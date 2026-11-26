/**
 * 主进程与渲染进程共享的类型定义。
 * 只放纯类型，不引入任何运行时依赖，避免 preload / 渲染层打包时被牵连。
 */

export type AuthType = 'password' | 'key'

/** 一台被托管的服务器连接配置 */
export interface ServerConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKey?: string
  passphrase?: string
  /** 所属分组 id，'default' 为内置默认分组 */
  groupId: string
  /** 标签色，用于区分环境（生产/测试） */
  color?: string
  note?: string
  createdAt: number
  lastUsedAt?: number
}

export interface ServerGroup {
  id: string
  name: string
}

export interface AppSettings {
  /** 界面主题，同时决定终端配色 */
  theme: 'dark' | 'light'
  /** @deprecated 旧版本字段，仅用于迁移已保存的配置，新代码读 theme */
  terminalTheme?: 'dark' | 'light'
  /** 终端字号 */
  fontSize: number
  /** 指标采集间隔（毫秒），0 表示关闭 */
  metricInterval: number
  /** 复制即选中 */
  copyOnSelect: boolean
  /**
   * 自定义更新源：指向一个 latest.json 的完整 URL（http/https/file://）。
   *
   * **一般不用动**，界面上也没有这一项 —— 留空就用内置的三条通道（见 DEFAULT_UPDATE_FEEDS）。
   * 只有内网部署、必须走自己的静态目录/共享盘时才手改配置文件：填了就只走它，
   * 不会再并发去连 GitHub（内网机器不该因为"兜底"而漏流量出去）。
   */
  updateFeed: string
  /**
   * 启动时静默检查更新。默认开。
   * 纯内网机器关掉它，就只有在「关于 → 检查更新」里手动点才会联网。
   */
  updateAutoCheck: boolean
}

/**
 * 内置更新源的候选通道 —— 并发尝试，谁先给出结果用谁。
 *
 * 为什么是数组而不是一个地址：github.com 在国内直连经常超时，但同一个资源套上
 * 加速前缀（`https://ghfast.top/https://github.com/...`）几乎总能拿到。
 * 三个一起发比串行等超时快得多 —— 串行的话每个源 8 秒，最坏 24 秒，用户早把弹窗关了。
 *
 * 地址用的是 `releases/latest/download/<文件名>`：**永远指向最新 release 的同名附件**，
 * 所以发版时不用改代码、不用固定 tag、也不用手动删旧文件。
 *
 * 只对 **public 仓库**有效：private 仓库的 Release 附件匿名下载是 404。
 */
export const DEFAULT_UPDATE_FEEDS: string[] = [
  'https://github.com/ElvisZhang0/ThShell/releases/latest/download/latest.json',
  'https://ghfast.top/https://github.com/ElvisZhang0/ThShell/releases/latest/download/latest.json',
  'https://gh-proxy.com/https://github.com/ElvisZhang0/ThShell/releases/latest/download/latest.json'
]

/** 主源（直连）。仅用于展示与兜底，真正的候选列表是 DEFAULT_UPDATE_FEEDS */
export const DEFAULT_UPDATE_FEED = DEFAULT_UPDATE_FEEDS[0]

/**
 * 已知可用的 GitHub 加速前缀。
 * 下载地址不管是从哪个通道拿来的，都会自动补上这些前缀当备用 ——
 * 这样 latest.json 里不写 `mirrors`，直连下不动时也能换道。
 */
export const GH_MIRROR_PREFIXES = ['https://ghfast.top/', 'https://gh-proxy.com/']

/* ---------------- 检查更新 ---------------- */

/** latest.json 里的一个安装包 */
export interface UpdateAsset {
  /** node 的 process.platform 取值：win32 / darwin / linux */
  platform: string
  /** x64 / arm64 */
  arch: string
  /** exe / dmg / zip / AppImage / deb / rpm / tar.gz */
  format: string
  /** 主下载地址 */
  url: string
  /**
   * 备用镜像（**不含** url 本身），按顺序兜底。
   * GitHub Release 在国内经常下不动，加个镜像前缀就能救回来 —— 改 JSON 即可，不用重新发版。
   */
  mirrors?: string[]
  /** 字节数，用来在下载前提示体积、下载后校验是否下全 */
  size?: number
  /** 小写十六进制；有就必须校验，防内网文件服务器上放错版本 */
  sha256?: string
}

