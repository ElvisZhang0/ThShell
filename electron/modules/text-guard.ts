/**
 * 文本文件的兜底判断与编解码。
 *
 * 渲染层的扩展名白名单只是"值不值得点开"的快速筛选，挡不住真正的二进制：
 * 无扩展名的 core dump、名字叫 access.log 的压缩包、被写坏的配置文件。
 * 主进程已经拿到 Buffer 了，扫一次前 8KB 最省事 —— 二进制文件几乎必然出现 NUL。
 *
 * 但「有 NUL 字节」不等于二进制：**UTF-16 的 ASCII 字符每两个字节里就有一个 0x00**。
 * 于是 Windows 上的 .ini / .reg / .bat（记事本"Unicode"另存的结果）会被一句
 * "这不是文本文件"挡在门外 —— 用户看到的就是"ini 明明能编辑，为什么不让我编辑"。
 * 所以先看 BOM，再看 NUL。
 */

import type { TextEncoding, TextFileContent } from '../types'

/** 扫描前 8KB，出现 NUL 字节即视为二进制 */
export function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8192)
  for (let i = 0; i < end; i += 1) {
    if (buf[i] === 0) return true
  }
  return false
}

/**
 * 二进制文件统一用这句报错，渲染层直接弹给用户看。
 *
 * 别只说"这不是文本文件"：真有 无 BOM 的 UTF-16 / GBK 这类我们不解码的文本会被挡回来，
 * 那句话在用户眼里就是"明明能编辑，凭什么不让我编辑"。把可能性说出来。
 */
export const BINARY_FILE_MESSAGE =
  '这不是文本文件，或编码不受支持（如无 BOM 的 UTF-16），已阻止用内置编辑器打开'

export type { TextEncoding } from '../types'

/** 解码结果 = 界面要原样带回去的那三样东西（内容 / 编码 / 有没有 BOM） */
export type DecodedText = TextFileContent

/** utf-16be 用 utf16le 解出来是乱码，只能自己换字节序 */
function swap16(buf: Buffer): Buffer {
  const len = buf.length - (buf.length % 2)
  const out = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 2) {
    out[i] = buf[i + 1]
    out[i + 1] = buf[i]
  }
  return out
}

/**
 * 只看开头几个字节判断编码。
 *
 * 单独抽出来是给"只读日志尾部"用的：只读尾部时手上没有 BOM（它在文件第 0 字节），
 * 得先单独读文件头嗅一次，否则 UTF-16 的日志尾部会按 UTF-8 解成一片乱码。
 */
export function sniffEncoding(head: Buffer): { encoding: TextEncoding; bom: boolean } {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return { encoding: 'utf-8', bom: true }
  }
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', bom: true }
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', bom: true }
  return { encoding: 'utf-8', bom: false }
}

/**
 * 按编码解码一段字节，**不处理 BOM**（调用方已经确认这段里没有 BOM）。
 * 日志尾部的切片就走这里：那段字节是从文件中途截的，绝不会有 BOM。
 */
export function decodeBody(buf: Buffer, encoding: TextEncoding): string {
  if (encoding === 'utf-16le') return buf.toString('utf16le')
  if (encoding === 'utf-16be') return swap16(buf).toString('utf16le')
  return buf.toString('utf-8')
}

/**
 * Buffer → 字符串。能识别 UTF-8 BOM、UTF-16 LE/BE BOM；
 * 都不带 BOM 时按 UTF-8 读，读之前用 NUL 兜一层二进制。
 *
 * 不猜无 BOM 的 UTF-16：靠"奇偶位 NUL 多不多"猜，误判率不低（二进制里也有这种分布），
 * 而现实中不带 BOM 的 UTF-16 文本极少。真遇到就走系统默认程序。
 */
export function decodeText(buf: Buffer): DecodedText {
  const { encoding, bom } = sniffEncoding(buf)
  if (encoding === 'utf-16le') {
    // UTF-16 里成片的 0x00 是正常的，这里不能再做 NUL 判断
    return { content: buf.subarray(bom ? 2 : 0).toString('utf16le'), encoding, bom }
  }
  if (encoding === 'utf-16be') {
    return { content: swap16(buf.subarray(bom ? 2 : 0)).toString('utf16le'), encoding, bom }
  }
  const body = bom ? buf.subarray(3) : buf
  if (looksBinary(body)) throw new Error(BINARY_FILE_MESSAGE)
  return { content: body.toString('utf-8'), encoding, bom }
}

/** 字符串 → Buffer，按原文件的编码和 BOM 还原 */
export function encodeText(
  content: string,
  encoding: TextEncoding = 'utf-8',
  bom = false
): Buffer {
  if (encoding === 'utf-16le') {
    const body = Buffer.from(content, 'utf16le')
    return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body
  }
  if (encoding === 'utf-16be') {
    const body = swap16(Buffer.from(content, 'utf16le'))
    return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), body]) : body
  }
  const body = Buffer.from(content, 'utf-8')
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body
}

/** 界面上展示的编码名 */
export function encodingLabel(encoding: TextEncoding): string {
  return encoding === 'utf-16le' ? 'UTF-16 LE' : encoding === 'utf-16be' ? 'UTF-16 BE' : 'UTF-8'
}
