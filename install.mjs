#!/usr/bin/env node
/**
 * Wire this plugin into a Harness Web profile.
 *
 *   node install.mjs            # apply to the `web` profile
 *   node install.mjs --dry-run  # print the plan only
 *   node install.mjs --profile tui
 *
 * Two modes, picked automatically:
 *
 * - **installed** — this file sits inside `<profile>/node_modules/…`, the case
 *   after `dsh plugin --profile web add <pkg>`; only the bundle entry is added
 *   and the dependency line stays exactly as the package manager wrote it.
 * - **checkout** — this file is a working copy elsewhere; it is symlinked into
 *   `<profile>/node_modules` and the dependency is recorded as `link:…`.
 *
 * Either way it leaves `cordis.patch.yml` alone: the bundle's own
 * `dsh.bundle.patch` inserts the `mobile` row, so that YAML stays user-owned.
 *
 * A running `dsh web` does not reload Host plugins — restart it afterwards.
 */
import { readFile, writeFile, symlink, stat, lstat, readlink, mkdir, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'web'
if (typeof profile !== 'string' || profile === '') {
  console.error('install: --profile needs a name')
  process.exit(2)
}

const dshHome = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const own = JSON.parse(await readFile(join(HERE, 'package.json'), 'utf8'))
const pluginName = String(own.name)
// `appDir` on the Loader row defaults to ./app and resolves against this
// plugin's directory, so the packed tree always carries the UI here.
const appDir = resolve(HERE, 'app')

/** Write one file unless its content already matches. */
async function writeIfChanged(path, next) {
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch {
    // Missing file: fall through to the write.
  }
  if (current === next) {
    console.log(`  = ${path}`)
    return
  }
  if (dryRun) {
    console.log(`  + ${path}`)
    return
  }
  await writeFile(path, next)
  console.log(`  + ${path}`)
}

/** Whether `child` lives under `parent`. */
const isInside = (parent, child) => {
  const path = relative(parent, child)
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}

const nodeModules = join(profileDir, 'node_modules')
const installed = isInside(nodeModules, HERE)
const linkPath = join(nodeModules, ...pluginName.split('/'))

console.log(`${pluginName} installer${dryRun ? ' (dry run)' : ''}`)
console.log(`  profile : ${profileDir}`)
console.log(`  plugin  : ${HERE}`)
console.log(`  mode    : ${installed ? 'installed' : 'checkout (will be symlinked)'}`)
console.log('')

try {
  await stat(join(profileDir, 'package.json'))
} catch {
  console.error(`install: no profile at ${profileDir}; run "dsh --profile ${profile}" once first`)
  process.exit(1)
}
try {
  await stat(join(appDir, 'index.html'))
} catch {
  console.error(`install: the phone app is missing at ${appDir} — a published package must ship app/`)
  process.exit(1)
}

// 1. checkout only: make the working copy resolvable from the profile.
if (!installed) {
  console.log('link:')
  try {
    const existing = await lstat(linkPath).catch(() => undefined)
    if (existing === undefined) {
      if (dryRun) {
        console.log(`  + ${linkPath} -> ${HERE}`)
      } else {
        await mkdir(dirname(linkPath), { recursive: true })
        await symlink(HERE, linkPath, 'dir')
        console.log(`  + ${linkPath} -> ${HERE}`)
      }
    } else if (existing.isSymbolicLink()) {
      const target = await readlink(linkPath)
      if (resolve(dirname(linkPath), target) === HERE) {
        console.log(`  = ${linkPath}`)
      } else if (dryRun) {
        console.log(`  ~ ${linkPath} -> ${HERE}`)
      } else {
        await unlink(linkPath)
        await symlink(HERE, linkPath, 'dir')
        console.log(`  ~ ${linkPath} -> ${HERE}`)
      }
    } else {
      console.log(`  ! ${linkPath} exists and is not a symlink; remove it first`)
      process.exit(1)
    }
  } catch (error) {
    console.error(`install: could not link the plugin: ${error.message}`)
    process.exit(1)
  }
}

// 2. profile manifest: dependency (checkout only) + bundle entry (always).
console.log('manifest:')
const manifestPath = join(profileDir, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.dependencies ??= {}
if (!installed) manifest.dependencies[pluginName] = `link:${HERE}`
else if (manifest.dependencies[pluginName] === undefined) {
  manifest.dependencies[pluginName] = `^${String(own.version)}`
}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []
// A renamed package leaves its old identity behind as a `link:` dependency and
// a bundle entry. That entry records the path the plugin had *before* the move,
// so matching on `target === HERE` alone never fires after a plain `mv`: the
// old directory is gone and the resolved path no longer equals this one. Any
// `link:` dependency whose target is missing is unloadable, so it is dropped
// too — along with the dangling symlink it left in node_modules.
for (const [name, spec] of Object.entries(manifest.dependencies)) {
  if (name === pluginName) continue
  if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
  const target = resolve(spec.slice('link:'.length))
  const present = await stat(target).then(
    () => true,
    () => false,
  )
  // A different checkout that still exists is somebody else's row: leave it.
  if (present && target !== HERE) continue
  delete manifest.dependencies[name]
  const at = manifest.dsh.profile.bundles.indexOf(name)
  if (at >= 0) manifest.dsh.profile.bundles.splice(at, 1)
  const staleLink = join(nodeModules, ...name.split('/'))
  const linked = await lstat(staleLink).then(
    entry => entry.isSymbolicLink(),
    () => false,
  )
  if (linked) {
    const pointsAt = resolve(dirname(staleLink), await readlink(staleLink))
    const alive = await stat(pointsAt).then(
      () => true,
      () => false,
    )
    if (!alive && !dryRun) await unlink(staleLink)
  }
  console.log(`  - ${name} (${present ? `renamed to ${pluginName}` : `missing: ${target}`})`)
}
if (!manifest.dsh.profile.bundles.includes(pluginName)) manifest.dsh.profile.bundles.push(pluginName)
await writeIfChanged(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log('')
console.log('done. restart the Web GUI to load the plugin:')
console.log('  dsh web --host <your LAN IP>')
console.log('the 手机连接 page names the exact command and address to use.')
