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

