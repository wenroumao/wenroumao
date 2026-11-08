'use strict';
/**
 * 后台前端：登录、文章列表与编辑、Markdown 实时预览、配置、生成与推送。
 * 只调用同源 /admin/api/*，不缓存任何密钥。
 */

const API = '/admin/api';

const state = {
  bound: false,
  session: null,
  posts: [],
  filter: 'all',
  query: '',
  editing: null,
  dirty: false,
  pane: 'split',
  previewReady: false,
  previewTimer: null,
  previewRetry: null,
  previewTries: 0,
  pendingHtml: '',
  jobTimer: null,
  jobId: null,
  conflictShownFor: '',
  syncingScroll: false,
  configGroups: [],
  features: [],
  deploy: null,
  history: { items: [], paths: [], path: '', action: '' },
  source: { info: null, offset: 0, hasMore: false, busy: false },
  package: { modes: [], last: null, selected: 'full', busy: false },
  ssh: { info: null, busy: false },
  oss: {
    info: null, busy: false, results: [], queue: 0, done: 0,
    objects: [], selection: {}, nextMarker: '', hasMore: false,
    listBusy: false, deleteBusy: false, domain: null, search: ''
  }
};

function $(id) { return document.getElementById(id); }

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ 网络 */

async function api(path, options) {
  options = options || {};
  const headers = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.csrf && state.session) headers['X-CSRF-Token'] = state.session.csrf;
  const res = await fetch(API + path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: { message: text } }; }
  if (!res.ok) {
    if (res.status === 401 && options.auth !== false) {
      showLogin();
    }
    const err = new Error((data.error && data.error.message) || ('请求失败：' + res.status));
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------------ 提示 */

let toastTimer = null;
function toast(message, kind) {
  const node = $('toast');
  node.textContent = message;
  node.className = 'toast' + (kind ? ' toast-' + kind : '');
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { node.hidden = true; }, kind === 'error' ? 6000 : 3200);
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let modalResolve = null;
function confirmModal(opts) {
  opts = opts || {};
  $('modal-title').textContent = opts.title || '确认操作';
  const text = $('modal-text');
  if (opts.html) text.innerHTML = opts.html;
  else text.textContent = opts.text || '';
  const ok = $('modal-ok');
  ok.textContent = opts.confirmText || '确认';
  ok.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');
  $('modal').hidden = false;
  ok.focus();
  return new Promise(function (resolve) { modalResolve = resolve; });
}

function closeModal(result) {
  if ($('modal').hidden) return;
  $('modal').hidden = true;
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(!!result);
}

/* ------------------------------------------------------------------ 主题 */

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('admin-theme', next); } catch (e) { /* 忽略 */ }
  $('theme-label').textContent = next === 'dark' ? '浅色' : '深色';
  const frame = $('preview-frame');
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage({ type: 'preview-theme', theme: next }, '*');
  }
}

function initTheme() {
  let saved = '';
  try { saved = localStorage.getItem('admin-theme') || ''; } catch (e) { saved = ''; }
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

/* ------------------------------------------------------------ 页面切换 */

function showBoot(text) {
  $('boot').hidden = false;
  if (text) $('boot-text').textContent = text;
  $('setup').hidden = true;
  $('login').hidden = true;
  $('shell').hidden = true;
}

function showSetup() {
  $('boot').hidden = true;
  $('setup').hidden = false;
  $('login').hidden = true;
  $('shell').hidden = true;
}

function showLogin() {
  $('boot').hidden = true;
  $('setup').hidden = true;
  $('login').hidden = false;
  $('shell').hidden = true;
  $('login-error').hidden = true;
  $('login-pass').value = '';
  setTimeout(function () { $('login-user').focus(); }, 40);
}

function showShell() {
  $('boot').hidden = true;
  $('setup').hidden = true;
  $('login').hidden = true;
  $('shell').hidden = false;
}

const VIEW_META = {
  posts: { kicker: 'Articles', title: '文章' },
  editor: { kicker: 'Editor', title: '编辑文章' },
  config: { kicker: 'Settings', title: '站点配置' },
  features: { kicker: 'Switches', title: '功能开关' },
  history: { kicker: 'Revisions', title: '修改历史' },
  source: { kicker: 'Source', title: '源码' },
  package: { kicker: 'Package', title: '一键打包' },
  ssh: { kicker: 'SSH', title: 'SSH 密钥' },
  oss: { kicker: 'Image host', title: '图床' },
  publish: { kicker: 'Publish', title: '生成与推送' }
};

async function switchView(name, force) {
  if (!force && name !== 'editor' && state.dirty) {
    const ok = await confirmModal({
      title: '有未保存的修改',
      text: '离开编辑页会丢弃当前改动，确定要离开吗？',
      confirmText: '丢弃并离开'
    });
    if (!ok) return;
    state.dirty = false;
    updateDirtyUI();
  }
  ['posts', 'editor', 'config', 'features', 'history', 'source', 'package', 'ssh', 'oss', 'publish'].forEach(function (view) {
    $('view-' + view).hidden = view !== name;
  });
  document.querySelectorAll('.nav-item').forEach(function (btn) {
    btn.classList.toggle('is-active', btn.dataset.view === name);
  });
  const meta = VIEW_META[name] || VIEW_META.posts;
  $('view-kicker').textContent = meta.kicker;
  $('view-title').textContent = meta.title;
  $('btn-new').hidden = name !== 'posts';
  $('topbar-sub').textContent = '';
  if (name === 'posts') loadPosts();
  if (name === 'config') loadConfig();
  if (name === 'features') loadFeatures();
  if (name === 'history') loadHistory();
  if (name === 'source') loadSource();
  if (name === 'package') loadPackage();
  if (name === 'ssh') loadSsh();
  if (name === 'oss') loadOss();
  if (name === 'publish') loadPublish();
}

/* ------------------------------------------------------------------ 登录 */

async function boot() {
  if (!state.bound) bind();
  showBoot();
  try {
    const session = await api('/session', { auth: false });
    if (!session.configured) {
      showSetup();
      return;
    }
    if (!session.authenticated) {
      showLogin();
      return;
    }
    enter(session);
  } catch (err) {
    showBoot('后台连接失败：' + err.message);
  }
}

function enter(session) {
  state.session = session;
  showShell();
  $('brand-user').textContent = session.user || '本地';
  switchView('posts', true);
  resumeJob();
}

async function resumeJob() {
  try {
    const data = await api('/publish');
    if (data.job) {
      renderJob(data.job);
      if (data.job.status === 'running') pollJob(data.job.id);
    }
  } catch (e) { /* 忽略 */ }
}

/* --------------------------------------------------------------- 文章列表 */

async function loadPosts() {
  try {
    const data = await api('/posts');
    state.posts = data.posts || [];
    renderPosts();
  } catch (err) {
    if (err.status !== 401) toast('读取文章失败：' + err.message, 'error');
  }
}

function matches(post) {
  const q = state.query.trim().toLowerCase();
  if (state.filter === 'published' && !post.published) return false;
  if (state.filter === 'draft' && post.published) return false;
  if (!q) return true;
  const hay = [post.title, post.name, post.description]
    .concat(post.categories || [], post.tags || []).join(' ').toLowerCase();
  return hay.indexOf(q) >= 0;
}

function renderPosts() {
  const list = $('post-list');
  list.textContent = '';
  const rows = state.posts.filter(matches);
  $('post-count').textContent = rows.length + ' / ' + state.posts.length + ' 篇';

  rows.forEach(function (post, index) {
    const row = el('article', 'post-row');
    row.dataset.name = post.name;
    row.style.setProperty('--i', String(Math.min(index, 12)));

    const main = el('button', 'post-main');
    main.type = 'button';
    main.dataset.action = 'open';
    main.appendChild(el('h3', 'post-title', post.title || post.name));
    const meta = el('div', 'post-meta');
    if (!post.published) meta.appendChild(el('span', 'badge badge-draft', '草稿'));
    if (post.date) meta.appendChild(el('span', 'meta-item', post.date));
    if (post.categories && post.categories.length) {
      meta.appendChild(el('span', 'meta-item', post.categories.join(' · ')));
    }
    meta.appendChild(el('span', 'meta-item meta-dim', post.name));
    main.appendChild(meta);
    row.appendChild(main);

    const actions = el('div', 'post-actions');
    const edit = el('button', 'ghost-btn', '编辑');
    edit.type = 'button';
    edit.dataset.action = 'open';
    const del = el('button', 'ghost-btn ghost-danger', '删除');
    del.type = 'button';
    del.dataset.action = 'delete';
    actions.appendChild(edit);
    actions.appendChild(del);
    row.appendChild(actions);

    list.appendChild(row);
  });

  $('posts-empty').hidden = rows.length > 0;
  $('topbar-sub').textContent = state.posts.length ? '共 ' + state.posts.length + ' 篇' : '';
}

async function deletePostByName(name) {
  const post = state.posts.find(function (item) { return item.name === name; });
  const title = post ? post.title : name;
  const ok = await confirmModal({
    title: '删除文章',
    text: '确定删除《' + title + '》吗？文件会被移除并备份到 bak/admin，随后自动重新生成。',
    confirmText: '删除'
  });
  if (!ok) return;
  try {
    const data = await api('/posts/' + encodeURIComponent(name), { method: 'DELETE', csrf: true });
    toast('已删除《' + title + '》', 'ok');
    if (state.editing && state.editing.name === name) {
      state.editing = null;
      state.dirty = false;
      switchView('posts', true);
    }
    await loadPosts();
    if (data.build) watchJob(data.build.job, data.build.queued);
  } catch (err) {
    toast('删除失败：' + err.message, 'error');
  }
}

/* ------------------------------------------------------------------ 编辑器 */

function nowString() {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function setDirty(value) {
  state.dirty = value;
  updateDirtyUI();
}

function updateDirtyUI() {
  $('editor-dirty').hidden = !state.dirty;
  $('editor-save-state').textContent = state.dirty ? '有未保存的修改' : '';
}

function fillEditor(post) {
  $('editor-title').value = post.title || '';
  $('editor-date').value = post.date || nowString();
  $('editor-categories').value = (post.categories || []).join(', ');
  $('editor-tags').value = (post.tags || []).join(', ');
  $('editor-cover').value = post.cover || '';
  $('editor-description').value = post.description || '';
  $('editor-draft').checked = post.published === false;
  $('editor-comments').checked = post.comments !== false;
  $('editor-body').value = post.body || '';
  updateStats();
  resetMdHistory();
}

async function openEditor(name) {
  if (state.dirty) {
    const ok = await confirmModal({
      title: '有未保存的修改',
      text: '切换文章会丢弃当前改动，确定继续吗？',
      confirmText: '丢弃改动'
    });
    if (!ok) return;
  }
  state.dirty = false;
  if (name) {
    try {
      const post = await api('/posts/' + encodeURIComponent(name));
      state.editing = { name: post.name, isNew: false };
      fillEditor(post);
    } catch (err) {
      toast('打开失败：' + err.message, 'error');
      return;
    }
  } else {
    state.editing = { name: '', isNew: true };
    fillEditor({ title: '', date: nowString(), published: true, comments: true, body: '' });
  }
  updateDirtyUI();
  $('editor-save-state').textContent = '';
  $('preview-frame').src = '/admin/preview';
  state.previewReady = false;
  state.previewTries = 0;
  await switchView('editor', true);
  setPane('split');
  schedulePreview(true);
  $('editor-title').focus();
}

function setPane(pane) {
  state.pane = pane;
  $('editor-panes').dataset.pane = pane;
  document.querySelectorAll('.seg-btn').forEach(function (btn) {
    btn.classList.toggle('is-active', btn.dataset.pane === pane);
  });
  if (pane !== 'edit') schedulePreview(true);
  updateStats();
}

function editorPayload() {
  return {
    title: $('editor-title').value.trim(),
    date: $('editor-date').value.trim(),
    categories: $('editor-categories').value,
    tags: $('editor-tags').value,
    cover: $('editor-cover').value.trim(),
    description: $('editor-description').value.trim(),
    comments: $('editor-comments').checked,
    published: !$('editor-draft').checked,
    body: $('editor-body').value
  };
}

/* ------------------------------------------------------------ 导出（三期） */

function formatBytes(size) {
  const value = Number(size) || 0;
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(2) + ' MB';
}

function triggerDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
}

function exportFilename(disposition, fallback) {
  if (!disposition) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try { return decodeURIComponent(star[1]); } catch (err) { /* 继续尝试 */ }
  }
  const plain = /filename="([^"]+)"/i.exec(disposition);
  return plain ? plain[1] : fallback;
}

function requireExportTitle(payload) {
  if (payload.title) return true;
  toast('先填写文章标题再导出。', 'error');
  $('editor-title').focus();
  return false;
}

async function exportMarkdownFile() {
  const payload = editorPayload();
  if (!requireExportTitle(payload)) return;
  try {
    const data = await api('/export/md', { method: 'POST', body: payload, csrf: true });
    triggerDownload(data.filename, new Blob([data.markdown], { type: 'text/markdown;charset=utf-8' }));
    toast('已导出 ' + data.filename, 'ok');
  } catch (err) {
    toast('导出 Markdown 失败：' + err.message, 'error');
  }
}

async function exportWordFile() {
  const payload = editorPayload();
  if (!requireExportTitle(payload)) return;
  const btn = $('export-word');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在生成…';
  try {
    const res = await fetch(API + '/export/docx', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.session.csrf },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      let message = '导出失败：' + res.status;
      try {
        const data = JSON.parse(await res.text());
        if (data.error && data.error.message) message = data.error.message;
      } catch (err) { /* 保留默认文案 */ }
      if (res.status === 401) showLogin();
      throw new Error(message);
    }
    const blob = await res.blob();
    let warnings = [];
    try { warnings = JSON.parse(decodeURIComponent(res.headers.get('X-Export-Warnings') || '[]')); } catch (err) { warnings = []; }
    const filename = exportFilename(res.headers.get('Content-Disposition'), (payload.title || '文章') + '.docx');
    triggerDownload(filename, blob);
    const size = Number(res.headers.get('X-Export-Size')) || blob.size;
    if (warnings.length) {
      toast('已导出 ' + formatBytes(size) + '，图片提示：' + warnings.join('；'), 'error');
    } else {
      toast('已导出 ' + filename + '（' + formatBytes(size) + '）', 'ok');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function openPrintPage() {
  const payload = editorPayload();
  if (!requireExportTitle(payload)) return;
  let html = '';
  try {
    const data = await api('/preview', { method: 'POST', body: { body: payload.body }, csrf: true });
    html = data.html || '';
  } catch (err) {
    toast('渲染正文失败：' + err.message, 'error');
    return;
  }
  const key = 'admin.print.' + Date.now().toString(36) + '.' + Math.random().toString(36).slice(2, 8);
  try {
    prunePrintCache();
    localStorage.setItem(key, JSON.stringify({
      title: payload.title,
      date: payload.date,
      categories: payload.categories,
      html: html
    }));
  } catch (err) {
    toast('打印内容过大，浏览器无法暂存：' + err.message, 'error');
    return;
  }
  const win = window.open('/admin/print#' + key, '_blank');
  if (!win) {
    try { localStorage.removeItem(key); } catch (err) { /* 忽略 */ }
    toast('浏览器拦截了新窗口，请允许本站弹出窗口后重试。', 'error');
    return;
  }
  toast('已打开打印预览，在新页面点「打印 / 另存为 PDF」即可。', 'ok');
}

/** 清理一小时前没被打印页取走的临时内容，避免 localStorage 里堆积正文。 */
function prunePrintCache() {
  const expire = Date.now() - 60 * 60 * 1000;
  const stale = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('admin.print.')) continue;
    const stamp = parseInt(key.split('.')[2] || '', 36);
    if (!stamp || stamp < expire) stale.push(key);
  }
  stale.forEach(function (key) { localStorage.removeItem(key); });
}

