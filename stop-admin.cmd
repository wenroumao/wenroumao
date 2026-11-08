@echo off
chcp 936 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem 一键停止本地后台服务：只处理监听 4000 且能确认是本项目后台的进程。
rem 校验顺序：端口监听 -> PID -> 进程名 node -> 命令行含本项目路径（hexo 或 standalone），
rem 命令行里看不出项目时再用 /admin/api/session 接口确认身份，绝不按进程名批量结束 node。

set "PORT=4000"
set "PROJ=%~dp0"
set "PIDS="
set "STOPPED="
set "OTHERS="

rem 1) 端口 -> PID：只取 LISTENING，避免把普通客户端连接当成服务进程
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% " ^| findstr /c:"LISTENING"') do (
  echo !PIDS! | findstr /c:" %%P " >nul || set "PIDS=!PIDS! %%P "
)

if not defined PIDS goto not_running
echo [i] 监听 4000 端口的进程 PID:!PIDS!
for %%P in (!PIDS!) do call :stop_one %%P

if defined STOPPED goto wait_port
if defined OTHERS goto other_program
goto not_running

:stop_one
set "ONE=%~1"
rem 校验整体放在 PowerShell 里做，避免把带 | 的命令行交给 cmd 解析：
rem 0=确认是本项目后台；1=其它进程；2=进程已退出
powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=%ONE%'; if(-not $p){exit 2}; $c=[string]$p.CommandLine; if(-not ($p.Name -match '^node(\.exe)?$')){exit 1}; if(($c -match 'hexo') -and ($c.IndexOf($env:PROJ.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase) -ge 0)){exit 0}; try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:%PORT%/admin/api/session'; if($r.Content -match 'configured'){exit 0}}catch{}; exit 1"
set "CODE=!errorlevel!"
if "!CODE!"=="0" goto kill_one
if "!CODE!"=="1" goto other_one
rem 进程已经自己退出，什么都不做
goto :eof

:kill_one
taskkill /PID %ONE% /F >nul 2>&1
if errorlevel 1 goto other_one
set "STOPPED=!STOPPED! %ONE%"
goto :eof

:other_one
set "OTHERS=!OTHERS! %ONE%"
goto :eof

:wait_port
echo.
echo [i] 已停止本地后台服务：PID!STOPPED!
rem 等端口真正释放，最多 10 秒
set /a WAIT=0
:wait_loop
netstat -ano | findstr /r /c:":%PORT% " | findstr /c:"LISTENING" >nul
if errorlevel 1 goto stopped_ok
set /a WAIT+=1
if !WAIT! GEQ 10 goto stopped_slow
timeout /t 1 /nobreak >nul
goto wait_loop

:stopped_ok
echo [i] 4000 端口已释放，独立后台已停止；站点预览（4001）如仍在运行，请另行停止。
echo [i] 需要重新启动请双击 start-admin.cmd
echo.
pause
exit /b 0

:stopped_slow
echo [x] 已发送停止命令，但 4000 端口仍在监听，可能还有其它进程占用。
echo     请稍等几秒后再运行一次本脚本，或用任务管理器检查占用 4000 的进程。
echo.
pause
exit /b 1

:other_program
echo.
echo [x] 4000 端口被其它程序占用，本脚本没有结束任何进程。
echo     占用 PID:!OTHERS!
rem 进程信息由 PowerShell 直接输出，避免命令行中的 | 被 cmd 当成管道
for %%P in (!OTHERS!) do (
  powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=%%P'; if($p){Write-Host ('    '+$p.Name+' | '+$p.CommandLine)}"
)
echo.
echo     确认不是本项目后台后，可在任务管理器里手动结束，或先关闭占用端口的程序。
echo.
pause
exit /b 1

:not_running
echo.
echo [i] 当前没有在运行的本地后台服务（4000 端口未监听）。
echo [i] 需要启动请双击 start-admin.cmd
echo.
pause
exit /b 0
