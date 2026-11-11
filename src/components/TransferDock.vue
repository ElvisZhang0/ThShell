<script setup lang="ts">
/**
 * 窗口底部的传输面板：正在传的 + 传完的记录，一个地方看全。
 *
 * 为什么从文件页搬到这里：
 *   进度条原来挂在文件页底部，传完 5 秒就消失，于是"我刚把哪个文件从哪传到哪了"
 *   只能靠记忆。运维排查时这条信息很关键（备份到底落在 /data 还是 /home），
 *   所以记录要落盘、要能回看，而且不该跟某个标签页绑在一起 ——
 *   切到终端页照样能看见后台还在传。
 *
 * 为什么默认收起：它是个"看一眼就走"的辅助面板，常驻展开会一直占掉
 * 终端/文件列表的高度。收起时也不浪费：这一行本身就显示当前传输的百分比。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import { ArrowDown, Close, Download, Sort, Upload, VideoPause, VideoPlay } from '@element-plus/icons-vue'
import {
  formatDuration,
  formatEta,
  formatSize,
  formatSpeed,
  formatWhen,
  percentOf,
  transferState
} from '../utils/transfer-format'

const store = useAppStore()
const listEl = ref<HTMLElement | null>(null)

const OPEN_KEY = 'thshell.transferDock.open'
const open = ref(localStorage.getItem(OPEN_KEY) === '1')

/** 正在传的（全局，不分标签页） */
const active = computed(() => store.transfers.filter((t) => !t.done))

/**
 * 已结束的记录。要把"刚刚完成、界面还在显示 100%"那一条排掉，
 * 否则同一次传输会在列表里出现两行（一行进度、一行记录），看着像传了两次。
 */
const running = computed(() => new Set(store.transfers.map((t) => t.transferId)))
const history = computed(() => store.transferLog.filter((r) => !running.value.has(r.id)))

const failCount = computed(() => store.transferLog.filter((r) => r.error).length)

/** 收起状态下的那一行摘要：优先说"正在传什么"，没有就说"最近传了什么" */
const summary = computed(() => {
  const top = active.value[0]
  if (top) {
    const dir = top.direction === 'upload' ? '上传' : '下载'
    if (top.paused) return `${dir} ${top.filename} 已暂停 · ${percentOf(top)}%`
    const speed = top.done ? '' : ` · ${formatSpeed(top.speed)}`
    return `${dir} ${top.filename} ${percentOf(top)}%${speed}`
  }
  const last = store.transferLog[0]
  if (!last) return '还没有上传 / 下载记录'
  return `最近：${last.direction === 'upload' ? '上传' : '下载'} ${last.name} · ${formatWhen(last.at)}`
})

const total = computed(() => store.transferLog.length)

function toggle(): void {
  open.value = !open.value
}

watch(open, (v) => {
  localStorage.setItem(OPEN_KEY, v ? '1' : '0')
})

/** 展开时把列表拉回顶部：新记录在最上面，刚传完就该看到它 */
function scrollTop(): void {
  void nextTick(() => {
    if (listEl.value) listEl.value.scrollTop = 0
  })
}
watch(
  () => store.transferLog[0]?.id,
  () => {
    if (open.value) scrollTop()
  }
)

onMounted(() => {
  void store.loadTransferLog()
})
</script>

