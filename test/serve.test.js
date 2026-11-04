/**
 * The launcher's only real job is producing the right `dsh web` command, so that
 * is what these assert — without ever spawning a server.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const run = promisify(execFile)
const LAUNCHER = fileURLToPath(new URL('../bin/dsh-pair-serve.mjs', import.meta.url))

/** Run the launcher in print mode and return its stdout line. */
const printed = async args => {
  const { stdout } = await run(process.execPath, [LAUNCHER, '--print', ...args])
  return stdout.trim()
}

const runIn = async (home, args) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [LAUNCHER, ...args], {
      env: { ...process.env, DSH_HOME: home, DSH_PAIR_SESSION: 'dsh-pair-test' },
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

describe('launcher', () => {
  it('names a concrete LAN address, never a loopback or wildcard bind', async () => {
    const command = await printed([])
    assert.match(command, /^dsh web --host \S+$/u)
    assert.equal(command.includes('--host 127.'), false)
    assert.equal(command.includes('--host 0.0.0.0'), false)
  })

  it('forwards port, host and extra flags verbatim', async () => {
    assert.equal(await printed(['--port', '8321']), 'dsh web --host ' + (await printed([])).split(' ')[3] + ' --port 8321')
    assert.equal(await printed(['--host', '192.168.1.20']), 'dsh web --host 192.168.1.20')
    assert.match(await printed(['--port', '8321', '--no-open']), / --no-open$/u)
    assert.equal(await printed(['--host=192.168.1.20', '--port=9000']), 'dsh web --host 192.168.1.20 --port 9000')
  })

  it('refuses to guess when no address is available, instead of binding loopback', async () => {
    const { stdout } = await run(process.execPath, [LAUNCHER, '--print']).catch(error => ({ stdout: error.stdout }))
    // Either a usable address exists (most machines) or the tool exits 2 with a
    // message naming the override flag; it must never print a loopback command.
    if (stdout !== undefined && stdout.trim() !== '') assert.equal(stdout.includes('127.0.0.1'), false)
  })

  // `status` and `stop` have to work on a machine where nothing was ever started,
  // and on one without tmux: the pidfile is the only shared state either way.
  it('reports not running instead of guessing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pair-status-'))
    const status = await runIn(home, ['status'])
    assert.equal(status.code, 1)
    assert.match(status.stdout, /not running/u)

    const stop = await runIn(home, ['stop'])
    assert.equal(stop.code, 1)
    assert.match(stop.stderr, /not running/u)
  })

  it('has no URL to print before the server has run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pair-url-'))
    const url = await runIn(home, ['url'])
    assert.equal(url.code, 1)
    assert.match(url.stderr, /no URL/u)
  })
})
