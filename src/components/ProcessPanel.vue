<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CopyDocument, Refresh, Search } from '@element-plus/icons-vue'
import type { Tab } from '../stores/app'
import { cleanError } from '../stores/app'
import { usePaneBusy } from '../utils/pane-busy'
import type { ProcRow, ProcSnapshot } from '../../electron/types'

const props = defineProps<{ tab: Tab }>()

const snap = ref<ProcSnapshot | null>(null)
const loading = ref(false)
usePaneBusy('procs', loading)
const error = ref('')
const keyword = ref('')
const auto = ref(true)

type SortKey = 'cpu' | 'mem' | 'rss' | 'pid'
const sortKey = ref<SortKey>('cpu')
const sortDesc = ref(true)

/** 一次渲染 400 行封顶：再多 DOM 就拖了，剩下的靠搜索缩小范围 */
const RENDER_CAP = 400

let timer: number | undefined
let inFlight = false

/**
 * 上一轮采集耗时（毫秒）。
 *
 * 进程页每轮要跑 `ps -ww` + 扫一遍 /proc，机器上进程多的时候一两秒才回来。
 * 还按 3 秒踩着点发，就等于这条 SSH 连接一直在忙着传进程表 —— 同一个连接上的
 * 终端输入、监控采样全被挤，用户感受就是"整个 App 卡"、鼠标拖动一卡一卡的。
 * 所以慢的时候自动拉开间隔，把连接还给别的功能。
 */
let lastCost = 0
const FAST_MS = 3000
const SLOW_MS = 8000

function gapMs(): number {
  return lastCost > 1500 ? SLOW_MS : FAST_MS
}

/** 实际间隔要如实显示：写着「每 3 秒」却在等 8 秒，用户会以为刷新坏了 */
const autoGapSec = ref(3)

function sessionId(): string {
  return props.tab.sessionId || ''
}

async function load(silent = false) {
  const sid = sessionId()
  if (!sid || inFlight) return
  inFlight = true
  if (!silent) loading.value = true
  const firstLoad = snap.value === null
  const started = performance.now()
  try {
    snap.value = await window.api.ssh.procs(sid)
    error.value = ''
    // 换了一台机器，上一轮的名次没意义了
    if (firstLoad) prevRank.clear()
    /**
     * CPU 占用靠两次采样求差，第一次只能建游标 —— 不然用户打开就看到 0%，
     * 以为进程页坏了。这里立刻补一次，半秒后数字就是真的。
     */
    if (firstLoad) {
      window.setTimeout(() => {
        if (props.tab.view === 'procs') void load(true)
      }, 500)
    }
  } catch (err) {
    error.value = cleanError(err)
    if (!silent) snap.value = null
  } finally {
    inFlight = false
    loading.value = false
    lastCost = performance.now() - started
    autoGapSec.value = gapMs() / 1000
  }
}

function stopTimer() {
  if (timer) {
    window.clearTimeout(timer)
    timer = undefined
  }
}

/**
 * 自动刷新用「跑完再排下一次」的自调度，不用 setInterval。
 *
 * 原因有两个：
 * 1. 采集慢的服务器（几百上千个进程 + awk 扫 /proc）一趟要一两秒，setInterval
 *    会一直踩着点发，同一条 SSH 通道被占满，终端敲字都跟着卡；
 * 2. 上一趟还没回来时 inFlight 直接丢弃，看起来像"没刷新"，其实是被自己挡的。
 */
function scheduleNext() {
  stopTimer()
  if (!auto.value) return
  timer = window.setTimeout(async () => {
    timer = undefined
    if (props.tab.view !== 'procs') {
      scheduleNext()
      return
    }
    /*
     * 窗口在后台就不去戳服务器 —— 但只在「已经有数据」时成立。
     * 首轮常见失败是切页签那一刻会话还没连上（sessionId 还是空），
     * 要是后台也一律跳过，这一页就会永远停在转圈上，用户切回来还是空的。
     */
    if (document.hidden && snap.value) {
      scheduleNext()
      return
    }
    await load(true)
    scheduleNext()
  }, gapMs())
}

watch(auto, () => {
  if (props.tab.view === 'procs') scheduleNext()
})

