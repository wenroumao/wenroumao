'use strict';
/**
 * tools/admin/importer.js —— Markdown 导入与网页抓取
 * ---------------------------------------------------------------------------
 * 两件事：
 *   1) 本地 .md 文件的解析：剥离 BOM、限制大小、读出 front matter 字段；
 *   2) 网页转 Markdown：SSRF 防护、超时/体积限制、手写 HTML→Markdown。
 *
 * 不引入任何第三方依赖；HTTP 请求用 Node 自带的 http/https。
 */

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');
const core = require('./core');

const MAX_BYTES = 5 * 1024 * 1024;      // 网页响应体上限
const MAX_MD_BYTES = 2 * 1024 * 1024;   // 本地 .md 上限
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

class ImportError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.status = status || 400;
  }
}

/* ------------------------------------------------------------------ SSRF */

function ipv4IsPrivate(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some(function (n) { return !isFinite(n) || n < 0 || n > 255; })) return true;
  const a = parts[0];
  const b = parts[1];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT
  if (a >= 224) return true;                        // 组播与保留段
  return false;
}

function ipv6IsPrivate(ip) {
  const raw = String(ip).replace(/^\[|\]$/g, '').toLowerCase();
  if (raw === '::1' || raw === '::') return true;
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPrivate(mapped[1]);
  const mappedHex = raw.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return ipv4IsPrivate((hi >> 8) + '.' + (hi & 255) + '.' + (lo >> 8) + '.' + (lo & 255));
  }
  if (/^f[cd][0-9a-f]{2}:/.test(raw)) return true;  // fc00::/7 唯一本地地址
  if (/^fe[89ab][0-9a-f]:/.test(raw)) return true;  // fe80::/10 链路本地
  if (/^ff[0-9a-f]{2}:/.test(raw)) return true;     // 组播
  return false;
}

function ipIsPrivate(ip) {
  const family = net.isIP(String(ip).replace(/^\[|\]$/g, ''));
  if (family === 4) return ipv4IsPrivate(ip);
  if (family === 6) return ipv6IsPrivate(ip);
  return true;
}

/**
 * 域名必须解析到公网地址；直接写 IP 的也要拦。
 * lookup 可注入，测试里不真的查 DNS。
 */
async function assertPublicHost(hostname, lookup) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new ImportError('IMPORT_URL_INVALID', '地址缺少主机名。', 400);
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new ImportError('IMPORT_BLOCKED_PRIVATE', '不允许访问本机地址（' + host + '）。', 403);
  }
  if (net.isIP(host)) {
    if (ipIsPrivate(host)) {
      throw new ImportError('IMPORT_BLOCKED_PRIVATE', '不允许访问内网地址（' + host + '）。', 403);
    }
    return [{ address: host, family: net.isIP(host) }];
  }
  let list;
  try {
    list = await (lookup || dns.promises.lookup)(host, { all: true, verbatim: true });
  } catch (err) {
    throw new ImportError('IMPORT_DNS', '域名解析失败：' + err.message, 502);
  }
  if (!list || !list.length) throw new ImportError('IMPORT_DNS', '域名解析不到地址：' + host, 502);
  for (let i = 0; i < list.length; i++) {
    if (ipIsPrivate(list[i].address)) {
      throw new ImportError('IMPORT_BLOCKED_PRIVATE', '不允许访问内网地址（' + host + ' → ' + list[i].address + '）。', 403);
    }
  }
  return list;
}

function normalizeUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input == null ? '' : input).trim());
  } catch (err) {
    throw new ImportError('IMPORT_URL_INVALID', '地址格式不正确，需要完整的 http(s) 链接。', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ImportError('IMPORT_URL_INVALID', '只允许 http 或 https 地址。', 400);
  }
  if (parsed.username || parsed.password) {
    throw new ImportError('IMPORT_URL_INVALID', '地址里不能带账号密码。', 400);
  }
  return parsed;
}

/** 把 DNS 结果钉死在本次请求上，避免解析后又被换成内网地址。 */
function pinnedLookup(addresses) {
  return function (hostname, options, callback) {
    if (!addresses.length) return callback(new Error('没有可用地址'));
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  };
}

