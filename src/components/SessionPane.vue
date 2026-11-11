<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Box,
  Cpu,
  FolderOpened,
  Monitor,
  Odometer,
  RefreshRight,
  WarningFilled
} from '@element-plus/icons-vue'
import { useAppStore } from '../stores/app'
import type { Tab, ViewKind } from '../stores/app'
import TerminalView from './TerminalView.vue'
import FileManager from './FileManager.vue'
import MonitorPanel from './MonitorPanel.vue'
import SystemPanel from './SystemPanel.vue'
import DockerPanel from './DockerPanel.vue'

const props = defineProps<{ tab: Tab }>()
const store = useAppStore()

const views: { key: ViewKind; label: string; icon: typeof Monitor }[] = [
  { key: 'terminal', label: '终端', icon: Monitor },
  { key: 'files', label: '文件', icon: FolderOpened },
  { key: 'monitor', label: '监控', icon: Odometer },
  { key: 'system', label: '系统', icon: Cpu }
]

/**
 * 「容器」页签只在远程机器装了 docker 时才出现。
 * 探测失败（老 OpenSSH 拒绝、Windows 主机没有 docker）就当没有，不把死页签摆在那里。
 */
const hasDocker = ref(false)
watch(
  () => props.tab.sessionId,
  async (sessionId) => {
    if (!sessionId) {
      hasDocker.value = false
      return
    }
    try {
      const probe = await window.api.docker.probe(sessionId)
      hasDocker.value = probe.available
      // 装了 docker 但 daemon 不可用时也要能看到这一页 —— 那里的报错才是运维要的信息
      if (!probe.available && props.tab.view === 'docker') props.tab.view = 'terminal'
    } catch {
      hasDocker.value = false
    }
  },
  { immediate: true }
)

const live = computed(() => props.tab.status === 'connected' && !!props.tab.sessionId)
</script>

<template>
  <div class="session-pane">
    <div class="pane-head">
      <div class="seg">
        <button
          v-for="view in views"
          :key="view.key"
          class="seg-btn"
          :class="{ active: tab.view === view.key }"
          :disabled="!live"
          @click="tab.view = view.key"
        >
          <el-icon><component :is="view.icon" /></el-icon>
          {{ view.label }}
        </button>
        <button
          v-if="hasDocker"
          class="seg-btn"
          :class="{ active: tab.view === 'docker' }"
          :disabled="!live"
          @click="tab.view = 'docker'"
        >
          <el-icon><Box /></el-icon>
          容器
        </button>
      </div>

      <div class="pane-sub mono truncate">{{ tab.subtitle }}</div>

      <div class="pane-ops">
        <span class="status-text" :class="tab.status">
          {{
            tab.status === 'connected'
              ? '已连接'
              : tab.status === 'connecting'
                ? '连接中…'
                : tab.status === 'error'
                  ? '连接失败'
                  : '已断开'
          }}
        </span>
        <el-button
          v-if="tab.status !== 'connected'"
          size="small"
          type="primary"
          plain
          :icon="RefreshRight"
          @click="store.reconnect(tab.id)"
        >
          重新连接
        </el-button>
      </div>
    </div>

    <div class="pane-body">
      <template v-if="live">
        <TerminalView v-show="tab.view === 'terminal'" :tab="tab" />
        <FileManager v-show="tab.view === 'files'" :tab="tab" />
        <MonitorPanel v-show="tab.view === 'monitor'" :tab="tab" />
        <SystemPanel v-show="tab.view === 'system'" :tab="tab" />
        <DockerPanel v-if="hasDocker" v-show="tab.view === 'docker'" :tab="tab" />
      </template>

      <div v-else class="state-screen">
        <div v-if="tab.status === 'connecting'" class="state-box">
          <div class="spinner" />
          <h3>正在建立 SSH 连接</h3>
          <p class="mono">{{ tab.subtitle }}</p>
        </div>

        <div v-else class="state-box">
          <el-icon class="warn-icon"><WarningFilled /></el-icon>
          <h3>{{ tab.status === 'error' ? '连接失败' : '会话已断开' }}</h3>
          <p class="err-msg">{{ tab.message || '与服务器的连接已关闭' }}</p>
          <el-button type="primary" :icon="RefreshRight" @click="store.reconnect(tab.id)">
            重新连接
          </el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-pane {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.pane-head {
  height: 38px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-soft);
}

.seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: var(--bg-base);
  border: 1px solid var(--border-soft);
}

.seg-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-3);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.12s;
}

/* 图标跟着一起放大，否则 12px 的文字配 12px 的图标显得又小又糊 */
.seg-btn .el-icon {
  font-size: var(--icon-sm);
}

.seg-btn:hover:not(:disabled) {
  color: var(--text-1);
  background: var(--bg-hover);
}

.seg-btn.active {
  color: #062520;
  background: linear-gradient(135deg, #5eead4, #2dd4bf);
  font-weight: 600;
}

.seg-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.pane-sub {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-3);
}

.pane-ops {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-text {
  font-size: 11px;
  color: var(--text-3);
}

.status-text.connected {
  color: var(--success);
}

.status-text.error {
  color: var(--danger);
}

.pane-body {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--bg-base);
}

.state-screen {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
}

.state-box {
  text-align: center;
  max-width: 460px;
}

.state-box h3 {
  margin: 14px 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
}

.state-box p {
  margin: 0 0 18px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
  word-break: break-all;
}

.err-msg {
  color: var(--danger) !important;
}

.warn-icon {
  font-size: 34px;
  color: var(--danger);
}

.spinner {
  width: 30px;
  height: 30px;
  margin: 0 auto;
  border-radius: 50%;
  border: 2px solid rgba(45, 212, 191, 0.18);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
