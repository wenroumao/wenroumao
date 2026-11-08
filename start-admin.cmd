@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"

rem ��ȷ�� 4000 �˿��Ƿ��ѱ�ռ�ã������·�������ȴû����ʾ
netstat -ano | findstr ":4000" | findstr "LISTENING" >nul
if not errorlevel 1 goto port_busy

if exist ".admin-auth" goto run
if defined ADMIN_USER if defined ADMIN_PASSWORD goto run

echo.
echo [i] �״�������Ҫ���ù���Ա�˺ţ��˺�����ֻ���ڱ������еı��غ�̨
set "ADMIN_USER="
set /p "ADMIN_USER=����Ա�˺ţ�ֱ�ӻس��� admin: "
if not defined ADMIN_USER set "ADMIN_USER=admin"
set "ADMIN_PASSWORD="
set /p "ADMIN_PASSWORD=����Ա����: "
if not defined ADMIN_PASSWORD (
  echo [x] ���벻��Ϊ��
  goto end_fail
)

set "SAVE_AUTH="
set /p "SAVE_AUTH=�Ƿ񱣴浽 .admin-auth���´������룬���ļ��Ѽ��� gitignore? [y/N]: "
if /i "%SAVE_AUTH%"=="y" (
  > ".admin-auth" echo ADMIN_USER=%ADMIN_USER%
  >> ".admin-auth" echo ADMIN_PASSWORD=%ADMIN_PASSWORD%
  echo [i] ��д�� .admin-auth
)

:run
echo.
echo [i] ��̨��ַ: http://localhost:4000/admin/
echo [i] վ��Ԥ��: http://localhost:4000/
echo [i] ����Ŀ�����֧�ں�̨�ġ����������͡���鿴���Զ����ɡ��ֶ�����
echo.
call "%~dp0start-blog.cmd"
echo.
echo [i] ������ֹͣ
pause
exit /b 0

:port_busy
echo [x] 4000 �˿��ѱ�ռ�ã��µķ����޷���������ǰռ�����:
netstat -ano | findstr ":4000" | findstr "LISTENING"
echo.
echo �����취:
echo   1. �ص�֮ǰ�������վ��������д��ڣ������������������������Ӧ�� node ����
echo   2. ���������б��ű�
echo.
echo ������ʾ˵����ҳ���Ͽ����Ŀ����Ǿɷ�������ǰ����ͣ����
pause
exit /b 1

:end_fail
pause
exit /b 1