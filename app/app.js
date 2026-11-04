/**
 * DeepSeek Harness · phone app
 *
 * A dependency-free mobile surface for the `dsh-pair` Host plugin.
 * It is deliberately a separate project from the plugin: the plugin owns
 * pairing and the bridge, this app owns the screen. Nothing here knows about
 * DSH internals — the contract is the small JSON API documented in README.md.
 *
 * Flow: boot → pair (token in URL) → home (workspace/session tree) → session
 * (transcript + composer). One poller keeps the open session live; it appends
 * only items newer than the cursor the app already holds.
 */

const API = '/m/api'
/** Build marker, surfaced to the Host so a stale client is visible in the log. */
const BUILD = '2026-11-05-docs'
/** Stable identity of this page instance, so duplicated viewports are visible. */
const CLIENT = Math.random().toString(36).slice(2, 8)

const state = {
  device: null,
  workspaces: [],
  loose: [],
  view: 'home',
  session: null,
  sending: false,
  pending: null,
  error: '',
  lastStateAt: 0,
  groupedBy: 'workspace',
  diagnostics: null,
  pendingRequests: [],
  homeTimer: null,
  events: null,
  eventsState: 'off',
  sheet: null,
  modelQuery: '',
  startedAt: Date.now(),
  viewed: new Map(),
  // Session lists collapsed by id. Workspaces start expanded; the ungrouped
  // bucket starts collapsed because it is usually the long tail.
  collapsedGroups: new Set(['__loose']),
}

const app = document.getElementById('app')
let pollTimer = null

/** localStorage key for per-session "seen" timestamps. */
const VIEWED_KEY = 'dshPair.viewed'
/** localStorage key for the previous visit instant, the unread baseline. */
const VISIT_KEY = 'dshPair.lastVisit'

/**
 * Load the seen map; unread state is a client concern, like the desktop's
 * completion badge, so it lives with this browser.
 * @returns {Map<string, number>}
 */
function loadViewed() {
  try {
    const raw = localStorage.getItem(VIEWED_KEY)
    if (raw === null) return new Map()
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return new Map()
    return new Map(Object.entries(parsed).filter(([, value]) => typeof value === 'number'))
  } catch {
    return new Map()
  }
}

/**
 * Remember that the user looked at a session, and persist it.
 * @param {string} id
 * @param {number} at - the session's activity instant that was seen.
 */
function markViewed(id, at) {
  const previous = state.viewed.get(id) ?? 0
  if (at <= previous) return
  state.viewed.set(id, at)
  try {
    localStorage.setItem(VIEWED_KEY, JSON.stringify(Object.fromEntries(state.viewed)))
  } catch {
    // Private mode or quota: unread state simply stops persisting.
  }
}

/** ---------------------------------------------------------------- helpers */

/**
 * Create an element.
 * @param {string} tag
 * @param {object} [props] - `class`, `text`, `html`, `dataset`, `on*` and plain attributes.
 * @param {(Node|string|null|undefined)[]} [children]
 * @returns {HTMLElement}
 */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'html') node.innerHTML = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'value') node.value = value
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

/**
 * Escape text for safe interpolation into HTML.
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/**
 * Render inline Markdown as HTML from already-escaped text.
 * @param {string} text
 * @returns {string}
 */
function inlineMarkdown(text) {
  let out = text
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
  out = out.replace(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img class="md-image" src="$2" alt="$1" loading="lazy">')
  // Workspace-relative images are served by the bridge for this session.
  if (state.session !== null) {
    const base = `${API}/session/${encodeURIComponent(state.session.id)}/file?path=`
    out = out.replace(/!\[([^\]\n]*)\]\((?!https?:)([^)\s]+)\)/g, (_match, alt, path) => `<img class="md-image" src="${base}${encodeURIComponent(path)}" alt="${alt}" loading="lazy">`)
  }
  out = out.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>')
  return out
}

/**
 * Render a small, safe Markdown subset as a fragment.
 * @param {string} source
 * @returns {DocumentFragment}
 */