export interface UpdateManifest {
  version: string
  publishedAt?: string
  /** 更新说明，纯文本，换行用 \n */
  notes?: string
  assets: UpdateAsset[]
}

export interface UpdateCheckResult {
  current: string
  latest?: string
  hasUpdate: boolean
  notes?: string
  /** 当前平台该下载哪个包 */
  asset?: UpdateAsset
  /** 实际取到数据的那条通道（直连或某个加速镜像），界面上告诉用户走的是哪条 */
  feed?: string
  /** 失败了：网络、JSON 格式、版本号非法…… 原样带出来给用户看 */
  error?: string
  /** 版本更新了，但更新源里没有我这个平台的包 */
  unsupported?: string
}

export interface UpdateProgress {
  transferred: number
  total: number
  /** 0-100，total 未知时为 0 */
  percent: number
  /** 字节/秒，平滑后的值 */
  speed: number
}

export interface AppConfig {
  groups: ServerGroup[]
  servers: ServerConfig[]
  settings: AppSettings
}

export type SessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface SessionState {
  sessionId: string
  serverId: string
  status: SessionStatus
  message?: string
}

/** 本地终端启动后回给渲染层的信息，用来填页签标题和副标题 */
export interface LocalShellInfo {
  sessionId: string
  /** 实际拉起来的 shell：PowerShell 7 / Windows PowerShell / Command Prompt / bash / zsh */
  shell: string
  cwd: string
}

/** 一次服务器资源快照 */
export interface MetricSnapshot {
  time: number
  /** 0-100 */
  cpu: number
  memUsed: number
  memTotal: number
  swapUsed: number
  swapTotal: number
  load1: number
  load5: number
  load15: number
  /** KB/s */
  netRx: number
  netTx: number
  diskUsed: number
  diskTotal: number
  uptime: number
  processes: number
}

/**
 * 进程监控里的一行。
 * cpu 是**瞬时**占用（两次采样求差），口径和 htop 一致：一个核跑满 = 100%，
 * 所以多核机器上所有进程加起来可以超过 100。
 */
export interface ProcRow {
  pid: number
  ppid: number
  user: string
  /** R / S / D / Z / T … */
  state: string
  threads: number
  /** KB */
  rss: number
  cpu: number
  mem: number
  cmd: string
}

/** 进程页顶部的概要（htop 那几条 meter 用的数） */
export interface ProcStats {
  /** 服务器上的进程总数；rows 可能被截断 */
  total: number
  running: number
  sleeping: number
  zombie: number
  threads: number
  cores: number
  /** 全机瞬时占用（两次采样求差），0-100 */
  cpu: number
  load1: number
  load5: number
  load15: number
  memTotal: number
  memUsed: number
  swapTotal: number
  swapUsed: number
}

export interface ProcSnapshot {
  time: number
  rows: ProcRow[]
  stats: ProcStats
  /** htop 是否装了；没装就得按发行版给安装命令 */
  htop: {
    available: boolean
    path: string
    /** 探测到的包管理器：apt / dnf / yum / zypper / apk / pacman / unknown */
    pkg: string
    /** 直接可复制的安装命令 */
    install: string
    /** 发行版名，用于提示文案 */
    os: string
  }
}

/**
 * 一个 systemd 服务（.service 单元）。
 *
 * 数据来自两份 systemctl 输出合并：`list-units --all`（运行状态）和
 * `list-unit-files`（开机自启态）。没被加载的 unit 只有后者有，
 * 这时 active 为空、loaded 为 false —— 界面显示「未加载」，
 * 不能谎报成「已停止」（用户可能正要去启动它）。
 */
export interface ServiceRow {
  /** 完整单元名，如 cron.service / getty@tty1.service */
  name: string
  /** loaded / not-found / masked … */
  load: string
  /** active / inactive / failed / activating / reloading … */
  active: string
  /** running / dead / exited / failed … */
  sub: string
  description: string
  /** 开机自启态：enabled / disabled / static / masked / indirect … */
  enabled: string
  /** 是否已被 systemd 加载进内存 */
  loaded: boolean
}

