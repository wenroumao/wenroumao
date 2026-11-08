'use strict';
/**
 * tools/admin/source.js —— 把本地源码提交并推送到 source 分支
 * ---------------------------------------------------------------------------
 * 与 deploy.js 是两条互不干扰的链路：
 *   - deploy.js：hexo generate 之后把 public/ 推到发布分支（通常是 main）。
 *   - 本文件：把仓库里的源码改动提交、推送到同一仓库的 source 分支。
 *
 * 三条硬约束：
 *   1. 只提交源码：.admin-auth / .admin-deploy.json / bak/ / public/ 等
 *      在 .gitignore 里已有的条目，这里再显式过滤一遍，防止配置被改后误提交。
 *   2. 绝不 force：推送永远是普通 `git push <url> HEAD:refs/heads/<branch>`。
 *   3. 不用 shell：所有 git 参数都以数组传给 spawn，提交说明不会被解释成命令。
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const DEFAULT_REPO = 'git@github.com:wenroumao/wenroumao.git';
const DEFAULT_BRANCH = 'source';
const MAX_MESSAGE = 200;
const COMMIT_LIMIT = 10;

/** 兜底提交身份：本仓库没有配置 user.name / user.email，不指定会直接 commit 失败。 */
const COMMIT_NAME = 'wenroumao';
const COMMIT_EMAIL = 'admin@local';

/** 这些路径永远不进源码提交（与 .gitignore 一致，但代码里再挡一次）。 */
const EXCLUDED_EXACT = ['.admin-auth', '.admin-deploy.json', '.admin-oss.json'];
const EXCLUDED_PREFIX = ['bak/', 'public/', '.deploy_git/', '.deploy_git', 'node_modules/', '.git/', '.admin-oss.json.tmp-'];

function sourceError(code, message, raw) {
  const err = new Error(message);
  err.code = code;
  if (raw) err.raw = raw;
  return err;
}

/** 路径归一 + 排除判断；Windows 下 git 仍用 /，但反斜杠也一并归一。 */
function isExcluded(relPath) {
  const s = String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s) return true;
  if (EXCLUDED_EXACT.indexOf(s) >= 0) return true;
  if (/^\.admin-deploy\.json\.tmp-/.test(s)) return true;
  return EXCLUDED_PREFIX.some(function (prefix) {
    return s === prefix || s.indexOf(prefix) === 0;
  });
}

/** 同步执行 git，只用于读状态这类短命令。 */
function gitSync(baseDir, args) {
  return execFileSync('git', args, {
    cwd: baseDir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024
  });
}

/**
 * 异步执行 git，收集输出给前端日志。
 * GIT_TERMINAL_PROMPT=0 + BatchMode 保证不会卡在隐藏进程里等输入。
 */
function gitRun(baseDir, args, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ||
        'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new'
    }, options.env || {});
    const child = spawn('git', args, { cwd: baseDir, env: env, windowsHide: true });
    let output = '';
    const decoder = new StringDecoder('utf8');
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) { /* 忽略 */ }
      reject(sourceError('SOURCE_TIMEOUT', 'git 命令超时，已中断。', output));
    }, options.timeoutMs || 180000);

    function onData(chunk) {
      const text = decoder.write(chunk);
      if (!text) return;
      output += text;
      if (options.log) options.log(text);
      if (output.length > 200000) output = output.slice(-160000);
    }

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(sourceError('SOURCE_GIT_MISSING', '无法执行 git：' + err.message, output));
    });
    child.on('close', function (code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve(output);
      reject(sourceError('SOURCE_GIT_FAILED', 'git ' + args[0] + ' 退出码 ' + code, output));
    });
  });
}

/** 解析 `git status --porcelain=v1 -z`；重命名条目后紧跟一个原路径，忽略即可。 */
function parseStatus(output) {
  const parts = String(output || '').split('\0');
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i];
    if (!chunk) continue;
    const code = chunk.slice(0, 2);
    const filePath = chunk.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i += 1;
    rows.push({ path: filePath, code: code });
  }
  return rows;
}

/** 工作区状态 → 展示用 M/A/D。 */
function changeKind(code) {
  if (code === '??') return 'A';
  if (code.indexOf('D') >= 0) return 'D';
  if (code.indexOf('A') >= 0) return 'A';
  return 'M';
}

