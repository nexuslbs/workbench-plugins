/**
 * plugin-inventory page module: renders the loader inventory the plugin's JSON
 * API returns. Plain ES module, no framework, no build step; the core shell
 * imports it and calls mount(root, { page, api }).
 */
const API = '/api/plugin-inventory'

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = String(text)
  return node
}

function stateClass(state) {
  if (state === 'loaded') return 'ok'
  if (state === 'failed') return 'error'
  if (state === 'disabled') return 'muted'
  return ''
}

function render(data, root) {
  root.appendChild(el('h1', undefined, 'Plugin Inventory'))
  const summary = el(
    'p',
    'muted',
    `${data.entries.length} plugin(s) discovered, ${data.loaded} loaded, ${data.failed} failed, ` +
      `${data.disabled.length} disabled. Config: ${data.configFile}`,
  )
  root.appendChild(summary)

  const table = el('table')
  const head = el('tr')
  for (const label of ['Plugin', 'Version', 'Source', 'Path', 'State', 'Capabilities / commands']) {
    head.appendChild(el('th', undefined, label))
  }
  table.appendChild(head)

  for (const entry of data.entries) {
    const row = el('tr')
    row.appendChild(el('td', undefined, entry.name))
    row.appendChild(el('td', undefined, entry.version))
    row.appendChild(el('td', undefined, `${entry.source}${entry.external ? ' (external)' : ''}`))
    row.appendChild(el('td', 'muted', entry.dir))
    const state = el('td', stateClass(entry.state), entry.state + (entry.error ? `: ${entry.error}` : ''))
    row.appendChild(state)
    const caps = entry.capabilities && entry.capabilities.length ? entry.capabilities.join(', ') : ''
    const commands = entry.commands && entry.commands.length ? `commands: ${entry.commands.join(', ')}` : ''
    row.appendChild(el('td', 'muted', [caps, commands].filter(Boolean).join(' | ')))
    table.appendChild(row)
  }
  root.appendChild(table)

  const sources = el('details')
  sources.appendChild(el('summary', undefined, 'Sources'))
  const pre = el('pre', 'muted', JSON.stringify(data.sources, null, 2))
  sources.appendChild(pre)
  root.appendChild(sources)
}

export async function mount(root, { api }) {
  root.appendChild(el('p', 'muted', 'loading the loader inventory...'))
  let data
  try {
    data = await api.get(API)
  } catch (error) {
    root.innerHTML = ''
    root.appendChild(el('p', 'error', `cannot load ${API}: ${error && error.message ? error.message : error}`))
    return
  }
  root.innerHTML = ''
  render(data, root)
}
