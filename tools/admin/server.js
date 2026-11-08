'use strict';
/**
 * tools/admin/server.js —— 挂在 hexo server 上的本地后台
 * ---------------------------------------------------------------------------
 * 只处理 /admin 开头的请求，其余交给 Hexo 自己。
 * 不引入 express / connect 依赖：中间件签名就是 (req, res, next)。
 *
 * 入口在 scripts/admin-server.js，通过 server_middleware 过滤器挂载。
 * 本文件也接受 options 注入（baseDir / env / runBuild），方便测试。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const core = require('./core');
const deploy = require('./deploy');
const source = require('./source');
const packager = require('./package');
const ssh = require('./ssh');
const oss = require('./oss');
const importer = require('./importer');

const COOKIE_NAME = 'fomalhaut_admin';
const UI_DIR = path.join(__dirname, 'ui');
const STATIC_FILES = {
  '': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/snippets.js': { file: 'snippets.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/preview': { file: 'preview.html', type: 'text/html; charset=utf-8', frameable: true },
  '/preview.html': { file: 'preview.html', type: 'text/html; charset=utf-8', frameable: true },
  '/preview.js': { file: 'preview.js', type: 'text/javascript; charset=utf-8' },
  '/preview.css': { file: 'preview.css', type: 'text/css; charset=utf-8' }
};

/**
 * 后台可写的全部字段。开关（type: 'boolean' + feature: true）与「功能开关」页
 * 共用这一份白名单：界面只展示这里列出的 id，接口也只接受这里列出的 id。
 */
