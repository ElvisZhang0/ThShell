import type {
  ServiceAction,
  ServiceLogQuery,
  ServiceLogResult,
  ServiceRow,
  ServiceSnapshot
} from '../types'
import type { ExecFn } from './metrics'

/**
 * 「系统服务」页：列出 systemd 里所有 .service 的运行状态，并支持启动 / 停止 / 重启。
 *
 * 两件事必须一次 SSH 往返拿全：
 * - `list-units --all`：只包含**已加载进内存**的单元，能看到 active/failed 这些真实状态；
 * - `list-unit-files`：包含机器上**装了的全部** unit 文件，但只有 enabled/disabled 这种开机自启态。
 * 只查前者会漏掉一堆没被加载的服务（用户会觉得"我的 xxx 怎么没列出来"），
 * 只查后者又拿不到运行状态。两边按名字合并才对得上。
 *
 * 分隔符照抄 procs.ts 的做法用 0x1F：description 里出现任何可打印字符都不奇怪，
 * 用 `@@` 之类的拼音分隔符迟早会被真实输出切错段。
 */
const SEP = '\x1f'
const mark = (tag: string): string => `printf '\\037${tag}\\037\\n'`

const SCRIPT = `export LC_ALL=C
${mark('UNITS')}
systemctl list-units --type=service --all --no-pager --no-legend 2>&1
${mark('FILES')}
systemctl list-unit-files --type=service --no-pager --no-legend 2>&1
${mark('VER')}
systemctl --version 2>&1 | head -1
${mark('INIT')}
ps -p 1 -o comm= 2>/dev/null | head -1
${mark('END')}`

/** 老版本 systemd 会给 failed 单元加个 `●` 前缀，`--plain` 又不一定支持，统一剥掉 */
const BULLET = /^[\s\u25CF\u2731*]+/

/**
 * `  cron.service  loaded  active  running  Regular background program...`
 * 前四列都不含空格，剩下的整段都是描述。
 */
const UNIT_LINE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/

function parseUnits(raw: string): ServiceRow[] {
  const out: ServiceRow[] = []
  for (const line of raw.split('\n')) {
    const text = line.replace(BULLET, '')
    if (!text.trim()) continue
    const m = UNIT_LINE.exec(text)
    // 列数不够的是 systemctl 的告警/提示（比如 "Warning: ..."），跳过而不是硬解析
    if (!m || !m[1].endsWith('.service')) continue
    out.push({
      name: m[1],
      load: m[2],
      active: m[3],
      sub: m[4],
      description: (m[5] || '').trim(),
      // 自启态先留空，等 FILES 段回来补
      enabled: '',
      loaded: true
    })
  }
  return out
}

/** `cron.service  enabled  enabled`（新版多一列 PRESET，只取前两列） */
function parseFiles(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const parts = line.replace(BULLET, '').trim().split(/\s+/)
    if (parts.length < 2 || !parts[0].endsWith('.service')) continue
    map.set(parts[0], parts[1])
  }
  return map
}

export async function collectServices(exec: ExecFn): Promise<ServiceSnapshot> {
  const { stdout } = await exec(SCRIPT)
  const time = Date.now()

  if (!stdout || !stdout.includes(`${SEP}END${SEP}`)) {
    throw new Error(`服务列表读取失败：${(stdout || '').trim().slice(0, 160) || '没有输出'}`)
  }

  const parts = stdout.split(SEP)
  const seg = (tag: string): string => {
    const i = parts.indexOf(tag)
    return i >= 0 ? (parts[i + 1] ?? '').trim() : ''
  }

  const unitsRaw = seg('UNITS')
  const files = parseFiles(seg('FILES'))
  const init = seg('INIT')

  /**
   * 容器 / WSL / 非 systemd 的机器：systemctl 会回一句
   * "System has not been booted with systemd as init system"。
   * 这不是故障，是个真实结论 —— 界面该说清楚，而不是摆一张空表。
   */
  const noSystemd =
    /not been booted with systemd|Failed to connect to bus|System has not been booted/i.test(unitsRaw) ||
    (!!init && init !== 'systemd')

  if (noSystemd) {
    return {
      time,
      rows: [],
      stats: { total: 0, running: 0, failed: 0, inactive: 0 },
      systemd: {
        available: false,
        init: init || 'unknown',
        version: '',
        hint:
          unitsRaw.trim().slice(0, 300) ||
          `1 号进程是 ${init || '未知'}，不是 systemd，这台机器没有 systemctl 服务可管。`
      }
    }
  }

  const rows = parseUnits(unitsRaw)
  const seen = new Set(rows.map((r) => r.name))

  /**
   * 没被加载的 unit（disabled 且从没启动过）只存在于 list-unit-files 里，
   * 状态全是未知 —— 标成 loaded:false，界面显示「未加载」而不是假装它「已停止」。
   */
  for (const [name, enabled] of files) {
    if (seen.has(name)) continue
    rows.push({
      name,
      load: '',
      active: '',
      sub: '',
      description: '',
      enabled,
      loaded: false
    })
  }

  // 已加载的回填自启态；unit file 里没有的（临时 unit）留空
  for (const r of rows) {
    if (!r.enabled) r.enabled = files.get(r.name) ?? ''
  }

  const stat = (pred: (r: ServiceRow) => boolean) => rows.filter(pred).length
  const running = stat((r) => r.active === 'active')
  const failed = stat((r) => r.active === 'failed')

  return {
    time,
    rows,
    stats: {
      total: rows.length,
      running,
      failed,
      inactive: stat((r) => r.loaded && r.active !== 'active' && r.active !== 'failed')
    },
    systemd: {
      available: true,
      init: init || 'systemd',
      version: seg('VER'),
      hint: ''
    }
  }
}

