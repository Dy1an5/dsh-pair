#!/usr/bin/env node
/**
 * Start `dsh web` on the LAN address a phone can actually reach.
 *
 *   dsh-pair-serve                 # foreground, first usable LAN address
 *   dsh-pair-serve --port 8321     # extra flags are forwarded to `dsh web`
 *   dsh-pair-serve --detach        # background: tmux when installed, otherwise a detached process
 *   dsh-pair-serve status|url|logs|stop
 *   dsh-pair-serve --print         # print the command instead of running it
 *   dsh-pair-serve --host 10.0.0.7 # override the detected address
 *
 * Why this exists: `dsh web` without `--host` binds 127.0.0.1, which no phone can
 * reach, and the address to use is not something a user should have to discover.
 * The 手机连接 page prints the same command; this is the one-command version.
 *
 * `--detach` deliberately does not require tmux: tmux gives you `attach`, a bare
 * detached process gives you the same background behaviour on machines without it.
 * Either way the URL lands in the log, which `url` and `status` read back.
 *
 * `DSH_PAIR_HOST` / `DSH_PAIR_PORT` do the same as the flags. Anything you would
 * otherwise retype every day belongs in `$DSH_HOME/dsh-pair.json`:
 *
 *   { "port": 8321, "detach": true }
 *
 * Flags win over environment, which wins over the file, which wins over detection.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'
import { lanAddresses } from '../index.js'

const argv = process.argv.slice(2)
const forwarded = []
const commands = new Set(['start', 'run', 'status', 'url', 'logs', 'log', 'stop', 'attach', 'config'])
let command = 'run'
let host
let port
let print = false
let detach = false

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (commands.has(arg) && command === 'run' && forwarded.length === 0 && !arg.startsWith('-')) {
    command = arg === 'start' ? 'run' : arg
  } else if (arg === '--print' || arg === '-P') {
    print = true
  } else if (arg === '--detach' || arg === '-d') {
    detach = true
  } else if (arg === '--host' || arg === '-H') {
    host = argv[index + 1]
    index += 1
  } else if (arg.startsWith('--host=')) {
    host = arg.slice('--host='.length)
  } else if (arg === '--port' || arg === '-p') {
    port = argv[index + 1]
    index += 1
  } else if (arg.startsWith('--port=')) {
    port = arg.slice('--port='.length)
  } else {
    forwarded.push(arg)
  }
}

const dshHome = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
const configPath = join(dshHome, 'dsh-pair.json')
const logPath = process.env.DSH_PAIR_LOG ?? join(dshHome, 'dsh-pair.log')
const pidPath = join(dshHome, 'dsh-pair.pid')
const SESSION = process.env.DSH_PAIR_SESSION ?? 'dsh-pair'

/** Saved defaults; a missing file is simply "no defaults yet". */
function readConfig() {
  let text
  try {
    text = readFileSync(configPath, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    console.error(`dsh-pair-serve: ignoring ${configPath}: ${error.message}`)
    return {}
  }
}

const config = readConfig()

/** Whether a command exists on PATH. */
const has = name => spawnSync(name, ['-V'], { stdio: 'ignore' }).status === 0

/** Whether the tmux session this tool starts is still alive. */
const sessionAlive = () => has('tmux') && spawnSync('tmux', ['has-session', '-t', SESSION], { stdio: 'ignore' }).status === 0

/** The pid of a detached (non-tmux) run, if it is still alive. */
const detachedPid = () => {
  let pid
  try {
    pid = Number(readFileSync(pidPath, 'utf8').trim())
  } catch {
    return undefined
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return undefined
  }
}

const running = () => sessionAlive() || detachedPid() !== undefined

/** The URL `dsh web` printed, which is the one a phone should open. */
const loggedUrl = () => {
  let text = ''
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    return undefined
  }
  const matches = [...text.matchAll(/^dsh web: (https?:\S+)$/gmu)]
  return matches.at(-1)?.[1]
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Wait for the URL line to appear, or give up. */
async function awaitUrl(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const url = loggedUrl()
    if (url !== undefined) return url
    if (!running()) return undefined
    await sleep(250)
  }
  return undefined
}

host = host ?? process.env.DSH_PAIR_HOST ?? config.host ?? lanAddresses()[0]
port = port ?? process.env.DSH_PAIR_PORT ?? config.port
if (!detach && config.detach === true) detach = true

if (command === 'config') {
  console.log(configPath)
  if (Object.keys(config).length === 0) {
    console.error('dsh-pair-serve: no defaults yet — write one, e.g. {"port": 8321, "detach": true}')
  } else {
    console.log(JSON.stringify(config, null, 2))
  }
  process.exit(0)
}

