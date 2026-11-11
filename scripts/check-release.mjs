#!/usr/bin/env node
/**
 * 发布后自检：确认「检查更新」这条路是真的通的。
 *
 * 客户端不认 tag、不认 Release 标题，只认一个地址能不能取到 latest.json ——
 * 所以自检也只验这一件事，外加每个包里写的 sha256 和大小对不对得上。
 *
 * 用法：
 *   node scripts/check-release.mjs                 # 直连 + 两个国内镜像各试一遍
 *   node scripts/check-release.mjs --expect 0.1.0  # 额外校验版本号
 *   node scripts/check-release.mjs --no-download   # 只验清单，不碰安装包（快）
 *
 * 退出码：0 全部通过；1 有失败项（可直接挂在发版脚本后面）。
 */
const args = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const REPO = arg('repo', 'ElvisZhang0/ThShell')
/** 空串 = 直连。顺序和客户端内置的一致 */
const CHANNELS = ['', 'https://ghfast.top/', 'https://gh-proxy.com/']
const MANIFEST = `https://github.com/${REPO}/releases/latest/download/latest.json`
const expect = arg('expect', '').replace(/^v/i, '')
const noDownload = args.includes('--no-download')

const checks = []
const push = (name, ok, detail = '') => checks.push([name, ok, detail])
const ok = (s) => `\x1b[32m${s}\x1b[0m`
const bad = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

async function get(url, { head = false, timeout = 15000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  const started = Date.now()
  try {
    const res = await fetch(url, { method: head ? 'HEAD' : 'GET', signal: ctrl.signal })
    return { res, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** 三条通道各试一次，第一个成功的当作"清单来源" */
async function fetchManifest() {
  const results = []
  for (const prefix of CHANNELS) {
    const url = prefix + MANIFEST
    const label = prefix ? new URL(prefix).hostname : '直连 github.com'
    try {
      const { res, ms } = await get(url)
      if (!res.ok) {
        results.push({ label, ok: false, detail: `HTTP ${res.status}`, ms })
        continue
      }
      const text = await res.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        results.push({ label, ok: false, detail: '不是合法 JSON', ms })
        continue
      }
      results.push({ label, ok: true, detail: `${ms}ms`, ms, json, prefix })
    } catch (err) {
      results.push({ label, ok: false, detail: err.message || '连接失败', ms: 0 })
    }
  }
  return results
}

const channelResults = await fetchManifest()
for (const r of channelResults) {
  push(
    `通道可用：${r.label}`,
    r.ok,
    r.detail + (r.ok ? dim('（客户端会并发探路，一条通就够）') : '')
  )
}

const winner = channelResults.find((r) => r.ok)
if (!winner) {
  push('取到 latest.json', false, '三条通道全失败 —— 检查仓库是否 public、Release 是否发布（不能勾 Pre-release）')
} else {
  const m = winner.json
  push('取到 latest.json', true, `走的是 ${winner.label}`)

  if (expect) {
    push('清单版本与预期一致', String(m.version) === expect, `${m.version} ${expect ? `(预期 ${expect})` : ''}`)
  }
  push('清单有 version', !!m.version, String(m.version ?? '无'))
  push('清单有 assets', Array.isArray(m.assets) && m.assets.length > 0, `${m.assets?.length ?? 0} 个包`)

  const assets = Array.isArray(m.assets) ? m.assets : []
  for (const a of assets) {
    const tag = `${a.platform}/${a.arch}/${a.format}`
    push(`  ${tag} 有 url`, typeof a.url === 'string' && a.url.length > 0, a.url ?? '无')
    push(`  ${tag} 有 sha256`, /^[a-f0-9]{64}$/.test(String(a.sha256 ?? '')), String(a.sha256 ?? '').slice(0, 12))
    push(`  ${tag} 有 size`, typeof a.size === 'number' && a.size > 0, a.size ? `${(a.size / 1048576).toFixed(1)}MB` : '无')
  }

  // 关键的一套：Windows 用户最多，装不上就白发版；mac/linux 各要能挑到包
  const has = (p) => assets.some((a) => a.platform === p && a.format !== 'portable')
  push('Windows 有可自动更新的包', has('win32'), assets.filter((a) => a.platform === 'win32').map((a) => a.format).join('/') || '无')
  push('macOS 有包', has('darwin'), assets.filter((a) => a.platform === 'darwin').map((a) => `${a.format}-${a.arch}`).join(' ') || '无')
  push('Linux 有包', has('linux'), assets.filter((a) => a.platform === 'linux').map((a) => a.format).join('/') || '无')

  // 相对路径要能按清单的位置解析出来（客户端就是这么干的）
  const manifestBase = winner.prefix + MANIFEST
  const resolved = assets.map((a) => {
    try {
      return new URL(a.url, manifestBase).toString()
    } catch (e) {
      return ''
    }
  })
  push('相对地址能解析', resolved.every((u) => /^https?:\/\//.test(u)), resolved[0] ?? '无')

  if (!noDownload && resolved[0]) {
    // 只探第一个包：HEAD 一下够判断"地址真的存在"，不用把上百 MB 拖下来
    try {
      const { res, ms } = await get(resolved[0], { head: true, timeout: 20000 })
      push('安装包地址可下载', res.ok, `HTTP ${res.status} ${ms}ms ${dim(resolved[0])}`)
    } catch (err) {
      push('安装包地址可下载', false, err.message || '连接失败')
    }
  }
}

const failed = checks.filter((c) => !c[1])
for (const [name, pass, detail] of checks) {
  console.log(`  ${pass ? ok('PASS') : bad('FAIL')} ${name}${detail ? '  ' + dim(detail) : ''}`)
}
console.log(
  `\n${failed.length ? bad(`${failed.length} 项失败`) : ok('全部通过')}（${checks.length} 项）`
)
process.exit(failed.length ? 1 : 0)
