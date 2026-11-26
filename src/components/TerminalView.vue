<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { ArrowDown, ArrowUp, Close, CopyDocument, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../stores/app'
import type { Tab } from '../stores/app'
import { HOT_COMMANDS, QUICK_GROUPS, QUICK_TOTAL, type QuickCommand, type QuickGroup } from '../utils/quick-commands'

const props = defineProps<{ tab: Tab }>()
const store = useAppStore()

/**
 * 本地终端和远程终端在这个组件里共用一套 xterm，
 * 差别只有两处：字节往哪个通道写、快捷命令栏要不要显示。
 * 分成两个组件的话，搜索/复制/右键菜单/主题那一大坨要复制一遍，没必要。
 */
const isLocal = computed(() => props.tab.kind === 'local')

/** 往当前会话写字节。本地走 shell，远程走 ssh —— 其余逻辑完全一致 */
function sendData(data: string): void {
  if (!props.tab.sessionId) return
  if (isLocal.value) window.api.shell.write(props.tab.sessionId, data)
  else window.api.ssh.write(props.tab.sessionId, data)
}

function sendResize(cols: number, rows: number): void {
  if (!props.tab.sessionId) return
  if (isLocal.value) window.api.shell.resize(props.tab.sessionId, cols, rows)
  else window.api.ssh.resize(props.tab.sessionId, cols, rows)
}

const termHost = ref<HTMLDivElement>()
const searchOpen = ref(false)
const searchText = ref('')
const panelOpen = ref(false)
/** 命令面板里的搜索词：69 条命令靠翻是找不到的，先收窄再点 */
const qpQuery = ref('')
const qpInput = ref<HTMLInputElement>()
const ctx = ref({ visible: false, x: 0, y: 0 })

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let offData: (() => void) | null = null
let offLocalData: (() => void) | null = null
let offLocalExit: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null
let rafId = 0

const darkTheme = {
  background: '#0f1218',
  foreground: '#d7dee8',
  cursor: '#2dd4bf',
  cursorAccent: '#0f1218',
  selectionBackground: 'rgba(45, 212, 191, 0.28)',
  black: '#1b2029',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#cbd5e1',
  brightBlack: '#4b5563',
  brightRed: '#fca5a5',
  brightGreen: '#6ee7b7',
  brightYellow: '#fcd34d',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f1f5f9'
}

/**
 * 浅色主题的 ANSI 调色板。
 *
 * ⚠️ 这里踩过一次：整套 bright* 以及 white 原本是按"深色底"配的浅色，
 * 搬到白底上直接没法看 —— 而且最要命的是 white(37) 和 brightWhite(97)，
 * 白底上对比度只有 1.2:1 和 1.05:1，等于隐形。
 *
 * 具体症状：PowerShell 的 PSReadLine 用 ANSI 画语法高亮，
 * 敲 `cd D:` 时 `cd` 是 brightYellow(93)、`D:` 是 white(37)、
 * 行内预测建议是 brightWhite(97) —— 三个全落在浅色区间里，
 * 用户看到的就是"这几坨字怎么这么浅"。
 *
 * 修法不去动 PowerShell（$PSStyle / PSReadLine 的配色是用户自己的环境，
 * 之前就因为覆盖过一次被要求还原），而是把浅色主题的调色板改对：
 * 浅底上的 "bright" 不该更亮，该更深 —— 白底上"更醒目"就是"更黑"。
 * 取值参照 VS Code Default Light+ 的思路（它的 ansiWhite 是 #555 而不是 #fff），
 * 并保证对比度：正文色 ≥ 4.5:1、预测建议这种弱化文字 ≥ 3:1。
 */
const lightTheme = {
  background: '#ffffff',
  foreground: '#1f2937',
  cursor: '#0d9488',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(13, 148, 136, 0.2)',
  black: '#1f2937',
  red: '#dc2626',
  green: '#059669',
  yellow: '#b45309',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  // 37 号色：PSReadLine 用它画"裸参数"（cd D: 里的 D:），很多 CLI 也拿它当次要正文。
  // 原来是 #e5e7eb（白底 1.24:1 ≈ 隐形），改成深灰后 7.0:1。
  white: '#57606f',
  brightBlack: '#6b7280',
  brightRed: '#b91c1c',
  brightGreen: '#047857',
  // 93 号色：PSReadLine 画命令名，原来是 #f59e0b（2.2:1），现在是 5.4:1
  brightYellow: '#a16207',
  brightBlue: '#1d4ed8',
  brightMagenta: '#7e22ce',
  brightCyan: '#0e7490',
  // 97 号色：行内预测建议（还会再叠一层 dim），原来是 #f9fafb（1.05:1），现在是 4.6:1
  brightWhite: '#6f7885'
}

function currentTheme() {
  return store.config.settings.theme === 'light' ? lightTheme : darkTheme
}

/**
 * 把当前配色挂到 window 上。
 *
 * 冒烟要算"白底上 ANSI 白到底看不看得见"（对比度），读的就是这份实时表；
 * 排查"某个颜色怎么这么浅"时也能直接在控制台敲 __termTheme 看，不用翻源码。
 */
function publishTheme(): void {
  ;(window as unknown as { __termTheme?: unknown }).__termTheme = currentTheme()
}

function doFit() {
  if (!term || !fitAddon || !termHost.value) return
  // 隐藏状态下（display:none）容器尺寸为 0，fit 会算成 1x1 把内容压没
  if (termHost.value.clientWidth < 20 || termHost.value.clientHeight < 20) return
  try {
    fitAddon.fit()
  } catch {
    /* 容器尚未稳定，下一帧再试 */
  }
}

async function copySelection() {
  if (!term) return
  const text = term.getSelection()
  if (!text) return
  try {
    await window.api.clipboard.write(text)
    ElMessage.success({ message: '已复制', duration: 900 })
  } catch {
    ElMessage.error('复制失败')
  }
}

async function pasteClipboard() {
  if (!term) return
  try {
    const text = await window.api.clipboard.read()
    if (text) sendData(text)
  } catch {
    ElMessage.error('读取剪贴板失败')
  }
}

function runQuick(item: QuickCommand) {
  term?.focus()
  // 带占位参数的命令只写进提示符、不回车：直接跑一条写死端口号的 lsof，
  // 输出是空的，看着像"这条命令没用"，其实是要先改参数。
  sendData(item.mode === 'fill' ? item.cmd : item.cmd + '\r')
  // 执行后收起面板，否则挡住刚打出来的结果
  panelOpen.value = false
}

function togglePanel() {
  panelOpen.value = !panelOpen.value
  if (panelOpen.value) {
    // 每次打开都从干净的全量列表开始；顺手把焦点放进搜索框 ——
    // 打开这个面板，十次有九次是"我要找某条命令"
    qpQuery.value = ''
    void nextTick(() => qpInput.value?.focus())
  } else {
    term?.focus()
  }
}

/** 面板开着时按 Esc 关掉。终端把按键都吞了，所以在 window 捕获阶段拦一层 */
function onPanelKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !panelOpen.value) return
  event.stopPropagation()
  // 第一次 Esc 只清搜索词：搜错了想退回全量表，不该顺手把面板一起关掉
  if (qpQuery.value) {
    qpQuery.value = ''
    qpInput.value?.focus()
    return
  }
  panelOpen.value = false
  term?.focus()
}

