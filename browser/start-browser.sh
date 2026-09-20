#!/bin/sh
# Entrypoint of the browser service image: run the chromium that ships WITH the
# image (the playwright browser cache) behind a tiny TCP forwarder, so that the
# CDP endpoint is reachable from OUTSIDE this container.
#
# WHY A FORWARDER: chromium binds its DevTools server to LOOPBACK only -
# `--remote-debugging-address=0.0.0.0` is ignored by current builds (verified on
# Chromium 153, with and without `--user-data-dir`: `/proc/net/tcp` shows
# `127.0.0.1:<port>`, connections to the container IP are refused). A browser
# SERVICE must be reachable by IP / published port from the container that drives
# it, so the image runs two processes:
#
#   chromium       -> 127.0.0.1:${BROWSER_CDP_INTERNAL_PORT} (default: CDP port + 1)
#   cdp-forward.js -> 0.0.0.0:${BROWSER_CDP_PORT}            (default: 9222) -> chromium
#
# Nothing here knows about workbench.
#
#   start-browser                 foreground (the container entrypoint): start both,
#                                 require the CDP endpoint to answer, then supervise
#   start-browser --background    start it DETACHED, wait until the CDP endpoint
#                                 answers, then exit 0 (bounded, for a launcher run
#                                 through `docker exec` / ssh, which would otherwise
#                                 block forever on a foreground child)
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
INTERNAL_PORT="${BROWSER_CDP_INTERNAL_PORT:-$((PORT + 1))}"
WAIT_SECONDS="${BROWSER_START_WAIT_SECONDS:-60}"
LOG="${BROWSER_LOG:-/tmp/start-browser.log}"
FORWARDER="${BROWSER_FORWARDER:-/usr/local/bin/cdp-forward.js}"

# Does the CDP HTTP endpoint answer on a given port?
cdp_answers() {
  node -e '
    const http = require("http");
    const req = http.get({ host: "127.0.0.1", port: Number(process.argv[1]), path: "/json/version", timeout: 2000 }, (res) => {
      res.resume();
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
    req.on("error", () => process.exit(1));
    req.on("timeout", () => { req.destroy(); process.exit(1); });
  ' "$1" 2>/dev/null
}

# Background mode: detach the FOREGROUND supervisor (this same script) and wait for
# the CDP endpoint it must bring up. One startup path, two behaviours - the exit
# code is the proof that the service is up, no sleep-and-hope.
if [ "$MODE" = "background" ]; then
  echo "start-browser: starting detached, waiting for CDP on 127.0.0.1:$PORT"
  nohup "$0" --foreground >>"$LOG" 2>&1 &
  SUPERVISOR_PID=$!
  waited=0
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    if cdp_answers "$PORT"; then
      echo "start-browser: CDP endpoint answering on 0.0.0.0:$PORT (after ${waited}s)"
      exit 0
    fi
    if ! kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
      echo "start-browser: the supervisor exited before the CDP endpoint answered - log tail:" >&2
      tail -n 20 "$LOG" >&2 2>/dev/null || true
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "start-browser: no answer on 127.0.0.1:$PORT within ${WAIT_SECONDS}s - log tail:" >&2
  tail -n 20 "$LOG" >&2 2>/dev/null || true
  kill -TERM "$SUPERVISOR_PID" 2>/dev/null || true
  exit 1
fi

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

CHROME_PID=""
FWD_PID=""
stop_children() {
  if [ -n "$CHROME_PID" ]; then kill -TERM "$CHROME_PID" 2>/dev/null || true; fi
  if [ -n "$FWD_PID" ]; then kill -TERM "$FWD_PID" 2>/dev/null || true; fi
}
trap 'stop_children; exit 143' TERM INT

fail_loudly() {
  echo "start-browser: $1" >&2
  echo "start-browser: log tail ($LOG):" >&2
  tail -n 20 "$LOG" >&2 2>/dev/null || true
  stop_children
  exit 1
}

echo "start-browser: $BIN ($($BIN --version 2>/dev/null || echo version-unknown)) on 127.0.0.1:$INTERNAL_PORT, CDP forwarded on 0.0.0.0:$PORT"

"$BIN" \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$INTERNAL_PORT" \
  ${BROWSER_EXTRA_ARGS:-} \
  about:blank >>"$LOG" 2>&1 &
CHROME_PID=$!

CDP_LISTEN_HOST=0.0.0.0 CDP_LISTEN_PORT="$PORT" \
CDP_UPSTREAM_HOST=127.0.0.1 CDP_UPSTREAM_PORT="$INTERNAL_PORT" \
  node "$FORWARDER" >>"$LOG" 2>&1 &
FWD_PID=$!

waited=0
while [ "$waited" -lt "$WAIT_SECONDS" ]; do
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    fail_loudly "chromium exited during startup"
  fi
  if ! kill -0 "$FWD_PID" 2>/dev/null; then
    fail_loudly "the CDP forwarder exited during startup"
  fi
  if cdp_answers "$PORT"; then
    echo "start-browser: CDP endpoint answering on 0.0.0.0:$PORT (after ${waited}s)"
    break
  fi
  sleep 1
  waited=$((waited + 1))
done

if ! cdp_answers "$PORT"; then
  fail_loudly "no answer on 127.0.0.1:$PORT within ${WAIT_SECONDS}s"
fi

# Foreground (the container entrypoint): supervise both children and leave as soon
# as one of them dies - a half-dead browser service must not look healthy.
while kill -0 "$CHROME_PID" 2>/dev/null && kill -0 "$FWD_PID" 2>/dev/null; do
  sleep 5
done
fail_loudly "a child process exited"
