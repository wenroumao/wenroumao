'use strict';
/**
 * tools/admin/ssh.js —— 本机 SSH 密钥的只读展示、生成与连通性测试
 * ---------------------------------------------------------------------------
 * 安全边界：
 *   - 只读接口只读取 *.pub（公钥）与文件是否存在，绝不读取、绝不回传私钥内容；
 *   - keygen 只在目标文件不存在时执行，存在就拒绝，不覆盖；
 *   - 生成后的私钥不会出现在任何返回值或日志里；
 *   - ssh 调用一律 spawn + 参数数组，不拼 shell。
 *
 * 口令策略：后台生成的 ed25519 默认不设口令（-N ''）。
 * 理由：后台用 BatchMode=yes 做非交互 git push，带口令的密钥在没有 ssh-agent 的
 * 场景会直接认证失败；本机单人使用，密钥文件权限由 OpenSSH 控制。需要口令的
 * 用户可以自己用 ssh-keygen 生成，后台不会覆盖已有文件。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const KEY_TYPES = [
  { id: 'ed25519', label: 'Ed25519', privateName: 'id_ed25519', publicName: 'id_ed25519.pub' },
  { id: 'rsa', label: 'RSA', privateName: 'id_rsa', publicName: 'id_rsa.pub' }
];

const TEST_COMMAND = 'ssh -T git@github.com';
const GENERATE_COMMAND = 'ssh-keygen -t ed25519 -C "your-email@example.com"';

function sshError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function safeHome(value) {
  return path.resolve(String(value || os.homedir()));
}

function sshDir(home) {
  return path.join(safeHome(home), '.ssh');
}

/** 公钥指纹：SHA256(key blob)，与 ssh-keygen -lf 的 SHA256: 形式一致。 */
function publicKeyFingerprint(publicKey) {
  const parts = String(publicKey || '').trim().split(/\s+/);
  if (parts.length < 2) return '';
  try {
    const blob = Buffer.from(parts[1], 'base64');
    if (!blob.length) return '';
    return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  } catch (e) { return ''; }
}

function readPublicKey(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text.length > 8192 ? '' : text;
  } catch (e) { return ''; }
}

function exists(file) {
  try { return fs.existsSync(file); } catch (e) { return false; }
}

/**
 * 只读描述：是否存在私钥/公钥（布尔）、公钥全文、指纹。
 * 注意：这里从头到尾不会打开私钥文件。
 */
function describe(options) {
  const opts = options || {};
  const dir = sshDir(opts.home);
  const keys = {};
  KEY_TYPES.forEach(function (type) {
    const privateFile = path.join(dir, type.privateName);
    const publicFile = path.join(dir, type.publicName);
    const publicKey = readPublicKey(publicFile);
    keys[type.id] = {
      id: type.id,
      label: type.label,
      private: exists(privateFile),
      public: exists(publicFile),
      publicKey: publicKey,
      fingerprint: publicKeyFingerprint(publicKey)
    };
  });

  // 优先展示 ed25519；没有就退回 RSA；两个都没有时 active 为空。
  const active = (keys.ed25519.private || keys.ed25519.public) ? 'ed25519'
    : (keys.rsa.private || keys.rsa.public) ? 'rsa' : '';

  return {
    dir: '~/.ssh',
    keys: keys,
    active: active,
    publicKey: active ? keys[active].publicKey : '',
    fingerprint: active ? keys[active].fingerprint : '',
    testCommand: TEST_COMMAND,
    generateCommand: GENERATE_COMMAND,
    keygenSupported: true,
    note: '私钥只保存在本机 ~/.ssh，接口只显示公钥；生成后私钥不会再回传页面。'
  };
}

