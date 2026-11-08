'use strict';
/**
 * tools/admin/core.js —— 本地后台的纯逻辑
 * ---------------------------------------------------------------------------
 * 这里不碰 HTTP，也不启动进程，只做四件事：
 *   1) 读取管理员凭据（环境变量优先，其次站点根目录的 .admin-auth）
 *   2) 文章 front matter 的解析、补丁、重建（保留没被改动的字段与注释）
 *   3) 两份配置文件的 YAML 路径读写（只动白名单字段，按行补丁）
 *   4) 文章路径校验与备份
 *
 * 设计取舍：不引入 js-yaml 等新依赖，也不把整份 YAML 重新序列化。
 * 整份重写会把 7 万行主题配置的注释、缩进、顺序全部打乱，风险远大于收益。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POSTS_REL = 'source/_posts';
const SETUP_VARS = ['ADMIN_USER', 'ADMIN_PASSWORD'];

/* ---------------------------------------------------------------- 管理员凭据 */

/**
 * @param {string} baseDir 站点根目录
 * @param {object} [env] 测试时可注入
 * @returns {{user:string,password:string,configured:boolean,allowLan:boolean,deployEnabled:boolean,ttlMs:number}}
 */
function loadAdminConfig(baseDir, env) {
  env = env || process.env;
  let user = String(env.ADMIN_USER || '').trim();
  let password = String(env.ADMIN_PASSWORD || '');

  if (!user || !password) {
    const file = path.join(baseDir, '.admin-auth');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { /* 没这个文件很正常 */ }
    text.split(/\r?\n/).forEach(function (line) {
      const m = line.match(/^\s*(ADMIN_[A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (!m) return;
      const value = unquote(m[2]);
      if (m[1] === 'ADMIN_USER' && !user) user = value;
      if (m[1] === 'ADMIN_PASSWORD' && !password) password = value;
    });
  }

  return {
    user: user,
    password: password,
    configured: !!user && !!password,
    allowLan: env.ADMIN_ALLOW_LAN === '1' || env.ADMIN_ALLOW_LAN === 'true',
    deployEnabled: env.ADMIN_DEPLOY_ENABLED === '1' || env.ADMIN_DEPLOY_ENABLED === 'true',
    ttlMs: 8 * 60 * 60 * 1000
  };
}

function missingSetupVars(cfg) {
  return SETUP_VARS.filter(function (name) {
    if (name === 'ADMIN_USER') return !cfg.user;
    if (name === 'ADMIN_PASSWORD') return !cfg.password;
    return false;
  });
}

/** 两个字符串先各自 SHA-256，再定长比较；长度与内容都不泄漏。 */
function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const right = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(left, right);
}

/** 只接受本机回环地址。 */
function isLoopback(addr) {
  const s = String(addr || '');
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1' || s.indexOf('127.') === 0;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    if (!key) return;
    let value = part.slice(idx + 1).trim();
    try { value = decodeURIComponent(value); } catch (e) { /* 保留原样 */ }
    out[key] = value;
  });
  return out;
}

/* ------------------------------------------------------------ front matter */

function splitFrontMatter(raw) {
  const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { hasFrontMatter: false, frontMatter: '', body: text };
  return { hasFrontMatter: true, frontMatter: m[1], body: text.slice(m[0].length) };
}

/** 只解析顶层字段；列表与 `|` 块能读，嵌套映射不展开。 */
function parseFields(frontMatter) {
  const lines = String(frontMatter || '').split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/);
    if (!m) continue;
    const key = m[1];
    const rest = String(m[2] || '').trim();

    if (rest === '|' || rest === '>') {
      const block = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^\S/.test(lines[j])) break;
        block.push(lines[j].replace(/^  /, ''));
      }
      out[key] = block.join('\n').replace(/\s+$/, '');
      i = j - 1;
      continue;
    }

    if (!rest) {
      const items = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const line = lines[j];
        if (/^\s+-\s+/.test(line)) items.push(parseScalar(line.replace(/^\s+-\s+/, '')));
        else if (!line.trim()) continue;
        else break;
      }
      if (items.length) {
        out[key] = items;
        i = j - 1;
      } else {
        out[key] = '';
      }
      continue;
    }

    out[key] = parseScalar(rest);
  }
  return out;
}

