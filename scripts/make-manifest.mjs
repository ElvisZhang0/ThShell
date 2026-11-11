#!/usr/bin/env node
/**
 * 生成 latest.json —— 检查更新用的更新描述文件。
 *
 * 打包完成后跑一遍：扫 release/ 里的安装包，算 sha256 和字节数，写成客户端能读的 JSON。
 *
 * 用法（GitHub Releases，最常用）：
 *   node scripts/make-manifest.mjs --gh ElvisZhang0/ThShell --notes "修复了 xxx"
 *   → 每个包写成 https://github.com/ElvisZhang0/ThShell/releases/latest/download/<文件名>
 *   这个地址永远指向**最新 release 的同名附件**，所以发版时不用改代码、不用固定 tag。
 *
 * 其它：
 *   node scripts/make-manifest.mjs --base https://dl.example.com/thshell/   # 自建静态目录
 *   node scripts/make-manifest.mjs                                          # 相对路径
 *   node scripts/make-manifest.mjs --mirror https://ghfast.top/             # 给每个包配镜像
 *   node scripts/make-manifest.mjs --version 0.2.0 --notes "..."            # 指定版本/说明
 *
 * 不写 --base / --gh 时用**相对路径**（只有文件名）：客户端会按 latest.json 自己的 URL 去解析，
 * 这样换域名、挪目录都不用重新生成。
 *
 * 镜像规则：`--mirror <前缀>` 可重复，生成 `mirrors: [前缀 + 主地址]`。
 * 主地址失败时客户端自动按顺序试镜像，全部失败才报错。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
/** 可重复的 --xxx 参数（--mirror 可以给多个） */
const argAll = (name) => {
  const out = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}` && args[i + 1]) out.push(args[i + 1])
  }
  return out
}

const root = process.cwd()
const dir = path.resolve(root, arg('dir', 'release'))
const out = path.resolve(root, arg('out', 'latest.json'))
const notes = arg('notes', '')
const gh = arg('gh', '')
const mirrors = argAll('mirror')

// base 优先级：--base > --gh 推导 > 相对路径
let base = arg('base', '')
if (!base && gh) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(gh)) {
    console.error(`[manifest] --gh 要写成 owner/repo，收到的是：${gh}`)
    process.exit(1)
  }
  base = `https://github.com/${gh}/releases/latest/download/`
}

if (!fs.existsSync(dir)) {
  console.error(`[manifest] 目录不存在：${dir}（先跑 pnpm dist:win / dist:linux）`)
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))
const version = arg('version', pkg.version).replace(/^v/i, '')

/** 文件名 → { platform, arch, format }。认不出来的直接跳过，别往 JSON 里塞垃圾 */
function classify(file) {
  const lower = file.toLowerCase()
  if (lower.endsWith('.blockmap') || lower.endsWith('.yml') || lower.endsWith('.json')) return null

  const arch = /(?:arm64|aarch64)/i.test(file) ? 'arm64' : 'x64'

  // Windows：安装版和免安装版都是 .exe，只有安装版能自动更新
  if (lower.endsWith('.exe')) {
    if (lower.includes('portable')) return { platform: 'win32', arch, format: 'portable' }
    if (lower.includes('setup') || lower.includes('win')) return { platform: 'win32', arch, format: 'exe' }
    return null
  }
  if (lower.endsWith('.msi')) return { platform: 'win32', arch, format: 'msi' }

  // macOS：dmg 优先，zip 备着（有的场景只给 zip）
  if (lower.endsWith('.dmg')) return { platform: 'darwin', arch, format: 'dmg' }
  if (lower.endsWith('.zip') && lower.includes('mac')) return { platform: 'darwin', arch, format: 'zip' }

  // Linux：AppImage > deb > rpm > tar.gz，客户端按这个顺序挑
  if (lower.endsWith('.appimage')) return { platform: 'linux', arch, format: 'AppImage' }
  if (lower.endsWith('.deb')) return { platform: 'linux', arch, format: 'deb' }
  if (lower.endsWith('.rpm')) return { platform: 'linux', arch, format: 'rpm' }
  if (lower.endsWith('.tar.gz')) return { platform: 'linux', arch, format: 'tar.gz' }

  return null
}

function sha256(file) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex')
}

const assets = []
for (const file of fs.readdirSync(dir).sort()) {
  const full = path.join(dir, file)
  if (!fs.statSync(full).isFile()) continue
  const kind = classify(file)
  if (!kind) continue

  const size = fs.statSync(full).size
  const sum = sha256(full)
  const url = base ? base.replace(/\/?$/, '/') + encodeURIComponent(file) : encodeURIComponent(file)
  const asset = { ...kind, url, size, sha256: sum }

  // 镜像前缀只能接在绝对地址前面；相对路径时静默跳过（客户端没法拼）
  if (mirrors.length && /^https?:\/\//i.test(url)) {
    asset.mirrors = mirrors.map((m) => (m.endsWith('/') ? m : m + '/') + url)
  }
  assets.push(asset)

  const extra = asset.mirrors ? `  +${asset.mirrors.length} 个镜像` : ''
  console.log(
    `[manifest] ${kind.platform}/${kind.arch}/${kind.format}  ${(size / 1048576).toFixed(1)}MB  ${file}${extra}`
  )
}

if (mirrors.length && !/^https?:\/\//i.test(base)) {
  console.warn('[manifest] 提醒：没给绝对地址，--mirror 被忽略了（镜像得拼在完整 URL 前面）')
}

if (!assets.length) {
  console.error(`[manifest] ${dir} 里没找到可识别的安装包`)
  process.exit(1)
}

const manifest = {
  version,
  publishedAt: new Date().toISOString(),
  notes: notes || `ThShell ${version}`,
  assets
}

fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
console.log(`\n[manifest] 已写入 ${out}（${assets.length} 个包，版本 ${version}）`)

if (path.basename(out) !== 'latest.json') {
  console.warn('[manifest] 提醒：客户端认的是文件名 latest.json，改名后就取不到了')
}

if (gh) {
  const rel = path.relative(root, dir).replace(/\\/g, '/') || '.'
  console.log('[manifest] 下一步：把 latest.json 和上面这些安装包一起传给 GitHub Release')
  console.log(`[manifest]   gh release create v${version} latest.json ${rel}/ThShell-* --notes "${notes || `ThShell ${version}`}"`)
  console.log('[manifest]   注意：Release 不能勾 Pre-release —— 客户端读的是 releases/latest')
  console.log('[manifest]   仓库必须是 public，否则附件匿名下载会 404')
} else if (base) {
  console.log(`[manifest] 下一步：把 latest.json 和安装包一起放到 ${base}，再确认「配置 → 更新源」指向最新版`)
} else {
  console.log('[manifest] 下一步：把 latest.json 和安装包放同一个目录，再把那个地址填进「配置 → 更新源」')
}
