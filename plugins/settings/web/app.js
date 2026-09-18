/**
 * settings page module: shows the active config file (path + raw text), the
 * per-plugin config, the secret references BY NAME, and edits one value through
 * POST /api/settings/patch, then shows the re-read file.
 */
const API = '/api/settings'

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = String(text)
  return node
}

export async function mount(root, { api }) {
  root.appendChild(el('h1', undefined, 'Settings'))
  const status = el('p', 'muted', 'loading...')
  root.appendChild(status)
  const body = el('div')
  root.appendChild(body)

  const output = el('pre', 'muted', 'no edit yet')
  const editor = el('form')
  editor.appendChild(el('h2', undefined, 'Edit a value (persisted through the config layer)'))
  const pathInput = el('input')
  pathInput.placeholder = 'path, e.g. plugins.hello-world.message'
  pathInput.size = 48
  const valueInput = el('input')
  valueInput.placeholder = 'value (JSON or plain text)'
  valueInput.size = 32
  const submit = el('button', undefined, 'persist patch')
  submit.onclick = async (event) => {
    event.preventDefault()
    const path = pathInput.value.split('.').filter(Boolean)
    if (path.length === 0) {
      output.textContent = 'a dotted path is required'
      return false
    }
    let value = valueInput.value
    try {
      value = JSON.parse(valueInput.value)
    } catch {
      /* keep the raw string */
    }
    let result
    try {
      result = await api.post(`${API}/patch`, { op: 'set', path, value })
    } catch (error) {
      output.textContent = `patch request failed: ${error && error.message ? error.message : error}`
      return false
    }
    output.textContent =
      `POST ${API}/patch { op: set, path: ${path.join('.')}, value: ${JSON.stringify(value)} }\n` +
      `-> ${result.ok ? 'ok' : 'error'}: ${result.message}\n` +
      `   file: ${result.file}\n` +
      `   before: ${result.before ? result.before.text.split('\n').filter((l) => l.includes(path[path.length - 1])).join(' | ') : ''}\n` +
      `   after:  ${result.after ? result.after.text.split('\n').filter((l) => l.includes(path[path.length - 1])).join(' | ') : ''}`
    await load()
    return false
  }
  editor.appendChild(pathInput)
  editor.appendChild(valueInput)
  editor.appendChild(submit)
  root.appendChild(editor)
  root.appendChild(el('h2', undefined, 'Raw response'))
  root.appendChild(output)

  async function load() {
    const data = await api.get(API)
    status.textContent = `active config file: ${data.file} (${data.format})`
    body.innerHTML = ''
    const refs = el('div')
    refs.appendChild(el('h2', undefined, 'Secret references (names only)'))
    if (!data.references || data.references.length === 0) {
      refs.appendChild(el('p', 'muted', 'none'))
    } else {
      const list = el('ul')
      for (const ref of data.references) {
        list.appendChild(el('li', 'muted', `${ref.path} -> ${ref.kind}:${ref.name}`))
      }
      refs.appendChild(list)
    }
    refs.appendChild(el('p', 'muted', data.secretPolicy))
    body.appendChild(refs)

    body.appendChild(el('h2', undefined, 'Config file (as written, unexpanded)'))
    body.appendChild(el('pre', 'muted', data.text))

    body.appendChild(el('h2', undefined, 'Per-plugin config'))
    body.appendChild(el('pre', 'muted', JSON.stringify(data.plugins, null, 2)))
  }

  try {
    await load()
  } catch (error) {
    status.textContent = `cannot load ${API}: ${error && error.message ? error.message : error}`
  }
}
