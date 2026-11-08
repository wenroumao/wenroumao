/*!
 * live-photo-src.js  —— 站点级构建脚本（不改 themes/ 与 node_modules/）
 * ---------------------------------------------------------------------------
 * 这里只做三件构建期的事，运行时逻辑在 source/js/inject/live-photo.js。
 *
 * 一、让实况照片静图在「完全禁用 JS」时也能显示
 *   主题开了图片懒加载（lazyload.field: site），
 *   themes/fomalhaut/scripts/filters/post_lazyload.js:11-21 会在 after_render:html
 *   阶段把所有 `<img ... src=...>` 改写成 src=占位 GIF + data-lazy-src=真实地址；
 *   真实地址只有 vanilla-lazyload 运行时才填回，JS 全关时静图永远停在占位图。
 *   本脚本以 priority 11（晚于主题默认的 10）只对 `img.live-photo-still`
 *   把 data-lazy-src 写回 src，其它图片维持主题原有懒加载行为。
 *
 * 二、绕过阿里云 OSS 的防盗链（仅本地/预览环境需要）
 *   OSS 桶对 live photo 素材做了 Referer 白名单：只允许 https://wenroumao.cn/，
 *   空 Referer 也放行；从 http://localhost 打开时会返回 403，浏览器报
 *   net::ERR_BLOCKED_BY_ORB，静图和视频都加载不出来。
 *   处理：
 *     · 含 .live-photo-container 的页面，在 </head> 前插入
 *       <meta name="referrer" content="no-referrer">，让 img/video 都不带 Referer；
 *     · 所有指向 OSS 的 <img>（含画廊入口卡片的封面）补 referrerpolicy="no-referrer"，
 *       同样不带 Referer，线上/本地都能加载。
 *   该改动同时避免了向 OSS 泄露页面来源，不影响站内其它图片与统计。
 *
 * 三、把「实况照片播放方式」全局默认值写进页面
 *   后台「功能开关」页写入 _config.fomalhaut.yml 的 live_photo.play_mode
 *   （hover / press）。构建时读取该值，在含 .live-photo-container 的页面
 *   </head> 前插入 <meta name="live-photo-default-mode" content="...">。
 *   这只是纯静态站（没有后台接口）时的兜底；本地预览时运行时脚本会直接读
 *   /admin/api/live-photo-mode，以磁盘上的最新配置为准。页面不再写死单张图的播放方式。
 *
 * 卸载：删除本文件即可。
 */
'use strict';

const OSS_HOST_RE = /wenroumao\.oss-cn-beijing\.aliyuncs\.com/i;
const STILL_IMG_RE = /<img\b[^>]*class=("[^"]*live-photo-still[^"]*"|'[^']*live-photo-still[^']*')[^>]*>/gi;
const IMG_TAG_RE = /<img\b[^>]*>/gi;
const LAZY_SRC_RE = /\bdata-lazy-src=("([^"]*)"|'([^']*)')/i;
const SRC_RE = /\ssrc=\s*("[^"]*"|'[^']*')/i;
const LIVE_CONTAINER_RE = /class="[^"]*live-photo-container/;
const PLAY_MODE_META_RE = /name="live-photo-default-mode"/i;

/** 读取主题配置里的全局默认播放方式；非法或缺失一律回退 hover。 */
function defaultPlayMode() {
  let mode = '';
  try {
    const conf = (hexo.theme.config && hexo.theme.config.live_photo) || {};
    mode = String(conf.play_mode || '');
  } catch (e) {
    mode = '';
  }
  return mode === 'press' ? 'press' : 'hover';
}

/** 只有实况照片页需要这个默认值，普通页面不输出多余 meta。 */
function addPlayModeMeta(html, mode) {
  if (!LIVE_CONTAINER_RE.test(html)) return html;
  if (PLAY_MODE_META_RE.test(html)) return html;
  return html.replace(/<\/head>/i,
    '<meta name="live-photo-default-mode" content="' + mode + '"></head>');
}

function restoreStillSrc(html) {
  return html.replace(STILL_IMG_RE, function (tag) {
    const lazy = LAZY_SRC_RE.exec(tag);
    if (!lazy) return tag;

    const url = lazy[2] !== undefined ? lazy[2] : lazy[3];
    if (!url) return tag;

    if (SRC_RE.test(tag)) {
      return tag.replace(SRC_RE, ' src="' + url + '"');
    }

    return tag.replace(/<img\b/i, '<img src="' + url + '"');
  });
}

function addOssReferrerPolicy(html) {
  return html.replace(IMG_TAG_RE, function (tag) {
    if (/\breferrerpolicy=/i.test(tag)) return tag;
    if (!OSS_HOST_RE.test(tag)) return tag;
    return tag.replace(/<img\b/i, '<img referrerpolicy="no-referrer"');
  });
}

hexo.extend.filter.register('after_render:html', function (html) {
  let out = String(html);

  out = restoreStillSrc(out);
  out = addOssReferrerPolicy(out);
  out = addPlayModeMeta(out, defaultPlayMode());

  /* 实况照片页需要 video 也不带 Referer（video 没有 referrerpolicy 属性） */
  if (/class="[^"]*live-photo-container/.test(out) && !/name="referrer"/i.test(out)) {
    out = out.replace(/<\/head>/i, '<meta name="referrer" content="no-referrer"></head>');
  }

  return out;
}, 11);
