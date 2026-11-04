/**
 * Host half of `dsh-pair`.
 *
 * DeepSeek Harness already serves its Web GUI over the LAN when started with
 * `--host <lan-ip>`; what it lacks is a low-friction way to get a phone onto
 * that origin, and a phone-shaped surface. This plugin adds both:
 *
 * - **Pairing.** A rotating, short-lived token is rendered as a QR code on the
 *   desktop. Scanning it opens the mobile app with `?t=<token>`; the app trades
 *   the token for an HttpOnly device cookie scoped to `/m`. The token never
 *   grants access to `/api` — the phone uses this plugin's own bridge instead.
 * - **Bridge.** `/m/api/*` exposes exactly the three things the phone needs:
 *   the workspace/session tree, one session transcript, and prompt delivery.
 *   It talks to Host services directly (`sessionQuery`, `sessionController`,
 *   `workspaceController`), so there is no second copy of business logic.
 * - **App hosting.** The phone UI ships inside this package (`app/`)
 *   and is served from `config.appDir` as plain static files.
 *
 * Security posture: everything here is LAN-only by construction (the listener
 * is whatever `dsh web --host` bound), the pairing token expires, device
 * cookies are HMAC-signed and revocable, and the desktop endpoints reuse the
 * Harness connection's own cookie/Origin admission instead of inventing a
 * second desktop auth scheme.
 *
 * @module dsh-pair
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, extname, join, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import qrcode from './vendor/qrcode.mjs'

/** Directory this module lives in; relative `appDir` values resolve against it. */
const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Desktop-facing pairing document (authenticated through the Harness connection). */
const PAIR_PATH = '/dsh-pair/pair.json'
/** Desktop-facing device revocation endpoint. */
const REVOKE_PATH = '/dsh-pair/revoke.json'
/**
 * Mobile app mount point. Registered as a prefix *without* a trailing slash:
 * the Host router matches `pathname === prefix || pathname.startsWith(prefix + '/')`,
 * so a `/m/` prefix would only ever match `/m/` itself.
 */
const APP_ROOT = '/m'
/** Mobile bridge; same no-trailing-slash prefix rule. */
const API_ROOT = '/m/api'

/** Name of the device cookie. Scoped to `/m` so the Harness origin never sees it elsewhere. */
const DEVICE_COOKIE = 'dsh_pair'

/** Response body cap for bridge requests. */
const MAX_BODY_BYTES = 256 * 1024
/** Prompt bodies carry base64 images; the client downscales before sending. */
const MAX_PROMPT_BYTES = 5 * 1024 * 1024
/** Pairing attempts allowed per client address inside one minute. */
const PAIR_ATTEMPTS_PER_MINUTE = 20
/** Transcript items returned when the app opens a session without a cursor. */
const TRANSCRIPT_TAIL_ITEMS = 200
/** Hard cap on one transcript response. */
const TRANSCRIPT_MAX_ITEMS = 600
/** Per-field truncation so one giant tool result cannot stall a phone. */
const MAX_TEXT_CHARS = 24_000
const MAX_TOOL_ARGS_CHARS = 2_000
const MAX_TOOL_RESULT_CHARS = 6_000
/** Prompt admission timeout; the Host resumes a cold session inside this window. */
/** Image media types the prompt bridge accepts. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const PROMPT_TIMEOUT_MS = 60_000

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
})

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

// ---------------------------------------------------------------- utilities

/**
 * Resolve one configuration value with a fallback.
 * @param value - raw value from the Loader row.
 * @param fallback - value used when `value` is missing or empty.
 * @returns the configured string.
 */
function text(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * Resolve one positive numeric configuration value.
 * @param value - raw value from the Loader row.
 * @param fallback - value used when `value` is not a positive finite number.
 * @returns the configured number.
 */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Project the Loader row onto the knobs this plugin reads.
 * @param raw - the Loader row's `config`, possibly absent or malformed.
 * @returns complete settings.
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    appDir: text(source.appDir, 'app'),
    pairTtlMinutes: positive(source.pairTtlMinutes, 10),
    cookieDays: positive(source.cookieDays, 30),
    maxDevices: Math.max(1, Math.floor(positive(source.maxDevices, 8))),
    // 0 = show the request on both devices at once (first answer wins). That is
    // the default: the Host keeps the desktop chain waiting rather than opening
    // the dialog only after the phone went unanswered, which would make the
    // desktop stay silent (and sometimes linger) long after the phone decided.
    phoneOnlyMs: Number.isFinite(source.phoneOnlyMs) && source.phoneOnlyMs >= 0 ? source.phoneOnlyMs : 0,
    debug: source.debug === true,
    // Empty string disables persistence (tests, or a deliberately stateless host).
    storePath:
      typeof source.storePath === 'string'
        ? source.storePath
        : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-pair-devices.json'),
  }
}

/**
 * Resolve `appDir` against the plugin directory.
 * @param appDir - configured path, absolute or relative.
 * @returns absolute app directory.
 */
export function appDirectory(appDir) {
  return resolvePath(PLUGIN_DIR, appDir)
}

/**
 * Compare two strings without leaking length or prefix timing.
 * @param actual - attacker-controlled value.
 * @param expected - server-held value.
 * @returns whether they are identical.
 */
function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual))
  const right = Buffer.from(String(expected))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Classify one listener address as loopback (the forms `--host` accepts).
 * @param host - bound host literal.
 * @returns whether a phone on the LAN could never reach it.
 */
/**
 * Non-loopback IPv4 addresses of this machine, so the Desktop page can name the
 * one to bind. IPv6 is deliberately skipped: `--host` accepts a literal, and a
 * link-local IPv6 address needs a zone id that a URL cannot express.
 *
 * @returns candidate LAN addresses, most useful first.
 */
export function lanAddresses() {
  const found = []
  try {
    for (const [name, list] of Object.entries(networkInterfaces())) {
      // Virtual interfaces are reachable from the Host but never from a phone:
      // docker bridges, container veths, VPN/tunnel links. Offering one sends
      // the user to an address that answers locally and times out elsewhere.
      if (/^(docker|br-|veth|tun|utun|tap|zt|tailscale)/iu.test(name)) continue
      for (const item of list ?? []) {
        if (item.family !== 'IPv4' && item.family !== 4) continue
        if (item.internal) continue
        // Link-local, plus the benchmark range tun drivers (Clash/Meta and
        // friends) hand out: neither is reachable from the phone's network.
        if (/^(169\.254\.|198\.1[89]\.)/u.test(item.address)) continue
        found.push(item.address)
      }
    }
  } catch {
    // Address enumeration is best-effort; the page still shows the warning.
  }
  // Real Wi-Fi/Ethernet first: a Host with both a NIC and a tunnel should name
  // the NIC, which is the address a phone on the same network can reach.
  const rank = address =>
    address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : address.startsWith('172.') ? 3 : 2
  return [...new Set(found)].sort((left, right) => rank(left) - rank(right))
}

/**
 * The command that makes this Host reachable from a phone.
 * @param port - listening port; omitted when the Host did not report one.
 * @returns one copy-pasteable `dsh web --host …` line.
 */
export function bindCommand(port) {
  const target = lanAddresses()[0]
  const suffix = typeof port === 'number' && Number.isFinite(port) && port > 0 ? ` --port ${String(port)}` : ''
  return target === undefined ? `dsh web --host <你的局域网 IP>${suffix}` : `dsh web --host ${target}${suffix}`
}

export function isLoopbackHost(host) {
  const value = String(host ?? '').toLowerCase()
  return value === '::1' || value === '0:0:0:0:0:0:0:1' || value === '::ffff:127.0.0.1' || /^127\./u.test(value) || value === 'localhost'
}

/**
 * Sign one value with the process secret.
 * @param secret - process HMAC key.
 * @param value - payload to sign.
 * @returns base64url signature.
 */
function sign(secret, value) {
  return createHmac('sha256', secret).update(value).digest('base64url').slice(0, 32)
}

/**
 * Parse the request's Cookie header.
 * @param request - incoming request.
 * @returns cookie name → value map.
 */
export function parseCookies(request) {
  const header = request.headers.cookie
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name !== '') out[name] = decodeURIComponent(value)
  }
  return out
}

/**
 * Write one JSON response.
 * @param response - Node response.
 * @param status - HTTP status.
 * @param body - JSON-serializable payload.
 * @param headers - extra headers.
 */
function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(payload)
}

/**
 * Write one plain-text response.
 * @param response - Node response.
 * @param status - HTTP status.
 * @param body - text payload.
 * @param headers - extra headers.
 */
function sendText(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  response.end(body)
}

/**
 * Read and parse a JSON request body.
 * @param request - incoming request.
 * @param limit - maximum accepted bytes.
 * @returns parsed value, or `undefined` when the body is absent.
 * @throws when the body exceeds the limit or is not valid JSON.
 */
