/**
 * Test harness: a minimal stand-in for the Host services the plugin uses.
 *
 * The plugin only needs five things from `ctx` — `webServer.register`,
 * `connection.admit`, `sessionQuery`, `sessionController`,
 * `workspaceController` — so the harness implements exactly those against a
 * real `node:http` server. That keeps these tests honest about routing,
 * cookies, and status codes without booting a full Harness profile.
 */
import http from 'node:http'
import { apply } from '../index.js'

/** A tiny fixture session whose events exercise every normalized item kind. */
export const SESSION_EVENTS = [
  { seq: 1, type: 'turn/start', time: 1_700_000_000_000, data: { turn: 1 } },
  {
    seq: 2,
    type: 'user/message',
    time: 1_700_000_001_000,
    data: { role: 'user', content: [{ type: 'text', text: '帮我看下这个仓库' }], source: { kind: 'user' } },
  },
  {
    seq: 3,
    type: 'assistant/message',
    time: 1_700_000_002_000,
    data: {
      message: {
        role: 'assistant',
        source: { provider: 'deepseek', model: 'flash' },
        content: [
          { type: 'reasoning', text: '先看结构。' },
          { type: 'text', text: '**结论**：结构清楚。\n\n```sh\nls -la\n```' },
          { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
        ],
      },
    },
  },
  {
    seq: 4,
    type: 'tool/result',
    time: 1_700_000_003_000,
    data: { message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'README.md\nsrc/' }] } },
  },
  {
    seq: 5,
    type: 'user/message',
    time: 1_700_000_004_000,
    data: { role: 'user', content: [{ type: 'text', text: '[注入] 上下文' }], source: { kind: 'agent' } },
  },
  { seq: 6, type: 'turn/end', time: 1_700_000_005_000, data: { turn: 1, reason: 'success' } },
]

/** Second session: still running, no end event. */
export const RUNNING_EVENTS = [
  { seq: 1, type: 'turn/start', time: 1_700_000_010_000, data: { turn: 1 } },
  {
    seq: 2,
    type: 'user/message',
    time: 1_700_000_011_000,
    data: { role: 'user', content: [{ type: 'text', text: '跑一下测试' }], source: { kind: 'user' } },
  },
]

/**
 * Build the fixture services.
 * @param {object} [options]
 * @param {boolean} [options.admit] - what `connection.admit` answers.
 * @returns {object} services plus call records.
 */