function requestOnce(parsed, addresses, options) {
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const maxBytes = options.maxBytes || MAX_BYTES;
  const request = options.request || (parsed.protocol === 'https:' ? https.request : http.request);

  return new Promise(function (resolve, reject) {
    let settled = false;
    let timer = null;
    let req = null;

    function done(err, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    }

    function onResponse(res) {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers && res.headers.location) {
        try { res.resume(); } catch (e) { /* 忽略 */ }
        return done(null, { redirect: String(res.headers.location), status: status });
      }
      if (status < 200 || status >= 300) {
        try { res.resume(); } catch (e) { /* 忽略 */ }
        return done(new ImportError('IMPORT_HTTP_ERROR', '目标返回 HTTP ' + status + '。', 502));
      }
      const type = String((res.headers && res.headers['content-type']) || '').toLowerCase();
      if (!(type.indexOf('text/html') === 0 || type.indexOf('application/xhtml+xml') === 0)) {
        try { res.destroy(); } catch (e) { /* 忽略 */ }
        return done(new ImportError(
          'IMPORT_NOT_HTML',
          '目标不是 HTML 页面（Content-Type: ' + (type || '未知') + '）。',
          415
        ));
      }
      const charset = (type.match(/charset=([^;\s]+)/) || [])[1] || '';
      const chunks = [];
      let size = 0;
      let truncated = false;

      res.on('data', function (chunk) {
        if (truncated) return;
        size += chunk.length;
        if (size > maxBytes) {
          truncated = true;
          const keep = Math.max(0, chunk.length - (size - maxBytes));
          if (keep) chunks.push(chunk.slice(0, keep));
          try { res.destroy(); } catch (e) { /* 忽略 */ }
          return done(null, {
            status: status,
            headers: res.headers,
            body: Buffer.concat(chunks),
            truncated: true,
            charset: charset
          });
        }
        chunks.push(chunk);
      });
      res.on('end', function () {
        done(null, {
          status: status,
          headers: res.headers,
          body: Buffer.concat(chunks),
          truncated: false,
          charset: charset
        });
      });
      res.on('error', function (err) {
        done(new ImportError('IMPORT_NETWORK', '读取响应失败：' + err.message, 502));
      });
    }

    try {
      req = request({
        protocol: parsed.protocol,
        hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
        port: parsed.port || undefined,
        path: (parsed.pathname || '/') + (parsed.search || ''),
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HexoAdminImporter/1.0)',
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        lookup: pinnedLookup(addresses)
      }, onResponse);
    } catch (err) {
      return done(new ImportError('IMPORT_NETWORK', '发起请求失败：' + err.message, 502));
    }

    timer = setTimeout(function () {
      try { if (req) req.destroy(); } catch (e) { /* 忽略 */ }
      done(new ImportError(
        'IMPORT_TIMEOUT',
        '抓取超时（' + Math.round(timeoutMs / 1000) + ' 秒），目标可能响应太慢。',
        504
      ));
    }, timeoutMs);

    req.on('error', function (err) {
      done(new ImportError('IMPORT_NETWORK', '抓取失败：' + err.message, 502));
    });
    req.end();
  });
}

/**
 * 抓取一个 HTML 页面。
 * options：lookup（测试注入）、request（测试注入）、timeoutMs、maxBytes。
 */
async function fetchPage(input, options) {
  options = options || {};
  let current = normalizeUrl(input).href;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = normalizeUrl(current);
    const addresses = await assertPublicHost(parsed.hostname, options.lookup);
    const res = await requestOnce(parsed, addresses, {
      timeoutMs: options.timeoutMs || TIMEOUT_MS,
      maxBytes: options.maxBytes || MAX_BYTES,
      request: options.request
    });
    if (res.redirect) {
      if (hop === MAX_REDIRECTS) {
        throw new ImportError('IMPORT_TOO_MANY_REDIRECTS', '重定向次数太多。', 502);
      }
      current = new URL(res.redirect, current).href;
      continue;
    }
    return {
      url: parsed.href,
      status: res.status,
      html: res.body.toString('utf8').replace(/^\uFEFF/, ''),
      truncated: res.truncated,
      charset: res.charset
    };
  }
  throw new ImportError('IMPORT_TOO_MANY_REDIRECTS', '重定向次数太多。', 502);
}