export interface ServiceStats {
  total: number
  running: number
  failed: number
  /** 已加载但没在跑（不含 failed） */
  inactive: number
}

export interface ServiceSnapshot {
  time: number
  rows: ServiceRow[]
  stats: ServiceStats
  systemd: {
    /** 这台机器有没有 systemd：容器 / WSL / sysvinit 机器上会是 false */
    available: boolean
    /** 1 号进程的 comm，如 systemd / init / tini */
    init: string
    version: string
    /** 不可用时的原因（直接给运维看的那句原始报错） */
    hint: string
  }
}

/** 服务的三个动作。只给这三个 —— 开机自启开关属于「改配置」，不在这里做 */
export type ServiceAction = 'start' | 'stop' | 'restart'

/** 拉服务日志的参数 */
export interface ServiceLogQuery {
  /** 首屏要多少行；增量时是单次上限 */
  lines: number
  /** 增量游标：`YYYY-MM-DD HH:MM:SS`，空表示拉首屏 */
  since?: string
  /** 游标那一秒里上次已经返回过多少行（--since 是闭区间，不跳过就重复） */
  skip?: number
}

export interface ServiceLogResult {
  lines: string[]
  /** 下一轮增量用的游标 */
  cursor: string
  /** 游标那一秒里已经返回过的行数 */
  cursorCount: number
  /** 日志是普通账号读的，还是靠 sudo 读的 */
  source: 'user' | 'sudo'
  /** 需要让用户知道的事（权限不足等）—— 不是错误，但会影响能看到什么 */
  note: string
  at: number
}

/** 一个挂载点的磁盘占用 */
export interface DiskMount {
  device: string
  mount: string
  fstype: string
  /** df -h 的原始人类可读值，如 "40G" */
  size: string
  used: string
  avail: string
  /** 空间使用率 0-100；df 解析不出来时给 -1 */
  usePercent: number
  /** inode 使用率 0-100；非 Linux 或取不到时给 -1 */
  inodePercent: number
  inodeUsed: string
  inodeTotal: string
}

/** 一张网卡及其地址 */
export interface NetInterface {
  name: string
  /** 从 flags 里读出来的 UP，纯展示用 */
  up: boolean
  mac: string
  ipv4: string[]
  ipv6: string[]
}

/**
 * 一块「有设备节点、但没挂到任何目录」的磁盘/分区。
 * 来源是 lsblk 而不是 df —— df 只列已经挂上的，恰恰漏掉要找的那些。
 */
export interface UnmountedDisk {
  /** 设备路径，如 /dev/sdb1 */
  path: string
  /** lsblk 的人类可读容量，如 20G */
  size: string
  /** 空字符串表示还没格式化，这时候不能直接 mount */
  fstype: string
  label: string
  /** 所属磁盘型号，多块盘时靠它区分是哪一块 */
  model: string
  /** part / disk / lvm … */
  type: string
  /** 已经做过 swap 的分区：列出来但别让人往目录上挂 */
  isSwap: boolean
}

export interface MountRequest {
  device: string
  mountPoint: string
  fstype: string
  /** 写入 /etc/fstab，开机自动挂载 */
  persist: boolean
}

/** 远端配置类写操作的统一回执；ok=false 时 log 里是完整报错 */
export interface ConfigResult {
  ok: boolean
  log: string
}

export type NetBackend = 'nmcli' | 'ifcfg' | 'netplan' | 'none'

/** 某张网卡当前的地址配置（读出来填进表单，改完再写回去） */
export interface NetConfigInfo {
  backend: NetBackend
  device: string
  /** nmcli 的连接名，跟设备名不一定一样 */
  connName: string
  method: 'dhcp' | 'manual'
  /** CIDR 形式，如 172.30.10.206/22 */
  addresses: string[]
  gateway: string
  dns: string[]
  /** 后端说明或者「为什么改不了」 */
  hint: string
}

export interface NetConfigApply {
  device: string
  backend: NetBackend
  connName: string
  method: 'dhcp' | 'manual'
  addresses: string[]
  gateway: string
  dns: string[]
}

