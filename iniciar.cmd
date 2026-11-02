@echo off
rem Relevo: arranque local en Windows. Solo escucha en 127.0.0.1.
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Necesitas Node.js 22.18 o superior: https://nodejs.org & exit /b 1)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)" || (echo Necesitas Node.js 22.18 o superior. & exit /b 1)
if not exist node_modules (
  echo Instalando dependencias fijadas, sin scripts de instalacion...
  call npm ci --ignore-scripts || exit /b 1
)
start "" http://localhost:4317
call npm start
