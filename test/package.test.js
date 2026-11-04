/**
 * Packaging guards.
 *
 * These do not test behaviour — they test that the thing we would publish is
 * complete. The failure they exist for is silent: `files` once omitted `app/`,
 * so `npm publish` produced a plugin whose phone UI 404s, and nothing local
 * noticed because development links the checkout instead of packing it.
 */
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const readJson = async path => JSON.parse(await readFile(join(ROOT, path), 'utf8'))

/** Whether `files` would include a repository-relative path. */
const ships = (files, path) =>
  files.some(entry => {
    const trimmed = entry.replace(/\/$/u, '')
    return path === trimmed || path.startsWith(`${trimmed}/`)
  })

describe('package', () => {
  it('is publishable: not private, scoped, and carrying a license file', async () => {
    const pkg = await readJson('package.json')
    assert.notEqual(pkg.private, true, 'a private package cannot be published')
    assert.equal(typeof pkg.name, 'string')
    assert.notEqual(pkg.name.trim(), '')
    assert.match(String(pkg.version), /^\d+\.\d+\.\d+/u)
    assert.equal(pkg.license, 'MIT')
    assert.ok(ships(pkg.files ?? [], 'LICENSE'), 'LICENSE must ship: MIT requires the notice')
    await stat(join(ROOT, 'LICENSE'))
    // The Chinese README is a published artifact too: `npm` renders README.md
    // but the pair must travel together.
    assert.ok(ships(pkg.files ?? [], 'README.zh.md'), 'README.zh.md must ship')
  })

  it('ships the phone app, which a bare Host cannot rebuild', async () => {
    const pkg = await readJson('package.json')
    assert.ok(ships(pkg.files ?? [], 'app/index.html'), 'app/ must be in files or the phone UI 404s')
    for (const asset of ['app/app.js', 'app/styles.css', 'app/manifest.webmanifest', 'app/assets/icon.svg']) {
      assert.ok(ships(pkg.files ?? [], asset), `${asset} must ship`)
      await stat(join(ROOT, asset))
    }
  })

  it('declares the entry points it actually ships', async () => {
    const pkg = await readJson('package.json')
    const files = pkg.files ?? []
    for (const value of Object.values(pkg.exports ?? {})) {
      const path = String(value).replace(/^\.\//u, '')
      // `package.json` is always packed by npm whatever `files` says.
      if (path === 'package.json') continue
      assert.ok(ships(files, path), `${path} must ship`)
    }
    for (const path of Object.values(pkg.bin ?? {})) {
      assert.ok(ships(files, String(path).replace(/^\.\//u, '')), `${String(path)} must ship`)
    }
  })

  it('points the bundle patch and client face at files that ship', async () => {
    const pkg = await readJson('package.json')
    const patch = pkg.dsh?.bundle?.patch
    assert.equal(typeof patch, 'string')
    assert.ok(ships(pkg.files ?? [], patch.replace(/^\.\//u, '')), 'cordis.patch.yml must ship')
    const raw = await readFile(join(ROOT, patch), 'utf8')
    // The row the patch inserts is what mounts the Host plugin, so its `name`
    // must be the package name exactly — a comment mentioning the old one would
    // satisfy a looser match while the row itself stayed broken.
    assert.match(raw, /insert:/u)
    assert.match(raw, new RegExp(`name:\\s*'${pkg.name.replace(/[\\/]/gu, '\\$&')}'`, 'u'))

    assert.equal(pkg.dsh?.client?.platform, 'web')
    assert.ok(Array.isArray(pkg.dsh?.client?.inject))
    assert.ok(ships(pkg.files ?? [], 'client.js'))
  })

  it('keeps development-only trees out of the tarball', async () => {
    const pkg = await readJson('package.json')
    for (const path of ['test/', 'docs/']) {
      assert.equal(ships(pkg.files ?? [], path), false, `${path} must not ship`)
    }
    // The vendored QR encoder carries its own notice; both must publish.
    assert.ok(ships(pkg.files ?? [], 'vendor/qrcode.mjs'))
    assert.ok(ships(pkg.files ?? [], 'vendor/NOTICE.md'))
  })
})