const CONFIG_FIELDS = [
  { id: 'title', file: '_config.yml', path: ['title'], label: '站点标题', group: '站点信息', type: 'text', hint: '显示在浏览器标签与页头' },
  { id: 'subtitle', file: '_config.yml', path: ['subtitle'], label: '站点副标题', group: '站点信息', type: 'text' },
  { id: 'description', file: '_config.yml', path: ['description'], label: '站点描述', group: '站点信息', type: 'text' },
  { id: 'keywords', file: '_config.yml', path: ['keywords'], label: '关键词', group: '站点信息', type: 'text', hint: '英文逗号分隔' },
  { id: 'author', file: '_config.yml', path: ['author'], label: '作者', group: '站点信息', type: 'text' },
  { id: 'language', file: '_config.yml', path: ['language'], label: '语言', group: '站点信息', type: 'text' },
  { id: 'url', file: '_config.yml', path: ['url'], label: '站点地址', group: '站点信息', type: 'text', hint: '结尾带 /' },

  { id: 'avatar.img', file: '_config.fomalhaut.yml', path: ['avatar', 'img'], label: '头像图片', group: '主题外观', type: 'text' },
  { id: 'index_img', file: '_config.fomalhaut.yml', path: ['index_img'], label: '首页大图', group: '主题外观', type: 'text', hint: '留空则用默认头图' },
  { id: 'default_top_img', file: '_config.fomalhaut.yml', path: ['default_top_img'], label: '默认头图', group: '主题外观', type: 'text' },
  { id: 'footer.owner.since', file: '_config.fomalhaut.yml', path: ['footer', 'owner', 'since'], label: '建站年份', group: '主题外观', type: 'number' },
  { id: 'footer.custom_text', file: '_config.fomalhaut.yml', path: ['footer', 'custom_text'], label: '页脚自定义文字', group: '主题外观', type: 'text' },
  { id: 'subtitle.sub', file: '_config.fomalhaut.yml', path: ['subtitle', 'sub'], label: '副标题文案', group: '主题外观', type: 'list', hint: '一行一句' },
  { id: 'ai_chat.model', file: '_config.fomalhaut.yml', path: ['ai_chat', 'model'], label: 'AI 模型', group: '主题外观', type: 'text' },

  /* ------------------------------ 界面外观 ------------------------------ */
  { id: 'preloader.enable', file: '_config.fomalhaut.yml', path: ['preloader', 'enable'], label: '加载动画', group: '界面外观', type: 'boolean', feature: true, hint: '首次进入站点时显示加载动画。' },
  { id: 'subtitle.enable', file: '_config.fomalhaut.yml', path: ['subtitle', 'enable'], label: '首页副标题', group: '界面外观', type: 'boolean', feature: true, hint: '首页大标题下显示副标题文字。' },
  { id: 'subtitle.effect', file: '_config.fomalhaut.yml', path: ['subtitle', 'effect'], label: '副标题打字效果', group: '界面外观', type: 'boolean', feature: true, hint: '副标题逐字打出的动画；关闭后只显示第一行文案。' },
  { id: 'darkmode.enable', file: '_config.fomalhaut.yml', path: ['darkmode', 'enable'], label: '日夜模式', group: '界面外观', type: 'boolean', feature: true, hint: '允许站点在前台切换浅色与深色主题。' },
  { id: 'darkmode.button', file: '_config.fomalhaut.yml', path: ['darkmode', 'button'], label: '日夜切换按钮', group: '界面外观', type: 'boolean', feature: true, hint: '右下角按钮列里显示手动切换浅色/深色的按钮。' },
  { id: 'enter_transitions', file: '_config.fomalhaut.yml', path: ['enter_transitions'], label: '入场过渡', group: '界面外观', type: 'boolean', feature: true, hint: '页面切换时播放淡入过渡动画。' },
  { id: 'aside.enable', file: '_config.fomalhaut.yml', path: ['aside', 'enable'], label: '侧边栏', group: '界面外观', type: 'boolean', feature: true, hint: '文章页右侧显示作者、公告等卡片。' },
  { id: 'beautify.enable', file: '_config.fomalhaut.yml', path: ['beautify', 'enable'], label: '标题美化', group: '界面外观', type: 'boolean', feature: true, hint: '给文章标题加上前缀小图标。' },

  /* ------------------------------ 氛围特效 ------------------------------ */
  { id: 'canvas_ribbon.enable', file: '_config.fomalhaut.yml', path: ['canvas_ribbon', 'enable'], label: '静态彩带', group: '氛围特效', type: 'boolean', feature: true, hint: '背景铺一层静止的彩带线条。' },
  { id: 'canvas_fluttering_ribbon.enable', file: '_config.fomalhaut.yml', path: ['canvas_fluttering_ribbon', 'enable'], label: '动态飘带', group: '氛围特效', type: 'boolean', feature: true, hint: '背景显示会飘动的彩带。' },
  { id: 'canvas_nest.enable', file: '_config.fomalhaut.yml', path: ['canvas_nest', 'enable'], label: '粒子连线', group: '氛围特效', type: 'boolean', feature: true, hint: '背景显示随鼠标移动的粒子连线。' },
  { id: 'activate_power_mode.enable', file: '_config.fomalhaut.yml', path: ['activate_power_mode', 'enable'], label: '打字粒子', group: '氛围特效', type: 'boolean', feature: true, hint: '输入时在页面出现粒子与抖动特效。' },
  { id: 'fireworks.enable', file: '_config.fomalhaut.yml', path: ['fireworks', 'enable'], label: '点击烟花', group: '氛围特效', type: 'boolean', feature: true, hint: '鼠标点击时绽放烟花。' },
  { id: 'click_heart.enable', file: '_config.fomalhaut.yml', path: ['click_heart', 'enable'], label: '点击爱心', group: '氛围特效', type: 'boolean', feature: true, hint: '鼠标点击时冒出爱心。' },
  { id: 'ClickShowText.enable', file: '_config.fomalhaut.yml', path: ['ClickShowText', 'enable'], label: '点击文字', group: '氛围特效', type: 'boolean', feature: true, hint: '鼠标点击时显示预设文字（文字内容在主题配置里）。' },
  { id: 'lantern.enable', file: '_config.fomalhaut.yml', path: ['lantern', 'enable'], label: '节日灯笼', group: '氛围特效', type: 'boolean', feature: true, hint: '页面两侧挂灯笼，适合节日期间开启。' },
  { id: 'wowjs.enable', file: '_config.fomalhaut.yml', path: ['wowjs', 'enable'], label: '滚动入场动画', group: '氛围特效', type: 'boolean', feature: true, hint: '列表与卡片滚动进入视口时淡入。' },

  /* ------------------------------ 阅读体验 ------------------------------ */
  { id: 'highlight.enable', file: '_config.yml', path: ['highlight', 'enable'], label: '代码高亮', group: '阅读体验', type: 'boolean', feature: true, hint: '关闭后代码块不再着色，复制按钮、语言标签等也可能一起失效。' },
  { id: 'highlight_copy', file: '_config.fomalhaut.yml', path: ['highlight_copy'], label: '代码复制按钮', group: '阅读体验', type: 'boolean', feature: true, hint: '代码块右上角显示一键复制按钮。' },
  { id: 'highlight_lang', file: '_config.fomalhaut.yml', path: ['highlight_lang'], label: '代码语言标签', group: '阅读体验', type: 'boolean', feature: true, hint: '代码块左上角显示语言名称。' },
  { id: 'code_word_wrap', file: '_config.fomalhaut.yml', path: ['code_word_wrap'], label: '代码自动换行', group: '阅读体验', type: 'boolean', feature: true, hint: '长代码行自动折行，不出现横向滚动条。' },
  { id: 'toc.post', file: '_config.fomalhaut.yml', path: ['toc', 'post'], label: '文章目录', group: '阅读体验', type: 'boolean', feature: true, hint: '文章页右侧显示标题目录。' },
  { id: 'post_copyright.enable', file: '_config.fomalhaut.yml', path: ['post_copyright', 'enable'], label: '版权卡片', group: '阅读体验', type: 'boolean', feature: true, hint: '文章底部显示作者与许可协议卡片。' },
  { id: 'related_post.enable', file: '_config.fomalhaut.yml', path: ['related_post', 'enable'], label: '相关推荐', group: '阅读体验', type: 'boolean', feature: true, hint: '文章底部推荐相关文章。' },
  { id: 'noticeOutdate.enable', file: '_config.fomalhaut.yml', path: ['noticeOutdate', 'enable'], label: '文章过期提醒', group: '阅读体验', type: 'boolean', feature: true, hint: '长期未更新的文章顶部显示过期提示。' },
  { id: 'wordcount.enable', file: '_config.fomalhaut.yml', path: ['wordcount', 'enable'], label: '字数统计', group: '阅读体验', type: 'boolean', feature: true, hint: '显示文章字数与预计阅读时间。' },
  { id: 'medium_zoom', file: '_config.fomalhaut.yml', path: ['medium_zoom'], label: '图片缩放', group: '阅读体验', type: 'boolean', feature: true, hint: '点击正文图片时用 medium-zoom 放大。' },
  { id: 'fancybox', file: '_config.fomalhaut.yml', path: ['fancybox'], label: '图片灯箱', group: '阅读体验', type: 'boolean', feature: true, hint: '点击正文图片时用 fancybox 灯箱查看。' },
  { id: 'lazyload.enable', file: '_config.fomalhaut.yml', path: ['lazyload', 'enable'], label: '图片懒加载', group: '阅读体验', type: 'boolean', feature: true, hint: '图片滚动到可视区域附近才加载。' },
  { id: 'cover.index_enable', file: '_config.fomalhaut.yml', path: ['cover', 'index_enable'], label: '首页封面', group: '阅读体验', type: 'boolean', feature: true, hint: '首页文章列表显示封面图。' },

  /* ---------------------------- 交互与评论 ------------------------------ */
  { id: 'pjax.enable', file: '_config.fomalhaut.yml', path: ['pjax', 'enable'], label: 'PJAX 无刷新跳转', group: '交互与评论', type: 'boolean', feature: true, hint: '站内跳转不整页刷新；个别插件冲突时可临时关闭排查。' },
  { id: 'local_search.enable', file: '_config.fomalhaut.yml', path: ['local_search', 'enable'], label: '本地搜索', group: '交互与评论', type: 'boolean', feature: true, hint: '用本地生成的索引提供站内搜索。' },
  { id: 'algolia_search.enable', file: '_config.fomalhaut.yml', path: ['algolia_search', 'enable'], label: 'Algolia 搜索', group: '交互与评论', type: 'boolean', feature: true, hint: '使用 Algolia 云端索引搜索（需要先配好索引）。' },
  { id: 'instantpage', file: '_config.fomalhaut.yml', path: ['instantpage'], label: '链接预加载', group: '交互与评论', type: 'boolean', feature: true, hint: '鼠标悬停链接时提前预取目标页面。' },
  { id: 'comments.lazyload', file: '_config.fomalhaut.yml', path: ['comments', 'lazyload'], label: '评论懒加载', group: '交互与评论', type: 'boolean', feature: true, hint: '评论区进入视口后才加载；开启时评论数可能不显示。' },
  { id: 'translate.enable', file: '_config.fomalhaut.yml', path: ['translate', 'enable'], label: '简繁转换', group: '交互与评论', type: 'boolean', feature: true, hint: '右下角提供简繁体一键转换按钮。' },
  { id: 'pangu.enable', file: '_config.fomalhaut.yml', path: ['pangu', 'enable'], label: '中英文空格', group: '交互与评论', type: 'boolean', feature: true, hint: '自动在中英文之间补一个空格。' },
  { id: 'snackbar.enable', file: '_config.fomalhaut.yml', path: ['snackbar', 'enable'], label: '右下角提示条', group: '交互与评论', type: 'boolean', feature: true, hint: '显示站点通知/提示条。' },
  { id: 'envelope_comment.enable', file: '_config.fomalhaut.yml', path: ['envelope_comment', 'enable'], label: '留言板信封', group: '交互与评论', type: 'boolean', feature: true, hint: '留言板使用信封样式的展开动画。' },

  /* ------------------------------ AI 能力 ------------------------------- */
  { id: 'ai_chat.enable', file: '_config.fomalhaut.yml', path: ['ai_chat', 'enable'], label: 'AI 页面助手', group: 'AI 能力', type: 'boolean', feature: true, hint: '在页面右侧显示 AI 按钮，可总结当前页面并追问（需要配置 API Key）。' },

  /* ----------------------------- 站点与 SEO ----------------------------- */
  { id: 'external_link.enable', file: '_config.yml', path: ['external_link', 'enable'], label: '外链新窗口', group: '站点与 SEO', type: 'boolean', feature: true, hint: '站外链接在新标签页打开。' },
  { id: 'nofollow.enable', file: '_config.yml', path: ['nofollow', 'enable'], label: '外链 nofollow', group: '站点与 SEO', type: 'boolean', feature: true, hint: '给站外链接加上 rel="nofollow"，避免权重外流。' },
  { id: 'meta_generator', file: '_config.yml', path: ['meta_generator'], label: '生成器标记', group: '站点与 SEO', type: 'boolean', feature: true, hint: '在页面 head 里输出 Hexo 版本标记。' },
  { id: 'Open_Graph_meta', file: '_config.fomalhaut.yml', path: ['Open_Graph_meta'], label: '社交分享卡片', group: '站点与 SEO', type: 'boolean', feature: true, hint: '输出 Open Graph 标签，分享到社交平台时显示缩略卡片。' }
];