watch(
  () => props.tab.view,
  (view) => {
    if (view === 'procs') {
      // 切回来先给一眼旧数据，再补一次新的，别让整屏空白等 3s
      void load()
      scheduleNext()
    } else {
      stopTimer()
    }
  }
)

/**
 * 页签先点、连接后到：这一刻 sessionId 才出现，补一轮采集。
 * 没有这条就只能等 3 秒后的下一轮定时（窗口在后台时更是要等到用户切回前台）。
 */
watch(
  () => props.tab.sessionId,
  (sid) => {
    if (sid && props.tab.view === 'procs' && !snap.value) void load()
  }
)

onMounted(() => {
  if (props.tab.view === 'procs') {
    void load()
    scheduleNext()
  }
})

onBeforeUnmount(stopTimer)

/* ---------------- 排序 / 过滤 ---------------- */

function sortBy(key: SortKey) {
  // 换排序键/方向要立刻按真实值重排，别被滞回卡住
  prevRank.clear()
  if (sortKey.value === key) sortDesc.value = !sortDesc.value
  else {
    sortKey.value = key
    sortDesc.value = true
  }
}

/**
 * 上一轮的名次 + 滞回。
 *
 * 每 3 秒按实时值全量重排时，行会在鼠标底下来回窜：hover 出来的「结束/强杀」跟着闪，
 * 每行的 title 提示也被反复取消重弹 —— 观感就是"鼠标在鬼畜"。而 CPU 占用本来就在抖动，
 * 差个 1% 就换位毫无意义。
 *
 * 所以两个数值相差不到 5% 时当作并列，按上一轮先后排；真涨上去/掉下来照样换位。
 */
const prevRank = new Map<number, number>()
const HYST = 0.05

function sortValue(r: ProcRow, key: SortKey): number {
  if (key === 'pid') return r.pid
  if (key === 'rss') return r.rss
  return key === 'cpu' ? r.cpu : r.mem
}

const filtered = computed(() => {
  const all = snap.value?.rows ?? []
  const kw = keyword.value.trim().toLowerCase()
  const rows = kw
    ? all.filter(
        (r) =>
          r.cmd.toLowerCase().includes(kw) ||
          r.user.toLowerCase().includes(kw) ||
          String(r.pid).includes(kw)
      )
    : all.slice()

  const key = sortKey.value
  const dir = sortDesc.value ? -1 : 1
  const hyst = key !== 'pid'

  rows.sort((a, b) => {
    const va = sortValue(a, key)
    const vb = sortValue(b, key)
    if (va === vb) return a.pid - b.pid
    if (hyst) {
      const scale = Math.max(Math.abs(va), Math.abs(vb))
      if (scale > 0 && Math.abs(va - vb) / scale < HYST) {
        const ra = prevRank.get(a.pid)
        const rb = prevRank.get(b.pid)
        if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb
        return a.pid - b.pid
      }
    }
    return va > vb ? dir : -dir
  })

  // 记名次给下一轮当参照（这个 computed 每次依赖变化只跑一次，副作用可控）
  rows.forEach((r, i) => prevRank.set(r.pid, i))
  return rows
})

const shown = computed(() => filtered.value.slice(0, RENDER_CAP))
const hiddenCount = computed(() => Math.max(0, filtered.value.length - RENDER_CAP))

/* ---------------- 概要 ---------------- */

const stats = computed(() => snap.value?.stats)

const cpuPct = computed(() => stats.value?.cpu ?? 0)

const memPct = computed(() => {
  const s = stats.value
  if (!s || !s.memTotal) return 0
  return Math.min(100, (s.memUsed / s.memTotal) * 100)
})

const swapPct = computed(() => {
  const s = stats.value
  if (!s || !s.swapTotal) return 0
  return Math.min(100, (s.swapUsed / s.swapTotal) * 100)
})

const htop = computed(() => snap.value?.htop)

/* ---------------- 展示辅助 ---------------- */

/** 条形宽度：单核满 = 100%，多线程进程会超过 100，条子封顶但数字照实显示 */
function barWidth(pct: number): string {
  return `${Math.max(0, Math.min(100, pct))}%`
}

function heat(pct: number): string {
  if (pct >= 60) return 'hot'
  if (pct >= 25) return 'warm'
  return ''
}

