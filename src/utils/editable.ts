/**
 * 「这个文件能不能用内置编辑器打开」的判定。
 *
 * 只按扩展名白名单 + 大小上限判，图的是快（列表里逐行调用也不心疼）。
 * 真正的"是不是文本、是什么编码"由主进程读过前 8KB 再兜一层 ——
 * 扩展名可以骗人（.log 里塞二进制、无扩展名的 core dump），两层各管一半，别合并。
 */

import { EDIT_MAX_BYTES, EDIT_WARN_BYTES, LOG_DEFAULT_LINES, LOG_LINE_OPTIONS } from '../../electron/types'

// 体积上限放在 electron/types.ts 里，主进程和渲染层共用一个数字，别在这里再写一份
export { EDIT_MAX_BYTES, EDIT_WARN_BYTES, LOG_DEFAULT_LINES, LOG_LINE_OPTIONS }

/** 文本类扩展名（小写、不含点） */
const TEXT_EXT = new Set([
  // 纯文本 / 日志 / 配置
  'txt', 'text', 'log', 'log1', 'conf', 'cfg', 'config', 'ini', 'properties', 'env', 'service',
  'unit', 'socket', 'timer', 'target', 'mount', 'list', 'repo', 'desktop', 'reg',
  // 结构化数据
  'json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'xml', 'csv', 'tsv', 'plist', 'proto',
  // 文档 / 标记
  'md', 'markdown', 'rst', 'adoc', 'org', 'tex', 'bib', 'html', 'htm', 'xhtml', 'shtml', 'svg',
  // 脚本 / 代码
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'py', 'rb', 'pl', 'lua', 'php', 'tcl',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte',
  'css', 'scss', 'sass', 'less', 'styl',
  'java', 'kt', 'kts', 'groovy', 'gradle', 'scala', 'go', 'rs', 'cs', 'fs', 'vb',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', 'swift', 'dart', 'r', 'jl',
  'sql', 'graphql', 'gql', 'tf', 'tfvars', 'hcl', 'dockerfile', 'gitignore', 'editorconfig',
  // 补丁 / 证书（都是文本，就地改过再贴回去很常见）
  'diff', 'patch', 'pem', 'crt', 'cer', 'pub', 'asc', 'key'
])

/**
 * 没有扩展名、但一定是文本的文件名（Unix 配置和构建文件的常态）。
 * 判断前统一转小写。
 */
const TEXT_NAMES = new Set([
  'dockerfile', 'containerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'jenkinsfile',
  'vagrantfile', 'brewfile', 'cmakelists.txt',
  'hosts', 'hostname', 'hosts.allow', 'hosts.deny', 'passwd', 'shadow', 'group', 'gshadow',
  'fstab', 'mtab', 'crontab', 'resolv.conf', 'nsswitch.conf',
  'authorized_keys', 'known_hosts', 'sshd_config', 'ssh_config', 'config',
  'nginx.conf', 'httpd.conf', 'my.cnf', 'redis.conf',
  '.gitconfig', '.gitignore', '.gitattributes', '.gitmodules', '.npmrc', '.yarnrc',
  '.bashrc', '.bash_profile', '.bash_logout', '.zshrc', '.zprofile', '.profile', '.vimrc',
  '.editorconfig', '.env', '.env.local', '.dockerignore', '.eslintrc', '.prettierrc'
])

/**
 * @param name 文件名（不是路径）
 * @param size 字节数；列表里拿不到时省略，只看扩展名
 */
export function isEditableText(name: string, size?: number): boolean {
  if (size != null && size > EDIT_MAX_BYTES) return false
  const lower = name.trim().toLowerCase()
  if (!lower) return false
  if (TEXT_NAMES.has(lower)) return true
  const dot = lower.lastIndexOf('.')
  // dot < 0：没有扩展名；dot === 0：.gitignore 这类点开头的，只能靠上面的名单
  if (dot <= 0 || dot === lower.length - 1) return false
  return TEXT_EXT.has(lower.slice(dot + 1))
}

