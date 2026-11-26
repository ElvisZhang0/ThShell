import type {
  ConfigResult,
  MountRequest,
  NetConfigApply,
  NetConfigInfo,
  UnmountedDisk
} from '../types'
import type { ExecFn } from './metrics'

/**
 * 系统页上那两块「能动手」的地方：挂载磁盘、配置网络。
 *
 * 和 sysinfo 分开的原因：sysinfo 是只读快照，随便重试；这里每一步都在改远端机器，
 * 要备份、要判断权限、要考虑「命令还没回话连接就断了」。混在一起迟早出事。
 *
 * 三条铁律：
 * 1. 所有写入前先留 .bak —— 改 fstab / ifcfg 改错，机器可能起不来。
 * 2. 改网络的动作一律延时到后台执行。改了 IP 的瞬间当前 SSH 就废了，
 *    前台等结果只会等到超时，用户还以为失败。
 * 3. 用户输入一律走 sq() 转义，别拼进双引号里。
 */

/** 单引号包裹，内部单引号按 POSIX 规则断开转义 */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 回执日志最多留这么多行，界面里是个可滚动的框，塞太多没人看 */
function clip(text: string, lines = 40): string {
  const all = text.trim().split(/\r?\n/).filter(Boolean)
  return all.slice(-lines).join('\n')
}

/**
 * 能不能写系统文件：root 直接来；否则要求免密 sudo（-n）。
 * 不要在远端弹密码提示 —— ssh exec 没有 tty，sudo 会一直挂着直到超时。
 */
async function privileged(exec: ExecFn): Promise<{ ok: boolean; prefix: string; why: string }> {
  const who = await exec('id -u 2>/dev/null')
  if (who.stdout.trim() === '0') return { ok: true, prefix: '', why: '' }

  const test = await exec('sudo -n true 2>&1')
  if (test.code === 0) return { ok: true, prefix: 'sudo -n ', why: '' }

  return {
    ok: false,
    prefix: '',
    why: '当前账号不是 root，且没有免密 sudo（远端会等密码，这里等不到）。请用 root 登录，或先给该账号配 NOPASSWD。'
  }
}

/* ============================ 挂载磁盘 ============================ */

const DISK_PROBE = [
  'export LC_ALL=C',
  // -P 输出 KEY="VALUE"，比默认的树形/JSON 都好解析，util-linux 2.22+ 都有
  'echo @@LSBLK@@; lsblk -P -o NAME,PATH,SIZE,TYPE,FSTYPE,MOUNTPOINT,LABEL,MODEL 2>/dev/null',
  'echo @@FSTAB@@; cat /etc/fstab 2>/dev/null'
].join('\n')

function parseLsblk(raw: string): UnmountedDisk[] {
  const out: UnmountedDisk[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const field: Record<string, string> = {}
    const re = /([A-Z]+)="([^"]*)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line))) field[m[1]] = m[2]

    const path = field.PATH ?? ''
    const type = field.TYPE ?? ''
    const fstype = field.FSTYPE ?? ''
    const mount = field.MOUNTPOINT ?? ''
    // swap 分区的 MOUNTPOINT 是字面量 [SWAP]，不是真挂载点：要列出来，但标成不可挂
    const isSwap = fstype === 'swap' || mount === '[SWAP]'
    // loop 设备（snap / 挂载的 ISO）和 sr0 光驱不是"没挂上的盘"，列出来只会干扰
    if (!path || !/^(part|disk|lvm|crypt)$/.test(type)) continue
    if (mount && !isSwap) continue
    /**
     * 整盘只有"自己就是一个文件系统"的情况才值得挂（/dev/sdb 直接 mkfs 再用）。
     * 上面已经有分区的整盘（/dev/sdb 带 sdb1/sdb2）没有文件系统，
     * 它自己不能挂，列出来只会让人误操作。
     */
    if (type === 'disk' && !fstype) continue

    out.push({
      path,
      size: field.SIZE ?? '',
      fstype,
      label: field.LABEL ?? '',
      model: (field.MODEL ?? '').trim(),
      type,
      isSwap
    })
  }
  // 盘符多的机器（sda sdb sdc）按名字排，别一会儿 sdb 一会儿 sda1
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export async function listUnmountedDisks(exec: ExecFn): Promise<UnmountedDisk[]> {
  const res = await exec(DISK_PROBE)
  if (res.code !== 0 && !res.stdout.includes('@@LSBLK@@')) return []
  const segment = (tag: string): string => {
    const parts = res.stdout.split('@@')
    const idx = parts.indexOf(tag)
    return idx >= 0 ? (parts[idx + 1] ?? '') : ''
  }
  return parseLsblk(segment('LSBLK'))
}

