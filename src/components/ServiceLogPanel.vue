<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Close, DocumentCopy, Refresh } from '@element-plus/icons-vue'
import type { Tab } from '../stores/app'
import { cleanError } from '../stores/app'
import type { ServiceLogResult, ServiceRow } from '../../electron/types'

const props = defineProps<{ tab: Tab; row: ServiceRow }>()
const emit = defineEmits<{ (e: 'close'): void }>()

/** 增量游标：`--since` 是闭区间，所以要连「那一秒里已经收过几条」一起记 */
const cursor = ref({ ts: '', count: 0 })
const lines = ref<string[]>([])
const busy = ref(false)
const error = ref('')
const note = ref('')
const source = ref<ServiceLogResult['source']>('user')
const fetchedAt = ref(0)

/** 首屏 / 每次增量的行数上限。跟 Docker 日志一个量级，够看一次启动全过程 */
const pageSize = ref(300)
/** 最多留多少行：跟一整天不断追加会把内存吃穿，超出就从头丢 */
const MAX_KEEP = 2000

const follow = ref(true)
/** 是否贴着底部。滚上去看历史时自动关掉跟随，否则新行一来就把人拽走 */
const pinned = ref(true)
const bodyEl = ref<HTMLElement>()

/* ---------------- 取数 ---------------- */

let timer: number | undefined

function schedule() {
  window.clearTimeout(timer)
  if (!follow.value) return
  // 窗口在后台就不打扰远端：回到前台后 watch(follow) / visibilitychange 会补一次
  timer = window.setTimeout(() => void load(false), document.hidden ? 5000 : 1500)
}

async function load(reset: boolean) {
  const sid = props.tab.sessionId
  if (!sid) {
    error.value = '会话已断开，日志取不到'
    return
  }
  if (busy.value) return
  busy.value = true
  try {
    const res = await window.api.services.logs(sid, props.row.name, {
      lines: pageSize.value,
      since: reset ? '' : cursor.value.ts,
      skip: reset ? 0 : cursor.value.count
    })
    if (reset) lines.value = res.lines
    else if (res.lines.length) lines.value = lines.value.concat(res.lines).slice(-MAX_KEEP)
    cursor.value = { ts: res.cursor, count: res.cursorCount }
    note.value = res.note
    source.value = res.source
    fetchedAt.value = res.at
    error.value = ''
    if (follow.value) scrollToEnd()
  } catch (err) {
    // 只保留最后一次的错误；下一轮成功会自己清掉
    error.value = cleanError(err)
  } finally {
    busy.value = false
    schedule()
  }
}

function scrollToEnd() {
  void nextTick(() => {
    const el = bodyEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function onScroll() {
  const el = bodyEl.value
  if (!el) return
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  pinned.value = near
  if (!near && follow.value) follow.value = false
}

watch(follow, (on) => {
  if (on) {
    pinned.value = true
    scrollToEnd()
    void load(false)
  } else {
    window.clearTimeout(timer)
  }
})

watch(pageSize, () => void load(true))

/* ---------------- 行 ---------------- */

/**
 * 把 `2026-11-26T16:20:31+0800 host systemd[1]: ...` 拆成时间戳和正文。
 * 时间戳单独一层是为了让它淡下去 —— 一屏几十行全是同样长度的日期，
 * 整行同色反而看不出正文从哪儿开始。
 */
const view = computed(() =>
  lines.value.map((line) => {
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:]+[^\s]*)\s+([\s\S]*)$/.exec(line)
    const ts = m ? m[1].replace('T', ' ') : ''
    const rest = m ? m[2] : line
    const tone = /\b(failed|failure|fatal|error|denied|refused|cannot|could not)\b/i.test(rest)
      ? 'bad'
      : /\b(warn|warning|deprecated)\b/i.test(rest)
        ? 'warn'
        : ''
    return { ts, rest, tone }
  })
)

const stamp = computed(() =>
  fetchedAt.value ? new Date(fetchedAt.value).toLocaleTimeString('zh-CN') : '—'
)

/* ---------------- 复制 / 键盘 ---------------- */

async function copyText(text: string, tip: string) {
  if (!text) return
  try {
    await window.api.clipboard.write(text)
    ElMessage.success(tip)
  } catch (err) {
    ElMessage.error(`复制失败：${cleanError(err)}`)
  }
}

function copyAll() {
  void copyText(lines.value.join('\n'), `已复制 ${lines.value.length} 行日志`)
}

/**
 * 应用菜单被摘掉了（setApplicationMenu(null)），不能指望系统 Ctrl+C 一定生效，
 * 这里自己把选区送进剪贴板 —— 和 Docker 日志面板的处理保持一致。
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
    return
  }
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
  if (event.key.toLowerCase() !== 'c') return
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return
  const text = sel.toString()
  if (!text) return
  event.preventDefault()
  void copyText(text, `已复制 ${text.split('\n').length} 行日志`)
}

/** 切回前台补一轮：后台期间一直在排 timer，但没真的发请求 */
function onVisible() {
  if (!document.hidden && follow.value) void load(false)
}

onMounted(() => {
  void load(true)
  window.addEventListener('keydown', onKeydown, true)
  document.addEventListener('visibilitychange', onVisible)
})

onBeforeUnmount(() => {
  window.clearTimeout(timer)
  window.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<template>
  <section class="lg">
    <header class="lg-head">
      <span class="lg-title mono">{{ row.name }}</span>
      <span class="lg-cmd mono">journalctl -u {{ row.name }}</span>
      <span v-if="source === 'sudo'" class="lg-tag">sudo</span>
      <span class="lg-meta">{{ lines.length }} 行 · {{ stamp }}</span>

      <div class="grow" />

      <el-select v-model="pageSize" size="small" class="lg-size" :teleported="false">
        <el-option label="最近 200 行" :value="200" />
        <el-option label="最近 500 行" :value="500" />
        <el-option label="最近 1000 行" :value="1000" />
      </el-select>
      <el-checkbox v-model="follow" size="small">实时</el-checkbox>
      <el-button size="small" :icon="Refresh" :loading="busy" @click="load(true)">刷新</el-button>
      <el-button size="small" :icon="DocumentCopy" @click="copyAll">复制</el-button>
      <button class="lg-x" title="关闭（Esc）" @click="emit('close')">
        <el-icon><Close /></el-icon>
      </button>
    </header>

    <!-- 权限限制 / 没有持久化日志这类事不是错误，但决定了「你能看到什么」，必须说出来 -->
    <div v-if="note" class="lg-note">{{ note }}</div>

    <div class="lg-wrap">
      <div ref="bodyEl" class="lg-body" @scroll="onScroll">
        <div v-if="error" class="lg-state bad">{{ error }}</div>
        <div v-else-if="!view.length" class="lg-state">
          {{ busy ? '读取中…' : '这个服务还没有日志（journalctl 没返回任何条目）' }}
        </div>
        <template v-else>
          <div v-for="(l, i) in view" :key="i" class="ln" :class="l.tone">
            <span v-if="l.ts" class="ts">{{ l.ts }}</span>
            <span class="msg">{{ l.rest }}</span>
          </div>
        </template>
      </div>
      <button v-if="!pinned" class="lg-jump" @click="follow = true">↓ 跳到最新</button>
    </div>
  </section>
</template>

<style scoped>
.lg {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  height: min(56%, 520px);
  min-height: 180px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  box-shadow: 0 -8px 24px rgb(0 0 0 / 12%);
}

.lg-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-panel-2);
}

.lg-title {
  flex: none;
  font-size: 12px;
  color: var(--text-1);
  font-weight: 600;
}

/* 把实际执行的那条命令摆出来：出问题时用户能自己复制到终端里复现 */
.lg-cmd {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--text-3);
}

