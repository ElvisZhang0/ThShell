<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowLeft,
  CaretBottom,
  CopyDocument,
  Delete,
  Download,
  EditPen,
  FolderAdd,
  FolderOpened,
  InfoFilled,
  Monitor,
  Refresh,
  Tickets,
  Upload,
  View
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore, cleanError } from '../stores/app'
import type { Tab } from '../stores/app'
import { useDialogWindow } from '../utils/dialog-win'
import WinControls from './WinControls.vue'
import type { FileEntry, Place, TextEncoding } from '../../electron/types'
import {
  EDIT_MAX_BYTES,
  EDIT_MAX_TEXT,
  EDIT_WARN_BYTES,
  LOG_DEFAULT_LINES,
  LOG_LINE_OPTIONS,
  isEditableText,
  isLogFile,
  isMarkdown,
  isOfficePreviewable,
  isPdf,
  isReadonlyPreviewDoc
} from '../utils/editable'
import { isImageFile, isViewableImage, kindLabel, kindOf } from '../utils/file-kind'
import FileContextMenu from './FileContextMenu.vue'
import CodeEditor from './CodeEditor.vue'
import RenameIcon from './RenameIcon.vue'
import FileTypeIcon from './FileTypeIcon.vue'
import ImagePreview from './ImagePreview.vue'
import OfficePreview from './OfficePreview.vue'
import MarkdownPreview from './MarkdownPreview.vue'
import PdfPreview from './PdfPreview.vue'
import { formatSize } from '../utils/transfer-format'
import type { MenuItem } from './FileContextMenu.vue'

/** 内置编辑器的视图模式：只有 markdown 用得上分栏/纯预览 */
type EditViewMode = 'editor' | 'split' | 'preview'
const viewModes: { key: EditViewMode; label: string }[] = [
  { key: 'editor', label: '编辑' },
  { key: 'split', label: '分栏' },
  { key: 'preview', label: '预览' }
]

const props = defineProps<{ tab: Tab }>()
const store = useAppStore()

const localPath = ref('')
const remotePath = ref('')
const localEntries = ref<FileEntry[]>([])
const remoteEntries = ref<FileEntry[]>([])
const localSelected = ref<FileEntry | null>(null)
const remoteSelected = ref<FileEntry | null>(null)
const loadingLocal = ref(false)
const loadingRemote = ref(false)
const busy = ref(false)

/** 远程 $HOME，用于「跳转 → 主目录」，连接后才知道 */
const remoteHome = ref('')

/** 本地常用位置 + 盘符，打开下拉时刷新（中途插拔 U 盘也能看到） */
const places = ref<Place[]>([])
const placeItems = computed(() => places.value.filter((p) => p.kind === 'place'))
const driveItems = computed(() => places.value.filter((p) => p.kind === 'drive'))

const remotePlaces = computed(() => {
  const list = [
    { label: '主目录', path: remoteHome.value },
    { label: '根目录', path: '/' },
    { label: '临时文件', path: '/tmp' },
    { label: '系统日志', path: '/var/log' },
    { label: '配置文件', path: '/etc' },
    { label: '第三方软件', path: '/opt' },
    { label: '用户目录', path: '/home' }
  ]
  return list.filter((p) => !!p.path)
})

/**
 * 内置编辑器。本地和远程共用同一个弹窗，靠 `side` 决定读/写走哪个 API。
 * `original` 留着做未保存判断：只有当内容真变了才算脏，来回切换不会被无谓地拦。
 */
const editDialog = ref({
  visible: false,
  side: 'remote' as 'local' | 'remote',
  path: '',
  name: '',
  content: '',
  original: '',
  saving: false,
  /**
   * 当前用户是否有写权限。读文件时顺手探测一次，没权限就：
   * 编辑器只读 + 保存按钮禁用 —— 不要让人改半天点保存才吃一个 Permission denied。
   */
  writable: true,
  /**
   * 读进来时的编码。Windows 的 .ini / .reg 常常是 UTF-16，
   * 保存要按原样写回去，否则读它的老程序整份乱码。
   */
  encoding: 'utf-8' as TextEncoding,
  /** 原文件带 BOM：保存时补回去 */
  bom: false,
  /** markdown 才有意义：编辑 / 分栏 / 预览 */
  viewMode: 'editor' as EditViewMode
})

/** 办公文档预览（只读）：内容只在打开时读一次，不做脏标记 */
const previewDialog = ref({
  visible: false,
  side: 'remote' as 'local' | 'remote',
  path: '',
  name: '',
  base64: '',
  size: 0
})
const previewLoading = ref(false)
/** 三种二进制预览共用一个对话框，标签要能区分开（不然图片会显示成"只读预览"） */
const previewRenderable = computed(
  () => isViewableImage(previewDialog.value.name) || isOfficePreviewable(previewDialog.value.name)
)
const previewTag = computed(() => {
  const name = previewDialog.value.name
  if (isViewableImage(name)) return '图片预览'
  if (!isOfficePreviewable(name)) return '不支持预览'
  return isPdf(name) ? 'PDF 预览' : '只读预览'
})

const editDirty = computed(() => editDialog.value.content !== editDialog.value.original)
/** markdown 才给分栏预览；其它文件预览栏根本不挂载 */
const editIsMarkdown = computed(() => isMarkdown(editDialog.value.name))
const editSplit = computed(() => editIsMarkdown.value && editDialog.value.viewMode === 'split')
/** md 分栏要横向空间，普通文件仍用原来的宽度 */
const editDialogWidth = computed(() => (editIsMarkdown.value ? 'min(1360px, 95vw)' : 'min(1100px, 88vw)'))

/* 三个弹窗各自的窗口态（最小化 / 最大化）。打开新文件前要 reset，
   否则上一次最大化开着、这次点开另一个文件会直接顶满屏幕 */
const editWin = useDialogWindow()
const logWin = useDialogWindow()
const previewWin = useDialogWindow()

/** 最大化时铺满窗口：宽度和 `top` 走 prop，高度和内部撑满走 .max 那套 CSS */
const MAX_WIDTH = 'calc(100vw - 18px)'
const MAX_TOP = '9px'
/**
 * 按文件真实编码算字节数。
 * 之前一律用 `new Blob([content]).size`，那是 UTF-8 的字节数 ——
 * UTF-16 的 .ini 会显示成一个比实际大不少的数字，跟「UTF-16 LE」标签自相矛盾。
 *
 * 改成"停手 250ms 再算"：这个数只是给底栏看的，而 20MB 的文件每敲一个字都
 * 走一遍全量计算（Blob 方式还会整份复制）就是白白丢掉一次 GC。
 */
const editBytes = ref(0)
let bytesTimer = 0
watch(
  () => [editDialog.value.content, editDialog.value.encoding, editDialog.value.bom] as const,
  ([content, encoding, bom]) => {
    window.clearTimeout(bytesTimer)
    bytesTimer = window.setTimeout(() => {
      editBytes.value = countBytes(content, encoding) + (bom ? (encoding === 'utf-8' ? 3 : 2) : 0)
    }, 200)
  },
  { immediate: true }
)

/** UTF-8 要逐字符算（代理对算 4 字节），UTF-16 一个码元就是 2 字节 */
function countBytes(text: string, encoding: TextEncoding): number {
  if (encoding !== 'utf-8') return text.length * 2
  let n = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      // 高低代理各是两个码元合起来 4 字节，跳过低位那个
      n += 4
      i += 1
    } else n += 3
  }
  return n
}
/**
 * 读进来时的编码。界面上要显示出来：UTF-16 的 .ini 以前会被"这不是文本文件"挡掉，
 * 现在能打开了，得让人知道它是什么编码 —— 也等于承诺"保存会按原编码写回去"。
 */
const editEncodingLabel = computed(() => {
  const map: Record<TextEncoding, string> = {
    'utf-8': 'UTF-8',
    'utf-16le': 'UTF-16 LE',
    'utf-16be': 'UTF-16 BE'
  }
  return map[editDialog.value.encoding] ?? 'UTF-8'
})

/**
 * 「这个条目双击应该怎么开」—— 只有一个判定入口。
 *
 * 以前这段三选一的判断在六个地方各写了一遍（双击本地、双击远程、底栏按钮、
 * 按钮图标、按钮文案、右键菜单），结果就是一边改了另一边忘了：
 * 右键「预览文档」就曾经写死成 `openReadonlyPreview('local', …)`，
 * 在远程那栏点它会去本地找一个同名文件。
 */
type OpenMode = 'enter' | 'image' | 'doc' | 'log' | 'edit' | 'system'

function openModeOf(entry: FileEntry): OpenMode {
  if (entry.isDir) return 'enter'
  if (isViewableImage(entry.name)) return 'image'
  if (isReadonlyPreviewDoc(entry.name)) return 'doc'
  if (isLogFile(entry.name)) return 'log'
  if (isEditableText(entry.name, entry.size)) return 'edit'
  // 剩下的（压缩包、程序、解不了的 RAW/PSD）交给系统默认程序
  return 'system'
}

/** 应用内能打开的那几种 */
function openableInApp(entry: FileEntry): boolean {
  return ['image', 'doc', 'log', 'edit'].includes(openModeOf(entry))
}

/** 底栏「打开」按钮的可用性 */
const canOpenLocal = computed(() => {
  const e = localSelected.value
  return !!e && !e.isDir && openableInApp(e)
})
const canOpenRemote = computed(() => {
  const e = remoteSelected.value
  return !!e && !e.isDir && openableInApp(e)
})

/**
 * 底栏那个按钮的图标和文案跟着文件类型变 ——
 * 眼睛就是「看」，笔就是「改」，两者不能互换：
 * - 文本 → 笔（在编辑器中打开）
 * - 日志 → 眼睛（只读看末尾）
 * - office / PDF / 图片 → 眼睛（只读预览）
 * 以前这里是"重命名用笔、编辑用眼睛"，正好反着，看着就别扭。
 */
function pickOpenIcon(e: FileEntry | null) {
  if (!e) return EditPen
  return openModeOf(e) === 'edit' ? EditPen : View
}

function pickOpenLabel(e: FileEntry | null): string {
  if (!e) return '编辑'
  switch (openModeOf(e)) {
    case 'image':
      return '预览图片'
    case 'doc':
      return '预览文档'
    case 'log':
      return '查看日志'
    default:
      return '编辑'
  }
}

/** 应用内打开（底栏按钮 / 双击 / 右键都从这里走） */
async function openInApp(side: 'local' | 'remote', entry: FileEntry) {
  const mode = openModeOf(entry)
  if (mode === 'image' || mode === 'doc') await openBinaryPreview(side, entry)
  else if (mode === 'log') await openLogViewer(side, entry)
  else if (mode === 'edit') await openInEditor(side, entry)
}

function openAnything(side: 'local' | 'remote', entry: FileEntry) {
  return openInApp(side, entry)
}

