import fs from 'node:fs'
import path from 'node:path'
import type { SshManager } from './ssh-manager'
import type { PasteMode, PasteResult } from '../types'

/** 统一成一句话给人看，别把 ENOTEMPTY/EACCES 这种原始码甩到界面上 */
function humanize(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  const code = e?.code
  if (code === 'EACCES' || code === 'EPERM') return '权限不足'
  if (code === 'ENOENT') return '源或目标不存在'
  if (code === 'EBUSY') return '文件被占用'
  if (code === 'ENOSPC') return '磁盘空间不足'
  if (code === 'EEXIST') return '目标已存在'
  return e?.message ?? String(err)
}

function targetOf(srcPath: string, destDir: string): string {
  return path.join(destDir, path.basename(srcPath))
}

/* ---------------- 本地 ---------------- */

export function copyLocal(srcPaths: string[], destDir: string): PasteResult {
  const failed: { path: string; message: string }[] = []
  let done = 0

  for (const src of srcPaths) {
    const target = targetOf(src, destDir)
    try {
      if (path.resolve(target) === path.resolve(src)) throw new Error('源和目标是同一个位置')
      // force 覆盖同名文件；目标是已存在的目录时按内容合并，和资源管理器的行为一致
      fs.cpSync(src, target, {
        recursive: true,
        force: true,
        errorOnExist: false,
        preserveTimestamps: true
      })
      done++
    } catch (err) {
      failed.push({ path: src, message: humanize(err) })
    }
  }
  return { done, failed }
}

export async function moveLocal(srcPaths: string[], destDir: string): Promise<PasteResult> {
  const failed: { path: string; message: string }[] = []
  let done = 0

  for (const src of srcPaths) {
    const target = targetOf(src, destDir)
    try {
      if (path.resolve(target) === path.resolve(src)) throw new Error('源和目标是同一个位置')
      // rename 不能覆盖已存在的目标：Windows 直接 EPERM，Linux 对非空目录报 ENOTEMPTY。
      // 覆盖同名项在界面层已经确认过，这里先清掉旧目标再搬。
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
      try {
        fs.renameSync(src, target)
      } catch (err) {
        // 跨盘剪切 rename 会抛 EXDEV，只能退化成「复制 + 删除源」
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
        fs.cpSync(src, target, { recursive: true, force: true, preserveTimestamps: true })
        fs.rmSync(src, { recursive: true, force: true })
      }
      done++
    } catch (err) {
      failed.push({ path: src, message: humanize(err) })
    }
  }
  return { done, failed }
}

/* ---------------- 远程 ---------------- */

/** 远程路径要按 shell 规则包一层单引号，路径里有空格或 $ 才不会被打断 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 远程复制/移动走服务端的 cp / mv，而不是「下载再上传」。
 * 两个关键点：
 *   1. 必须带 -T（--no-target-directory）。不带的话，目标目录已存在时
 *      `cp -r /a/b /dest/b` 会变成 /dest/b/b 这种多套一层的经典坑。
 *   2. 逐个文件一条命令，而不是拼成一长串 && —— 这样才能把失败定位到具体文件。
 */
async function remotePasteOne(
  ssh: SshManager,
  sessionId: string,
  src: string,
  destDir: string,
  mode: PasteMode
): Promise<void> {
  const target = path.posix.join(destDir, path.posix.basename(src))
  if (target === src) throw new Error('源和目标是同一个位置')

  const verb = mode === 'cut' ? 'mv' : 'cp'
  // -a 保留权限/时间戳，-T 见上，-- 防止路径以 - 开头被当成参数
  const args = mode === 'cut' ? `-T --` : `-aT --`
  const command = `${verb} ${args} ${shellQuote(src)} ${shellQuote(target)}`
  const result = await ssh.exec(sessionId, command)
  if (result.code !== 0) {
    const message = (result.stderr || result.stdout || '').trim().split('\n').pop() || '操作失败'
    throw new Error(message)
  }
}

export async function pasteRemote(
  ssh: SshManager,
  sessionId: string,
  srcPaths: string[],
  destDir: string,
  mode: PasteMode
): Promise<PasteResult> {
  const failed: { path: string; message: string }[] = []
  let done = 0
  for (const src of srcPaths) {
    try {
      await remotePasteOne(ssh, sessionId, src, destDir, mode)
      done++
    } catch (err) {
      failed.push({ path: src, message: humanize(err) })
    }
  }
  return { done, failed }
}
