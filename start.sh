#!/usr/bin/env bash
# One-command start: sets up everything the first time, then launches Session Scribe.
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "First run: setting things up (this takes a minute)..."
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip -q
fi
.venv/bin/pip install -q -r requirements.txt

# Load the API key from .env if present
if [ -f .env ]; then set -a; . ./.env; set +a; fi

exec .venv/bin/python app.py
