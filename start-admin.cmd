@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"

rem 独立后台：不依赖 hexo server，前端改坏时仍能启动并做源码恢复。
rem 4000 端口固定给后台，站点预览改到 4001（见 start-blog.cmd）。

netstat -ano | findstr ":4000" | findstr "LISTENING" >nul
if not errorlevel 1 goto port_busy

if exist ".admin-auth" goto run
if defined ADMIN_USER if defined ADMIN_PASSWORD goto run

echo.
echo [i] 首次启动需要设置管理员账号（账号密码只保存在本机的本地后台）
set "ADMIN_USER="
set /p "ADMIN_USER=管理员账号（直接回车用 admin）: "
if not defined ADMIN_USER set "ADMIN_USER=admin"
set "ADMIN_PASSWORD="
set /p "ADMIN_PASSWORD=管理员密码: "
if not defined ADMIN_PASSWORD (
  echo [x] 密码不能为空
  goto end_fail
)

set "SAVE_AUTH="
set /p "SAVE_AUTH=是否保存到 .admin-auth（下次不用输入，该文件已加入 gitignore）? [y/N]: "
if /i "%SAVE_AUTH%"=="y" (
  > ".admin-auth" echo ADMIN_USER=%ADMIN_USER%
  >> ".admin-auth" echo ADMIN_PASSWORD=%ADMIN_PASSWORD%
  echo [i] 已写入 .admin-auth
)

:run
echo.
echo [i] 独立后台: http://localhost:4000/admin/
echo [i] 该入口不依赖 hexo server，前端或主题改坏也能打开后台
echo [i] 站点预览请另开窗口运行 start-blog.cmd（http://localhost:4001/）
echo [i] 停止服务请运行 stop-admin.cmd，或在本窗口按 Ctrl+C
echo.

set "BUNDLED_NODE=C:\Users\m1302\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
where node >nul 2>nul
if %errorlevel%==0 (
  node "tools\admin\standalone.js"
  goto after
)
if exist "%BUNDLED_NODE%" (
  "%BUNDLED_NODE%" "tools\admin\standalone.js"
  goto after
)
echo [x] 未找到 Node.js，请安装 Node 18/20/22 LTS 后重试。
goto end_fail

:after
echo.
echo [i] 后台进程已退出
pause
exit /b 0

:port_busy
echo [x] 4000 端口已被占用，无法启动后台。当前占用:
netstat -ano | findstr ":4000" | findstr "LISTENING"
echo.
echo 处理办法:
echo   1. 先运行 stop-admin.cmd 停止旧的后台进程
echo   2. 或在任务管理器里结束占用 4000 的 node 进程
echo.
echo 提示：界面上看到的旧数据可能来自旧进程，务必先停旧进程。
pause
exit /b 1

:end_fail
pause
exit /b 1