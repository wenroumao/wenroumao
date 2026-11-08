@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "BUNDLED_NODE=C:\Users\m1302\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
where node >nul 2>nul
if %errorlevel%==0 (
  echo [i] using node from PATH
  node "node_modules\hexo\bin\hexo" server -p 4001
  goto :eof
)
if exist "%BUNDLED_NODE%" (
  echo [i] using bundled DSH node
  "%BUNDLED_NODE%" "node_modules\hexo\bin\hexo" server -p 4001
  goto :eof
)
echo [x] Node.js not found. Install Node 18/20/22 LTS from https://nodejs.org then rerun.
pause