import type { SFTPWrapper, FileEntry as SshFileEntry } from 'ssh2'
import fs from 'node:fs'
import path from 'node:path'
import type {
  DirDownloadResult,
  DirUploadResult,
  FileEntry,
  RemoteIdentity,
  TailContent,
  TransferProgress
} from '../types'
import { EDIT_MAX_BYTES } from '../types'
import { decodeText, encodeText, sniffEncoding, type DecodedText, type TextEncoding } from './text-guard'
import { clampLines, collectTail, emptyTail } from './log-tail'

/** SFTP 路径永远用 /，不要用 node:path（Windows 上会给你拼出反斜杠） */
export function joinRemote(dir: string, name: string): string {
  if (dir === '/' || dir === '') return '/' + name
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

export function parentRemote(remotePath: string): string {
  const normalized = remotePath.replace(/\/+$/, '')
  if (!normalized || normalized === '/') return '/'
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return '/'
  return normalized.slice(0, idx)
}

/**
 * 权限位 → 9 位 rwx 串。
 *
 * setuid / setgid / sticky 落在三个 x 位上，ls 的写法是「有执行位用小写、没有用大写」
 * （`rwxr-xr-t`）。不能把它们当普通 x 抹平：`/tmp` 显示成 `rwxrwxrwx` 会让人以为
 * 谁都能删别人的文件，实际上有 sticky 挡着。
 */
export function permText(mode: number): string {
  const bits = mode & 0o7777
  const has = (v: number) => (bits & v) !== 0
  const trio = (r: number, w: number, x: number, special: number, ch: string) => {
    const ex = has(x)
    const xc = has(special) ? (ex ? ch : ch.toUpperCase()) : ex ? 'x' : '-'
    return (has(r) ? 'r' : '-') + (has(w) ? 'w' : '-') + xc
  }
  return (
    trio(0o400, 0o200, 0o100, 0o4000, 's') +
    trio(0o040, 0o020, 0o010, 0o2000, 's') +
    trio(0o004, 0o002, 0o001, 0o1000, 't')
  )
}

/**
 * 从 SFTP 的长格式里抠属主 / 属组名。
 *
 * `readdir` 会给一条 `-rw-r--r-- 1 root root 1234 Nov 10 12:00 name` 这样的串，
 * 前三列（类型+权限、链接数、属主、属组）里不会有空格，文件名里的空格从后面前才开始，
 * 所以按空白切前四个就够了 —— 不用自己去解析 `/etc/passwd`。
 * 有些服务器会回空长格式，那就退回数字 uid/gid。
 */
function splitLongname(longname?: string): { owner: string; group: string } {
  const t = (longname || '').trim().split(/\s+/)
  if (t.length >= 4 && /^[-dlcbsp]/i.test(t[0])) return { owner: t[2], group: t[3] }
  return { owner: '', group: '' }
}

/**
 * 这个条目对当前登录用户可写吗。
 *
 * 顺序不能反：other 位有写就是谁都能写，先判掉；root 不受权限位约束；
 * 剩下的按"属主 → 属组 → 其他"三档看对应的那一位。
 * 拿不到身份（老系统没有 `id`、exec 被禁）就返回 undefined，界面保持中性色 ——
 * 猜错方向比不标更糟：把能写的标红，人会以为要 sudo。
 */
function canWrite(
  mode: number,
  uid: number,
  gid: number,
  who?: RemoteIdentity
): boolean | undefined {
  if (!who) return undefined
  if (mode & 0o002) return true
  if (who.uid === 0) return true
  if (who.uid === uid) return (mode & 0o200) !== 0
  if (who.gids.includes(gid)) return (mode & 0o020) !== 0
  return false
}

function toEntry(dir: string, item: SshFileEntry, who?: RemoteIdentity): FileEntry {
  const name = item.filename
  const mode = item.attrs.mode ?? 0
  const uid = item.attrs.uid ?? -1
  const gid = item.attrs.gid ?? -1
  const names = splitLongname(item.longname)
  return {
    name,
    path: joinRemote(dir, name),
    isDir: item.attrs.isDirectory(),
    size: item.attrs.size,
    mtime: (item.attrs.mtime || 0) * 1000,
    mode,
    isSymlink: item.attrs.isSymbolicLink(),
    modeText: permText(mode),
    owner: names.owner || (uid >= 0 ? String(uid) : ''),
    group: names.group || (gid >= 0 ? String(gid) : ''),
    writable: canWrite(mode, uid, gid, who)
  }
}

export function listRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  who?: RemoteIdentity
): Promise<FileEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) return reject(new Error(translateSftpError(err, remotePath)))
      const entries = list.map((item) => toEntry(remotePath, item, who))
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-CN')
      })
      resolve(entries)
    })
  })
}