function parseScalar(input) {
  let s = stripInlineComment(String(input == null ? '' : input));
  if (!s) return '';
  if (/^"(?:[^"\\]|\\.)*"$/.test(s)) {
    try { return JSON.parse(s); } catch (e) { return s.slice(1, -1); }
  }
  if (/^'(?:[^']|'')*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^(null|~)$/i.test(s)) return '';
  if (/^[-+]?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** 引号里的 # 不算注释。 */
function stripInlineComment(input) {
  const s = String(input == null ? '' : input);
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trim();
  }
  return s.trim();
}

/** 取出行尾注释（引号内的 # 不算），返回 "# ..." 或空串。 */
function trailingComment(line) {
  const s = String(line == null ? '' : line);
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(i).trim();
  }
  return '';
}

function unquote(s) {
  const value = stripInlineComment(String(s == null ? '' : s));
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try { return JSON.parse(value); } catch (e) { return value.slice(1, -1); }
  }
  if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value == null ? '' : value);
  if (s === '') return '';
  if (
    /^[^\s#'"\-?:,[\]{}&*!|>@`%][^#\r\n]*$/.test(s) &&
    !/\s$/.test(s) &&
    !/:(?:\s|$)/.test(s) &&
    !/^(true|false|null|~)$/i.test(s) &&
    !/^[-+]?\d+(?:\.\d+)?$/.test(s)
  ) return s;
  return JSON.stringify(s);
}

function serializeField(key, value, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return pad + key + ':';
    return [pad + key + ':'].concat(value.map(function (item) {
      return ' '.repeat(indent + 2) + '- ' + yamlScalar(item);
    })).join('\n');
  }
  const text = String(value == null ? '' : value);
  if (text.indexOf('\n') >= 0) {
    return pad + key + ': |\n' + text.split(/\r?\n/).map(function (line) {
      return ' '.repeat(indent + 2) + line;
    }).join('\n');
  }
  if (!text) return pad + key + ':';
  return pad + key + ': ' + yamlScalar(value);
}

function findKeyLine(lines, key, indent, from) {
  const re = new RegExp('^' + ' '.repeat(indent) + escapeRegExp(key) + ':(?:[ \\t]+(.*))?$');
  for (let i = from || 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

function blockEnd(lines, index, indent) {
  let i = index + 1;
  for (; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) <= indent) return i;
  }
  return lines.length;
}

