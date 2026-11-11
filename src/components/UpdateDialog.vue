<script setup lang="ts">
import { computed, watch } from 'vue'
import { useAppStore } from '../stores/app'
import { formatSize, formatSpeed } from '../utils/transfer-format'
import {
  cancelDownload,
  resolveFeed,
  runCheck,
  runDownload,
  runInstall,
  updateState
} from '../utils/update-state'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'open-settings'): void
}>()

const store = useAppStore()

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

/**
 * 空 = 用内置 GitHub 源（resolveFeed 里兜底），所以这里只是"当前生效的地址"，
 * 界面不再有"没配更新源"这种状态 —— 装完就能查。
 */
const feed = computed(() => resolveFeed(store.config.settings.updateFeed))
const r = computed(() => updateState.result)
const pct = computed(() => updateState.progress.percent)

const assetLabel = computed(() => {
  const a = r.value?.asset
  if (!a) return ''
  const size = a.size ? ` · ${formatSize(a.size, false)}` : ''
  return `${a.format}${size}`
})

/** 打开时自动查一次：用户点"检查更新"进来，不该再让他点第二下 */
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    updateState.message = ''
    void runCheck(feed.value)
  }
)

async function retry(): Promise<void> {
  await runCheck(feed.value)
}

async function download(): Promise<void> {
  await runDownload()
}

async function install(): Promise<void> {
  await runInstall()
}

function goSettings(): void {
  visible.value = false
  emit('open-settings')
}
</script>

<template>
  <el-dialog v-model="visible" title="检查更新" width="480px">
    <div class="upd">
      <!-- 检查中 -->
      <div v-if="updateState.checking" class="row muted">
        <span class="spin" />
        正在检查更新…
      </div>

      <!-- 出错：连不上 / JSON 不对 / 版本号非法 -->
      <template v-else-if="r?.error">
        <div class="row warn">{{ r.error }}</div>
        <div class="row muted">
          当前版本 <span class="mono">{{ r.current || '—' }}</span>
        </div>
        <div class="row muted">
          更新源：<span class="mono elide">{{ feed }}</span>
        </div>
      </template>

      <!-- 有新版本 -->
      <template v-else-if="r?.hasUpdate">
        <div class="row">
          <span class="tag">新版本</span>
          <span class="mono strong">{{ r.latest }}</span>
          <span class="muted">（当前 {{ r.current }}）</span>
        </div>
        <pre v-if="r.notes" class="notes">{{ r.notes }}</pre>

        <div v-if="r.unsupported" class="row warn">{{ r.unsupported }}</div>

        <template v-else>
          <div class="row muted">{{ assetLabel }}</div>

          <div v-if="updateState.downloading" class="progress">
            <el-progress :percentage="pct" :stroke-width="6" :show-text="false" />
            <div class="pmeta">
              <span class="mono">
                {{ formatSize(updateState.progress.transferred, false) }} /
                {{ formatSize(updateState.progress.total, false) }}
              </span>
              <span class="mono">{{ formatSpeed(updateState.progress.speed) }}</span>
              <span class="mono">{{ pct }}%</span>
            </div>
          </div>

          <div v-if="updateState.filePath" class="row ok">已下载到本地，可以安装了。</div>
          <div v-if="updateState.message" class="row ok">{{ updateState.message }}</div>
          <div v-if="updateState.error" class="row warn">{{ updateState.error }}</div>
        </template>
      </template>

      <!-- 已是最新 -->
      <template v-else-if="r">
        <div class="row">
          已是最新版本 <span class="mono strong">{{ r.current }}</span>
        </div>
        <div v-if="r.latest" class="row muted">更新源上的版本：{{ r.latest }}</div>
      </template>

      <div v-else class="row muted">还没有检查过。</div>
    </div>

    <template #footer>
      <div class="foot">
        <!-- 出错时给个改源的入口：默认走 GitHub，连不上就换自建目录 -->
        <el-button v-if="r?.error" size="small" @click="goSettings">换个更新源</el-button>
        <el-button size="small" :disabled="updateState.checking || updateState.downloading" @click="retry">
          重新检查
        </el-button>

        <template v-if="r?.hasUpdate && r.asset && !r.unsupported">
          <el-button
            v-if="updateState.downloading"
            size="small"
            @click="cancelDownload"
          >
            取消下载
          </el-button>
          <el-button
            v-else-if="!updateState.filePath"
            type="primary"
            size="small"
            @click="download"
          >
            下载
          </el-button>
          <el-button v-else type="primary" size="small" @click="install">安装</el-button>
        </template>

        <el-button size="small" @click="visible = false">关闭</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.upd {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 72px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-1);
  line-height: 1.7;
}

.muted {
  color: var(--text-3);
}

/* 更新源地址可能很长（GitHub 那串），一行放不下就截断，别把弹窗撑宽 */
.elide {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

.warn {
  color: var(--danger);
}

.ok {
  color: var(--success);
}

.strong {
  font-weight: 600;
}

.tag {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--accent);
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
}

.notes {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel-2);
  color: var(--text-2);
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

.progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pmeta {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--text-3);
}

.foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* 转圈：两条边不透明的手画圆环，比 el-icon 的 loading 更轻 */
.spin {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
