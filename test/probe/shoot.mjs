/**
 * Drive headless Chromium over CDP to capture the phone app.
 *
 * The app is a single-page app with pollers, so `--screenshot` never fires:
 * the page never goes idle. This script attaches to a DevTools target, runs a
 * click script, waits for the expected node, and captures the viewport.
 *
 * Usage: node test/probe/shoot.mjs <url> <out.png> [clickExpr] [waitExpr]
 */
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const [url, out, clickExpr = '', waitExpr = ''] = process.argv.slice(2)
if (url === undefined || out === undefined) {
  console.error('usage: shoot.mjs <url> <out.png> [clickExpr] [waitExpr]')
  process.exit(2)
}

const CHROME = process.env.CHROME
if (CHROME === undefined) {
  console.error('set CHROME to a chromium binary')
  process.exit(2)
}

const port = 9222 + Math.floor(Math.random() * 400)
const profile = `/tmp/dsh-probe-${randomUUID()}`
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    `--remote-debugging-port=${String(port)}`,
    `--user-data-dir=${profile}`,
    '--window-size=390,844',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

/** Wait until the DevTools endpoint answers. */
async function endpoint() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
      if (response.ok) return (await response.json()).webSocketDebuggerUrl
    } catch {
      // Not up yet.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('devtools endpoint did not start')
}

/** Minimal CDP session over the browser-level socket. */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  return { socket, opened, send }
}

const browser = connect(await endpoint())
await browser.opened
const created = await browser.send('Target.createTarget', { url: 'about:blank' })
const attached = await browser.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
const sessionId = attached.sessionId
const send = (method, params) => browser.send(method, params, sessionId)

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
if (process.env.DARK === '1') {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
}
await send('Page.navigate', { url })

/** Evaluate an expression in the page. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text ?? 'evaluate failed')
  return result.result?.value
}

/** Poll until the expression is truthy. */
async function waitFor(expression, ms = 15_000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (await evaluate(expression)) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${expression}`)
}

await waitFor('document.readyState === "complete"')
if (clickExpr !== '') {
  await waitFor(clickExpr.replace(/^click:/u, 'Boolean(') + ')').catch(() => {})
  await evaluate(clickExpr)
}
if (waitExpr !== '') await waitFor(waitExpr)
// Let the sheet transition settle before capturing.
await new Promise(resolve => setTimeout(resolve, 450))

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
await writeFile(out, Buffer.from(shot.data, 'base64'))
console.log(`wrote ${out}`)

browser.socket.close()
chrome.kill('SIGKILL')
process.exit(0)
