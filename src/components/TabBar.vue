<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { Back, CircleClose, Close, Right } from '@element-plus/icons-vue'
import { useAppStore } from '../stores/app'

const store = useAppStore()

function close(tabId: string, event: MouseEvent) {
  event.stopPropagation()
  store.closeTab(tabId)
}

function onMiddleClick(tabId: string, event: MouseEvent) {
  if (event.button === 1) {
    event.preventDefault()
    store.closeTab(tabId)
  }
}

/* ---------------- 右键菜单 ---------------- */
const menu = reactive({ visible: false, x: 0, y: 0 })
/** 右键落在哪个页签上；空白处右键时退化成当前活动页签 */
const menuTabId = ref('')

/**
 * 菜单高 = 4 项 × 30 + 分隔线 9 + 上下 padding 10 ≈ 139，
 * 这里留到 160 是为了给 125% 缩放下字号变大留余量，否则最后一项会被窗口底边切掉。
 */
const MENU_W = 186
const MENU_H = 160

function openMenu(event: MouseEvent, tabId: string) {
  if (!store.tabs.some((t) => t.id === tabId)) return
  /**
   * 右键不会触发 click，而终端/侧栏的菜单都只监听 window 的 click 来关闭，
   * 于是"终端菜单开着时去右键页签"会出现两个菜单叠在一起。
   * 这里补一次"点到别处"的语义，让它们先自己收掉（三处监听都只做关闭，无副作用）。
   */
  document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  menuTabId.value = tabId
  menu.x = Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_W - 8))
  menu.y = Math.max(8, Math.min(event.clientY, window.innerHeight - MENU_H - 8))
  menu.visible = true
}

function closeMenu() {
  menu.visible = false
  menuTabId.value = ''
}

/** 空白区域右键：作用于当前活动页签，没有活动页签就不弹 */
function onBlankMenu(event: MouseEvent) {
  if (!store.activeTabId) return
  openMenu(event, store.activeTabId)
}

const index = computed(() => store.tabs.findIndex((t) => t.id === menuTabId.value))
const canCloseOthers = computed(() => store.tabs.length > 1)
const canCloseLeft = computed(() => index.value > 0)
const canCloseRight = computed(() => index.value >= 0 && index.value < store.tabs.length - 1)

function run(action: (tabId: string) => void) {
  const id = menuTabId.value
  closeMenu()
  if (id) action(id)
}

onMounted(() => {
  window.addEventListener('click', closeMenu)
  window.addEventListener('blur', closeMenu)
  // 页签栏横向滚动时菜单会飘在错误的位置，滚一下直接收掉
  window.addEventListener('wheel', closeMenu, { capture: true, passive: true })
})
onUnmounted(() => {
  window.removeEventListener('click', closeMenu)
  window.removeEventListener('blur', closeMenu)
  window.removeEventListener('wheel', closeMenu, true)
})
</script>

<template>
  <div class="tabbar" @contextmenu.prevent="onBlankMenu($event)">
    <div class="tabs">
      <div
        v-for="tab in store.tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === store.activeTabId }"
        @click="store.activeTabId = tab.id"
        @mousedown="onMiddleClick(tab.id, $event)"
        @contextmenu.prevent.stop="openMenu($event, tab.id)"
      >
        <span class="status-dot" :class="tab.status" />
        <span class="tab-title truncate">{{ tab.title }}</span>
        <el-icon class="close-btn" @click="close(tab.id, $event)">
          <Close />
        </el-icon>
      </div>
    </div>
    <div class="tab-actions">
      <span class="hint">{{ store.tabs.length }} 个会话</span>
    </div>

    <!-- 右键菜单：样式复用 style.css 里的全局 .ctx-* -->
    <teleport to="body">
      <div
        v-if="menu.visible"
        class="ctx-menu"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @click.stop
      >
        <div class="ctx-item" @click="run(store.closeTab)">
          <el-icon class="ctx-icon"><Close /></el-icon>关闭当前标签页
        </div>
        <div
          class="ctx-item"
          :class="{ disabled: !canCloseOthers }"
          @click="run(store.closeOtherTabs)"
        >
          <!-- 和「关闭当前」的裸 X 区分开：带圈的是"整组关掉"，一眼能扫出差别 -->
          <el-icon class="ctx-icon"><CircleClose /></el-icon>关闭其他标签页
        </div>
        <div class="ctx-sep" />
        <div class="ctx-item" :class="{ disabled: !canCloseLeft }" @click="run(store.closeTabsLeft)">
          <el-icon class="ctx-icon"><Back /></el-icon>关闭左侧标签页
        </div>
        <div
          class="ctx-item"
          :class="{ disabled: !canCloseRight }"
          @click="run(store.closeTabsRight)"
        >
          <el-icon class="ctx-icon"><Right /></el-icon>关闭右侧标签页
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.tabbar {
  height: var(--tabbar-h);
  flex: none;
  display: flex;
  align-items: stretch;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}

.tabs {
  display: flex;
  align-items: stretch;
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1;
  min-width: 0;
}

.tabs::-webkit-scrollbar {
  height: 3px;
}

.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px 0 12px;
  min-width: 120px;
  max-width: 210px;
  border-right: 1px solid var(--border-soft);
  cursor: pointer;
  color: var(--text-3);
  transition: background 0.12s, color 0.12s;
}

.tab:hover {
  background: var(--bg-hover);
  color: var(--text-2);
}

.tab.active {
  background: var(--bg-base);
  color: var(--text-1);
}

.tab.active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dot-idle);
  flex: none;
}

.status-dot.connected {
  background: var(--success);
}

.status-dot.connecting {
  background: var(--warning);
  animation: blink 1.1s infinite;
}

.status-dot.error {
  background: var(--danger);
}

@keyframes blink {
  50% {
    opacity: 0.25;
  }
}

.tab-title {
  font-size: 12.5px;
  flex: 1;
}

.close-btn {
  font-size: var(--icon-xs);
  padding: 2px;
  border-radius: 4px;
  opacity: 0;
}

.close-btn:hover {
  background: var(--bg-active);
  color: var(--danger);
}

.tab:hover .close-btn,
.tab.active .close-btn {
  opacity: 1;
}

.tab-actions {
  display: flex;
  align-items: center;
  padding: 0 12px;
  border-left: 1px solid var(--border-soft);
}

.hint {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}
</style>
