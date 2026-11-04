/**
 * Screenshot probe for the phone app.
 *
 * Serves `app/` with stub `/m/api` responses so the real app.js renders in a
 * headless browser without a Host. `?open=model|context|settings` makes the
 * probe click the matching entry after the session view is mounted.
 *
 * Not part of the shipped plugin: this exists so a UI change can be inspected
 * as pixels instead of inferred from source.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = resolve(fileURLToPath(new URL('../../app', import.meta.url)))

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

/** The thinking strength the probe currently reports, so a switch round-trips. */
let currentEffort = 'high'

const META = {
  models: [
    { provider: 'magpie', id: 'deepseek/deepseek-flash', name: 'DeepSeek-V4.1-Flash · DeepSeek', description: '', images: true, thinking: true },
    { provider: 'magpie', id: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash · OpenCode Go', description: '', images: true, thinking: true },
    { provider: 'magpie-responses', id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol · Codex', description: '', images: true, thinking: true },
    { provider: 'magpie-responses', id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra · Codex', description: '', images: true, thinking: true },
    { provider: 'magpie-responses', id: 'gpt-6-astra', name: 'GPT-6-Astra · Codex', description: '', images: true, thinking: true },
    { provider: 'magpie-responses', id: 'gpt-6-luna', name: 'GPT-6-Luna · Codex', description: '', images: true, thinking: true },
    { provider: 'magpie-responses', id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol · Codex', description: '', images: true, thinking: true },
  ],
  model: { provider: 'magpie', model: 'opencode-go/deepseek-v4.1-flash', reasoningEffort: 'high' },
  reasoning: {
    efforts: [
      { id: 'low', name: 'Low', description: '' },
      { id: 'high', name: 'High', description: '' },
      { id: 'max', name: 'Max', description: '' },
    ],
    default: 'high',
  },
  supportsImages: true,
  permission: 'workspace-write',
  permissions: [
    { value: 'read-only', name: 'read-only', description: '' },
    { value: 'workspace-write', name: 'workspace-write', description: '' },
    { value: 'danger-full-access', name: 'danger-full-access', description: '' },
  ],
  context: {
    total: 172_400,
    surface: 158_900,
    used: 169_000,
    window: 1_000_000,
    percent: 17,
    breakdown: { system: 6_400, tools: 21_300, messages: 141_300 },
  },
  skills: [
    { name: 'herdr', description: '终端复用' },
    { name: 'mobile-design-system', description: '移动端 UI 规范' },
    { name: 'onetake', description: '产品动效短片' },
    { name: 'setup-pstack', description: '配置 pstack 模型' },
    { name: 'deep-research', description: '多源检索与核验' },
    { name: 'office-docs', description: '生成 Office 文档' },
  ],
  commands: [
    { name: 'compact', description: '压缩当前会话的上下文' },
    { name: 'goal', description: '设置或查看目标', hint: '目标描述' },
    { name: 'export', description: '导出会话记录' },
    { name: 'plan', description: '进入计划模式' },
  ],
}

const STATE = {
  workspaces: [
    {
      id: 'ws-demo',
      title: 'dsh-pair',
      path: '/home/dylan/Projects/idea/dsh_creator/plugins/dsh-pair',
      sessions: [
        { id: 'session-alpha', title: '看一下仓库结构', cwd: '/home/dylan/Projects/idea/dsh_creator/plugins/dsh-pair', updatedAt: Date.now(), live: null, running: false, pending: null, pinned: true },
        { id: 'session-tool', title: '跑一下测试', cwd: '/home/dylan/Projects/idea/dsh_creator/plugins/dsh-pair', updatedAt: Date.now() - 3_600_000, live: null, running: false, pending: null },
        { id: 'session-question', title: '要不要一起改文档', cwd: '/home/dylan/Projects/idea/dsh_creator/plugins/dsh-pair', updatedAt: Date.now() - 7_200_000, live: null, running: false, pending: { kind: 'question' } },
        { id: 'session-approve', title: '清理临时文件', cwd: '/home/dylan/Projects/idea/dsh_creator/plugins/dsh-pair', updatedAt: Date.now() - 9_000_000, live: null, running: false, pending: { kind: 'approval' } },
      ],
    },
  ],
  loose: [],
  pending: [],
  groupedBy: 'workspace',
  device: { id: 'probe', label: 'Probe' },
}

const TRANSCRIPTS = {
  'session-alpha': {
    id: 'session-alpha',
    title: '看一下仓库结构',
    cwd: '/home/dylan/Projects/idea/dsh_creator/plugins/dsh-pair',
    running: false,
    lastSeq: 2,
    firstSeq: 1,
    items: [
      { key: 'u1', kind: 'user', seq: 1, time: Date.now() - 60_000, text: '看一下仓库结构' },
      { key: 'a1', kind: 'assistant', seq: 2, time: Date.now() - 55_000, text: '先看目录结构，再读入口文件。' },
    ],
    pending: [],
    updatedAt: Date.now(),
  },
  'session-tool': {
    id: 'session-tool',
    title: '跑一下测试',
    cwd: '/home/dylan/Projects/idea/dsh_creator/plugins/dsh-pair',
    running: false,
    lastSeq: 5,
    firstSeq: 1,
    items: [
      { key: 'u1', kind: 'user', seq: 1, time: Date.now() - 120_000, text: '跑一下测试，挂了的告诉我原因' },
      { key: 'a0', kind: 'assistant', seq: 2, time: Date.now() - 118_000, text: '', reasoning: '先跑一遍，再按失败分组。' },
      {
        key: 't1',
        kind: 'tool',
        seq: 3,
        time: Date.now() - 110_000,
        name: 'bash',
        args: '{"command":"node --test"}',
        result: 'pass 50\nfail 0',
      },
      { key: 'a1', kind: 'assistant', seq: 4, time: Date.now() - 100_000, text: '**50 个用例通过**，没有失败。' },
    ],
    pending: [],
    updatedAt: Date.now(),
  },
  'session-approve': {
    id: 'session-approve',
    title: '清理临时文件',
    cwd: '/home/dylan/Projects/idea/dsh_creator/plugins/dsh-pair',
    running: false,
    lastSeq: 2,
    firstSeq: 1,
    items: [
      { key: 'u1', kind: 'user', seq: 1, time: Date.now() - 400_000, text: '把 test/probe/tmp 清掉' },
      { key: 'a1', kind: 'assistant', seq: 2, time: Date.now() - 395_000, text: '要删 6 个文件，先请你确认。' },
    ],
    pending: [
      {
        id: 'approve-1',
        kind: 'approval',
        toolName: 'bash',
        reason: 'rm -rf test/probe/tmp（不可撤销）',
      },
    ],
    updatedAt: Date.now(),
  },
  'session-question': {
    id: 'session-question',
    title: '要不要一起改文档',
    cwd: '/home/dylan/Projects/idea/dsh_creator/plugins/dsh-pair',
    running: false,
    lastSeq: 3,
    firstSeq: 1,
    items: [
      { key: 'u1', kind: 'user', seq: 1, time: Date.now() - 300_000, text: '顺手把文档也更新一下' },
      { key: 'a1', kind: 'assistant', seq: 2, time: Date.now() - 295_000, text: '先确认范围再动笔。' },
    ],
    pending: [
      {
        id: 'ask-1',
        kind: 'question',
        questions: [
          {
            id: 'q1',
            header: '文档范围',
            question: '这次改哪些文档？',
            options: [
              { label: '只改 README', description: '安装与截图' },
              { label: 'README 和 app 说明', description: '两处一起对齐' },
              { label: '先不改', description: '等结构定下来' },
            ],
          },
        ],
      },
      {
        id: 'approve-1',
        kind: 'approval',
        toolName: 'bash',
        reason: '要写入 docs/ 下的截图文件',
      },
    ],
    updatedAt: Date.now(),
  },
}

const PROBE = `
<script type="module">
  const open = new URLSearchParams(location.search).get('open')
  if (open) {
    const wait = async (test, ms = 8000) => {
      const started = Date.now()
      while (Date.now() - started < ms) {
        const value = test()
        if (value) return value
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return null
    }
    ;(async () => {
      // Enter the session first: the chips live on the session shell.
      location.hash = '#/s/session-alpha'
      const chip = await wait(() => open === 'model'
        ? document.querySelector('.ctx-chip:not(.ctx-chip--usage)')
        : open === 'context'
          ? document.querySelector('.ctx-chip--usage')
          : document.querySelector('.topbar .icon-btn[aria-label="会话设置"]'))
      if (chip) chip.click()
      await wait(() => document.querySelector('.sheet-host.open') ?? document.querySelector('.sheet'))
      document.body.dataset.probeReady = 'true'
    })()
  }
  window.__probeReady = () => document.body.dataset.probeReady === 'true'
</script>
`

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://local')
  const path = url.pathname

  if (path.startsWith('/m/api/')) {
    if (path === '/m/api/state') return json(response, STATE)
    if (/^\/m\/api\/session\/[^/]+\/meta$/u.test(path)) {
      return json(response, { ...META, model: { ...META.model, reasoningEffort: currentEffort } })
    }
    if (request.method === 'POST' && /^\/m\/api\/session\/[^/]+\/command$/u.test(path)) {
      const body = await readBody(request)
      const line = String(body?.line ?? '')
      const name = line.slice(1).split(/\s/u)[0]
      const known = ['compact', 'goal', 'export', 'plan'].includes(name)
      return json(response, known
        ? { ran: 'command', kind: 'success', text: `已执行 ${'/'}${name}` }
        : { ran: 'prompt', kind: 'success', text: '' })
    }
    if (request.method === 'POST' && /^\/m\/api\/session\/[^/]+\/model$/u.test(path)) {
      const body = await readBody(request)
      if (typeof body?.reasoningEffort === 'string') currentEffort = body.reasoningEffort
      return json(response, { selected: { provider: body?.provider, model: body?.model, reasoningEffort: currentEffort } })
    }
    const sessionMatch = /^\/m\/api\/session\/([^/]+)$/u.exec(path)
    if (sessionMatch !== null) {
      const id = decodeURIComponent(sessionMatch[1])
      const transcript = TRANSCRIPTS[id]
      if (transcript === undefined) return json(response, { error: 'not-found' }, 404)
      return json(response, transcript)
    }
    if (path.endsWith('/stream') || path === '/m/api/events') {
      // No EventSource: a held-open stream keeps the headless browser from ever
      // finishing a screenshot run, and the probe only inspects static layout.
      response.writeHead(204)
      response.end()
      return
    }
    return json(response, { ok: true })
  }

  const file = path === '/' || path === '' ? 'index.html' : path.replace(/^\//u, '')
  const resolved = join(APP, file)
  if (!resolved.startsWith(APP)) {
    response.writeHead(403)
    response.end('forbidden')
    return
  }
  try {
    let body = await readFile(resolved)
    if (file === 'index.html') {
      body = Buffer.from(String(body).replace('</body>', `${PROBE}</body>`))
    }
    response.writeHead(200, { 'content-type': TYPES[extname(resolved)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end('not found')
  }
})

/** Read a JSON request body for the stub endpoints. */
function readBody(request) {
  return new Promise(resolve => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      try { resolve(JSON.parse(raw)) } catch { resolve({}) }
    })
  })
}

function json(response, value) {
  const body = JSON.stringify(value)
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

const port = Number(process.env.PORT ?? 8931)
server.listen(port, '127.0.0.1', () => console.log(`probe ${String(port)}`))
