/**
 * plugin-manager page module: one row per plugin with the loader actions, plus
 * a "reconcile" button that applies a config-file edit to the RUNNING process
 * and an install form. Every action POSTs to /api/plugin-manager/action and
 * prints the RAW loader response (ok, message, persisted, before -> after,
 * and for reconcile the per-plugin delta) so the state change is visible
 * instead of claimed.
 */
const API = '/api/plugin-manager'

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

function row(text) {
  return el('td', 'muted', text)
}

export async function mount(root, { api }) {
  root.appendChild(el('h1', undefined, 'Plugin Manager'))
  const status = el('p', 'muted', 'loading...')
  root.appendChild(status)
  const output = el('pre', 'muted', 'no action yet')
  const tableBox = el('div')

  async function refresh() {
    const state = await api.get(`${API}/state`)
    status.textContent =
      `${state.entries.length} plugin(s) discovered. Config: ${state.configFile}` +
      (state.canPersist && state.canPersist.ok === false ? ` (not persistable: ${state.canPersist.reason})` : '')
    tableBox.innerHTML = ''
    const table = el('table')
    const head = el('tr')
    for (const label of ['Plugin', 'Source', 'State', 'Actions']) head.appendChild(el('th', undefined, label))
    table.appendChild(head)
    for (const entry of state.entries) {
      const tr = el('tr')
      tr.appendChild(el('td', undefined, `${entry.name} ${entry.version}`))
      tr.appendChild(row(`${entry.source}${entry.external ? ' (external)' : ''}`))
      tr.appendChild(el('td', stateClass(entry.state), entry.state + (entry.error ? `: ${entry.error}` : '')))
      const actions = el('td')
      const add = (label, action) => {
        const button = el('button', undefined, label)
        button.onclick = () => act(action, entry.name)
        actions.appendChild(button)
      }
      if (entry.state === 'loaded') {
        add('reload', 'reload')
        add('disable', 'disable')
        add('unload', 'unload')
      } else {
        add('load', 'load')
        add('enable', 'enable')
      }
      if (entry.state === 'failed') add('retry', 'retry')
      tr.appendChild(actions)
      table.appendChild(tr)
    }
    tableBox.appendChild(table)
  }

  async function act(action, target, extra) {
    output.textContent = `POST ${API}/action ${JSON.stringify({ action, target, ...(extra || {}) })}`
    let result
    try {
      result = await api.post(`${API}/action`, { action, target, ...(extra || {}) })
    } catch (error) {
      output.textContent += `\n-> request failed: ${error && error.message ? error.message : error}`
      return
    }
    const before = result.before && result.before.discovered ? result.before.discovered.map((e) => `${e.name}=${e.state}`) : []
    const after = result.after && result.after.discovered ? result.after.discovered.map((e) => `${e.name}=${e.state}`) : []
    output.textContent +=
      `\n-> status ${result.ok ? 'ok' : 'error'}: ${result.message}` +
      `\n   persisted: ${result.persisted}` +
      `\n   before: ${before.join(', ')}` +
      `\n   after:  ${after.join(', ')}` +
      (Array.isArray(result.changes)
        ? `\n   delta:  ${result.changes.map((c) => `${c.name}=${c.action}`).join(', ') || '(empty: the roster already matches)'}`
        : '')
    try {
      await refresh()
    } catch (error) {
      status.textContent = `refresh failed: ${error && error.message ? error.message : error}`
    }
  }

  const reconcile = el('form')
  reconcile.appendChild(el('h2', undefined, 'Apply config changes'))
  reconcile.appendChild(
    el('p', 'muted', 'Diff the desired "plugins:" roster in the config file against the live tree and apply only the delta (load / unload / reload), without restarting the process.'),
  )
  const reconcileButton = el('button', undefined, 'reconcile')
  reconcileButton.onclick = (event) => {
    event.preventDefault()
    void act('reconcile')
    return false
  }
  reconcile.appendChild(reconcileButton)

  const install = el('form')
  install.appendChild(el('h2', undefined, 'Install a source'))
  const inputs = {}
  for (const [key, placeholder] of [
    ['kind', 'kind (path|git)'],
    ['id', 'id'],
    ['path', 'path (relative to the config)'],
    ['url', 'url (git)'],
    ['ref', 'ref (git, optional)'],
    ['subdir', 'subdir (optional)'],
  ]) {
    const input = el('input')
    input.placeholder = placeholder
    inputs[key] = input
    install.appendChild(input)
  }
  const submit = el('button', undefined, 'install source')
  submit.onclick = (event) => {
    event.preventDefault()
    const source = {}
    for (const [key, input] of Object.entries(inputs)) if (input.value.trim()) source[key] = input.value.trim()
    if (source.kind !== 'path' && source.kind !== 'git') {
      output.textContent = "install needs a 'kind' of 'path' or 'git'"
      return false
    }
    void act('install', source.id || source.path || source.url || '(source)', { source })
    return false
  }
  install.appendChild(submit)

  root.appendChild(tableBox)
  root.appendChild(reconcile)
  root.appendChild(install)
  root.appendChild(el('h2', undefined, 'Raw loader response'))
  root.appendChild(output)

  try {
    await refresh()
  } catch (error) {
    status.textContent = `cannot load ${API}/state: ${error && error.message ? error.message : error}`
  }
}
