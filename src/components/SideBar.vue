<script setup lang="ts">
import { computed, reactive, ref, onMounted, onUnmounted } from 'vue'
import {
  ArrowRight,
  Connection,
  Delete,
  Edit,
  FolderAdd,
  Plus,
  Search,
  CopyDocument
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore, cleanError } from '../stores/app'
import type { ServerConfig } from '../../electron/types'

const emit = defineEmits<{
  (e: 'new-server'): void
  (e: 'edit-server', id: string): void
}>()

const store = useAppStore()
const collapsed = ref<Set<string>>(new Set())

const groups = computed(() => {
  const keyword = store.filter.trim().toLowerCase()
  const result = store.config.groups.map((group) => {
    const all = store.config.servers.filter((s) => s.groupId === group.id)
    if (!keyword) return { group, servers: all, total: all.length }
    const matched = all.filter(
      (s) =>
        s.name.toLowerCase().includes(keyword) ||
        s.host.toLowerCase().includes(keyword) ||
        s.username.toLowerCase().includes(keyword)
    )
    return { group, servers: matched, total: all.length }
  })
  return keyword ? result.filter((g) => g.servers.length > 0) : result
})

function toggleGroup(id: string) {
  const next = new Set(collapsed.value)
  next.has(id) ? next.delete(id) : next.add(id)
  collapsed.value = next
}

function isCollapsed(id: string): boolean {
  if (store.filter.trim()) return false
  return collapsed.value.has(id)
}

async function connect(server: ServerConfig) {
  await store.openServer(server)
}

/* ---------------- 右键菜单 ---------------- */
type MenuTarget =
  | { type: 'server'; server: ServerConfig }
  | { type: 'group'; id: string }
  | null

const menu = reactive({ visible: false, x: 0, y: 0 })
const menuTarget = ref<MenuTarget>(null)

function openMenu(event: MouseEvent, target: MenuTarget) {
  event.preventDefault()
  event.stopPropagation()
  menuTarget.value = target
  menu.x = Math.min(event.clientX, window.innerWidth - 190)
  menu.y = Math.min(event.clientY, window.innerHeight - 220)
  menu.visible = true
}

function closeMenu() {
  menu.visible = false
  menuTarget.value = null
}

onMounted(() => {
  window.addEventListener('click', closeMenu)
  window.addEventListener('blur', closeMenu)
})
onUnmounted(() => {
  window.removeEventListener('click', closeMenu)
  window.removeEventListener('blur', closeMenu)
})

async function handleEdit() {
  const target = menuTarget.value
  closeMenu()
  if (target?.type === 'server') emit('edit-server', target.server.id)
}

async function handleConnect() {
  const target = menuTarget.value
  closeMenu()
  if (target?.type === 'server') await connect(target.server)
}

function handleDuplicate() {
  const target = menuTarget.value
  if (target?.type !== 'server') return
  const src = target.server
  const copy: ServerConfig = {
    ...src,
    id: `srv-${Date.now()}`,
    name: src.name + ' - 副本',
    createdAt: Date.now(),
    lastUsedAt: undefined
  }
  store.upsertServer(copy)
  closeMenu()
  ElMessage.success('已复制连接配置')
}

