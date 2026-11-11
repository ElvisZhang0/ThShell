/**
 * 文件「是什么类型」的判定 —— 只回答种类，不回答图标长什么样。
 *
 * 为什么单独一层：图标（哪个 SVG、什么颜色）是设计问题，改起来频繁；
 * 而"这个扩展名算图片还是算压缩包"是事实问题，会被预览路由、属性面板、
 * 右键菜单一起用。混在一起的话，调个图标颜色都要动到路由逻辑。
 *
 * 判定只看扩展名（外加一小撮确定是日志的无扩展名文件名），够快也够用：
 * 列表里逐行调用，不能去读文件头。
 */

export type FileKind =
  | 'folder'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'archive'
  | 'code'
  | 'config'
  | 'log'
  | 'text'
  | 'font'
  | 'db'
  | 'exe'
  | 'key'
  | 'other'

/** 图片：能直接在预览面板里看的 */
const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif',
  // 相机 RAW / 设计稿：浏览器多半解不了，但归到图片类至少图标是对的、双击也不该去开编辑器
  'tif', 'tiff', 'heic', 'heif', 'psd', 'ai', 'raw', 'cr2', 'nef'
])

/** 能真正在 <img> 里画出来的图片（其余归到"图片但预览不了"，双击交给系统） */
const IMAGE_VIEWABLE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif'
])

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mpg', 'mpeg', 'rmvb', '3gp', 'm2ts'
])

const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a', 'wma', 'aiff', 'ape'])

const DOC_EXT = new Set(['doc', 'docx', 'rtf', 'odt', 'pages', 'wps', 'epub'])

const SHEET_EXT = new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods', 'numbers'])

const SLIDE_EXT = new Set(['ppt', 'pptx', 'pps', 'ppsx', 'odp', 'key'])

const ARCHIVE_EXT = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'xz', 'txz', 'zst', 'lz4', 'cab',
  // 镜像文件本质就是"打包好的整盘"，和压缩包归一类最省事
  'iso', 'img', 'dmg', 'jar', 'war', 'apk', 'deb', 'rpm'
])

const CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte',
  'py', 'rb', 'pl', 'lua', 'php', 'tcl', 'r', 'jl', 'dart', 'swift', 'kt', 'kts', 'scala', 'groovy',
  'java', 'go', 'rs', 'cs', 'fs', 'vb', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm',
  'sql', 'graphql', 'gql', 'proto', 'tf', 'tfvars', 'hcl',
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'bat', 'cmd', 'ps1', 'psm1',
  'css', 'scss', 'sass', 'less', 'styl',
  'html', 'htm', 'xhtml', 'shtml', 'vue', 'astro',
  'lua', 'asm', 's', 'v', 'sv', 'vhd', 'verilog'
])

const CONFIG_EXT = new Set([
  'conf', 'cfg', 'config', 'ini', 'properties', 'env', 'service', 'unit', 'socket', 'timer',
  'target', 'mount', 'desktop', 'reg', 'toml', 'json', 'jsonc', 'json5', 'yml', 'yaml',
  'plist', 'gitignore', 'dockerignore', 'editorconfig'
])

const FONT_EXT = new Set(['ttf', 'otf', 'woff', 'woff2', 'eot', 'ttc', 'fon'])

const DB_EXT = new Set(['db', 'sqlite', 'sqlite3', 'mdb', 'accdb', 'dbf', 'dump', 'bak'])

const EXE_EXT = new Set(['exe', 'msi', 'bin', 'run', 'com', 'scr', 'app'])

const KEY_EXT = new Set(['pem', 'crt', 'cer', 'key', 'p12', 'pfx', 'pub', 'asc', 'gpg', 'keystore', 'jks'])

const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'mdown', 'mkd', 'rst', 'adoc', 'org', 'tex', 'bib',
  'diff', 'patch', 'nfo', 'srt', 'vtt'
])

/** 没有扩展名但一定是文本的名字（README / LICENSE 这类） */
const NO_EXT_TEXT = new Set(['readme', 'license', 'licence', 'changelog', 'authors', 'copying', 'todo', 'notice'])