/* ------------------------------------------------------------- HTML 解析 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr'
]);
const RAW_TAGS = new Set(['script', 'style']);
const INLINE_TAGS = new Set([
  'a', 'span', 'strong', 'b', 'em', 'i', 'code', 'del', 's', 'strike', 'u',
  'small', 'mark', 'label', 'time', 'abbr', 'sup', 'sub', 'br', 'img',
  'tt', 'kbd', 'var', 'samp', 'big', 'cite', 'q'
]);
const NOISE_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'nav', 'footer', 'aside',
  'form', 'svg', 'canvas', 'iframe', 'object', 'embed', 'input', 'button'
]);
const NOISE_ATTR = /(?:^|[\s_-])(?:nav|navbar|menu|footer|sidebar|side-bar|breadcrumb|share|social|related|comment|cookie|advert|ads|popup)(?:$|[\s_-])/i;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00B7',
  ldquo: '\u201C', rdquo: '\u201D', lsquo: '\u2018', rsquo: '\u2019',
  laquo: '\u00AB', raquo: '\u00BB', copy: '\u00A9', reg: '\u00AE',
  trade: '\u2122', times: '\u00D7', divide: '\u00F7', deg: '\u00B0',
  le: '\u2264', ge: '\u2265', ensp: ' ', emsp: ' ', thinsp: ' '
};

function decodeEntities(input) {
  return String(input == null ? '' : input).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, function (all, body) {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!isFinite(code) || code < 0 || code > 0x10FFFF) return all;
      try { return String.fromCodePoint(code); } catch (e) { return all; }
    }
    const key = body.toLowerCase();
    return ENTITIES[key] == null ? all : ENTITIES[key];
  });
}

/** 找标签结束的 '>'，跳过引号里的内容。 */
function findTagEnd(source, start) {
  let quote = '';
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    if (!name) continue;
    const value = m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : ''));
    if (attrs[name] === undefined) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function parseHtml(html) {
  const source = String(html == null ? '' : html);
  const root = { type: 'root', name: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;

  function pushText(raw) {
    if (!raw) return;
    const text = decodeEntities(raw);
    if (!text) return;
    stack[stack.length - 1].children.push({ type: 'text', text: text });
  }

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      pushText(source.slice(i));
      break;
    }
    if (lt > i) pushText(source.slice(i, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source[lt + 1] === '!' || source[lt + 1] === '?') {
      const end = source.indexOf('>', lt);
      i = end < 0 ? source.length : end + 1;
      continue;
    }

    const gt = findTagEnd(source, lt + 1);
    if (gt < 0) {
      pushText(source.slice(lt));
      break;
    }
    const raw = source.slice(lt + 1, gt);
    i = gt + 1;

    const closing = raw[0] === '/';
    const selfClose = /\/\s*$/.test(raw);
    const nameMatch = raw.replace(/^\/+/, '').match(/^\s*([A-Za-z0-9:_-]+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();

    if (closing) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      continue;
    }

    const node = {
      type: 'element',
      name: name,
      attrs: parseAttrs(raw.slice(nameMatch[0].length)),
      children: []
    };
    stack[stack.length - 1].children.push(node);

    if (selfClose || VOID_TAGS.has(name)) continue;

    if (RAW_TAGS.has(name)) {
      const closeRe = new RegExp('</\\s*' + name + '\\s*>', 'i');
      const rest = source.slice(i);
      const found = closeRe.exec(rest);
      if (found) {
        node.children.push({ type: 'text', text: decodeEntities(rest.slice(0, found.index)), raw: true });
        i += found.index + found[0].length;
      } else {
        node.children.push({ type: 'text', text: decodeEntities(rest), raw: true });
        i = source.length;
      }
      continue;
    }

    stack.push(node);
  }

  return root;
}

function walk(node, visit) {
  visit(node);
  if (!node.children) return;
  for (let i = 0; i < node.children.length; i++) walk(node.children[i], visit);
}

function hasElement(node, name) {
  if (!node || !node.children) return false;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type !== 'element') continue;
    if (child.name === name || hasElement(child, name)) return true;
  }
  return false;
}

