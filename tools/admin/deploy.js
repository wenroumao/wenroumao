'use strict';
/**
 * tools/admin/deploy.js —— 显式配置的 GitHub 推送
 * ---------------------------------------------------------------------------
 * 为什么不用 `hexo deploy`：_config.yml 里的 deploy 还是占位符 yourname.github.io，
 * 而本仓库的 origin / mirror 指向主题上游 fomalhaut1998/hexo-theme-fomalhaut。
 * 直接跑 deploy 只会推错地方。这里只认后台里填写的部署仓库 + 分支 + 开关，
 * 不读 _config.yml 的 deploy，也不回落到任何现有 remote。
 *
 * 推送方式：hexo generate 之后，把 public/ 同步到 .deploy_git/（已有 .gitignore），
 * 再执行 `git push <显式 URL> HEAD:refs/heads/<branch> --force`。
 * 强制推送是因为发布分支整棵目录都由 public/ 生成；只推到配置好的发布仓库。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const CONFIG_FILE = '.admin-deploy.json';
const DEFAULT_BRANCH = 'gh-pages';
const UPSTREAM_MARK = 'fomalhaut1998/hexo-theme-fomalhaut';

function truthy(value) {
  return value === true || value === '1' || value === 'true' || value === 'yes';
}

/** 地址决定认证方式：https 走 Token，git@ / ssh:// 走 SSH Key。 */
function repoMode(repo) {
  const s = String(repo || '').trim();
  if (/^https?:\/\//i.test(s)) return 'https';
  if (/^(git@|ssh:\/\/)/i.test(s)) return 'ssh';
  return '';
}

const GIT_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/**
 * git 在 core.quotePath=true（默认）时会把非 ASCII 路径输出成 "\345\274\200..."，
 * 这里统一还原成真实路径，避免中文文件名被误判成“远端多余文件”。
 * 注意：八进制转义是 UTF-8 的字节序列，必须按字节收集后再整体按 UTF-8 解码，
 * 逐个 String.fromCharCode 会得到 “å¼...” 这样的乱码。
 */
function decodeGitPath(name) {
  const raw = String(name == null ? '' : name).trim();
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const chars = Array.from(raw.slice(1, -1));
  const bytes = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\\' && i + 1 < chars.length) {
      const next = chars[i + 1];
      if (/[0-7]/.test(next) && /^[0-7]{3}$/.test(chars.slice(i + 1, i + 4).join(''))) {
        bytes.push(parseInt(chars.slice(i + 1, i + 4).join(''), 8));
        i += 3;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(GIT_ESCAPES, next)) {
        bytes.push(GIT_ESCAPES[next]);
        i += 1;
        continue;
      }
      bytes.push(Buffer.from(next, 'utf8')[0]);
      i += 1;
      continue;
    }
    const buf = Buffer.from(ch, 'utf8');
    for (let j = 0; j < buf.length; j++) bytes.push(buf[j]);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** 递归列出目录下的相对路径（用 / 分隔，便于和 git 的树对比）。 */
function walkFiles(root, prefix, out) {
  prefix = prefix || '';
  out = out || [];
  let names = [];
  try { names = fs.readdirSync(path.join(root, prefix)); } catch (e) { return out; }
  names.forEach(function (name) {
    const rel = prefix ? prefix + '/' + name : name;
    const full = path.join(root, rel);
    let stat;
    try { stat = fs.statSync(full); } catch (e) { return; }
    if (stat.isDirectory()) walkFiles(root, rel, out);
    else out.push(rel);
  });
  return out;
}

/** 本机 ~/.ssh 下是否存在可用的私钥（只看文件名，不读内容）。 */
function detectSshKey() {
  try {
    const dir = path.join(os.homedir(), '.ssh');
    return fs.readdirSync(dir).some(function (name) {
      if (name === 'known_hosts' || name === 'known_hosts.old' || name === 'config') return false;
      if (/\.pub$/i.test(name)) return false;
      return /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name) || /\.(pem|key)$/i.test(name);
    });
  } catch (e) {
    return false;
  }
}


function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (e) { return {}; }
}