/** 一条登录会话（who 的输出） */
export interface LoginSession {
  user: string
  tty: string
  since: string
  from: string
}

/**
 * 服务器静态信息快照。
 * 和 MetricSnapshot 分开：那个是每 3 秒刷一次的资源曲线，这个是"进来时看一眼"的机器档案。
 */
export interface SystemInfo {
  time: number
  hostname: string
  /** /etc/os-release 的 PRETTY_NAME，取不到就退回 redhat-release 的原文 */
  os: string
  kernel: string
  /** 从 uname -srm 里拆出来的机器架构 */
  arch: string
  cpuModel: string
  cpuCores: number
  /** MB */
  memTotal: number
  swapTotal: number
  /** 秒 */
  uptime: number
  load1: number
  load5: number
  load15: number
  processes: number
  /** "2026-11-09 17:49:20 CST +0800" */
  date: string
  /** systemd-detect-virt 的输出，"none" 表示物理机 */
  virt: string
  disks: DiskMount[]
  nets: NetInterface[]
  gateways: string[]
  dns: string[]
  sessions: LoginSession[]
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  /** 毫秒时间戳 */
  mtime: number
  mode: number
  isSymlink?: boolean
  /** 9 位 rwx 串（`rwxr-xr-x`，带 setuid/setgid/sticky 的 s/S/t/T）；本地列表没有这个 */
  modeText?: string
  /** 属主 / 属组名。取自 SFTP 的长格式（`ls -l` 那一行），取不到就是空串 */
  owner?: string
  group?: string
  /**
   * 当前 SSH 登录用户对这个条目**有没有写权限**（算上了属主/组/其他三档与 root）。
   * undefined = 没算（不是远程列表，或拿不到登录用户的 uid）
   */
  writable?: boolean
}

/** 一次 SSH 会话里"我是谁"：判定权限位要用，连上之后问一次就缓存 */
export interface RemoteIdentity {
  uid: number
  /** 数值 gid 列表（含主组与所有附加组） */
  gids: number[]
  username: string
}

export interface TransferProgress {
  transferId: string
  sessionId: string
  direction: 'upload' | 'download'
  /** 显示用的名字：单文件是文件名，目录传输带「（N 个文件）」 */
  filename: string
  /** 源完整路径：上传是本地路径，下载是远端路径 */
  from: string
  /** 目标完整路径：上传是远端路径，下载是本地路径 */
  to: string
  /** 目录传输（一次操作一条记录，不逐文件刷） */
  dir?: boolean
  /** 已传输字节 */
  transferred: number
  /**
   * 总字节数。文件总大小在开始前取到，所以进度条一上来就有分母；
   * 极端情况下取不到（stat 失败）时先为 0，等 step 回调补上。
   */
  total: number
  /** 瞬时速度（字节/秒），已在主进程做过指数平滑，界面直接用 */
  speed: number
  /** 从开始到现在的毫秒数，用于显示耗时 */
  elapsed: number
  /** 目录传输时的文件总数，单文件传输不填 */
  fileCount?: number
  /** 目录传输时已完成的文件数 */
  fileDone?: number
  /** 用户点了暂停（流没断，只是不再流动；继续之后从原处接着走） */
  paused?: boolean
  /** 用户点了取消。和"失败"分开：一个是用户的选择，一个是出了错 */
  canceled?: boolean
  done: boolean
  error?: string
}

/**
 * 一条已结束的传输记录（落盘，重启后还在）。
 *
 * 为什么单独存一份而不是复用 TransferProgress：进度是"此刻正在发生"的状态，
 * 完成后就该消失；记录是"发生过什么"，要留着回看"这个文件是从哪儿弄到哪儿去的"。
 */
export interface TransferRecord {
  id: string
  direction: 'upload' | 'download'
  /** 显示用名字（目录带「（N 个文件）」） */
  filename: string
  from: string
  to: string
  /** 文件 / 目录名（列表里单独一列，省得从路径里再切一次） */
  name: string
  dir?: boolean
  /** 字节数 */
  size: number
  /** 结束时间戳 */
  at: number
  /** 耗时毫秒 */
  ms: number
  /** 失败原因，成功为空 */
  error?: string
  /** 用户中途取消（不是出错）。界面上灰着显示「已取消」，别跟失败混一块 */
  canceled?: boolean
}

