@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -Command "$t=(Get-Date).Ticks; Invoke-WebRequest -UseBasicParsing -Uri (\"https://cdn.jsdelivr.net/gh/danya0828/fishbot@main/bot.js?t=$t\") -OutFile \"bot.js\"; Invoke-WebRequest -UseBasicParsing -Uri (\"https://cdn.jsdelivr.net/gh/danya0828/fishbot@main/persona.md?t=$t\") -OutFile \"persona.md\"; Write-Host 更新完成"
echo.
pause