/** 键盘快捷键作用于哪一栏：跟着最后一次点击/右键走 */
const focusSide = ref<'local' | 'remote'>('remote')

/* ---------------- 右键菜单 ---------------- */
interface CtxState {
  visible: boolean
  x: number
  y: number
  side: 'local' | 'remote'
  /** null 表示右键点在空白处（对当前目录操作） */
  entry: FileEntry | null
}

const ctx = ref<CtxState>({ visible: false, x: 0, y: 0, side: 'local', entry: null })

const SEP: MenuItem = { key: 'sep' }

function openCtx(event: MouseEvent, side: 'local' | 'remote', entry: FileEntry | null) {
  event.preventDefault()
  event.stopPropagation()
  // 右键的同时选中它，否则菜单操作的很可能是上一次选中的另一个文件
  if (side === 'local') {
    localSelected.value = entry
    focusSide.value = 'local'
  } else {
    remoteSelected.value = entry
    focusSide.value = 'remote'
  }
  ctx.value = { visible: true, x: event.clientX, y: event.clientY, side, entry }
}

function closeCtx() {
  ctx.value.visible = false
}

const menuItems = computed<MenuItem[]>(() => {
  const { side, entry } = ctx.value
  const items: MenuItem[] = []

  if (side === 'local') {
    if (!entry) {
      // 空白处：只放对"当前目录"有意义的操作
      const localPaste = pasteLabel('local')
      if (localPaste) {
        items.push({ key: 'paste', label: localPaste, kbd: 'Ctrl+V', icon: 'paste' })
        items.push(SEP)
      }
      items.push(
        { key: 'newFolder', label: '新建文件夹', icon: 'newFolder' },
        { key: 'refresh', label: '刷新', kbd: 'F5', icon: 'refresh' },
        SEP,
        { key: 'reveal', label: '在资源管理器中打开', icon: 'reveal' },
        { key: 'copyPath', label: '复制当前路径', icon: 'copy' }
      )
      return items
    }
    // 菜单第一项跟双击走同一套判定，文案就说"双击会发生什么"
    const mode = openModeOf(entry)
    if (mode === 'image') {
      items.push({ key: 'preview', label: '预览图片', kbd: '双击', icon: 'open' })
    } else if (mode === 'doc') {
      items.push({ key: 'preview', label: '预览文档', kbd: '双击', icon: 'open' })
    } else if (mode === 'log') {
      items.push({ key: 'log', label: '查看日志（只读末尾）', kbd: '双击', icon: 'open' })
    } else if (mode === 'edit') {
      items.push({ key: 'edit', label: '在编辑器中打开', kbd: '双击', icon: 'edit' })
    }
    items.push({
      key: 'open',
      label: entry.isDir ? '打开' : '用默认程序打开',
      // 双击已经被编辑器/预览占用了，这里就别再标"双击"，免得两行都写着同一个快捷键
      kbd: mode === 'enter' || mode === 'system' ? '双击' : undefined,
      icon: entry.isDir ? 'folder' : 'open'
    })
    items.push({ key: 'reveal', label: '在资源管理器中显示', icon: 'reveal' })
    if (!entry.isDir) items.push({ key: 'uploadFile', label: '上传到远程', icon: 'upload' })
    else items.push({ key: 'uploadDir', label: '上传此目录到远程', icon: 'upload' })
    items.push(SEP)
    items.push({ key: 'cut', label: '剪切', kbd: 'Ctrl+X', icon: 'cut' })
    items.push({ key: 'copy', label: '复制', kbd: 'Ctrl+C', icon: 'copyFile' })
    const localPaste = pasteLabel('local')
    if (localPaste) items.push({ key: 'paste', label: localPaste, kbd: 'Ctrl+V', icon: 'paste' })
    items.push(SEP)
    items.push({ key: 'copyPath', label: '复制路径', icon: 'copy' })
    items.push({ key: 'copyName', label: '复制名称', icon: 'copy' })
    items.push(SEP)
    items.push({ key: 'properties', label: '属性', icon: 'info' })
    items.push(SEP)
    items.push({ key: 'rename', label: '重命名', kbd: 'F2', icon: 'rename' })
    items.push({ key: 'delete', label: '删除（移到回收站）', kbd: 'Del', icon: 'delete', danger: true })
    return items
  }

  if (!entry) {
    const remotePaste = pasteLabel('remote')
    if (remotePaste) {
      items.push({ key: 'paste', label: remotePaste, kbd: 'Ctrl+V', icon: 'paste' })
      items.push(SEP)
    }
    items.push(
      { key: 'newFolder', label: '新建文件夹', icon: 'newFolder' },
      { key: 'uploadPick', label: '上传文件到此处', icon: 'upload' },
      { key: 'uploadPickDir', label: '上传文件夹到此处', icon: 'upload' },
      { key: 'refresh', label: '刷新', kbd: 'F5', icon: 'refresh' },
      SEP,
      { key: 'openInTerminal', label: '在终端中打开当前位置', icon: 'terminal' },
      { key: 'copyPath', label: '复制当前路径', icon: 'copy' }
    )
    return items
  }

  items.push({
    key: 'open',
    label: entry.isDir
      ? '打开'
      : openModeOf(entry) === 'image'
        ? '预览图片'
        : openModeOf(entry) === 'doc'
          ? '预览文档'
          : openModeOf(entry) === 'log'
            ? '查看日志'
            : openModeOf(entry) === 'edit'
              ? '编辑'
              : '用默认程序打开',
    kbd: '双击',
    icon: entry.isDir ? 'folder' : 'open'
  })
  items.push({
    key: 'download',
    label: entry.isDir ? '下载此目录到本地' : '下载到本地',
    icon: 'download'
  })
  if (entry.isDir) items.push({ key: 'openInTerminal', label: '在终端中打开', icon: 'terminal' })
  items.push(SEP)
  items.push({ key: 'cut', label: '剪切', kbd: 'Ctrl+X', icon: 'cut' })
  items.push({ key: 'copy', label: '复制', kbd: 'Ctrl+C', icon: 'copyFile' })
  const remotePaste = pasteLabel('remote')
  if (remotePaste) items.push({ key: 'paste', label: remotePaste, kbd: 'Ctrl+V', icon: 'paste' })
  items.push(SEP)
  items.push({ key: 'copyPath', label: '复制远程路径', icon: 'copy' })
  items.push({ key: 'copyName', label: '复制名称', icon: 'copy' })
  items.push(SEP)
  items.push({ key: 'properties', label: '属性', icon: 'info' })
  items.push(SEP)
  items.push({ key: 'rename', label: '重命名', kbd: 'F2', icon: 'rename' })
  items.push({ key: 'delete', label: '删除', kbd: 'Del', icon: 'delete', danger: true })
  return items
})

/* ---------------- 属性面板 ---------------- */
const propDialog = ref({
  visible: false,
  side: 'local' as 'local' | 'remote',
  entry: null as FileEntry | null
})

function openProperties(side: 'local' | 'remote', entry: FileEntry) {
  propDialog.value = { visible: true, side, entry }
}

/** POSIX 权限位转成 rwxr-xr-x (755) 这种人人都能读的形式 */
function formatMode(entry: FileEntry): string {
  const bits = entry.mode ?? 0
  if (!bits) return '—'
  // 9 位串由主进程按 ls 的规则算（含 setuid/setgid/sticky 的 s/S/t/T），这里只补上八进制：
  // 运维嘴里说的"644 / 755"就是这一串，两样一起给最省事
  return `${entry.modeText || '—'} (${(bits & 0o777).toString(8).padStart(3, '0')})`
}

/** 属主 / 属组：一格显示 `root:root`，和 chown 的写法一致 */
function ownerText(entry: FileEntry): string {
  if (!entry.owner && !entry.group) return '—'
  return `${entry.owner || '?'}:${entry.group || '?'}`
}

function ownerHint(entry: FileEntry): string {
  const who = entry.writable === false ? '不可写' : entry.writable === true ? '可写' : '写权限未知'
  return `属主 ${entry.owner || '?'} · 属组 ${entry.group || '?'} · 当前用户${who}`
}

/** 权限列的 tooltip：把"为什么红"说清楚，否则只能靠猜 */
function permHint(entry: FileEntry): string {
  const perm = entry.modeText || '权限未知'
  if (entry.writable === false) {
    return `${perm}｜当前 SSH 用户没有写权限（属主 ${entry.owner || '?'}:${entry.group || '?'}）`
  }
  if (entry.writable === true) return `${perm}｜当前 SSH 用户可写`
  return perm
}

function propSize(entry: FileEntry | null): string {
  if (!entry) return '—'
  if (entry.isDir) return '目录（不统计内部文件）'
  return `${formatSize(entry.size, false)}（${entry.size.toLocaleString()} 字节）`
}

/* ---------------- 右键菜单动作 ---------------- */
async function copyText(text: string, tip: string) {
  try {
    await window.api.clipboard.write(text)
    ElMessage.success(tip)
  } catch (err) {
    ElMessage.error('复制失败：' + cleanError(err))
  }
}

/** 右键某个本地文件 → 直接传到当前远程目录，不用再走文件选择框 */
async function uploadOne(filePath: string) {
  const name = filePath.split(/[\\/]/).pop() ?? 'upload.bin'
  busy.value = true
  try {
    // 取消时返回空串：不算失败，也不该报"已上传"
    const ok = await window.api.sftp.upload(
      props.tab.sessionId,
      filePath,
      joinRemote(remotePath.value, name)
    )
    await loadRemote()
    if (ok) ElMessage.success(`已上传 ${name}`)
    else ElMessage.info('已取消上传')
  } catch (err) {
    ElMessage.error('上传失败：' + cleanError(err))
  } finally {
    busy.value = false
  }
}

/** 在终端里 cd 到该目录，省得手敲长路径 */
function openInTerminal(dir: string) {
  // 路径带空格必须整体加引号，内部的单引号按 shell 规则断开再转义
  const quoted = /[\s$`"\\!*?[\]{}()<>|&;]/.test(dir) ? `'${dir.replace(/'/g, `'\\''`)}'` : dir
  window.api.ssh.write(props.tab.sessionId, `cd ${quoted}\n`)
  props.tab.view = 'terminal'
}

/* ---------------- 文件剪贴板（复制 / 剪切 / 粘贴） ---------------- */

/** 菜单里的「粘贴」文案：跨栏时直接说明会做什么，省得用户猜 */
function pasteLabel(target: 'local' | 'remote'): string | null {
  const clip = store.clipboard
  if (!clip || !clip.entries.length) return null
  const n = clip.entries.length
  if (clip.side === target) return n > 1 ? `粘贴 ${n} 项` : '粘贴'
  const verb = clip.side === 'local' ? '上传' : '下载'
  return n > 1 ? `粘贴（${verb} ${n} 项）` : `粘贴（${verb}）`
}