function toSize(kb: number): string {
  if (!kb) return '0'
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(0)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

function toGb(mb: number): string {
  if (!mb) return '0'
  const gb = mb / 1024
  return gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)
}

const stateTip: Record<string, string> = {
  R: '运行中',
  S: '可中断睡眠',
  D: '不可中断（等 IO）',
  Z: '僵尸',
  T: '已停止',
  I: '空闲内核线程'
}

async function copyInstall() {
  const cmd = htop.value?.install
  if (!cmd) return
  try {
    await window.api.clipboard.write(cmd)
    ElMessage.success('安装命令已复制')
  } catch (err) {
    ElMessage.error(cleanError(err))
  }
}

async function kill(row: ProcRow, force: boolean) {
  const sid = sessionId()
  if (!sid) return
  const short = row.cmd.length > 64 ? `${row.cmd.slice(0, 64)}…` : row.cmd
  try {
    await ElMessageBox.confirm(
      force
        ? `强制杀死 PID ${row.pid}\n${short}\n\nSIGKILL 进程拦不住，正在写的文件可能留下半截。`
        : `结束 PID ${row.pid}\n${short}\n\n发 SIGTERM，进程有机会自己收尾。`,
      force ? '强制杀死进程' : '结束进程',
      {
        type: force ? 'error' : 'warning',
        confirmButtonText: force ? '强杀' : '结束',
        cancelButtonText: '取消',
        confirmButtonClass: force ? 'el-button--danger' : ''
      }
    )
  } catch {
    return
  }
  try {
    const msg = await window.api.ssh.killProc(sid, row.pid, force)
    ElMessage.success(msg)
    await load()
  } catch (err) {
    ElMessage.error(cleanError(err))
  }
}
</script>

