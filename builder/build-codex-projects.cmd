@echo off
setlocal
chcp 65001 >nul

where py >nul 2>nul
if %errorlevel% equ 0 (
  set "PYTHON=py -3"
) else (
  set "PYTHON=python"
)

if not "%~1"=="" goto run_args

set /p "INPUT_PATH=请输入小红书 JSON 文件或目录路径，然后按回车: "
if not defined INPUT_PATH exit /b 1
rem Windows 文件名不能包含双引号；去掉“复制为路径”带来的一层引号。
set "INPUT_PATH=%INPUT_PATH:"=%"
rem 同时兼容从类 Unix 终端复制来的反斜杠空格。
set "INPUT_PATH=%INPUT_PATH:\ = %"
%PYTHON% "%~dp0build_codex_projects.py" "%INPUT_PATH%"
set "RESULT=%errorlevel%"
echo.
pause
exit /b %RESULT%

:run_args
%PYTHON% "%~dp0build_codex_projects.py" %*
exit /b %errorlevel%