function indentOf(line) {
  const m = String(line).match(/^[ \t]*/);
  return m ? m[0].replace(/\t/g, '  ').length : 0;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按顶层字段做行补丁。值为 null 时删除该字段；未出现的字段原样保留。
 * @param {string} frontMatter 不含 --- 分隔符的内容
 * @param {object} updates
 */
function patchFrontMatter(frontMatter, updates) {
  const lines = String(frontMatter || '').split(/\r?\n/);
  Object.keys(updates).forEach(function (key) {
    const value = updates[key];
    const idx = findKeyLine(lines, key, 0);
    if (idx < 0) {
      if (value !== null && value !== undefined) {
        const block = serializeField(key, value, 0).split('\n');
        lines.push.apply(lines, block);
      }
      return;
    }
    const end = blockEnd(lines, idx, 0);
    if (value === null || value === undefined) {
      lines.splice(idx, end - idx);
    } else {
      lines.splice.apply(lines, [idx, end - idx].concat(serializeField(key, value, 0).split('\n')));
    }
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

function buildFrontMatter(fields) {
  const order = ['title', 'published', 'categories', 'tags', 'cover', 'description', 'comments', 'date', 'updated'];
  const lines = [];
  order.forEach(function (key) {
    if (!(key in fields)) return;
    const value = fields[key];
    if (value === null || value === undefined) return;
    if (Array.isArray(value) && !value.length) return;
    if (!Array.isArray(value) && value === '' && key !== 'title') return;
    lines.push(serializeField(key, value, 0));
  });
  Object.keys(fields).forEach(function (key) {
    if (order.indexOf(key) >= 0) return;
    if (fields[key] === null || fields[key] === undefined) return;
    lines.push(serializeField(key, fields[key], 0));
  });
  return lines.join('\n');
}

/* --------------------------------------------------------------- YAML 路径 */

/**
 * 读取嵌套标量 / 列表。找不到返回 undefined。
 * @param {string} text 整份 YAML
 * @param {string[]} keyPath
 */
function getYamlPath(text, keyPath) {
  const lines = String(text || '').split(/\r?\n/);
  let indent = 0;
  let from = 0;
  for (let depth = 0; depth < keyPath.length; depth++) {
    const idx = findKeyLine(lines, keyPath[depth], indent, from);
    if (idx < 0) return undefined;
    const rest = (lines[idx].match(/^[ \t]*[^:]+:(?:[ \t]+(.*))?$/) || [])[1] || '';
    if (depth === keyPath.length - 1) {
      if (!rest.trim()) {
        const items = [];
        const end = blockEnd(lines, idx, indent);
        for (let j = idx + 1; j < end; j++) {
          if (/^\s+-\s+/.test(lines[j])) items.push(parseScalar(lines[j].replace(/^\s+-\s+/, '')));
        }
        return items.length ? items : '';
      }
      return parseScalar(rest);
    }
    if (rest.trim()) return undefined;
    const next = findChildIndent(lines, idx, indent);
    if (next < 0) return undefined;
    indent = next;
    from = idx + 1;
  }
  return undefined;
}

/**
 * 修改嵌套标量 / 列表；只支持已存在的中间层级，找不到就抛错。
 * @returns {string} 新文本
 */
function setYamlPath(text, keyPath, value) {
  const lines = String(text || '').split(/\r?\n/);
  let indent = 0;
  let from = 0;
  for (let depth = 0; depth < keyPath.length; depth++) {
    const idx = findKeyLine(lines, keyPath[depth], indent, from);
    if (idx < 0) {
      if (depth === 0 && indent === 0) {
        if (!lines.length || (lines.length === 1 && !lines[0].trim())) lines.length = 0;
        else lines.push('');
        lines.push.apply(lines, serializeField(keyPath[0], value, 0).split('\n'));
        return lines.join('\n');
      }
      throw new Error('配置里找不到 ' + keyPath.join('.'));
    }
    if (depth === keyPath.length - 1) {
      const end = blockEnd(lines, idx, indent);
      const replacement = serializeField(keyPath[depth], value, indent).split('\n');
      const comment = trailingComment(lines[idx]);
      if (comment && replacement.length === 1 && !Array.isArray(value) && !String(value).includes('\n')) {
        replacement[0] += ' ' + comment;
      }
      lines.splice.apply(lines, [idx, end - idx].concat(replacement));
      return lines.join('\n');
    }
    const rest = (lines[idx].match(/^[ \t]*[^:]+:(?:[ \t]+(.*))?$/) || [])[1] || '';
    if (rest.trim()) throw new Error(keyPath.slice(0, depth + 1).join('.') + ' 不是分组，不能改子项。');
    const next = findChildIndent(lines, idx, indent);
    if (next < 0) throw new Error('配置里找不到 ' + keyPath.join('.'));
    indent = next;
    from = idx + 1;
  }
  return lines.join('\n');
}

function findChildIndent(lines, index, parentIndent) {
  for (let i = index + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const indent = indentOf(lines[i]);
    if (indent <= parentIndent) return -1;
    return indent;
  }
  return -1;
}

/* ------------------------------------------------------------------- 文章 */

function postsRoot(baseDir) {
  return path.join(baseDir, POSTS_REL);
}

/** 相对路径必须是 _posts 内的 .md，拒绝穿越、绝对路径、点开头。 */
function resolvePostPath(baseDir, relPath) {
  let rel = String(relPath == null ? '' : relPath).replace(/\\/g, '/');
  if (!rel) throw new Error('缺少文章路径。');
  if (rel.indexOf('\u0000') >= 0) throw new Error('文章路径非法。');
  rel = path.posix.normalize(rel);
  if (rel.startsWith('../') || rel === '..' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    throw new Error('文章路径越界。');
  }
  if (!/\.md$/i.test(rel)) throw new Error('只允许 .md 文件。');
  const segments = rel.split('/');
  if (segments.some(function (s) { return !s || s.startsWith('.'); })) throw new Error('文章路径非法。');
  const root = postsRoot(baseDir);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('文章路径越界。');
  return { rel: rel, full: full };
}

function walkPosts(dir, prefix, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  entries.forEach(function (entry) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) walkPosts(path.join(dir, entry.name), rel, out);
      return;
    }
    if (!entry.isFile() || !/\.md$/i.test(entry.name) || entry.name.startsWith('.')) return;
    out.push(rel);
  });
}

function listPosts(baseDir) {
  const root = postsRoot(baseDir);
  const names = [];
  walkPosts(root, '', names);
  return names.map(function (rel) {
    let raw = '';
    let stat = null;
    try {
      raw = fs.readFileSync(path.join(root, rel), 'utf8');
      stat = fs.statSync(path.join(root, rel));
    } catch (e) { return null; }
    const parsed = splitFrontMatter(raw);
    const data = parseFields(parsed.frontMatter);
    return {
      name: rel,
      title: String(data.title || rel.replace(/\.md$/i, '')),
      date: String(data.date || ''),
      categories: Array.isArray(data.categories) ? data.categories : (data.categories ? [data.categories] : []),
      tags: Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : []),
      description: String(data.description || ''),
      published: data.published !== false,
      size: stat ? stat.size : 0,
      mtime: stat ? stat.mtimeMs : 0
    };
  }).filter(Boolean).sort(function (a, b) {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (b.mtime || 0) - (a.mtime || 0);
  });
}