<template>
  <div class="proc">
    <!-- htop 没装：按发行版给命令，直接复制就能贴到终端里跑 -->
    <div v-if="snap && !htop?.available" class="htop-tip">
      <span class="tip-text">
        这台机器没有 htop<template v-if="htop?.os">（{{ htop.os }}）</template>，下面这张表是内置采集的。
        想要完整 htop：
      </span>
      <code class="mono">{{ htop?.install }}</code>
      <el-button size="small" text :icon="CopyDocument" @click="copyInstall">复制</el-button>
      <el-button size="small" text :icon="Refresh" @click="load()">重新检测</el-button>
    </div>

    <div class="meters">
      <div class="meter">
        <span class="k">CPU</span>
        <b>{{ cpuPct.toFixed(0) }}%</b>
        <i class="track"><i class="fill" :class="heat(cpuPct)" :style="{ width: barWidth(cpuPct) }" /></i>
        <span class="sub">
          负载 {{ stats?.load1.toFixed(2) ?? '—' }} / {{ stats?.load5.toFixed(2) ?? '—' }} /
          {{ stats?.load15.toFixed(2) ?? '—' }} · {{ stats?.cores ?? 0 }} 核
        </span>
      </div>
      <div class="meter">
        <span class="k">内存</span>
        <b>{{ toGb(stats?.memUsed ?? 0) }} / {{ toGb(stats?.memTotal ?? 0) }} GB</b>
        <i class="track"><i class="fill" :class="heat(memPct)" :style="{ width: barWidth(memPct) }" /></i>
        <span class="sub">{{ memPct.toFixed(1) }}%</span>
      </div>
      <div class="meter">
        <span class="k">Swap</span>
        <b>{{ toGb(stats?.swapUsed ?? 0) }} / {{ toGb(stats?.swapTotal ?? 0) }} GB</b>
        <i class="track"><i class="fill" :class="heat(swapPct)" :style="{ width: barWidth(swapPct) }" /></i>
        <span class="sub">{{ stats?.swapTotal ? `${swapPct.toFixed(1)}%` : '未启用' }}</span>
      </div>
      <div class="meter">
        <span class="k">进程</span>
        <b>{{ stats?.total ?? 0 }}</b>
        <span class="sub">
          运行 {{ stats?.running ?? 0 }} · 睡眠 {{ stats?.sleeping ?? 0 }} · 僵尸
          <em :class="{ bad: (stats?.zombie ?? 0) > 0 }">{{ stats?.zombie ?? 0 }}</em> ·
          {{ stats?.threads ?? 0 }} 线程
        </span>
      </div>
    </div>

    <div class="proc-bar">
      <el-input v-model="keyword" size="small" placeholder="搜命令 / 用户 / PID" clearable class="kw">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <div class="grow" />
      <el-checkbox v-model="auto" size="small">每 {{ autoGapSec }} 秒刷新</el-checkbox>
      <el-button size="small" :icon="Refresh" :loading="loading" @click="load()">刷新</el-button>
    </div>

    <div v-if="error" class="state small">
      <span class="err">{{ error }}</span>
      <el-button size="small" text :icon="Refresh" @click="load()">重试</el-button>
    </div>

    <div v-else-if="!snap" class="state small"><div class="spinner" /></div>

    <div v-else class="ptable">
      <div class="thead">
        <span class="c-pid" @click="sortBy('pid')">PID</span>
        <span class="c-user">USER</span>
        <span class="c-num" @click="sortBy('cpu')">
          CPU%<i v-if="sortKey === 'cpu'" class="arrow">{{ sortDesc ? '▼' : '▲' }}</i>
        </span>
        <span class="c-num" @click="sortBy('mem')">
          MEM%<i v-if="sortKey === 'mem'" class="arrow">{{ sortDesc ? '▼' : '▲' }}</i>
        </span>
        <span class="c-rss" @click="sortBy('rss')">
          RSS<i v-if="sortKey === 'rss'" class="arrow">{{ sortDesc ? '▼' : '▲' }}</i>
        </span>
        <span class="c-state">S</span>
        <span class="c-cmd">COMMAND</span>
        <span class="c-act" />
      </div>
      <div class="tbody">
        <div v-for="r in shown" :key="r.pid" class="row" :class="{ run: r.state === 'R' }">
          <span class="c-pid mono">{{ r.pid }}</span>
          <span class="c-user truncate" :title="r.user">{{ r.user }}</span>
          <span class="c-num mono cell-bar">
            <i class="bar" :class="heat(r.cpu)" :style="{ width: barWidth(r.cpu) }" />
            <b>{{ r.cpu.toFixed(1) }}</b>
          </span>
          <span class="c-num mono cell-bar">
            <i class="bar" :class="heat(r.mem)" :style="{ width: barWidth(r.mem) }" />
            <b>{{ r.mem.toFixed(1) }}</b>
          </span>
          <span class="c-rss mono">{{ toSize(r.rss) }}</span>
          <span class="c-state mono" :class="'s-' + r.state" :title="stateTip[r.state] || r.state">
            {{ r.state }}
          </span>
          <span class="c-cmd mono truncate" :title="r.cmd">{{ r.cmd }}</span>
          <span class="c-act">
            <button class="act" title="结束进程（SIGTERM）" @click="kill(r, false)">结束</button>
            <button class="act danger" title="强制杀死（SIGKILL）" @click="kill(r, true)">强杀</button>
          </span>
        </div>
        <div v-if="!shown.length" class="empty">没有匹配的进程</div>
      </div>
      <div class="pfoot">
        <span>
          显示 {{ shown.length }} / {{ filtered.length }} 个
          <template v-if="hiddenCount">（还有 {{ hiddenCount }} 个没渲染，用搜索缩小范围）</template>
        </span>
        <span class="mono">采样 {{ snap ? new Date(snap.time).toLocaleTimeString() : '—' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.proc {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-base);
}

/* ---------- htop 缺失提示 ---------- */
.htop-tip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 11px;
  color: var(--text-2);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
  border-bottom: 1px solid var(--border-soft);
}

.tip-text {
  /* 窄窗口下先让文案缩，命令不能被截 —— 用户要复制的是命令 */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.htop-tip code {
  flex: none;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-panel-2);
  color: var(--text-1);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 概要 ---------- */
.meters {
  flex: none;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  padding: 10px 12px;
}

.meter {
  min-width: 0;
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: baseline;
  gap: 2px 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
}

.meter .k {
  font-size: 11px;
  color: var(--text-3);
}

.meter b {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.track {
  grid-column: 1 / -1;
  display: block;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-panel-2);
  overflow: hidden;
}

.fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.3s;
}

