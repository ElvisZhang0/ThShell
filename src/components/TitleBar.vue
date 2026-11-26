<script setup lang="ts">
import { Expand, Fold, InfoFilled, Monitor, Plus, Setting, Upload } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppStore, cleanError } from '../stores/app'
import { updateState } from '../utils/update-state'
import LogoMark from './LogoMark.vue'

const props = defineProps<{ collapsed: boolean }>()

const emit = defineEmits<{
  (e: 'new-server'): void
  (e: 'new-local'): void
  (e: 'open-settings'): void
  (e: 'toggle-sidebar'): void
  (e: 'open-about'): void
  (e: 'open-help'): void
  (e: 'open-update'): void
}>()

const store = useAppStore()

/** 启动时的静默检查查到了新版本 → 「关于」按钮上点一个小圆点 */
const hasUpdate = computed(() => !!updateState.result?.hasUpdate)

/** 「关于」下拉的三项：关于 / 检查更新 / 使用说明。设置（配置）有独立的齿轮按钮，不再重复放一份 */
function onMenu(command: string | number | object): void {
  if (command === 'about') emit('open-about')
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

    <!--
      侧边栏开关就固定在品牌右边：展开时是「收起」，收起时是「展开」。
      只给图标不带文字 —— 标题栏左侧本来就空，一串汉字横在那儿太抢，文案全交给 title。
      放回标题栏而不是塞进侧边栏，是因为它得一直看得见：塞进侧边栏里的话，
      侧边栏一收起，按钮就跟着一起没了。
    -->
    <nav class="menubar">
      <button
        class="mb"
        :title="props.collapsed ? '展开侧边栏（Ctrl+B）' : '收起侧边栏（Ctrl+B）'"
        @click="emit('toggle-sidebar')"
      >
        <el-icon><component :is="props.collapsed ? Expand : Fold" /></el-icon>
      </button>
    </nav>

    <div class="spacer" />

    <div class="actions">
      <!-- 本地终端放在"新建连接"前面：它是"随手开个本机 shell"，和"配一台服务器"是两件事，
           而且不占侧栏的任何配置，所以不加重色按钮抢主按钮的视觉焦点 -->
      <el-button
        size="small"
        :icon="Monitor"
        title="打开本机终端（Ctrl+`）"
        @click="emit('new-local')"
      >
        终端
      </el-button>
      <el-button type="primary" size="small" :icon="Plus" @click="emit('new-server')">
        新建连接
      </el-button>
      <el-button size="small" :icon="Upload" @click="importConfig">导入</el-button>
      <el-button size="small" :icon="Setting" circle title="设置" @click="emit('open-settings')" />

      <!-- 关于紧跟在设置后面：都是"这个应用本身"的入口，摆一起才好找 -->
      <div class="about-wrap">
        <el-dropdown trigger="click" popper-class="tb-dropdown" @command="onMenu">
          <el-button
            size="small"
            :icon="InfoFilled"
            circle
            :title="hasUpdate ? '有新版本可用 · 关于 / 检查更新 / 使用说明' : '关于 / 检查更新 / 使用说明'"
          />
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="about">关于 ThShell</el-dropdown-item>
              <el-dropdown-item command="update">
                检查更新
                <span v-if="hasUpdate" class="dot" />
              </el-dropdown-item>
              <el-dropdown-item command="help">使用说明</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <!-- 发版提示：不弹窗，只在图标右上角点一个点 -->
        <span v-if="hasUpdate" class="about-dot" />
      </div>
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
  justify-content: center;
  gap: 5px;
  height: 26px;
  padding: 0 6px;
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

/* "有新版本"提示点：7px 的小圆点，不抢眼但能让人想起来点它。
   画在图标按钮右上角，用标题栏底色描一圈边，看着像是从按钮里冒出来的 */
.about-wrap {
  position: relative;
  display: flex;
}

.about-dot {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--titlebar-bg);
  pointer-events: none;
}

/* el-dropdown 默认是 inline-flex，按钮会被它撑出额外的高度 */
.actions :deep(.el-dropdown) {
  display: flex;
}

/* EP 会给触发元素的焦点加蓝色描边，标题栏里太扎眼 */
.actions :deep(.el-dropdown > .el-button:focus) {
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

/* 圆形图标按钮不要那圈描边：标题栏自己就有底色，再套一圈圆框像是浮在上面的卡片，
   和左边带文字的按钮也不在一个语言里。hover 才给一点底色，说明它可点。 */
.actions :deep(.el-button.is-circle) {
  border-color: transparent;
  background: transparent;
  color: var(--text-2);
}

.actions :deep(.el-button.is-circle:hover) {
  border-color: transparent;
  background: var(--bg-hover);
  color: var(--text-1);
}
</style>