/* ============================ 启动 / 停止 / 重启 ============================ */

/**
 * 服务名白名单。
 * 这个名字最终会拼进 shell 命令，不加约束就等于开了个命令注入口子。
 * 允许 `getty@tty1.service` 这种模板实例（@ 和 : 都是合法字符），
 * 也允许 `\`：systemd 会把设备路径转义成 `dev-disk-by\x2duuid-...` 这种单元名。
 */
const NAME_OK = /^[A-Za-z0-9._@:\\-]+\.service$/

/** 单引号包裹（白名单已排除了单引号，这里只是让反斜杠原样传给 systemctl） */
function sq(value: string): string {
  return `'${value}'`
}

/** 单次会话的权限判断结果缓存：点五次重启不该跑五次 `id -u` + `sudo -n true` */
const privCache = new Map<string, { prefix: string; why: string }>()

async function privilege(exec: ExecFn, sessionId: string): Promise<{ prefix: string; why: string }> {
  const hit = privCache.get(sessionId)
  if (hit) return hit

  const who = await exec('id -u 2>/dev/null')
  if (who.stdout.trim() === '0') {
    const ok = { prefix: '', why: '' }
    privCache.set(sessionId, ok)
    return ok
  }

  // 非 root 时**只能**用免密 sudo：ssh exec 没有 tty，sudo 会一直等密码直到超时
  const test = await exec('sudo -n true 2>&1')
  if (test.code === 0) {
    const ok = { prefix: 'sudo -n ', why: '' }
    privCache.set(sessionId, ok)
    return ok
  }

  const bad = {
    prefix: '',
    why: '当前账号不是 root，且没有免密 sudo（远端会等密码，这里等不到）。请用 root 登录，或给该账号配 NOPASSWD。'
  }
  privCache.set(sessionId, bad)
  return bad
}

export function clearServiceState(sessionId: string): void {
  privCache.delete(sessionId)
}

const VERB: Record<ServiceAction, string> = {
  start: '启动',
  stop: '停止',
  restart: '重启'
}

/**
 * 执行一次服务操作。
 *
 * 为什么要 `; echo rc=$?`：systemctl 失败时退出码不一定是 1，而且 stderr 才是真正的原因
 * （Unit xxx.service not found / Access denied / Job for xxx failed）。
 * 把 2>&1 和退出码一起带回来，界面才能给出"到底为什么没起来"。
 */
export async function serviceAction(
  exec: ExecFn,
  sessionId: string,
  name: string,
  action: ServiceAction
): Promise<string> {
  if (!NAME_OK.test(name)) throw new Error(`非法的服务名：${name}`)
  if (!VERB[action]) throw new Error(`不支持的操作：${action}`)

  const priv = await privilege(exec, sessionId)
  const { stdout } = await exec(
    `${priv.prefix}systemctl ${action} ${sq(name)} 2>&1; echo "rc=$?"`
  )
  const rc = /rc=(\d+)/.exec(stdout)?.[1]
  const body = stdout.replace(/rc=\d+/, '').trim()

  if (rc !== '0') {
    // sudo 密码/权限问题最常见，直接把通用解释接到真实报错后面
    const hint = /password is required|a terminal is required/i.test(body) ? `\n${priv.why}` : ''
    throw new Error(body || `${VERB[action]} ${name} 失败（退出码 ${rc ?? '未知'}）${hint}`)
  }

  // 有些 unit 是 Type=oneshot：systemctl 立刻返回 0，但服务可能随即退出。
  // 不在这里二次判定，交给界面的刷新去显示真实状态。
  return `已${VERB[action]} ${name}`
}

