'use strict';
/**
 * 后台核心与 HTTP 集成测试（不依赖真实 hexo / 不联网）
 * 运行：node --test tools/tests/admin.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const core = require('../admin/core.js');
const deploy = require('../admin/deploy.js');
const createAdminServer = require('../admin/server.js');
const packager = require('../admin/package.js');
const ssh = require('../admin/ssh.js');
const oss = require('../admin/oss.js');
const source = require('../admin/source.js');
const importer = require('../admin/importer.js');
const crypto = require('crypto');

const CONFIG_SITE = [
  'title: Demo',
  "subtitle: ''",
  "description: ''",
  "keywords: ''",
  'author: Me',
  'language: zh-CN',
  'url: https://example.com/',
  ''
].join('\n');

const CONFIG_THEME = [
  'avatar:',
  '  img: /img/avatar.png',
  'index_img:',
  'default_top_img: /img/default.png',
  'footer:',
  '  owner:',
  '    since: 2020 # 建站年份',
  "  custom_text: ''",
  'preloader:',
  '  enable: true',
  'subtitle:',
  '  enable: true',
  '  effect: true',
  '  sub:',
  '    - 第一句',
  '    - 第二句',
  'ai_chat:',
  '  enable: false',
  '  model: deepseek-chat # 对话模型',
  ''
].join('\n');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fomalhaut-admin-'));
  fs.mkdirSync(path.join(dir, 'source', '_posts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'source', '_posts', '2026-01-01-hello.md'), [
    '---',
    'title: 第一篇',
    'date: 2026-01-01 10:00:00',
    'categories:',
    '  - 随笔',
    'tags:',
    '  - 测试',
    'cover: /img/cover.png',
    'description: 摘要',
    'comments: true',
    'abbrlink: 12345',
    '---',
    '',
    '正文内容',
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, '_config.yml'), CONFIG_SITE, 'utf8');
  fs.writeFileSync(path.join(dir, '_config.fomalhaut.yml'), CONFIG_THEME, 'utf8');
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function startServer(dir, envOverride, extra) {
  const env = Object.assign({
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'secret',
    ADMIN_AUTO_GENERATE: '1'
  }, envOverride || {});
  const calls = { generate: 0, deploy: [] };
  const middleware = createAdminServer(Object.assign({
    baseDir: dir,
    env: env,
    runGenerate: function (task) {
      calls.generate += 1;
      task.log('fake generate\n');
      return delay(20);
    },
    runDeploy: function (task) {
      calls.deploy.push({ repo: task.repo, branch: task.branch });
      task.log('fake deploy\n');
      return delay(20);
    }
  }, extra || {}));
  const server = http.createServer(function (req, res) {
    middleware(req, res, function () {
      res.statusCode = 404;
      res.end('next');
    });
  });
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    base: base,
    calls: calls,
    close: function () {
      return new Promise(function (resolve) { server.close(resolve); });
    }
  };
}

async function call(base, apiPath, options) {
  options = options || {};
  const headers = {};
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.csrf) headers['X-CSRF-Token'] = options.csrf;
  if (options.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + apiPath, {
    method: options.method || 'GET',
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const json = await res.json().catch(function () { return {}; });
  return { status: res.status, json: json, setCookie: res.headers.get('set-cookie') || '' };
}

async function login(base) {
  const res = await call(base, '/admin/api/login', {
    method: 'POST',
    body: { username: 'admin', password: 'secret' }
  });
  assert.equal(res.status, 200);
  const cookie = String(res.setCookie).split(';')[0];
  assert.match(cookie, /^fomalhaut_admin=/);
  return { cookie: cookie, csrf: res.json.csrf };
}

async function waitJob(base, auth, id) {
  for (let i = 0; i < 80; i++) {
    const res = await call(base, '/admin/api/publish/' + id, { cookie: auth.cookie });
    if (res.json.job && res.json.job.status !== 'running') return res.json.job;
    await delay(25);
  }
  throw new Error('构建任务没有在预期时间内结束');
}

/* ------------------------------------------------------------------ core */

test('front matter：解析、补丁保留未知字段与注释', function () {
  const raw = [
    '---',
    'title: 旧标题',
    'date: 2026-01-01 10:00:00',
    'categories:',
    '  - 随笔',
    'abbrlink: 12345',
    '---',
    '',
    '正文'
  ].join('\n');
  const split = core.splitFrontMatter(raw);
  assert.equal(split.hasFrontMatter, true);
  const data = core.parseFields(split.frontMatter);
  assert.equal(data.title, '旧标题');
  assert.deepEqual(data.categories, ['随笔']);
  assert.equal(data.abbrlink, '12345');

  const patched = core.patchFrontMatter(split.frontMatter, { title: '新标题', tags: ['甲', '乙'] });
  assert.match(patched, /title: 新标题/);
  assert.match(patched, /abbrlink: 12345/);
  assert.match(patched, /- 甲/);
});