/** 把 https / ssh 两种写法尽量归一，用于判断“是不是同一个仓库”。 */
function normalizeRepo(repo) {
  let s = String(repo || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/\.git$/i, '');
  const ssh = s.match(/^git@([^:]+):(.+)$/);
  if (ssh) return ssh[1] + '/' + ssh[2].replace(/^\/+/, '');
  s = s.replace(/^(https?|ssh):\/\//, '');
  s = s.replace(/^[^@/]+@/, '');
  return s.replace(/\/+$/, '');
}

const remoteCache = new Map();

function sourceRemotes(baseDir) {
  if (remoteCache.has(baseDir)) return remoteCache.get(baseDir);
  let remotes = [];
  try {
    const out = execFileSync('git', ['-C', baseDir, 'remote', '-v'], { encoding: 'utf8', timeout: 5000 });
    const seen = new Set();
    out.split(/\r?\n/).forEach(function (line) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) seen.add(normalizeRepo(parts[1]));
    });
    remotes = Array.from(seen);
  } catch (e) { remotes = []; }
  // 后台状态轮询会频繁读配置，缓存一下避免每次都 spawn git。
  if (remoteCache.size > 20) remoteCache.clear();
  remoteCache.set(baseDir, remotes);
  return remotes;
}

function repoConflict(baseDir, repo) {
  const normalized = normalizeRepo(repo);
  if (!normalized) return '';
  if (normalized.indexOf(UPSTREAM_MARK) >= 0) {
    return '这个地址是主题上游仓库，绝不能推送。请填你自己的博客发布仓库。';
  }
  const remotes = sourceRemotes(baseDir);
  if (remotes.indexOf(normalized) >= 0) {
    return '这个地址与当前源码仓库的 remote 相同，绝不能推送。请填自己的博客发布仓库。';
  }
  return '';
}

function maskRepo(repo) {
  return String(repo || '').replace(/(https?:\/\/)([^/@]+)@/i, '$1***@');
}

/**
 * @returns {{repo:string,branch:string,enabled:boolean,ready:boolean,reason:string,
 *            locked:{repo:boolean,branch:boolean,enabled:boolean},conflict:string,
 *            sources:{repo:string,branch:string,enabled:string}}}
 */
function loadDeployConfig(baseDir, env) {
  env = env || process.env;
  const file = readJson(path.join(baseDir, CONFIG_FILE));
  const envRepo = String(env.ADMIN_DEPLOY_REPO || '').trim();
  const envBranch = String(env.ADMIN_DEPLOY_BRANCH || '').trim();
  const envEnabled = env.ADMIN_DEPLOY_ENABLED;
  const envToken = String(env.ADMIN_DEPLOY_TOKEN || '').trim();

  const repo = envRepo || String(file.repo || '').trim();
  const branch = envBranch || String(file.branch || '').trim() || DEFAULT_BRANCH;
  const enabled = envEnabled !== undefined && envEnabled !== ''
    ? truthy(envEnabled)
    : file.enabled === true;
  const token = envToken || String(file.token || '').trim();
  const mode = repoMode(repo);
  const conflict = repoConflict(baseDir, repo);
  const sshKeyFound = mode === 'ssh' ? detectSshKey() : null;

  let invalid = '';
  if (repo) {
    try { validateRepo(repo); } catch (e) { invalid = e.message; }
  }

  let reason = '';
  if (!repo) {
    reason = '还没有填写部署仓库地址。请到「发布设置」填写你自己的博客仓库。';
  } else if (invalid) {
    reason = '部署仓库地址不合法：' + invalid;
  } else if (conflict) {
    reason = conflict;
  } else if (!enabled) {
    reason = '推送未启用。请到「发布设置」勾选“允许推送”。';
  } else if (mode === 'https' && !token) {
    reason = '推送地址是 HTTPS，但还没有填写 Personal Access Token。请到「发布设置」填写 Token，或改用 SSH 地址。';
  }

  // 不阻塞推送，但必须提前说清楚，避免点了按钮才在日志里看到失败。
  let warn = '';
  if (!reason && mode === 'ssh' && !sshKeyFound) {
    warn = '本机 ' + path.join(os.homedir(), '.ssh') + ' 下没有找到私钥，SSH 推送很可能被 GitHub 拒绝。建议改用 HTTPS + Personal Access Token。';
  }

  return {
    repo: repo,
    branch: branch,
    enabled: enabled,
    token: token,
    hasToken: !!token,
    mode: mode,
    sshKeyFound: sshKeyFound,
    ready: !!repo && !invalid && enabled && !conflict && !(mode === 'https' && !token),
    reason: reason,
    warn: warn,
    conflict: conflict,
    invalid: invalid,
    locked: {
      repo: !!envRepo,
      branch: !!envBranch,
      enabled: envEnabled !== undefined && envEnabled !== '',
      token: !!envToken
    },
    sources: {
      repo: envRepo ? 'env' : (file.repo ? 'file' : ''),
      branch: envBranch ? 'env' : (file.branch ? 'file' : ''),
      enabled: envEnabled !== undefined && envEnabled !== '' ? 'env' : (file.enabled !== undefined ? 'file' : ''),
      token: envToken ? 'env' : (file.token ? 'file' : '')
    }
  };
}