export function mkdirRemote(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => (err ? reject(new Error(translateSftpError(err, remotePath))) : resolve()))
  })
}

export function renameRemote(sftp: SFTPWrapper, oldPath: string, newPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (err) =>
      err ? reject(new Error(translateSftpError(err, oldPath))) : resolve()
    )
  })
}

/** 递归删除：SFTP 的 rmdir 只删空目录，所以自己往下走一层 */
export async function removeRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  isDir: boolean
): Promise<void> {
  if (!isDir) {
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(remotePath, (err) =>
        err ? reject(new Error(translateSftpError(err, remotePath))) : resolve()
      )
    })
    return
  }
  const children = await listRemote(sftp, remotePath)
  for (const child of children) {
    if (child.isDir && !child.isSymlink) {
      await removeRemote(sftp, child.path, true)
    } else {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(child.path, (err) =>
          err ? reject(new Error(translateSftpError(err, child.path))) : resolve()
        )
      })
    }
  }
  await new Promise<void>((resolve, reject) => {
    sftp.rmdir(remotePath, (err) =>
      err ? reject(new Error(translateSftpError(err, remotePath))) : resolve()
    )
  })
}

export function readRemoteFile(
  sftp: SFTPWrapper,
  remotePath: string,
  maxBytes = EDIT_MAX_BYTES
): Promise<DecodedText> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (statErr, stats) => {
      if (statErr) return reject(new Error(translateSftpError(statErr, remotePath)))
      if (stats.size > maxBytes) {
        return reject(new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB，不支持内置编辑器打开`))
      }
      sftp.readFile(remotePath, (err, data) => {
        if (err) return reject(new Error(translateSftpError(err, remotePath)))
        // Buffer 解码前就判编码与二进制：转成字符串之后 NUL 就变成 U+FFFD，什么都看不出来了
        try {
          resolve(decodeText(data))
        } catch (decodeErr) {
          reject(decodeErr instanceof Error ? decodeErr : new Error(String(decodeErr)))
        }
      })
    })
  })
}

/** 按原编码写回：UTF-16 的配置文件被改成 UTF-8，读它的服务就整份乱码了 */
export function writeRemoteFile(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string,
  encoding: TextEncoding = 'utf-8',
  bom = false
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, encodeText(content, encoding, bom), (err) =>
      err ? reject(new Error(translateSftpError(err, remotePath))) : resolve()
    )
  })
}

/* ---------------- 日志尾部只读 ---------------- */

function sftpOpenRead(sftp: SFTPWrapper, remotePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, 'r', (err, handle) => {
      if (err || !handle) {
        return reject(new Error(translateSftpError(err ?? new Error('无法打开文件'), remotePath)))
      }
      resolve(handle)
    })
  })
}

/**
 * 读 [start, start+length) 这一段。
 * 单次 `read` 返回的字节数可能少于请求（服务端分片返回），所以要循环读满；
 * 读到 0 字节说明文件比 stat 时短了（刚被轮转/截断），按实际读到的收工。
 */
async function sftpReadRange(
  sftp: SFTPWrapper,
  handle: Buffer,
  start: number,
  length: number
): Promise<Buffer> {
  const out = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const want = length - filled
    const got = await new Promise<number>((resolve, reject) => {
      sftp.read(handle, out, filled, want, start + filled, (err, bytesRead) => {
        if (err) return reject(err)
        resolve(bytesRead ?? 0)
      })
    })
    if (got <= 0) break
    filled += got
  }
  return filled === length ? out : out.subarray(0, filled)
}

/**
 * 只读远程文件末尾若干行 —— 日志在服务器上动辄几百 MB，
 * 整份读回来既慢又占内存，而运维要看的往往就是最后几十行。
 *
 * 不用 `createReadStream`：它的 end 是否含头含尾在实现里绕不清楚，
 * 用 `open` + 定位 `read` 反而最直白，也方便"不够就往前翻倍再读一次"。
 */
export async function readRemoteTail(
  sftp: SFTPWrapper,
  remotePath: string,
  lines?: number
): Promise<TailContent> {
  const stats = await new Promise<{ size: number }>((resolve, reject) => {
    sftp.stat(remotePath, (err, st) => {
      if (err) return reject(new Error(translateSftpError(err, remotePath)))
      resolve({ size: st.size })
    })
  })
  if (stats.size === 0) return emptyTail(0)

  const handle = await sftpOpenRead(sftp, remotePath)
  try {
    // 尾巴上没有 BOM，编码只能从文件头嗅
    const head = await sftpReadRange(sftp, handle, 0, Math.min(4, stats.size))
    const { encoding } = sniffEncoding(head)
    const slice = await collectTail(
      stats.size,
      clampLines(lines),
      (start, length) => sftpReadRange(sftp, handle, start, length),
      encoding
    )
    return { ...slice, size: stats.size, encoding }
  } finally {
    await new Promise<void>((resolve) => sftp.close(handle, () => resolve()))
  }
}

/* ---------------- 进度上报 ---------------- */

/** 上报节流间隔（毫秒）。10 次/秒肉眼已经连续，再密就是白烧 IPC。 */
const PROGRESS_INTERVAL = 100

interface ReporterInit {
  sessionId: string
  direction: 'upload' | 'download'
  filename: string
  /** 源 / 目标完整路径：一路带到界面，完成后直接写进传输记录 */
  from: string
  to: string
  /** 目录传输（记录里标出来，界面能显示「文件夹」而不是猜） */
  dir?: boolean
  /** 已知总字节数；未知先给 0，等 step 回调补 */
  total: number
  /** 目录传输时的文件总数 */
  fileCount?: number
}

interface Reporter {
  setTotal(total: number): void
  /** 设置绝对已传字节（单文件 step 回调给的就是累计值） */
  progress(transferred: number, total?: number): void
  /** 累加字节（目录传输按文件累加） */
  add(bytes: number): void
  /** 完成一个文件（目录传输用） */
  countFile(): void
  finish(error?: string): void
}

/**
 * 进度上报器。
 *
 * 直接转发 step 回调会出三个问题，这里一并解决：
 *   1. ssh2 每传一个 chunk（约 32KB）就回调一次，100MB 文件就是 3000+ 次 IPC，
 *      主进程和渲染进程都会被拖住 —— 按 100ms 节流。
 *   2. step 给的瞬时速度抖得没法看（网络本来就是脉冲式的），
 *      用两次上报之间的增量算速度再做指数平滑，读数才稳定 —— 而且平滑放在主进程做，
 *      渲染进程只管显示，避免两边各算一套导致数字对不上。
 *   3. 收尾时把 transferred 对齐到 total，否则进度条永远停在 99%。
 */
function createReporter(
  init: ReporterInit,
  onProgress: (p: TransferProgress) => void
): Reporter {
  const transferId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const startedAt = Date.now()

  let total = init.total
  let transferred = 0
  let fileDone = 0
  let speed = 0
  let sampleAt = startedAt
  let sampleBytes = 0
  let lastEmitAt = 0
  let closed = false

  function emit(done: boolean, error?: string, force = false): void {
    if (closed) return
    const now = Date.now()
    if (!done && !force && now - lastEmitAt < PROGRESS_INTERVAL) return
    lastEmitAt = now

    const dt = now - sampleAt
    if (dt > 0) {
      const instant = ((transferred - sampleBytes) / dt) * 1000
      // 首帧没有历史，直接采信；之后 0.65/0.35 平滑，既跟得上又不跳字
      speed = speed === 0 ? instant : speed * 0.65 + instant * 0.35
      sampleAt = now
      sampleBytes = transferred
    }

    onProgress({
      transferId,
      sessionId: init.sessionId,
      direction: init.direction,
      filename: init.filename,
      from: init.from,
      to: init.to,
      dir: init.dir,
      transferred,
      total,
      speed: Math.max(0, Math.round(speed)),
      elapsed: now - startedAt,
      fileCount: init.fileCount,
      fileDone: init.fileCount ? fileDone : undefined,
      done,
      error
    })
    if (done) closed = true
  }

  return {
    setTotal(next: number) {
      if (next > 0) total = next
    },
    progress(bytes: number, nextTotal?: number) {
      if (nextTotal && nextTotal > 0) total = nextTotal
      transferred = bytes
      emit(false)
    },
    add(bytes: number) {
      transferred += bytes
      emit(false)
    },
    countFile() {
      fileDone++
    },
    finish(error?: string) {
      // 成功时对齐到 total，进度条才会走满；失败保留实际值，别把进度清零
      if (!error && total > 0) transferred = total
      speed = error ? 0 : speed
      emit(true, error, true)
    }
  }
}

function statRemote(sftp: SFTPWrapper, remotePath: string): Promise<{ size: number }> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => (err ? reject(err) : resolve(stats)))
  })
}

export async function downloadRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  onProgress: (p: TransferProgress) => void,
  sessionId: string
): Promise<string> {
  fs.mkdirSync(path.dirname(localPath), { recursive: true })
  const filename = path.basename(remotePath)

  // 先 stat 一次：进度条第一帧就能显示总大小，而不是等第一个 chunk 到达
  let size = 0
  try {
    size = (await statRemote(sftp, remotePath)).size
  } catch {
    /* 拿不到就算了，step 回调里还有 total */
  }

  const reporter = createReporter(
    {
      sessionId,
      direction: 'download',
      filename,
      from: remotePath,
      to: localPath,
      total: size
    },
    onProgress
  )
  reporter.progress(0, size)

  await new Promise<void>((resolve, reject) => {
    sftp.fastGet(
      remotePath,
      localPath,
      {
        step: (transferred, _chunk, total) => reporter.progress(transferred, total)
      },
      (err) => {
        if (err) {
          const message = translateSftpError(err, remotePath)
          reporter.finish(message)
          reject(new Error(message))
          return
        }
        reporter.finish()
        resolve()
      }
    )
  })
  return localPath
}

export async function uploadLocal(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  onProgress: (p: TransferProgress) => void,
  sessionId: string
): Promise<string> {
  const filename = path.basename(localPath)

  let size = 0
  try {
    size = fs.statSync(localPath).size
  } catch {
    /* 文件在选完之后被删掉了，交给 fastPut 报错 */
  }

  const reporter = createReporter(
    {
      sessionId,
      direction: 'upload',
      filename,
      from: localPath,
      to: remotePath,
      total: size
    },
    onProgress
  )
  reporter.progress(0, size)

  await new Promise<void>((resolve, reject) => {
    sftp.fastPut(
      localPath,
      remotePath,
      {
        step: (transferred, _chunk, total) => reporter.progress(transferred, total)
      },
      (err) => {
        if (err) {
          const message = translateSftpError(err, remotePath)
          reporter.finish(message)
          reject(new Error(message))
          return
        }
        reporter.finish()
        resolve()
      }
    )
  })
  return remotePath
}

interface ScannedFile {
  remote: string
  /** 相对根目录的路径，用 / 分隔 */
  rel: string
  size: number
}

interface ScanAcc {
  files: ScannedFile[]
  totalBytes: number
  skipped: number
}

/** Windows 不允许的字符，出现就要替换，否则 mkdir/write 直接 EINVAL */
function sanitizeSegment(name: string): string {
  if (process.platform !== 'win32') return name
  let out = name.replace(/[\\/:*?"<>|]/g, '_')
  // 结尾的点和空格会被资源管理器悄悄吞掉
  out = out.replace(/[. ]+$/, '')
  // 设备保留名
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(out)) out = '_' + out
  return out || '_'
}

function toLocalPath(baseLocal: string, rel: string): string {
  const segments = rel.split('/').filter(Boolean).map(sanitizeSegment)
  return path.join(baseLocal, ...segments)
}

async function scanRemoteDir(
  sftp: SFTPWrapper,
  remoteDir: string,
  relBase: string,
  acc: ScanAcc,
  depth = 0
): Promise<void> {
  // 深度兜底：正常项目目录不会超过 24 层，超过基本是软链环
  if (depth > 24) {
    acc.skipped++
    return
  }
  let entries: FileEntry[]
  try {
    entries = await listRemote(sftp, remoteDir)
  } catch {
    // 单个子目录没权限就跳过，不要让整个任务失败
    acc.skipped++
    return
  }

  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name
    if (entry.isDir) {
      // 不跟随符号链接目录，否则 /proc 这类目录会无限递归
      if (entry.isSymlink) {
        acc.skipped++
        continue
      }
      await scanRemoteDir(sftp, entry.path, rel, acc, depth + 1)
    } else {
      acc.files.push({ remote: entry.path, rel, size: entry.size })
      acc.totalBytes += entry.size
    }
  }
}

/**
 * 目录递归下载。
 *
 * 分两趟：先完整扫描统计总字节数（进度条才有分母），再逐个 fastGet。
 * 单个文件失败不中断整体，收集到 failed 里最后统一报告 —— 大目录下载到
 * 第 300 个文件因为一个没权限的文件整体失败，体验太差。
 */
export async function downloadDirectory(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  onProgress: (p: TransferProgress) => void,
  sessionId: string
): Promise<DirDownloadResult> {
  const folderName = remotePath.replace(/\/+$/, '').split('/').pop() || 'download'

  const acc: ScanAcc = { files: [], totalBytes: 0, skipped: 0 }
  await scanRemoteDir(sftp, remotePath, '', acc)

  const reporter = createReporter(
    {
      sessionId,
      direction: 'download',
      filename: `${folderName}（${acc.files.length} 个文件）`,
      from: remotePath,
      to: localPath,
      dir: true,
      total: Math.max(acc.totalBytes, 1),
      fileCount: acc.files.length
    },
    onProgress
  )
  reporter.progress(0)

  fs.mkdirSync(localPath, { recursive: true })

  const failed: { path: string; message: string }[] = []
  let downloaded = 0

  for (const file of acc.files) {
    const target = toLocalPath(localPath, file.rel)
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(file.remote, target, (err) => (err ? reject(err) : resolve()))
      })
      downloaded++
    } catch (err) {
      failed.push({ path: file.remote, message: translateSftpError(err as Error, file.remote) })
    }
    // 失败的文件也要推进，否则进度条会卡住
    reporter.countFile()
    reporter.add(file.size)
  }

  reporter.finish(failed.length ? `${failed.length} 个文件下载失败` : undefined)

  return {
    total: acc.files.length,
    downloaded,
    failed,
    skipped: acc.skipped,
    bytes: acc.totalBytes
  }
}

/* ---------------- 目录上传 ---------------- */

interface LocalScanAcc {
  files: { src: string; rel: string; size: number }[]
  /** 所有子目录的相对路径。空目录没有文件，只能靠这份清单在远端补建 */
  dirs: string[]
  totalBytes: number
  skipped: number
}

function scanLocalDir(dir: string, relBase: string, acc: LocalScanAcc, depth = 0): void {
  if (depth > 24) {
    acc.skipped++
    return
  }
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    acc.skipped++
    return
  }
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name)
    const rel = relBase ? `${relBase}/${dirent.name}` : dirent.name

    let stat: fs.Stats
    try {
      // 跟随符号链接取大小；坏链直接跳过，不让整个上传失败
      stat = fs.statSync(full)
    } catch {
      acc.skipped++
      continue
    }

    if (stat.isDirectory()) {
      // 不跟随符号链接目录，否则指回上级的软链会让扫描原地打转
      if (dirent.isSymbolicLink()) {
        acc.skipped++
        continue
      }
      acc.dirs.push(rel)
      scanLocalDir(full, rel, acc, depth + 1)
    } else {
      acc.files.push({ src: full, rel, size: stat.size })
      acc.totalBytes += stat.size
    }
  }
}

/**
 * 逐级确保远程目录存在。
 * SFTP 的 mkdir 只建一层，且已存在时返回 code 4（和权限错误同一个码），
 * 所以先 stat 判断，再看情况 mkdir；created 缓存避免同一路径反复 stat。
 */
async function ensureRemoteDir(
  sftp: SFTPWrapper,
  dir: string,
  created: Set<string>
): Promise<void> {
  const segments = dir.split('/').filter(Boolean)
  let cursor = ''
  for (const segment of segments) {
    cursor += '/' + segment
    if (created.has(cursor)) continue
    try {
      await statRemote(sftp, cursor)
    } catch {
      try {
        await mkdirRemote(sftp, cursor)
      } catch {
        /* 并发下别人已经建好；真没权限的话后面的 fastPut 会报错 */
      }
    }
    created.add(cursor)
  }
}

/**
 * 目录递归上传 —— downloadDirectory 的反向操作。
 * 同样是两趟：先扫本地统计总字节（进度条要有分母），再逐个 fastPut。
 * 单个文件失败不中断，收进 failed 最后统一报告。
 */
export async function uploadDirectory(
  sftp: SFTPWrapper,
  localDir: string,
  remotePath: string,
  onProgress: (p: TransferProgress) => void,
  sessionId: string
): Promise<DirUploadResult> {
  const folderName = path.basename(localDir) || 'upload'
  const acc: LocalScanAcc = { files: [], dirs: [], totalBytes: 0, skipped: 0 }
  scanLocalDir(localDir, '', acc)

  const reporter = createReporter(
    {
      sessionId,
      direction: 'upload',
      filename: `${folderName}（${acc.files.length} 个文件）`,
      from: localDir,
      to: remotePath,
      dir: true,
      total: Math.max(acc.totalBytes, 1),
      fileCount: acc.files.length
    },
    onProgress
  )
  reporter.progress(0)

  const created = new Set<string>()
  const failed: { path: string; message: string }[] = []
  let uploaded = 0

  // 先把目标目录本身和所有子目录建出来：
  // 只靠 fastPut 前逐级 ensure 的话，空目录会被整个丢掉（本地有、远端没有），
  // 而且整个目录一个文件都没有时远端连根目录都不会建。
  try {
    await ensureRemoteDir(sftp, remotePath, created)
    for (const rel of acc.dirs) {
      await ensureRemoteDir(sftp, joinRemote(remotePath, rel), created)
    }
  } catch (err) {
    failed.push({ path: remotePath, message: translateSftpError(err as Error, remotePath) })
  }

  for (const file of acc.files) {
    const remoteFile = joinRemote(remotePath, file.rel)
    try {
      await ensureRemoteDir(sftp, path.posix.dirname(remoteFile), created)
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(file.src, remoteFile, (err) => (err ? reject(err) : resolve()))
      })
      uploaded++
    } catch (err) {
      failed.push({ path: file.src, message: translateSftpError(err as Error, remoteFile) })
    }
    // 失败的文件也推进，否则进度条会卡住
    reporter.countFile()
    reporter.add(file.size)
  }

  reporter.finish(failed.length ? `${failed.length} 个文件上传失败` : undefined)

  return {
    total: acc.files.length,
    uploaded,
    failed,
    skipped: acc.skipped,
    bytes: acc.totalBytes
  }
}

function translateSftpError(err: NodeJS.ErrnoException & { code?: number }, remotePath: string): string {
  const msg = err?.message ?? String(err)
  if (/No such file/i.test(msg)) return `路径不存在：${remotePath}`
  if (/Permission denied/i.test(msg)) return `权限不足：${remotePath}`
  if (/Failure/i.test(msg)) return `操作失败（可能是权限或路径问题）：${remotePath}`
  return msg
}

/* ---------------- 写权限探测 ---------------- */

/**
 * 把任意字符串塞进单引号里，唯一安全的转义方式：
 * 单引号内的字符串不做任何展开，遇到字面量 ' 就断开、转义、再接回去（'\''）。
 * 路径里带空格、$、`、; 都不会出问题。
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 远程文件当前登录用户能不能写 —— 决定「保存」按钮是否可用、编辑器是否只读。
 *
 * 为什么不让渲染层用 mode 位自己算：
 *   mode 只说明"属主/属组/其他人"各自的权限位，要判断当前用户还得知道 uid/gid、
 *   所属附加组，而且 root、ACL、只读挂载（有 w 位但 FS 是 ro）这几种例外全靠猜。
 *   直接让服务器自己回答 `test -w`，一次往返把所有情况覆盖掉，结论和真正写入时一致。
 *
 * 注意：`test -w` 只反映"此刻能不能写"，不排除保存瞬间被别人改了属主/挂载变 ro。
 * 所以写失败的分支仍要保留，不能拿这个探测结果当保险。
 */
export async function checkRemoteWritable(
  run: (command: string) => Promise<{ stdout: string; stderr: string; code: number }>,
  remotePath: string
): Promise<boolean> {
  // 不用 test 的退出码（ssh2 的 exit code 有时拿不到 0/1 之外的语义），
  // 直接把结果打到 stdout，肉眼可查也最好解析
  const res = await run(`test -w ${shellQuote(remotePath)} && echo WRITABLE || echo READONLY`)
  return res.stdout.trim().split('\n').pop() === 'WRITABLE'
}


/* ---------------- 二进制读取（办公文档预览用） ---------------- */

/** 预览上限：docx/xlsx 一般几百 KB，50MB 足够，再大传 base64 给渲染进程会把内存顶爆 */
export const MAX_PREVIEW_BYTES = 50 * 1024 * 1024

/**
 * 读远程文件原始字节，返回 base64。
 * 为什么不用 readRemoteFile：那个会做 UTF-8 解码 + 二进制拦截，
 * docx/xlsx 是 zip 包，解码即毁。
 */
export function readRemoteBinary(
  sftp: SFTPWrapper,
  remotePath: string,
  maxBytes = MAX_PREVIEW_BYTES
): Promise<{ base64: string; size: number }> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (statErr, stats) => {
      if (statErr) return reject(new Error(translateSftpError(statErr, remotePath)))
      if (stats.size > maxBytes) {
        return reject(
          new Error(`文件 ${Math.round(stats.size / 1024 / 1024)}MB，超过预览上限 ${Math.round(maxBytes / 1024 / 1024)}MB`)
        )
      }
      sftp.readFile(remotePath, (err, data) => {
        if (err) return reject(new Error(translateSftpError(err, remotePath)))
        resolve({ base64: data.toString('base64'), size: data.length })
      })
    })
  })
}
