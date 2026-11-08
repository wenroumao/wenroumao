'use strict';
/**
 * tools/admin/exporter.js —— 三期：导出
 * ---------------------------------------------------------------------------
 * 三个能力，全部不依赖第三方包：
 *   1. buildMarkdown(meta)  生成带 front matter 的 .md 文本
 *   2. buildDocx(meta)      手写 OOXML，再用 package.js 里已有的 zip 写入器打包
 *
 * docx 里的图片会按需下载：只允许 http/https、只允许公网地址（复用 importer
 * 的 SSRF 判定）、单张上限 2 MB；下载失败或超限时保留文字提示，不阻塞导出。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const core = require('./core');
const importer = require('./importer');
const packaging = require('./package');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 8000;
const EMU_PER_INCH = 914400;
const MAX_IMAGE_WIDTH_EMU = Math.round(6 * EMU_PER_INCH);
const MAX_IMAGE_HEIGHT_EMU = Math.round(8.5 * EMU_PER_INCH);

/* --------------------------------------------------------------- 通用小工具 */

function xmlEscape(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeEntities(text) {
  return String(text == null ? '' : text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function trimList(value, max) {
  return String(value == null ? '' : value)
    .split(/[,，]/)
    .map(function (item) { return item.trim(); })
    .filter(function (item) { return item; })
    .slice(0, max || 20);
}

function safeFilename(title) {
  const base = String(title || '').trim() || '未命名文章';
  return base.replace(/[\\/:*?"<>|\r\n\t]/g, '-').replace(/\s+/g, ' ').slice(0, 80);
}

/* --------------------------------------------------------------- 1. Markdown */

function buildMarkdown(meta) {
  meta = meta || {};
  const title = String(meta.title || '').trim() || '未命名文章';
  const date = String(meta.date || '').trim() || core.formatDate(new Date());
  const body = String(meta.body == null ? '' : meta.body).replace(/\r\n/g, '\n').replace(/\s+$/, '');

  const fields = { title: title, date: date };
  if (meta.published === false) fields.published = false;
  const categories = trimList(meta.categories);
  const tags = trimList(meta.tags);
  if (categories.length) fields.categories = categories;
  if (tags.length) fields.tags = tags;
  if (String(meta.cover || '').trim()) fields.cover = String(meta.cover).trim();
  if (String(meta.description || '').trim()) fields.description = String(meta.description).trim();
  fields.comments = meta.comments === false ? false : true;

  return {
    filename: safeFilename(title) + '.md',
    charCount: body.replace(/\s/g, '').length,
    markdown: '---\n' + core.buildFrontMatter(fields) + '\n---\n\n' + body + '\n'
  };
}

/* ------------------------------------------------------ Markdown → 结构化 */

const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+.#-]*)\s*$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_IMAGE_ONLY = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)\s*$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;
const RE_TOC = /^\s*<!--\s*(toc|more)\s*-->\s*$/i;

function isTableRow(line) {
  return /\|/.test(line) && !RE_HEADING.test(line);
}

function splitTableRow(line) {
  let text = String(line).trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (ch === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function tableAlignments(line) {
  return splitTableRow(line).map(function (cell) {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

/** 把一段内联文本拆成 run：粗体、斜体、删除线、代码、链接、图片、颜色/字号。 */
function parseInline(input) {
  let text = String(input == null ? '' : input);
  // 常见内联 HTML 先翻译成 Markdown 等价写法；span 留给下面的规则处理
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, function (all, src) {
    const alt = /alt=["']([^"']*)["']/i.exec(all);
    return '![' + (alt ? alt[1] : '') + '](' + src + ')';
  });
  text = text.replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, function (all, href, label) {
    return '[' + label.replace(/<[^>]+>/g, '') + '](' + href + ')';
  });
  text = text.replace(/<(?!\/?span\b)[^>]+>/gi, '');

  const runs = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~]+~~|`[^`]+`|!\[[^\]]*\]\([^)]+\)|\[[^\]]*\]\([^)]+\)|<span\b[^>]*>[\s\S]*?<\/span>)/g;
  let last = 0;
  let match;

  function pushText(value, extra) {
    if (!value) return;
    const lastRun = runs[runs.length - 1];
    const same = !extra && lastRun && lastRun.type === 'text' && !lastRun.bold && !lastRun.italic &&
      !lastRun.strike && !lastRun.code && !lastRun.color && !lastRun.size;
    if (same) { lastRun.text += value; return; }
    runs.push(Object.assign({ type: 'text', text: value }, extra || {}));
  }

  while ((match = pattern.exec(text))) {
    pushText(decodeEntities(text.slice(last, match.index)));
    const token = match[0];
    last = match.index + token.length;

    if (token.startsWith('**') || token.startsWith('__')) {
      pushText(decodeEntities(token.slice(2, -2)), { bold: true });
    } else if (token.startsWith('~~')) {
      pushText(decodeEntities(token.slice(2, -2)), { strike: true });
    } else if (token.startsWith('`')) {
      pushText(token.slice(1, -1), { code: true });
    } else if (token.startsWith('![')) {
      const img = /^!\[([^\]]*)\]\(([^)\s]+)/.exec(token);
      if (img) runs.push({ type: 'image', alt: decodeEntities(img[1]), url: img[2] });
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]*)\]\(([^)\s]+)/.exec(token);
      if (link) runs.push({ type: 'link', text: decodeEntities(link[1]), url: link[2] });
    } else if (token.toLowerCase().startsWith('<span')) {
      const span = /^<span\b[^>]*style=["']([^"']*)["'][^>]*>([\s\S]*?)<\/span>$/i.exec(token);
      if (span) {
        const style = span[1];
        const extra = {};
        const color = /color\s*:\s*(#[0-9a-fA-F]{3,8})/i.exec(style);
        const size = /font-size\s*:\s*(\d+(?:\.\d+)?)\s*(px|pt)/i.exec(style);
        if (color) {
          let hex = color[1].slice(1);
          if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
          if (hex.length === 6 || hex.length === 8) extra.color = hex.slice(0, 6).toUpperCase();
        }
        if (size) {
          const value = parseFloat(size[1]);
          const pt = size[2].toLowerCase() === 'px' ? value * 0.75 : value;
          extra.size = Math.max(8, Math.min(144, Math.round(pt * 2)));
        }
        const inner = parseInline(span[2]);
        inner.forEach(function (run) {
          if (run.type === 'text' && Object.keys(extra).length) {
            if (extra.color && !run.color) run.color = extra.color;
            if (extra.size && !run.size) run.size = extra.size;
          }
          runs.push(run);
        });
      }
    } else if (token.startsWith('*') || token.startsWith('_')) {
      pushText(decodeEntities(token.slice(1, -1)), { italic: true });
    }
  }
  pushText(decodeEntities(text.slice(last)));
  return runs;
}

/** 正文 → 块数组。只覆盖导出需要的结构，不追求完整 Markdown 语法。 */
function parseBlocks(body) {
  const lines = String(body == null ? '' : body).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  function flushParagraph(buffer) {
    const text = buffer.join('\n').replace(/\s+$/, '');
    if (!text.trim()) return;
    blocks.push({ type: 'paragraph', runs: parseInline(text) });
  }

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim() || RE_TOC.test(line)) { i++; continue; }

    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1].charAt(0);
      const indent = fence[1].length;
      const code = [];
      i++;
      while (i < lines.length) {
        const close = RE_FENCE.exec(lines[i]);
        if (close && close[1].charAt(0) === marker && close[1].length >= indent) { i++; break; }
        code.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', lang: fence[2] || '', text: code.join('\n') });
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, runs: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (RE_HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    if (RE_QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        inner.push(RE_QUOTE.exec(lines[i])[1]);
        i++;
      }
      parseBlocks(inner.join('\n')).forEach(function (block) {
        block.quote = true;
        blocks.push(block);
      });
      continue;
    }

    const image = RE_IMAGE_ONLY.exec(line);
    if (image) {
      blocks.push({ type: 'image', runs: [{ type: 'image', alt: decodeEntities(image[1]), url: image[2] }], align: 'center' });
      i++;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = tableAlignments(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header: header, aligns: aligns, rows: rows });
      continue;
    }

    const listItem = RE_LIST.exec(line);
    if (listItem) {
      const items = [];
      while (i < lines.length) {
        const item = RE_LIST.exec(lines[i]);
        if (!item) break;
        const indent = item[1].replace(/\t/g, '  ').length;
        items.push({
          level: Math.min(4, Math.floor(indent / 2)),
          ordered: /\d/.test(item[2]),
          runs: parseInline(item[3])
        });
        i++;
      }
      blocks.push({ type: 'list', items: items });
      continue;
    }

    const buffer = [];
    while (i < lines.length) {
      const current = lines[i];
      if (!current.trim()) break;
      if (RE_FENCE.test(current) || RE_HEADING.test(current) || RE_HR.test(current) ||
          RE_QUOTE.test(current) || RE_LIST.test(current) || RE_IMAGE_ONLY.test(current)) break;
      if (isTableRow(current) && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) break;
      buffer.push(current);
      i++;
    }
    flushParagraph(buffer);
  }

  return blocks;
}

