@echo off
REM One-click start for Windows: sets up everything the first time, then launches Session Scribe.
cd /d "%~dp0"

if not exist .venv (
  echo First run: setting things up ^(this takes a minute^)...
  python -m venv .venv
)
.venv\Scripts\python -m pip install -q -r requirements.txt

if exist .env (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do set "%%a=%%b"
)

.venv\Scripts\python app.py
pause