async function handleDelete() {
  const target = menuTarget.value
  closeMenu()
  if (target?.type === 'server') {
    try {
      await ElMessageBox.confirm(
        `确定删除连接「${target.server.name}」吗？此操作只删除本地配置，不影响服务器。`,
        '删除连接',
        { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
      )
      store.removeServer(target.server.id)
      ElMessage.success('已删除')
    } catch {
      /* 用户取消 */
    }
  } else if (target?.type === 'group') {
    try {
      await ElMessageBox.confirm('删除分组后，组内服务器会移动到「默认分组」。', '删除分组', {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消'
      })
      store.removeGroup(target.id)
    } catch {
      /* 取消 */
    }
  }
}

async function handleRenameGroup() {
  const target = menuTarget.value
  closeMenu()
  if (target?.type !== 'group') return
  const group = store.config.groups.find((g) => g.id === target.id)
  if (!group) return
  try {
    const { value } = await ElMessageBox.prompt('分组名称', '重命名分组', {
      inputValue: group.name,
      inputValidator: (v) => (v?.trim() ? true : '名称不能为空')
    })
    group.name = value.trim()
    await store.persist()
  } catch {
    /* 取消 */
  }
}

async function handleNewGroup() {
  try {
    const { value } = await ElMessageBox.prompt('新建一个分组，用于按环境或项目归类服务器', '新建分组', {
      inputValue: '新分组',
      inputValidator: (v) => (v?.trim() ? true : '名称不能为空')
    })
    store.addGroup(value.trim())
  } catch {
    /* 取消 */
  }
}

function statusOf(serverId: string): 'connected' | 'connecting' | 'closed' {
  const tab = store.tabs.find((t) => t.serverId === serverId)
  if (!tab) return 'closed'
  if (tab.status === 'connected') return 'connected'
  if (tab.status === 'connecting') return 'connecting'
  return 'closed'
}

function activeOf(serverId: string): boolean {
  const tab = store.activeTab
  return !!tab && tab.serverId === serverId
}
</script>

<template>
  <aside class="sidebar">
    <div class="search-row">
      <el-input v-model="store.filter" size="small" placeholder="搜索名称 / IP / 用户" clearable>
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-tooltip content="新建分组" placement="bottom" :show-after="400">
        <el-button size="small" :icon="FolderAdd" circle @click="handleNewGroup" />
      </el-tooltip>
    </div>

    <div class="tree scroll-y">
      <div v-for="entry in groups" :key="entry.group.id" class="group">
        <div
          class="group-head"
          @click="toggleGroup(entry.group.id)"
          @contextmenu="openMenu($event, { type: 'group', id: entry.group.id })"
        >
          <el-icon class="caret" :class="{ collapsed: isCollapsed(entry.group.id) }">
            <ArrowRight />
          </el-icon>
          <span class="group-name truncate">{{ entry.group.name }}</span>
          <span class="count">{{ entry.servers.length }}</span>
          <el-icon
            class="group-add"
            title="在此分组新建连接"
            @click.stop="emit('new-server')"
          >
            <Plus />
          </el-icon>
        </div>

        <transition name="fold">
          <div v-show="!isCollapsed(entry.group.id)" class="server-list">
            <div
              v-for="server in entry.servers"
              :key="server.id"
              class="server-item"
              :class="{ active: activeOf(server.id) }"
              @dblclick="connect(server)"
              @contextmenu="openMenu($event, { type: 'server', server })"
            >
              <span
                class="dot"
                :class="statusOf(server.id)"
                :style="server.color ? { background: server.color } : undefined"
              />
              <div class="server-text">
                <div class="server-name truncate">{{ server.name }}</div>
                <div class="server-meta truncate mono">
                  {{ server.username }}@{{ server.host }}:{{ server.port }}
                </div>
              </div>
              <el-tooltip content="连接" placement="right" :show-after="500">
                <el-icon class="connect-btn" @click.stop="connect(server)">
                  <Connection />
                </el-icon>
              </el-tooltip>
            </div>

            <div v-if="!entry.servers.length" class="empty-group">暂无连接</div>
          </div>
        </transition>
      </div>

      <div v-if="!groups.length" class="empty-state">
        <p>没有匹配的连接</p>
      </div>
    </div>

    <div class="sidebar-foot">
      <el-button text size="small" :icon="Plus" @click="emit('new-server')">添加服务器</el-button>
    </div>

    <!-- 右键菜单 -->
    <teleport to="body">
      <div
        v-if="menu.visible"
        class="ctx-menu"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @click.stop
      >
        <template v-if="menuTarget?.type === 'server'">
          <div class="ctx-item" @click="handleConnect">
            <el-icon><Connection /></el-icon>连接
          </div>
          <div class="ctx-item" @click="handleEdit">
            <el-icon><Edit /></el-icon>编辑配置
          </div>
          <div class="ctx-item" @click="handleDuplicate">
            <el-icon><CopyDocument /></el-icon>复制一份
          </div>
          <div class="ctx-sep" />
          <div class="ctx-item danger" @click="handleDelete">
            <el-icon><Delete /></el-icon>删除
          </div>
        </template>

        <template v-else-if="menuTarget?.type === 'group'">
          <div class="ctx-item" @click="closeMenu(); emit('new-server')">
            <el-icon><Plus /></el-icon>新建连接到该分组
          </div>
          <div class="ctx-item" @click="handleRenameGroup">
            <el-icon><Edit /></el-icon>重命名分组
          </div>
          <div class="ctx-sep" />
          <div class="ctx-item danger" @click="handleDelete">
            <el-icon><Delete /></el-icon>删除分组
          </div>
        </template>
      </div>
    </teleport>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-w);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  min-height: 0;
}

