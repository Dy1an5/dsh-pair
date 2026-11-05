/**
 * The launcher's only real job is producing the right `dsh web` command, so that
 * is what these assert — without ever spawning a server.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const run = promisify(execFile)
const LAUNCHER = fileURLToPath(new URL('../bin/dsh-pair-serve.mjs', import.meta.url))

// The launcher reads saved defaults from `$DSH_HOME/dsh-pair.json`, so every test
// runs against an empty home — otherwise a developer's own defaults silently
// rewrite the expected command line.
const EMPTY_HOME = await mkdtemp(join(tmpdir(), 'dsh-pair-home-'))
const cleanEnv = { ...process.env, DSH_HOME: EMPTY_HOME, DSH_PAIR_SESSION: 'dsh-pair-test' }

/** Run the launcher in print mode and return its stdout line. */
const printed = async args => {
  const { stdout } = await run(process.execPath, [LAUNCHER, '--print', ...args], { env: cleanEnv })
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
    const { stdout } = await run(process.execPath, [LAUNCHER, '--print'], { env: cleanEnv }).catch(error => ({ stdout: error.stdout }))
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

  // Daily use should not need flags: the defaults live in the profile directory,
  // and an explicit flag still beats them.
  it('reads saved defaults, and flags still win', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-pair-config-'))
    await writeFile(join(home, 'dsh-pair.json'), JSON.stringify({ port: 8321, detach: true }))

    const withDefaults = await runIn(home, ['--print', '--host', '192.168.1.20'])
    assert.equal(withDefaults.code, 0)
    assert.match(withDefaults.stdout, /--port 8321/u)

    const overridden = await runIn(home, ['--print', '--host', '192.168.1.20', '--port', '9000'])
    assert.match(overridden.stdout, /--port 9000/u)
  })
})