async function readJson(request, limit = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Describe a device from its User-Agent.
 * @param userAgent - raw User-Agent header.
 * @returns short human label such as `iPhone · Safari`.
 */
export function deviceLabel(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent : ''
  const device = /iPhone/i.test(ua)
    ? 'iPhone'
    : /iPad/i.test(ua)
      ? 'iPad'
      : /Android/i.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/i.test(ua)
          ? 'Mac'
          : /Windows/i.test(ua)
            ? 'Windows'
            : /Linux/i.test(ua)
              ? 'Linux'
              : 'Browser'
  const browser = /MicroMessenger/i.test(ua)
    ? '微信'
    : /EdgA?/i.test(ua)
      ? 'Edge'
      : /CriOS|Chrome/i.test(ua)
        ? 'Chrome'
        : /FxiOS|Firefox/i.test(ua)
          ? 'Firefox'
          : /Safari/i.test(ua)
            ? 'Safari'
            : '浏览器'
  return `${device} · ${browser}`
}

// ---------------------------------------------------------------- pairing

/**
 * Rotation token + device registry for one Host process.
 *
 * Tokens live for `ttlMs` and are replaced on demand; devices live until they
 * are revoked, evicted (oldest first at `maxDevices`), or the process exits.
 * A restart therefore invalidates every device cookie — intentionally, since
 * the HMAC secret is process-local.
 */
export class Pairing {
  /**
   * @param options - TTLs, the device cap, and where the device registry persists.
   */
  constructor({ ttlMs, cookieDays, maxDevices, storePath }) {
    this.ttlMs = ttlMs
    this.cookieDays = cookieDays
    this.maxDevices = maxDevices
    this.storePath = storePath
    this.secret = randomBytes(32)
    this.token = ''
    this.expiresAt = 0
    this.devices = new Map()
    this.attempts = new Map()
    this.load()
  }

  /**
   * Restore the HMAC secret and paired devices from disk.
   *
   * Without this, every `dsh web` restart invalidates every phone cookie and
   * forces a re-scan; the pairing state is small and worth keeping.
   */
  load() {
    if (typeof this.storePath !== 'string' || this.storePath === '') return
    try {
      const raw = readFileSync(this.storePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return
      if (typeof parsed.secret === 'string' && parsed.secret !== '') this.secret = Buffer.from(parsed.secret, 'base64url')
      if (Array.isArray(parsed.devices)) {
        for (const device of parsed.devices) {
          if (typeof device?.id !== 'string' || device.id === '') continue
          this.devices.set(device.id, {
            id: device.id,
            label: String(device.label ?? '设备'),
            userAgent: String(device.userAgent ?? ''),
            createdAt: Number(device.createdAt ?? Date.now()),
            lastSeenAt: Number(device.lastSeenAt ?? Date.now()),
          })
        }
      }
    } catch {
      // Missing or unreadable store: start fresh.
    }
  }

  /** Persist the secret and device list; failures must not break pairing. */
  persist() {
    if (typeof this.storePath !== 'string' || this.storePath === '') return
    try {
      mkdirSync(dirname(this.storePath), { recursive: true })
      writeFileSync(
        this.storePath,
        JSON.stringify({
          version: 1,
          secret: Buffer.from(this.secret).toString('base64url'),
          devices: this.list(),
        }),
        { mode: 0o600 },
      )
    } catch {
      // A read-only home still works, it just forgets devices on restart.
    }
  }

  /**
   * Return the live token, minting one when absent or expired.
   * @param force - replace the current token even when it is still valid.
   * @returns the active token.
   */
  rotate(force = false) {
    const now = Date.now()
    if (!force && this.token !== '' && now < this.expiresAt) return this.token
    this.token = randomBytes(18).toString('base64url')
    this.expiresAt = now + this.ttlMs
    return this.token
  }

  /**
   * Check a scanned token.
   * @param candidate - token from the QR URL.
   * @returns whether it is the live token and has not expired.
   */
  accepts(candidate) {
    return (
      typeof candidate === 'string' &&
      candidate !== '' &&
      this.token !== '' &&
      Date.now() < this.expiresAt &&
      safeEqual(candidate, this.token)
    )
  }

  /**
   * Rate-limit pairing attempts per client address.
   * @param address - socket address.
   * @returns whether this attempt may proceed.
   */
  allowAttempt(address) {
    const now = Date.now()
    const key = String(address)
    const entry = this.attempts.get(key)
    if (entry === undefined || now > entry.resetAt) {
      this.attempts.set(key, { count: 1, resetAt: now + 60_000 })
      return true
    }
    entry.count += 1
    return entry.count <= PAIR_ATTEMPTS_PER_MINUTE
  }

  /**
   * Register one phone and mint its cookie.
   * @param request - the pairing request (for its User-Agent).
   * @returns the device record and its `Set-Cookie` value.
   */
  issue(request) {
    while (this.devices.size >= this.maxDevices) {
      const oldest = this.devices.values().next().value
      if (oldest === undefined) break
      this.devices.delete(oldest.id)
    }
    const now = Date.now()
    const device = {
      id: randomBytes(12).toString('base64url'),
      label: deviceLabel(request.headers['user-agent']),
      userAgent: String(request.headers['user-agent'] ?? '').slice(0, 180),
      createdAt: now,
      lastSeenAt: now,
    }
    this.devices.set(device.id, device)
    this.persist()
    return device
  }

  /**
   * Build the cookie value for a device.
   * @param device - registered device.
   * @returns `id.expiry.signature`.
   */
  cookieValue(device) {
    const expires = Date.now() + this.cookieDays * 86_400_000
    return `${device.id}.${expires}.${sign(this.secret, `${device.id}.${expires}`)}`
  }

  /**
   * Resolve and touch the device named by the request cookie.
   * @param request - incoming request.
   * @returns the device, or `undefined` when absent, revoked, or forged.
   */
  deviceFrom(request) {
    const raw = parseCookies(request)[DEVICE_COOKIE]
    if (typeof raw !== 'string') return undefined
    const parts = raw.split('.')
    if (parts.length !== 3) return undefined
    const [id, expiresText, signature] = parts
    const expires = Number(expiresText)
    if (!Number.isFinite(expires) || expires < Date.now()) return undefined
    if (!safeEqual(signature, sign(this.secret, `${id}.${expires}`))) return undefined
    const device = this.devices.get(id)
    if (device === undefined) return undefined
    device.lastSeenAt = Date.now()
    return device
  }

  /**
   * Drop one device; its cookie stops validating immediately.
   * @param id - device id.
   * @returns whether a device was removed.
   */
  revoke(id) {
    const removed = this.devices.delete(String(id))
    if (removed) this.persist()
    return removed
  }

  /**
   * Public device rows for the desktop page.
   * @returns devices without their user-agent string.
   */
  list() {
    return [...this.devices.values()].map(({ id, label, createdAt, lastSeenAt }) => ({
      id,
      label,
      createdAt,
      lastSeenAt,
    }))
  }
}

// ---------------------------------------------------------------- QR

/**
 * Render one QR code as a standalone SVG string.
 * @param value - text to encode (usually the pairing URL).
 * @param options - module size and quiet zone in modules.
 * @returns SVG markup.
 */
export function renderQrSvg(value, { cellSize = 8, margin = 4 } = {}) {
  const qr = qrcode(0, 'M')
  qr.addData(String(value))
  qr.make()
  const count = qr.getModuleCount()
  const size = (count + margin * 2) * cellSize
  const commands = []
  for (let row = 0; row < count; row += 1) {
    let runStart = -1
    for (let column = 0; column <= count; column += 1) {
      const dark = column < count && qr.isDark(row, column)
      if (dark && runStart < 0) runStart = column
      if (!dark && runStart >= 0) {
        const length = column - runStart
        commands.push(
          `M${(runStart + margin) * cellSize} ${(row + margin) * cellSize}h${length * cellSize}v${cellSize}h${-length * cellSize}z`,
        )
        runStart = -1
      }
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
    `<path d="${commands.join('')}" fill="#0b0c0e"/>`,
    '</svg>',
  ].join('')
}

// ---------------------------------------------------------------- transcripts

/**
 * Concatenate the text blocks of one message.
 * @param content - model-facing content blocks.
 * @returns visible text with blank blocks dropped.
 */
/**
 * Collect durable image references from one message's content parts.
 * @param content - message content blocks.
 * @returns the image attachment refs, in order.
 */
function imagesOf(content) {
  if (!Array.isArray(content)) return []
  const refs = []
  for (const block of content) if (block?.type === 'image' && block.attachment?.attachmentId !== undefined) refs.push(block.attachment)
  return refs
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/**
 * Concatenate reasoning blocks, kept separate so the app can collapse them.
 * @param content - model-facing content blocks.
 * @returns reasoning text, possibly empty.
 */
function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/**
 * Clamp one string to a display budget.
 * @param value - input text.
 * @param max - maximum characters.
 * @returns the text, truncated with an ellipsis marker.
 */
function clamp(value, max) {
  if (typeof value !== 'string') return ''
  return value.length <= max ? value : `${value.slice(0, max)}\n… (${value.length - max} 字符已省略)`
}

/**
 * Fold a durable session log into phone-sized message items.
 *
 * Tool calls are paired with their results by `callId`; synthetic user
 * messages (injected context, goal rounds, subagent notices) are skipped so
 * the transcript reads like the conversation the user actually had.
 *
 * @param events - raw events from `sessionQuery.readSession`.
 * @returns normalized items in event order plus the derived run state.
 */
export function normalizeEvents(events, options = {}) {
  const items = []
  const toolItems = new Map()
  let running = false
  for (const event of Array.isArray(events) ? events : []) {
    switch (event?.type) {
      case 'turn/start':
        running = true
        break
      case 'turn/end':
        running = false
        break
      case 'user/message': {
        // `user/message` carries the message directly; assistant and tool events
        // wrap theirs under `data.message`.
        const message = event.data?.message ?? event.data
        if (message?.source !== undefined && message.source?.kind !== 'user') break
        const body = textOf(message?.content)
        const images = imagesOf(message?.content)
        if (images.length > 0) {
          for (const ref of images) options.onImage?.(ref)
        }
        if (body !== '' || images.length > 0) {
          items.push({
            key: `u${event.seq}`,
            kind: 'user',
            seq: event.seq,
            time: event.time,
            text: clamp(body, MAX_TEXT_CHARS),
            ...(images.length === 0 ? {} : { images: images.map(ref => ({ id: String(ref.attachmentId), width: ref.width, height: ref.height, mediaType: ref.mediaType })) }),
          })
        }
        break
      }
      case 'assistant/message': {
        const message = event.data?.message
        const body = textOf(message?.content)
        const reasoning = reasoningOf(message?.content)
        const images = imagesOf(message?.content)
        for (const ref of images) options.onImage?.(ref)
        if (body !== '' || images.length > 0) {
          items.push({
            key: `a${event.seq}`,
            kind: 'assistant',
            seq: event.seq,
            time: event.time,
            text: clamp(body, MAX_TEXT_CHARS),
            ...(reasoning === '' ? {} : { reasoning: clamp(reasoning, MAX_TEXT_CHARS) }),
            ...(event.data?.interrupted === true ? { interrupted: true } : {}),
            ...(images.length === 0 ? {} : { images: images.map(ref => ({ id: String(ref.attachmentId), width: ref.width, height: ref.height, mediaType: ref.mediaType })) }),
          })
        }
        for (const block of Array.isArray(message?.content) ? message.content : []) {
          if (block?.type !== 'tool-call') continue
          const item = {
            key: `t${String(block.id ?? '') || event.seq}`,
            kind: 'tool',
            seq: event.seq,
            time: event.time,
            callId: String(block.id ?? ''),
            name: String(block.name ?? 'tool'),
            args: clamp(String(block.arguments ?? ''), MAX_TOOL_ARGS_CHARS),
          }
          items.push(item)
          toolItems.set(item.callId, item)
        }
        break
      }
      case 'tool/result': {
        const message = event.data?.message
        const callId = String(message?.toolCallId ?? '')
        const body = clamp(textOf(message?.content), MAX_TOOL_RESULT_CHARS)
        const resultImages = imagesOf(message?.content)
        for (const ref of resultImages) options.onImage?.(ref)
        const target = toolItems.get(callId)
        if (target !== undefined) {
          target.result = body
          if (resultImages.length > 0) {
            target.images = resultImages.map(ref => ({ id: String(ref.attachmentId), width: ref.width, height: ref.height, mediaType: ref.mediaType }))
          }
          target.isError = message?.isError === true
          if (event.data?.error?.reason !== undefined) target.error = String(event.data.error.reason)
          target.resultSeq = event.seq
        } else {
          items.push({
            key: `t${callId || event.seq}`,
            kind: 'tool',
            seq: event.seq,
            time: event.time,
            callId,
            name: 'tool',
            args: '',
            result: body,
            isError: message?.isError === true,
          })
        }
        break
      }
      default:
        break
    }
  }
  return { items, running }
}

/**
 * Read one session's title, falling back to its directory name.
 * @param ctx - Host context with `sessionQuery`.
 * @param sessionId - logical session id.
 * @returns title text, possibly empty.
 */
async function sessionTitle(ctx, sessionId) {
  try {
    const observation = await ctx.sessionQuery.readTitleSnapshot(sessionId)
    const value = observation?.value
    if (value !== undefined && typeof value.title?.title === 'string') return value.title.title
  } catch {
    // Titles are cosmetic.
  }
  return ''
}

// ---------------------------------------------------------------- bridge

/**
 * Cache of per-session last-activity instants, so sorting by recency does not
 * re-scan every stored log on each home-screen load.
 */
const activityCache = new Map()
/**
 * Durable image references seen while building transcripts, keyed
 * `sessionId:attachmentId`, so the image route can resolve one without
 * re-reading the whole log.
 */
const imageRefs = new Map()

/** Short-lived live status per session (running / pending interaction). */
const liveStateCache = new Map()
/**
 * Human interactions waiting for the phone: approvals and `ask_user_question`
 * calls. Module scope so the state document can list them; entries carry the
 * resolver the agent is awaiting.
 */
const pendingInteractions = new Map()
/**
 * Approval ids the bridge saw decided while it still held a card for them,
 * keyed `sessionId:approvalId` and stamped with the decision time. The home
 * status otherwise reads a cached session log that may predate the decision;
 * this remembers the `approval/decided` long enough to outlast that cache.
 */
const decidedElsewhere = new Map()
/** How long a decided approval suppresses the home status dot. */
const DECIDED_MEMORY_MS = 60_000
/** Remember one approval settled by a path other than the phone. */
function rememberDecision(sessionId, id) {
  const now = Date.now()
  decidedElsewhere.set(`${sessionId}:${id}`, now)
  for (const [key, at] of decidedElsewhere) if (now - at > DECIDED_MEMORY_MS) decidedElsewhere.delete(key)
}
/**
 * Whether the bridge already observed this session's approval being decided.
 * @param sessionId - logical session id.
 * @returns whether a recent decision was seen for that session.
 */
function settledAgain(sessionId) {
  const now = Date.now()
  for (const [key, at] of decidedElsewhere) {
    if (now - at > DECIDED_MEMORY_MS) continue
    if (key.startsWith(`${sessionId}:`)) return true
  }
  return false
}
/** Open `/m/api/events` streams, one per connected app instance. */
const eventWatchers = new Set()
/** Per-client transcript poll counters, to spot two viewports reading one session. */
const transcriptClients = new Map()
/**
 * Localized names for the built-in permission presets. Only consulted when the
 * Host's catalog carries no display name (it then reports the preset id), so a
 * profile that configures its own labels keeps them.
 */
const PRESET_LABELS = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
  auto: '自动',
  custom: '自定义',
}

/** Last app build reported by a client, so a stale bundle shows up in the log. */
let lastAppBuild = ''
/** Last skill-catalog summary, so the log gains one line per real change. */
let lastSkillNote = ''

/**
 * Read one session's latest event time and whether a human ever spoke in it.
 *
 * The desktop hides "blank" sessions (a New Session placeholder that never
 * received a prompt); the same test here keeps the phone list free of empty
 * rows. One `listEvents` pass answers both questions.
 *
 * @param ctx - Host context with `sessionQuery`.
 * @param sessionId - logical session id.
 * @param fallback - time used when the log cannot be read.
 * @returns `{ time, started }`.
 */
async function activityOf(ctx, sessionId, fallback) {
  const cached = activityCache.get(sessionId)
  if (cached !== undefined && Date.now() - cached.at < 60_000) return cached
  let time = fallback
  let started = false
  try {
    const records = await ctx.sessionQuery.listEvents(sessionId)
    for (const record of records) {
      if (record.type === 'user/message') started = true
      if (typeof record.time === 'number' && record.time > time) time = record.time
    }
  } catch {
    // Fall back to creation time; an unreadable log still gets a row.
    started = true
  }
  const value = { time, started, at: Date.now() }
  activityCache.set(sessionId, value)
  return value
}

/**
 * Build the workspace/session tree for the phone home screen.
 * @param ctx - Host context with `workspaceController` and `sessionQuery`.
 * @returns grouped sessions plus leftovers that belong to no workspace.
 */
export async function collectState(ctx) {
  const records = await ctx.sessionQuery.listSessions()
  const titles = new Map()
  try {
    const observed = await ctx.sessionQuery.readTitleSnapshots(records.map(record => record.header.id))
    for (const entry of observed) {
      if (entry.status === 'fulfilled') {
        const title = entry.value?.title?.title
        if (typeof title === 'string' && title !== '') titles.set(String(entry.sessionId), title)
      }
    }
  } catch {
    // Titles are cosmetic; ids and directories remain usable.
  }

  // Workspace inventory. The registry is the most direct source; the Remote
  // controller's `baseline()` is the documented consumer API and the fallback.
  /**
   * Read the workspace inventory from the most direct source available.
   * @returns `{ items, archivedIds, pinnedIds, source, error }`.
   */
  const inventory = () => {
    const result = { items: [], archivedIds: [], pinnedIds: [], source: 'none', error: undefined }
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry !== undefined) {
        result.items = registry.list().map(workspace => ({
          workspaceId: String(workspace.id),
          title: workspace.title,
          path: String(workspace.path ?? ''),
          sessionIds: [...workspace.sessionIds].map(String),
        }))
        result.archivedIds = [...registry.archivedSessionIds].map(String)
        result.pinnedIds = [...registry.pinnedSessionIds].map(String)
        result.source = 'registry'
      } else {
        const baseline = ctx.workspaceController.baseline()
        result.items = (baseline.items ?? []).map(item => ({
          workspaceId: String(item.workspaceId),
          title: item.title,
          path: String(item.path ?? ''),
          sessionIds: (item.sessionIds ?? []).map(String),
        }))
        result.archivedIds = (baseline.archivedSessionIds ?? []).map(String)
        result.pinnedIds = (baseline.pinnedSessionIds ?? []).map(String)
        result.source = 'controller'
      }
    } catch (caught) {
      result.error = caught instanceof Error ? caught.message : String(caught)
      ctx.logger?.warn?.(`dsh-pair: workspace inventory unavailable: ${result.error}`)
    }
    return result
  }

  let inventoryState = inventory()
  let { items, archivedIds, pinnedIds } = inventoryState
  let source = inventoryState.source
  let error = inventoryState.error
  const membershipOf = list => list.reduce((count, workspace) => count + workspace.sessionIds.length, 0)
  const membershipCount = membershipOf(items)
  const archived = new Set(archivedIds)
  const pinned = new Set(pinnedIds)
  const normalize = value => String(value ?? '').replace(/\/+$/u, '')

  /**
   * Live status of one session, in the desktop's vocabulary.
   *
   * - `running`: the last turn has no matching `turn/end`.
   * - `pending`: an `approval/asked` event without its `approval/decided` (and
   *   still answerable from this phone), or an open timed `ask_user_question`
   *   reported by the `userQuestions` projection.
   *
   * Only live sessions are inspected: a cold log can end mid-turn after a crash,
   * and the desktop likewise reports status from live state. Results are cached
   * for a few seconds because the home screen refetches on every visit.
   *
   * @param sessionId - logical session id.
   * @returns `{ running, pending }`.
   */
  const liveStateOf = async sessionId => {
    const cached = liveStateCache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < 5_000) return cached
    const value = { running: false, pending: null, at: Date.now() }
    try {
      const snapshot = await ctx.sessionQuery.readSession(sessionId)
      const asked = new Set()
      for (const event of snapshot.events ?? []) {
        if (event.type === 'turn/start') value.running = true
        else if (event.type === 'turn/end') value.running = false
        else if (event.type === 'approval/asked') asked.add(String(event.data?.id ?? ''))
        else if (event.type === 'approval/decided') asked.delete(String(event.data?.id ?? ''))
      }
      if (asked.size > 0) value.pending = 'approval'
    } catch {
      // A session that cannot be read simply has no status.
    }
    // A decision made by another answerer is not yet reflected in this cached
    // read, yet `session/event` has already told the bridge that the phone can
    // no longer answer it. The dot follows the live set, so it never points at
    // a decision the card cannot take.
    if (value.pending === 'approval') {
      const answerable = [...pendingInteractions.values()].some(entry => entry.kind === 'approval' && entry.sessionId === sessionId)
      if (!answerable) value.pending = settledAgain(sessionId) ? null : 'approval'
    }
    if (value.pending === null) {
      try {
        const live = ctx.get('sessions')?.get(sessionId)
        const projections = ctx.get('sessionProjections')
        if (live !== undefined && projections !== undefined) {
          const state = projections.stateOf(live, 'userQuestions')
          if ((state?.questions?.active?.length ?? 0) > 0) value.pending = 'question'
        }
      } catch {
        // The questions projection is optional.
      }
    }
    liveStateCache.set(sessionId, value)
    return value
  }

  // One row per visible session, with its activity and blank state.
  const rows = []
  await Promise.all(
    records.map(async record => {
      const id = String(record.header.id)
      if (archived.has(id)) return
      const header = record.header
      const activity = await activityOf(ctx, id, header.createdAt)
      if (activity.started === false) return
      const live = record.live === true
      const status = live ? await liveStateOf(id) : { running: false, pending: null }
      rows.push({
        id,
        title: titles.get(id) ?? '',
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        createdAt: header.createdAt,
        updatedAt: activity.time,
        live,
        running: status.running,
        pending: status.pending,
        pinned: pinned.has(id),
      })
    }),
  )

  /** Pinned first, then most recent activity — the desktop's default order. */
  const order = list =>
    list.sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        right.updatedAt - left.updatedAt ||
        right.createdAt - left.createdAt,
    )

  /**
   * Build the workspace list.
   *
   * Deliberately flat, in registry order: the desktop keeps every workspace at
   * the same level even when one path contains another, so `Projects` and
   * `Projects/idea/alma_study` are siblings, not parent and child.
   *
   * @returns `{ workspaces, loose }`.
   */
  const byWorkspace = () => {
    const byMember = new Map()
    for (const workspace of items) for (const id of workspace.sessionIds) byMember.set(id, workspace.workspaceId)
    const groups = new Map(
      items.map(workspace => [
        workspace.workspaceId,
        { id: workspace.workspaceId, title: workspace.title, path: workspace.path, sessions: [] },
      ]),
    )
    const loose = []
    for (const row of rows) {
      const owner = byMember.get(row.id)
      const group = owner === undefined ? undefined : groups.get(owner)
      if (group === undefined) loose.push(row)
      else group.sessions.push(row)
    }
    // Every registered workspace is listed, including one whose sessions are all
    // archived or blank — the desktop renders those as empty folders.
    return {
      workspaces: [...groups.values()].map(group => ({ ...group, sessions: order(group.sessions) })),
      loose: order(loose),
    }
  }

  /**
   * Last-resort grouping by working directory, used only when the registry
   * reports no members at all. Flat on purpose: without membership data, path
   * nesting would invent parents the desktop never shows.
   */
  const byDirectory = () => {
    const groups = new Map()
    const loose = []
    for (const row of rows) {
      const cwd = normalize(row.cwd)
      if (cwd === '') {
        loose.push(row)
        continue
      }
      const group = groups.get(cwd) ?? { id: `cwd:${cwd}`, title: basenameOf(cwd) || cwd, path: cwd, parentId: null, sessions: [] }
      group.sessions.push(row)
      groups.set(cwd, group)
    }
    return {
      workspaces: [...groups.values()].map(group => ({ ...group, sessions: order(group.sessions) })),
      loose: order(loose),
    }
  }

  const result = membershipCount > 0 ? byWorkspace() : byDirectory()
  const mode = membershipCount > 0 ? 'workspace' : 'cwd'

  if (mode === 'cwd' && rows.length > 0) {
    ctx.logger?.warn?.(
      `dsh-pair: workspace registry reported ${items.length} workspace(s) with 0 members; grouped ${rows.length} session(s) by directory`,
    )
  }

  const pending = [...pendingInteractions.values()].map(({ resolve, ...rest }) => ({
    ...rest,
    title: titles.get(rest.sessionId) ?? '',
  }))

  return {
    workspaces: result.workspaces,
    loose: result.loose,
    pending,
    archivedCount: archived.size,
    groupedBy: mode,
    diagnostics: {
      source,
      workspaces: items.length,
      members: membershipCount,
      sessions: rows.length,
      ...(error === undefined ? {} : { error }),
    },
  }
}