function validateBranch(branch) {
  const value = String(branch || '').trim();
  if (!value) throw new Error('分支不能为空。');
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(value) || value.startsWith('-') || value.startsWith('/') ||
    value.endsWith('/') || value.indexOf('..') >= 0 || value.indexOf('//') >= 0) {
    throw new Error('分支名不合法。');
  }
  return value;
}

function validateRepo(repo) {
  const value = String(repo || '').trim();
  if (!value) throw new Error('仓库地址不能为空。');
  if (value.length > 600 || /[\r\n\t]/.test(value) || /\s/.test(value)) throw new Error('仓库地址里有空白字符。');
  if (!/^(https?:\/\/|ssh:\/\/|git@|file:\/\/)/i.test(value) && !path.isAbsolute(value)) {
    throw new Error('仓库地址需要是 https://、git@、ssh:// 或本地绝对路径。');
  }
  return value;
}

function validateToken(token) {
  const value = String(token == null ? '' : token).trim();
  if (!value) return '';
  if (value.length > 400) throw new Error('Token 长度异常。');
  if (/[\r\n\t\s]/.test(value)) throw new Error('Token 里不能有空格或换行。');
  return value;
}

function saveDeployConfig(baseDir, input, env) {
  const current = loadDeployConfig(baseDir, env);
  input = input || {};
  ['repo', 'branch', 'enabled', 'token'].forEach(function (key) {
    if (current.locked[key] && key in input) {
      throw new Error(key + ' 由环境变量控制，不能在页面里改。');
    }
  });
  const repo = validateRepo(input.repo === undefined ? current.repo : input.repo);
  const branch = validateBranch(input.branch === undefined ? current.branch : input.branch);
  const conflict = repoConflict(baseDir, repo);
  if (conflict) throw new Error(conflict);
  const enabled = input.enabled === undefined ? current.enabled : !!input.enabled;
  const token = 'token' in input ? validateToken(input.token) : current.token;
  if (repoMode(repo) === 'https' && !token) {
    throw new Error('HTTPS 地址需要同时填写 Personal Access Token，否则推送一定会失败。');
  }
  if (repoMode(repo) === '' && !path.isAbsolute(repo) && !/^file:\/\//i.test(repo)) {
    throw new Error('仓库地址只支持 https://、git@、ssh://、file:// 或本地绝对路径。');
  }

  const file = path.join(baseDir, CONFIG_FILE);
  const payload = { repo: repo, branch: branch, enabled: enabled };
  if (token) payload.token = token;
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
  return loadDeployConfig(baseDir, env);
}

/** HTTPS 认证：用 http.extraHeader 传 Token，避免把 Token 写进命令行或 URL。 */
function authConfig(repo, token) {
  if (repoMode(repo) !== 'https' || !token) return [];
  const basic = Buffer.from('x-access-token:' + token, 'utf8').toString('base64');
  return [
    ['http.extraHeader', 'Authorization: Basic ' + basic],
    ['credential.helper', '']
  ];
}

