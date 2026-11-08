'use strict';
/**
 * tools/admin/standalone.js —— 不依赖 Hexo 的本地后台入口
 * ---------------------------------------------------------------------------
 * 用法：node tools/admin/standalone.js
 * 只挂载 /admin/ 与 /admin/api/*，不 import hexo 运行时；
 * 因此主题模板、source/js、source/css 改坏时，后台仍然能起来并执行恢复。
 *
 * 环境变量：
 *   ADMIN_PORT   监听端口，默认 4000（与 stop-admin.cmd 的识别端口一致）
 *   ADMIN_HOST   监听地址，默认 127.0.0.1
 */

const http = require('http');
const path = require('path');
const createAdmin = require('./server.js');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');

/** 只组装 HTTP server，不监听端口，方便测试与复用。 */
function createStandaloneServer(options) {
  options = options || {};
  const baseDir = options.baseDir || PROJECT_DIR;
  const middleware = createAdmin({
    baseDir: baseDir,
    env: options.env || process.env,
    // 生成器沿用 server.js 的实现：只跑 node_modules/hexo/bin/hexo generate，
    // 失败只会让“生成”这一步报错，不会带走后台进程。
    runGenerate: options.runGenerate || createAdmin.createHexoRunner(baseDir),
    sourceOptions: options.sourceOptions
  });

  return http.createServer(function (req, res) {
    // /admin/ 交给中间件直接出页面；这里只补跳转，避免把 /admin/ 又重定向回自己。
    if (req.url === '/' || req.url === '/admin') {
      res.statusCode = 302;
      res.setHeader('Location', '/admin/');
      res.end();
      return;
    }
    middleware(req, res, function () {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end('404 Not Found\n后台只提供 /admin/ 与 /admin/api/*。');
    });
  });
}

function main() {
  const port = Number(process.env.ADMIN_PORT) || 4000;
  const host = String(process.env.ADMIN_HOST || '127.0.0.1');
  const server = createStandaloneServer();

  server.on('error', function (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error('[x] ' + port + ' 端口已被占用。先运行 stop-admin.cmd，或设置 ADMIN_PORT 换一个端口。');
    } else {
      console.error('[x] 后台启动失败：' + err.message);
    }
    process.exit(1);
  });

  server.listen(port, host, function () {
    console.log('[i] 独立后台已启动：http://' + host + ':' + server.address().port + '/admin/');
    console.log('[i] 不依赖 hexo server；站点预览请另开 start-blog.cmd。');
    console.log('[i] 停止服务请运行 stop-admin.cmd，或在本窗口按 Ctrl+C。');
  });

  process.on('SIGINT', function () {
    server.close(function () { process.exit(0); });
  });
}

if (require.main === module) main();

module.exports = createStandaloneServer;
module.exports.createStandaloneServer = createStandaloneServer;