/**
 * Last path segment, used to title directory-derived groups.
 * @param value - absolute path.
 * @returns the final segment.
 */
function basenameOf(value) {
  const parts = String(value ?? '').split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/**
 * Read one session transcript for the phone.
 * @param ctx - Host context with `sessionQuery`.
 * @param sessionId - logical session id.
 * @param afterSeq - only return items newer than this event seq.
 * @param answerable - interactions this phone can actually answer right now.
 * @returns transcript payload.
 */
export async function readTranscript(ctx, sessionId, afterSeq, answerable = []) {
  const snapshot = await ctx.sessionQuery.readSession(sessionId)
  const { items, running } = normalizeEvents(snapshot.events, {
    onImage: ref => imageRefs.set(`${sessionId}:${String(ref.attachmentId)}`, ref),
  })
  const events = Array.isArray(snapshot.events) ? snapshot.events : []
  const logCursor = events.length > 0 ? Number(events[events.length - 1].seq) : 0
  const cursor = Number.isFinite(afterSeq) && afterSeq > 0 ? afterSeq : 0
  const selected =
    cursor > 0
      ? items.filter(item => item.seq > cursor || (typeof item.resultSeq === 'number' && item.resultSeq > cursor))
      : items.slice(-TRANSCRIPT_TAIL_ITEMS)
  const header = snapshot.session
  const recent = events[events.length - 1]
  return {
    id: sessionId,
    title: await sessionTitle(ctx, sessionId),
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: header.createdAt,
    running,
    inheritedEventCount: snapshot.inheritedEventCount ?? 0,
    lastSeq: logCursor,
    firstSeq: selected.length > 0 ? selected[0].seq : 0,
    truncated: cursor === 0 && items.length > TRANSCRIPT_TAIL_ITEMS,
    items: selected.slice(0, TRANSCRIPT_MAX_ITEMS),
    // Last log event time, not the last rendered item: the list's unread state
    // compares against this value, and tool results advance it without adding
    // a visible row.
    updatedAt: typeof recent?.time === 'number' ? recent.time : header.createdAt,
    // Always present, empty included: the app replaces its card list with this,
    // so an answered request must arrive as `[]` rather than as a missing key
    // (a missing key would leave the old card on screen).
    pending: answerable.map(({ resolve, ...rest }) => rest),
  }
}

/**
 * Deliver one prompt into a session, resuming it when cold.
 * @param ctx - Host context with `sessionController`.
 * @param sessionId - target session.
 * @param body - prompt text.
 * @returns receipt payload.
 */
async function sendPrompt(ctx, sessionId, body) {
  const content = String(body?.text ?? '').trim()
  const images = Array.isArray(body?.images) ? body.images : []
  if (content === '' && images.length === 0) {
    const error = new Error('消息不能为空')
    error.status = 400
    throw error
  }
  if (content.length > 32_000) {
    const error = new Error('消息过长（上限 32000 字符）')
    error.status = 400
    throw error
  }
  const parts = content === '' ? [] : [{ type: 'text', text: content }]
  let budget = 12_000_000
  for (const image of images) {
    const mediaType = String(image?.mediaType ?? '')
    const data = String(image?.data ?? '')
    if (!IMAGE_MEDIA_TYPES.has(mediaType) || data === '') {
      const error = new Error('不支持的图片格式')
      error.status = 400
      throw error
    }
    budget -= data.length
    if (budget < 0) {
      const error = new Error('图片总大小超过限制（约 9MB）')
      error.status = 400
      throw error
    }
    parts.push({ type: 'image', mediaType, data })
  }
  const controller = ctx.sessionController
  if (controller === undefined) {
    const error = new Error('当前 profile 没有装载会话控制器')
    error.status = 503
    throw error
  }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROMPT_TIMEOUT_MS)
  try {
    try {
      await controller.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: parts,
        },
        abort.signal,
      )
    } catch (error) {
      if (String(error?.reason ?? '').includes('MODEL_DOES_NOT_SUPPORT_IMAGES') || /image input/i.test(String(error?.message ?? ''))) {
        const friendly = new Error('当前模型不支持图片输入，先换一个支持图片的模型再发')
        friendly.status = 400
        throw friendly
      }
      throw error
    }
    return { accepted: true }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the Host to stop the active turn of one session.
 * @param ctx - Host context with `sessionController`.
 * @param sessionId - target session.
 * @returns receipt payload.
 */