/** 剪贴板里的路径集合，用来把「剪切」的源在列表里淡显 */
const cutPaths = computed(() => {
  const clip = store.clipboard
  if (!clip || clip.mode !== 'cut') return new Set<string>()
  return new Set(clip.entries.map((e) => e.path))
})

function isCutSource(path: string): boolean {
  return cutPaths.value.has(path)
}

function sameDir(a: string, b: string, side: 'local' | 'remote'): boolean {
  const norm = (p: string) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const na = norm(a)
  const nb = norm(b)
  // Windows 路径不区分大小写，Linux 区分
  return side === 'local' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

function copySelection(mode: 'copy' | 'cut') {
  const side = focusSide.value
  const current = side === 'local' ? localSelected.value : remoteSelected.value
  if (!current) {
    ElMessage.info('先选中一个文件或目录')
    return
  }
  store.setClipboard({
    side,
    mode,
    sourceDir: side === 'local' ? localPath.value : remotePath.value,
    entries: [{ path: current.path, name: current.name, isDir: current.isDir }]
  })
  ElMessage.success(`${mode === 'cut' ? '已剪切' : '已复制'} ${current.name}`)
}

/** 目录下载到本地时，根目录名同样要按 Windows 规则清洗，否则 create 直接失败 */
function safeLocalName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_') || 'download'
}

/**
 * 粘贴。四种组合：
 *   本地→本地 / 远程→远程：交给主进程 cp / mv，不产生流量
 *   本地→远程：逐个 upload（目录走 uploadDir），剪切则传完删本地源（进回收站）
 *   远程→本地：逐个 download（目录走 downloadDir），剪切则拉完删远程源
 */
