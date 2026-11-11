import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig, ServerConfig } from '../types'

const DEFAULT_CONFIG: AppConfig = {
  groups: [{ id: 'default', name: '默认分组' }],
  servers: [],
  settings: {
    theme: 'dark',
    fontSize: 14,
    metricInterval: 3000,
    copyOnSelect: true
  }
}

/**
 * 配置文件落在 userData 目录，不跟随安装目录，卸载重装不丢。
 *
 * 密码用 Electron safeStorage（Windows 走 DPAPI，macOS 走 Keychain）加密后
 * base64 存盘。这样明文密码不会出现在磁盘上；safeStorage 不可用时（极少见）
 * 退化为明文，并在字段上打标记，前端不做提示，但代码里留痕。
 */
export class ConfigStore {
  private filePath: string
  private cache: AppConfig | null = null

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'thshell-config.json')
  }

  get path(): string {
    return this.filePath
  }

  private encrypt(plain?: string): string | undefined {
    if (!plain) return undefined
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return 'enc:' + safeStorage.encryptString(plain).toString('base64')
      }
    } catch {
      /* 某些 Linux 环境无 keyring，降级明文 */
    }
    return 'raw:' + plain
  }

  private decrypt(stored?: string): string | undefined {
    if (!stored) return undefined
    if (stored.startsWith('enc:')) {
      try {
        return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
      } catch {
        return undefined
      }
    }
    if (stored.startsWith('raw:')) return stored.slice(4)
    return stored
  }

  load(): AppConfig {
    if (this.cache) return this.cache
    let config: AppConfig = structuredClone(DEFAULT_CONFIG)
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as AppConfig
        const rawSettings = raw.settings ?? {}
        const settings = { ...DEFAULT_CONFIG.settings, ...rawSettings }
        // 0.1 版只有 terminalTheme（仅管终端），0.2 起统一成 theme。
        // 老配置升级时把旧值接过来，否则用户之前选的浅色会被重置成深色。
        if (!rawSettings.theme && rawSettings.terminalTheme) {
          settings.theme = rawSettings.terminalTheme
        }
        config = {
          groups: raw.groups?.length ? raw.groups : DEFAULT_CONFIG.groups,
          servers: Array.isArray(raw.servers) ? raw.servers : [],
          settings
        }
      }
    } catch (err) {
      console.error('[config] 读取失败，回退默认配置', err)
      // 坏文件备份一份，别直接覆盖掉用户数据
      try {
        fs.copyFileSync(this.filePath, this.filePath + '.broken')
      } catch {
        /* ignore */
      }
    }
    // 解密后交给渲染进程
    config.servers = config.servers.map((s) => ({
      ...s,
      password: this.decrypt(s.password),
      privateKey: this.decrypt(s.privateKey),
      passphrase: this.decrypt(s.passphrase)
    }))
    this.cache = config
    return config
  }

  save(config: AppConfig): void {
    const toDisk: AppConfig = {
      groups: config.groups,
      servers: config.servers.map((s: ServerConfig) => ({
        ...s,
        password: this.encrypt(s.password),
        privateKey: this.encrypt(s.privateKey),
        passphrase: this.encrypt(s.passphrase)
      })),
      settings: config.settings
    }
    // 先写临时文件再 rename，避免写一半断电导致配置损坏
    const tmp = this.filePath + '.tmp'
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(toDisk, null, 2), 'utf-8')
    fs.renameSync(tmp, this.filePath)
    this.cache = config
  }

  /** 导出为不含密码的明文 JSON，方便在团队内共享连接信息 */
  exportSanitized(): AppConfig {
    const config = this.load()
    return {
      ...config,
      servers: config.servers.map((s) => ({
        ...s,
        password: undefined,
        privateKey: undefined,
        passphrase: undefined
      }))
    }
  }
}
