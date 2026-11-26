import type { ProcRow, ProcSnapshot, ProcStats } from '../types'
import type { ExecFn } from './metrics'

/**
 * 一次 SSH 往返把所有要的东西都拿回来。
 *
 * 分隔符用 **0x1F（US，单元分隔符）**，不是 `@@`。
 * ps 的 args 是任意命令行，某个训练脚本里完全可能带 `@@`，
 * 一旦出现，后面所有段都会错位 —— 表现是「进程表有，但内存 0/0、负载 NaN」，
 * 排查起来极其难受。0x1F 是控制字符，命令行里敲不出来，安全得多。
 *
 * 几个刻意的写法：
 * - `ps -ww` 不限宽，否则长命令行会被截成 80 列，看不出是哪个 java 参数开的
 * - `pid=` 这种尾等号是「不要表头」，省得按列位置切
 * - 瞬时 CPU 必须自己算（`/proc/<pid>/stat` 的 utime+stime），ps 的 pcpu
 *   是**进程生命周期平均值** —— 一个跑了两天的进程即使现在满核，ps 也只显示个位数
 */
const SEP = '\x1f'
const mark = (tag: string): string => `printf '\\037${tag}\\037\\n'`

const SCRIPT = `export LC_ALL=C
${mark('PS')}
ps -ww -eo pid=,ppid=,user=,stat=,nlwp=,rss=,pcpu=,args= 2>&1
${mark('TICKS')}
awk '{print $1" "$14+$15}' /proc/[0-9]*/stat 2>/dev/null
${mark('CPU')}
head -1 /proc/stat
${mark('CORES')}
grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 0
${mark('LOAD')}
cat /proc/loadavg 2>/dev/null
${mark('MEM')}
head -4 /proc/meminfo 2>/dev/null
${mark('HTOP')}
command -v htop 2>/dev/null || true
${mark('PKG')}
if command -v apt-get >/dev/null 2>&1; then echo apt
elif command -v dnf >/dev/null 2>&1; then echo dnf
elif command -v yum >/dev/null 2>&1; then echo yum
elif command -v zypper >/dev/null 2>&1; then echo zypper
elif command -v apk >/dev/null 2>&1; then echo apk
elif command -v pacman >/dev/null 2>&1; then echo pacman
else echo unknown; fi
${mark('OS')}
(. /etc/os-release >/dev/null 2>&1 && echo "$PRETTY_NAME") || uname -s
${mark('END')}`

/** 各发行版的安装命令。CentOS 7 的 htop 在 EPEL 里，得先装仓库 */
const INSTALL_CMD: Record<string, string> = {
  apt: 'sudo apt update && sudo apt install -y htop',
  dnf: 'sudo dnf install -y htop',
  yum: 'sudo yum install -y epel-release && sudo yum install -y htop',
  zypper: 'sudo zypper install -y htop',
  apk: 'sudo apk add htop',
  pacman: 'sudo pacman -S --noconfirm htop',
  unknown: '没有识别出包管理器，请手动安装 htop'
}

/** 返回多少行。企业服务器一般 100~500 个进程，800 行足够，再多 JSON 就臃肿了 */
const MAX_ROWS = 800

interface PrevState {
  ticks: Map<number, number>
  cpuTotal: number
  /** idle + iowait 的累计 ticks：全机占用率靠「总增量里有多少不是空转」算 */
  idleTotal: number
}

const prevMap = new Map<string, PrevState>()

/** `ps -eo pid,ppid,user,stat,nlwp,rss,pcpu,args` 的一行 */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s*(.*)$/

interface RawProc {
  pid: number
  ppid: number
  user: string
  stat: string
  threads: number
  rss: number
  pcpu: number
  cmd: string
}

/**
 * 命令行截断上限。
 * java 的启动参数动辄几 KB，一台机器几百个进程时整包里全是这些字符串：
 * 界面只有一行、靠省略号截，多出来的纯属白搬（IPC + 解析 + DOM 文本）。
 * 400 字符足够认出是哪个服务、哪个 jar，鼠标悬停看也够。
 */
const CMD_MAX = 400

function trimCmd(cmd: string): string {
  return cmd.length > CMD_MAX ? `${cmd.slice(0, CMD_MAX)}…` : cmd
}

function parsePs(raw: string): RawProc[] {
  const out: RawProc[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const m = PS_LINE.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    if (!Number.isFinite(pid) || pid <= 0) continue
    out.push({
      pid,
      ppid: Number(m[2]) || 0,
      user: m[3],
      stat: m[4],
      threads: Number(m[5]) || 0,
      rss: Number(m[6]) || 0,
      pcpu: Number(m[7]) || 0,
      // java 的 args 能到几 KB：整台机器几百个进程时，一趟 IPC 就是好几 MB，
      // 而界面只有一行、靠省略号截断显示。留 400 字符够认出是哪个服务，
      // 再多就是纯搬运 —— 传输、解析、DOM 文本全都白花钱。
      cmd: trimCmd((m[8] || '').trim())
    })
  }
  return out
}

function memInfo(raw: string): { total: number; avail: number; swapTotal: number; swapFree: number } {
  const val = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(raw)
    return m ? Number(m[1]) : 0
  }
  return {
    total: val('MemTotal'),
    avail: val('MemAvailable') || val('MemFree'),
    swapTotal: val('SwapTotal'),
    swapFree: val('SwapFree')
  }
}

