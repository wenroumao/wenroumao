/* ============================================================================
 * source/js/inject/motion-effects.js —— 首页 ReactBits 风格动效（原生实现）
 * ----------------------------------------------------------------------------
 * 四个效果，各自独立开关（_config.fomalhaut.yml → motion_effects.*.enable）：
 *   1. text_reveal      站点标题逐字进场：拆字 + 逐字淡入 / 上浮 / 消模糊
 *   2. gradient_text    站点标题流光渐变：渐变在文字内缓慢平移
 *   3. card_spotlight   首页文章卡片跟随鼠标的聚光高光（仅精确指针设备）
 *   4. grid_background  首屏头图网格 + 跟随鼠标的柔光（触屏 / 减少动态下退化为静态网格）
 *
 * 性能与降级约定（硬要求）：
 *   · 本脚本由构建期 scripts/motion-inject.js 以 defer 注入，且只在首页注入，
 *     不进入关键渲染路径；CSS 也用 media=print + onload 异步加载。
 *   · 所有效果都是「JS 加类之后才生效」的渐进增强：脚本加载失败 / 禁用 JS /
 *     语法报错时，标题与卡片保持原样，首屏内容完整可见。
 *   · prefers-reduced-motion: reduce：逐字与流光完全不做，聚光关闭，网格退化为静态纹理。
 *   · 触屏（hover:none / pointer:coarse）：不创建鼠标柔光与聚光，不会出现卡住的悬停态。
 *   · 页面隐藏（visibilitychange）时给 <html> 加 fm-motion-paused，暂停 CSS 动画；
 *     聚光 / 网格的指针跟随同时停掉。标题离开视口时流光单独暂停（IntersectionObserver）。
 *   · 指针事件全部用 requestAnimationFrame 合并，每帧最多一次坐标读写；不遍历 DOM 树，
 *     不碰布局属性（只写 transform / opacity / CSS 变量）。
 *
 * 调试：控制台执行 __FMOTION_DEBUG.state() 查看当前开关与暂停状态；
 *       __FMOTION_DEBUG.refresh() 可在 pjax 异常后手动重建。
 * ========================================================================== */
