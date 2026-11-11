import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, shell } from 'electron'
import type { FileEntry, Place, TailContent } from '../types'
import { EDIT_MAX_BYTES } from '../types'
import { decodeText, encodeText, sniffEncoding, type DecodedText, type TextEncoding } from './text-guard'
import { clampLines, collectTail, emptyTail } from './log-tail'

/** 内置编辑器能打开的上限，和渲染层共用 electron/types.ts 里的 EDIT_MAX_BYTES */

export function localHome(): string {
  return os.homedir()
}

/**
 * 侧栏「跳转」菜单的内容：常用位置 + 所有盘符。
 * 路径都在主进程算，渲染层不用管 Windows / macOS 的差异。
 */
export function localPlaces(): Place[] {
  const places: Place[] = []
  const push = (label: string, key: 'home' | 'desktop' | 'downloads' | 'documents') => {
    try {
      const dir = app.getPath(key)
      // 有些系统上「下载」「文档」并不存在，别给用户一个点了就报错的入口
      if (dir && fs.existsSync(dir)) places.push({ label, path: dir, kind: 'place' })
    } catch {
      /* 取不到就跳过这一类 */
    }
  }
  push('主目录', 'home')
  push('桌面', 'desktop')
  push('下载', 'downloads')
  push('文档', 'documents')

  for (const drive of localDrives()) {
    places.push({ label: drive, path: drive, kind: 'drive' })
  }
  return places
}

export function listLocal(dirPath: string): FileEntry[] {
  const dirents = fs.readdirSync(dirPath, { withFileTypes: true })
  const entries: FileEntry[] = []
  for (const dirent of dirents) {
    const full = path.join(dirPath, dirent.name)
    let size = 0
    let mtime = 0
    try {
      const stat = fs.statSync(full)
      size = stat.size
      mtime = stat.mtimeMs
    } catch {
      // 无权限或断开的符号链接，跳过 stat，但仍显示出来
    }
    entries.push({
      name: dirent.name,
      path: full,
      isDir: dirent.isDirectory(),
      size,
      mtime,
      mode: 0,
      isSymlink: dirent.isSymbolicLink()
    })
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return entries
}

export function localDrives(): string[] {
  if (process.platform !== 'win32') return ['/']
  const drives: string[] = []
  for (let i = 67; i <= 90; i++) {
    const letter = String.fromCharCode(i) + ':\\'
    try {
      if (fs.existsSync(letter)) drives.push(letter)
    } catch {
      /* 光驱未就绪等情况忽略 */
    }
  }
  return drives
}

export function mkdirLocal(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: false })
}

export function renameLocal(oldPath: string, newPath: string): void {
  fs.renameSync(oldPath, newPath)
}

/**
 * 本地删除走系统回收站（shell.trashItem），
 * 万一误删还能捞回来 —— 不做 permanently delete。
 */
export async function removeLocal(targetPath: string): Promise<void> {
  await shell.trashItem(targetPath)
}

export function readLocalFile(filePath: string): DecodedText {
  const stat = fs.statSync(filePath)
  if (stat.size > EDIT_MAX_BYTES) {
    throw new Error(`文件超过 ${Math.round(EDIT_MAX_BYTES / 1024 / 1024)}MB，不支持内置编辑器打开`)
  }
  // 先自己读 Buffer 再解码：`readFileSync(p, 'utf-8')` 拿到的是已经被替换成 U+FFFD 的字符串，
  // 到那时再想判断"原来是不是二进制 / 是不是 UTF-16"就晚了。
  return decodeText(fs.readFileSync(filePath))
}

/**
 * 按原编码写回。
 * 不无脑写 UTF-8：UTF-16 的 .ini 被改成 UTF-8 之后，读它的老程序会整份当乱码。
 * 编码和 BOM 由 readLocalFile 一起返回，界面原样带回来。
 */
export function writeLocalFile(
  filePath: string,
  content: string,
  encoding: TextEncoding = 'utf-8',
  bom = false
): void {
  fs.writeFileSync(filePath, encodeText(content, encoding, bom))
}

/**
 * 只读文件末尾若干行（日志查看）。
 *
 * 走 fd + 定位读，不整份读进来：几百 MB 的日志在这里也只是读几十 KB。
 * 编码先单独读文件头 4 字节嗅一次 —— 尾巴上没有 BOM，不嗅就会把 UTF-16 的日志解成乱码。
 */
export async function readLocalTail(filePath: string, lines?: number): Promise<TailContent> {
  const stat = fs.statSync(filePath)
  const size = stat.size
  if (size === 0) return emptyTail(0)

  const want = clampLines(lines)
  const fd = fs.openSync(filePath, 'r')
  try {
    const head = Buffer.allocUnsafe(Math.min(4, size))
    fs.readSync(fd, head, 0, head.length, 0)
    const { encoding } = sniffEncoding(head)

    const slice = await collectTail(
      size,
      want,
      async (start, length) => {
        const buf = Buffer.allocUnsafe(length)
        fs.readSync(fd, buf, 0, length, start)
        return buf
      },
      encoding
    )
    return { ...slice, size, encoding }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 本地文件当前用户能不能写 —— 用来决定「保存」按钮是否可用、编辑器是否只读。
 *
 * 为什么不用 stat 的 mode 位：
 *   - Windows 上 mode 位几乎没意义（NTFS ACL 不体现在这里），靠 (mode & 0o200) 判断会误判；
 *   - fs.access(W_OK) 走的是 libuv 的真实检查：Windows 下会看只读属性 + ACL，
 *     Linux/macOS 下等价于 access(2)。
 * 代价是它"探测即结论"，不保证写入时不会因为竞态失败 —— 所以保存失败仍要兜底报错。
 */
export function isLocalWritable(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function openLocalPath(targetPath: string): Promise<void> {
  const err = await shell.openPath(targetPath)
  if (err) throw new Error(err)
}

/** 读本地文件原始字节，返回 base64（办公文档预览用；不能用 readLocalFile，它会拦二进制） */
export function readLocalBinary(
  filePath: string,
  maxBytes = 50 * 1024 * 1024
): { base64: string; size: number } {
  const stat = fs.statSync(filePath)
  if (stat.size > maxBytes) {
    throw new Error(
      `文件 ${Math.round(stat.size / 1024 / 1024)}MB，超过预览上限 ${Math.round(maxBytes / 1024 / 1024)}MB`
    )
  }
  const buf = fs.readFileSync(filePath)
  return { base64: buf.toString('base64'), size: buf.length }
}
