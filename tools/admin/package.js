'use strict';
/**
 * tools/admin/package.js —— 一键打包前端 + 后台源码
 * ---------------------------------------------------------------------------
 * 输出目录固定为仓库根下的 backup/package/（已在 .gitignore 里忽略）。
 *
 * 压缩实现（不引入第三方依赖）：
 *   1. 首选系统自带 `tar`（Windows 10/11 自带的 bsdtar）：
 *      spawn('tar', ['-a', '-c', '-f', out, '.']) —— -a 按 .zip 后缀自动选 zip 格式，
 *      进程参数用数组传递，路径含中文/空格也不需要 shell 拼串。
 *   2. 回退：Node 自带的 zlib 写一个最小 zip（UTF-8 文件名标记），保证没有 tar 的机器也能打包。
 *   3. 回退只发生在 tar 不存在或非零退出时；tar 失败留下的半截文件会先删除。
 *
 * 隐私边界：只复制 baseDir 内的文件，并且显式排除凭据、备份、依赖、产物、
 * 以及用户主目录下的 ~/.ssh（即使 HOME 被误设成项目内部也不会带出去）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { spawn } = require('child_process');

const OUTPUT_DIR = 'backup/package';
const LAST_FILE = '.last.json';

const MODES = [
  {
    id: 'full',
    label: '完整',
    description: '含 .git 提交历史与 public/ 产物，换电脑后可继续 commit / push。',
    includesGit: true
  },
  {
    id: 'light',
    label: '轻量',
    description: '不含 .git、node_modules、public，解压后 npm install 即可运行。',
    includesGit: false
  }
];

/** 顶层目录：两种模式都排除。 */
const EXCLUDED_TOP = ['bak', 'backup', 'node_modules', '.deploy_git', '.ssh'];
const EXCLUDED_EXACT = ['.admin-auth', '.admin-deploy.json', '.admin-oss.json'];
const ADMIN_DEPLOY_TMP = /^\.admin-deploy\.json\.tmp-/;
const ADMIN_OSS_TMP = /^\.admin-oss\.json\.tmp-/;

function packageError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeRel(relPath) {
  return String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '');
}

function isInside(root, target) {
  const base = path.resolve(root);
  const abs = path.resolve(target);
  return abs === base || abs.indexOf(base + path.sep) === 0;
}

/**
 * 判断仓库内相对路径是否排除。mode 为 full / light。
 * 只按仓库根判断顶层目录，避免误伤 source/bak 这类同名子目录。
 */
function isExcluded(relPath, mode) {
  const rel = normalizeRel(relPath);
  if (!rel) return true;
  if (EXCLUDED_EXACT.indexOf(rel) >= 0) return true;
  if (ADMIN_DEPLOY_TMP.test(rel)) return true;
  if (ADMIN_OSS_TMP.test(rel)) return true;
  if (rel === '.git/index.lock') return true;

  const parts = rel.split('/');
  const top = parts[0];
  if (EXCLUDED_TOP.indexOf(top) >= 0) return true;
  if (/^\.deploy_git(\.|$)/.test(top)) return true;

  if (mode === 'light') {
    if (top === '.git' || top === 'public') return true;
  }
  return false;
}

/** 收集需要打包的文件清单（只收普通文件，符号链接一律跳过，避免越界）。 */
function collectFiles(baseDir, mode, homeSsh) {
  const files = [];
  const skipped = [];
  const stack = [''];

  while (stack.length) {
    const relDir = stack.pop();
    const absDir = relDir ? path.join(baseDir, relDir) : baseDir;
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      skipped.push((relDir || '.') + '（无法读取）');
      continue;
    }
    entries.forEach(function (entry) {
      const rel = relDir ? relDir + '/' + entry.name : entry.name;
      const abs = path.join(absDir, entry.name);
      if (isExcluded(rel, mode)) {
        skipped.push(rel + (entry.isDirectory() ? '/' : ''));
        return;
      }
      if (!isInside(baseDir, abs)) {
        skipped.push(rel);
        return;
      }
      if (homeSsh && isInside(homeSsh, abs)) {
        skipped.push(rel);
        return;
      }
      if (entry.isSymbolicLink()) {
        skipped.push(rel + '（符号链接，跳过）');
        return;
      }
      if (entry.isDirectory()) {
        stack.push(rel);
        return;
      }
      if (entry.isFile()) files.push(rel);
    });
  }

  files.sort();
  return { files: files, skipped: skipped };
}

