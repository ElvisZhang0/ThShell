<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, InfoFilled } from '@element-plus/icons-vue'
import { useAppStore, cleanError } from '../stores/app'
import type { AppSettings } from '../../electron/types'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const store = useAppStore()
const version = ref('0.1.0')
const exporting = ref(false)

/** 打开面板时的快照：设置项都是即时预览的，取消要能还原 */
let snapshot: AppSettings | null = null
let saved = false

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const settings = computed(() => store.config.settings)

async function exportConfig() {
  exporting.value = true
  try {
    const path = await window.api.config.exportConfig()
    if (path) ElMessage.success('已导出到 ' + path)
  } catch (err) {
    ElMessage.error('导出失败：' + cleanError(err))
  } finally {
    exporting.value = false
  }
}

function restartMetrics() {
  if (store.metricsTimer) {
    clearInterval(store.metricsTimer as ReturnType<typeof setInterval>)
    store.metricsTimer = 0
  }
  store.startMetricsLoop()
}

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      // 每次打开重新拍快照：设置项即时预览，取消时要能还原
      snapshot = structuredClone(store.config.settings)
      saved = false
      try {
        version.value = await window.api.app.version()
      } catch {
        /* 忽略 */
      }
      return
    }
    if (!saved && snapshot) {
      Object.assign(store.config.settings, snapshot)
      store.applyTheme()
    }
    snapshot = null
  }
)

onMounted(async () => {
  try {
    version.value = await window.api.app.version()
  } catch {
    /* 忽略 */
  }
})

async function save() {
  saved = true
  await store.saveSettings()
  restartMetrics()
  ElMessage.success('设置已保存')
  visible.value = false
}
</script>

<template>
  <el-dialog v-model="visible" title="设置" width="520px">
    <div class="section">
      <div class="section-title">终端</div>

      <div class="field">
        <div class="label">
          <span>字号</span>
          <span class="hint">当前 {{ settings.fontSize }}px</span>
        </div>
        <el-slider v-model="settings.fontSize" :min="11" :max="20" :step="1" show-stops />
      </div>

      <div class="field row">
        <div class="label">
          <span>界面主题</span>
          <span class="hint">同时决定终端配色，切换后立即预览</span>
        </div>
        <el-radio-group v-model="settings.theme" size="small">
          <el-radio-button value="dark">深色</el-radio-button>
          <el-radio-button value="light">浅色</el-radio-button>
        </el-radio-group>
      </div>

      <div class="field row">
        <div class="label">
          <span>复制即选中</span>
          <span class="hint">选中文本后自动复制</span>
        </div>
        <el-switch v-model="settings.copyOnSelect" />
      </div>
    </div>

    <div class="section">
      <div class="section-title">监控</div>
      <div class="field row">
        <div class="label">
          <span>采集间隔</span>
          <span class="hint">越短越实时，对服务器压力略大</span>
        </div>
        <el-select v-model="settings.metricInterval" size="small" style="width: 130px">
          <el-option label="1 秒" :value="1000" />
          <el-option label="2 秒" :value="2000" />
          <el-option label="3 秒" :value="3000" />
          <el-option label="5 秒" :value="5000" />
          <el-option label="10 秒" :value="10000" />
          <el-option label="关闭" :value="0" />
        </el-select>
      </div>
    </div>

    <div class="section">
      <div class="section-title">数据</div>
      <div class="field row">
        <div class="label">
          <span>连接配置</span>
          <span class="hint">密码使用系统凭据加密，导出时不含密码</span>
        </div>
        <el-button size="small" :icon="Download" :loading="exporting" @click="exportConfig">
          导出
        </el-button>
      </div>
    </div>

    <div class="about">
      <el-icon><InfoFilled /></el-icon>
      <span>ThShell v{{ version }} · 基于 Electron + Vue 3 · SSH 由 ssh2 提供</span>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.section {
  padding: 4px 0 14px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 14px;
}

.section:last-of-type {
  border-bottom: none;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 12px;
}

.field {
  margin-bottom: 14px;
}

.field:last-child {
  margin-bottom: 0;
}

.field.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12.5px;
  color: var(--text-1);
  margin-bottom: 6px;
}

.field.row .label {
  margin-bottom: 0;
}

.hint {
  font-size: 10.5px;
  color: var(--text-3);
}

.about {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
  padding-top: 4px;
}
</style>