/** 悬停气泡的补充行：参数怎么读 / 什么时候会误判 */
function tipLines(item: QuickCommand): string[] {
  const lines = item.note ? [item.note] : []
  if (item.mode === 'fill') lines.push('点击只插入命令行，改完参数再回车')
  return lines
}

/**
 * 命令面板的过滤结果。
 *
 * 匹配范围就是"屏幕上看得见的东西"：cmd / desc / 分组名。
 * 曾经把 note 也算进去，结果搜 docker 时冒出一条 `findmnt -T`（它的悬停说明里提到了
 * /var/lib/docker），卡片上却一个 docker 都找不到 —— 用户只会觉得这过滤是乱来的。
 * 规则简单点：搜到的词必须能在卡片或它所在的分组名上看见。
 *
 * 分组名参与匹配是为了能整组捞：搜「网络」要把 ss -tunlp 这些带出来，
 * 而它们命令里根本没有"网络"两个字。
 *
 * 空格分隔的多个词按 AND 处理：搜「磁盘 排序」只留 `du -sh * | sort -h` 这种两条都占的。
 */
const qpGroups = computed<QuickGroup[]>(() => {
  const terms = qpQuery.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return QUICK_GROUPS
  return QUICK_GROUPS.map((g) => {
    // 分组名命中就把整组端上来，不再逐条筛 —— 否则"磁盘与文件"只露出两条，看着像丢命令
    const label = g.label.toLowerCase()
    const byGroup = terms.every((t) => label.includes(t))
    return {
      label: g.label,
      commands: byGroup
        ? g.commands
        : g.commands.filter((c) => {
            const hay = `${c.cmd} ${c.desc}`.toLowerCase()
            return terms.every((t) => hay.includes(t))
          })
    }
  }).filter((g) => g.commands.length > 0)
})