/** 传输记录最多留多少条。200 条 ≈ 一年日常量，JSON 也就几十 KB */
export const TRANSFER_LOG_MAX = 200


export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** 目录递归下载的汇总结果 */
export interface DirDownloadResult {
  total: number
  downloaded: number
  failed: { path: string; message: string }[]
  skipped: number
  bytes: number
  /**
   * 用户中途点了取消。
   * 调用方必须看这个字段：剪切模式下"传完就删源"，取消了却还删源等于直接毁数据。
   */
  canceled?: boolean
}

/** 二进制文件内容（base64），办公文档预览用 */
export interface BinaryFile {
  base64: string
  size: number
}

/** 内置编辑器读到的文本编码（写回时要按原样还原） */
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be'

/**
 * 内置编辑器能打开的体积上限。
 *
 * 这不是"政策"，是护栏：一份文本在读进来之后至少同时存在 4 份
 * （主进程 Buffer、解码出来的字符串、Vue 里的 content、"原始内容"），
 * 再加 CodeMirror 自己的文档结构。500MB 的日志塞进来，窗口会直接卡死、
 * 用户连"取消"都点不到 —— 比明确拒绝一句更糟。
 *
 * 主进程和渲染层共用这一个数字：两处各写一份迟早对不上，
 * 表现就是"按钮能点但打不开"或者"提示 5MB 实际 20MB 才拦"。
 */
export const EDIT_MAX_BYTES = 20 * 1024 * 1024

/** 超过这个体积就不拦了，只提醒一句：编辑器可能会卡 */
export const EDIT_WARN_BYTES = 3 * 1024 * 1024

/* ---------------- 日志尾部查看 ---------------- */

/**
 * 日志文件的打开方式：只读、只看末尾。
 *
 * 为什么不沿用编辑器的"整份读进来"：
 * - 真正要看的日志动辄几百 MB，整份读进 CodeMirror 是必卡；
 * - 看日志的人 99% 只关心"刚才发生了什么"，也就是最后几十行。
 * 于是双击 .log 时按字节从文件末尾往回倒着读，凑够行数就停 —— 文件多大都一样快。
 */
export const LOG_DEFAULT_LINES = 200
export const LOG_MIN_LINES = 50
export const LOG_MAX_LINES = 5000

/** 下拉里给的档位。够覆盖"扫一眼"到"回溯一小时" */
export const LOG_LINE_OPTIONS = [50, 100, 200, 500, 1000, 2000, 5000]

/**
 * 往回读的上限（字节）。
 * 5000 行的日志一般不超 2MB，8MB 是很宽裕的天花板；
 * 再往上就是"用户其实想要整份文件"，那该下载而不是在这里翻。
 */
export const LOG_MAX_TAIL_BYTES = 8 * 1024 * 1024

/** readTail 的返回值 */
export interface TailContent {
  /** 末尾若干行（已按文件编码解码，行之间用 \n 连） */
  content: string
  /** 实际给了多少行（文件太短时会少于请求值） */
  lines: number
  /** 文件总字节数 */
  size: number
  /** 前面还有内容没取到（文件比请求的行数更长） */
  truncated: boolean
  /** 文件的编码：日志的尾巴上没有 BOM，编码是从文件头单独嗅的 */
  encoding: TextEncoding
}

/**
 * readFile 的返回值。
 *
 * 为什么不是裸字符串：Windows 上的 .ini / .reg / .bat 常常是 UTF-16（记事本"Unicode"另存），
 * 只返回内容的话保存时只能猜编码 —— 猜错就等于把文件写坏，读它的老程序整份乱码。
 * 所以把"读进来时是什么编码、带不带 BOM"一起带出来，界面原样交回 writeFile。
 */
export interface TextFileContent {
  content: string
  encoding: TextEncoding
  /** 原文件带 BOM：保存时补回去 */
  bom: boolean
}

/** 目录递归上传的汇总结果 */
export interface DirUploadResult {
  total: number
  uploaded: number
  failed: { path: string; message: string }[]
  skipped: number
  bytes: number
  /** 用户中途取消。剪切模式下调用方不能因为"部分成功"就去删源 */
  canceled?: boolean
}

