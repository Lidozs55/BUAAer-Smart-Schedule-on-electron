@echo off
chcp 65001 >nul
REM 启动 cpolar 隧道服务
REM 隧道名称：buaa-calendar，本地端口：5000
cpolar http 5000 --name buaa-calendar
pause