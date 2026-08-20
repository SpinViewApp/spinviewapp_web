@echo off
setlocal
title SpinView builder: compile
rem ###############################################################
rem  Compiles _data\tools\website_builder.c once into the .exe.
rem  Compiler preference: tcc, then gcc, then cc (then well-known
rem  MinGW install paths as a fallback). Only run this after
rem  website_builder.c changes; for day-to-day updates use update.bat.
rem ###############################################################

set "ROOT=%~dp0"
rem Strip the trailing backslash so the classic cmd "quote swallowing"
rem bug (an argument ending in \" ) can never corrupt the exe path.
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
rem This batch lives in _data\tools; the project root is two levels up.
for %%I in ("%ROOT%\..\..") do set "ROOT=%%~fI"
set "SRC=%ROOT%\_data\tools\website_builder.c"
set "EXE=%ROOT%\_data\tools\website_builder.exe"

set "COMPILER="
where tcc >nul 2>nul && set "COMPILER=tcc"
if not defined COMPILER (
  for %%C in (gcc cc) do (
    where %%C >nul 2>nul && set "COMPILER=%%C"
    if defined COMPILER goto compiler_found
  )
)
if not defined COMPILER (
  for %%C in (
    "C:\TDM-GCC-64\bin\gcc.exe"
    "C:\MinGW\bin\gcc.exe"
    "C:\mingw64\bin\gcc.exe"
    "C:\msys64\mingw64\bin\gcc.exe"
    "C:\Program Files\mingw-w64\x86_64-8.1.0-posix-seh-rt_v6-rev0\mingw64\bin\gcc.exe"
  ) do (
    if exist %%C set "COMPILER=%%~C"
    if defined COMPILER goto compiler_found
  )
)
:compiler_found

if not defined COMPILER (
  echo [SpinView] ERROR no C compiler found. Install tcc, gcc or cc.
  if not defined SV_NO_PAUSE pause
  exit /b 1
)
if not exist "%SRC%" (
  echo [SpinView] ERROR %SRC% not found.
  if not defined SV_NO_PAUSE pause
  exit /b 1
)

echo [SpinView] Compiling with %COMPILER%...
"%COMPILER%" -O2 -Wall "%SRC%" -o "%EXE%" 2>&1
if not %errorlevel%==0 (
  echo [SpinView] COMPILE FAILED. Review the messages above.
  if not defined SV_NO_PAUSE pause
  exit /b 1
)

echo [SpinView] Compiled %EXE%
echo [SpinView] Ready. Run update.bat to rebuild the website.
if not defined SV_NO_PAUSE pause
exit /b 0