/** 默认 keygen：spawn 数组传参，不经过 shell。 */
function defaultKeygen(task) {
  return new Promise(function (resolve, reject) {
    const env = Object.assign({}, process.env, { HOME: task.home, USERPROFILE: task.home });
    const child = spawn('ssh-keygen', [
      '-t', 'ed25519',
      '-f', task.target,
      '-N', '',
      '-C', task.comment,
      '-q'
    ], { env: env, windowsHide: true });

    let output = '';
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) { /* 忽略 */ }
      reject(sshError('SSH_KEYGEN_TIMEOUT', 'ssh-keygen 超时，已中断。'));
    }, 20000);

    child.stdout.on('data', function (chunk) { output += chunk; });
    child.stderr.on('data', function (chunk) { output += chunk; });
    child.on('error', function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err && err.code === 'ENOENT') {
        return reject(sshError('SSH_KEYGEN_MISSING', '找不到 ssh-keygen：请先安装 Windows OpenSSH 客户端，或手动生成密钥。'));
      }
      reject(sshError('SSH_KEYGEN_FAILED', 'ssh-keygen 启动失败：' + err.message));
    });
    child.on('close', function (code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve(output);
      reject(sshError('SSH_KEYGEN_FAILED', 'ssh-keygen 退出码 ' + code + (output ? '：' + output.trim().slice(-300) : '')));
    });
  });
}

function publicFileFor(type, dir) {
  return path.join(dir, type.publicName);
}

/**
 * 生成 ed25519 密钥。目标私钥或公钥已存在时直接拒绝，不做任何覆盖。
 */
async function generateKey(options) {
  const opts = options || {};
  const home = safeHome(opts.home);
  const dir = sshDir(home);
  const type = KEY_TYPES[0];
  const target = path.join(dir, type.privateName);
  const publicFile = publicFileFor(type, dir);

  if (exists(target) || exists(publicFile)) {
    throw sshError('SSH_KEY_EXISTS',
      '~/.ssh/id_ed25519 已存在，不会覆盖。请先备份或手动移除后再生成，或直接使用现有公钥。');
  }

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw sshError('SSH_KEYGEN_FAILED', '无法创建 ~/.ssh 目录：' + err.message);
  }

  // 生成前再查一次，避免与其它进程竞争。
  if (exists(target) || exists(publicFile)) {
    throw sshError('SSH_KEY_EXISTS', '目标文件在生成过程中出现，已停止，不会覆盖。');
  }

  const runner = opts.runKeygen || defaultKeygen;
  await runner({
    home: home,
    dir: dir,
    target: target,
    publicFile: publicFile,
    comment: String(opts.comment || 'wenroumao-admin')
  });

  const publicKey = readPublicKey(publicFile);
  if (!publicKey) {
    throw sshError('SSH_KEYGEN_FAILED', 'ssh-keygen 执行后没有找到公钥文件 ~/.ssh/id_ed25519.pub。');
  }

  return {
    ok: true,
    algorithm: 'ed25519',
    passphrase: false,
    passphraseReason: '未设口令：后台用 BatchMode=yes 做非交互 git 推送，带口令的密钥在没有 ssh-agent 时会认证失败。',
    publicKey: publicKey,
    fingerprint: publicKeyFingerprint(publicKey),
    files: {
      private: '~/.ssh/id_ed25519',
      public: '~/.ssh/id_ed25519.pub'
    }
  };
}

/** 默认 ssh 测试：BatchMode + accept-new，15 秒超时。 */
function defaultTest(task) {
  return new Promise(function (resolve) {
    const timeoutMs = task.timeoutMs || 15000;
    const seconds = Math.max(1, Math.floor(timeoutMs / 1000));
    const env = Object.assign({}, process.env, { HOME: task.home, USERPROFILE: task.home });
    let output = '';
    let settled = false;
    let timedOut = false;

    let child;
    try {
      child = spawn('ssh', [
        '-T',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=' + seconds,
        'git@github.com'
      ], { env: env, windowsHide: true });
    } catch (err) {
      return resolve({ errorCode: err && err.code, errorMessage: err.message, output: '', timedOut: false });
    }

    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      timedOut = true;
      try { child.kill(); } catch (e) { /* 忽略 */ }
      resolve({ code: null, signal: 'SIGKILL', output: output, timedOut: true });
    }, timeoutMs);

    function onData(chunk) { output += String(chunk); }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        errorCode: err && err.code,
        errorMessage: err && err.message,
        output: output,
        timedOut: false
      });
    });
    child.on('close', function (code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code, signal: signal, output: output, timedOut: false });
    });
  });
}