async function cancelTurn(ctx, sessionId) {
  const controller = ctx.sessionController
  if (controller === undefined) {
    const error = new Error('当前 profile 没有装载会话控制器')
    error.status = 503
    throw error
  }
  await controller.cancel({ sessionId })
  return { accepted: true }
}

// ---------------------------------------------------------------- static app

/**
 * Serve one file from the configured app directory.
 * @param request - incoming request.
 * @param response - Node response.
 * @param appDir - absolute app directory.
 * @param pathname - URL pathname beginning with `/m/`.
 * @returns whether a file was served.
 */
async function serveAppFile(request, response, appDir, pathname) {
  const relative = pathname === APP_ROOT || pathname === `${APP_ROOT}/` ? '' : pathname.startsWith(`${APP_ROOT}/`) ? pathname.slice(APP_ROOT.length + 1) : undefined
  if (relative === undefined) return false
  const decoded = decodeURIComponent(relative === '' ? 'index.html' : relative)
  const target = resolvePath(appDir, decoded)
  if (!target.startsWith(`${appDir}${sep}`) && target !== appDir) return false
  let info
  try {
    info = await stat(target)
  } catch {
    return false
  }
  if (!info.isFile()) return false
  const body = await readFile(target)
  const type = MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream'
  const headers = {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  }
  if (type.startsWith('text/html')) {
    headers['content-security-policy'] = CONTENT_SECURITY_POLICY
    headers['referrer-policy'] = 'no-referrer'
  }
  response.writeHead(200, headers)
  if (request.method === 'HEAD') response.end()
  else response.end(body)
  return true
}

// ---------------------------------------------------------------- plugin

/**
 * Services this plugin needs before it starts.
 *
 * Cordis throws on reading an undeclared service (`cannot get property ...
 * without inject`), so every service the bridge touches must be listed here —
 * `workspaceController` and `sessionController` included.
 */
export const inject = ['webServer', 'sessionQuery', 'connection', 'workspaceController', 'sessionController']

