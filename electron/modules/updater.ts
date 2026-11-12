import { app, net, shell } from 'electron'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DEFAULT_UPDATE_FEEDS, GH_MIRROR_PREFIXES } from '../types'
import type { UpdateAsset, UpdateCheckResult, UpdateManifest, UpdateProgress } from '../types'

/**
 * 检查更新 / 下载 / 安装。
 *
 * 为什么不用 electron-updater：
 *   1. 它只认 electron-builder 那套 latest.yml + Squirrel/NSIS，Linux 那边**只支持 AppImage**，
 *      而我们要发 deb / rpm（CentOS、麒麟这些机器上装的就是 rpm）；
 *   2. macOS 未签名时 Squirrel.Mac 直接拒绝，等于白搭；
 *   3. 我们的"更新源"就是一个静态 JSON，二进制放哪儿都行。
 * 所以这里用最朴素的方案：一个 latest.json 描述"新版本有哪些包、在哪儿、sha256 多少"，
 * 客户端自己比对、自己下载、自己校验、自己拉起安装包。跨平台一致，也没有隐藏行为。
 *
 * 更新源不限于自建服务器 —— GitHub Releases 直接就能当源，见 types.ts 的
 * DEFAULT_UPDATE_FEED。判断依据只有一条：那个 URL 能取到 latest.json。
 *
 * 安全边界：我们只做 sha256 校验（写了就强制校验），不做签名验证 —— 没证书，做也做不了。
 */

/** 各平台优先下载哪种格式：越靠前越优先 */
const FORMAT_PREFERENCE: Record<string, string[]> = {
  win32: ['exe', 'msi', 'zip'],
  darwin: ['dmg', 'zip'],
  linux: ['AppImage', 'deb', 'rpm', 'tar.gz']
}

/**
 * 版本号比较：只看数字段，`0.10.0` > `0.9.9`。
 * 不引 semver 包 —— 我们只发 `x.y.z`，多引一个依赖不值当。
 * 预发布后缀（`-beta.1`）一律当 0 处理，回归测试里会说明。
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    String(v)
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((s) => Number.parseInt(s, 10))
      .map((n) => (Number.isFinite(n) ? n : 0))
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** 校验 latest.json 的结构。少字段、类型不对都要当场说清楚，别让用户对着"检查更新失败"猜 */
export function parseManifest(raw: unknown): UpdateManifest {
  const m = raw as Partial<UpdateManifest> | null
  if (!m || typeof m !== 'object') throw new Error('更新描述不是对象')
  if (!m.version || typeof m.version !== 'string') throw new Error('更新描述里没有 version')
  if (!Array.isArray(m.assets) || m.assets.length === 0) throw new Error('更新描述里没有 assets')
  const assets: UpdateAsset[] = m.assets.map((a, i) => {
    if (!a || typeof a.url !== 'string' || !a.url) throw new Error(`第 ${i + 1} 个包没有 url`)
    // 镜像写坏了不该让整份描述作废：能用的留下，不能用的丢掉
    const mirrors = Array.isArray(a.mirrors)
      ? a.mirrors.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      : undefined
    return {
      platform: String(a.platform || ''),
      arch: String(a.arch || ''),
      format: String(a.format || ''),
      url: a.url,
      mirrors: mirrors && mirrors.length ? mirrors : undefined,
      size: typeof a.size === 'number' ? a.size : undefined,
      sha256: typeof a.sha256 === 'string' ? a.sha256.toLowerCase() : undefined
    }
  })
  return { version: m.version, publishedAt: m.publishedAt, notes: m.notes, assets }
}

