@echo off
chcp 65001 > nul
cd /d "%~dp0"
title 발주 납기 현황판
node server.js
set rc=%errorlevel%
if "%rc%"=="2" (
  timeout /t 4 > nul
  exit /b 0
)
echo.
if "%rc%"=="0" echo 현황판이 꺼졌어요.
echo 아무 키나 누르면 이 창이 닫혀요.
pause > nul
