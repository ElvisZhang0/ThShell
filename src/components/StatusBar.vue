<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'

const store = useAppStore()

const active = computed(() => store.activeTab)

/**
 * 远程连接和本地终端分开数。
 * 混成"3 个活动连接"会让人以为开了三条 SSH —— 本地终端的"连接"其实是本机子进程，
 * 两者排查方向完全不同（一个是网络/认证，一个是本机 shell 起没起来）。
 */
const remoteCount = computed(
  () => store.tabs.filter((t) => t.status === 'connected' && t.kind !== 'local').length
)
const localCount = computed(
  () => store.tabs.filter((t) => t.status === 'connected' && t.kind === 'local').length
)
const summary = computed(() => {
  const parts: string[] = []
  if (remoteCount.value) parts.push(`${remoteCount.value} 个远程连接`)
  if (localCount.value) parts.push(`${localCount.value} 个本地终端`)
  return parts.join(' · ') || '0 个活动连接'
})
const activeTransfer = computed(() => store.transfers.filter((t) => !t.done).length)
</script>

<template>
  <footer class="statusbar">
    <div class="left">
      <span class="chip" :class="{ on: remoteCount + localCount > 0 }">
        <span class="dot" />{{ summary }}
      </span>
      <span v-if="active" class="chip mono">{{ active.subtitle }}</span>
      <span v-if="activeTransfer" class="chip transfer">↑↓ {{ activeTransfer }} 个传输中</span>
    </div>

    <div class="right">
      <span class="muted">UTF-8</span>
      <span class="sep" />
      <span class="muted">ThShell 0.1</span>
    </div>
  </footer>
</template>

<style scoped>
.statusbar {
  height: var(--statusbar-h);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  font-size: 10.5px;
  color: var(--text-3);
}

.left,
.right {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.chip {
  display: flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--dot-idle);
}

.chip.on .dot {
  background: var(--success);
  box-shadow: 0 0 6px rgba(52, 211, 153, 0.7);
}

.chip.transfer {
  color: var(--accent);
}

.muted {
  opacity: 0.8;
}

.sep {
  width: 1px;
  height: 9px;
  background: var(--border);
}
</style>