.fill.warm {
  background: #f59e0b;
}

.fill.hot {
  background: #ef4444;
}

.meter .sub {
  grid-column: 1 / -1;
  font-size: 10px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meter .sub em.bad {
  color: #ef4444;
  font-style: normal;
}

/* ---------- 工具条 ---------- */
.proc-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px 8px;
}

.proc-bar .kw {
  width: 220px;
}

.grow {
  flex: 1;
}

/* ---------- 表 ---------- */
.ptable {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin: 0 12px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  overflow: hidden;
}

/*
 * 列宽固定 + 命令列吃掉剩余：进程里长命令行太多了，
 * 让命令列自己缩，别的列不会被挤得跳来跳去。
 */
.thead,
.row {
  display: grid;
  grid-template-columns: 68px 108px 104px 104px 84px 34px minmax(0, 1fr) 92px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
}

.thead {
  flex: none;
  height: 28px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-3);
  background: var(--bg-panel-2);
  border-bottom: 1px solid var(--border-soft);
}

.thead .c-pid,
.thead .c-num,
.thead .c-rss {
  cursor: pointer;
  user-select: none;
}

.thead .c-pid:hover,
.thead .c-num:hover,
.thead .c-rss:hover {
  color: var(--accent);
}

.arrow {
  margin-left: 3px;
  font-style: normal;
  color: var(--accent);
}

.tbody {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.row {
  height: 26px;
  font-size: 11.5px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-soft) 55%, transparent);
  /*
   * 一次渲染 400 行，但屏幕上只看得见十几行：给上行外可见性之后，
   * 滚出视口的行完全不参与排版和绘制，每次刷新只重绘看得见那几行。
   * contain-intrinsic-size 必须写死行高（26px，和 height 一致），
   * 否则滚动条长度会先塌再涨，滚轮一拖就跳。
   */
  content-visibility: auto;
  contain-intrinsic-size: auto 26px;
}

.row:hover {
  background: var(--bg-panel-2);
}

.row.run .c-pid {
  color: #22c55e;
  font-weight: 600;
}

.c-pid {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.c-user {
  color: var(--text-2);
}

.c-rss {
  color: var(--text-2);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 百分比条垫在数字底下，扫一眼就能看出谁在吃 CPU —— htop 的观感靠的就是它 */
.cell-bar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 18px;
  padding-right: 4px;
  border-radius: 3px;
  overflow: hidden;
}

/*
 * 这里**不能**给 width 加 transition：400 行 × 2 条 = 每次刷新 800 个宽度动画同时跑，
 * 每个都要重排重绘，整机就是被它拖卡的（顶部那 4 个概要条可以动画，它们只有 4 个）。
 */
.cell-bar .bar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: color-mix(in srgb, var(--accent) 26%, transparent);
}

.cell-bar .bar.warm {
  background: color-mix(in srgb, #f59e0b 34%, transparent);
}

.cell-bar .bar.hot {
  background: color-mix(in srgb, #ef4444 38%, transparent);
}

.cell-bar b {
  position: relative;
  font-weight: 500;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.c-state {
  font-weight: 600;
  text-align: center;
}

.c-state.s-R {
  color: #22c55e;
}

.c-state.s-D {
  color: #f59e0b;
}

.c-state.s-Z {
  color: #ef4444;
}

.c-state.s-T,
.c-state.s-I {
  color: var(--text-3);
}

.c-cmd {
  color: var(--text-1);
}

.c-act {
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: flex-end;
  opacity: 0;
  transition: opacity 0.12s;
}

.row:hover .c-act {
  opacity: 1;
}

.act {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  font-size: 10.5px;
  cursor: pointer;
}

.act:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.act.danger:hover {
  color: #ef4444;
  border-color: #ef4444;
}

.empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}

.pfoot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 24px;
  padding: 0 10px;
  font-size: 10.5px;
  color: var(--text-3);
  border-top: 1px solid var(--border-soft);
}

/* ---------- 状态 ---------- */
.state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 12px;
  color: var(--text-2);
}

.state.small {
  padding: 20px;
}

.err {
  color: #ef4444;
}

.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spinner {
  width: 22px;
  height: 22px;
  margin: 0 auto 10px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--text-1) 15%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
