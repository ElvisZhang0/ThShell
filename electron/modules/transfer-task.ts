/**
 * 单个文件/目录传输的控制内核：暂停、继续、取消，以及**断点续传**。
 *
 * 为什么原来没有这些按钮 —— 结构上就没法有：
 *   传输是靠 `sftp.fastGet` / `fastPut` 一次调用跑完全程的，那是"一发不可收"的整包调用：
 *   它不返回任何句柄，中途想停只能把整条 SFTP 会话 destroy 掉 ——
 *   代价是同一个会话上的文件列表、其他传输、正在编辑的文本全部一起断。
 *   所以不是"忘了做"，是那条路根本长不出暂停键。
 *
 * 换成流以后三个动作都变得很自然：
 *   - 暂停 = `readStream.pause()`（数据不再流动，握手和句柄都还在）
 *   - 继续 = `readStream.resume()`
 *   - 取消 = `destroy()` 两个流，管道随即以错误结束，我们把它翻译成"已取消"
 *
 * 断点续传靠一个旁路文件：下载写 `<目标>.part`、上传写 `<远端>.part`，完成才改名到位。
 * 好处有两个 —— 传输中的半成品不会顶着正式文件名被人当成完整文件，
 * 而且**中断以后重来一次会自动从 .part 的末尾接着传**（不需要额外的状态文件，
 * 文件大小本身就是断点）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper } from 'ssh2'

/** 分块大小。ssh2 内部也是 32KB 一包，给到 64KB 少一轮往返 */
const CHUNK = 64 * 1024

/** 取消用异常表达：它要穿透 pipeline 的 Promise 链，又不能和真实 IO 错误混为一谈 */
export class TransferCanceled extends Error {
  constructor() {
    super('已取消')
    this.name = 'TransferCanceled'
  }
}

interface Stream {
  pause(): void
  resume(): void
  destroy(err?: Error): void
}

/**
 * 一次传输的控制面板。
 *
 * 为什么状态放在这儿而不是界面里：界面只负责点按钮，真正的"停/走"必须发生在
 * 数据流动的那一侧 —— 主进程。界面的状态是主进程推回去的，两边各存一份迟早对不上。
 */
export class TransferControl {
  readonly id: string
  private state: 'running' | 'paused' | 'canceled' = 'running'
  private src: Stream | null = null
  private sink: Stream | null = null
  private onChange: (() => void) | null = null
  /** 目录传输是按文件串行跑的，"暂停"要能挂住那个 for 循环 */
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = []

  constructor(id: string, onChange?: () => void) {
    this.id = id
    this.onChange = onChange ?? null
  }

  get paused(): boolean {
    return this.state === 'paused'
  }

  get canceled(): boolean {
    return this.state === 'canceled'
  }

  /** 每传一个文件都会换一对新的流，状态（暂停/取消）要延续下去 */
  attach(src: Stream, sink: Stream): void {
    this.src = src
    this.sink = sink
    // 点暂停时可能还没开始传（界面比主进程快一步），补一次
    if (this.state === 'paused') src.pause()
    if (this.state === 'canceled') src.destroy(new TransferCanceled())
  }

  detach(): void {
    this.src = null
    this.sink = null
  }

  pause(): void {
    if (this.state !== 'running') return
    this.state = 'paused'
    this.src?.pause()
    this.onChange?.()
  }

  resume(): void {
    if (this.state !== 'paused') return
    this.state = 'running'
    this.src?.resume()
    // 目录传输里正挂在 gate 上的那个循环也要放行
    const ws = this.waiters
    this.waiters = []
    for (const w of ws) w.resolve()
    this.onChange?.()
  }

  cancel(): void {
    if (this.state === 'canceled') return
    this.state = 'canceled'
    // 先通知界面（让按钮立刻变灰），再拆管道
    this.onChange?.()
    const ws = this.waiters
    this.waiters = []
    for (const w of ws) w.reject(new TransferCanceled())
    this.src?.destroy(new TransferCanceled())
    this.sink?.destroy(new TransferCanceled())
  }

  /**
   * 目录传输的 for 循环里用：暂停时把循环挂住，恢复时继续，取消时抛出去。
   * 没有这一步，点暂停只会停住"当前这个文件"，后面的文件照样一个个往下排。
   */
  gate(): Promise<void> {
    if (this.state === 'canceled') return Promise.reject(new TransferCanceled())
    if (this.state === 'running') return Promise.resolve()
    return new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }))
  }
}

/* ------------------------------------------------------------ 任务注册表 */

/**
 * transferId → 控制对象。
 *
 * 界面点"暂停"时只知道 transferId（那是从进度事件里拿到的），
 * 所以主进程必须留一份索引，否则收到 id 也不知道该停谁。
 */
const tasks = new Map<string, TransferControl>()

export function registerTask(ctl: TransferControl): void {
  tasks.set(ctl.id, ctl)
}

export function unregisterTask(id: string): void {
  tasks.delete(id)
}

