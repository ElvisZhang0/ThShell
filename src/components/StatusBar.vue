<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app'
import { updateState } from '../utils/update-state'

const store = useAppStore()
const emit = defineEmits<{ (e: 'open-update'): void }>()

/** 状态栏原来写死 "ThShell 0.1"，发了这么多版一直是错的；问主进程要真的版本号 */
const appVersion = ref('')
onMounted(async () => {
  try {
    appVersion.value = await window.api.app.version()
  } catch {
    /* 拿不到就只显示名字，不值得为此报错 */
  }
})

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

/**
 * 后台下载的落地位置。
 *
 * 弹窗一关，用户手上就只剩状态栏这一条线索了 —— 没有它，下载在不在跑、
 * 下了多少、下完了没有，全都只能靠猜。点击回到检查更新弹窗。
 */
const updateChip = computed(() => {
  const s = updateState
  if (s.downloading) {
    const pct = s.progress.percent
    return { kind: 'busy' as const, text: `↓ 更新${s.result?.latest ? ' ' + s.result.latest : ''} ${pct}%` }
  }
  if (s.filePath && !s.launched) {
    return {
      kind: 'ready' as const,
      text: `更新${s.result?.latest ? ' ' + s.result.latest : ''} 已下载 · 点击安装`
    }
  }
  return null
})
</script>

<template>
  <footer class="statusbar">
    <div class="left">
      <span class="chip" :class="{ on: remoteCount + localCount > 0 }">
        <span class="dot" />{{ summary }}
      </span>
      <span v-if="active" class="chip mono">{{ active.subtitle }}</span>
      <span v-if="activeTransfer" class="chip transfer">↑↓ {{ activeTransfer }} 个传输中</span>
      <button
        v-if="updateChip"
        class="chip upd"
        :class="updateChip.kind"
        :title="updateChip.kind === 'busy' ? '后台下载进行中，点击查看进度' : '更新包已下载，点击安装'"
        @click="emit('open-update')"
      >
        {{ updateChip.text }}
      </button>
    </div>

    <div class="right">
      <span class="muted">UTF-8</span>
      <span class="sep" />
      <span class="muted">ThShell{{ appVersion ? ' ' + appVersion : '' }}</span>
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

/* 后台下载的入口。做成按钮是因为它可点，但不能长得像按钮 ——
   状态栏里塞一颗实心按钮会把"这条是系统状态"的层级搞乱 */
.chip.upd {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}

.chip.upd:hover {
  text-decoration: underline;
}

.chip.upd.ready {
  color: var(--success);
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