async function saveEditor() {
  if (!state.editing) return;
  const payload = editorPayload();
  if (!payload.title) {
    toast('标题不能为空。', 'error');
    $('editor-title').focus();
    return;
  }
  const btn = $('editor-save');
  btn.disabled = true;
  $('editor-save-state').textContent = '正在保存…';
  try {
    let data;
    if (state.editing.isNew) {
      data = await api('/posts', { method: 'POST', body: payload, csrf: true });
      state.editing = { name: data.name, isNew: false };
    } else {
      data = await api('/posts/' + encodeURIComponent(state.editing.name), { method: 'PUT', body: payload, csrf: true });
      state.editing = { name: data.name, isNew: false };
    }
    setDirty(false);
    $('editor-save-state').textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    toast('已保存，正在重新生成…', 'ok');
    watchJob(data.build && data.build.job, data.build && data.build.queued);
    loadPosts();
    schedulePreview(true);
  } catch (err) {
    $('editor-save-state').textContent = '保存失败';
    toast('保存失败：' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function leaveEditor() {
  if (state.dirty) {
    const ok = await confirmModal({
      title: '有未保存的修改',
      text: '返回列表会丢弃当前改动，确定要离开吗？',
      confirmText: '丢弃并返回'
    });
    if (!ok) return;
  }
  state.dirty = false;
  state.editing = null;
  updateDirtyUI();
  switchView('posts', true);
}

/* -------------------------------------------------------------- Markdown 预览 */

function schedulePreview(immediate) {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(renderPreview, immediate ? 0 : 340);
}

async function renderPreview() {
  const body = $('editor-body').value;
  try {
    const data = await api('/preview', { method: 'POST', body: { body: body }, csrf: true });
    state.pendingHtml = data.html || '';
    pushPreview();
  } catch (err) {
    if (err.status !== 401) toast('预览渲染失败：' + err.message, 'error');
  }
}

/**
 * 预览 iframe 的 ready 消息可能在父页绑定监听之前就发出，
 * 所以不能只依赖 postMessage，还要用 readyState 兜底判断。
 */
function previewFrameReady() {
  if (state.previewReady) return true;
  const frame = $('preview-frame');
  if (!frame) return false;
  try {
    const doc = frame.contentDocument;
    if (doc && doc.readyState === 'complete' && doc.querySelector('#article-container')) {
      state.previewReady = true;
      return true;
    }
  } catch (e) {
    /* 跨域或尚未加载 */
  }
  return false;
}

function pushPreview() {
  const frame = $('preview-frame');
  if (!frame || !frame.contentWindow) return;
  const ready = previewFrameReady();
  frame.contentWindow.postMessage({
    type: 'preview-render', html: state.pendingHtml, theme: currentTheme()
  }, '*');
  clearTimeout(state.previewRetry);
  if (!ready && state.previewTries < 40) {
    state.previewTries += 1;
    state.previewRetry = setTimeout(pushPreview, 150);
  }
}

function updateStats() {
  const text = $('editor-body').value;
  const chars = text.replace(/\s/g, '').length;
  const lines = text ? text.split('\n').length : 0;
  const minutes = Math.max(1, Math.round(chars / 300));
  $('editor-stats').textContent = chars + ' 字 · ' + lines + ' 行 · 约 ' + minutes + ' 分钟';
}

/* ------------------------------------------------------------ 导入（一期） */

const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

function confirmImportOverwrite() {
  return confirmModal({
    title: '导入会覆盖当前编辑内容',
    text: '当前编辑器里的标题、正文与其它字段都会被导入内容替换。确定继续吗？',
    confirmText: '覆盖并导入'
  });
}

/** 把后端解析好的字段填进编辑器；没给的字段保持原样。 */
function applyImportedPost(data, sourceLabel) {
  if (data.title) $('editor-title').value = data.title;
  if (data.date) $('editor-date').value = data.date;
  if (data.categories && data.categories.length) $('editor-categories').value = data.categories.join(', ');
  if (data.tags && data.tags.length) $('editor-tags').value = data.tags.join(', ');
  if (data.cover) $('editor-cover').value = data.cover;
  if (data.description) $('editor-description').value = data.description;
  if (typeof data.comments === 'boolean') $('editor-comments').checked = data.comments;
  if (typeof data.published === 'boolean') $('editor-draft').checked = !data.published;
  $('editor-body').value = data.body || '';
  setDirty(true);
  updateStats();
  schedulePreview(true);

  const warnings = data.warnings || [];
  if (warnings.length) toast((sourceLabel || '导入') + '：' + warnings[0], 'error');
  else toast((sourceLabel || '导入') + ' 已导入。', 'ok');
}

async function importMarkdownFile(file) {
  if (!file) return;
  const nameOk = /\.(md|markdown)$/i.test(file.name) || String(file.type || '').indexOf('markdown') >= 0;
  if (!nameOk) {
    toast('只支持 .md / .markdown 文件。', 'error');
    return;
  }
  if (file.size > IMPORT_MAX_BYTES) {
    toast('文件超过 2 MB（' + (file.size / 1024 / 1024).toFixed(1) + ' MB），请拆分后再导入。', 'error');
    return;
  }
  if (!(await confirmImportOverwrite())) return;

  let text = '';
  try {
    text = await file.text();
  } catch (err) {
    toast('读取文件失败：' + err.message, 'error');
    return;
  }
  try {
    const data = await api('/import/md', { method: 'POST', body: { text: text }, csrf: true });
    applyImportedPost(data, file.name);
  } catch (err) {
    toast('导入失败：' + err.message, 'error');
  }
}

function openUrlModal() {
  $('url-input').value = '';
  const hint = $('url-hint');
  hint.textContent = '';
  hint.classList.remove('is-error');
  $('url-ok').disabled = false;
  $('url-modal').hidden = false;
  $('url-input').focus();
}

function closeUrlModal() {
  $('url-modal').hidden = true;
}

async function submitUrlImport() {
  const url = $('url-input').value.trim();
  const hint = $('url-hint');
  hint.classList.remove('is-error');
  if (!/^https?:\/\//i.test(url)) {
    hint.textContent = '需要完整的 http:// 或 https:// 地址。';
    hint.classList.add('is-error');
    return;
  }
  if (!(await confirmImportOverwrite())) return;

  const btn = $('url-ok');
  btn.disabled = true;
  hint.textContent = '正在抓取并转换，最多等 15 秒…';
  try {
    const data = await api('/import/url', { method: 'POST', body: { url: url }, csrf: true });
    closeUrlModal();
    applyImportedPost({
      title: data.title,
      body: data.markdown,
      warnings: data.warnings
    }, '网页导入');
  } catch (err) {
    hint.textContent = err.message;
    hint.classList.add('is-error');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------- 编辑器工具（二期） */

const MD_HISTORY_LIMIT = 60;
const mdHistory = { states: [], index: -1, muted: false };

function editorTextarea() { return $('editor-body'); }

function resetMdHistory() {
  mdHistory.states = [];
  mdHistory.index = -1;
  mdHistory.muted = false;
  pushMdHistory();
}

function pushMdHistory() {
  if (mdHistory.muted) return;
  const ta = editorTextarea();
  const last = mdHistory.states[mdHistory.index];
  if (last && last.value === ta.value) {
    last.start = ta.selectionStart;
    last.end = ta.selectionEnd;
    return;
  }
  mdHistory.states = mdHistory.states.slice(0, mdHistory.index + 1);
  mdHistory.states.push({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd });
  if (mdHistory.states.length > MD_HISTORY_LIMIT) mdHistory.states.shift();
  mdHistory.index = mdHistory.states.length - 1;
}

function restoreMdHistory(target) {
  if (target < 0 || target >= mdHistory.states.length) return;
  const snapshot = mdHistory.states[target];
  const ta = editorTextarea();
  mdHistory.muted = true;
  ta.value = snapshot.value;
  mdHistory.index = target;
  ta.focus();
  ta.setSelectionRange(Math.min(snapshot.start, ta.value.length), Math.min(snapshot.end, ta.value.length));
  mdHistory.muted = false;
  afterEditorMutation(false);
}

function afterEditorMutation(recordHistory) {
  setDirty(true);
  updateStats();
  schedulePreview();
  if (recordHistory !== false) pushMdHistory();
}

function replaceEditorRange(start, end, text, selectStart, selectEnd) {
  const ta = editorTextarea();
  const value = ta.value;
  ta.value = value.slice(0, start) + text + value.slice(end);
  const from = selectStart == null ? start + text.length : selectStart;
  const to = selectEnd == null ? from : selectEnd;
  ta.focus();
  ta.setSelectionRange(Math.min(from, ta.value.length), Math.min(to, ta.value.length));
  afterEditorMutation();
}

function wrapEditorSelection(prefix, suffix, placeholder) {
  const ta = editorTextarea();
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.slice(start, end);
  const text = selected || placeholder || '';
  const innerStart = start + prefix.length;
  replaceEditorRange(start, end, prefix + text + suffix, innerStart, innerStart + text.length);
}

function selectedLineBounds() {
  const ta = editorTextarea();
  const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  let end = ta.value.indexOf('\n', ta.selectionEnd);
  if (end === -1) end = ta.value.length;
  return { start: start, end: end, value: ta.value.slice(start, end) };
}

function applyHeading(level) {
  const bounds = selectedLineBounds();
  const lines = bounds.value.split('\n');
  const plain = lines.map(function (line) { return line.replace(/^\s*#{1,6}\s+/, ''); });
  const next = level > 0
    ? plain.map(function (line) { return line.trim() ? '#'.repeat(level) + ' ' + line.replace(/^\s+/, '') : line; })
    : plain;
  const text = next.join('\n');
  replaceEditorRange(bounds.start, bounds.end, text, bounds.start, bounds.start + text.length);
}

function toggleLinePrefix(word, testRe, stripRe) {
  const bounds = selectedLineBounds();
  const lines = bounds.value.split('\n');
  const filled = lines.filter(function (line) { return line.trim(); });
  const allHave = filled.length > 0 && filled.every(function (line) { return testRe.test(line); });
  let index = 0;
  const next = lines.map(function (line) {
    if (!line.trim()) return line;
    const plain = line.replace(stripRe, '');
    index += 1;
    if (allHave) return plain;
    if (word === 'ordered') return index + '. ' + plain;
    return word + plain;
  });
  const text = next.join('\n');
  replaceEditorRange(bounds.start, bounds.end, text, bounds.start, bounds.start + text.length);
}

function wrapInlineStyle(prop, value, placeholder) {
  const ta = editorTextarea();
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.slice(start, end) || placeholder;
  const open = '<span style="' + prop + ':' + value + '">';
  const text = open + selected + '</span>';
  const innerStart = start + open.length;
  replaceEditorRange(start, end, text, innerStart, innerStart + selected.length);
}

function wrapParagraph(open, close) {
  const ta = editorTextarea();
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.slice(start, end) || '这里写内容';
  const text = '\n\n' + open + '\n' + selected + '\n' + close + '\n\n';
  const innerAt = text.indexOf(selected);
  replaceEditorRange(start, end, text, start + innerAt, start + innerAt + selected.length);
}

function handleMdCommand(command) {
  const ta = editorTextarea();
  switch (command) {
    case 'bold': wrapEditorSelection('**', '**', '加粗文字'); break;
    case 'italic': wrapEditorSelection('*', '*', '斜体文字'); break;
    case 'strike': wrapEditorSelection('~~', '~~', '删除线文字'); break;
    case 'code': wrapEditorSelection('`', '`', '代码'); break;
    case 'link': {
      const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      wrapEditorSelection('[', '](https://example.com)', selected || '链接文字');
      break;
    }
    case 'image': openImageModal(); break;
    case 'quote': toggleLinePrefix('> ', /^\s*>\s?/, /^\s*>\s?/); break;
    case 'ul': toggleLinePrefix('- ', /^\s*[-*+]\s+/, /^\s*[-*+]\s+/); break;
    case 'task': toggleLinePrefix('- [ ] ', /^\s*-\s\[[ xX]\]\s+/, /^\s*-\s\[[ xX]\]\s+/); break;
    case 'ol': toggleLinePrefix('ordered', /^\s*\d+\.\s+/, /^\s*\d+\.\s+/); break;
    case 'hr': replaceEditorRange(ta.selectionStart, ta.selectionStart, '\n\n---\n\n'); break;
    case 'align-left': wrapParagraph('<div align="left">', '</div>'); break;
    case 'align-center': wrapParagraph('<div align="center">', '</div>'); break;
    case 'align-right': wrapParagraph('<div align="right">', '</div>'); break;
    case 'center-block': wrapParagraph('<div align="center">', '</div>'); break;
    case 'undo': restoreMdHistory(mdHistory.index - 1); break;
    case 'redo': restoreMdHistory(mdHistory.index + 1); break;
    case 'find': toggleFindPanel(); break;
    case 'table': openTableModal(); break;
    case 'toc':
      replaceEditorRange(ta.selectionStart, ta.selectionStart, '<!-- toc -->');
      toast('已插入目录标记，主题需要支持目录（例如 toc 插件）。', 'ok');
      break;
    case 'snippets': toggleSnippetsPanel(); break;
    default: break;
  }
}

function applyInlineHtmlSetting() {
  const on = $('md-inline-html').checked;
  document.querySelectorAll('.md-html-tools').forEach(function (node) { node.hidden = !on; });
  try { localStorage.setItem('admin.inlineHtml', on ? '1' : '0'); } catch (e) { /* 忽略 */ }
}

/* 查找替换 */

function toggleFindPanel() {
  const panel = $('md-find');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    $('find-text').focus();
    updateFindCount();
  }
}

function findOccurrences(query) {
  const value = editorTextarea().value;
  const out = [];
  if (!query) return out;
  let at = value.indexOf(query, 0);
  while (at !== -1) {
    out.push(at);
    at = value.indexOf(query, at + query.length);
  }
  return out;
}

function updateFindCount() {
  const query = $('find-text').value;
  const countEl = $('find-count');
  if (!query) { countEl.textContent = ''; return; }
  const total = findOccurrences(query).length;
  countEl.textContent = total ? '共 ' + total + ' 处' : '没有匹配';
}

function jumpFind(backwards) {
  const query = $('find-text').value;
  if (!query) return;
  const ta = editorTextarea();
  const value = ta.value;
  let idx;
  if (backwards) {
    idx = value.lastIndexOf(query, Math.max(0, ta.selectionStart - 1));
    if (idx < 0) idx = value.lastIndexOf(query);
  } else {
    idx = value.indexOf(query, ta.selectionEnd);
    if (idx < 0) idx = value.indexOf(query, 0);
  }
  if (idx < 0) { toast('没有找到匹配内容。', 'error'); return; }
  ta.focus();
  ta.setSelectionRange(idx, idx + query.length);
  updateFindCount();
}

function replaceFindOne() {
  const query = $('find-text').value;
  if (!query) return;
  const ta = editorTextarea();
  const value = ta.value;
  let idx = value.indexOf(query, ta.selectionStart);
  if (idx < 0) idx = value.indexOf(query, 0);
  if (idx < 0) { toast('没有找到匹配内容。', 'error'); return; }
  replaceEditorRange(idx, idx + query.length, $('replace-text').value);
  updateFindCount();
}

function replaceFindAll() {
  const query = $('find-text').value;
  if (!query) return;
  const ta = editorTextarea();
  const count = findOccurrences(query).length;
  if (!count) { toast('没有找到匹配内容。', 'error'); return; }
  const next = ta.value.split(query).join($('replace-text').value);
  replaceEditorRange(0, ta.value.length, next, ta.selectionStart, ta.selectionEnd);
  updateFindCount();
  toast('已替换 ' + count + ' 处。', 'ok');
}

/* 片段库 */

function buildSnippetsPanel() {
  const panel = $('snippets-panel');
  panel.textContent = '';
  (window.MD_SNIPPETS || []).forEach(function (group) {
    const box = el('div', 'snippets-group');
    box.appendChild(el('h4', '', group.group));
    const row = el('div', 'snippets-btns');
    (group.items || []).forEach(function (item) {
      const btn = el('button', '', item.label);
      btn.type = 'button';
      btn.addEventListener('click', function () { insertSnippet(item); });
      row.appendChild(btn);
    });
    box.appendChild(row);
    panel.appendChild(box);
  });
}

function toggleSnippetsPanel() {
  const panel = $('snippets-panel');
  if (!panel.childElementCount) buildSnippetsPanel();
  panel.hidden = !panel.hidden;
  if (!panel.hidden) panel.scrollTop = 0;
}

function insertSnippet(item) {
  const ta = editorTextarea();
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const text = String(item.text || '');
  let selectStart = start + text.length;
  let selectEnd = selectStart;
  if (item.select && text.indexOf(item.select) >= 0) {
    const at = text.indexOf(item.select);
    selectStart = start + at;
    selectEnd = selectStart + item.select.length;
  }
  replaceEditorRange(start, end, text, selectStart, selectEnd);
  $('snippets-panel').hidden = true;
  toast('已插入片段：' + item.label, 'ok');
}

/* 图片插入 */

function openImageModal() {
  $('image-file').value = '';
  $('image-url').value = '';
  $('image-alt').value = '';
  $('image-hint').textContent = '';
  $('image-hint').classList.remove('is-error');
  $('image-modal').hidden = false;
  $('image-url').focus();
}

function closeImageModal() { $('image-modal').hidden = true; }

async function uploadImageFromEditor(file) {
  if (!file) return;
  const hint = $('image-hint');
  hint.classList.remove('is-error');
  hint.textContent = '正在上传到 OSS…';
  try {
    const dataUrl = await readFileBase64(file);
    const data = await api('/oss/upload', {
      method: 'POST',
      csrf: true,
      body: { name: file.name, type: file.type, data: dataUrl }
    });
    $('image-url').value = data.url || '';
    if (!$('image-alt').value) $('image-alt').value = file.name.replace(/\.[^.]+$/, '');
    hint.textContent = '已上传：' + (data.key || file.name);
  } catch (err) {
    hint.classList.add('is-error');
    hint.textContent = '上传失败：' + err.message + '。可以直接填图片地址。';
  }
}

function insertImageFromModal() {
  const url = $('image-url').value.trim();
  const hint = $('image-hint');
  if (!url) {
    hint.classList.add('is-error');
    hint.textContent = '请先选择图片上传，或填写图片地址。';
    return;
  }
  const alt = $('image-alt').value.trim();
  const ta = editorTextarea();
  const markdown = '![' + alt + '](' + url + ')';
  replaceEditorRange(ta.selectionStart, ta.selectionEnd, markdown);
  closeImageModal();
  toast('已插入图片。', 'ok');
}

/* 表格插入 */

function openTableModal() {
  $('table-rows').value = '3';
  $('table-cols').value = '3';
  $('table-modal').hidden = false;
  $('table-rows').focus();
}

function closeTableModal() { $('table-modal').hidden = true; }

function insertTableFromModal() {
  const rows = Math.max(1, Math.min(30, parseInt($('table-rows').value, 10) || 3));
  const cols = Math.max(1, Math.min(12, parseInt($('table-cols').value, 10) || 3));
  const header = [];
  for (let c = 1; c <= cols; c++) header.push('列 ' + c);
  let text = '| ' + header.join(' | ') + ' |\n| ' + new Array(cols).fill('---').join(' | ') + ' |';
  for (let r = 1; r < rows; r++) {
    text += '\n| ' + new Array(cols).fill('  ').join(' | ') + ' |';
  }
  const ta = editorTextarea();
  replaceEditorRange(ta.selectionStart, ta.selectionEnd, '\n\n' + text + '\n\n');
  closeTableModal();
}

/* 分屏拖动 */

function setupSplitter() {
  const panes = $('editor-panes');
  const splitter = $('pane-splitter');
  let dragging = false;
  try {
    const saved = parseFloat(localStorage.getItem('admin.editorSplit') || '');
    if (saved >= 25 && saved <= 75) panes.style.setProperty('--split', saved + '%');
  } catch (e) { /* 忽略 */ }

  splitter.addEventListener('pointerdown', function (event) {
    dragging = true;
    splitter.classList.add('is-dragging');
    try { splitter.setPointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
    event.preventDefault();
  });
  splitter.addEventListener('pointermove', function (event) {
    if (!dragging) return;
    const rect = panes.getBoundingClientRect();
    const percent = Math.max(25, Math.min(75, ((event.clientX - rect.left) / rect.width) * 100));
    panes.style.setProperty('--split', percent.toFixed(1) + '%');
  });
  function stopDrag() {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('is-dragging');
    const current = parseFloat(panes.style.getPropertyValue('--split')) || 50;
    try { localStorage.setItem('admin.editorSplit', String(Math.round(current))); } catch (e) { /* 忽略 */ }
  }
  splitter.addEventListener('pointerup', stopDrag);
  splitter.addEventListener('pointercancel', stopDrag);
  splitter.addEventListener('dblclick', function () {
    panes.style.removeProperty('--split');
    try { localStorage.removeItem('admin.editorSplit'); } catch (e) { /* 忽略 */ }
  });
}

function togglePreviewPane() {
  setPane(state.pane === 'preview' ? 'split' : 'preview');
}

/* 工具栏绑定 */

function bindEditorTools() {
  $('md-toolbar').addEventListener('click', function (event) {
    const btn = event.target.closest ? event.target.closest('button[data-md]') : null;
    if (!btn) return;
    handleMdCommand(btn.dataset.md);
  });

  $('md-heading').addEventListener('change', function () {
    const level = parseInt(this.value, 10) || 0;
    this.value = '0';
    applyHeading(level);
  });

  $('md-color').addEventListener('change', function () {
    wrapInlineStyle('color', this.value, '彩色文字');
  });

  $('md-size').addEventListener('change', function () {
    if (!this.value) return;
    const size = this.value;
    this.value = '';
    wrapInlineStyle('font-size', size, '大号文字');
  });

  $('md-inline-html').addEventListener('change', applyInlineHtmlSetting);
  try {
    const saved = localStorage.getItem('admin.inlineHtml');
    if (saved === '0') $('md-inline-html').checked = false;
  } catch (e) { /* 忽略 */ }
  applyInlineHtmlSetting();

  $('editor-body').addEventListener('input', pushMdHistory);
  $('editor-body').addEventListener('keydown', function (event) {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    const key = String(event.key || '').toLowerCase();
    if (key === 'b') { event.preventDefault(); handleMdCommand('bold'); }
    else if (key === 'i') { event.preventDefault(); handleMdCommand('italic'); }
    else if (key === 'k') { event.preventDefault(); handleMdCommand('link'); }
    else if (key === 'p' && event.shiftKey) { event.preventDefault(); togglePreviewPane(); }
    else if (key === 'z' && event.shiftKey) { event.preventDefault(); handleMdCommand('redo'); }
  });

  $('find-text').addEventListener('input', updateFindCount);
  $('find-next').addEventListener('click', function () { jumpFind(false); });
  $('find-prev').addEventListener('click', function () { jumpFind(true); });
  $('find-one').addEventListener('click', replaceFindOne);
  $('find-all').addEventListener('click', replaceFindAll);
  $('find-close').addEventListener('click', function () { $('md-find').hidden = true; });
  $('find-text').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); jumpFind(event.shiftKey); }
  });

  $('image-file').addEventListener('change', function () {
    uploadImageFromEditor(this.files && this.files[0]);
  });
  $('image-ok').addEventListener('click', insertImageFromModal);
  $('image-cancel').addEventListener('click', closeImageModal);
  document.querySelectorAll('[data-image-cancel]').forEach(function (node) {
    node.addEventListener('click', closeImageModal);
  });
  $('table-ok').addEventListener('click', insertTableFromModal);
  $('table-cancel').addEventListener('click', closeTableModal);
  document.querySelectorAll('[data-table-cancel]').forEach(function (node) {
    node.addEventListener('click', closeTableModal);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!$('image-modal').hidden) closeImageModal();
    if (!$('table-modal').hidden) closeTableModal();
    if (!$('snippets-panel').hidden) $('snippets-panel').hidden = true;
  });

  $('export-md').addEventListener('click', exportMarkdownFile);
  $('export-pdf').addEventListener('click', openPrintPage);
  $('export-word').addEventListener('click', exportWordFile);

  setupSplitter();
}

/* ---------------------------------------------------------------- 配置页 */

async function loadConfig() {
  const box = $('config-groups');
  box.textContent = '';
  try {
    const data = await api('/config');
    state.configGroups = data.groups || [];
  } catch (err) {
    toast('读取配置失败：' + err.message, 'error');
    return;
  }
  state.configGroups.forEach(function (group) {
    const section = el('section', 'config-group');
    section.appendChild(el('h2', '', group.name));
    const grid = el('div', 'config-grid');
    group.fields.forEach(function (field) {
      const label = el('label', 'field');
      const caption = el('span', '', field.label);
      label.appendChild(caption);
      let input;
      if (field.type === 'boolean') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!field.value;
      } else {
        input = document.createElement('input');
        input.type = field.type === 'number' ? 'number' : 'text';
        if (field.type === 'list') input.value = (field.value || []).join(', ');
        else input.value = field.value == null ? '' : String(field.value);
      }
      input.dataset.field = field.id;
      input.dataset.fieldType = field.type;
      label.appendChild(input);
      if (field.hint) label.appendChild(el('em', 'field-hint', field.hint));
      label.appendChild(el('em', 'field-hint field-source', field.file + ' › ' + field.path));
      grid.appendChild(label);
    });
    section.appendChild(grid);
    box.appendChild(section);
  });
}

async function saveConfig() {
  const values = {};
  document.querySelectorAll('[data-field]').forEach(function (input) {
    values[input.dataset.field] = input.dataset.fieldType === 'boolean' ? input.checked : input.value;
  });
  const btn = $('config-save');
  btn.disabled = true;
  $('config-state').textContent = '正在保存…';
  try {
    const data = await api('/config', { method: 'PUT', body: { values: values }, csrf: true });
    $('config-state').textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    toast('配置已保存，正在重新生成…', 'ok');
    if (data.build) watchJob(data.build.job, data.build.queued);
  } catch (err) {
    $('config-state').textContent = '保存失败';
    toast('保存失败：' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* -------------------------------------------------------------- 功能开关 */

const FEATURE_GROUP_ORDER = ['界面外观', '氛围特效', '阅读体验', '交互与评论', 'AI 能力', '站点与 SEO'];

/** “已保存但还没生成”的开关 id 记在 localStorage，刷新页面也不会误以为已生效。 */
function featurePendingIds() {
  try {
    const list = JSON.parse(localStorage.getItem('admin-features-pending') || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function setFeaturePendingIds(ids) {
  try { localStorage.setItem('admin-features-pending', JSON.stringify(ids)); } catch (e) { /* 忽略 */ }
  renderFeatureNotice();
}

function addFeaturePending(id) {
  const ids = featurePendingIds();
  if (ids.indexOf(id) < 0) ids.push(id);
  setFeaturePendingIds(ids);
}

function clearFeaturePending() {
  if (!featurePendingIds().length) return;
  setFeaturePendingIds([]);
}

function renderFeatureNotice() {
  const notice = $('features-notice');
  if (!notice) return;
  const count = featurePendingIds().length;
  notice.hidden = count === 0;
  if (count) $('features-pending-text').textContent = '有 ' + count + ' 项开关修改尚未生成';
}

async function loadFeatures() {
  renderFeatureNotice();
  const box = $('feature-groups');
  box.textContent = '';
  let data;
  try {
    data = await api('/features');
  } catch (err) {
    toast('读取开关失败：' + err.message, 'error');
    return;
  }
  state.features = [];
  const groups = (data.groups || []).slice().sort(function (a, b) {
    return FEATURE_GROUP_ORDER.indexOf(a.name) - FEATURE_GROUP_ORDER.indexOf(b.name);
  });
  groups.forEach(function (group) {
    const section = el('section', 'feature-group');
    const head = el('div', 'feature-group-head');
    head.appendChild(el('h2', '', group.name));
    head.appendChild(el('span', 'feature-count', group.fields.length + ' 项'));
    section.appendChild(head);

    const grid = el('div', 'feature-grid');
    group.fields.forEach(function (item) {
      state.features.push(item);
      const card = el('article', 'feature-card' + (item.value ? ' is-on' : ''));
      card.dataset.id = item.id;
      const text = el('div', 'feature-text');
      text.appendChild(el('h3', '', item.label));
      if (item.hint) text.appendChild(el('p', '', item.hint));
      text.appendChild(el('em', 'feature-source',
        item.file + ' › ' + item.path + ' · 当前：' + (item.value ? '开' : '关')));
      card.appendChild(text);

      const toggle = el('button', 'toggle');
      toggle.type = 'button';
      toggle.dataset.action = 'toggle-feature';
      toggle.dataset.feature = item.id;
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', item.value ? 'true' : 'false');
      toggle.setAttribute('aria-label', (item.value ? '关闭 ' : '开启 ') + item.label);
      card.appendChild(toggle);

      grid.appendChild(card);
    });
    section.appendChild(grid);
    box.appendChild(section);
  });
  if (!state.features.length) box.appendChild(el('p', 'empty', '没有可用的开关。'));
}

function paintFeatureCard(button, item) {
  const card = button && button.closest ? button.closest('.feature-card') : null;
  if (!card) return;
  card.classList.toggle('is-on', !!item.value);
  button.setAttribute('aria-checked', item.value ? 'true' : 'false');
  button.setAttribute('aria-label', (item.value ? '关闭 ' : '开启 ') + item.label);
  const source = card.querySelector('.feature-source');
  if (source) {
    source.textContent = item.file + ' › ' + item.path + ' · 当前：' + (item.value ? '开' : '关');
  }
}

/** 每个开关都要先确认：说清改哪个文件的哪个字段、当前值 → 新值。 */
async function toggleFeature(id, button) {
  const item = state.features.find(function (entry) { return entry.id === id; });
  if (!item) return;
  const next = !item.value;
  const ok = await confirmModal({
    title: (next ? '开启' : '关闭') + '「' + item.label + '」',
    html: (item.hint ? '<p>' + escapeHtml(item.hint) + '</p>' : '')
      + '<p class="confirm-path">配置文件：<code>' + escapeHtml(item.file) + '</code><br>'
      + '字段：<code>' + escapeHtml(item.path) + '</code></p>'
      + '<p>当前值 <strong>' + (item.value ? '开' : '关') + '</strong>'
      + ' → <strong>' + (next ? '开' : '关') + '</strong></p>'
      + '<p class="hint">确认后立即写入配置文件并备份原文件，其它字段与注释保持不变。'
      + '站点前台需要重新生成后才会生效。</p>',
    confirmText: next ? '确认开启' : '确认关闭',
    danger: false
  });
  if (!ok) return;

  if (button) button.disabled = true;
  try {
    await api('/features', { method: 'POST', body: { id: id, value: next }, csrf: true });
    item.value = next;
    paintFeatureCard(button, item);
    addFeaturePending(id);
    toast('已' + (next ? '开启' : '关闭') + '「' + item.label + '」，记得重新生成', 'ok');
  } catch (err) {
    toast('保存失败：' + err.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

/** 复用现有生成流程：跳到发布页跑一次生成，任务日志在那里完整可见。 */
async function regenerateFromFeatures() {
  const ok = await confirmModal({
    title: '重新生成站点',
    text: '会完整生成一次站点，让新开关在生成的页面里生效。生成期间可以先做别的，等它跑完再刷新前台；如果本地预览仍是旧效果，重启 hexo server 即可。',
    confirmText: '开始生成',
    danger: false
  });
  if (!ok) return;
  switchView('publish', true);
  startJob(false);
}

/* ------------------------------------------------------------ 图床（OSS） */

const OSS_FIELD_LABELS = {
  accessKeyId: 'AccessKeyId',
  accessKeySecret: 'AccessKeySecret',
  bucket: 'Bucket',
  region: 'Region',
  customDomain: '自定义域名',
  pathPrefix: '路径前缀'
};

function ossBadge(info) {
  const badge = $('oss-state');
  const configured = !!(info && info.configured);
  badge.textContent = configured ? '已配置' : '未配置';
  badge.className = 'badge ' + (configured ? 'badge-ok' : 'badge-warn');
}

function fillOssConfig(info) {
  const config = (info && info.config) || {};
  $('oss-access-key-id').value = config.accessKeyId || '';
  $('oss-secret').value = '';
  $('oss-bucket').value = config.bucket || '';
  $('oss-region').value = config.region || '';
  $('oss-domain').value = config.customDomain || '';
  $('oss-prefix').value = config.pathPrefix || '';

  const overridden = Object.keys(info && info.overrides || {}).filter(function (field) {
    return info.overrides[field];
  }).map(function (field) {
    return OSS_FIELD_LABELS[field] || field;
  });
  const parts = [];
  parts.push(config.hasSecret ? 'Secret 已保存（留空可保留原值）' : 'Secret 未配置');
  if (overridden.length) parts.push('环境变量覆盖：' + overridden.join('、'));
  if (!info || !info.configured) parts.push('还需要填写 AccessKeyId / Secret / Bucket / Region');
  $('oss-config-note').textContent = parts.join('；');
  ossBadge(info);
}

function renderOssResults() {
  const box = $('oss-results');
  box.textContent = '';
  if (!state.oss.results.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  state.oss.results.forEach(function (item) {
    const wrap = el('div', 'oss-item');
    const img = el('img', 'oss-thumb');
    img.src = item.url;
    img.alt = item.name || '图片';
    img.loading = 'lazy';

    const meta = el('div', 'oss-meta');
    meta.appendChild(el('strong', '', item.name || '图片'));
    meta.appendChild(el('span', 'oss-sub', formatBytes(item.bytes) + ' · ' + item.key));

    const actions = el('div', 'copy-row');
    [['复制 URL', item.url], ['复制 Markdown', item.markdown], ['复制 HTML', item.html]].forEach(function (row) {
      const btn = el('button', 'ghost-btn', row[0]);
      btn.type = 'button';
      btn.dataset.copy = row[1];
      actions.appendChild(btn);
    });
    const insert = el('button', 'btn btn-small', '插入文章');
    insert.type = 'button';
    insert.dataset.insert = item.markdown;
    actions.appendChild(insert);
    meta.appendChild(actions);
    meta.appendChild(el('code', 'oss-url', item.url));

    wrap.appendChild(img);
    wrap.appendChild(meta);
    box.appendChild(wrap);
  });
}

function ossBaseName(key) {
  return String(key || '').split('/').pop() || key;
}

function formatOssTime(value) {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  function p(n) { return String(n).padStart(2, '0'); }
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) +
    ' ' + p(date.getHours()) + ':' + p(date.getMinutes());
}

function renderOssDomain(domain) {
  const box = $('oss-domain-warn');
  if (!domain || !domain.customDomain || domain.ok) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.className = 'oss-domain-warn is-warn';
  box.textContent = '当前自定义域名不可用：' + domain.message +
    (domain.defaultDomain ? '（已改用 ' + domain.defaultDomain + '）' : '');
}

function updateOssSelection() {
  const count = Object.keys(state.oss.selection).length;
  $('oss-selected-count').textContent = '（' + count + '）';
  $('btn-oss-delete-selected').disabled = count === 0 || state.oss.deleteBusy;
}

function renderOssGrid() {
  const grid = $('oss-grid');
  grid.textContent = '';
  const all = state.oss.objects;
  const query = state.oss.search;
  const rows = query
    ? all.filter(function (item) { return item.key.toLowerCase().indexOf(query) >= 0; })
    : all;

  const empty = $('oss-empty');
  const showEmpty = rows.length === 0 && !state.oss.listBusy;
  empty.hidden = !showEmpty;
  if (showEmpty) {
    const strong = empty.querySelector('strong');
    const span = empty.querySelector('span');
    if (query) {
      strong.textContent = '没有匹配「' + state.oss.search + '」的图片';
      span.textContent = '搜索只过滤已经加载的图片；可以点「加载更多」继续往后找。';
    } else {
      strong.textContent = '这个 Bucket 里还没有图片';
      span.textContent = '可以先用上面的上传区传一张，或检查路径前缀 / 自定义域名配置。';
    }
  }

  rows.forEach(function (item) {
    const name = ossBaseName(item.key);
    const card = el('article', 'oss-card');
    card.dataset.key = item.key;

    const pick = el('label', 'oss-pick');
    const checkbox = el('input', '');
    checkbox.type = 'checkbox';
    checkbox.checked = !!state.oss.selection[item.key];
    checkbox.dataset.ossSelect = item.key;
    checkbox.setAttribute('aria-label', '选择 ' + name);
    pick.appendChild(checkbox);
    card.appendChild(pick);

    const previewBtn = el('button', 'oss-preview');
    previewBtn.type = 'button';
    previewBtn.dataset.ossPreview = item.url;
    previewBtn.dataset.ossPreviewName = name;
    const img = el('img', 'oss-grid-thumb');
    img.src = item.url;
    img.alt = name;
    img.loading = 'lazy';
    img.onerror = function () {
      if (img.dataset.fallback || !item.defaultUrl || img.src === item.defaultUrl) return;
      img.dataset.fallback = '1';
      img.src = item.defaultUrl;
    };
    previewBtn.appendChild(img);
    card.appendChild(previewBtn);

    const body = el('div', 'oss-card-body');
    body.appendChild(el('strong', 'oss-card-name', name));
    body.appendChild(el('span', 'oss-sub', formatBytes(item.size) + ' · ' + formatOssTime(item.lastModified)));
    body.appendChild(el('code', 'oss-sub', item.key));

    const actions = el('div', 'oss-card-actions');
    const copyMd = el('button', 'ghost-btn', '复制 Markdown');
    copyMd.type = 'button';
    copyMd.dataset.ossCopy = item.markdown;
    const copyUrl = el('button', 'ghost-btn', '复制 URL');
    copyUrl.type = 'button';
    copyUrl.dataset.ossCopy = item.url;
    const view = el('button', 'ghost-btn', '预览');
    view.type = 'button';
    view.dataset.ossPreview = item.url;
    view.dataset.ossPreviewName = name;
    const del = el('button', 'ghost-btn ghost-danger', '删除');
    del.type = 'button';
    del.dataset.ossDelete = item.key;
    actions.appendChild(copyMd);
    actions.appendChild(copyUrl);
    actions.appendChild(view);
    actions.appendChild(del);
    body.appendChild(actions);
    card.appendChild(body);
    grid.appendChild(card);
  });

  $('btn-oss-more').hidden = !state.oss.hasMore;
  updateOssSelection();
}

async function loadOssObjects(reset) {
  if (state.oss.listBusy) return;
  const info = state.oss.info;
  if (!info || !info.configured) {
    state.oss.objects = [];
    state.oss.hasMore = false;
    state.oss.nextMarker = '';
    state.oss.selection = {};
    renderOssGrid();
    $('oss-manager-state').textContent = '保存 OSS 配置后，这里会列出 Bucket 里的全部图片。';
    $('btn-oss-more').hidden = true;
    return;
  }

  if (reset) {
    state.oss.objects = [];
    state.oss.selection = {};
    state.oss.nextMarker = '';
    state.oss.hasMore = false;
    renderOssGrid();
  }

  state.oss.listBusy = true;
  const stateText = $('oss-manager-state');
  stateText.textContent = reset ? '正在读取 OSS 资源…' : '正在加载更多…';
  $('btn-oss-refresh').disabled = true;
  try {
    const marker = reset ? '' : state.oss.nextMarker;
    const data = await api('/oss/objects?limit=48' +
      (marker ? '&marker=' + encodeURIComponent(marker) : ''));
    state.oss.objects = reset ? data.items : state.oss.objects.concat(data.items);
    state.oss.nextMarker = data.nextMarker || '';
    state.oss.hasMore = !!data.hasMore;
    state.oss.domain = data.domain || null;
    renderOssDomain(state.oss.domain);
    renderOssGrid();
    const total = data.total == null ? state.oss.objects.length + ' 张已加载' : '共 ' + data.total + ' 张';
    stateText.textContent = data.items.length
      ? total + '；点图片可预览大图，勾选后可批量删除。'
      : (reset ? '没有找到图片。' : '已经到底了。');
  } catch (err) {
    if (err.status !== 401) {
      stateText.textContent = '读取资源失败：' + ossFailureText(err);
      toast('读取 OSS 资源失败', 'error');
    }
  } finally {
    state.oss.listBusy = false;
    $('btn-oss-refresh').disabled = false;
    $('btn-oss-more').hidden = !state.oss.hasMore;
    renderOssGrid();
  }
}

async function deleteOssKeys(keys) {
  const list = (keys || []).filter(Boolean);
  if (!list.length) return;
  if (!state.oss.info || !state.oss.info.configured) {
    toast('请先保存 OSS 配置，再删除图片。', 'error');
    return;
  }
  if (state.oss.deleteBusy) return;

  const preview = list.slice(0, 10).map(function (key) {
    return '<li>' + escapeHtml(ossBaseName(key)) + '</li>';
  }).join('');
  const more = list.length > 10 ? '<li>……等 ' + list.length + ' 个文件</li>' : '';
  const ok = await confirmModal({
    title: '确认删除 ' + list.length + ' 个图片？',
    html: '<p>将从 OSS 永久删除以下文件：</p>' +
      '<ul class="confirm-list">' + preview + more + '</ul>' +
      '<p class="danger-note">删除后文章里引用这些图片会导致裂图，且 OSS 没有回收站。请确认这些图片不再需要。</p>',
    confirmText: '确认删除'
  });
  if (!ok) return;

  state.oss.deleteBusy = true;
  updateOssSelection();
  const resultBox = $('oss-delete-result');
  resultBox.hidden = false;
  resultBox.className = 'restore-result';
  resultBox.textContent = '正在删除 ' + list.length + ' 个文件…';
  try {
    const data = await api('/oss/delete', { method: 'POST', csrf: true, body: { keys: list } });
    const deleted = [];
    const failures = [];
    (data.results || []).forEach(function (item) {
      if (item.ok) deleted.push(item.key);
      else failures.push(item);
    });

    const gone = {};
    deleted.forEach(function (key) {
      gone[key] = true;
      delete state.oss.selection[key];
    });
    state.oss.objects = state.oss.objects.filter(function (item) { return !gone[item.key]; });
    renderOssGrid();

    if (failures.length) {
      resultBox.className = 'restore-result is-warn';
      resultBox.textContent = '已删除 ' + deleted.length + ' 个，失败 ' + failures.length + ' 个：\n' +
        failures.map(function (item) {
          return '✗ ' + item.key + '：' + (item.label || '删除失败') +
            '（' + (item.code || 'UNKNOWN') + (item.ossCode ? ' / ' + item.ossCode : '') + '）' +
            (item.message ? ' — ' + item.message : '') +
            (item.remoteMessage && item.remoteMessage !== item.message ? ' OSS：' + item.remoteMessage : '');
        }).join('\n');
    } else {
      resultBox.className = 'restore-result is-ok';
      resultBox.textContent = '✓ 已删除 ' + deleted.length + ' 个图片。';
    }

    if (deleted.length && failures.length) toast('部分删除成功，失败原因见列表', 'error');
    else if (deleted.length) toast('已删除 ' + deleted.length + ' 个图片', 'ok');
    else toast('删除失败，原因见列表', 'error');

    // 当前页被删空但 OSS 里还有下一页时，自动补一页，避免误显示“Bucket 里没有图片”。
    if (deleted.length && state.oss.objects.length === 0 && state.oss.hasMore) {
      loadOssObjects(false);
    }
  } catch (err) {
    resultBox.className = 'restore-result is-warn';
    resultBox.textContent = '✗ ' + ossFailureText(err);
    toast('删除失败', 'error');
  } finally {
    state.oss.deleteBusy = false;
    updateOssSelection();
  }
}

function openOssLightbox(url, name) {
  const box = $('oss-lightbox');
  const img = $('oss-lightbox-img');
  img.src = url;
  img.alt = name || '图片预览';
  box.hidden = false;
  $('oss-lightbox-close').focus();
}

function closeOssLightbox() {
  const box = $('oss-lightbox');
  if (box.hidden) return;
  box.hidden = true;
  $('oss-lightbox-img').src = '';
}

async function loadOss() {
  try {
    const info = await api('/oss/config');
    state.oss.info = info;
    fillOssConfig(info);
    renderOssResults();
    await loadOssObjects(true);
  } catch (err) {
    if (err.status !== 401) {
      toast('读取图床配置失败：' + err.message, 'error');
      $('oss-config-note').textContent = err.message;
    }
  }
}

async function saveOss() {
  const btn = $('btn-oss-save');
  btn.disabled = true;
  btn.textContent = '正在保存…';
  const payload = {
    accessKeyId: $('oss-access-key-id').value.trim(),
    bucket: $('oss-bucket').value.trim(),
    region: $('oss-region').value.trim(),
    customDomain: $('oss-domain').value.trim(),
    pathPrefix: $('oss-prefix').value.trim()
  };
  const secret = $('oss-secret').value.trim();
  if (secret) payload.accessKeySecret = secret;
  try {
    const info = await api('/oss/config', { method: 'PUT', csrf: true, body: payload });
    state.oss.info = info;
    fillOssConfig(info);
    toast(info.configured ? '图床配置已保存' : '已保存，但还缺少必填项', info.configured ? 'ok' : 'error');
  } catch (err) {
    const detail = err.body && err.body.error;
    const message = detail && detail.label ? detail.label + '：' + detail.message : err.message;
    toast('保存失败：' + message, 'error');
    $('oss-config-note').textContent = message + (detail && detail.hint ? '（' + detail.hint + '）' : '');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存配置';
  }
}

function ossFailureText(err) {
  const detail = err && err.body && err.body.error;
  if (!detail) return (err && err.message) || '图床操作失败。';
  return (detail.label ? detail.label + '：' : '') + (detail.message || '') +
    (detail.hint ? '\n' + detail.hint : '');
}

async function testOss() {
  const btn = $('btn-oss-test');
  const box = $('oss-test-result');
  btn.disabled = true;
  btn.textContent = '正在测试…';
  box.hidden = false;
  box.className = 'restore-result';
  box.textContent = '正在上传一张 1×1 测试图，成功后会自动删除…';
  try {
    const data = await api('/oss/test', { method: 'POST', csrf: true, body: {} });
    box.textContent = '✓ ' + data.message + (data.note ? '\n' + data.note : '') +
      (data.key ? '\n测试对象：' + data.key : '');
    box.className = 'restore-result is-ok';
    toast('图床连通性正常', 'ok');
  } catch (err) {
    const text = ossFailureText(err);
    box.textContent = '✗ ' + text;
    box.className = 'restore-result is-warn';
    toast('连通性测试失败', 'error');
  } finally {
    state.oss.busy = false;
    btn.disabled = false;
    btn.textContent = '测试连通性';
  }
}

function readFileBase64(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result || '')); };
    reader.onerror = function () { reject(new Error('读取文件失败')); };
    reader.readAsDataURL(file);
  });
}

function uploadOssFile(file, index, total) {
  return new Promise(function (resolve, reject) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API + '/oss/upload');
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (state.session && state.session.csrf) xhr.setRequestHeader('X-CSRF-Token', state.session.csrf);

    xhr.upload.onprogress = function (event) {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      showOssProgress('第 ' + (index + 1) + ' / ' + total + ' 张 · ' + percent + '%', percent);
    };
    xhr.onload = function () {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch (e) { data = {}; }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const err = new Error((data.error && data.error.message) || ('上传失败：' + xhr.status));
      err.status = xhr.status;
      err.body = data;
      reject(err);
    };
    xhr.onerror = function () { reject(new Error('网络中断，上传失败。')); };
    xhr.onabort = function () { reject(new Error('上传已取消。')); };

    readFileBase64(file).then(function (base64) {
      xhr.send(JSON.stringify({ name: file.name, type: file.type, data: base64 }));
    }).catch(reject);
  });
}

function showOssProgress(text, percent) {
  const bar = $('oss-progress');
  const fill = $('oss-progress-bar');
  const label = $('oss-progress-text');
  bar.hidden = false;
  fill.style.width = Math.max(0, Math.min(100, percent || 0)) + '%';
  label.textContent = text || '';
}

function hideOssProgress() {
  $('oss-progress').hidden = true;
  $('oss-progress-bar').style.width = '0%';
  $('oss-progress-text').textContent = '';
}

async function handleOssFiles(fileList) {
  const files = Array.prototype.slice.call(fileList || []);
  if (!files.length) return;
  if (!state.oss.info || !state.oss.info.configured) {
    toast('请先保存 OSS 配置，再上传图片。', 'error');
    return;
  }
  if (state.oss.busy) return toast('正在上传，请等当前批次完成。', 'error');

  const valid = [];
  files.forEach(function (file) {
    const type = String(file.type || '').toLowerCase();
    if (!/^image\/(jpeg|png|gif|webp|avif|bmp|tiff)$/.test(type)) {
      toast(file.name + ' 不是支持的图片格式（SVG 已禁用）。', 'error');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast(file.name + ' 超过 10 MB，已跳过。', 'error');
      return;
    }
    valid.push(file);
  });
  if (!valid.length) return;

  state.oss.busy = true;
  const hint = $('oss-upload-hint');
  hint.textContent = '正在上传 ' + valid.length + ' 张图片……';
  let uploaded = 0;
  try {
    for (let i = 0; i < valid.length; i++) {
      showOssProgress('第 ' + (i + 1) + ' / ' + valid.length + ' 张 · 读取中', 0);
      try {
        const result = await uploadOssFile(valid[i], i, valid.length);
        uploaded += 1;
        state.oss.results.unshift(result);
        renderOssResults();
        if (result.domain) renderOssDomain(result.domain);
      } catch (err) {
        toast(valid[i].name + '：' + ossFailureText(err), 'error');
      }
    }
    hint.textContent = '上传结束。可复制链接，或在编辑页打开文章后点「插入文章」。';
  } finally {
    state.oss.busy = false;
    hideOssProgress();
    if (uploaded) loadOssObjects(true);
  }
}

function insertMarkdownIntoEditor(markdown) {
  if (!state.editing) {
    toast('请先在「文章」页打开一篇文章，再插入图片。', 'error');
    return;
  }
  const textarea = $('editor-body');
  const editorVisible = !$('view-editor').hidden;
  const length = textarea.value.length;
  const position = editorVisible ? (textarea.selectionStart == null ? length : textarea.selectionStart) : length;

  const before = textarea.value.slice(0, position);
  const after = textarea.value.slice(position);
  const lead = before && !/\n$/.test(before) ? '\n\n' : '';
  const tail = after && !/^\n/.test(after) ? '\n' : '';
  textarea.value = before + lead + markdown + tail + after;
  const caret = (before + lead + markdown).length;
  textarea.setSelectionRange(caret, caret);

  state.dirty = true;
  updateDirtyUI();
  updateStats();
  schedulePreview(true);
  toast('已插入到当前文章（' + (editorVisible ? '光标处' : '文末') + '）', 'ok');
}

/* ------------------------------------------------------------ 生成与推送 */

function deployReadyText(deploy) {
  if (!deploy) return '未知';
  if (!deploy.repo) return '未配置仓库';
  if (deploy.mode === 'https' && !deploy.hasToken) return '缺少 Token';
  if (!deploy.enabled) return '推送已关闭';
  if (!deploy.ready) return deploy.reason || '暂不可用';
  return '可以推送';
}

function repoModeOf(value) {
  const text = String(value || '').trim();
  if (/^https?:\/\//i.test(text)) return 'https';
  if (/^(git@|ssh:\/\/)/i.test(text)) return 'ssh';
  return '';
}

/** 根据仓库地址实时切换「SSH / HTTPS」提示和 Token 输入框。 */
function renderDeployMode(deploy) {
  const mode = repoModeOf($('deploy-input-repo').value);
  const hasToken = !!(deploy && deploy.hasToken);
  const label = $('deploy-mode');
  const hint = $('deploy-mode-hint');
  const tokenRow = $('deploy-token-row');
  const tokenHint = $('deploy-token-hint');

  if (mode === 'https') {
    label.textContent = 'HTTPS + Token';
    hint.textContent = '适合没有 SSH 密钥的机器';
    tokenRow.hidden = false;
    tokenHint.textContent = hasToken
      ? '已保存 Token（不会回显）。留空表示继续使用已保存的 Token。'
      : '必填。到 GitHub → Settings → Developer settings → Personal access tokens 生成，勾选 repo 权限。';
  } else if (mode === 'ssh') {
    label.textContent = 'SSH 密钥';
    hint.textContent = '需要本机 ~/.ssh 有私钥，且公钥已加到 GitHub';
    tokenRow.hidden = true;
    tokenHint.textContent = '';
  } else {
    label.textContent = '自动判断';
    hint.textContent = '地址以 https:// 开头用 Token，以 git@ 或 ssh:// 开头用 SSH';
    tokenRow.hidden = true;
    tokenHint.textContent = '';
  }

  const warn = deploy && deploy.warn ? deploy.warn : '';
  const warnBox = $('deploy-warn');
  if (warn) {
    warnBox.textContent = warn;
    warnBox.hidden = false;
  } else {
    warnBox.textContent = '';
    warnBox.hidden = true;
  }
}

/* ------------------------------------------------------------------ 源码 */

const SOURCE_PAGE = 10;

async function loadSource(append) {
  if (state.source.busy) return;
  state.source.busy = true;
  const offset = append ? state.source.offset : 0;
  try {
    const query = '/source?limit=' + SOURCE_PAGE + '&offset=' + offset + (append ? '&changes=0' : '');
    const data = await api(query);
    if (!append) {
      state.source.info = data;
      state.source.offset = 0;
    }
    renderSource(data, !!append);
  } catch (err) {
    if (err.status !== 401) {
      toast('读取源码状态失败：' + err.message, 'error');
      $('source-repo').textContent = '读取失败';
      $('source-note').textContent = err.message;
      const badge = $('source-state');
      badge.textContent = '不可用';
      badge.className = 'badge badge-warn';
    }
  } finally {
    state.source.busy = false;
  }
}

function renderSource(data, append) {
  $('source-repo').textContent = data.repo;
  $('source-note').textContent = '本地分支 ' + (data.localBranch || '未知') +
    ' · HEAD ' + (data.head || '无') + ' · 推送目标 ' + data.branch;
  $('source-restore-head').textContent = data.head || '无提交';
  $('source-restore-target').textContent = '远端 ' + data.branch;
  if (data.clean !== null && data.clean !== undefined) {
    const badge = $('source-state');
    if (data.changes.length) {
      badge.textContent = data.changes.length + ' 个改动待提交';
      badge.className = 'badge badge-warn';
    } else {
      badge.textContent = '工作区干净';
      badge.className = 'badge badge-ok';
    }
    renderSourceChanges(data.changes);
  }
  renderSourceCommits(data.commits || [], append, !!data.hasMore);
}

function renderSourceChanges(changes) {
  const list = $('source-changes');
  list.textContent = '';
  $('source-change-count').textContent = changes.length ? changes.length + ' 个' : '';
  $('source-changes-empty').hidden = changes.length > 0;
  changes.forEach(function (row) {
    const li = el('li');
    li.appendChild(el('span', 'source-kind is-' + row.status, row.status));
    li.appendChild(el('span', 'source-path', row.path));
    li.appendChild(el('span', 'muted', row.label));
    list.appendChild(li);
  });
  $('btn-source-commit').disabled = changes.length === 0;
  $('source-hint').textContent = changes.length
    ? '只会提交上面这 ' + changes.length + ' 个文件；.admin-auth、部署凭据、bak/、public/ 会被排除。'
    : '工作区没有改动，不会产生空提交。';
}

function renderSourceCommits(commits, append, hasMore) {
  const list = $('source-commits');
  if (!append) list.textContent = '';
  commits.forEach(function (row) {
    const li = el('li');
    li.appendChild(el('span', 'source-sha', row.sha));
    li.appendChild(el('span', 'source-subject', row.subject || '(没有说明)'));
    const meta = el('span', 'source-meta', (row.relative ? row.relative + ' · ' : '') +
      (row.author ? row.author : ''));
    meta.title = (row.date || '') + (row.author ? ' · ' + row.author : '');
    li.appendChild(meta);
    list.appendChild(li);
  });
  state.source.offset = (append ? state.source.offset : 0) + commits.length;
  state.source.hasMore = hasMore;
  $('source-commits-empty').hidden = list.children.length > 0;
  const more = $('source-more');
  more.hidden = !hasMore;
  more.disabled = false;
}

function updateSourceCount() {
  $('source-count').textContent = $('source-message').value.length + ' / 200';
}

function renderSourceLog(text) {
  const log = $('source-log');
  log.textContent = String(text || '').trim() || '（没有输出）';
  log.scrollTop = log.scrollHeight;
}

async function commitSource() {
  const input = $('source-message');
  const message = input.value.trim();
  if (!message) {
    toast('请先写一句更新说明。', 'error');
    input.focus();
    return;
  }
  if (message.length > 200) {
    toast('提交说明不能超过 200 字。', 'error');
    return;
  }
  const info = state.source.info || {};
  const changes = info.changes || [];
  if (!changes.length) {
    toast('没有需要提交的改动。', 'error');
    return;
  }
  const ok = await confirmModal({
    title: '提交并推送源码',
    html: '<p>将提交 <strong>' + changes.length + ' 个文件</strong>，推送到 <code>' +
      escapeHtml(info.repo || '') + '</code> 的 <code>' + escapeHtml(info.branch || 'source') + '</code> 分支。</p>' +
      '<p>更新说明：<strong>' + escapeHtml(message) + '</strong></p>',
    confirmText: '提交并推送'
  });
  if (!ok) return;

  const btn = $('btn-source-commit');
  btn.disabled = true;
  btn.textContent = '正在提交…';
  $('source-hint').textContent = '正在 git add / commit / push，请稍等。';
  try {
    const data = await api('/source/commit', { method: 'POST', csrf: true, body: { message: message } });
    input.value = '';
    updateSourceCount();
    renderSourceLog(data.log);
    toast('已提交并推送：' + data.commit, 'ok');
    await loadSource();
  } catch (err) {
    const body = err.body || {};
    renderSourceLog(body.log || body.raw || err.message);
    if (body.committed) {
      toast('已提交到本地（' + (body.commit || '') + '），但推送失败。', 'error');
      $('source-hint').textContent = '已提交到本地、未推送：' + err.message;
      await loadSource();
    } else {
      toast('提交失败：' + err.message, 'error');
      $('source-hint').textContent = err.message;
    }
  } finally {
    btn.textContent = '提交并推送';
    btn.disabled = false;
  }
}

function renderRestoreResult(data) {
  const box = $('source-restore-result');
  const lines = [];
  lines.push('✓ 已恢复到 ' + data.shortTo + '（' + String(data.fromSha || '').slice(0, 7) + ' → ' + data.shortTo + '）');
  if (data.backup && data.backup.path) lines.push('备份：' + data.backup.path);
  if (data.backup && data.backup.count) lines.push('备份条目：' + data.backup.count + ' 个');
  if (data.dependencyWarning) lines.push('⚠ ' + data.dependencyWarning);
  if (data.generate && data.generate.ok === false) lines.push('✗ hexo generate 失败：' + data.generate.error);
  if (data.retained && data.retained.length) {
    lines.push('保留的未跟踪文件（' + data.retained.length + ' 个）：' +
      data.retained.slice(0, 12).join('、') + (data.retained.length > 12 ? ' …' : ''));
  }
  box.textContent = lines.join('\n');
  box.hidden = false;
  box.className = 'restore-result ' + (data.generate && data.generate.ok === false ? 'is-warn' : 'is-ok');
}

function renderRestoreError(backupPath, message) {
  const box = $('source-restore-result');
  box.textContent = '✗ 恢复未完成：' + message + (backupPath ? '\n已保留备份：' + backupPath : '');
  box.hidden = false;
  box.className = 'restore-result is-warn';
}

async function restoreSource() {
  const btn = $('btn-source-restore');
  btn.disabled = true;
  $('source-hint').textContent = '正在读取远端 source…';

  let info;
  try {
    info = await api('/source?remote=1');
  } catch (err) {
    toast('读取远端失败：' + err.message, 'error');
    $('source-hint').textContent = err.message;
    btn.disabled = false;
    return;
  }
  state.source.info = info;
  renderSource(info, false);

  const remote = info.remote || {};
  if (!remote.ok || !remote.sha) {
    toast('取不到远端 source：' + (remote.error || '分支可能还不存在'), 'error');
    $('source-hint').textContent = '无法读取远端 source，已取消恢复。' + (remote.error || '');
    btn.disabled = false;
    return;
  }

  const files = info.changes || [];
  const ok = await confirmModal({
    title: '用远端源码覆盖本地？',
    html: '<p>将丢弃本地未提交的修改，并已自动备份到 <code>bak/admin/restore/&lt;时间戳&gt;/</code>。</p>' +
      '<p>目标：远端 <code>' + escapeHtml(info.repo) + '</code> 的 <code>' + escapeHtml(info.branch) + '</code> 分支</p>' +
      '<p>当前 HEAD <code>' + escapeHtml(info.head || '未知') + '</code> → 目标 <code>' +
      escapeHtml(remote.sha.slice(0, 7)) + '</code></p>' +
      '<p>这会把本地 <code>' + escapeHtml(info.localBranch || 'main') + '</code> 指针改成与远端 <code>' +
      escapeHtml(info.branch) + '</code> 一致；只改本地，不会推送到远端。</p>' +
      '<p>会被覆盖的本地文件（' + files.length + ' 个）：</p>' +
      (files.length
        ? '<ul class="modal-files">' + files.map(function (row) {
          return '<li>' + escapeHtml(row.status) + ' ' + escapeHtml(row.path) + '</li>';
        }).join('') + '</ul>'
        : '<p class="muted">本地没有改动，仍会把 main 指向远端 source。</p>') +
      '<p>未跟踪文件会保留，不执行 <code>git clean</code>。恢复后会重新执行 hexo generate。</p>',
    confirmText: '备份并覆盖本地'
  });

  if (!ok) {
    btn.disabled = false;
    $('source-hint').textContent = '';
    return;
  }

  btn.textContent = '正在备份并覆盖…';
  $('source-hint').textContent = '正在备份 → fetch → reset --hard → hexo generate。';
  try {
    const data = await api('/source/restore', { method: 'POST', csrf: true, body: {} });
    renderSourceLog(data.log);
    renderRestoreResult(data);
    toast('已恢复到 ' + data.shortTo, 'ok');
    $('source-message').value = '';
    updateSourceCount();
    await loadSource();
  } catch (err) {
    const body = err.body || {};
    renderSourceLog(body.log || body.raw || err.message);
    if (body.backup && body.backup.path) renderRestoreError(body.backup.path, err.message);
    toast('恢复失败：' + err.message, 'error');
    $('source-hint').textContent = err.message;
    await loadSource();
  } finally {
    btn.textContent = '用远端源码覆盖本地';
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------ 一键打包 */

async function copyText(text) {
  const value = String(text == null ? '' : text);
  if (!value) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (e) { /* 降级到 execCommand */ }
  const area = el('textarea');
  area.value = value;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  area.remove();
  return ok;
}

function renderPackageModes() {
  const box = $('package-modes');
  box.textContent = '';
  state.package.modes.forEach(function (mode) {
    const label = el('label', 'pkg-mode');
    const input = el('input');
    input.type = 'radio';
    input.name = 'package-mode';
    input.value = mode.id;
    input.checked = mode.id === state.package.selected;
    input.addEventListener('change', function () {
      if (input.checked) state.package.selected = mode.id;
    });
    const body = el('span', 'pkg-mode-body');
    body.appendChild(el('strong', '', mode.label));
    body.appendChild(el('span', 'pkg-mode-desc', mode.description));
    label.appendChild(input);
    label.appendChild(body);
    box.appendChild(label);
  });
}

function packageLine(label, value) {
  const row = el('div', 'pkg-line');
  row.appendChild(el('span', 'pkg-label', label));
  row.appendChild(el('span', 'pkg-value', value));
  return row;
}

function renderPackageLast() {
  const box = $('package-last');
  const last = state.package.last;
  box.textContent = '';
  if (!last) {
    box.textContent = '还没有打包记录。';
    return;
  }
  box.appendChild(packageLine('文件', last.name || ''));
  box.appendChild(packageLine('大小', last.sizeText || formatBytes(last.size)));
  box.appendChild(packageLine('模式', last.mode === 'light' ? '轻量' : '完整'));
  box.appendChild(packageLine('时间', last.createdAt ? formatTime(last.createdAt) : ''));
  box.appendChild(packageLine('路径', last.file || ''));
}

function renderPackageResult(data) {
  const box = $('package-result');
  box.textContent = '';
  box.hidden = false;
  $('package-empty').hidden = true;

  box.appendChild(packageLine('文件', data.name || ''));
  box.appendChild(packageLine('大小', data.sizeText || formatBytes(data.size)));
  box.appendChild(packageLine('模式', data.mode === 'light' ? '轻量' : '完整'));
  box.appendChild(packageLine('压缩方式', (data.method || '') + (data.fallback ? '（tar 不可用，已回退到内置压缩）' : '')));
  box.appendChild(packageLine('条目', String(data.entries || 0)));
  box.appendChild(packageLine('路径', data.file || ''));

  const actions = el('div', 'pkg-actions');
  const copy = el('button', 'btn', '复制包路径');
  copy.type = 'button';
  copy.dataset.copy = data.file || '';
  actions.appendChild(copy);
  const tip = el('span', 'muted', '打开所在文件夹：复制路径后在资源管理器地址栏粘贴。');
  actions.appendChild(tip);
  box.appendChild(actions);
}

async function loadPackage() {
  try {
    const data = await api('/package');
    state.package.modes = data.modes || [];
    state.package.last = data.last || null;
    renderPackageModes();
    renderPackageLast();
  } catch (err) {
    if (err.status !== 401) toast('读取打包信息失败：' + err.message, 'error');
  }
}

async function runPackage() {
  if (state.package.busy) return;
  state.package.busy = true;
  const btn = $('btn-package');
  const stateBadge = $('package-state');
  btn.disabled = true;
  btn.textContent = '正在打包…';
  stateBadge.textContent = '打包中';
  stateBadge.className = 'badge badge-warn';
  $('package-hint').textContent = '正在收集文件 → 写入 MIGRATE.md / .env.example → 压缩，请稍等。';
  try {
    const data = await api('/package', {
      method: 'POST', csrf: true, body: { mode: state.package.selected }
    });
    state.package.last = data;
    renderPackageResult(data);
    renderPackageLast();
    stateBadge.textContent = '已完成';
    stateBadge.className = 'badge badge-ok';
    $('package-hint').textContent = '已生成：' + data.file;
    toast('打包完成：' + data.name, 'ok');
  } catch (err) {
    stateBadge.textContent = '失败';
    stateBadge.className = 'badge badge-err';
    $('package-hint').textContent = err.message;
    toast('打包失败：' + err.message, 'error');
  } finally {
    state.package.busy = false;
    btn.disabled = false;
    btn.textContent = '开始打包';
  }
}

/* ------------------------------------------------------------ SSH 面板 */

function sshKvRow(name, text, ok) {
  const row = el('div', 'ssh-kv-row');
  row.appendChild(el('code', '', name));
  const badge = el('span', ok ? 'is-ok' : 'is-missing', text);
  row.appendChild(badge);
  return row;
}

function renderSsh(data) {
  state.ssh.info = data;
  const keys = data.keys || {};
  const active = data.active || '';
  const ed = keys.ed25519 || {};
  const hasEd = !!(ed.private || ed.public);
  const publicKey = data.publicKey || '';

  $('ssh-summary').textContent = active
    ? (keys[active].label + ' 密钥已存在')
    : '还没有 SSH 密钥';
  $('ssh-note').textContent = active
    ? '私钥只保存在本机 ~/.ssh；这里只展示公钥与指纹，接口不回传私钥。'
    : '可以点下面按钮生成，或按页面提示手动生成。生成后私钥不会再回传页面。';

  const stateBadge = $('ssh-state');
  stateBadge.textContent = active ? '可用' : '待生成';
  stateBadge.className = 'badge ' + (active ? 'badge-ok' : 'badge-warn');

  const box = $('ssh-exists');
  box.textContent = '';
  ['ed25519', 'rsa'].forEach(function (id) {
    const item = keys[id] || {};
    box.appendChild(sshKvRow('~/.ssh/' + (id === 'ed25519' ? 'id_ed25519' : 'id_rsa'),
      (item.private ? '私钥存在' : '私钥不存在') + ' · ' + (item.public ? '公钥存在' : '公钥不存在'),
      item.private || item.public));
  });

  $('ssh-public').textContent = publicKey || '（还没有公钥）';
  $('ssh-fingerprint').textContent = data.fingerprint || '-';
  $('btn-copy-ssh').disabled = !publicKey;
  $('btn-ssh-keygen').disabled = hasEd || !!state.ssh.busy;
  $('btn-ssh-keygen').textContent = hasEd ? '已存在，不会覆盖' : '生成 ed25519 密钥';
  $('ssh-keygen-hint').textContent = hasEd
    ? '~/.ssh/id_ed25519 已存在，后台不会覆盖；直接复制上面的公钥去 GitHub 添加即可。'
    : '后台生成时使用空口令：非交互 git 推送依赖 BatchMode，带口令会要求 ssh-agent。';
  $('ssh-copy-hint').textContent = publicKey
    ? '复制后打开 https://github.com/settings/keys → New SSH key → 粘贴保存。'
    : '生成密钥后，这里会出现可复制的公钥。';
  $('ssh-command').textContent = data.testCommand || 'ssh -T git@github.com';
}

async function loadSsh() {
  try {
    const data = await api('/ssh');
    renderSsh(data);
  } catch (err) {
    if (err.status !== 401) {
      toast('读取 SSH 状态失败：' + err.message, 'error');
      $('ssh-summary').textContent = '读取失败';
      $('ssh-note').textContent = err.message;
    }
  }
}

async function keygenSsh() {
  if (state.ssh.busy) return;
  state.ssh.busy = true;
  const btn = $('btn-ssh-keygen');
  btn.disabled = true;
  btn.textContent = '正在生成…';
  $('ssh-keygen-hint').textContent = '正在执行 ssh-keygen，请稍等。';
  try {
    const data = await api('/ssh/keygen', { method: 'POST', csrf: true, body: {} });
    toast('已生成 ed25519 密钥', 'ok');
    $('ssh-copy-hint').textContent = '公钥已生成，复制后到 GitHub 添加。';
    await loadSsh();
    if (data.publicKey) copyText(data.publicKey);
  } catch (err) {
    $('ssh-keygen-hint').textContent = err.message;
    toast('生成失败：' + err.message, 'error');
  } finally {
    state.ssh.busy = false;
    btn.disabled = false;
    if ($('btn-ssh-keygen').textContent === '正在生成…') $('btn-ssh-keygen').textContent = '生成 ed25519 密钥';
  }
}

async function testSsh() {
  if (state.ssh.busy) return;
  state.ssh.busy = true;
  const btn = $('btn-ssh-test');
  const box = $('ssh-test-result');
  btn.disabled = true;
  btn.textContent = '正在测试…';
  box.hidden = false;
  box.className = 'restore-result';
  box.textContent = '正在执行 ssh -T git@github.com（最多 15 秒）…';
  try {
    const data = await api('/ssh/test', { method: 'POST', csrf: true, body: {} });
    const lines = [
      (data.ok ? '✓ ' : '✗ ') + (data.label || data.status || '未知结果'),
      data.hint || '',
      data.raw ? '原始输出：\n' + data.raw : ''
    ].filter(Boolean);
    box.textContent = lines.join('\n');
    box.className = 'restore-result ' + (data.ok ? 'is-ok' : 'is-warn');
    toast(data.ok ? 'SSH 认证成功' : (data.label || 'SSH 测试未通过'), data.ok ? 'ok' : 'error');
  } catch (err) {
    box.textContent = '✗ 测试失败：' + err.message;
    box.className = 'restore-result is-warn';
    toast('测试失败：' + err.message, 'error');
  } finally {
    state.ssh.busy = false;
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
}

async function loadPublish() {
  let deploy = null;
  try {
    const data = await api('/deploy');
    deploy = data.deploy;
  } catch (err) {
    toast('读取部署设置失败：' + err.message, 'error');
    return;
  }
  const repo = deploy && deploy.repo ? deploy.repo : '';
  state.deploy = deploy;
  $('deploy-repo').textContent = repo || '还没有配置部署仓库';
  $('deploy-note').textContent = repo
    ? '目标分支：' + deploy.branch + '（' + (deploy.mode === 'https' ? 'HTTPS + Token' : deploy.mode === 'ssh' ? 'SSH 密钥' : '本地路径') + '）。推送前会检查远端可达与分支存在，失败原因写在任务日志里。'
    : '在下方「部署设置」里填入你自己的博客仓库地址后，推送按钮才会可用。';
  const badge = $('deploy-state');
  badge.textContent = deployReadyText(deploy);
  badge.className = 'badge ' + (deploy && deploy.ready ? 'badge-ok' : 'badge-warn');

  $('deploy-input-repo').value = repo;
  $('deploy-input-branch').value = (deploy && deploy.branch) || 'main';
  $('deploy-input-enabled').checked = !!(deploy && deploy.enabled);
  $('deploy-input-token').value = '';
  renderDeployMode(deploy);

  const publishBtn = $('btn-publish');
  publishBtn.textContent = '生成并推送' + (repo && deploy.branch ? '（' + deploy.branch + '）' : '');
  const usable = !!(deploy && deploy.ready);
  publishBtn.disabled = !usable;
  $('publish-hint').textContent = usable
    ? '会先本地生成，再推送到 ' + repo + ' 的 ' + deploy.branch + ' 分支，推送前需要你确认一次。'
    : '推送暂不可用：' + (deploy.reason || deployReadyText(deploy));

  try {
    const data = await api('/publish');
    if (data.job) renderJob(data.job);
  } catch (e) { /* 忽略 */ }
}

async function saveDeploy(form) {
  const mode = repoModeOf($('deploy-input-repo').value);
  const body = {
    repo: $('deploy-input-repo').value.trim(),
    branch: $('deploy-input-branch').value.trim() || 'main',
    enabled: $('deploy-input-enabled').checked
  };
  const typed = $('deploy-input-token').value.trim();
  if (mode === 'https') {
    if (typed) body.token = typed;
  } else {
    // 切回 SSH 时顺手清掉不再需要的 Token
    body.token = '';
  }
  try {
    await api('/deploy', { method: 'PUT', body: body, csrf: true });
    toast('部署设置已保存', 'ok');
    loadPublish();
  } catch (err) {
    toast('保存失败：' + err.message, 'error');
  }
}

async function startJob(deploy, allowDelete, skipConfirm) {
  if (deploy && !skipConfirm) {
    const repo = $('deploy-repo').textContent;
    const branch = ($('deploy-input-branch').value || 'main').trim();
    const ok = await confirmModal({
      title: '确认推送',
      text: '将生成站点并推送到 ' + repo + ' 的 ' + branch + ' 分支。确认继续？',
      confirmText: '生成并推送'
    });
    if (!ok) return;
  }
  state.conflictShownFor = '';
  try {
    const data = await api('/publish', {
      method: 'POST',
      body: { deploy: !!deploy, allowDelete: allowDelete === true },
      csrf: true
    });
    renderJob(data.job);
    pollJob(data.job.id);
    toast(deploy ? (allowDelete ? '已确认覆盖，开始生成并推送…' : '开始生成并推送…') : '开始生成…', 'ok');
  } catch (err) {
    toast('启动失败：' + err.message, 'error');
  }
}

/**
 * 推送被「远端有非产物文件」拦下时，弹出确认框：
 * 列出会被删除的文件（中文路径已由后端解码），确认后只对这一次推送放行。
 */
async function maybePromptConflict(job) {
  if (!job || job.status !== 'failed') return;
  const files = job.conflictFiles || [];
  if (!files.length) return;
  if (state.conflictShownFor === job.id) return;
  state.conflictShownFor = job.id;

  const shown = files.slice(0, 200);
  const more = files.length - shown.length;
  const ok = await confirmModal({
    title: '远端有 ' + files.length + ' 个文件会被删除',
    html: '<p>下列文件在远端 ' + escapeHtml(job.branch || '目标') + ' 分支上，但不在本次生成的 public/ 产物里。</p>'
      + '<p>确认后这些远端文件会被删除，本次推送会覆盖该分支；本机源码和 public/ 不受影响。</p>'
      + '<ul class="conflict-list">' + shown.map(function (f) {
        return '<li>' + escapeHtml(f) + '</li>';
      }).join('') + '</ul>'
      + (more > 0 ? '<p class="hint">还有 ' + more + ' 个文件未显示，确认后同样会被删除。</p>' : '')
      + '<p class="hint">确认只对这一次推送生效；取消后远端保持不变，下次仍会拦截。</p>',
    confirmText: '确认删除并推送'
  });
  if (ok) startJob(true, true, true);
}

function jobStatusText(job) {
  if (!job) return '空闲';
  if (job.status === 'running') return job.phase === 'deploy' ? '正在推送' : '正在生成';
  if (job.status === 'success') return '已完成';
  if (job.status === 'failed') return '失败';
  return job.status;
}

function renderJob(job) {
  if (!job) return;
  const badge = $('job-status');
  badge.textContent = jobStatusText(job);
  badge.className = 'badge ' + (job.status === 'failed' ? 'badge-err' : job.status === 'running' ? 'badge-warn' : 'badge-ok');
  const kind = job.deploy ? '生成并推送' : '生成';
  const when = job.endedAt ? new Date(job.endedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  $('job-meta').textContent = kind + (job.auto ? '（保存后自动）' : '') + (when ? ' · ' + when : '');
  const log = $('job-log');
  log.textContent = job.log || '（暂无输出）';
  log.scrollTop = log.scrollHeight;
  maybePromptConflict(job);
}

function watchJob(job, queued) {
  if (!job) return;
  renderJob(job);
  if (queued) toast('已有任务在跑，已排队，结束后自动生成。', 'ok');
  if (job.status === 'running') pollJob(job.id);
}

function pollJob(id) {
  state.jobId = id;
  clearInterval(state.jobTimer);
  const tick = async function () {
    try {
      const data = await api('/publish/' + encodeURIComponent(id));
      renderJob(data.job);
      if (data.job.status !== 'running') {
        clearInterval(state.jobTimer);
        state.jobTimer = null;
        if (data.job.status === 'success') {
          // 生成成功后，功能开关保存的配置已经写进生成的页面里了。
          clearFeaturePending();
          toast(data.job.deploy ? '已推送到远端。' : '生成完成，前台已更新。', 'ok');
        } else if (data.job.conflictFiles && data.job.conflictFiles.length) {
          toast('推送已暂停：远端有 ' + data.job.conflictFiles.length + ' 个文件会被删除，请确认。', 'error');
        } else {
          toast('任务失败，原因见日志。', 'error');
        }
      }
    } catch (err) {
      clearInterval(state.jobTimer);
      state.jobTimer = null;
      toast('查询任务失败：' + err.message, 'error');
    }
  };
  tick();
  state.jobTimer = setInterval(tick, 1200);
}

/* ------------------------------------------------------------------ 历史 */

const ACTION_META = {
  create: { text: '新建', cls: 'badge-ok' },
  update: { text: '保存', cls: '' },
  delete: { text: '删除', cls: 'badge-warn' },
  config: { text: '配置', cls: '' },
  deploy: { text: '部署', cls: '' },
  restore: { text: '回退', cls: 'badge-warn' }
};

function formatTime(iso) {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return String(iso || '');
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function formatFieldValue(value) {
  const text = String(value == null ? '' : value);
  return text.length > 80 ? text.slice(0, 80) + '…' : text;
}

async function loadHistory() {
  const query = ['limit=100'];
  if (state.history.path) query.push('path=' + encodeURIComponent(state.history.path));
  if (state.history.action) query.push('action=' + encodeURIComponent(state.history.action));
  try {
    const data = await api('/revisions?' + query.join('&'));
    state.history.items = data.items || [];
    state.history.paths = data.paths || [];
    renderHistoryPaths();
    renderHistory();
  } catch (err) {
    toast('读取历史失败：' + err.message, 'error');
  }
}

function renderHistoryPaths() {
  const select = $('history-path');
  const current = state.history.path;
  select.textContent = '';
  const all = el('option', '', '全部文件');
  all.value = '';
  select.appendChild(all);
  state.history.paths.forEach(function (entry) {
    const option = el('option', '', entry.path + '（' + entry.count + '）');
    option.value = entry.path;
    select.appendChild(option);
  });
  // 当前筛选的文件可能不在统计里（比如只筛某个动作），补一个选项保持选中态
  if (current && !state.history.paths.some(function (entry) { return entry.path === current; })) {
    const option = el('option', '', current);
    option.value = current;
    select.appendChild(option);
  }
  select.value = current;
}

function renderHistory() {
  const list = $('history-list');
  list.textContent = '';
  const items = state.history.items;
  $('history-count').textContent = items.length ? '共 ' + items.length + ' 条' : '';
  items.forEach(function (item) {
    const row = el('article', 'history-row' + (item.purged ? ' is-purged' : ''));
    row.dataset.id = item.id;

    const main = el('div', 'history-main');
    const head = el('div', 'history-head');
    const meta = ACTION_META[item.action] || { text: item.action, cls: '' };
    head.appendChild(el('span', 'badge ' + meta.cls, meta.text));
    head.appendChild(el('strong', 'history-target', item.target || item.path));
    head.appendChild(el('span', 'history-time muted', formatTime(item.at)));
    main.appendChild(head);

    const info = el('div', 'history-meta');
    info.appendChild(el('span', 'meta-item', item.path));
    if (!item.purged) {
      const stats = item.stats || {};
      info.appendChild(el('span', 'meta-item meta-add', '+' + (stats.added || 0)));
      info.appendChild(el('span', 'meta-item meta-del', '-' + (stats.removed || 0)));
      info.appendChild(el('span', 'meta-item meta-dim', formatBytes(item.bytes)));
      if (item.restoreOf) info.appendChild(el('span', 'meta-item meta-dim', '回退自 ' + item.restoreOf));
    }
    main.appendChild(info);
    row.appendChild(main);

    const actions = el('div', 'history-actions');
    if (item.purged) {
      actions.appendChild(el('span', 'badge badge-warn', '已清理，仅剩记录'));
    } else {
      const view = el('button', 'ghost-btn', '查看差异');
      view.type = 'button';
      view.dataset.action = 'view';
      actions.appendChild(view);
      const restore = el('button', 'ghost-btn ghost-danger', item.action === 'delete' ? '恢复这篇文章' : '回退到这一版');
      restore.type = 'button';
      restore.dataset.action = 'restore';
      actions.appendChild(restore);
    }
    row.appendChild(actions);
    list.appendChild(row);
  });
  $('history-empty').hidden = items.length > 0;
}

function renderFieldTable(fields) {
  const table = el('table', 'diff-fields');
  const head = el('thead');
  const headRow = el('tr');
  ['字段', '旧值', '新值'].forEach(function (text) { headRow.appendChild(el('th', '', text)); });
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el('tbody');
  fields.forEach(function (field) {
    const row = el('tr');
    row.appendChild(el('th', 'field-name', field.label || field.key));
    row.appendChild(el('td', 'field-old', formatFieldValue(field.old)));
    row.appendChild(el('td', 'field-new', formatFieldValue(field.new)));
    body.appendChild(row);
  });
  table.appendChild(body);
  return table;
}

/** diff 只用 <pre> 行级着色，文本一律走 textContent，不拼 HTML。 */
function renderDiff(lines) {
  const pre = el('pre', 'diff');
  lines.forEach(function (line) {
    const row = document.createElement('span');
    row.className = 'diff-line diff-' + line.type;
    row.textContent = (line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  ') + line.text;
    pre.appendChild(row);
  });
  return pre;
}

async function openHistoryDetail(id) {
  const box = $('history-detail');
  box.hidden = false;
  $('history-detail-title').textContent = '加载中…';
  $('history-detail-meta').textContent = '';
  $('history-fields').textContent = '';
  $('history-diff').textContent = '';
  try {
    const data = await api('/revisions/' + encodeURIComponent(id));
    const record = data.record || {};
    const action = ACTION_META[record.action] || { text: record.action };
    $('history-detail-title').textContent = record.target || record.path || '修改详情';
    $('history-detail-meta').textContent =
      action.text + ' · ' + formatTime(record.at) + ' · ' + (record.path || '');

    const fields = data.fields || [];
    if (fields.length) $('history-fields').appendChild(renderFieldTable(fields));

    if (record.purged) {
      $('history-diff').appendChild(el('p', 'muted', '这条记录的内容已被清理，只剩下索引，无法查看差异或回退。'));
    } else {
      (data.files || []).forEach(function (file) {
        const block = el('div', 'diff-block');
        const blockHead = el('div', 'diff-block-head');
        blockHead.appendChild(el('strong', '', file.path));
        blockHead.appendChild(el('span', 'meta-dim', formatBytes(file.bytes)));
        block.appendChild(blockHead);
        const lines = file.diff || [];
        if (!lines.length) block.appendChild(el('p', 'muted', '内容没有变化。'));
        else block.appendChild(renderDiff(lines));
        $('history-diff').appendChild(block);
      });
    }

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  } catch (err) {
    toast('读取差异失败：' + err.message, 'error');
  }
}

async function restoreRevision(item) {
  const isDelete = item.action === 'delete';
  const ok = await confirmModal({
    title: isDelete ? '恢复这篇文章' : '回退到这一版',
    html: '<p>目标：<code>' + escapeHtml(item.target || item.path) + '</code><br>时间：' +
      escapeHtml(formatTime(item.at)) + '</p>' +
      '<p>当前内容会先另存为新版本，可再回退。</p>' +
      (isDelete ? '<p class="hint">这篇文章现在不存在，恢复会重新创建它。</p>' : ''),
    confirmText: isDelete ? '恢复' : '确认回退'
  });
  if (!ok) return;
  try {
    const data = await api('/revisions/' + encodeURIComponent(item.id) + '/restore', {
      method: 'POST', csrf: true, body: {}
    });
    toast(isDelete ? '已恢复，正在重新生成…' : '已回退，当前内容已另存为新版本。', 'ok');
    watchJob(data.build && data.build.job, data.build && data.build.queued);
    loadHistory();
    loadPosts();
    // 正打开着这篇文章且没有未保存改动时，重新载入，避免编辑器里还是旧内容
    if (state.editing && !state.dirty && !state.editing.isNew && item.path === state.editing.name) {
      try {
        const post = await api('/posts/' + encodeURIComponent(item.path));
        state.editing = { name: post.name, isNew: false };
        fillEditor(post);
        schedulePreview(true);
        $('editor-save-state').textContent = '已回退并重新载入';
      } catch (e) { /* 忽略 */ }
    }
  } catch (err) {
    toast('回退失败：' + err.message, 'error');
  }
}

function openHistoryForPost() {
  if (!state.editing || state.editing.isNew) {
    toast('新文章还没有历史记录，保存一次后才会出现。', 'error');
    return;
  }
  state.history.path = state.editing.name;
  state.history.action = '';
  $('history-action').value = '';
  switchView('history');
}

/* ------------------------------------------------------------------ 绑定 */

function bind() {
  state.bound = true;
  initTheme();

  $('theme-toggle').addEventListener('click', function () {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });

  $('login-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    const errBox = $('login-error');
    errBox.hidden = true;
    $('login-submit').disabled = true;
    try {
      await api('/login', {
        method: 'POST', auth: false,
        body: { username: $('login-user').value.trim(), password: $('login-pass').value }
      });
      await boot();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      $('login-submit').disabled = false;
    }
  });

  const retry = $('setup-retry');
  if (retry) {
    retry.addEventListener('click', function () {
      showBoot('正在重新检测…');
      boot();
    });
  }

  $('logout').addEventListener('click', async function () {
    try { await api('/logout', { method: 'POST', csrf: true }); } catch (e) { /* 忽略 */ }
    state.session = null;
    state.posts = [];
    clearInterval(state.jobTimer);
    showLogin();
  });

  document.querySelectorAll('.nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () { switchView(btn.dataset.view); });
  });

  // 历史
  $('history-path').addEventListener('change', function () {
    state.history.path = $('history-path').value;
    loadHistory();
  });
  $('history-action').addEventListener('change', function () {
    state.history.action = $('history-action').value;
    loadHistory();
  });
  $('history-refresh').addEventListener('click', function () { loadHistory(); });
  $('history-list').addEventListener('click', function (event) {
    const btn = event.target.closest('[data-action]');
    const row = event.target.closest('.history-row');
    if (!btn || !row) return;
    const item = state.history.items.find(function (entry) { return entry.id === row.dataset.id; });
    if (!item) return;
    if (btn.dataset.action === 'view') openHistoryDetail(item.id);
    else restoreRevision(item);
  });
  $('history-detail-close').addEventListener('click', function () {
    $('history-detail').hidden = true;
  });

  // 列表
  $('post-search').addEventListener('input', function () {
    state.query = $('post-search').value;
    renderPosts();
  });
  document.querySelectorAll('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      state.filter = chip.dataset.filter;
      document.querySelectorAll('.chip').forEach(function (other) {
        other.classList.toggle('is-active', other === chip);
      });
      renderPosts();
    });
  });
  $('post-list').addEventListener('click', function (event) {
    const row = event.target.closest('.post-row');
    if (!row) return;
    const action = (event.target.closest('[data-action]') || {}).dataset;
    if (!action) return;
    if (action.action === 'delete') return deletePostByName(row.dataset.name);
    openEditor(row.dataset.name);
  });
  $('btn-new').addEventListener('click', function () { openEditor(''); });

  // 编辑器
  $('editor-back').addEventListener('click', leaveEditor);
  $('editor-history').addEventListener('click', openHistoryForPost);
  $('editor-save').addEventListener('click', saveEditor);
  ['editor-title', 'editor-date', 'editor-categories', 'editor-tags', 'editor-cover', 'editor-description', 'editor-body']
    .forEach(function (id) {
      $(id).addEventListener('input', function () {
        setDirty(true);
        if (id === 'editor-body') { updateStats(); schedulePreview(); }
      });
    });
  ['editor-draft', 'editor-comments'].forEach(function (id) {
    $(id).addEventListener('change', function () { setDirty(true); });
  });
  document.querySelectorAll('.seg-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { setPane(btn.dataset.pane); });
  });

  // 导入 .md（按钮 + 拖入）
  $('editor-import-md').addEventListener('click', function () { $('import-file').click(); });
  $('import-file').addEventListener('change', function () {
    const file = this.files && this.files[0];
    this.value = '';
    importMarkdownFile(file);
  });
  const paneEdit = document.querySelector('.pane-edit');
  const dropHint = $('editor-drop');
  paneEdit.addEventListener('dragover', function (event) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    dropHint.hidden = false;
  });
  paneEdit.addEventListener('dragleave', function (event) {
    if (!paneEdit.contains(event.relatedTarget)) dropHint.hidden = true;
  });
  paneEdit.addEventListener('drop', function (event) {
    event.preventDefault();
    dropHint.hidden = true;
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) importMarkdownFile(file);
  });

  // 网页导入
  $('editor-import-url').addEventListener('click', openUrlModal);
  $('url-ok').addEventListener('click', submitUrlImport);
  $('url-cancel').addEventListener('click', closeUrlModal);
  document.querySelectorAll('[data-url-cancel]').forEach(function (node) {
    node.addEventListener('click', closeUrlModal);
  });
  $('url-input').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); submitUrlImport(); }
    if (event.key === 'Escape') closeUrlModal();
  });
  // 输入法组字期间不触发预览，避免半成品闪烁
  let composing = false;
  $('editor-body').addEventListener('compositionstart', function () { composing = true; });
  $('editor-body').addEventListener('compositionend', function () { composing = false; schedulePreview(); });
  $('editor-body').addEventListener('input', function () { if (!composing) schedulePreview(); });

  $('editor-body').addEventListener('scroll', function () {
    if (!$('editor-sync').checked || state.pane === 'edit') return;
    if (state.syncingScroll) return;
    const area = $('editor-body');
    const max = Math.max(1, area.scrollHeight - area.clientHeight);
    state.syncingScroll = true;
    const frame = $('preview-frame');
    if (frame.contentWindow) {
      frame.contentWindow.postMessage({ type: 'preview-scroll-to', ratio: area.scrollTop / max }, '*');
    }
    setTimeout(function () { state.syncingScroll = false; }, 60);
  });

  $('preview-frame').addEventListener('load', function () {
    state.previewReady = true;
    state.previewTries = 0;
    pushPreview();
  });

  window.addEventListener('message', function (event) {
    if (!event.data) return;
    if (event.data.type === 'preview-ready') {
      state.previewReady = true;
      pushPreview();
    }
    if (event.data.type === 'preview-scroll' && $('editor-sync').checked && state.pane !== 'edit') {
      if (state.syncingScroll) return;
      const area = $('editor-body');
      const max = Math.max(1, area.scrollHeight - area.clientHeight);
      state.syncingScroll = true;
      area.scrollTop = max * (Number(event.data.ratio) || 0);
      setTimeout(function () { state.syncingScroll = false; }, 60);
    }
  });

  // 配置
  $('config-save').addEventListener('click', saveConfig);

  // 功能开关
  $('feature-groups').addEventListener('click', function (event) {
    const button = event.target.closest('[data-action="toggle-feature"]');
    if (!button || button.disabled) return;
    toggleFeature(button.dataset.feature, button);
  });
  $('btn-regenerate').addEventListener('click', regenerateFromFeatures);

  // 发布
  $('btn-generate').addEventListener('click', function () { startJob(false); });
  $('btn-publish').addEventListener('click', function () { startJob(true); });
  $('deploy-form').addEventListener('submit', function (event) {
    event.preventDefault();
    saveDeploy(event.target);
  });
  $('deploy-input-repo').addEventListener('input', function () {
    renderDeployMode(state.deploy);
  });

  // 源码
  $('source-form').addEventListener('submit', function (event) {
    event.preventDefault();
    commitSource();
  });
  $('source-message').addEventListener('input', updateSourceCount);
  $('source-more').addEventListener('click', function () {
    $('source-more').disabled = true;
    loadSource(true);
  });
  $('btn-source-restore').addEventListener('click', restoreSource);

  // 一键打包
  $('btn-package').addEventListener('click', runPackage);
  $('package-result').addEventListener('click', function (event) {
    const btn = event.target.closest('[data-copy]');
    if (!btn) return;
    copyText(btn.dataset.copy).then(function (ok) {
      toast(ok ? '包路径已复制' : '复制失败，请手动选择路径', ok ? 'ok' : 'error');
    });
  });

  // SSH 面板
  $('btn-ssh-keygen').addEventListener('click', keygenSsh);
  $('btn-ssh-test').addEventListener('click', testSsh);
  $('btn-copy-ssh').addEventListener('click', function () {
    const publicKey = state.ssh.info && state.ssh.info.publicKey;
    if (!publicKey) return toast('还没有可复制的公钥', 'error');
    copyText(publicKey).then(function (ok) {
      toast(ok ? '公钥已复制' : '复制失败，请手动选择公钥文本', ok ? 'ok' : 'error');
    });
  });
  $('btn-copy-ssh-command').addEventListener('click', function () {
    const command = ($('ssh-command').textContent || 'ssh -T git@github.com').trim();
    copyText(command).then(function (ok) {
      toast(ok ? '测试命令已复制' : '复制失败，请手动选择命令', ok ? 'ok' : 'error');
    });
  });

  // 图床
  $('btn-oss-save').addEventListener('click', saveOss);
  $('btn-oss-test').addEventListener('click', testOss);

  const dropzone = $('oss-dropzone');
  const fileInput = $('oss-file');
  dropzone.addEventListener('click', function (event) {
    // 程序化点击 input 时事件会冒泡回 dropzone，这里要停住，避免无限触发。
    if (event.target === fileInput) return;
    fileInput.click();
  });
  dropzone.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  ['dragenter', 'dragover'].forEach(function (name) {
    dropzone.addEventListener(name, function (event) {
      event.preventDefault();
      dropzone.classList.add('is-over');
    });
  });
  ['dragleave', 'dragend'].forEach(function (name) {
    dropzone.addEventListener(name, function (event) {
      event.preventDefault();
      dropzone.classList.remove('is-over');
    });
  });
  dropzone.addEventListener('drop', function (event) {
    event.preventDefault();
    dropzone.classList.remove('is-over');
    handleOssFiles(event.dataTransfer && event.dataTransfer.files);
  });
  fileInput.addEventListener('change', function () {
    handleOssFiles(fileInput.files);
    fileInput.value = '';
  });

  $('oss-results').addEventListener('click', function (event) {
    const btn = event.target.closest('[data-copy],[data-insert]');
    if (!btn) return;
    if (btn.dataset.insert) {
      insertMarkdownIntoEditor(btn.dataset.insert);
      return;
    }
    copyText(btn.dataset.copy).then(function (ok) {
      toast(ok ? '已复制' : '复制失败，请手动选择文本', ok ? 'ok' : 'error');
    });
  });

  // 图床资源管理器
  $('oss-search').addEventListener('input', function () {
    state.oss.search = $('oss-search').value.trim().toLowerCase();
    renderOssGrid();
  });
  $('btn-oss-refresh').addEventListener('click', function () {
    loadOssObjects(true);
  });
  $('btn-oss-more').addEventListener('click', function () {
    loadOssObjects(false);
  });
  $('btn-oss-delete-selected').addEventListener('click', function () {
    deleteOssKeys(Object.keys(state.oss.selection));
  });
  $('oss-grid').addEventListener('change', function (event) {
    const box = event.target.closest('[data-oss-select]');
    if (!box) return;
    if (box.checked) state.oss.selection[box.dataset.ossSelect] = true;
    else delete state.oss.selection[box.dataset.ossSelect];
    updateOssSelection();
  });
  $('oss-grid').addEventListener('click', function (event) {
    const copy = event.target.closest('[data-oss-copy]');
    if (copy) {
      copyText(copy.dataset.ossCopy).then(function (ok) {
        toast(ok ? '已复制' : '复制失败，请手动选择文本', ok ? 'ok' : 'error');
      });
      return;
    }
    const preview = event.target.closest('[data-oss-preview]');
    if (preview) {
      openOssLightbox(preview.dataset.ossPreview, preview.dataset.ossPreviewName);
      return;
    }
    const del = event.target.closest('[data-oss-delete]');
    if (del) deleteOssKeys([del.dataset.ossDelete]);
  });
  $('oss-lightbox-close').addEventListener('click', closeOssLightbox);
  $('oss-lightbox').addEventListener('click', function (event) {
    if (event.target === $('oss-lightbox')) closeOssLightbox();
  });

  // 弹窗
  $('modal-ok').addEventListener('click', function () { closeModal(true); });
  $('modal-cancel').addEventListener('click', function () { closeModal(false); });
  document.querySelectorAll('[data-modal-cancel]').forEach(function (node) {
    node.addEventListener('click', function () { closeModal(false); });
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !$('oss-lightbox').hidden) {
      closeOssLightbox();
      return;
    }
    if (event.key === 'Escape' && !$('modal').hidden) {
      closeModal(false);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      if (!$('view-editor').hidden) {
        event.preventDefault();
        saveEditor();
      }
    }
  });

  window.addEventListener('beforeunload', function (event) {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  bindEditorTools();
}

boot();