function readPost(baseDir, relPath) {
  const target = resolvePostPath(baseDir, relPath);
  let raw;
  try { raw = fs.readFileSync(target.full, 'utf8'); } catch (e) {
    const err = new Error('文章不存在。');
    err.code = 'ENOENT';
    throw err;
  }
  const parsed = splitFrontMatter(raw);
  const data = parseFields(parsed.frontMatter);
  return {
    name: target.rel,
    title: String(data.title || target.rel.replace(/\.md$/i, '')),
    date: String(data.date || ''),
    categories: Array.isArray(data.categories) ? data.categories : (data.categories ? [data.categories] : []),
    tags: Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : []),
    cover: String(data.cover || ''),
    description: String(data.description || ''),
    comments: data.comments === false ? false : true,
    published: data.published !== false,
    body: parsed.body.replace(/\r\n/g, '\n'),
    frontMatter: parsed.frontMatter,
    hasFrontMatter: parsed.hasFrontMatter
  };
}

function normalizeList(value, max) {
  if (Array.isArray(value)) {
    return value.map(function (item) { return String(item == null ? '' : item).trim(); })
      .filter(Boolean).slice(0, max || 30);
  }
  return String(value == null ? '' : value).split(/[,，]/).map(function (item) { return item.trim(); })
    .filter(Boolean).slice(0, max || 30);
}

function normalizeText(value, max) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 300);
}