const qpCount = computed(() => qpGroups.value.reduce((n, g) => n + g.commands.length, 0))

/**
 * 把命中搜索词的那几段切出来，好让 <mark> 上色。
 * 没有搜索词时整段返回，模板里就不用再写一层 v-if —— 两种情况下结构完全一样。
 */
function markParts(text: string): { t: string; hit: boolean }[] {
  const terms = qpQuery.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return [{ t: text, hit: false }]
  const low = text.toLowerCase()
  const ranges: [number, number][] = []
  for (const term of terms) {
    let at = 0
    for (;;) {
      const i = low.indexOf(term, at)
      if (i < 0) break
      ranges.push([i, i + term.length])
      at = i + term.length
    }
  }
  if (!ranges.length) return [{ t: text, hit: false }]
  // 排序后并集：「磁盘」和「磁盘管理」同时命中时不能切成互相重叠的几截
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const out: { t: string; hit: boolean }[] = []
  let at = 0
  for (const [s, e] of merged) {
    if (s > at) out.push({ t: text.slice(at, s), hit: false })
    out.push({ t: text.slice(s, e), hit: true })
    at = e
  }
  if (at < text.length) out.push({ t: text.slice(at), hit: false })
  return out
}

function clearQpSearch(): void {
  qpQuery.value = ''
  qpInput.value?.focus()
}

function clearTerminal() {
  term?.clear()
  term?.focus()
}

function openCtx(event: MouseEvent) {
  event.preventDefault()
  ctx.value = {
    visible: true,
    x: Math.min(event.clientX, window.innerWidth - 170),
    y: Math.min(event.clientY, window.innerHeight - 180)
  }
}

function closeCtx() {
  ctx.value.visible = false
}

function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) {
    nextTick(() => {
      const input = document.querySelector<HTMLInputElement>('.search-bar input')
      input?.focus()
    })
  } else {
    term?.focus()
    searchAddon?.clearDecorations()
  }
}

function findNext() {
  if (searchText.value) searchAddon?.findNext(searchText.value)
}

function findPrev() {
  if (searchText.value) searchAddon?.findPrevious(searchText.value)
}

