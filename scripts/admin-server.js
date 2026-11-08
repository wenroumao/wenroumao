/* global hexo */
/**
 * scripts/admin-server.js —— 把本地后台挂到 hexo server 上
 * ---------------------------------------------------------------------------
 * 只在 `hexo server` 时执行 server_middleware 过滤器；hexo generate 不会触碰它。
 * 后台代码在 tools/admin/，不放进 source/，因此不会出现在 public/ 或线上站点。
 */
'use strict';

hexo.extend.filter.register('server_middleware', function (app) {
  const path = require('path');
  const createAdmin = require(path.join(hexo.base_dir, 'tools', 'admin', 'server.js'));
  // 与前台同源的代码高亮：复用 hexo 内置的 before_post_render 过滤器
  const backtickCodeBlock = require(path.join(
    hexo.base_dir, 'node_modules', 'hexo', 'lib', 'plugins', 'filter',
    'before_post_render', 'backtick_code_block'
  ));
  app.use(createAdmin({
    baseDir: hexo.base_dir,
    env: process.env,
    // Markdown 预览：先用 hexo 自己的代码高亮过滤器包好代码块，再走站点注册的 Markdown 渲染器，
    // 因此字体、配色、代码块表格结构与前台一致。外挂标签（{% note %} 等）不在这里求值。
    runMarkdown: function (text) {
      const data = { content: String(text == null ? '' : text), engine: 'md' };
      backtickCodeBlock.call(hexo, data);
      return hexo.render.render({ text: data.content, engine: 'md' }).then(function (html) {
        return String(html).replace(/<\/?hexoPostRenderCodeBlock>/g, '');
      });
    }
  }));
  hexo.log.info('本地后台已挂载：http://localhost:%s/admin/', hexo.config.server && hexo.config.server.port ? hexo.config.server.port : 4000);
});