async function doPaste(side: 'local' | 'remote') {
  const clip = store.clipboard
  if (!clip || !clip.entries.length) return

  const destDir = side === 'local' ? localPath.value : remotePath.value
  if (!destDir) return

  const kind = clip.side === side ? 'same' : clip.side === 'local' ? 'upload' : 'download'

  if (kind === 'same' && sameDir(clip.sourceDir, destDir, side)) {
    ElMessage.info('源和目标是同一个目录')
    return
  }

  // 冲突只在同目录列表里判断：列表本身就是最新的目标内容，不用再额外问一次主进程
  const existing = new Set(
    (side === 'local' ? localEntries.value : remoteEntries.value).map((e) => e.name)
  )
  const conflicts = clip.entries.filter((e) => existing.has(e.name))
  if (conflicts.length) {
    const what = conflicts.length === 1 ? `「${conflicts[0].name}」` : `${conflicts.length} 个同名项`
    try {
      await ElMessageBox.confirm(
        `目标目录已有 ${what}，继续会覆盖文件（目录则按内容合并）。`,
        '确认粘贴',
        { type: 'warning', confirmButtonText: '覆盖粘贴', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
  }

  const sessionId = props.tab.sessionId
  const failed: { path: string; message: string }[] = []
  let done = 0

  busy.value = true
  try {
    if (kind === 'same') {
      const paths = clip.entries.map((e) => e.path)
      const res =
        side === 'local'
          ? await window.api.local.paste(paths, destDir, clip.mode)
          : await window.api.sftp.paste(sessionId, paths, destDir, clip.mode)
      done += res.done
      failed.push(...res.failed)
    } else if (kind === 'upload') {
      for (const entry of clip.entries) {
        try {
          if (entry.isDir) {
            const res = await window.api.sftp.uploadDir(
              sessionId,
              entry.path,
              joinRemote(destDir, entry.name)
            )
            // 用户点了取消：整批停下。**不能**往下走到"剪切删源"那一步
            if (res.canceled) break
            if (res.failed.length) {
              failed.push(...res.failed)
              continue
            }
          } else {
            // 取消时主进程返回空串而不是抛错（取消不是失败），这里同样要停下
            const done1 = await window.api.sftp.upload(
              sessionId,
              entry.path,
              joinRemote(destDir, entry.name)
            )
            if (!done1) break
          }
          done++
          // 剪切：传完再删本地源，走回收站，误操作还能捞回来
          if (clip.mode === 'cut') await window.api.local.remove(entry.path)
        } catch (err) {
          failed.push({ path: entry.path, message: cleanError(err) })
        }
      }
    } else {
      for (const entry of clip.entries) {
        try {
          const target = joinLocal(destDir, entry.isDir ? safeLocalName(entry.name) : entry.name)
          if (entry.isDir) {
            const res = await window.api.sftp.downloadDir(sessionId, entry.path, target)
            if (res.canceled) break
            if (res.failed.length) {
              failed.push(...res.failed)
              continue
            }
          } else {
            const got = await window.api.sftp.download(sessionId, entry.path, target)
            if (!got) break
          }
          done++
          if (clip.mode === 'cut') {
            await window.api.sftp.remove(sessionId, entry.path, entry.isDir)
          }
        } catch (err) {
          failed.push({ path: entry.path, message: cleanError(err) })
        }
      }
    }
  } finally {
    busy.value = false
    // 剪切是一次性的：成功或失败都清掉，避免用户以为还能再粘一次
    if (clip.mode === 'cut') store.setClipboard(null)
    // 两侧都刷：剪切会改动源目录，跨栏粘贴会同时影响两栏
    await Promise.all([loadLocal(), loadRemote()])
  }

  if (failed.length) {
    ElMessage.warning(`已粘贴 ${done} 项，${failed.length} 项失败：${failed[0].message}`)
  } else {
    ElMessage.success(`已粘贴 ${done} 项`)
  }
}

async function onMenuPick(key: string) {
  const { side, entry } = ctx.value
  const target = entry

  switch (key) {
    case 'edit':
      if (target && !target.isDir) await openInEditor(side, target)
      return
    case 'log':
      if (target && !target.isDir) await openLogViewer(side, target)
      return
    case 'preview':
      // side 必须跟着右键的那一栏走 —— 这里以前写死 'local'，远程文件点预览会去本地找同名文件
      if (target && !target.isDir) await openInApp(side, target)
      return
    case 'open':
      if (!target) return
      if (side === 'local') await openLocal(target)
      else await openRemote(target)
      return
    case 'reveal':
      if (!target) {
        await window.api.local.openPath(localPath.value)
        return
      }
      await window.api.local.reveal(target.path)
      return
    case 'uploadFile':
      if (target && !target.isDir) await uploadOne(target.path)
      return
    case 'uploadDir':
      if (target?.isDir) await uploadFolderTo(target.path, remotePath.value)
      return
    case 'uploadPick':
      await upload()
      return
    case 'uploadPickDir':
      await uploadDir()
      return
    case 'download':
      await download()
      return
    case 'copy':
      copySelection('copy')
      return
    case 'cut':
      copySelection('cut')
      return
    case 'paste':
      await doPaste(side)
      return
    case 'openInTerminal':
      openInTerminal(side === 'local' ? localPath.value : target ? target.path : remotePath.value)
      return
    case 'copyPath':
      await copyText(
        side === 'local' ? target?.path ?? localPath.value : target?.path ?? remotePath.value,
        '已复制路径'
      )
      return
    case 'copyName':
      if (target) await copyText(target.name, '已复制名称')
      return
    case 'properties':
      if (target) openProperties(side, target)
      return
    case 'rename':
      if (side === 'local') await renameLocal()
      else await renameRemote()
      return
    case 'delete':
      if (side === 'local') await deleteLocal()
      else await deleteRemote()
      return
    case 'newFolder':
      if (side === 'local') await makeLocalDir()
      else await makeRemoteDir()
      return
    case 'refresh':
      if (side === 'local') await loadLocal()
      else await loadRemote()
      return
  }
}

/* ---------------- 工具函数 ---------------- */
function formatTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function parentOf(p: string): string {
  if (!p) return p
  const isWin = p.includes('\\') || /^[A-Za-z]:/.test(p)
  const sep = isWin ? '\\' : '/'
  const trimmed = p.replace(/[\\/]+$/, '')
  if (!trimmed) return sep
  // 已经在盘符根（C:）时再往上还是它自己
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + sep
  const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (idx < 0) return trimmed
  if (idx === 0) return '/'
  const parent = trimmed.slice(0, idx)
  if (/^[A-Za-z]:$/.test(parent)) return parent + sep
  return parent
}

function joinLocal(dir: string, name: string): string {
  const isWin = dir.includes('\\') || /^[A-Za-z]:/.test(dir)
  const sep = isWin ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

function joinRemote(dir: string, name: string): string {
  if (dir === '/' || dir === '') return '/' + name
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

/* ---------------- 路径跳转 ---------------- */
async function loadPlaces() {
  try {
    places.value = await window.api.local.places()
  } catch {
    places.value = []
  }
}

function onPlacesToggle(open: boolean) {
  if (open) void loadPlaces()
}

async function jumpLocal(target: string) {
  await loadLocal(target)
}

async function jumpRemote(target: string) {
  await loadRemote(target)
}

/** 打开系统的目录选择框，从当前目录起步 */
async function pickLocalDir() {
  try {
    const dir = await window.api.dialog.pickDir(localPath.value)
    if (dir) await loadLocal(dir)
  } catch (err) {
    ElMessage.error('打开目录失败：' + cleanError(err))
  }
}

/* ---------------- 加载 ---------------- */
async function loadLocal(target = localPath.value) {
  if (!target) return
  loadingLocal.value = true
  try {
    localEntries.value = await window.api.local.list(target)
    localPath.value = target
    localSelected.value = null
  } catch (err) {
    ElMessage.error('本地目录读取失败：' + cleanError(err))
  } finally {
    loadingLocal.value = false
  }
}

async function loadRemote(target = remotePath.value) {
  loadingRemote.value = true
  try {
    remoteEntries.value = await window.api.sftp.list(props.tab.sessionId, target)
    remotePath.value = target
    remoteSelected.value = null
  } catch (err) {
    ElMessage.error('远程目录读取失败：' + cleanError(err))
  } finally {
    loadingRemote.value = false
  }
}

async function initPaths() {
  try {
    localPath.value = await window.api.local.home()
    await loadLocal()
  } catch {
    /* 忽略 */
  }

  try {
    const res = await window.api.ssh.exec(props.tab.sessionId, 'printf %s "$HOME"')
    const home = res.stdout.trim()
    remoteHome.value = home || '/'
    remotePath.value = remoteHome.value
    await loadRemote()
  } catch {
    remotePath.value = '/'
    await loadRemote()
  }
}

/* ---------------- 本地操作 ---------------- */
/**
 * 本地双击：
 * - 目录 → 进去
 * - 文本类 → 内置编辑器（这才是运维常干的事，不该弹系统记事本）
 * - 其它（图片/压缩包/可执行）→ 交给系统默认程序，内置编辑器帮不上忙
 */
async function openLocal(entry: FileEntry) {
  const mode = openModeOf(entry)
  if (mode === 'enter') {
    await loadLocal(entry.path)
    return
  }
  // 'system' 交给系统默认程序：压缩包、安装包、解不了的 RAW/PSD
  if (mode !== 'system') {
    await openInApp('local', entry)
    return
  }
  try {
    await window.api.local.openPath(entry.path)
  } catch (err) {
    ElMessage.error('打开失败：' + cleanError(err))
  }
}

async function makeLocalDir() {
  try {
    const { value } = await ElMessageBox.prompt('文件夹名称', '新建文件夹', {
      inputValue: '新建文件夹',
      inputValidator: (v) => (v?.trim() ? true : '名称不能为空')
    })
    await window.api.local.mkdir(joinLocal(localPath.value, value.trim()))
    await loadLocal()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(cleanError(err))
  }
}

async function deleteLocal() {
  if (!localSelected.value) return
  const target = localSelected.value
  try {
    await ElMessageBox.confirm(
      `将「${target.name}」移到系统回收站？`,
      '删除本地文件',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
    await window.api.local.remove(target.path)
    await loadLocal()
    ElMessage.success('已移入回收站')
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(cleanError(err))
  }
}

async function renameLocal() {
  if (!localSelected.value) return
  const target = localSelected.value
  try {
    const { value } = await ElMessageBox.prompt('新的名称', '重命名', {
      inputValue: target.name,
      inputValidator: (v) => (v?.trim() ? true : '名称不能为空')
    })
    await window.api.local.rename(target.path, joinLocal(localPath.value, value.trim()))
    await loadLocal()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(cleanError(err))
  }
}

/* ---------------- 只读预览：图片 / office 文档 / PDF ---------------- */
/**
 * 二进制文件读原始字节交给渲染进程（图片、docx、xlsx、pdf）。
 * 走 readBinary 而不是 readFile：后者按 UTF-8 解码并拦二进制，zip 包会被判成"不是文本"。
 * pptx/ppt/doc 也走这里 —— 面板里会自己说明为什么渲染不了，比在列表里弹个 warning 更有用。
 * 体积上限在主进程（readBinary 里 50MB），这里不重复判：越权判断迟早两边不一致。
 */
async function openBinaryPreview(side: 'local' | 'remote', entry: FileEntry) {
  previewWin.reset()
  previewLoading.value = true
  try {
    const bin =
      side === 'local'
        ? await window.api.local.readBinary(entry.path)
        : await window.api.sftp.readBinary(props.tab.sessionId, entry.path)
    previewDialog.value = {
      visible: true,
      side,
      path: entry.path,
      name: entry.name,
      base64: bin.base64,
      size: bin.size
    }
  } catch (err) {
    ElMessage.error('打开失败：' + cleanError(err))
  } finally {
    previewLoading.value = false
  }
}

/* ---------------- 内置编辑器（本地 / 远程共用） ---------------- */
async function openInEditor(side: 'local' | 'remote', entry: FileEntry) {
  editWin.reset()
  if (entry.size > EDIT_MAX_BYTES) {
    ElMessage.warning(`超过 ${EDIT_MAX_TEXT} 的文件请下载后用其它工具编辑`)
    return
  }
  // 大文件不拦，只提醒：运维手上的 10MB 日志是正常需求，拦下来只会让人绕路。
  // 但得先说清楚代价 —— 敲字会顿，窗口内存也会上去。
  if (entry.size > EDIT_WARN_BYTES) {
    ElMessage.warning(`文件 ${formatSize(entry.size)}，编辑器打开和输入可能有点卡`)
  }
  try {
    const text =
      side === 'local'
        ? await window.api.local.readFile(entry.path)
        : await window.api.sftp.readFile(props.tab.sessionId, entry.path)
    // 读到了内容再问权限：连读都失败的话弹窗根本不该开，没必要多跑一次探测
    let writable = true
    try {
      writable =
        side === 'local'
          ? await window.api.local.canWrite(entry.path)
          : await window.api.sftp.canWrite(props.tab.sessionId, entry.path)
    } catch {
      // 探测本身失败（会话抖动等）按"可写"处理：真保存不了还有 writeFile 兜底报错，
      // 别因为一次探测失败就把编辑功能锁死
    }
    editDialog.value = {
      visible: true,
      side,
      path: entry.path,
      name: entry.name,
      content: text.content,
      original: text.content,
      saving: false,
      writable,
      encoding: text.encoding,
      bom: text.bom,
      // markdown 默认分栏，其它文件没有预览栏
      viewMode: isMarkdown(entry.name) ? 'split' : 'editor'
    }
  } catch (err) {
    ElMessage.error('读取失败：' + cleanError(err))
  }
}

async function openRemote(entry: FileEntry) {
  const mode = openModeOf(entry)
  if (mode === 'enter') {
    await loadRemote(entry.path)
    return
  }
  // 图片 / office / PDF / 日志 / 文本都在应用内解决，不用先下载
  if (mode !== 'system') {
    await openInApp('remote', entry)
    return
  }
  // 剩下的只能下载。提示要分开说清楚是"哪一种打不开"——
  // 一句笼统的"请下载"会让人以为所有文件都没法看
  if (isImageFile(entry.name)) {
    ElMessage.warning('这个图片格式内置预览看不了，请下载到本地后用对应工具打开')
  } else if (entry.size > EDIT_MAX_BYTES) {
    ElMessage.warning(`超过 ${EDIT_MAX_TEXT} 的文件请下载到本地后编辑`)
  } else {
    ElMessage.warning('这不是文本文件，请下载到本地后用对应工具打开')
  }
}

async function saveEdit() {
  const d = editDialog.value
  if (!d.visible || d.saving || !editDirty.value) return
  // 按钮已经禁用了，但 Ctrl+S 走的是编辑器 keymap，会绕过 UI 状态，这里必须再拦一次
  if (!d.writable) {
    ElMessage.warning('当前用户没有这个文件的写权限，无法保存')
    return
  }
  d.saving = true
  try {
    if (d.side === 'local') {
      await window.api.local.writeFile(d.path, d.content, d.encoding, d.bom)
      await loadLocal()
    } else {
      await window.api.sftp.writeFile(props.tab.sessionId, d.path, d.content, d.encoding, d.bom)
      await loadRemote()
    }
    d.original = d.content
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error('保存失败：' + cleanError(err))
  } finally {
    d.saving = false
  }
}

/**
 * 关窗守卫：有未保存修改时先问一句。
 * 直接丢掉改了一半的 nginx.conf 是很疼的事，宁可多一次确认。
 */
function handleEditClose(done: () => void) {
  if (!editDirty.value) {
    done()
    return
  }
  ElMessageBox.confirm('有未保存的修改，关闭后会丢失。', '还没保存', {
    type: 'warning',
    confirmButtonText: '放弃修改',
    cancelButtonText: '继续编辑',
    distinguishCancelAndClose: true
  })
    .then(() => done())
    .catch(() => {
      /* 继续编辑：什么都不做 */
    })
}

/**
 * Tab 缩进交给 CodeMirror 的 indentWithTab 处理（它会跟随语言做正确缩进），
 * 这里原来那个往 textarea 里塞两个空格的 hack 已经不需要了。
 */

/* ---------------- 日志查看器（只读，只看末尾） ---------------- */
/**
 * 为什么单独一套状态，而不是给 editDialog 加个 `mode: 'log'`：
 * 两者的状态几乎没有交集 —— 这边要行数、刷新时间、自动刷新，那边要脏标记、编码、保存权限。
 * 合在一起之后模板里会全是 v-if，改任何一个都怕碰坏另一个。
 *
 * 也不复用"整份读进来"的链路：几百 MB 的 access.log 整份读必卡，
 * 而看日志的人只关心最后几十行 —— 主进程从文件末尾往回倒着读，文件多大都是毫秒级。
 */
const logDialog = ref({
  visible: false,
  side: 'remote' as 'local' | 'remote',
  path: '',
  name: '',
  content: '',
  /** 想看多少行。记住上一次选的，下次打开沿用 */
  want: LOG_DEFAULT_LINES,
  /** 实际拿到多少行（文件比请求短时会少） */
  lines: 0,
  size: 0,
  /** 前面还有内容没取到 */
  truncated: false,
  loading: false,
  /** 自动刷新：盯着一个还在写的日志时才需要，默认关 */
  auto: false,
  at: 0
})
const logEditor = ref<InstanceType<typeof CodeEditor> | null>(null)
/** 自动刷新间隔。3 秒够看"刚打出来的报错"，又不至于把 SFTP 连接刷成洪水 */
const LOG_AUTO_MS = 3000
let logTimer = 0
/** 请求序号：切文件/连点刷新时，晚到的旧结果不许覆盖新结果 */
let logSeq = 0

const logMeta = computed(() => {
  const d = logDialog.value
  if (!d.at) return ''
  const scope = d.truncated ? `末尾 ${d.lines} 行` : `全部 ${d.lines} 行`
  const time = new Date(d.at).toLocaleTimeString('zh-CN', { hour12: false })
  // 空日志会显示 "文件 —"，所以这里关掉 dashOnZero：0 字节就写 0 B
  return `${scope} · 文件 ${formatSize(d.size, false)} · ${time}`
})

/**
 * 滚到底。刚打开时 el-dialog 是懒挂载的（destroy-on-close），可能要好几个 tick
 * 编辑器才出来 —— 光 nextTick 不够，补一帧 rAF 再试，总比"打开停在第 1 行"好。
 */
async function scrollLogToEnd(tries = 12) {
  for (let i = 0; i < tries; i += 1) {
    await nextTick()
    if (logEditor.value) {
      logEditor.value.scrollToEnd()
      return
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

/**
 * 读一次末尾若干行。
 * @param mode open = 刚打开（一定滚到底）；auto = 定时刷新（用户翻到上面看历史时别拽他回来）
 */
async function reloadLog(mode: 'open' | 'manual' | 'auto' = 'manual') {
  const d = logDialog.value
  if (!d.visible || d.loading) return
  const seq = ++logSeq
  d.loading = true
  // 自动刷新时若用户已经往上翻，就保住他的滚动位置 —— 正看着某一段被弹回底部最恼人
  const scroller = document.querySelector<HTMLElement>('.log-dialog .cm-scroller')
  const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60
  const prevTop = scroller?.scrollTop ?? 0
  try {
    const res =
      d.side === 'local'
        ? await window.api.local.readTail(d.path, d.want)
        : await window.api.sftp.readTail(props.tab.sessionId, d.path, d.want)
    if (seq !== logSeq) return
    d.content = res.content
    d.lines = res.lines
    d.size = res.size
    d.truncated = res.truncated
    d.at = Date.now()
    await nextTick()
    if (seq !== logSeq) return
    if (mode === 'open' || atBottom) await scrollLogToEnd()
    else if (scroller) scroller.scrollTop = prevTop
  } catch (err) {
    if (seq !== logSeq) return
    // 自动刷新失败不弹窗：网络抖一下弹一个红条反而更烦，界面上留着上次的内容就行
    if (mode !== 'auto') ElMessage.error('读取日志失败：' + cleanError(err))
  } finally {
    if (seq === logSeq) d.loading = false
  }
}

async function openLogViewer(side: 'local' | 'remote', entry: FileEntry) {
  logWin.reset()
  const want = logDialog.value.want || LOG_DEFAULT_LINES
  logDialog.value = {
    visible: true,
    side,
    path: entry.path,
    name: entry.name,
    content: '',
    want,
    lines: 0,
    size: entry.size,
    truncated: false,
    loading: false,
    auto: false,
    at: 0
  }
  await reloadLog('open')
}

/** 自动刷新的开关与开窗/关窗联动：关掉弹窗必须停表，否则后台一直在拉文件 */
function syncLogTimer() {
  window.clearInterval(logTimer)
  logTimer = 0
  if (logDialog.value.visible && logDialog.value.auto) {
    logTimer = window.setInterval(() => void reloadLog('auto'), LOG_AUTO_MS)
  }
}
watch(() => [logDialog.value.visible, logDialog.value.auto] as const, syncLogTimer)

async function makeRemoteDir() {
  try {
    const { value } = await ElMessageBox.prompt('文件夹名称', '新建远程文件夹', {
      inputValue: 'new_folder',
      inputValidator: (v) => (v?.includes('/') ? '名称不能包含 /' : v?.trim() ? true : '名称不能为空')
    })
    await window.api.sftp.mkdir(props.tab.sessionId, joinRemote(remotePath.value, value.trim()))
    await loadRemote()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(cleanError(err))
  }
}

async function deleteRemote() {
  if (!remoteSelected.value) return
  const target = remoteSelected.value
  try {
    await ElMessageBox.confirm(
      target.isDir
        ? `将递归删除远程目录「${target.name}」及其全部内容，此操作不可恢复。`
        : `确定删除远程文件「${target.name}」？`,
      '删除远程文件',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
    busy.value = true
    await window.api.sftp.remove(props.tab.sessionId, target.path, target.isDir)
    await loadRemote()
    ElMessage.success('已删除')
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(cleanError(err))
  } finally {
    busy.value = false
  }
}

async function renameRemote() {
  if (!remoteSelected.value) return
  const target = remoteSelected.value
  try {
    const { value } = await ElMessageBox.prompt('新的名称', '重命名', {
      inputValue: target.name,
      inputValidator: (v) => (v?.includes('/') ? '名称不能包含 /' : v?.trim() ? true : '名称不能为空')
    })
    await window.api.sftp.rename(
      props.tab.sessionId,
      target.path,
      joinRemote(remotePath.value, value.trim())
    )
    await loadRemote()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(cleanError(err))
  }
}

/* ---------------- 上传 / 下载 ---------------- */
async function upload() {
  try {
    const files = await window.api.dialog.pickFiles()
    if (!files.length) return
    busy.value = true
    let sent = 0
    for (const file of files) {
      const name = file.split(/[\\/]/).pop() ?? 'upload.bin'
      const ok = await window.api.sftp.upload(
        props.tab.sessionId,
        file,
        joinRemote(remotePath.value, name)
      )
      // 取消了一个就整批停下：用户要停，不该继续往下一个文件扑
      if (!ok) break
      sent++
    }
    await loadRemote()
    if (sent) ElMessage.success(`已上传 ${sent} 个文件`)
    if (sent < files.length) ElMessage.info(`已取消，还有 ${files.length - sent} 个没传`)
  } catch (err) {
    ElMessage.error('上传失败：' + cleanError(err))
  } finally {
    busy.value = false
  }
}

/** 目录名从完整本地路径里取：Windows 的 \ 和 Unix 的 / 都要认 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? 'upload'
}

/**
 * 目录递归上传（本地 → 远程目录）。
 *
 * 远程已有同名目录时先问一句：SFTP 的 fastPut 是**静默覆盖**，
 * 同名文件会被直接顶掉。运维传配置/数据目录时最怕这个，
 * 所以默认不覆盖、要用户明确点「合并上传」。
 * 不会删除远程独有的文件 —— 合并只做加法，删除留给用户自己动手。
 */
async function uploadFolderTo(localDir: string, remoteDir: string) {
  const name = baseName(localDir)
  const exist = remoteEntries.value.find((e) => e.name === name)
  if (exist && !exist.isDir) {
    ElMessage.error(`远程已存在同名文件 ${name}，不能按目录上传`)
    return
  }
  if (exist) {
    try {
      await ElMessageBox.confirm(
        `远程已存在目录 ${name}，继续上传会覆盖其中的同名文件（远程独有的文件保留不动）。`,
        '目录已存在',
        { confirmButtonText: '合并上传', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return
    }
  }
  busy.value = true
  try {
    const result = await window.api.sftp.uploadDir(
      props.tab.sessionId,
      localDir,
      joinRemote(remoteDir, name)
    )
    await loadRemote()
    // 取消不是失败，也不是完成：说清楚"停在哪了"，别报个"已上传"骗人
    if (result.canceled) {
      ElMessage.info(`已取消，上传了 ${result.uploaded}/${result.total} 个文件`)
    } else if (result.failed.length) {
      ElMessage.warning(
        `已上传 ${result.uploaded}/${result.total} 个文件，${result.failed.length} 个失败：${result.failed[0].message}`
      )
    } else if (!result.total) {
      // 空目录也要给反馈，否则看着像没反应
      ElMessage.success(`已创建空目录 ${name}`)
    } else {
      ElMessage.success(`已上传目录 ${name}（${result.total} 个文件）`)
    }
  } catch (err) {
    ElMessage.error('上传目录失败：' + cleanError(err))
  } finally {
    busy.value = false
  }
}

/** 上传文件夹：弹目录选择框，默认定位在本地当前目录 */
async function uploadDir() {
  const dir = await window.api.dialog.pickDir(localPath.value || undefined)
  if (!dir) return
  await uploadFolderTo(dir, remotePath.value)
}

async function download() {
  if (!remoteSelected.value) return
  const target = remoteSelected.value
  busy.value = true
  try {
    if (target.isDir) {
      // 目录：在本地当前目录下建同名文件夹，递归拉取
      // 根目录名要和主进程里的分段清洗规则保持一致，否则 Windows 上会创建失败
      const folder = target.name.replace(/[\\/:*?"<>|]/g, '_') || 'download'
      const dest = joinLocal(localPath.value, folder)
      const result = await window.api.sftp.downloadDir(
        props.tab.sessionId,
        target.path,
        dest
      )
      await loadLocal()
      if (result.canceled) {
        ElMessage.info(`已取消，下载了 ${result.downloaded}/${result.total} 个文件`)
      } else if (result.failed.length) {
        ElMessage.warning(
          `已下载 ${result.downloaded}/${result.total} 个文件，${result.failed.length} 个失败（可能是权限或文件名非法）`
        )
      } else {
        ElMessage.success(`已下载 ${result.total} 个文件到 ${dest}`)
      }
    } else {
      // 取消时主进程返回空串（不是抛错），别报"下载完成"
      const got = await window.api.sftp.download(
        props.tab.sessionId,
        target.path,
        joinLocal(localPath.value, target.name)
      )
      await loadLocal()
      if (got) ElMessage.success('下载完成')
      else ElMessage.info('已取消下载')
    }
  } catch (err) {
    ElMessage.error('下载失败：' + cleanError(err))
  } finally {
    busy.value = false
  }
}

/* ---------------- 键盘 ---------------- */
function onKey(event: KeyboardEvent) {
  // 只在这一栏可见时响应，否则会抢走终端里的按键
  if (props.tab.view !== 'files') return
  // 路径输入框、重命名弹框里打字时不要触发
  const tag = (event.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return

  const side = focusSide.value
  const current = side === 'local' ? localSelected.value : remoteSelected.value

  // 复制/剪切/粘贴：只在没按 Shift/Alt 时接管，避免和终端里的 Ctrl+Shift+C 抢
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
    const key = event.key.toLowerCase()
    if (key === 'c' || key === 'x' || key === 'v') {
      event.preventDefault()
      if (key === 'v') void doPaste(side)
      else copySelection(key === 'c' ? 'copy' : 'cut')
      return
    }
  }

  if (event.key === 'F5') {
    event.preventDefault()
    void (side === 'local' ? loadLocal() : loadRemote())
    return
  }
  if (!current) return

  if (event.key === 'F2') {
    event.preventDefault()
    void (side === 'local' ? renameLocal() : renameRemote())
  } else if (event.key === 'Delete') {
    event.preventDefault()
    void (side === 'local' ? deleteLocal() : deleteRemote())
  }
}

onMounted(async () => {
  void loadPlaces()
  await initPaths()
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.clearTimeout(bytesTimer)
  window.clearInterval(logTimer)
})
</script>

<template>
  <div class="fm">
    <div class="panes">
      <!-- 本地 -->
      <section class="pane">
        <header class="pane-bar">
          <el-dropdown
            trigger="click"
            placement="bottom-start"
            popper-class="pl-dropdown"
            @command="jumpLocal"
            @visible-change="onPlacesToggle"
          >
            <span class="pane-tag local jump">
              本地
              <el-icon class="caret"><CaretBottom /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="p in placeItems" :key="p.path" :command="p.path">
                  <span class="pl-label">{{ p.label }}</span>
                  <span class="pl-path mono">{{ p.path }}</span>
                </el-dropdown-item>
                <el-dropdown-item
                  v-for="(p, i) in driveItems"
                  :key="p.path"
                  :command="p.path"
                  :divided="i === 0"
                >
                  <span class="pl-label mono">{{ p.label }}</span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-tooltip content="上一级" :show-after="400">
            <el-icon class="ic" @click="loadLocal(parentOf(localPath))"><ArrowLeft /></el-icon>
          </el-tooltip>
          <input
            v-model="localPath"
            class="path-input mono"
            @keyup.enter="loadLocal(localPath)"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <el-tooltip content="打开目录…" :show-after="400">
            <el-icon class="ic" @click="pickLocalDir"><FolderOpened /></el-icon>
          </el-tooltip>
          <el-tooltip content="刷新" :show-after="400">
            <el-icon class="ic" :class="{ spin: loadingLocal }" @click="loadLocal()"><Refresh /></el-icon>
          </el-tooltip>
        </header>

        <div class="list">
          <div class="list-head">
            <span class="col-name">名称</span>
            <span class="col-size">大小</span>
            <span class="col-time">修改时间</span>
          </div>
          <div class="rows" @contextmenu="openCtx($event, 'local', null)">
            <div
              v-for="entry in localEntries"
              :key="entry.path"
              class="row"
              :class="{ selected: localSelected?.path === entry.path, cutting: isCutSource(entry.path) }"
              @click="localSelected = entry, focusSide = 'local'"
              @dblclick="openLocal(entry)"
              @contextmenu="openCtx($event, 'local', entry)"
            >
              <span class="col-name">
                <FileTypeIcon :name="entry.name" :is-dir="entry.isDir" />
                <span class="fname truncate">{{ entry.name }}</span>
              </span>
              <span class="col-size mono">{{ entry.isDir ? '—' : formatSize(entry.size) }}</span>
              <span class="col-time mono">{{ formatTime(entry.mtime) }}</span>
            </div>
            <div v-if="!localEntries.length" class="empty">空目录</div>
          </div>
        </div>

        <footer class="pane-foot">
          <el-tooltip content="新建文件夹" :show-after="400">
            <el-button text size="small" :icon="FolderAdd" @click="makeLocalDir" />
          </el-tooltip>
          <!-- 重命名用「A + 光标」的图标：笔要留给真正的"编辑"。tooltip 里带上 F2，图标认不出来也能读 -->
          <el-tooltip content="重命名（F2）" :show-after="400">
            <el-button class="sq" text size="small" :disabled="!localSelected" @click="renameLocal">
              <el-icon><RenameIcon /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="删除（移到回收站）" :show-after="400">
            <el-button
              class="del"
              text
              size="small"
              :icon="Delete"
              :disabled="!localSelected"
              @click="deleteLocal"
            />
          </el-tooltip>
          <el-tooltip :content="pickOpenLabel(localSelected)" :show-after="400">
            <el-button
              text
              size="small"
              :icon="pickOpenIcon(localSelected)"
              :disabled="!canOpenLocal"
              @click="localSelected && openAnything('local', localSelected)"
            />
          </el-tooltip>
          <div class="grow" />
          <!-- 一个按钮两件事：文件走多选、目录走递归上传，默认点主按钮仍是传文件 -->
          <el-dropdown
            trigger="click"
            placement="top-end"
            :disabled="busy"
            @command="(cmd: string) => (cmd === 'folder' ? uploadDir() : upload())"
          >
            <el-button text size="small" type="primary" :icon="Upload" :loading="busy">
              上传到远程<el-icon class="el-icon--right"><CaretBottom /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="files">上传文件…</el-dropdown-item>
                <el-dropdown-item command="folder">上传文件夹…（含子目录）</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </footer>
      </section>

      <!-- 远程 -->
      <section class="pane">
        <header class="pane-bar">
          <el-dropdown
            trigger="click"
            placement="bottom-start"
            popper-class="pl-dropdown"
            @command="jumpRemote"
          >
            <span class="pane-tag remote jump">
              远程
              <el-icon class="caret"><CaretBottom /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="p in remotePlaces" :key="p.path" :command="p.path">
                  <span class="pl-label">{{ p.label }}</span>
                  <span class="pl-path mono">{{ p.path }}</span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-tooltip content="上一级" :show-after="400">
            <el-icon class="ic" @click="loadRemote(parentOf(remotePath))"><ArrowLeft /></el-icon>
          </el-tooltip>
          <input
            v-model="remotePath"
            class="path-input mono"
            @keyup.enter="loadRemote(remotePath)"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <el-tooltip content="刷新" :show-after="400">
            <el-icon class="ic" :class="{ spin: loadingRemote }" @click="loadRemote()"><Refresh /></el-icon>
          </el-tooltip>
        </header>

        <div class="list remote">
          <div class="list-head">
            <span class="col-name">名称</span>
            <span class="col-mode">权限</span>
            <span class="col-owner">用户 / 组</span>
            <span class="col-size">大小</span>
            <span class="col-time">修改时间</span>
          </div>
          <div class="rows" @contextmenu="openCtx($event, 'remote', null)">
            <div
              v-for="entry in remoteEntries"
              :key="entry.path"
              class="row"
              :class="{ selected: remoteSelected?.path === entry.path, cutting: isCutSource(entry.path) }"
              @click="remoteSelected = entry, focusSide = 'remote'"
              @dblclick="openRemote(entry)"
              @contextmenu="openCtx($event, 'remote', entry)"
            >
              <span class="col-name">
                <FileTypeIcon :name="entry.name" :is-dir="entry.isDir" />
                <span class="fname truncate">{{ entry.name }}</span>
              </span>
              <!-- 不能写的标红：这一列最常被用来判断"要不要 sudo"，扫一眼就得看出来 -->
              <span
                class="col-mode mono"
                :class="{ nowrite: entry.writable === false }"
                :title="permHint(entry)"
              >
                {{ entry.modeText || '—' }}
              </span>
              <span class="col-owner mono truncate" :title="ownerHint(entry)">
                {{ ownerText(entry) }}
              </span>
              <span class="col-size mono">{{ entry.isDir ? '—' : formatSize(entry.size) }}</span>
              <span class="col-time mono">{{ formatTime(entry.mtime) }}</span>
            </div>
            <div v-if="!remoteEntries.length" class="empty">空目录</div>
          </div>
        </div>

        <footer class="pane-foot">
          <el-tooltip content="新建文件夹" :show-after="400">
            <el-button text size="small" :icon="FolderAdd" @click="makeRemoteDir" />
          </el-tooltip>
          <el-tooltip content="重命名（F2）" :show-after="400">
            <el-button class="sq" text size="small" :disabled="!remoteSelected" @click="renameRemote">
              <el-icon><RenameIcon /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="删除" :show-after="400">
            <el-button
              class="del"
              text
              size="small"
              :icon="Delete"
              :disabled="!remoteSelected"
              @click="deleteRemote"
            />
          </el-tooltip>
          <el-tooltip :content="pickOpenLabel(remoteSelected)" :show-after="400">
            <el-button
              text
              size="small"
              :icon="pickOpenIcon(remoteSelected)"
              :disabled="!canOpenRemote"
              @click="remoteSelected && openAnything('remote', remoteSelected)"
            />
          </el-tooltip>
          <div class="grow" />
          <el-button
            text
            size="small"
            type="primary"
            :icon="Download"
            :disabled="!remoteSelected"
            :loading="busy"
            @click="download"
          >
            下载到本地
          </el-button>
        </footer>
      </section>
    </div>

    <!-- 传输进度不在这一页显示了：上传/下载统一由窗口底部的传输记录面板兜住
         （见 TransferDock.vue）—— 进度和记录放在同一个地方，才不用在
         "正在传" 和 "传完了刚才那个从哪儿下去的" 之间来回看两个区域 -->

    <!-- 内置编辑器：本地和远程共用，Ctrl/Cmd+S 保存 -->
    <el-dialog
      v-model="editDialog.visible"
      :width="editWin.mode === 'max' ? MAX_WIDTH : editDialogWidth"
      :top="editWin.mode === 'max' ? MAX_TOP : '5vh'"
      destroy-on-close
      :close-on-click-modal="false"
      :before-close="handleEditClose"
      :show-close="false"
      :class="['edit-dialog', editWin.mode]"
    >
      <template #header>
        <!-- 收起状态下整条标题栏就是"点一下展开"的把手 -->
        <div
          class="edit-head"
          :class="{ min: editWin.mode === 'min' }"
          @click="editWin.mode === 'min' && editWin.restore()"
          @dblclick="editWin.mode !== 'min' && editWin.toggleMax()"
        >
          <span class="edit-badge" :class="editDialog.side">{{ editDialog.side === 'local' ? '本地' : '远程' }}</span>
          <el-icon v-if="editWin.mode === 'min'" class="min-ico"><EditPen /></el-icon>
          <span class="edit-name mono truncate" :title="editDialog.path">{{ editDialog.name }}</span>
          <!-- 没写权限时先说清楚，别等用户改完点保存才发现 -->
          <span v-if="!editDialog.writable" class="edit-ro">只读 · 无写权限</span>
          <!-- UTF-16 的文件单独标一下：以前它会被当成二进制挡在门外 -->
          <span v-if="editDialog.encoding !== 'utf-8'" class="edit-enc mono">
            {{ editEncodingLabel }}
          </span>
          <span v-if="editDirty" class="edit-dirty">未保存</span>
          <!-- 只有 markdown 有预览，其它文件不显示这个切换 -->
          <div v-if="editIsMarkdown" class="view-switch">
            <button
              v-for="m in viewModes"
              :key="m.key"
              :class="{ active: editDialog.viewMode === m.key }"
              @click="editDialog.viewMode = m.key"
            >
              {{ m.label }}
            </button>
          </div>
          <WinControls
            :maximized="editWin.mode === 'max'"
            :minned="editWin.mode === 'min'"
            @minimize="editWin.minimize()"
            @restore="editWin.restore()"
            @toggle-max="editWin.toggleMax()"
            @close="handleEditClose(() => (editDialog.visible = false))"
          />
        </div>
      </template>

      <div class="edit-path mono">{{ editDialog.path }}</div>
      <!--
        原来是个 <textarea>，只能看纯文本；换成 CodeMirror 后：语法高亮（json/yaml/sh/
        nginx/dockerfile/sql…）、行号、Ctrl+F 搜索、括号匹配、自动缩进都白送。
        Ctrl+S 由编辑器内部 keymap 转成 save 事件，和旧行为一致。
      -->
      <div
        class="editor-wrap"
        :class="{ split: editSplit, 'preview-only': editIsMarkdown && editDialog.viewMode === 'preview' }"
      >
        <div v-show="editDialog.viewMode !== 'preview'" class="editor-pane">
          <CodeEditor
            v-model="editDialog.content"
            :filename="editDialog.name"
            :readonly="!editDialog.writable"
            @save="saveEdit"
          />
        </div>
        <!--
          右栏：markdown 的实时预览。不做 v-if 切换而是在分栏模式下常驻，
          因为重建组件会丢滚动位置 —— 对比左右两栏时最烦的就是这个。
        -->
        <div
          v-if="editIsMarkdown"
          v-show="editDialog.viewMode !== 'editor'"
          class="preview-pane"
        >
          <MarkdownPreview :content="editDialog.content" />
        </div>
      </div>
      <template #footer>
        <div class="edit-foot">
          <span class="edit-meta mono">
            {{ editBytes }} 字节 · {{ editEncodingLabel }} ·
            {{ editDialog.writable ? 'Ctrl+S 保存' : '只读，无写权限' }} · Ctrl+F 查找
          </span>
          <div class="edit-actions">
            <el-button @click="handleEditClose(() => (editDialog.visible = false))">关闭</el-button>
            <!--
              包一层 span 是 el-tooltip 的要求（它要拿到子元素的引用才能定位）；
              disabled 的按钮本身不触发鼠标事件，靠外层 span 才能显示提示
            -->
            <el-tooltip
              :disabled="editDialog.writable"
              content="当前用户没有这个文件的写权限，保存不可用"
              placement="top"
            >
              <span class="save-slot">
                <el-button
                  type="primary"
                  :loading="editDialog.saving"
                  :disabled="!editDirty || !editDialog.writable"
                  @click="saveEdit"
                >
                  保存
                </el-button>
              </span>
            </el-tooltip>
          </div>
        </div>
      </template>
    </el-dialog>

    <!--
      日志查看器：只读、只取末尾若干行。
      和上面的编辑器是两套东西 —— 日志不需要"改"，也不需要整份读进来。
    -->
    <el-dialog
      v-model="logDialog.visible"
      :width="logWin.mode === 'max' ? MAX_WIDTH : 'min(1240px, 94vw)'"
      :top="logWin.mode === 'max' ? MAX_TOP : '5vh'"
      destroy-on-close
      :close-on-click-modal="false"
      :show-close="false"
      :class="['log-dialog', logWin.mode]"
    >
      <template #header>
        <div
          class="edit-head"
          :class="{ min: logWin.mode === 'min' }"
          @click="logWin.mode === 'min' && logWin.restore()"
          @dblclick="logWin.mode !== 'min' && logWin.toggleMax()"
        >
          <span class="edit-badge" :class="logDialog.side">
            {{ logDialog.side === 'local' ? '本地' : '远程' }}
          </span>
          <el-icon v-if="logWin.mode === 'min'" class="min-ico"><Tickets /></el-icon>
          <span class="edit-name mono truncate" :title="logDialog.path">{{ logDialog.name }}</span>
          <span class="log-tag">日志 · 只读</span>
          <!-- 文件比要的行数长，得说清楚"上面还有"，否则会以为日志只有这么点 -->
          <span v-if="logDialog.truncated" class="log-cut">前面还有内容</span>
          <WinControls
            :maximized="logWin.mode === 'max'"
            :minned="logWin.mode === 'min'"
            @minimize="logWin.minimize()"
            @restore="logWin.restore()"
            @toggle-max="logWin.toggleMax()"
            @close="logDialog.visible = false"
          />
        </div>
      </template>

      <div class="edit-path mono">{{ logDialog.path }}</div>

      <div class="log-bar">
        <span class="log-hint">显示最后</span>
        <el-select
          v-model="logDialog.want"
          size="small"
          class="log-pick"
          @change="() => reloadLog()"
        >
          <el-option v-for="n in LOG_LINE_OPTIONS" :key="n" :label="`${n} 行`" :value="n" />
        </el-select>
        <el-button size="small" :icon="Refresh" :loading="logDialog.loading" @click="() => reloadLog()">
          刷新
        </el-button>
        <el-checkbox v-model="logDialog.auto" size="small">自动刷新</el-checkbox>
        <span class="log-meta mono">{{ logMeta }}</span>
      </div>

      <div class="editor-wrap log-wrap">
        <div class="editor-pane">
          <CodeEditor
            ref="logEditor"
            :model-value="logDialog.content"
            :filename="logDialog.name"
            :line-numbers="false"
            readonly
          />
        </div>
      </div>

      <template #footer>
        <div class="edit-foot">
          <span class="edit-meta mono">日志只读，不提供保存 · Ctrl+F 查找</span>
          <el-button @click="logDialog.visible = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 只读预览（office 文档 / PDF）：不写回 -->
    <el-dialog
      v-model="previewDialog.visible"
      :width="previewWin.mode === 'max' ? MAX_WIDTH : 'min(1120px, 90vw)'"
      :top="previewWin.mode === 'max' ? MAX_TOP : '5vh'"
      destroy-on-close
      :show-close="false"
      :class="['preview-dialog', previewWin.mode]"
    >
      <template #header>
        <div
          class="edit-head"
          :class="{ min: previewWin.mode === 'min' }"
          @click="previewWin.mode === 'min' && previewWin.restore()"
          @dblclick="previewWin.mode !== 'min' && previewWin.toggleMax()"
        >
          <span class="edit-badge" :class="previewDialog.side">
            {{ previewDialog.side === 'local' ? '本地' : '远程' }}
          </span>
          <el-icon v-if="previewWin.mode === 'min'" class="min-ico"><View /></el-icon>
          <span class="edit-name mono truncate" :title="previewDialog.path">
            {{ previewDialog.name }}
          </span>
          <span class="preview-tag" :class="{ off: !previewRenderable }">{{ previewTag }}</span>
          <WinControls
            :maximized="previewWin.mode === 'max'"
            :minned="previewWin.mode === 'min'"
            @minimize="previewWin.minimize()"
            @restore="previewWin.restore()"
            @toggle-max="previewWin.toggleMax()"
            @close="previewDialog.visible = false"
          />
        </div>
      </template>

      <div class="preview-body">
        <!-- 图片、PDF、office 各有一套渲染逻辑和工具条，靠扩展名分派，互不影响 -->
        <ImagePreview
          v-if="previewDialog.base64 && isViewableImage(previewDialog.name)"
          :base64="previewDialog.base64"
          :filename="previewDialog.name"
          :size="previewDialog.size"
        />
        <PdfPreview
          v-else-if="previewDialog.base64 && isPdf(previewDialog.name)"
          :base64="previewDialog.base64"
          :filename="previewDialog.name"
          :size="previewDialog.size"
        />
        <OfficePreview
          v-else-if="previewDialog.base64"
          :base64="previewDialog.base64"
          :filename="previewDialog.name"
          :size="previewDialog.size"
        />
      </div>

      <template #footer>
        <div class="edit-foot">
          <span class="edit-meta mono">{{ formatSize(previewDialog.size, false) }} · 只读，不会写回</span>
          <div class="edit-actions">
            <el-button @click="previewDialog.visible = false">关闭</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <!-- 右键菜单 -->
    <FileContextMenu
      :visible="ctx.visible"
      :x="ctx.x"
      :y="ctx.y"
      :items="menuItems"
      @pick="onMenuPick"
      @close="closeCtx"
    />

    <!-- 属性 -->
    <el-dialog v-model="propDialog.visible" title="属性" width="470px">
      <div v-if="propDialog.entry" class="props">
        <div class="prop-row">
          <span class="prop-k">名称</span>
          <span class="prop-v">{{ propDialog.entry.name }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-k">类型</span>
          <span class="prop-v">
            {{ kindLabel(kindOf(propDialog.entry.name, propDialog.entry.isDir)) }} ·
            {{ propDialog.side === 'local' ? '本地' : '远程' }}
          </span>
        </div>
        <div class="prop-row">
          <span class="prop-k">大小</span>
          <span class="prop-v mono">{{ propSize(propDialog.entry) }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-k">修改时间</span>
          <span class="prop-v mono">{{ formatTime(propDialog.entry.mtime) }}</span>
        </div>
        <div v-if="propDialog.side === 'remote'" class="prop-row">
          <span class="prop-k">权限</span>
          <span
            class="prop-v mono"
            :class="{ 'no-write': propDialog.entry.writable === false }"
          >
            {{ formatMode(propDialog.entry) }}
          </span>
        </div>
        <div v-if="propDialog.side === 'remote'" class="prop-row">
          <span class="prop-k">属主 / 属组</span>
          <span class="prop-v mono">
            {{ ownerText(propDialog.entry) }}
            <span v-if="propDialog.entry.writable === false" class="no-write">（当前用户不可写）</span>
          </span>
        </div>
        <div class="prop-row">
          <span class="prop-k">位置</span>
          <span class="prop-v mono prop-path">{{ propDialog.entry.path }}</span>
        </div>
      </div>
      <template #footer>
        <el-button @click="propDialog.visible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.fm {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-base);
}

.panes {
  flex: 1;
  display: flex;
  min-height: 0;
}

.pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.pane + .pane {
  border-left: 1px solid var(--border);
}

.pane-bar {
  height: 34px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-soft);
}

.pane-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  flex: none;
}

.pane-tag.local {
  color: var(--tag-local-fg);
  background: var(--tag-local-bg);
}

/* 标签本身是「跳转」下拉的触发器 */
.pane-tag.jump {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  user-select: none;
}

.pane-tag.jump:hover {
  filter: brightness(1.15);
}

.caret {
  font-size: 9px;
  opacity: 0.7;
}

.pane-tag.remote {
  color: var(--accent);
  background: var(--accent-soft);
}

/* 路径栏右侧的图标按钮：周围没有文字参照，字号要比行内图标再大一档，
   并且给成固定 26×26 的方框，悬停底色才是正方形而不是被 padding 拉长的条 */
/* 路径栏的上一级 / 选择目录 / 刷新。
   字号跟页签栏那些图标对齐（--icon-sm 16px）—— 这三个是一排并列的小动作，
   比行内图标再大一档（21px）会显得整条栏被图标压住。方框 24×24 是为了
   悬停底色是正方形（裸 inline 元素加 padding 会拉成横条）。 */
.ic {
  font-size: var(--icon-sm);
  color: var(--text-2);
  cursor: pointer;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  flex: none;
}

.ic:hover {
  color: var(--accent);
  background: var(--bg-hover);
}

.ic.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.path-input {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  font-size: 11.5px;
  outline: none;
}

.path-input:hover {
  border-color: var(--border);
}

.path-input:focus {
  border-color: var(--accent-line);
  background: var(--bg-base);
  color: var(--text-1);
}

.list {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.list-head,
.row {
  display: grid;
  grid-template-columns: 1fr 78px 116px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
}

/* 远程多两列：权限、属主/属组。本地是 Windows，没有这套东西，不加 */
.list.remote .list-head,
.list.remote .row {
  grid-template-columns: 1fr 68px 110px 78px 116px;
}

/* 用容器查询而不是媒体查询：窗口宽不宽不重要，重要的是**这一栏**还剩多少像素。
   1080 的最小窗口下每栏只有 400 出头，硬塞五列会把文件名挤没。 */
.list {
  container-type: inline-size;
}

@container (max-width: 560px) {
  .list.remote .list-head,
  .list.remote .row {
    grid-template-columns: 1fr 68px 78px 116px;
  }
  .list.remote .col-owner {
    display: none;
  }
}

@container (max-width: 450px) {
  .list.remote .list-head,
  .list.remote .row {
    grid-template-columns: 1fr 78px 116px;
  }
  .list.remote .col-mode {
    display: none;
  }
}

.col-mode,
.col-owner {
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 当前 SSH 用户写不了：整串权限标红。这一列最常被用来判断"要不要 sudo" */
.col-mode.nowrite {
  color: var(--danger);
}

.list-head {
  height: 26px;
  flex: none;
  font-size: 10.5px;
  color: var(--text-3);
  border-bottom: 1px solid var(--border-soft);
  letter-spacing: 0.4px;
}

.rows {
  flex: 1;
  overflow-y: auto;
  padding: 2px 4px;
}

.row {
  height: 29px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
}

.row:hover {
  background: var(--bg-hover);
}

.row.selected {
  background: var(--accent-soft);
  color: var(--text-1);
}

/* 被剪切的条目淡显，和资源管理器一样，一眼能看出"这个已经被拿走了" */
.row.cutting {
  opacity: 0.45;
}

.col-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fname {
  min-width: 0;
}

.col-size,
.col-time {
  font-size: 10.5px;
  color: var(--text-3);
  text-align: right;
}

.empty {
  padding: 24px;
  text-align: center;
  font-size: 11.5px;
  color: var(--text-3);
}

.pane-foot {
  height: 38px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border-soft);
}

/* Element Plus 的小号按钮图标只有 14px，在这一栏里显得又小又难点。
   纯图标的按钮必须做成正方形：带 padding 的 text 按钮在 hover 时
   会拉出一条横向长条，配上下方的方角图标很别扭。 */
.pane-foot :deep(.el-button) {
  height: 28px;
  border-radius: 6px;
  color: var(--text-2);
}

.pane-foot :deep(.el-button.is-text:not(:has(span))) {
  width: 28px;
  padding: 0;
}

/* 自己画的图标（重命名）要单独兜成正方形：EP 会把 slot 里的内容包一层 <span>，
   上面那条 :not(:has(span)) 就命中不了，按钮会变成带 padding 的长条，跟旁边对不齐 */
.pane-foot :deep(.el-button.is-text.sq) {
  width: 28px;
  padding: 0;
}

/* 图标跟页签栏一致（--icon-sm 16px）：底栏是一组并列的小按钮，
   比行内图标再大一档（19px）会跟上面的路径栏、下面的状态栏都不成比例 */
.pane-foot :deep(.el-button .el-icon) {
  font-size: var(--icon-sm);
}

/* 主操作（上传/下载）和左侧的图标按钮拉开层级 */
.pane-foot :deep(.el-button.is-text.el-button--primary) {
  padding: 0 9px;
  color: var(--accent);
}

.pane-foot :deep(.el-button.is-text.el-button--primary:not(.is-disabled):hover) {
  color: var(--accent);
  background: var(--accent-soft);
}

/* 删除是破坏性操作，别和「重命名」长得一模一样 */
.pane-foot :deep(.el-button.del:not(.is-disabled):hover) {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}

.edit-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 「本地 / 远程」小标签：一眼知道改的是哪边的文件 */
.edit-badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10.5px;
  line-height: 16px;
  border: 1px solid var(--border);
  color: var(--text-3);
  background: var(--bg-panel-2);
}

.edit-badge.remote {
  color: var(--accent);
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

.edit-name {
  font-size: 13px;
  color: var(--text-1);
  min-width: 0;
}

.edit-dirty {
  flex: none;
  margin-left: 4px;
  font-size: 11px;
  color: var(--warning);
}

/* 无写权限的标记：用危险的红色调，跟"未保存"的黄色区分开 */
.edit-ro {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--danger);
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

/* 编码标记：中性色，别跟「只读」那种报警色抢注意力 */
.edit-enc {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--text-3);
  border: 1px solid var(--border);
  background: var(--bg-base);
}

/* 编辑 / 分栏 / 预览 分段切换：只有 markdown 会渲染出来 */
.view-switch {
  display: flex;
  gap: 1px;
  margin-left: auto;
  padding: 1px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel-2);
}

.view-switch button {
  padding: 2px 10px;
  font-size: 11.5px;
  color: var(--text-3);
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
}

.view-switch button:hover {
  color: var(--text-1);
}

.view-switch button.active {
  color: var(--accent);
  background: var(--accent-soft);
}

/* el-tooltip 的挂载点：inline-flex 才不会在按钮外面多出一块行内空白 */
.save-slot {
  display: inline-flex;
}

.edit-foot {
  display: flex;
  align-items: center;
  gap: 12px;
}

.edit-meta {
  flex: 1;
  text-align: left;
  font-size: 11px;
  color: var(--text-3);
}

.edit-actions {
  display: flex;
  gap: 8px;
}

.edit-path {
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 8px;
  word-break: break-all;
}

/* ---------- 日志查看器 ---------- */
.log-tag {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--text-3);
  border: 1px solid var(--border);
  background: var(--bg-base);
}

/* "前面还有内容"用警告黄而不是危险红：日志被截掉一部分是正常状态，不是出错 */
.log-cut {
  flex: none;
  font-size: 11px;
  color: var(--warning);
}

.log-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 11.5px;
  color: var(--text-3);
}

.log-hint {
  white-space: nowrap;
}

.log-pick {
  width: 104px;
}

/* 元信息靠右：左边是"能点的"，右边是"读的"，混在一起会当按钮点 */
.log-meta {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}

.log-bar :deep(.el-checkbox__label) {
  font-size: 11.5px;
}

/* 日志比编辑器再高一档：一屏多一行是一行 */
.log-wrap {
  height: 62vh;
}

/* ---------- 办公文档预览 ---------- */
.preview-body {
  height: 68vh;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-base);
  overflow: hidden;
}

.preview-tag {
  flex: none;
  /* 不再用 margin-left:auto 把自己顶到最右：右边现在是窗口按钮的地盘，
     两个 auto 会互相分空白，标签会飘在中间 */
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.preview-tag.off {
  color: var(--text-3);
  background: var(--bg-panel);
}

/* CodeMirror 宿主：高度撑满、边框和旧 textarea 对齐，圆角裁剪避免滚到底时溢出。
   分栏时它是个 flex 容器：左编辑、右预览，中间一条竖线。 */
.editor-wrap {
  display: flex;
  height: 58vh;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-base);
  overflow: hidden;
}

/* 编辑栏：min-width:0 是关键，否则 CodeMirror 的长行会把 flex 子项撑破，
   右栏被挤成一条缝 */
.editor-pane {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

.editor-wrap.split .editor-pane {
  flex: 1 1 50%;
}

/* 只看预览时左栏不显示，右栏必须铺满，否则会只剩右半边 */
.editor-wrap.preview-only .preview-pane {
  flex: 1 1 100%;
  border-left: none;
}

/* 预览栏：独立滚动，不跟着代码编辑器滚 */
.preview-pane {
  flex: 1 1 50%;
  min-width: 0;
  height: 100%;
  border-left: 1px solid var(--border);
  overflow: hidden;
}

.editor-wrap:focus-within {
  border-color: var(--accent-line);
}

/* ---------- 属性面板 ---------- */
.props {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.prop-row {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 10px;
  padding: 7px 2px;
  border-bottom: 1px solid var(--border-soft);
  font-size: 12.5px;
}

.prop-row:last-child {
  border-bottom: none;
}

.prop-k {
  color: var(--text-3);
}

.prop-v {
  color: var(--text-1);
  word-break: break-all;
}

.prop-path {
  font-size: 11.5px;
  color: var(--text-2);
  line-height: 1.5;
}

/* 属性面板里"当前用户不可写"跟着权限列一个色，两处说法一致 */
.prop-v.no-write {
  color: var(--danger);
}

.no-write {
  color: var(--danger);
}

/* ==================== 弹窗的窗口态：最大化 / 最小化 ====================
   `.el-dialog` 本体、遮罩、`__body` / `__footer` 都是 Element Plus 自己建的
   （而且 teleport 到 body 上），没有 data-v，所以只能 :global 选。
   内容区仍是我渲染的，带 data-v，可以照常写普通选择器。 */

/* 最大化：定高 + flex 列，让正文区自己吃掉剩下的高度。
   不写 `height: calc(100vh - 148px)` 这种算法 —— 头部/底栏一改字号就得重算，
   而且算多了会把底栏顶出屏幕。 */
:global(.el-dialog.max) {
  height: calc(100vh - 18px);
  display: flex;
  flex-direction: column;
  margin-bottom: 0;
}

:global(.el-dialog.max .el-dialog__body) {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 路径行和日志工具条不许被压：窗口矮的时候 flex 会先拿它们开刀，
   结果 select 和按钮只剩半个 */
:global(.el-dialog.max .edit-path),
:global(.el-dialog.max .log-bar) {
  flex: none;
}

/* 原先定高的几块内容（68vh / 58vh / 62vh）在最大化时改成"占满剩余空间"。
   注意 :global 必须把**整条选择器**包进去：写成 `:global(.a) .b` 时 Vue 会把
   `.b` 连同空格一起吞掉，编译出来只剩 `.el-dialog.max{height:auto}`，
   直接把上面那条定高又改回去了 */
:global(.el-dialog.max .preview-body),
:global(.el-dialog.max .editor-wrap) {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
}

/* 最小化：整块对话框缩到右下角，正文和底栏只是 display:none —— 组件没卸载，
   所以编辑器未保存的内容、PDF 已经画好的画布、图片的缩放位置都还在 */
:global(.el-dialog.min) {
  position: fixed;
  right: 14px;
  bottom: 30px;
  top: auto;
  left: auto;
  margin: 0 !important;
  width: 320px !important;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  /* 遮罩被设成 pointer-events:none 后，这里必须自己收回来，否则小条也点不动 */
  pointer-events: auto;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.36);
}

/* 遮罩要"透明且不吃点击"：不然收起来之后后面的文件列表点不动，小条等于摆设 */
:global(.el-overlay:has(.el-dialog.min)) {
  background: transparent;
  pointer-events: none;
}

/* 三个弹窗可以同时被收起，各给一个固定档位 —— 都用 bottom:30px 的话它们会叠成一坨 */
:global(.log-dialog.min) {
  bottom: 68px;
}

:global(.edit-dialog.min) {
  bottom: 106px;
}

:global(.el-dialog.min .el-dialog__header) {
  padding: 0;
  margin: 0;
}

:global(.el-dialog.min .el-dialog__body),
:global(.el-dialog.min .el-dialog__footer) {
  display: none;
}

/* 收起时标题栏就是那条小条：只留「哪份文件 + 有没有未保存 + 三颗按钮」。
   右边留 10px：按钮组自己带 -8px 的外探，合起来正好贴着卡片边 2px */
.edit-head.min {
  padding: 5px 10px;
  cursor: pointer;
}

.edit-head.min:hover {
  background: var(--bg-hover);
}

.edit-head.min .edit-name {
  flex: 1;
  font-size: 12px;
}

/* 小条上留一个小图形：三个弹窗可能同时收着，光看文件名分不清哪个是预览哪个是编辑器 */
.edit-head.min .min-ico {
  flex: none;
  font-size: 12px;
  color: var(--text-3);
}

.edit-head.min .edit-badge,
.edit-head.min .preview-tag,
.edit-head.min .log-tag,
.edit-head.min .log-cut,
.edit-head.min .edit-ro,
.edit-head.min .edit-enc,
.edit-head.min .view-switch {
  display: none;
}
</style>
