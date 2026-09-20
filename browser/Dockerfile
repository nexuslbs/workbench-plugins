# The BROWSER SERVICE image of the workbench project - a SEPARATE image from the
# workbench core image (`ghcr.io/nexuslbs/workbench`).
#
# Operator decision (2026-09-20): "the browser image is a separate image, not the
# workbench image. It could be accessible using GeneralService". The core image
# ships NO browser; a deployment runs THIS image (or the upstream
# `mcr.microsoft.com/playwright` it is built FROM) and points the
# `browser-use-playwright` provider at it with `browserService.endpoint`.
#
# It contains NO workbench code and NO workbench dependency: chromium, a raw TCP
# forwarder that publishes chromium's loopback CDP endpoint on 0.0.0.0, and a tiny
# entrypoint (start-browser / cdp-forward.js).
#
# Published from THIS repository (nexuslbs/workbench-plugins) by
# `.github/workflows/browser-publish.yml` on a `browser-*` tag as
# `ghcr.io/nexuslbs/workbench-plugins/browser:<version>`.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# The port CALLERS use (bound 0.0.0.0 by cdp-forward.js) and the port chromium
# itself listens on (loopback only - see cdp-forward.js for why the forwarder is
# required, not optional).
ENV BROWSER_CDP_PORT=9222
ENV BROWSER_CDP_INTERNAL_PORT=9223

COPY start-browser.sh /usr/local/bin/start-browser
COPY cdp-forward.js /usr/local/bin/cdp-forward.js
RUN chmod 0755 /usr/local/bin/start-browser /usr/local/bin/cdp-forward.js

EXPOSE 9222
ENTRYPOINT ["/usr/local/bin/start-browser"]