function listChanges(baseDir) {
  const out = gitSync(baseDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return parseStatus(out)
    .filter(function (row) { return !isExcluded(row.path); })
    .map(function (row) {
      const status = changeKind(row.code);
      return {
        path: row.path,
        status: status,
        label: status === 'A' ? '新增' : status === 'D' ? '删除' : '修改'
      };
    })
    .sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
}

/** 相对时间，服务端算好，避免前端各写一套。 */
function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return Math.floor(diff / minute) + ' 分钟前';
  if (diff < day) return Math.floor(diff / hour) + ' 小时前';
  if (diff < 30 * day) return Math.floor(diff / day) + ' 天前';
  if (diff < 365 * day) return Math.floor(diff / (30 * day)) + ' 个月前';
  return Math.floor(diff / (365 * day)) + ' 年前';
}

/**
 * 分页读取提交：offset 从 0 开始，多取一条用来判断还有没有更早的。
 * 空仓库（还没有任何提交）时 git log 报错，这里退化成空列表，不当异常。
 */
function listCommits(baseDir, limit, offset) {
  const count = Math.max(1, Math.min(COMMIT_LIMIT, Number(limit) || COMMIT_LIMIT));
  const skip = Math.max(0, Number(offset) || 0);
  let out = '';
  try {
    out = gitSync(baseDir, ['log', '-n', String(count + 1), '--skip', String(skip),
      '--date=iso-strict', '--pretty=format:%h%x1f%s%x1f%cI%x1f%an']);
  } catch (e) {
    return { commits: [], hasMore: false };
  }
  const rows = out.split('\n').filter(Boolean).map(function (line) {
    const parts = line.split('\x1f');
    const date = parts[2] || '';
    return {
      sha: parts[0] || '',
      subject: parts[1] || '',
      date: date,
      relative: relativeTime(date),
      author: parts[3] || ''
    };
  });
  return { commits: rows.slice(0, count), hasMore: rows.length > count };
}

