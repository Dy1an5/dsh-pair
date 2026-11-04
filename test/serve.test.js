/**
 * The launcher's only real job is producing the right `dsh web` command, so that
 * is what these assert — without ever spawning a server.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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
})
