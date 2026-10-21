@echo off
REM One-click start for Windows: creates a virtual env, installs/updates packages, starts the server.
cd /d "%~dp0"
if not exist .venv (
  echo Creating virtual environment...
  python -m venv .venv || goto :error
  .venv\Scripts\python -m pip install --upgrade pip
)
echo Checking packages...
.venv\Scripts\python -m pip install -q -r requirements.txt || goto :error
if not exist .env (
  copy .env.example .env >nul
  echo.
  echo  Created .env - paste your free Groq key into it, save, then run this again.
  notepad .env
  goto :eof
)
start "" http://localhost:8000
.venv\Scripts\python app.py
pause
goto :eof
:error
echo Setup failed. Make sure Python 3.10+ is installed and on your PATH.
pause
