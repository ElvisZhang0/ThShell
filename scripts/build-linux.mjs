#!/usr/bin/env node
/**
 * 打包 Linux 版（AppImage / deb / rpm / tar.gz）。
 *
 * 为什么需要这个脚本：electron-builder 在 Windows 和 macOS 上**不能直接**打 Linux 包
 * —— fpm（做 deb/rpm）和 appimagetool 都是 ELF 程序。官方给的路子是在 Linux 容器里跑。
 * 所以这里：宿主机先把前端构建好，然后把整个项目目录挂进容器，在里面装依赖 + 打包。
 *
 * 为什么依赖要在容器里重装，而不是复用宿主机的 node_modules：
 * pnpm 的 node_modules 是一堆指向全局 store 的符号链接，路径是 Windows 的绝对路径
 * （`C:\Users\...\.pnpm\...`），挂进 Linux 容器全是断链。所以给 node_modules 单独挂一块
 * 命名卷，让容器自己装一份 Linux 版；store 也挂卷，第二次打不用重新下载。
 *
 * 用法：
 *   npm run dist:linux              # 当前平台自动选：Linux 本机直跑，Win/mac 走 Docker
 *   node scripts/build-linux.mjs --skip-build   # 跳过宿主机的 vite build
 *   末尾可以带 electron-builder 的参数，比如 `-- --publish never`
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const IMAGE = 'electronuserland/builder:latest'
/** 四块缓存卷：装一次，以后都复用 */
const VOLS = {
  modules: 'thshell-linux-node_modules',
  store: 'thshell-linux-pnpm-store',
  electron: 'thshell-linux-electron-cache',
  builder: 'thshell-linux-builder-cache'
}

const argv = process.argv.slice(2)
const skipBuild = argv.includes('--skip-build')
const passthrough = argv.filter((a) => a !== '--skip-build')

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.error) {
    console.error(`[dist:linux] 执行失败：${cmd} ${args.join(' ')}`)
    console.error(r.error.message)
    process.exit(1)
  }
  if (r.status !== 0) process.exit(r.status ?? 1)
  return r
}

// 1. 宿主机构建前端产物（vite build + vue-tsc），容器里只负责"装壳"
if (!skipBuild) {
  console.log('[dist:linux] 1/2 构建渲染进程与主进程…')
  // 直接跑脚本，不经过 npm —— 否则 npm 会对着 pnpm 导出的 npm_config_* 念 8 行警告
  run(process.execPath, ['scripts/build.mjs'])
}

// 2. Linux 本机：直接打，不用 Docker（最快，也是 CI 里 ubuntu-latest 的路径）
if (process.platform === 'linux') {
  console.log('[dist:linux] 2/2 本机打包…')
  run(path.join(ROOT, 'node_modules/.bin/electron-builder'), [
    '--linux',
    'AppImage',
    'deb',
    'rpm',
    'tar.gz',
    ...passthrough
  ])
  process.exit(0)
}

// 3. Windows / macOS：走 Docker
const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
  encoding: 'utf8'
})
if (probe.status !== 0) {
  console.error(
    '[dist:linux] 没连上 Docker。Linux 包必须在 Linux 里构建（fpm/appimagetool 是 ELF 程序），\n' +
      '             所以要么装 Docker Desktop，要么把项目丢到 Linux 机器 / CI 上跑 `npm run dist:linux`。\n' +
      '             另：macOS 和 Windows 都不可能直接产出 deb/rpm —— 这不是配置问题。'
  )
  process.exit(1)
}

// Docker 只认宿主机的原生路径。Git Bash 里 process.cwd() 已经是 `C:\...` 形式，
// 但万一被 MSYS 转成 `/c/...` 就挂不上，这里统一转回盘符写法
const hostDir = process.platform === 'win32' ? path.win32.normalize(ROOT) : ROOT

console.log(`[dist:linux] 2/2 在容器里打包（${IMAGE}）…`)
const inner = [
  'set -e',
  // 镜像里带 node，但 pnpm 版本可能对不上 lockfile v9，缺了就装一个
  'command -v pnpm >/dev/null 2>&1 || npm i -g pnpm@9 --silent',
  // --frozen-lockfile：容器里的依赖必须跟锁文件一致，别悄悄装出第二套版本
  'pnpm install --frozen-lockfile --reporter=silent',
  ['./node_modules/.bin/electron-builder', '--linux', 'AppImage', 'deb', 'rpm', 'tar.gz', ...passthrough]
    .join(' ')
    .trim()
].join(' && ')

run('docker', [
  'run',
  '--rm',
  ...(process.platform === 'darwin' && process.arch === 'arm64' ? ['--platform', 'linux/amd64'] : []),
  '-v',
  `${hostDir}:/project`,
  // 用命名卷盖住宿主机的 node_modules，容器里装自己的
  '-v',
  `${VOLS.modules}:/project/node_modules`,
  '-v',
  `${VOLS.store}:/root/.local/share/pnpm/store`,
  '-v',
  `${VOLS.electron}:/root/.cache/electron`,
  '-v',
  `${VOLS.builder}:/root/.cache/electron-builder`,
  '-w',
  '/project',
  IMAGE,
  'bash',
  '-lc',
  inner
])

// 容器以 root 跑，产物在 Windows 上没影响；在 Linux 上属主会是 root，
// 提示一句比让他自己 `sudo chown` 强
const out = path.join(ROOT, 'release')
if (fs.existsSync(out)) {
  const made = fs
    .readdirSync(out)
    .filter((f) => /\.(AppImage|deb|rpm|tar\.gz)$/.test(f))
    .map((f) => `  ${f}`)
  console.log(`[dist:linux] 完成，产物在 release/：\n${made.join('\n') || '  （没有产出，看上面的报错）'}`)
}