/**
 * Mount pairing, the mobile bridge, and app hosting.
 * @param ctx - Host plugin context.
 * @param rawConfig - the Loader row's configuration.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const appDir = appDirectory(config.appDir)
  const pairing = new Pairing({
    ttlMs: config.pairTtlMinutes * 60_000,
    cookieDays: config.cookieDays,
    maxDevices: config.maxDevices,
    storePath: config.storePath,
  })

  /**
   * Push the current pending interactions to every connected app instance.
   *
   * The home screen cannot wait for its 5 s poll: a desktop answerer resolves
   * the request long before that. This stream makes the card appear as soon as
   * the request exists.
   */
  const notifyPending = () => {
    const pending = [...pendingInteractions.values()].map(({ resolve, ...rest }) => rest)
    const frame = `event: pending\ndata: ${JSON.stringify({ pending })}\n\n`
    if (config.debug) console.log(`dsh-pair: push pending=${pending.map(entry => `${entry.id}:${entry.kind}`).join(',') || '-'} to ${String(eventWatchers.size)} app(s)`)
    for (const response of eventWatchers) {
      try {
        response.write(frame)
      } catch {
        eventWatchers.delete(response)
      }
    }
  }

  /** How long a phone may hold an approval before the ask fails closed. */
  const INTERACTION_WAIT_MS = 180_000

  /**
   * Resolve the first usable answer: phone or the desktop answerer.
   *
   * The desktop chain runs concurrently; "no answerer" style outcomes are
   * treated as no opinion so a connected phone can still decide.
   *
   * Once the desktop chain hands back a decision the card stops being
   * answerable, so the entry leaves `pendingInteractions` *before* waiting on
   * that decision's bookkeeping. Otherwise a phone polling at that instant
   * still sees an answerable card whose POST finds nothing.
   *
   * @param entry - interaction record registered in `pendingInteractions`.
   * @param desktop - promise of the downstream (desktop) outcome.
   * @param signal - cancellation owned by the asking tool.
   * @param emptyValue - value used when nobody answered.
   * @param onSettled - releases a not-yet-started desktop chain.
   * @returns the winning value.
   */
  const awaitInteraction = (entry, desktop, signal, emptyValue, onSettled) =>
    new Promise(resolve => {
      let settled = false
      const withdraw = () => {
        if (pendingInteractions.get(entry.id) !== entry) return false
        pendingInteractions.delete(entry.id)
        notifyPending()
        return true
      }
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Whoever settles the request also withdraws it: `withdraw` is the only
        // place that pushes, so a card is never pushed twice for one state.
        withdraw()
        onSettled?.()
        resolve(value)
      }
      const timer = setTimeout(() => finish(emptyValue), INTERACTION_WAIT_MS)
      timer.unref?.()
      entry.resolve = value => finish(value)
      pendingInteractions.set(entry.id, entry)
      notifyPending()
      // A cancelled or timed-out ask is no longer answerable either; `finish`
      // withdraws the card in every case.
      signal?.addEventListener('abort', () => finish(emptyValue), { once: true })
      desktop.then(
        value => {
          if (value !== 'unavailable') finish(value)
        },
        () => {},
      )
    })

  /**
   * Whether the phone should be offered a decision.
   *
   * A watcher means someone is looking at this exact session. Otherwise a
   * recently active device still gets the request, so the home screen can show
   * it and the user can open the session; a phone that has been idle for
   * minutes does not stall the agent.
   *
   * @param sessionId - session the request belongs to.
   * @returns whether to race the phone answerer.
   */
  const shouldOfferPhone = sessionId => watchers.get(sessionId) !== undefined

  /**
   * Log one offer decision so a failed delivery can be diagnosed from web.log.
   * @param kind - interaction kind.
   * @param sessionId - target session.
   * @param offered - whether the phone was given the request.
   */
  const traceOffer = (kind, sessionId, offered) => {
    const now = Date.now()
    const ages = [...pairing.devices.values()].map(device => `${device.label}:${Math.round((now - device.lastSeenAt) / 1000)}s`).join(',')
    // console.log lands in dsh web's log; ctx.logger.info is not persisted there.
    if (!config.debug) return
    console.log(
      `dsh-pair: ${kind} for ${sessionId} offered=${String(offered)} watchers=${String(watchers.get(sessionId)?.size ?? 0)} devices=${String(pairing.devices.size)} ages=${ages === '' ? '-' : ages}`,
    )
  }

  /**
   * Start the desktop chain, or keep it off the screen while the phone answers.
   *
   * The hold applies only while the phone can actually answer: someone is
   * watching the session and `phoneOnlyMs` leaves a window. If the phone
   * answers first, the desktop chain never starts — nothing is left open to
   * clean up. If the phone stays silent, the desktop dialog appears late
   * rather than the ask failing closed.
   *
   * A hold while the phone has no answerable card would be worse than no hold:
   * the desktop would stay silent until the window expired, and a request
   * whose card was already withdrawn (decided elsewhere, cancelled, expired)
   * would then open a dialog nobody is waiting for. So the window is only
   * granted for a session with a live watcher.
   *
   * With `phoneOnlyMs: 0` (the default) both devices show the request at once
   * and the first answer wins, exactly like the desktop's own answerers.
   *
   * @param sessionId - session the request belongs to.
   * @param entry - interaction record about to be registered.
   * @param next - downstream waterfall step.
   * @returns `{ desktop, cancel }`; `cancel` stops a not-yet-started desktop chain.
   */
  const phoneFirst = (sessionId, entry, next) => {
    const watching = watchers.get(sessionId) !== undefined
    // A hold window the phone can never answer is worse than no hold at all:
    // the desktop would sit silent and then open a dialog nobody is waiting for.
    if (!watching || config.phoneOnlyMs <= 0) return { desktop: Promise.resolve().then(() => next()), cancel: () => {} }
    let timer
    const desktop = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        Promise.resolve()
          .then(() => next())
          .then(resolve, reject)
      }, config.phoneOnlyMs)
      timer.unref?.()
    })
    return { desktop, cancel: () => clearTimeout(timer) }
  }

  /**
   * Approvals: let the phone decide when someone is watching that session.
   * Registered with `prepend` so the request is visible before the desktop
   * bridge can claim it.
   */
  const onApprovalRequest = async (req, next) => {
    const sessionId = String(req.agent?.session?.id ?? '')
    const offered = sessionId !== '' && shouldOfferPhone(sessionId)
    traceOffer('approval', sessionId, offered)
    if (!offered) return next()
    const id = String(req.id ?? `${sessionId}:${String(req.callId ?? '')}:${Date.now()}`)
    const entry = {
      id,
      kind: 'approval',
      sessionId,
      toolName: String(req.toolName ?? 'tool'),
      callId: req.callId === undefined ? undefined : String(req.callId),
      reason: String(req.reason ?? ''),
      createdAt: Date.now(),
    }
    const chain = phoneFirst(sessionId, entry, next)
    const desktop = chain.desktop.catch(() => 'unavailable')
    return awaitInteraction(entry, desktop, req.signal, 'unavailable', chain.cancel)
  }

  /**
   * Timed questions: let the phone answer when someone is watching that session.
   * The desktop chain keeps its chance; its "no answerer" rejection is preserved
   * when the phone also declines, because the tool's timeout handling depends on
   * that error type.
   */
  const onQuestionRequest = async (request, next) => {
    const sessionId = String(request.agent?.session?.id ?? '')
    const offered = sessionId !== '' && shouldOfferPhone(sessionId)
    traceOffer('question', sessionId, offered)
    if (!offered) return next()
    // Timed questions carry `wait.callId`; a blocking `ask()` (no timeout
    // parameter) carries none, but is still answerable — synthesize an id so the
    // card can key itself and the POST can find the entry.
    const callId = String(request.wait?.callId ?? '')
    const entry = {
      id: callId === '' ? `q:${sessionId}:${Date.now()}` : `q:${callId}`,
      kind: 'question',
      sessionId,
      callId,
      questions: (request.questions ?? []).map(question => ({
        id: String(question.id),
        question: String(question.question ?? ''),
        detail: question.detail === undefined ? undefined : String(question.detail),
        header: question.header === undefined ? undefined : String(question.header),
        multiSelect: question.multiSelect === true,
        options: (question.options ?? []).map(option => ({
          label: String(option.label ?? ''),
          description: option.description === undefined ? undefined : String(option.description),
        })),
      })),
      createdAt: Date.now(),
    }
    let desktopError
    const chain = phoneFirst(sessionId, entry, next)
    const desktop = chain.desktop.catch(error => {
      desktopError = error
      throw error
    })
    const answer = await awaitInteraction(entry, desktop, request.signal, undefined, chain.cancel)
    if (answer !== undefined) return answer
    if (desktopError !== undefined) throw desktopError
    throw new Error('no user-questions answerer accepted the request')
  }

  ctx.effect(
    () => ctx.on('approval/request', onApprovalRequest, { global: true, prepend: true }),
    'dsh-pair: approval answerer',
  )
  ctx.effect(
    () => ctx.on('user-questions/request', onQuestionRequest, { global: true, prepend: true }),
    'dsh-pair: question answerer',
  )

  /**
   * Process-local assistant text for in-flight attempts, keyed by session id.
   *
   * Durable logs only carry an assistant message once the step settles, so a
   * phone reading `readSession` alone would sit silent for the whole model
   * call. `agent/assistant-stream` publishes every chunk before settlement;
   * this registry folds those chunks and fans them out to SSE subscribers.
   */
  const liveStreams = new Map()
  /** session id → set of open SSE responses. */
  const watchers = new Map()

  /**
   * Project one live attempt for a late joiner or a polling client.
   * @param sessionId - logical session id.
   * @returns snapshot, or undefined when nothing is in flight.
   */
  const liveSnapshot = sessionId => {
    const entry = liveStreams.get(sessionId)
    if (entry === undefined) return undefined
    return {
      attemptId: entry.attemptId,
      turn: entry.turn,
      step: entry.step,
      text: entry.text,
      reasoning: entry.reasoning,
      tools: [...entry.tools.values()],
      revision: entry.revision,
    }
  }

  /**
   * Write one SSE frame to every watcher of a session.
   * @param sessionId - logical session id.
   * @param payload - JSON-serializable frame; `payload.type` becomes the event name.
   */
  const broadcastFrame = (sessionId, payload) => {
    const set = watchers.get(sessionId)
    if (set === undefined || set.size === 0) return
    const frame = `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const response of set) {
      try {
        response.write(frame)
      } catch {
        set.delete(response)
      }
    }
  }

  /**
   * Fold one `agent/assistant-stream` frame into the live registry.
   * @param payload - the Host event payload.
   */
  const onAssistantStream = ({ agent, frame }) => {
    // `agent.session.id` is the runtime identity; `agent.id` is the same value
    // on older surfaces, so fall back for forward compatibility.
    const sessionId = String(agent?.session?.id ?? agent?.id ?? '')
    if (sessionId === '' || frame === undefined || frame === null) return
    let entry = liveStreams.get(sessionId)
    if (frame.type === 'start') {
      entry = { attemptId: frame.attemptId, revision: frame.revision, turn: frame.turn, step: frame.step, text: '', reasoning: '', tools: new Map(), timer: null }
      liveStreams.set(sessionId, entry)
      broadcastFrame(sessionId, { type: 'start', attemptId: frame.attemptId, turn: frame.turn, step: frame.step })
      return
    }
    if (entry === undefined || entry.attemptId !== frame.attemptId) {
      // A chunk without an observed start (listener attached mid-attempt).
      if (frame.type !== 'chunk') return
      entry = { attemptId: frame.attemptId, revision: frame.revision, turn: 0, step: 0, text: '', reasoning: '', tools: new Map(), timer: null }
      liveStreams.set(sessionId, entry)
    }
    if (frame.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        entry.text += chunk.text
        broadcastFrame(sessionId, { type: 'text', text: chunk.text })
      } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        entry.reasoning += chunk.text
        broadcastFrame(sessionId, { type: 'reasoning', text: chunk.text })
      } else if (chunk?.type === 'tool-call-delta') {
        const callId = String(chunk.id ?? '')
        const tool = entry.tools.get(callId) ?? { callId, name: '', args: '' }
        if (typeof chunk.name === 'string' && chunk.name !== '') tool.name = chunk.name
        if (typeof chunk.argumentsDelta === 'string') tool.args += chunk.argumentsDelta
        entry.tools.set(callId, tool)
        broadcastFrame(sessionId, { type: 'tool', callId, name: tool.name, args: chunk.argumentsDelta ?? '' })
      }
      entry.revision = frame.revision
      return
    }
    if (frame.type === 'end') {
      broadcastFrame(sessionId, { type: 'end', outcome: frame.outcome })
      // Keep the preview briefly: the durable event lands before this frame,
      // but the phone may still be one poll behind.
      const stale = entry
      stale.timer = setTimeout(() => {
        if (liveStreams.get(sessionId) === stale) liveStreams.delete(sessionId)
      }, 4000)
      stale.timer.unref?.()
    }
  }

  /**
   * Drop decided approvals from the phone, whoever decided.
   *
   * The Host writes `approval/asked` *before* it runs any answerer, so the
   * desktop dialog and the phone card always appear together. When the
   * desktop (or an auto-decision) settles the waterfall first, nothing on the
   * phone side would ever learn about it: `awaitInteraction` only sees its own
   * outcome, and the desktop chain is already settled. The matching
   * `approval/decided` is the readable signal, so the card goes away with it.
   *
   * @param payload - `{ sessionId, event }` from the session log observer.
   */
  const onSessionEvent = payload => {
    const event = payload?.event
    if (event?.type !== 'approval/decided') return
    const sessionId = String(payload.sessionId ?? '')
    const id = String(event.data?.id ?? '')
    const entry = pendingInteractions.get(id)
    if (entry === undefined || entry.kind !== 'approval' || (sessionId !== '' && entry.sessionId !== sessionId)) return
    rememberDecision(entry.sessionId, id)
    entry.resolve('unavailable')
  }

  // `global: true` is required: agent events are dispatched through the
  // agent's scope carrier, and a scoped listener would never see them.
  ctx.effect(() => ctx.on('agent/assistant-stream', onAssistantStream, { global: true }), 'dsh-pair: assistant stream')
  ctx.effect(() => ctx.on('session/event', onSessionEvent, { global: true }), 'dsh-pair: approval settled elsewhere')
  ctx.effect(
    () =>
      ctx.on(
        'agent/disposed',
        ({ agent }) => {
          const sessionId = String(agent?.session?.id ?? agent?.id ?? '')
          if (sessionId !== '') liveStreams.delete(sessionId)
        },
        { global: true },
      ),
    'dsh-pair: live cleanup',
  )

  /**
   * Build the pairing document for the Desktop page.
   * @param rotate - force a fresh token.
   * @param appReady - whether the configured app directory currently serves an index.
   * @returns pairing payload.
   */
  const pairDocument = (rotate, appReady) => {
    const token = pairing.rotate(rotate)
    const origin = (() => {
      try {
        return ctx.webServer.getOrigin()
      } catch {
        return `http://${ctx.webServer.host}:${ctx.webServer.port}`
      }
    })()
    const url = `${origin}${APP_ROOT}/?t=${encodeURIComponent(token)}`
    return {
      url,
      origin,
      token,
      expiresAt: pairing.expiresAt,
      ttlMs: pairing.ttlMs,
      svg: renderQrSvg(url),
      boundHost: ctx.webServer.host,
      protocol: ctx.webServer.protocol,
      devices: pairing.list(),
      appDir,
      appReady,
      loopback: isLoopbackHost(ctx.webServer.host),
      // When the listener is loopback-only a phone cannot reach it, and the QR
      // would encode `127.0.0.1`. The Desktop page then needs to tell the user
      // the exact command to run — including which address to name — instead of
      // making them discover their own LAN IP.
      lanAddresses: isLoopbackHost(ctx.webServer.host) ? lanAddresses() : [],
      bindCommand: isLoopbackHost(ctx.webServer.host) ? bindCommand(ctx.webServer.port) : '',
    }
  }

  /**
   * Reject a desktop endpoint request unless it carries this Harness origin's
   * browser authentication (the same admission `/api` uses).
   * @param request - incoming request.
   * @param response - Node response.
   * @returns whether the request may proceed.
   */
  const admitDesktop = (request, response) => {
    let admission
    try {
      admission = ctx.connection.admit(request)
    } catch {
      admission = { rejection: 403 }
    }
    if ('rejection' in admission) {
      sendText(response, admission.rejection, admission.rejection === 401 ? 'unauthorized' : 'forbidden')
      return false
    }
    return true
  }

  /**
   * Guard one bridge request with the device cookie.
   * @param request - incoming request.
   * @param response - Node response.
   * @returns the device, or `undefined` after a 401 was written.
   */
  const admitDevice = (request, response) => {
    const device = pairing.deviceFrom(request)
    if (device === undefined) {
      sendJson(response, 401, { error: 'unpaired', message: '此设备尚未配对或已被撤销' })
      return undefined
    }
    return device
  }

  /**
   * Dispatch `/m/api/*`.
   * @param request - incoming request.
   * @param response - Node response.
   * @param pathname - request path.
   */
  /**
   * Everything the phone needs to render the session-settings sheet: models,
   * permission presets, token usage, and the user-invocable skills.
   * @param sessionId - target session.
   * @returns the sheet payload; unavailable parts come back empty.
   */
  const sessionMeta = async sessionId => {
    const live = ctx.get('sessions')?.get?.(sessionId)
    const models = []
    const llm = ctx.get('llm')
    if (llm !== undefined) {
      for (const provider of llm.listProviders()) {
        const list = await Promise.resolve(llm.listModels(provider.id)).catch(() => [])
        for (const model of list) {
          models.push({
            provider: provider.id,
            id: model.id,
            name: model.name,
            description: model.description ?? '',
            images: Array.isArray(model.inputModalities) ? model.inputModalities.includes('image') : false,
          })
        }
      }
    }
    // The selection the NEXT request will use, which is what the desktop shows:
    // a model picked in the sheet (`pending`) outranks the last recorded request
    // (`lastUsed`). Service access goes through `ctx.get`: the plugin does not
    // inject `sessionProjections`, and property access would throw and silently
    // report "no model", leaving every row in the picker unmarked.
    let model = null
    const projections = ctx.get('sessionProjections')
    if (live !== undefined && projections !== undefined) {
      try {
        const selection = projections.stateOf(live, 'modelSelection')
        const next = selection?.pending ?? selection?.lastUsed
        if (next !== undefined && next !== null) {
          model = {
            provider: String(next.provider),
            model: String(next.model),
            // The reasoning effort travels with the selection; the thinking
            // control reads it back rather than guessing from the default.
            ...(next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) }),
          }
        }
      } catch {
        // Projection unavailable: fall through to the process default.
      }
    }
    if (model === null) {
      try {
        const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
        if (fallback !== undefined && fallback !== null) {
          model = {
            provider: String(fallback.provider),
            model: String(fallback.model),
            ...(fallback.reasoningEffort === undefined ? {} : { reasoningEffort: String(fallback.reasoningEffort) }),
          }
        }
      } catch {
        // No default surface: the picker simply marks nothing.
      }
    }
    if (model === null) {
      // A recorded request header is the durable truth for a session whose
      // projection predates this process.
      try {
        const header = live?.requestHeader?.()
        const config = header?.config
        if (config !== undefined) {
          model = {
            provider: String(config.provider),
            model: String(config.model),
            ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.reasoningEffort) }),
          }
        }
      } catch {
        // Header unavailable: keep the null model.
      }
    }
    const currentModel = model === null ? null : models.find(item => item.provider === model.provider && item.id === model.model)
    const supportsImages = currentModel === undefined || currentModel === null ? true : currentModel.images === true
    // Reasoning metadata belongs to one exact provider/model route and the
    // catalog listing does not carry it — only `resolveModelInfo` does. For this
    // Host the lookup is a synchronous config read behind a promise, so the
    // picker can afford one per row: that is what lights the `thinking` badge,
    // and the current route's own entry also feeds the thinking control.
    let reasoning = null
    if (llm !== undefined && typeof llm.resolveModelInfo === 'function') {
      await Promise.all(
        models.map(async item => {
          try {
            const info = await llm.resolveModelInfo(item.provider, item.id)
            const efforts = info?.reasoning?.efforts
            item.thinking = Array.isArray(efforts) && efforts.length > 0
            const isCurrent = model !== null && model.provider === item.provider && model.model === item.id
            if (!isCurrent || !item.thinking) return
            reasoning = {
              efforts: efforts.map(effort => ({
                id: String(effort.id),
                name: String(effort.name ?? effort.id),
                description: effort.description === undefined ? '' : String(effort.description),
              })),
              ...(info.reasoning.defaultEffort === undefined ? {} : { default: String(info.reasoning.defaultEffort) }),
            }
          } catch {
            // A route that cannot describe itself simply has no badge.
            item.thinking = false
          }
        }),
      )
    }
    const permissions = []
    let permission = null
    const presets = ctx.get('permissionPresets')
    if (presets !== undefined) {
      try {
        for (const option of presets.catalog().options) {
          permissions.push({
            value: option.value,
            // A preset configured without a display name reports its own id
            // (`read-only`, `workspace-write`, …). The desktop localizes those,
            // so translate the built-ins here rather than showing raw slugs in
            // an otherwise Chinese sheet; a configured name always wins.
            name: option.name === option.value ? (PRESET_LABELS[option.value] ?? option.name) : option.name,
            description: option.description ?? '',
          })
        }
        if (live !== undefined) permission = presets.current(live)
      } catch {
        // Catalog unavailable: the sheet simply shows nothing to choose.
      }
    }
    // Context follows the desktop's composer meter, which reads two projections:
    // `contextPressure` for occupancy and `contextBreakdown` for the composition
    // bar. `tokenMeter` stays as the fallback for a session whose projections
    // have not been sampled yet.
    let context = null
    const meter = ctx.get('tokenMeter')
    if (meter !== undefined && live !== undefined) {
      try {
        const measurement = meter.measure(live)
        context = { total: measurement.totalTokens, surface: measurement.surfaceTokens }
      } catch {
        context = null
      }
    }
    if (live !== undefined && projections !== undefined) {
      try {
        const pressure = projections.stateOf(live, 'contextPressure')
        const composition = projections.stateOf(live, 'contextBreakdown')
        // `stateOf` returns the projection's RAW state, not the client wire
        // view: the breakdown therefore sits one level down at `state.breakdown`
        // (reading `state.systemTokens` silently yields zeros), and
        // `projectedTokens` is a wire-only derivation this side has to redo.
        const projected =
          pressure?.pressureTokens !== undefined && pressure?.sampledSurfaceTokens !== undefined
            ? Math.max(0, pressure.pressureTokens + (pressure.surfaceTokens ?? 0) - pressure.sampledSurfaceTokens)
            : undefined
        const used = projected ?? pressure?.pressureTokens
        const window = pressure?.contextWindow
        const parts = composition?.breakdown ?? composition
        if (used !== undefined) {
          context = {
            ...(context ?? {}),
            used,
            ...(window === undefined ? {} : { window }),
            ...(window === undefined ? {} : { percent: Math.min(100, Math.round((used / window) * 100)) }),
            breakdown: {
              system: Number(parts?.systemTokens ?? 0),
              tools: Number(parts?.toolsTokens ?? 0),
              messages: Number(parts?.messageTokens ?? 0),
            },
          }
        }
      } catch {
        // Projections missing: the tokenMeter figures above still render.
      }
    }
    // The slash palette needs the authoritative command catalog for this agent.
    // Skills are NOT commands (they are prompt-side `/name` tokens expanded by
    // the skill tool's pre-step hook), so they travel separately and the caller
    // merges both lists.
    const commands = []
    const commandService = ctx.get('commands')
    const agent = ctx.get('agents')?.get?.(sessionId)
    if (commandService !== undefined && agent !== undefined) {
      try {
        for (const command of commandService.list(agent)) {
          commands.push({
            name: String(command.name),
            description: String(command.description ?? ''),
            ...(typeof command.input?.hint === 'string' ? { hint: command.input.hint } : {}),
          })
        }
      } catch {
        // No registry: the palette simply lists skills only.
      }
    }
    const skills = []
    // Resolve the registry the way the desktop's own skill catalog does: an
    // agent preset may mount its OWN `skills` service, and that is the one
    // carrying the session's user skills. Reading the root service alone
    // reports just the host/bundled set — the "only the official ones" symptom.
    const skillService = (() => {
      if (agent !== undefined) {
        try {
          const scoped = ctx.get('agentPresets')?.serviceFor?.(agent, 'skills')
          if (scoped !== undefined && scoped !== null) return scoped
        } catch {
          // Preset registry unavailable: fall back to the root service.
        }
      }
      return ctx.get('skills')
    })()
    if (skillService !== undefined) {
      try {
        // The catalog is scoped data: without `cwd` the filesystem provider skips
        // every project root (`.dsh/skills`, `.agents/skills`), and without
        // `scope` the agent-scoped layers are invisible. Calling `list()` bare
        // therefore reports a subset — which is what made the phone's palette
        // look like it only had the bundled commands.
        const cwd =
          agent === undefined
            ? undefined
            : (ctx.get('workingDirectory')?.get?.(agent.session) ?? agent.session?.header?.cwd)
        const catalog = await skillService.list({
          ...(cwd === undefined || cwd === null ? {} : { cwd }),
          ...(agent === undefined ? {} : { scope: agent }),
        })
        for (const skill of catalog) {
          if (skill.invocation?.userInvocable === false) continue
          skills.push({ name: skill.name, description: skill.description ?? '' })
        }
        // Always logged when the counts change: this is the one line that says
        // whether the catalog came from the preset registry and how much it saw.
        const note = `skills=${String(skills.length)}/${String(catalog.length)} cwd=${String(cwd ?? '-')} preset=${String(agent !== undefined && skillService !== ctx.get('skills'))}`
        if (note !== lastSkillNote) {
          lastSkillNote = note
          console.log(`dsh-pair: meta ${note}`)
        }
      } catch (error) {
        // No catalog: the palette simply lists commands only.
        if (config.debug) console.log(`dsh-pair: skill catalog unavailable: ${String(error?.message ?? error)}`)
      }
    }
    return { model, models, supportsImages, reasoning, permission, permissions, context, commands, skills }
  }

  const handleApi = async (request, response, pathname) => {
    const route = pathname.startsWith(`${API_ROOT}/`) ? pathname.slice(API_ROOT.length + 1) : ''
    const method = request.method ?? 'GET'

    if (route === 'pair' && method === 'POST') {
      if (!pairing.allowAttempt(request.socket?.remoteAddress ?? '')) {
        sendJson(response, 429, { error: 'too-many-attempts', message: '尝试过于频繁，请稍后再试' })
        return
      }
      const body = await readJson(request)
      if (!pairing.accepts(body?.token)) {
        sendJson(response, 403, { error: 'invalid-token', message: '二维码已失效，请在电脑上刷新' })
        return
      }
      const device = pairing.issue(request)
      const secure = ctx.webServer.protocol === 'https:'
      sendJson(
        response,
        200,
        { ok: true, device: { id: device.id, label: device.label } },
        {
          'set-cookie': [
            `${DEVICE_COOKIE}=${encodeURIComponent(pairing.cookieValue(device))}`,
            'Path=/m',
            'HttpOnly',
            'SameSite=Lax',
            `Max-Age=${Math.floor(config.cookieDays * 86_400)}`,
            ...(secure ? ['Secure'] : []),
          ].join('; '),
        },
      )
      return
    }

    if (route === 'unpair' && method === 'POST') {
      const device = pairing.deviceFrom(request)
      if (device !== undefined) pairing.revoke(device.id)
      sendJson(response, 200, { ok: true }, { 'set-cookie': `${DEVICE_COOKIE}=; Path=/m; HttpOnly; Max-Age=0; SameSite=Lax` })
      return
    }

    const device = admitDevice(request, response)
    if (device === undefined) return

    if (route === 'state' && method === 'GET') {
      const build = new URL(request.url ?? '/', 'http://local').searchParams.get('v')
      if (build !== null && build !== lastAppBuild) {
        lastAppBuild = build
        console.log(`dsh-pair: app build ${build}`)
      }
      const state = await collectState(ctx)
      sendJson(response, 200, { ...state, device: { id: device.id, label: device.label } })
      return
    }

    const sessionMatch = /^session\/([^/]+)(?:\/(prompt|cancel|stream|approval|answer|meta|model|mode|command|file))?$/u.exec(route)
    const imageMatch = /^session\/([^/]+)\/image\/(.+)$/u.exec(route)
    if (imageMatch !== null && method === 'GET') {
      const sessionId = imageMatch[1]
      const attachmentId = imageMatch[2]
      const decodedId = decodeURIComponent(attachmentId)
      const ref = imageRefs.get(`${sessionId}:${decodedId}`)
      if (ref === undefined) {
        sendJson(response, 404, { error: 'not-found', message: '这张图片不在最近的记录里' })
        return
      }
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        sendJson(response, 503, { error: 'unavailable', message: '当前 profile 没有装载附件服务' })
        return
      }
      let bytes
      let mediaType = ref.mediaType
      const hostPath = attachments.imageHostPath?.(ref)
      if (typeof hostPath === 'string' && hostPath !== '') {
        bytes = await readFile(hostPath)
      } else {
        const image = await attachments.readImageRequest(ref, { width: 1280, height: 1280, maxBytes: 2_500_000 })
        bytes = Buffer.from(image.data)
        mediaType = image.mediaType
      }
      response.writeHead(200, {
        'content-type': mediaType ?? 'application/octet-stream',
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      })
      response.end(bytes)
      return
    }
    if (route === 'events' && method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
      })
      response.write('retry: 3000\n\n')
      eventWatchers.add(response)
      if (config.debug) console.log(`dsh-pair: events stream connected (${String(eventWatchers.size)} open)`)
      const initial = [...pendingInteractions.values()].map(({ resolve, ...rest }) => rest)
      response.write(`event: pending\ndata: ${JSON.stringify({ pending: initial })}\n\n`)
      const heartbeat = setInterval(() => {
        try {
          response.write(': ping\n\n')
        } catch {
          // The close handler cleans up.
        }
      }, 15_000)
      heartbeat.unref?.()
      response.on('close', () => {
        clearInterval(heartbeat)
        eventWatchers.delete(response)
      })
      return
    }
    if (sessionMatch !== null) {
      const sessionId = decodeURIComponent(sessionMatch[1])
      const action = sessionMatch[2] ?? 'read'
      if (action === 'read' && method === 'GET') {
        const after = Number(new URL(request.url ?? '/', 'http://local').searchParams.get('after') ?? '0')
        const client = String(new URL(request.url ?? '/', 'http://local').searchParams.get('c') ?? '')
        if (client !== '') {
          const seen = transcriptClients.get(client)
          const next = (seen ?? 0) + 1
          transcriptClients.set(client, next)
          if (next === 1) console.log(`dsh-pair: transcript poller ${client} -> ${sessionId}`)
        }
        const answerable = [...pendingInteractions.values()].filter(entry => entry.sessionId === sessionId)
        const transcript = await readTranscript(ctx, sessionId, after, answerable)
        const live = liveSnapshot(sessionId)
        if (answerable.length > 0 && config.debug) console.log(`dsh-pair: transcript ${sessionId} pending=${String(answerable.length)}`)
        sendJson(response, 200, {
          ...transcript,
          ...(live === undefined ? {} : { live }),
        })
        return
      }
      if (action === 'approval' && method === 'POST') {
        const body = await readJson(request)
        const entry = pendingInteractions.get(String(body?.id ?? ''))
        if (entry === undefined || entry.kind !== 'approval' || entry.sessionId !== sessionId) {
          sendJson(response, 404, { error: 'not-found', message: '这条审批已经结束' })
          return
        }
        const decision = body?.decision === 'allow' ? 'allowed-once' : 'rejected'
        entry.resolve(decision)
        sendJson(response, 200, { accepted: true, decision })
        return
      }
      if (action === 'answer' && method === 'POST') {
        const body = await readJson(request)
        const entry = pendingInteractions.get(String(body?.id ?? ''))
        if (entry === undefined || entry.kind !== 'question' || entry.sessionId !== sessionId) {
          sendJson(response, 404, { error: 'not-found', message: '这个问题已经结束' })
          return
        }
        const answers = Array.isArray(body?.answers) ? body.answers : []
        const normalized = answers.map(answer => ({
          id: String(answer?.id ?? ''),
          selected: Array.isArray(answer?.selected) ? answer.selected.map(String) : [],
          ...(typeof answer?.custom === 'string' && answer.custom !== '' ? { custom: answer.custom } : {}),
        }))
        if (normalized.length !== entry.questions.length) {
          sendJson(response, 400, { error: 'bad-answer', message: '回答不完整' })
          return
        }
        entry.resolve({ answers: normalized })
        sendJson(response, 200, { accepted: true })
        return
      }
      if (action === 'stream' && method === 'GET') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-content-type-options': 'nosniff',
        })
        response.write('retry: 3000\n\n')
        const set = watchers.get(sessionId) ?? new Set()
        watchers.set(sessionId, set)
        set.add(response)
        const snapshot = liveSnapshot(sessionId)
        if (snapshot !== undefined) response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
        const heartbeat = setInterval(() => {
          try {
            response.write(': ping\n\n')
          } catch {
            // The close handler cleans up.
          }
        }, 15_000)
        heartbeat.unref?.()
        const close = () => {
          clearInterval(heartbeat)
          set.delete(response)
          if (set.size === 0) watchers.delete(sessionId)
        }
        response.on('close', close)
        return
      }
      if (action === 'prompt' && method === 'POST') {
        // Images travel as base64, so this route needs a much larger cap than
        // the rest of the bridge.
        const body = await readJson(request, MAX_PROMPT_BYTES)
      if (body?.images?.length > 0) {
        const sizes = body.images.reduce((sum, image) => sum + String(image?.data ?? '').length, 0)
        console.log(`dsh-pair: prompt with ${String(body.images.length)} image(s), ${String(sizes)} base64 bytes`)
      } else {
        console.log('dsh-pair: prompt without images')
      }
        sendJson(response, 200, await sendPrompt(ctx, sessionId, body))
        return
      }
      if (action === 'file' && method === 'GET') {
        // Serve one image from the session's working directory so assistant
        // markdown like ![x](docs/a.png) renders on the phone too.
        const target = new URL(request.url ?? '/', 'http://local').searchParams.get('path') ?? ''
        if (target === '') {
          sendJson(response, 400, { error: 'bad-request', message: '缺少 path' })
          return
        }
        const snapshot = await ctx.sessionQuery.readSession(sessionId)
        const root = String(snapshot?.session?.cwd ?? '')
        if (root === '') {
          sendJson(response, 409, { error: 'no-cwd', message: '这个会话没有工作目录' })
          return
        }
        const resolved = await realpath(resolvePath(root, target)).catch(() => '')
        if (resolved === '' || !(resolved === root || resolved.startsWith(root + sep))) {
          sendJson(response, 403, { error: 'forbidden', message: '只能读取会话目录里的文件' })
          return
        }
        const info = await stat(resolved).catch(() => undefined)
        if (info === undefined || !info.isFile()) {
          sendJson(response, 404, { error: 'not-found', message: '文件不存在' })
          return
        }
        if (info.size > 8 * 1024 * 1024) {
          sendJson(response, 413, { error: 'too-large', message: '文件太大' })
          return
        }
        const type = MIME_TYPES[extname(resolved).toLowerCase()]
        if (type === undefined || !type.startsWith('image/')) {
          sendJson(response, 415, { error: 'unsupported', message: '只能看图片' })
          return
        }
        const bytes = await readFile(resolved)
        response.writeHead(200, {
          'content-type': type,
          'content-length': String(bytes.length),
          'cache-control': 'private, max-age=300',
          'x-content-type-options': 'nosniff',
        })
        response.end(bytes)
        return
      }
      if (action === 'meta' && method === 'GET') {
        sendJson(response, 200, await sessionMeta(sessionId))
        return
      }
      if (action === 'model' && method === 'POST') {
        const body = await readJson(request)
        const provider = String(body?.provider ?? '')
        const model = String(body?.model ?? '')
        if (provider === '' || model === '') {
          sendJson(response, 400, { error: 'bad-request', message: '缺少 provider 或 model' })
          return
        }
        const selected = await ctx.sessionController.selectModel({
          sessionId,
          provider,
          model,
          ...(typeof body?.reasoningEffort === 'string' ? { reasoningEffort: body.reasoningEffort } : {}),
        })
        sendJson(response, 200, { selected: selected?.selected ?? { provider, model } })
        return
      }
      if (action === 'mode' && method === 'POST') {
        const body = await readJson(request)
        const live = ctx.get('sessions')?.get?.(sessionId)
        const presets = ctx.get('permissionPresets')
        if (live === undefined || presets === undefined) {
          sendJson(response, 409, { error: 'not-live', message: '会话没有在运行，先发一条消息再改模式' })
          return
        }
        presets.set(live, String(body?.name ?? ''))
        sendJson(response, 200, { current: presets.current(live) })
        return
      }
      if (action === 'command' && method === 'POST') {
        const body = await readJson(request)
        // One line, two mechanisms — the Host decides which one owns it, the
        // same way the desktop composer does:
        //  1. a registered slash command (`/compact`, `/goal`, …) runs host-side;
        //  2. anything else is a normal prompt, which is exactly how a skill is
        //     invoked (`/skill-name` is expanded by the skill tool's pre-step).
        const line = String(body?.line ?? '').trim()
        if (line === '' || !line.startsWith('/')) {
          sendJson(response, 400, { error: 'bad-request', message: '命令要以 / 开头' })
          return
        }
        const agent = ctx.get('agents')?.get?.(sessionId)
        const commandService = ctx.get('commands')
        if (agent === undefined) {
          sendJson(response, 409, { error: 'not-live', message: '会话没有在运行，无法执行命令' })
          return
        }
        if (commandService !== undefined) {
          const abort = new AbortController()
          const execution = await commandService.execute(agent, line, [], abort.signal)
          if (execution !== undefined) {
            const result = execution.result ?? execution
            sendJson(response, 200, {
              ran: 'command',
              kind: String(result?.kind ?? 'success'),
              text: String(result?.text ?? ''),
            })
            return
          }
          // `undefined` here means the name is not a registered command; the
          // prompt path below is what carries a skill invocation.
        }
        await sendPrompt(ctx, sessionId, { text: line })
        sendJson(response, 200, { ran: 'prompt', kind: 'success', text: '' })
        return
      }
      if (action === 'cancel' && method === 'POST') {
        sendJson(response, 200, await cancelTurn(ctx, sessionId))
        return
      }
      sendJson(response, 405, { error: 'method-not-allowed' })
      return
    }

    sendJson(response, 404, { error: 'not-found' })
  }

  /** Run one async handler and turn failures into JSON/text responses. */
  const guard = (run) => (request, response) => {
    Promise.resolve()
      .then(() => run(request, response))
      .catch(error => {
        const tooLarge = error instanceof Error && /body too large/i.test(error.message)
        const status = tooLarge ? 413 : Number.isInteger(error?.status) ? error.status : 500
        const message = tooLarge ? '请求体太大（图片总量上限约 9MB）' : error instanceof Error ? error.message : String(error)
        // console.error reaches dsh web's log; ctx.logger output is not persisted there.
        console.error(`dsh-pair: ${request.method} ${request.url} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        if (response.headersSent) {
          response.destroy()
          return
        }
        sendJson(response, status, { error: tooLarge ? 'too-large' : 'internal', message })
      })
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PAIR_PATH,
        handler: guard(async (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'method-not-allowed' })
          if (!admitDesktop(request, response)) return
          const rotate = new URL(request.url ?? '/', 'http://local').searchParams.get('rotate') === '1'
          const appReady = await stat(join(appDir, 'index.html')).then(
            info => info.isFile(),
            () => false,
          )
          sendJson(response, 200, pairDocument(rotate, appReady))
        }),
      }),
    'dsh-pair: pairing document',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: REVOKE_PATH,
        handler: guard(async (request, response) => {
          if (request.method !== 'POST') return sendJson(response, 405, { error: 'method-not-allowed' })
          if (!admitDesktop(request, response)) return
          const body = await readJson(request)
          const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : ''
          sendJson(response, 200, { revoked: pairing.revoke(deviceId) })
        }),
      }),
    'dsh-pair: device revocation',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/m',
        handler: (request, response) => {
          const url = request.url ?? '/m'
          const queryIndex = url.indexOf('?')
          const query = queryIndex < 0 ? '' : url.slice(queryIndex)
          response.writeHead(308, { location: `${APP_ROOT}/${query}` })
          response.end()
        },
      }),
    'dsh-pair: app redirect',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_ROOT,
        handler: guard((request, response) => handleApi(request, response, new URL(request.url ?? '/', 'http://local').pathname)),
      }),
    'dsh-pair: bridge',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: APP_ROOT,
        handler: guard(async (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') return sendText(response, 405, 'method not allowed')
          const pathname = new URL(request.url ?? '/', 'http://local').pathname
          if (await serveAppFile(request, response, appDir, pathname)) return
          // The app routes with the hash, so a missing file is a real 404 — never
          // answer with HTML where a module was expected.
          sendText(
            response,
            503,
            [
              'dsh-pair: mobile app not found.',
              '',
              `Looked in: ${appDir}`,
              'Set `appDir` on the `mobile` row in your profile patch to point at the phone app directory.',
            ].join('\n'),
          )
        }),
      }),
    'dsh-pair: static app',
  )

  console.log(`dsh-pair: app served from ${appDir}; paired devices ${String(pairing.devices.size)}`)
}