const FEATURE_GROUP_ORDER = ['界面外观', '氛围特效', '阅读体验', '交互与评论', 'AI 能力', '站点与 SEO'];

function createAdminServer(options) {
  const opts = options || {};
  const baseDir = opts.baseDir || path.join(__dirname, '..', '..');
  const env = opts.env || process.env;
  const runGenerate = opts.runGenerate || createHexoRunner(baseDir);
  const runDeploy = opts.runDeploy || function (task) {
    // 不传 {repo, branch} 这类“半截配置”，让 deployWithGit 自己重新读盘，
    // 避免再次出现 ready 为 undefined 的误报。
    return deploy.deployWithGit(baseDir, { allowDelete: task.allowDelete === true }, task.log);
  };
  // 预览用站点自己的 Markdown 渲染器；未注入时退化为纯文本，保证接口始终可用。
  const runMarkdown = opts.runMarkdown || defaultMarkdown;
  const autoGenerate = env.ADMIN_AUTO_GENERATE === '0' || env.ADMIN_AUTO_GENERATE === 'false' ? false : true;
  const sessions = new Map();
  const loginFailures = new Map();
  const jobs = new Map();
  // 源码页的仓库/分支可注入（测试用临时裸仓库，线上走默认的 wenroumao/source）。
  const sourceOptions = opts.sourceOptions || {};
  // 打包与 SSH 的 home/压缩器/执行器都可注入，测试里不碰真实 ~/.ssh、不联网。
  const packageOptions = opts.packageOptions || {};
  const sshOptions = opts.sshOptions || {};
  // 图床：env 可注入，request 可注入（测试不联网）。
  const ossOptions = opts.ossOptions || {};
  const ossEnv = ossOptions.env || env;
  let sourceBusy = false;
  let packageBusy = false;
  let sshBusy = false;
  let ossBusy = false;
  let currentJobId = '';
  let lastJobId = '';
  let pendingAuto = false;

  function config() {
    return core.loadAdminConfig(baseDir, env);
  }

  function deployConfig() {
    return deploy.loadDeployConfig(baseDir, env);
  }

  // 发给浏览器的配置里绝不能带 Token
  function publicDeploy() {
    const value = deployConfig();
    delete value.token;
    return value;
  }

  function securityHeaders(res, frameable) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors " + (frameable ? "'self'" : "'none'"));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', frameable ? 'SAMEORIGIN' : 'DENY');
  }

  function sendJson(res, code, payload) {
    securityHeaders(res);
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
  }

  function fail(res, code, message) {
    sendJson(res, code, { error: { message: message } });
  }

  /** 图床错误：保留分类 label/hint，前端可直接显示人话。 */
  function sendOssFailure(res, err) {
    const code = (err && err.code) || 'OSS_REMOTE_ERROR';
    let status = 502;
    if (code === 'OSS_NOT_CONFIGURED' || code === 'OSS_NOT_IMAGE' ||
        code === 'OSS_DELETE_INVALID' || code === 'OSS_DELETE_LIMIT') {
      status = code === 'OSS_NOT_IMAGE' ? 415 : 400;
    } else if (code === 'OSS_FILE_TOO_LARGE') status = 413;
    else if (code === 'OSS_LIST_FORBIDDEN') status = 403;
    else if (code === 'OSS_CONFIG_WRITE_FAILED') status = 500;
    sendJson(res, status, {
      ok: false,
      error: {
        code: code,
        label: (err && err.label) || '图床错误',
        message: (err && err.message) || 'OSS 操作失败。',
        hint: (err && err.hint) || ''
      }
    });
  }

  /** 导入失败：保留 importer 的错误码与人话提示。 */
  function sendImportFailure(res, err) {
    const code = (err && err.code) || 'IMPORT_FAILED';
    const status = (err && err.status) || 502;
    sendJson(res, status, {
      ok: false,
      error: {
        code: code,
        message: (err && err.message) || '导入失败。'
      }
    });
  }

  /** 没有注入站点渲染器时的兜底：原样显示，不假装是 Markdown 渲染结果。 */
  function defaultMarkdown(text) {
    return '<pre class="preview-fallback">' + String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>';
  }

  function sessionOf(req) {
    const token = core.parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return session;
  }

  function createSession(user) {
    const cfg = config();
    const now = Date.now();
    sessions.forEach(function (session, token) {
      if (session.expiresAt <= now) sessions.delete(token);
    });
    if (sessions.size > 50) {
      const oldest = Array.from(sessions.entries()).sort(function (a, b) {
        return a[1].createdAt - b[1].createdAt;
      })[0];
      if (oldest) sessions.delete(oldest[0]);
    }
    const token = crypto.randomBytes(24).toString('base64url');
    const csrf = crypto.randomBytes(18).toString('base64url');
    sessions.set(token, { user: user, csrf: csrf, createdAt: now, expiresAt: now + cfg.ttlMs });
    return { token: token, csrf: csrf, ttlMs: cfg.ttlMs };
  }

  function cookieHeader(token, ttlMs, secure) {
    let cookie = COOKIE_NAME + '=' + token + '; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(ttlMs / 1000);
    if (secure) cookie += '; Secure';
    return cookie;
  }

  function isSecure(req) {
    return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  function checkOrigin(req) {
    const origin = String(req.headers.origin || '').trim();
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch (e) { return false; }
      if (host !== String(req.headers.host || '')) return false;
    }
    const site = String(req.headers['sec-fetch-site'] || '').trim();
    if (site && (site === 'cross-site' || site === 'cross-origin' || site === 'same-site')) return false;
    return true;
  }

  function requireSession(req, res, cors) {
    if (!cors) return null;
    const session = sessionOf(req);
    if (!session) {
      fail(res, 401, '登录已过期，请重新登录。');
      return null;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!core.safeEqual(String(req.headers['x-csrf-token'] || ''), session.csrf)) {
        fail(res, 403, '请求校验失败，请刷新页面后重试。');
        return null;
      }
    }
    return session;
  }

  function rateLimited(ip) {
    const now = Date.now();
    const entry = loginFailures.get(ip);
    if (!entry || entry.resetAt <= now) {
      if (entry) loginFailures.delete(ip);
      return false;
    }
    return entry.count >= 6;
  }

  function recordFailure(ip) {
    const now = Date.now();
    const entry = loginFailures.get(ip);
    if (!entry || entry.resetAt <= now) {
      loginFailures.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    } else {
      entry.count += 1;
    }
    if (loginFailures.size > 2000) loginFailures.clear();
  }

  function readBody(req, limit) {
    return new Promise(function (resolve, reject) {
      let size = 0;
      const chunks = [];
      req.on('data', function (chunk) {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('请求体太大。'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) return resolve({});
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('请求体不是合法 JSON。')); }
      });
      req.on('error', function (err) { reject(err); });
    });
  }

  function sendStatic(req, res, name) {
    const entry = STATIC_FILES[name];
    if (!entry) return false;
    const file = path.join(UI_DIR, entry.file);
    let content;
    try { content = fs.readFileSync(file); } catch (e) {
      fail(res, 500, '后台页面文件缺失：' + entry.file);
      return true;
    }
    securityHeaders(res, !!entry.frameable);
    res.statusCode = 200;
    res.setHeader('Content-Type', entry.type);
    res.setHeader('Cache-Control', 'no-store');
    res.end(content);
    return true;
  }

  function sessionPayload(req) {
    const cfg = config();
    const target = deployConfig();
    const session = sessionOf(req);
    return {
      configured: cfg.configured,
      missing: core.missingSetupVars(cfg),
      authenticated: !!session,
      user: session ? session.user : '',
      csrf: session ? session.csrf : '',
      setupFile: '.admin-auth',
      autoGenerate: autoGenerate,
      deploy: {
        ready: target.ready,
        reason: target.reason,
        warn: target.warn,
        repo: target.repo,
        branch: target.branch,
        mode: target.mode,
        enabled: target.enabled,
        hasToken: target.hasToken
      }
    };
  }

  /** 读一个白名单字段的当前值；文件缺失或字段不存在时返回空值。 */
  function readFieldValue(field) {
    let value = '';
    try {
      const text = fs.readFileSync(path.join(baseDir, field.file), 'utf8');
      const found = core.getYamlPath(text, field.path);
      value = found === undefined ? '' : found;
    } catch (e) { /* 文件缺失时显示空值 */ }
    if (field.type === 'boolean') value = value === true || value === 'true';
    if (field.type === 'list' && !Array.isArray(value)) value = value ? [String(value)] : [];
    if (field.type === 'number' && value === '') value = '';
    return value;
  }

  /** 普通配置页：不含开关（开关统一在「功能开关」页）。 */
  function configPayload() {
    const groups = [];
    const byGroup = {};
    CONFIG_FIELDS.forEach(function (field) {
      if (field.feature) return;
      const value = readFieldValue(field);
      const item = {
        id: field.id, label: field.label, type: field.type, value: value,
        hint: field.hint || '', file: field.file, path: field.path.join('.')
      };
      if (!byGroup[field.group]) {
        byGroup[field.group] = { name: field.group, fields: [] };
        groups.push(byGroup[field.group]);
      }
      byGroup[field.group].fields.push(item);
    });
    return { groups: groups };
  }

  /** 功能开关页：与 CONFIG_FIELDS 共用同一份白名单，按分组返回布尔开关。 */
  function featurePayload() {
    const groups = [];
    const byGroup = {};
    CONFIG_FIELDS.forEach(function (field) {
      if (!field.feature || field.type !== 'boolean') return;
      const item = {
        id: field.id, label: field.label, hint: field.hint || '',
        value: readFieldValue(field) === true,
        file: field.file, path: field.path.join('.')
      };
      if (!byGroup[field.group]) {
        byGroup[field.group] = { name: field.group, fields: [] };
        groups.push(byGroup[field.group]);
      }
      byGroup[field.group].fields.push(item);
    });
    groups.sort(function (a, b) {
      return FEATURE_GROUP_ORDER.indexOf(a.name) - FEATURE_GROUP_ORDER.indexOf(b.name);
    });
    return { groups: groups, total: groups.reduce(function (n, g) { return n + g.fields.length; }, 0) };
  }

  /** 功能开关页专用：只允许改 feature 白名单里的布尔字段。 */
  function saveFeature(body) {
    const id = String((body && body.id) || '');
    const field = CONFIG_FIELDS.find(function (item) {
      return item.id === id && item.feature && item.type === 'boolean';
    });
    if (!field) throw new Error('没有这个开关。');
    if (typeof body.value !== 'boolean') throw new Error('开关的值只能是开或关。');
    saveConfig({ [field.id]: body.value });
    return field;
  }

  /** 留痕失败不影响主流程：保存成功优先，历史写不进去最多少一条记录。 */
  function safeRevision(input) {
    try { return core.appendRevision(baseDir, input); } catch (e) { return null; }
  }

  /** 展示用值：数组用顿号拼接，布尔说人话，空值给出明确占位。 */
  function displayValue(value) {
    if (Array.isArray(value)) return value.length ? value.join('、') : '（空）';
    if (value === '' || value === undefined || value === null) return '（空）';
    if (typeof value === 'boolean') return value ? '开' : '关';
    return String(value);
  }

  function sameValue(a, b) {
    return JSON.stringify(a === undefined ? '' : a) === JSON.stringify(b === undefined ? '' : b);
  }

  function saveConfig(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('配置内容格式不对。');
    const changed = [];
    const byFile = {};
    CONFIG_FIELDS.forEach(function (field) {
      if (!(field.id in values)) return;
      let value = values[field.id];
      if (field.type === 'boolean') {
        value = value === true || value === 'true';
      } else if (field.type === 'number') {
        const n = Number(value);
        if (!isFinite(n)) throw new Error(field.label + ' 需要是数字。');
        value = Math.floor(n);
      } else if (field.type === 'list') {
        value = Array.isArray(value) ? value : String(value == null ? '' : value).split(/\r?\n/);
        value = value.map(function (item) { return String(item).replace(/[\r\n]+/g, ' ').trim(); })
          .filter(Boolean).slice(0, 30);
        value.forEach(function (item) {
          if (item.length > 200) throw new Error(field.label + ' 单项不能超过 200 字。');
        });
      } else {
        value = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
        if (value.length > 3000) throw new Error(field.label + ' 超过 3000 字。');
      }
      if (!byFile[field.file]) byFile[field.file] = [];
      byFile[field.file].push({ field: field, value: value });
      changed.push(field.id);
    });
    Object.keys(byFile).forEach(function (file) {
      const full = path.join(baseDir, file);
      let text = fs.readFileSync(full, 'utf8');
      const before = text;
      const fields = [];
      byFile[file].forEach(function (item) {
        const oldValue = core.getYamlPath(before, item.field.path);
        text = core.setYamlPath(text, item.field.path, item.value);
        if (!sameValue(oldValue === undefined ? '' : oldValue, item.value)) {
          fields.push({
            key: item.field.id,
            label: item.field.label,
            old: displayValue(oldValue === undefined ? '' : oldValue),
            new: displayValue(item.value)
          });
        }
      });
      if (text !== before) {
        core.backupFile(baseDir, file);
        fs.writeFileSync(full, text, 'utf8');
        // 同一次保存多个字段只记一条，字段明细放进 stats.fields
        const label = fields.length
          ? fields.map(function (item) { return item.label; }).slice(0, 3).join('、') +
            (fields.length > 3 ? ' 等 ' + fields.length + ' 项' : '')
          : file;
        safeRevision({
          action: 'config',
          target: label,
          files: [{ path: file, before: before, after: text }],
          fields: fields
        });
      }
    });
    return changed;
  }

  /** 部署配置留痕只记仓库/分支/开关，Token 不参与展示。 */
  function deployRevisionFields(before, after) {
    let oldValue = {};
    let newValue = {};
    try { oldValue = JSON.parse(before) || {}; } catch (e) { oldValue = {}; }
    try { newValue = JSON.parse(after) || {}; } catch (e) { newValue = {}; }
    const labels = { repo: '仓库地址', branch: '分支', enabled: '允许推送' };
    return ['repo', 'branch', 'enabled'].filter(function (key) {
      return !sameValue(oldValue[key], newValue[key]);
    }).map(function (key) {
      return { key: key, label: labels[key], old: displayValue(oldValue[key]), new: displayValue(newValue[key]) };
    });
  }

  /** 文章展示名用标题，读不到时退回文件名。 */
  function postTitle(rel) {
    try {
      const post = core.readPost(baseDir, rel);
      return post.title || rel;
    } catch (e) { return rel; }
  }


  function jobView(job) {
    if (!job) return null;
    return {
      id: job.id, status: job.status, deploy: job.deploy, auto: job.auto, phase: job.phase,
      startedAt: job.startedAt, endedAt: job.endedAt, log: job.log, branch: job.branch || '',
      conflictFiles: job.conflictFiles || [], conflictCode: job.conflictCode || ''
    };
  }

  /** 保存后的自动生成；正在构建时合并成一次“待生成”，不并发跑 hexo。 */
  function scheduleAutoGenerate() {
    if (!autoGenerate) return { skipped: true, job: null };
    const active = jobs.get(currentJobId);
    if (active && active.status === 'running') {
      pendingAuto = true;
      return { queued: true, job: jobView(active) };
    }
    const result = startJob({ deploy: false, auto: true });
    if (result.busy) {
      pendingAuto = true;
      return { queued: true, job: result.job };
    }
    return { queued: false, job: result.job };
  }

  function startJob(options) {
    options = options || {};
    const wantsDeploy = !!options.deploy;
    const auto = !!options.auto;
    const target = wantsDeploy ? deployConfig() : null;
    if (wantsDeploy && (!target || !target.ready)) {
      return { busy: true, blocked: true, reason: target ? target.reason : '推送未配置。', job: null };
    }

    const active = jobs.get(currentJobId);
    if (active && active.status === 'running') return { busy: true, job: jobView(active) };
    currentJobId = '';

    const id = crypto.randomBytes(8).toString('hex');
    const job = {
      id: id, status: 'running', deploy: wantsDeploy, auto: auto, phase: 'generate',
      startedAt: Date.now(), endedAt: null, log: '', repo: target ? target.repo : '',
      branch: target ? target.branch : '', allowDelete: options.allowDelete === true,
      conflictFiles: [], conflictCode: ''
    };
    jobs.set(id, job);
    currentJobId = id;
    lastJobId = id;
    if (jobs.size > 8) {
      Array.from(jobs.keys()).slice(0, jobs.size - 8).forEach(function (key) {
        if (key !== currentJobId && key !== lastJobId) jobs.delete(key);
      });
    }

    function log(text) {
      job.log += text;
      if (job.log.length > 240000) job.log = '……（前面的日志已省略）\n' + job.log.slice(-200000);
    }

    Promise.resolve()
      .then(function () { return runGenerate({ log: log }); })
      .then(function () {
        if (!wantsDeploy) return null;
        job.phase = 'deploy';
        log('\n$ 推送 public/ 到发布仓库\n');
        return runDeploy({
          repo: target.repo, branch: target.branch, log: log,
          allowDelete: options.allowDelete === true
        });
      })
      .then(function () {
        job.status = 'success';
        job.phase = 'done';
        job.endedAt = Date.now();
        log('\n✓ ' + (wantsDeploy ? '生成并推送完成' : '生成完成') + '\n');
      })
      .catch(function (err) {
        log('\n✗ ' + String((err && err.message) || err) + '\n');
        if (err && err.code === 'DEPLOY_EXTRA_FILES' && Array.isArray(err.files)) {
          job.conflictCode = err.code;
          job.conflictFiles = err.files.slice(0, 500);
        }
        job.status = 'failed';
        job.phase = 'done';
        job.endedAt = Date.now();
      })
      .then(function () {
        currentJobId = '';
        if (pendingAuto) {
          pendingAuto = false;
          startJob({ deploy: false, auto: true });
        }
      });
    return { busy: false, job: jobView(job) };
  }

  return function adminMiddleware(req, res, next) {
    const cfg = config();
    let parsed;
    try { parsed = new URL(req.url || '/', 'http://localhost'); } catch (e) { return next(); }
    const pathname = parsed.pathname;
    if (pathname !== '/admin' && !pathname.startsWith('/admin/')) return next();

    if (!cfg.allowLan && !core.isLoopback(req.socket && req.socket.remoteAddress)) {
      securityHeaders(res);
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('后台只允许本机访问。');
      return;
    }

    if (pathname === '/admin') {
      res.statusCode = 302;
      res.setHeader('Location', '/admin/' + (parsed.search || ''));
      res.end();
      return;
    }

    if (!pathname.startsWith('/admin/api')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        securityHeaders(res);
        res.statusCode = 405;
        res.end('Method Not Allowed');
        return;
      }
      const staticName = pathname.slice('/admin'.length);
      if (sendStatic(req, res, staticName)) return;
      securityHeaders(res);
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('没有这个页面。');
      return;
    }

    const apiPath = pathname.slice('/admin/api'.length) || '/';
    const method = req.method || 'GET';
    const isRead = method === 'GET' || method === 'HEAD';

    if (!checkOrigin(req)) return fail(res, 403, '来源校验失败。');

    if (apiPath === '/session' && isRead) {
      return sendJson(res, 200, sessionPayload(req));
    }

    if (apiPath === '/login' && method === 'POST') {
      if (!cfg.configured) {
        return fail(res, 503, '还没配置管理员账号：请设置 ADMIN_USER 与 ADMIN_PASSWORD，或用 .admin-auth 文件。');
      }
      const ip = String((req.socket && req.socket.remoteAddress) || 'unknown');
      if (rateLimited(ip)) return fail(res, 429, '登录失败次数太多，请 15 分钟后再试。');
      return readBody(req, 8 * 1024).then(function (body) {
        const userOk = core.safeEqual(String(body.username || '').trim(), cfg.user);
        const passOk = core.safeEqual(String(body.password || ''), cfg.password);
        if (!userOk || !passOk) {
          recordFailure(ip);
          return fail(res, 401, '账号或密码不正确。');
        }
        loginFailures.delete(ip);
        const session = createSession(String(body.username || '').trim() || cfg.user);
        securityHeaders(res);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Set-Cookie', cookieHeader(session.token, session.ttlMs, isSecure(req)));
        res.end(JSON.stringify({ ok: true, user: String(body.username || '').trim() || cfg.user, csrf: session.csrf }));
      }).catch(function (err) { fail(res, 400, err.message); });
    }

    if (apiPath === '/logout' && method === 'POST') {
      const token = core.parseCookies(req.headers.cookie)[COOKIE_NAME];
      if (token) sessions.delete(token);
      securityHeaders(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Set-Cookie', cookieHeader('', 0, isSecure(req)) + '; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (!cfg.configured) return fail(res, 503, '后台还没配置管理员账号。');
    const session = requireSession(req, res, true);
    if (!session) return;

    if (apiPath === '/posts' && isRead) {
      return sendJson(res, 200, { posts: core.listPosts(baseDir) });
    }

    if (apiPath === '/posts' && method === 'POST') {
      return readBody(req, 2.5 * 1024 * 1024).then(function (body) {
        const name = core.createPost(baseDir, body);
        try {
          const created = core.resolvePostPath(baseDir, name);
          const text = fs.readFileSync(created.full, 'utf8');
          safeRevision({
            action: 'create',
            target: postTitle(name),
            files: [{ path: name, before: '', after: text }]
          });
        } catch (e) { /* 留痕失败不影响保存 */ }
        const build = scheduleAutoGenerate();
        sendJson(res, 201, { ok: true, name: name, build: build });
      }).catch(function (err) { fail(res, 400, err.message); });
    }

    if (apiPath.indexOf('/posts/') === 0) {
      let rel = '';
      try { rel = decodeURIComponent(apiPath.slice('/posts/'.length)); } catch (e) { return fail(res, 400, '文章路径编码不对。'); }
      try {
        if (isRead) return sendJson(res, 200, core.readPost(baseDir, rel));
        if (method === 'PUT') {
          return readBody(req, 2.5 * 1024 * 1024).then(function (body) {
            let before = '';
            try { before = fs.readFileSync(core.resolvePostPath(baseDir, rel).full, 'utf8'); } catch (e) { before = ''; }
            const title = postTitle(rel);
            const name = core.updatePost(baseDir, rel, body);
            try {
              const text = fs.readFileSync(core.resolvePostPath(baseDir, name).full, 'utf8');
              safeRevision({
                action: 'update',
                target: title,
                files: [{ path: rel, before: before, after: text }]
              });
            } catch (e) { /* 留痕失败不影响保存 */ }
            const build = scheduleAutoGenerate();
            sendJson(res, 200, { ok: true, name: name, build: build });
          }).catch(function (err) {
            if (err.code === 'ENOENT') return fail(res, 404, err.message);
            fail(res, 400, err.message);
          });
        }
        if (method === 'DELETE') {
          let before = '';
          let title = rel;
          try {
            before = fs.readFileSync(core.resolvePostPath(baseDir, rel).full, 'utf8');
            title = postTitle(rel);
          } catch (e) { before = ''; }
          core.deletePost(baseDir, rel);
          try {
            // 删除也要留快照，之后才能「恢复这篇文章」
            safeRevision({
              action: 'delete',
              target: title,
              files: [{ path: rel, before: before, after: null }]
            });
          } catch (e) { /* 留痕失败不影响删除 */ }
          const build = scheduleAutoGenerate();
          return sendJson(res, 200, { ok: true, build: build });
        }
      } catch (err) {
        if (err.code === 'ENOENT') return fail(res, 404, err.message);
        return fail(res, 400, err.message);
      }
      return fail(res, 405, '不支持的方法。');
    }

    if (apiPath === '/config' && isRead) {
      return sendJson(res, 200, configPayload());
    }

    if (apiPath === '/preview' && method === 'POST') {
      return readBody(req, 3 * 1024 * 1024).then(function (body) {
        const text = String(body.body == null ? '' : body.body);
        return Promise.resolve(runMarkdown(text, body.meta || {})).then(function (html) {
          sendJson(res, 200, { html: String(html == null ? '' : html) });
        });
      }).catch(function (err) {
        return fail(res, 400, (err && err.message) || '预览渲染失败。');
      });
    }

    if (apiPath === '/import/md' && method === 'POST') {
      return readBody(req, importer.MAX_MD_BYTES + 64 * 1024).then(function (body) {
        sendJson(res, 200, importer.parseMarkdown(body.text));
      }).catch(function (err) { sendImportFailure(res, err); });
    }

    if (apiPath === '/import/url' && method === 'POST') {
      return readBody(req, 16 * 1024).then(function (body) {
        return importer.convertUrl(body.url, opts.importOptions);
      }).then(function (result) {
        sendJson(res, 200, result);
      }).catch(function (err) { sendImportFailure(res, err); });
    }

    if (apiPath === '/config' && method === 'PUT') {
      return readBody(req, 64 * 1024).then(function (body) {
        const changed = saveConfig(body.values);
        const build = scheduleAutoGenerate();
        sendJson(res, 200, { ok: true, changed: changed, build: build });
      }).catch(function (err) { fail(res, 400, err.message); });
    }

    if (apiPath === '/features' && isRead) {
      return sendJson(res, 200, featurePayload());
    }

    // 开关只写白名单字段；不在这里自动生成，前端会明确提示“需要重新生成”。
    if (apiPath === '/features' && method === 'POST') {
      return readBody(req, 16 * 1024).then(function (body) {
        const field = saveFeature(body);
        sendJson(res, 200, { ok: true, id: field.id, value: body.value });
      }).catch(function (err) { fail(res, 400, err.message); });
    }

    if (apiPath === '/deploy' && isRead) {
      return sendJson(res, 200, { deploy: publicDeploy() });
    }

    if (apiPath === '/deploy' && method === 'PUT') {
      return readBody(req, 16 * 1024).then(function (body) {
        const file = path.join(baseDir, deploy.CONFIG_FILE);
        let before = '';
        try { before = fs.readFileSync(file, 'utf8'); } catch (e) { before = ''; }
        deploy.saveDeployConfig(baseDir, body, env);
        let after = '';
        try { after = fs.readFileSync(file, 'utf8'); } catch (e) { after = ''; }
        if (after && after !== before) {
          safeRevision({
            action: 'deploy',
            target: '部署设置',
            files: [{ path: deploy.CONFIG_FILE, before: before, after: after }],
            fields: deployRevisionFields(before, after)
          });
        }
        sendJson(res, 200, { ok: true, deploy: publicDeploy() });
      }).catch(function (err) { fail(res, 400, err.message); });
    }

    /* ------------------------------------------------------- 修改留痕 */
    // 历史接口统一 no-store（sendJson 已设置），响应只含 bak/admin/revisions/ 里的数据。
    if (apiPath === '/revisions' && isRead) {
      return sendJson(res, 200, core.listRevisions(baseDir, {
        path: parsed.searchParams.get('path') || '',
        action: parsed.searchParams.get('action') || '',
        limit: Number(parsed.searchParams.get('limit')) || 50
      }));
    }

    if (apiPath.indexOf('/revisions/') === 0) {
      let rest = '';
      try { rest = decodeURIComponent(apiPath.slice('/revisions/'.length)); } catch (e) { return fail(res, 400, '记录编号编码不对。'); }
      if (method === 'POST' && /\/restore$/.test(rest)) {
        const id = rest.slice(0, -'/restore'.length);
        return readBody(req, 4 * 1024).then(function () {
          const result = core.restoreRevision(baseDir, id);
          const build = scheduleAutoGenerate();
          sendJson(res, 200, {
            ok: true,
            id: result.record ? result.record.id : '',
            restoreOf: id,
            files: result.files,
            build: build
          });
        }).catch(function (err) {
          if (err.code === 'ENOENT') return fail(res, 404, err.message);
          fail(res, 400, err.message);
        });
      }
      if (isRead) {
        try {
          return sendJson(res, 200, core.readRevision(baseDir, rest));
        } catch (err) {
          if (err.code === 'ENOENT') return fail(res, 404, err.message);
          return fail(res, 400, err.message);
        }
      }
      return fail(res, 405, '不支持的方法。');
    }

    /* ------------------------------------------------------- 源码推送 */
    // GET 只读本地状态：目标仓库/分支、工作区改动、分页的历史提交，不联网。
    if (apiPath === '/source' && isRead) {
      try {
        source.assertRepo(baseDir);
        const payload = source.describe(baseDir, {
          repo: sourceOptions.repo,
          branch: sourceOptions.branch,
          changes: parsed.searchParams.get('changes') !== '0',
          limit: parsed.searchParams.get('limit'),
          offset: parsed.searchParams.get('offset')
        });
        // 恢复弹窗需要先展示目标 SHA；只有显式要 remote=1 时才联网查询。
        if (parsed.searchParams.get('remote') === '1') {
          try {
            payload.remote = {
              ok: true,
              sha: source.remoteBranchSha(baseDir, payload.repo, payload.branch) || ''
            };
          } catch (err) {
            payload.remote = { ok: false, sha: '', error: err.message };
          }
        }
        return sendJson(res, 200, payload);
      } catch (err) {
        return fail(res, err.code === 'SOURCE_NOT_REPO' ? 400 : 500, err.message);
      }
    }

    // 从远端 source 覆盖本地：破坏性操作，先备份再 fetch + reset --hard。
    if (apiPath === '/source/restore' && method === 'POST') {
      if (sourceBusy) return fail(res, 409, '上一次源码操作还没结束，等它完成再试。');
      return readBody(req, 16 * 1024).then(function () {
        sourceBusy = true;
        return source.restoreFromRemote(baseDir, {
          repo: sourceOptions.repo,
          branch: sourceOptions.branch,
          log: function () { /* 日志由返回值带回 */ },
          runGenerate: function (task) { return runGenerate(task); }
        }).then(function (result) {
          sendJson(res, 200, {
            ok: true, restored: true,
            fromSha: result.fromSha, toSha: result.toSha, shortTo: result.shortTo,
            backup: result.backup, retained: result.retained,
            dependencyWarning: result.dependencyWarning, generate: result.generate,
            log: result.log
          });
        }).catch(function (err) {
          const code = err && err.code ? err.code : 'SOURCE_RESTORE_FAILED';
          const status = code === 'SOURCE_NOT_REPO' || code === 'SOURCE_BACKUP_FAILED' ? 500 : 502;
          sendJson(res, status, {
            ok: false,
            error: { code: code, message: (err && err.message) || '恢复失败。' },
            restored: false,
            backup: (err && err.backup) || null,
            fromSha: (err && err.fromSha) || '',
            log: (err && err.log) || '',
            raw: (err && err.raw) || ''
          });
        }).then(function () { sourceBusy = false; });
      }).catch(function (err) { fail(res, 400, err.message); });
    }

    if (apiPath === '/source/commit' && method === 'POST') {
      if (sourceBusy) return fail(res, 409, '上一次源码提交还没结束，等它完成再试。');
      return readBody(req, 16 * 1024).then(function (body) {
        sourceBusy = true;
        let log = '';
        return source.commitAndPush(baseDir, body && body.message, {
          repo: sourceOptions.repo,
          branch: sourceOptions.branch,
          log: function (text) { log += text; }
        }).then(function (result) {
          sendJson(res, 200, {
            ok: true, committed: true, pushed: true,
            commit: result.commit, files: result.files, log: result.log
          });
        }).catch(function (err) {
          // commit 成功但推送失败要单独说清楚，不能混成一个“失败”。
          const code = err && err.code ? err.code : 'SOURCE_FAILED';
          let status = 500;
          if (code === 'SOURCE_EMPTY' || code === 'SOURCE_MESSAGE_REQUIRED' ||
              code === 'SOURCE_MESSAGE_TOO_LONG' || code === 'SOURCE_MESSAGE_INVALID' ||
              code === 'SOURCE_FORBIDDEN' || code === 'SOURCE_NOT_REPO') status = 400;
          else if (code === 'SOURCE_REMOTE_AHEAD') status = 409;
          else if (code === 'SOURCE_PUSH_FAILED' || code === 'SOURCE_REMOTE_UNREACHABLE' ||
              code === 'SOURCE_TIMEOUT' || code === 'SOURCE_GIT_FAILED') status = 502;
          sendJson(res, status, {
            ok: false,
            error: { code: code, message: (err && err.message) || '源码提交失败。' },
            committed: !!(err && err.committed),
            pushed: false,
            commit: (err && err.commit) || '',
            files: (err && err.files) || [],
            log: (err && err.log) || log,
            raw: (err && err.raw) || ''
          });
        });
      }).catch(function (err) { fail(res, 400, err.message); }).then(function () {
        sourceBusy = false;
      });
    }

    /* --------------------------------------------------------- 一键打包 */
    // GET 只读：可选模式 + 上次生成记录（都在 backup/package/.last.json）。
    if (apiPath === '/package' && isRead) {
      try {
        return sendJson(res, 200, packager.describe(baseDir));
      } catch (err) {
        return fail(res, 500, err.message);
      }
    }

    // POST：同步打包（复制 + 压缩），期间 packageBusy 挡住并发请求。
    if (apiPath === '/package' && method === 'POST') {
      if (packageBusy) return fail(res, 409, '上一次打包还没结束，等它完成再试。');
      packageBusy = true;
      return readBody(req, 16 * 1024).then(function (body) {
        return packager.createPackage(baseDir, {
          mode: body && body.mode,
          compressor: packageOptions.compressor,
          home: packageOptions.home,
          log: function () { /* 进度由返回值带回 */ }
        }).then(function (result) {
          sendJson(res, 200, result);
        }).catch(function (err) {
          const code = err && err.code ? err.code : 'PACKAGE_FAILED';
          const status = code === 'PACKAGE_INVALID_MODE' ? 400
            : code === 'PACKAGE_BUSY' ? 409
              : code === 'PACKAGE_NO_PROJECT' ? 400 : 500;
          sendJson(res, status, {
            ok: false,
            error: { code: code, message: (err && err.message) || '打包失败。' }
          });
        }).then(function () { packageBusy = false; });
      }).catch(function (err) {
        packageBusy = false;
        fail(res, 400, err.message);
      });
    }

    /* --------------------------------------------------------- SSH 快捷面板 */
    // GET 只读：只报告私钥/公钥是否存在、公钥全文与指纹，绝不读私钥。
    if (apiPath === '/ssh' && isRead) {
      try {
        return sendJson(res, 200, ssh.describe({ home: sshOptions.home }));
      } catch (err) {
        return fail(res, 500, err.message);
      }
    }

    // POST：生成 ed25519；目标文件存在就拒绝（409），绝不覆盖。
    if (apiPath === '/ssh/keygen' && method === 'POST') {
      if (sshBusy) return fail(res, 409, '上一次 SSH 操作还没结束，等它完成再试。');
      sshBusy = true;
      return readBody(req, 8 * 1024).then(function () {
        return ssh.generateKey({
          home: sshOptions.home,
          runKeygen: sshOptions.runKeygen
        }).then(function (result) {
          sendJson(res, 200, Object.assign({ ok: true }, result));
        }).catch(function (err) {
          const code = err && err.code ? err.code : 'SSH_KEYGEN_FAILED';
          const status = code === 'SSH_KEY_EXISTS' ? 409 : 500;
          sendJson(res, status, {
            ok: false,
            error: { code: code, message: (err && err.message) || '生成密钥失败。' }
          });
        }).then(function () { sshBusy = false; });
      }).catch(function (err) {
        sshBusy = false;
        fail(res, 400, err.message);
      });
    }

    // POST：执行 ssh -T 并分类；认证失败也返回 200 + 分类结果，不是只给退出码。
    if (apiPath === '/ssh/test' && method === 'POST') {
      if (sshBusy) return fail(res, 409, '上一次 SSH 操作还没结束，等它完成再试。');
      sshBusy = true;
      return readBody(req, 8 * 1024).then(function () {
        return ssh.testConnection({
          home: sshOptions.home,
          runTest: sshOptions.runTest,
          timeoutMs: sshOptions.timeoutMs
        }).then(function (result) {
          sendJson(res, 200, Object.assign({ ok: result.ok }, result));
        }).catch(function (err) {
          sendJson(res, 500, {
            ok: false,
            error: { code: (err && err.code) || 'SSH_TEST_FAILED', message: (err && err.message) || 'SSH 测试失败。' }
          });
        }).then(function () { sshBusy = false; });
      }).catch(function (err) {
        sshBusy = false;
        fail(res, 400, err.message);
      });
    }

    /* --------------------------------------------------------- 图床（OSS） */
    // GET 只读配置；未配置时也返回 200，前端展示引导文案。
    if (apiPath === '/oss/config' && isRead) {
      try {
        return sendJson(res, 200, oss.describe(baseDir, ossEnv));
      } catch (err) {
        return fail(res, 500, err.message);
      }
    }

    // PUT：secret 留空表示保留原值；写入 .admin-oss.json（0600）。
    if (apiPath === '/oss/config' && method === 'PUT') {
      return readBody(req, 64 * 1024).then(function (body) {
        try {
          sendJson(res, 200, oss.saveConfig(baseDir, body, ossEnv));
        } catch (err) {
          sendOssFailure(res, err);
        }
      }).catch(function (err) {
        if (err && err.code) return sendOssFailure(res, err);
        fail(res, 400, err.message);
      });
    }

    // POST：base64 上传；服务端签名，AK 不下发浏览器。
    if (apiPath === '/oss/upload' && method === 'POST') {
      if (ossBusy) return fail(res, 409, '上一张图片还在上传，请稍候。');
      ossBusy = true;
      return readBody(req, 16 * 1024 * 1024).then(function (body) {
        return oss.uploadImage(baseDir, body, {
          env: ossEnv,
          request: ossOptions.request,
          probeDomain: ossOptions.probeDomain,
          now: ossOptions.now
        }).then(function (result) {
          sendJson(res, 200, result);
        }).catch(function (err) {
          sendOssFailure(res, err);
        }).then(function () { ossBusy = false; });
      }).catch(function (err) {
        ossBusy = false;
        if (err && err.code) return sendOssFailure(res, err);
        fail(res, 400, err.message);
      });
    }

    // POST：上传 1×1 测试图并删除；只用于验证 AK/Bucket/Region 组合是否正确。
    if (apiPath === '/oss/test' && method === 'POST') {
      if (ossBusy) return fail(res, 409, '图床正在忙，请稍后再测试。');
      ossBusy = true;
      return readBody(req, 8 * 1024).then(function () {
        return oss.testConnection(baseDir, {
          env: ossEnv,
          request: ossOptions.request
        }).then(function (result) {
          sendJson(res, 200, result);
        }).catch(function (err) {
          sendOssFailure(res, err);
        }).then(function () { ossBusy = false; });
      }).catch(function (err) {
        ossBusy = false;
        if (err && err.code) return sendOssFailure(res, err);
        fail(res, 400, err.message);
      });
    }

    // GET：列出 OSS 里的图片，marker 分页；customDomain 不可用时自动回退默认域名。
    if (apiPath === '/oss/objects' && isRead) {
      return oss.listObjects(baseDir, {
        prefix: parsed.searchParams.get('prefix') || '',
        marker: parsed.searchParams.get('marker') || '',
        limit: parsed.searchParams.get('limit') || '',
        search: parsed.searchParams.get('search') || ''
      }, {
        env: ossEnv,
        request: ossOptions.request,
        probeDomain: ossOptions.probeDomain
      }).then(function (result) {
        sendJson(res, 200, result);
      }).catch(function (err) {
        sendOssFailure(res, err);
      });
    }

    // POST：批量删除；返回每个 key 的成功/失败明细。
    if (apiPath === '/oss/delete' && method === 'POST') {
      if (ossBusy) return fail(res, 409, '图床正在忙，请稍后再删除。');
      ossBusy = true;
      return readBody(req, 256 * 1024).then(function (body) {
        return oss.deleteObjects(baseDir, body, {
          env: ossEnv,
          request: ossOptions.request
        }).then(function (result) {
          sendJson(res, 200, result);
        }).catch(function (err) {
          sendOssFailure(res, err);
        }).then(function () { ossBusy = false; });
      }).catch(function (err) {
        ossBusy = false;
        if (err && err.code) return sendOssFailure(res, err);
        fail(res, 400, err.message);
      });
    }

    if (apiPath === '/publish' && isRead) {
      return sendJson(res, 200, { job: jobView(jobs.get(lastJobId) || null), deploy: publicDeploy() });
    }

    if (apiPath === '/publish' && method === 'POST') {
      return readBody(req, 8 * 1024).then(function (body) {
        const wantsDeploy = !!body.deploy;
        if (wantsDeploy) {
          const target = deployConfig();
          if (!target.ready) return fail(res, 409, target.reason || '推送未配置。');
        }
        const result = startJob({ deploy: wantsDeploy, allowDelete: body.allowDelete === true });
        if (result.blocked) return fail(res, 409, result.reason || '推送未配置。');
        if (result.busy) return fail(res, 409, '已有构建任务在跑，等它结束。');
        sendJson(res, 202, { ok: true, job: result.job });
      }).catch(function (err) { fail(res, 400, err.message); });
    }

    if (apiPath.indexOf('/publish/') === 0 && isRead) {
      const id = apiPath.slice('/publish/'.length);
      const job = jobs.get(id);
      if (!job) return fail(res, 404, '没有这个构建任务。');
      return sendJson(res, 200, { job: jobView(job) });
    }

    return fail(res, 404, '没有这个接口。');
  };
}