test('YAML 路径：读取嵌套值、写回保留行尾注释', function () {
  assert.equal(core.getYamlPath(CONFIG_THEME, ['footer', 'owner', 'since']), 2020);
  assert.deepEqual(core.getYamlPath(CONFIG_THEME, ['subtitle', 'sub']), ['第一句', '第二句']);
  assert.equal(core.getYamlPath(CONFIG_THEME, ['ai_chat', 'enable']), false);
  assert.equal(core.getYamlPath(CONFIG_THEME, ['index_img']), '');

  const next = core.setYamlPath(CONFIG_THEME, ['footer', 'owner', 'since'], 2021);
  assert.match(next, /since: 2021 # 建站年份/);
  const toggled = core.setYamlPath(CONFIG_THEME, ['ai_chat', 'enable'], true);
  assert.match(toggled, /enable: true/);
  assert.match(toggled, /model: deepseek-chat # 对话模型/);

  const appended = core.setYamlPath(CONFIG_SITE, ['new_key'], 'hello');
  assert.match(appended, /new_key: hello/);
});

test('文章路径：拒绝穿越、绝对路径与非 md 文件', function () {
  const dir = makeFixture();
  try {
    assert.equal(core.resolvePostPath(dir, '2026-01-01-hello.md').rel, '2026-01-01-hello.md');
    assert.throws(function () { core.resolvePostPath(dir, '../_config.yml'); });
    assert.throws(function () { core.resolvePostPath(dir, '/etc/passwd.md'); });
    assert.throws(function () { core.resolvePostPath(dir, 'C:/secret.md'); });
    assert.throws(function () { core.resolvePostPath(dir, 'note.txt'); });
    assert.throws(function () { core.resolvePostPath(dir, '.hidden.md'); });
  } finally { cleanup(dir); }
});

test('slug 与部署仓库守卫：绝不指向主题上游', function () {
  assert.equal(core.slugFromTitle('你好 Hexo / 世界'), '你好-Hexo-世界');
  assert.equal(core.slugFromTitle(''), 'untitled');
  assert.match(deploy.repoConflict(os.tmpdir(), 'git@github.com:fomalhaut1998/hexo-theme-fomalhaut.git'), /主题上游/);
  assert.equal(deploy.normalizeRepo('git@github.com:wenroumao/wenroumao.git'), 'github.com/wenroumao/wenroumao');
  assert.equal(deploy.normalizeRepo('https://github.com/wenroumao/wenroumao.git'), 'github.com/wenroumao/wenroumao');
});

/* --------------------------------------------------------------- HTTP */

test('会话：未登录 401，登录后可以读取列表', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const anon = await call(srv.base, '/admin/api/posts');
    assert.equal(anon.status, 401);

    const auth = await login(srv.base);
    const list = await call(srv.base, '/admin/api/posts', { cookie: auth.cookie });
    assert.equal(list.status, 200);
    assert.equal(list.json.posts.length, 1);
    assert.equal(list.json.posts[0].title, '第一篇');

    const session = await call(srv.base, '/admin/api/session', { cookie: auth.cookie });
    assert.equal(session.json.authenticated, true);
    assert.equal(session.json.user, 'admin');
    assert.equal(session.json.deploy.ready, false);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('登录失败限流与错误密码', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const bad = await call(srv.base, '/admin/api/login', {
      method: 'POST', body: { username: 'admin', password: 'wrong' }
    });
    assert.equal(bad.status, 401);
    const ok = await call(srv.base, '/admin/api/login', {
      method: 'POST', body: { username: 'admin', password: 'secret' }
    });
    assert.equal(ok.status, 200);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('文章保存后自动生成，并保留原 front matter 未知字段', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const auth = await login(srv.base);
    const saved = await call(srv.base, '/admin/api/posts/2026-01-01-hello.md', {
      method: 'PUT',
      cookie: auth.cookie,
      csrf: auth.csrf,
      body: {
        title: '改过的标题', date: '2026-01-01 10:00:00', categories: ['随笔'], tags: ['测试', '新标签'],
        cover: '', description: '', comments: true, body: '新的正文'
      }
    });
    assert.equal(saved.status, 200);
    assert.ok(saved.json.build && saved.json.build.job);
    const job = await waitJob(srv.base, auth, saved.json.build.job.id);
    assert.equal(job.status, 'success');
    assert.ok(srv.calls.generate >= 1);

    const text = fs.readFileSync(path.join(dir, 'source', '_posts', '2026-01-01-hello.md'), 'utf8');
    assert.match(text, /title: 改过的标题/);
    assert.match(text, /abbrlink: 12345/);
    assert.doesNotMatch(text, /cover:/);
    assert.match(text, /新的正文/);
    assert.ok(fs.existsSync(path.join(dir, 'bak', 'admin')));

    const traversal = await call(srv.base, '/admin/api/posts/' + encodeURIComponent('../_config.yml'), {
      cookie: auth.cookie
    });
    assert.equal(traversal.status, 400);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('配置保存：白名单字段生效并自动生成', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const auth = await login(srv.base);
    const payload = await call(srv.base, '/admin/api/config', { cookie: auth.cookie });
    assert.equal(payload.status, 200);
    const titleField = payload.json.groups[0].fields.filter(function (f) { return f.id === 'title'; })[0];
    assert.equal(titleField.value, 'Demo');

    const saved = await call(srv.base, '/admin/api/config', {
      method: 'PUT',
      cookie: auth.cookie,
      csrf: auth.csrf,
      body: { values: { title: '温柔猫的博客', 'footer.owner.since': 2022, 'subtitle.sub': ['甲', '乙'] } }
    });
    assert.equal(saved.status, 200);
    await waitJob(srv.base, auth, saved.json.build.job.id);

    const site = fs.readFileSync(path.join(dir, '_config.yml'), 'utf8');
    assert.match(site, /title: 温柔猫的博客/);
    const theme = fs.readFileSync(path.join(dir, '_config.fomalhaut.yml'), 'utf8');
    assert.match(theme, /since: 2022 # 建站年份/);
    assert.match(theme, /- 甲/);
    assert.match(theme, /- 乙/);

    const bad = await call(srv.base, '/admin/api/config', {
      method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
      body: { values: { 'footer.owner.since': '不是数字' } }
    });
    assert.equal(bad.status, 400);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('功能开关：分组返回、白名单校验、保留注释且不自动生成', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const auth = await login(srv.base);

    const listed = await call(srv.base, '/admin/api/features', { cookie: auth.cookie });
    assert.equal(listed.status, 200);
    const groups = listed.json.groups || [];
    const names = groups.map(function (g) { return g.name; });
    ['界面外观', '氛围特效', '阅读体验', '交互与评论', 'AI 能力', '站点与 SEO'].forEach(function (name) {
      assert.ok(names.indexOf(name) >= 0, '缺少分组 ' + name);
    });
    const all = groups.reduce(function (acc, g) { return acc.concat(g.fields); }, []);
    assert.equal(listed.json.total, all.length);
    assert.ok(all.length >= 40, '开关数量应覆盖常用项');
    const preloader = all.filter(function (f) { return f.id === 'preloader.enable'; })[0];
    assert.equal(preloader.value, true);
    assert.equal(preloader.file, '_config.fomalhaut.yml');
    assert.equal(preloader.path, 'preloader.enable');

    const config = await call(srv.base, '/admin/api/config', { cookie: auth.cookie });
    const configIds = config.json.groups.reduce(function (acc, g) {
      return acc.concat(g.fields.map(function (f) { return f.id; }));
    }, []);
    assert.ok(configIds.indexOf('preloader.enable') < 0, '开关不应重复出现在普通配置页');
    assert.ok(configIds.indexOf('title') >= 0);

    const unknown = await call(srv.base, '/admin/api/features', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: { id: 'url', value: false }
    });
    assert.equal(unknown.status, 400);
    const wrongType = await call(srv.base, '/admin/api/features', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: { id: 'preloader.enable', value: 'false' }
    });
    assert.equal(wrongType.status, 400);

    const saved = await call(srv.base, '/admin/api/features', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: { id: 'preloader.enable', value: false }
    });
    assert.equal(saved.status, 200);

    const theme = fs.readFileSync(path.join(dir, '_config.fomalhaut.yml'), 'utf8');
    assert.match(theme, /preloader:\n {2}enable: false/);
    assert.match(theme, /since: 2020 # 建站年份/);
    assert.match(theme, /- 第一句/);
    assert.ok(fs.existsSync(path.join(dir, 'bak', 'admin')));
    // 开关保存不触发自动生成：由用户显式点「重新生成」
    assert.equal(srv.calls.generate, 0);

    const after = await call(srv.base, '/admin/api/features', { cookie: auth.cookie });
    const next = after.json.groups.reduce(function (acc, g) { return acc.concat(g.fields); }, [])
      .filter(function (f) { return f.id === 'preloader.enable'; })[0];
    assert.equal(next.value, false);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('推送：未配置时拒绝；配置后只推显式地址与分支；上游地址被拒', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const auth = await login(srv.base);

    const blocked = await call(srv.base, '/admin/api/publish', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: { deploy: true }
    });
    assert.equal(blocked.status, 409);
    assert.match(blocked.json.error.message, /部署仓库/);

    const upstream = await call(srv.base, '/admin/api/deploy', {
      method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
      body: { repo: 'git@github.com:fomalhaut1998/hexo-theme-fomalhaut.git', branch: 'main', enabled: true }
    });
    assert.equal(upstream.status, 400);
    assert.match(upstream.json.error.message, /主题上游/);

    const configured = await call(srv.base, '/admin/api/deploy', {
      method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
      body: { repo: 'git@github.com:wenroumao/wenroumao.git', branch: 'main', enabled: true }
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.json.deploy.ready, true);

    const pushed = await call(srv.base, '/admin/api/publish', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: { deploy: true }
    });
    assert.equal(pushed.status, 202);
    const job = await waitJob(srv.base, auth, pushed.json.job.id);
    assert.equal(job.status, 'success');
    assert.equal(job.deploy, true);
    assert.deepEqual(srv.calls.deploy[0], {
      repo: 'git@github.com:wenroumao/wenroumao.git',
      branch: 'main'
    });
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('中文路径：git 的八进制转义会被还原，不会误判成远端多余文件', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fomalhaut-gitpath-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.mkdirSync(path.join(dir, 'categories', '开始使用'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'categories', '开始使用', 'index.html'), 'x');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false',
      'commit', '-qm', 'x'], { cwd: dir });

    const quoted = execFileSync('git', ['-c', 'core.quotePath=true', 'ls-tree', '-r', '--name-only', 'HEAD'],
      { cwd: dir, encoding: 'utf8' }).trim();
    assert.match(quoted, /^"categories\//);
    assert.match(quoted, /\\3[0-7][0-7]/);

    const plain = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'HEAD'],
      { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(plain, 'categories/开始使用/index.html');

    assert.equal(deploy.decodeGitPath(quoted), 'categories/开始使用/index.html');
    assert.equal(deploy.decodeGitPath('tags/标签/index.html'), 'tags/标签/index.html');
  } finally { cleanup(dir); }
});

test('推送被拦：返回冲突清单与分支，确认后只对本次推送放行', async function () {
  const dir = makeFixture();
  const extraFiles = ['categories/开始使用/index.html', 'tags/标签/index.html'];
  const seen = [];
  const srv = await startServer(dir, null, {
    runDeploy: function (task) {
      seen.push({ allowDelete: task.allowDelete === true });
      if (task.allowDelete !== true) {
        const err = new Error('远端 main 分支里有 2 个文件不属于当前 public/ 产物，已停止推送以免误删。');
        err.code = 'DEPLOY_EXTRA_FILES';
        err.files = extraFiles;
        return Promise.reject(err);
      }
      task.log('已确认覆盖，开始推送\n');
      return delay(10);
    }
  });
  try {
    const auth = await login(srv.base);
    const configured = await call(srv.base, '/admin/api/deploy', {
      method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
      body: { repo: 'git@github.com:wenroumao/wenroumao.git', branch: 'main', enabled: true }
    });
    assert.equal(configured.status, 200);

    const blocked = await call(srv.base, '/admin/api/publish', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: { deploy: true }
    });
    assert.equal(blocked.status, 202);
    const failed = await waitJob(srv.base, auth, blocked.json.job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.conflictCode, 'DEPLOY_EXTRA_FILES');
    assert.equal(failed.branch, 'main');
    assert.deepEqual(failed.conflictFiles, extraFiles);

    const confirmed = await call(srv.base, '/admin/api/publish', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: { deploy: true, allowDelete: true }
    });
    assert.equal(confirmed.status, 202);
    const ok = await waitJob(srv.base, auth, confirmed.json.job.id);
    assert.equal(ok.status, 'success');
    assert.deepEqual(seen.map(function (item) { return item.allowDelete; }), [false, true]);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('未配置管理员时只给配置说明，不暴露登录接口', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir, { ADMIN_USER: '', ADMIN_PASSWORD: '' });
  try {
    const session = await call(srv.base, '/admin/api/session');
    assert.equal(session.json.configured, false);
    assert.deepEqual(session.json.missing.sort(), ['ADMIN_PASSWORD', 'ADMIN_USER'].sort());
    const loginTry = await call(srv.base, '/admin/api/login', {
      method: 'POST', body: { username: 'a', password: 'b' }
    });
    assert.equal(loginTry.status, 503);
    const page = await fetch(srv.base + '/admin/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') || '', /default-src 'self'/);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('预览：走站点注入的 Markdown 渲染器，且必须登录', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir, null, {
    runMarkdown: function (text) { return Promise.resolve('<p class="md">' + text + '</p>'); }
  });
  try {
    const denied = await call(srv.base, '/admin/api/preview', {
      method: 'POST', body: { body: '# 标题' }
    });
    assert.equal(denied.status, 401);

    const auth = await login(srv.base);
    const ok = await call(srv.base, '/admin/api/preview', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: { body: '# 标题' }
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.html, '<p class="md"># 标题</p>');

    const noCsrf = await call(srv.base, '/admin/api/preview', {
      method: 'POST', cookie: auth.cookie, body: { body: 'x' }
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('预览页允许同源嵌入，后台主页仍然禁止被嵌入', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const preview = await fetch(srv.base + '/admin/preview');
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(preview.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
    assert.match(await preview.text(), /\/admin\/preview\.js/);

    const page = await fetch(srv.base + '/admin/');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('草稿：published: false 写入与改回，并且列表能区分状态', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const auth = await login(srv.base);
    const created = await call(srv.base, '/admin/api/posts', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: { title: '草稿一篇', date: '2026-02-02 09:00:00', body: '内容', published: false }
    });
    assert.equal(created.status, 201);
    const file = path.join(dir, 'source', '_posts', created.json.name);
    assert.match(fs.readFileSync(file, 'utf8'), /published: false/);

    let list = await call(srv.base, '/admin/api/posts', { cookie: auth.cookie });
    let draft = list.json.posts.find(function (post) { return post.name === created.json.name; });
    assert.equal(draft.published, false);

    const updated = await call(srv.base, '/admin/api/posts/' + encodeURIComponent(created.json.name), {
      method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
      body: { title: '草稿一篇', date: '2026-02-02 09:00:00', body: '内容', published: true }
    });
    assert.equal(updated.status, 200);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /published:/);

    list = await call(srv.base, '/admin/api/posts', { cookie: auth.cookie });
    draft = list.json.posts.find(function (post) { return post.name === created.json.name; });
    assert.equal(draft.published, true);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('部署配置：缺 Token / 地址不合法 / 未启用 给出不同原因', function () {
  const dir = makeFixture();
  const file = path.join(dir, deploy.CONFIG_FILE);

  fs.writeFileSync(file, JSON.stringify({ repo: 'https://github.com/a/b.git', branch: 'main', enabled: true }));
  let config = deploy.loadDeployConfig(dir, {});
  assert.equal(config.mode, 'https');
  assert.equal(config.ready, false);
  assert.match(config.reason, /Personal Access Token/);

  fs.writeFileSync(file, JSON.stringify({ repo: 'ftp://nope/x', branch: 'main', enabled: true }));
  config = deploy.loadDeployConfig(dir, {});
  assert.equal(config.ready, false);
  assert.match(config.reason, /地址不合法/);

  fs.writeFileSync(file, JSON.stringify({ repo: 'git@github.com:a/b.git', branch: 'main', enabled: false }));
  config = deploy.loadDeployConfig(dir, {});
  assert.equal(config.ready, false);
  assert.match(config.reason, /推送未启用/);

  cleanup(dir);
});

test('部署：HTTPS 保存会带上 Token，留空保留、空字符串清除', function () {
  const dir = makeFixture();
  deploy.saveDeployConfig(dir, {
    repo: 'https://github.com/a/b.git', branch: 'main', enabled: true, token: 'ghp_abc123'
  }, {});
  let config = deploy.loadDeployConfig(dir, {});
  assert.equal(config.ready, true);
  assert.equal(config.hasToken, true);
  assert.equal(config.token, 'ghp_abc123');

  deploy.saveDeployConfig(dir, { enabled: false }, {});
  assert.equal(deploy.loadDeployConfig(dir, {}).token, 'ghp_abc123');

  // HTTPS 下清空 Token 会被拒绝（那样必然推不上去）
  assert.throws(function () {
    deploy.saveDeployConfig(dir, { token: '' }, {});
  }, /Personal Access Token/);

  // 换成 SSH 地址后再传空串即可清除
  deploy.saveDeployConfig(dir, { repo: 'git@github.com:a/b.git', token: '' }, {});
  assert.equal(deploy.loadDeployConfig(dir, {}).hasToken, false);

  cleanup(dir);
});

test('部署：git 错误能分类成可照做的中文提示', function () {
  assert.match(deploy.classifyGitFailure('git@github.com: Permission denied (publickey).', 'git@github.com:a/b.git'), /SSH|私钥/);
  assert.match(deploy.classifyGitFailure('fatal: Authentication failed for x', 'https://github.com/a/b.git'), /Token/);
  assert.match(deploy.classifyGitFailure('ssh: Could not resolve host: github.com', 'git@github.com:a/b.git'), /域名解析/);
  assert.match(deploy.classifyGitFailure('remote: Repository not found.', 'git@github.com:a/b.git'), /仓库不存在/);
});

test('部署：没有配置时抛准确原因，而不是笼统的“推送未配置”', async function () {
  const dir = makeFixture();
  await assert.rejects(
    deploy.deployWithGit(dir, {}, function () {}),
    /还没有填写部署仓库地址/
  );
  cleanup(dir);
});

test('接口：GET /deploy 不会把 Token 回传给浏览器', async function () {
  const dir = makeFixture();
  fs.writeFileSync(path.join(dir, deploy.CONFIG_FILE), JSON.stringify({
    repo: 'https://github.com/a/b.git', branch: 'main', enabled: true, token: 'ghp_secret'
  }));
  const srv = await startServer(dir);
  try {
    const auth = await login(srv.base);
    const res = await call(srv.base, '/admin/api/deploy', { cookie: auth.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.deploy.hasToken, true);
    assert.equal(res.json.deploy.token, undefined);
    assert.doesNotMatch(JSON.stringify(res.json), /ghp_secret/);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

/* ------------------------------------------------------------ 修改留痕 */

const REV_POST = '2026-01-01-hello.md';

async function postRevisions(base, auth, extra) {
  return call(base, '/admin/api/revisions' + (extra || ''), { cookie: auth.cookie });
}

test('留痕：连续保存两次两条记录，同内容被去重', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const auth = await login(srv.base);
    const url = '/admin/api/posts/' + encodeURIComponent(REV_POST);
    const baseBody = { title: '第一篇', date: '2026-01-01 10:00:00', body: '第一版正文' };

    await call(srv.base, url, { method: 'PUT', cookie: auth.cookie, csrf: auth.csrf, body: baseBody });
    let list = await postRevisions(srv.base, auth, '?path=' + encodeURIComponent(REV_POST));
    assert.equal(list.status, 200);
    assert.equal(list.json.items.length, 1);
    assert.equal(list.json.items[0].action, 'update');
    assert.equal(list.json.items[0].target, '第一篇');
    assert.ok(list.json.items[0].stats.added >= 1);

    // 同一份内容再保存：sha256 与上一条相同，不重复记
    await call(srv.base, url, { method: 'PUT', cookie: auth.cookie, csrf: auth.csrf, body: baseBody });
    list = await postRevisions(srv.base, auth, '?path=' + encodeURIComponent(REV_POST));
    assert.equal(list.json.items.length, 1);

    // 改正文：新增第二条，时间倒序
    await call(srv.base, url, {
      method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
      body: Object.assign({}, baseBody, { body: '第一版正文\n第二行' })
    });
    list = await postRevisions(srv.base, auth, '?path=' + encodeURIComponent(REV_POST));
    assert.equal(list.json.items.length, 2);
    assert.equal(list.json.items[0].stats.added, 1);
    assert.ok(Date.parse(list.json.items[0].at) >= Date.parse(list.json.items[1].at));
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('回退：写入旧版内容并新增 restore 记录，还能再退回来', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const auth = await login(srv.base);
    const url = '/admin/api/posts/' + encodeURIComponent(REV_POST);
    const file = path.join(dir, 'source', '_posts', REV_POST);
    const baseBody = { title: '第一篇', date: '2026-01-01 10:00:00' };

    await call(srv.base, url, {
      method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
      body: Object.assign({}, baseBody, { body: '版本一' })
    });
    const textV1 = fs.readFileSync(file, 'utf8');
    await call(srv.base, url, {
      method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
      body: Object.assign({}, baseBody, { body: '版本二' })
    });
    const textV2 = fs.readFileSync(file, 'utf8');

    const list = await postRevisions(srv.base, auth, '?path=' + encodeURIComponent(REV_POST));
    assert.equal(list.json.items.length, 2);
    const v2 = list.json.items[0];
    const v1 = list.json.items[1];

    // 新旧文本 + 行级 diff
    const detail = await call(srv.base, '/admin/api/revisions/' + v2.id, { cookie: auth.cookie });
    assert.equal(detail.status, 200);
    assert.match(detail.json.files[0].oldText, /版本一/);
    assert.match(detail.json.files[0].newText, /版本二/);
    const diff = detail.json.files[0].diff;
    assert.ok(diff.some(function (line) { return line.type === 'add' && /版本二/.test(line.text); }));
    assert.ok(diff.some(function (line) { return line.type === 'del' && /版本一/.test(line.text); }));

    // 回退到 v1
    const restored = await call(srv.base, '/admin/api/revisions/' + v1.id + '/restore', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf
    });
    assert.equal(restored.status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), textV1);

    const afterRestore = await postRevisions(srv.base, auth, '?path=' + encodeURIComponent(REV_POST));
    assert.equal(afterRestore.json.items[0].action, 'restore');
    assert.equal(afterRestore.json.items[0].restoreOf, v1.id);

    // 再回退到回退前的那一版
    const back = await call(srv.base, '/admin/api/revisions/' + v2.id + '/restore', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf
    });
    assert.equal(back.status, 200);
    assert.equal(fs.readFileSync(file, 'utf8'), textV2);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('删除可恢复：delete 记录保存快照，回退即重建文件', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const auth = await login(srv.base);
    const url = '/admin/api/posts/' + encodeURIComponent(REV_POST);
    const file = path.join(dir, 'source', '_posts', REV_POST);
    const original = fs.readFileSync(file, 'utf8');

    const removed = await call(srv.base, url, { method: 'DELETE', cookie: auth.cookie, csrf: auth.csrf });
    assert.equal(removed.status, 200);
    assert.equal(fs.existsSync(file), false);

    let list = await postRevisions(srv.base, auth, '?path=' + encodeURIComponent(REV_POST));
    assert.equal(list.json.items[0].action, 'delete');
    const id = list.json.items[0].id;
    const detail = await call(srv.base, '/admin/api/revisions/' + id, { cookie: auth.cookie });
    assert.ok(detail.json.files[0].diff.some(function (line) { return line.type === 'del'; }));

    const restored = await call(srv.base, '/admin/api/revisions/' + id + '/restore', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf
    });
    assert.equal(restored.status, 200);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.readFileSync(file, 'utf8'), original);

    list = await postRevisions(srv.base, auth, '?path=' + encodeURIComponent(REV_POST));
    assert.equal(list.json.items[0].action, 'restore');
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('留痕：配置保存记录字段的旧值/新值', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const auth = await login(srv.base);
    const saved = await call(srv.base, '/admin/api/config', {
      method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
      body: { values: { title: '新标题' } }
    });
    assert.equal(saved.status, 200);

    const list = await postRevisions(srv.base, auth, '?action=config');
    assert.equal(list.json.items.length, 1);
    const item = list.json.items[0];
    assert.equal(item.path, '_config.yml');
    assert.equal(item.stats.fields.length, 1);
    assert.equal(item.stats.fields[0].key, 'title');
    assert.equal(item.stats.fields[0].old, 'Demo');
    assert.equal(item.stats.fields[0].new, '新标题');
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('回退：非法路径被拒绝，不会写出到目录之外', function () {
  const dir = makeFixture();
  try {
    const sha = core.hashText('evil');
    const revDir = path.join(dir, 'bak', 'admin', 'revisions');
    fs.mkdirSync(path.join(revDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(revDir, 'files', sha + '.md'), 'evil');
    fs.writeFileSync(path.join(revDir, 'index.json'), JSON.stringify({
      version: 1,
      items: [{
        id: '20260101000000-abcdef',
        at: new Date().toISOString(),
        action: 'update',
        target: 'evil',
        path: '../evil.md',
        bytes: 4,
        sha256: sha,
        stats: { added: 1, removed: 0, fields: [] },
        restoreOf: '',
        files: [{ path: '../evil.md', sha256: sha, bytes: 4 }]
      }]
    }));

    assert.throws(function () { core.restoreRevision(dir, '20260101000000-abcdef'); });
    assert.equal(fs.existsSync(path.join(dir, '..', 'evil.md')), false);
  } finally {
    cleanup(dir);
  }
});

test('回退：缺少 CSRF 被拒绝', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const auth = await login(srv.base);
    const denied = await call(srv.base, '/admin/api/revisions/whatever/restore', {
      method: 'POST', cookie: auth.cookie
    });
    assert.equal(denied.status, 403);

    const anonymous = await call(srv.base, '/admin/api/revisions', {});
    assert.equal(anonymous.status, 401);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('留痕：同一路径超过 200 条会被裁剪并留下 purged 占位', function () {
  const dir = makeFixture();
  try {
    for (let i = 0; i < 205; i++) {
      core.appendRevision(dir, {
        action: 'update',
        target: '第一篇',
        files: [{ path: REV_POST, before: '旧内容 ' + i, after: '新内容 ' + i }]
      });
    }
    const index = JSON.parse(fs.readFileSync(path.join(core.revisionsDir(dir), 'index.json'), 'utf8'));
    const real = index.items.filter(function (item) { return !item.purged; });
    assert.equal(real.length, 200);
    assert.ok(index.items.some(function (item) { return item.purged === true; }));

    const list = core.listRevisions(dir, { path: REV_POST, limit: 5 });
    assert.equal(list.items.length, 5);
    assert.ok(list.total > 200);
  } finally {
    cleanup(dir);
  }
});

/* ---------------------------------------------------------------- 源码 */

function gitExec(cwd, args) {
  return String(execFileSync('git', args, { cwd: cwd, encoding: 'utf8', stdio: 'pipe' })).trim();
}

/** 一个工作仓库 + 一个本地裸仓库，模拟“本地提交、推送到 source”。 */
function makeSourcePair() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fomalhaut-src-'));
  const work = path.join(root, 'work');
  const bare = path.join(root, 'remote.git');
  fs.mkdirSync(work, { recursive: true });
  gitExec(root, ['init', '-q', '--bare', bare]);
  gitExec(work, ['init', '-q']);
  gitExec(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  gitExec(work, ['config', 'user.name', 'tester']);
  gitExec(work, ['config', 'user.email', 'tester@local']);
  gitExec(work, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(work, 'README.md'), '# demo\n', 'utf8');
  fs.writeFileSync(path.join(work, 'old.md'), 'old\n', 'utf8');
  gitExec(work, ['add', '--', 'README.md', 'old.md']);
  gitExec(work, ['commit', '-q', '-m', 'init']);
  return { root: root, work: work, bare: bare };
}

async function sourceServer(pair) {
  return startServer(pair.work, null, {
    sourceOptions: { repo: pair.bare, branch: 'source' }
  });
}

test('源码：没有改动时不产生空提交', async function () {
  const pair = makeSourcePair();
  const srv = await sourceServer(pair);
  try {
    const auth = await login(srv.base);
    const before = gitExec(pair.work, ['rev-list', '--count', 'HEAD']);
    const res = await call(srv.base, '/admin/api/source/commit', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: { message: '没有改动也要提交' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'SOURCE_EMPTY');
    assert.equal(gitExec(pair.work, ['rev-list', '--count', 'HEAD']), before);
  } finally {
    await srv.close();
    cleanup(pair.root);
  }
});

test('源码：显式 add 全部改动、排除私有文件并推送', async function () {
  const pair = makeSourcePair();
  const srv = await sourceServer(pair);
  try {
    const auth = await login(srv.base);
    fs.writeFileSync(path.join(pair.work, 'README.md'), '# demo changed\n', 'utf8');
    fs.writeFileSync(path.join(pair.work, 'new.txt'), 'new\n', 'utf8');
    fs.unlinkSync(path.join(pair.work, 'old.md'));
    fs.writeFileSync(path.join(pair.work, '.admin-auth'), 'ADMIN_PASSWORD=secret\n', 'utf8');
    fs.mkdirSync(path.join(pair.work, 'bak'), { recursive: true });
    fs.writeFileSync(path.join(pair.work, 'bak', 'private.md'), 'secret\n', 'utf8');
    fs.mkdirSync(path.join(pair.work, 'public'), { recursive: true });
    fs.writeFileSync(path.join(pair.work, 'public', 'index.html'), '<html></html>\n', 'utf8');

    const list = await call(srv.base, '/admin/api/source', { cookie: auth.cookie });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.changes.map(function (row) { return row.path; }),
      ['README.md', 'new.txt', 'old.md']);
    assert.deepEqual(list.json.changes.map(function (row) { return row.status; }),
      ['M', 'A', 'D']);

    const res = await call(srv.base, '/admin/api/source/commit', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: { message: '调整首页与清理示例' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.pushed, true);
    assert.equal(res.json.commit.length, 7);
    assert.equal(res.json.files.length, 3);

    const head = gitExec(pair.work, ['rev-parse', 'HEAD']);
    assert.equal(gitExec(pair.bare, ['rev-parse', 'refs/heads/source']), head);

    const tree = gitExec(pair.work, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n');
    assert.ok(tree.indexOf('README.md') >= 0);
    assert.ok(tree.indexOf('new.txt') >= 0);
    assert.equal(tree.indexOf('old.md'), -1);
    assert.ok(tree.every(function (name) { return !/\.admin-auth|^bak\/|^public\//.test(name); }));
    assert.ok(fs.existsSync(path.join(pair.work, '.admin-auth')));

    // 私有文件仍留在工作区，只是没有被带进提交。
    const status = gitExec(pair.work, ['status', '--porcelain']).split('\n').filter(Boolean).sort();
    assert.deepEqual(status, ['?? .admin-auth', '?? bak/', '?? public/']);
  } finally {
    await srv.close();
    cleanup(pair.root);
  }
});

test('源码：缺 CSRF 被拒，且不会产生提交', async function () {
  const pair = makeSourcePair();
  const srv = await sourceServer(pair);
  try {
    const auth = await login(srv.base);
    fs.writeFileSync(path.join(pair.work, 'new.txt'), 'new\n', 'utf8');
    const before = gitExec(pair.work, ['rev-list', '--count', 'HEAD']);
    const res = await call(srv.base, '/admin/api/source/commit', {
      method: 'POST', cookie: auth.cookie, body: { message: '绕过 CSRF' }
    });
    assert.equal(res.status, 403);
    assert.equal(gitExec(pair.work, ['rev-list', '--count', 'HEAD']), before);
  } finally {
    await srv.close();
    cleanup(pair.root);
  }
});

test('源码：推送失败时明确返回已提交未推送', async function () {
  const pair = makeSourcePair();
  const srv = await startServer(pair.work, null, {
    sourceOptions: { repo: path.join(pair.root, 'missing', 'remote.git'), branch: 'source' }
  });
  try {
    const auth = await login(srv.base);
    fs.writeFileSync(path.join(pair.work, 'new.txt'), 'new\n', 'utf8');
    const before = Number(gitExec(pair.work, ['rev-list', '--count', 'HEAD']));
    const res = await call(srv.base, '/admin/api/source/commit', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: { message: '推不上去也要保留本地提交' }
    });
    assert.equal(res.status, 502);
    assert.equal(res.json.committed, true);
    assert.equal(res.json.pushed, false);
    assert.match(res.json.error.message, /已提交到本地/);
    assert.equal(Number(gitExec(pair.work, ['rev-list', '--count', 'HEAD'])), before + 1);
  } finally {
    await srv.close();
    cleanup(pair.root);
  }
});

test('源码：历史可分页一直往前翻，空仓库不报错', async function () {
  const pair = makeSourcePair();
  const srv = await sourceServer(pair);
  try {
    const auth = await login(srv.base);
    for (let i = 1; i <= 24; i++) {
      fs.writeFileSync(path.join(pair.work, 'note-' + i + '.txt'), 'n' + i + '\n', 'utf8');
      gitExec(pair.work, ['add', '--', 'note-' + i + '.txt']);
      gitExec(pair.work, ['commit', '-q', '-m', '第 ' + i + ' 次更新']);
    }

    const first = await call(srv.base, '/admin/api/source?limit=10&offset=0', { cookie: auth.cookie });
    assert.equal(first.status, 200);
    assert.equal(first.json.commits.length, 10);
    assert.equal(first.json.hasMore, true);
    assert.equal(first.json.commits[0].subject, '第 24 次更新');
    assert.ok(first.json.commits[0].relative);
    assert.ok(first.json.commits[0].date);

    const second = await call(srv.base, '/admin/api/source?limit=10&offset=10&changes=0', { cookie: auth.cookie });
    assert.equal(second.json.commits.length, 10);
    assert.equal(second.json.hasMore, true);
    assert.equal(second.json.commits[0].subject, '第 14 次更新');

    const third = await call(srv.base, '/admin/api/source?limit=10&offset=20&changes=0', { cookie: auth.cookie });
    assert.equal(third.json.commits.length, 5);
    assert.equal(third.json.hasMore, false);
    assert.equal(third.json.commits[4].subject, 'init');

    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fomalhaut-empty-'));
    gitExec(emptyDir, ['init', '-q']);
    const emptySrv = await sourceServer({ work: emptyDir, bare: pair.bare });
    try {
      const emptyAuth = await login(emptySrv.base);
      const empty = await call(emptySrv.base, '/admin/api/source', { cookie: emptyAuth.cookie });
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.json.commits, []);
      assert.equal(empty.json.hasMore, false);
    } finally {
      await emptySrv.close();
      cleanup(emptyDir);
    }
  } finally {
    await srv.close();
    cleanup(pair.root);
  }
});

/* ---------------------------------------------------------- 源码恢复 */

/** 把工作仓库当前 HEAD 推到本地裸仓库的 source 分支，充当“GitHub 上的源码”。 */
function seedSource(pair) {
  gitExec(pair.work, ['push', pair.bare, 'HEAD:refs/heads/source']);
  return gitExec(pair.work, ['rev-parse', 'HEAD']);
}

async function restoreServer(pair, extra) {
  return startServer(pair.work, null, Object.assign({
    sourceOptions: { repo: pair.bare, branch: 'source' },
    runGenerate: function () { return Promise.resolve(); }
  }, extra || {}));
}

test('源码恢复：先备份、覆盖已跟踪文件、保留未跟踪文件', async function () {
  const pair = makeSourcePair();
  const remoteSha = seedSource(pair);
  const srv = await restoreServer(pair);
  try {
    const auth = await login(srv.base);
    fs.writeFileSync(path.join(pair.work, 'README.md'), '# broken local\n', 'utf8');
    fs.writeFileSync(path.join(pair.work, 'old.md'), 'broken old\n', 'utf8');
    fs.writeFileSync(path.join(pair.work, 'notes.txt'), 'keep me\n', 'utf8');

    const res = await call(srv.base, '/admin/api/source/restore', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: {}
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.restored, true);
    assert.equal(res.json.toSha, remoteSha);
    assert.equal(res.json.shortTo, remoteSha.slice(0, 7));
    assert.ok(res.json.backup.path.indexOf('bak/admin/restore/') === 0);

    assert.ok(fs.existsSync(path.join(pair.work, res.json.backup.path, 'manifest.json')));
    assert.equal(
      fs.readFileSync(path.join(pair.work, res.json.backup.path, 'files', 'README.md'), 'utf8'),
      '# broken local\n');
    assert.ok(res.json.retained.indexOf('notes.txt') >= 0);

    // Windows 上 core.autocrlf 可能把检出内容换成 CRLF，比较前统一换行符。
    assert.equal(fs.readFileSync(path.join(pair.work, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), '# demo\n');
    assert.equal(fs.existsSync(path.join(pair.work, 'notes.txt')), true);
    assert.equal(gitExec(pair.work, ['rev-parse', 'HEAD']), remoteSha);
    assert.match(gitExec(pair.work, ['status', '--porcelain']), /notes\.txt/);
  } finally {
    await srv.close();
    cleanup(pair.root);
  }
});

test('源码恢复：备份失败则中止，不覆盖本地', async function () {
  const pair = makeSourcePair();
  seedSource(pair);
  const srv = await restoreServer(pair);
  try {
    const auth = await login(srv.base);
    fs.writeFileSync(path.join(pair.work, 'README.md'), '# broken local\n', 'utf8');
    // 让 bak/admin/restore 无法创建：把 bak 变成一个普通文件。
    fs.writeFileSync(path.join(pair.work, 'bak'), 'not a directory\n', 'utf8');

    const before = gitExec(pair.work, ['rev-parse', 'HEAD']);
    const res = await call(srv.base, '/admin/api/source/restore', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: {}
    });
    assert.equal(res.status, 500);
    assert.equal(res.json.error.code, 'SOURCE_BACKUP_FAILED');
    assert.equal(gitExec(pair.work, ['rev-parse', 'HEAD']), before);
    assert.equal(fs.readFileSync(path.join(pair.work, 'README.md'), 'utf8'), '# broken local\n');
  } finally {
    await srv.close();
    cleanup(pair.root);
  }
});

test('源码恢复：缺 CSRF 被拒且不产生备份', async function () {
  const pair = makeSourcePair();
  seedSource(pair);
  const srv = await restoreServer(pair);
  try {
    const auth = await login(srv.base);
    fs.writeFileSync(path.join(pair.work, 'README.md'), '# broken local\n', 'utf8');
    const before = gitExec(pair.work, ['rev-parse', 'HEAD']);
    const res = await call(srv.base, '/admin/api/source/restore', {
      method: 'POST', cookie: auth.cookie, body: {}
    });
    assert.equal(res.status, 403);
    assert.equal(gitExec(pair.work, ['rev-parse', 'HEAD']), before);
    assert.equal(fs.existsSync(path.join(pair.work, 'bak', 'admin', 'restore')), false);
  } finally {
    await srv.close();
    cleanup(pair.root);
  }
});

test('源码恢复：hexo generate 失败不影响后台，错误原样返回', async function () {
  const pair = makeSourcePair();
  seedSource(pair);
  const srv = await startServer(pair.work, null, {
    sourceOptions: { repo: pair.bare, branch: 'source' },
    runGenerate: function () { return Promise.reject(new Error('模板编译失败：test only')); }
  });
  try {
    const auth = await login(srv.base);
    fs.writeFileSync(path.join(pair.work, 'README.md'), '# broken local\n', 'utf8');
    const res = await call(srv.base, '/admin/api/source/restore', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: {}
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.restored, true);
    assert.equal(res.json.generate.ok, false);
    assert.match(res.json.generate.error, /模板编译失败/);

    // 后台仍然可用：恢复之后还能正常读取源码状态。
    const after = await call(srv.base, '/admin/api/source', { cookie: auth.cookie });
    assert.equal(after.status, 200);
  } finally {
    await srv.close();
    cleanup(pair.root);
  }
});

test('独立入口：不依赖 hexo 即可启动并提供后台页面', async function () {
  const pair = makeSourcePair();
  const createStandalone = require('../admin/standalone.js');
  const server = createStandalone({
    baseDir: pair.work,
    env: { ADMIN_USER: 'admin', ADMIN_PASSWORD: 'secret' },
    runGenerate: function () { return Promise.resolve(); }
  });
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const page = await fetch(base + '/admin/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);

    const session = await (await fetch(base + '/admin/api/session')).json();
    assert.equal(session.configured, true);
    assert.equal(session.authenticated, false);

    const root = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/admin/');
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
    cleanup(pair.root);
  }
});


/* ------------------------------------------------------------ 打包与 SSH */

function writeFixtureFile(root, rel, content) {
  const file = path.join(root, rel.replace(/\//g, path.sep));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function makePackageFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fomalhaut-pkg-'));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  writeFixtureFile(project, '_config.yml', 'title: demo\n');
  writeFixtureFile(project, 'package.json', '{"name":"demo"}\n');
  writeFixtureFile(project, 'source/_posts/hello.md', '# hello\n');
  writeFixtureFile(project, 'source/中文/说明.md', '中文文件名\n');
  writeFixtureFile(project, '.admin-auth', 'ADMIN_PASSWORD=SECRET-SENTINEL\n');
  writeFixtureFile(project, '.admin-deploy.json', '{"token":"TOKEN-SENTINEL"}\n');
  writeFixtureFile(project, '.admin-oss.json',
    '{"accessKeyId":"OSS-AK","accessKeySecret":"OSS-SECRET-SENTINEL","bucket":"demo","region":"oss-cn-hangzhou"}\n');
  writeFixtureFile(project, '.admin-oss.json.tmp-123', 'OSS-TMP-SENTINEL\n');
  writeFixtureFile(project, 'bak/admin/restore/secret.md', 'BACKUP-SENTINEL\n');
  writeFixtureFile(project, '.deploy_git/config', 'deploy\n');
  writeFixtureFile(project, 'node_modules/demo/index.js', 'module.exports = 1;\n');
  writeFixtureFile(project, 'public/index.html', '<html></html>\n');
  writeFixtureFile(project, 'backup/package/old.zip', 'old-package\n');
  writeFixtureFile(project, '.git/config', '[core]\n');
  writeFixtureFile(project, '.git/HEAD', 'ref: refs/heads/main\n');
  writeFixtureFile(project, '.git/index.lock', 'lock\n');
  writeFixtureFile(project, '.ssh/id_ed25519', 'PROJECT-SSH-SENTINEL\n');
  writeFixtureFile(home, '.ssh/id_ed25519', 'HOME-SSH-PRIVATE-SENTINEL\n');
  writeFixtureFile(home, '.ssh/id_ed25519.pub',
    'ssh-ed25519 ' + Buffer.from('home-key-blob').toString('base64') + ' home@test\n');
  return { root: root, project: project, home: home };
}

test('打包：轻量包排除凭据/依赖/产物/SSH，包含迁移说明与中文文件名', async function () {
  const fx = makePackageFixture();
  const srv = await startServer(fx.project, null, {
    packageOptions: { home: fx.home, compressor: 'node' }
  });
  try {
    const auth = await login(srv.base);
    const info = await call(srv.base, '/admin/api/package', { cookie: auth.cookie });
    assert.equal(info.status, 200);
    assert.equal(info.json.modes.length, 2);
    assert.deepEqual(info.json.modes.map(function (m) { return m.id; }), ['full', 'light']);
    assert.equal(info.json.last, null);
    assert.equal(info.json.output, 'backup/package/');

    const res = await call(srv.base, '/admin/api/package', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: { mode: 'light' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.mode, 'light');
    assert.equal(res.json.method, 'node');
    assert.match(res.json.name, /^wenroumao-blog-\d{8}-\d{4}(-\d+)?\.zip$/);
    assert.ok(res.json.size > 0);
    assert.match(res.json.file, /^backup\/package\//);
    assert.ok(!JSON.stringify(res.json).includes('SENTINEL'));
    assert.ok(!JSON.stringify(res.json).includes('OSS-SECRET'));

    const zipFile = path.join(fx.project, res.json.file.replace(/\//g, path.sep));
    assert.ok(fs.existsSync(zipFile));
    const entries = packager.listEntries(zipFile);
    assert.ok(entries.indexOf('MIGRATE.md') >= 0);
    assert.ok(entries.indexOf('.env.example') >= 0);
    assert.ok(entries.indexOf('_config.yml') >= 0);
    assert.ok(entries.indexOf('source/中文/说明.md') >= 0);

    [
      '.admin-auth', '.admin-deploy.json', '.admin-oss.json', '.admin-oss.json.tmp-123',
      '.deploy_git/config', 'node_modules/demo/index.js', 'public/index.html', 'backup/package/old.zip',
      '.git/config', '.git/index.lock', '.ssh/id_ed25519', 'bak/admin/restore/secret.md'
    ].forEach(function (name) {
      assert.equal(entries.indexOf(name), -1, '不应包含 ' + name);
    });
    assert.ok(entries.every(function (name) {
      return !/^(bak|backup|node_modules|public|\.git|\.deploy_git|\.ssh)\//.test(name);
    }));

    const migrate = packager.migrateMarkdown('light', '2026-11-08T00:00:00.000Z');
    assert.match(migrate, /npm install/);
    assert.match(migrate, /start-admin\.cmd/);
    assert.match(migrate, /\.admin-auth/);
    assert.match(migrate, /ssh-keygen/);
    assert.match(migrate, /github\.com\/settings\/keys/);
    assert.match(migrate, /vercel\.json/);
    assert.ok(!/SECRET-SENTINEL|TOKEN-SENTINEL|PRIVATE/.test(migrate));

    const env = packager.envExample();
    ['ADMIN_USER=', 'ADMIN_PASSWORD=', 'ADMIN_DEPLOY_TOKEN='].forEach(function (name) {
      assert.ok(env.indexOf(name) >= 0, '缺少变量名 ' + name);
    });
    assert.ok(!/SECRET-SENTINEL|TOKEN-SENTINEL/.test(env));

    const after = await call(srv.base, '/admin/api/package', { cookie: auth.cookie });
    assert.equal(after.json.last && after.json.last.name, res.json.name);
  } finally {
    await srv.close();
    cleanup(fx.root);
  }
});

test('打包：完整模式保留 .git 与 public，仍排除凭据与 index.lock', async function () {
  const fx = makePackageFixture();
  const srv = await startServer(fx.project, null, {
    packageOptions: { home: fx.home, compressor: 'node' }
  });
  try {
    const auth = await login(srv.base);
    const res = await call(srv.base, '/admin/api/package', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: { mode: 'full' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, 'full');
    const zipFile = path.join(fx.project, res.json.file.replace(/\//g, path.sep));
    const entries = packager.listEntries(zipFile);
    assert.ok(entries.indexOf('.git/config') >= 0);
    assert.ok(entries.indexOf('public/index.html') >= 0);
    assert.equal(entries.indexOf('.git/index.lock'), -1);
    assert.equal(entries.indexOf('.admin-auth'), -1);
    assert.equal(entries.indexOf('.admin-deploy.json'), -1);
    assert.equal(entries.indexOf('.admin-oss.json'), -1);
    assert.equal(entries.indexOf('.admin-oss.json.tmp-123'), -1);
    assert.equal(entries.indexOf('node_modules/demo/index.js'), -1);
    assert.equal(entries.indexOf('bak/admin/restore/secret.md'), -1);
    assert.equal(entries.indexOf('.ssh/id_ed25519'), -1);
    assert.ok(entries.every(function (name) { return !name.startsWith('backup/'); }));
  } finally {
    await srv.close();
    cleanup(fx.root);
  }
});

test('打包：缺 CSRF 被拒，且不会生成新包', async function () {
  const fx = makePackageFixture();
  const srv = await startServer(fx.project, null, {
    packageOptions: { home: fx.home, compressor: 'node' }
  });
  try {
    const auth = await login(srv.base);
    const res = await call(srv.base, '/admin/api/package', {
      method: 'POST', cookie: auth.cookie, body: { mode: 'light' }
    });
    assert.equal(res.status, 403);
    const dir = path.join(fx.project, 'backup', 'package');
    assert.equal(fs.existsSync(dir) && fs.readdirSync(dir).filter(function (n) {
      return /^wenroumao-blog-/.test(n);
    }).length, 0);
  } finally {
    await srv.close();
    cleanup(fx.root);
  }
});

test('打包：不支持的模式返回 400', async function () {
  const fx = makePackageFixture();
  const srv = await startServer(fx.project, null, {
    packageOptions: { home: fx.home, compressor: 'node' }
  });
  try {
    const auth = await login(srv.base);
    const res = await call(srv.base, '/admin/api/package', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: { mode: 'everything' }
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'PACKAGE_INVALID_MODE');
  } finally {
    await srv.close();
    cleanup(fx.root);
  }
});

function makeSshHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fomalhaut-ssh-'));
  return root;
}

test('SSH：只读接口只报存在性与公钥，不回传私钥', async function () {
  const home = makeSshHome();
  const privateText = 'PRIVATE-SENTINEL-KEY-MATERIAL\n';
  const publicText = 'ssh-ed25519 ' + Buffer.from('some-key-blob').toString('base64') + ' test@example\n';
  writeFixtureFile(home, '.ssh/id_ed25519', privateText);
  writeFixtureFile(home, '.ssh/id_ed25519.pub', publicText);
  const srv = await startServer(path.join(home, 'project'), null, { sshOptions: { home: home } });
  fs.mkdirSync(path.join(home, 'project'), { recursive: true });
  try {
    const auth = await login(srv.base);
    const res = await call(srv.base, '/admin/api/ssh', { cookie: auth.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.keys.ed25519.private, true);
    assert.equal(res.json.keys.ed25519.public, true);
    assert.equal(res.json.keys.rsa.private, false);
    assert.equal(res.json.publicKey, publicText.trim());
    assert.match(res.json.fingerprint, /^SHA256:/);
    assert.equal(res.json.testCommand, 'ssh -T git@github.com');
    assert.ok(!JSON.stringify(res.json).includes('PRIVATE-SENTINEL'));
    assert.ok(!JSON.stringify(res.json).includes('privateKey'));

    const raw = await fetch(srv.base + '/admin/api/ssh', { headers: { Cookie: auth.cookie } });
    assert.equal(raw.headers.get('cache-control'), 'no-store');
  } finally {
    await srv.close();
    cleanup(home);
  }
});

test('SSH：没有密钥时只报不存在，界面拿到空公钥', async function () {
  const home = makeSshHome();
  fs.mkdirSync(path.join(home, 'project'), { recursive: true });
  const srv = await startServer(path.join(home, 'project'), null, { sshOptions: { home: home } });
  try {
    const auth = await login(srv.base);
    const res = await call(srv.base, '/admin/api/ssh', { cookie: auth.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.active, '');
    assert.equal(res.json.publicKey, '');
    assert.equal(res.json.keys.ed25519.private, false);
    assert.equal(res.json.keys.rsa.public, false);
  } finally {
    await srv.close();
    cleanup(home);
  }
});

test('SSH keygen：目标已存在时拒绝覆盖，私钥内容保持不变', async function () {
  const home = makeSshHome();
  const privateText = 'PRIVATE-DO-NOT-OVERWRITE\n';
  writeFixtureFile(home, '.ssh/id_ed25519', privateText);
  writeFixtureFile(home, '.ssh/id_ed25519.pub',
    'ssh-ed25519 ' + Buffer.from('existing').toString('base64') + ' old@test\n');
  fs.mkdirSync(path.join(home, 'project'), { recursive: true });
  const srv = await startServer(path.join(home, 'project'), null, {
    sshOptions: { home: home, runKeygen: function () { throw new Error('不应该执行 ssh-keygen'); } }
  });
  try {
    const auth = await login(srv.base);
    const res = await call(srv.base, '/admin/api/ssh/keygen', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: {}
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'SSH_KEY_EXISTS');
    assert.equal(fs.readFileSync(path.join(home, '.ssh', 'id_ed25519'), 'utf8'), privateText);
    assert.ok(!JSON.stringify(res.json).includes('PRIVATE-DO-NOT-OVERWRITE'));
  } finally {
    await srv.close();
    cleanup(home);
  }
});

test('SSH keygen：成功时返回公钥，不返回私钥；缺 CSRF 被拒', async function () {
  const home = makeSshHome();
  fs.mkdirSync(path.join(home, 'project'), { recursive: true });
  let called = 0;
  const srv = await startServer(path.join(home, 'project'), null, {
    sshOptions: {
      home: home,
      runKeygen: function (task) {
        called += 1;
        fs.writeFileSync(task.publicFile,
          'ssh-ed25519 ' + Buffer.from('generated-key').toString('base64') + ' admin@local\n', 'utf8');
        return Promise.resolve();
      }
    }
  });
  try {
    const auth = await login(srv.base);
    const denied = await call(srv.base, '/admin/api/ssh/keygen', {
      method: 'POST', cookie: auth.cookie, body: {}
    });
    assert.equal(denied.status, 403);
    assert.equal(called, 0);

    const res = await call(srv.base, '/admin/api/ssh/keygen', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: {}
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.algorithm, 'ed25519');
    assert.equal(res.json.passphrase, false);
    assert.match(res.json.publicKey, /^ssh-ed25519 /);
    assert.match(res.json.fingerprint, /^SHA256:/);
    assert.equal(res.json.files.private, '~/.ssh/id_ed25519');
    assert.ok(!JSON.stringify(res.json).includes('PRIVATE'));
    assert.equal(called, 1);
  } finally {
    await srv.close();
    cleanup(home);
  }
});

test('SSH 测试：按原始输出分类，不只给退出码', function () {
  const ok = ssh.classify({
    code: 1,
    output: "Hi demo! You've successfully authenticated, but GitHub does not provide shell access.\n"
  });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.label, '认证成功');

  const noKey = ssh.classify({ code: 255, output: 'git@github.com: Permission denied (publickey).\r\n' });
  assert.equal(noKey.status, 'no-key');
  assert.equal(noKey.label, '公钥未添加');

  const offline = ssh.classify({
    code: 255,
    output: 'ssh: connect to host github.com port 22: Connection timed out\r\n'
  });
  assert.equal(offline.status, 'network');
  assert.equal(offline.label, '网络不通');

  const timeout = ssh.classify({ timedOut: true, output: '' });
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.label, '超时');

  const missing = ssh.classify({ errorCode: 'ENOENT', output: '' });
  assert.equal(missing.status, 'network');
});

test('SSH 测试：接口返回分类结果，缺 CSRF 被拒', async function () {
  const home = makeSshHome();
  fs.mkdirSync(path.join(home, 'project'), { recursive: true });
  const srv = await startServer(path.join(home, 'project'), null, {
    sshOptions: {
      home: home,
      runTest: function () {
        return Promise.resolve({
          code: 1,
          output: "Hi demo! You've successfully authenticated, but GitHub does not provide shell access.\n"
        });
      }
    }
  });
  try {
    const auth = await login(srv.base);
    const denied = await call(srv.base, '/admin/api/ssh/test', {
      method: 'POST', cookie: auth.cookie, body: {}
    });
    assert.equal(denied.status, 403);

    const res = await call(srv.base, '/admin/api/ssh/test', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf, body: {}
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
    assert.equal(res.json.ok, true);
    assert.equal(res.json.label, '认证成功');
    assert.equal(res.json.command, 'ssh -T git@github.com');
    assert.match(res.json.raw, /successfully authenticated/);
  } finally {
    await srv.close();
    cleanup(home);
  }
});

/* ------------------------------------------------------------ 图床（OSS） */

const OSS_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeOssDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fomalhaut-oss-'));
}

test('图床：配置写入后 GET 不回显 secret，留空保留原值', async function () {
  const dir = makeOssDir();
  const srv = await startServer(dir, null, { ossOptions: { env: {} } });
  try {
    const auth = await login(srv.base);
    const initial = await call(srv.base, '/admin/api/oss/config', { cookie: auth.cookie });
    assert.equal(initial.status, 200);
    assert.equal(initial.json.configured, false);
    assert.equal(initial.json.config.hasSecret, false);
    assert.match(initial.json.note, /AccessKeySecret/);

    // 未配置时上传给出明确错误，不是 500
    const denied = await call(srv.base, '/admin/api/oss/upload', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: { name: 'a.png', type: 'image/png', data: OSS_PNG_BASE64 }
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.error.code, 'OSS_NOT_CONFIGURED');
    assert.match(denied.json.error.message, /AccessKeyId/);

    const saved = await call(srv.base, '/admin/api/oss/config', {
      method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
      body: {
        accessKeyId: 'TEST-AK', accessKeySecret: 'TEST-SECRET-SENTINEL',
        bucket: 'demo-bucket', region: 'oss-cn-hangzhou',
        pathPrefix: 'blog/2026/11/', customDomain: 'https://img.example.com/'
      }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.configured, true);
    assert.equal(saved.json.config.hasSecret, true);
    assert.equal(saved.json.config.pathPrefix, 'blog/2026/11');
    assert.equal(saved.json.config.customDomain, 'https://img.example.com');
    assert.ok(!JSON.stringify(saved.json).includes('TEST-SECRET-SENTINEL'));

    const file = path.join(dir, '.admin-oss.json');
    assert.ok(fs.existsSync(file));
    assert.match(fs.readFileSync(file, 'utf8'), /TEST-SECRET-SENTINEL/);

    // secret 留空表示保留原值
    const kept = await call(srv.base, '/admin/api/oss/config', {
      method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
      body: { accessKeyId: 'TEST-AK-2', accessKeySecret: '', bucket: 'demo-bucket', region: 'oss-cn-hangzhou' }
    });
    assert.equal(kept.status, 200);
    assert.equal(kept.json.config.accessKeyId, 'TEST-AK-2');
    assert.equal(kept.json.config.hasSecret, true);
    assert.match(fs.readFileSync(file, 'utf8'), /TEST-SECRET-SENTINEL/);

    const reread = await call(srv.base, '/admin/api/oss/config', { cookie: auth.cookie });
    assert.equal(reread.status, 200);
    assert.equal(reread.json.config.hasSecret, true);
    assert.ok(!JSON.stringify(reread.json).includes('TEST-SECRET-SENTINEL'));

    // 缺 CSRF：写接口必须被拒
    const noCsrf = await call(srv.base, '/admin/api/oss/config', {
      method: 'PUT', cookie: auth.cookie,
      body: { accessKeyId: 'x', bucket: 'x', region: 'oss-cn-hangzhou' }
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('图床：环境变量覆盖本地配置，且仍然不回显 secret', async function () {
  const dir = makeOssDir();
  fs.writeFileSync(path.join(dir, '.admin-oss.json'), JSON.stringify({
    accessKeyId: 'FILE-AK',
    accessKeySecret: 'FILE-SECRET-SENTINEL',
    bucket: 'file-bucket',
    region: 'oss-cn-shanghai'
  }), 'utf8');
  const srv = await startServer(dir, null, {
    ossOptions: {
      env: {
        OSS_ACCESS_KEY_ID: 'ENV-AK',
        OSS_ACCESS_KEY_SECRET: 'ENV-SECRET-SENTINEL',
        OSS_BUCKET: 'env-bucket',
        OSS_REGION: 'cn-beijing'
      }
    }
  });
  try {
    const auth = await login(srv.base);
    const res = await call(srv.base, '/admin/api/oss/config', { cookie: auth.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.json.configured, true);
    assert.equal(res.json.config.accessKeyId, 'ENV-AK');
    assert.equal(res.json.config.bucket, 'env-bucket');
    assert.equal(res.json.config.region, 'oss-cn-beijing');
    assert.equal(res.json.config.hasSecret, true);
    assert.equal(res.json.overrides.accessKeyId, true);
    assert.equal(res.json.overrides.bucket, true);
    assert.equal(res.json.overrides.pathPrefix, false);
    assert.ok(!JSON.stringify(res.json).includes('ENV-SECRET-SENTINEL'));
    assert.ok(!JSON.stringify(res.json).includes('FILE-SECRET-SENTINEL'));

    const merged = oss.effectiveConfig(dir, {
      OSS_ACCESS_KEY_SECRET: 'ENV-SECRET-SENTINEL',
      OSS_BUCKET: 'env-bucket'
    });
    assert.equal(merged.config.accessKeySecret, 'ENV-SECRET-SENTINEL');
    assert.equal(merged.local.accessKeySecret, 'FILE-SECRET-SENTINEL');
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('图床：OSS V1 签名串与 HMAC-SHA1 可被独立复算', function () {
  const signed = oss.signV1({
    method: 'put',
    contentType: 'image/png',
    date: 'Thu, 17 Nov 2016 03:28:00 GMT',
    resource: '/oss-example/key.png',
    ossHeaders: { 'X-OSS-Object-Acl': 'public-read' },
    accessKeyId: 'test-ak',
    accessKeySecret: 'test-sk'
  });
  const expectedString = 'PUT\n\nimage/png\nThu, 17 Nov 2016 03:28:00 GMT\n' +
    'x-oss-object-acl:public-read\n/oss-example/key.png';
  assert.equal(signed.stringToSign, expectedString);
  const expectedSignature = crypto.createHmac('sha1', 'test-sk')
    .update(expectedString, 'utf8').digest('base64');
  assert.equal(signed.signature, expectedSignature);
  assert.equal(signed.authorization, 'OSS test-ak:' + expectedSignature);

  // 对象名：前缀 + 年/月 + 短哈希 + 可读文件名
  const key = oss.buildKey({ pathPrefix: 'blog/' }, 'photo 1.png', 'png', new Date(2026, 10, 8));
  assert.match(key, /^blog\/2026\/11\/[0-9a-f]{8}-photo-1\.png$/);

  assert.equal(
    oss.publicUrl({ bucket: 'demo-bucket', region: 'oss-cn-hangzhou' }, 'blog/2026/11/photo 1.png'),
    'https://demo-bucket.oss-cn-hangzhou.aliyuncs.com/blog/2026/11/photo%201.png');
  assert.equal(
    oss.publicUrl({ customDomain: 'https://img.example.com/' }, 'blog/2026/11/photo 1.png'),
    'https://img.example.com/blog/2026/11/photo%201.png');
});

test('图床：上传走服务端签名，并把 URL/Markdown/HTML 返回给前端', async function () {
  const dir = makeOssDir();
  const captured = [];
  const srv = await startServer(dir, null, {
    ossOptions: {
      env: {},
      now: new Date(2026, 10, 8, 12, 0, 0),
      request: function (params) {
        captured.push(params);
        return Promise.resolve({ status: 200, text: '', headers: {} });
      }
    }
  });
  try {
    const auth = await login(srv.base);
    const saved = await call(srv.base, '/admin/api/oss/config', {
      method: 'PUT', cookie: auth.cookie, csrf: auth.csrf,
      body: {
        accessKeyId: 'TEST-AK', accessKeySecret: 'TEST-SK-SENTINEL',
        bucket: 'demo-bucket', region: 'oss-cn-hangzhou', pathPrefix: 'blog/'
      }
    });
    assert.equal(saved.status, 200);

    const png = Buffer.from(OSS_PNG_BASE64, 'base64');
    const up = await call(srv.base, '/admin/api/oss/upload', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: {
        name: 'photo 1.png',
        type: 'image/png',
        data: 'data:image/png;base64,' + OSS_PNG_BASE64
      }
    });
    assert.equal(up.status, 200);
    assert.equal(up.json.ok, true);
    assert.equal(up.json.bytes, png.length);
    assert.match(up.json.key, /^blog\/2026\/11\/[0-9a-f]{8}-photo-1\.png$/);
    assert.equal(up.json.url, 'https://demo-bucket.oss-cn-hangzhou.aliyuncs.com/' + up.json.key);
    assert.equal(up.json.markdown, '![](' + up.json.url + ')');
    assert.equal(up.json.html, '<img src="' + up.json.url + '" alt="">');
    assert.ok(!JSON.stringify(up.json).includes('TEST-SK-SENTINEL'));

    const req = captured[0];
    assert.equal(req.method, 'PUT');
    assert.equal(req.contentType, 'image/png');
    assert.equal(req.ossHeaders['x-oss-object-acl'], 'public-read');
    assert.equal(req.body.length, png.length);
    assert.match(req.authorization, /^OSS TEST-AK:/);
    assert.ok(req.stringToSign.indexOf('/demo-bucket/' + up.json.key) >= 0);
    assert.ok(req.stringToSign.indexOf('x-oss-object-acl:public-read\n') >= 0);
    assert.ok(!JSON.stringify(req).includes('TEST-SK-SENTINEL'));
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('图床：非图片、超大文件与常见 OSS 错误都被明确拒绝/分类', function () {
  assert.throws(function () {
    oss.validateImage({ name: 'note.txt', type: 'text/plain', data: Buffer.from('hello').toString('base64') });
  }, function (err) { return err.code === 'OSS_NOT_IMAGE'; });

  const big = Buffer.alloc(oss.MAX_BYTES + 1);
  big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
  assert.throws(function () {
    oss.validateImage({ name: 'big.png', type: 'image/png', data: big.toString('base64') });
  }, function (err) { return err.code === 'OSS_FILE_TOO_LARGE' && err.label === '文件过大'; });

  // 声明是 PNG，内容却不是图片
  assert.throws(function () {
    oss.validateImage({ name: 'fake.png', type: 'image/png', data: Buffer.from('hello').toString('base64') });
  }, function (err) { return err.code === 'OSS_NOT_IMAGE'; });

  const ak = oss.classifyFailure(403,
    '<Error><Code>InvalidAccessKeyId</Code><Message>bad ak</Message></Error>', '');
  assert.equal(ak.code, 'OSS_AK_INVALID');
  assert.equal(ak.label, 'AK 无效');
  const bucket = oss.classifyFailure(404, '<Error><Code>NoSuchBucket</Code></Error>', '');
  assert.equal(bucket.code, 'OSS_BUCKET_MISSING');
  assert.equal(bucket.label, 'Bucket 不存在');
  const denied = oss.classifyFailure(403, '<Error><Code>AccessDenied</Code></Error>', '');
  assert.equal(denied.code, 'OSS_FORBIDDEN');
  assert.equal(denied.label, '权限不足');
  const region = oss.classifyFailure(0, '', 'ENOTFOUND');
  assert.equal(region.code, 'OSS_REGION_INVALID');
  assert.equal(region.label, '地域不对');
  const timeout = oss.classifyFailure(0, '', 'ETIMEDOUT');
  assert.equal(timeout.code, 'OSS_NETWORK');
  assert.equal(timeout.label, '网络超时');
});

test('图床：私有配置不进源码提交、打包与源码恢复备份', function () {
  assert.equal(source.isExcluded('.admin-oss.json'), true);
  assert.equal(source.isExcluded('.admin-oss.json.tmp-123'), true);
  assert.equal(packager.isExcluded('.admin-oss.json', 'light'), true);
  assert.equal(packager.isExcluded('.admin-oss.json', 'full'), true);
  assert.equal(packager.isExcluded('.admin-oss.json.tmp-123', 'full'), true);
});

/* ---------------------------------------------------- 图床：资源管理器 */

function ossContent(key, lastModified, size, etag) {
  return '<Contents><Key>' + key + '</Key><LastModified>' + lastModified +
    '</LastModified><ETag>' + etag + '</ETag><Size>' + size + '</Size></Contents>';
}

const OSS_PAGE_1 = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
  '<Name>demo-bucket</Name><Prefix>blog/2026/11/</Prefix><Marker></Marker>' +
  '<MaxKeys>48</MaxKeys><IsTruncated>true</IsTruncated>' +
  '<NextMarker>blog/2026/11/b.png</NextMarker><Total>3</Total>' +
  ossContent('blog/2026/11/a.png', '2026-11-08T10:00:00.000Z', 1024, '"etag-a"') +
  ossContent('blog/2026/11/note.txt', '2026-11-08T09:00:00.000Z', 10, '"etag-n"') +
  ossContent('blog/2026/11/logo.svg', '2026-11-06T10:00:00.000Z', 2048, '"etag-s"') +
  ossContent('blog/2026/11/b.png', '2026-11-07T10:00:00.000Z', 512, '"etag-b"') +
  '</ListBucketResult>';

const OSS_PAGE_2 = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
  '<IsTruncated>false</IsTruncated>' +
  ossContent('blog/2026/11/c.jpg', '2026-11-05T10:00:00.000Z', 300, '"etag-c"') +
  '</ListBucketResult>';

test('图床资源管理器：ListObjects 签名、图片过滤、marker 分页与域名兜底', async function () {
  const dir = makeOssDir();
  const captured = [];
  const srv = await startServer(dir, null, {
    ossOptions: {
      env: {
        OSS_ACCESS_KEY_ID: 'LIST-AK',
        OSS_ACCESS_KEY_SECRET: 'LIST-SECRET-SENTINEL',
        OSS_BUCKET: 'demo-bucket',
        OSS_REGION: 'oss-cn-hangzhou',
        OSS_CUSTOM_DOMAIN: 'https://wenroumao.cn/'
      },
      request: function (params) {
        captured.push(params);
        if (params.query.indexOf('marker=') >= 0) {
          return Promise.resolve({ status: 200, text: OSS_PAGE_2, headers: {} });
        }
        return Promise.resolve({ status: 200, text: OSS_PAGE_1, headers: {} });
      },
      probeDomain: function () { return Promise.resolve(false); }
    }
  });
  try {
    const auth = await login(srv.base);
    const first = await call(srv.base,
      '/admin/api/oss/objects?limit=48&prefix=' + encodeURIComponent('blog/2026/11/'),
      { cookie: auth.cookie });
    assert.equal(first.status, 200);
    assert.equal(first.json.ok, true);
    assert.equal(first.json.items.length, 3);
    assert.deepEqual(first.json.items.map(function (item) { return item.key; }), [
      'blog/2026/11/a.png',
      'blog/2026/11/b.png',
      'blog/2026/11/logo.svg'
    ]);
    assert.equal(first.json.hasMore, true);
    assert.equal(first.json.nextMarker, 'blog/2026/11/b.png');
    assert.equal(first.json.total, 3);
    assert.equal(first.json.order, 'lastModified-desc');
    assert.equal(first.json.domain.customDomain, 'https://wenroumao.cn');
    assert.equal(first.json.domain.ok, false);

    // customDomain 打不开：url 自动退回默认域名，但三个 URL 字段都返回。
    assert.equal(first.json.items[0].url, first.json.items[0].defaultUrl);
    assert.match(first.json.items[0].defaultUrl, /^https:\/\/demo-bucket\.oss-cn-hangzhou\.aliyuncs\.com\//);
    assert.match(first.json.items[0].cdnUrl, /^https:\/\/wenroumao\.cn\//);
    assert.equal(first.json.items[0].markdown, '![](' + first.json.items[0].defaultUrl + ')');
    assert.ok(!JSON.stringify(first.json).includes('LIST-SECRET-SENTINEL'));

    // 列表请求的签名与 query：GET、bucket 根资源、marker/prefix 在 URL 而非签名串里。
    const listReq = captured[0];
    assert.equal(listReq.method, 'GET');
    assert.equal(listReq.key, '');
    assert.match(listReq.query, /prefix=blog%2F2026%2F11%2F/);
    assert.match(listReq.query, /max-keys=48/);
    assert.match(listReq.stringToSign, /^GET\n\n\n[^\n]+\n\/demo-bucket\/$/);
    assert.equal(listReq.stringToSign.indexOf('prefix='), -1);
    assert.match(listReq.authorization, /^OSS LIST-AK:/);
    assert.ok(!JSON.stringify(listReq).includes('LIST-SECRET-SENTINEL'));

    // 第二页把 marker 传回去。
    const more = await call(srv.base,
      '/admin/api/oss/objects?limit=48&marker=' +
      encodeURIComponent('blog/2026/11/b.png'), { cookie: auth.cookie });
    assert.equal(more.status, 200);
    assert.equal(more.json.items.length, 1);
    assert.equal(more.json.items[0].key, 'blog/2026/11/c.jpg');
    assert.equal(more.json.hasMore, false);
    assert.equal(more.json.nextMarker, '');
    assert.match(captured[1].query, /marker=blog%2F2026%2F11%2Fb\.png/);

    // search 在服务端过滤当前页；txt 被扩展名过滤掉。
    const searched = await call(srv.base,
      '/admin/api/oss/objects?limit=48&search=logo', { cookie: auth.cookie });
    assert.equal(searched.status, 200);
    assert.equal(searched.json.items.length, 1);
    assert.equal(searched.json.items[0].key, 'blog/2026/11/logo.svg');
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('图床资源管理器：批量删除返回逐条明细，缺 CSRF 与超量被拒', async function () {
  const dir = makeOssDir();
  const deletedKeys = [];
  const srv = await startServer(dir, null, {
    ossOptions: {
      env: {
        OSS_ACCESS_KEY_ID: 'DEL-AK',
        OSS_ACCESS_KEY_SECRET: 'DEL-SECRET-SENTINEL',
        OSS_BUCKET: 'demo-bucket',
        OSS_REGION: 'oss-cn-hangzhou'
      },
      request: function (params) {
        if (params.method !== 'DELETE') {
          return Promise.resolve({ status: 200, text: '', headers: {} });
        }
        deletedKeys.push(params.key);
        if (params.key === 'blog/denied.png') {
          const err = oss.classifyFailure(403,
            '<Error><Code>AccessDenied</Code><Message>no delete permission</Message></Error>', '');
          err.ossCode = 'AccessDenied';
          err.ossMessage = 'no delete permission';
          err.ossStatus = 403;
          return Promise.reject(err);
        }
        return Promise.resolve({ status: 204, text: '', headers: {} });
      }
    }
  });
  try {
    const auth = await login(srv.base);
    const res = await call(srv.base, '/admin/api/oss/delete', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: { keys: ['blog/good.png', 'blog/denied.png', '../bad.png'] }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.partial, true);
    assert.equal(res.json.deleted, 1);
    assert.equal(res.json.failed, 2);
    assert.equal(res.json.total, 3);
    assert.deepEqual(deletedKeys, ['blog/good.png', 'blog/denied.png']);

    const good = res.json.results.find(function (item) { return item.key === 'blog/good.png'; });
    const denied = res.json.results.find(function (item) { return item.key === 'blog/denied.png'; });
    const bad = res.json.results.find(function (item) { return item.key === '../bad.png'; });
    assert.ok(good && good.ok);
    assert.equal(denied.code, 'OSS_FORBIDDEN');
    assert.equal(denied.ossCode, 'AccessDenied');
    assert.equal(denied.remoteMessage, 'no delete permission');
    assert.equal(bad.code, 'OSS_BAD_KEY');
    assert.ok(!JSON.stringify(res.json).includes('DEL-SECRET-SENTINEL'));

    // 缺 CSRF：写接口必须被拒
    const noCsrf = await call(srv.base, '/admin/api/oss/delete', {
      method: 'POST', cookie: auth.cookie, body: { keys: ['blog/good.png'] }
    });
    assert.equal(noCsrf.status, 403);

    // 单次超过 100 个：不联网，直接拒绝
    const many = [];
    for (let i = 0; i < 101; i++) many.push('blog/' + i + '.png');
    let limitError = null;
    try {
      await oss.deleteObjects(dir, { keys: many }, {
        env: {
          OSS_ACCESS_KEY_ID: 'DEL-AK', OSS_ACCESS_KEY_SECRET: 'x',
          OSS_BUCKET: 'demo-bucket', OSS_REGION: 'oss-cn-hangzhou'
        }
      });
    } catch (err) { limitError = err; }
    assert.ok(limitError);
    assert.equal(limitError.code, 'OSS_DELETE_LIMIT');
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

test('图床资源管理器：未配置时列表/删除返回 OSS_NOT_CONFIGURED', async function () {
  const dir = makeOssDir();
  const srv = await startServer(dir, null, { ossOptions: { env: {} } });
  try {
    const auth = await login(srv.base);
    const list = await call(srv.base, '/admin/api/oss/objects', { cookie: auth.cookie });
    assert.equal(list.status, 400);
    assert.equal(list.json.error.code, 'OSS_NOT_CONFIGURED');
    assert.match(list.json.error.message, /AccessKeyId/);

    const del = await call(srv.base, '/admin/api/oss/delete', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: { keys: ['blog/a.png'] }
    });
    assert.equal(del.status, 400);
    assert.equal(del.json.error.code, 'OSS_NOT_CONFIGURED');
  } finally {
    await srv.close();
    cleanup(dir);
  }
});

/* ------------------------------------------------------- Markdown 导入（一期） */

test('本地 .md 解析：BOM 剥离、front matter 字段保留、大小限制', function () {
  const raw = '\uFEFF---\ntitle: 导入的标题\ndate: 2026-01-02 09:00:00\ncategories:\n  - 随笔\n  - 笔记\ntags: [甲, 乙]\ncover: /img/c.png\nexcerpt: 摘要文字\ncomments: false\ndraft: true\n---\n\n正文第一段\n';
  const parsed = importer.parseMarkdown(raw);
  assert.equal(parsed.hasFrontMatter, true);
  assert.equal(parsed.title, '导入的标题');
  assert.equal(parsed.date, '2026-01-02 09:00:00');
  assert.deepEqual(parsed.categories, ['随笔', '笔记']);
  assert.deepEqual(parsed.tags, ['甲', '乙']);
  assert.equal(parsed.cover, '/img/c.png');
  assert.equal(parsed.description, '摘要文字');
  assert.equal(parsed.comments, false);
  assert.equal(parsed.published, false);
  assert.equal(parsed.body, '正文第一段\n');
  assert.deepEqual(parsed.warnings, []);

  const noFront = importer.parseMarkdown('\uFEFF只有正文\n');
  assert.equal(noFront.hasFrontMatter, false);
  assert.equal(noFront.body, '只有正文\n');
  assert.match(noFront.warnings.join(), /没有 front matter/);

  assert.throws(function () { importer.parseMarkdown('   '); }, /空的/);
  const big = 'a'.repeat(importer.MAX_MD_BYTES + 1);
  assert.throws(function () { importer.parseMarkdown(big); }, function (err) {
    return err.code === 'IMPORT_MD_TOO_LARGE';
  });
});

test('SSRF 防护：内网 IP、localhost、解析到内网的域名一律拦截', async function () {
  const blocked = ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.1',
    '169.254.1.1', '0.0.0.0', '::1', '[::1]', '::ffff:127.0.0.1', '100.64.0.1'];
  for (let i = 0; i < blocked.length; i++) {
    await assert.rejects(
      importer.assertPublicHost(blocked[i]),
      function (err) { return err.code === 'IMPORT_BLOCKED_PRIVATE'; },
      blocked[i] + ' 应该被拦截'
    );
  }
  await assert.rejects(
    importer.assertPublicHost('localhost'),
    function (err) { return err.code === 'IMPORT_BLOCKED_PRIVATE'; }
  );

  const lookup = async function () { return [{ address: '10.0.0.8', family: 4 }]; };
  await assert.rejects(
    importer.assertPublicHost('evil.example.com', lookup),
    function (err) { return err.code === 'IMPORT_BLOCKED_PRIVATE'; }
  );

  const publicLookup = async function () { return [{ address: '93.184.216.34', family: 4 }]; };
  const ok = await importer.assertPublicHost('example.com', publicLookup);
  assert.equal(ok[0].address, '93.184.216.34');

  assert.throws(function () { importer.normalizeUrl('ftp://example.com/a'); }, /只允许 http/);
  assert.throws(function () { importer.normalizeUrl('not a url'); }, /格式不正确/);
});

test('网页抓取：15 秒超时按 IMPORT_TIMEOUT 结束', async function () {
  const lookup = async function () { return [{ address: '93.184.216.34', family: 4 }]; };
  const fakeRequest = function () {
    return { on: function () {}, end: function () {}, destroy: function () {} };
  };
  await assert.rejects(
    importer.fetchPage('https://example.com/post', { lookup: lookup, request: fakeRequest, timeoutMs: 60 }),
    function (err) { return err.code === 'IMPORT_TIMEOUT'; }
  );
});

test('HTML → Markdown：标题/段落/强调/代码/列表/引用/表格/图片/链接/分隔线', function () {
  const html = [
    '<html><head><title>文章标题 - 某站点</title>',
    '<meta property="og:title" content="OG 标题"></head>',
    '<body>',
    '<nav class="site-nav"><a href="/">首页</a></nav>',
    '<article class="post-content">',
    '<h1>第一章</h1>',
    '<p>普通段落，含 <strong>粗体</strong> 与 <em>斜体</em> 和 <code>inline()</code>。</p>',
    '<h3>小节</h3>',
    '<ul><li>甲</li><li>乙<ul><li>乙-1</li></ul></li></ul>',
    '<ol start="3"><li>第三</li><li>第四</li></ol>',
    '<blockquote>引用第一行<br>引用第二行</blockquote>',
    '<pre><code class="language-js">const x = 1;\nif (x) { console.log(x); }</code></pre>',
    '<table><thead><tr><th>名称</th><th>值</th></tr></thead>',
    '<tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody></table>',
    '<img src="/img/pic.png" alt="示意图">',
    '<p><a href="/other/post">站内链接</a></p>',
    '<hr>',
    '</article>',
    '<footer><p>版权页脚</p></footer>',
    '<script>var a = 1;</script>',
    '</body></html>'
  ].join('\n');

  const result = importer.htmlToMarkdown(html, 'https://example.com/post/1');
  assert.equal(result.title, 'OG 标题');
  const md = result.markdown;

  assert.match(md, /^# 第一章/m);
  assert.match(md, /### 小节/);
  assert.match(md, /\*\*粗体\*\*/);
  assert.match(md, /\*斜体\*/);
  assert.match(md, /`inline\(\)`/);
  assert.match(md, /- 甲/);
  assert.match(md, /  - 乙-1/);
  assert.match(md, /3\. 第三/);
  assert.match(md, /> 引用第一行/);
  assert.match(md, /```js\nconst x = 1;/);
  assert.match(md, /\| 名称 \| 值 \|/);
  assert.match(md, /\| a \| 1 \|/);
  assert.match(md, /!\[示意图\]\(https:\/\/example\.com\/img\/pic\.png\)/);
  assert.match(md, /\[站内链接\]\(https:\/\/example\.com\/other\/post\)/);
  assert.match(md, /\n---($|\n)/);
  assert.doesNotMatch(md, /首页/);
  assert.doesNotMatch(md, /版权页脚/);
  assert.doesNotMatch(md, /var a = 1/);
  assert.equal(result.charCount, md.length);
  assert.deepEqual(result.warnings, []);
});

test('HTML → Markdown：内容过少时提示可能需要 JS 渲染', function () {
  const html = '<html><head><title>SPA</title></head><body><div id="app"></div>' +
    '<script src="/app.js"></script></body></html>';
  const result = importer.htmlToMarkdown(html, 'https://example.com/');
  assert.equal(result.markdown, '');
  assert.match(result.warnings.join(), /可能需要 JS 渲染/);
});

test('导入接口：缺 CSRF 被拒，内网地址被拦，.md 导入可用', async function () {
  const dir = makeFixture();
  const srv = await startServer(dir);
  try {
    const auth = await login(srv.base);

    const noCsrf = await call(srv.base, '/admin/api/import/md', {
      method: 'POST', cookie: auth.cookie, body: { text: '# x' }
    });
    assert.equal(noCsrf.status, 403);

    const noAuth = await call(srv.base, '/admin/api/import/md', { method: 'POST', body: { text: '# x' } });
    assert.equal(noAuth.status, 401);

    const ssrf = await call(srv.base, '/admin/api/import/url', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: { url: 'http://127.0.0.1:8080/' }
    });
    assert.equal(ssrf.status, 403);
    assert.equal(ssrf.json.error.code, 'IMPORT_BLOCKED_PRIVATE');

    const md = await call(srv.base, '/admin/api/import/md', {
      method: 'POST', cookie: auth.cookie, csrf: auth.csrf,
      body: { text: '\uFEFF---\ntitle: 导入标题\ntags:\n  - 导入\n---\n\n正文\n' }
    });
    assert.equal(md.status, 200);
    assert.equal(md.json.title, '导入标题');
    assert.deepEqual(md.json.tags, ['导入']);
    assert.equal(md.json.rawBody === undefined, true);
  } finally {
    await srv.close();
    cleanup(dir);
  }
});
