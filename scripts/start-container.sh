#!/bin/sh
set -eu

# ponytail: Nutshell already is a mint; keep it private and run it beside the app.
mint --host 127.0.0.1 --port 3338 &
lp_mint_pid=$!
trap 'kill "$lp_mint_pid" 2>/dev/null || true' EXIT INT TERM

python -c '
import time
import urllib.request

for _ in range(100):
    try:
        urllib.request.urlopen("http://127.0.0.1:3338/v1/info", timeout=1)
        break
    except Exception:
        time.sleep(0.1)
else:
    raise SystemExit("LP mint did not start")
'

exec uvicorn backend.main:app --host 0.0.0.0 --port 8090
