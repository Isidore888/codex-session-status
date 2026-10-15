@echo off
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "%~dp0scripts\bootstrap.ps1" -Setup