function initTerminal() {
  if (!termHost.value) return

  term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, 'Noto Sans Mono CJK SC', monospace",
    fontSize: store.config.settings.fontSize,
    lineHeight: 1.25,
    letterSpacing: 0.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 8000,
    theme: currentTheme(),
    allowProposedApi: true,
    macOptionIsMeta: true,
    rightClickSelectsWord: false
  })

  fitAddon = new FitAddon()
  searchAddon = new SearchAddon()
  term.loadAddon(fitAddon)
  term.loadAddon(searchAddon)
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      // 终端里的链接用系统浏览器打开，别在应用内跳转
      window.open(uri, '_blank')
    })
  )

  term.open(termHost.value)

  /**
   * ⚠️ onResize / onData 必须在第一次 fit **之前**挂上。
   *
   * fit() 会把 xterm 从默认的 80x24 改成容器的实际行列，那一下必须同步给对端。
   * 之前这里是先 doFit() 再 onResize，首次 fit 的事件没人接 —— SSH 那边因为连上后
   * 会重挂一次组件侥幸没露，本地终端则是 PTY 永远停在主进程给的 120x30，
   * 而 xterm 已经是 34 行 142 列。
   *
   * 后果不是"少了一行"，是 PowerShell 的 PSReadLine 重绘命令行时用**绝对光标定位**
   * （ESC[<行>;<列>H，行号按它自己那份窗口高度算）。两边行数一对不上，敲下第一个
   * 字母时光标就跑到提示符上面两三行去了 —— 看着像"光标飞了"，其实是尺寸没对齐。
   */
  term.onData((data) => sendData(data))
  term.onResize(({ cols, rows }) => sendResize(cols, rows))

  doFit()
  term.focus()
  // 双保险：容器恰好等于 80x24 时 fit 不产生尺寸变化、不触发 onResize，
  // 这时候主动同步一次，保证 PTY 从第一帧起就和界面一致
  sendResize(term.cols, term.rows)

  // Ctrl+F 搜索 / Ctrl+Shift+C 复制 / Ctrl+Shift+V 粘贴
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    const ctrl = event.ctrlKey || event.metaKey
    if (ctrl && event.key.toLowerCase() === 'f') {
      toggleSearch()
      return false
    }
    if (ctrl && event.shiftKey && event.key.toLowerCase() === 'c') {
      void copySelection()
      return false
    }
    if (ctrl && event.shiftKey && event.key.toLowerCase() === 'v') {
      void pasteClipboard()
      return false
    }
    return true
  })

  offData = window.api.ssh.onData(({ sessionId, data }) => {
    if (sessionId === props.tab.sessionId) term?.write(data)
  })
  // 本地终端：数据 + 退出都要听。退出时在屏幕上留一行字，
  // 否则用户敲完 exit 只看到提示符没了，不知道是崩了还是正常退的
  offLocalData = window.api.shell.onData(({ sessionId, data }) => {
    if (sessionId === props.tab.sessionId) term?.write(data)
  })
  offLocalExit = window.api.shell.onExit(({ sessionId, exitCode }) => {
    if (sessionId !== props.tab.sessionId) return
    term?.write(`\r\n\x1b[33m[本地 shell 已退出，退出码 ${exitCode}]\x1b[0m\r\n`)
  })

  resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(doFit)
  })
  resizeObserver.observe(termHost.value)
}

onMounted(() => {
  initTerminal()
  publishTheme()
  window.addEventListener('click', closeCtx)
  // 捕获阶段：xterm 的 textarea 会把按键都吃掉，冒泡阶段拦不到 Esc
  window.addEventListener('keydown', onPanelKeydown, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeCtx)
  window.removeEventListener('keydown', onPanelKeydown, true)
  cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
  offData?.()
  offLocalData?.()
  offLocalExit?.()
  term?.dispose()
  term = null
})

// 切回终端标签时重新计算尺寸（v-show 隐藏期间拿不到真实宽高）
watch(
  () => props.tab.view,
  async (view) => {
    // 切走时把命令面板收掉：回来时还悬着一个上次没关的浮层很奇怪
    if (view !== 'terminal') panelOpen.value = false
    if (view !== 'terminal') return
    await nextTick()
    setTimeout(doFit, 60)
  }
)

// 字号实时生效
watch(
  () => store.config.settings.fontSize,
  (size) => {
    if (!term) return
    term.options.fontSize = size
    setTimeout(doFit, 40)
  }
)

// 主题切换：界面和终端一起换，避免深色界面配浅色终端那种割裂感
watch(
  () => store.config.settings.theme,
  () => {
    publishTheme()
    if (!term) return
    term.options.theme = currentTheme()
  }
)

// 会话重建（重连）后组件会重新挂载，epoch 变化时给个提示
watch(
  () => props.tab.epoch,
  () => {
    doFit()
  }
)
</script>