/* ============================ 启动日志（journalctl） ============================ */

/** `2026-11-26T16:20:31+0800 host systemd[1]: ...` → `2026-11-26 16:20:31` */
const STAMP_AT = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/

export function logStamp(line: string): string {
  const m = STAMP_AT.exec(line)
  return m ? `${m[1]} ${m[2]}` : ''
}

/** journalctl 自己吐的提示行 / 分隔行，不是服务日志 */
const JOURNAL_NOISE = /^(-- Logs begin at |-- No entries --|Hint: You are currently not seeing)/

/**
 * 把 journalctl 的原始输出切成「能显示的行」。
 * `-- Logs begin at ... --` 这种页眉和 `Hint: 你看不到别人的日志` 都不是日志本身，
 * 前者纯噪音，后者要单独拎出来当提示 —— 混在日志里会被用户当成一条报错。
 */
export function parseJournal(raw: string): { lines: string[]; hint: string } {
  const lines: string[] = []
  let hint = ''
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) continue
    if (/^Hint: You are currently not seeing/.test(line)) {
      hint = line.replace(/^Hint:\s*/, '').trim()
      continue
    }
    if (JOURNAL_NOISE.test(line)) continue
    // sudo 自己报的错不是日志，单独收起来
    if (/^sudo: /.test(line)) {
      hint = hint || line
      continue
    }
    lines.push(line)
  }
  return { lines, hint }
}

/**
 * `--since` 是**闭区间**：上次最后一行所在的那一秒会被重新吐一遍。
 * 完全按时间戳 `>` 过滤会丢掉同一秒里后来的行（高频服务一秒几十条），
 * 所以按「这一秒里上次已经收过几条」精确跳过前面那几条。
 * 没有时间戳的行是多行 message 的续行，无从判断新旧，保留。
 */
export function dropSeen(lines: string[], since: string, skip: number): string[] {
  if (!since) return lines
  let seen = 0
  return lines.filter((line) => {
    if (logStamp(line) !== since) return true
    seen += 1
    return seen > Math.max(0, skip)
  })
}

/** 拿不到完整日志的几种典型输出：权限不够 / 没开持久化 / journal 目录读不了 */
const NEED_ROOT =
  /not seeing messages from other users|Access denied|Operation not permitted|Failed to open journal|No journal files were found|Failed to add match/i

export async function serviceLogs(
  exec: ExecFn,
  sessionId: string,
  name: string,
  q: ServiceLogQuery
): Promise<ServiceLogResult> {
  if (!NAME_OK.test(name)) throw new Error(`非法的服务名：${name}`)

  const limit = Math.max(50, Math.min(2000, Math.round(q.lines) || 300))
  const since = q.since && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(q.since) ? q.since : ''

  const args = [`-u ${sq(name)}`, '--no-pager', '-o short-iso', `-n ${limit}`]
  // since 和 -n 一起用时取的是「那一秒之后最近的 limit 条」，正好当作增量上限
  if (since) args.push(`--since ${sq(since)}`)

  const run = (prefix: string) => exec(`${prefix}journalctl ${args.join(' ')} 2>&1`)
  const at = Date.now()

  let out = await run('')
  let source: 'user' | 'sudo' = 'user'
  let note = ''

  if (NEED_ROOT.test(out.stdout)) {
    const priv = await privilege(exec, sessionId)
    if (priv.prefix) {
      const elevated = await run(priv.prefix)
      // sudo 也没多看到东西时，保留普通账号那份原始输出（更能说明真实原因）
      out = elevated
      source = 'sudo'
      if (NEED_ROOT.test(elevated.stdout)) note = 'journalctl 仍然没给出内容，可能这台机器没开持久化日志。'
    } else if (priv.why) {
      note = priv.why
    }
  }

  const body = out.stdout || ''
  if (/journalctl:\s*(command )?not found|journalctl: not found/i.test(body)) {
    throw new Error('这台机器没有 journalctl（systemd-journald 未安装），看不了服务日志。')
  }

  const parsed = parseJournal(body)
  const lines = dropSeen(parsed.lines, since, q.skip ?? 0)

  // 游标：本批最后一条带时间戳的行；本批没东西就沿用上一次的
  let cursor = since
  let cursorCount = since ? Math.max(0, q.skip ?? 0) : 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const stamp = logStamp(lines[i])
    if (!stamp) continue
    cursor = stamp
    cursorCount = lines.filter((l) => logStamp(l) === stamp).length
    break
  }

  return {
    lines,
    cursor,
    cursorCount,
    source,
    note: note || parsed.hint,
    at
  }
}
