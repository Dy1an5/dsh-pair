/**
 * Plugin tests.
 *
 * Two layers: pure helpers (transcript folding, pairing state) and a real
 * HTTP round-trip through the harness in `harness.js`, which covers routing,
 * cookie handling, and the desktop/bridge authentication split.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it, mock } from 'node:test'
import { Pairing, collectState, normalizeEvents, renderQrSvg, deviceLabel } from '../index.js'
import { RUNNING_EVENTS, SESSION_EVENTS, createServices, startHarness } from './harness.js'

const APP_DIR = fileURLToPath(new URL('../app', import.meta.url))
/** The checkout's parent directory: one level above the plugin, for cwd-relative reads. */
const CHECKOUT_PARENT = dirname(dirname(APP_DIR))
/** A file inside this plugin, addressed relative to that parent cwd. */
const PLUGIN_RELATIVE_IMAGE = join(basename(dirname(APP_DIR)), 'docs/phone-sheet.png')

describe('normalizeEvents', () => {
  it('folds user, assistant, and paired tool rows', () => {
    const { items, running } = normalizeEvents(SESSION_EVENTS)
    assert.equal(running, false)
    assert.deepEqual(
      items.map(item => item.kind),
      ['user', 'assistant', 'tool'],
    )
    assert.equal(items[0].text, '帮我看下这个仓库')
    assert.equal(items[1].reasoning, '先看结构。')
    assert.match(items[1].text, /\*\*结论\*\*/)
    assert.equal(items[2].name, 'bash')
    assert.equal(items[2].result, 'README.md\nsrc/')
    assert.equal(items[2].isError, false)
  })

  it('skips synthetic user messages so injections do not read as chat', () => {
    const { items } = normalizeEvents(SESSION_EVENTS)
    assert.equal(
      items.some(item => (item.text ?? '').includes('[注入]')),
      false,
    )
  })

  it('reports a running turn while no turn/end exists', () => {
    const { running } = normalizeEvents(RUNNING_EVENTS)
    assert.equal(running, true)
  })

  it('clamps oversized tool output', () => {
    const huge = 'x'.repeat(20_000)
    const { items } = normalizeEvents([
      { seq: 1, type: 'assistant/message', time: 1, data: { message: { content: [{ type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }] } } },
      { seq: 2, type: 'tool/result', time: 2, data: { message: { toolCallId: 'c', content: [{ type: 'text', text: huge }] } } },
    ])
    assert.equal(items[0].result.length < 7_000, true)
    assert.match(items[0].result, /字符已省略/)
  })

  it('keeps a tool call whose result never arrived', () => {
    const { items } = normalizeEvents([
      { seq: 9, type: 'assistant/message', time: 1, data: { message: { content: [{ type: 'tool-call', id: 'pending', name: 'read', arguments: '{"path":"a"}' }] } } },
    ])
    assert.equal(items.length, 1)
    assert.equal(items[0].result, undefined)
    assert.equal(items[0].key, 'tpending')
  })
})

describe('collectState', () => {
  it('falls back to flat directory groups when the registry has no members', async () => {
    const services = createServices()
    services.workspaceController = {
      baseline: () => ({
        items: [{ workspaceId: 'ws-demo', title: 'Demo', path: '/home/dylan/Projects/demo', sessionIds: [] }],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      }),
    }
    const state = await collectState(services)
    assert.equal(state.groupedBy, 'cwd')
    assert.deepEqual(
      state.workspaces.map(group => group.title).sort(),
      ['demo', 'other', 'web'],
    )
    // Flat on purpose: no invented parent/child nesting without membership data.
    assert.equal(state.workspaces[0].parentId, null)
    const demo = state.workspaces.find(group => group.title === 'demo')
    const web = state.workspaces.find(group => group.title === 'web')
    assert.deepEqual(
      demo.sessions.map(session => session.id).sort(),
      ['session-alpha', 'session-beta', 'session-image', 'session-pending'],
    )
    assert.deepEqual(
      web.sessions.map(session => session.id),
      ['session-gamma'],
    )
    assert.equal(state.diagnostics.members, 0)
  })

  it('keeps workspaces flat in registry order, even when one path contains another', async () => {
    const state = await collectState(createServices())
    assert.deepEqual(
      state.workspaces.map(workspace => workspace.id),
      ['ws-demo', 'ws-demo-web', 'ws-empty'],
    )
    assert.equal(state.groupedBy, 'workspace')
    // Pinned leads, then most recent activity.
    assert.deepEqual(
      state.workspaces[0].sessions.map(session => session.id),
      ['session-alpha', 'session-beta', 'session-pending'],
    )
    assert.equal(state.workspaces[0].sessions[0].title, '看一下仓库结构')
    assert.equal(state.workspaces[0].sessions[0].pinned, true)
    // Status follows the desktop: only a live session inside an open turn runs.
    assert.equal(state.workspaces[0].sessions[0].running, false)
  // The approval fixture is live inside an open turn with an unanswered ask.
    const pendingRow = state.workspaces[0].sessions.find(session => session.id === 'session-pending')
    assert.equal(pendingRow.pending, 'approval')
    assert.equal(pendingRow.running, true)
    // `demo/web` is a sibling of `demo`, not a child; an empty workspace is still listed.
    assert.equal(state.workspaces[1].path, '/home/dylan/Projects/demo/web')
    assert.deepEqual(state.workspaces[2].sessions, [])
    // Sessions the registry does not account for stay ungrouped, like the desktop;
    // a blank session (no prompt ever) is hidden the way the desktop hides it.
    assert.deepEqual(
      state.loose.map(session => session.id),
      ['session-loose', 'session-image'],
    )
  })
})

