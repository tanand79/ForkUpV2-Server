@echo off
cd /d "%~dp0"
echo.
echo ForkUp - deploy production database
echo Running from: %CD%
echo.
npm run db:deploy:production
echo.
if errorlevel 1 (
  echo FAILED. See messages above.
  echo Easiest fix: phpMyAdmin - see HOSTINGER-DB.md
) else (
  echo SUCCESS.
)
echo.
pause
