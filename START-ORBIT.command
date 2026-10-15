#!/bin/zsh
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required. Install Node.js 22 or newer, then reopen this file."
  echo "Press Return to close."
  read -r REPLY
  exit 1
fi

PORT=4175
while [[ "$PORT" -lt 4190 ]] && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Ports 4175–4189 are busy. Stop an old Orbit server and try again."
  echo "Press Return to close."
  read -r REPLY
  exit 1
fi

export PORT
echo "Starting Orbit from: $PWD"
echo "Open http://127.0.0.1:$PORT"
npm start &
SERVER_PID=$!
READY=0
for _ in {1..30}; do
  if curl --silent --fail "http://127.0.0.1:$PORT/api/health" >/dev/null; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "$READY" -eq 1 ]]; then
  open "http://127.0.0.1:$PORT"
else
  echo "Orbit did not start. Read the error above, then check Node.js and the project files."
fi
wait "$SERVER_PID"
