#!/usr/bin/env node
/**
 * Start `dsh web` on the LAN address a phone can actually reach.
 *
 *   dsh-pair-serve                 # bind the first usable LAN address
 *   dsh-pair-serve --port 8321     # extra flags are forwarded to `dsh web`
 *   dsh-pair-serve --print         # print the command instead of running it
 *   dsh-pair-serve --host 10.0.0.7 # override the detected address
 *
 * Why this exists: `dsh web` without `--host` binds 127.0.0.1, which no phone can
 * reach, and the address to use is not something a user should have to discover.
 * The 手机连接 page prints the same command; this is the one-command version.
 *
 * `DSH_PAIR_HOST` / `DSH_PAIR_PORT` do the same as the flags.
 */
import { spawn } from 'node:child_process'
import { lanAddresses } from '../index.js'

const argv = process.argv.slice(2)
const forwarded = []
let host
let port
let print = false

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--print' || arg === '-P') {
    print = true
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

host = host ?? process.env.DSH_PAIR_HOST ?? lanAddresses()[0]
port = port ?? process.env.DSH_PAIR_PORT

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

const args = ['web', '--host', host, ...(port === undefined ? [] : ['--port', String(port)]), ...forwarded]

if (print) {
  console.log(['dsh', ...args].join(' '))
  process.exit(0)
}

const child = spawn('dsh', args, { stdio: 'inherit' })
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