(function (w, d) {
  'use strict';

  var CFG = w.__FMOTION__ || {};
  var FLAGS = {
    textReveal: CFG.textReveal === true,
    gradientText: CFG.gradientText === true,
    cardSpotlight: CFG.cardSpotlight === true,
    gridBackground: CFG.gridBackground === true
  };

  function mql(query) {
    try { return typeof w.matchMedia === 'function' ? w.matchMedia(query) : null; } catch (e) { return null; }
  }
  var motionQuery = mql('(prefers-reduced-motion: reduce)');
  var fineQuery = mql('(hover: hover) and (pointer: fine)');
  var reduceMotion = !!(motionQuery && motionQuery.matches);
  var finePointer = !!(fineQuery && fineQuery.matches);

  /* 每个效果注册的监听器 / 观察器，重建前统一注销，避免 pjax 多次进入首页后越挂越多 */
  var cleanups = [];
  var observers = [];
  var rafId = 0;
  var pageAway = false;

  var nodes = { title: null, posts: null, header: null, gridLayer: null, gridGlow: null };
  var splitState = null;
  var activeCard = null;
  var gradientAnims = [];    /* Web Animations 实例：只动 background-position，不占用 CSS animation 属性 */
  var titleOffscreen = false;

  function listen(target, type, fn, opts) {
    if (!target || !target.addEventListener) return;
    target.addEventListener(type, fn, opts);
    cleanups.push(function () { target.removeEventListener(type, fn, opts); });
  }

  function observe(io) { observers.push(io); }

  function cancelRaf() {
    if (rafId) { w.cancelAnimationFrame(rafId); rafId = 0; }
  }

  function isPaused() { return pageAway || !!d.hidden; }

  function setPausedClass() {
    var root = d.documentElement;
    if (!root) return;
    if (isPaused()) root.classList.add('fm-motion-paused');
    else root.classList.remove('fm-motion-paused');
  }

  /* 按「字素簇」切分：中文、emoji、组合字符都不会被切成半个 */
  function splitGraphemes(str) {
    str = String(str == null ? '' : str);
    try {
      if (w.Intl && w.Intl.Segmenter) {
        var seg = new w.Intl.Segmenter(undefined, { granularity: 'grapheme' });
        var out = [], it = seg.segment(str)[Symbol.iterator](), r;
        while (!(r = it.next()).done) out.push(r.value.segment);
        return out;
      }
    } catch (e) { /* 退回按码位切 */ }
    return Array.prototype.slice.call(str);
  }

  /* ------------------------------ 1. 逐字进场 ------------------------------ */
  function initTextReveal() {
    var title = d.getElementById('site-title');
    if (!title) return;
    nodes.title = title;

    /* 减少动态偏好：不拆字，标题保持主题原样 */
    if (reduceMotion) return;

    var text = title.textContent;
    if (!text || text.length > 72) return;
    var chars = splitGraphemes(text);
    if (!chars.length || chars.length > 72) return;

    var frag = d.createDocumentFragment();
    for (var i = 0; i < chars.length; i++) {
      var span = d.createElement('span');
      span.className = 'fm-char';
      span.textContent = chars[i];
      span.style.setProperty('--fm-i', i);
      frag.appendChild(span);
    }

    /* 先记录原文再清空：即使 append 中途抛错，teardown 也能把文字还原 */
    splitState = { node: title, text: text };
    title.setAttribute('data-fm-split', '1');
    title.textContent = '';
    title.appendChild(frag);
    title.classList.add('fm-split');
  }

  /* ------------------------------ 2. 流光渐变 ------------------------------ */
  function initGradient() {
    var title = d.getElementById('site-title');
    if (!title) return;
    nodes.title = nodes.title || title;

    /* 减少动态偏好：不加渐变类，保持主题原本的纯色标题 */
    if (reduceMotion) return;

    /* 与逐字进场叠加时，渐变必须做在每颗字符上；否则字符的 transform / filter
       会形成独立合成层，父元素的 background-clip:text 裁剪不到，字形会变成透明 */
    var chars = title.querySelectorAll('.fm-char');
    var charMode = chars.length > 0;
    var targets;
    if (charMode) {
      title.classList.add('fm-gradient-chars');
      targets = Array.prototype.slice.call(chars);
    } else {
      title.classList.add('fm-gradient');
      targets = [title];
    }

    /* 用 Web Animations 只动 background-position：
       · 不占用 CSS 的 animation 属性，主题原有的霓虹 light_15px 动画不会被顶掉；
       · 可以精确 pause / play，页面隐藏与离开视口时都不空转；
       · 逐字模式下按索引给负延迟，形成从左到右扫过的光带。
       不支持 Element.animate 的老浏览器保留静态渐变，文字依旧完整可读。 */
    if (typeof title.animate === 'function') {
      try {
        for (var gi = 0; gi < targets.length; gi++) {
          if (typeof targets[gi].animate !== 'function') continue;
          gradientAnims.push(targets[gi].animate(
            [{ backgroundPosition: '0% 50%' }, { backgroundPosition: '200% 50%' }],
            {
              duration: 7500,
              iterations: Infinity,
              easing: 'linear',
              delay: charMode ? -(gi * 140) : 0
            }
          ));
        }
        syncGradient();
      } catch (e) { cancelGradient(); }
    }

    /* 标题滚出视口时暂停流光，减少不可见动画的持续开销 */
    if ('IntersectionObserver' in w) {
      var io = new w.IntersectionObserver(function (entries) {
        var entry = entries[0];
        if (!entry) return;
        titleOffscreen = !entry.isIntersecting;
        if (titleOffscreen) title.classList.add('fm-offscreen');
        else title.classList.remove('fm-offscreen');
        syncGradient();
      }, { threshold: 0 });
      io.observe(title);
      observe(io);
    }
  }

  /* 页面隐藏 / 标题离开视口 → 暂停；恢复可见且标题回到视口 → 继续 */
  function syncGradient() {
    var pause = isPaused() || titleOffscreen;
    for (var i = 0; i < gradientAnims.length; i++) {
      var anim = gradientAnims[i];
      if (pause) {
        if (anim.playState === 'running') anim.pause();
      } else if (anim.playState === 'paused') {
        anim.play();
      }
    }
  }

  function cancelGradient() {
    for (var i = 0; i < gradientAnims.length; i++) {
      try { gradientAnims[i].cancel(); } catch (e) { /* ignore */ }
    }
    gradientAnims = [];
  }

  /* ---------------------------- 3. 卡片聚光高光 ---------------------------- */
  function closestCard(el, root) {
    while (el && el !== root) {
      if (el.classList && el.classList.contains('recent-post-item')) return el;
      el = el.parentElement;
    }
    return null;
  }

  function deactivateCard() {
    if (activeCard) {
      activeCard.classList.remove('fm-spot-active');
      activeCard = null;
    }
  }

  function initSpotlight() {
    var posts = d.getElementById('recent-posts');
    if (!posts) return;
    nodes.posts = posts;
    posts.classList.add('fm-spotlight-host');

    var pending = null;

    function apply() {
      rafId = 0;
      if (!pending || isPaused()) { pending = null; return; }
      var evt = pending;
      pending = null;
      if (evt.pointerType && evt.pointerType !== 'mouse') return;

      var card = closestCard(evt.target, posts);
      if (!card) { deactivateCard(); return; }
      if (card !== activeCard) {
        deactivateCard();
        activeCard = card;
        card.classList.add('fm-spot-active');
      }
      /* 读一次矩形，随后只写 CSS 变量（不触发布局），读写在同一个 rAF 内合并 */
      var rect = card.getBoundingClientRect();
      card.style.setProperty('--fm-x', (evt.clientX - rect.left).toFixed(1) + 'px');
      card.style.setProperty('--fm-y', (evt.clientY - rect.top).toFixed(1) + 'px');
    }

    function onMove(evt) {
      if (evt.pointerType && evt.pointerType !== 'mouse') return;
      pending = {
        target: evt.target,
        clientX: evt.clientX,
        clientY: evt.clientY,
        pointerType: evt.pointerType
      };
      if (!rafId) rafId = w.requestAnimationFrame(apply);
    }

    function onLeave() {
      pending = null;
      deactivateCard();
    }

    listen(posts, 'pointermove', onMove, { passive: true });
    listen(posts, 'pointerleave', onLeave, { passive: true });
    listen(posts, 'pointercancel', onLeave, { passive: true });
    listen(w, 'blur', onLeave);
  }

  /* -------------------------- 4. 背景网格 + 鼠标柔光 -------------------------- */
  function initGrid() {
    var header = d.getElementById('page-header');
    if (!header || !header.classList.contains('full_page')) return;
    nodes.header = header;

    var layer = d.createElement('div');
    layer.className = 'fm-grid-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.setAttribute('role', 'presentation');
    /* 放在 :before 遮罩之后、标题之前，保证网格压在头图上但不挡文字 */
    header.insertBefore(layer, header.firstChild);
    nodes.gridLayer = layer;

    /* 触屏 / 减少动态：只保留静态网格，不创建鼠标柔光 */
    if (!finePointer || reduceMotion) return;

    var glow = d.createElement('span');
    glow.className = 'fm-grid-glow';
    glow.setAttribute('aria-hidden', 'true');
    layer.appendChild(glow);
    nodes.gridGlow = glow;

    var pending = null;

    function apply() {
      rafId = 0;
      if (!pending || isPaused()) { pending = null; return; }
      var evt = pending;
      pending = null;

      var rect = header.getBoundingClientRect();
      var x = evt.clientX - rect.left;
      var y = evt.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        layer.classList.remove('fm-grid-live');
        return;
      }
      /* 只写 transform（合成层），不碰 left/top，避免逐帧布局 */
      glow.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)';
      layer.classList.add('fm-grid-live');
    }

    function onMove(evt) {
      if (evt.pointerType && evt.pointerType !== 'mouse') return;
      pending = { clientX: evt.clientX, clientY: evt.clientY };
      if (!rafId) rafId = w.requestAnimationFrame(apply);
    }

    function onLeave() {
      pending = null;
      layer.classList.remove('fm-grid-live');
    }

    listen(header, 'pointermove', onMove, { passive: true });
    listen(header, 'pointerleave', onLeave, { passive: true });
    listen(w, 'blur', onLeave);
  }

  /* ------------------------------ 生命周期 ------------------------------ */
  function teardown() {
    for (var i = 0; i < cleanups.length; i++) {
      try { cleanups[i](); } catch (e) { /* 节点已被 pjax 替换 */ }
    }
    cleanups = [];
    for (var j = 0; j < observers.length; j++) {
      try { observers[j].disconnect(); } catch (e) { /* ignore */ }
    }
    observers = [];
    cancelRaf();
    deactivateCard();

    cancelGradient();
    titleOffscreen = false;

    if (nodes.posts) nodes.posts.classList.remove('fm-spotlight-host');
    if (nodes.gridLayer && nodes.gridLayer.parentNode) {
      nodes.gridLayer.parentNode.removeChild(nodes.gridLayer);
    }
    if (nodes.title) {
      nodes.title.classList.remove('fm-gradient', 'fm-gradient-chars', 'fm-offscreen');
    }
    if (splitState) {
      var node = splitState.node;
      if (node && node.getAttribute('data-fm-split') === '1') {
        node.textContent = splitState.text;
        node.removeAttribute('data-fm-split');
        node.classList.remove('fm-split');
      }
      splitState = null;
    }
    nodes = { title: null, posts: null, header: null, gridLayer: null, gridGlow: null };
  }

  function init() {
    try {
      teardown();
      if (!d.body) return;
      setPausedClass();

      if (FLAGS.textReveal) initTextReveal();
      if (FLAGS.gradientText) initGradient();
      if (FLAGS.cardSpotlight && finePointer && !reduceMotion && !isPaused()) initSpotlight();
      if (FLAGS.gridBackground) initGrid();
    } catch (err) {
      /* 任何异常都回到「没有动效的原生页面」，绝不让首屏内容消失 */
      try { teardown(); } catch (e) { /* ignore */ }
      try { if (w.console && console.warn) console.warn('[fm-motion] 初始化失败，已回退到无动效：', err); } catch (e2) { /* ignore */ }
    }
  }

  function onVisibility() {
    pageAway = false;
    setPausedClass();
    if (isPaused()) {
      syncGradient();
      if (nodes.posts) deactivateCard();
      if (nodes.gridLayer) nodes.gridLayer.classList.remove('fm-grid-live');
    } else {
      /* 从后台回来时按需重建（触屏 / 减少动态等条件可能已变化） */
      init();
    }
  }

  function onPageHide() {
    pageAway = true;
    setPausedClass();
    syncGradient();
    if (nodes.posts) deactivateCard();
    if (nodes.gridLayer) nodes.gridLayer.classList.remove('fm-grid-live');
  }

  function onPageShow() {
    pageAway = false;
    setPausedClass();
    init();
  }

  function onMotionChange() {
    reduceMotion = !!(motionQuery && motionQuery.matches);
    init();
  }

  function onPointerChange() {
    finePointer = !!(fineQuery && fineQuery.matches);
    init();
  }

  /* 事件只注册一次；pjax 换页只重建页面内效果 */
  d.addEventListener('visibilitychange', onVisibility);
  w.addEventListener('pagehide', onPageHide);
  w.addEventListener('pageshow', onPageShow);
  d.addEventListener('pjax:complete', function () { setTimeout(init, 0); });
  if (motionQuery) {
    if (typeof motionQuery.addEventListener === 'function') motionQuery.addEventListener('change', onMotionChange);
    else if (typeof motionQuery.addListener === 'function') motionQuery.addListener(onMotionChange);
  }
  if (fineQuery) {
    if (typeof fineQuery.addEventListener === 'function') fineQuery.addEventListener('change', onPointerChange);
    else if (typeof fineQuery.addListener === 'function') fineQuery.addListener(onPointerChange);
  }

  w.__FMOTION_DEBUG = {
    state: function () {
      return {
        flags: FLAGS,
        reduceMotion: reduceMotion,
        finePointer: finePointer,
        hidden: isPaused(),
        title: nodes.title ? {
          split: nodes.title.classList.contains('fm-split'),
          gradient: nodes.title.classList.contains('fm-gradient'),
          gradientChars: nodes.title.classList.contains('fm-gradient-chars'),
          offscreen: nodes.title.classList.contains('fm-offscreen')
        } : null,
        gradientAnimations: gradientAnims.length,
        gradientPlayState: gradientAnims.length ? gradientAnims[0].playState : null,
        spotlight: !!(nodes.posts && nodes.posts.classList.contains('fm-spotlight-host')),
        grid: !!nodes.gridLayer,
        gridGlow: !!nodes.gridGlow
      };
    },
    refresh: init
  };

  if (!d.body) d.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window, document);
