/**
 * 预览 iframe：接收父页渲染结果，只替换正文容器，
 * 样式与字体全部复用站点自己的 /css/index.css。
 */
(function () {
  var container = document.getElementById('article-container');
  var lastHtml = null;

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }

  function reportScroll() {
    var doc = document.documentElement;
    var max = Math.max(1, doc.scrollHeight - window.innerHeight);
    parent.postMessage({ type: 'preview-scroll', ratio: window.scrollY / max }, '*');
  }

  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data || {};

    if (data.type === 'preview-render') {
      applyTheme(data.theme);
      var html = String(data.html == null ? '' : data.html);
      if (html !== lastHtml) {
        lastHtml = html;
        container.innerHTML = html || '<p class="preview-empty">开始输入，这里会实时显示前台效果。</p>';
      }
      parent.postMessage({ type: 'preview-rendered', empty: !html }, '*');
      return;
    }

    if (data.type === 'preview-theme') {
      applyTheme(data.theme);
      return;
    }

    if (data.type === 'preview-scroll-to') {
      var doc = document.documentElement;
      var max = Math.max(1, doc.scrollHeight - window.innerHeight);
      window.scrollTo(0, Math.round(max * Math.min(1, Math.max(0, Number(data.ratio) || 0))));
    }
  });

  window.addEventListener('scroll', reportScroll, { passive: true });
  parent.postMessage({ type: 'preview-ready' }, '*');
})();