<template>
  <section class="dock" :class="{ open }">
    <!-- 这一行始终在：收起时它就是"状态条"，展开时它是标题栏 -->
    <div
      class="head"
      role="button"
      tabindex="0"
      :title="open ? '收起传输记录' : '展开传输记录'"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <el-icon class="h-icon"><Sort /></el-icon>
      <span class="h-title">传输</span>

      <span v-if="active.length" class="h-live">
        <span class="pulse" />
        {{ active.length }} 个进行中
      </span>

      <span class="h-sum truncate">{{ summary }}</span>

      <span v-if="failCount" class="h-fail">{{ failCount }} 个失败</span>
      <span v-if="total" class="h-count mono">{{ total }} 条</span>

      <el-popconfirm
        v-if="open && total"
        title="清空全部传输记录？"
        confirm-button-text="清空"
        cancel-button-text="取消"
        :width="200"
        @confirm="store.clearTransferLog()"
      >
        <template #reference>
          <!-- 点它不该顺手把面板收起来 -->
          <button class="h-btn" title="清空记录" @click.stop>清空</button>
        </template>
      </el-popconfirm>

      <el-icon class="h-chev" :class="{ up: open }"><ArrowDown /></el-icon>
    </div>

    <div v-if="open" ref="listEl" class="dock-list">
      <!-- 进行中：进度 + 源 → 目标 -->
      <div
        v-for="item in active"
        :key="item.transferId"
        class="row live"
        :title="item.error || `${item.from} → ${item.to}`"
      >
        <span class="badge" :class="item.direction">
          <el-icon>
            <Upload v-if="item.direction === 'upload'" />
            <Download v-else />
          </el-icon>
        </span>

        <div class="body">
          <div class="l1">
            <span class="name truncate">{{ item.filename }}</span>
            <span class="m speed mono">{{ item.done ? '' : formatSpeed(item.speed) }}</span>
            <span class="m pct mono">{{ percentOf(item) }}%</span>

            <!--
              暂停 / 继续 / 取消只在"还没结束"时给。
              done 那一帧（成功后界面还会挂 1.2 秒）再给按钮，点了也不会有反应，纯属误导。
            -->
            <span v-if="!item.done" class="ctl">
              <button
                class="c-btn"
                :title="item.paused ? '继续传输' : '暂停传输'"
                @click.stop="
                  item.paused ? store.resumeTransfer(item.transferId) : store.pauseTransfer(item.transferId)
                "
              >
                <el-icon>
                  <VideoPlay v-if="item.paused" />
                  <VideoPause v-else />
                </el-icon>
              </button>
              <button class="c-btn danger" title="取消传输" @click.stop="store.cancelTransfer(item.transferId)">
                <el-icon><Close /></el-icon>
              </button>
            </span>
          </div>
          <div class="l1">
            <el-progress
              class="bar"
              :percentage="percentOf(item)"
              :status="item.error ? 'exception' : item.done ? 'success' : undefined"
              :stroke-width="4"
              :show-text="false"
            />
            <span class="m bytes mono">
              {{ formatSize(item.transferred, false) }} / {{ formatSize(item.total, false) }}
            </span>
            <span class="m eta mono">{{ formatEta(item) }}</span>
            <span class="m state">{{ transferState(item) }}</span>
          </div>
          <div class="path mono">
            <span class="p">{{ item.from }}</span>
            <span class="arrow">→</span>
            <span class="p">{{ item.to }}</span>
          </div>
        </div>
      </div>

      <!-- 已结束的记录 -->
      <div
        v-for="rec in history"
        :key="rec.id"
        class="row done"
        :class="{ failed: !!rec.error }"
        :title="rec.error || `${rec.from} → ${rec.to}\n耗时 ${formatDuration(rec.ms)}`"
      >
        <span class="badge" :class="rec.direction">
          <el-icon>
            <Upload v-if="rec.direction === 'upload'" />
            <Download v-else />
          </el-icon>
        </span>

        <div class="body">
          <div class="l1">
            <span class="name truncate">{{ rec.name }}</span>
            <span v-if="rec.dir" class="tag">文件夹</span>
            <span class="m size mono">{{ formatSize(rec.size) }}</span>
            <span class="m when mono">{{ formatWhen(rec.at) }}</span>
            <span class="m state" :class="{ bad: !!rec.error }">
              {{ rec.error ? '失败' : '已完成' }}
            </span>
          </div>
          <div class="path mono">
            <span class="p">{{ rec.from }}</span>
            <span class="arrow">→</span>
            <span class="p">{{ rec.to }}</span>
          </div>
          <div v-if="rec.error" class="err">{{ rec.error }}</div>
        </div>
      </div>

      <div v-if="!active.length && !history.length" class="empty">
        还没有上传 / 下载记录
      </div>
    </div>
  </section>
</template>

<style scoped>
.dock {
  flex: none;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}

/* 收起时 30px，和状态栏一个量级：它是"看一眼"的东西，不该抢主区域 */
.head {
  height: 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  cursor: pointer;
  user-select: none;
  outline: none;
}

.head:hover {
  background: var(--bg-hover);
}

.head:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent-line);
}

.h-icon {
  font-size: var(--icon-xs);
  color: var(--text-3);
  flex: none;
}

.h-title {
  font-size: 11px;
  color: var(--text-2);
  flex: none;
}

.h-live {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
  font-size: 10.5px;
  color: var(--accent);
}

/* 一个呼吸点：不看文字也知道"还在动" */
.pulse {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  animation: breathe 1.4s ease-in-out infinite;
}

@keyframes breathe {
  50% {
    opacity: 0.25;
  }
}

