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

# ---------------------------------------------------------------------------
# THE LIVE VIEW (opt-in, OFF by default): the operator watches and drives THE SAME
# chromium the agent uses - no second X server, no second browser, no per-session
# display. The chain is
#
#   chromium on $DISPLAY_NAME -> x11vnc 127.0.0.1:$VNC_PORT (RFB, password auth)
#                             -> websockify 0.0.0.0:$NOVNC_PORT (noVNC + WebSocket)
#                             -> a tunnel (cloudflared) -> the operator's phone
#
# so whatever the agent opens appears in the live view, and whatever the human
# clicks / types / scrolls happens in the agent's browser.
#
#   BROWSER_VNC=0 (default)  nothing extra runs: a deployment that does not opt in
#                            starts exactly the processes it started before
#   BROWSER_VNC=1            start x11vnc + websockify; REQUIRES
#                            BROWSER_VNC_PASSWORD and a headful X display, and
#                            refuses to start the VNC part otherwise (FAIL CLOSED:
#                            a passwordless VNC endpoint is full remote control of
#                            this container for anyone who can reach the port)
#
# noVNC = full remote control of this browser container. The tunnel hostname must
# ADDITIONALLY be protected (Cloudflare Access, or an unguessable path): the
# password is the second line of defence, never the only one.
VNC_ENABLED=""
case "${BROWSER_VNC:-0}" in
  1|true|yes|on) VNC_ENABLED="1" ;;
  0|false|no|off|"") VNC_ENABLED="" ;;
  *)
    echo "start-browser: BROWSER_VNC must be 0 or 1 (got '$BROWSER_VNC')" >&2
    exit 2
    ;;
esac
VNC_PORT="${BROWSER_VNC_PORT:-5900}"
NOVNC_PORT="${BROWSER_NOVNC_PORT:-8080}"
NOVNC_WEB="${BROWSER_NOVNC_WEB:-/usr/share/novnc}"
VNC_PWFILE="${BROWSER_VNC_PWFILE:-/tmp/.browser-vnc-passwd}"
if [ -n "$VNC_ENABLED" ]; then
  # FAIL CLOSED, in this order: a live view that would come up without the password
  # the operator expects, or without one of its pieces, must never start.
  if [ -z "${BROWSER_VNC_PASSWORD:-}" ]; then
    echo "start-browser: BROWSER_VNC=1 but BROWSER_VNC_PASSWORD is empty - refusing to start a PASSWORDLESS live view (that is full remote control of this browser): set BROWSER_VNC_PASSWORD (secret) or BROWSER_VNC=0" >&2
    exit 2
  fi
  if ! command -v x11vnc >/dev/null 2>&1 || ! command -v websockify >/dev/null 2>&1 || [ ! -f "$NOVNC_WEB/vnc.html" ]; then
    echo "start-browser: BROWSER_VNC=1 but the live view is incomplete: x11vnc / websockify / $NOVNC_WEB/vnc.html missing from this image" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# THE LAUNCH MODE - the DEPLOYED DEFAULT is a REAL, HEADFUL browser.
#
# A headless chromium is REFUSED by an origin that checks for a real browser:
# the verification step passes (the cookie such an origin sets appears) and the
# origin STILL answers 403 "Just a moment..." on the next navigation. The SAME
# image served the page directly (HTTP 200, no verification step at all) as soon
# as chromium ran HEADFUL under Xvfb (measured on a public page, threads 2607 and
# 2688). That is why the default here is headful: not a fingerprint trick but an
# ordinary desktop chromium on a real X display.
#
#   BROWSER_HEADLESS=0 (default) headful chromium on the Xvfb display below
#   BROWSER_HEADLESS=1           the old `--headless=new` launch (opt-in; a
#                                deployment that must not run an X server)
HEADLESS=""
case "${BROWSER_HEADLESS:-0}" in
  1|true|yes|on) HEADLESS="1" ;;
  0|false|no|off|"") HEADLESS="" ;;
  *)
    echo "start-browser: BROWSER_HEADLESS must be 0 or 1 (got '$BROWSER_HEADLESS')" >&2
    exit 2
    ;;
