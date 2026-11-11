import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'
import type { ExecResult, RemoteIdentity, ServerConfig, SessionState } from '../types'

interface Session {
  id: string
  config: ServerConfig
  client: Client
  shell?: ClientChannel
  sftpPromise?: Promise<SFTPWrapper>
  /** `id -u; id -G` 的结果，只问一次 */
  identityPromise?: Promise<RemoteIdentity | undefined>
  decoder: StringDecoder
  /** 断线后自动重连的标记，避免手动关闭时误触发 */
  intentionalClose: boolean
}

type DataHandler = (payload: { sessionId: string; data: string }) => void
type StateHandler = (payload: SessionState) => void

/**
 * SSH 连接池。
 *
 * 一个 session = 一条 SSH 连接 + 一个交互式 shell + 一个 SFTP 通道。
 * 主进程持有所有连接，渲染进程只拿 sessionId，避免密码/密钥泄漏到页面里。
 */
export class SshManager {
  private sessions = new Map<string, Session>()

  constructor(
    private onData: DataHandler,
    private onState: StateHandler
  ) {}

  listSessions(): string[] {
    return [...this.sessions.keys()]
  }

  getSessionConfig(sessionId: string): ServerConfig | undefined {
    return this.sessions.get(sessionId)?.config
  }

  async connect(config: ServerConfig, cols = 100, rows = 30): Promise<string> {
    const sessionId = randomUUID()
    const client = new Client()
    this.onState({ sessionId, serverId: config.id, status: 'connecting' })

    const connectOptions = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      password: config.authType === 'password' ? config.password : undefined,
      privateKey: config.authType === 'key' ? config.privateKey : undefined,
      passphrase: config.authType === 'key' ? config.passphrase : undefined,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      // 老服务器（CentOS 6 / 老旧交换机）经常只用 ssh-rsa，ssh2 v1 默认已禁用，
      // 这里显式放开常见 legacy 算法，现代服务器不受影响。
      algorithms: {
        serverHostKey: [
          'ssh-ed25519',
          'ecdsa-sha2-nistp256',
          'rsa-sha2-512',
          'rsa-sha2-256',
          'ssh-rsa'
        ]
      }
    }

    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        client.removeListener('error', onError)
        resolve()
      }
      const onError = (err: Error) => {
        client.removeListener('ready', onReady)
        reject(err)
      }
      client.once('ready', onReady)
      client.once('error', onError)
      try {
        client.connect(connectOptions)
      } catch (err) {
        reject(err as Error)
      }
    }).catch((err: Error) => {
      client.end()
      this.onState({
        sessionId,
        serverId: config.id,
        status: 'error',
        message: humanizeSshError(err)
      })
      throw new Error(humanizeSshError(err))
    })

    const session: Session = {
      id: sessionId,
      config,
      client,
      decoder: new StringDecoder('utf8'),
      intentionalClose: false
    }
    this.sessions.set(sessionId, session)
    this.onState({ sessionId, serverId: config.id, status: 'connected' })

    // 交互式 shell：xterm-256color 才能正确显示颜色和光标控制序列
    const shell = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) return reject(err)
        resolve(stream)
      })
    }).catch((err: Error) => {
      client.end()
      this.sessions.delete(sessionId)
      this.onState({
        sessionId,
        serverId: config.id,
        status: 'error',
        message: '打开终端失败：' + err.message
      })
      throw err
    })

    session.shell = shell
    shell.on('data', (chunk: Buffer) => {
      // 多字节中文/emoji 会被 TCP 分片切断，必须交给 StringDecoder 缓冲
      const text = session.decoder.write(chunk)
      if (text) this.onData({ sessionId, data: text })
    })
    shell.stderr?.on('data', (chunk: Buffer) => {
      const text = session.decoder.write(chunk)
      if (text) this.onData({ sessionId, data: text })
    })
    shell.on('close', () => {
      this.onState({ sessionId, serverId: config.id, status: 'closed' })
    })

    client.on('close', () => {
      this.sessions.delete(sessionId)
      this.onState({ sessionId, serverId: config.id, status: 'closed' })
    })
    client.on('error', (err: Error) => {
      this.onState({
        sessionId,
        serverId: config.id,
        status: 'error',
        message: humanizeSshError(err)
      })
    })

    return sessionId
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.shell?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const shell = this.sessions.get(sessionId)?.shell
    // setWindow(rows, cols, height, width)
    shell?.setWindow(rows, cols, 0, 0)
  }

  async exec(sessionId: string, command: string): Promise<ExecResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话已断开')
    return new Promise<ExecResult>((resolve, reject) => {
      session.client.exec(command, (err, stream) => {
        if (err) return reject(err)
        const outDecoder = new StringDecoder('utf8')
        const errDecoder = new StringDecoder('utf8')
        let stdout = ''
        let stderr = ''
        let code = 0
        stream.on('data', (chunk: Buffer) => {
          stdout += outDecoder.write(chunk)
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += errDecoder.write(chunk)
        })
        stream.on('exit', (exitCode: number) => {
          code = exitCode ?? 0
        })
        stream.on('close', () => {
          stdout += outDecoder.end()
          stderr += errDecoder.end()
          resolve({ code, stdout, stderr })
        })
      })
    })
  }

  /**
   * 当前登录用户是谁（uid + 所有 gid）。
   *
   * 判定"这个文件我能不能写"必须用 uid/gid 比，不能拿用户名比：
   * 同一个用户名在不同机器上 uid 可能不同，而容器/共享存储里同名不同 uid 很常见。
   * 一次会话只问一次（`id -u` + `id -G` 一条命令搞定），后面列目录直接用缓存 ——
   * 每个目录都多跑一次 exec 会让翻目录明显变慢。
   */
  async getIdentity(sessionId: string): Promise<RemoteIdentity | undefined> {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    if (!session.identityPromise) {
      session.identityPromise = (async () => {
        try {
          // -u 是数字 uid，-G 是所有组（数字）；两行输出，第一行一个数，第二行一串
          const { stdout } = await this.exec(sessionId, 'id -u; id -G')
          const lines = stdout.trim().split(/\r?\n/)
          const uid = Number.parseInt((lines[0] || '').trim(), 10)
          const gids = (lines[1] || '')
            .trim()
            .split(/\s+/)
            .map((g) => Number.parseInt(g, 10))
            .filter((g) => Number.isFinite(g))
          if (!Number.isFinite(uid)) return undefined
          if (!gids.includes(uid) && gids.length === 0) gids.push(uid)
          return { uid, gids, username: session.config.username } satisfies RemoteIdentity
        } catch {
          // 拿不到就当"不知道"：权限列照样显示，只是不标红，别把界面拖坏
          return undefined
        }
      })()
    }
    return session.identityPromise
  }

  async getSftp(sessionId: string): Promise<SFTPWrapper> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话已断开')
    if (!session.sftpPromise) {
      session.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
        session.client.sftp((err, sftp) => {
          if (err) return reject(err)
          resolve(sftp)
        })
      })
      // 失败要清掉缓存，否则后续重试一直拿到 rejected promise
      session.sftpPromise.catch(() => {
        session.sftpPromise = undefined
      })
    }
    return session.sftpPromise
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.intentionalClose = true
    try {
      session.shell?.close()
      session.client.end()
    } catch {
      /* 已断开 */
    }
    this.sessions.delete(sessionId)
  }

  disconnectAll(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id)
  }
}

/** 把 ssh2 抛出的英文错误翻译成能看懂的中文 */
function humanizeSshError(err: Error): string {
  const msg = err?.message ?? String(err)
  if (/All configured authentication methods failed/i.test(msg)) {
    return '认证失败：用户名、密码或密钥不正确'
  }
  if (/ECONNREFUSED/i.test(msg)) return '连接被拒绝：目标端口未开放或 SSH 服务未启动'
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return '主机名无法解析，请检查地址'
  if (/ETIMEDOUT|Timed out while waiting/i.test(msg)) {
    return '连接超时：检查网络、防火墙或安全组规则'
  }
  if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) return '网络不可达，请检查 IP 与路由'
  if (/Cannot parse privateKey/i.test(msg)) return '私钥格式无法解析，请确认是 OpenSSH 或 PEM 格式'
  return msg
}
