@echo off
setlocal
title CADR CUT - Build Installer (CADR STUDIO)

set "ISCC_CMD="
where ISCC.exe >nul 2>nul
if not errorlevel 1 (
    set "ISCC_CMD=ISCC.exe"
) else if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" (
    set "ISCC_CMD=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
) else if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" (
    set "ISCC_CMD=%ProgramFiles%\Inno Setup 6\ISCC.exe"
) else if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" (
    set "ISCC_CMD=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
)

if "%ISCC_CMD%"=="" (
    echo ========================================================
    echo  Inno Setup 6 compiler ^(ISCC.exe^) was not found.
    echo  Download Inno Setup 6 from: https://jrsoftware.org/isdl.php
    echo  Or use INSTALL_WINDOWS.bat to install CADR CUT directly!
    echo ========================================================
    pause
    exit /b 1
)

echo Building CADR CUT Setup (.exe)...
"%ISCC_CMD%" "%~dp0CADR_CUT_Setup_LICENSED.iss"
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo  [SUCCESS] Build complete!
echo  Your installer is ready in: %~dp0Output\
echo ========================================================
pause