esac
# A live view attaches to the X display the browser draws on; the headless launch
# has no display at all, so there is nothing to stream - refuse instead of serving
# an empty VNC screen.
if [ -n "$HEADLESS" ] && [ -n "$VNC_ENABLED" ]; then
  echo "start-browser: BROWSER_VNC=1 needs the X display a headful browser runs on, and BROWSER_HEADLESS=1 starts no X server (set BROWSER_HEADLESS=0 or BROWSER_VNC=0)" >&2
  exit 2
fi
DISPLAY_NAME="${BROWSER_DISPLAY:-:99}"
SCREEN="${BROWSER_SCREEN:-1440x1000x24}"
WINDOW_SIZE="${BROWSER_WINDOW_SIZE:-1440,1000}"
PROFILE_DIR="${BROWSER_PROFILE_DIR:-/tmp/chrome-profile}"
XVFB_PID=""

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

# Does the noVNC page answer? The live-view readiness probe, same shape as the CDP
# one: a live view is up when the page a phone will open is really served.
novnc_answers() {
  node -e '
    const http = require("http");
    const req = http.get({ host: "127.0.0.1", port: Number(process.argv[1]), path: "/vnc.html", timeout: 2000 }, (res) => {
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
      # With the live view enabled, exit 0 only once the noVNC page answers too: the
      # supervisor starts it right after the CDP endpoint comes up, and a launcher
      # that gets exit 0 must know BOTH endpoints are usable.
      if [ -n "$VNC_ENABLED" ]; then
        while [ "$waited" -lt "$WAIT_SECONDS" ]; do
          if novnc_answers "$NOVNC_PORT"; then
            echo "start-browser: live view answering on 0.0.0.0:$NOVNC_PORT (noVNC, after ${waited}s)"
            exit 0
          fi
          sleep 1
          waited=$((waited + 1))
        done
        echo "start-browser: no answer on 127.0.0.1:$NOVNC_PORT (noVNC) within ${WAIT_SECONDS}s - log tail:" >&2
        tail -n 20 "$LOG" >&2 2>/dev/null || true
        kill -TERM "$SUPERVISOR_PID" 2>/dev/null || true
        exit 1
      fi
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
# HEADFUL needs the FULL chromium: `chromium_headless_shell` is a separate binary
# that can only ever run headless. In headless mode the shell stays an acceptable
# fallback, and an image carrying no browser at all fails LOUDLY either way.
BIN=""
CANDIDATES="
  /ms-playwright/chromium-*/chrome-linux/chrome
  /ms-playwright/chromium-*/chrome-linux64/chrome
  /usr/bin/chromium /usr/bin/google-chrome"
if [ -n "$HEADLESS" ]; then
  CANDIDATES="$CANDIDATES
  /ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell
  /ms-playwright/chromium_headless_shell-*/chrome-linux64/headless_shell"
fi
for candidate in $CANDIDATES; do
  for path in $candidate; do
    if [ -x "$path" ]; then BIN="$path"; break 2; fi
  done
done
if [ -z "$BIN" ]; then
  echo "start-browser: no usable browser binary found (headful mode refuses the headless shell): this is not a browser image" >&2
  exit 1
fi

CHROME_PID=""
FWD_PID=""
VNC_PID=""
WS_PID=""
stop_children() {
  if [ -n "$CHROME_PID" ]; then kill -TERM "$CHROME_PID" 2>/dev/null || true; fi
  if [ -n "$FWD_PID" ]; then kill -TERM "$FWD_PID" 2>/dev/null || true; fi
  if [ -n "$WS_PID" ]; then kill -TERM "$WS_PID" 2>/dev/null || true; fi
  if [ -n "$VNC_PID" ]; then kill -TERM "$VNC_PID" 2>/dev/null || true; fi
  if [ -n "$XVFB_PID" ]; then kill -TERM "$XVFB_PID" 2>/dev/null || true; fi
}
trap 'stop_children; exit 143' TERM INT

fail_loudly() {
  echo "start-browser: $1" >&2
  echo "start-browser: log tail ($LOG):" >&2
  tail -n 20 "$LOG" >&2 2>/dev/null || true
  stop_children
  exit 1
}

# THE CHROMIUM SWITCH SET: the SAME stock automation switches playwright's own
# chromium launcher spawns (playwright-core chromiumSwitches - i.e. the browser
# the provider would launch itself, with the version of the library the plugin
# already depends on). A SHORTER hand-rolled list is not neutral: measured
# (thread 2755, same binary + display + egress IP) the shortened list made the
# origin serve a DIFFERENT document than this set, while spawning with these
# switches got the same document bare playwright gets. Keep it in sync with
# node_modules/playwright-core when playwright is upgraded.
STOCK_FLAGS="\
--disable-field-trial-config \
--disable-background-networking \
--disable-background-timer-throttling \
--disable-backgrounding-occluded-windows \
--disable-back-forward-cache \
--disable-breakpad \
--disable-client-side-phishing-detection \
--disable-component-extensions-with-background-pages \
--disable-component-update \
--no-default-browser-check \
--disable-default-apps \
--disable-edgeupdater \
--disable-extensions \
--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion \
--enable-features=CDPScreenshotNewSurface \
--allow-pre-commit-input \
--disable-hang-monitor \
--disable-ipc-flooding-protection \
--disable-popup-blocking \
--disable-prompt-on-repost \
--disable-renderer-backgrounding \
--disable-updater-scheduler \
--force-color-profile=srgb \
--metrics-recording-only \
--no-first-run \
--password-store=basic \
--use-mock-keychain \
--no-service-autorun \
--export-tagged-pdf \
--disable-search-engine-choice-screen \
--unsafely-disable-devtools-self-xss-warnings \
--edge-skip-compat-layer-relaunch \
--disable-infobars \
--disable-sync \
--enable-unsafe-swiftshader"

# The X DISPLAY: started and owned HERE in headful mode. Readiness is the X
# socket, not a sleep: chromium refuses to start against a display that is not
# there yet, and a container that half-started must never look healthy.
if [ -z "$HEADLESS" ]; then
  if ! command -v Xvfb >/dev/null 2>&1; then
    fail_loudly "Xvfb is not installed in this image: a headful chromium needs an X server (set BROWSER_HEADLESS=1 to run headless instead)"
  fi
  export DISPLAY="$DISPLAY_NAME"
  XNUM="${DISPLAY_NAME#:}"
  XNUM="${XNUM%%.*}"
  XSOCK="/tmp/.X11-unix/X${XNUM}"
  XLOCK="/tmp/.X${XNUM}-lock"
  # A RESTARTED container keeps its /tmp: the previous Xvfb is gone but its lock
  # file survives, and Xvfb then REFUSES to start ("Server is already active for
  # display :99", exit 1) so the browser never comes up - a container that looks
  # alive and answers nothing. This script starts the ONLY Xvfb in the container
  # and runs once per container start, so a lock file with no live Xvfb behind it
  # is always stale: clear it. `pgrep` may be absent; then the socket check below
  # still decides, only the stale lock is left alone.
  if [ -e "$XLOCK" ] && ! pgrep -x Xvfb >/dev/null 2>&1; then
    rm -f "$XLOCK"
  fi
  rm -f "$XSOCK" 2>/dev/null || true
  Xvfb "$DISPLAY_NAME" -screen 0 "$SCREEN" -nolisten tcp >>"$LOG" 2>&1 &
  XVFB_PID=$!
  xwaited=0
  while [ "$xwaited" -lt "$WAIT_SECONDS" ]; do
    if ! kill -0 "$XVFB_PID" 2>/dev/null; then
      fail_loudly "Xvfb exited during startup"
    fi
    if [ -S "$XSOCK" ]; then break; fi
    sleep 1
    xwaited=$((xwaited + 1))
  done
  if [ ! -S "$XSOCK" ]; then
    fail_loudly "no X display on $DISPLAY_NAME (socket $XSOCK) within ${WAIT_SECONDS}s"
  fi
  MODE="headful on $DISPLAY_NAME ($SCREEN), window $WINDOW_SIZE"
  # NO GPU-DISABLING FLAG. `--disable-gpu` (and `--use-gl=disabled`) leave the
  # browser with NO WebGL renderer at all: `canvas.getContext('webgl')` returns a
  # context whose UNMASKED_RENDERER_WEBGL is null, which is not what an ordinary
  # desktop browser exposes on a machine that has any GL stack. This container
  # has no GPU, so ANGLE falls back to software rendering on this display;
  # `--enable-unsafe-swiftshader` only ALLOWS that fallback (recent chromium
  # refuses software WebGL without it) and is inert where real GL exists.
  LAUNCH_ARGS="$STOCK_FLAGS --window-size=$WINDOW_SIZE --user-data-dir=$PROFILE_DIR"
else
  MODE="headless (--headless=new, BROWSER_HEADLESS=1)"
  LAUNCH_ARGS="$STOCK_FLAGS --headless=new --window-size=$WINDOW_SIZE --user-data-dir=$PROFILE_DIR"
fi

echo "start-browser: mode=$MODE, chromium $BIN ($($BIN --version 2>/dev/null || echo version-unknown)) on 127.0.0.1:$INTERNAL_PORT, CDP forwarded on 0.0.0.0:$PORT"

# shellcheck disable=SC2086
"$BIN" \
  $LAUNCH_ARGS \
  --no-sandbox \
  --disable-dev-shm-usage \
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

# ---------------------------------------------------------------------------
# THE LIVE VIEW, started AFTER the browser is really up and ON THE SAME DISPLAY:
# x11vnc attaches to $DISPLAY_NAME (the display chromium is drawing on), websockify
# serves the noVNC client and proxies the RFB connection to x11vnc. The password is
# handed to x11vnc through a 0600 file (never on the command line, so it does not
# show up in `ps`, and never in a log); the x11vnc server itself binds LOOPBACK
# only and websockify is the only thing listening on the container network.
start_live_view() {
  [ -n "$VNC_ENABLED" ] || return 0
  rm -f "$VNC_PWFILE"
  umask 077
  if ! x11vnc -storepasswd "$BROWSER_VNC_PASSWORD" "$VNC_PWFILE" >/dev/null 2>&1; then
    fail_loudly "could not store the VNC password in $VNC_PWFILE"
  fi
  chmod 0600 "$VNC_PWFILE"
  x11vnc -display "$DISPLAY_NAME" -forever -shared -localhost \
    -rfbport "$VNC_PORT" -rfbauth "$VNC_PWFILE" >>"$LOG" 2>&1 &
  VNC_PID=$!
  websockify --web="$NOVNC_WEB" "0.0.0.0:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >>"$LOG" 2>&1 &
  WS_PID=$!
  vwaited=0
  while [ "$vwaited" -lt "$WAIT_SECONDS" ]; do
    if ! kill -0 "$VNC_PID" 2>/dev/null; then
      fail_loudly "x11vnc exited during startup"
    fi
    if ! kill -0 "$WS_PID" 2>/dev/null; then
      fail_loudly "websockify exited during startup"
    fi
    if novnc_answers "$NOVNC_PORT"; then
      echo "start-browser: live view on 0.0.0.0:$NOVNC_PORT (noVNC) -> 127.0.0.1:$VNC_PORT (x11vnc on $DISPLAY_NAME), password required"
      return 0
    fi
    sleep 1
    vwaited=$((vwaited + 1))
  done
  fail_loudly "no answer on 127.0.0.1:$NOVNC_PORT (noVNC) within ${WAIT_SECONDS}s"
}
start_live_view

# Foreground (the container entrypoint): supervise both children and leave as soon
# as one of them dies - a half-dead browser service must not look healthy.
while kill -0 "$CHROME_PID" 2>/dev/null && kill -0 "$FWD_PID" 2>/dev/null; do
  if [ -n "$XVFB_PID" ] && ! kill -0 "$XVFB_PID" 2>/dev/null; then
    fail_loudly "Xvfb exited"
  fi
  if [ -n "$VNC_PID" ] && ! kill -0 "$VNC_PID" 2>/dev/null; then
    fail_loudly "x11vnc exited"
  fi
  if [ -n "$WS_PID" ] && ! kill -0 "$WS_PID" 2>/dev/null; then
    fail_loudly "websockify exited"
  fi
  sleep 5
done
fail_loudly "a child process exited"
