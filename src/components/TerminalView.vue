<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { ArrowDown, ArrowUp, Close, CopyDocument, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../stores/app'
import type { Tab } from '../stores/app'
import { HOT_COMMANDS, QUICK_GROUPS, QUICK_TOTAL, type QuickCommand } from '../utils/quick-commands'

const props = defineProps<{ tab: Tab }>()
const store = useAppStore()

const termHost = ref<HTMLDivElement>()
const searchOpen = ref(false)
const searchText = ref('')
const panelOpen = ref(false)
const ctx = ref({ visible: false, x: 0, y: 0 })

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let offData: (() => void) | null = null
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
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#ef4444',
  brightGreen: '#10b981',
  brightYellow: '#f59e0b',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#f9fafb'
}

function currentTheme() {
  return store.config.settings.theme === 'light' ? lightTheme : darkTheme
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
    if (text) window.api.ssh.write(props.tab.sessionId, text)
  } catch {
    ElMessage.error('读取剪贴板失败')
  }
}

function runQuick(item: QuickCommand) {
  term?.focus()
  // 带占位参数的命令只写进提示符、不回车：直接跑一条写死端口号的 lsof，
  // 输出是空的，看着像"这条命令没用"，其实是要先改参数。
  window.api.ssh.write(props.tab.sessionId, item.mode === 'fill' ? item.cmd : item.cmd + '\r')
  // 执行后收起面板，否则挡住刚打出来的结果
  panelOpen.value = false
}

function togglePanel() {
  panelOpen.value = !panelOpen.value
  if (!panelOpen.value) term?.focus()
}

/** 面板开着时按 Esc 关掉。终端把按键都吞了，所以在 window 捕获阶段拦一层 */
function onPanelKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && panelOpen.value) {
    event.stopPropagation()
    panelOpen.value = false
    term?.focus()
  }
}

/** 悬停气泡的补充行：参数怎么读 / 什么时候会误判 */
function tipLines(item: QuickCommand): string[] {
  const lines = item.note ? [item.note] : []
  if (item.mode === 'fill') lines.push('点击只插入命令行，改完参数再回车')
  return lines
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
  doFit()
  term.focus()

  term.onData((data) => window.api.ssh.write(props.tab.sessionId, data))
  term.onResize(({ cols, rows }) => window.api.ssh.resize(props.tab.sessionId, cols, rows))

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

  resizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(doFit)
  })
  resizeObserver.observe(termHost.value)
}

onMounted(() => {
  initTerminal()
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

    <div ref="termHost" class="term-host" @contextmenu="openCtx" @mousedown="panelOpen = false" />

    <div class="quick-bar">
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
    <div v-show="panelOpen" class="quick-panel">
      <div class="qp-head">
        <span class="qp-title">运维常用命令</span>
        <span class="qp-hint">共 {{ QUICK_TOTAL }} 条 · 点一下执行，悬停看说明</span>
      </div>
      <div class="qp-body">
        <div v-for="group in QUICK_GROUPS" :key="group.label" class="qp-group">
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
                <span class="qp-cmd mono">
                  {{ item.cmd }}
                  <span v-if="item.mode === 'fill'" class="qp-edit">✎</span>
                </span>
                <span class="qp-desc">{{ item.desc }}</span>
              </button>
            </el-tooltip>
          </div>
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
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-soft);
}

.qp-title {
  font-size: 12px;
  color: var(--text-1);
}

.qp-hint {
  font-size: 11px;
  color: var(--text-3);
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
  max-width: 100%;
  overflow: hidden;
  font-size: 11.5px;
  color: var(--text-1);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qp-chip:hover .qp-cmd {
  color: var(--accent);
}

.qp-edit {
  margin-left: 3px;
  font-size: 10px;
  color: var(--accent-line);
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