function formatDate(date) {
  const d = date instanceof Date ? date : new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function slugFromTitle(title) {
  const slug = String(title || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60);
  return slug || 'untitled';
}

/**
 * @param {string} relOrFull 相对站点根目录的路径，或绝对路径（文章用绝对路径更方便）
 */
function backupFile(baseDir, relOrFull) {
  const source = path.isAbsolute(relOrFull) ? relOrFull : path.join(baseDir, relOrFull);
  if (!fs.existsSync(source)) return '';
  const relative = path.relative(baseDir, source);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
  const stamp = formatDate(new Date()).replace(/[-: ]/g, '').slice(0, 14) + '-' +
    String(Date.now()).slice(-6) + '-' + crypto.randomBytes(2).toString('hex');
  const dest = path.join(baseDir, 'bak', 'admin', stamp, relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  return path.relative(baseDir, dest).replace(/\\/g, '/');
}

function createPost(baseDir, meta) {
  meta = meta || {};
  const title = normalizeText(meta.title, 200);
  if (!title) throw new Error('标题不能为空。');
  const date = normalizeText(meta.date, 40) || formatDate(new Date());
  const categories = normalizeList(meta.categories, 20);
  const tags = normalizeList(meta.tags, 20);
  const cover = normalizeText(meta.cover, 500);
  const description = normalizeText(meta.description, 2000);
  const body = String(meta.body == null ? '' : meta.body).replace(/\r\n/g, '\n');
  if (body.length > 2 * 1024 * 1024) throw new Error('正文超过 2MB。');

  const fields = { title: title, date: date };
  if (meta.published === false) fields.published = false;
  if (categories.length) fields.categories = categories;
  if (tags.length) fields.tags = tags;
  if (cover) fields.cover = cover;
  if (description) fields.description = description;
  fields.comments = meta.comments === false ? false : true;

  const day = date.slice(0, 10).replace(/[^\d-]/g, '') || formatDate(new Date()).slice(0, 10);
  const base = day + '-' + slugFromTitle(title);
  let rel = base + '.md';
  let n = 2;
  while (fs.existsSync(path.join(postsRoot(baseDir), rel))) {
    rel = base + '-' + n + '.md';
    n++;
  }
  const target = resolvePostPath(baseDir, rel);
  fs.mkdirSync(path.dirname(target.full), { recursive: true });
  fs.writeFileSync(target.full, '---\n' + buildFrontMatter(fields) + '\n---\n\n' + body.replace(/\s+$/, '') + '\n', 'utf8');
  return target.rel;
}

function updatePost(baseDir, relPath, meta) {
  const target = resolvePostPath(baseDir, relPath);
  const current = readPost(baseDir, target.rel);
  meta = meta || {};
  const title = normalizeText(meta.title, 200) || current.title;
  const date = normalizeText(meta.date, 40) || current.date || formatDate(new Date());
  const body = String(meta.body == null ? current.body : meta.body).replace(/\r\n/g, '\n');
  if (body.length > 2 * 1024 * 1024) throw new Error('正文超过 2MB。');

  const updates = {
    title: title,
    date: date,
    categories: normalizeList(meta.categories, 20),
    tags: normalizeList(meta.tags, 20),
    cover: normalizeText(meta.cover, 500) || '',
    description: normalizeText(meta.description, 2000) || '',
    comments: meta.comments === false ? false : true,
    published: meta.published === false ? false : null
  };
  // 空的可选字段直接删掉，避免留下空键
  ['cover', 'description'].forEach(function (key) {
    if (!updates[key]) updates[key] = null;
  });
  if (!updates.categories.length) updates.categories = null;
  if (!updates.tags.length) updates.tags = null;
  if (parseFields(current.frontMatter).updated !== undefined) updates.updated = formatDate(new Date());

  const frontMatter = patchFrontMatter(current.frontMatter, updates);
  backupFile(baseDir, target.full);
  fs.writeFileSync(target.full, '---\n' + frontMatter + '\n---\n' + body.replace(/\r\n/g, '\n').replace(/^\n+/, '\n'), 'utf8');
  return target.rel;
}

function deletePost(baseDir, relPath) {
  const target = resolvePostPath(baseDir, relPath);
  if (!fs.existsSync(target.full)) {
    const err = new Error('文章不存在。');
    err.code = 'ENOENT';
    throw err;
  }
  backupFile(baseDir, target.full);
  fs.unlinkSync(target.full);
  return target.rel;
}

/* ------------------------------------------------------------ 修改留痕 */

const REVISION_LIMIT_PER_PATH = 200;
const REVISION_PURGED_LIMIT = 50;
const REVISION_EXTRA_FILES = ['_config.yml', '_config.fomalhaut.yml'];
const DEPLOY_REL = '.admin-deploy.json';
const DEPLOY_TOKEN_PLACEHOLDER = '__ADMIN_KEEP_TOKEN__';

/** 内容的 SHA-256；留痕去重与快照文件名都用它。 */
function hashText(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

function revisionsDir(baseDir) {
  return path.join(baseDir, 'bak', 'admin', 'revisions');
}

function revisionIndexFile(baseDir) {
  return path.join(revisionsDir(baseDir), 'index.json');
}

function revisionSnapshotFile(baseDir, sha) {
  return path.join(revisionsDir(baseDir), 'files', sha + '.md');
}

/**
 * 留痕只允许两类路径：source/_posts 下的 .md，以及两份配置与部署配置。
 * 文章路径复用 resolvePostPath，不新增任何文件系统入口。
 */
function resolveRevisionPath(baseDir, relPath) {
  const rel = String(relPath == null ? '' : relPath).replace(/\\/g, '/');
  if (rel === DEPLOY_REL) return { rel: rel, full: path.join(baseDir, rel) };
  if (REVISION_EXTRA_FILES.indexOf(rel) >= 0) return { rel: rel, full: path.join(baseDir, rel) };
  return resolvePostPath(baseDir, rel);
}

function readRevisionIndex(baseDir) {
  try {
    const data = JSON.parse(fs.readFileSync(revisionIndexFile(baseDir), 'utf8'));
    if (data && Array.isArray(data.items)) return { version: 1, items: data.items };
  } catch (e) { /* 第一次留痕时还没有索引 */ }
  return { version: 1, items: [] };
}

/** 先写临时文件再 rename，避免写一半进程退出把索引写坏。 */
function writeRevisionIndex(baseDir, index) {
  const dir = revisionsDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const temp = revisionIndexFile(baseDir) + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, items: index.items }, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, revisionIndexFile(baseDir));
}

/** 快照按内容哈希存，同一内容只落一份；删改前的版本共用同一份文件。 */
function writeRevisionSnapshot(baseDir, text) {
  const body = String(text == null ? '' : text);
  const sha = hashText(body);
  const file = revisionSnapshotFile(baseDir, sha);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(2).toString('hex');
    fs.writeFileSync(temp, body, 'utf8');
    fs.renameSync(temp, file);
  }
  return { sha256: sha, bytes: Buffer.byteLength(body, 'utf8') };
}