<template>
  <div class="terminal-wrap">
    <transition name="slide">
      <div v-if="searchOpen" class="search-bar">
        <el-icon class="s-icon"><Search /></el-icon>
        <input
          v-model="searchText"
          class="s-input"
          placeholder="在终端中查找…"
          @keyup.enter="findNext"
          @keyup.shift.enter="findPrev"
          @keyup.esc="toggleSearch"
        />
        <el-button text size="small" @click="findPrev">上一个</el-button>
        <el-button text size="small" @click="findNext">下一个</el-button>
        <el-icon class="s-close" @click="toggleSearch"><Close /></el-icon>
      </div>
    </transition>

    <!-- data-session-id 是给自动化冒烟用的：合成键盘事件要窗口有焦点，
         无人值守跑的时候经常丢字，冒烟就靠这个属性直接调 IPC 往 PTY 写 -->
    <div
      ref="termHost"
      class="term-host"
      :data-session-id="props.tab.sessionId"
      @contextmenu="openCtx"
      @mousedown="panelOpen = false"
    />

    <!-- 快捷命令是给 Linux 运维用的（df/ss/journalctl），本机 Windows shell 上按下去全是
         "不是内部或外部命令"。本地终端直接不显示这一栏，把高度让给终端本身。 -->
    <div v-if="!isLocal" class="quick-bar">
      <button class="quick-label" :class="{ on: panelOpen }" @click="togglePanel">
        <el-icon :class="{ flip: panelOpen }"><ArrowUp /></el-icon>
        快捷命令
        <!-- 带个总数，不然"这里能点开"和"一共多少条"都看不出来 -->
        <span class="ql-count">{{ QUICK_TOTAL }}</span>
      </button>

      <!-- 常驻的一键命令：最常用的几条，点一下直接跑 -->
      <div class="quick-list">
        <el-tooltip
          v-for="item in HOT_COMMANDS"
          :key="item.cmd"
          placement="top"
          :show-after="220"
          popper-class="q-tip"
        >
          <template #content>
            <div class="q-tip-d">{{ item.desc }}</div>
            <div v-for="line in tipLines(item)" :key="line" class="q-tip-n">{{ line }}</div>
          </template>
          <button class="quick-chip mono" @click="runQuick(item)">{{ item.cmd }}</button>
        </el-tooltip>
      </div>
    </div>

    <!-- 全部命令浮层：挂在 .terminal-wrap 上而不是快捷栏里，
         这样 max-height 能按整个终端高度算，终端被拖矮时不会顶出窗格。
         做成浮层而不是横向再排一长条，是因为三十几条命令在一条会横滚的栏里根本找不到。 -->
    <div v-show="panelOpen && !isLocal" class="quick-panel">
      <div class="qp-head">
        <span class="qp-title">运维常用命令</span>

        <!-- 搜索框常驻在标题栏：命令列表只会越来越长，
             滚着找不如先收窄。打开面板时焦点自动落在这里，可以直接敲字 -->
        <div class="qp-search">
          <el-icon class="qs-icon"><Search /></el-icon>
          <input
            ref="qpInput"
            v-model="qpQuery"
            class="qs-input"
            type="text"
            spellcheck="false"
            placeholder="搜索命令或说明，如 端口 / 磁盘 / docker"
          />
          <button
            v-if="qpQuery"
            class="qs-clear"
            title="清空搜索（Esc）"
            @click.stop="clearQpSearch"
          >
            <el-icon><Close /></el-icon>
          </button>
        </div>

        <span class="qp-hint">
          {{ qpQuery ? `找到 ${qpCount} 条` : `共 ${QUICK_TOTAL} 条 · 点一下执行，悬停看说明` }}
        </span>
      </div>
      <div class="qp-body">
        <div v-for="group in qpGroups" :key="group.label" class="qp-group">
          <div class="qp-glabel">{{ group.label }}</div>
          <div class="qp-items">
            <el-tooltip
              v-for="item in group.commands"
              :key="item.cmd"
              placement="top"
              :show-after="260"
              popper-class="q-tip"
            >
              <template #content>
                <!-- 卡片上的命令会按宽度截断（journalctl 那条就放不下），
                     所以气泡里把完整命令再给一遍，免得"点了什么自己看不清"。 -->
                <div class="q-tip-c mono">{{ item.cmd }}</div>
                <div class="q-tip-d">{{ item.desc }}</div>
                <div v-for="line in tipLines(item)" :key="line" class="q-tip-n">{{ line }}</div>
              </template>
              <button class="qp-chip" :class="{ fill: item.mode === 'fill' }" @click="runQuick(item)">
                <!-- 命令文本单独一层负责截断。✎ 是一整条超长命令（curl、tcpdump）上唯一能看出
                     「点它只插入、不执行」的线索，不能跟着省略号一起被裁掉。 -->
                <span class="qp-cmd mono">
                  <span class="qp-cmd-t">
                    <template v-for="(p, i) in markParts(item.cmd)" :key="i"
                      ><mark v-if="p.hit" class="qp-hit">{{ p.t }}</mark
                      ><template v-else>{{ p.t }}</template></template
                    >
                  </span>
                  <span v-if="item.mode === 'fill'" class="qp-edit">✎</span>
                </span>
                <span class="qp-desc">
                  <template v-for="(p, i) in markParts(item.desc)" :key="i"
                    ><mark v-if="p.hit" class="qp-hit">{{ p.t }}</mark
                    ><template v-else>{{ p.t }}</template></template
                  >
                </span>
              </button>
            </el-tooltip>
          </div>
        </div>

        <!-- 搜不到时不能只剩一片空白 —— 得说清"是没匹配，不是没命令"，并给一条退路 -->
        <div v-if="!qpGroups.length" class="qp-empty">
          <span>没有匹配「{{ qpQuery }}」的命令</span>
          <button class="qp-empty-btn" @click.stop="clearQpSearch">看全部 {{ QUICK_TOTAL }} 条</button>
        </div>
      </div>
    </div>

    <teleport to="body">
      <div
        v-if="ctx.visible"
        class="ctx-menu"
        :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
        @click.stop
      >
        <div class="ctx-item" @click="copySelection(); closeCtx()">
          <el-icon><CopyDocument /></el-icon>复制
          <span class="ctx-kbd">Ctrl+Shift+C</span>
        </div>
        <div class="ctx-item" @click="pasteClipboard(); closeCtx()">
          <el-icon><ArrowDown /></el-icon>粘贴
          <span class="ctx-kbd">Ctrl+Shift+V</span>
        </div>
        <div class="ctx-item" @click="toggleSearch(); closeCtx()">
          <el-icon><Search /></el-icon>查找
          <span class="ctx-kbd">Ctrl+F</span>
        </div>
        <div class="ctx-sep" />
        <div class="ctx-item" @click="clearTerminal(); closeCtx()">清屏</div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.terminal-wrap {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-base);
}

