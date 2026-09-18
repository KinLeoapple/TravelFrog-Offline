@echo off
rem 旅行青蛙·中国之旅 离线版 — Electron 桌面壳启动器
rem 双击即玩: 自动拉起内嵌游戏服务器的桌面窗口; 关闭窗口 = 优雅存档退出
cd /d %~dp0
npm start --silent
