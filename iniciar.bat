@echo off
echo Iniciando servidor local...
start http://localhost:3000
call npm run build:css
node server.js
