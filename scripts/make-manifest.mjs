#!/usr/bin/env node
/**
 * 生成 latest.json —— 检查更新用的更新描述文件。
 *
 * 打包完成后跑一遍：扫 release/ 里的安装包，算 sha256 和字节数，写成客户端能读的 JSON。
 * 把 latest.json 和那些安装包一起丢到任意静态目录（nginx / 共享盘 / 对象存储）即可。
 *
 * 用法：
 *   node scripts/make-manifest.mjs                          # 用 package.json 的 version
 *   node scripts/make-manifest.mjs --version 0.2.0          # 指定版本（一般不用）
 *   node scripts/make-manifest.mjs --base https://dl.x.com/thshell/   # 写绝对地址
 *   node scripts/make-manifest.mjs --notes "修复了 xxx\n新增了 yyy"
 *
 * 不写 --base 时用**相对路径**（只有文件名）：客户端会按 latest.json 自己的 URL 去解析，
 * 这样换域名、挪目录都不用重新生成。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const root = process.cwd()
const dir = path.resolve(root, arg('dir', 'release'))
const out = path.resolve(root, arg('out', 'latest.json'))
const base = arg('base', '')
const notes = arg('notes', '')

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
  assets.push({
    ...kind,
    url: base ? base.replace(/\/?$/, '/') + encodeURIComponent(file) : encodeURIComponent(file),
    size,
    sha256: sum
  })
  console.log(`[manifest] ${kind.platform}/${kind.arch}/${kind.format}  ${(size / 1048576).toFixed(1)}MB  ${file}`)
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
console.log('[manifest] 把 latest.json 和安装包一起放到同一个目录，再把地址填进「配置 → 更新源」')
