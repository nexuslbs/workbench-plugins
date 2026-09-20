# The BROWSER SERVICE image of the workbench project - a SEPARATE image from the
# workbench core image (`ghcr.io/nexuslbs/workbench`).
#
# Operator decision (2026-09-20): "the browser image is a separate image, not the
# workbench image. It could be accessible using GeneralService". The core image
# ships NO browser; a deployment runs THIS image (or the upstream
# `mcr.microsoft.com/playwright` it is built FROM) and points the
# `browser-use-playwright` provider at it with `browserService.endpoint`.
#
# It contains NO workbench code and NO workbench dependency: chromium + a tiny
# entrypoint that serves CDP on BROWSER_CDP_PORT (default 9222).
#
# Published from THIS repository (nexuslbs/workbench-plugins) by
# `.github/workflows/browser-publish.yml` on a `browser-*` tag as
# `ghcr.io/nexuslbs/workbench-plugins/browser:<version>`.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV BROWSER_CDP_PORT=9222
COPY start-browser.sh /usr/local/bin/start-browser
RUN chmod 0755 /usr/local/bin/start-browser
EXPOSE 9222
ENTRYPOINT ["/usr/local/bin/start-browser"]