describe('Pairing', () => {
  it('mints a token that expires', () => {
    const pairing = new Pairing({ ttlMs: 20, cookieDays: 1, maxDevices: 2 })
    const token = pairing.rotate()
    assert.equal(pairing.accepts(token), true)
    assert.equal(pairing.accepts(`${token}x`), false)
    return new Promise(resolve => {
      setTimeout(() => {
        assert.equal(pairing.accepts(token), false)
        assert.equal(pairing.rotate() === token, false)
        resolve()
      }, 40)
    })
  })

  it('round-trips a signed device cookie and refuses forged ones', () => {
    const pairing = new Pairing({ ttlMs: 1000, cookieDays: 1, maxDevices: 2 })
    const device = pairing.issue({ headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari' } })
    const cookie = pairing.cookieValue(device)
    const request = { headers: { cookie: `dsh_pair=${encodeURIComponent(cookie)}` } }
    assert.equal(pairing.deviceFrom(request)?.id, device.id)

    const parts = cookie.split('.')
    const tampered = `${parts[0]}.${Number(parts[1]) + 1000}.${parts[2]}`
    assert.equal(pairing.deviceFrom({ headers: { cookie: `dsh_pair=${tampered}` } }), undefined)
    assert.equal(pairing.deviceFrom({ headers: { cookie: 'dsh_pair=garbage' } }), undefined)

    pairing.revoke(device.id)
    assert.equal(pairing.deviceFrom(request), undefined)
  })

  it('evicts the oldest device at the cap', () => {
    const pairing = new Pairing({ ttlMs: 1000, cookieDays: 1, maxDevices: 2 })
    const first = pairing.issue({ headers: {} })
    pairing.issue({ headers: {} })
    pairing.issue({ headers: {} })
    assert.equal(pairing.list().length, 2)
    assert.equal(pairing.list().some(device => device.id === first.id), false)
  })

  it('labels common phone user agents', () => {
    assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Safari/604.1'), 'iPhone · Safari')
    assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 Chrome/131 Mobile'), 'Android · Chrome')
  })
})

describe('renderQrSvg', () => {
  it('renders a self-contained SVG with a quiet zone', () => {
    const svg = renderQrSvg('http://192.168.1.10:8321/m/?t=abc')
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    assert.match(svg, /<path d="M/)
    assert.match(svg, /fill="#ffffff"/)
  })
})

describe('HTTP surface', () => {
  /** @type {Awaited<ReturnType<typeof startHarness>>} */
  let harness

  before(async () => {
    harness = await startHarness({ appDir: APP_DIR })
  })

  after(async () => {
    await harness.close()
  })

  /** Read the pairing document. */
  const readPairing = async () => {
    const response = await fetch(`${harness.base}/dsh-pair/pair.json`)
    assert.equal(response.status, 200)
    return response.json()
  }

  it('serves the app shell and assets', async () => {
    const page = await fetch(`${harness.base}/m/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/)
    assert.match(await page.text(), /DeepSeek Harness/)
    const script = await fetch(`${harness.base}/m/app.js`)
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type') ?? '', /javascript/)
  })

  it('redirects /m to /m/ and keeps the token query', async () => {
    const response = await fetch(`${harness.base}/m?t=abc`, { redirect: 'manual' })
    assert.equal(response.status, 308)
    assert.equal(response.headers.get('location'), '/m/?t=abc')
  })

  it('refuses pairing documents when the desktop connection rejects', async () => {
    const denied = await startHarness({ appDir: APP_DIR, services: createServices({ admit: false }) })
    try {
      const response = await fetch(`${denied.base}/dsh-pair/pair.json`)
      assert.equal(response.status, 401)
    } finally {
      await denied.close()
    }
  })

  it('names the LAN address to bind when the listener is loopback-only', async () => {
    // A plain `dsh web` binds 127.0.0.1, so this is the state a fresh install
    // starts in: the Desktop page has to hand over the exact command.
    const loopback = await startHarness({ appDir: APP_DIR, host: '127.0.0.1' })
    try {
      const document = await (await fetch(`${loopback.base}/dsh-pair/pair.json`)).json()
      assert.equal(document.loopback, true)
      assert.match(document.bindCommand, /^dsh web --host /)
      assert.equal(document.bindCommand.includes('127.0.0.1'), false)
      assert.ok(Array.isArray(document.lanAddresses))
    } finally {
      await loopback.close()
    }
    // A reachable listener needs no instruction at all.
    assert.equal((await readPairing()).bindCommand, '')
  })

  it('publishes a pairing URL that carries the live token', async () => {
    const document = await readPairing()
    assert.match(document.url, /^http:\/\/192\.168\.1\.10:\d+\/m\/\?t=/)
    assert.match(document.svg, /^<svg/)
    assert.equal(document.appReady, true)
    assert.ok(document.expiresAt > Date.now())
  })

  it('rejects a stale token and accepts the live one', async () => {
    const document = await readPairing()
    const stale = await fetch(`${harness.base}/m/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'nope' }),
    })
    assert.equal(stale.status, 403)

    const response = await fetch(`${harness.base}/m/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: document.token }),
    })
    assert.equal(response.status, 200)
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
    assert.match(cookie, /^dsh_pair=/)

    const state = await fetch(`${harness.base}/m/api/state`, { headers: { cookie } })
    assert.equal(state.status, 200)
    const payload = await state.json()
    assert.equal(payload.workspaces[0].title, 'Demo')
    assert.equal(payload.device.label, 'Browser · 浏览器')
  })

  it('keeps the bridge closed without a device cookie', async () => {
    const response = await fetch(`${harness.base}/m/api/state`)
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error, 'unpaired')
  })

  it('returns a transcript and appends only new items after a cursor', async () => {
    const cookie = await pair()
    const first = await fetch(`${harness.base}/m/api/session/session-alpha`, { headers: { cookie } })
    assert.equal(first.status, 200)
    const payload = await first.json()
    assert.equal(payload.title, '看一下仓库结构')
    assert.deepEqual(
      payload.items.map(item => item.kind),
      ['user', 'assistant', 'tool'],
    )

    const tail = await fetch(`${harness.base}/m/api/session/session-alpha?after=${payload.lastSeq}`, { headers: { cookie } })
    assert.deepEqual((await tail.json()).items, [])
  })

  it('reports models, presets, usage and skills for one session', async () => {
    const cookie = await pair()
    const meta = await (await fetch(`${harness.base}/m/api/session/session-alpha/meta`, { headers: { cookie } })).json()
    assert.equal(meta.models.length, 2)
    assert.equal(meta.permissions[0].value, 'read-only')
    // The catalog reports a bare id; the plugin localizes built-ins.
    assert.equal(meta.permissions[0].name, '只读')
    assert.equal(meta.permissions[2].name, '自动批准')
    assert.equal(meta.permission, 'workspace-write')
    assert.equal(meta.context.total, 28_140)
    assert.deepEqual(meta.skills.map(skill => skill.name), ['bundled', 'herdr'])
  })

  it('reports the model the next request will use, so the picker can mark it', async () => {
    const cookie = await pair()
    const meta = await (await fetch(`${harness.base}/m/api/session/session-alpha/meta`, { headers: { cookie } })).json()
    // `pending` outranks `lastUsed`: the sheet marks what the session will use
    // next, exactly like the desktop selector.
    assert.deepEqual(meta.model, { provider: 'deepseek', model: 'r1', reasoningEffort: 'high' })
    const marked = meta.models.filter(model => model.provider === meta.model.provider && model.id === meta.model.model)
    assert.equal(marked.length, 1)
    assert.equal(marked[0].name, 'DeepSeek R1')
  })

  it('reports the thinking strengths of the current route', async () => {
    const cookie = await pair()
    const meta = await (await fetch(`${harness.base}/m/api/session/session-alpha/meta`, { headers: { cookie } })).json()
    // Efforts come from `resolveModelInfo`, never from the catalog listing.
    assert.deepEqual(meta.reasoning.efforts.map(effort => effort.id), ['low', 'high', 'max'])
    // Every row that can think carries the badge flag, resolved per route.
    assert.deepEqual(meta.models.map(model => model.thinking), [true, true])
    assert.equal(meta.models[0].images, false)
    assert.equal(meta.reasoning.efforts[1].name, 'High')
    assert.equal(meta.reasoning.default, 'high')
    // The selection carries the effort the next request will use.
    assert.equal(meta.model.reasoningEffort, 'high')
  })

  it('switches thinking strength without changing the model', async () => {
    const cookie = await pair()
    const response = await fetch(`${harness.base}/m/api/session/session-alpha/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'deepseek', model: 'r1', reasoningEffort: 'max' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(harness.services.calls.models.at(-1), { sessionId: 'session-alpha', provider: 'deepseek', model: 'r1', reasoningEffort: 'max' })
  })

  it('reports context the way the desktop composer meter does', async () => {
    const cookie = await pair()
    const meta = await (await fetch(`${harness.base}/m/api/session/session-alpha/meta`, { headers: { cookie } })).json()
    // Occupancy follows the desktop: projectedTokens first, then pressureTokens.
    assert.equal(meta.context.used, 41_000)
    assert.equal(meta.context.window, 128_000)
    assert.equal(meta.context.percent, 32)
    assert.deepEqual(meta.context.breakdown, { system: 4_000, tools: 9_000, messages: 26_000 })
  })

  it('switches the model through the session controller', async () => {
    const cookie = await pair()
    const response = await fetch(`${harness.base}/m/api/session/session-alpha/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ provider: 'deepseek', model: 'r1' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(harness.services.calls.models.at(-1), { sessionId: 'session-alpha', provider: 'deepseek', model: 'r1' })
  })

  it('lists the slash catalog next to the skills', async () => {
    const cookie = await pair()
    const meta = await (await fetch(`${harness.base}/m/api/session/session-alpha/meta`, { headers: { cookie } })).json()
    assert.deepEqual(meta.commands.map(command => command.name), ['compact', 'goal'])
    assert.equal(meta.commands[1].hint, '目标描述')
    // Skills stay separate: they are prompt tokens, not registry entries.
    assert.deepEqual(meta.skills.map(skill => skill.name), ['bundled', 'herdr'])
  })

  it('runs a registered slash command host-side', async () => {
    const cookie = await pair()
    const response = await fetch(`${harness.base}/m/api/session/session-alpha/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ line: '/compact' }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ran, 'command')
    assert.equal(payload.text, '已压缩')
    assert.deepEqual(harness.services.calls.commands.at(-1), '/compact')
    assert.equal(harness.services.calls.prompts.length, 0)
  })

  it('sends an unknown slash line as a prompt so a skill can run', async () => {
    const cookie = await pair()
    const response = await fetch(`${harness.base}/m/api/session/session-alpha/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ line: '/herdr' }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    // The skill tool expands `/name` from the prompt text during pre-step; the
    // bridge must not try to run it as a command.
    assert.equal(payload.ran, 'prompt')
    assert.deepEqual(harness.services.calls.prompts.at(-1).content, [{ type: 'text', text: '/herdr' }])
  })

  it('serves a workspace image referenced by assistant markdown', async () => {
    const cookie = await pair()
    const original = harness.services.sessionQuery.readSession
    harness.services.sessionQuery.readSession = async id => {
      const snapshot = await original(id)
      return id === 'session-alpha'
        ? { ...snapshot, session: { ...snapshot.session, cwd: CHECKOUT_PARENT } }
        : snapshot
    }
    try {
      const image = await fetch(`${harness.base}/m/api/session/session-alpha/file?path=${encodeURIComponent(PLUGIN_RELATIVE_IMAGE)}`, { headers: { cookie } })
      assert.equal(image.status, 200)
      assert.equal(image.headers.get('content-type'), 'image/png')

      const escape = await fetch(`${harness.base}/m/api/session/session-alpha/file?path=${encodeURIComponent('../../etc/passwd')}`, { headers: { cookie } })
      assert.equal(escape.status, 403)
    } finally {
      harness.services.sessionQuery.readSession = original
    }
  })

  it('carries image parts in a prompt', async () => {
    const cookie = await pair()
    const response = await fetch(`${harness.base}/m/api/session/session-alpha/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        text: '看这张图',
        images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
      }),
    })
    assert.equal(response.status, 200)
    const prompt = harness.services.calls.prompts.at(-1)
    assert.equal(prompt.content[0].type, 'text')
    assert.equal(prompt.content[1].type, 'image')
    assert.equal(prompt.content[1].mediaType, 'image/png')
  })

  it('rejects an image part with an unsupported type', async () => {
    const cookie = await pair()
    const response = await fetch(`${harness.base}/m/api/session/session-alpha/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: '', images: [{ mediaType: 'image/svg+xml', data: 'AAA' }] }),
    })
    assert.equal(response.status, 400)
  })

  it('exposes message images and serves their bytes', async () => {
    const cookie = await pair()
    const transcript = await (await fetch(`${harness.base}/m/api/session/session-image`, { headers: { cookie } })).json()
    const user = transcript.items.find(item => item.kind === 'user')
    const id = user.images?.[0]?.id
    assert.ok(String(id).startsWith('sha256:'))

    // Ids contain a colon and are shell/path-hostile: the route must keep them whole.
    const encoded = String(id).split('/').map(segment => encodeURIComponent(segment)).join('/')
    const image = await fetch(`${harness.base}/m/api/session/session-image/image/${encoded}`, { headers: { cookie } })
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.ok((await image.arrayBuffer()).byteLength > 50)
  })

  it('delivers a prompt through the session controller', async () => {
    const cookie = await pair()
    const response = await fetch(`${harness.base}/m/api/session/session-alpha/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: '继续' }),
    })
    assert.equal(response.status, 200)
    const request = harness.services.calls.prompts.at(-1)
    assert.equal(request.sessionId, 'session-alpha')
    assert.deepEqual(request.content, [{ type: 'text', text: '继续' }])
    assert.equal(typeof request.requestId, 'string')
  })

  it('rejects an empty prompt without touching the controller', async () => {
    const cookie = await pair()
    const before = harness.services.calls.prompts.length
    const response = await fetch(`${harness.base}/m/api/session/session-alpha/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: '   ' }),
    })
    assert.equal(response.status, 400)
    assert.equal(harness.services.calls.prompts.length, before)
  })

  it('streams live assistant deltas over SSE', async () => {
    const cookie = await pair()
    const frames = []
    const closed = new Promise(resolve => {
      const request = http.get(
        `${harness.base}/m/api/session/session-alpha/stream`,
        { headers: { cookie, accept: 'text/event-stream' } },
        response => {
          assert.match(response.headers['content-type'] ?? '', /text\/event-stream/)
          response.setEncoding('utf8')
          let buffer = ''
          response.on('data', chunk => {
            buffer += chunk
            let split
            while ((split = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, split)
              buffer = buffer.slice(split + 2)
              const event = /^event: (.+)$/mu.exec(block)?.[1]
              const data = /^data: (.+)$/mu.exec(block)?.[1]
              if (event !== undefined && data !== undefined) frames.push({ event, data: JSON.parse(data) })
              if (frames.length >= 4) {
                request.destroy()
                resolve()
              }
            }
          })
        },
      )
      request.on('error', () => resolve())
    })

    // Give the response a beat to register, then drive one attempt.
    await new Promise(resolve => setTimeout(resolve, 120))
    harness.emit('agent/assistant-stream', { agent: { id: 'session-alpha' }, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
    harness.emit('agent/assistant-stream', { agent: { id: 'session-alpha' }, frame: { type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '你好' } } })
    harness.emit('agent/assistant-stream', { agent: { id: 'session-alpha' }, frame: { type: 'chunk', attemptId: 'a1', revision: 3, index: 1, time: 2, chunk: { type: 'tool-call-delta', index: 0, id: 'call-live', name: 'bash', argumentsDelta: '{"command":"ls"}' } } })
    harness.emit('agent/assistant-stream', { agent: { id: 'session-alpha' }, frame: { type: 'end', attemptId: 'a1', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } } })
    await closed

    assert.deepEqual(
      frames.map(frame => frame.event),
      ['start', 'text', 'tool', 'end'],
    )
    assert.equal(frames[1].data.text, '你好')
    assert.equal(frames[2].data.name, 'bash')
    assert.equal(frames[3].data.outcome.kind, 'committed')
  })

  it('folds live text into the polling transcript', async () => {
    const cookie = await pair()
    harness.emit('agent/assistant-stream', { agent: { id: 'session-beta' }, frame: { type: 'start', attemptId: 'b1', revision: 1, turn: 1, step: 1 } })
    harness.emit('agent/assistant-stream', { agent: { id: 'session-beta' }, frame: { type: 'chunk', attemptId: 'b1', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: '先读一下' } } })
    const response = await fetch(`${harness.base}/m/api/session/session-beta?after=0`, { headers: { cookie } })
    const payload = await response.json()
    assert.equal(payload.live.text, '先读一下')
  })

  it('pushes pending interactions to every connected app', async () => {
    const cookie = await pair()
    const frames = []
    const request = http.get(`${harness.base}/m/api/events`, { headers: { cookie } }, response => {
      response.setEncoding('utf8')
      let buffer = ''
      response.on('data', chunk => {
        buffer += chunk
        let split
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const event = /^event: (.+)$/mu.exec(block)?.[1]
          const data = /^data: (.+)$/mu.exec(block)?.[1]
          if (event === 'pending' && data !== undefined) frames.push(JSON.parse(data))
        }
      })
    })
    request.on('error', () => {})
    // The phone only receives requests for the session it is watching.
    const watcher = http.get(`${harness.base}/m/api/session/session-alpha/stream`, { headers: { cookie } })
    watcher.on('response', response => response.resume())
    watcher.on('error', () => {})
    await new Promise(resolve => setTimeout(resolve, 150))

    const decision = harness.emitWaterfall(
      'approval/request',
      { agent: { session: { id: 'session-alpha' } }, toolName: 'bash', id: 'ap-push' },
      () => 'unavailable',
    )
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(frames.at(-1)?.pending?.some(entry => entry.id === 'ap-push'), true)

    await fetch(`${harness.base}/m/api/session/session-alpha/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ id: 'ap-push', decision: 'deny' }),
    })
    assert.equal(await decision, 'rejected')
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.deepEqual(frames.at(-1)?.pending, [])
    request.destroy()
    watcher.destroy()
  })

  it('lets the phone approve a pending tool request', async () => {
    const cookie = await pair()
    // A watcher must exist for the phone to be offered the decision.
    const watcher = http.get(`${harness.base}/m/api/session/session-alpha/stream`, { headers: { cookie } })
    watcher.on('response', response => response.resume())
    watcher.on('error', () => {})
    await new Promise(resolve => setTimeout(resolve, 120))

    const outcome = harness.emitWaterfall(
      'approval/request',
      { agent: { session: { id: 'session-alpha' } }, toolName: 'bash', reason: 'rm -rf build', id: 'ap-9' },
      () => 'unavailable',
    )
    await new Promise(resolve => setTimeout(resolve, 120))

    const transcript = await (await fetch(`${harness.base}/m/api/session/session-alpha`, { headers: { cookie } })).json()
    const approval = transcript.pending?.find(entry => entry.id === 'ap-9')
    assert.equal(approval?.kind, 'approval')
    assert.equal(approval?.toolName, 'bash')

    const response = await fetch(`${harness.base}/m/api/session/session-alpha/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ id: 'ap-9', decision: 'allow' }),
    })
    assert.equal(response.status, 200)
    assert.equal(await outcome, 'allowed-once')
    watcher.destroy()
  })

  it('withdraws the phone card when the desktop decides first', async () => {
    const cookie = await pair()
    const frames = []
    const events = http.get(`${harness.base}/m/api/events`, { headers: { cookie } }, response => {
      response.setEncoding('utf8')
      let buffer = ''
      response.on('data', chunk => {
        buffer += chunk
        let split
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const event = /^event: (.+)$/mu.exec(block)?.[1]
          const data = /^data: (.+)$/mu.exec(block)?.[1]
          if (event === 'pending' && data !== undefined) frames.push(JSON.parse(data))
        }
      })
    })
    events.on('error', () => {})
    const watcher = http.get(`${harness.base}/m/api/session/session-alpha/stream`, { headers: { cookie } })
    watcher.on('response', response => response.resume())
    watcher.on('error', () => {})
    await new Promise(resolve => setTimeout(resolve, 150))

    // The Host logs `approval/asked` before running any answerer, so the
    // desktop dialog and the phone card necessarily exist together.
    harness.ask({ id: 'ap-desktop', toolName: 'bash', reason: 'rm -rf build' })
    const outcome = harness.emitWaterfall(
      'approval/request',
      { agent: { session: { id: 'session-alpha' } }, toolName: 'bash', reason: 'rm -rf build', id: 'ap-desktop' },
      () => 'rejected',
    )
    const offered = () => frames.some(frame => frame.pending?.some(entry => entry.id === 'ap-desktop'))
    const withdrawn = () => frames.length > 0 && frames.at(-1).pending.every(entry => entry.id !== 'ap-desktop')
    await waitFor(offered)
    assert.equal(offered(), true)

    // The desktop answers: the bridge must surrender the card even though its
    // own waterfall never saw the decision.
    harness.decide({ id: 'ap-desktop', outcome: 'rejected' })
    await waitFor(withdrawn)
    assert.equal(withdrawn(), true)
    const after = await (await fetch(`${harness.base}/m/api/session/session-alpha`, { headers: { cookie } })).json()
    assert.equal(after.pending?.some(entry => entry.id === 'ap-desktop') ?? false, false)

    // The desktop chain is released and decides on its own.
    assert.equal(await outcome, 'rejected')

    // A late tap finds nothing to approve instead of a card that lingers.
    const response = await fetch(`${harness.base}/m/api/session/session-alpha/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ id: 'ap-desktop', decision: 'allow' }),
    })
    assert.equal(response.status, 404)
    events.destroy()
    watcher.destroy()
  })

  it('keeps every pushed card answerable until the phone or desktop settles it', async () => {
    // A dedicated Host with `debug` on: every `pending` push is a card the
    // phone can render, so the log is the exact record of what got offered.
    const debugHarness = await startHarness({ appDir: APP_DIR, config: { debug: true } })
    const document = await (await fetch(`${debugHarness.base}/dsh-pair/pair.json`)).json()
    const paired = await fetch(`${debugHarness.base}/m/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: document.token }),
    })
    const cookie = (paired.headers.get('set-cookie') ?? '').split(';')[0]
    const logs = []
    const originalLog = console.log
    mock.method(console, 'log', (...args) => {
      logs.push(args.join(' '))
    })
    const watcher = http.get(`${debugHarness.base}/m/api/session/session-alpha/stream`, { headers: { cookie } })
    watcher.on('response', response => response.resume())
    watcher.on('error', () => {})
    // The phone's own push stream, so the Host writes the card where the app
    // would have read it.
    const events = http.get(`${debugHarness.base}/m/api/events`, { headers: { cookie } })
    events.on('response', response => response.resume())
    events.on('error', () => {})
    await new Promise(resolve => setTimeout(resolve, 150))

    try {
      let releaseDesktop
      const desktopDecision = new Promise(resolve => {
        releaseDesktop = resolve
      })
      // The Host logs `approval/asked` first, then both answerers see it.
      debugHarness.ask({ id: 'ap-race', toolName: 'bash' })
      const outcome = debugHarness.emitWaterfall(
        'approval/request',
        { agent: { session: { id: 'session-alpha' } }, toolName: 'bash', id: 'ap-race' },
        () => desktopDecision,
      )
      await new Promise(resolve => setTimeout(resolve, 120))
      const shown = await (await fetch(`${debugHarness.base}/m/api/session/session-alpha`, { headers: { cookie } })).json()
      assert.equal(shown.pending?.some(entry => entry.id === 'ap-race'), true)

      // The desktop decides. From here the phone must never be pushed a card
      // that its POST can no longer settle.
      releaseDesktop('rejected')
      assert.equal(await outcome, 'rejected')
      await new Promise(resolve => setTimeout(resolve, 120))
      const pushes = logs.filter(line => line.startsWith('dsh-pair: push pending='))
      const withdrawnAt = pushes.findIndex(line => !line.includes('ap-race'))
      assert.notEqual(withdrawnAt, -1)
      assert.equal(pushes.slice(withdrawnAt).some(line => line.includes('ap-race')), false)
      const late = await fetch(`${debugHarness.base}/m/api/session/session-alpha/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ id: 'ap-race', decision: 'allow' }),
      })
      assert.equal(late.status, 404)
    } finally {
      mock.restoreAll()
      originalLog(`dsh-pair test: captured ${String(logs.length)} log line(s)`)
      events.destroy()
      watcher.destroy()
      await debugHarness.close()
    }
  })

  it('answers a blocking question that carries no wait id', async () => {
    const cookie = await pair()
    const watcher = http.get(`${harness.base}/m/api/session/session-alpha/stream`, { headers: { cookie } })
    watcher.on('response', response => response.resume())
    watcher.on('error', () => {})
    await new Promise(resolve => setTimeout(resolve, 120))

    const outcome = harness.emitWaterfall(
      'user-questions/request',
      { agent: { session: { id: 'session-alpha' } }, questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }] }] },
      () => Promise.reject(new Error('NO_PROVIDER')),
    )
    await new Promise(resolve => setTimeout(resolve, 120))
    const transcript = await (await fetch(`${harness.base}/m/api/session/session-alpha`, { headers: { cookie } })).json()
    const entry = transcript.pending?.find(item => item.kind === 'question')
    assert.equal(typeof entry?.id, 'string')
    assert.equal(entry.questions[0].question, '继续吗？')

    await fetch(`${harness.base}/m/api/session/session-alpha/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ id: entry.id, answers: [{ id: 'q1', selected: ['继续'] }] }),
    })
    assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: ['继续'] }] })
    watcher.destroy()
  })

  it('keeps the desktop dialog away while the phone is watching', async () => {
    const cookie = await pair()
    const harness2 = await startHarness({ appDir: APP_DIR, config: { phoneOnlyMs: 60_000 } })
    try {
      const doc = await (await fetch(`${harness2.base}/dsh-pair/pair.json`)).json()
      const paired = await fetch(`${harness2.base}/m/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: doc.token }),
      })
      const phone = (paired.headers.get('set-cookie') ?? '').split(';')[0]
      const watcher = http.get(`${harness2.base}/m/api/session/session-alpha/stream`, { headers: { cookie: phone } })
      watcher.on('response', response => response.resume())
      watcher.on('error', () => {})
      await new Promise(resolve => setTimeout(resolve, 120))

      let desktopStarted = false
      const outcome = harness2.emitWaterfall(
        'approval/request',
        { agent: { session: { id: 'session-alpha' } }, toolName: 'bash', id: 'ap-priority' },
        () => {
          desktopStarted = true
          return 'rejected'
        },
      )
      await new Promise(resolve => setTimeout(resolve, 120))
      await fetch(`${harness2.base}/m/api/session/session-alpha/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: phone },
        body: JSON.stringify({ id: 'ap-priority', decision: 'allow' }),
      })
      const decision = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('held'), 500))])
      assert.equal(decision, 'allowed-once')
      assert.equal(desktopStarted, false)
      watcher.destroy()
    } finally {
      await harness2.close()
    }
  })

  it('falls back to the desktop answerer when nobody picks up', async () => {
    const cookie = await pair()
    const watcher = http.get(`${harness.base}/m/api/session/session-alpha/stream`, { headers: { cookie } })
    watcher.on('response', response => response.resume())
    watcher.on('error', () => {})
    await new Promise(resolve => setTimeout(resolve, 120))

    const outcome = harness.emitWaterfall(
      'approval/request',
      { agent: { session: { id: 'session-alpha' } }, toolName: 'bash', id: 'ap-10' },
      () => 'rejected',
    )
    const decision = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('held'), 500))])
    watcher.destroy()
    assert.equal(decision, 'rejected')
  })

  it('revokes a device from the desktop endpoint', async () => {
    const cookie = await pair()
    const deviceId = decodeURIComponent(cookie.split('=')[1]).split('.')[0]
    const response = await fetch(`${harness.base}/dsh-pair/revoke.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).revoked, true)
    const state = await fetch(`${harness.base}/m/api/state`, { headers: { cookie } })
    assert.equal(state.status, 401)
  })

  /**
   * Poll until a condition holds; the bridge's push is scheduled, not reentrant.
   * @param {() => boolean} condition
   */
  async function waitFor(condition) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (condition()) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  /** Pair a fresh device and return its cookie header. */
  async function pair() {
    const document = await readPairing()
    const response = await fetch(`${harness.base}/m/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: document.token }),
    })
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
    assert.equal(response.status, 200, `pair failed: ${String(response.status)} ${await response.clone().text()}`)
    assert.match(cookie, /^dsh_pair=/)
    return cookie
  }
})