function readRevisionSnapshot(baseDir, sha) {
  try { return fs.readFileSync(revisionSnapshotFile(baseDir, sha), 'utf8'); } catch (e) { return ''; }
}

/** 部署配置里的 Token 不进快照、不进 diff：只留一个占位，回退时沿用当前 Token。 */
function maskDeployText(text) {
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && data.token) {
      data.token = DEPLOY_TOKEN_PLACEHOLDER;
      return JSON.stringify(data, null, 2) + '\n';
    }
  } catch (e) { /* 不是 JSON 就按原文存 */ }
  return String(text == null ? '' : text);
}

function unmaskDeployText(snapshot, current) {
  let data;
  try { data = JSON.parse(snapshot); } catch (e) { return String(snapshot == null ? '' : snapshot); }
  if (data && data.token === DEPLOY_TOKEN_PLACEHOLDER) {
    let token = '';
    try { token = String(JSON.parse(current).token || ''); } catch (e) { token = ''; }
    if (token) data.token = token;
    else delete data.token;
  }
  return JSON.stringify(data, null, 2) + '\n';
}

/** 手写行级 diff（不引第三方库）：先裁掉公共前后缀，再对中段做 LCS。 */
function diffLines(before, after) {
  const a = String(before == null ? '' : before).replace(/\r\n/g, '\n').split('\n');
  const b = String(after == null ? '' : after).replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }

  const out = [];
  for (let i = 0; i < start; i++) out.push({ type: 'same', text: a[i] });

  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  if (midA.length * midB.length > 4000000) {
    // 超长改动不做逐行比对，直接按“整段替换”展示，避免一次请求吃掉几百 MB 内存。
    midA.forEach(function (line) { out.push({ type: 'del', text: line }); });
    midB.forEach(function (line) { out.push({ type: 'add', text: line }); });
  } else {
    out.push.apply(out, lcsDiff(midA, midB));
  }

  for (let i = endA + 1; i < a.length; i++) out.push({ type: 'same', text: a[i] });
  return out;
}

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

function revisionRecordView(item) {
  return {
    id: item.id,
    at: item.at,
    action: item.action,
    target: item.target || item.path || '',
    path: item.path || '',
    bytes: item.bytes || 0,
    sha256: item.sha256 || '',
    stats: item.stats || { added: 0, removed: 0, fields: [] },
    restoreOf: item.restoreOf || '',
    purged: !!item.purged
  };
}

function newRevisionId(index) {
  const prefix = formatDate(new Date()).replace(/[-: ]/g, '');
  const used = new Set(index.items.map(function (item) { return item.id; }));
  for (let i = 0; i < 20; i++) {
    const id = prefix + '-' + crypto.randomBytes(3).toString('hex');
    if (!used.has(id)) return id;
  }
  return prefix + '-' + Date.now().toString(36);
}

/**
 * 每 path 只保留最近 200 条；被裁掉的换成 purged 占位（占位本身也限量），
 * 这样界面能解释“这里曾经有记录”，索引又不会无限膨胀。
 */
function trimRevisions(index) {
  const counts = {};
  let trimmed = 0;
  const kept = [];
  index.items.forEach(function (item) {
    if (item.purged) { kept.push(item); return; }
    const key = item.path || '';
    counts[key] = (counts[key] || 0) + 1;
    if (counts[key] <= REVISION_LIMIT_PER_PATH) {
      kept.push(item);
    } else {
      trimmed += 1;
      kept.push({ id: item.id, at: item.at, action: item.action, path: key, purged: true });
    }
  });
  const purgedCounts = {};
  index.items = kept.filter(function (item) {
    if (!item.purged) return true;
    const key = item.path || '';
    purgedCounts[key] = (purgedCounts[key] || 0) + 1;
    return purgedCounts[key] <= REVISION_PURGED_LIMIT;
  });
  return trimmed;
}