/** 从一堆包里挑出"我这台机器该装的那个" */
export function pickAsset(manifest: UpdateManifest): UpdateAsset | undefined {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const candidates = manifest.assets.filter(
    (a) =>
      a.platform === process.platform &&
      (a.arch === arch || !a.arch) &&
      // 免安装版（portable）不能自我替换：拉起它只是又开一个实例，用户以为更新了其实没换。
      // 所以永远不把它当更新包 —— 宁可报"没有可用的包"，也别给个装不上的。
      a.format !== 'portable'
  )
  const order = FORMAT_PREFERENCE[process.platform] ?? []
  for (const format of order) {
    const hit = candidates.find((a) => a.format === format)
    if (hit) return hit
  }
  // 格式认不出来时，只要平台对得上就给第一个 —— 用户自己判断能不能装
  return candidates[0]
}

/** 读文本：http(s) 走 Electron 的 net（会带上系统代理），file:// 直接读盘 */
async function readText(url: string, signal: AbortSignal): Promise<string> {
  if (url.startsWith('file://')) {
    return fs.promises.readFile(new URL(url), 'utf-8')
  }
  const res = await net.fetch(url, { signal })
  if (!res.ok) throw new Error(`服务器返回 ${res.status} ${res.statusText}`)
  return res.text()
}

/** 把一个地址缩短成"牌子"，报错时说人话：`https://ghfast.top/https://github.com/x` → `ghfast.top` */
function channelName(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * 把下载地址补齐成"多条通道"。
 *
 * 为什么要自动补：latest.json 里的地址可能是直连 github.com 的，也可能是带加速前缀的。
 * 直连在国内常常断流，而同一份文件套上镜像前缀就能下 —— 与其发版时手写 mirrors，
 * 不如客户端自己推出来：
 *   - 地址带 github.com → 顺带补上每个已知镜像前缀
 *   - 地址已经套了镜像前缀 → 补上剥掉前缀的原始 GitHub 地址
 * 用户自己配的 mirrors 优先级最高，排在最前面。
 */
export function withFallbackUrls(asset: UpdateAsset): UpdateAsset {
  const extra: string[] = []
  const inner = asset.url.match(/^https?:\/\/[^/]+\/(https:\/\/github\.com\/.+)$/i)
  if (inner) {
    // 已经是镜像地址：原始 GitHub 地址作为第一备用
    extra.push(inner[1])
  } else if (/^https?:\/\/github\.com\//i.test(asset.url)) {
    for (const prefix of GH_MIRROR_PREFIXES) extra.push(prefix + asset.url)
  }
  if (!extra.length) return asset

  const merged = [...(asset.mirrors ?? [])]
  for (const u of extra) if (!merged.includes(u) && u !== asset.url) merged.push(u)
  return { ...asset, mirrors: merged.length ? merged : undefined }
}

/**
 * 拉取 latest.json 并跟当前版本比对。
 *
 * `feed` 可以是单个地址、一组地址，或空字符串：
 *   - 空 → 用内置的 DEFAULT_UPDATE_FEEDS（直连 + 国内加速镜像）
 *   - 数组 → 依次/并发尝试这组地址（冒烟和调试用）
 *   - 字符串 → 只用它（用户自己配的内网源，不该再偷偷去连 GitHub）
 *
 * 多个候选是**并发**发的，谁先成功用谁：串行等超时的话，三个源最坏要 24 秒，
 * 用户早就把弹窗关了。任何一步失败都写进 `error` 而不是抛出去 —— 调用方是界面。
 */
export async function checkForUpdates(feed: string | string[]): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  const requested = (Array.isArray(feed) ? feed : [feed])
    .map((u) => (u || '').trim())
    .filter(Boolean)
  const candidates = requested.length ? requested : DEFAULT_UPDATE_FEEDS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  const failures: string[] = []

  try {
    const picked = await new Promise<{ manifest: UpdateManifest; source: string }>(
      (resolve, reject) => {
        let left = candidates.length
        let settled = false
        const fail = (source: string, err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          // 只有多条通道时才标"是哪条挂的"；单源报错加个域名前缀纯属噪音
          failures.push(candidates.length > 1 ? `${channelName(source)}：${msg}` : msg)
        }
        for (const source of candidates) {
          void (async () => {
            try {
              const text = await readText(source, controller.signal)
              let raw: unknown
              try {
                raw = JSON.parse(text)
              } catch {
                throw new Error('不是合法 JSON')
              }
              const manifest = parseManifest(raw)
              if (!settled) {
                settled = true
                resolve({ manifest, source })
              }
            } catch (err) {
              fail(source, err)
            } finally {
              left -= 1
              if (left === 0 && !settled) reject(new Error(failures.join('；') || '没有可用的通道'))
            }
          })()
        }
      }
    )

    const { manifest, source } = picked
    // 相对路径按**取到数据的那条通道**解析：一个目录里放 latest.json 和安装包最省事。
    // 走镜像时这一条顺手把下载也带上镜像前缀（`.../releases/latest/download/<文件名>`），
    // 所以 JSON 里写文件名就够了。
    const abs = (u: string) => new URL(u, source).toString()
    manifest.assets = manifest.assets.map((a) =>
      withFallbackUrls({ ...a, url: abs(a.url), mirrors: a.mirrors?.map(abs) })
    )

    const hasUpdate = compareVersions(manifest.version, current) > 0
    const asset = hasUpdate ? pickAsset(manifest) : undefined
    return {
      current,
      latest: manifest.version,
      hasUpdate,
      notes: manifest.notes,
      asset,
      feed: source,
      unsupported:
        hasUpdate && !asset
          ? `更新源里没有 ${process.platform}/${process.arch} 可自动更新的包（免安装版不算）`
          : undefined
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      current,
      hasUpdate: false,
      error: controller.signal.aborted
        ? '连接更新源超时（12 秒，直连和镜像都没通）'
        : candidates.length > 1
          ? `所有通道都没取到更新描述 —— ${msg}`
          : msg
    }
  } finally {
    clearTimeout(timer)
  }
}

