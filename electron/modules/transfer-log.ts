/**
 * 传输记录的落盘读写。
 *
 * 为什么不塞进 config.json：
 *   配置是"用户设置"，几百条历史记录混在里边，配置文件的读写频率、体积、
 *   甚至 future 的迁移逻辑都会被拖着走。记录会一直增长，配置基本不变 ——
 *   两件事分开存，各自简单。
 *
 * 为什么在主进程记而不是渲染层记：
 *   渲染层拿到的只是进度事件，路径来自主进程；而且窗口关掉 / 页面刷新时
 *   渲染层的记账会丢。main 里 emitProgress 是唯一的收口，成功失败都在那儿过。
 *
 * 写法和配置文件一致：先写 .tmp 再 rename，中途断电不会留下半截 JSON。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { TRANSFER_LOG_MAX, type TransferRecord } from '../types'

let cache: TransferRecord[] | null = null

function file(): string {
  return path.join(app.getPath('userData'), 'transfers.json')
}

/** 读出全部记录（新的在前）。文件坏了就当空的，不要因为历史记录挡住启动 */
export function loadTransferLog(): TransferRecord[] {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(file(), 'utf-8')
    const parsed = JSON.parse(raw)
    cache = Array.isArray(parsed) ? parsed.filter(isRecord) : []
  } catch {
    cache = []
  }
  return cache
}

function isRecord(v: unknown): v is TransferRecord {
  const r = v as TransferRecord
  return !!r && typeof r.id === 'string' && typeof r.from === 'string' && typeof r.to === 'string'
}

/** 追加一条（新的在前），超过上限丢最旧的 */
export function appendTransfer(rec: TransferRecord): TransferRecord[] {
  const list = loadTransferLog()
  // 同 id 覆盖：极端情况下主进程会把 done 事件发两次（比如先失败后补发完成）
  const idx = list.findIndex((r) => r.id === rec.id)
  if (idx >= 0) list.splice(idx, 1)
  list.unshift(rec)
  if (list.length > TRANSFER_LOG_MAX) list.length = TRANSFER_LOG_MAX
  write(list)
  return list
}

export function clearTransferLog(): TransferRecord[] {
  cache = []
  write(cache)
  return cache
}

/**
 * 按 id 删几条。只有冒烟模式用：截图前塞几条假记录，截完按 id 清掉，
 * 不能碰用户真实的记录（那是 `clear` 的活儿，清完就找不回来了）。
 */
export function removeTransfer(ids: string[]): TransferRecord[] {
  const set = new Set(ids)
  const list = loadTransferLog().filter((r) => !set.has(r.id))
  write(list)
  return list
}

function write(list: TransferRecord[]): void {
  cache = list
  const target = file()
  const tmp = `${target}.tmp`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8')
    fs.renameSync(tmp, target)
  } catch (err) {
    // 记录写不进去不该影响传输本身，吞掉但留个日志
    console.warn('[transfer-log] 写入失败', err)
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 临时文件清不掉就算了 */
    }
  }
}