.lg-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  line-height: 16px;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
}

.lg-meta {
  flex: none;
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.grow {
  flex: 1;
}

.lg-size {
  width: 118px;
  flex: none;
}

.lg-head :deep(.el-checkbox) {
  margin-right: 0;
}

.lg-head :deep(.el-checkbox__label) {
  font-size: 11.5px;
  padding-left: 5px;
}

/* Element Plus 相邻按钮默认 12px 外边距，这里叠上 flex 的 gap 会撑到 20px */
.lg-head :deep(.el-button + .el-button) {
  margin-left: 0;
}

.lg-head :deep(.el-button) {
  height: 24px;
  padding: 0 8px;
  font-size: 11.5px;
}

.lg-x {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

.lg-x:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.lg-note {
  flex: none;
  padding: 5px 12px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-2);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border-bottom: 1px solid var(--border-soft);
}

.lg-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}

.lg-body {
  height: 100%;
  overflow: auto;
  padding: 6px 12px 10px;
  /* 日志要能选中复制：全局 body 上是 user-select:none，这里必须显式放开 */
  user-select: text;
  cursor: text;
}

.lg-body ::selection {
  background: #2563eb;
  color: #fff;
}

.ln {
  display: flex;
  gap: 8px;
  font-family: var(--font-mono, ui-monospace, 'Cascadia Mono', Consolas, monospace);
  font-size: 11.5px;
  line-height: 18px;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-all;
  /* 两千行一次排版会卡滚动：屏外的行不参与布局绘制 */
  content-visibility: auto;
  contain-intrinsic-size: auto 18px;
}

.ln .ts {
  flex: none;
  color: var(--text-3);
  opacity: 0.75;
}

.ln .msg {
  min-width: 0;
}

/* 只在正文里找错误词：时间戳和主机名里不会有这些词，但也别整行刷红 */
.ln.bad .msg {
  color: var(--danger);
}

.ln.warn .msg {
  color: var(--warning);
}

.lg-state {
  padding: 18px 6px;
  font-size: 11.5px;
  color: var(--text-3);
}

.lg-state.bad {
  color: var(--danger);
  white-space: pre-wrap;
}

.lg-jump {
  position: absolute;
  right: 14px;
  bottom: 12px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-panel);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
}

.lg-jump:hover {
  color: var(--accent);
  border-color: var(--accent);
}

/* 窄窗口：先让出命令复现那一行，工具条不能再折行 */
@media (max-width: 1120px) {
  .lg-cmd {
    display: none;
  }
}

@media (max-width: 980px) {
  .lg-meta {
    display: none;
  }
}
</style>