export function createServices({ admit = true } = {}) {
  const calls = {
    models: [],
    commands: [], prompts: [], cancels: [], skillLists: [] }
  const sessions = [
    {
      header: { id: 'session-alpha', createdAt: 1_700_000_000_000, cwd: '/home/dylan/Projects/demo', isSeeded: false },
      events: SESSION_EVENTS,
      title: '看一下仓库结构',
    },
    {
      header: { id: 'session-beta', createdAt: 1_700_000_100_000, cwd: '/home/dylan/Projects/demo', isSeeded: false },
      events: RUNNING_EVENTS,
      title: '跑测试',
    },
    {
      header: { id: 'session-loose', createdAt: 1_700_000_200_000, cwd: '/tmp/other', isSeeded: false },
      events: [
        {
          seq: 1,
          type: 'user/message',
          time: 1_700_000_201_000,
          data: { role: 'user', content: [{ type: 'text', text: '没有归属的会话' }], source: { kind: 'user' } },
        },
      ],
      title: '',
    },
    {
      header: { id: 'session-no-cwd', createdAt: 1_700_000_300_000, isSeeded: false },
      events: [],
      title: '',
    },
    {
      header: { id: 'session-pending', createdAt: 1_700_000_060_000, cwd: '/home/dylan/Projects/demo', isSeeded: false },
      events: [
        { seq: 1, type: 'turn/start', time: 1_700_000_060_000, data: { turn: 1 } },
        {
          seq: 2,
          type: 'user/message',
          time: 1_700_000_061_000,
          data: { role: 'user', content: [{ type: 'text', text: '删掉这个文件' }], source: { kind: 'user' } },
        },
        { seq: 3, type: 'approval/asked', time: 1_700_000_062_000, data: { id: 'ap-1', toolName: 'bash' } },
      ],
      title: '删掉这个文件',
    },
    {
      header: { id: 'session-image', createdAt: 1_700_000_070_000, cwd: '/home/dylan/Projects/demo', isSeeded: false },
      events: [
        { seq: 1, type: 'turn/start', time: 1_700_000_070_000, data: { turn: 1 } },
        {
          seq: 2,
          type: 'user/message',
          time: 1_700_000_071_000,
          data: {
            role: 'user',
            content: [
              { type: 'text', text: '看这张图' },
              {
                type: 'image',
                attachment: {
                  attachmentId: 'sha256:26371a00bf13e2df79767680d9a3a3643334471c84dd4f3801e4d8887d34218d',
                  mediaType: 'image/png',
                  bytes: 3,
                  width: 8,
                  height: 8,
                },
              },
            ],
            source: { kind: 'user' },
          },
        },
      ],
      title: '看这张图',
    },
    {
      header: { id: 'session-gamma', createdAt: 1_700_000_050_000, cwd: '/home/dylan/Projects/demo/web', isSeeded: false },
      events: [
        { seq: 1, type: 'turn/start', time: 1_700_000_050_000, data: { turn: 1 } },
        {
          seq: 2,
          type: 'user/message',
          time: 1_700_000_051_000,
          data: { role: 'user', content: [{ type: 'text', text: '前端部分' }], source: { kind: 'user' } },
        },
      ],
      title: '前端部分',
    },
  ]
  const services = {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v3', name: 'DeepSeek V3' }, { id: 'r1', name: 'DeepSeek R1' }],
      // Only `resolveModelInfo` reports reasoning metadata; the catalog listing
      // above deliberately does not, matching the real service.
      resolveModelInfo: async (provider, model) => ({
        provider,
        id: model,
        name: model === 'r1' ? 'DeepSeek R1' : 'DeepSeek V3',
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
            { id: 'max', name: 'Max' },
          ],
          defaultEffort: 'high',
        },
      }),
    },
    tokenMeter: {
      measure: () => ({ totalTokens: 28_140, surfaceTokens: 20_000, logRevision: 3 }),
    },
    /**
     * Session projections the Host would provide. `modelSelection` carries both
     * a picked (`pending`) and a used (`lastUsed`) model so tests can tell which
     * one the phone reports, and the context pair mirrors the desktop meter.
     */
    sessionProjections: {
      stateOf: (_session, key) => {
        if (key === 'modelSelection') {
          return {
            pending: { provider: 'deepseek', model: 'r1', reasoningEffort: 'high' },
            lastUsed: { provider: 'deepseek', model: 'v3' },
          }
        }
        // Raw projection states, exactly as `stateOf` returns them: the
        // breakdown is nested and `projectedTokens` does not exist here (it is
        // derived for the client wire view), so these fixtures fail loudly if
        // the plugin reads the wrong level.
        if (key === 'contextPressure') {
          return { contextWindow: 128_000, pressureTokens: 39_000, surfaceTokens: 4_000, sampledSurfaceTokens: 2_000 }
        }
        if (key === 'contextBreakdown') {
          return { systems: [], surfaceTokens: 39_000, breakdown: { systemTokens: 4_000, toolsTokens: 9_000, messageTokens: 26_000 } }
        }
        return undefined
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'v3' }),
    },
    /** The plugin reads the session's directory so project skill roots resolve. */
    workingDirectory: {
      get: session => session?.cwd ?? '/home/dylan/Projects/demo',
    },
    permissionPresets: {
      // A preset configured without a display name reports its own id, exactly
      // like the real catalog; the plugin supplies the localized label.
      catalog: () => ({
        options: [
          { value: 'read-only', name: 'read-only' },
          { value: 'workspace-write', name: 'workspace-write' },
          { value: 'auto', name: '自动批准' },
        ],
      }),
      current: () => 'workspace-write',
      set() {},
    },
    /**
     * The ROOT `skills` service. On a real Host this carries only the bundled
     * set: a session's own skills live in the registry its agent preset mounts,
     * so reading this one is exactly the "only official skills" symptom.
     */
    skills: {
      list: async options => {
        calls.skillLists.push({ source: 'root', ...(options ?? {}) })
        return [{ name: 'bundled', description: '内置技能', invocation: { userInvocable: true } }]
      },
    },
    /** The preset-scoped registry the desktop's own catalog resolves first. */
    presetSkills: {
      list: async options => {
        calls.skillLists.push({ source: 'preset', ...(options ?? {}) })
        return [
          { name: 'bundled', description: '内置技能', invocation: { userInvocable: true } },
          { name: 'herdr', description: '终端复用', invocation: { userInvocable: true, modelInvocable: true } },
          { name: 'hidden', description: '不可用', invocation: { userInvocable: false } },
        ]
      },
    },
    agentPresets: {
      serviceFor: (_agent, name) => (name === 'skills' ? services.presetSkills : undefined),
    },
    commands: {
      // A tiny registry: `/compact` is a real command, anything else is not —
      // which is how skills reach the prompt path instead of the command path.
      list: () => [
        { name: 'compact', description: '压缩上下文', input: undefined },
        { name: 'goal', description: '设置目标', input: { hint: '目标描述' } },
      ],
      find: (_agent, name) => (name === 'compact' || name === 'goal' ? { name } : undefined),
      execute: async (_agent, line) => {
        calls.commands.push(line)
        const name = line.slice(1).split(/\s/u)[0]
        if (name === 'compact') return { result: { kind: 'success', text: '已压缩' } }
        if (name === 'goal') return { result: { kind: 'success', text: '目标已设置' } }
        return undefined
      },
    },
    /** Minimal attachment provider: one in-memory PNG by id. */
    attachments: {
      async readImageRequest(ref) {
        if (typeof ref?.attachmentId !== 'string' || !ref.attachmentId.startsWith('sha256:')) throw new Error('missing attachment')
        return { data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAABH0lEQVR4nO3PkaKDAAAF0GAQBIMgCIJBMAiCQRAMgiAIgsEgCIJBMAgGQTAYBEEQBMEgCILBIAiCIAiCIBgEQRAE7xPeD9zzB4cgCGK325EkSVHUfr+naZphGJZlOY47HA48zx+PR0EQRFE8nU6SJMmyfD6fFUVRVVXTNF3XDcO4XC7X69U0TcuybNu+3W6O49zvd9d1H4+H53m+7z+fz9frFQRBGIZRFMVxnCRJmqbv9zvLsjzPi6L4fD7f77csy6qq6rpumqZt267r+r4fhmEcx9/vN03TPM/Lsqzrum0bgQACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAgj8F/gDmnuhWk7edLMAAAAASUVORK5CYII=', 'base64'), mediaType: 'image/png', width: ref.width, height: ref.height }
      },
    },
    calls,
    /** Optional service lookup the plugin performs for the workspace registry. */
    get(name) {
      if (name === 'workspaceRegistry') return services.workspaceRegistry
      if (name === 'attachments') return services.attachments
      if (name === 'sessions') return { get: id => ({ sessionId: String(id) }) }
      if (name === 'agents') return { get: () => ({ id: 'agent-1' }) }
      if (name === 'llm') return services.llm
      if (name === 'tokenMeter') return services.tokenMeter
      if (name === 'permissionPresets') return services.permissionPresets
      if (name === 'skills') return services.skills
      if (name === 'commands') return services.commands
      if (name === 'sessionProjections') return services.sessionProjections
      if (name === 'workingDirectory') return services.workingDirectory
      if (name === 'agentPresets') return services.agentPresets
      if (name === 'agentDefaultModel') return services.agentDefaultModel
      return undefined
    },
    sessionQuery: {
      async listSessions() {
        return sessions.map(session => ({ header: session.header, live: session.events.length > 0, persisted: true }))
      },
      async readTitleSnapshots(ids) {
        return ids.map(id => {
          const session = sessions.find(item => item.header.id === String(id))
          return session === undefined
            ? { sessionId: id, status: 'rejected' }
            : { sessionId: id, status: 'fulfilled', value: { title: { title: session.title } } }
        })
      },
      async readTitleSnapshot(id) {
        const session = sessions.find(item => item.header.id === String(id))
        return { sessionId: id, value: { title: { title: session?.title ?? '' } } }
      },
      async listEvents(id) {
        const session = sessions.find(item => item.header.id === String(id))
        if (session === undefined) return []
        return session.events.map(event => ({ sessionId: id, seq: event.seq, type: event.type, time: event.time }))
      },
      async readSession(id) {
        const session = sessions.find(item => item.header.id === String(id))
        if (session === undefined) throw new Error(`no session ${id}`)
        return { session: session.header, inheritedEventCount: 0, events: session.events }
      },
    },
    sessionController: {
      async prompt(request) {
        calls.prompts.push(request)
        return { accepted: true }
      },
      async selectModel(request) {
        calls.models.push(request)
        return { selected: { provider: request.provider, model: request.model } }
      },
      async cancel(request) {
        calls.cancels.push(request)
        return { accepted: true }
      },
    },
    workspaceController: {
      baseline() {
        return {
          items: [
            {
              workspaceId: 'ws-demo',
              title: 'Demo',
              path: '/home/dylan/Projects/demo',
              sessionIds: ['session-alpha', 'session-beta', 'session-pending'],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-02T00:00:00.000Z',
            },
            {
              workspaceId: 'ws-demo-web',
              title: 'Web',
              path: '/home/dylan/Projects/demo/web',
              sessionIds: ['session-gamma'],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-02T00:00:00.000Z',
            },
            {
              workspaceId: 'ws-empty',
              title: 'Empty',
              path: '/home/dylan/Projects/empty',
              sessionIds: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-02T00:00:00.000Z',
            },
          ],
          archivedSessionIds: [],
          pinnedSessionIds: ['session-alpha'],
        }
      },
    },
    connection: {
      admit() {
        return admit ? { peer: { id: 'owner' } } : { rejection: 401 }
      },
    },
  }
  return services
}

