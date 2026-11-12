/**
 * 更新链路验证：证明「An object could not be cloned」已经不在，
 * 并核对「下载 → 安装」一站式按钮的文案与失败呈现。
 *
 * 刻意不真的安装：所有会被点到的 asset 都指向 404，
 * 只有一次受控的下载成功验证（下完不调 install）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const PORT = 18911
const payload = Buffer.alloc(4096, 7)
const sha = crypto.createHash('sha256').update(payload).digest('hex')

const server = http.createServer((req, res) => {
  if (req.url?.endsWith('fake.exe')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length })
    res.end(payload)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log('[1/6] 本地源已起在', PORT)

/* ---------------------------------------------------------------- CDP 管道 */

const targets = await (await fetch('http://127.0.0.1:9223/json')).json()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.log('没有页面目标')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result ?? m.error)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++seq
    const timer = setTimeout(() => {
      // 窗口被遮挡或最小化时 Page.captureScreenshot 会一直不返回。
      // 截图只是佐证，卡住它不该拖死整轮验证。
      pending.delete(i)
      res(null)
    }, 12_000)
    pending.set(i, (r) => {
      clearTimeout(timer)
      res(r)
    })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')
await send('Page.enable')

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '') }
  return r?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ 场景 */

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`)
}

// 1. 打开「更新」相关菜单，点「检查更新」
await evaluate(`document.querySelectorAll('.menubar .el-dropdown .mb')[0]?.click()`)
await wait(500)
await evaluate(`[...document.querySelectorAll('.tb-dropdown .el-dropdown-menu__item')]
  .find((i) => i.textContent.includes('检查更新'))?.click()`)
await wait(800)

// 让默认那次联网检查结束（最多 13 秒），再用本地数据接管
for (let i = 0; i < 26; i += 1) {
  const busy = await evaluate(`(async () => {
    const m = await import('/src/utils/update-state.ts')
    return m.updateState.checking
  })()`)
  if (busy === false) break
  await wait(600)
}

// 2. 注入一个「有新版本」的结果。赋值进 reactive 之后 asset 就是 Proxy —— 正是原来出事的地方
const goodAsset = {
  platform: 'win32',
  arch: 'x64',
  format: 'exe',
  url: `http://127.0.0.1:${PORT}/fake.exe`,
  size: payload.length,
  sha256: sha
}
const injected = await evaluate(`(async () => {
  const m = await import('/src/utils/update-state.ts')
  m.updateState.result = {
    current: '0.2.1', latest: '0.2.2', hasUpdate: true,
    asset: ${JSON.stringify(goodAsset)}, feed: 'http://127.0.0.1:${PORT}/latest.json'
  }
  m.updateState.error = ''
  return JSON.stringify({ v: m.updateState.result.latest, a: m.updateState.result.asset.url })
})()`)
check('界面能拿到注入的更新结果', String(injected).includes('0.2.2'), String(injected).slice(0, 80))

const dlgText = await evaluate(`(() => {
  const ds = [...document.querySelectorAll('.el-dialog')].filter((el) => el.getBoundingClientRect().width > 0)
  return ds.length ? ds[ds.length - 1].textContent.replace(/\\s+/g, ' ').trim() : ''
})()`)
check('弹窗显示新版本号', String(dlgText).includes('0.2.2'), String(dlgText).slice(0, 90))
check('不再有「下载 / 安装」两个按钮', !String(dlgText).includes('已下载到本地'), String(dlgText).slice(0, 60))

const btnText = await evaluate(`(() => {
  const ds = [...document.querySelectorAll('.el-dialog')].filter((el) => el.getBoundingClientRect().width > 0)
  const d = ds[ds.length - 1]
  if (!d) return ''
  const b = [...d.querySelectorAll('.el-dialog__footer button')].find((x) => x.classList.contains('el-button--primary'))
  return b ? b.textContent.trim() : ''
})()`)
check('主按钮是「升级到 0.2.2」', String(btnText).includes('升级到 0.2.2'), String(btnText))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = path.join(process.env.TEMP ?? '/tmp', 'thshell-upgrade-dialog.png')
if (shot?.data) { fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64')); console.log('截图：', shotPath) } else console.log('截图跳过（窗口不可见）')

// 3. 真跑一次下载（不装）：证明 plain 之后的 asset 能过 IPC 且校验通过
const dl = await evaluate(`(async () => {
  const m = await import('/src/utils/update-state.ts')
  try {
    const p = await m.runDownload()
    return JSON.stringify({ ok: true, p: String(p) })
  } catch (e) {
    return JSON.stringify({ ok: false, e: String(e && e.message) })
  }
})()`)
const dlObj = JSON.parse(String(dl))
const clonedErr = String(dlObj.e ?? '').includes('could not be cloned')
check('asset 能过 IPC（无 clone 报错）', !clonedErr, clonedErr ? String(dlObj.e).slice(0, 80) : '无克隆错误')
check(
  '下载完成且校验通过',
  dlObj.ok && fs.existsSync(dlObj.p) && fs.statSync(dlObj.p).size === payload.length,
  dlObj.ok ? `${dlObj.p} → ${dlObj.p ? fs.statSync(dlObj.p).size : 0} 字节` : String(dlObj.e).slice(0, 80)
)

// 4. 换成 404 的包，点主按钮：应当停在下载失败，绝不进入安装
await evaluate(`(async () => {
  const m = await import('/src/utils/update-state.ts')
  m.updateState.filePath = ''
  m.updateState.error = ''
  m.updateState.result = {
    current: '0.2.1', latest: '0.2.2', hasUpdate: true,
    asset: { platform: 'win32', arch: 'x64', format: 'exe',
             url: 'http://127.0.0.1:${PORT}/missing.exe', size: 4096 }
  }
  return 'ready'
})()`)
await wait(400)
await evaluate(`(() => {
  const ds = [...document.querySelectorAll('.el-dialog')].filter((el) => el.getBoundingClientRect().width > 0)
  const d = ds[ds.length - 1]
  const b = d && [...d.querySelectorAll('.el-dialog__footer button')].find((x) => x.classList.contains('el-button--primary'))
  b?.click()
  return !!b
})()`)
await wait(3500)

const after = await evaluate(`(async () => {
  const m = await import('/src/utils/update-state.ts')
  return JSON.stringify({
    err: m.updateState.error, launched: m.updateState.launched,
    installing: m.updateState.installing, downloading: m.updateState.downloading
  })
})()`)
const a = JSON.parse(String(after))
check('点一次按钮就自己开始下载（无需第二次点击）', a.downloading === false, `downloading=${a.downloading}`)
check('下载失败时错误给人话', !!a.err && !a.err.includes('could not be cloned'), String(a.err).slice(0, 90))
check('下载失败不会去装空文件', a.launched === false, `launched=${a.launched}`)

const shot2 = await send('Page.captureScreenshot', { format: 'png' })
const shotPath2 = path.join(process.env.TEMP ?? '/tmp', 'thshell-upgrade-fail.png')
if (shot2?.data) { fs.writeFileSync(shotPath2, Buffer.from(shot2.data, 'base64')); console.log('截图：', shotPath2) } else console.log('截图跳过（窗口不可见）')

server.close()
ws.close()
const bad = results.filter((r) => !r[1]).length
console.log(`\n${bad ? bad + ' 项失败' : '全部通过'}（${results.length} 项）`)
process.exit(bad ? 1 : 0)