let activeAbort: AbortController | null = null

export function cancelDownload(): void {
  activeAbort?.abort()
  activeAbort = null
}

function tempDir(): string {
  const dir = path.join(app.getPath('temp'), 'thshell-update')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function fileNameOf(url: string, format: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '')
    if (name) return name
  } catch {
    /* 落到下面兜底 */
  }
  return `thshell-update.${format}`
}

/**
 * 从**一个**地址下载到 `<dest>.part`，校验通过后 rename 成正式文件。
 * 失败一律抛出去，由外层决定是否换镜像。
 */
async function downloadOne(
  url: string,
  asset: UpdateAsset,
  dest: string,
  onProgress: (p: UpdateProgress) => void,
  controller: AbortController
): Promise<void> {
  const part = dest + '.part'
  try {
    const res = await net.fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`服务器返回 ${res.status}`)
    if (!res.body) throw new Error('响应没有内容')

    const total = Number(res.headers.get('content-length') || asset.size || 0)
    const hash = crypto.createHash('sha256')
    let transferred = 0
    let lastTick = 0
    let lastBytes = 0
    let speed = 0

    const source = Readable.fromWeb(res.body as never)
    source.on('data', (chunk: Buffer) => {
      transferred += chunk.length
      hash.update(chunk)
      const now = Date.now()
      // 与传输进度条同一套节流：每 120ms 上报一次，且速度做指数平滑，读数不跳
      if (now - lastTick >= 120 || transferred === total) {
        const dt = (now - lastTick) / 1000
        if (dt > 0 && lastTick) {
          const inst = (transferred - lastBytes) / dt
          speed = speed ? speed * 0.65 + inst * 0.35 : inst
        }
        lastTick = now
        lastBytes = transferred
        onProgress({
          transferred,
          total,
          percent: total ? Math.min(100, Math.round((transferred / total) * 100)) : 0,
          speed
        })
      }
    })

    await pipeline(source, fs.createWriteStream(part))

    if (asset.size && transferred !== asset.size) {
      throw new Error(`文件不完整：应为 ${asset.size} 字节，实际 ${transferred} 字节`)
    }
    if (asset.sha256) {
      const got = hash.digest('hex')
      if (got !== asset.sha256) {
        throw new Error(`校验不通过：期望 ${asset.sha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…`)
      }
    }

    fs.rmSync(dest, { force: true })
    fs.renameSync(part, dest)
  } catch (err) {
    fs.rmSync(part, { force: true })
    throw err
  }
}