function rawText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  if (!node.children) return '';
  return node.children.map(rawText).join('');
}

function textLength(node) {
  if (!node) return 0;
  if (node.type === 'text') return node.text.replace(/\s+/g, ' ').trim().length;
  if (!node.children) return 0;
  return node.children.reduce(function (sum, child) { return sum + textLength(child); }, 0);
}

function shouldDrop(node) {
  if (NOISE_TAGS.has(node.name)) return true;
  if (node.attrs && node.attrs.hidden !== undefined) return true;
  const role = String((node.attrs && node.attrs.role) || '').toLowerCase();
  if (role === 'navigation' || role === 'banner' || role === 'contentinfo' ||
      role === 'complementary' || role === 'search') return true;
  const mark = String((node.attrs && node.attrs.class) || '') + ' ' + String((node.attrs && node.attrs.id) || '');
  return NOISE_ATTR.test(mark);
}

function cleanChildren(children) {
  const out = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'element') {
      if (shouldDrop(child)) continue;
      child.children = cleanChildren(child.children || []);
    } else if (child.type === 'text' && !child.text.trim()) {
      continue;
    }
    out.push(child);
  }
  return out;
}

/** 找正文容器：article/main/#content 等，太小的就不采用。 */
function selectRoot(tree) {
  let body = null;
  const candidates = [];
  walk(tree, function (node) {
    if (node.type !== 'element') return;
    if (node.name === 'body') body = node;
    const id = String((node.attrs && node.attrs.id) || '').toLowerCase();
    const cls = String((node.attrs && node.attrs.class) || '').toLowerCase();
    const role = String((node.attrs && node.attrs.role) || '').toLowerCase();
    const byClass = /(^|\s)(post-content|article-content|entry-content|post-body|article-body)(\s|$)/.test(cls);
    if (node.name === 'article' || node.name === 'main' || role === 'main' ||
        id === 'content' || id === 'main' || byClass) {
      candidates.push(node);
    }
  });
  const base = body || tree;
  const baseLen = textLength(base);
  let best = base;
  let bestLen = baseLen;
  const threshold = Math.max(300, baseLen * 0.3);
  for (let i = 0; i < candidates.length; i++) {
    const len = textLength(candidates[i]);
    if (len >= threshold && len > bestLen) {
      best = candidates[i];
      bestLen = len;
    }
  }
  return best;
}

function cleanTitle(raw) {
  let title = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!title) return '';
  const parts = title.split(/\s+[-|\u2013\u2014_]\s+/);
  if (parts.length > 1 && parts[0].length >= 2) title = parts[0].trim();
  return title;
}

function extractTitle(tree) {
  let og = '';
  let title = '';
  walk(tree, function (node) {
    if (node.type !== 'element') return;
    if (node.name === 'title' && !title) title = rawText(node);
    if (node.name === 'meta' && node.attrs) {
      const key = String(node.attrs.property || node.attrs.name || '').toLowerCase();
      if (key === 'og:title' && node.attrs.content && !og) og = node.attrs.content;
    }
  });
  return cleanTitle(og || title);
}

/* ---------------------------------------------------------- HTML → Markdown */

function absoluteUrl(value, baseUrl) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  if (/^(?:data|javascript|vbscript|mailto|tel):/i.test(raw)) return raw;
  try {
    return new URL(raw, baseUrl || undefined).href;
  } catch (e) {
    return raw;
  }
}

function escapeInline(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]])/g, '\\$1');
}

function normalizeInline(text) {
  return String(text == null ? '' : text)
    .replace(/\u00A0/g, ' ')
    .split('\u0001')
    .map(function (part) { return part.replace(/\s+/g, ' ').trim(); })
    .join('  \n')
    .trim();
}

