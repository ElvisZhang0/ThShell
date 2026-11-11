import { defineStore } from 'pinia'
import { DEFAULT_UPDATE_FEED } from '../../electron/types'
import type {
  AppConfig,
  MetricSnapshot,
  ServerConfig,
  SessionState,
  SessionStatus,
  TransferProgress,
  TransferRecord
} from '../../electron/types'

export type ViewKind = 'terminal' | 'files' | 'monitor' | 'system' | 'docker'

/** 文件剪贴板的一条记录，只存粘贴时需要的最小信息 */
export interface ClipEntry {
  path: string
  name: string
  isDir: boolean
}

/**
 * 文件剪贴板。
 * 放在全局 store 而不是组件里：同一时刻只有一个剪贴板，
 * 从 A 标签页复制、切到 B 标签页粘贴是常规操作。
 */
export interface FileClipboard {
  side: 'local' | 'remote'
  mode: 'copy' | 'cut'
  /** 源所在目录，用来挡住「粘贴到自己所在目录」 */
  sourceDir: string
  entries: ClipEntry[]
}

export interface Tab {
  id: string
  /** 主进程返回的 SSH 会话 id，连接完成前为空 */
  sessionId: string
  serverId: string
  title: string
  subtitle: string
  status: SessionStatus
  view: ViewKind
  message?: string
  /** 终端是否已建立过，用于重连后强制重建 xterm */
  epoch: number
}

const EMPTY_CONFIG: AppConfig = {
  groups: [],
  servers: [],
  settings: {
    theme: 'dark',
    fontSize: 14,
    metricInterval: 3000,
    copyOnSelect: true,
    updateFeed: DEFAULT_UPDATE_FEED
  }
}

/** Electron 的 invoke 错误会带一长串前缀，剥掉只留人话 */
export function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

