<script setup lang="ts">
import { ArrowDown, Expand, Fold, Plus, Setting, Upload } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppStore, cleanError } from '../stores/app'
import { updateState } from '../utils/update-state'
import LogoMark from './LogoMark.vue'

const props = defineProps<{ collapsed: boolean }>()

const emit = defineEmits<{
  (e: 'new-server'): void
  (e: 'open-settings'): void
  (e: 'toggle-sidebar'): void
  (e: 'open-about'): void
  (e: 'open-help'): void
  (e: 'open-update'): void
}>()

const store = useAppStore()

/** 启动时的静默检查查到了新版本 → 「关于」按钮上点一个小圆点 */
const hasUpdate = computed(() => !!updateState.result?.hasUpdate)

/** 「关于」下拉的四项：关于 / 配置 / 检查更新 / 使用说明 */
function onMenu(command: string | number | object): void {
  if (command === 'about') emit('open-about')
  else if (command === 'settings') emit('open-settings')
  else if (command === 'update') emit('open-update')
  else if (command === 'help') emit('open-help')
}

async function importConfig() {
  try {
    const incoming = await window.api.config.importConfig()
    if (!incoming) return

    const groupIds = new Set(store.config.groups.map((g) => g.id))
    let addedGroups = 0
    for (const group of incoming.groups ?? []) {
      if (!groupIds.has(group.id)) {
        store.config.groups.push(group)
        groupIds.add(group.id)
        addedGroups++
      }
    }

    const exists = new Set(
      store.config.servers.map((s) => `${s.host}:${s.port}:${s.username}`.toLowerCase())
    )
    let addedServers = 0
    for (const server of incoming.servers ?? []) {
      const key = `${server.host}:${server.port}:${server.username}`.toLowerCase()
      if (exists.has(key)) continue
      const groupId = groupIds.has(server.groupId) ? server.groupId : 'default'
      store.config.servers.push({ ...server, groupId })
      exists.add(key)
      addedServers++
    }

    await store.persist()
    ElMessage.success(`导入完成：新增 ${addedServers} 台服务器、${addedGroups} 个分组`)
  } catch (err) {
    ElMessage.error('导入失败：' + cleanError(err))
  }
}
</script>

<template>
  <header class="titlebar">
    <div class="brand">
      <div class="logo"><LogoMark /></div>
      <div class="brand-text">
        <span class="name">ThShell</span>
        <span class="tag">SSH / SFTP</span>
      </div>
    </div>

    <!-- 菜单栏：跟右侧那排操作按钮分开摆 —— 左边是"看/设置"，右边是"做事" -->
    <nav class="menubar">
      <button
        class="mb"
        :class="{ on: !props.collapsed }"
        :title="props.collapsed ? '展开侧边栏（Ctrl+B）' : '收起侧边栏（Ctrl+B）'"
        @click="emit('toggle-sidebar')"
      >
        <el-icon class="mb-ico"><component :is="props.collapsed ? Expand : Fold" /></el-icon>
        <span>{{ props.collapsed ? '展开侧边栏' : '收起侧边栏' }}</span>
      </button>

      <el-dropdown trigger="click" popper-class="tb-dropdown" @command="onMenu">
        <button class="mb" :title="hasUpdate ? '有新版本可用' : '关于 / 配置 / 检查更新 / 使用说明'">
          <span>关于</span>
          <!-- 有新版本时只点一个点，不弹窗打扰 —— 什么时候装是用户说了算 -->
          <span v-if="hasUpdate" class="mb-dot" />
          <el-icon class="mb-caret"><ArrowDown /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="about">关于 ThShell</el-dropdown-item>
            <el-dropdown-item command="settings">配置</el-dropdown-item>
            <el-dropdown-item command="update">
              检查更新
              <span v-if="hasUpdate" class="dot" />
            </el-dropdown-item>
            <el-dropdown-item command="help">使用说明</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </nav>

    <div class="spacer" />

    <div class="actions">
      <el-button type="primary" size="small" :icon="Plus" @click="emit('new-server')">
        新建连接
      </el-button>
      <el-button size="small" :icon="Upload" @click="importConfig">导入</el-button>
      <el-button size="small" :icon="Setting" circle @click="emit('open-settings')" />
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: 50px;
  flex: none;
  display: flex;
  align-items: center;
  padding: 0 14px;
  background: var(--titlebar-bg);
  border-bottom: 1px solid var(--border);
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
}

.logo {
  width: 30px;
  height: 30px;
  flex: none;
  filter: drop-shadow(0 4px 12px rgba(45, 212, 191, 0.25));
}

.brand-text {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.name {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: 0.3px;
  color: var(--text-1);
}

.tag {
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--text-3);
  text-transform: uppercase;
}

.spacer {
  flex: 1;
}

/* ---------- 菜单栏 ----------
   放在品牌和右侧那排操作按钮中间：左边是"看 / 设置"，右边是"做事"。
   和前后的元素之间各留一条竖线，否则一行里挤了三种控件会分不清组 */
.menubar {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: 16px;
  padding-left: 14px;
  border-left: 1px solid var(--border);
}

.mb {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.mb:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

/* 侧边栏收起时这颗按钮变成"展开"，给一层极淡的高亮提示状态，
   否则用户看不出它是个开关 */
.mb.on {
  color: var(--text-2);
}

.mb-ico {
  font-size: 14px;
}

.mb-caret {
  font-size: 10px;
  color: var(--text-3);
}

/* "有新版本"提示点：6px 的小圆点，不抢眼但能让人想起来点它 */
.mb-dot {
  width: 6px;
  height: 6px;
  margin-left: -1px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

/* el-dropdown 默认是 inline-flex，按钮会被它撑出额外的高度 */
.menubar :deep(.el-dropdown) {
  display: flex;
}

/* EP 会给触发元素的焦点加蓝色描边，标题栏里太扎眼 */
.menubar :deep(.el-dropdown > .mb:focus) {
  outline: none;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Element Plus 小号按钮的图标只有 14px，配上 100% 缩放的高分屏偏细 */
.actions :deep(.el-button) {
  height: 28px;
  font-size: 12px;
}

.actions :deep(.el-button .el-icon) {
  font-size: var(--icon-md);
}
</style>