function inlineToMd(node, ctx) {
  if (!node) return '';
  if (node.type === 'text') return escapeInline(node.text);

  switch (node.name) {
    case 'br': return '\u0001';
    case 'img': return imageToMd(node, ctx);
    case 'code': {
      const text = rawText(node).replace(/\u00A0/g, ' ');
      return '`' + text.replace(/`/g, '\\`') + '`';
    }
    case 'strong':
    case 'b':
      return wrapInline(node, ctx, '**');
    case 'em':
    case 'i':
      return wrapInline(node, ctx, '*');
    case 'del':
    case 's':
    case 'strike':
      return wrapInline(node, ctx, '~~');
    case 'a': {
      const inner = normalizeInline(childrenToInline(node, ctx));
      const href = absoluteUrl((node.attrs && (node.attrs.href || node.attrs['data-href'])) || '', ctx.baseUrl);
      if (!href) return inner;
      const cls = String((node.attrs && node.attrs.class) || '');
      // 标题旁的锚点链接（空文本、纯 # 跳转）不产出 Markdown 链接
      if (!inner && (href.indexOf('#') === 0 || /anchor|headerlink/i.test(cls))) return '';
      return '[' + (inner || escapeInline(href)) + '](' + href.replace(/\)/g, '%29') + ')';
    }
    default:
      return childrenToInline(node, ctx);
  }
}

function childrenToInline(node, ctx) {
  if (!node.children) return '';
  return node.children.map(function (child) { return inlineToMd(child, ctx); }).join('');
}

function wrapInline(node, ctx, mark) {
  const inner = normalizeInline(childrenToInline(node, ctx));
  if (!inner) return '';
  return mark + inner + mark;
}

function imageToMd(node, ctx) {
  if (!node.attrs) return '';
  const src = absoluteUrl(node.attrs.src || node.attrs['data-src'] || node.attrs['data-original'] || '', ctx.baseUrl);
  if (!src) return '';
  const alt = String(node.attrs.alt || node.attrs.title || '').replace(/([\[\]])/g, '\\$1');
  return '![' + alt + '](' + src.replace(/\)/g, '%29') + ')';
}

function renderPre(node) {
  let codeNode = null;
  walk(node, function (child) {
    if (!codeNode && child.type === 'element' && child.name === 'code') codeNode = child;
  });
  const holder = codeNode || node;
  const cls = String((holder.attrs && holder.attrs.class) || '');
  const lang = (cls.match(/language-([A-Za-z0-9+#._-]+)/) || [])[1] ||
    String((holder.attrs && (holder.attrs['data-lang'] || holder.attrs['data-language'])) || '');
  const text = rawText(holder)
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+|\n+$/g, '');
  let longest = 0;
  const runs = text.match(/`+/g) || [];
  for (let i = 0; i < runs.length; i++) longest = Math.max(longest, runs[i].length);
  const fence = '`'.repeat(Math.min(12, Math.max(3, longest + 1)));
  return fence + lang + '\n' + text + '\n' + fence;
}

function renderList(node, ctx, depth) {
  const ordered = node.name === 'ol';
  let index = parseInt(String((node.attrs && node.attrs.start) || '1'), 10);
  if (!isFinite(index) || index < 1) index = 1;
  const pad = '  '.repeat(depth);
  const lines = [];

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type !== 'element') continue;
    if (child.name !== 'li') {
      const text = blockToMd([child], ctx);
      if (text) lines.push(pad + text.replace(/\n/g, '\n' + pad));
      continue;
    }
    const marker = ordered ? (index++) + '. ' : '- ';
    const inlineNodes = [];
    const nested = [];
    for (let k = 0; k < child.children.length; k++) {
      const part = child.children[k];
      if (part.type === 'element' && (part.name === 'ul' || part.name === 'ol')) nested.push(part);
      else inlineNodes.push(part);
    }
    const text = normalizeInline(inlineNodes.map(function (part) {
      return inlineToMd(part, ctx);
    }).join('')).replace(/\n/g, ' ');
    lines.push(pad + marker + text);
    for (let k = 0; k < nested.length; k++) {
      const sub = renderList(nested[k], ctx, depth + 1);
      if (sub) lines.push(sub);
    }
  }
  return lines.join('\n');
}

function collectRows(node, out) {
  if (!node.children) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type !== 'element') continue;
    if (child.name === 'tr') out.push(child);
    else if (child.name === 'thead' || child.name === 'tbody' || child.name === 'tfoot') collectRows(child, out);
  }
}

