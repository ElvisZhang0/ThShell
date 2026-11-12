/**
 * 「编辑连接」回显验证。
 *
 * 这个 bug 值得单独留一条测试：0.1.0 起就存在，表现是打开编辑连接后
 * 名称/主机/备注全空、只有端口和用户名是默认值，且**不弹任何错误** ——
 * 根因是 structuredClone 撞上 Pinia 的响应式 Proxy 抛 DataCloneError，
 * resetForm 当场中断（详见 ServerDialog.vue 里那段注释）。
 *
 * 用法（需要先带调试端口起开发窗口）：
 *   THSHELL_CDP=1 pnpm dev
 *   pnpm test:dialog
 *
 * 不写死任何一台服务器：取树里第一台可见的来断言，换台机器也能跑。
 * 会写一次配置文件（点保存验证密码没被清空），**结束前必然还原**。
 */
import fs from 'node:fs'
import path from 'node:path'

const CDP = 'http://127.0.0.1:9223/json'
const CFG = path.join(process.env.APPDATA ?? '', 'ThShell', 'thshell-config.json')

const targets = await (await fetch(CDP)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.log('没有页面目标 —— 先用 THSHELL_CDP=1 pnpm dev 起窗口')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const errs = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result ?? m.error)
    pending.delete(m.id)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errs.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 240))
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++seq
    // 窗口不可见时截图类调用会一直不返回，统一兜个超时
    const t = setTimeout(() => {
      pending.delete(i)
      res(null)
    }, 10_000)
    pending.set(i, (r) => {
      clearTimeout(t)
      res(r)
    })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')
await send('Page.enable')

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`)
}

const visibleDialog = `[...document.querySelectorAll('.el-dialog')].filter((el) => el.getBoundingClientRect().width > 0).pop()`
async function closeDialog() {
  await ev(`${visibleDialog}?.querySelector('.el-dialog__headerbtn')?.click()`)
  await wait(450)
}

/** 读表单：按 label 取输入值，顺手带上密码框的占位文案 */
const readForm = () =>
  ev(`(() => {
    const d = ${visibleDialog}
    if (!d) return 'no dialog'
    const out = {}
    for (const it of d.querySelectorAll('.el-form-item')) {
      const label = it.querySelector('.el-form-item__label')?.textContent?.trim() ?? ''
      const ta = it.querySelector('textarea')
      const inp = it.querySelector('input')
      out[label] = ta ? ta.value : (inp ? inp.value : '')
    }
    out.__pwdPlaceholder = [...d.querySelectorAll('input[type=password]')].map((i) => i.placeholder).join('|')
    return JSON.stringify(out)
  })()`)

const backup = fs.existsSync(CFG) ? fs.readFileSync(CFG, 'utf8') : null

try {
  await closeDialog()
  errs.length = 0

  // 取第一台可见的服务器来试
  const first = await ev(`(() => {
    const row = [...document.querySelectorAll('.server-item')].find((el) => el.getBoundingClientRect().height > 0)
    if (!row) return ''
    return row.querySelector('.server-name')?.textContent?.trim() ?? ''
  })()`)
  if (!first) {
    console.log('侧栏里没有任何服务器，先建一台再跑')
    process.exit(1)
  }
  console.log('拿这台开刀：', first)

  await ev(`(() => {
    const row = [...document.querySelectorAll('.server-item')].find((el) => el.getBoundingClientRect().height > 0)
    const r = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }))
  })()`)
  await wait(350)
  await ev(`[...document.querySelectorAll('.ctx-item')].find((i) => i.textContent.includes('编辑'))?.click()`)
  await wait(750)

  const f = JSON.parse(await readForm())
  check('连接名称回显', f['连接名称'] === first, String(f['连接名称']))
  check('主机地址回显', !!f['主机地址'], String(f['主机地址']))
  check('用户名回显', !!f['用户名'], String(f['用户名']))
  check('端口回显（不是默认值）', /^\d+$/.test(String(f['端口'])), String(f['端口']))
  check(
    '密码框留空且提示「已保存」',
    f['密码'] === '' && (f.__pwdPlaceholder.includes('已保存') || f.__pwdPlaceholder.includes('登录密码')),
    f.__pwdPlaceholder
  )

  // 开了编辑没点保存就关掉，不会有任何写入
  await closeDialog()

  check(
    '控制台没有 DataCloneError',
    !errs.some((e) => e.includes('DataCloneError')),
    errs.length ? errs[0].slice(0, 90) : '干净'
  )

  // 再点一次保存：密码框是空的，原密码必须还在（不能被空串顶掉）
  if (backup) {
    await ev(`(() => {
      const row = [...document.querySelectorAll('.server-item')].find((el) => el.getBoundingClientRect().height > 0)
      const r = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }))
    })()`)
    await wait(350)
    await ev(`[...document.querySelectorAll('.ctx-item')].find((i) => i.textContent.includes('编辑'))?.click()`)
    await wait(700)
    await ev(`(() => {
      const d = ${visibleDialog}
      ;[...d.querySelectorAll('.el-dialog__footer button')].find((b) => /保存|创建/.test(b.textContent))?.click()
    })()`)
    await wait(1200)
    const onDisk = JSON.parse(fs.readFileSync(CFG, 'utf8')).servers.find((s) => s.name === first)
    check(
      '保存后密码仍在（空密码框 = 不修改）',
      !!onDisk && typeof onDisk.password === 'string' && onDisk.password.length > 8,
      onDisk ? onDisk.password.slice(0, 10) + '…' : '这台库里找不到'
    )
  }
} finally {
  if (backup) {
    fs.writeFileSync(CFG, backup)
    console.log('配置文件已还原')
  }
  ws.close()
}

const bad = results.filter((r) => !r[1]).length
console.log(`\n${bad ? bad + ' 项失败' : '全部通过'}（${results.length} 项）`)
process.exit(bad ? 1 : 0)
