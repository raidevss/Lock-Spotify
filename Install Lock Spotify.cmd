@echo off
title Lock Spotify installer
echo Installing / updating Lock Spotify...
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://raw.githubusercontent.com/raidevss/Lock-Spotify/main/install.ps1' | iex"
echo.
pause
