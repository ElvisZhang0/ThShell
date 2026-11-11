import type { DiskMount, LoginSession, NetInterface, SystemInfo } from '../types'
import type { ExecFn } from './metrics'

/**
 * 服务器档案采集（系统信息页）。
 *
 * 和 metrics 的区别：那个是每 3 秒一次的"曲线"，这个是"进来看一眼"的静态档案，
 * 所以不做差分、不留状态、也不轮询，一次 exec 全拿回来。
 *
 * 命令都挑各发行版都有的实现（POSIX sh + coreutils + iproute2），
 * 老到 CentOS 6、新到 Ubuntu 24 都能跑；Windows 主机则整段失败，返回 null 由界面提示不支持。
 */
const SCRIPT = [
  'export LC_ALL=C',
  // 发行版：优先 os-release（systemd 系），退回 redhat-release / debian_version
  'echo @@OS@@; (cat /etc/os-release 2>/dev/null || cat /etc/redhat-release 2>/dev/null || cat /etc/debian_version 2>/dev/null)',
  'echo @@KERNEL@@; uname -srm 2>/dev/null',
  'echo @@HOST@@; hostname 2>/dev/null',
  'echo @@CPU@@; (grep -m1 "model name" /proc/cpuinfo 2>/dev/null; grep -m1 Hardware /proc/cpuinfo 2>/dev/null; grep -c "^processor" /proc/cpuinfo 2>/dev/null)',
  'echo @@MEM@@; head -n 3 /proc/meminfo 2>/dev/null',
  'echo @@UP@@; cat /proc/uptime 2>/dev/null',
  'echo @@LOAD@@; cat /proc/loadavg 2>/dev/null',
  'echo @@PROC@@; ps -e 2>/dev/null | tail -n +2 | wc -l',
  'echo @@DATE@@; date "+%Y-%m-%d %H:%M:%S %Z %z" 2>/dev/null',
  'echo @@VIRT@@; (command -v systemd-detect-virt >/dev/null 2>&1 && systemd-detect-virt 2>/dev/null)',
  'echo @@DISK@@; df -hPT 2>/dev/null | tail -n +2',
  'echo @@INODE@@; df -iPT 2>/dev/null | tail -n +2',
  // ip -o 每行一条，比解析 ip addr 的多行缩进稳得多；没有 iproute2 的老机器就空着
  'echo @@LINK@@; ip -o link 2>/dev/null',
  'echo @@ADDR@@; ip -o addr 2>/dev/null',
  'echo @@ROUTE@@; ip route 2>/dev/null',
  'echo @@DNS@@; grep -E "^nameserver" /etc/resolv.conf 2>/dev/null',
  'echo @@WHO@@; who 2>/dev/null'
].join('; ')

