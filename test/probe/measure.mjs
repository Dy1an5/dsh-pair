/**
 * Measure the open sheet: does a long list scroll inside the viewport?
 *
 * Run: CHROME=... node test/probe/measure.mjs
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const CHROME = process.env.CHROME
const port = 9222 + Math.floor(Math.random() * 400)
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', `--remote-debugging-port=${String(port)}`, `--user-data-dir=/tmp/dsh-measure-${randomUUID()}`, '--window-size=390,844', 'about:blank'],
  { stdio: 'ignore' },
)

const endpoint = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
      if (response.ok) return (await response.json()).webSocketDebuggerUrl
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('no devtools')
}

const socket = new WebSocket(await endpoint())
const pending = new Map()
let nextId = 1
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  })

const created = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
const call = (method, params) => send(method, params, sessionId)
await call('Page.enable')
await call('Runtime.enable')
await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await call('Page.navigate', { url: 'http://127.0.0.1:8931/' })

const evaluate = async expression => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result.result?.value
}

await new Promise(resolve => setTimeout(resolve, 1500))
await evaluate('location.hash = "#/s/session-alpha"')
await new Promise(resolve => setTimeout(resolve, 1200))
await evaluate('document.querySelector(".ctx-chip")?.click()')
await new Promise(resolve => setTimeout(resolve, 700))

// A real profile lists dozens of models: clone rows to prove the sheet scrolls
// instead of clipping the tail.
await evaluate(`(() => {
  const body = document.querySelector('.sheet-body')
  const last = body.querySelector('.sheet-row')
  for (let index = 0; index < 14; index += 1) body.append(last.cloneNode(true))
})()`)
await new Promise(resolve => setTimeout(resolve, 200))

console.log(
  JSON.stringify(
    await evaluate(`(() => {
      const sheet = document.querySelector('.sheet')
      const body = document.querySelector('.sheet-body')
      const host = document.querySelector('.sheet-host')
      const rect = sheet.getBoundingClientRect()
      return {
        viewport: innerHeight,
        sheet: { top: Math.round(rect.top), height: Math.round(rect.height), maxHeight: getComputedStyle(sheet).maxHeight, overflowY: getComputedStyle(sheet).overflowY, scrollHeight: sheet.scrollHeight, clientHeight: sheet.clientHeight },
        body: { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight },
        host: { height: Math.round(host.getBoundingClientRect().height) },
        rows: document.querySelectorAll('.sheet-row').length,
      }
    })()`),
    null,
    2,
  ),
)

socket.close()
chrome.kill('SIGKILL')
process.exit(0)
