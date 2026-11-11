/**
 * 「只看日志末尾」的核心逻辑，本地和 SFTP 共用。
 *
 * 做法：从文件末尾往回读一个窗口（起始 64KB），不够就翻倍往前推，
 * 直到凑够要的行数或顶到 8MB 上限。所以文件多大都是毫秒级 ——
 * 这和编辑器"整份读进来"是两条路，别合并。
 *
 * 三个必须处理对的细节：
 * 1. **起始偏移落在字符中间**：窗口从文件中途切进来，开头那几个字节可能是半个汉字/半个 UTF-16 码元。
 *    所以只要不是从文件头开始，第一行一律丢掉（它本来也是半截）。
 * 2. **编码**：日志尾巴上没有 BOM（BOM 在文件第 0 字节），得先单独读文件头嗅一次。
 * 3. **二进制**：扩展名能骗人，`access.log` 里也可能是 gzip 或 core dump。
 *    切片的头 8KB 里出现 NUL 就拒绝 —— 但 UTF-16 除外（它每隔一个字节就是 0x00）。
 */

import { LOG_MAX_LINES, LOG_MAX_TAIL_BYTES, LOG_MIN_LINES, type TailContent } from '../types'
import { BINARY_FILE_MESSAGE, decodeBody, looksBinary, type TextEncoding } from './text-guard'

/** 第一次往回读多大。200 行 × 100 字节 ≈ 20KB，64KB 通常一次就够 */
const FIRST_WINDOW = 64 * 1024

/** 把用户给的行数夹到 [50, 5000]：过小没意义，过大等于整份读进来 */
export function clampLines(n: number | undefined): number {
  if (!Number.isFinite(n)) return 200
  return Math.min(LOG_MAX_LINES, Math.max(LOG_MIN_LINES, Math.floor(n as number)))
}

/**
 * 把一段"从文件中途开始"的字节切成行。
 * @param start 切片在文件里的起始偏移；0 表示从文件头读的，第一行是完整的
 */
export function sliceLines(buf: Buffer, start: number, encoding: TextEncoding): string[] {
  const text = decodeBody(buf, encoding)
  const rows = text.split('\n')
  // 从中间切进来的第一行是半截，丢掉；文件末尾的空串（以换行结尾）也去掉，纯粹为了计数准确
  if (start > 0 && rows.length) rows.shift()
  if (rows.length && rows[rows.length - 1] === '') rows.pop()
  return rows
}

export interface TailSlice {
  content: string
  lines: number
  truncated: boolean
}

/**
 * 从文件末尾往回凑够 want 行。
 * @param size  文件字节数（stat 拿到的；读的过程中文件变长也不管，只读到这个位置）
 * @param read  读 [start, start+length) 的原始字节
 * @param encoding 文件编码（调用方先嗅了文件头才知道）
 */
export async function collectTail(
  size: number,
  want: number,
  read: (start: number, length: number) => Promise<Buffer>,
  encoding: TextEncoding
): Promise<TailSlice> {
  const fromHead = size <= 0
  if (fromHead) return { content: '', lines: 0, truncated: false }

  let window = Math.min(size, FIRST_WINDOW)
  // UTF-16 的窗口起点必须落在偶数偏移上，否则第一行会从码元中间断开、后面整体错位
  const align = (n: number) => (encoding === 'utf-8' ? n : n - (n % 2))

  for (;;) {
    const start = align(size - window)
    const buf = await read(start, size - start)

    // 二进制护栏：UTF-16 里成片的 0x00 是正常的，不能套这条规则
    if (encoding === 'utf-8' && looksBinary(buf)) throw new Error(BINARY_FILE_MESSAGE)

    const rows = sliceLines(buf, start, encoding)
    const exactHead = start === 0
    if (rows.length >= want || exactHead || window >= LOG_MAX_TAIL_BYTES || window >= size) {
      const picked = rows.length > want ? rows.slice(-want) : rows
      return {
        content: picked.join('\n'),
        lines: picked.length,
        // 没读到文件头 = 前面还有内容；或者窗口里行数本来就超过要的
        truncated: !exactHead || rows.length > want
      }
    }
    // 行数不够且前面还有：窗口翻倍，继续往前推
    window = Math.min(size, window * 2)
  }
}

/** 空文件的返回值，两条链路共用 */
export function emptyTail(size = 0, encoding: TextEncoding = 'utf-8'): TailContent {
  return { content: '', lines: 0, size, truncated: false, encoding }
}

export type { TailContent }