/* ------------------------------------------------------------- 图片处理 */

function detectImage(buffer) {
  if (!buffer || !buffer.length) return null;
  if (buffer.length >= 8 && buffer.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { type: 'png', ext: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 6) {
    const head = buffer.slice(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') {
      return { type: 'gif', ext: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const size = jpegSize(buffer);
    return { type: 'jpeg', ext: 'jpg', width: size.width, height: size.height };
  }
  if (buffer.length >= 12 && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return { type: 'webp', ext: '', width: 0, height: 0 };
  }
  if (buffer.length >= 26 && buffer.slice(0, 2).toString('ascii') === 'BM') {
    return { type: 'bmp', ext: 'bmp', width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
  }
  return null;
}

function jpegSize(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = buffer.readUInt16BE(offset);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return { width: 0, height: 0 };
}

function parseDataUrl(url) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(String(url || ''));
  if (!match) return null;
  const mime = (match[1] || 'image/png').toLowerCase();
  const raw = match[3];
  let buffer;
  try {
    buffer = match[2] ? Buffer.from(raw, 'base64') : Buffer.from(decodeURIComponent(raw), 'binary');
  } catch (e) {
    return null;
  }
  return { buffer: buffer, mime: mime };
}

function pinnedLookup(addresses) {
  return function (hostname, options, callback) {
    if (!addresses.length) return callback(new Error('没有可用地址'));
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  };
}

/** 下载公网图片；任何一步不满足安全条件都拒绝。 */
function fetchImage(url) {
  return new Promise(function (resolve, reject) {
    let parsed;
    try {
      parsed = importer.normalizeUrl(url);
    } catch (err) {
      return reject(err);
    }
    importer.assertPublicHost(parsed.hostname).then(function (addresses) {
      const lib = parsed.protocol === 'https:' ? https : http;
      let settled = false;
      let timer = null;
      let req = null;

      function finish(err, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (req) req.destroy();
        if (err) reject(err); else resolve(value);
      }

      timer = setTimeout(function () {
        finish(new Error('图片下载超时'));
      }, IMAGE_TIMEOUT_MS);

      try {
        req = lib.request(parsed, {
          method: 'GET',
          lookup: pinnedLookup(addresses),
          headers: { 'User-Agent': 'hexo-admin-export/1.0', Accept: 'image/*' }
        }, function (res) {
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            res.resume();
            return finish(new Error('图片返回 HTTP ' + status));
          }
          const type = String(res.headers['content-type'] || '').toLowerCase();
          if (type && !/^image\//.test(type)) {
            res.resume();
            return finish(new Error('图片地址返回的不是图片（' + type + '）'));
          }
          const chunks = [];
          let size = 0;
          res.on('data', function (chunk) {
            size += chunk.length;
            if (size > MAX_IMAGE_BYTES) {
              finish(new Error('图片超过 2 MB'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', function () { finish(null, Buffer.concat(chunks)); });
          res.on('error', function (err) { finish(err); });
        });
        req.on('error', function (err) { finish(err); });
        req.end();
      } catch (err) {
        finish(err);
      }
    }).catch(reject);
  });
}

async function loadImage(url, warnings) {
  if (typeof url !== 'string' || !url) return null;
  if (url.startsWith('data:')) {
    const data = parseDataUrl(url);
    if (!data) { warnings.push('图片 data URL 解析失败。'); return null; }
    if (data.buffer.length > MAX_IMAGE_BYTES) {
      warnings.push('内嵌图片超过 2 MB，已跳过：' + data.mime);
      return null;
    }
    const info = detectImage(data.buffer);
    if (!info || !info.ext) { warnings.push('无法识别的内嵌图片格式，已跳过。'); return null; }
    return { buffer: data.buffer, info: info };
  }
  if (!/^https?:\/\//i.test(url)) {
    warnings.push('相对路径图片未嵌入 Word（缺少站点域名）：' + url);
    return null;
  }
  try {
    const buffer = await fetchImage(url);
    const info = detectImage(buffer);
    if (!info) { warnings.push('无法识别的图片格式，已跳过：' + url); return null; }
    if (!info.ext) { warnings.push('WebP 图片暂不支持嵌入 Word：' + url); return null; }
    return { buffer: buffer, info: info };
  } catch (err) {
    warnings.push('图片未能嵌入（' + (err.message || '下载失败') + '）：' + url);
    return null;
  }
}

/* ----------------------------------------------------------- 3. DOCX 生成 */

function escapeAttr(text) {
  return xmlEscape(text).replace(/\n/g, ' ');
}

function rPr(options) {
  const parts = [];
  if (options.code) {
    parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/>');
  }
  if (options.bold) parts.push('<w:b/>');
  if (options.italic) parts.push('<w:i/>');
  if (options.strike) parts.push('<w:strike/>');
  if (options.color) parts.push('<w:color w:val="' + options.color + '"/>');
  if (options.size) parts.push('<w:sz w:val="' + options.size + '"/><w:szCs w:val="' + options.size + '"/>');
  if (options.link) parts.push('<w:color w:val="0563C1"/><w:u w:val="single"/>');
  if (options.code) parts.push('<w:shd w:val="clear" w:color="auto" w:fill="F2F3F5"/>');
  return parts.length ? '<w:rPr>' + parts.join('') + '</w:rPr>' : '';
}

function textRun(text, options) {
  const opts = options || {};
  const pieces = String(text == null ? '' : text).split('\n');
  return pieces.map(function (piece, index) {
    const br = index > 0 ? '<w:br/>' : '';
    if (!piece) return br ? '<w:r>' + br + '</w:r>' : '';
    return '<w:r>' + rPr(opts) + br + '<w:t xml:space="preserve">' + xmlEscape(piece) + '</w:t></w:r>';
  }).join('');
}

function drawingXml(image, ctx) {
  const info = image.info;
  let cx = info.width ? Math.round((info.width / 96) * EMU_PER_INCH) : Math.round(4 * EMU_PER_INCH);
  let cy = info.height ? Math.round((info.height / 96) * EMU_PER_INCH) : Math.round(3 * EMU_PER_INCH);
  if (cx > MAX_IMAGE_WIDTH_EMU) {
    const ratio = MAX_IMAGE_WIDTH_EMU / cx;
    cx = MAX_IMAGE_WIDTH_EMU;
    cy = Math.round(cy * ratio);
  }
  if (cy > MAX_IMAGE_HEIGHT_EMU) {
    const ratio = MAX_IMAGE_HEIGHT_EMU / cy;
    cy = MAX_IMAGE_HEIGHT_EMU;
    cx = Math.round(cx * ratio);
  }
  const id = ctx.nextDrawingId++;
  return '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
    '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
    '<wp:docPr id="' + id + '" name="图片 ' + id + '" descr="' + escapeAttr(image.alt || '') + '"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + id + '" name="' + image.part + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="' + image.rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing>';
}

function runsXml(runs, ctx) {
  return (runs || []).map(function (run) {
    if (run.type === 'image') {
      if (run.image) return '<w:r>' + drawingXml(run.image, ctx) + '</w:r>';
      const label = run.alt || run.url || '图片';
      return textRun('[图片：' + label + ']', { italic: true });
    }
    if (run.type === 'link') {
      const rid = ctx.addRel(run.url);
      if (!rid) return textRun(run.text, { link: true });
      return '<w:hyperlink r:id="' + rid + '">' + textRun(run.text, { link: true }) + '</w:hyperlink>';
    }
    return textRun(run.text, {
      bold: run.bold, italic: run.italic, strike: run.strike, code: run.code,
      color: run.color, size: run.size
    });
  }).join('');
}

function paragraph(runs, options) {
  const opts = options || {};
  const props = [];
  if (opts.style) props.push('<w:pStyle w:val="' + opts.style + '"/>');
  if (opts.list) {
    props.push('<w:numPr><w:ilvl w:val="' + opts.list.level + '"/><w:numId w:val="' + (opts.list.ordered ? 2 : 1) + '"/></w:numPr>');
  }
  if (opts.quote) {
    props.push('<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C9CED6"/></w:pBdr>');
    props.push('<w:shd w:val="clear" w:color="auto" w:fill="F7F8FA"/>');
    props.push('<w:ind w:left="360" w:right="180"/>');
  }
  if (opts.indent && !opts.quote) props.push('<w:ind w:left="' + opts.indent + '"/>');
  if (opts.align) props.push('<w:jc w:val="' + opts.align + '"/>');
  return '<w:p>' + (props.length ? '<w:pPr>' + props.join('') + '</w:pPr>' : '') + runs + '</w:p>';
}

function emptyParagraph(style) {
  return '<w:p><w:pPr><w:pStyle w:val="' + style + '"/></w:pPr></w:p>';
}

function tableXml(block, ctx) {
  const cols = Math.max(1, block.header.length);
  const grid = new Array(cols).fill('<w:gridCol w:w="' + Math.floor(8300 / cols) + '"/>').join('');
  const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (side) {
    return '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="C9CED6"/>';
  }).join('');
  const rows = [];
  const headerCells = block.header.map(function (cell, index) {
    const align = block.aligns[index] || 'left';
    const runs = parseInline(cell).map(function (run) {
      return run.type === 'text' ? Object.assign({}, run, { bold: true }) : run;
    });
    return '<w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F2F3F5"/></w:tcPr>' +
      paragraph(runsXml(runs, ctx), { align: align }) + '</w:tc>';
  });
  rows.push('<w:tr>' + headerCells.join('') + '</w:tr>');
  block.rows.forEach(function (cells) {
    const rowCells = [];
    for (let i = 0; i < cols; i++) {
      rowCells.push('<w:tc><w:tcPr/>' +
        paragraph(runsXml(parseInline(cells[i] || ''), ctx), { align: block.aligns[i] || 'left' }) + '</w:tc>');
    }
    rows.push('<w:tr>' + rowCells.join('') + '</w:tr>');
  });
  return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' + border +
    '</w:tblBorders></w:tblPr><w:tblGrid>' + grid + '</w:tblGrid>' + rows.join('') + '</w:tbl>';
}

function documentXml(blocks, ctx) {
  const body = [];
  blocks.forEach(function (block) {
    if (block.type === 'heading') {
      const level = Math.max(1, Math.min(6, block.level));
      body.push(paragraph(runsXml(block.runs, ctx), {
        style: 'Heading' + level,
        align: block.quote ? 'left' : null,
        quote: block.quote
      }));
      return;
    }
    if (block.type === 'code') {
      const lines = String(block.text || '').split('\n');
      if (!lines.length) lines.push('');
      lines.forEach(function (line) {
        body.push('<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr>' +
          textRun(line || ' ', { code: true, size: 18 }) + '</w:p>');
      });
      body.push(emptyParagraph('Normal'));
      return;
    }
    if (block.type === 'list') {
      block.items.forEach(function (item) {
        body.push(paragraph(runsXml(item.runs, ctx), {
          list: { ordered: item.ordered, level: item.level },
          quote: block.quote
        }));
      });
      return;
    }
    if (block.type === 'table') {
      body.push(tableXml(block, ctx));
      body.push(emptyParagraph('Normal'));
      return;
    }
    if (block.type === 'hr') {
      body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C9CED6"/></w:pBdr></w:pPr></w:p>');
      return;
    }
    if (block.type === 'image' || block.type === 'paragraph') {
      const hasImage = block.runs && block.runs.some(function (run) { return run.type === 'image' && run.image; });
      body.push(paragraph(runsXml(block.runs, ctx), {
        align: block.align || (hasImage ? 'center' : null),
        quote: block.quote
      }));
      return;
    }
  });
  if (!body.length) body.push(paragraph(textRun('（空文档）', {}), {}));
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body>' + body.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>';
}

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>' +
  '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  headingStyle(1, 44, '2E3A48', 360, 200) +
  headingStyle(2, 36, '2E3A48', 300, 160) +
  headingStyle(3, 30, '2E3A48', 260, 140) +
  headingStyle(4, 26, '3A4654', 220, 120) +
  headingStyle(5, 24, '3A4654', 200, 100) +
  headingStyle(6, 22, '55606E', 180, 100) +
  '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F3F5"/><w:spacing w:after="0" w:line="264" w:lineRule="auto"/></w:pPr>' +
  '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/><w:sz w:val="18"/></w:rPr></w:style>' +
  '</w:styles>';

function headingStyle(level, size, color, before, after) {
  return '<w:style w:type="paragraph" w:styleId="Heading' + level + '"><w:name w:val="heading ' + level + '"/>' +
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="' + before + '" w:after="' + after + '"/></w:pPr>' +
    '<w:rPr><w:b/><w:color w:val="' + color + '"/><w:sz w:val="' + size + '"/><w:szCs w:val="' + size + '"/></w:rPr></w:style>';
}

const NUMBERING_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  abstractNum(1, 'bullet', ['•', '◦', '▪', '·', '•']) +
  abstractNum(2, 'decimal', ['%1.', '%2.', '%3.', '%4.', '%5.']) +
  '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>' +
  '<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>' +
  '</w:numbering>';

function abstractNum(id, format, texts) {
  const levels = texts.map(function (text, level) {
    const indent = 720 * (level + 1);
    return '<w:lvl w:ilvl="' + level + '"><w:start w:val="1"/><w:numFmt w:val="' + format + '"/>' +
      '<w:lvlText w:val="' + xmlEscape(text) + '"/><w:lvlJc w:val="left"/>' +
      '<w:pPr><w:ind w:left="' + indent + '" w:hanging="360"/></w:pPr></w:lvl>';
  }).join('');
  return '<w:abstractNum w:abstractNumId="' + id + '"><w:multiLevelType w:val="hybridMultilevel"/>' +
    levels + '</w:abstractNum>';
}

/** 生成 docx 需要的所有部件（文件名 → Buffer）。 */
async function buildParts(meta, warnings) {
  const blocks = parseBlocks(meta && meta.body);
  const ctx = {
    nextRid: 1, nextDrawingId: 1, rels: [], media: [], warnings: warnings,
    addRel: function (url) {
      const target = String(url || '').trim();
      if (!/^https?:\/\//i.test(target)) return '';
      const rid = 'rId' + ctx.nextRid++;
      ctx.rels.push('<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' +
        escapeAttr(target) + '" TargetMode="External"/>');
      return rid;
    }
  };

  const images = [];
  blocks.forEach(function (block) {
    (block.runs || []).forEach(function (run) { if (run.type === 'image') images.push(run); });
  });
  for (let i = 0; i < images.length; i++) {
    const run = images[i];
    const loaded = await loadImage(run.url, warnings);
    if (!loaded) continue;
    const part = 'word/media/image' + (ctx.media.length + 1) + '.' + loaded.info.ext;
    const rid = 'rId' + ctx.nextRid++;
    ctx.rels.push('<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' +
      part.replace('word/', '') + '"/>');
    ctx.media.push({ path: part, buffer: loaded.buffer });
    run.image = { rid: rid, part: path.basename(part), alt: run.alt, info: loaded.info };
  }

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpg" ContentType="image/jpeg"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Default Extension="gif" ContentType="image/gif"/>' +
    '<Default Extension="bmp" ContentType="image/bmp"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '</Types>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    ctx.rels.join('') + '</Relationships>';

  const parts = {
    '[Content_Types].xml': Buffer.from(contentTypes, 'utf8'),
    '_rels/.rels': Buffer.from(rootRels, 'utf8'),
    'word/document.xml': Buffer.from(documentXml(blocks, ctx), 'utf8'),
    'word/styles.xml': Buffer.from(STYLES_XML, 'utf8'),
    'word/numbering.xml': Buffer.from(NUMBERING_XML, 'utf8'),
    'word/_rels/document.xml.rels': Buffer.from(docRels, 'utf8')
  };
  ctx.media.forEach(function (item) {
    parts[item.path] = item.buffer;
  });
  return { parts: parts, blocks: blocks };
}

async function buildDocx(meta) {
  const warnings = [];
  meta = meta || {};
  const built = await buildParts(meta, warnings);
  const rels = Object.keys(built.parts);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hexo-admin-docx-'));
  const outFile = path.join(staging, 'out.docx');
  try {
    rels.forEach(function (rel) {
      const full = path.join(staging, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, built.parts[rel]);
    });
    packaging.writeZip(staging, outFile, rels);
    const buffer = fs.readFileSync(outFile);
    return {
      filename: safeFilename(meta.title) + '.docx',
      buffer: buffer,
      size: buffer.length,
      warnings: warnings,
      images: rels.filter(function (rel) { return rel.startsWith('word/media/'); }).length
    };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

module.exports = {
  MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
  buildMarkdown: buildMarkdown,
  buildDocx: buildDocx,
  buildParts: buildParts,
  parseBlocks: parseBlocks,
  parseInline: parseInline,
  detectImage: detectImage,
  safeFilename: safeFilename
};
