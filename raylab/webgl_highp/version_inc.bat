@echo off
setlocal

set "VERSION_FILE=%~dp0version.txt"

rem version.txt is the counter itself: it stays in the deploy folder and is
rem NOT copied by the build. Seed it on a fresh folder instead of failing.
if not exist "%VERSION_FILE%" (
    > "%VERSION_FILE%" echo v0000
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$path=$env:VERSION_FILE; $version=(Get-Content -Raw -LiteralPath $path).Trim();" ^
  "if ($version -notmatch '^(.*?)(\d+)$') { throw 'Format de version invalide: ' + $version };" ^
  "$prefix=$Matches[1]; $digits=$Matches[2]; $next=[System.Numerics.BigInteger]::Parse($digits)+1;" ^
  "$width=$digits.Length; $number=$next.ToString(); if ($number.Length -lt $width) { $number=$number.PadLeft($width,'0') };" ^
  "$result=$prefix+$number; [IO.File]::WriteAllText($path,$result+[Environment]::NewLine,(New-Object Text.UTF8Encoding($false)));" ^
  "Write-Host ($version + ' devient ' + $result)"

if errorlevel 1 exit /b 1
endlocal