.h-sum {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-3);
}

.h-fail {
  flex: none;
  font-size: 10.5px;
  color: var(--danger);
}

.h-count {
  flex: none;
  font-size: 10.5px;
  color: var(--text-3);
}

.h-btn {
  flex: none;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  font-size: 10.5px;
  color: var(--text-2);
  cursor: pointer;
}

.h-btn:hover {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
}

.h-chev {
  font-size: var(--icon-xs);
  color: var(--text-3);
  flex: none;
  transition: transform 0.15s ease;
}

.h-chev.up {
  transform: rotate(180deg);
}

/* 展开后给个上限：传了 20 个文件也不该把终端挤成一条缝。
 * 260px 是按"三条进行中 + 一条历史刚好不滚动"标定的（冒烟里有断言）；
 * 行内的控制按钮从 16px 放大到 22px 之后，每行高 6px，这里跟着加了 28px。 */
.dock-list {
  max-height: 260px;
  overflow-y: auto;
  padding: 2px 12px 8px;
  border-top: 1px solid var(--border-soft);
}

.row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
}

.row + .row {
  border-top: 1px solid var(--border-soft);
}

.badge {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 4px;
  font-size: 11px;
}

/* 上传 / 下载用两种色，扫一眼就能分清方向，不用去读箭头 */
.badge.upload {
  color: var(--accent-2);
  background: color-mix(in srgb, var(--accent-2) 14%, transparent);
}

.badge.download {
  color: var(--accent);
  background: var(--accent-soft);
}

.row.failed .badge {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}

.body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.l1 {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.name {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-1);
}

.row.done .name {
  color: var(--text-2);
}

.row.failed .name {
  color: var(--danger);
}

.tag {
  flex: none;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 9.5px;
  line-height: 14px;
  color: var(--text-3);
}

.m {
  flex: none;
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
}

/* 固定列宽 + 右对齐，多行之间能竖着扫。
   字节列要给到 96px："2.1 GB / 8.4 GB" 这类"已传 / 总量"是 15 个字符，
   给窄了会溢出自己的格子，上下两行的右边缘就对不齐了。 */
.m.size,
.m.bytes {
  width: 96px;
  text-align: right;
}

.m.speed {
  width: 74px;
  text-align: right;
  color: var(--text-2);
}

.m.pct {
  width: 36px;
  text-align: right;
  color: var(--accent);
  font-weight: 600;
}

.m.eta {
  width: 52px;
  text-align: right;
}

.m.when {
  width: 84px;
  text-align: right;
}

.m.state {
  width: 56px;
  text-align: right;
  color: var(--success);
}

.row.live .m.state {
  color: var(--text-2);
}

.m.state.bad {
  color: var(--danger);
}

.bar {
  flex: 1;
  min-width: 0;
}

/*
 * 行内的暂停 / 取消按钮。
 * 常驻显示而不是 hover 才出现：传输区本来就只有几行，"要传完了才发现能暂停"
 * 比"稍微占点地方"更糟。
 *
 * 尺寸按 22×22 做：这是一天要点好几次的动作，16px 的图标框太小，
 * 鼠标得瞄着点，误点还会点到旁边的进度条上。
 * 代价是每行高 6px，面板的 max-height 跟着从 232 提到 260（见 .dock-list）。
 */
.ctl {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  flex: 0 0 auto;
  height: 22px;
}

.c-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
}

.c-btn:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.c-btn.danger:hover {
  background: var(--danger-soft, rgba(248, 113, 113, 0.14));
  color: var(--danger);
}

/* EP 默认进度槽是浅灰，深色主题下会亮得刺眼；太淡又看不见 4px 的槽 */
.bar :deep(.el-progress-bar__outer) {
  background: color-mix(in srgb, var(--text-1) 15%, transparent);
}

/*
 * 「从哪个目录、到哪个目录」单独一行，等宽字体、两半各自截断：
 * 路径太长时截中间比截尾巴有用 —— 头和尾分别说明"在哪台机器/哪个盘"和"落在哪"。
 */
.path {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-3);
}

.path .p {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path .p:first-child {
  flex: 0 1 auto;
}

.path .p:last-child {
  flex: 1 1 0;
  color: var(--text-2);
}

.path .arrow {
  flex: none;
  color: var(--text-3);
}

.err {
  font-size: 10.5px;
  color: var(--danger);
  word-break: break-all;
}

.empty {
  padding: 14px 2px;
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
}
</style>