function renderMarkdown(source) {
  const fragment = document.createDocumentFragment()
  const blocks = String(source ?? '').replace(/\r\n?/g, '\n').split(/```/)
  for (let index = 0; index < blocks.length; index += 1) {
    const chunk = blocks[index]
    if (index % 2 === 1) {
      const firstBreak = chunk.indexOf('\n')
      const language = firstBreak < 0 ? chunk.trim() : chunk.slice(0, firstBreak).trim()
      const body = firstBreak < 0 ? '' : chunk.slice(firstBreak + 1).replace(/\n$/, '')
      fragment.append(h('pre', { dataset: language ? { language } : {} }, h('code', { text: body })))
      continue
    }
    appendMarkdownBlocks(fragment, chunk)
  }
  return fragment
}

/**
 * Append paragraph-level blocks for one non-code chunk.
 * @param {DocumentFragment} fragment
 * @param {string} chunk
 */
function appendMarkdownBlocks(fragment, chunk) {
  const lines = chunk.split('\n')
  let paragraph = []
  let list = null
  let quote = null

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    fragment.append(h('p', { html: inlineMarkdown(escapeHtml(paragraph.join('\n'))).replace(/\n/g, '<br>') }))
    paragraph = []
  }
  const flushList = () => {
    if (list !== null) fragment.append(list)
    list = null
  }
  const flushQuote = () => {
    if (quote !== null) fragment.append(quote)
    quote = null
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, '')
    if (line.trim() === '') {
      flushAll()
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      flushAll()
      fragment.append(h(`h${heading[1].length}`, { html: inlineMarkdown(escapeHtml(heading[2])) }))
      continue
    }
    if (/^(-{3,}|\*{3,})$/u.test(line.trim())) {
      flushAll()
      fragment.append(h('hr'))
      continue
    }
    const quoted = /^>\s?(.*)$/u.exec(line)
    if (quoted !== null) {
      flushParagraph()
      flushList()
      if (quote === null) quote = h('blockquote')
      quote.append(h('p', { html: inlineMarkdown(escapeHtml(quoted[1])) }))
      continue
    }
    flushQuote()
    const bullet = /^[-*+]\s+(.*)$/u.exec(line)
    const ordered = /^\d+[.)]\s+(.*)$/u.exec(line)
    if (bullet !== null || ordered !== null) {
      flushParagraph()
      const tag = bullet !== null ? 'ul' : 'ol'
      if (list === null || list.tagName.toLowerCase() !== tag) {
        flushList()
        list = h(tag)
      }
      list.append(h('li', { html: inlineMarkdown(escapeHtml((bullet ?? ordered)[1])) }))
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushAll()
}

/**
 * Call one bridge endpoint, mapping auth loss to the pairing screen.
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (response.status === 401) {
    const error = new Error('unpaired')
    error.code = 'unpaired'
    throw error
  }
  if (!response.ok) {
    const error = new Error(payload.message ?? `${response.status} ${response.statusText}`)
    error.code = payload.error ?? 'http'
    throw error
  }
  return payload
}

/**
 * Relative timestamp for rows.
 * @param {number} value - epoch milliseconds.
 * @returns {string}
 */
function relativeTime(value) {
  const delta = Date.now() - Number(value ?? 0)
  if (!Number.isFinite(delta) || delta < 0) return ''
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return `${Math.floor(days / 30)} 个月前`
}

/**
 * Short relative time, matching the desktop sidebar's style ("9 分钟").
 * @param {number} value - epoch milliseconds.
 * @returns {string}
 */
function compactTime(value) {
  const delta = Date.now() - Number(value ?? 0)
  if (!Number.isFinite(delta) || delta < 0) return ''
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天`
  return `${Math.floor(days / 30)} 个月`
}

/**
 * Basename of a path.
 * @param {string} value
 * @returns {string}
 */
function basename(value) {
  const parts = String(value ?? '').split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/** --------------------------------------------------------------- chrome */

/**
 * Replace the app contents.
 * @param {'boot'|'pair'|'home'|'session'|'error'} view
 * @param {Node} node
 */
function setView(view, node) {
  state.view = view
  app.dataset.view = view
  app.replaceChildren(node)
}

/** Render the boot state. */
function renderBoot(message = '正在连接…') {
  setView('boot', h('div', { class: 'boot' }, h('div', { class: 'boot-mark', 'aria-hidden': 'true' }), h('p', { class: 'boot-text', text: message })))
}

/**
 * Render the unpaired screen.
 * @param {string} [message]
 */
function renderPair(message) {
  setView(
    'pair',
    h(
      'div',
      { class: 'boot' },
      h('div', { class: 'boot-mark', 'aria-hidden': 'true' }),
      h('p', { class: 'boot-text', text: message ?? '这台手机还没有配对。' }),
      h('p', { class: 'boot-text', text: '在电脑上打开 DeepSeek Harness →「手机连接」，用相机重新扫码。' }),
    ),
  )
}

/**
 * Inline SVG icons.
 * @param {'back'|'send'|'refresh'|'chevron'} name
 * @returns {SVGElement}
 */
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '22')
  svg.setAttribute('height', '22')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const paths = {
    back: ['M15 18l-6-6 6-6'],
    chevron: ['M9 18l6-6-6-6'],
    refresh: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
    send: ['M12 19V5', 'M5 12l7-7 7 7'],
    image: ['M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z', 'M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 17', 'M9 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0'],
    folder: ['M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h7A1.5 1.5 0 0 1 19 9.7V17a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17z'],
    more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
    search: ['M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14z', 'M20 20l-4.2-4.2'],
    // Four-point spark: the shape chat apps use for "which model".
    model: ['M12 4l1.9 5.1L19 11l-5.1 1.9L12 18l-1.9-5.1L5 11l5.1-1.9z', 'M18 17.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z'],
  }[name]
  for (const d of paths ?? []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/**
 * Selection check for a list row.
 *
 * Drawn as an inline SVG rather than the `✓` character: the glyph comes from
 * whatever font the phone has, so its weight and vertical position differ per
 * device (and it can read as clipped against a highlighted row's edge). A path
 * renders identically everywhere and inherits the accent colour.
 *
 * @param {boolean} active
 * @returns {HTMLElement}
 */
function sheetCheck(active) {
  const slot = h('span', { class: 'sheet-check', 'aria-hidden': 'true' })
  if (!active) return slot
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5')
  svg.append(path)
  slot.append(svg)
  return slot
}

/**
 * Build a top bar.
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.subtitle]
 * @param {boolean} [options.back]
 * @param {Node[]} [options.actions]
 * @returns {HTMLElement}
 */
function topbar({ title, subtitle, back = false, actions = [] }) {
  return h(
    'header',
    { class: 'topbar' },
    back
      ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': '返回', onclick: () => { location.hash = '#/' } }, icon('back'))
      : null,
    h('div', { class: 'topbar-titles' }, h('div', { class: 'topbar-title', text: title }), subtitle ? h('div', { class: 'topbar-sub', text: subtitle }) : null),
    ...actions,
  )
}

/** Add the hairline under the topbar once the screen scrolls. */
function wireTopbarScroll() {
  const screen = app.querySelector('.screen')
  const bar = app.querySelector('.topbar')
  if (screen === null || bar === null || screen.dataset.wired === '1') return
  screen.dataset.wired = '1'
  const update = () => {
    bar.dataset.scrolled = screen.scrollTop > 2 ? 'true' : 'false'
  }
  screen.addEventListener('scroll', update, { passive: true })
  update()
}

/** --------------------------------------------------------------- home */

function renderHome() {
  const total = state.workspaces.reduce((sum, workspace) => sum + workspace.sessions.length, 0) + state.loose.length
  const container = h('div', { class: 'home' })

  if (state.pendingRequests.length > 0) {
    const first = state.pendingRequests[0]
    container.append(
      h(
        'button',
        {
          class: 'pending-banner',
          type: 'button',
          onclick: () => openSession(first.sessionId),
        },
        h('span', { class: 'pending-banner-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'pending-banner-text', text: `${first.title || '会话'} · ${first.kind === 'approval' ? '需要批准' : '需要回答'}` }),
        h('span', { class: 'pending-banner-count', text: String(state.pendingRequests.length) }),
      ),
    )
  }

  if (state.groupedBy === 'cwd') {
    const count = state.diagnostics?.sessions
    container.append(
      h('div', { class: 'home-note', text: `未读到工作区成员关系，先按目录分组${typeof count === 'number' ? `（${count} 个会话）` : ''}` }),
    )
  }

  // Flat list in Host order, exactly like the desktop sidebar: a workspace whose
  // path contains another is still a sibling, not a parent.
  const toggle = id => {
    if (state.collapsedGroups.has(id)) state.collapsedGroups.delete(id)
    else state.collapsedGroups.add(id)
    renderHome()
  }

  for (const workspace of state.workspaces) {
    const collapsed = state.collapsedGroups.has(workspace.id)
    container.append(workspaceRow(workspace, collapsed, () => toggle(workspace.id)))
    if (!collapsed) for (const session of workspace.sessions) container.append(sessionRow(session))
  }

  if (state.loose.length > 0) {
    const loose = { id: '__loose', title: '未分组', path: '', sessions: state.loose }
    const collapsed = state.collapsedGroups.has('__loose')
    container.append(workspaceRow(loose, collapsed, () => toggle('__loose')))
    if (!collapsed) for (const session of state.loose) container.append(sessionRow(session))
  }

  if (total === 0) {
    container.append(
      h('div', { class: 'empty' }, h('strong', { text: '还没有会话' }), h('span', { text: '在电脑上开始一段对话，它会出现在这里。' })),
    )
  }

  startHomePolling()
  setView(
    'home',
    h(
      'div',
      { class: 'screen' },
      topbar({
        title: '工作区',
        subtitle: `${state.device ? state.device.label : '已连接'} · ${state.eventsState === 'live' ? '实时' : '轮询'}`,
        actions: [
          h(
            'button',
            {
              class: 'icon-btn',
              type: 'button',
              'aria-label': '刷新',
              onclick: async () => {
                try {
                  await loadState({ force: true })
                  renderHome()
                } catch (error) {
                  if (error.code === 'unpaired') renderPair()
                }
              },
            },
            icon('refresh'),
          ),
        ],
      }),
      container,
    ),
  )
  wireTopbarScroll()
}

/**
 * One workspace row: folder glyph, title, and a collapse toggle for its
 * sessions. Workspaces with nothing to show render as a plain row.
 * @param {object} node
 * @param {boolean} collapsed
 * @param {() => void} onToggle
 * @returns {HTMLElement}
 */
function workspaceRow(node, collapsed, onToggle) {
  const count = node.sessions?.length ?? 0
  const canToggle = count > 0
  const children = [
    h('span', { class: 'workspace-icon' }, icon('folder')),
    h('span', { class: 'workspace-name', text: node.title || '工作区' }),
    collapsed && canToggle ? h('span', { class: 'workspace-count', text: String(count) }) : null,
    canToggle
      ? h('span', { class: 'workspace-caret', dataset: { collapsed: String(collapsed) } }, icon('chevron'))
      : null,
  ]
  if (!canToggle) return h('div', { class: 'workspace-row' }, ...children)
  return h(
    'button',
    {
      class: 'workspace-row',
      type: 'button',
      'aria-expanded': String(!collapsed),
      'aria-label': `${node.title || '工作区'} · ${count} 个会话`,
      onclick: onToggle,
    },
    ...children,
  )
}

/**
 * One session row, indented under its workspace, time flushed right.
 * @param {object} session
 * @returns {HTMLElement}
 */
function sessionRow(session) {
  // Precedence mirrors the desktop: a pending interaction outranks "running",
  // because a turn blocked on the user is what needs attention.
  const status =
    session.pending !== null && session.pending !== undefined
      ? 'pending'
      : session.running
        ? 'running'
        : session.updatedAt > Math.max(state.startedAt, state.viewed.get(session.id) ?? 0)
          ? 'done'
          : null
  const label = status === 'running' ? '进行中' : status === 'pending' ? '等待批准或回答' : '已完成'
  return h(
    'button',
    { class: 'session-row', type: 'button', onclick: () => openSession(session.id) },
    h(
      'span',
      { class: 'session-status-slot' },
      status === null ? null : h('span', { class: 'session-status', dataset: { state: status }, role: 'img', 'aria-label': label }),
    ),
    h('span', { class: 'session-title', text: session.title || '未命名会话' }),
    session.pinned ? h('span', { class: 'session-pin', text: '置顶' }) : null,
    h('span', { class: 'session-time', text: compactTime(session.updatedAt ?? session.createdAt) }),
  )
}

/** --------------------------------------------------------------- session */

/**
 * Open one session and paint it.
 * @param {string} id
 */
async function openSession(id) {
  closeStream(state.session)
  renderBoot('正在打开会话…')
  state.session = {
    id,
    title: '',
    cwd: '',
    workspaceTitle: '',
    items: [],
    map: new Map(),
    running: false,
    lastSeq: 0,
    revision: 0,
    scrolledToBottom: true,
    pinned: true,
    draft: '',
    live: { active: false, text: '', reasoning: '', tools: new Map(), attemptId: null },
    pending: [],
    pendingSlot: null,
    meta: null,
    metaAt: 0,
    contextBtn: null,
    modelBtn: null,
    subtitleNode: null,
    images: [],
    liveEl: null,
    stream: null,
    shell: null,
    chat: null,
    screen: null,
    titleNode: null,
  }
  try {
    state.pending = null
    const data = await api(`/session/${encodeURIComponent(id)}`)
    applyTranscript(data, true)
    markViewed(id, Number(data.updatedAt ?? Date.now()))
    if (location.hash !== `#/s/${encodeURIComponent(id)}`) history.replaceState(null, '', `#/s/${encodeURIComponent(id)}`)
    renderSession()
    startPolling()
    openStream(state.session)
  } catch (error) {
    if (error.code === 'unpaired') return renderPair()
    toast(error.message)
    renderHome()
  }
}

/**
 * Merge transcript items by stable key.
 * @param {object[]} items
 * @param {boolean} reset
 */
function mergeItems(items, reset) {
  const session = state.session
  if (session === null) return
  if (reset) session.map = new Map()
  for (const item of items) {
    const previous = session.map.get(item.key)
    if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(item)) session.revision += 1
    session.map.set(item.key, item)
  }
  session.items = [...session.map.values()].sort((left, right) => (left.seq === right.seq ? String(left.key).localeCompare(String(right.key)) : left.seq - right.seq))
}

/**
 * Apply one transcript payload.
 * @param {object} data
 * @param {boolean} reset
 */
function applyTranscript(data, reset) {
  const session = state.session
  if (session === null) return false
  const beforeRevision = session.revision
  const beforeRunning = session.running
  const beforePending = session.pending.map(entry => entry.id).join('|')
  if (data.title) session.title = data.title
  if (data.cwd) session.cwd = data.cwd
  session.running = data.running === true
  session.lastSeq = Math.max(session.lastSeq, Number(data.lastSeq ?? 0))
  session.pending = Array.isArray(data.pending) ? data.pending : []
  // The log now carries the user's own row: drop the local echo so the message
  // (and its pictures) is not drawn twice while the turn is still running.
  if ((state.pending !== null || (state.pendingImages ?? []).length > 0) && (data.items ?? []).some(item => item.kind === 'user')) {
    state.pending = null
    state.pendingImages = []
  }
  const pendingChanged = session.pending.map(entry => entry.id).join('|') !== beforePending
  markViewed(session.id, Number(data.updatedAt ?? 0))
  mergeItems(Array.isArray(data.items) ? data.items : [], reset)
  let settled = false
  if (state.pending !== null && session.items.some(item => item.kind === 'user' && item.text === state.pending)) {
    state.pending = null
    settled = true
  }
  return settled || pendingChanged || session.revision !== beforeRevision || session.running !== beforeRunning
}

/** Build the session shell once: topbar, scrolling screen, composer. */
function renderSession() {
  const session = state.session
  if (session === null) return
  if (session.shell === null) {
    const screen = h('div', { class: 'screen' })
    const chat = h('div', { class: 'chat' })
    screen.append(chat)
    // Three compact controls in the top-right, the way a chat app carries its
    // session verbs: the model picker, the context meter, and the settings
    // sheet. They replaced a full-width row of oversized chips.
    session.modelBtn = h(
      'button',
      { class: 'icon-btn icon-btn--sm', type: 'button', 'aria-label': '选择模型', onclick: () => openModelPicker(session) },
      icon('model'),
    )
    session.contextBtn = h(
      'button',
      { class: 'icon-btn icon-btn--sm', type: 'button', 'aria-label': '上下文用量', onclick: () => openContext(session) },
      ring(0, { size: 22, stroke: 3, className: 'ctx-ring ctx-ring--mini' }),
    )
    const header = topbar({
      title: session.title || '会话',
      subtitle: basename(session.cwd),
      back: true,
      actions: [
        h('div', { class: 'topbar-actions' }, session.modelBtn, session.contextBtn, h(
          'button',
          { class: 'icon-btn icon-btn--sm', type: 'button', 'aria-label': '会话设置', onclick: () => openSettings(session) },
          icon('more'),
        )),
      ],
    })
    session.titleNode = header.querySelector('.topbar-title')
    session.subtitleNode = header.querySelector('.topbar-sub')
    session.chat = chat
    session.screen = screen
    session.pendingSlot = h('div', { class: 'pending-slot' })
    session.shell = h('div', { class: 'shell' }, header, screen, session.pendingSlot, buildComposer(session))
    // `screen` is the scrolling box; `chat` only defines the content height.
    screen.addEventListener(
      'scroll',
      () => {
        // Our own "pin to bottom" scroll also fires this event. If layout grew in
        // the same frame, the naive distance check reads as "user scrolled up"
        // and every later paint stops following the conversation.
        if (session.pinned !== false) {
          session.scrolledToBottom = true
          return
        }
        session.scrolledToBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 80
        session.pinned = session.scrolledToBottom
      },
      { passive: true },
    )
    // Leaving the bottom on purpose clears the pin; coming back restores it.
    for (const event of ['touchstart', 'wheel', 'keydown']) screen.addEventListener(event, () => { session.pinned = null }, { passive: true })
  }
  if (session.titleNode !== null && session.title !== '') session.titleNode.textContent = session.title
  paintHeaderControls(session)
  if (session.meta === null || Date.now() - session.metaAt > 30_000) void loadMeta(session)
  setView('session', session.shell)
  wireTopbarScroll()
  paintTranscript()
}

/** Paint the transcript into the existing chat container. */
function paintTranscript() {
  const session = state.session
  if (session === null || session.chat === null) return
  const chat = session.chat
  const fragment = document.createDocumentFragment()
  const items = session.items

  for (const item of items) {
    if (item.kind === 'user') {
      // Pictures first, then the words: a screenshot is what you are showing,
      // and the caption reads as belonging to it.
      const bundle = h('div', { class: 'user-bundle' })
      const shots = item.images ?? []
      if (shots.length > 1) {
        bundle.append(h('div', { class: 'image-grid', dataset: { count: String(shots.length) } }, ...shots.map(image => thumbnail(imageSrc(item.sessionId ?? state.session.id, image.id)))))
      } else {
        for (const image of shots) bundle.append(thumbnail(imageSrc(item.sessionId ?? state.session.id, image.id)))
      }
      if (item.text) bundle.append(h('div', { class: 'user-caption', text: item.text }))
      fragment.append(h('div', { class: 'turn turn--user' }, bundle))
      continue
    }
    if (item.kind === 'assistant') {
      const body = h('div', { class: 'prose' })
      if (item.reasoning) body.append(renderReasoning(item.reasoning))
      body.append(renderMarkdown(item.text))
      for (const image of item.images ?? []) {
        const src = imageSrc(state.session.id, image.id)
        body.append(thumbnail(src))
      }
      fragment.append(h('div', { class: 'turn turn--assistant' }, h('div', { class: 'author' }, h('span', { class: 'author-mark' }), h('span', { text: 'Harness' })), body))
      continue
    }
    if (item.kind === 'tool') fragment.append(renderTool(item, session.running))
  }

  if (state.pending !== null || (state.pendingImages ?? []).length > 0) {
    const bundle = h('div', { class: 'user-bundle' })
    for (const src of state.pendingImages ?? []) bundle.append(thumbnail(src))
    if (state.pending) bundle.append(h('div', { class: 'user-caption', text: state.pending }))
    fragment.append(h('div', { class: 'turn turn--user' }, bundle))
  }
  if (session.live.active) fragment.append(ensureLiveNode(session).node)
  else if (session.running) {
    fragment.append(h('div', { class: 'turn' }, h('span', { class: 'thinking' }, h('span', { text: '正在处理' }), h('i'), h('i'), h('i'))))
  }
  if (items.length === 0 && !session.running && state.pending === null) {
    fragment.append(h('div', { class: 'empty' }, h('strong', { text: '还没有消息' }), h('span', { text: '在下面输入，继续这段对话。' })))
  }

  chat.replaceChildren(fragment)
  paintPending(session)
  // Markdown images come from the sanitized HTML string, so they are wired after
  // insertion (an inline onclick would be stripped by the escaping).
  for (const picture of chat.querySelectorAll('img.bubble-image,img.md-image')) {
    if (picture.complete) continue
    picture.addEventListener(
      'load',
      () => {
        if (session.scrolledToBottom === true) pinToBottom(session)
      },
      { once: true },
    )
  }
  pinToBottom(session)
}

/**
 * Collapsible reasoning block, collapsed by default like a tool row.
 * @param {string} text
 * @returns {HTMLElement}
 */
function renderReasoning(text) {
  const body = h('div', { class: 'reasoning', hidden: true, text })
  const toggle = h(
    'button',
    { class: 'reason-toggle', type: 'button', 'aria-expanded': 'false' },
    h('span', { class: 'reason-chevron' }, icon('chevron')),
    h('span', { text: '思考过程' }),
  )
  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden
    toggle.dataset.open = body.hidden ? 'false' : 'true'
    toggle.setAttribute('aria-expanded', body.hidden ? 'false' : 'true')
  })
  return h('div', { class: 'reason-block' }, toggle, body)
}

/**
 * Build (once) the node that shows the in-flight assistant text.
 * @param {object} session
 * @returns {{node: HTMLElement, prose: HTMLElement, reasoning: HTMLElement, tools: HTMLElement}}
 */
function ensureLiveNode(session) {
  if (session.liveEl !== null) return session.liveEl
  const prose = h('div', { class: 'prose prose--live' })
  const reasoning = h('div', { class: 'reasoning', hidden: true })
  const tools = h('div', { class: 'live-tools' })
  const node = h(
    'div',
    { class: 'turn turn--assistant live' },
    h('div', { class: 'author' }, h('span', { class: 'author-mark' }), h('span', { text: 'Harness' }), h('span', { class: 'author-live', text: '生成中' })),
    reasoning,
    prose,
    tools,
  )
  session.liveEl = { node, prose, reasoning, tools }
  return session.liveEl
}

/**
 * Repaint only the live node, so token deltas never rebuild the transcript.
 * @param {object} session
 */
function updateLiveNode(session) {
  const live = session.live
  if (!live.active) return
  const parts = ensureLiveNode(session)
  parts.reasoning.hidden = live.reasoning === '' || live.text !== ''
  parts.reasoning.textContent = live.reasoning
  const text = live.text === '' && live.reasoning !== '' ? '' : live.text
  parts.prose.textContent = text
  parts.tools.replaceChildren(
    ...[...live.tools.values()]
      .filter(tool => tool.name !== '' || tool.args !== '')
      .map(tool =>
        h(
          'div',
          { class: 'tool' },
          h('div', { class: 'tool-head' }, h('span', { class: 'tool-name', text: tool.name || 'tool' }), h('span', { class: 'tool-status', dataset: { state: 'running' }, text: '运行中' })),
        ),
      ),
  )
  pinToBottom(session)
}

/**
 * Open the SSE stream that carries in-flight assistant text.
 * @param {object} session
 */
function openStream(session) {
  closeStream(session)
  if (typeof EventSource !== 'function') return
  const source = new EventSource(`/m/api/session/${encodeURIComponent(session.id)}/stream`)
  session.stream = source
  const start = payload => {
    session.live = { active: true, text: payload?.text ?? '', reasoning: payload?.reasoning ?? '', tools: new Map(), attemptId: payload?.attemptId ?? null }
    for (const tool of payload?.tools ?? []) session.live.tools.set(tool.callId, { ...tool })
    paintTranscript()
  }
  source.addEventListener('snapshot', event => {
    try {
      start(JSON.parse(event.data))
    } catch {
      // Ignore a malformed frame; polling remains authoritative.
    }
  })
  source.addEventListener('start', event => {
    try {
      start(JSON.parse(event.data))
    } catch {
      start()
    }
  })
  source.addEventListener('text', event => {
    try {
      session.live.active = true
      session.live.text += JSON.parse(event.data).text ?? ''
      updateLiveNode(session)
    } catch {
      // Ignore malformed frames.
    }
  })
  source.addEventListener('reasoning', event => {
    try {
      session.live.active = true
      session.live.reasoning += JSON.parse(event.data).text ?? ''
      updateLiveNode(session)
    } catch {
      // Ignore malformed frames.
    }
  })
  source.addEventListener('tool', event => {
    try {
      const data = JSON.parse(event.data)
      const tool = session.live.tools.get(data.callId) ?? { callId: data.callId, name: '', args: '' }
      if (data.name) tool.name = data.name
      tool.args += data.args ?? ''
      session.live.tools.set(data.callId, tool)
      session.live.active = true
      updateLiveNode(session)
    } catch {
      // Ignore malformed frames.
    }
  })
  source.addEventListener('end', () => {
    session.live = { active: false, text: '', reasoning: '', tools: new Map(), attemptId: null }
    session.liveEl = null
    paintTranscript()
    refreshTranscript({ force: true })
  })
  // A dead stream is not fatal: the 1.5s polling loop still converges.
  source.onerror = () => {}
}

/**
 * Close the SSE stream of the open session, if any.
 * @param {object|null} session
 */
function closeStream(session) {
  if (session?.stream == null) return
  try {
    session.stream.close()
  } catch {
    // Already closed.
  }
  session.stream = null
}

/**
 * Render the cards that let the phone answer the agent: approvals and
 * `ask_user_question` batches.
 * @param {object} session
 */
function paintPending(session) {
  const slot = session.pendingSlot
  if (slot === null) return
  slot.replaceChildren(...session.pending.filter(entry => entry !== undefined).map(entry => pendingCard(session, entry)))
}

/**
 * One interaction card, mirroring the desktop question composer: a raised
 * panel with a header block, option rows (number chip for single-select,
 * checkbox for multi), inline descriptions, and a footer action row.
 * @param {object} session
 * @param {object} entry
 * @returns {HTMLElement}
 */
function pendingCard(session, entry) {
  const card = (...children) => h('div', { class: 'ask-card' }, ...children)

  if (entry.kind === 'approval') {
    // The desktop answerer may settle this request at any moment, so a tap is
    // often one poll behind: it can lose the race, or be pressed twice.
    // Disable the card immediately and drop it whether or not the POST lands.
    let sending = false
    const send = async decision => {
      if (sending) return
      sending = true
      const buttons = el.querySelectorAll('button')
      for (const button of buttons) button.disabled = true
      try {
        await api(`/session/${encodeURIComponent(session.id)}/approval`, {
          method: 'POST',
          body: JSON.stringify({ id: entry.id, decision }),
        })
      } catch {
        // A 404 means another device decided first, which is the outcome the
        // user wanted anyway; the refresh below removes the stale card.
      }
      await refreshTranscript({ force: true })
    }
    return card(
      h(
        'div',
        { class: 'ask-header' },
        h(
          'div',
          { class: 'ask-heading' },
          h('div', { class: 'ask-eyebrow' }, '需要批准'),
          h('div', { class: 'ask-title ask-tool' }, entry.toolName ?? 'tool'),
          entry.reason ? h('div', { class: 'ask-detail' }, entry.reason) : null,
        ),
      ),
      h(
        'div',
        { class: 'ask-footer' },
        h('button', { class: 'ask-btn', type: 'button', onclick: () => send('deny') }, '拒绝'),
        h('button', { class: 'ask-btn ask-btn--primary', type: 'button', onclick: () => send('allow') }, '允许一次'),
      ),
    )
  }

  if (entry.kind === 'question') {
    const answers = new Map(entry.questions.map(question => [question.id, { selected: [], custom: '' }]))
    const answered = question => {
      const value = answers.get(question.id)
      return value.selected.length > 0 || value.custom !== ''
    }
    let index = 0

    const heading = h('div', { class: 'ask-heading' })
    const optionHost = h('div', { class: 'ask-options' })
    const pager = h('div', { class: 'ask-pager' })
    const back = h('button', { class: 'ask-btn', type: 'button' }, '上一步')
    const forward = h('button', { class: 'ask-btn ask-btn--primary', type: 'button' })

    const sync = () => {
      const question = entry.questions[index]
      const value = answers.get(question.id)
      forward.disabled = !answered(question)
      forward.textContent = index === entry.questions.length - 1 ? '提交' : '下一步'
      back.hidden = index === 0
      pager.textContent = entry.questions.length > 1 ? `${index + 1} / ${entry.questions.length}` : ''
      pager.hidden = entry.questions.length < 2
      if (customInput !== null) customInput.value = value.custom
    }

    let customInput = null

    const build = question => {
      // `replaceChildren` stringifies null into a literal "null" text node;
      // a question without an optional header used to print one.
      heading.replaceChildren(
        ...[
          question.header ? h('div', { class: 'ask-eyebrow', text: question.header }) : null,
          h('div', { class: 'ask-title', text: question.question }),
          question.detail ? h('div', { class: 'ask-detail', text: question.detail }) : null,
        ].filter(child => child !== null),
      )

      const rows = (question.options ?? []).map((option, position) => {
        const row = h(
          'button',
          { class: 'ask-option', type: 'button', 'aria-checked': 'false' },
          h('span', { class: 'ask-mark', 'data-multi': question.multiSelect ? 'true' : 'false' }),
          h(
            'span',
            { class: 'ask-copy' },
            h('span', { class: 'ask-label', text: option.label }),
            option.description ? h('span', { class: 'ask-desc', text: option.description }) : null,
          ),
        )
        row.dataset.label = option.label
        row.addEventListener('click', () => {
          const value = answers.get(question.id)
          if (question.multiSelect) {
            value.selected = value.selected.includes(option.label)
              ? value.selected.filter(label => label !== option.label)
              : [...value.selected, option.label]
          } else {
            value.selected = [option.label]
          }
          if (customInput !== null) customInput.value = ''
          value.custom = ''
          for (const sibling of optionHost.querySelectorAll('.ask-option')) {
            const on = value.selected.includes(sibling.dataset.label)
            sibling.dataset.checked = on ? 'true' : 'false'
            sibling.setAttribute('aria-checked', on ? 'true' : 'false')
          }
          sync()
        })
        return row
      })

      customInput = h('input', { class: 'ask-custom-input', type: 'text', placeholder: '其他，自己输入', autocomplete: 'off' })
      customInput.addEventListener('input', () => {
        const value = answers.get(question.id)
        value.custom = customInput.value.trim()
        if (value.custom !== '') {
          value.selected = []
          for (const sibling of optionHost.querySelectorAll('.ask-option')) {
            sibling.dataset.checked = 'false'
            sibling.setAttribute('aria-checked', 'false')
          }
        }
        sync()
      })

      // Restore what this step already holds, so stepping back and forth keeps
      // the selection instead of resetting it.
      const saved = answers.get(question.id)
      for (const row of rows) {
        const on = saved.selected.includes(row.dataset.label)
        row.dataset.checked = on ? 'true' : 'false'
        row.setAttribute('aria-checked', on ? 'true' : 'false')
      }
      customInput.value = saved.custom

      optionHost.replaceChildren(
        ...rows,
        h('label', { class: 'ask-custom' }, h('span', { class: 'ask-mark', 'data-multi': 'false' }), customInput),
      )
    }

    const render = () => {
      build(entry.questions[index])
      sync()
    }

    back.addEventListener('click', () => {
      if (index === 0) return
      index -= 1
      render()
    })

    forward.addEventListener('click', async () => {
      if (index < entry.questions.length - 1) {
        index += 1
        render()
        return
      }
      const payload = entry.questions.map(question => {
        const value = answers.get(question.id)
        return { id: question.id, selected: value.selected, ...(value.custom ? { custom: value.custom } : {}) }
      })
      forward.disabled = true
      const response = await api(`/session/${encodeURIComponent(session.id)}/answer`, {
        method: 'POST',
        body: JSON.stringify({ id: entry.id, answers: payload }),
      }).catch(() => undefined)
      if (response !== undefined) await refreshTranscript({ force: true })
      else forward.disabled = false
    })

    const element = card(
      h('div', { class: 'ask-header' }, heading, pager),
      h('div', { class: 'ask-body' }, optionHost),
      h('div', { class: 'ask-footer' }, back, forward),
    )
    render()
    return element
  }

  return card(h('div', { class: 'ask-header' }, h('div', { class: 'ask-heading' }, h('div', { class: 'ask-title' }, '未知交互'))))
}

/**
 * One collapsible tool row.
 * @param {object} item
 * @param {boolean} running
 * @returns {HTMLElement}
 */
function renderTool(item, running) {
  const body = h('div', { class: 'tool-body', hidden: true })
  const block = (label, text) => h('div', { class: 'tool-block' }, h('span', { class: 'tool-label', text: label }), h('pre', { class: 'tool-pre', text }))
  if (item.args) body.append(block('参数', item.args))
  if (item.result !== undefined) body.append(block(item.isError ? '结果 · 失败' : '结果', item.result))
  if (item.error) body.append(block('错误', item.error))
  for (const image of item.images ?? []) {
    const src = `${API}/session/${encodeURIComponent(state.session.id)}/image/${encodeURIComponent(image.id)}`
    body.append(thumbnail(src))
  }
  const pending = item.result === undefined && running
  const status = pending ? '运行中' : item.isError ? '失败' : item.result === undefined ? '已调用' : '完成'
  return h(
    'div',
    { class: 'tool' },
    h(
      'button',
      {
        class: 'tool-head',
        type: 'button',
        onclick: () => {
          body.hidden = !body.hidden
        },
      },
      h('span', { class: 'tool-name', text: item.name }),
      h('span', { class: 'tool-status', dataset: { state: pending ? 'running' : item.isError ? 'error' : 'done' }, text: status }),
    ),
    body,
  )
}

/**
 * Build the composer once per session.
 * @param {object} session
 * @returns {HTMLElement}
 */
/**
 * Clamp the palette to the visible viewport, keyboard included.
 *
 * `vh` is the layout viewport, which on iOS does not shrink for the keyboard:
 * a vh-sized list ends up half behind it, where neither the eye nor the finger
 * reaches — the exact "list won't scroll" complaint. `visualViewport` is the
 * one that shrinks, so the height is recomputed from it whenever it changes.
 *
 * @param {HTMLElement} palette
 */
function clampPaletteHeight(palette) {
  const visual = window.visualViewport?.height ?? 0
  const visible = Math.min(window.innerHeight, visual > 0 ? visual : window.innerHeight)
  palette.style.maxHeight = `${Math.round(Math.max(140, visible * 0.42))}px`
}

/**
 * Merge the command catalog and the skill catalog into one palette list.
 *
 * They are different mechanisms — a command runs host-side, a skill is a prompt
 * token the skill tool expands — but from the composer's side both are
 * `/name` lines, so one list is the honest presentation.
 *
 * @param {object} session
 * @returns {{name: string, description: string, hint?: string, kind: 'command'|'skill'}[]}
 */
function slashCandidates(session) {
  const meta = session.meta
  if (meta === null) return []
  const seen = new Set()
  const items = []
  for (const command of meta.commands ?? []) {
    if (seen.has(command.name)) continue
    seen.add(command.name)
    items.push({
      name: command.name,
      description: command.description ?? '',
      ...(command.hint === undefined ? {} : { hint: command.hint }),
      kind: 'command',
    })
  }
  for (const skill of meta.skills ?? []) {
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    items.push({ name: skill.name, description: skill.description ?? '', kind: 'skill' })
  }
  return items
}

/**
 * Run one slash line and report what the Host did with it.
 *
 * A registered command answers host-side and its text is shown as a toast; a
 * skill line is submitted as a prompt, so the normal transcript path takes
 * over and no optimistic bubble is invented here.
 *
 * @param {object} session
 * @param {string} line
 * @param {HTMLTextAreaElement} textarea
 * @param {() => void} sync
 */
async function runSlash(session, line, textarea, sync) {
  if (state.sending) return
  state.sending = true
  sync()
  try {
    const result = await api(`/session/${encodeURIComponent(session.id)}/command`, {
      method: 'POST',
      body: JSON.stringify({ line }),
    })
    session.draft = ''
    textarea.value = ''
    if (result.ran === 'command') {
      if (result.kind === 'error') toast(result.text === '' ? '命令执行失败' : result.text)
      else if (result.text !== '') toast(result.text, { tone: 'ok' })
      await loadMeta(session)
    }
    await refreshTranscript({ force: true })
  } catch (error) {
    if (error.code === 'unpaired') return renderPair()
    toast(error.message)
  } finally {
    state.sending = false
    sync()
  }
}

function buildComposer(session) {
  const textarea = h('textarea', { rows: 1, placeholder: '继续对话…', enterkeyhint: 'send', autocomplete: 'off' })
  textarea.value = session.draft ?? ''
  const send = h('button', { class: 'send', type: 'button', 'aria-label': '发送', disabled: true }, icon('send'))
  const attach = h('button', { class: 'attach', type: 'button', 'aria-label': '添加图片' }, icon('image'))
  const file = h('input', { class: 'composer-file', type: 'file', accept: 'image/*', multiple: true })
  const tray = h('div', { class: 'composer-tray' })
  const palette = h('div', { class: 'slash-palette', hidden: true })

  session.images = session.images ?? []

  const paintTray = () => {
    tray.hidden = session.images.length === 0
    tray.replaceChildren(
      ...session.images.map((image, index) =>
        h(
          'div',
          { class: 'tray-item' },
          h('img', { src: image.url, alt: '' }),
          h(
            'button',
            {
              class: 'tray-remove',
              type: 'button',
              'aria-label': '移除图片',
              onclick: () => {
                session.images.splice(index, 1)
                paintTray()
                sync()
              },
            },
            '×',
          ),
        ),
      ),
    )
  }

  /**
   * Slash token at the very start of the draft, or null.
   *
   * Only the first word counts: once a space is typed the argument text is no
   * longer a command name, so the palette closes and the line becomes a normal
   * submission for that command.
   * @returns {string|null}
   */
  const slashToken = () => {
    const value = textarea.value
    if (!value.startsWith('/')) return null
    const rest = value.slice(1)
    if (/\s/u.test(rest)) return null
    return rest
  }

  const paintPalette = () => {
    const token = slashToken()
    if (token === null) {
      palette.hidden = true
      palette.replaceChildren()
      return
    }
    const needle = token.toLowerCase()
    // No artificial cap: a phone with many skills must still be able to reach
    // every one of them, and the palette scrolls.
    const items = slashCandidates(session).filter(item => needle === '' || item.name.toLowerCase().includes(needle))
    if (items.length === 0) {
      palette.hidden = true
      palette.replaceChildren()
      return
    }
    palette.hidden = false
    clampPaletteHeight(palette)
    palette.replaceChildren(
      ...items.map(item =>
        h(
          'button',
          {
            class: 'slash-item',
            type: 'button',
            onclick: () => {
              // Insert, do not run: commands with arguments need the user to
              // keep typing, and inserting is what the desktop trigger does.
              textarea.value = item.hint === undefined ? `/${item.name}` : `/${item.name} `
              textarea.focus()
              sync()
            },
          },
          h('span', { class: 'slash-name', text: `/${item.name}` }),
          h('span', { class: 'slash-desc', text: item.description }),
          item.kind === 'skill' ? h('span', { class: 'slash-kind', text: '技能' }) : null,
        ),
      ),
    )
  }

  // The keyboard opens *after* the palette paints, so its height has to follow
  // the visual viewport. Re-clamping only touches max-height, never the rows, so
  // the scroll position survives.
  window.visualViewport?.addEventListener('resize', () => {
    if (!palette.hidden) clampPaletteHeight(palette)
  })

  const sync = () => {
    session.draft = textarea.value
    send.disabled = (textarea.value.trim() === '' && session.images.length === 0) || state.sending
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`
    paintPalette()
  }

  /**
   * Decode, downscale and re-encode one picked image.
   *
   * Phone photos are several megabytes; the bridge sends base64, so shrinking
   * to a 1600 px JPEG keeps a request well under the body limit.
   * @param {File} selected
   * @returns {Promise<{mediaType: string, url: string, data: string}|null>}
   */
  const readImage = selected =>
    new Promise(resolve => {
      if (!selected.type.startsWith('image/')) return resolve(null)
      if (selected.size > 24 * 1024 * 1024) {
        toast('图片太大，换一张')
        return resolve(null)
      }
      // `createImageBitmap` decodes the Blob directly; an object URL would need
      // `blob:` in the CSP and a second copy of the bytes.
      createImageBitmap(selected)
        .catch(() => null)
        .then(bitmap => {
          if (bitmap === null) {
            toast('这张图片解不开，换一张试试')
            return resolve(null)
          }
          const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
          const width = Math.max(1, Math.round(bitmap.width * scale))
          const height = Math.max(1, Math.round(bitmap.height * scale))
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
          bitmap.close?.()
          const dataUrl = canvas.toDataURL('image/jpeg', 0.82)
          // Keep the whole JSON body under the Host's 5 MB prompt cap.
          if (dataUrl.length > 4_400_000) {
            toast('图片压缩后仍然太大（上限 5MB）')
            return resolve(null)
          }
          resolve({ mediaType: 'image/jpeg', url: dataUrl, data: dataUrl.split(',')[1] })
        })
    })

  file.addEventListener('change', async () => {
    for (const selected of [...file.files]) {
      const image = await readImage(selected).catch(() => null)
      if (image === null) continue
      session.images.push({ mediaType: image.mediaType, url: image.url, data: image.url.split(',')[1] })
    }
    file.value = ''
    paintTray()
    sync()
    // A photo that lands after the fact still unlocks the send button.
    requestAnimationFrame(sync)
  })
  attach.addEventListener('click', () => {
    if (session.meta?.supportsImages === false) {
      toast('当前模型不支持图片，先在设置里换一个支持图片的模型')
      return
    }
    file.click()
  })
  session.attach = attach

  const submit = async () => {
    const text = textarea.value.trim()
    const images = session.images.slice()
    if ((text === '' && images.length === 0) || state.sending) return
    if (text.startsWith('/') && images.length === 0) {
      await runSlash(session, text, textarea, sync)
      return
    }
    state.sending = true
    state.pending = text
    state.pendingImages = images.map(image => image.url)
    session.scrolledToBottom = true
    session.pinned = true
    session.draft = ''
    session.images = []
    textarea.value = ''
    paintTray()
    sync()
    paintTranscript()
    try {
      await api(`/session/${encodeURIComponent(session.id)}/prompt`, {
        method: 'POST',
        body: JSON.stringify({
          text,
          ...(images.length === 0
            ? {}
            : { images: images.map(image => ({ mediaType: image.mediaType, data: image.data })) }),
        }),
      })
      // The durable user event may land after this response; do not keep the
      // optimistic bubble forever if the poll never sees it.
      setTimeout(() => {
        if (state.pending === text) {
          state.pending = null
          state.pendingImages = []
          paintTranscript()
        }
      }, 4_000)
      await refreshTranscript({ force: true })
    } catch (error) {
      state.pending = null
      state.pendingImages = []
      paintTranscript()
      if (error.code === 'unpaired') return renderPair()
      toast(error.message)
    } finally {
      state.sending = false
      sync()
    }
  }

  textarea.addEventListener('input', sync)
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submit()
    }
  })
  send.addEventListener('click', submit)
  paintTray()
  requestAnimationFrame(sync)
  return h('footer', { class: 'composer' }, palette, tray, h('div', { class: 'composer-bar' }, attach, textarea, send), file)
}

/**
 * Tap-to-zoom for transcript images.
 *
 * Delegated on the document so markdown images — inserted as HTML, never bound
 * individually — behave exactly like the ones built in code.
 */
document.addEventListener('click', event => {
  const picture = event.target instanceof Element ? event.target.closest('img.bubble-image, img.md-image') : null
  if (picture === null || picture.closest('.lightbox') !== null) return
  event.preventDefault()
  openLightbox(picture.src)
})

/**
 * Show a short-lived message above the composer.
 * @param {string} message
 */
function toast(message, { tone = 'error' } = {}) {
  const text = String(message ?? '').trim()
  if (text === '') return
  document.querySelector('.toast')?.remove()
  const node = h('div', { class: 'toast', 'data-tone': tone, text })
  document.body.append(node)
  setTimeout(() => node.remove(), 4200)
}

/**
 * Keep the transcript glued to the newest message unless the user scrolled up.
 * @param {object} session
 */
function pinToBottom(session) {
  const screen = session.screen
  if (screen === null || session.scrolledToBottom === false) return
  session.pinned = true
  screen.scrollTop = screen.scrollHeight
  requestAnimationFrame(() => {
    if (session.screen !== null && session.scrolledToBottom !== false) session.screen.scrollTop = session.screen.scrollHeight
  })
}

/**
 * One tappable image thumbnail.
 * @param {string} src
 * @returns {HTMLImageElement}
 */
function thumbnail(src) {
  return h('img', { class: 'bubble-image', src, alt: '', loading: 'lazy', onclick: () => openLightbox(src) })
}

/**
 * Build the URL for one durable attachment.
 *
 * Attachment ids are `sha256:<hex>` and may contain separators, so each path
 * segment is encoded but the id itself stays whole.
 * @param {string} sessionId
 * @param {string} attachmentId
 * @returns {string}
 */
function imageSrc(sessionId, attachmentId) {
  const id = String(attachmentId).split('/').map(segment => encodeURIComponent(segment)).join('/')
  return `${API}/session/${encodeURIComponent(sessionId)}/image/${id}`
}

/**
 * Show one image full screen.
 * @param {string} src
 */
function openLightbox(src) {
  const image = h('img', { class: 'lightbox-image', src, alt: '', draggable: 'false' })
  const stage = h('div', { class: 'lightbox-stage' }, image)
  let scale = 1
  let x = 0
  let y = 0
  let start = null
  let pinch = null
  let dragged = false
  const active = new Map()

  const apply = animate => {
    image.style.transition = animate ? 'transform 160ms ease' : 'none'
    image.style.transform = `translate(${String(x)}px, ${String(y)}px) scale(${String(scale)})`
  }

  const clamp = () => {
    // Keep the picture on screen: never drag it further than the visible part.
    const box = stage.getBoundingClientRect()
    const width = image.clientWidth * scale
    const height = image.clientHeight * scale
    const maxX = Math.max(0, (width - box.width) / 2)
    const maxY = Math.max(0, (height - box.height) / 2)
    x = Math.min(maxX, Math.max(-maxX, x))
    y = Math.min(maxY, Math.max(-maxY, y))
  }

  const reset = () => {
    scale = 1
    x = 0
    y = 0
    apply(true)
  }

  const close = () => overlay.remove()
  const overlay = h(
    'div',
    { class: 'lightbox' },
    stage,
    h('button', { class: 'lightbox-close', type: 'button', 'aria-label': '关闭', onclick: close }, '×'),
  )

  // The picture toggles zoom; anywhere else in the stage closes the viewer.
  image.addEventListener('click', () => {
    if (dragged) {
      dragged = false
      return
    }
    if (scale > 1) return reset()
    scale = 2.5
    x = 0
    y = 0
    apply(true)
  })
  stage.addEventListener('click', event => {
    if (event.target === stage) close()
  })

  overlay.addEventListener('dblclick', event => {
    event.preventDefault()
    if (scale > 1) return reset()
    scale = 2.5
    apply(true)
  })

  // One finger pans, two fingers pinch; a flick down at 1x closes.
  overlay.addEventListener('pointerdown', event => {
    // Capturing would retarget the following `click` to the overlay, which breaks
    // the picture's own tap-to-zoom; pan needs no capture since it stays inside.
    if (!event.isPrimary) overlay.setPointerCapture?.(event.pointerId)
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const points = [...active.values()].filter(point => point !== undefined)
    if (event.isPrimary || points.length === 0) start = { x: event.clientX, y: event.clientY, scale, tx: x, ty: y }
    active.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (active.size === 2) {
      const [a, b] = [...active.values()]
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale }
    }
    dragged = false
  })

  overlay.addEventListener('pointermove', event => {
    if (!active.has(event.pointerId)) return
    active.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (active.size >= 2 && pinch !== null) {
      const [a, b] = [...active.values()]
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1
      scale = Math.min(4, Math.max(1, (pinch.scale * distance) / pinch.distance))
      apply(false)
      return
    }
    if (start === null || scale <= 1) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.abs(dx) + Math.abs(dy) > 6) dragged = true
    x = start.tx + dx
    y = start.ty + dy
    clamp()
    apply(false)
  })

  const release = event => {
    const wasPinching = active.size >= 2
    active.delete(event.pointerId)
    if (active.size === 0) {
      if (!wasPinching && start !== null && scale <= 1 && event.clientY - start.y > 90) close()
      if (active.size === 0) {
        start = null
        pinch = null
      }
    }
    if (active.size < 2) pinch = null
  }
  overlay.addEventListener('pointerup', release)
  overlay.addEventListener('pointercancel', release)

  // Escape closes on a desktop keyboard.
  const onKey = event => {
    if (event.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  const observer = new MutationObserver(() => {
    if (!overlay.isConnected) {
      document.removeEventListener('keydown', onKey)
      observer.disconnect()
    }
  })
  document.body.append(overlay)
  observer.observe(document.body, { childList: true })
}

/**
 * Load the session settings payload (models, presets, usage, skills).
 * @param {object} session
 */
async function loadMeta(session) {
  try {
    const meta = await api(`/session/${encodeURIComponent(session.id)}/meta`)
    session.meta = meta
    session.metaAt = Date.now()
    paintHeaderControls(session)
    // Repaint whichever interface is open for this session, in place.
    if (state.sheet !== null && state.sheet.session === session) {
      state.sheet.bodyEl.replaceChildren(...state.sheet.panel.body())
    }
  } catch {
    // Settings are optional: a bare host still renders the transcript.
  }
}

/**
 * Compact usage string: 28.1k / 128k.
 * @param {number} value
 */
function compactTokens(value) {
  if (!Number.isFinite(value)) return '—'
  // Same ladder the desktop meter uses: raw, then K, then M, each with one
  // decimal below 100 so 1,000,000 reads as `1M` rather than `1000k`.
  const scaled = candidate => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10))
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${scaled(value / 1000)}k`
  return `${scaled(value / 1_000_000)}M`
}

/**
 * Paint the session's top-right controls and subtitle.
 *
 * The model name is the subtitle (the way a chat app shows the active route),
 * so it stays readable even though the old chip row is gone. The context button
 * carries a miniature occupancy ring; the full numbers live in that screen.
 *
 * @param {object} session
 */
function paintHeaderControls(session) {
  const meta = session.meta
  if (session.attach !== undefined && session.attach !== null) {
    session.attach.dataset.off = meta !== null && meta.supportsImages === false ? 'true' : 'false'
  }
  const context = meta?.context
  const used = Number(context?.used ?? 0)
  const window = Number(context?.window ?? 0)
  const percent = window > 0 ? Math.max(0, Math.min(100, Math.round((used / window) * 100))) : 0
  if (session.contextBtn !== null) {
    session.contextBtn.replaceChildren(ring(percent, { size: 22, stroke: 3, className: 'ctx-ring ctx-ring--mini' }))
    session.contextBtn.setAttribute('aria-label', meta === null ? '上下文用量' : `上下文已用 ${percent}%`)
  }
  if (session.modelBtn !== null) {
    session.modelBtn.disabled = meta === null || (meta.models ?? []).length === 0
  }
  if (session.subtitleNode === null) return
  // Keep the working directory visible until settings arrive, then lead with the
  // model: it is the thing this header now lets you change.
  session.subtitleNode.textContent = meta === null ? basename(session.cwd) : modelLabel(meta)
  session.subtitleNode.title = basename(session.cwd)
}

/**
 * Display name of the model a session will use next.
 * @param {object} meta
 * @returns {string}
 */
function modelLabel(meta) {
  const current = meta?.model
  if (current === null || current === undefined) return '默认模型'
  const match = (meta.models ?? []).find(item => item.provider === current.provider && item.id === current.model)
  return match?.name ?? current.model
}

/**
 * Whether a model row is the one the session will use next.
 * @param {object} meta
 * @param {object} model
 * @returns {boolean}
 */
function isCurrentModel(meta, model) {
  const current = meta?.model
  return current !== null && current !== undefined && current.provider === model.provider && current.model === model.id
}

/** ------------------------------------------------------------- sheets */

/**
 * Open (or replace) one sheet interface.
 *
 * The sheet keeps a re-render hook so a late `/meta` response repaints the body
 * in place; without it a picker opened while settings loaded would flash away.
 *
 * @param {object} session
 * @param {string} kind - `model` | `context` | `settings`.
 * @param {{title: string, body: () => (HTMLElement|string)[]}} panel
 */
function openSheet(session, kind, panel) {
  const owned = state.sheet
  if (owned !== null && owned.session === session && owned.kind === kind) {
    // Same interface, refreshed: swap the body and keep the animation running.
    owned.bodyEl.replaceChildren(...panel.body())
    owned.panel = panel
    return
  }
  if (owned !== null) closeSheet({ animate: false })
  // A fresh interface starts with an empty filter; refreshing the same one
  // keeps whatever the user typed.
  state.modelQuery = ''

  const body = h('div', { class: 'sheet-body' }, ...panel.body())
  const sheet = h(
    'div',
    { class: 'sheet' },
    h('div', { class: 'sheet-grip' }),
    h(
      'div',
      { class: 'sheet-head' },
      h('span', { class: 'sheet-title', text: panel.title }),
      h('button', { class: 'sheet-close', type: 'button', onclick: () => closeSheet() }, '完成'),
    ),
    body,
  )
  const mask = h('div', { class: 'sheet-mask', onclick: () => closeSheet() })
  const host = h('div', { class: 'sheet-host' }, sheet)
  state.sheet = { session, kind, bodyEl: body, host, sheet, mask, panel }
  document.body.append(mask)
  document.body.append(host)
  requestAnimationFrame(() => host.classList.add('open'))
}

/**
 * Close the open sheet.
 * @param {{animate?: boolean}} [options]
 */
function closeSheet({ animate = true } = {}) {
  if (state.sheet === null) return
  const { host, mask } = state.sheet
  state.sheet = null
  mask.remove()
  if (!animate) {
    host.remove()
    return
  }
  host.classList.remove('open')
  setTimeout(() => host.remove(), 160)
}

/** Backwards-compatible alias: older call sites close the same sheet. */
function closeSettings() {
  closeSheet()
}

/**
 * Thinking-strength control for the current route.
 *
 * The efforts come from `resolveModelInfo` for that exact provider/model, so a
 * route without reasoning support renders nothing at all rather than an empty
 * row of buttons. Changing one re-selects the same model with the new effort.
 *
 * @param {object} session
 * @param {object} meta
 * @returns {HTMLElement[]}
 */
function reasoningPicker(session, meta) {
  const efforts = meta.reasoning?.efforts ?? []
  // One option is not a choice: a lone button reads as a broken control, and
  // the model row above already names the route.
  if (efforts.length < 2) return []
  const current = meta.model?.reasoningEffort ?? meta.reasoning?.default
  const selecting = async effort => {
    if (meta.model === null || meta.model === undefined) return
    await api(`/session/${encodeURIComponent(session.id)}/model`, {
      method: 'POST',
      body: JSON.stringify({ provider: meta.model.provider, model: meta.model.model, reasoningEffort: effort }),
    }).catch(error => { toast(error.message) })
    await loadMeta(session)
  }
  const row = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': '思考强度' },
    ...efforts.map(effort =>
      h('button', {
        class: 'segmented-item',
        type: 'button',
        'data-active': effort.id === current ? 'true' : 'false',
        'aria-pressed': effort.id === current ? 'true' : 'false',
        title: effort.description ?? '',
        onclick: () => { if (effort.id !== current) void selecting(effort.id) },
      }, effort.name),
    ),
  )
  return [
    h('div', { class: 'sheet-label', text: '思考强度' }),
    row,
  ]
}

/**
 * 模型 interface: every configured model, grouped by provider, with the model
 * the session will use next checked.
 * @param {object} session
 */
function openModelPicker(session) {
  openSheet(session, 'model', {
    title: '模型',
    body: () => {
      const meta = session.meta
      if (meta === null) return [h('div', { class: 'sheet-usage', text: '正在读取模型…' })]
      // Thinking strength first: it belongs to the current route, and it is the
      // control people reach for without changing the model at all.
      const children = reasoningPicker(session, meta)
      const list = h('div', { class: 'model-list' })
      const query = () => state.modelQuery ?? ''

      const rowsFor = () => {
        const needle = query().trim().toLowerCase()
        const groups = new Map()
        for (const model of meta.models ?? []) {
          if (needle !== '' && !`${model.name} ${model.provider} ${model.id}`.toLowerCase().includes(needle)) continue
          const bucket = groups.get(model.provider) ?? []
          bucket.push(model)
          groups.set(model.provider, bucket)
        }
        const rows = []
        for (const [provider, models] of groups) {
          rows.push(h('div', { class: 'sheet-label', text: provider }))
          for (const model of models) rows.push(modelRow(session, meta, model))
        }
        if (rows.length === 0) rows.push(h('div', { class: 'sheet-usage', text: needle === '' ? '这个 Host 没有可选的模型' : '没有匹配的模型' }))
        return rows
      }

      const paintList = () => list.replaceChildren(...rowsFor())
      paintList()
      children.push(list)

      const field = h('input', {
        class: 'sheet-search-input',
        type: 'search',
        placeholder: '搜索模型',
        enterkeyhint: 'search',
        autocomplete: 'off',
        value: query(),
        oninput: event => {
          state.modelQuery = event.target.value
          paintList()
        },
      })
      children.push(
        h('div', { class: 'sheet-search' }, h('span', { class: 'sheet-search-icon' }, icon('search')), field),
      )
      return children
    },
  })
}

/**
 * One model row: name, capability badges, and a check on the selected route.
 *
 * The selected row deliberately keeps the plain row background — the reference
 * list marks selection with the check alone, so a filled box would read as a
 * different kind of control.
 *
 * @param {object} session
 * @param {object} meta
 * @param {object} model
 * @returns {HTMLElement}
 */
function modelRow(session, meta, model) {
  const active = isCurrentModel(meta, model)
  const badges = []
  if (model.thinking === true) badges.push(h('span', { class: 'model-badge', text: 'thinking' }))
  if (model.images === true) badges.push(h('span', { class: 'model-badge', text: 'vision' }))
  return h(
    'button',
    {
      class: 'sheet-row model-row',
      type: 'button',
      'data-active': active ? 'true' : 'false',
      'aria-pressed': active ? 'true' : 'false',
      onclick: async () => {
        await api(`/session/${encodeURIComponent(session.id)}/model`, {
          method: 'POST',
          body: JSON.stringify({ provider: model.provider, model: model.id }),
        }).catch(error => { toast(error.message) })
        await loadMeta(session)
      },
    },
    h(
      'span',
      { class: 'sheet-row-text' },
      h('span', { class: 'sheet-row-name', text: model.name }),
      badges.length > 0 ? h('span', { class: 'model-badges' }, ...badges) : null,
    ),
    sheetCheck(active),
  )
}

/**
 * 上下文 interface, mirroring the desktop composer meter: occupancy ring and
 * percentage, `~used / window`, a composition bar, and the heuristic split into
 * system prompt, tool definitions, and conversation messages.
 * @param {object} session
 */
function openContext(session) {
  openSheet(session, 'context', {
    title: '上下文',
    body: () => {
      const meta = session.meta
      if (meta === null) return [h('div', { class: 'sheet-usage', text: '正在读取用量…' })]
      const context = meta.context
      const used = context?.used
      const window = context?.window
      if (used === undefined || window === undefined) {
        // No provider sample yet: show what the meter knows instead of nothing.
        const total = Number(context?.total ?? 0)
        const surface = Number(context?.surface ?? 0)
        return [
          h('div', { class: 'sheet-usage', text: total > 0 ? `会话累计 ${compactTokens(total)} tokens，其中 ${compactTokens(surface)} 计入请求。` : '这个会话还没有发出过请求，没有用量数据。' }),
          h('div', { class: 'sheet-note', text: '桌面端在这个阶段同样只显示占位。' }),
        ]
      }
      const percent = Number(context?.percent ?? Math.min(100, Math.round((used / window) * 100)))
      const breakdown = context?.breakdown ?? { system: 0, tools: 0, messages: 0 }
      const segments = [
        { key: 'system', label: '系统提示词', value: Number(breakdown.system ?? 0), tone: 'system' },
        { key: 'tools', label: '工具定义', value: Number(breakdown.tools ?? 0), tone: 'tools' },
        { key: 'messages', label: '对话消息', value: Number(breakdown.messages ?? 0), tone: 'messages' },
      ]
      const breakdownTotal = segments.reduce((sum, segment) => sum + segment.value, 0)
      const children = [
        h(
          'div',
          { class: 'ctx-detail-head' },
          ring(percent),
          h(
            'div',
            { class: 'ctx-detail-figures' },
            h('div', { class: 'ctx-detail-percent', text: `${percent}%` }),
            h('div', { class: 'ctx-detail-caption', text: '上下文已用' }),
          ),
        ),
        h('div', { class: 'ctx-detail-range', text: `~${compactTokens(used)} / ${compactTokens(window)}` }),
      ]
      if (breakdownTotal > 0) {
        children.push(
          h(
            'div',
            { class: 'ctx-detail-bar' },
            ...segments.map(segment =>
              h('i', { class: `ctx-detail-segment ctx-detail-segment--${segment.tone}`, style: `width:${(segment.value / breakdownTotal) * 100}%` }),
            ),
          ),
          h(
            'dl',
            { class: 'ctx-detail-rows' },
            ...segments.flatMap(segment => [
              h('dt', {}, h('span', { class: `ctx-detail-swatch ctx-detail-swatch--${segment.tone}` }), segment.label),
              h('dd', { text: `~${compactTokens(segment.value)}` }),
            ]),
          ),
        )
      } else {
        children.push(h('div', { class: 'sheet-note', text: '这个 Host 还没有提供构成明细。' }))
      }
      const total = Number(context?.total ?? 0)
      if (total > 0 && Math.abs(total - used) / Math.max(1, used) > 0.02) {
        children.push(h('div', { class: 'sheet-note', text: `会话累计 ${compactTokens(total)} tokens。` }))
      }
      return children
    },
  })
}

/**
 * Occupancy ring, drawn like the desktop meter's.
 * @param {number} percent - 0..100
 * @returns {SVGElement}
 */
function ring(percent, { size = 56, stroke = 5, className = 'ctx-ring' } = {}) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`)
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  track.setAttribute('class', 'ctx-ring-track')
  track.setAttribute('cx', String(size / 2))
  track.setAttribute('cy', String(size / 2))
  track.setAttribute('r', String(radius))
  track.setAttribute('stroke-width', String(stroke))
  const fill = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  fill.setAttribute('class', 'ctx-ring-fill')
  fill.setAttribute('cx', String(size / 2))
  fill.setAttribute('cy', String(size / 2))
  fill.setAttribute('r', String(radius))
  fill.setAttribute('stroke-width', String(stroke))
  fill.setAttribute('stroke-dasharray', `${(circumference * percent) / 100} ${circumference}`)
  fill.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`)
  svg.append(track, fill)
  return svg
}

