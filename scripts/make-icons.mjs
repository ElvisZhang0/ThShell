/**
 * 从 build/icon.svg 生成各尺寸 PNG 与 Windows .ico。
 *
 * 用法：node scripts/make-icons.mjs
 *
 * 为什么用矢量派生而不是直接画位图：应用图标要出现在 16px 的任务栏、
 * 32px 的标题栏、256px 的商店页和 1024px 的宣传图上，只有矢量能保证
 * 每个尺寸的边缘都干净。这张 SVG 是唯一源文件，改完重跑本脚本即可。
 */
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'build', 'icon.svg')
const BUILD_DIR = path.join(ROOT, 'build')
const LINUX_DIR = path.join(BUILD_DIR, 'icons')
const RES_DIR = path.join(ROOT, 'resources')

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

/**
 * 主体在画布里的基准占比。1.05 让图形在大尺寸下更饱满（约 50% 画布宽），
 * 小尺寸再额外放大一点，抵掉缩小时的视觉收窄。
 */
const BASE_SCALE = 1.05

function scaleFor(size) {
  if (size >= 256) return 1
  if (size >= 48) return 1.02
  return 1.06
}

async function renderPng(size) {
  // 只放大提示符主体，圆角底板保持原比例 —— 底板跟着放大会把圆角顶出画布
  const scale = (BASE_SCALE * scaleFor(size)).toFixed(3)
  const svg = fs
    .readFileSync(SRC, 'utf8')
    .replace(
      'transform="translate(512 512) scale(1) translate(-512 -512)"',
      `transform="translate(512 512) scale(${scale}) translate(-512 -512)"`
    )

  return sharp(Buffer.from(svg))
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
}

/** electron-builder 在 Windows 上只认 .ico，自己拼一个多尺寸的，避免它去调外部工具 */
function buildIco(images) {
  const count = images.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)

  const dirEntries = []
  let offset = 6 + count * 16

  for (const { size, data } of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0) // width（256 记作 0）
    entry.writeUInt8(size >= 256 ? 0 : size, 1) // height
    entry.writeUInt8(0, 2) // 调色板数
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bpp
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    dirEntries.push(entry)
    offset += data.length
  }

  return Buffer.concat([header, ...dirEntries, ...images.map((i) => i.data)])
}

async function main() {
  if (!fs.existsSync(SRC)) throw new Error(`找不到源文件：${SRC}`)
  fs.mkdirSync(LINUX_DIR, { recursive: true })
  fs.mkdirSync(RES_DIR, { recursive: true })

  const icoImages = []

  for (const size of SIZES) {
    const png = await renderPng(size)
    const target =
      size === 1024
        ? path.join(BUILD_DIR, 'icon.png')
        : path.join(LINUX_DIR, `${size}x${size}.png`)
    fs.writeFileSync(target, png)
    console.log(`✓ ${path.relative(ROOT, target)}`)
    if ([16, 24, 32, 48, 64, 128, 256].includes(size)) {
      icoImages.push({ size, data: png })
    }
  }

  const ico = buildIco(icoImages)
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), ico)
  console.log(`✓ build/icon.ico（${icoImages.length} 个尺寸，${(ico.length / 1024).toFixed(1)} KB）`)

  // 窗口图标：打包后从 asar 里读，256 够用
  const winIcon = await renderPng(256)
  fs.writeFileSync(path.join(RES_DIR, 'icon.png'), winIcon)
  console.log('✓ resources/icon.png')
}

main().catch((err) => {
  console.error('生成图标失败：', err)
  process.exit(1)
})