/** 给提示语用的体积上限文案 */
export const EDIT_MAX_TEXT = `${Math.round(EDIT_MAX_BYTES / 1024 / 1024)}MB`

/**
 * 「双击该不该进只读日志查看器」。
 *
 * 日志不走编辑器，和体积无关：几百 MB 的 nginx access.log 是常态，
 * 而看日志的人只关心最后几十行。所以这里没有 size 参数 —— 再大也照样双击就开。
 *
 * 认得的不只是 `.log`：
 * - `app.log` / `app.log.1`（logrotate 的轮转）/ `app.log-2026-11-10`（按日期切）
 * - `.out` / `.err` / `.nohup`：nohup、systemd 重定向、各种"手工记日志"的产物
 * - `messages` / `syslog` / `secure`：没有扩展名的系统日志
 * 压缩过的（`.log.gz`）不算：那是二进制，双击会落到"下载"分支。
 */
const LOG_EXT = new Set(['log', 'log1', 'log2', 'out', 'err', 'nohup', 'trace'])

/**
 * 没有扩展名但一定是日志的文件名。
 * 故意不把 `cron`、`errors` 这类名字收进来 —— `/etc/cron.d/` 下真有一堆叫 `cron` 的
 * 计划任务配置，把它们也变成"只读查看"就是倒退。宁漏不错。
 */
const LOG_NAMES = new Set([
  'messages',
  'syslog',
  'secure',
  'maillog',
  'dmesg',
  'boot.log',
  'kern.log',
  'daemon.log',
  'auth.log',
  'debug'
])

/** 取扩展名（小写、不含点）；没有扩展名返回空串 */
function extOf(name: string): string {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot > 0 ? lower.slice(dot + 1) : ''
}

export function isLogFile(name: string): boolean {
  const lower = name.trim().toLowerCase()
  if (!lower) return false
  if (LOG_NAMES.has(lower)) return true
  // app.log / app.log.1 / nginx.access.log.2.gz 里最后那种会被下一行的 ext 判掉
  if (/\.log(\.\d+)?$/.test(lower)) return true
  // app.log-2026-11-10 / app.log.2026-11-10
  if (/\.log[.-]\d{4}[-.]?\d{2}[-.]?\d{2}/.test(lower)) return true
  return LOG_EXT.has(extOf(lower))
}

/* ---------------- 办公文档 / PDF（只读预览） ---------------- */

/**
 * docx / xlsx / xls / pdf 能真渲染；pptx / ppt / doc 只给提示（没有靠谱的纯前端渲染器）。
 * PDF 走 pdf.js，本质上也是"二进制只读预览"，所以并进同一套路由。
 */
const OFFICE_PREVIEW_EXT = new Set(['docx', 'xlsx', 'xls', 'xlsm', 'pdf'])
const OFFICE_OTHER_EXT = new Set(['pptx', 'ppt', 'doc'])

/** markdown 扩展名：这几个走「左编辑 / 右实时预览」分栏 */
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn'])

/** 是不是 markdown（决定编辑器要不要开分栏预览） */
export function isMarkdown(name: string): boolean {
  return MARKDOWN_EXT.has(extOf(name))
}

/** 是不是 PDF */
export function isPdf(name: string): boolean {
  return extOf(name) === 'pdf'
}

/** 是不是办公文档（含只能提示的那几种） */
export function isOfficeDoc(name: string): boolean {
  const ext = extOf(name)
  return OFFICE_PREVIEW_EXT.has(ext) || OFFICE_OTHER_EXT.has(ext)
}

/** 是不是能真渲染出内容的办公文档 */
export function isOfficePreviewable(name: string): boolean {
  return OFFICE_PREVIEW_EXT.has(extOf(name))
}

/**
 * 「双击 / 右键预览」该走只读预览面板的文件类型 —— 办公文档 + PDF。
 * 单独抽出来是为了让调用处读起来是"要不要预览"，而不是"是不是 office"，
 * 否则 PDF 会被塞进一个叫 isOfficeDoc 的分支里，看着像 bug。
 */
export function isReadonlyPreviewDoc(name: string): boolean {
  return isOfficeDoc(name)
}