/**
 * 跨进程传对象前必须解包。
 *
 * Pinia 的 state 是响应式 Proxy，contextBridge 在把参数送过边界时走结构化克隆，
 * 而 Proxy 不可克隆 —— 抛出来的是 "An object could not be cloned"，
 * 在界面上长得像「连接失败」，排查时极容易怀疑到网络或认证头上。
 *
 * 这里用 JSON 深拷贝而不是 structuredClone：后者对 Proxy 同样会抛 DataCloneError。
 * 连接配置本身就是纯 JSON 结构，不涉及 Date / Map，深拷贝不会丢信息。
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export const useAppStore = defineStore('app', {
  state: () => ({
    config: structuredClone(EMPTY_CONFIG) as AppConfig,
    ready: false,
    tabs: [] as Tab[],
    activeTabId: '',
    metrics: {} as Record<string, MetricSnapshot[]>,
    transfers: [] as TransferProgress[],
    /** 已结束的传输记录（主进程落盘，重启后还在） */
    transferLog: [] as TransferRecord[],
    /** 文件剪贴板（全局唯一） */
    clipboard: null as FileClipboard | null,
    /** 侧栏筛选关键词 */
    filter: '',
    metricsTimer: 0 as number | ReturnType<typeof setInterval>
  }),

  getters: {
    activeTab(state): Tab | undefined {
      return state.tabs.find((t) => t.id === state.activeTabId)
    },
    connectedTabs(state): Tab[] {
      return state.tabs.filter((t) => t.status === 'connected')
    },
    serversByGroup(state) {
      return (groupId: string): ServerConfig[] =>
        state.config.servers.filter((s) => s.groupId === groupId)
    },
    serverById(state) {
      return (id: string): ServerConfig | undefined => state.config.servers.find((s) => s.id === id)
    }
  },

  actions: {
    async init() {
      try {
        const loaded = await window.api.config.load()
        const s = loaded.settings
        this.config = {
          groups: loaded.groups.length ? loaded.groups : [{ id: 'default', name: '默认分组' }],
          servers: loaded.servers,
          settings: {
            // 兼容旧配置：只有 terminalTheme 没有 theme
            theme: s.theme ?? s.terminalTheme ?? 'dark',
            fontSize: s.fontSize ?? 14,
            metricInterval: s.metricInterval ?? 3000,
            copyOnSelect: s.copyOnSelect ?? true,
            // 老配置里没这个字段 → 补默认的 GitHub 源；
            // 显式存着空串的，是用户自己关掉的，不动它
            updateFeed: s.updateFeed ?? DEFAULT_UPDATE_FEED
          }
        }
      } catch (err) {
        console.error('配置加载失败', err)
      }
      this.ready = true
      this.applyTheme()
      this.startMetricsLoop()
    },

    /** 把主题写到 <html data-theme>，CSS 变量和终端配色都跟着它走 */
    applyTheme() {
      if (typeof document === 'undefined') return
      const theme = this.config.settings.theme
      document.documentElement.dataset.theme = theme
      // 同步 Windows 原生标题栏：它不认 CSS 变量，跟的是系统深色模式，
      // 不切的话界面变浅色后标题栏仍是黑的
      window.api?.theme?.set(theme).catch(() => {
        /* 主题同步失败不致命，界面内配色已经切了 */
      })
    },

    async persist() {
      try {
        await window.api.config.save(plain(this.config))
      } catch (err) {
        console.error('配置保存失败', err)
      }
    },

    async openServer(server: ServerConfig) {
      const existing = this.tabs.find((t) => t.serverId === server.id)
      if (existing) {
        this.activeTabId = existing.id
        if (existing.status === 'error' || existing.status === 'closed') {
          await this.reconnect(existing.id)
        }
        return
      }

      const tab: Tab = {
        id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        sessionId: '',
        serverId: server.id,
        title: server.name,
        subtitle: `${server.username}@${server.host}:${server.port}`,
        status: 'connecting',
        view: 'terminal',
        epoch: 0
      }
      this.tabs.push(tab)
      this.activeTabId = tab.id

      try {
        const sessionId = await window.api.ssh.connect(plain(server), 120, 32)
        const target = this.tabs.find((t) => t.id === tab.id)
        if (!target) {
          // 连接期间标签被关掉了，主进程会话要顺手收掉
          void window.api.ssh.disconnect(sessionId)
          return
        }
        target.sessionId = sessionId
        target.status = 'connected'
        target.epoch += 1

        // 记录最近使用时间，侧栏按使用频率排序时用得上
        const cfgServer = this.config.servers.find((s) => s.id === server.id)
        if (cfgServer) {
          cfgServer.lastUsedAt = Date.now()
          void this.persist()
        }
      } catch (err) {
        const target = this.tabs.find((t) => t.id === tab.id)
        if (target) {
          target.status = 'error'
          target.message = cleanError(err)
        }
      }
    },

    async reconnect(tabId: string) {
      const tab = this.tabs.find((t) => t.id === tabId)
      if (!tab) return
      const server = this.serverById(tab.serverId)
      if (!server) {
        tab.status = 'error'
        tab.message = '连接配置已被删除'
        return
      }
      if (tab.sessionId) {
        void window.api.ssh.disconnect(tab.sessionId)
      }
      tab.status = 'connecting'
      tab.message = undefined
      tab.sessionId = ''
      try {
        const sessionId = await window.api.ssh.connect(plain(server), 120, 32)
        tab.sessionId = sessionId
        tab.status = 'connected'
        tab.epoch += 1
      } catch (err) {
        tab.status = 'error'
        tab.message = cleanError(err)
      }
    },

    closeTab(tabId: string) {
      const idx = this.tabs.findIndex((t) => t.id === tabId)
      if (idx < 0) return
      const tab = this.tabs[idx]
      if (tab.sessionId) {
        void window.api.ssh.disconnect(tab.sessionId)
        delete this.metrics[tab.sessionId]
      }
      this.tabs.splice(idx, 1)
      if (this.activeTabId === tabId) {
        const next = this.tabs[idx] ?? this.tabs[idx - 1]
        this.activeTabId = next?.id ?? ''
      }
    },

    closeOtherTabs(tabId: string) {
      for (const t of [...this.tabs]) {
        if (t.id !== tabId) this.closeTab(t.id)
      }
    },

    /**
     * 关闭某个页签左侧 / 右侧的全部页签。
     * 先 slice 出快照再逐个关，避免边遍历边 splice 把下标带偏。
     * 顺序按"从远到近"关更稳：closeTab 会在关掉活动页时挑邻居，
     * 逆序关让活动页的落点始终落在没被删的那一侧。
     */
    closeTabsLeft(tabId: string) {
      const idx = this.tabs.findIndex((t) => t.id === tabId)
      if (idx <= 0) return
      for (const t of this.tabs.slice(0, idx).reverse()) this.closeTab(t.id)
    },

    closeTabsRight(tabId: string) {
      const idx = this.tabs.findIndex((t) => t.id === tabId)
      if (idx < 0) return
      for (const t of this.tabs.slice(idx + 1).reverse()) this.closeTab(t.id)
    },

    applySessionState(payload: SessionState) {
      const tab = this.tabs.find((t) => t.sessionId === payload.sessionId)
      if (!tab) return
      tab.status = payload.status
      if (payload.message) tab.message = payload.message
      if (payload.status === 'closed' && tab.sessionId) {
        delete this.metrics[tab.sessionId]
      }
    },

    startMetricsLoop() {
      if (this.metricsTimer) return
      this.metricsTimer = setInterval(async () => {
        const interval = this.config.settings.metricInterval
        if (!interval) return
        for (const tab of this.connectedTabs) {
          if (!tab.sessionId) continue
          try {
            const snapshot = await window.api.ssh.metrics(tab.sessionId)
            if (!snapshot) continue
            const history = this.metrics[tab.sessionId] ?? []
            history.push(snapshot)
            // 只留最近 60 个采样点，够画 3 分钟趋势
            if (history.length > 60) history.shift()
            this.metrics[tab.sessionId] = history
          } catch {
            /* 单次采集失败不打断循环 */
          }
        }
      }, Math.max(1000, this.config.settings.metricInterval || 3000))
    },

    setClipboard(clip: FileClipboard | null) {
      this.clipboard = clip
    },

    pushTransfer(p: TransferProgress) {
      const idx = this.transfers.findIndex((t) => t.transferId === p.transferId)
      if (idx >= 0) this.transfers[idx] = p
      else this.transfers.unshift(p)
      if (this.transfers.length > 20) this.transfers.pop()
      if (p.done) {
        // 主进程已经把这条写进记录了（transfer:changed 会顺手把列表拉回来），
        // 这里只负责把"100% / 失败"那一帧留一会儿再撤，否则用户刚看进度条就没了
        setTimeout(() => {
          this.transfers = this.transfers.filter((t) => t.transferId !== p.transferId)
        }, 1200)
      }
    },

    async loadTransferLog() {
      try {
        this.transferLog = await window.api.transfer.list()
      } catch {
        /* 记录读不出来不影响传输本身 */
      }
    },

    async clearTransferLog() {
      try {
        this.transferLog = await window.api.transfer.clear()
      } catch {
        /* 同上 */
      }
    },

    upsertServer(server: ServerConfig) {
      const idx = this.config.servers.findIndex((s) => s.id === server.id)
      if (idx >= 0) this.config.servers[idx] = server
      else this.config.servers.push(server)
      void this.persist()
    },

    removeServer(id: string) {
      this.config.servers = this.config.servers.filter((s) => s.id !== id)
      const tab = this.tabs.find((t) => t.serverId === id)
      if (tab) this.closeTab(tab.id)
      void this.persist()
    },

    addGroup(name: string): string {
      const id = `group-${Date.now()}`
      this.config.groups.push({ id, name })
      void this.persist()
      return id
    },

    removeGroup(id: string) {
      if (id === 'default') return
      for (const server of this.config.servers.filter((s) => s.groupId === id)) {
        server.groupId = 'default'
      }
      this.config.groups = this.config.groups.filter((g) => g.id !== id)
      void this.persist()
    },

    async saveSettings() {
      await this.persist()
    }
  }
})