export async function collectProcesses(
  sessionId: string,
  exec: ExecFn
): Promise<ProcSnapshot> {
  const { stdout } = await exec(SCRIPT)
  if (!stdout || !stdout.includes(`${SEP}END${SEP}`)) {
    throw new Error(`进程列表读取失败：${(stdout || '').trim().slice(0, 160) || '没有输出'}`)
  }

  // split 之后分隔符本身已经没了，要找的是裸 tag
  const parts = stdout.split(SEP)
  const seg = (tag: string): string => {
    const i = parts.indexOf(tag)
    return i >= 0 ? (parts[i + 1] ?? '').trim() : ''
  }

  const raw = parsePs(seg('PS'))
  if (!raw.length) {
    throw new Error('ps 没有返回任何进程：这台机器的 ps 可能是 BusyBox 版，装 procps 后可用')
  }

  // ---- 每进程累计 CPU ticks（utime + stime）----
  const ticks = new Map<number, number>()
  for (const line of seg('TICKS').split('\n')) {
    const m = /^(\d+)\s+(\d+)$/.exec(line.trim())
    if (m) ticks.set(Number(m[1]), Number(m[2]))
  }

  // ---- 机器整体 CPU ticks（用来求「这段时间里这个进程占了多少」）----
  const cpuCols = seg('CPU')
    .replace(/^cpu\s+/, '')
    .split(/\s+/)
    .map(Number)
    .filter((n) => !Number.isNaN(n))
  const cpuTotal = cpuCols.reduce((a, b) => a + b, 0)

  const idleTotal = (cpuCols[3] ?? 0) + (cpuCols[4] ?? 0)
  const cores = Math.max(1, Number(seg('CORES')) || 1)
  const [load1 = 0, load5 = 0, load15 = 0] = seg('LOAD')
    .split(/\s+/)
    .slice(0, 3)
    .map(Number)

  const mem = memInfo(seg('MEM'))
  const memTotal = Math.round(mem.total / 1024) // MB
  const memUsed = Math.max(0, Math.round((mem.total - mem.avail) / 1024))
  const swapTotal = Math.round(mem.swapTotal / 1024)
  const swapUsed = Math.max(0, Math.round((mem.swapTotal - mem.swapFree) / 1024))

  const prev = prevMap.get(sessionId)
  const dTotal = prev && cpuTotal > prev.cpuTotal ? cpuTotal - prev.cpuTotal : 0
  const dIdle = prev && idleTotal > prev.idleTotal ? idleTotal - prev.idleTotal : 0
  // 全机占用：和 metrics 里同一套算法，只是这里顺手就有一份，不用另开一条轮询
  const cpuAll = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0

  const rows: ProcRow[] = raw.map((p) => {
    const now = ticks.get(p.pid)
    const before = prev?.ticks.get(p.pid)
    let cpu: number
    if (dTotal > 0 && now !== undefined && before !== undefined) {
      // 进程在这段时间里烧掉的 tick / 全机烧掉的 tick × 核数 = 单核百分比
      cpu = ((now - before) / dTotal) * cores * 100
    } else if (!prev) {
      // 第一次采样没有差值可用，先用 ps 的均值顶着（下一轮就准了）
      cpu = p.pcpu
    } else {
      // 上一轮没有这个 PID：这是刚启动的进程，这一轮就是 0
      cpu = 0
    }
    cpu = Math.max(0, Math.min(cpu, cores * 100))

    const state = (p.stat || '?')[0]
    return {
      pid: p.pid,
      ppid: p.ppid,
      user: p.user,
      state,
      threads: p.threads,
      rss: p.rss,
      cpu: Number(cpu.toFixed(1)),
      mem: mem.total ? Number(((p.rss / mem.total) * 100).toFixed(1)) : 0,
      cmd: p.cmd || `[${p.user}]`
    }
  })

  prevMap.set(sessionId, { ticks, cpuTotal, idleTotal })

  const stats: ProcStats = {
    total: rows.length,
    running: rows.filter((r) => r.state === 'R').length,
    sleeping: rows.filter((r) => r.state === 'S').length,
    zombie: rows.filter((r) => r.state === 'Z').length,
    threads: rows.reduce((a, r) => a + r.threads, 0),
    cores,
    cpu: Number(cpuAll.toFixed(1)),
    load1,
    load5,
    load15,
    memTotal,
    memUsed,
    swapTotal,
    swapUsed
  }

  // 按 CPU 降序给前 MAX_ROWS 条：界面默认就按这个看，省得把 2000 个僵尸进程全传回来
  rows.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem)

  const htopPath = seg('HTOP')
  const pkg = seg('PKG') || 'unknown'
  const os = seg('OS').replace(/^"|"$/g, '').trim()

  return {
    time: Date.now(),
    rows: rows.slice(0, MAX_ROWS),
    stats,
    htop: {
      available: !!htopPath,
      path: htopPath,
      pkg,
      install: INSTALL_CMD[pkg] ?? INSTALL_CMD.unknown,
      os
    }
  }
}

/**
 * 结束进程。
 * 拒绝 PID 1 —— 那是 init/systemd，杀了整台机器就废了；
 * 也拒绝非数字，别让 PID 变成命令注入的入口。
 */
export async function killProcess(exec: ExecFn, pid: number, force: boolean): Promise<string> {
  const n = Math.trunc(Number(pid))
  if (!Number.isFinite(n)) throw new Error(`非法的 PID：${pid}`)
  if (n <= 1) throw new Error(`拒绝操作 PID ${n}：1 号是 init，杀了整台机器就废了`)
  const sig = force ? 'KILL' : 'TERM'
  const { stdout } = await exec(`kill -${sig} ${n} 2>&1; echo "rc=$?"`)
  if (!/rc=0/.test(stdout)) {
    const msg = stdout.replace(/rc=\d+/, '').trim()
    throw new Error(msg || `kill -${sig} ${n} 失败`)
  }
  return `已发送 SIG${sig} 给 PID ${n}`
}

export function clearProcState(sessionId: string): void {
  prevMap.delete(sessionId)
}
