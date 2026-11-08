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
  ssh: { info: null, busy: false }
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
  ['posts', 'editor', 'config', 'features', 'history', 'source', 'package', 'ssh', 'publish'].forEach(function (view) {
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

  // 弹窗
  $('modal-ok').addEventListener('click', function () { closeModal(true); });
  $('modal-cancel').addEventListener('click', function () { closeModal(false); });
  document.querySelectorAll('[data-modal-cancel]').forEach(function (node) {
    node.addEventListener('click', function () { closeModal(false); });
  });

  document.addEventListener('keydown', function (event) {
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
}

boot();
