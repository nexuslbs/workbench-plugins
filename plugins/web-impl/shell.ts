/**
 * The minimal shell, served by the `web@1` provider `http` (plugin web-impl).
 *
 * CHOICE (documented in `docs/PLUGIN-CONTRACT.md`): the shell - the HTML page,
 * the nav built from the registered pages and the mount point that imports a
 * page's own module - is the CORE provider's. It is deliberately tiny (no SPA
 * framework, no bundler, no template engine) and contains no product feature:
 * every surface the UI shows is a page module registered by a UI plugin, served
 * from that plugin's own directory.
 *
 * A page module is a browser ES module exporting
 *
 *   export function mount(element, context) { ... }   // required
 *   export function unmount() { ... }                 // optional
 *
 * where `context.page` is the registered page and `context.api` offers
 * `get(url)` / `post(url, body)` against the plugin's own JSON routes.
 */
import type { Web, WebPageInfo } from '../../definitions/web.ts'

/** Escapes text for HTML output. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Renders the shell HTML: nav from the registered pages, one mount point. */
export function renderShell(web: Web, activePath: string = '/'): string {
  const pages = web.pages()
  const nav = pages.length
    ? pages
        .map(
          (page) =>
            `<a class="nav-item${page.path === activePath ? ' active' : ''}" href="${escapeHtml(page.path)}" data-page="${escapeHtml(page.id)}">${escapeHtml(page.title)}</a>`,
        )
        .join('\n        ')
    : '<span class="nav-item muted">no UI plugin loaded</span>'
  const summary = pages.length
    ? `${pages.length} page(s) from ${new Set(pages.map((page) => page.plugin)).size} plugin(s)`
    : 'no UI plugin is configured; this is the empty shell'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>workbench</title>
<link rel="stylesheet" href="/shell.css">
</head>
<body>
<header class="top">
  <span class="brand">workbench</span>
  <nav class="nav">
        ${nav}
  </nav>
  <span class="summary">${escapeHtml(summary)}</span>
</header>
<main id="mount"><p class="muted">loading...</p></main>
<script type="module" src="/shell.js"></script>
</body>
</html>
`
}

/** The shell stylesheet (plain CSS, no framework). */
export const SHELL_CSS = `:root { color-scheme: light dark; --fg: #1b1b1f; --bg: #f7f7f8; --line: #d9d9e0; --accent: #2f6fed; --muted: #6b6b76; --card: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8ea; --bg: #16171a; --line: #33343a; --accent: #7aa2f7; --muted: #9a9aa5; --card: #1e1f24; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); background: var(--bg); }
.top { display: flex; gap: 16px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--card); position: sticky; top: 0; }
.brand { font-weight: 700; letter-spacing: .04em; }
.nav { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; }
.nav-item { padding: 3px 10px; border: 1px solid transparent; border-radius: 999px; color: var(--fg); text-decoration: none; }
.nav-item:hover { border-color: var(--line); }
.nav-item.active { border-color: var(--accent); color: var(--accent); }
.summary { color: var(--muted); font-size: 12px; }
main { padding: 16px; }
.muted { color: var(--muted); }
h1 { font-size: 18px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 20px 0 8px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
tr:hover td { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.error { color: #c0392b; }
.ok { color: #1e8449; }
button { font: inherit; padding: 3px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); cursor: pointer; }
button:hover { border-color: var(--accent); color: var(--accent); }
input, select { font: inherit; padding: 3px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); }
pre { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 8px; overflow: auto; max-height: 320px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0 0 8px; }
`

/**
 * The shell module: it resolves the current URL to a registered page, imports
 * that page's own module (served by its plugin) and mounts it. No router, no
 * framework: one fetch of the page index plus one dynamic import.
 */
export const SHELL_JS = `const mount = document.getElementById('mount');
const api = {
  get: async (url) => { const r = await fetch(url, { headers: { accept: 'application/json' } }); return r.json(); },
  post: async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return r.json();
  },
};
function fail(message) { mount.innerHTML = '<p class="error"></p>'; mount.querySelector('.error').textContent = String(message); }
function pick(pages, pathname) {
  return pages.find((page) => page.path === pathname)
    || pages.find((page) => pathname === '/p/' + page.id)
    || (pathname === '/' ? pages[0] : undefined);
}
let current;
async function run() {
  let pages;
  try { pages = (await api.get('/api/web/pages')).pages || []; }
  catch (error) { fail('cannot load the page index: ' + error); return; }
  const page = pick(pages, location.pathname);
  if (!page) {
    mount.innerHTML = '<h1>workbench web</h1><p class="muted">No UI plugin is loaded. Declare one in the config sources and reload.</p>';
    return;
  }
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page.id));
  try {
    const module = await import(page.module);
    if (current && typeof current.unmount === 'function') await current.unmount();
    mount.innerHTML = '';
    current = module;
    await module.mount(mount, { page, api });
  } catch (error) { fail('page ' + page.id + ' failed: ' + (error && error.message ? error.message : error)); }
}
window.addEventListener('popstate', run);
run();
`

/** Pages shown by the shell, for the provider's page-index route. */
export function pageIndex(web: Web): WebPageInfo[] {
  return web.pages()
}