/** 粘贴模式：复制会保留源，剪切成功后删掉源 */
export type PasteMode = 'copy' | 'cut'

/** 同栏粘贴（本地↔本地、远程↔远程）的汇总结果 */
export interface PasteResult {
  done: number
  failed: { path: string; message: string }[]
}

/** 「跳转」菜单里的一项：常用位置或盘符 */
export interface Place {
  label: string
  path: string
  kind: 'place' | 'drive'
}

// ---------- Docker ----------

export interface DockerProbe {
  /** 机器上有没有 docker 命令 */
  available: boolean
  /** 客户端版本字符串（docker --version 原文） */
  version: string
  /** compose 版本，没有则为空 */
  compose: string
  /** daemon 版本 */
  serverVersion: string
  /** daemon 不可用时的原因（没权限 / 没启动），用于提示 */
  error: string
}

export interface DockerInfo {
  name: string
  serverVersion: string
  operatingSystem: string
  kernelVersion: string
  architecture: string
  driver: string
  rootDir: string
  cpus: number
  /** 字节 */
  memoryTotal: number
  containers: number
  running: number
  paused: number
  stopped: number
  images: number
  swarm: boolean
  warnings: string
}

/** docker system df 的一行 */
export interface DockerDfRow {
  type: string
  total: number
  active: number
  size: string
  reclaimable: string
}

export interface DockerOverview {
  info: DockerInfo
  df: DockerDfRow[]
}

export interface DockerContainer {
  id: string
  name: string
  image: string
  command: string
  /** running / exited / paused / created / restarting / dead */
  state: string
  status: string
  ports: string
  created: string
  runningFor: string
  networks: string
  mounts: string
  labels: string
}

export interface DockerImage {
  id: string
  repository: string
  tag: string
  created: string
  size: string
  digest: string
}

export interface DockerNetwork {
  id: string
  name: string
  driver: string
  scope: string
  internal: boolean
}

export interface DockerVolume {
  name: string
  driver: string
  scope: string
}

export interface DockerComposeProject {
  name: string
  status: string
  configFiles: string
}

export interface DockerStats {
  cpu: string
  mem: string
  memPerc: string
  netIO: string
  blockIO: string
  pids: string
}

export interface DockerContainerDetail {
  /** docker inspect 的第一条（原始对象），界面按需取字段 */
  inspect: unknown
  stats: DockerStats | null
  raw: string
}

/** preload 暴露到 window.api 上的完整接口 */
/** 「关于」弹窗用的版本档案。运行时版本只有主进程知道（preload 里拿不到 app 版本），所以走 IPC */
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
}

