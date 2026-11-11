import { clipboard, contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppConfig,
  ExecResult,
  FileEntry,
  MetricSnapshot,
  ServerConfig,
  SessionState,
  SystemInfo,
  ThShellApi,
  TransferProgress,
  TransferRecord
} from './types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: ThShellApi = {
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (config: AppConfig) => ipcRenderer.invoke('config:save', config),
    exportConfig: () => ipcRenderer.invoke('config:export'),
    importConfig: () => ipcRenderer.invoke('config:import')
  },
  theme: {
    set: (theme: 'light' | 'dark' | 'system') => ipcRenderer.invoke('theme:set', theme)
  },
  ssh: {
    connect: (config: ServerConfig, cols = 100, rows = 30) =>
      ipcRenderer.invoke('ssh:connect', config, cols, rows),
    disconnect: (sessionId: string) => ipcRenderer.invoke('ssh:disconnect', sessionId),
    write: (sessionId: string, data: string) => ipcRenderer.send('ssh:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    exec: (sessionId: string, command: string): Promise<ExecResult> =>
      ipcRenderer.invoke('ssh:exec', sessionId, command),
    metrics: (sessionId: string): Promise<MetricSnapshot | null> =>
      ipcRenderer.invoke('ssh:metrics', sessionId),
    sysinfo: (sessionId: string): Promise<SystemInfo | null> =>
      ipcRenderer.invoke('ssh:sysinfo', sessionId),
    onData: (cb) => subscribe<{ sessionId: string; data: string }>('ssh:data', cb),
    onState: (cb) => subscribe<SessionState>('ssh:state', cb)
  },
  sftp: {
    list: (sessionId: string, remotePath: string): Promise<FileEntry[]> =>
      ipcRenderer.invoke('sftp:list', sessionId, remotePath),
    download: (sessionId, remotePath, localPath) =>
      ipcRenderer.invoke('sftp:download', sessionId, remotePath, localPath),
    downloadDir: (sessionId, remotePath, localPath) =>
      ipcRenderer.invoke('sftp:downloadDir', sessionId, remotePath, localPath),
    upload: (sessionId, localPath, remotePath) =>
      ipcRenderer.invoke('sftp:upload', sessionId, localPath, remotePath),
    uploadDir: (sessionId, localDir, remotePath) =>
      ipcRenderer.invoke('sftp:uploadDir', sessionId, localDir, remotePath),
    mkdir: (sessionId, remotePath) => ipcRenderer.invoke('sftp:mkdir', sessionId, remotePath),
    remove: (sessionId, remotePath, isDir) =>
      ipcRenderer.invoke('sftp:remove', sessionId, remotePath, isDir),
    rename: (sessionId, oldPath, newPath) =>
      ipcRenderer.invoke('sftp:rename', sessionId, oldPath, newPath),
    readFile: (sessionId, remotePath) => ipcRenderer.invoke('sftp:readFile', sessionId, remotePath),
    readTail: (sessionId, remotePath, lines) =>
      ipcRenderer.invoke('sftp:readTail', sessionId, remotePath, lines),
    readBinary: (sessionId, remotePath) =>
      ipcRenderer.invoke('sftp:readBinary', sessionId, remotePath),
    writeFile: (sessionId, remotePath, content, encoding, bom) =>
      ipcRenderer.invoke('sftp:writeFile', sessionId, remotePath, content, encoding, bom),
    canWrite: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:canWrite', sessionId, remotePath),
    paste: (sessionId, srcPaths, destDir, mode) =>
      ipcRenderer.invoke('remote:paste', sessionId, srcPaths, destDir, mode),
    onProgress: (cb) => subscribe<TransferProgress>('sftp:progress', cb)
  },
  transfer: {
    /** 已结束的传输记录（新的在前），重启后还在 */
    list: (): Promise<TransferRecord[]> => ipcRenderer.invoke('transfer:list'),
    clear: (): Promise<TransferRecord[]> => ipcRenderer.invoke('transfer:clear'),
    /** 主进程写完一条记录就通知一次，界面重新拉列表 */
    onChanged: (cb: () => void): (() => void) => {
      const handler = () => cb()
      ipcRenderer.on('transfer:changed', handler)
      return () => ipcRenderer.removeListener('transfer:changed', handler)
    }
  },
  local: {
    home: () => ipcRenderer.invoke('local:home'),
    list: (dirPath: string) => ipcRenderer.invoke('local:list', dirPath),
    mkdir: (dirPath: string) => ipcRenderer.invoke('local:mkdir', dirPath),
    remove: (targetPath: string) => ipcRenderer.invoke('local:remove', targetPath),
    rename: (oldPath: string, newPath: string) =>
      ipcRenderer.invoke('local:rename', oldPath, newPath),
    readFile: (filePath: string) => ipcRenderer.invoke('local:readFile', filePath),
    readTail: (filePath: string, lines) => ipcRenderer.invoke('local:readTail', filePath, lines),
    readBinary: (filePath: string) => ipcRenderer.invoke('local:readBinary', filePath),
    writeFile: (filePath: string, content: string, encoding, bom) =>
      ipcRenderer.invoke('local:writeFile', filePath, content, encoding, bom),
    canWrite: (filePath: string) => ipcRenderer.invoke('local:canWrite', filePath),
    openPath: (targetPath: string) => ipcRenderer.invoke('local:openPath', targetPath),
    reveal: (targetPath: string) => ipcRenderer.invoke('local:reveal', targetPath),
    drives: () => ipcRenderer.invoke('local:drives'),
    places: () => ipcRenderer.invoke('local:places'),
    paste: (srcPaths, destDir, mode) => ipcRenderer.invoke('local:paste', srcPaths, destDir, mode)
  },
  dialog: {
    pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
    pickDir: (defaultPath?: string) => ipcRenderer.invoke('dialog:pickDir', defaultPath),
    pickSave: (defaultName: string) => ipcRenderer.invoke('dialog:pickSave', defaultName)
  },
  // 剪贴板走主进程：file:// 协议下 navigator.clipboard 会被 Chromium 禁用
  clipboard: {
    read: () => Promise.resolve(clipboard.readText()),
    write: (text: string) => {
      clipboard.writeText(text)
      return Promise.resolve()
    }
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    platform: () => ipcRenderer.invoke('app:platform'),
    info: () => ipcRenderer.invoke('app:info'),
    minimize: () => ipcRenderer.send('app:minimize'),
    toggleMaximize: () => ipcRenderer.send('app:toggleMaximize'),
    close: () => ipcRenderer.send('app:close')
  },
  docker: {
    probe: (sessionId: string) => ipcRenderer.invoke('docker:probe', sessionId),
    overview: (sessionId: string) => ipcRenderer.invoke('docker:overview', sessionId),
    containers: (sessionId: string) => ipcRenderer.invoke('docker:containers', sessionId),
    containerAction: (
      sessionId: string,
      id: string,
      action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove',
      force?: boolean
    ) => ipcRenderer.invoke('docker:container-action', sessionId, id, action, force),
    containerLogs: (sessionId: string, id: string, tail?: number) =>
      ipcRenderer.invoke('docker:container-logs', sessionId, id, tail),
    containerDetail: (sessionId: string, id: string) =>
      ipcRenderer.invoke('docker:container-detail', sessionId, id),
    images: (sessionId: string) => ipcRenderer.invoke('docker:images', sessionId),
    pullImage: (sessionId: string, ref: string) =>
      ipcRenderer.invoke('docker:pull-image', sessionId, ref),
    removeImage: (sessionId: string, ref: string, force?: boolean) =>
      ipcRenderer.invoke('docker:remove-image', sessionId, ref, force),
    networks: (sessionId: string) => ipcRenderer.invoke('docker:networks', sessionId),
    volumes: (sessionId: string) => ipcRenderer.invoke('docker:volumes', sessionId),
    removeNetwork: (sessionId: string, id: string) =>
      ipcRenderer.invoke('docker:remove-network', sessionId, id),
    removeVolume: (sessionId: string, name: string) =>
      ipcRenderer.invoke('docker:remove-volume', sessionId, name),
    compose: (sessionId: string) => ipcRenderer.invoke('docker:compose', sessionId),
    prune: (sessionId: string, target: 'container' | 'image' | 'volume' | 'builder' | 'all') =>
      ipcRenderer.invoke('docker:prune', sessionId, target)
  }
}

contextBridge.exposeInMainWorld('api', api)
