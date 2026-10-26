@echo off
chcp 65001 >nul
rem Builds the TV client installer and the Android APK, then publishes both to the server:
rem the web remote shows download buttons, TVs and phones are offered the update.
rem   build-windows.cmd            - new version (x.y.z -> x.y.z+1), build, publish
rem   build-windows.cmd nobump     - rebuild the current version
rem   build-windows.cmd nopublish  - build only
cd /d "%~dp0"

if /i not "%1"=="nobump" (
  echo ==^> version
  call node scripts\version.mjs bump || goto :err
)
echo ==^> npm install
call npm install --no-audit --no-fund || goto :err
echo ==^> tests
call npm test || goto :err
echo ==^> TVBox installer for Windows
call npm run dist:tv || goto :err
echo.
echo Installer: apps\tv-client\release
echo ==^> Android APK (needs Android Studio)
call npm run apk || echo APK was not built: check Android SDK / JDK

if /i "%1"=="nopublish" goto :done
if /i "%2"=="nopublish" goto :done
echo ==^> publishing to the server
call node scripts\publish-release.mjs || echo Publishing failed: run deploy.ps1 once so that .release-token is saved, then: npm run publish:apps

:done
echo.
echo DONE
pause
exit /b 0
:err
echo BUILD FAILED
pause
exit /b 1