/** 没有扩展名但一定是配置的名字 */
const NO_EXT_CONFIG = new Set([
  'dockerfile', 'containerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'jenkinsfile',
  'vagrantfile', 'cmakelists.txt', 'hosts', 'hostname', 'passwd', 'shadow', 'group', 'gshadow',
  'fstab', 'mtab', 'crontab', 'crond', 'resolv.conf', 'nsswitch.conf', 'config'
])

/** 没有扩展名、但一眼就知道是日志的名字（和 editable.ts 的名单保持一致，避免两处判得不一样） */
const LOG_NAMES = new Set(['messages', 'syslog', 'secure', 'maillog', 'dmesg', 'boot.log', 'kern.log', 'daemon.log', 'auth.log', 'debug'])
const LOG_EXT = new Set(['log', 'log1', 'log2', 'out', 'err', 'nohup', 'trace'])

function extOf(name: string): string {
  const lower = name.trim().toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot > 0 ? lower.slice(dot + 1) : ''
}

export function fileExt(name: string): string {
  return extOf(name)
}

/** 是不是图片（含解不了的 RAW/PSD —— 它们只是"预览不了"，不是"不是图片"） */
export function isImageFile(name: string): boolean {
  return IMAGE_EXT.has(extOf(name))
}

/**
 * 能不能在应用内预览。
 * SVG 也算：放进 <img> 里渲染不会执行脚本，是安全的 —— 只有当它是 <object>/<iframe>
 * 或者被内联进 DOM 时才有脚本风险。
 */
export function isViewableImage(name: string): boolean {
  return IMAGE_VIEWABLE_EXT.has(extOf(name))
}

export function imageMime(name: string): string {
  return MIME_BY_EXT[extOf(name)] ?? 'application/octet-stream'
}

/** 归类。目录优先，其次按扩展名；都没有就是 other */
export function kindOf(name: string, isDir = false): FileKind {
  if (isDir) return 'folder'
  const lower = name.trim().toLowerCase()
  const ext = extOf(lower)

  // 日志先判：.log 比 .txt 更具体，而且它决定双击走只读查看器。
  // 但 `.log.gz` 这种压缩过的要留给压缩包 —— 双击它应该是下载，不是"看末尾"（那是二进制）
  if (
    LOG_EXT.has(ext) ||
    LOG_NAMES.has(lower) ||
    /\.log(\.\d+)?$/.test(lower) ||
    /\.log[.-]\d{4}[-.]?\d{2}[-.]?\d{2}/.test(lower)
  ) {
    return 'log'
  }

  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (DOC_EXT.has(ext)) return 'doc'
  if (SHEET_EXT.has(ext)) return 'sheet'
  if (SLIDE_EXT.has(ext)) return 'slide'
  if (ARCHIVE_EXT.has(ext)) return 'archive'
  if (DB_EXT.has(ext)) return 'db'
  if (KEY_EXT.has(ext)) return 'key'
  if (FONT_EXT.has(ext)) return 'font'
  if (EXE_EXT.has(ext)) return 'exe'
  if (CODE_EXT.has(ext)) return 'code'
  if (CONFIG_EXT.has(ext)) return 'config'
  if (TEXT_EXT.has(ext)) return 'text'

  // 没有扩展名的常见文件：Makefile / Dockerfile / hosts / README 之类
  if (NO_EXT_CONFIG.has(lower)) return 'config'
  if (NO_EXT_TEXT.has(lower)) return 'text'
  return 'other'
}

/** 属性面板里显示的中文类型名 */
const KIND_LABEL: Record<FileKind, string> = {
  folder: '文件夹',
  image: '图片',
  video: '视频',
  audio: '音频',
  pdf: 'PDF 文档',
  doc: '文档',
  sheet: '表格',
  slide: '演示文稿',
  archive: '压缩包 / 镜像',
  code: '源代码',
  config: '配置文件',
  log: '日志',
  text: '文本',
  font: '字体',
  db: '数据库',
  exe: '程序 / 安装包',
  key: '证书 / 密钥',
  other: '文件'
}

export function kindLabel(kind: FileKind): string {
  return KIND_LABEL[kind] ?? '文件'
}