/** 默认生成器：执行 hexo generate，把输出交给调用方。推送由 deploy.js 单独处理。 */
function createHexoRunner(baseDir) {
  return function runGenerate(task) {
    return new Promise(function (resolve, reject) {
      const bin = path.join(baseDir, 'node_modules', 'hexo', 'bin', 'hexo');
      if (!fs.existsSync(bin)) return reject(new Error('找不到 hexo：' + bin));
      task.log('\n$ hexo generate\n');
      let tail = '';
      function collect(chunk) {
        const text = String(chunk);
        task.log(text);
        // 只留最后一小段，失败时把原始报错带回前端，避免只看到一个退出码。
        tail = (tail + text).slice(-2000);
      }
      const child = spawn(process.execPath, [bin, 'generate'], {
        cwd: baseDir,
        env: process.env,
        windowsHide: true
      });
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', function (err) {
        reject(new Error('hexo generate 启动失败：' + err.message));
      });
      child.on('close', function (code) {
        if (code === 0) return resolve();
        const detail = tail.trim();
        reject(new Error('hexo generate 退出码 ' + code + (detail ? '\n' + detail : '')));
      });
    });
  };
}

module.exports = createAdminServer;
module.exports.CONFIG_FIELDS = CONFIG_FIELDS;
module.exports.createHexoRunner = createHexoRunner;