/** 索引裁剪后清掉不再被引用的快照，否则 files/ 会只涨不降。 */
function pruneRevisionSnapshots(baseDir, index) {
  const used = new Set();
  index.items.forEach(function (item) {
    (item.files || []).forEach(function (file) { used.add(file.sha256); });
  });
  const dir = path.join(revisionsDir(baseDir), 'files');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  names.forEach(function (name) {
    const m = name.match(/^([0-9a-f]{64})\.md$/);
    if (!m || used.has(m[1])) return;
    try { fs.unlinkSync(path.join(dir, name)); } catch (e) { /* 忽略 */ }
  });
}

/**
 * 追加一条修改记录。
 * @param {object} input
 *   action: create|update|delete|config|deploy|restore
 *   target: 展示用名称；path: 单文件时可不传
 *   files: [{ path, before, after }]，after 为 null 表示删除
 *   fields: 配置类改动字段 [{key,label,old,new}]
 *   restoreOf: 回退来源记录 id
 *   force: 跳过“同内容去重”（回退、删除用）
 */
function appendRevision(baseDir, input) {
  input = input || {};
  const action = String(input.action || 'update');
  const filesIn = Array.isArray(input.files) ? input.files : [];
  if (!filesIn.length) return null;

  const index = readRevisionIndex(baseDir);
  const latestSha = {};
  index.items.forEach(function (item) {
    if (item.purged || latestSha[item.path] !== undefined) return;
    latestSha[item.path] = item.sha256 || '';
  });

  const changed = [];
  filesIn.forEach(function (file) {
    const target = resolveRevisionPath(baseDir, file.path);
    const before = String(file.before == null ? '' : file.before);
    const after = file.after == null ? '' : String(file.after);
    // 删除时快照存的是被删掉的内容，diff 则是“旧内容 → 空”
    const snapshotText = file.after == null ? before : after;
    const stored = target.rel === DEPLOY_REL ? maskDeployText(snapshotText) : snapshotText;
    const snapshot = writeRevisionSnapshot(baseDir, stored);
    if (!input.force && action !== 'delete' && latestSha[target.rel] === snapshot.sha256) return;
    const lines = diffLines(before, after);
    changed.push({
      path: target.rel,
      sha256: snapshot.sha256,
      bytes: snapshot.bytes,
      added: lines.filter(function (line) { return line.type === 'add'; }).length,
      removed: lines.filter(function (line) { return line.type === 'del'; }).length
    });
  });
  if (!changed.length) return null;

  const fields = Array.isArray(input.fields) ? input.fields : [];
  const pathLabel = changed.length === 1 ? changed[0].path : changed.map(function (file) { return file.path; }).join(' + ');
  const record = {
    id: newRevisionId(index),
    at: new Date().toISOString(),
    action: action,
    target: String(input.target || pathLabel),
    path: pathLabel,
    bytes: changed.reduce(function (sum, file) { return sum + file.bytes; }, 0),
    sha256: changed.length === 1 ? changed[0].sha256 : hashText(changed.map(function (file) { return file.path + ':' + file.sha256; }).join('\n')),
    stats: {
      added: changed.reduce(function (sum, file) { return sum + file.added; }, 0),
      removed: changed.reduce(function (sum, file) { return sum + file.removed; }, 0),
      fields: fields
    },
    restoreOf: String(input.restoreOf || ''),
    files: changed.map(function (file) {
      return { path: file.path, sha256: file.sha256, bytes: file.bytes };
    })
  };

  index.items.unshift(record);
  const trimmed = trimRevisions(index);
  writeRevisionIndex(baseDir, index);
  if (trimmed) pruneRevisionSnapshots(baseDir, index);
  return revisionRecordView(record);
}

function listRevisions(baseDir, options) {
  options = options || {};
  const index = readRevisionIndex(baseDir);
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const action = String(options.action || '');
  const pathFilter = String(options.path || '').replace(/\\/g, '/');

  const counts = {};
  index.items.forEach(function (item) {
    if (item.purged) return;
    const key = item.path || '';
    counts[key] = (counts[key] || 0) + 1;
  });

  const matched = index.items.filter(function (item) {
    if (pathFilter && item.path !== pathFilter) return false;
    if (action && item.action !== action) return false;
    return true;
  });

  return {
    items: matched.slice(0, limit).map(revisionRecordView),
    total: matched.length,
    limit: limit,
    paths: Object.keys(counts).sort().map(function (key) {
      return { path: key, count: counts[key] };
    })
  };
}