.term-host {
  flex: 1;
  min-height: 0;
  padding: 6px 0 0 8px;
  overflow: hidden;
}

/* xterm 内部把 padding 吃掉了，用外层 padding 会更稳，但会导致
   FitAddon 计算偏差 —— 这里改为给 .xterm 元素自己补 padding */
.term-host :deep(.xterm) {
  padding: 2px 4px;
}

.term-host :deep(.xterm-viewport) {
  background-color: transparent !important;
}

.search-bar {
  height: 34px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}

.s-icon {
  font-size: 12px;
  color: var(--text-3);
}

.s-input {
  flex: 1;
  height: 24px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-1);
  font-size: 12.5px;
  font-family: var(--font-mono);
}

.s-close {
  font-size: 12px;
  color: var(--text-3);
  cursor: pointer;
}

.s-close:hover {
  color: var(--danger);
}

.quick-bar {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border-soft);
  min-height: 32px;
}

/* 面板浮层的锚点：栏本身的固定高度（32px），改这里要同步 .quick-panel 的 bottom */
.quick-label {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 3px 7px;
  /* 负外边距把文字左边缘顶回和下面列表对齐的位置，免得整栏看着往右缩进 */
  margin-left: -7px;
  border: none;
  border-radius: 5px;
  background: transparent;
  font-family: inherit;
  font-size: 11px;
  color: var(--text-3);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  transition: color 0.12s, background 0.12s;
}

.quick-label:hover {
  color: var(--text-2);
  background: var(--bg-base);
}

/* 展开状态跟选中态一样亮起来，不然点开浮层后看不出这个按钮是"开着的" */
.quick-label.on {
  color: var(--accent);
  background: var(--accent-soft);
}

.quick-label .el-icon {
  font-size: var(--icon-xs);
  transition: transform 0.15s;
}

.quick-label .el-icon.flip {
  transform: rotate(180deg);
}

.ql-count {
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-base);
  font-size: 10px;
  line-height: 15px;
  color: var(--text-3);
}

.quick-label.on .ql-count {
  border-color: transparent;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
}

.quick-list {
  display: flex;
  flex: 1 1 auto;
  gap: 6px;
  /* min-width:0 才能让这个 flex 子项真正收缩，否则内容撑到多宽它就有多宽，横向滚动失效 */
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.quick-list::-webkit-scrollbar {
  display: none;
}

.quick-chip {
  flex: none;
  padding: 3px 9px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--bg-base);
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-mono);
  cursor: pointer;
  transition: all 0.12s;
}

.quick-chip:hover {
  border-color: var(--accent-line);
  color: var(--accent);
  background: var(--accent-soft);
}

/* ---------- 全部命令浮层 ---------- */

