#!/bin/sh
# Entrypoint of the browser service image: run the chromium that ships WITH the
# image (the playwright browser cache) with a CDP endpoint other containers can
# attach to. Nothing here knows about workbench.
#
#   start-browser                 foreground (the container entrypoint)
#   start-browser --background    start it DETACHED, wait until the CDP endpoint
#                                 answers, then exit 0 (bounded, for a launcher
#                                 run through `docker exec` / ssh, which would
#                                 otherwise block forever on a foreground child)
set -eu

MODE="foreground"
case "${1:-}" in
  ""|-f|--foreground) MODE="foreground" ;;
  -d|--background|--detach) MODE="background" ;;
  *)
    echo "start-browser: unknown option '$1' (usage: start-browser [--background])" >&2
    exit 2
    ;;
esac

PORT="${BROWSER_CDP_PORT:-9222}"
WAIT_SECONDS="${BROWSER_START_WAIT_SECONDS:-60}"
LOG="${BROWSER_LOG:-/tmp/start-browser.log}"

# The playwright image keeps its builds under /ms-playwright/<name>-<rev>/.
# Prefer the full chromium (CDP + real rendering), fall back to the headless
# shell, and fail LOUDLY when the image really carries no browser.
BIN=""
for candidate in \
  /ms-playwright/chromium-*/chrome-linux/chrome \
  /ms-playwright/chromium-*/chrome-linux64/chrome \
  /ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell \
  /ms-playwright/chromium_headless_shell-*/chrome-linux64/headless_shell \
  /usr/bin/chromium /usr/bin/google-chrome
do
  for path in $candidate; do
    if [ -x "$path" ]; then BIN="$path"; break 2; fi
  done
done
if [ -z "$BIN" ]; then
  echo "start-browser: no chromium binary found under /ms-playwright - this is not a browser image" >&2
  exit 1
fi

echo "start-browser: $BIN --remote-debugging-port=$PORT ($($BIN --version 2>/dev/null || echo version-unknown))"

if [ "$MODE" = "foreground" ]; then
  exec "$BIN" \
    --headless=new \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --remote-debugging-address=0.0.0.0 \
    --remote-debugging-port="$PORT" \
    ${BROWSER_EXTRA_ARGS:-} \
    about:blank
fi

# Background mode: detach chromium, then wait for /json/version to answer so the
# caller can attach IMMEDIATELY when this command exits 0. A CI-safe bounded
# wait: the exit code is the proof, no sleep-and-hope.
nohup "$BIN" \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port="$PORT" \
  ${BROWSER_EXTRA_ARGS:-} \
  about:blank >>"$LOG" 2>&1 &

waited=0
while [ "$waited" -lt "$WAIT_SECONDS" ]; do
  if node -e "require('http').get('http://127.0.0.1:' + process.argv[1] + '/json/version', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))" "$PORT" 2>/dev/null; then
    echo "start-browser: CDP endpoint answering on 127.0.0.1:$PORT (after ${waited}s)"
    exit 0
  fi
  sleep 1
  waited=$((waited + 1))
done

echo "start-browser: chromium did not answer on 127.0.0.1:$PORT within ${WAIT_SECONDS}s - log tail:" >&2
tail -n 20 "$LOG" >&2 2>/dev/null || true
exit 1