export function pauseTask(id: string): boolean {
  const t = tasks.get(id)
  if (!t || t.canceled) return false
  t.pause()
  return true
}

export function resumeTask(id: string): boolean {
  const t = tasks.get(id)
  if (!t) return false
  t.resume()
  return true
}

export function cancelTask(id: string): boolean {
  const t = tasks.get(id)
  if (!t) return false
  t.cancel()
  return true
}

/** 冒烟用：看清当前还挂着几个任务，确认没有泄漏 */
export function activeTaskIds(): string[] {
  return [...tasks.keys()]
}

/* -------------------------------------------------------------- 传一个文件 */

export interface PipeFileOptions {
  sftp: SFTPWrapper
  direction: 'upload' | 'download'
  /** 下载是远端路径，上传是本地路径 */
  from: string
  /** 下载是本地路径，上传是远端路径 */
  to: string
  /** 源的字节数。为 0 表示未知（此时不做续传，老老实实从头传） */
  total: number
  ctl: TransferControl
  /** 每传一块回调一次，用来累计进度 */
  onBytes: (n: number) => void
  /**
   * 确定断点后回调一次（从 .part 的末尾接着传时 start 大于 0）。
   * 界面要靠它把"已传字节"和进度条直接摆到断点位置 ——
   * 否则续传的头几百毫秒会显示 0%，看着像在重传。
   */
  onResume?: (start: number) => void
}

function statRemoteSize(sftp: SFTPWrapper, remotePath: string): Promise<number> {
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err, stats) => resolve(err ? -1 : stats.size))
  })
}

function renameRemote(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 目标已存在时 SFTP 的 rename 会失败（不同实现不一样），先删掉更稳
    sftp.unlink(to, () => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    })
  })
}

/**
 * 传一个文件，支持从 `.part` 的末尾接着传。
 *
 * 返回实际传了多少字节（续传时只算本次新增的部分）。
 * 被取消时抛 TransferCanceled —— 调用方据此决定是记一条"已取消"还是"失败"。
 */
export async function pipeFile(opts: PipeFileOptions): Promise<number> {
  const { sftp, direction, from, to, total, ctl, onBytes, onResume } = opts

  // 半成品就写在目标旁边：叫 xxx.part，谁看一眼都知道这不是完整文件
  const part = `${to}.part`

  // 断点 = .part 的大小。文件本身就是状态，不需要额外的元数据
  let start = 0
  if (total > 0) {
    start =
      direction === 'download'
        ? fs.existsSync(part)
          ? fs.statSync(part).size
          : 0
        : await statRemoteSize(sftp, part)
    if (start < 0) start = 0
    // 源变了（变小了）就别硬接，从头来更安全
    if (start > total) start = 0
  }

  if (start >= total && total > 0) {
    // 上次其实已经传完了，只是没来得及改名（比如改名时断电）
    await finish(direction, sftp, part, to)
    return 0
  }

  if (start > 0) onResume?.(start)

  if (direction === 'download') fs.mkdirSync(path.dirname(to), { recursive: true })

  const src = (
    direction === 'download'
      ? sftp.createReadStream(from, { start, highWaterMark: CHUNK })
      : fs.createReadStream(from, { start, highWaterMark: CHUNK })
  ) as unknown as Readable

  const sink = (
    direction === 'download'
      ? fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' })
      : sftp.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' })
  ) as unknown as Stream

  let moved = 0
  // 计数挂在源流上：两个方向的源都是"读"，逻辑对称，也不用关心谁慢谁快
  src.on('data', (chunk: Buffer) => {
    moved += chunk.length
    onBytes(chunk.length)
  })

  ctl.attach(src as unknown as Stream, sink)
  try {
    await pipeline(src, sink)
  } catch (err) {
    // 取消走的是 destroy(TransferCanceled)，pipeline 会把它包在 cause 里
    const reason = err as Error & { cause?: unknown }
    const canceled =
      ctl.canceled ||
      reason instanceof TransferCanceled ||
      reason.cause instanceof TransferCanceled
    if (canceled) throw new TransferCanceled()
    throw err
  } finally {
    ctl.detach()
  }

  await finish(direction, sftp, part, to)
  return moved
}

/** 收尾：把 .part 改名成正式文件名；并保证父目录存在 */
async function finish(
  direction: 'upload' | 'download',
  sftp: SFTPWrapper,
  part: string,
  to: string
): Promise<void> {
  if (direction === 'download') {
    fs.renameSync(part, to)
  } else {
    await renameRemote(sftp, part, to)
  }
}

/** 取消 / 失败后清掉半成品：留着会让人以为"下次能续"，其实数据是断的 */
export async function dropPart(
  direction: 'upload' | 'download',
  sftp: SFTPWrapper,
  to: string
): Promise<void> {
  const part = `${to}.part`
  try {
    if (direction === 'download') {
      fs.rmSync(part, { force: true })
    } else {
      await new Promise<void>((resolve) => sftp.unlink(part, () => resolve()))
    }
  } catch {
    /* 清不掉就算了，别覆盖掉真正的错误 */
  }
}