.search-row {
  display: flex;
  gap: 6px;
  padding: 10px 10px 8px;
}

.tree {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 8px;
}

.scroll-y {
  overflow-y: auto;
}

.group {
  margin-bottom: 2px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 6px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-3);
}

.group-head:hover {
  background: var(--bg-hover);
  color: var(--text-2);
}

.caret {
  font-size: var(--icon-xs);
  transform: rotate(90deg);
  transition: transform 0.15s ease;
}

.caret.collapsed {
  transform: rotate(0deg);
}

.group-name {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
}

.count {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--bg-elevated);
  color: var(--text-3);
}

.group-add {
  opacity: 0;
  font-size: var(--icon-sm);
  transition: opacity 0.15s;
}

.group-head:hover .group-add {
  opacity: 1;
}

.server-list {
  padding: 2px 0 4px 6px;
}

.server-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s;
}

.server-item:hover {
  background: var(--bg-hover);
}

.server-item.active {
  background: var(--accent-soft);
}

.server-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--dot-idle);
}

.dot.connected {
  background: var(--success);
  box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.16);
}

.dot.connecting {
  background: var(--warning);
  animation: pulse 1.1s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.server-text {
  flex: 1;
  min-width: 0;
}

.server-name {
  font-size: 12.5px;
  color: var(--text-1);
  line-height: 1.35;
}

.server-meta {
  font-size: 10.5px;
  color: var(--text-3);
  line-height: 1.3;
}

/* 服务器行右侧的连接按钮：整行只有它一个图标，字小一点就显得像颗装饰点，
   固定成 24×24 的方框 + --icon-xl，悬停底色才是正方形 */
.connect-btn {
  opacity: 0;
  font-size: var(--icon-xl);
  color: var(--text-2);
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  flex: none;
}

.connect-btn:hover {
  color: var(--accent);
  background: var(--bg-active);
}

.server-item:hover .connect-btn {
  opacity: 1;
}

.empty-group {
  padding: 6px 10px;
  font-size: 11px;
  color: var(--text-3);
}

.empty-state {
  padding: 40px 16px;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
}

.sidebar-foot {
  flex: none;
  padding: 6px 10px;
  border-top: 1px solid var(--border-soft);
}

.sidebar-foot :deep(.el-button) {
  height: 28px;
  font-size: 12px;
}

.sidebar-foot :deep(.el-button .el-icon) {
  font-size: var(--icon-md);
}

.fold-enter-active,
.fold-leave-active {
  transition: opacity 0.12s ease;
}
.fold-enter-from,
.fold-leave-to {
  opacity: 0;
}

/* 右键菜单 */
.ctx-menu {
  position: fixed;
  z-index: 4000;
  min-width: 172px;
  padding: 5px;
  border-radius: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-pop);
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 5px;
  font-size: 12.5px;
  color: var(--text-1);
  cursor: pointer;
}

.ctx-item:hover {
  background: var(--bg-active);
}

.ctx-item.danger {
  color: var(--danger);
}

.ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}
</style>