/**
 * 会话设置 interface: mode and skills only. The model list and the usage block
 * live in their own interfaces now, so nothing appears twice.
 * @param {object} session
 */
function openSettings(session) {
  openSheet(session, 'settings', {
    title: '会话设置',
    body: () => {
      const meta = session.meta
      if (meta === null) return [h('div', { class: 'sheet-usage', text: '正在读取设置…' })]
      const children = []
      if ((meta.permissions ?? []).length > 0) {
        children.push(h('div', { class: 'sheet-label', text: '模式' }))
        for (const option of meta.permissions) {
          const active = meta.permission === option.value
          children.push(
            h(
              'button',
              {
                class: 'sheet-row',
                type: 'button',
                'data-active': active ? 'true' : 'false',
                onclick: async () => {
                  await api(`/session/${encodeURIComponent(session.id)}/mode`, {
                    method: 'POST',
                    body: JSON.stringify({ name: option.value }),
                  }).catch(error => { toast(error.message) })
                  await loadMeta(session)
                },
              },
              h('span', { class: 'sheet-row-text' },
                h('span', { class: 'sheet-row-name', text: option.name }),
                option.description ? h('span', { class: 'sheet-row-desc', text: option.description }) : null,
              ),
              sheetCheck(active),
            ),
          )
        }
      }
      // Skills are NOT listed here: the composer's `/` palette owns them now,
      // together with the command catalog. One entry point, no duplicate list.
      if (children.length === 0) children.push(h('div', { class: 'sheet-usage', text: '这个 Host 没有可调的会话设置。' }))
      children.push(h('div', { class: 'sheet-note', text: '斜杠命令和技能在输入框里打 / 打开。' }))
      return children
    },
  })
}