function stamp(date) {
  const d = date || new Date();
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
}

function uniqueName(dir, base) {
  let name = base + '.zip';
  let index = 2;
  while (fs.existsSync(path.join(dir, name))) {
    name = base + '-' + index + '.zip';
    index += 1;
  }
  return name;
}

/* --------------------------------------------------------------- 说明文件 */

function migrateMarkdown(mode, generatedAt) {
  const lines = [
    '# 温柔猫博客 —— 迁移与部署说明',
    '',
    '本包由后台「一键打包」生成于 ' + generatedAt + '，模式：' + (mode === 'full' ? '完整' : '轻量') + '。',
    '',
    '## 包里有什么',
    '',
    '- 前端：Hexo 站点（_config.yml、_config.fomalhaut.yml、themes/、source/、scaffolds/、scripts/ 等）。',
    '- 后台：tools/admin/（独立入口 tools/admin/standalone.js，不依赖 hexo server）。',
    '- 图床图片存放在阿里云 OSS，不随源码打包；换机后继续用同一 Bucket 或重新配置 .admin-oss.json。',
    mode === 'full'
      ? '- .git：保留提交历史，换电脑后可以继续 commit / push。'
      : '- 不含 .git / node_modules / public：解压后先 npm install，再重新生成。',
    '',
    '## 换电脑后的步骤',
    '',
    '1. 安装 Node.js 18 或更高版本，然后在本目录打开终端执行：',
    '',
    '       npm install',
    '',
    '2. 配置管理员账号（二选一）：',
    '',
    '   - 双击 start-admin.cmd，按提示输入账号密码，会保存到 .admin-auth；',
    '   - 或手动新建 .admin-auth，写两行：ADMIN_USER=... 与 ADMIN_PASSWORD=...。',
    '',
    '   变量名可参考同目录的 .env.example（里面只有变量名，没有真实值）。',
    '',
    '3. 准备 GitHub SSH 密钥：',
    '',
    '       ssh-keygen -t ed25519 -C "your-email@example.com"',
    '',
    '   Windows 上公钥文件是 %USERPROFILE%\\.ssh\\id_ed25519.pub。复制它的全部内容，',
    '   打开 https://github.com/settings/keys → New SSH key → 粘贴并保存。',
    '',
    '   也可以在后台「SSH 密钥」页一键生成、复制公钥并测试连接；生成后私钥不会再回传页面。',
    '',
    '   测试：ssh -T git@github.com（看到 successfully authenticated 即成功；GitHub 此时退出码是 1，属正常）。',
    '',
    '4. 启动后台：',
    '',
    '       start-admin.cmd',
    '',
    '   浏览器打开 http://127.0.0.1:4000/admin/ 。站点预览另开 start-blog.cmd。',
    '',
    '5. 改推送目标：',
    '',
    '   - 源码：后台「源码」页提交并推送到 source 分支（仓库地址在 tools/admin/source.js 的 DEFAULT_REPO）；',
    '   - 产物：后台「生成与推送」页填写你自己的仓库地址与 main 分支，保存后点「生成并推送」。',
    '',
    '   如果换成了自己的 GitHub 仓库，记得两处都改，否则会推回原作者的仓库。',
    '',
    '6. 生成并推送：',
    '',
    '   后台「生成与推送」→「生成并推送」；也可以在终端执行 npm run build。',
    '',
    '## 部署到 Vercel',
    '',
    '- 仓库根目录如有 vercel.json，直接在 Vercel 里 New Project → Import Git Repository → 选择你的仓库。',
    '- 构建命令与输出目录以 vercel.json 为准；之后每次推送到 main，Vercel 会自动重新部署。',
    '',
    '## 安全提醒',
    '',
    '- 包里不含 .admin-auth、.admin-deploy.json、.admin-oss.json、bak/、backup/、node_modules/、~/.ssh。',
    '- 请勿把真实密码、Token 或私钥写进仓库或 MIGRATE.md。',
    '- 轻量包解压后第一次生成前，public/ 目录可能不存在，这是正常的。',
    ''
  ];
  return lines.join('\n');
}

