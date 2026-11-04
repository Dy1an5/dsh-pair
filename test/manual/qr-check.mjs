import { chromium } from 'playwright-core'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { startHarness } from '../harness.js'

const CHROME = '/home/dylan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const JSQR = process.env.JSQR_PATH ?? fileURLToPath(new URL('./node_modules/jsqr/dist/jsQR.js', import.meta.url))
const harness = await startHarness({ appDir: fileURLToPath(new URL('../../app/', import.meta.url)) })
const pairing = await (await fetch(`${harness.base}/dsh-pair/pair.json`)).json()

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 420, height: 420 } })
await page.setContent(`<style>html,body{margin:0}</style>${pairing.svg}`)
await page.addScriptTag({ path: JSQR })
const decoded = await page.evaluate(() => {
  const svg = document.querySelector('svg')
  const rect = svg.getBoundingClientRect()
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(rect.width)
  canvas.height = Math.ceil(rect.height)
  const context = canvas.getContext('2d')
  const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const data = context.getImageData(0, 0, canvas.width, canvas.height)
      const result = window.jsQR(data.data, data.width, data.height)
      resolve(result ? result.data : null)
    }
    image.onerror = reject
    image.src = url
  })
})

console.log('expected :', pairing.url)
console.log('decoded  :', decoded)
console.log('match    :', decoded === pairing.url)
await browser.close()
await harness.close()
