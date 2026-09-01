@echo off
rem Windows から二度打ちで起きる形。中身は WSL の configure-agents.sh へ渡す。
rem
rem distro は既定の物を使う（-d で決め打ちせぬ。Ubuntu と限らぬゆえ）。
rem 変えたければ  set HONDEN_WSL_DISTRO=<名>  を先に。
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title honden - Configure Agents
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "D="
if defined HONDEN_WSL_DISTRO set "D=-d %HONDEN_WSL_DISTRO%"

if not exist "%SCRIPT_DIR%\configure-agents.sh" (
    echo   configure-agents.sh がこの bat の隣に無い。honden の根に置かれよ。
    pause
    exit /b 1
)
wsl.exe %D% -- true >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   WSL が起きぬ。distro の初期設定を済ませ、WSL 側で bash scripts/first_setup.sh を。
    pause
    exit /b 1
)
for /f "usebackq delims=" %%I in (`wsl.exe %D% -- wslpath -a "%SCRIPT_DIR%"`) do set "REPO_WSL=%%I"
if not defined REPO_WSL (
    echo   WSL の道に直せなんだ: %SCRIPT_DIR%
    pause
    exit /b 1
)
wsl.exe %D% -- bash -lc "cd \"%REPO_WSL%\" && bash configure-agents.sh %*"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo   終了 %RC%
pause
exit /b %RC%