function renderTable(node, ctx) {
  const rows = [];
  collectRows(node, rows);
  if (!rows.length) return '';

  const cells = rows.map(function (row) {
    const out = [];
    for (let i = 0; i < row.children.length; i++) {
      const cell = row.children[i];
      if (cell.type !== 'element' || cell.name !== 'td' && cell.name !== 'th') continue;
      const text = normalizeInline(childrenToInline(cell, ctx))
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');
      out.push(text);
    }
    return out;
  });

  const width = cells.reduce(function (max, row) { return Math.max(max, row.length); }, 0);
  if (width < 1) return '';

  const firstRow = rows[0];
  const firstIsHeader = firstRow.children.every(function (cell) {
    return cell.type !== 'element' || cell.name === 'th';
  });
  const header = firstIsHeader ? cells[0] : new Array(width).fill('');
  const dataRows = firstIsHeader ? cells.slice(1) : cells;

  function padRow(row) {
    const copy = row.slice(0, width);
    while (copy.length < width) copy.push('');
    return copy;
  }

  const lines = [
    '| ' + padRow(header).join(' | ') + ' |',
    '| ' + new Array(width).fill('---').join(' | ') + ' |'
  ];
  for (let i = 0; i < dataRows.length; i++) {
    lines.push('| ' + padRow(dataRows[i]).join(' | ') + ' |');
  }
  return lines.join('\n');
}

function renderBlock(node, ctx) {
  const tag = node.name;
  if (/^h[1-6]$/.test(tag)) {
    const inner = normalizeInline(childrenToInline(node, ctx)).replace(/\n/g, ' ');
    return inner ? '#'.repeat(Number(tag[1])) + ' ' + inner : '';
  }
  switch (tag) {
    case 'p': {
      const inner = normalizeInline(childrenToInline(node, ctx));
      return inner;
    }
    case 'blockquote': {
      const inner = blockToMd(node.children, ctx);
      return inner.split('\n').map(function (line) { return line ? '> ' + line : '>'; }).join('\n');
    }
    case 'ul':
    case 'ol':
      return renderList(node, ctx, 0);
    case 'pre':
      return renderPre(node);
    case 'table':
      // Hexo 的 highlight 会把代码包进 <figure><table><td><pre>
      if (hasElement(node, 'pre')) return renderPre(node);
      return renderTable(node, ctx);
    case 'hr':
      return '---';
    case 'img':
      return imageToMd(node, ctx);
    case 'figure':
      if (hasElement(node, 'pre')) return renderPre(node);
      return blockToMd(node.children, ctx);
    case 'figcaption': {
      const inner = normalizeInline(childrenToInline(node, ctx));
      return inner ? '* ' + inner + ' *' : '';
    }
    default:
      if (INLINE_TAGS.has(tag)) return normalizeInline(inlineToMd(node, ctx));
      return blockToMd(node.children || [], ctx);
  }
}

function blockToMd(nodes, ctx) {
  const parts = [];
  let buffer = [];

  function flush() {
    if (!buffer.length) return;
    const text = normalizeInline(buffer.join(''));
    if (text) parts.push(text);
    buffer = [];
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === 'text') {
      buffer.push(escapeInline(node.text));
      continue;
    }
    if (node.name === 'br') { buffer.push('\u0001'); continue; }
    if (INLINE_TAGS.has(node.name)) { buffer.push(inlineToMd(node, ctx)); continue; }
    flush();
    const rendered = renderBlock(node, ctx);
    if (rendered) parts.push(rendered);
  }
  flush();
  return parts.join('\n\n');
}