/** --------------------------------------------------------------- data */

/** Load the workspace/session tree. */
async function loadState({ force = false } = {}) {
  if (!force && Date.now() - state.lastStateAt < 4000) return
  const data = await api(`/state?v=${encodeURIComponent(BUILD)}`)
  state.workspaces = Array.isArray(data.workspaces) ? data.workspaces : []
  state.loose = Array.isArray(data.loose) ? data.loose : []
  state.device = data.device ?? state.device
  state.groupedBy = data.groupedBy === 'cwd' ? 'cwd' : 'workspace'
  state.pendingRequests = Array.isArray(data.pending) ? data.pending : []
  state.diagnostics = data.diagnostics ?? null
  state.lastStateAt = Date.now()
}

/**
 * Poll the open session for new items.
 * @param {{force?: boolean}} [options]
 */
async function refreshTranscript({ force = false } = {}) {
  const session = state.session
  if (session === null) return
  if (!force && document.visibilityState !== 'visible') return
  try {
    const data = await api(`/session/${encodeURIComponent(session.id)}?after=${session.lastSeq}&c=${CLIENT}`)
    if (applyTranscript(data, false)) paintTranscript()
  } catch (error) {
    if (error.code === 'unpaired') {
      stopPolling()
      renderPair()
    }
  }
}