/** os-release 是 KEY="VALUE" 格式，只要 PRETTY_NAME */
function parseOs(raw: string): string {
  const pretty = /^PRETTY_NAME=(.*)$/m.exec(raw)
  if (pretty) return pretty[1].replace(/^["']|["']$/g, '').trim()
  // redhat-release / debian_version 只有一行原文
  return raw.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

function num(value: string | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * df 的一行。列：Filesystem Type Size Used Avail Use% Mounted
 * 末尾挂载点可能带空格，所以 Mounted 之后整段吃掉。
 */
function parseDf(lines: string[]): Map<string, Omit<DiskMount, 'inodePercent' | 'inodeUsed' | 'inodeTotal'>> {
  const map = new Map<string, Omit<DiskMount, 'inodePercent' | 'inodeUsed' | 'inodeTotal'>>()
  for (const line of lines) {
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)%\s+(.+)$/.exec(line)
    if (!m) continue
    map.set(m[7].trim(), {
      device: m[1],
      fstype: m[2],
      size: m[3],
      used: m[4],
      avail: m[5],
      usePercent: num(m[6]),
      mount: m[7].trim()
    })
  }
  return map
}

/** df -iPT 的列和 df -hPT 一样，只是 Size/Used 换成了 inode 个数 */
function parseInode(lines: string[]): Map<string, { percent: number; used: string; total: string }> {
  const map = new Map<string, { percent: number; used: string; total: string }>()
  for (const line of lines) {
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)%\s+(.+)$/.exec(line)
    if (!m) continue
    map.set(m[7].trim(), { percent: num(m[6]), used: m[4], total: m[3] })
  }
  return map
}

function parseNets(linkRaw: string, addrRaw: string): NetInterface[] {
  const byName = new Map<string, NetInterface>()

  // 2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ... state UP ... link/ether 00:50:56:xx:xx:xx brd ...
  for (const line of linkRaw.split('\n')) {
    const m = /^\d+:\s+([^:@\s]+)(?:@\S+)?:\s+<([^>]*)>.*?link\/ether\s+(\S+)/.exec(line)
    if (!m) continue
    /**
     * 别看 flags 里的 UP —— 它只表示"管理上启用了"，docker0 这种没插线的网桥也带 UP，
     * 但 `state` 是 DOWN。判断"这条链路是不是真的通的"要看 state。
     * 例外：不少驱动（bond、tun、部分虚拟机网卡）永远报 state UNKNOWN，那时退回看 flags。
     */
    const state = /(?:^|\s)state\s+(\S+)/.exec(line)?.[1] ?? ''
    const flagsUp = /(^|,)UP(,|$)/.test(m[2])
    byName.set(m[1], {
      name: m[1],
      up: state === 'UP' || (state === 'UNKNOWN' && flagsUp),
      mac: m[3],
      ipv4: [],
      ipv6: []
    })
  }

  // 2: eth0    inet 172.30.10.206/22 brd ... scope global eth0\       valid_lft ...
  for (const line of addrRaw.split('\n')) {
    const m = /^\d+:\s+(\S+)\s+(inet6?)\s+([0-9a-fA-F.:]+)\/(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const iface = byName.get(m[1]) ?? {
      name: m[1],
      up: false,
      mac: '',
      ipv4: [],
      ipv6: []
    }
    byName.set(m[1], iface)
    // 只收全局地址：scope host 是 127.0.0.1，scope link 是 fe80:: 这类链路本地地址，
    // 运维想看的"这台机器对外是什么 IP"不在里面
    if (!/scope\s+global/.test(m[5])) continue
    if (m[3].startsWith('127.')) continue
    const cidr = `${m[3]}/${m[4]}`
    if (m[2] === 'inet') iface.ipv4.push(cidr)
    else iface.ipv6.push(cidr)
  }

  /**
   * 过滤 + 排序。
   * docker 宿主机上会有几十张 vethXXXX：既没地址又是 DOWN，列出来纯属噪音；
   * 有地址的、或者至少 UP 着的才有信息量。排完 UP 的在前，同状态按名字。
   */
  return [...byName.values()]
    .filter((n) => n.ipv4.length || n.ipv6.length || n.up)
    .sort((a, b) => Number(b.up) - Number(a.up) || a.name.localeCompare(b.name))
}

function parseSessions(raw: string): LoginSession[] {
  const out: LoginSession[] = []
  for (const line of raw.split('\n')) {
    // root     pts/0        2026-11-09 16:45 (10.200.58.237)
    const m = /^(\S+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*(?:\((.*)\))?/.exec(line.trim())
    if (!m) continue
    out.push({ user: m[1], tty: m[2], since: m[3], from: m[4] ?? '' })
  }
  return out
}

export async function collectSystemInfo(exec: ExecFn): Promise<SystemInfo | null> {
  let stdout: string
  try {
    const result = await exec(SCRIPT)
    stdout = result.stdout
  } catch {
    return null
  }
  if (!stdout || !stdout.includes('@@KERNEL@@')) return null

  // 分隔符已被 split 吃掉，这里找的是裸 tag（metrics 里踩过 `tag + '@@'` 永远匹配不上的坑）
  const segments = stdout.split('@@')
  const pick = (tag: string): string => {
    const idx = segments.indexOf(tag)
    return idx >= 0 ? (segments[idx + 1] ?? '').trim() : ''
  }

  const os = parseOs(pick('OS'))
  const kernelRaw = pick('KERNEL')
  // 整段脚本在 Windows 的 cmd 下只会把 `echo @@OS@@; ...` 当一行回显，等于什么都没采到
  if (!os && !kernelRaw) return null

  const kernelParts = kernelRaw.split(/\s+/)
  const arch = kernelParts.length >= 3 ? kernelParts[kernelParts.length - 1] : ''
  const kernel = kernelParts.slice(0, 2).join(' ')

  const cpuLines = pick('CPU').split('\n').map((l) => l.trim()).filter(Boolean)
  const cores = num(cpuLines.find((l) => /^\d+$/.test(l)))
  const modelLine = cpuLines.find((l) => /:/.test(l)) ?? ''
  const cpuModel = modelLine.split(':').slice(1).join(':').trim() || modelLine

  const memRaw = pick('MEM')
  const memKb = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(memRaw)
    return m ? Number(m[1]) : 0
  }

  const diskMap = parseDf(pick('DISK').split('\n').filter(Boolean))
  const inodeMap = parseInode(pick('INODE').split('\n').filter(Boolean))
  const disks: DiskMount[] = [...diskMap.values()]
    .map((d) => {
      const inode = inodeMap.get(d.mount)
      return {
        ...d,
        inodePercent: inode ? inode.percent : -1,
        inodeUsed: inode ? inode.used : '',
        inodeTotal: inode ? inode.total : ''
      }
    })
    /**
     * 两件事：
     * 1. docker 宿主机上每跑一个容器就多一条 `.../overlay2/<hash>/merged` 挂载，
     *    十几个容器能刷满整张表 —— 那是实现细节，不是"这台机器的磁盘挂载情况"。
     * 2. 真盘（设备在 /dev/ 下）排前面，tmpfs/devtmpfs/cgroup 这些往后放，
     *    运维第一眼要看的是 / 和 /data 用了多少。
     */
    .filter((d) => !d.mount.includes('/overlay2/'))
    .sort((a, b) => {
      const real = Number(b.device.startsWith('/dev/')) - Number(a.device.startsWith('/dev/'))
      return real
    })

  const load = pick('LOAD').split(/\s+/).map(Number)

  const gateways = [
    ...new Set(
      pick('ROUTE')
        .split('\n')
        .filter((l) => /^default\s/.test(l))
        .map((l) => /via\s+(\S+)/.exec(l)?.[1] ?? '')
        .filter(Boolean)
    )
  ]

  const dns = [
    ...new Set(
      pick('DNS')
        .split('\n')
        .map((l) => l.replace(/^\s*nameserver\s+/, '').trim())
        .filter(Boolean)
    )
  ]

  return {
    time: Date.now(),
    hostname: pick('HOST').split('\n')[0] ?? '',
    os,
    kernel,
    arch,
    cpuModel,
    cpuCores: cores,
    memTotal: Math.round(memKb('MemTotal') / 1024),
    swapTotal: Math.round(memKb('SwapTotal') / 1024),
    uptime: Math.round(num(pick('UP').split(/\s+/)[0])),
    load1: load[0] || 0,
    load5: load[1] || 0,
    load15: load[2] || 0,
    processes: num(pick('PROC').trim()),
    date: pick('DATE').split('\n')[0] ?? '',
    virt: pick('VIRT').split('\n')[0] ?? '',
    disks,
    nets: parseNets(pick('LINK'), pick('ADDR')),
    gateways,
    dns,
    sessions: parseSessions(pick('WHO'))
  }
}