.quick-panel {
  position: absolute;
  left: 10px;
  right: 10px;
  /* 快捷栏高度 32 + 8 的缝；改快捷栏高度的话这里要一起改 */
  bottom: 40px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  max-height: calc(100% - 52px);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}

.qp-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-soft);
}

.qp-title {
  flex: none;
  font-size: 12px;
  color: var(--text-1);
}

/* 搜索框夹在标题和计数之间，靠右但不贴边：
   margin-left:auto 把"剩下的空间"全给它左侧，宽度不给死，窄窗口时才不会被计数文案挤扁 */
.qp-search {
  margin-left: auto;
  flex: 0 1 340px;
  min-width: 150px;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-base);
  transition: border-color 0.12s, box-shadow 0.12s;
}

.qp-search:focus-within {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.qs-icon {
  flex: none;
  font-size: var(--icon-xs);
  color: var(--text-3);
}

.qs-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  font-size: 11.5px;
  color: var(--text-1);
}

.qs-input::placeholder {
  color: var(--text-3);
}

/* 清空按钮做成 14px 的小叉：不占地方，也不至于小到点不着 */
.qs-clear {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
}

.qs-clear:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.qp-hint {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}

/* 命中片段：底色比 hover 用的 --accent-soft(13%) 再重一档 ——
   11.5px 的等宽字上，13% 的底几乎看不出来，等于没标 */
.qp-hit {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
  color: var(--accent);
  border-radius: 2px;
}

.qp-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 36px 0 32px;
  font-size: 11.5px;
  color: var(--text-3);
}

.qp-empty-btn {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-base);
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
}

.qp-empty-btn:hover {
  border-color: var(--accent-line);
  color: var(--accent);
  background: var(--accent-soft);
}

.qp-body {
  flex: 1;
  min-height: 0;
  padding: 10px 12px 4px;
  overflow-y: auto;
}

.qp-group {
  margin-bottom: 10px;
}

.qp-glabel {
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 5px;
  padding-left: 2px;
}

/* 自适应列宽：宽窗口一排放 4 张卡片，窄窗口自动变 2 列。
   196px 太窄，`du -sh /* 2>/dev/null | sort -h` 这种会截掉尾巴，所以给到 224。 */
.qp-items {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(224px, 1fr));
  gap: 6px;
}

.qp-chip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  padding: 5px 8px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-base);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}

.qp-chip:hover {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}

/* 需要自己改参数的命令：虚线边框 + 铅笔标记，跟"点一下就执行"的区分开 */
.qp-chip.fill {
  border-style: dashed;
}

.qp-cmd {
  display: flex;
  align-items: baseline;
  gap: 3px;
  max-width: 100%;
  /* 少了这个，flex 项的默认 min-width:auto 会被最长的那条命令撑开，卡片宽度跟着涨、网格错位 */
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-1);
}

/* 真正被省略号截断的只有命令文本这一段 */
.qp-cmd-t {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qp-chip:hover .qp-cmd {
  color: var(--accent);
}

.qp-edit {
  flex: none;
  font-size: 10px;
  /* 原来用的是 --accent-line（分隔线那一档），10px 下淡到几乎看不见 ——
     ✎ 是这条命令会插入而不执行的唯一标记，看不清就等于没有。用次要文字色。 */
  color: var(--text-3);
}

.qp-desc {
  max-width: 100%;
  overflow: hidden;
  font-size: 11px;
  color: var(--text-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 右键菜单样式已抽到全局 style.css，与文件管理器的菜单共用一套 */

.slide-enter-active,
.slide-leave-active {
  transition: height 0.15s ease, opacity 0.15s ease;
}
.slide-enter-from,
.slide-leave-to {
  height: 0;
  opacity: 0;
}
</style>

<!-- 命令说明气泡的内容是 teleport 到 body 上的，scoped 样式够不着（拿不到 data-v），
     所以这一段单独写成非 scoped。颜色不写死：气泡背景由 --tooltip-* 按主题反转，
     这里只靠透明度分主次，深浅两套主题都不会糊。 -->
<style>
.q-tip {
  max-width: 320px;
}

.q-tip .q-tip-c {
  margin-bottom: 3px;
  font-size: 11.5px;
  opacity: 0.9;
}

.q-tip .q-tip-d {
  font-size: 12px;
  line-height: 1.45;
}

.q-tip .q-tip-n {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.45;
  opacity: 0.66;
}
</style>
