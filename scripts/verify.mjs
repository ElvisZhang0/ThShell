#!/usr/bin/env node
/**
 * 一条命令跑完冒烟验证。
 *
 * 为什么需要它：
 * 1. 验证项一多，手动 `THSHELL_SMOKE=xxx` 一个个跑既慢又容易漏 ——
 *    改了文件管理器的图标，其实 text/log/edit/tips/icons 都该过一遍，人工记不住。
 * 2. 更要命的是**上一次的窗口没退干净**：ThShell 有单实例锁，第二个实例抢不到锁会
 *    静默 `app.quit()` —— 零输出、退出码 0、日志 2 字节，看着像代码编译坏了。
 *    这里每个进程自己等它 exit 再跑下一个，并显式识别"无任何 [smoke] 输出"这种情形。
 *
 * 用法：
 *   npm run verify              # 默认跑 core：text log edit tips icons
 *   npm run verify -- log tips  # 只跑这两组
 *   npm run verify -- --layout  # 布局/视觉那批（foot menu jump transfer clip tabs quick monitor sys）
 *   npm run verify -- --all     # 全跑
 *   npm run verify -- -b        # 先 build 再跑
 *   npm run verify -- -v        # 逐条打印断言（默认只吐失败行）
 *   npm run verify -- --list    # 看看有哪些组
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** electron 包导出的就是可执行文件路径 */
const electronPath = require('electron')

/** 改完代码必须过一遍的几组：都自带数据准备，不依赖机器上有什么文件 */
const CORE = ['bar', 'update', 'text', 'log', 'pdf', 'edit', 'tips', 'icons', 'perm']
/** 布局 / 视觉类：只在动了对应区域时带上，跑得慢（每组 ~10s） */
const LAYOUT = ['foot', 'menu', 'jump', 'transfer', 'clip', 'tabs', 'quick', 'monitor', 'sys']
const ALL = [...CORE, ...LAYOUT]

const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('-'))
const named = argv
  .filter((a) => !a.startsWith('-'))
  .join(',')
  .split(',')
  .filter(Boolean)

let groups = named.length ? named : CORE
if (flags.includes('--all')) groups = ALL
else if (flags.includes('--layout')) groups = named.length ? named : LAYOUT

if (flags.includes('--list')) {
  console.log('core  :', CORE.join(' '))
  console.log('layout:', LAYOUT.join(' '))
  process.exit(0)
}

const TIMEOUT_MS = 150_000

function runBuild() {
  console.log('▶ build（vue-tsc + vite）…')
  const r = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    console.error('✗ build 失败，先修编译错误')
    process.exit(1)
  }
}

function runOne(mode) {
  return new Promise((resolve) => {
    const started = Date.now()
    const env = { ...process.env, THSHELL_SMOKE: mode }
    // 有它在 Electron 会退化成纯 Node 进程，窗口都起不来
    delete env.ELECTRON_RUN_AS_NODE

    const child = spawn(electronPath, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''

    // 默认只实时吐失败行，其余的攒到最后汇总 —— 全过程刷屏反而看不见重点。
    // 想逐条看就加 -v。
    const verbose = flags.includes('-v') || flags.includes('--verbose')
    const onChunk = (buf) => {
      const text = buf.toString()
      out += text
      for (const line of text.split('\n')) {
        if (verbose && line.includes('[smoke]')) process.stdout.write(`  ${line.trim()}\n`)
        else if (/\[smoke\].*(FAIL|MISS)/.test(line)) process.stdout.write(`  ${line.trim()}\n`)
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)

    const timer = setTimeout(() => {
      out += '\n[verify] 超时，已杀掉进程\n'
      child.kill()
    }, TIMEOUT_MS)

    child.on('exit', (code) => {
      clearTimeout(timer)
      const pass = (out.match(/\[smoke\] PASS/g) || []).length
      const fail = (out.match(/\[smoke\] FAIL/g) || []).length
      const miss = (out.match(/\[smoke\] MISS/g) || []).length
      // 每组的收尾语句格式不统一（"全部通过（31 项）" / "全部有提示" / "全部一致"），
      // 认"不是 PASS/FAIL/MISS/SKIP 的那条 [smoke] 行"最稳
      const tails = out
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('[smoke]') && !/^\[smoke\]\s*(PASS|FAIL|MISS|SKIP)/.test(s))
      resolve({ mode, pass, fail: fail + miss, verdict: tails.pop() || '', out, ms: Date.now() - started, code })
    })
  })
}

const results = []
const t0 = Date.now()
if (flags.includes('-b') || flags.includes('--build')) runBuild()

function killStray() {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' })
  }
  return new Promise((r) => setTimeout(r, 2500))
}

console.log(`▶ 跑 ${groups.length} 组：${groups.join(' ')}\n`)
for (const mode of groups) {
  process.stdout.write(`▶ ${mode} … `)
  let r = await runOne(mode)
  let silent = !/\[smoke\]/.test(r.out)
  if (silent) {
    // 单实例锁的竞态：上一组的 Electron 还没退干净，这一组起来就被顶掉、一条都不打印。
    // 清掉残留进程重跑一次 —— 真失败会打印 FAIL 行，不会被这个重试掩盖
    await killStray()
    process.stdout.write('（重试）… ')
    r = await runOne(mode)
    silent = !/\[smoke\]/.test(r.out)
  }
  results.push(r)
  console.log(silent ? `静默退出（${r.ms}ms）` : `${r.pass} 项通过${r.fail ? `，${r.fail} 项失败` : ''}（${r.ms}ms）`)
  if (silent) {
    console.log('  ⚠ 这个模式一条 [smoke] 都没输出，重试也没起来 —— 大概有别的 ThShell 开着占单实例锁。')
    console.log('    关掉已运行的 ThShell 再跑。')
  }
}

/* ---------------- 汇总 ---------------- */
const bad = results.filter((r) => r.fail > 0 || !/\[smoke\]/.test(r.out))
console.log('\n──────── 汇总 ────────')
for (const r of results) {
  const mark = r.fail > 0 ? '✗' : /\[smoke\]/.test(r.out) ? '✓' : '?'
  console.log(`${mark} ${r.mode.padEnd(9)} ${(r.verdict || '无结果').replace(/^\[smoke\]\s*/, '')}`)
}
const totalSec = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`──────── ${results.length} 组，${bad.length ? bad.length + ' 组有问题' : '全部通过'}，${totalSec}s ────────`)
process.exit(bad.length ? 1 : 0)