function tidy(markdown) {
  return String(markdown || '')
    .replace(/\u0001/g, '  \n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * HTML → Markdown。返回 { title, markdown, charCount, warnings }。
 * extra 可带 truncated / charset（来自抓取层）。
 */
function htmlToMarkdown(html, baseUrl, extra) {
  extra = extra || {};
  const tree = parseHtml(html);
  const title = extractTitle(tree);
  const root = selectRoot(tree);
  const cleaned = cleanChildren(root.children || []);
  const markdown = tidy(blockToMd(cleaned, { baseUrl: baseUrl || '' }));
  const plainLength = textLength(root);

  const warnings = [];
  if (!markdown) {
    warnings.push('没有从页面提取到可转换的正文。');
    warnings.push('页面可能需要 JS 渲染，抓取内容可能不完整。');
  } else if (markdown.length < 150 || plainLength < 50) {
    warnings.push('页面可能需要 JS 渲染，抓取内容可能不完整。');
  }
  if (extra.truncated) {
    warnings.push('页面超过了响应体大小上限，只转换了前一部分，内容可能不完整。');
  }
  if (extra.charset && !/^utf-?8$/i.test(extra.charset)) {
    warnings.push('页面声明编码为 ' + extra.charset + '，当前按 UTF-8 解码，中文可能乱码。');
  }

  return {
    title: title,
    markdown: markdown,
    charCount: markdown.length,
    warnings: warnings
  };
}

/** 完整流程：抓取 + 转换。 */
async function convertUrl(input, options) {
  const page = await fetchPage(input, options);
  const result = htmlToMarkdown(page.html, page.url, page);
  return {
    url: page.url,
    title: result.title,
    markdown: result.markdown,
    charCount: result.charCount,
    warnings: result.warnings
  };
}

/* -------------------------------------------------------------- .md 解析 */

function toList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map(function (item) { return cleanListItem(item); }).filter(Boolean);
  }
  return String(value)
    .replace(/^\s*\[|\]\s*$/g, '')
    .split(/[,，]/)
    .map(function (item) { return cleanListItem(item); })
    .filter(Boolean);
}

function cleanListItem(item) {
  return String(item == null ? '' : item)
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

/**
 * 解析本地 .md：剥 BOM、限制 2 MB、拆 front matter。
 * 返回可直接填进编辑器的字段。
 */
function parseMarkdown(raw, options) {
  options = options || {};
  if (typeof raw !== 'string') {
    throw new ImportError('IMPORT_MD_INVALID', '文件内容读不出来。', 400);
  }
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const limit = options.maxBytes || MAX_MD_BYTES;
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new ImportError(
      'IMPORT_MD_TOO_LARGE',
      '文件超过 ' + Math.round(limit / 1024 / 1024) + ' MB，请拆分后再导入。',
      413
    );
  }
  if (!text.trim()) throw new ImportError('IMPORT_MD_EMPTY', '文件是空的。', 400);

  const split = core.splitFrontMatter(text);
  const fields = split.hasFrontMatter ? core.parseFields(split.frontMatter) : {};
  const warnings = [];
  if (/\uFFFD/.test(text)) warnings.push('文件里出现了乱码字符（\uFFFD），请确认文件是按 UTF-8 保存的。');
  if (!split.hasFrontMatter) warnings.push('文件没有 front matter，标题和日期需要手工填写。');

  return {
    hasFrontMatter: split.hasFrontMatter,
    title: String(fields.title == null ? '' : fields.title).trim(),
    date: String(fields.date == null ? '' : fields.date).trim(),
    categories: toList(fields.categories),
    tags: toList(fields.tags),
    cover: String(fields.cover || fields.image || '').trim(),
    description: String(fields.description || fields.excerpt || '').trim(),
    comments: fields.comments === undefined ? true : !!fields.comments,
    published: fields.published === undefined
      ? (fields.draft === undefined ? true : !fields.draft)
      : !!fields.published,
    body: split.body.replace(/^\n+/, ''),
    warnings: warnings
  };
}

module.exports = {
  ImportError: ImportError,
  MAX_BYTES: MAX_BYTES,
  MAX_MD_BYTES: MAX_MD_BYTES,
  TIMEOUT_MS: TIMEOUT_MS,
  MAX_REDIRECTS: MAX_REDIRECTS,
  ipIsPrivate: ipIsPrivate,
  assertPublicHost: assertPublicHost,
  normalizeUrl: normalizeUrl,
  fetchPage: fetchPage,
  htmlToMarkdown: htmlToMarkdown,
  parseHtml: parseHtml,
  convertUrl: convertUrl,
  parseMarkdown: parseMarkdown
};
