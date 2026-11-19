import * as pty from 'node-pty'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { LocalShellInfo } from '../types'

// LocalShellInfo 定义在 types.ts（渲染层也要用），这里只引不再定义一份

type DataHandler = (payload: { sessionId: string; data: string }) => void
type ExitHandler = (payload: { sessionId: string; exitCode: number; signal?: number }) => void

interface LocalSession {
  proc: pty.IPty
  shell: string
  cwd: string
  /** 收到过 onExit，用于挡住重复回调（kill 之后还会再触发一次） */
  exited: boolean
  /**
   * 累计吐出来的字节数。
   * 这是"shell 到底活没活"最硬的证据 —— 跟窗口有没有焦点、xterm 有没有
   * 渲染出文本行都无关。冒烟里拿它做判据，比去读 DOM 里的提示符稳得多。
   */
  bytes: number
  /**
   * PTY 当前的窗口尺寸。
   *
   * 必须记着：PowerShell 的 PSReadLine 重绘命令行时用的是**绝对光标定位**
   * （`ESC[<行>;<列>H`），行号按它自己那份窗口高度算。这份尺寸只要跟 xterm
   * 的真实行列差一行，敲第二个字符时光标就会画到提示符上面去。
   * 冒烟拿它和界面上的行列做相等断言，专门盯这类错位。
   */
  cols: number
  rows: number
}

/**
 * 本地终端池。
 *
 * 和 SSH 那套故意长得一样：主进程持有真实进程，渲染进程只拿 sessionId。
 * 这样 TerminalView 除了"往哪个通道写字节"之外一行都不用改。
 *
 * ⚠️ 为什么必须用 node-pty 而不是 child_process.spawn：
 * 没有 PTY 的子进程是纯管道，程序自己不回显输入、不刷新提示符，
 * 在 xterm 里表现就是"打字看不见字"，vim / top / more 直接不可用。
 * node-pty 在 Windows 上走 ConPTY、类 Unix 走 forkpty，才是真终端。
 *
 * node-pty 1.1 用的是 N-API 预编译包（prebuilds/），跟我们装的 Electron 33
 * 的 ABI 不冲突 —— 所以 electron-builder 那边的 npmRebuild:false 不用动，
 * 但 asarUnpack 里必须带上它，.node / conpty.dll 在 asar 里 dlopen 不了。
 */
export class LocalShellManager {
  private sessions = new Map<string, LocalSession>()

  constructor(
    private onData: DataHandler,
    private onExit: ExitHandler
  ) {}

  /**
   * 起一个新的本地 shell。
   *
   * cols/rows 跟着渲染层实际的终端尺寸走：先按 120x30 起，xterm 挂上后
   * 会通过 shell:resize 立刻纠正一次。给个小尺寸起会更糟 —— 提示符会先折行再重排。
   */
  async open(cols = 120, rows = 30): Promise<LocalShellInfo> {
    const pick = pickShell()
    const cwd = startDir()
    const sessionId = randomUUID()
    const startCols = Math.max(20, Math.floor(cols) || 120)
    const startRows = Math.max(5, Math.floor(rows) || 30)

    const proc = pty.spawn(pick.file, pick.args, {
      name: 'xterm-256color',
      cols: startCols,
      rows: startRows,
      cwd,
      // process.env 里可能有 undefined，pnpm 脚本注入的变量也会混进来，
      // node-pty 要求纯 string 字典，过滤一遍更稳
      env: cleanEnv()
    })

    const session: LocalSession = {
      proc,
      shell: pick.label,
      cwd,
      exited: false,
      bytes: 0,
      cols: startCols,
      rows: startRows
    }
    this.sessions.set(sessionId, session)

    proc.onData((data) => {
      // 进程已退出后 ConPTY 偶尔还会推最后一帧，会话没了就丢掉
      if (!this.sessions.has(sessionId)) return
      session.bytes += data.length
      this.onData({ sessionId, data })
    })

    proc.onExit(({ exitCode, signal }) => {
      if (session.exited) return
      session.exited = true
      this.sessions.delete(sessionId)
      this.onExit({ sessionId, exitCode, signal })
    })

    return { sessionId, shell: pick.label, cwd }
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.exited) return
    session.proc.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.exited) return
    if (cols < 2 || rows < 2) return
    try {
      session.proc.resize(Math.floor(cols), Math.floor(rows))
      session.cols = Math.floor(cols)
      session.rows = Math.floor(rows)
    } catch {
      /* 进程正在退出时 resize 会抛，忽略即可 */
    }
  }

  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    this.sessions.delete(sessionId)
    session.exited = true
    const pid = session.proc.pid
    try {
      session.proc.kill()
    } catch {
      /* 已经自己退了 */
    }
    if (process.platform === 'win32') {
      // ConPTY 下 proc.kill() 只保证把宿主收掉，shell 本身偶尔会赖着不走
      // （实测：关页签后 pwsh 还在任务管理器里）。给一拍再补 taskkill /T /F。
      setTimeout(() => hardKill(pid), 200)
    }
    return true
  }

  /**
   * 退出应用时统一收口。
   *
   * 这里用**同步** taskkill：调用点紧跟着 app.exit(0) / 进程退出，
   * 异步补刀根本来不及跑，留下的就是孤儿 pwsh。
   */
  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      const session = this.sessions.get(sessionId)
      this.sessions.delete(sessionId)
      if (!session) continue
      session.exited = true
      try {
        session.proc.kill()
      } catch {
        /* 已经退了 */
      }
      if (process.platform === 'win32') hardKillSync(session.proc.pid)
    }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** 这个会话累计吐了多少字节（0 = 进程起来了但一句话都没说） */
  bytesOf(sessionId: string): number {
    return this.sessions.get(sessionId)?.bytes ?? 0
  }

  /** PTY 当前的窗口尺寸（冒烟拿来和界面上的行列数对账） */
  sizeOf(sessionId: string): { cols: number; rows: number } | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return { cols: session.cols, rows: session.rows }
  }
}

