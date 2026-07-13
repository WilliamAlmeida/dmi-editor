@echo off
rem Abre o DMI Editor no navegador e sobe o servidor local.
rem A pasta raiz padrao e a pasta acima desta (ex: Downloads\Byond).
rem Para usar outra: start.cmd "C:\caminho\do\projeto"
cd /d "%~dp0"
start "" http://localhost:5175
node server.js %*
