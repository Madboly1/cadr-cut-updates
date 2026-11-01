@echo off
setlocal EnableDelayedExpansion
title CADR CUT — One-Click GitHub OTA Update Publisher (Madboly1/cadr-cut-updates)
color 0B

cls
echo ====================================================================
echo        CADR STUDIO  ^|  One-Click GitHub OTA Update Publisher
echo              Linked Repo: Madboly1/cadr-cut-updates
echo ====================================================================
echo.

set /p NEW_VER="1. Enter New Version Number (e.g. 1.3.3 or 1.4.0): "
if "%NEW_VER%"=="" (
    echo [ERROR] Version number cannot be empty.
    pause
    exit /b 1
)

set /p NOTES="2. Enter Short Update Notes (what changed?): "
if "%NOTES%"=="" set "NOTES=General improvements and bug fixes"

echo.
echo Updating version.json, Plugin\version.json, main.js, and index.html to v%NEW_VER%...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ver = '%NEW_VER%'.Trim(); " ^
  "$notes = '%NOTES%'; " ^
  "$obj = [ordered]@{ version = $ver; repo = 'Madboly1/cadr-cut-updates'; releaseDate = (Get-Date -Format 'yyyy-MM-dd'); notesAr = $notes; notesEn = $notes; files = @('Plugin/client/index.html','Plugin/client/main.js','Plugin/client/license.js','Plugin/jsx/host.jsx','Plugin/CSXS/manifest.xml','Plugin/version.json') }; " ^
  "$json = $obj | ConvertTo-Json -Depth 4; " ^
  "[System.IO.File]::WriteAllText('%~dp0version.json', $json, [System.Text.Encoding]::UTF8); " ^
  "[System.IO.File]::WriteAllText('%~dp0Plugin\version.json', $json, [System.Text.Encoding]::UTF8); " ^
  "$mjsPath = '%~dp0Plugin\client\main.js'; " ^
  "if (Test-Path $mjsPath) { $mjs = [System.IO.File]::ReadAllText($mjsPath, [System.Text.Encoding]::UTF8); $mjs = [regex]::Replace($mjs, 'var CADR_CURRENT_VERSION = "[^"]+";', ('var CADR_CURRENT_VERSION = "' + $ver + '";')); [System.IO.File]::WriteAllText($mjsPath, $mjs, [System.Text.Encoding]::UTF8); } " ^
  "$htmlPath = '%~dp0Plugin\client\index.html'; " ^
  "if (Test-Path $htmlPath) { $html = [System.IO.File]::ReadAllText($htmlPath, [System.Text.Encoding]::UTF8); $html = [regex]::Replace($html, '(<span id="cadrCurrentVerBadge"[^>]*>)v[0-9.]+(</span>)', ('${1}v' + $ver + '${2}')); [System.IO.File]::WriteAllText($htmlPath, $html, [System.Text.Encoding]::UTF8); }"

echo [OK] All files updated to v%NEW_VER%!
echo.
pause
