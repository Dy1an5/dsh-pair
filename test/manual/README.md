# Manual checks

Not part of `node --test`; they need a browser and a couple of dev packages.
Run them when changing the phone UI or the QR renderer.

```bash
cd dsh-pair/test/manual
npm init -y >/dev/null
npm i playwright-core jsqr

# Chromium: set CHROME_PATH if it is not at the default Playwright cache path.
CHROME_PATH=/path/to/chrome node e2e.mjs      # screenshots into ./shots
JSQR_PATH=./node_modules/jsqr/dist/jsQR.js node qr-check.mjs
```

`e2e.mjs` boots the real plugin HTTP surface with fixture services, drives it in
Chromium at iPhone metrics, checks that pairing is consumed, that a session
opens, that the composer delivers a prompt, and that the layout has no
horizontal overflow. `qr-check.mjs` decodes the generated QR and asserts it
matches the pairing URL.