export interface ThShellApi {
  config: {
    load: () => Promise<AppConfig>
    save: (config: AppConfig) => Promise<void>
    exportConfig: () => Promise<string | null>
    importConfig: () => Promise<AppConfig | null>
  }
  /** 原生窗口主题（Windows 标题栏颜色）：跟随应用内主题切换 */
  theme: {
    set: (theme: 'light' | 'dark' | 'system') => Promise<void>
  }
  ssh: {
    connect: (config: ServerConfig, cols?: number, rows?: number) => Promise<string>
    disconnect: (sessionId: string) => Promise<void>
    write: (sessionId: string, data: string) => void
    resize: (sessionId: string, cols: number, rows: number) => void
    exec: (sessionId: string, command: string) => Promise<ExecResult>
    metrics: (sessionId: string) => Promise<MetricSnapshot | null>
    sysinfo: (sessionId: string) => Promise<SystemInfo | null>
    procs: (sessionId: string) => Promise<ProcSnapshot>
    killProc: (sessionId: string, pid: number, force: boolean) => Promise<string>
    onData: (cb: (payload: { sessionId: string; data: string }) => void) => () => void
    onState: (cb: (payload: SessionState) => void) => () => void
  }
  /**
   * 系统页上的写操作（挂载磁盘 / 配置网卡）。
   * 单独开一个命名空间而不是挂进 ssh：这两个是"会改远端机器"的动作，
   * 出问题时需要一眼看出调用的是只读采集还是写操作。
   */
  syscfg: {
    disks: (sessionId: string) => Promise<UnmountedDisk[]>
    mount: (sessionId: string, req: MountRequest) => Promise<ConfigResult>
    netConfig: (sessionId: string, device: string) => Promise<NetConfigInfo>
    netApply: (sessionId: string, req: NetConfigApply) => Promise<ConfigResult>
  }
  /**
   * 系统服务（systemd）。
   * 单独一层而不是塞进 ssh：这里会改远端机器的运行状态，
   * 和 ssh.exec 那种"随便跑条命令"的性质要分开。
   */
  services: {
    list: (sessionId: string) => Promise<ServiceSnapshot>
    action: (sessionId: string, name: string, action: ServiceAction) => Promise<string>
    /** 某个服务的 journalctl 日志；不传 since 就是首屏 */
    logs: (sessionId: string, name: string, query: ServiceLogQuery) => Promise<ServiceLogResult>
  }
  /**
   * 本地终端（本机 shell，走 PTY）。
   * 和 ssh 分开而不是塞进 ssh 命名空间：两者生命周期、错误语义都不一样，
   * 混在一起以后排查"这个 sessionId 到底是远程还是本地"会很烦。
   */
  shell: {
    open: (cols?: number, rows?: number) => Promise<LocalShellInfo>
    close: (sessionId: string) => Promise<boolean>
    write: (sessionId: string, data: string) => void
    resize: (sessionId: string, cols: number, rows: number) => void
    onData: (cb: (payload: { sessionId: string; data: string }) => void) => () => void
    onExit: (
      cb: (payload: { sessionId: string; exitCode: number; signal?: number }) => void
    ) => () => void
  }
  sftp: {
    list: (sessionId: string, remotePath: string) => Promise<FileEntry[]>
    download: (sessionId: string, remotePath: string, localPath: string) => Promise<string>
    downloadDir: (
      sessionId: string,
      remotePath: string,
      localPath: string
    ) => Promise<DirDownloadResult>
    upload: (sessionId: string, localPath: string, remotePath: string) => Promise<string>
    uploadDir: (
      sessionId: string,
      localDir: string,
      remotePath: string
    ) => Promise<DirUploadResult>
    /** 远程内部复制/移动（服务端 cp / mv，不走网络） */
    paste: (
      sessionId: string,
      srcPaths: string[],
      destDir: string,
      mode: PasteMode
    ) => Promise<PasteResult>
    mkdir: (sessionId: string, remotePath: string) => Promise<void>
    remove: (sessionId: string, remotePath: string, isDir: boolean) => Promise<void>
    rename: (sessionId: string, oldPath: string, newPath: string) => Promise<void>
    readFile: (sessionId: string, remotePath: string) => Promise<TextFileContent>
    /**
     * 只读文件末尾若干行（日志查看用）。
     * 从文件末尾往回倒着读，不整份载入 —— 几百 MB 的日志照样秒开。
     */
    readTail: (sessionId: string, remotePath: string, lines?: number) => Promise<TailContent>
    /** 原始字节（base64），办公文档预览用；readFile 会按 UTF-8 解码并拒绝二进制 */
    readBinary: (sessionId: string, remotePath: string) => Promise<BinaryFile>
    /**
     * 写回远程文件。encoding / bom 由 readFile 一起返回、界面原样带回来 ——
     * UTF-16 的配置文件被改写成 UTF-8，读它的服务就整份乱码了。
     */
    writeFile: (
      sessionId: string,
      remotePath: string,
      content: string,
      encoding?: TextEncoding,
      bom?: boolean
    ) => Promise<void>
    /** 当前登录用户对该文件有没有写权限（服务器上跑 test -w），决定保存按钮是否可点 */
    canWrite: (sessionId: string, remotePath: string) => Promise<boolean>
    onProgress: (cb: (p: TransferProgress) => void) => () => void
  }
  /** 传输记录（已结束的上传/下载，落盘保存） */
  transfer: {
    list: () => Promise<TransferRecord[]>
    clear: () => Promise<TransferRecord[]>
    /** 主进程写入一条新记录时回调，界面据此刷新列表 */
    onChanged: (cb: () => void) => () => void
    /**
     * 暂停 / 继续 / 取消。参数是 `transferId`（进度事件里带的那个）。
     * 返回 false 表示这条已经在收尾了（找不到控制对象），不是错误，按钮照常失效即可。
     */
    pause: (transferId: string) => Promise<boolean>
    resume: (transferId: string) => Promise<boolean>
    cancel: (transferId: string) => Promise<boolean>
  }
  local: {
    home: () => Promise<string>
    list: (dirPath: string) => Promise<FileEntry[]>
    mkdir: (dirPath: string) => Promise<void>
    remove: (targetPath: string) => Promise<void>
    rename: (oldPath: string, newPath: string) => Promise<void>
    readFile: (filePath: string) => Promise<TextFileContent>
    /** 只读文件末尾若干行（日志查看用），同上：从末尾倒着读，不整份载入 */
    readTail: (filePath: string, lines?: number) => Promise<TailContent>
    readBinary: (filePath: string) => Promise<BinaryFile>
    writeFile: (
      filePath: string,
      content: string,
      encoding?: TextEncoding,
      bom?: boolean
    ) => Promise<void>
    /** 本地文件是否可写（fs.access W_OK），决定保存按钮是否可点 */
    canWrite: (filePath: string) => Promise<boolean>
    openPath: (targetPath: string) => Promise<void>
    /** 在系统文件管理器中定位该路径 */
    reveal: (targetPath: string) => Promise<void>
    drives: () => Promise<string[]>
    /** 常用位置 + 盘符，供路径栏的跳转菜单使用 */
    places: () => Promise<Place[]>
    /** 本地内部复制/移动 */
    paste: (srcPaths: string[], destDir: string, mode: PasteMode) => Promise<PasteResult>
  }
  dialog: {
    pickFiles: () => Promise<string[]>
    /** defaultPath 传当前目录，对话框会直接定位过去 */
    pickDir: (defaultPath?: string) => Promise<string | null>
    pickSave: (defaultName: string) => Promise<string | null>
  }
  clipboard: {
    read: () => Promise<string>
    write: (text: string) => Promise<void>
  }
  docker: {
    probe: (sessionId: string) => Promise<DockerProbe>
    overview: (sessionId: string) => Promise<DockerOverview>
    containers: (sessionId: string) => Promise<DockerContainer[]>
    containerAction: (
      sessionId: string,
      id: string,
      action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove',
      force?: boolean
    ) => Promise<string>
    containerLogs: (sessionId: string, id: string, tail?: number, since?: string) => Promise<string>
    containerDetail: (sessionId: string, id: string) => Promise<DockerContainerDetail>
    images: (sessionId: string) => Promise<DockerImage[]>
    pullImage: (sessionId: string, ref: string) => Promise<string>
    removeImage: (sessionId: string, ref: string, force?: boolean) => Promise<string>
    networks: (sessionId: string) => Promise<DockerNetwork[]>
    volumes: (sessionId: string) => Promise<DockerVolume[]>
    removeNetwork: (sessionId: string, id: string) => Promise<string>
    removeVolume: (sessionId: string, name: string) => Promise<string>
    compose: (sessionId: string) => Promise<DockerComposeProject[]>
    prune: (
      sessionId: string,
      target: 'container' | 'image' | 'volume' | 'builder' | 'all'
    ) => Promise<string>
  }
  app: {
    version: () => Promise<string>
    platform: () => Promise<string>
    /** 「关于」弹窗要的整份版本档案：应用版本 + 运行时三件套 */
    info: () => Promise<AppInfo>
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
  }
  /** 检查更新 / 下载 / 安装。全部走主进程：渲染层不碰文件系统，也拿不到安装包路径 */
  update: {
    check: (feed: string) => Promise<UpdateCheckResult>
    download: (asset: UpdateAsset) => Promise<{ path: string } | null>
    /** 取消正在进行的下载 */
    cancel: () => void
    /** 启动安装包（Windows 直接拉起安装程序；其它平台打开所在目录） */
    install: (filePath: string) => Promise<string>
    onProgress: (cb: (p: UpdateProgress) => void) => () => void
  }
}