/** 把 git 的 stderr 归类成用户能直接照做的中文提示。 */
function classifyGitFailure(raw, repo) {
  const text = String(raw || '');
  const https = repoMode(repo) === 'https';

  if (/Permission denied \(publickey\)|no supported authentication methods available/i.test(text)) {
    return detectSshKey()
      ? 'SSH 认证失败：GitHub 不接受本机密钥。请确认公钥已加到 GitHub 账号，并用 ssh -T git@github.com 测试。'
      : '本机没有可用的 SSH 私钥（' + path.join(os.homedir(), '.ssh') + ' 下只有 known_hosts 或为空）。请改用 HTTPS + Personal Access Token，或先生成密钥并添加到 GitHub。';
  }
  if (/Host key verification failed/i.test(text)) {
    return 'SSH 主机指纹校验失败。请先在终端执行一次 ssh -T git@github.com，确认 github.com 的指纹。';
  }
  if (/Could not resolve host|Name or service not known|Temporary failure in name resolution/i.test(text)) {
    return '域名解析失败，请检查网络或代理设置。';
  }
  if (/Connection timed out|Operation timed out|Connection refused|Network is unreachable/i.test(text)) {
    return '连接超时或被拒绝，请检查网络、代理或防火墙。';
  }
  if (/Repository not found|does not appear to be a git repository|remote: Not Found/i.test(text)) {
    return '仓库不存在，或当前凭据没有访问权限。请确认仓库地址与账号权限。';
  }
  if (/Authentication failed|Invalid username or password|Bad credentials|401 Unauthorized/i.test(text)) {
    return 'HTTPS 认证失败：Personal Access Token 无效、已过期，或没有 repo 权限。';
  }
  if (/could not read Username|terminal prompts disabled|could not read Password/i.test(text)) {
    return https ? 'HTTPS 需要认证，但没有可用的 Token。' : '远端需要认证，但当前没有可用凭据。';
  }
  if (/Could not read from remote repository/i.test(text)) {
    return '没有访问权限，请确认仓库地址、账号权限，或改用 HTTPS + Token。';
  }
  return '连接失败（未识别的错误，详见上方 git 输出）。';
}

function runGit(args, options, log) {
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }, options.env || {});
    // 用 GIT_CONFIG_* 传递认证头，Token 不进 argv，也不会出现在进程列表里。
    (options.gitConfig || []).forEach(function (pair, index) {
      env['GIT_CONFIG_KEY_' + index] = pair[0];
      env['GIT_CONFIG_VALUE_' + index] = pair[1];
      env['GIT_CONFIG_COUNT'] = String(index + 1);
    });
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: env,
      windowsHide: true
    });
    let output = '';
    let stdout = '';
    let timedOut = false;
    // 按流分别用 StringDecoder 解码，避免一个 UTF-8 汉字恰好跨 chunk 时被截成乱码
    // （ls-tree 输出的中文目录名一旦乱码，就会被误判成“远端多余文件”）。
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const timer = setTimeout(function () {
      timedOut = true;
      try { child.kill(); } catch (e) { /* 忽略 */ }
    }, options.timeoutMs || 120000);

    function onData(text, stream) {
      if (!text) return;
      output += text;
      if (stream === 'out') stdout += text;
      if (output.length > 60000) output = output.slice(-50000);
      if (stdout.length > 600000) stdout = stdout.slice(-500000);
      log(text.replace(/(https?:\/\/)([^/@\s]+)@/gi, '$1***@'));
    }
    child.stdout.on('data', function (chunk) { onData(outDecoder.write(chunk), 'out'); });
    child.stderr.on('data', function (chunk) { onData(errDecoder.write(chunk), 'err'); });
    child.on('error', function (err) {
      clearTimeout(timer);
      reject(new Error('执行 git 失败：' + err.message));
    });
    child.on('close', function (code) {
      clearTimeout(timer);
      // 把解码器里残留的半个字符冲出来
      onData(outDecoder.end(), 'out');
      onData(errDecoder.end(), 'err');
      if (timedOut) {
        const err = new Error('git ' + args[0] + ' 超时（' + Math.round((options.timeoutMs || 120000) / 1000) + ' 秒）');
        err.output = output;
        return reject(err);
      }
      if (code === 0) return resolve(stdout);
      const err = new Error('git ' + args[0] + ' 退出码 ' + code);
      err.output = output;
      reject(err);
    });
  });
}

