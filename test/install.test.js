/**
 * Installer guards.
 *
 * The failure these exist for is silent: the plugin was renamed, `install.mjs`
 * was re-run, and the profile kept pointing at the directory name it had
 * *before* the `mv` — a `link:` target that no longer exists. `dsh web` then
 * starts with `skipping profile bundle "<old name>"` on every boot, and the row
 * is one refactor away from being fatal. The cleanup must key on "resolvable"
 * rather than on "equals this directory", because after a rename those differ.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, symlink, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const INSTALLER = fileURLToPath(new URL('../install.mjs', import.meta.url))
const ROOT = dirname(INSTALLER)

/** A throwaway `$DSH_HOME` holding one `web` profile. */
async function profileHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pair-install-'))
  const profile = join(home, 'profiles', 'web')
  await mkdir(join(profile, 'node_modules', '@local'), { recursive: true })
  const json = join(profile, 'package.json')
  await writeFile(json, `${JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2)}\n`)
  return { home, profile, modules: join(profile, 'node_modules'), json }
}

const readManifest = async path => JSON.parse(await readFile(path, 'utf8'))
const install = (home, ...args) =>
  run(process.execPath, [INSTALLER, '--profile', 'web', ...args], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home },
  })

describe('installer', () => {
  it('drops the pre-rename identity and its dangling link', async () => {
    const { home, json, modules } = await profileHome()
    const oldTarget = join(home, 'elsewhere', 'dsh-mobile')
    await writeFile(
      json,
      `${JSON.stringify(
        {
          name: 'dsh-profile-web',
          private: true,
          dependencies: { '@local/dsh-mobile': `link:${oldTarget}` },
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@local/dsh-mobile'] } },
        },
        null,
        2,
      )}\n`,
    )
    await symlink(oldTarget, join(modules, '@local', 'dsh-mobile'))

    await install(home)

    const manifest = await readManifest(json)
    assert.equal(manifest.dependencies['@local/dsh-mobile'], undefined)
    assert.equal(manifest.dependencies['dsh-pair'], `link:${ROOT}`)
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-pair'])
    // The dead symlink goes with it; a stale `node_modules` entry outlives the
    // manifest line otherwise and still confuses resolution.
    await assert.rejects(lstat(join(modules, '@local', 'dsh-mobile')))
    assert.equal((await lstat(join(modules, 'dsh-pair'))).isSymbolicLink(), true)
  })

  it('leaves another live checkout alone', async () => {
    const { home, json, modules } = await profileHome()
    // A sibling plugin that still exists on disk. It must be built here rather than
    // borrowed from the developer's checkout: CI has no `../dsh-oil-git`, and a
    // test that silently depends on one machine's layout fails only in CI.
    const neighbour = join(home, 'plugins', 'dsh-oil-git')
    await mkdir(neighbour, { recursive: true })
    await writeFile(join(neighbour, 'package.json'), '{"name":"dsh-oil-git"}\n')
    await writeFile(
      json,
      `${JSON.stringify(
        {
          name: 'dsh-profile-web',
          private: true,
          dependencies: { '@local/dsh-oil-git': `link:${neighbour}` },
          dsh: { profile: { bundles: ['@local/dsh-oil-git'] } },
        },
        null,
        2,
      )}\n`,
    )
    await symlink(neighbour, join(modules, '@local', 'dsh-oil-git'))

    await install(home)

    const manifest = await readManifest(json)
    assert.equal(manifest.dependencies['@local/dsh-oil-git'], `link:${neighbour}`)
    assert.deepEqual(manifest.dsh.profile.bundles, ['@local/dsh-oil-git', 'dsh-pair'])
  })

  it('is idempotent and leaves --dry-run without side effects', async () => {
    const { home, json } = await profileHome()
    await install(home)
    const once = await readFile(json, 'utf8')

    await install(home)
    assert.equal(await readFile(json, 'utf8'), once)

    const before = await readFile(json, 'utf8')
    await install(home, '--dry-run')
    assert.equal(await readFile(json, 'utf8'), before)
  })
})
