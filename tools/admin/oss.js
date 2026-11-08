'use strict';
/**
 * tools/admin/oss.js —— 阿里云 OSS 图床
 * ---------------------------------------------------------------------------
 * 设计取舍：
 *   - 上传走 JSON + base64（而不是手写 multipart 解析），实现更稳、无第三方依赖；
 *     浏览器用 XHR 上报进度。单文件上限 10 MB，请求体上限 16 MB。
 *   - 签名使用 OSS V1（HMAC-SHA1），所有签名在服务端完成，AccessKey 不下发浏览器。
 *   - 只允许常见位图（不接受 SVG，避免在图片域名下执行脚本）。
 *   - 配置存 .admin-oss.json（0600），可用 OSS_* 环境变量覆盖；
 *     GET /admin/api/oss/config 永远不返回 accessKeySecret。
 *   - 日志与错误信息只出现 OSS 错误码与脱敏提示，不包含 Secret。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const CONFIG_FILE = '.admin-oss.json';
const MAX_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT = 20000;
const DOMAIN_TIMEOUT = 6000;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const DELETE_MAX = 100;

/** 资源管理器里允许展示 / 操作的图片扩展名。 */
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'];

const ENV_NAMES = {
  accessKeyId: 'OSS_ACCESS_KEY_ID',
  accessKeySecret: 'OSS_ACCESS_KEY_SECRET',
  bucket: 'OSS_BUCKET',
  region: 'OSS_REGION',
  customDomain: 'OSS_CUSTOM_DOMAIN',
  pathPrefix: 'OSS_PATH_PREFIX'
};

const IMAGE_TYPES = {
  'image/jpeg': { ext: 'jpg', allowed: ['jpg', 'jpeg'] },
  'image/png': { ext: 'png', allowed: ['png'] },
  'image/gif': { ext: 'gif', allowed: ['gif'] },
  'image/webp': { ext: 'webp', allowed: ['webp'] },
  'image/avif': { ext: 'avif', allowed: ['avif'] },
  'image/bmp': { ext: 'bmp', allowed: ['bmp'] },
  'image/tiff': { ext: 'tif', allowed: ['tif', 'tiff'] }
};

const MIME_ALIASES = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-icon': 'image/vnd.microsoft.icon'
};

/** 1×1 透明 PNG，用于连通性测试。 */
const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function ossError(code, label, message, hint) {
  const err = new Error(message);
  err.code = code;
  err.label = label;
  if (hint) err.hint = hint;
  return err;
}

function normalizeRegion(value) {
  let region = String(value == null ? '' : value).trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  if (!region) return '';
  if (!/^oss-/i.test(region) && /^[a-z]{2}-/i.test(region)) region = 'oss-' + region;
  return region.toLowerCase();
}

function normalizePrefix(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/').split('/')
    .filter(function (part) { return part && part !== '.' && part !== '..'; })
    .map(function (part) {
      return part.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    })
    .filter(Boolean)
    .join('/');
}