function envExample() {
  return [
    '# 变量名示例：值留空，请按需填写；不要把真实密钥提交到仓库。',
    '# 也可以把这些写进 .admin-auth（ADMIN_USER / ADMIN_PASSWORD）。',
    '',
    'ADMIN_USER=',
    'ADMIN_PASSWORD=',
    '# 可选：HTTPS 推送使用的 GitHub Personal Access Token',
    'ADMIN_DEPLOY_TOKEN=',
    '# 可选：独立后台的监听端口 / 地址',
    'ADMIN_PORT=',
    'ADMIN_HOST=',
    '# 可选：图床（阿里云 OSS）环境变量覆盖；不填则读取本机 .admin-oss.json',
    'OSS_ACCESS_KEY_ID=',
    'OSS_ACCESS_KEY_SECRET=',
    'OSS_BUCKET=',
    'OSS_REGION=',
    'OSS_CUSTOM_DOMAIN=',
    'OSS_PATH_PREFIX=',
    ''
  ].join('\n');
}

/* ------------------------------------------------------------- zip 回退实现 */

const CRC_TABLE = (function () {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/** 最小 zip 写入器：deflate + UTF-8 文件名（通用标志位 0x0800）。 */
function writeZip(stagingDir, outFile, files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach(function (rel) {
    const abs = path.join(stagingDir, rel);
    const stat = fs.statSync(abs);
    const data = fs.readFileSync(abs);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const when = dosDateTime(stat.mtime);
    const name = Buffer.from(normalizeRel(rel), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(when.time, 10);
    local.writeUInt16LE(when.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(when.time, 12);
    central.writeUInt16LE(when.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  });

  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(outFile, Buffer.concat(localParts.concat([centralBuffer, end])));
}

/** 读取 zip 中央目录里的文件名，供测试与结果抽样展示（不依赖 unzip）。 */
function listEntries(zipFile) {
  const buffer = fs.readFileSync(zipFile);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 65535; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw packageError('PACKAGE_UNREADABLE', '生成的 zip 缺少中央目录。');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    names.push(normalizeRel(name));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/* --------------------------------------------------------------- 压缩执行 */

function compressWithTar(stagingDir, outFile) {
  return new Promise(function (resolve, reject) {
    const child = spawn('tar', ['-a', '-c', '-f', outFile, '.'], {
      cwd: stagingDir,
      windowsHide: true
    });
    let output = '';
    child.stdout.on('data', function (chunk) { output += chunk; });
    child.stderr.on('data', function (chunk) { output += chunk; });
    child.on('error', function (err) {
      reject(packageError('PACKAGE_TAR_MISSING', 'tar 不可用：' + err.message));
    });
    child.on('close', function (code) {
      if (code === 0) return resolve(output);
      reject(packageError('PACKAGE_TAR_FAILED', 'tar 退出码 ' + code + (output ? '：' + output.trim().slice(-300) : '')));
    });
  });
}

async function compress(stagingDir, outFile, files, compressor) {
  const choice = compressor || 'auto';
  if (choice !== 'node') {
    try {
      await compressWithTar(stagingDir, outFile);
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
        return { method: 'tar', fallback: false };
      }
      throw packageError('PACKAGE_TAR_FAILED', 'tar 没有生成有效文件。');
    } catch (err) {
      try { fs.rmSync(outFile, { force: true }); } catch (e) { /* 忽略 */ }
      if (choice === 'tar') throw err;
    }
  }
  writeZip(stagingDir, outFile, files);
  return { method: 'node', fallback: choice === 'auto' };
}

/* ------------------------------------------------------------------ 对外 */

function lastRecord(baseDir) {
  try {
    const raw = fs.readFileSync(path.join(baseDir, OUTPUT_DIR, LAST_FILE), 'utf8');
    const data = JSON.parse(raw);
    return data && data.name ? data : null;
  } catch (e) { return null; }
}

function describe(baseDir) {
  return {
    modes: MODES,
    output: OUTPUT_DIR + '/',
    last: lastRecord(baseDir)
  };
}

function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * 生成迁移包。
 * options: mode(full|light), compressor(auto|tar|node), home(用于定位 ~/.ssh), log(fn)
 */
async function createPackage(baseDir, options) {
  const opts = options || {};
  const mode = String(opts.mode || 'full');
  if (!MODES.some(function (item) { return item.id === mode; })) {
    throw packageError('PACKAGE_INVALID_MODE', '不支持的打包模式：' + mode + '（可选 full / light）。');
  }
  const root = path.resolve(baseDir);
  if (!fs.existsSync(root)) throw packageError('PACKAGE_NO_PROJECT', '项目目录不存在：' + root);

  const log = opts.log || function () {};
  const home = path.resolve(opts.home || os.homedir());
  const homeSsh = path.join(home, '.ssh');
  const outDir = path.join(root, 'backup', 'package');
  fs.mkdirSync(outDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const name = uniqueName(outDir, 'wenroumao-blog-' + stamp());
  const outFile = path.join(outDir, name);

  log('收集文件（模式：' + mode + '）…\n');
  const collected = collectFiles(root, mode, homeSsh);
  log('共 ' + collected.files.length + ' 个文件，已排除 ' + collected.skipped.length + ' 项。\n');

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wenroumao-pkg-'));
  let method = '';
  let fallback = false;
  const startedAt = Date.now();
  try {
    collected.files.forEach(function (rel) {
      const src = path.join(root, rel);
      const dst = path.join(stagingDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    });

    const extraFiles = ['MIGRATE.md', '.env.example'];
    extraFiles.forEach(function (rel) {
      const content = rel === 'MIGRATE.md' ? migrateMarkdown(mode, generatedAt) : envExample();
      fs.writeFileSync(path.join(stagingDir, rel), content, 'utf8');
    });
    const allFiles = collected.files.concat(extraFiles).sort();

    log('压缩到 ' + OUTPUT_DIR + '/' + name + ' …\n');
    const result = await compress(stagingDir, outFile, allFiles, opts.compressor);
    method = result.method;
    fallback = result.fallback;
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size <= 0) {
      throw packageError('PACKAGE_EMPTY', '压缩完成但没有生成有效文件。');
    }
  } catch (err) {
    try { fs.rmSync(outFile, { force: true }); } catch (e) { /* 忽略 */ }
    throw err.code ? err : packageError('PACKAGE_FAILED', '打包失败：' + err.message);
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }

  const size = fs.statSync(outFile).size;
  const record = {
    mode: mode,
    name: name,
    file: OUTPUT_DIR + '/' + name,
    size: size,
    sizeText: sizeText(size),
    method: method,
    createdAt: generatedAt,
    durationMs: Date.now() - startedAt,
    entries: collected.files.length + 2
  };
  try {
    fs.writeFileSync(path.join(outDir, LAST_FILE), JSON.stringify(record, null, 2) + '\n', 'utf8');
  } catch (e) { /* 记录失败不影响包本身 */ }

  log('✓ 打包完成：' + record.file + '（' + record.sizeText + '，' + method + '）\n');
  return Object.assign({ ok: true, absPath: outFile }, record, {
    fallback: fallback,
    skippedCount: collected.skipped.length
  });
}

module.exports = {
  OUTPUT_DIR: OUTPUT_DIR,
  MODES: MODES,
  isExcluded: isExcluded,
  describe: describe,
  createPackage: createPackage,
  listEntries: listEntries,
  lastRecord: lastRecord,
  migrateMarkdown: migrateMarkdown,
  envExample: envExample,
  stamp: stamp,
  sizeText: sizeText
};
