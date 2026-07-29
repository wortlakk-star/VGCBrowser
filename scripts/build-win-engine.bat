@echo off
setlocal enabledelayedexpansion
title VGC Core - Build Windows engine (native antidetect)
REM ============================================================================
REM  VGC Core - build lai engine Windows voi patch chong-van-tay NATIVE moi nhat
REM  (screen 06 + client-rects 07 + fonts 08 + fingerprint/os_crypt cu).
REM
REM  Cach chay:  double-click file nay, HOAC trong cmd:
REM      scripts\build-win-engine.bat
REM
REM  Yeu cau: da build engine Windows it nhat 1 lan (co out\vgc + gn args),
REM  Visual Studio 2022 + depot_tools + node_modules cua repo (da co san tren
REM  may build app). Xem engine-src\BUILD-WINDOWS-ENGINE.md neu la lan dau.
REM ============================================================================

REM ---- CHINH 3 BIEN NAY NEU MAY ANH KHAC ----
if "%CHROMIUM_SRC%"=="" set "CHROMIUM_SRC=C:\src\vgc-chromium\src"
if "%DEPOT_TOOLS%"=="" set "DEPOT_TOOLS=C:\src\depot_tools"
if "%ENGINE_VER%"==""  set "ENGINE_VER=0.1.106"
REM -------------------------------------------

REM repo root = thu muc cha cua scripts\
set "REPO=%~dp0.."
for %%i in ("%REPO%") do set "REPO=%%~fi"
set "PATCHES=%REPO%\engine-src\patches"

echo.
echo === [1/6] Cap nhat repo (git pull) ===
cd /d "%REPO%" || goto :err
git pull origin main || goto :err

echo.
echo === [2/6] Reset cay Chromium ve goc ===
if not exist "%CHROMIUM_SRC%" (
  echo   Khong thay "%CHROMIUM_SRC%" - sua bien CHROMIUM_SRC o dau file.
  goto :err
)
cd /d "%CHROMIUM_SRC%" || goto :err
git checkout . || goto :err

echo.
echo === [3/6] Ap patch native (fingerprint + UA-CH) ===
git apply --3way "%PATCHES%\vgc-native-all.patch" || goto :err
git apply --3way "%PATCHES%\vgc-uach-chrome-brand.patch" || goto :err
echo   OK - da ap 2 patch.

echo.
echo === [4/6] Build engine (autoninja, ~10-20 phut incremental) ===
set "PATH=%DEPOT_TOOLS%;%PATH%"
call autoninja -C out\vgc chrome || goto :err
if not exist "%CHROMIUM_SRC%\out\vgc\chrome.exe" ( echo   Build xong nhung khong thay chrome.exe & goto :err )

echo.
echo === [5/6] Dong goi + gan logo VGC ===
set "STAGE=%REPO%\engine\chromium"
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"
robocopy "%CHROMIUM_SRC%\out\vgc" "%STAGE%" /E /XF *.pdb *.ninja *.o *.lib /XD obj gen >nul
if %ERRORLEVEL% GEQ 8 ( echo   robocopy loi & goto :err )
REM gan icon VGC len chrome.exe + chrome.dll (best-effort, khong lam vo build)
cd /d "%REPO%"
call node scripts\brand-engine.mjs
set "ZIP=%REPO%\release\vgc-core-win-x64-%ENGINE_VER%.zip"
if not exist "%REPO%\release" mkdir "%REPO%\release"
if exist "%ZIP%" del /q "%ZIP%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath '%ZIP%' -Force" || goto :err

echo.
echo === [6/6] XONG ===
echo   Engine zip: %ZIP%
echo.
echo   Buoc cuoi (thu cong):
echo    1) Upload "%ZIP%" len  https://vgcbrowser.com/dl/vgc-core-win-x64-%ENGINE_VER%.zip
echo    2) Sua src\main\settings.ts:  engineUrl = 'https://vgcbrowser.com/dl/vgc-core-win-x64-%ENGINE_VER%.zip'
echo    3) npm run dist:win  de ra file .exe app moi.
echo.
echo   * Kiem tra zip: chrome.exe phai nam o GOC zip (khong bi boc them thu muc).
goto :done

:err
echo.
echo *** LOI - da dung lai. Xem thong bao ngay tren de biet buoc nao hong. ***
echo     (Chay lai file nay sau khi sua; cac buoc deu lam lai duoc.)
endlocal
exit /b 1

:done
endlocal
echo Nhan phim bat ky de dong...
pause >nul