async function deployWithGit(baseDir, options, log) {
  options = options || {};
  // 始终以磁盘/环境变量里的配置为准，调用方传进来的只是“再确认一次”。
  // 以前这里看到 options.repo 就把它当成完整配置，导致 ready 恒为 undefined，
  // 从而永远报「推送未配置」——这是误报的根因。
  const stored = loadDeployConfig(baseDir);
  const targetRepo = options.repo || stored.repo || '';
  if (!String(targetRepo).trim()) {
    throw new Error('还没有填写部署仓库地址。请到「发布设置」填写你自己的博客仓库。');
  }
  const repo = validateRepo(targetRepo);
  const branch = validateBranch(options.branch || stored.branch || '');
  const token = String(options.token || stored.token || '').trim();
  const enabled = options.enabled === undefined ? stored.enabled : !!options.enabled;

  const conflict = repoConflict(baseDir, repo);
  if (conflict) throw new Error(conflict);
  if (!enabled) throw new Error('推送未启用。请到「发布设置」勾选“允许推送”。');
  const mode = repoMode(repo);
  if (mode === 'https' && !token) {
    throw new Error('推送地址是 HTTPS，但没有可用的 Personal Access Token。请到「发布设置」填写 Token，或改用 SSH 地址。');
  }

  const publicDir = path.join(baseDir, 'public');
  if (!fs.existsSync(publicDir)) throw new Error('public/ 不存在，先执行一次 hexo generate。');
  const safeRepo = maskRepo(repo);
  const work = path.join(baseDir, '.deploy_git');
  const gitConfig = authConfig(repo, token);

  log('→ 推送方式：' + (mode === 'https' ? 'HTTPS + Personal Access Token' : mode === 'ssh' ? 'SSH 密钥' : '本地路径'));
  log('→ 检查部署仓库连通性：' + safeRepo);
  log(' · 目标分支：' + branch + '\n');

  let remoteHeads = '';
  try {
    remoteHeads = await runGit(['ls-remote', '--heads', repo], {
      cwd: baseDir, timeoutMs: 30000, gitConfig: gitConfig
    }, log);
  } catch (e) {
    const detail = classifyGitFailure(String(e.output || '') + '\n' + String(e.message || ''), repo);
    throw new Error('无法连接部署仓库 ' + safeRepo + '：' + detail);
  }
  const headMap = {};
  remoteHeads.split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^([0-9a-f]+)\trefs\/heads\/(.+)$/);
    if (m) headMap[m[2]] = m[1];
  });
  const heads = Object.keys(headMap);
  if (heads.indexOf(branch) >= 0) {
    log('→ 远端已有分支 ' + branch + '@' + headMap[branch].slice(0, 7) + '，本次会覆盖它（仅包含 public/ 产物）。\n');
  } else {
    log('→ 远端还没有分支 ' + branch + '，本次推送会新建它。现有分支：' + (heads.length ? heads.join('、') : '（空仓库）') + '\n');
  }

  fs.mkdirSync(work, { recursive: true });
  log('→ 同步 public/ 到 .deploy_git/（' + safeRepo + ' · ' + branch + '）\n');

  if (!fs.existsSync(path.join(work, '.git'))) {
    await runGit(['init', '-q'], { cwd: work }, log);
  }

  // 覆盖前先看远端到底有什么：如果存在不属于本次产物的文件，停下来交给用户决定。
  // 只有显式允许（options.allowDelete 或 ADMIN_DEPLOY_ALLOW_DELETE=1）时才继续并删除。
  const allowDelete = options.allowDelete === true || truthy(process.env.ADMIN_DEPLOY_ALLOW_DELETE);
  const remoteSha = headMap[branch] || '';
  if (remoteSha) {
    try {
      await runGit(['fetch', '--no-tags', '--depth=1', repo,
        'refs/heads/' + branch], { cwd: work, timeoutMs: 60000, gitConfig: gitConfig }, log);
      // core.quotePath=false 让中文路径按 UTF-8 原样输出，
      // 否则 git 会输出 "\345\274\200..." 这种八进制转义，拿去和本地文件名比对必然对不上。
      const tree = await runGit(['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'FETCH_HEAD'], { cwd: work }, log);
      const remoteFiles = tree.split(/\r?\n/).filter(Boolean).map(decodeGitPath);
      const localSet = new Set(walkFiles(publicDir).map(decodeGitPath));
      const extra = remoteFiles.filter(function (name) { return !localSet.has(name); });
      if (extra.length && !allowDelete) {
        const blocked = new Error('远端 ' + branch + ' 分支里有 ' + extra.length + ' 个文件不属于当前 public/ 产物，已停止推送以免误删。');
        blocked.code = 'DEPLOY_EXTRA_FILES';
        blocked.files = extra;
        throw blocked;
      }
      if (extra.length) {
        log('→ 已确认允许覆盖：远端将删除 ' + extra.length + ' 个非产物文件：' + extra.slice(0, 8).join('、') + (extra.length > 8 ? ' 等' : '') + '\n');
      } else {
        log('→ 远端内容与产物一致（共 ' + remoteFiles.length + ' 个文件），可以安全覆盖。\n');
      }
    } catch (e) {
      if (e && e.code === 'DEPLOY_EXTRA_FILES') throw e;
      // 拉取远端内容失败不阻塞推送，但要说清楚
      log('（提示：读取远端文件清单失败，跳过覆盖前检查：' + e.message + '）\n');
    }
  }

  // 清空上一次的产物，只保留 .git
  fs.readdirSync(work).forEach(function (name) {
    if (name === '.git') return;
    fs.rmSync(path.join(work, name), { recursive: true, force: true });
  });
  fs.cpSync(publicDir, work, { recursive: true });

  await runGit(['add', '-A'], { cwd: work }, log);
  try {
    await runGit([
      '-c', 'user.name=wenroumao Admin',
      '-c', 'user.email=admin@local',
      'commit', '-m', 'deploy: ' + new Date().toISOString()
    ], { cwd: work }, log);
  } catch (e) {
    if (!/nothing to commit|nothing added to commit|no changes added/i.test(String(e.output || ''))) throw e;
    log('（内容没有变化，跳过 commit）\n');
  }

  const pushArgs = ['push', repo, 'HEAD:refs/heads/' + branch];
  if (remoteSha) {
    // 只覆盖“我们刚才看到的那一个远端提交”，期间若有人更新过远端，推送会被拒绝。
    pushArgs.push('--force-with-lease=refs/heads/' + branch + ':' + remoteSha);
  }
  try {
    await runGit(pushArgs, {
      cwd: work, timeoutMs: 180000, gitConfig: gitConfig
    }, log);
  } catch (e) {
    const detail = classifyGitFailure(String(e.output || '') + '\n' + String(e.message || ''), repo);
    if (/stale info|rejected/i.test(String(e.output || ''))) {
      throw new Error('推送被拒绝：远端 ' + branch + ' 在检查之后被更新过（--force-with-lease 保护）。请刷新后重试。');
    }
    throw new Error('推送失败：' + detail);
  }
  log('\n✓ 已推送到 ' + safeRepo + ' 的 ' + branch + ' 分支\n');
}

module.exports = {
  CONFIG_FILE: CONFIG_FILE,
  DEFAULT_BRANCH: DEFAULT_BRANCH,
  UPSTREAM_MARK: UPSTREAM_MARK,
  loadDeployConfig: loadDeployConfig,
  saveDeployConfig: saveDeployConfig,
  deployWithGit: deployWithGit,
  normalizeRepo: normalizeRepo,
  repoConflict: repoConflict,
  maskRepo: maskRepo,
  walkFiles: walkFiles,
  decodeGitPath: decodeGitPath,
  validateRepo: validateRepo,
  validateBranch: validateBranch,
  validateToken: validateToken,
  repoMode: repoMode,
  detectSshKey: detectSshKey,
  classifyGitFailure: classifyGitFailure,
  authConfig: authConfig
};
