/**
 * Visual + interaction check for the phone app.
 *
 * Boots the plugin's real HTTP surface with fixture services, drives it in
 * Chromium at iPhone metrics, and writes screenshots to `.tmp/e2e/shots/`.
 * Run from the repo root:
 *
 *   node .tmp/e2e/run.mjs
 */
import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { startHarness } from '../harness.js'

const CHROME = process.env.CHROME_PATH ?? '/home/dylan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const SHOTS = fileURLToPath(new URL('./shots/', import.meta.url))
const APP_DIR = fileURLToPath(new URL('../../app/', import.meta.url))

await mkdir(SHOTS, { recursive: true })

const harness = await startHarness({ appDir: APP_DIR })
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })

/**
 * Open one page with the iPhone profile.
 * @param {object} [options]
 * @param {boolean} [options.dark]
 * @returns {Promise<import('playwright-core').Page>}
 */
async function page({ dark = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: dark ? 'dark' : 'light',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
  })
  return context.newPage()
}

const errors = []

try {
  const pairing = await (await fetch(`${harness.base}/dsh-pair/pair.json`)).json()
  const url = `${harness.base}/m/?t=${encodeURIComponent(pairing.token)}`

  // --- home ---------------------------------------------------------------
  const first = await page()
  first.on('pageerror', error => errors.push(`home: ${error.message}`))
  first.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  await first.goto(url, { waitUntil: 'networkidle' })
  await first.waitForSelector('.row', { timeout: 5000 })
  await first.screenshot({ path: `${SHOTS}/home-dark.png` })
  console.log('home rows:', await first.locator('.row').count())
  console.log('pairing stripped:', new URL(first.url()).search === '')

  // --- session ------------------------------------------------------------
  await first.locator('.row').first().click()
  await first.waitForSelector('.bubble', { timeout: 5000 })
  await first.waitForTimeout(400)
  await first.screenshot({ path: `${SHOTS}/session-dark.png` })
  console.log('bubbles:', await first.locator('.bubble').count(), 'tools:', await first.locator('.tool').count())

  // Tool row expands.
  await first.locator('.tool-head').first().click()
  await first.waitForTimeout(150)
  await first.screenshot({ path: `${SHOTS}/tool-open.png` })

  // --- send ---------------------------------------------------------------
  const promptsBefore = harness.services.calls.prompts.length
  await first.fill('.composer textarea', '手机端发一条')
  await first.click('.send')
  await first.waitForTimeout(600)
  console.log('prompt delivered:', harness.services.calls.prompts.length === promptsBefore + 1)
  await first.screenshot({ path: `${SHOTS}/session-sent.png` })

  // --- light --------------------------------------------------------------
  const light = await page({ dark: false })
  await light.goto(url, { waitUntil: 'networkidle' })
  await light.waitForSelector('.row')
  await light.screenshot({ path: `${SHOTS}/home-light.png` })
  await light.locator('.row').first().click()
  await light.waitForSelector('.bubble')
  await light.screenshot({ path: `${SHOTS}/session-light.png` })

  // --- layout invariants ---------------------------------------------------
  const metrics = await first.evaluate(() => {
    const bar = document.querySelector('.composer')
    const screen = document.querySelector('.screen')
    return {
      composerBottom: Math.round(bar.getBoundingClientRect().bottom),
      viewport: window.innerHeight,
      screenScrollable: screen.scrollHeight > screen.clientHeight,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    }
  })
  console.log('metrics:', JSON.stringify(metrics))
} finally {
  console.log('page errors:', errors.length === 0 ? 'none' : errors)
  await browser.close()
  await harness.close()
}
