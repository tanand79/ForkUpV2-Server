@echo off
setlocal
cd /d "%~dp0"

echo Creating api.zip for Hostinger upload...
echo.

if exist api.zip del api.zip

powershell -NoProfile -Command ^
  "$root = Get-Location; " ^
  "$items = @('package.json','package-lock.json','nest-cli.json','tsconfig.json','tsconfig.build.json','src','.env.production.example','hostinger-import.sql','HOSTINGER-DB.md'); " ^
  "$missing = $items | Where-Object { -not (Test-Path (Join-Path $root $_)) }; " ^
  "if ($missing) { Write-Error ('Missing: ' + ($missing -join ', ')); exit 1 }; " ^
  "$staging = Join-Path $env:TEMP ('forkup-api-pack-' + [guid]::NewGuid().ToString()); " ^
  "$apiDir = Join-Path $staging 'api'; " ^
  "New-Item -ItemType Directory -Path $apiDir -Force | Out-Null; " ^
  "foreach ($item in $items) { Copy-Item -Path (Join-Path $root $item) -Destination $apiDir -Recurse -Force }; " ^
  "Compress-Archive -Path $apiDir -DestinationPath (Join-Path $root 'api.zip') -Force; " ^
  "Remove-Item $staging -Recurse -Force"

if errorlevel 1 (
  echo.
  echo Failed to create api.zip
  exit /b 1
)

echo.
echo Created api.zip with api/ folder inside.
echo Hostinger settings:
echo   Root directory = api
echo   Build command = npm run build
echo   Start command = npm run start:prod
echo   Entry file = dist/main.js
echo.
echo Import .env.production.example in your host env panel (see variable names inside).
echo.
pause