function readRevision(baseDir, id) {
  const index = readRevisionIndex(baseDir);
  const pos = index.items.findIndex(function (item) { return item.id === id; });
  if (pos < 0) {
    const err = new Error('没有这条修改记录。');
    err.code = 'ENOENT';
    throw err;
  }
  const item = index.items[pos];
  const view = revisionRecordView(item);
  if (item.purged) return { record: view, files: [], fields: [] };

  const files = (item.files || []).map(function (file) {
    const current = readRevisionSnapshot(baseDir, file.sha256);
    let previous = '';
    // 同 path 的“上一版”= 索引里更旧的最近一条，用它做 diff 的左边
    for (let j = pos + 1; j < index.items.length; j++) {
      const older = index.items[j];
      if (older.purged || !older.files) continue;
      const matched = older.files.find(function (entry) { return entry.path === file.path; });
      if (matched) { previous = readRevisionSnapshot(baseDir, matched.sha256); break; }
    }
    let oldText = previous;
    let newText = current;
    if (item.action === 'delete') {
      oldText = current;
      newText = '';
    }
    return {
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      oldText: oldText,
      newText: newText,
      diff: diffLines(oldText, newText)
    };
  });

  return { record: view, files: files, fields: (item.stats && item.stats.fields) || [] };
}

/**
 * 回退到某条记录：把快照写回原路径（删除记录则重建文件），
 * 再以 action=restore 追加一条新记录，保证还能退回来。
 */
function restoreRevision(baseDir, id) {
  const index = readRevisionIndex(baseDir);
  const item = index.items.find(function (entry) { return entry.id === id; });
  if (!item) {
    const err = new Error('没有这条修改记录。');
    err.code = 'ENOENT';
    throw err;
  }
  if (item.purged) throw new Error('这条记录的内容已被清理，无法回退。请选更近的一条。');

  const planned = (item.files || []).map(function (file) {
    const target = resolveRevisionPath(baseDir, file.path);
    let text = readRevisionSnapshot(baseDir, file.sha256);
    if (target.rel === DEPLOY_REL) {
      let current = '';
      try { current = fs.readFileSync(target.full, 'utf8'); } catch (e) { current = ''; }
      text = unmaskDeployText(text, current);
    }
    return { target: target, text: text, rel: target.rel };
  });

  const written = planned.map(function (entry) {
    let before = '';
    if (fs.existsSync(entry.target.full)) {
      before = fs.readFileSync(entry.target.full, 'utf8');
      backupFile(baseDir, entry.target.full);
    }
    fs.mkdirSync(path.dirname(entry.target.full), { recursive: true });
    fs.writeFileSync(entry.target.full, entry.text, 'utf8');
    return { path: entry.rel, before: before, after: entry.text };
  });

  const record = appendRevision(baseDir, {
    action: 'restore',
    target: item.target,
    restoreOf: item.id,
    files: written,
    fields: [],
    force: true
  });
  return { record: record, files: planned.map(function (entry) { return entry.rel; }) };
}

module.exports = {
  POSTS_REL: POSTS_REL,
  SETUP_VARS: SETUP_VARS,
  loadAdminConfig: loadAdminConfig,
  missingSetupVars: missingSetupVars,
  safeEqual: safeEqual,
  isLoopback: isLoopback,
  parseCookies: parseCookies,
  splitFrontMatter: splitFrontMatter,
  parseFields: parseFields,
  patchFrontMatter: patchFrontMatter,
  buildFrontMatter: buildFrontMatter,
  getYamlPath: getYamlPath,
  setYamlPath: setYamlPath,
  resolvePostPath: resolvePostPath,
  listPosts: listPosts,
  readPost: readPost,
  createPost: createPost,
  updatePost: updatePost,
  deletePost: deletePost,
  backupFile: backupFile,
  formatDate: formatDate,
  slugFromTitle: slugFromTitle,
  hashText: hashText,
  revisionsDir: revisionsDir,
  resolveRevisionPath: resolveRevisionPath,
  appendRevision: appendRevision,
  listRevisions: listRevisions,
  readRevision: readRevision,
  restoreRevision: restoreRevision,
  diffLines: diffLines
};