/**
 * Subscribe to the Host's pending-interaction push.
 *
 * The home screen cannot rely on its 5 s poll: a desktop answerer resolves a
 * request in well under that. This stream makes the card appear immediately,
 * wherever the app happens to be.
 */
function openEvents() {
  if (typeof EventSource !== 'function' || state.events !== null) return
  const source = new EventSource('/m/api/events')
  state.events = source
  source.addEventListener('pending', event => {
    let payload
    try {
      payload = JSON.parse(event.data)
    } catch {
      return
    }
    const list = Array.isArray(payload?.pending) ? payload.pending : []
    const before = state.pendingRequests.map(entry => entry.id).join('|')
    state.pendingRequests = list
    if (state.session !== null) {
      state.session.pending = list.filter(entry => entry.sessionId === state.session.id)
      paintPending(state.session)
    }
    if (state.view === 'home' && list.map(entry => entry.id).join('|') !== before) renderHome()
  })
  source.onopen = () => {
    state.eventsState = 'live'
    if (state.view === 'home') renderHome()
    else if (state.view === 'session') renderSession()
  }
  // EventSource reconnects on its own; a dead stream only costs the push speed.
  source.onerror = () => {
    state.eventsState = 'off'
  }
}

/** Watch for pending interactions while the home screen is visible. */
function startHomePolling() {
  if (state.homeTimer !== null) return
  state.homeTimer = setInterval(async () => {
    if (state.view !== 'home' || document.visibilityState !== 'visible') return
    const before = state.pendingRequests.map(entry => entry.id).join('|')
    try {
      await loadState({ force: true })
    } catch {
      return
    }
    if (state.pendingRequests.map(entry => entry.id).join('|') !== before) renderHome()
  }, 5000)
}

