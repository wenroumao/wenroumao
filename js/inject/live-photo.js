/*!
 * live-photo.js —— 实况照片（Live Photo）交互（站点独立脚本，不改主题源码）
 * ---------------------------------------------------------------------------
 * 作用页：/box/gallery/live/（source/box/gallery/live/index.md 里手写的 .live-photo-container）。
 *
 * 移植来源：wenroumao.cn 的 /js/live_photo.js（原生 JS，无库依赖），按本站需要精简：
 *   · 不做 canvas 抽帧：封面只用 <video poster>，跨域视频会污染 canvas、toDataURL 抛 SecurityError；
 *   · 不依赖 pjax / 主题内部变量，改成 MutationObserver + window.load 刷新；
 *   · 全局默认播放方式由后台「功能开关 → 实况照片播放方式」统一控制，前端读
 *     /admin/api/live-photo-mode（每次请求直接读 _config.fomalhaut.yml，后台切换后刷新即生效，
 *     不需要重启 hexo server 或重新构建）；接口不可用（例如纯静态站）时回退到构建期注入的
 *     <meta name="live-photo-default-mode">。页面里不再对单张图写死播放方式。
 *   · 同一时刻只播一个；标签页隐藏（visibilitychange）时全部暂停；
 *   · hover 模式只在「鼠标 + 精确指针」设备上绑定悬停，触屏走点击播放；
 *   · press 模式下长按会先被 touchmove 取消，避免抢走页面滚动；
 *   · 尊重 prefers-reduced-motion：仍可播放，但额外缩放在 CSS 里关掉。
 *
 * 结构约定（每条实况照片）：
 *   .live-photo-container[data-duration]
 *     .live-photo-wrapper
 *       img.live-photo-still.no-lightbox
 *       video.live-photo-video[poster]
 *       .live-photo-indicator
 *       .live-photo-tip
 *
 * 卸载：删掉 _config.fomalhaut.yml inject.head 里引入本文件的 <script> 即可。
 */