/** 挂载点的基本合法性：必须是绝对路径，且不能是根 */
function badMountPoint(p: string): string {
  if (!p.startsWith('/')) return '挂载点必须是绝对路径'
  if (p === '/' || /^\/+$/.test(p)) return '不能挂到 /'
  if (p.split('/').includes('..')) return '挂载点里不能出现 ..'
  if (/[\s'"]/.test(p)) return '挂载点里不要带空格和引号'
  return ''
}

export async function mountDisk(exec: ExecFn, req: MountRequest): Promise<ConfigResult> {
  if (!req.device.startsWith('/dev/')) return { ok: false, log: '设备路径不对：必须以 /dev/ 开头' }
  const bad = badMountPoint(req.mountPoint)
  if (bad) return { ok: false, log: bad }
  if (!req.fstype) return { ok: false, log: '这块分区还没有文件系统，先格式化再挂' }

  const perm = await privileged(exec)
  if (!perm.ok) return { ok: false, log: perm.why }

  /**
   * fstab 里用 UUID 而不是 /dev/sdb1：盘序一变（插了新盘、换了接口）设备名就会漂，
   * 用设备名写 fstab 是"重启后挂错盘"的经典来源。nofail 保证盘不在也能开机。
   */
  const script = [
    'set -e',
    'export LC_ALL=C',
    `DEV=${sq(req.device)}`,
    `MNT=${sq(req.mountPoint)}`,
    `FS=${sq(req.fstype)}`,
    'mkdir -p "$MNT"',
    'mount "$DEV" "$MNT"',
    'echo "[mount] OK"',
    'findmnt -n -o SOURCE,TARGET,FSTYPE "$MNT" 2>/dev/null | head -1',
    ...(req.persist
      ? [
          'BAK="/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"',
          'cp -a /etc/fstab "$BAK" && echo "[fstab] 已备份到 $BAK"',
          'SRC="$DEV"',
          'UUID=$(blkid -s UUID -o value "$DEV" 2>/dev/null || true)',
          '[ -n "$UUID" ] && SRC="UUID=$UUID"',
          // 同一个挂载点只留一行：重复写 fstab 会让 mount -a 报 "already mounted"
          `if awk -v m="$MNT" '$1 !~ /^#/ && $2 == m { f = 1 } END { exit f ? 0 : 1 }' /etc/fstab; then
  echo "[fstab] 已有该挂载点，跳过追加"
else
  printf '%s %s %s defaults,nofail 0 0\\n' "$SRC" "$MNT" "$FS" >> /etc/fstab
  echo "[fstab] 已追加 $(tail -1 /etc/fstab)"
fi`
        ]
      : []),
    'echo "[done] 挂载完成"'
  ].join('\n')

  const res = await exec(`${perm.prefix}sh -c ${sq(script)}`)
  const log = clip([res.stdout, res.stderr].filter(Boolean).join('\n'))
  return { ok: res.code === 0, log: log || (res.code === 0 ? '完成' : '没有输出，退出码非 0') }
}

/* ============================ 网络配置 ============================ */

function parseIfcfg(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) continue
    out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

/** NETMASK(255.255.252.0) → 22；已经是前缀长度就直接用 */
function maskToPrefix(mask: string): number {
  if (!mask) return 0
  if (/^\d+$/.test(mask)) return Number(mask)
  const bits = mask.split('.').map((n) => Number(n) || 0)
  return bits.reduce((acc, n) => acc + (n.toString(2).match(/1/g)?.length ?? 0), 0)
}

function prefixToMask(prefix: number): string {
  const full = prefix >= 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0
  return [24, 16, 8, 0].map((s) => (full >>> s) & 255).join('.')
}

/** 把地址规整成 CIDR：用户可能只填 IP，掩码由表单另一栏给 */

export async function readNetConfig(exec: ExecFn, device: string): Promise<NetConfigInfo> {
  const empty: NetConfigInfo = {
    backend: 'none',
    device,
    connName: '',
    method: 'manual',
    addresses: [],
    gateway: '',
    dns: [],
    hint: '没识别出这台机器用哪种方式管理网络'
  }

  const ifcfgPath = `/etc/sysconfig/network-scripts/ifcfg-${device}`
  const probe = [
    'export LC_ALL=C',
    'echo @@NM@@; command -v nmcli >/dev/null 2>&1 && echo yes || echo no',
    'echo @@CON@@; nmcli -t -f NAME,DEVICE,TYPE,ACTIVE con show 2>/dev/null',
    `echo @@IFCFG@@; cat ${sq(ifcfgPath)} 2>/dev/null`,
    'echo @@NETPLAN@@; ls /etc/netplan/*.yaml 2>/dev/null'
  ].join('\n')

  const res = await exec(probe)
  if (res.code !== 0 && !res.stdout.includes('@@NM@@')) return empty
  const segment = (tag: string): string => {
    const parts = res.stdout.split('@@')
    const idx = parts.indexOf(tag)
    return idx >= 0 ? (parts[idx + 1] ?? '') : ''
  }

  const hasNm = segment('NM').trim() === 'yes'
  const ifcfgRaw = segment('IFCFG')
  const netplanFiles = segment('NETPLAN').split('\n').filter(Boolean)

  // ---------- 1. NetworkManager ----------
  if (hasNm) {
    // NAME:DEVICE:TYPE:ACTIVE，连接名里可能有空格甚至冒号，所以从右侧切
    let conn = ''
    for (const line of segment('CON').split('\n')) {
      const m = /^(.*):([^:]*):([^:]+):(yes|no)$/.exec(line.trim())
      if (!m) continue
      if (m[2] !== device) continue
      // 同一设备可能有多个连接（旧的、未激活的），优先取 active 的那个
      if (!conn || m[4] === 'yes') conn = m[1]
    }
    if (conn) {
      const detail = await exec(
        `nmcli -t -f ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns con show ${sq(conn)} 2>/dev/null`
      )
      const kv: Record<string, string> = {}
      for (const line of detail.stdout.split('\n')) {
        const idx = line.indexOf(':')
        if (idx > 0) kv[line.slice(0, idx)] = line.slice(idx + 1)
      }
      return {
        backend: 'nmcli',
        device,
        connName: conn,
        method: kv['ipv4.method'] === 'auto' ? 'dhcp' : 'manual',
        addresses: (kv['ipv4.addresses'] ?? '')
          .split(/[|,]/)
          .map((s) => s.trim())
          .filter(Boolean),
        gateway: (kv['ipv4.gateway'] ?? '').trim(),
        dns: (kv['ipv4.dns'] ?? '')
          .split(/[|,\s]/)
          .map((s) => s.trim())
          .filter(Boolean),
        hint: `NetworkManager 连接「${conn}」`
      }
    }
  }

  // ---------- 2. ifcfg 文件（CentOS 6/7 老写法） ----------
  if (ifcfgRaw.trim()) {
    const kv = parseIfcfg(ifcfgRaw)
    const prefix = kv.PREFIX ? Number(kv.PREFIX) : maskToPrefix(kv.NETMASK ?? '')
    const addrs: string[] = []
    for (const key of ['IPADDR', 'IPADDR0', 'IPADDR1', 'IPADDR2', 'IPADDR3']) {
      const v = kv[key]
      if (v) addrs.push(v.includes('/') ? v : `${v}/${prefix || 24}`)
    }
    const boot = (kv.BOOTPROTO ?? '').toLowerCase()
    return {
      backend: 'ifcfg',
      device,
      connName: ifcfgPath,
      method: boot === 'dhcp' || boot === 'bootp' ? 'dhcp' : 'manual',
      addresses: addrs,
      gateway: kv.GATEWAY ?? '',
      dns: [kv.DNS1, kv.DNS2, kv.DNS3].filter((v): v is string => !!v),
      hint: `配置文件 ${ifcfgPath}`
    }
  }

  // ---------- 3. netplan（Ubuntu 17.10+） ----------
  if (netplanFiles.length) {
    return {
      ...empty,
      backend: 'netplan',
      hint: `netplan 管理（${netplanFiles.map((f) => f.split('/').pop()).join(', ')}）。保存时写 90-thshell-${device}.yaml 覆盖，地址以表单为准`
    }
  }

  // nmcli 装了但这张网卡没有连接（比如 lo 或刚插上的网卡）也走 nmcli 新建
  if (hasNm) {
    return { ...empty, backend: 'nmcli', connName: device, hint: 'NetworkManager 里还没有这张网卡的连接，保存时按设备名新建' }
  }

  return empty
}

function buildIfcfg(origin: string, req: NetConfigApply): string {
  const kv = parseIfcfg(origin)
  // 保留原来那些我们不懂的键（UUID、HWADDR、TYPE、NAME…），只覆盖地址相关的
  const keep = { ...kv }
  for (const key of [
    'BOOTPROTO',
    'IPADDR',
    'IPADDR0',
    'IPADDR1',
    'IPADDR2',
    'IPADDR3',
    'PREFIX',
    'NETMASK',
    'GATEWAY',
    'DNS1',
    'DNS2',
    'DNS3',
    'DEFROUTE'
  ]) {
    delete keep[key]
  }
  keep['DEVICE'] = keep['DEVICE'] || req.device
  keep['ONBOOT'] = 'yes'

  if (req.method === 'dhcp') {
    keep['BOOTPROTO'] = 'dhcp'
  } else {
    const first = req.addresses[0] ?? ''
    const [ip, prefixRaw] = first.split('/')
    const prefix = Number(prefixRaw) || 24
    keep['BOOTPROTO'] = 'none'
    keep['IPADDR'] = ip ?? ''
    keep['PREFIX'] = String(prefix)
    // 老版本 network 脚本还认 NETMASK，两个都写最稳
    keep['NETMASK'] = prefixToMask(prefix)
    if (req.gateway) keep['GATEWAY'] = req.gateway
    req.dns.forEach((d, i) => {
      if (i < 3) keep[`DNS${i + 1}`] = d
    })
    if (req.addresses.length > 1) {
      req.addresses.slice(1, 4).forEach((a, i) => {
        keep[`IPADDR${i}`] = a.split('/')[0]
      })
    }
  }

  const lines = Object.entries(keep).map(([k, v]) => `${k}="${v}"`)
  return lines.join('\n') + '\n'
}

function buildNetplan(req: NetConfigApply): string {
  const pad = '      '
  const body: string[] = [`network:`, `  version: 2`, `  ethernets:`, `    ${req.device}:`]
  if (req.method === 'dhcp') {
    body.push(`${pad}dhcp4: true`)
    if (req.dns.length) {
      body.push(`${pad}nameservers:`, `${pad}  addresses:`)
      req.dns.filter(Boolean).forEach((d) => body.push(`${pad}    - ${d}`))
    }
  } else {
    body.push(`${pad}dhcp4: false`, `${pad}dhcp6: false`)
    body.push(`${pad}addresses:`)
    req.addresses.filter(Boolean).forEach((a) => body.push(`${pad}  - ${a}`))
    if (req.gateway) {
      body.push(`${pad}routes:`, `${pad}  - to: default`, `${pad}    via: ${req.gateway}`)
    }
    if (req.dns.length) {
      body.push(`${pad}nameservers:`, `${pad}  addresses:`)
      req.dns.forEach((d) => body.push(`${pad}    - ${d}`))
    }
  }
  return body.join('\n') + '\n'
}

/** base64 只是为了让远端不用处理引号/换行：内容里全是 YAML 的冒号和缩进 */
function writeRemoteFile(target: string, content: string, perm = '0644'): string {
  const b64 = Buffer.from(content, 'utf8').toString('base64')
  return [
    `TMP=$(mktemp)`,
    `printf '%s' ${sq(b64)} | base64 -d > "$TMP"`,
    `chmod ${perm} "$TMP"`,
    `mv -f "$TMP" ${sq(target)}`
  ].join('\n')
}

export async function applyNetConfig(exec: ExecFn, req: NetConfigApply): Promise<ConfigResult> {
  if (!/^[A-Za-z0-9_.:@-]+$/.test(req.device)) return { ok: false, log: '网卡名不合法' }
  if (req.method === 'manual') {
    if (!req.addresses.filter(Boolean).length) return { ok: false, log: '静态地址至少填一个' }
    for (const a of req.addresses.filter(Boolean)) {
      const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(a)
      if (!m) return { ok: false, log: `地址格式应为 IP/前缀长度，如 172.30.10.206/22：${a}` }
      if (Number(m[2]) < 1 || Number(m[2]) > 32) return { ok: false, log: `前缀长度应在 1-32：${a}` }
    }
    if (req.gateway && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(req.gateway)) {
      return { ok: false, log: `网关格式不对：${req.gateway}` }
    }
  }

  const perm = await privileged(exec)
  if (!perm.ok) return { ok: false, log: perm.why }

  /**
   * 应用动作全部丢到后台延时 1 秒执行。
   * 改 IP 的那一瞬间 SSH 就不通了，前台等 `nmcli con up` 只会等到通道报错，
   * 用户看到的是"保存失败"，实际上改成功了 —— 这种假失败最容易引出第二次误操作。
   */
  const background = (cmd: string): string =>
    `( sleep 1; ${cmd} >/tmp/thshell-net.log 2>&1 ) & echo '[net] 已提交，1 秒后应用'`

  let script = ''
  if (req.backend === 'nmcli') {
    const conn = req.connName || req.device
    const dns = req.dns.filter(Boolean).join(' ')
    if (req.method === 'dhcp') {
      script = [
        'set -e',
        `nmcli con mod ${sq(conn)} ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ${sq(dns)}`,
        background(`nmcli con up ${sq(conn)}`)
      ].join('\n')
    } else {
      script = [
        'set -e',
        `nmcli con mod ${sq(conn)} ipv4.method manual ipv4.addresses ${sq(req.addresses.filter(Boolean).join(','))} ipv4.gateway ${sq(req.gateway)} ipv4.dns ${sq(dns)}`,
        background(`nmcli con up ${sq(conn)}`)
      ].join('\n')
    }
  } else if (req.backend === 'ifcfg') {
    const target = `/etc/sysconfig/network-scripts/ifcfg-${req.device}`
    const origin = (await exec(`cat ${sq(target)} 2>/dev/null`)).stdout
    const content = buildIfcfg(origin, req)
    script = [
      'set -e',
      `cp -a ${sq(target)} ${sq(target)}.bak.$(date +%Y%m%d%H%M%S) && echo '[ifcfg] 已备份'`,
      writeRemoteFile(target, content),
      'echo "[ifcfg] 已写入"',
      background(
        'systemctl restart network 2>/dev/null || /etc/init.d/network restart 2>/dev/null || true'
      )
    ].join('\n')
  } else if (req.backend === 'netplan') {
    const target = `/etc/netplan/90-thshell-${req.device}.yaml`
    script = [
      'set -e',
      `[ -f ${sq(target)} ] && cp -a ${sq(target)} ${sq(target)}.bak.$(date +%Y%m%d%H%M%S) || true`,
      writeRemoteFile(target, buildNetplan(req), '0600'),
      'echo "[netplan] 已写入 90-thshell 覆盖文件"',
      background('netplan apply')
    ].join('\n')
  } else {
    return { ok: false, log: '这台机器没有可用的网络管理方式（nmcli / ifcfg / netplan 都没识别到）' }
  }

  const res = await exec(`${perm.prefix}sh -c ${sq(script)}`)
  const log = clip([res.stdout, res.stderr].filter(Boolean).join('\n'))
  return { ok: res.code === 0, log: log || (res.code === 0 ? '已提交' : '没有输出，退出码非 0') }
}
