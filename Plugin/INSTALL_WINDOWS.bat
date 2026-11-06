@echo off
setlocal EnableDelayedExpansion
title CADR CUT v1.3.7 — One-Click Installer (Premiere Pro 2020 - 2027+)
color 0F

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting Administrator privileges to install CADR CUT...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs"
    exit /b
)

cls
echo ====================================================================
echo                 CADR STUDIO  ^|  CADR CUT v1.3.7
echo          Compatible with Premiere Pro 2020 - 2026 / 2027+
echo                    YOUR VISION. OUR FRAME.
echo ====================================================================
echo.

set "SRC_DIR=%~dp0"
if exist "%~dp0Plugin\CSXS\manifest.xml" (
    set "SRC_DIR=%~dp0Plugin"
) else if exist "%~dp0CSXS\manifest.xml" (
    set "SRC_DIR=%~dp0"
) else (
    echo [ERROR] Could not find Plugin\CSXS\manifest.xml next to this installer.
    pause
    exit /b 1
)

echo [1/4] Enabling Adobe Premiere Pro CEP Debug Mode ^(2020 - 2027+ / CSXS 9 - 18^)...
for %%V in (9 10 11 12 13 14 15 16 17 18) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
)
echo       Done.
echo.

echo [2/4] Stopping background CEPHtmlEngine ^& clearing old CEP cache...
taskkill /F /IM CEPHtmlEngine.exe >nul 2>&1
if exist "%LocalAppData%\Temp\cep_cache" rmdir /s /q "%LocalAppData%\Temp\cep_cache" >nul 2>&1
echo       Done.
echo.

set "CEP_X86=%CommonProgramFiles(x86)%\Adobe\CEP\extensions"
set "CEP_X64=%CommonProgramFiles%\Adobe\CEP\extensions"
set "CEP_USR=%APPDATA%\Adobe\CEP\extensions"

set "BASE_CEP=%CEP_X86%"
if "%CommonProgramFiles(x86)%"=="" set "BASE_CEP=%CEP_X64%"
set "SYS_CEP=%BASE_CEP%\CADR_CUT"

echo [3/4] Cleaning all old/duplicate CADR extension folders...
for %%D in ("%CEP_X86%" "%CEP_X64%" "%CEP_USR%") do (
    if exist "%%~D\CADR_CUT" rmdir /s /q "%%~D\CADR_CUT" >nul 2>&1
    if exist "%%~D\CADR" rmdir /s /q "%%~D\CADR" >nul 2>&1
    if exist "%%~D\CADR_CUT - Copy" rmdir /s /q "%%~D\CADR_CUT - Copy" >nul 2>&1
    if exist "%%~D\com.cadr.panel" rmdir /s /q "%%~D\com.cadr.panel" >nul 2>&1
)
echo       Done.
echo.

echo [4/4] Installing CADR CUT v1.3.7 to %SYS_CEP%...
mkdir "%SYS_CEP%" >nul 2>&1
xcopy "%SRC_DIR%\client" "%SYS_CEP%\client\" /E /I /Y /Q >nul
xcopy "%SRC_DIR%\CSXS" "%SYS_CEP%\CSXS\" /E /I /Y /Q >nul
xcopy "%SRC_DIR%\jsx" "%SYS_CEP%\jsx\" /E /I /Y /Q >nul
if exist "%SRC_DIR%\tools" xcopy "%SRC_DIR%\tools" "%SYS_CEP%\tools\" /E /I /Y /Q >nul
if exist "%SRC_DIR%\version.json" copy /Y "%SRC_DIR%\version.json" "%SYS_CEP%\" >nul
if exist "%SRC_DIR%\.debug" copy /Y "%SRC_DIR%\.debug" "%SYS_CEP%\" >nul
if exist "%SRC_DIR%\README.md" copy /Y "%SRC_DIR%\README.md" "%SYS_CEP%\" >nul
if exist "%SRC_DIR%\LICENSE_SYSTEM_AR.txt" copy /Y "%SRC_DIR%\LICENSE_SYSTEM_AR.txt" "%SYS_CEP%\" >nul
if exist "%SRC_DIR%\CADR_CUT_icon_FINAL.ico" copy /Y "%SRC_DIR%\CADR_CUT_icon_FINAL.ico" "%SYS_CEP%\" >nul

:: Grant standard Windows Users modify permissions on CADR_CUT folder so One-Click GitHub OTA Updates work without Admin prompt
icacls "%SYS_CEP%" /grant *S-1-5-32-545:(OI)(CI)M /T /C /Q >nul 2>&1

echo       Installed cleanly to: %SYS_CEP%
echo.

echo ====================================================================
echo  [SUCCESS] CADR CUT v1.3.7 has been installed! (2020 - 2027+)
echo  Restart Adobe Premiere Pro -^> Window -^> Extensions -^> CADR CUT
echo ====================================================================
echo.
pause