(function () {
  'use strict';

  if (window.__livePhotoGalleryLoaded) return;
  window.__livePhotoGalleryLoaded = true;

  var DEFAULT_DURATION = 3;
  var DEFAULT_PRESS_DELAY = 300;

  /* 先取构建期 meta 作兜底，再用运行时 JSON 覆盖（后台保存后无需重启 hexo server）。 */
  var DEFAULT_PLAY_MODE = 'hover';
  var playModeMeta = document.querySelector('meta[name="live-photo-default-mode"]');
  if (playModeMeta) {
    var metaMode = playModeMeta.getAttribute('content');
    if (metaMode === 'hover' || metaMode === 'press') DEFAULT_PLAY_MODE = metaMode;
  }

  var supportsHover = true;
  if (window.matchMedia) {
    supportsHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  }

  function parseNumber(value, fallback) {
    var n = parseFloat(value);
    return isFinite(n) ? n : fallback;
  }

  function clampRatio(ratio) {
    return Math.max(0.5, Math.min(3, ratio));
  }

  /* -------------------------------------------------------------- 实例集合 */

  var items = [];
  var observer = null;
  var refreshTimer = null;

  function initAll() {
    var containers = document.querySelectorAll('.live-photo-container');
    Array.prototype.forEach.call(containers, setup);
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      initAll();
    }, 100);
  }

  /* -------------------------------------------------------------- 单个实例 */

  function setup(container) {
    if (container.dataset.livePhotoReady === '1') return;

    var wrapper = container.querySelector('.live-photo-wrapper');
    var video = container.querySelector('.live-photo-video');
    var still = container.querySelector('.live-photo-still');
    var indicator = container.querySelector('.live-photo-indicator');
    var progress = container.querySelector('.live-photo-progress');

    if (!wrapper || !video || !still) return;

    container.dataset.livePhotoReady = '1';

    /* 主题懒加载会把 src 换成占位 GIF、真实地址放 data-lazy-src。
       这里还原一次，保证本脚本先跑、懒加载后跑时静图也已经可见。 */
    var realSrc = still.getAttribute('data-lazy-src');
    if (realSrc && still.getAttribute('src') !== realSrc) {
      still.setAttribute('src', realSrc);
    }

    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');

    var playMode = DEFAULT_PLAY_MODE;

    var item = {
      container: container,
      wrapper: wrapper,
      video: video,
      still: still,
      indicator: indicator,
      progress: progress,
      duration: parseNumber(container.dataset.duration, DEFAULT_DURATION),
      playMode: playMode,
      pressDelay: parseNumber(container.dataset.pressDelay, DEFAULT_PRESS_DELAY),
      showProgress: container.dataset.showProgress !== 'false',
      playing: false,
      timer: null,
      pressTimer: null,
      raf: null,
      rafStart: 0,
      failed: false,
      bindings: []
    };

    if (!item.showProgress && progress) {
      progress.style.display = 'none';
    }

    if (!window.CSS || !window.CSS.supports || !window.CSS.supports('aspect-ratio', '1')) {
      container.classList.add('aspect-ratio-fallback');
    }

    bindEvents(item);
    bindMediaEvents(item);
    bindKeyboard(item);

    items.push(item);
  }

  function on(el, type, handler, options) {
    el.addEventListener(type, handler, options);
    return { el: el, type: type, handler: handler, options: options };
  }

  function bindEvents(item) {
    var b = item.bindings;

    if (item.playMode === 'press') {
      /* 长按：鼠标 / 触屏统一走定时器；移动超过 10px 取消，避免抢滚动。 */
      var startPress = function () {
        clearTimeout(item.pressTimer);
        item.pressTimer = setTimeout(function () {
          start(item);
        }, item.pressDelay);
      };
      var stopPress = function () {
        clearTimeout(item.pressTimer);
        item.pressTimer = null;
        stop(item);
      };

      b.push(on(item.container, 'mousedown', function (e) {
        if (e.button !== 0) return;
        startPress();
      }));
      b.push(on(item.container, 'mouseup', stopPress));
      b.push(on(item.container, 'mouseleave', stopPress));

      var touchStartX = 0;
      var touchStartY = 0;
      var touchMoved = false;

      b.push(on(item.container, 'touchstart', function (e) {
        if (e.touches.length !== 1) return;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchMoved = false;
        startPress();
      }, { passive: true }));

      b.push(on(item.container, 'touchmove', function (e) {
        if (touchMoved || e.touches.length !== 1) return;
        var dx = Math.abs(e.touches[0].clientX - touchStartX);
        var dy = Math.abs(e.touches[0].clientY - touchStartY);
        if (dx > 10 || dy > 10) {
          touchMoved = true;
          clearTimeout(item.pressTimer);
          item.pressTimer = null;
        }
      }, { passive: true }));

      b.push(on(item.container, 'touchend', stopPress));
      b.push(on(item.container, 'touchcancel', stopPress));

      b.push(on(item.container, 'contextmenu', function (e) {
        e.preventDefault();
      }));

      return;
    }

    /* hover 模式：桌面悬停；触屏点一下播放 duration 秒后自动停。 */
    if (supportsHover) {
      b.push(on(item.container, 'mouseenter', function () {
        start(item);
      }));
      b.push(on(item.container, 'mouseleave', function () {
        stop(item);
      }));
    }

    var tapX = 0;
    var tapY = 0;

    b.push(on(item.container, 'touchstart', function (e) {
      if (e.touches.length !== 1) return;
      tapX = e.touches[0].clientX;
      tapY = e.touches[0].clientY;
    }, { passive: true }));

    b.push(on(item.container, 'touchend', function (e) {
      var touch = e.changedTouches && e.changedTouches[0];
      if (!touch) return;
      if (Math.abs(touch.clientX - tapX) > 10 || Math.abs(touch.clientY - tapY) > 10) return;
      start(item);
    }, { passive: true }));
  }

  function bindMediaEvents(item) {
    var video = item.video;
    var b = item.bindings;

    b.push(on(video, 'loadstart', function () {
      item.container.classList.add('loading');
    }));

    b.push(on(video, 'loadedmetadata', function () {
      item.container.classList.remove('loading');
      adjustRatio(item);
    }));

    b.push(on(video, 'canplay', function () {
      item.container.classList.remove('loading');
    }));

    b.push(on(video, 'ended', function () {
      stop(item);
    }));

    b.push(on(video, 'error', function () {
      fail(item);
    }));
  }

  function bindKeyboard(item) {
    if (!item.container.hasAttribute('tabindex')) return;

    item.bindings.push(on(item.container, 'keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (item.playing) {
        stop(item);
      } else {
        start(item);
      }
    }));
  }

  function adjustRatio(item) {
    var video = item.video;
    if (!video.videoWidth || !video.videoHeight) return;
    var ratio = clampRatio(video.videoWidth / video.videoHeight);

    if (window.CSS && window.CSS.supports && window.CSS.supports('aspect-ratio', '1')) {
      item.container.style.aspectRatio = String(ratio);
      item.container.style.paddingTop = '';
    } else {
      item.container.classList.add('aspect-ratio-fallback');
      item.container.style.paddingTop = (100 / ratio) + '%';
    }
  }

  /* -------------------------------------------------------------- 播放控制 */

  function start(item) {
    if (item.playing) return;
    if (item.failed) return;

    stopAll(item);

    item.playing = true;
    item.container.classList.add('playing');

    var promise = item.video.play();
    if (promise && typeof promise.catch === 'function') {
      promise.catch(function (err) {
        /* 只有明确的格式不支持才永久标错；AbortError / NotAllowedError 等临时失败恢复状态，
           下次交互还能再试，避免一次失败就把卡片变成「点了不动」。 */
        if (err && err.name === 'NotSupportedError') {
          fail(item);
          return;
        }
        stop(item);
      });
    }

    startProgress(item);

    clearTimeout(item.timer);
    item.timer = setTimeout(function () {
      stop(item);
    }, item.duration * 1000);
  }

  function stop(item) {
    if (!item.playing) {
      clearTimeout(item.pressTimer);
      item.pressTimer = null;
      return;
    }

    item.playing = false;
    item.container.classList.remove('playing');
    clearTimeout(item.timer);
    item.timer = null;
    stopProgress(item);

    try {
      item.video.pause();
      item.video.currentTime = 0;
    } catch (e) {
      /* 某些浏览器在元数据未就绪时写 currentTime 会抛，忽略即可 */
    }
  }

  function stopAll(except) {
    for (var i = 0; i < items.length; i++) {
      if (items[i] !== except) stop(items[i]);
    }
  }

  function fail(item) {
    item.failed = true;
    item.container.classList.add('error');
    item.container.classList.remove('loading');
    stop(item);

    var tip = item.container.querySelector('.live-photo-tip');
    if (tip && !tip.textContent) {
      tip.textContent = '当前浏览器无法播放该视频格式';
    }
  }

  /* -------------------------------------------------------------- 进度条 */

  function startProgress(item) {
    if (!item.showProgress || !item.progress) return;

    item.rafStart = 0;
    item.progress.style.width = '0%';

    var step = function (timestamp) {
      if (!item.playing) return;
      if (!item.rafStart) item.rafStart = timestamp;

      var pct = Math.min(((timestamp - item.rafStart) / (item.duration * 1000)) * 100, 100);
      item.progress.style.width = pct + '%';

      if (pct < 100) {
        item.raf = requestAnimationFrame(step);
      }
    };

    item.raf = requestAnimationFrame(step);
  }

  function stopProgress(item) {
    if (item.raf) {
      cancelAnimationFrame(item.raf);
      item.raf = null;
    }
    if (item.progress) item.progress.style.width = '0%';
  }

  /* -------------------------------------------------------------- 全局事件 */

  function refresh() {
    initAll();
  }

  function init() {
    initAll();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initAll);
    }

    window.addEventListener('load', initAll);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopAll(null);
    });

    if (window.MutationObserver) {
      observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var nodes = mutations[i].addedNodes;
          for (var j = 0; j < nodes.length; j++) {
            var node = nodes[j];
            if (node.nodeType !== 1) continue;
            if (node.classList.contains('live-photo-container') ||
                (node.querySelector && node.querySelector('.live-photo-container'))) {
              scheduleRefresh();
              return;
            }
          }
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function boot() {
    if (window.__livePhotoGalleryBooted) return;
    window.__livePhotoGalleryBooted = true;
    /* 播放方式是全局的：挂在 html 上供 CSS 判断按压反馈，避免逐张写死。 */
    document.documentElement.setAttribute('data-live-photo-mode', DEFAULT_PLAY_MODE);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  /* 运行时接口优先：后台保存后刷新页面即可读到新值，不依赖构建产物或服务重启。 */
  var bootTimer = setTimeout(boot, 1500);
  if (window.fetch) {
    fetch('/admin/api/live-photo-mode?ts=' + Date.now(), {
      cache: 'no-store',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var mode = data && (data.play_mode || data.playMode);
        if (mode === 'hover' || mode === 'press') DEFAULT_PLAY_MODE = mode;
      })
      .catch(function () { /* 接口不可用时就用 meta / hover 兜底 */ })
      .then(function () {
        clearTimeout(bootTimer);
        boot();
      });
  } else {
    clearTimeout(bootTimer);
    boot();
  }

  /* 暴露给控制台排查用，不参与页面逻辑 */
  window.LivePhotoGallery = {
    refresh: refresh,
    stopAll: function () { stopAll(null); }
  };
})();