function normalizeDomain(value) {
  let domain = String(value == null ? '' : value).trim().replace(/\/+$/, '');
  if (!domain) return '';
  if (!/^https?:\/\//i.test(domain)) domain = 'https://' + domain;
  return domain;
}

function readLocal(baseDir) {
  try {
    const raw = fs.readFileSync(path.join(baseDir, CONFIG_FILE), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (e) { return {}; }
}

/** 文件 + 环境变量合并；环境变量优先。 */
function effectiveConfig(baseDir, env) {
  const local = readLocal(baseDir);
  const source = env || process.env;
  const overrides = {};
  const config = {};

  Object.keys(ENV_NAMES).forEach(function (field) {
    const envName = ENV_NAMES[field];
    const envValue = source && source[envName] != null ? String(source[envName]).trim() : '';
    if (envValue) {
      overrides[field] = true;
      config[field] = envValue;
    } else {
      overrides[field] = false;
      config[field] = String(local[field] == null ? '' : local[field]).trim();
    }
  });

  config.region = normalizeRegion(config.region);
  config.customDomain = normalizeDomain(config.customDomain);
  config.pathPrefix = normalizePrefix(config.pathPrefix);
  return { config: config, overrides: overrides, local: local };
}

function configured(config) {
  return !!(config && config.accessKeyId && config.accessKeySecret && config.bucket && config.region);
}

/** 面向前端的描述：绝不带 secret 明文。 */
function describe(baseDir, env) {
  const merged = effectiveConfig(baseDir, env);
  const config = merged.config;
  return {
    configured: configured(config),
    config: {
      accessKeyId: config.accessKeyId,
      bucket: config.bucket,
      region: config.region,
      customDomain: config.customDomain,
      pathPrefix: config.pathPrefix,
      hasSecret: !!config.accessKeySecret
    },
    overrides: merged.overrides,
    file: CONFIG_FILE,
    limits: {
      maxBytes: MAX_BYTES,
      maxLabel: '10 MB',
      types: Object.keys(IMAGE_TYPES)
    },
    note: 'AccessKeySecret 只保存在本机 .admin-oss.json（或环境变量），接口只返回是否已配置。'
  };
}

/** 保存配置：secret 留空表示保留原值；写入权限尽量收紧。 */
function saveConfig(baseDir, patch, env) {
  const input = patch || {};
  const local = readLocal(baseDir);
  const next = Object.assign({}, local);

  ['accessKeyId', 'bucket', 'customDomain'].forEach(function (field) {
    if (input[field] !== undefined) next[field] = String(input[field] == null ? '' : input[field]).trim();
  });
  if (input.region !== undefined) next.region = normalizeRegion(input.region);
  if (input.pathPrefix !== undefined) next.pathPrefix = normalizePrefix(input.pathPrefix);
  if (input.accessKeySecret !== undefined) {
    const secret = String(input.accessKeySecret == null ? '' : input.accessKeySecret).trim();
    if (secret) next.accessKeySecret = secret;
  }

  const file = path.join(baseDir, CONFIG_FILE);
  const text = JSON.stringify({
    accessKeyId: next.accessKeyId || '',
    accessKeySecret: next.accessKeySecret || '',
    bucket: next.bucket || '',
    region: next.region || '',
    customDomain: next.customDomain || '',
    pathPrefix: next.pathPrefix || ''
  }, null, 2) + '\n';

  const tmp = file + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (e) { /* Windows 上可能不支持 */ }
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
      try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* 忽略 */ }
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (e) { /* 忽略 */ }
    throw ossError('OSS_CONFIG_WRITE_FAILED', '配置保存失败', '无法写入 .admin-oss.json：' + err.message);
  }

  return describe(baseDir, env);
}

/* ---------------------------------------------------------------- 图片校验 */

function sniffImage(buffer) {
  if (!buffer || !buffer.length) return '';
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 &&
      buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6) {
    const gif = buffer.slice(0, 6).toString('ascii');
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
      buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if (buffer.length >= 4 && (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
  )) return 'image/tiff';
  if (buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return '';
}

function extOf(name) {
  const base = String(name == null ? '' : name).replace(/\\/g, '/').split('/').pop();
  const match = /\.([A-Za-z0-9]+)$/.exec(base);
  return match ? match[1].toLowerCase() : '';
}

function isImageKey(key) {
  return IMAGE_EXTENSIONS.indexOf(extOf(key)) >= 0;
}

function xmlUnescape(value) {
  return String(value == null ? '' : value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 列表用的前缀：保留中文与结尾斜杠，只去掉开头斜杠和危险段。 */
function normalizeListPrefix(value) {
  const raw = String(value == null ? '' : value).replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = raw.split('/').filter(function (part) { return part && part !== '.' && part !== '..'; });
  const joined = parts.join('/');
  return joined && /\/$/.test(raw) ? joined + '/' : joined;
}

/** 允许删除/读取的 key：不含目录穿越与开头斜杠。 */
function normalizeObjectKey(value) {
  const key = String(value == null ? '' : value).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!key || key.length > 1023) return '';
  if (key.split('/').some(function (part) { return part === '.' || part === '..'; })) return '';
  return key;
}

function validateImage(payload) {
  const name = String(payload && payload.name || '');
  const declaredRaw = String(payload && payload.type || '').trim().toLowerCase().split(';')[0];
  const declared = MIME_ALIASES[declaredRaw] || declaredRaw;

  if (!IMAGE_TYPES[declared]) {
    throw ossError('OSS_NOT_IMAGE', '不是图片',
      '只允许 ' + Object.keys(IMAGE_TYPES).join('、') + ' 这些图片格式。');
  }

  const ext = extOf(name);
  if (ext && IMAGE_TYPES[declared].allowed.indexOf(ext) < 0) {
    throw ossError('OSS_NOT_IMAGE', '不是图片', '文件扩展名 .' + ext + ' 与图片类型 ' + declared + ' 不匹配。');
  }

  const base64 = String(payload && payload.data || '')
    .replace(/^data:[^;]+;base64,/i, '')
    .replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw ossError('OSS_NOT_IMAGE', '不是图片', '图片数据不是合法的 base64。');
  }

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch (e) {
    throw ossError('OSS_NOT_IMAGE', '不是图片', '图片数据无法解码。');
  }
  if (!buffer.length) throw ossError('OSS_NOT_IMAGE', '不是图片', '图片内容为空。');
  if (buffer.length > MAX_BYTES) {
    throw ossError('OSS_FILE_TOO_LARGE', '文件过大',
      '单张图片不能超过 ' + (MAX_BYTES / 1024 / 1024) + ' MB，当前 ' +
      (buffer.length / 1024 / 1024).toFixed(1) + ' MB。');
  }

  const sniffed = sniffImage(buffer);
  if (!sniffed) {
    throw ossError('OSS_NOT_IMAGE', '不是图片', '文件内容不是可识别的图片（MIME 与实际内容不一致）。');
  }
  if (sniffed !== declared) {
    throw ossError('OSS_NOT_IMAGE', '不是图片',
      '声明的 MIME（' + declared + '）与实际图片内容（' + sniffed + '）不一致。');
  }

  return {
    buffer: buffer,
    mime: declared,
    ext: IMAGE_TYPES[declared].ext,
    name: name
  };
}

/* ---------------------------------------------------------------- 对象命名 */

function pad(n) { return String(n).padStart(2, '0'); }

function safeStem(name) {
  const base = String(name == null ? '' : name).replace(/\\/g, '/').split('/').pop()
    .replace(/\.[^.]*$/, '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 40);
  return base || 'image';
}

function buildKey(config, name, ext, now) {
  const date = now || new Date();
  const prefix = normalizePrefix(config.pathPrefix);
  const hash = crypto.randomBytes(4).toString('hex');
  const key = (prefix ? prefix + '/' : '') +
    date.getFullYear() + '/' + pad(date.getMonth() + 1) + '/' +
    hash + '-' + safeStem(name) + '.' + ext;
  return key;
}

function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

function defaultDomain(config) {
  return 'https://' + config.bucket + '.' + config.region + '.aliyuncs.com';
}

function defaultPublicUrl(config, key) {
  return defaultDomain(config) + '/' + encodeKey(key);
}

function cdnPublicUrl(config, key) {
  return config.customDomain ? normalizeDomain(config.customDomain) + '/' + encodeKey(key) : '';
}

function publicUrl(config, key) {
  return (config.customDomain ? normalizeDomain(config.customDomain) : defaultDomain(config)) +
    '/' + encodeKey(key);
}

/**
 * 判断自定义域名是否真的能打开对象。
 * - 没配自定义域名：视为可用，直接用默认域名。
 * - 配了：优先 HEAD 第一个对象；失败就标记不可用，调用方自动回退默认域名。
 */
function probeUrl(url, options) {
  const opts = options || {};
  if (opts.probeDomain) {
    return Promise.resolve(opts.probeDomain(url)).then(Boolean).catch(function () { return false; });
  }
  return new Promise(function (resolve) {
    let target;
    try { target = new URL(url); } catch (e) { return resolve(false); }
    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: 'HEAD',
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      timeout: DOMAIN_TIMEOUT
    }, function (res) {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('timeout', function () {
      req.destroy();
      resolve(false);
    });
    req.on('error', function () { resolve(false); });
    req.end();
  });
}

async function domainStatus(config, sampleKey, options) {
  const baseDomain = defaultDomain(config);
  if (!config.customDomain) {
    return {
      customDomain: '', ok: true, checked: false, defaultDomain: baseDomain,
      message: '未配置自定义域名，使用 OSS 默认域名。'
    };
  }
  const cdnBase = normalizeDomain(config.customDomain);
  const probe = cdnBase + '/' + encodeKey(sampleKey || '');
  const ok = await probeUrl(probe, options);
  return {
    customDomain: cdnBase,
    ok: ok,
    checked: true,
    defaultDomain: baseDomain,
    probe: probe,
    message: ok
      ? '自定义域名可访问。'
      : '自定义域名无法打开对象，已自动改用 OSS 默认域名；请检查 CNAME、证书，或清空自定义域名。'
  };
}

/* ------------------------------------------------------------------ 签名 */

/**
 * OSS V1 签名。返回 { stringToSign, signature, authorization }。
 * canonicalizedOSSHeaders 全部小写、按字典序、每行以 \n 结尾并拼在 Date 之后。
 */
function signV1(params) {
  const input = params || {};
  const method = String(input.method || 'GET').toUpperCase();
  const contentType = String(input.contentType || '');
  const date = String(input.date || new Date().toUTCString());
  const resource = String(input.resource || '');
  const secret = String(input.accessKeySecret || '');
  const accessKeyId = String(input.accessKeyId || '');

  const headers = input.ossHeaders || {};
  const canonicalHeaders = Object.keys(headers)
    .map(function (name) { return name.toLowerCase(); })
    .sort()
    .map(function (name) {
      const original = Object.keys(headers).filter(function (key) {
        return key.toLowerCase() === name;
      })[0];
      return name + ':' + String(headers[original]).trim() + '\n';
    })
    .join('');

  const stringToSign = method + '\n\n' + contentType + '\n' + date + '\n' +
    canonicalHeaders + resource;
  const signature = crypto.createHmac('sha1', secret).update(stringToSign, 'utf8').digest('base64');
  return {
    stringToSign: stringToSign,
    signature: signature,
    authorization: 'OSS ' + accessKeyId + ':' + signature
  };
}

/* -------------------------------------------------------------- 网络请求 */

function parseOssXml(text) {
  const value = String(text || '');
  const code = (/<Code>([^<]*)<\/Code>/.exec(value) || [])[1] || '';
  const message = (/<Message>([^<]*)<\/Message>/.exec(value) || [])[1] || '';
  return { code: code, message: message };
}

/** 把 OSS 返回码 / 网络错误翻译成人话。 */
function classifyFailure(status, text, transportCode) {
  const parsed = parseOssXml(text);
  const code = parsed.code;
  const message = parsed.message || String(text || '').slice(0, 200);

  if (code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch' ||
      code === 'InvalidAccessKeyId.NotFound') {
    return ossError('OSS_AK_INVALID', 'AK 无效',
      'AccessKeyId 或 AccessKeySecret 不正确，或 RAM 子账号没有该 Bucket 的权限。',
      '请到阿里云 RAM 控制台确认 AK 与授权策略。');
  }
  if (code === 'NoSuchBucket' || code === 'InvalidBucketName') {
    return ossError('OSS_BUCKET_MISSING', 'Bucket 不存在',
      '找不到 Bucket：' + message,
      '检查 Bucket 名称与地域是否一致。');
  }
  if (code === 'AccessDenied' || code === 'Forbidden' || code === 'UserDisable' ||
      (status === 403 && !code)) {
    return ossError('OSS_FORBIDDEN', '权限不足',
      '当前 AccessKey 没有写入该 Bucket 的权限。',
      '给 RAM 子账号授权 oss:PutObject（上传）与 oss:DeleteObject（连通性测试）。');
  }
  if (code === 'SecondLevelDomainForbidden' || code === 'InvalidDomainName') {
    return ossError('OSS_REGION_INVALID', '地域不对',
      'Endpoint 与 Bucket 所在地域不匹配：' + message,
      'Region 应形如 oss-cn-hangzhou，必须与 Bucket 实际地域一致。');
  }
  if (code === 'RequestTimeTooSkewed') {
    return ossError('OSS_NETWORK', '网络超时',
      '本机时间与 OSS 服务器偏差过大，请校准系统时间后重试。');
  }
  if (status === 404) {
    return ossError('OSS_BUCKET_MISSING', 'Bucket 不存在', '请求返回 404，检查 Bucket 与 Region。');
  }
  if (status === 401) {
    return ossError('OSS_AK_INVALID', 'AK 无效', '请求未通过认证，检查 AccessKey。');
  }

  if (transportCode === 'ENOTFOUND' || transportCode === 'EAI_AGAIN') {
    return ossError('OSS_REGION_INVALID', '地域不对',
      '无法解析 OSS 域名：Region 可能写错，或本机 DNS 不通。',
      'Region 应形如 oss-cn-hangzhou。');
  }
  if (transportCode === 'ETIMEDOUT' || transportCode === 'ESOCKETTIMEDOUT' ||
      transportCode === 'ECONNRESET' || transportCode === 'ECONNREFUSED') {
    return ossError('OSS_NETWORK', '网络超时', '连接 OSS 超时或中断，检查网络与代理。');
  }
  if (transportCode) {
    return ossError('OSS_NETWORK', '网络超时', '网络请求失败：' + transportCode);
  }

  return ossError('OSS_REMOTE_ERROR', 'OSS 返回错误',
    (code ? code + '：' : '') + message || ('HTTP ' + status));
}

/** 在分类结果上补回 OSS 原始错误码/消息，供批量删除逐条展示。 */
function remoteError(status, text, transportCode) {
  const err = classifyFailure(status, text, transportCode);
  const parsed = parseOssXml(text);
  err.ossCode = parsed.code || '';
  err.ossMessage = parsed.message || '';
  err.ossStatus = status || 0;
  return err;
}

function requestOss(config, method, key, body, contentType, options) {
  const opts = options || {};
  const date = new Date().toUTCString();
  const ossHeaders = method === 'PUT' ? { 'x-oss-object-acl': 'public-read' } : {};
  const resource = '/' + config.bucket + '/' + (key || '');
  const signed = signV1({
    method: method,
    contentType: contentType || '',
    date: date,
    resource: resource,
    ossHeaders: ossHeaders,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret
  });

  if (opts.request) {
    // 注入的请求器只用于测试：去掉 secret，避免它出现在任何调试输出里。
    const safeConfig = Object.assign({}, config);
    delete safeConfig.accessKeySecret;
    return Promise.resolve(opts.request({
      method: method,
      key: key,
      config: safeConfig,
      contentType: contentType || '',
      date: date,
      ossHeaders: ossHeaders,
      authorization: signed.authorization,
      stringToSign: signed.stringToSign,
      query: opts.query || '',
      body: body
    }));
  }

  return new Promise(function (resolve, reject) {
    const host = config.bucket + '.' + config.region + '.aliyuncs.com';
    const headers = Object.assign({}, ossHeaders, {
      'Host': host,
      'Date': date,
      'Authorization': signed.authorization
    });
    if (contentType) headers['Content-Type'] = contentType;
    if (body && body.length) headers['Content-Length'] = String(body.length);

    const req = https.request({
      method: method,
      hostname: host,
      port: 443,
      path: '/' + encodeKey(key) + (opts.query || ''),
      headers: headers,
      timeout: REQUEST_TIMEOUT
    }, function (res) {
      let text = '';
      res.on('data', function (chunk) { text += chunk; if (text.length > 800000) text = text.slice(-600000); });
      res.on('end', function () {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return resolve({ status: res.statusCode, text: text, headers: res.headers });
        }
        reject(remoteError(res.statusCode, text, ''));
      });
    });
    req.on('timeout', function () {
      req.destroy();
      reject(ossError('OSS_NETWORK', '网络超时', '连接 OSS 超过 ' + (REQUEST_TIMEOUT / 1000) + ' 秒。'));
    });
    req.on('error', function (err) {
      reject(remoteError(0, '', err && err.code));
    });
    if (body && body.length) req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ 对外 */

async function uploadImage(baseDir, payload, options) {
  const opts = options || {};
  const merged = effectiveConfig(baseDir, opts.env);
  const config = merged.config;
  if (!configured(config)) {
    throw ossError('OSS_NOT_CONFIGURED', '未配置 OSS',
      '请先在「图床」页填写 AccessKeyId、AccessKeySecret、Bucket 与 Region。',
      '也可以设置 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET 环境变量。');
  }

  const image = validateImage(payload);
  const key = buildKey(config, image.name, image.ext, opts.now);
  if (key.length > 1023) {
    throw ossError('OSS_NOT_IMAGE', '不是图片', '生成的对象名过长，请缩短文件名。');
  }

  try {
    await requestOss(config, 'PUT', key, image.buffer, image.mime, opts);
  } catch (err) {
    throw err && err.code ? err : classifyFailure(0, '', err && err.code);
  }

  const domain = await domainStatus(config, key, opts);
  const defaultUrl = defaultPublicUrl(config, key);
  const cdnUrl = cdnPublicUrl(config, key);
  const url = config.customDomain && domain.ok ? cdnUrl : defaultUrl;
  return {
    ok: true,
    url: url,
    defaultUrl: defaultUrl,
    cdnUrl: cdnUrl,
    domainOk: domain.ok,
    domain: domain,
    markdown: '![](' + url + ')',
    html: '<img src="' + url + '" alt="">',
    key: key,
    bytes: image.buffer.length,
    contentType: image.mime,
    name: image.name
  };
}

async function testConnection(baseDir, options) {
  const opts = options || {};
  const merged = effectiveConfig(baseDir, opts.env);
  const config = merged.config;
  if (!configured(config)) {
    throw ossError('OSS_NOT_CONFIGURED', '未配置 OSS',
      '请先填写 AccessKeyId、AccessKeySecret、Bucket 与 Region，再测试连通性。');
  }

  const prefix = normalizePrefix(config.pathPrefix);
  const key = (prefix ? prefix + '/' : '') + '_connectivity/' +
    crypto.randomBytes(4).toString('hex') + '-test.png';
  const url = publicUrl(config, key);

  try {
    await requestOss(config, 'PUT', key, TEST_PNG, 'image/png', opts);
  } catch (err) {
    throw err && err.code ? err : classifyFailure(0, '', err && err.code);
  }

  let deleted = false;
  let note = '';
  try {
    await requestOss(config, 'DELETE', key, null, '', opts);
    deleted = true;
  } catch (err) {
    note = '测试图已上传但删除失败，可手动删除：' + key;
  }

  return {
    ok: true,
    key: key,
    url: url,
    deleted: deleted,
    note: note,
    message: deleted
      ? '上传与删除均成功，配置可用。'
      : '上传成功；删除测试图失败，请到 OSS 控制台手动删除该对象。'
  };
}

/* ------------------------------------------------------------ 资源管理器 */

function parseListObjects(text) {
  const value = String(text || '');
  const items = [];
  const rawKeys = [];
  const contents = /<Contents>([\s\S]*?)<\/Contents>/gi;
  let match;
  while ((match = contents.exec(value))) {
    const block = match[1];
    const key = xmlUnescape((/<Key>([\s\S]*?)<\/Key>/.exec(block) || [])[1] || '').trim();
    if (!key) continue;
    rawKeys.push(key);
    const size = Number((/<Size>([\s\S]*?)<\/Size>/.exec(block) || [])[1] || 0);
    const etag = xmlUnescape((/<ETag>([\s\S]*?)<\/ETag>/.exec(block) || [])[1] || '')
      .replace(/^"|"$/g, '');
    const lastModified = xmlUnescape(
      (/<LastModified>([\s\S]*?)<\/LastModified>/.exec(block) || [])[1] || '');
    items.push({ key: key, size: isFinite(size) ? size : 0, lastModified: lastModified, etag: etag });
  }
  const totalRaw = (/<Total>([\s\S]*?)<\/Total>/i.exec(value) || [])[1];
  const total = totalRaw == null ? null : Number(totalRaw);
  return {
    items: items,
    rawKeys: rawKeys,
    isTruncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(value),
    nextMarker: xmlUnescape((/<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(value) || [])[1] || '').trim(),
    total: (total == null || !isFinite(total)) ? null : total
  };
}

/**
 * ListObjects（V1 签名）。只返回图片，分页靠 marker。
 * 单页内按 lastModified 倒序显示；下一页继续用 OSS 返回的 NextMarker。
 */
async function listObjects(baseDir, query, options) {
  const opts = options || {};
  const merged = effectiveConfig(baseDir, opts.env);
  const config = merged.config;
  if (!configured(config)) {
    throw ossError('OSS_NOT_CONFIGURED', '未配置 OSS',
      '请先在「图床」页填写 AccessKeyId、AccessKeySecret、Bucket 与 Region，再浏览资源。');
  }

  const input = query || {};
  const prefix = normalizeListPrefix(input.prefix);
  const marker = String(input.marker == null ? '' : input.marker).trim().slice(0, 1023);
  const search = String(input.search == null ? '' : input.search).trim().slice(0, 200).toLowerCase();
  let limit = Number(input.limit);
  if (!isFinite(limit) || limit <= 0) limit = LIST_DEFAULT;
  limit = Math.max(1, Math.min(LIST_MAX, Math.floor(limit)));

  const params = ['prefix=' + encodeURIComponent(prefix), 'max-keys=' + limit];
  if (marker) params.push('marker=' + encodeURIComponent(marker));
  const queryString = '?' + params.join('&');

  let response;
  try {
    response = await requestOss(config, 'GET', '', null, '', Object.assign({}, opts, { query: queryString }));
  } catch (err) {
    if (err && (err.code === 'OSS_FORBIDDEN' || err.ossCode === 'AccessDenied' || err.ossCode === 'Forbidden')) {
      throw ossError('OSS_LIST_FORBIDDEN', '无 ListObjects 权限',
        '当前 AccessKey 没有列出该 Bucket 的权限，无法浏览图床资源。',
        '给 RAM 子账号授予 oss:ListObjects（通常对应 ListBucket）权限。');
    }
    throw err && err.code ? err : classifyFailure(0, '', err && err.code);
  }

  const parsed = parseListObjects(response.text);
  const images = parsed.items.filter(function (item) {
    if (!isImageKey(item.key)) return false;
    return !search || item.key.toLowerCase().indexOf(search) >= 0;
  });

  images.sort(function (a, b) {
    const ta = Date.parse(a.lastModified) || 0;
    const tb = Date.parse(b.lastModified) || 0;
    if (tb !== ta) return tb - ta;
    return a.key < b.key ? 1 : (a.key > b.key ? -1 : 0);
  });

  const domain = await domainStatus(config, images.length ? images[0].key : '', opts);
  const items = images.map(function (item) {
    const defaultUrl = defaultPublicUrl(config, item.key);
    const cdnUrl = cdnPublicUrl(config, item.key);
    const url = config.customDomain && domain.ok ? cdnUrl : defaultUrl;
    return {
      key: item.key,
      size: item.size,
      lastModified: item.lastModified,
      etag: item.etag,
      url: url,
      defaultUrl: defaultUrl,
      cdnUrl: cdnUrl,
      markdown: '![](' + url + ')',
      html: '<img src="' + url + '" alt="">'
    };
  });

  return {
    ok: true,
    items: items,
    prefix: prefix,
    marker: marker,
    limit: limit,
    search: String(input.search == null ? '' : input.search).trim(),
    hasMore: parsed.isTruncated,
    nextMarker: parsed.isTruncated
      ? (parsed.nextMarker || parsed.rawKeys[parsed.rawKeys.length - 1] || '')
      : '',
    total: parsed.total,
    order: 'lastModified-desc',
    domain: domain
  };
}

/** 批量删除；逐个 DELETE，失败保留 OSS 原始错误码与消息。 */
async function deleteObjects(baseDir, payload, options) {
  const opts = options || {};
  const merged = effectiveConfig(baseDir, opts.env);
  const config = merged.config;
  if (!configured(config)) {
    throw ossError('OSS_NOT_CONFIGURED', '未配置 OSS',
      '请先填写 AccessKeyId、AccessKeySecret、Bucket 与 Region，再删除图片。');
  }

  const input = payload || {};
  const keys = Array.isArray(input.keys) ? input.keys : [];
  if (!keys.length) {
    throw ossError('OSS_DELETE_INVALID', '没有选择文件', '请至少选择一张要删除的图片。');
  }
  if (keys.length > DELETE_MAX) {
    throw ossError('OSS_DELETE_LIMIT', '一次删除太多',
      '单次最多删除 ' + DELETE_MAX + ' 个文件，请分批操作。');
  }

  const results = [];
  const seen = {};
  for (const raw of keys) {
    const key = normalizeObjectKey(raw);
    if (!key) {
      results.push({
        key: String(raw == null ? '' : raw), ok: false, code: 'OSS_BAD_KEY',
        label: '文件名无效', message: '对象名不合法，已跳过。', ossCode: '', remoteMessage: ''
      });
      continue;
    }
    if (seen[key]) continue;
    seen[key] = true;
    try {
      await requestOss(config, 'DELETE', key, null, '', opts);
      results.push({ key: key, ok: true });
    } catch (err) {
      results.push({
        key: key,
        ok: false,
        code: (err && err.code) || 'OSS_REMOTE_ERROR',
        label: (err && err.label) || 'OSS 返回错误',
        message: (err && err.message) || '删除失败。',
        ossCode: (err && err.ossCode) || '',
        remoteMessage: (err && err.ossMessage) || '',
        status: (err && err.ossStatus) || 0
      });
    }
  }

  const failed = results.filter(function (item) { return !item.ok; }).length;
  const deleted = results.length - failed;
  return {
    ok: failed === 0,
    partial: deleted > 0 && failed > 0,
    results: results,
    deleted: deleted,
    failed: failed,
    total: results.length
  };
}

module.exports = {
  CONFIG_FILE: CONFIG_FILE,
  MAX_BYTES: MAX_BYTES,
  IMAGE_TYPES: IMAGE_TYPES,
  describe: describe,
  saveConfig: saveConfig,
  uploadImage: uploadImage,
  testConnection: testConnection,
  signV1: signV1,
  buildKey: buildKey,
  publicUrl: publicUrl,
  encodeKey: encodeKey,
  classifyFailure: classifyFailure,
  validateImage: validateImage,
  sniffImage: sniffImage,
  effectiveConfig: effectiveConfig,
  listObjects: listObjects,
  deleteObjects: deleteObjects,
  isImageKey: isImageKey,
  parseListObjects: parseListObjects,
  domainStatus: domainStatus,
  defaultPublicUrl: defaultPublicUrl
};
