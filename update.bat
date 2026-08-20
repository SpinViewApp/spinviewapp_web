@echo off
setlocal
title SpinView website: update
rem ###############################################################
rem  Runs _data\tools\website_builder.exe to rebuild the site from
rem  index_source.html + _data. No compilation happens here.
rem  Run compile.bat first if the .exe is missing.
rem ###############################################################

set "ROOT=%~dp0"
rem Strip the trailing backslash so the classic cmd "quote swallowing"
rem bug (an argument ending in \" ) can never corrupt the root path.
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "EXE=%ROOT%\_data\tools\website_builder.exe"

if not exist "%EXE%" (
  echo [SpinView] ERROR %EXE% not found.
  echo [SpinView] Run compile.bat once to build it.
  if not defined SV_NO_PAUSE pause
  exit /b 1
)

echo [SpinView] Building website...
"%EXE%" "%ROOT%"
set RC=%errorlevel%
if not %RC%==0 (
  echo [SpinView] BUILD FAILED. index.html was left untouched.
  if not defined SV_NO_PAUSE pause
  exit /b %RC%
)

echo [SpinView] Update complete.
if not defined SV_NO_PAUSE pause
exit /b 0