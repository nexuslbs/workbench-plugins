/**
 * cordis-ui page module: inspects the live cordis runtime (services, registry
 * fibers, loader states) and performs one runtime action (start / stop /
 * reload / dispose) on a plugin through the plugin's JSON API. Plain ES module,
 * no framework, no build step; the core shell imports it and calls
 * mount(root, { page, api }).
 */
const API = '/api/cordis-ui'

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = String(text)
  return node
}

function pre(value) {
  return el('pre', 'muted', JSON.stringify(value, null, 2))
}

function table(headers, rows) {
  const node = el('table')
  const head = el('tr')
  for (const label of headers) head.appendChild(el('th', undefined, label))
  node.appendChild(head)
  for (const cells of rows) {
    const row = el('tr')
    for (const cell of cells) {
      const td = el('td', typeof cell === 'string' ? undefined : cell.className, typeof cell === 'string' ? cell : cell.text)
      row.appendChild(td)
    }
    node.appendChild(row)
  }
  return node
}

function renderRuntime(runtime, root) {
  root.appendChild(el('h1', undefined, 'Cordis UI'))
  root.appendChild(el('p', 'muted', `runtime contract ${runtime.contract}`))

  root.appendChild(el('h2', undefined, 'Services'))
  root.appendChild(
    table(
      ['Service', 'Available', 'Facts'],
      runtime.services.map((service) => [
        service.service,
        { text: service.available ? 'yes' : 'no', className: service.available ? 'ok' : 'error' },
        JSON.stringify(service.facts ?? {}),
      ]),
    ),
  )

  const registry = runtime.registry ?? { available: false, fibers: [] }
  root.appendChild(el('h2', undefined, `Registry (${registry.available ? `size ${registry.size ?? '?'}` : 'unavailable'})`))
  if (registry.note) root.appendChild(el('p', 'muted', registry.note))
  const fibers = registry.fibers ?? []
  if (fibers.length === 0) {
    root.appendChild(el('p', 'muted', 'no fiber reported by this cordis build'))
  } else {
    root.appendChild(
      table(
        ['Fiber / plugin', 'State', 'Effects'],
        fibers.map((fiber) => [fiber.name, fiber.state ?? '(unknown)', fiber.effects === undefined ? '(unknown)' : String(fiber.effects)]),
      ),
    )
  }

  const loader = runtime.loader ?? { entries: [], failures: [], disabled: [] }
  root.appendChild(el('h2', undefined, `Loader (${loader.entries.length} discovered, ${loader.failures.length} failed, ${loader.disabled.length} disabled)`))
  root.appendChild(
    table(
      ['Plugin', 'State', 'Source'],
      loader.entries.map((entry) => [entry.name, entry.state, entry.source ?? entry.dir ?? '']),
    ),
  )
  if (loader.failures.length > 0) {
    root.appendChild(el('h3', undefined, 'Load failures'))
    root.appendChild(pre(loader.failures))
  }
}

function renderActions(runtime, root, reload) {
  const names = (runtime.loader?.entries ?? []).map((entry) => entry.name)
  const box = el('div', 'actions')
  box.appendChild(el('h2', undefined, 'Manage the runtime'))

  const select = el('select')
  for (const name of names) {
    const option = el('option', undefined, name)
    option.value = name
    select.appendChild(option)
  }
  box.appendChild(select)

  const out = el('pre', 'muted')
  const actions = [
    ['inspect', 'inspect (read-only)'],
    ['reload', 'reload'],
    ['stop', 'stop (dispose the fiber)'],
    ['start', 'start (load it again)'],
    ['dispose', 'dispose'],
  ]
  for (const [action, label] of actions) {
    const button = el('button', undefined, label)
    button.addEventListener('click', async () => {
      const target = select.value
      out.textContent = `${action} ${target} ...`
      try {
        const result = await fetch(`${API}/action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, target }),
        }).then((response) => response.json())
        out.textContent = `${action} ${target}\n` + JSON.stringify(result, null, 2)
      } catch (error) {
        out.textContent = `${action} ${target} failed: ${error && error.message ? error.message : error}`
      }
      await reload()
    })
    box.appendChild(button)
  }
  box.appendChild(out)
  root.appendChild(box)
}

export async function mount(root, { api }) {
  root.appendChild(el('p', 'muted', 'loading the cordis runtime...'))
  let runtime
  try {
    runtime = await api.get(`${API}/runtime`)
  } catch (error) {
    root.innerHTML = ''
    root.appendChild(el('p', 'error', `cannot load ${API}/runtime: ${error && error.message ? error.message : error}`))
    return
  }
  root.innerHTML = ''
  renderRuntime(runtime, root)

  const actions = el('section')
  root.appendChild(actions)
  const reload = async () => {
    actions.innerHTML = ''
    try {
      renderActions(await api.get(`${API}/runtime`), actions, reload)
    } catch (error) {
      actions.appendChild(el('p', 'error', String(error)))
    }
  }
  await reload()
}