/**
 * 挑一个本地 shell。
 *
 * 对齐 IDEA 的默认行为：Windows 上只要机器里有 PowerShell，就用 PowerShell，
 * 而且是在应用内嵌的终端里跑（ConPTY + xterm），不是弹一个 conhost 窗口。
 * 只有 PowerShell 一个都找不到时才退回 cmd。
 *
 * 顺序是 pwsh（PowerShell 7）→ powershell（系统自带 5.1）→ cmd：
 * 装了 7 的人多半是主动装的，尊重它；没装就退回 5.1，别让用户看到"找不到 pwsh"。
 * 5.1 也必须在，因为国内办公机大量只有系统自带的那个。
 *
 * 三个都有编码相关的参数，理由见各自注释 —— 少了这些，中文在 xterm 里就是乱码。
 */
function pickShell(): { file: string; args: string[]; label: string } {
  if (process.platform === 'win32') {
    const pwsh = findExecutable([
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7-preview', 'pwsh.exe'),
      // Store 版 / winget 安装的 pwsh 落在这里，只查 Program Files 会漏掉
      path.join(
        process.env.LOCALAPPDATA || '',
        'Microsoft',
        'WindowsApps',
        'pwsh.exe'
      )
    ])
    if (pwsh) {
      // 不塞 -Command：PowerShell 7 在 PTY 里不带参数就是交互 shell，
      // 行为和用户自己打开的 pwsh 窗口完全一致（$PSStyle 的默认配色、profile、
      // 行内预测建议都按原样来）。
      //
      // 这里曾经加过一段启动脚本，把「蓝底」的目录着色改成前景蓝 —— 为了让浅色主题
      // 下也能看清。用户后来要求还原：终端里看到的样子要跟外面 PowerShell 一模一样，
      // 颜色我们自己不该动手。所以现在只留 -NoLogo（去版权横幅，IDEA 也是这么做的）。
      return { file: pwsh, args: ['-NoLogo'], label: 'PowerShell 7' }
    }

    const winPs = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    if (fs.existsSync(winPs)) {
      // PowerShell 5.1 默认按系统 ANSI 代码页（简中 = GBK）往标准输出写，
      // xterm.js 按 UTF-8 解码 → 中文全成问号。启动时把两端编码都掰到 UTF-8。
      // 用 -NoExit -Command 而不是 -Command：后者执行完就退出，终端会一闪而过。
      return {
        file: winPs,
        args: [
          '-NoLogo',
          '-NoExit',
          '-Command',
          '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8'
        ],
        label: 'Windows PowerShell'
      }
    }

    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
    // cmd 同理：不切 65001 的话 dir / echo 出来的中文路径是乱码
    return { file: comspec, args: ['/K', 'chcp 65001>nul'], label: 'Command Prompt' }
  }

  const shell = process.env.SHELL || '/bin/bash'
  return { file: shell, args: ['-l'], label: path.basename(shell) }
}

/** 只在白名单路径里找，不去扫 PATH —— 主进程扫 PATH 会拖慢首个终端 */
function findExecutable(candidates: string[]): string | undefined {
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file
    } catch {
      /* 权限问题当没有 */
    }
  }
  return undefined
}

/**
 * 补刀用的强杀。
 *
 * 先 `process.kill(pid, 0)` 探活：进程已经退了就什么都不做 ——
 * pid 会被系统复用，无脑 taskkill 有极小概率打中别的进程。
 */
function hardKill(pid: number): void {
  if (!alive(pid)) return
  try {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
      /* 杀不掉也没别的办法了 */
    })
  } catch {
    /* 同上 */
  }
}

function hardKillSync(pid: number): void {
  if (!alive(pid)) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* 同上 */
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 起始目录：用户主目录。取不到就退回系统临时目录，不让 spawn 因 cwd 失败 */
function startDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
  try {
    if (home && fs.statSync(home).isDirectory()) return home
  } catch {
    /* 落到下面 */
  }
  return os.tmpdir()
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  /**
   * TERM 必须**强制**覆盖，不能"有就沿用"。
   *
   * 这个 PTY 是货真价实的 xterm-256color 仿真，主进程自己被什么终端启动的
   * 跟它没关系。以前写成 `env.TERM || 'xterm-256color'`，外层只要是 `TERM=dumb`
   * （IDE 内置终端、CI、某些 SSH 会话都是），就会被原样继承进去 ——
   * 后果是所有依赖 TERM 判断彩色的程序全部退化成无色：git、vim、ls --color，
   * 以及 PowerShell 的 `$PSStyle`（目录名那圈蓝底就是这么消失的）。
   *
   * 排查时踩过：界面上一切正常，就是没有颜色，因为跑冒烟的那个 shell 恰好是 dumb。
   */
  env.TERM = 'xterm-256color'
  // xterm.js 支持 24 位色，报给程序让它别只敢用 256 色
  env.COLORTERM = 'truecolor'
  delete env.ELECTRON_RUN_AS_NODE
  return env
}
