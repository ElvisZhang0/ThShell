/**
 * 传输相关的显示格式化。
 *
 * 为什么单独抽出来：同一套数字要在两处显示 —— 文件页里的实时进度条、
 * 窗口底部的传输记录。两边各写一份 formatSize 迟早会算出两个不一样的值
 * （一个写 "1.0 GB" 一个写 "1 GB"），用户会以为是 bug。
 */
import type { TransferProgress } from '../../electron/types'

/** dashOnZero=false 时 0 字节显示成 "0 B"（传输进度用），否则显示 "—"（列表用） */
export function formatSize(bytes: number, dashOnZero = true): string {
  if (!bytes) return dashOnZero ? '—' : '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || !Number.isFinite(bytesPerSec)) return '—'
  return `${formatSize(bytesPerSec, false)}/s`
}

/** 剩余时间，按当前速度估算；速度未知或已传完时返回空串 */
export function formatEta(item: TransferProgress): string {
  if (item.done || !item.speed || !item.total) return ''
  const left = item.total - item.transferred
  if (left <= 0) return ''
  const sec = Math.ceil(left / item.speed)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`
}

export function percentOf(item: TransferProgress): number {
  if (!item.total) return 0
  const raw = (item.transferred / item.total) * 100
  // 传输中最多显示 99，走满 100 只留到 done，否则大文件会长时间挂着 100% 却没结束
  return Math.min(item.done ? 100 : 99, Math.floor(raw))
}

export function transferState(item: TransferProgress): string {
  if (item.error) return '失败'
  if (item.done) return item.canceled ? '已取消' : '完成'
  // 暂停优先于文件计数：暂停时最该让人看到的是"停着呢"，不是"3/120"
  if (item.paused) return '已暂停'
  if (item.fileCount) return `${item.fileDone ?? 0}/${item.fileCount}`
  return '传输中'
}

/**
 * 记录里的时间：今天只写时刻，昨天写「昨天」，更早写日期。
 * 传输记录绝大多数是刚发生的，全写成 "2026-11-10 11:20" 反而看不出"刚才/前天"。
 */
export function formatWhen(at: number): string {
  if (!at) return '—'
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  if (sameDay(d, now)) return hm
  const yesterday = new Date(now.getTime() - 86400_000)
  if (sameDay(d, yesterday)) return `昨天 ${hm}`
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`
}

/** 耗时：小于 1 分钟给整秒，再长给 m/s，超过 1 小时给 h/m */
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec} 秒`
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
  return `${Math.floor(sec / 3600)} 时 ${Math.floor((sec % 3600) / 60)} 分`
}

/** 路径中间省略：长路径保留头尾（/home/dump/…/2026-11-09.sql），比尾部截断有用 */
export function middleEllipsis(text: string, max = 64): string {
  if (text.length <= max) return text
  const keep = Math.floor((max - 1) / 2)
  return `${text.slice(0, keep)}…${text.slice(-keep)}`
}
