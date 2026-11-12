@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js belum terpasang. Unduh di https://nodejs.org & pause & exit /b 1)
start "" http://localhost:8080/backup.html
node server.js
pause