function currentBranch(baseDir) {
  try {
    return String(gitSync(baseDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch (e) { return ''; }
}

function headShortSha(baseDir) {
  try {
    return String(gitSync(baseDir, ['rev-parse', '--short=7', 'HEAD'])).trim();
  } catch (e) { return ''; }
}

/** 页面展示用：只读本地，不联网。 */
function describe(baseDir, options) {
  const opts = options || {};
  const repo = String(opts.repo || DEFAULT_REPO);
  const branch = String(opts.branch || DEFAULT_BRANCH);
  let changes = [];
  if (opts.changes !== false) {
    try { changes = listChanges(baseDir); } catch (e) {
      throw sourceError('SOURCE_NOT_REPO', '读取 git 状态失败：' + e.message);
    }
  }
  const history = listCommits(baseDir, opts.limit, opts.offset);
  return {
    repo: repo,
    branch: branch,
    localBranch: currentBranch(baseDir),
    head: headShortSha(baseDir),
    changes: changes,
    commits: history.commits,
    hasMore: history.hasMore,
    offset: Math.max(0, Number(opts.offset) || 0),
    limit: Math.max(1, Math.min(COMMIT_LIMIT, Number(opts.limit) || COMMIT_LIMIT)),
    clean: opts.changes === false ? null : changes.length === 0
  };
}

/** 提交说明：一句、非空、不含换行与控制字符、不超过 200 字。 */
function validateMessage(raw) {
  const message = String(raw == null ? '' : raw).trim();
  if (!message) throw sourceError('SOURCE_MESSAGE_REQUIRED', '请先写一句更新说明。');
  if (message.length > MAX_MESSAGE) {
    throw sourceError('SOURCE_MESSAGE_TOO_LONG', '提交说明不能超过 ' + MAX_MESSAGE + ' 字。');
  }
  if (/[\u0000-\u001f\u007f]/.test(message)) {
    throw sourceError('SOURCE_MESSAGE_INVALID', '提交说明只能是一行，不能包含换行或控制字符。');
  }
  return message;
}

/** 拉远端分支的 sha；分支不存在返回空字符串。 */
function remoteBranchSha(baseDir, repo, branch, log) {
  let out = '';
  try {
    out = gitSync(baseDir, ['ls-remote', '--heads', repo]);
  } catch (e) {
    throw sourceError('SOURCE_REMOTE_UNREACHABLE',
      '连不上远端仓库，检查网络或 SSH 密钥：' + String(e.stderr || e.message).trim(), String(e.stderr || e.message));
  }
  let sha = '';
  String(out).split('\n').forEach(function (line) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 2 && parts[1] === 'refs/heads/' + branch) sha = parts[0];
  });
  return sha;
}

async function commitAndPush(baseDir, rawMessage, options) {
  const opts = options || {};
  const repo = String(opts.repo || DEFAULT_REPO);
  const branch = String(opts.branch || DEFAULT_BRANCH);
  const message = validateMessage(rawMessage);
  const log = opts.log || function () {};
  const result = { committed: false, pushed: false, commit: '', files: [], log: '' };

  function note(text) { result.log += text; }

  const changes = listChanges(baseDir);
  if (!changes.length) {
    throw sourceError('SOURCE_EMPTY', '没有需要提交的改动。');
  }
  if (changes.some(function (row) { return isExcluded(row.path); })) {
    throw sourceError('SOURCE_FORBIDDEN', '改动里含有不该提交的本地文件，已停止。');
  }

  // 只 add 这份显式清单：没有 git add -A，也不会读到清单之外的文件。
  const files = changes.map(function (row) { return row.path; });
  note('$ git add -- ' + files.join(' ') + '\n');
  await gitRun(baseDir, ['add', '--'].concat(files), { log: note });

  // add 之后再校验一次暂存区，防止 .gitignore 被改后带进私有文件。
  const staged = String(gitSync(baseDir, ['diff', '--cached', '--name-only', '-z']))
    .split('\0').filter(Boolean);
  const forbidden = staged.filter(isExcluded);
  if (forbidden.length) {
    try { gitSync(baseDir, ['reset', '-q', '--'].concat(forbidden)); } catch (e) { /* 忽略 */ }
    throw sourceError('SOURCE_FORBIDDEN', '暂存区出现不该提交的文件：' + forbidden.join('、'));
  }
  if (!staged.length) throw sourceError('SOURCE_EMPTY', '没有需要提交的改动。');

  note('$ git commit -m <' + message.length + ' 字说明>\n');
  await gitRun(baseDir, [
    '-c', 'user.name=' + COMMIT_NAME,
    '-c', 'user.email=' + COMMIT_EMAIL,
    '-c', 'commit.gpgsign=false',
    'commit', '-m', message
  ], { log: note });
  result.committed = true;
  result.commit = headShortSha(baseDir);
  result.files = changes;

  // 推送前检查：远端有本地没有的提交就停下，绝不 force。
  let remoteSha = '';
  try {
    remoteSha = remoteBranchSha(baseDir, repo, branch, note);
    if (remoteSha) {
      note('$ git fetch ' + repo + ' refs/heads/' + branch + '\n');
      await gitRun(baseDir, ['fetch', '--no-tags', repo, 'refs/heads/' + branch], { log: note });
      const ahead = Number(String(gitSync(baseDir, ['rev-list', '--count', 'HEAD..FETCH_HEAD'])).trim()) || 0;
      if (ahead > 0) {
        throw sourceError('SOURCE_REMOTE_AHEAD',
          '远端 ' + branch + ' 有 ' + ahead + ' 个本地没有的提交，已停止推送（未使用 --force）。' +
          '请先手动拉取合并后再试。');
      }
    }
  } catch (err) {
    if (err && err.code === 'SOURCE_REMOTE_AHEAD') {
      err.committed = true;
      err.commit = result.commit;
      err.log = result.log;
      throw err;
    }
    // 远端不可达：提交已经成功，按「已提交未推送」返回，保留原始错误。
    const raw = String((err && (err.raw || err.message)) || err).trim();
    note('\n✗ ' + raw + '\n');
    const failed = sourceError('SOURCE_PUSH_FAILED',
      '已提交到本地（' + result.commit + '），但推送失败：' + (err && err.message ? err.message : raw), raw);
    failed.committed = true;
    failed.pushed = false;
    failed.commit = result.commit;
    failed.files = changes;
    failed.log = result.log;
    throw failed;
  }

  note('$ git push ' + repo + ' HEAD:refs/heads/' + branch + '\n');
  try {
    await gitRun(baseDir, ['push', repo, 'HEAD:refs/heads/' + branch], { log: note, timeoutMs: 240000 });
  } catch (err) {
    const raw = String((err && (err.raw || err.message)) || err).trim();
    note('\n✗ ' + raw + '\n');
    const failed = sourceError('SOURCE_PUSH_FAILED',
      '已提交到本地（' + result.commit + '），但推送失败：' + (err && err.message ? err.message : raw), raw);
    failed.committed = true;
    failed.pushed = false;
    failed.commit = result.commit;
    failed.files = changes;
    failed.log = result.log;
    throw failed;
  }

  result.pushed = true;
  note('\n✓ 已推送到 ' + branch + '\n');
  return result;
}

/* ------------------------------------------------------------ 从远端恢复 */

function stampNow() {
  const d = new Date();
  function pad(n) { return String(n).length < 2 ? '0' + n : String(n); }
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function isInside(baseDir, target) {
  const root = path.resolve(baseDir);
  const abs = path.resolve(target);
  return abs === root || abs.indexOf(root + path.sep) === 0;
}

/** 恢复后仍留在工作区的未跟踪文件（不含私有目录/凭据）。 */
function listUntracked(baseDir) {
  try {
    return parseStatus(gitSync(baseDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
      .filter(function (row) { return row.code === '??' && !isExcluded(row.path); })
      .map(function (row) { return row.path; })
      .sort();
  } catch (e) { return []; }
}

function blobAt(baseDir, rev, file) {
  try {
    return String(execFileSync('git', ['rev-parse', rev + ':' + file], {
      cwd: baseDir, encoding: 'utf8', windowsHide: true,
      // 文件不存在时 git 会往 stderr 写 fatal，这里静默掉：缺文件本身就等于“没变化”。
      stdio: ['ignore', 'pipe', 'ignore']
    })).trim();
  } catch (e) { return ''; }
}

/**
 * 把当前改动复制到 bak/admin/restore/<时间戳>/，并写 manifest.json + worktree.patch。
 * 任何一步失败都抛 SOURCE_BACKUP_FAILED，调用方必须放弃覆盖。
 */
function backupWorktree(baseDir, changes, stamp) {
  const relPath = 'bak/admin/restore/' + stamp;
  const dest = path.join(baseDir, 'bak', 'admin', 'restore', stamp);
  const filesDir = path.join(dest, 'files');
  const entries = [];
  try {
    fs.mkdirSync(filesDir, { recursive: true });
    changes.forEach(function (row) {
      if (isExcluded(row.path)) return;
      if (row.status === 'D') {
        entries.push({ path: row.path, status: 'D', saved: false, note: '文件已删除，内容不在工作区' });
        return;
      }
      const src = path.join(baseDir, row.path);
      if (!isInside(baseDir, src)) throw new Error('路径越界：' + row.path);
      const dst = path.join(filesDir, row.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      entries.push({ path: row.path, status: row.status, saved: true });
    });

    // 补丁兜底：即使有「已暂存但工作区又改过」的边缘情况，也能从 patch 找回。
    let patch = '';
    try { patch = gitSync(baseDir, ['diff', 'HEAD', '--binary']); } catch (e) { patch = ''; }
    if (patch) fs.writeFileSync(path.join(dest, 'worktree.patch'), patch, 'utf8');

    const manifest = {
      createdAt: new Date().toISOString(),
      head: String(gitSync(baseDir, ['rev-parse', 'HEAD'])).trim(),
      files: entries
    };
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return { dir: relPath, absDir: dest, count: entries.length, files: entries };
  } catch (err) {
    // fs 的 ENOTDIR / EACCES 等错误也有 code，不能当成业务错误直接透传。
    if (err && /^SOURCE_/.test(String(err.code || ''))) throw err;
    throw sourceError('SOURCE_BACKUP_FAILED', '备份失败，已中止恢复：' + err.message, err.message);
  }
}

/**
 * 用远端分支覆盖本地：先强制备份工作区，再 fetch + reset --hard。
 * 不使用 git clean：未跟踪文件原样保留。fetch/reset 都不触碰远端。
 */
async function restoreFromRemote(baseDir, options) {
  const opts = options || {};
  const repo = String(opts.repo || DEFAULT_REPO);
  const branch = String(opts.branch || DEFAULT_BRANCH);
  const log = opts.log || function () {};
  const result = {
    restored: false,
    fromSha: '',
    toSha: '',
    shortTo: '',
    backup: null,
    retained: [],
    dependencyWarning: '',
    generate: { ok: true, error: '' },
    log: ''
  };
  function note(text) { result.log += text; }

  assertRepo(baseDir);
  const changes = listChanges(baseDir);

  // 1) 先备份：失败就结束，绝不进入覆盖步骤。
  const backup = backupWorktree(baseDir, changes, stampNow());
  result.backup = { path: backup.dir, absPath: backup.absDir, count: backup.count, files: backup.files };
  note('$ 备份工作区 → ' + backup.dir + '（' + backup.count + ' 项）\n');

  const fromSha = String(gitSync(baseDir, ['rev-parse', 'HEAD'])).trim();
  result.fromSha = fromSha;

  try {
    // 2) 取远端 source，再让本地分支指向它。
    note('$ git fetch ' + repo + ' refs/heads/' + branch + '\n');
    await gitRun(baseDir, ['fetch', '--no-tags', repo, 'refs/heads/' + branch],
      { log: note, timeoutMs: 240000 });

    const toSha = String(gitSync(baseDir, ['rev-parse', 'FETCH_HEAD'])).trim();
    result.toSha = toSha;
    result.shortTo = toSha.slice(0, 7);

    const depChanged = ['package.json', 'package-lock.json'].some(function (file) {
      return blobAt(baseDir, 'HEAD', file) !== blobAt(baseDir, 'FETCH_HEAD', file);
    });

    note('$ git reset --hard FETCH_HEAD\n');
    await gitRun(baseDir, ['reset', '--hard', 'FETCH_HEAD'], { log: note });
    result.restored = true;
    result.retained = listUntracked(baseDir);
    if (depChanged) {
      result.dependencyWarning = '依赖可能已变（package.json / package-lock.json 与恢复前不同），需要重新 npm install。';
    }
    note('✓ 已恢复到 ' + result.shortTo + '\n');
  } catch (err) {
    const raw = String((err && (err.raw || err.message)) || err).trim();
    const failed = err && err.code ? err : sourceError('SOURCE_RESTORE_FAILED', '恢复失败：' + raw, raw);
    failed.backup = result.backup;
    failed.fromSha = fromSha;
    failed.log = result.log;
    throw failed;
  }

  // 3) 生成失败不影响后台存活，只把原始错误带回前端。
  if (opts.runGenerate) {
    try {
      await opts.runGenerate({ log: note });
      result.generate = { ok: true, error: '' };
    } catch (err) {
      result.generate = { ok: false, error: String((err && (err.raw || err.message)) || err).trim() };
      note('\n✗ hexo generate 失败：' + result.generate.error + '\n');
    }
  }

  return result;
}

/** 相对仓库根的路径检查，确保后台只在仓库内执行。 */
function assertRepo(baseDir) {
  let root = '';
  try {
    root = String(gitSync(baseDir, ['rev-parse', '--show-toplevel'])).trim();
  } catch (e) {
    throw sourceError('SOURCE_NOT_REPO', '当前目录不是 git 仓库，无法提交源码。');
  }
  if (!root) throw sourceError('SOURCE_NOT_REPO', '当前目录不是 git 仓库，无法提交源码。');
  return path.resolve(root);
}

module.exports = {
  DEFAULT_REPO: DEFAULT_REPO,
  DEFAULT_BRANCH: DEFAULT_BRANCH,
  MAX_MESSAGE: MAX_MESSAGE,
  describe: describe,
  listChanges: listChanges,
  listCommits: listCommits,
  isExcluded: isExcluded,
  validateMessage: validateMessage,
  commitAndPush: commitAndPush,
  remoteBranchSha: remoteBranchSha,
  restoreFromRemote: restoreFromRemote,
  listUntracked: listUntracked,
  assertRepo: assertRepo
};
