<script setup lang="ts">
import { computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../stores/app'
import { formatSize, formatSpeed } from '../utils/transfer-format'
import {
  cancelDownload,
  feedLabel,
  runBackgroundDownload,
  runCheck,
  runInstall,
  runUpgrade,
  toBackground,
  updateState
} from '../utils/update-state'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
}>()

const store = useAppStore()

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const r = computed(() => updateState.result)
const pct = computed(() => updateState.progress.percent)

/**
 * 当前生效的更新源：检查完就用主进程回报的**实际通道**（可能是某个镜像），
 * 还没查完时只能给配置里的值或内置主源 —— 具体走哪条要等结果。
 */
const feed = computed(() => r.value?.feed || feedLabel(store.config.settings.updateFeed))

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
  // force：用户明确点了「重新检查」，这时候才允许丢掉已经下好的包
  await runCheck(feed.value, true)
}

/**
 * 一次点击走完「下载 → 校验 → 拉起安装程序」。
 * 下载完还要用户再点一次「安装」这件事没有任何决策价值，只是多一步。
 *
 * 唯一会拦一下的情况：还有传输在跑。Windows 上安装要先退出应用，
 * 正在传的文件会断在半截 —— 这个代价用户事先不知道，得让他自己决定。
 */
async function upgrade(): Promise<void> {
  const running = store.transfers.filter((t) => !t.done).length
  if (running > 0) {
    try {
      await ElMessageBox.confirm(
        `还有 ${running} 个传输在进行。升级需要先关闭 ThShell，这些传输会中断（已传的部分会保留，下次可以重传）。`,
        '确认现在升级？',
        { confirmButtonText: '仍然升级', cancelButtonText: '等它们传完', type: 'warning' }
      )
    } catch {
      return
    }
  }
  await runUpgrade()
  // 下载途中被转后台（用户点了「后台下载」或关了窗）：runUpgrade 已经跳过安装，
  // 这里补一句提示，免得用户以为点了升级却什么都没发生
  if (updateState.background && updateState.filePath && !updateState.launched) {
    ElMessage.success('更新包已下载完成，随时可以在这里安装')
  }
}

/** 包已经躺在本地，只差安装 */
const ready = computed(() => !!updateState.filePath && !updateState.launched)

/**
 * 后台下载：关掉弹窗，让下载在背后继续。
 *
 * 两种状态一起处理 —— 还没开始（直接开始下）和已经在下载（只是别再自动装）。
 * 下完不自动 install：应用自己退出重启这件事，必须在用户看着的时候发生。
 */
function background(): void {
  visible.value = false
  if (updateState.downloading) {
    toBackground()
    ElMessage.info('已转入后台下载，进度显示在底部状态栏')
    return
  }
  ElMessage.info(`正在后台下载 ThShell ${r.value?.latest ?? ''}，进度显示在底部状态栏`)
  void runBackgroundDownload().then((ok) => {
    if (!ok && updateState.error) ElMessage.error(updateState.error)
  })
}

async function install(): Promise<void> {
  await runInstall()
}

/**
 * 关闭：下载还在跑就转后台。
 *
 * 不能让用户以为「关掉 = 取消」（取消有专门的按钮），更不能让它下完在背后自动装 ——
 * 那是前台一键升级的行为，用户没看着的时候发生会很吓人。
 */
function close(): void {
  visible.value = false
  if (updateState.downloading) {
    toBackground()
    ElMessage.info('下载已转入后台，进度显示在底部状态栏')
  }
}

/** 启动安装程序后被禁用：防止在应用退出前连点，起两个安装进程互抢文件 */
const busy = computed(
  () => updateState.downloading || updateState.installing || updateState.launched
)
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

          <!-- 安装阶段也留着这条：进度条突然消失会让人以为下载白跑了 -->
          <div v-if="updateState.downloading || updateState.installing" class="progress">
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

          <div v-if="ready && !updateState.installing" class="row ok">
            安装包已下载完成，随时可以安装
          </div>
          <div v-if="updateState.message" class="row ok">{{ updateState.message }}</div>
          <div v-if="updateState.error" class="row warn">{{ updateState.error }}</div>
          <!-- 自动安装失败时的退路：包已经校验完躺在本地，重试不必再下一遍 -->
          <div v-if="updateState.error && updateState.filePath" class="row muted">
            安装包已下载：<span class="mono elide">{{ updateState.filePath }}</span>
          </div>
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
        <el-button size="small" :disabled="updateState.checking || updateState.downloading" @click="retry">
          重新检查
        </el-button>

        <!-- checking 时也要藏起来：此时 r 还是上一次的结果，按钮却已经可点，
             用户会拿着旧版本的包去升级 -->
        <template v-if="r?.hasUpdate && r.asset && !r.unsupported && !updateState.checking">
          <!-- 已经下好：主按钮直接装，不必再下一次 100MB -->
          <el-button
            v-if="ready"
            type="primary"
            size="small"
            :loading="updateState.installing"
            :disabled="updateState.launched"
            @click="install"
          >
            {{ updateState.launched ? '正在安装' : `安装 ${r.latest}` }}
          </el-button>

          <template v-else>
            <!-- 下载中和还没开始都能点：关掉弹窗，下载在背后继续 -->
            <el-button size="small" @click="background">后台下载</el-button>
            <el-button v-if="updateState.downloading" size="small" @click="cancelDownload">
              取消下载
            </el-button>
            <el-button
              v-else
              type="primary"
              size="small"
              :disabled="busy"
              @click="upgrade"
            >
              升级到 {{ r.latest }}
            </el-button>
          </template>
        </template>

        <el-button size="small" @click="close">关闭</el-button>
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
