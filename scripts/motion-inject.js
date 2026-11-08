/*!
 * scripts/motion-inject.js —— 首页动效的构建期注入器（不改 themes/ 与 node_modules/）
 * ---------------------------------------------------------------------------
 * 为什么不用 _config.fomalhaut.yml 的 inject 列表：
 *   那份列表是静态 YAML，无法按开关决定「要不要注入」，也没法把开关值写进页面。
 *   这里用 after_render:html 在首页渲染完成后做三件事：
 *     ① 输出 window.__FMOTION__（四个开关的布尔快照）；
 *     ② 异步加载样式（media=print + onload 换成 all，不阻塞首屏渲染）；
 *     ③ 在 </body> 前插入 defer 脚本（不阻塞解析，也不进入关键渲染路径）。
 *   四项全部关闭 → 什么都不注入，首页零额外请求。
 *
 * 只作用于首页：页面里同时有 #site-info / #recent-posts 才处理，其余页面原样返回。
 * 回滚：删除本文件即可（前端脚本与样式不再被引用，页面回到主题原样）。
 */
'use strict';

const MARK = 'fm-motion';
const CSS_SRC = '/css/motion-effects.css?v=20261108a';
const JS_SRC = '/js/inject/motion-effects.js?v=20261108a';

const DEFAULTS = {
  textReveal: true,
  gradientText: true,
  cardSpotlight: true,
  gridBackground: true
};

/* 某个开关块存在且显式写了 enable 就用它，否则跟随默认值（默认全开） */
function readSwitch(block, fallback) {
  if (!block || typeof block !== 'object') return fallback;
  return typeof block.enable === 'boolean' ? block.enable : fallback;
}

function readFlags() {
  const cfg = (hexo.theme && hexo.theme.config && hexo.theme.config.motion_effects) || {};
  return {
    textReveal: readSwitch(cfg.text_reveal, DEFAULTS.textReveal),
    gradientText: readSwitch(cfg.gradient_text, DEFAULTS.gradientText),
    cardSpotlight: readSwitch(cfg.card_spotlight, DEFAULTS.cardSpotlight),
    gridBackground: readSwitch(cfg.grid_background, DEFAULTS.gridBackground)
  };
}

hexo.extend.filter.register('after_render:html', function (html) {
  try {
    if (typeof html !== 'string' || html.indexOf('</head>') === -1 || html.indexOf('</body>') === -1) {
      return html;
    }
    // 已经注入过（多过滤器重复执行时）直接跳过
    if (html.indexOf('<!-- ' + MARK + ' start -->') !== -1) return html;
    // 首页守卫：主题的 #body-wrap 只有首页会带 home 类（分类 / 标签 / 归档页都没有）
    if (!/<div[^>]*(?:class\s*=\s*["'][^"']*\bhome\b[^"']*["'][^>]*id\s*=\s*["']body-wrap["']|id\s*=\s*["']body-wrap["'][^>]*class\s*=\s*["'][^"']*\bhome\b[^"']*["'])/i.test(html)) {
      return html;
    }

    // 还需要拿到主题配置快照，这样开关变更后重新 generate 即可生效
    const flags = readFlags();
    if (!flags.textReveal && !flags.gradientText && !flags.cardSpotlight && !flags.gridBackground) {
      return html;
    }

    const json = JSON.stringify(flags)
      .replace(/</g, '\\u003c')       // 防止 </script> 提前闭合
      .replace(/\u2028|\u2029/g, '');

    const head = '<!-- ' + MARK + ' start -->\n'
      + '<script>window.__FMOTION__=' + json + ';</script>\n'
      + '<link rel="stylesheet" href="' + CSS_SRC + '" media="print" onload="this.media=\'all\'">\n'
      + '<!-- ' + MARK + ' head end -->\n';

    const bottom = '<script defer src="' + JS_SRC + '"></script>\n'
      + '<!-- ' + MARK + ' end -->';

    return html
      .replace(/<\/head>/i, head + '</head>')
      .replace(/<\/body>/i, bottom + '</body>');
  } catch (err) {
    try { hexo.log.warn('[fm-motion] 动效注入失败：' + (err && err.message)); } catch (e) { /* ignore */ }
    return html;
  }
}, 98);
