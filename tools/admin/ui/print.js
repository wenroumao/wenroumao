/**
 * tools/admin/ui/print.js —— 打印预览
 * ---------------------------------------------------------------------------
 * 内容由编辑页写入 localStorage（键在地址 # 后面），这里只负责排版：
 * 按 A4 高度主动分页（避免浏览器把代码块/表格拦腰截断），页脚可选页码。
 * 打印动作本身交给浏览器：点按钮 → 打印对话框 → 目标选「另存为 PDF」。
 */
(function () {
  'use strict';

  var pagesHost = document.getElementById('print-pages');
  var numbersToggle = document.getElementById('print-numbers');
  var printButton = document.getElementById('print-go');
  var closeButton = document.getElementById('print-close');

  var data = null;
  var numberPages = true;
  var templateNodes = null;
  var imagesSettled = false;

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function readData() {
    var key = String(location.hash || '').replace(/^#/, '');
    if (!key) return null;
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      localStorage.removeItem(key);
      var value = JSON.parse(raw);
      if (!value || typeof value.html !== 'string') return null;
      return value;
    } catch (err) {
      return null;
    }
  }

  function metaLine() {
    var parts = [];
    if (data.date) parts.push(escapeHtml(data.date));
    if (data.categories) parts.push(escapeHtml(data.categories));
    return parts.length ? '<div class="doc-meta">' + parts.join(' · ') + '</div>' : '';
  }

  function buildTemplate() {
    var head = document.createElement('header');
    head.className = 'doc-head';
    head.innerHTML = '<h1>' + escapeHtml(data.title || '未命名文章') + '</h1>' + metaLine();

    var body = document.createElement('div');
    body.className = 'doc-body';
    body.innerHTML = data.html || '<p class="preview-empty">（正文为空）</p>';

    templateNodes = [head].concat(Array.prototype.slice.call(body.children));
  }

  function newPage() {
    var page = document.createElement('div');
    page.className = 'page';
    var body = document.createElement('div');
    body.className = 'page-body';
    var foot = document.createElement('div');
    foot.className = 'page-foot';
    page.appendChild(body);
    page.appendChild(foot);
    pagesHost.appendChild(page);
    return { page: page, body: body, foot: foot };
  }

  /** 超长代码块按行拆到多页，避免被 overflow 裁掉。 */
  function splitCodeBlock(pre, limit) {
    var style = window.getComputedStyle(pre);
    var lineHeight = parseFloat(style.lineHeight);
    if (!lineHeight || !isFinite(lineHeight)) lineHeight = 21;
    var vertical = (parseInt(style.paddingTop, 10) || 0) + (parseInt(style.paddingBottom, 10) || 0) + 10;
    var capacity = Math.max(1, Math.floor((limit - vertical) / lineHeight * 0.92));
    var lines = String(pre.textContent || '').replace(/\n+$/, '').split('\n');
    if (lines.length <= capacity) return [pre];

    var pieces = [];
    var originalCode = pre.querySelector('code');
    for (var i = 0; i < lines.length; i += capacity) {
      var clone = pre.cloneNode(false);
      var code = document.createElement('code');
      if (originalCode && originalCode.className) code.className = originalCode.className;
      code.textContent = lines.slice(i, i + capacity).join('\n');
      clone.appendChild(code);
      pieces.push(clone);
    }
    return pieces;
  }

  function paginate() {
    var current = newPage();
    var limit = current.body.clientHeight;
    templateNodes.forEach(function (node) {
      var parts = node.tagName === 'PRE' ? splitCodeBlock(node, limit) : [node];
      parts.forEach(function (part) {
        current.body.appendChild(part);
        var overflow = current.body.scrollHeight > current.body.clientHeight + 1;
        if (overflow && current.body.childElementCount > 1) {
          current.body.removeChild(part);
          current = newPage();
          current.body.appendChild(part);
        }
      });
    });
  }

  function updateFooters() {
    var pages = Array.prototype.slice.call(pagesHost.querySelectorAll('.page'));
    pages.forEach(function (page, index) {
      var foot = page.querySelector('.page-foot');
      foot.hidden = !numberPages;
      if (!numberPages) { foot.textContent = ''; return; }
      foot.innerHTML = '<span>' + escapeHtml((data.title || '').slice(0, 40)) + '</span>' +
        '<span>' + (index + 1) + ' / ' + pages.length + '</span>';
    });
  }

  function pendingImages() {
    return Array.prototype.filter.call(pagesHost.querySelectorAll('img'), function (img) {
      return !img.complete;
    });
  }

  function watchImages() {
    var pending = pendingImages();
    if (!pending.length || imagesSettled) return;
    var remaining = pending.length;
    function settle() {
      remaining -= 1;
      if (remaining > 0) return;
      imagesSettled = true;
      setTimeout(render, 40);
    }
    pending.forEach(function (img) {
      img.addEventListener('load', settle, { once: true });
      img.addEventListener('error', settle, { once: true });
    });
  }

  function render() {
    pagesHost.textContent = '';
    if (!data) {
      var empty = document.createElement('p');
      empty.className = 'print-empty';
      empty.textContent = '没有找到要打印的内容。请回到后台编辑页，重新点「导出 PDF」。';
      pagesHost.appendChild(empty);
      return;
    }
    if (!templateNodes) buildTemplate();
    paginate();
    updateFooters();
    watchImages();
  }

  data = readData();
  try {
    numberPages = localStorage.getItem('admin.printNumbers') !== '0';
  } catch (err) {
    numberPages = true;
  }
  if (numbersToggle) numbersToggle.checked = numberPages;

  if (numbersToggle) {
    numbersToggle.addEventListener('change', function () {
      numberPages = numbersToggle.checked;
      try { localStorage.setItem('admin.printNumbers', numberPages ? '1' : '0'); } catch (err) { /* 忽略 */ }
      render();
    });
  }

  if (printButton) {
    printButton.addEventListener('click', function () {
      window.print();
    });
  }
  if (closeButton) {
    closeButton.addEventListener('click', function () { window.close(); });
  }

  render();
})();