/** Start the session poller. */
function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && state.view === 'session') refreshTranscript()
  }, 1500)
}

/** Stop the session poller. */
function stopPolling() {
  if (pollTimer !== null) clearInterval(pollTimer)
  pollTimer = null
}

/** Route from the current hash. */
async function route() {
  if (state.view === 'pair' || state.view === 'boot') return
  const match = /^#\/s\/(.+)$/u.exec(location.hash)
  if (match !== null) {
    const id = decodeURIComponent(match[1])
    if (state.session?.id !== id) await openSession(id)
    return
  }
  stopPolling()
  closeStream(state.session)
  state.session = null
  try {
    await loadState({ force: true })
    renderHome()
  } catch (error) {
    if (error.code === 'unpaired') return renderPair()
    toast(error.message)
  }
}

/** Trade the URL token for a device cookie. */
async function pairFromUrl() {
  const url = new URL(location.href)
  const token = url.searchParams.get('t')
  if (token === null || token === '') return false
  renderBoot('正在配对…')
  try {
    await api('/pair', { method: 'POST', body: JSON.stringify({ token }) })
    url.searchParams.delete('t')
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash || '#/'}`)
    return true
  } catch (error) {
    // A stale `?t=` in a bookmark or an old home-screen icon must not lock out a
    // device that already holds a valid cookie: strip it and let the normal
    // 401 → pairing screen path decide.
    url.searchParams.delete('t')
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash || '#/'}`)
    if (error.code !== 'invalid-token') renderPair('配对失败，请重新扫码。')
    return false
  }
}

/** Boot the app. */
async function boot() {
  state.viewed = loadViewed()
  // Unread means "finished since I last opened the app", so the baseline is the
  // previous visit rather than this page load.
  try {
    const previous = Number(localStorage.getItem(VISIT_KEY) ?? 0)
    if (Number.isFinite(previous) && previous > 0) state.startedAt = previous
    localStorage.setItem(VISIT_KEY, String(Date.now()))
  } catch {
    // Without storage the baseline stays at page load.
  }
  try {
    await pairFromUrl()
  } catch {
    return
  }
  try {
    await loadState({ force: true })
    openEvents()
    const match = /^#\/s\/(.+)$/u.exec(location.hash)
    if (match !== null) await openSession(decodeURIComponent(match[1]))
    else renderHome()
  } catch (error) {
    if (error.code === 'unpaired') return renderPair()
    setView(
      'error',
      h(
        'div',
        { class: 'boot' },
        h('p', { class: 'boot-text', text: `连接失败：${error.message}` }),
        h('button', { class: 'retry', type: 'button', onclick: () => boot() }, '重试'),
      ),
    )
  }
}

window.addEventListener('hashchange', () => {
  route()
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.view === 'session') refreshTranscript()
})

boot()