const webArgs = ['web', '--host', host, ...(port === undefined ? [] : ['--port', String(port)]), ...forwarded]
const printable = ['dsh', ...webArgs].join(' ')

if (command === 'status') {
  if (!running()) {
    console.log('dsh-pair-serve: not running')
    process.exit(1)
  }
  console.log(`dsh-pair-serve: running (${sessionAlive() ? `tmux session ${SESSION}` : `pid ${detachedPid()}`})`)
  const url = loggedUrl()
  if (url !== undefined) console.log(url)
  process.exit(0)
}

if (command === 'url') {
  const url = loggedUrl()
  if (url === undefined) {
    console.error('dsh-pair-serve: no URL in the log yet — is the server running?')
    process.exit(1)
  }
  console.log(url)
  process.exit(0)
}

if (command === 'logs' || command === 'log' || command === 'attach') {
  if (command === 'attach' && sessionAlive()) {
    const result = spawnSync('tmux', ['attach', '-t', SESSION], { stdio: 'inherit' })
    process.exit(result.status ?? 0)
  }
  let text = ''
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    console.error(`dsh-pair-serve: no log at ${logPath}`)
    process.exit(1)
  }
  console.log(text.trimEnd().split('\n').slice(-40).join('\n'))
  if (sessionAlive()) console.error(`\ndsh-pair-serve: attach with: tmux attach -t ${SESSION}`)
  process.exit(0)
}

if (command === 'stop') {
  let stopped = false
  if (sessionAlive()) {
    spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' })
    stopped = true
  }
  const pid = detachedPid()
  if (pid !== undefined) {
    try {
      process.kill(pid, 'SIGTERM')
      stopped = true
    } catch {
      // Already gone between the liveness check and the signal.
    }
  }
  try {
    unlinkSync(pidPath)
  } catch {
    // No pidfile: nothing to clean up.
  }
  if (!stopped) {
    console.error('dsh-pair-serve: not running')
    process.exit(1)
  }
  console.log('dsh-pair-serve: stopped')
  process.exit(0)
}

if (host === undefined || host === '') {
  console.error('dsh-pair-serve: no usable LAN address found.')
  console.error('  Pass one explicitly:  dsh-pair-serve --host 192.168.1.20')
  console.error('  Or run plain `dsh web` and use the 手机连接 page for the exact command.')
  process.exit(2)
}

// Deliberately loud: binding a LAN address exposes the whole Harness UI, whose
// tools can run arbitrary commands, to everyone on that network.
console.error(`dsh-pair-serve: binding ${host}${port === undefined ? '' : `:${port}`} — reachable by any device on this network.`)
console.error('dsh-pair-serve: pairing still requires the QR token; stop this process to close the port.')

if (print) {
  console.log(printable)
  process.exit(0)
}

if (detach) {
  mkdirSync(dirname(logPath), { recursive: true })
  const shell = printable.replace(/'/gu, `'\\''`)
  const quoted = /[\s'"]/u.test(logPath) ? `'${logPath.replace(/'/gu, `'\\''`)}'` : logPath

  if (sessionAlive()) {
    console.error(`dsh-pair-serve: already running in tmux session ${SESSION}`)
    process.exit(1)
  }

  if (has('tmux')) {
    const result = spawnSync('tmux', ['new', '-d', '-s', SESSION, `${shell} >> ${quoted} 2>&1`], { stdio: 'inherit' })
    if (result.status !== 0) {
      console.error(`dsh-pair-serve: tmux refused to start the session (exit ${String(result.status)})`)
      process.exit(1)
    }
    console.error(`dsh-pair-serve: started in tmux session ${SESSION}; logs at ${logPath}`)
  } else {
    // No tmux: a plain detached process is enough. The pidfile is what `status`
    // and `stop` read, so nothing else has to know the difference.
    const fd = openSync(logPath, 'a')
    const child = spawn('dsh', webArgs, { detached: true, stdio: ['ignore', fd, fd] })
    child.unref()
    writeFileSync(pidPath, String(child.pid))
    console.error(`dsh-pair-serve: started as pid ${String(child.pid)} (tmux not installed); logs at ${logPath}`)
  }

  const url = await awaitUrl()
  if (url !== undefined) {
    console.log(url)
    process.exit(0)
  }
  console.error('dsh-pair-serve: started, but no URL appeared yet — check `dsh-pair-serve logs`')
  process.exit(1)
}

const child = spawn('dsh', webArgs, { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code, signal) => {
  process.exit(signal === null ? (code ?? 0) : 1)
})
child.on('error', error => {
  console.error(`dsh-pair-serve: could not start \`dsh\`: ${error.message}`)
  process.exit(1)
})