/**
 * Start a real HTTP server around the plugin.
 * @param {object} options
 * @param {string} options.appDir - directory holding the phone app.
 * @param {object} [options.services] - fixture services.
 * @param {object} [options.config] - extra plugin configuration.
 * @returns {Promise<{base:string, close:()=>Promise<void>, services:object, routes:object[], origin:()=>string}>}
 */
export async function startHarness({ appDir, services = createServices(), config = {}, host = '192.168.1.10' }) {
  const routes = []
  const origin = { value: '' }
  const eventListeners = []
  const ctx = {
    /**
     * Minimal Cordis event registration: `on` returns a disposer, and the
     * harness routes test-emitted agent events to every listener.
     */
    /**
     * Service lookup used by the plugin for optional sources. The harness only
     * exposes the workspace registry when the fixture provides one.
     */
    get(name) {
      if (name === 'workspaceRegistry') return services.workspaceRegistry
      if (name === 'attachments') return services.attachments
      if (name === 'sessions') return { get: id => ({ sessionId: String(id) }) }
      if (name === 'agents') return { get: () => ({ id: 'agent-1' }) }
      if (name === 'llm') return services.llm
      if (name === 'tokenMeter') return services.tokenMeter
      if (name === 'permissionPresets') return services.permissionPresets
      if (name === 'skills') return services.skills
      if (name === 'commands') return services.commands
      if (name === 'sessionProjections') return services.sessionProjections
      if (name === 'agentDefaultModel') return services.agentDefaultModel
      if (name === 'workingDirectory') return services.workingDirectory
      if (name === 'agentPresets') return services.agentPresets
      return undefined
    },
    on(name, listener, options) {
      const entry = { name, listener, options: options ?? {} }
      eventListeners.push(entry)
      return () => {
        const index = eventListeners.indexOf(entry)
        if (index >= 0) eventListeners.splice(index, 1)
      }
    },
    logger: { info() {}, warn() {} },
    effect(fn) {
      fn()
    },
    webServer: {
      host,
      port: 0,
      protocol: 'http:',
      getOrigin() {
        return origin.value
      },
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    sessionQuery: services.sessionQuery,
    sessionController: services.sessionController,
    workspaceController: services.workspaceController,
    connection: services.connection,
  }

  // Tests never touch the real device store, and `phoneOnlyMs` is left at its
  // production default: the ordering between the phone and the desktop answerer
  // is exactly what a bug here looks like.
  apply(ctx, { appDir, storePath: '', ...config })

  /** Dispatch one request through the plugin's route table. */
  const dispatch = (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://local').pathname
    const exact = routes.filter(route => route.kind === 'exact' && route.path === pathname)
    // Mirror the real router: a prefix route owns its own path and everything
    // below it, but the registered path never carries a trailing slash.
    const prefix = routes
      .filter(route => {
        if (route.kind !== 'prefix') return false
        return pathname === route.path || pathname.startsWith(`${route.path}/`)
      })
      .sort((left, right) => right.path.length - left.path.length)
    const route = exact[0] ?? prefix[0]
    if (route === undefined) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    route.handler(request, response)
  }

  // Pairing is rate-limited per client address (20/min). A test run pairs far
  // more often than a person would, so each attempt gets its own address
  // rather than tripping the real guard.
  let pairClients = 0
  const server = http.createServer((request, response) => {
    Object.defineProperty(request.socket, 'remoteAddress', { configurable: true, value: `127.0.0.${String((pairClients += 1) % 250)}` })
    dispatch(request, response)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  origin.value = `http://192.168.1.10:${port}`
  ctx.webServer.port = port

  return {
    base: `http://127.0.0.1:${port}`,
    origin: () => origin.value,
    services,
    routes,
    /**
     * Deliver one `approval/asked` the way the Host's approval service writes
     * it, so a client can observe a card the desktop is already showing.
     * @param {{ id: string, sessionId?: string, toolName?: string }} asked
     */
    ask(asked) {
      for (const entry of [...eventListeners]) {
        if (entry.name === 'session/event') entry.listener({ sessionId: asked.sessionId ?? 'session-alpha', event: { type: 'approval/asked', data: asked } })
      }
    },
    /**
     * Deliver the `approval/decided` partner of {@link ask}.
     * @param {{ id: string, sessionId?: string, outcome?: string }} decided
     */
    decide(decided) {
      for (const entry of [...eventListeners]) {
        if (entry.name === 'session/event') entry.listener({ sessionId: decided.sessionId ?? 'session-alpha', event: { type: 'approval/decided', data: { id: decided.id, outcome: decided.outcome ?? 'allowed-once' } } })
      }
    },
    /** Deliver one Host event to the plugin's listeners. */
    emit(name, payload) {
      for (const entry of [...eventListeners]) if (entry.name === name) entry.listener(payload)
    },
    /**
     * Run one waterfall: prepended listeners first, each may claim by returning
     * a value or delegate through `next()`; the terminal answers last.
     */
    emitWaterfall(name, payload, terminal) {
      const entries = eventListeners.filter(entry => entry.name === name)
      const ordered = [...entries.filter(entry => entry.options.prepend === true), ...entries.filter(entry => entry.options.prepend !== true)]
      const run = index => {
        if (index >= ordered.length) return Promise.resolve(terminal())
        return Promise.resolve(ordered[index].listener(payload, () => run(index + 1)))
      }
      return run(0)
    },
    close: () => new Promise(resolve => server.close(resolve)),
  }
}