/**
 * 把 ssh -T 的原始输出归类。
 * GitHub 认证成功时故意返回退出码 1，因此只看退出码会误判；这里按文本分类。
 */
function classify(result) {
  const input = result || {};
  const raw = String(input.output || '').trim();
  const lower = raw.toLowerCase();

  if (input.timedOut || input.signal === 'SIGKILL' || input.signal === 'SIGTERM') {
    return {
      status: 'timeout', ok: false, label: '超时',
      hint: '15 秒内没有完成握手：检查网络、代理或防火墙是否拦截了 22 端口。',
      raw: raw
    };
  }

  if (input.errorCode === 'ENOENT') {
    return {
      status: 'network', ok: false, label: '网络不通',
      hint: '找不到 ssh 命令：请安装 Windows OpenSSH 客户端，或把 C:\\Windows\\System32\\OpenSSH 加入 PATH。',
      raw: raw || String(input.errorMessage || '')
    };
  }

  if (/successfully authenticated/i.test(raw) || /hi\s+[^\s!]+!.*successfully authenticated/i.test(raw)) {
    return {
      status: 'ok', ok: true, label: '认证成功',
      hint: 'GitHub 已经认得这把公钥；它不提供 shell，所以提示 “does not provide shell access” 属于正常。',
      raw: raw
    };
  }

  if (/permission denied\s*\(publickey/i.test(raw) || /publickey,password/i.test(raw) ||
      /please make sure you have correct access rights/i.test(raw)) {
    return {
      status: 'no-key', ok: false, label: '公钥未添加',
      hint: '这把公钥还没有加到 GitHub：打开 https://github.com/settings/keys 新建 SSH key 后重试。',
      raw: raw
    };
  }

  if (/could not resolve hostname/i.test(raw) || /connection refused/i.test(raw) ||
      /connection timed out/i.test(raw) || /operation timed out/i.test(raw) ||
      /network is unreachable/i.test(raw) || /no route to host/i.test(raw) ||
      /connection reset/i.test(raw) || /kex_exchange_identification/i.test(raw) ||
      /host key verification failed/i.test(raw) || /port 22:/i.test(raw)) {
    return {
      status: 'network', ok: false, label: '网络不通',
      hint: '连不上 github.com:22：检查网络、DNS、代理或公司防火墙。',
      raw: raw
    };
  }

  return {
    status: 'unknown', ok: false, label: '未知结果',
    hint: '没有得到可识别的输出，请把下面的原始输出发出来排查。',
    raw: raw
  };
}

/** 执行测试并归类；runner 可注入，测试里不会真的联网。 */
async function testConnection(options) {
  const opts = options || {};
  const runner = opts.runTest || defaultTest;
  const home = safeHome(opts.home);
  const result = await runner({
    home: home,
    timeoutMs: opts.timeoutMs || 15000
  });
  const classified = classify(result);
  return Object.assign({
    command: TEST_COMMAND,
    checkedAt: new Date().toISOString()
  }, classified);
}

module.exports = {
  KEY_TYPES: KEY_TYPES,
  TEST_COMMAND: TEST_COMMAND,
  GENERATE_COMMAND: GENERATE_COMMAND,
  describe: describe,
  generateKey: generateKey,
  testConnection: testConnection,
  classify: classify,
  publicKeyFingerprint: publicKeyFingerprint
};
