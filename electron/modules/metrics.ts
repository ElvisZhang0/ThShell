import type { MetricSnapshot } from '../types'

/**
 * Linux 服务器资源采集。
 *
 * 设计取舍：
 * - 一次 exec 把 CPU / 内存 / 网络 / 负载 / 磁盘 / 进程数全部取回来，
 *   而不是每条指标开一个 channel —— 网络差的时候能少一半往返。
 * - CPU 与网卡速率需要两次采样相减，所以按 sessionId 保存上一次的累计值。
 * - 采集失败（Windows 主机、极简容器没有 /proc）返回 null，前端自动隐藏监控面板，
 *   不弹错误打扰用户。
 */

interface MetricsState {
  lastCpuTotal?: number
  lastCpuIdle?: number
  lastRx?: number
  lastTx?: number
  lastTime?: number
}

const stateMap = new Map<string, MetricsState>()

const SCRIPT = [
  'export LC_ALL=C',
  'head -n1 /proc/stat',
  'echo "@@MEM@@"',
  'cat /proc/meminfo',
  'echo "@@NET@@"',
  'cat /proc/net/dev',
  'echo "@@LOAD@@"',
  'cat /proc/loadavg',
  'echo "@@UP@@"',
  'cat /proc/uptime',
  'echo "@@DISK@@"',
  'df -kP / 2>/dev/null | tail -n1',
  'echo "@@PS@@"',
  `ps -e 2>/dev/null | tail -n +2 | wc -l`
].join('; ')

export type ExecFn = (command: string) => Promise<{ code: number; stdout: string; stderr: string }>

export async function collectMetrics(
  sessionId: string,
  exec: ExecFn
): Promise<MetricSnapshot | null> {
  let stdout: string
  try {
    const result = await exec(SCRIPT)
    stdout = result.stdout
  } catch {
    return null
  }
  if (!stdout || !stdout.includes('@@MEM@@')) return null

  const segments = stdout.split('@@')
  /**
   * split('@@') 之后分隔符已经没了：`A@@MEM@@B` → ['A', 'MEM', 'B']。
   * 所以这里要找的是裸 tag，而不是 `tag + '@@'` —— 之前多拼了两个 @，
   * 永远匹配不上，导致内存/磁盘/运行时长/进程数全被解析成 0。
   */
  const pick = (tag: string): string => {
    const idx = segments.indexOf(tag)
    return idx >= 0 ? (segments[idx + 1] ?? '').trim() : ''
  }

  const now = Date.now()
  const prev = stateMap.get(sessionId) ?? {}
  const nextState: MetricsState = { ...prev, lastTime: now }

  // ---- CPU ----
  const statLine = stdout.split('\n')[0] ?? ''
  const cpuParts = statLine.replace(/^cpu\s+/, '').trim().split(/\s+/).map(Number)
  let cpu = 0
  if (cpuParts.length >= 4 && cpuParts.every((n) => !Number.isNaN(n))) {
    const idle = (cpuParts[3] ?? 0) + (cpuParts[4] ?? 0)
    const total = cpuParts.reduce((a, b) => a + b, 0)
    if (prev.lastCpuTotal !== undefined && prev.lastCpuIdle !== undefined) {
      const dTotal = total - prev.lastCpuTotal
      const dIdle = idle - prev.lastCpuIdle
      cpu = dTotal > 0 ? Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)) : 0
    }
    nextState.lastCpuTotal = total
    nextState.lastCpuIdle = idle
  }

  // ---- 内存 ----
  const memRaw = pick('MEM')
  const memVal = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(memRaw)
    return m ? Number(m[1]) : 0
  }
  const memTotal = Math.round(memVal('MemTotal') / 1024)
  const memAvailable = memVal('MemAvailable') || memVal('MemFree')
  const memUsed = Math.max(0, Math.round((memVal('MemTotal') - memAvailable) / 1024))
  const swapTotal = Math.round(memVal('SwapTotal') / 1024)
  const swapFree = memVal('SwapFree')
  const swapUsed = Math.max(0, Math.round((memVal('SwapTotal') - swapFree) / 1024))

  // ---- 网络（排除 lo） ----
  const netRaw = pick('NET')
  let rx = 0
  let tx = 0
  for (const line of netRaw.split('\n')) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const iface = m[1].trim()
    if (iface === 'lo' || iface.startsWith('lo:')) continue
    const cols = m[2].trim().split(/\s+/).map(Number)
    if (cols.length >= 9) {
      rx += cols[0] || 0
      tx += cols[8] || 0
    }
  }
  let netRx = 0
  let netTx = 0
  if (prev.lastRx !== undefined && prev.lastTx !== undefined && prev.lastTime) {
    const dt = Math.max(0.2, (now - prev.lastTime) / 1000)
    netRx = Math.max(0, (rx - prev.lastRx) / 1024 / dt)
    netTx = Math.max(0, (tx - prev.lastTx) / 1024 / dt)
  }
  nextState.lastRx = rx
  nextState.lastTx = tx

  // ---- 负载 / 运行时长 ----
  const loadParts = pick('LOAD').split(/\s+/).map(Number)
  const uptime = Math.round(Number(pick('UP').split(/\s+/)[0] || 0))

  // ---- 磁盘 ----
  const diskCols = pick('DISK').trim().split(/\s+/)
  const diskTotal = diskCols.length >= 3 ? Math.round(Number(diskCols[1]) / 1024) : 0
  const diskUsed = diskCols.length >= 3 ? Math.round(Number(diskCols[2]) / 1024) : 0

  const processes = Number(pick('PS').trim()) || 0

  stateMap.set(sessionId, nextState)

  return {
    time: now,
    cpu: Number(cpu.toFixed(1)),
    memUsed,
    memTotal,
    swapUsed,
    swapTotal,
    load1: loadParts[0] || 0,
    load5: loadParts[1] || 0,
    load15: loadParts[2] || 0,
    netRx,
    netTx,
    diskUsed,
    diskTotal,
    uptime,
    processes
  }
}

export function clearMetricsState(sessionId: string): void {
  stateMap.delete(sessionId)
}
