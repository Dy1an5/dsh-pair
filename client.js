/**
 * Client half of `dsh-pair`.
 *
 * Registers one Sidebar page — "手机连接" — that shows the pairing QR for the
 * phone app, the LAN URL behind it, a live expiry countdown, and the devices
 * currently paired. The page only ever calls this profile's own Host plugin;
 * the QR image itself is rendered by the Host from the exact URL the phone
 * will open, so desktop and phone cannot drift apart.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pair',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dshPair'
    const PANEL_ID = 'dsh-pair'
    const ENDPOINT = '/dsh-pair/pair.json'
    const REVOKE_ENDPOINT = '/dsh-pair/revoke.json'

    const ZH = {
      panel: '手机连接',
      title: '手机连接',
      subtitle: '同一个局域网里，用手机扫码继续你的会话。',
      scanTitle: '用相机扫码',
      step1: '手机和这台电脑连同一个 Wi-Fi',
      step2: '用系统相机扫下面的二维码',
      step3: '在手机浏览器里打开，可“添加到主屏幕”',
      refresh: '刷新二维码',
      refreshing: '刷新中…',
      copy: '复制链接',
      copied: '已复制',
      expiresIn: '二维码 {time} 后失效',
      expired: '二维码已失效',
      rotateNow: '换一张',
      devices: '已连接的设备',
      noDevices: '还没有设备连接',
      lastSeen: '最近使用',
      revoke: '断开',
      revokeConfirm: '断开这台设备？它需要重新扫码。',
      loopbackWarn: '当前只监听本机地址，手机连不上。',
      loopbackHint: '用下面这条命令重启，手机就能扫到：',
      copyCommand: '复制命令',
      copied: '已复制',
      otherAddresses: '其它可用地址：{list}',
      appMissing: '没有找到手机端页面。',
      appMissingHint: '把 dsh-pair 行配置里的 appDir 指向手机端 app 目录。',
      urlLabel: '手机地址',
      openLink: '在新标签页打开',
      loading: '正在读取配对信息…',
      error: '读取配对信息失败',
      retry: '重试',
      footer: '二维码等同于这台电脑的访问权限，只给信任的人看。',
    }

    const EN = {
      panel: 'Phone',
      title: 'Connect your phone',
      subtitle: 'Scan once on the same network to keep working from your phone.',
      scanTitle: 'Scan with the camera',
      step1: 'Put the phone on the same Wi-Fi as this computer',
      step2: 'Scan the code with the system camera',
      step3: 'Open it in the browser — “Add to Home Screen” works',
      refresh: 'New code',
      refreshing: 'Refreshing…',
      copy: 'Copy link',
      copied: 'Copied',
      expiresIn: 'Code expires in {time}',
      expired: 'Code expired',
      rotateNow: 'Get a new one',
      devices: 'Connected devices',
      noDevices: 'No device has connected yet',
      lastSeen: 'last seen',
      revoke: 'Disconnect',
      revokeConfirm: 'Disconnect this device? It will need to scan again.',
      loopbackWarn: 'The listener is loopback-only, so a phone cannot reach it.',
      loopbackHint: 'Restart with this command and the phone can reach it:',
      copyCommand: 'Copy command',
      copied: 'Copied',
      otherAddresses: 'Other addresses: {list}',
      appMissing: 'The phone app is not on disk yet.',
      appMissingHint: 'Point appDir on the dsh-pair row at the phone app directory.',
      urlLabel: 'Phone URL',
      openLink: 'Open in a new tab',
      loading: 'Reading pairing state…',
      error: 'Could not read pairing state',
      retry: 'Retry',
      footer: 'The QR grants this computer’s access — show it only to people you trust.',
    }

    const css = `
.dm-page{width:100%;height:100%;min-height:0;overflow:auto;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}
.dm-wrap{max-width:680px;margin:0 auto;padding:clamp(20px,4vw,40px) clamp(20px,4vw,40px) 48px;display:flex;flex-direction:column;gap:20px}
.dm-head{display:flex;flex-direction:column;gap:4px}
.dm-title{font-size:20px;font-weight:600;letter-spacing:-.01em}
.dm-sub{color:var(--dsw-alias-label-secondary);font-size:13px}
.dm-card{background:var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l3);border-radius:16px;padding:20px}
.dm-card--qr{display:flex;flex-direction:column;align-items:center;gap:14px}
.dm-qr{background:#fff;border-radius:14px;padding:12px;line-height:0;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dm-qr svg{width:min(260px,62vw);height:auto;display:block}
.dm-qr-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.dm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:inherit;border-radius:9px;padding:7px 14px;font-size:13px;font-family:inherit;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.dm-btn:hover{background:var(--dsw-alias-bg-hover, rgba(127,127,127,.08))}
.dm-btn--primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dm-btn--primary:hover{opacity:.9;background:var(--dsw-alias-brand-primary)}
.dm-btn:disabled{opacity:.5;cursor:default}
.dm-expiry{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.dm-steps{display:grid;gap:8px;margin:0;padding:0;list-style:none;width:100%;max-width:420px}
.dm-step{display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dm-step-n{flex:none;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-hover, rgba(127,127,127,.12))}
.dm-warn{border:1px solid #b7791f55;background:#b7791f14;color:#b7791f;border-radius:12px;padding:12px 14px;font-size:13px}
.dm-warn strong{display:block;margin-bottom:2px}
.dm-cmd{display:flex;gap:8px;align-items:center;margin-top:10px;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.18);font-family:var(--ds-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12.5px}
.dm-cmd code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap;color:inherit}
.dm-btn--tiny{flex:none;padding:4px 10px;font-size:12px}
.dm-hint{display:block;margin-top:8px;opacity:.8;font-size:12px}
.dm-url{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-hover, rgba(127,127,127,.08));font-family:var(--ds-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12.5px;overflow:hidden}
.dm-url span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.dm-url a{flex:none;color:var(--dsw-alias-brand-primary);text-decoration:none}
.dm-section-title{display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:600;margin-bottom:10px}
.dm-devices{display:flex;flex-direction:column;gap:2px}
.dm-device{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l3)}
.dm-device:first-child{border-top:none}
.dm-device-main{display:flex;flex-direction:column;gap:1px;min-width:0}
.dm-device-name{font-size:13px}
.dm-device-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dm-empty{font-size:13px;color:var(--dsw-alias-label-secondary);padding:6px 0}
.dm-foot{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dm-error{display:flex;flex-direction:column;gap:10px;align-items:flex-start}
@media (prefers-color-scheme: dark){.dm-qr{box-shadow:none}}
`

    /**
     * Format a millisecond countdown as `m:ss`.
     * @param ms - remaining milliseconds.
     * @returns short duration.
     */
    function formatDuration(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${minutes}:${String(seconds).padStart(2, '0')}`
    }

    /**
     * Relative time for a device row, in the page's language.
     * @param value - epoch milliseconds.
     * @returns coarse relative label.
     */
    function relative(value) {
      const delta = Date.now() - Number(value ?? 0)
      if (!Number.isFinite(delta) || delta < 0) return ''
      const minutes = Math.floor(delta / 60_000)
      try {
        const formatter = new Intl.RelativeTimeFormat((globalThis.document?.documentElement?.lang ?? 'zh').slice(0, 2), { numeric: 'auto' })
        if (minutes < 1) return formatter.format(0, 'minute')
        if (minutes < 60) return formatter.format(-minutes, 'minute')
        const hours = Math.floor(minutes / 60)
        if (hours < 24) return formatter.format(-hours, 'hour')
        return formatter.format(-Math.floor(hours / 24), 'day')
      } catch {
        return `${minutes} min`
      }
    }

    /**
     * Countdown that re-renders once a second and reports expiry.
     * @param props - expiry instant and the callback invoked at zero.
     * @returns countdown text.
     */
    function useCountdown(expiresAt, onExpire) {
      const [now, setNow] = React.useState(() => Date.now())
      const expiredRef = React.useRef(false)
      React.useEffect(() => {
        expiredRef.current = false
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [expiresAt])
      const remaining = Number(expiresAt ?? 0) - now
      React.useEffect(() => {
        if (remaining <= 0 && !expiredRef.current) {
          expiredRef.current = true
          onExpire?.()
        }
      }, [remaining, onExpire])
      return { remaining, expired: remaining <= 0 }
    }

    /**
     * The pairing page.
     * @returns the page element.
     */
    function MobilePage() {
      const t = React.useMemo(() => (key, vars) => {
        const dict = (globalThis.document?.documentElement?.lang ?? '').startsWith('zh') ? ZH : EN
        let out = dict[key] ?? EN[key] ?? key
        if (vars) for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, String(value))
        return out
      }, [])
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: '' })
      const [copied, setCopied] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(
        async (rotate) => {
          setBusy(true)
          try {
            const response = await fetch(`${ENDPOINT}${rotate ? '?rotate=1' : ''}`, {
              credentials: 'same-origin',
              cache: 'no-store',
            })
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
            const data = await response.json()
            setState({ phase: 'ready', data, error: '' })
          } catch (error) {
            setState({ phase: 'error', data: null, error: error instanceof Error ? error.message : String(error) })
          } finally {
            setBusy(false)
          }
        },
        [],
      )

      React.useEffect(() => {
        load(false)
      }, [load])

      const rotate = React.useCallback(() => {
        setCopied(false)
        load(true)
      }, [load])

      const { remaining, expired } = useCountdown(state.data?.expiresAt, rotate)

      /** Copy one string, flashing the shared "copied" state. */
      const copyText = React.useCallback(async text => {
        if (typeof text !== 'string' || text === '') return
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          setCopied(false)
        }
      }, [])

      const copy = React.useCallback(() => copyText(state.data?.url), [copyText, state.data])

      const revoke = React.useCallback(
        async (deviceId) => {
          if (!window.confirm(t('revokeConfirm'))) return
          try {
            await fetch(REVOKE_ENDPOINT, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ deviceId }),
            })
            await load(false)
          } catch {
            // The list simply stays as it was; the user can retry.
          }
        },
        [load, t],
      )

      if (state.phase === 'loading') {
        return h('div', { className: 'dm-page' }, h('div', { className: 'dm-wrap' }, h('div', { className: 'dm-sub' }, t('loading'))))
      }

      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'dm-page' },
          h(
            'div',
            { className: 'dm-wrap' },
            h('div', { className: 'dm-title' }, t('title')),
            h(
              'div',
              { className: 'dm-card dm-error' },
              h('div', null, `${t('error')}: ${state.error}`),
              h('button', { className: 'dm-btn', onClick: () => load(false) }, t('retry')),
            ),
          ),
        )
      }

      const data = state.data
      const devices = Array.isArray(data.devices) ? data.devices : []

      return h(
        'div',
        { className: 'dm-page' },
        h(
          'div',
          { className: 'dm-wrap' },
          h(
            'div',
            { className: 'dm-head' },
            h('div', { className: 'dm-title' }, t('title')),
            h('div', { className: 'dm-sub' }, t('subtitle')),
          ),

          data.loopback
            ? h(
                'div',
                { className: 'dm-warn' },
                h('strong', null, t('loopbackWarn')),
                h('span', null, t('loopbackHint')),
                // The exact command, with this machine's address already in it:
                // "run it with --host" is useless without saying which address.
                data.bindCommand
                  ? h(
                      'div',
                      { className: 'dm-cmd' },
                      h('code', null, data.bindCommand),
                      h(
                        'button',
                        {
                          className: 'dm-btn dm-btn--tiny',
                          type: 'button',
                          onClick: () => copyText(data.bindCommand),
                        },
                        t('copyCommand'),
                      ),
                    )
                  : null,
                (data.lanAddresses ?? []).length > 1
                  ? h('span', { className: 'dm-hint' }, t('otherAddresses', { list: data.lanAddresses.slice(1).join('、') }))
                  : null,
              )
            : null,

          data.appReady === false
            ? h(
                'div',
                { className: 'dm-warn' },
                h('strong', null, t('appMissing')),
                h('span', null, t('appMissingHint')),
              )
            : null,

          h(
            'div',
            { className: 'dm-card dm-card--qr' },
            h('div', { className: 'dm-qr', 'aria-hidden': true, dangerouslySetInnerHTML: { __html: data.svg } }),
            expired
              ? h(
                  'div',
                  { className: 'dm-qr-actions' },
                  h('div', { className: 'dm-expiry' }, t('expired')),
                  h('button', { className: 'dm-btn dm-btn--primary', onClick: rotate, disabled: busy }, t('rotateNow')),
                )
              : h(
                  'div',
                  { className: 'dm-qr-actions' },
                  h('button', { className: 'dm-btn dm-btn--primary', onClick: rotate, disabled: busy }, busy ? t('refreshing') : t('refresh')),
                  h('button', { className: 'dm-btn', onClick: copy }, copied ? t('copied') : t('copy')),
                ),
            h('div', { className: 'dm-expiry' }, t('expiresIn', { time: formatDuration(remaining) })),
            h(
              'ol',
              { className: 'dm-steps' },
              [t('step1'), t('step2'), t('step3')].map((line, index) =>
                h('li', { key: line, className: 'dm-step' }, h('span', { className: 'dm-step-n' }, String(index + 1)), h('span', null, line)),
              ),
            ),
          ),

          h(
            'div',
            { className: 'dm-card' },
            h('div', { className: 'dm-section-title' }, t('urlLabel')),
            h(
              'div',
              { className: 'dm-url' },
              h('span', null, data.url.replace(/[?&]t=.*$/u, '')),
              h('a', { href: data.url, target: '_blank', rel: 'noreferrer' }, t('openLink')),
            ),
          ),

          h(
            'div',
            { className: 'dm-card' },
            h('div', { className: 'dm-section-title' }, h('span', null, t('devices')), h('span', { className: 'dm-device-meta' }, String(devices.length))),
            devices.length === 0
              ? h('div', { className: 'dm-empty' }, t('noDevices'))
              : h(
                  'div',
                  { className: 'dm-devices' },
                  devices.map(device =>
                    h(
                      'div',
                      { key: device.id, className: 'dm-device' },
                      h(
                        'div',
                        { className: 'dm-device-main' },
                        h('span', { className: 'dm-device-name' }, device.label),
                        h('span', { className: 'dm-device-meta' }, `${t('lastSeen')} ${relative(device.lastSeenAt)}`),
                      ),
                      h('button', { className: 'dm-btn', onClick: () => revoke(device.id) }, t('revoke')),
                    ),
                  ),
                ),
          ),

          h('div', { className: 'dm-foot' }, t('footer')),
        ),
      )
    }

    /**
     * Sidebar glyph: a phone showing a QR square.
     * @param props - requested edge length.
     * @returns the icon element.
     */
    function MobileIcon({ size }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 3.2, y: 1.4, width: 9.6, height: 13.2, rx: 2.1, stroke: 'currentColor', strokeWidth: '1.2' }),
        h('rect', { x: 5.4, y: 4, width: 2.4, height: 2.4, rx: .6, fill: 'currentColor' }),
        h('rect', { x: 8.4, y: 4, width: 2.2, height: 2.2, rx: .5, fill: 'currentColor', opacity: .55 }),
        h('rect', { x: 5.4, y: 7.2, width: 2.2, height: 2.2, rx: .5, fill: 'currentColor', opacity: .55 }),
        h('rect', { x: 8.4, y: 7.2, width: 2.4, height: 2.4, rx: .6, fill: 'currentColor' }),
        h('rect', { x: 6.6, y: 12.2, width: 2.8, height: .9, rx: .45, fill: 'currentColor', opacity: .4 }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-pair: dictionaries')
        document.querySelectorAll('style[data-dsh-pair]').forEach(node => node.remove())
        const style = document.createElement('style')
        style.dataset.dshPair = ''
        style.textContent = css
        document.head.append(style)
        ctx.effect(() => () => style.remove(), 'dsh-pair: styles')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, MobilePage))
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 24, locale: NS, label: () => t('panel') }, MobileIcon),
        )
      },
    }
  },
})