/**
 * 下载安装包到临时目录，边下边算 sha256。
 * 返回 null 表示被取消（用户点了取消，不算错误）。
 *
 * 地址按 `[url, ...mirrors]` 依次尝试：GitHub Release 的附件国内经常连不上或者下到一半断，
 * 配了镜像就不用等用户手动重试。只有全部失败才报错，并把每个源的失败原因都带上。
 */
export async function downloadUpdate(
  asset: UpdateAsset,
  onProgress: (p: UpdateProgress) => void
): Promise<string | null> {
  const urls = [asset.url, ...(asset.mirrors ?? [])].filter((u) => /^https?:/i.test(u))
  if (!urls.length) throw new Error('只支持 http/https 下载地址')

  const controller = new AbortController()
  activeAbort = controller
  const dest = path.join(tempDir(), fileNameOf(asset.url, asset.format))
  const failures: string[] = []
  let firstErr: unknown = null

  try {
    for (let i = 0; i < urls.length; i += 1) {
      try {
        await downloadOne(urls[i], asset, dest, onProgress, controller)
        return dest
      } catch (err) {
        if (controller.signal.aborted) return null
        if (!firstErr) firstErr = err
        const msg = err instanceof Error ? err.message : String(err)
        failures.push(`${i === 0 ? '主源' : `镜像 ${i}`}：${msg}`)
        // 换源时进度归零，否则进度条会从上一份的百分比开始跳
        if (i < urls.length - 1) {
          onProgress({ transferred: 0, total: asset.size ?? 0, percent: 0, speed: 0 })
        }
      }
    }
    // 只有一个地址时别套"所有地址都失败"这层壳 —— 用户会纳闷"哪来的多个地址"
    if (urls.length === 1 && firstErr instanceof Error) throw firstErr
    throw new Error(`所有下载地址都失败了 —— ${failures.join('；')}`)
  } finally {
    activeAbort = null
  }
}

/**
 * 启动安装包。返回值是给用户看的一句话（各平台能做的事不一样）：
 *   Windows 直接拉起安装程序 —— 这是唯一能"真装"的平台；
 *   macOS 打开 dmg，用户自己拖进"应用程序"；
 *   Linux 打开所在目录 —— deb/rpm 需要 sudo，AppImage 直接替换原文件也行，但那是用户自己的选择。
 */
export async function installUpdate(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) throw new Error('安装包不见了，可能已经被清理，请重新下载')

  if (process.platform === 'win32') {
    // detached + unref：安装程序要活过本进程退出。
    // 不传 /S —— 静默安装遇上 UAC 会卡住且没有任何界面，用户只会觉得"点了没反应"
    spawn(filePath, [], { detached: true, stdio: 'ignore' }).unref()
    // 留 1.2 秒再退：自动升级是一步到底的，界面刚显示"正在启动安装程序"就黑掉，
    // 用户会怀疑是不是崩了。这段时间足够他看清那句话。
    setTimeout(() => app.quit(), 1200)
    return '安装程序已启动，本窗口即将关闭，装完会自动重新打开'
  }

  if (process.platform === 'darwin') {
    await shell.openPath(filePath)
    return '已打开安装镜像，把 ThShell 拖进「应用程序」覆盖旧版本即可'
  }

  shell.showItemInFolder(filePath)
  const name = path.basename(filePath)
  if (name.endsWith('.deb')) return `已定位到安装包，执行：sudo dpkg -i ${name}`
  if (name.endsWith('.rpm')) return `已定位到安装包，执行：sudo rpm -Uvh ${name}`
  if (name.endsWith('.AppImage')) return '已定位到新版本，替换旧的 AppImage 文件后重新打开'
  return '已定位到安装包'
}
