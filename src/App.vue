<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useAppStore } from './stores/app'
import TitleBar from './components/TitleBar.vue'
import SideBar from './components/SideBar.vue'
import TabBar from './components/TabBar.vue'
import SessionPane from './components/SessionPane.vue'
import WelcomePanel from './components/WelcomePanel.vue'
import StatusBar from './components/StatusBar.vue'
import TransferDock from './components/TransferDock.vue'
import ServerDialog from './components/ServerDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import AboutDialog from './components/AboutDialog.vue'
import HelpDialog from './components/HelpDialog.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import { runCheck } from './utils/update-state'

const store = useAppStore()
const serverDialogVisible = ref(false)
const editingServerId = ref<string | null>(null)
const settingsVisible = ref(false)
const aboutVisible = ref(false)
const helpVisible = ref(false)
const updateVisible = ref(false)

/**
 * 侧边栏收起状态。用 localStorage 记住，而不是塞进 config.settings ——
 * 这是"临时把屏幕让出来"的操作，写进配置文件会污染导出/导入的 schema。
 */
const SIDEBAR_KEY = 'thshell.sidebar'
const sidebarOpen = ref(localStorage.getItem(SIDEBAR_KEY) !== '0')

function toggleSidebar(): void {
  sidebarOpen.value = !sidebarOpen.value
  localStorage.setItem(SIDEBAR_KEY, sidebarOpen.value ? '1' : '0')
}

/**
 * Ctrl+B 切侧边栏，和 VS Code 一致；输入框里不抢（编辑器里 Ctrl+B 另有含义）。
 * Ctrl+` 开一个本地终端 —— 终端软件的通用习惯，所以**在终端里按也要生效**：
 * xterm 的输入是个隐藏 textarea，光看 tagName 会被误判成"正在打字"。
 */
function onKeydown(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
  // 事件直接 dispatch 到 window 时 target 是 window，没有 classList ——
  // 不能用 as HTMLElement 硬转，否则这里抛错会把整个处理函数打断（快捷键看着像没生效）
  const el = e.target instanceof HTMLElement ? e.target : null
  const tag = el?.tagName
  const inTerminal = !!el?.classList?.contains('xterm-helper-textarea')
  const typing = !inTerminal && (tag === 'INPUT' || tag === 'TEXTAREA' || !!el?.isContentEditable)
  if (typing) return

  if (e.key.toLowerCase() === 'b') {
    e.preventDefault()
    toggleSidebar()
    return
  }
  if (e.key === '`') {
    e.preventDefault()
    void store.openLocalShell()
  }
}

let offState: (() => void) | undefined
let offProgress: (() => void) | undefined
let offTransfer: (() => void) | undefined
let offShellExit: (() => void) | undefined

// 主题是全局的：改 settings.theme 后写到 <html data-theme>，
// CSS 变量整体切换，终端那边另有 watch 同步 xterm 配色
watch(
  () => store.config.settings.theme,
  () => store.applyTheme()
)

function openNewServer() {
  editingServerId.value = null
  serverDialogVisible.value = true
}

function openSettings() {
  settingsVisible.value = true
}

onMounted(async () => {
  await store.init()
  // 捕获阶段：xterm 在它自己的 textarea 上监听 keydown，冒泡阶段抢不到 Ctrl+`
  window.addEventListener('keydown', onKeydown, true)
  offState = window.api.ssh.onState((payload) => store.applySessionState(payload))
  offProgress = window.api.sftp.onProgress((payload) => store.pushTransfer(payload))
  // 记录由主进程写（路径只有它拿得到原件），写完通知一声，界面重新拉列表
  offTransfer = window.api.transfer.onChanged(() => void store.loadTransferLog())
  // 本地 shell 是被我们 spawn 出来的子进程，它自己退（敲 exit / 崩了）只有主进程知道
  offShellExit = window.api.shell.onExit((payload) => store.applyShellExit(payload))

  // 启动后静默查一次更新：默认就走内置的 GitHub 源，不需要用户配任何东西。
  // **不弹窗** —— 有新版只在「关于」按钮上点个圆点，装不装、什么时候装由用户决定。
  // 延迟 3 秒是为了不跟首屏的连接、配置加载抢带宽。
  // 纯内网机器可以在「配置 → 更新」里关掉自动检查，那样只有手动点才会联网。
  if (store.config.settings.updateAutoCheck !== false) {
    setTimeout(() => {
      void runCheck(store.config.settings.updateFeed || '').then((res) => {
        if (res?.hasUpdate) console.log('[update] 有新版本', res.latest)
      })
    }, 3000)
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown, true)
  offState?.()
  offProgress?.()
  offTransfer?.()
  offShellExit?.()
  if (store.metricsTimer) clearInterval(store.metricsTimer)
})
</script>

<template>
  <div class="app-shell">
    <TitleBar
      :collapsed="!sidebarOpen"
      @new-server="openNewServer"
      @new-local="store.openLocalShell()"
      @open-settings="openSettings"
      @toggle-sidebar="toggleSidebar"
      @open-about="aboutVisible = true"
      @open-help="helpVisible = true"
      @open-update="updateVisible = true"
    />

    <div class="app-body">
      <SideBar
        v-show="sidebarOpen"
        @new-server="openNewServer"
        @edit-server="(id) => { editingServerId = id; serverDialogVisible = true }"
      />

      <section class="workspace">
        <TabBar v-if="store.tabs.length" />

        <div class="workspace-body">
          <WelcomePanel
            v-if="!store.tabs.length"
            @new-server="openNewServer"
            @new-local="store.openLocalShell()"
          />

          <template v-else>
            <SessionPane
              v-for="tab in store.tabs"
              :key="tab.id"
              v-show="tab.id === store.activeTabId"
              :tab="tab"
            />
          </template>
        </div>
      </section>
    </div>

    <!-- 传输面板贴在状态栏上方：状态栏是最底层的"系统信息"，不该被顶下去 -->
    <TransferDock />
    <StatusBar />

    <ServerDialog v-model="serverDialogVisible" :server-id="editingServerId" />
    <SettingsDialog v-model="settingsVisible" />
    <AboutDialog v-model="aboutVisible" />
    <HelpDialog v-model="helpVisible" />
    <UpdateDialog v-model="updateVisible" />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-base);
}

.app-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.workspace {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--bg-base);
  /* 浅色主题下面板和工作区都是浅色，分割线必须用常规 border 才分得开 */
  border-left: 1px solid var(--border);
}

.workspace-body {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
