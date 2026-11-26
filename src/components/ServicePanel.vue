<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Search, WarningFilled } from '@element-plus/icons-vue'
import type { Tab } from '../stores/app'
import { cleanError } from '../stores/app'
import { usePaneBusy } from '../utils/pane-busy'
import ServiceLogPanel from './ServiceLogPanel.vue'
import type { ServiceAction, ServiceRow, ServiceSnapshot } from '../../electron/types'

const props = defineProps<{ tab: Tab }>()

const snap = ref<ServiceSnapshot | null>(null)
const loading = ref(false)
usePaneBusy('services', loading)
const error = ref('')
const keyword = ref('')
const loadedAt = ref(0)

/** 正在执行动作的服务名，用来给那一行单独转圈，避免整页禁用 */
const acting = ref('')

/**
 * 正在看日志的服务。
 * 用整行对象而不是只存名字：日志面板的标题要显示服务名和状态，
 * 翻过滤条件把这一行筛掉时面板也不会突然失去上下文。
 */
const logRow = ref<ServiceRow | null>(null)
function openLog(r: ServiceRow) {
  logRow.value = r
}

type Filter = 'all' | 'running' | 'stopped' | 'failed' | 'idle'
const filter = ref<Filter>('all')

/**
 * 四个分类互不重叠，加起来正好等于总数。
 * 「未加载」单独一项而不是并进「未运行」：这类单元根本没进过内存，
 * systemd 手里没有它的运行状态（可能 disabled 也可能被屏蔽），
 * 混进去会让「未运行」的数目和列表对不上，也让人误以为它们只是"停着"。
 */
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '运行中' },
  { key: 'stopped', label: '未运行' },
  { key: 'failed', label: '失败' },
  { key: 'idle', label: '未加载' }
]

async function load(silent = false) {
  const sid = props.tab.sessionId
  if (!sid || loading.value) return
  loading.value = true
  if (!silent) error.value = ''
  try {
    snap.value = await window.api.services.list(sid)
    error.value = ''
    loadedAt.value = Date.now()
  } catch (err) {
    error.value = cleanError(err)
    if (!silent) snap.value = null
  } finally {
    loading.value = false
  }
}

/**
 * 面板是 v-show 常驻的：不能靠 mounted 只采一次。
 * 切到本页时如果数据超过 30 秒就重采 —— 服务状态会被别人（定时任务、运维同事）改，
 * 隔太久看到的就不是现在了。30 秒这个值比系统页的 60 秒短：
 * 这一页的用途就是"看一眼现在跑没跑起来"。
 */
watch(
  () => props.tab.view,
  (view) => {
    if (view === 'services' && Date.now() - loadedAt.value > 30_000) void load()
  }
)

/** 页签先点、连接后到：这一刻 sessionId 才出现，补一次 */
watch(
  () => props.tab.sessionId,
  (sid) => {
    if (sid && props.tab.view === 'services' && !snap.value) void load()
  }
)

onMounted(() => {
  if (props.tab.view === 'services') void load()
})

/* ---------------- 状态展示 ---------------- */

type Tone = 'ok' | 'bad' | 'warn' | 'off' | 'idle'

/**
 * 状态口径：
 * - failed → 红「失败」，这是运维第一眼要找的；
 * - active → 绿「运行中」，副文本用 sub（running / exited：oneshot 跑完就是 exited）；
 * - activating / reloading / deactivating → 琥珀，正在变化，别让人以为卡住了；
 * - 其余已加载的 → 灰「已停止」；
 * - 没加载的（只在 unit file 里）→ 灰「未加载」，不能写成「已停止」——它根本没进过内存。
 */
function stateOf(r: ServiceRow): { tone: Tone; text: string; sub: string } {
  if (!r.loaded) return { tone: 'idle', text: '未加载', sub: r.load || '无 unit 文件信息' }
  if (r.active === 'failed') return { tone: 'bad', text: '失败', sub: r.sub || 'failed' }
  if (r.active === 'active') return { tone: 'ok', text: '运行中', sub: r.sub || 'active' }
  if (/^(activating|reloading|deactivating)$/.test(r.active)) {
    return { tone: 'warn', text: r.active === 'deactivating' ? '停止中' : '启动中', sub: r.sub }
  }
  return { tone: 'off', text: '已停止', sub: r.sub || r.active || 'inactive' }
}

/** enabled 的中文化；用户关心的只有「会不会开机自启」 */
function enabledText(r: ServiceRow): string {
  const v = r.enabled
  if (!v) return '—'
  const map: Record<string, string> = {
    enabled: '开机自启',
    'enabled-runtime': '临时启用',
    disabled: '手动',
    static: '被依赖',
    indirect: '被依赖',
    masked: '已屏蔽',
    'masked-runtime': '已屏蔽',
    generated: '生成'
  }
  return map[v] ?? v
}

function enabledTone(r: ServiceRow): string {
  if (r.enabled === 'enabled' || r.enabled === 'enabled-runtime') return 'on'
  if (r.enabled.startsWith('masked')) return 'masked'
  return ''
}

/* ---------------- 过滤 / 排序 ---------------- */

const rows = computed(() => snap.value?.rows ?? [])

const counts = computed(() => {
  const all = rows.value
  return {
    all: all.length,
    running: all.filter((r) => r.active === 'active').length,
    stopped: all.filter((r) => r.loaded && r.active !== 'active' && r.active !== 'failed').length,
    failed: all.filter((r) => r.active === 'failed').length,
    idle: all.filter((r) => !r.loaded).length
  }
})

/**
 * 默认顺序：失败 → 运行中 → 其余，同类按名字。
 * 服务页动辄两三百条，纯按字母排的话「哪个挂了」得靠滚动去找；
 * 出问题的排最前面，才符合打开这一页的目的。
 */
const TONE_RANK: Record<Tone, number> = { bad: 0, ok: 1, warn: 2, off: 3, idle: 4 }

const shown = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  let list = rows.value.filter((r) => {
    const s = stateOf(r)
    if (filter.value === 'running' && s.tone !== 'ok') return false
    if (filter.value === 'failed' && s.tone !== 'bad') return false
    if (filter.value === 'stopped' && (s.tone !== 'off' && s.tone !== 'warn')) return false
    if (filter.value === 'idle' && s.tone !== 'idle') return false
    if (!kw) return true
    return (
      r.name.toLowerCase().includes(kw) ||
      r.description.toLowerCase().includes(kw) ||
      r.enabled.toLowerCase().includes(kw)
    )
  })
  list = list.slice().sort((a, b) => {
    const ra = TONE_RANK[stateOf(a).tone]
    const rb = TONE_RANK[stateOf(b).tone]
    if (ra !== rb) return ra - rb
    return a.name.localeCompare(b.name)
  })
  return list
})

function hardRefresh() {
  loadedAt.value = 0
  void load()
}

/* ---------------- 动作 ---------------- */

async function run(r: ServiceRow, action: ServiceAction) {
  const sid = props.tab.sessionId
  if (!sid || acting.value) return

  const verb = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'
  // 停止/重启会打断正在连着的用户，必须确认；启动是"让它好起来"，不用拦一道
  if (action !== 'start') {
    try {
      await ElMessageBox.confirm(
        `${verb} ${r.name}？${r.description ? `\n${r.description}` : ''}\n\n${
          action === 'stop' ? '停止后依赖它的其他服务可能一起失效。' : '正在使用该服务的连接会短暂中断。'
        }`,
        `${verb}服务`,
        {
          type: 'warning',
          confirmButtonText: verb,
          cancelButtonText: '取消'
        }
      )
    } catch {
      return
    }
  }

  acting.value = r.name
  try {
    const msg = await window.api.services.action(sid, r.name, action)
    ElMessage.success(msg)
    // 等一秒再刷：Type=simple 的服务 systemctl 返回时进程刚 fork 出来，
    // 立刻查还可能是 activating，界面上会闪一下「启动中」再跳「运行中」。
    await new Promise((res) => setTimeout(res, action === 'start' ? 900 : 500))
    await load(true)
  } catch (err) {
    ElMessage.error(cleanError(err))
    // 失败也要刷：单元可能已经 failed 了，这个状态本身就是用户要看的
    await load(true)
  } finally {
    acting.value = ''
  }
}

const stamp = computed(() =>
  loadedAt.value ? new Date(loadedAt.value).toLocaleTimeString('zh-CN') : '—'
)
</script>

<template>
  <div class="svc">
    <!-- 没有 systemd：容器 / WSL / sysvinit 机器。说清楚原因，不留白屏 -->
    <div v-if="snap && !snap.systemd.available" class="state">
      <el-icon class="state-icon"><WarningFilled /></el-icon>
      <h3>这台机器没有 systemd</h3>
      <p>服务页依赖 <code>systemctl</code>。当前 1 号进程是 <code>{{ snap.systemd.init }}</code>。</p>
      <p class="raw mono">{{ snap.systemd.hint }}</p>
      <el-button text :icon="Refresh" @click="hardRefresh">再试一次</el-button>
    </div>

    <template v-else>
      <div class="svc-bar">
        <div class="fseg">
          <button
            v-for="f in FILTERS"
            :key="f.key"
            class="fbtn"
            :class="{ active: filter === f.key, bad: f.key === 'failed' && counts.failed > 0 }"
            @click="filter = f.key"
          >
            {{ f.label }}
            <span class="n">{{ counts[f.key] }}</span>
          </button>
        </div>

        <el-input v-model="keyword" size="small" placeholder="搜服务名 / 描述" clearable class="kw">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>

        <div class="grow" />
        <span class="stamp">采集于 {{ stamp }}</span>
        <el-button size="small" :icon="Refresh" :loading="loading" @click="hardRefresh">
          刷新
        </el-button>
      </div>

      <div v-if="error" class="state small">
        <span class="err">{{ error }}</span>
        <el-button size="small" text :icon="Refresh" @click="hardRefresh">重试</el-button>
      </div>

      <div v-else-if="!snap" class="state small"><div class="spinner" /></div>

      <div v-else class="stable">
        <div class="thead">
          <span class="c-name">服务</span>
          <span class="c-state">状态</span>
          <span class="c-boot">开机</span>
          <span class="c-desc">说明</span>
          <!-- 写「操作」而不是留空：按钮悬停才出现，表头不留字就没任何线索 -->
          <span class="c-act">操作</span>
        </div>
        <div class="tbody">
          <div v-for="r in shown" :key="r.name" class="row" :class="{ failed: r.active === 'failed' }">
            <span class="c-name mono truncate" :title="r.name">{{ r.name }}</span>
            <span class="c-state">
              <i class="dot" :class="stateOf(r).tone" />
              <span class="st" :class="stateOf(r).tone">{{ stateOf(r).text }}</span>
              <span class="sub mono truncate">{{ stateOf(r).sub }}</span>
            </span>
            <span class="c-boot">
              <span class="boot" :class="enabledTone(r)" :title="r.enabled || '—'">
                {{ enabledText(r) }}
              </span>
            </span>
            <span class="c-desc truncate" :title="r.description">{{ r.description || '—' }}</span>
            <span class="c-act">
              <span v-if="acting === r.name" class="mini-spin" />
              <template v-else>
                <!-- 日志对任何一行都给：没加载的服务也能翻它历史上跑过的记录，
                     真正的「没有日志」由面板自己说清楚，不在表格上提前拦掉 -->
                <button class="act log" title="查看启动日志" @click="openLog(r)">日志</button>
                <!-- 只有「已加载」的单元才给动作按钮：未加载的没有真实状态，
                     点下去反而会先被 start 拉起，和用户以为的「重启」不是一回事 -->
                <button
                  v-if="r.loaded && r.active !== 'active'"
                  class="act go"
                  title="启动"
                  @click="run(r, 'start')"
                >
                  启动
                </button>
                <button
                  v-if="r.loaded && r.active === 'active'"
                  class="act"
                  title="停止"
                  @click="run(r, 'stop')"
                >
                  停止
                </button>
                <button
                  v-if="r.loaded"
                  class="act"
                  title="重启"
                  @click="run(r, 'restart')"
                >
                  重启
                </button>
              </template>
            </span>
          </div>
          <div v-if="!shown.length" class="empty">
            {{ keyword ? `没有匹配「${keyword}」的服务` : '这一类下没有服务' }}
          </div>
        </div>
        <div class="sfoot">
          <span>显示 {{ shown.length }} / {{ rows.length }} 个服务</span>
          <span v-if="snap.stats.failed" class="fails">
            <i class="dot bad" />{{ snap.stats.failed }} 个失败
          </span>
          <span v-else class="mono">全部服务状态正常</span>
        </div>
      </div>
    </template>

    <!-- 日志浮层：从底部升起，盖住下半张表，关掉就回到表格原来的位置。
         key 挂在服务名上 —— 换一个服务必须整个重建（重新拉日志、游标归零），
         不然组件复用旧的 state，标题换了内容还是上一个服务的日志。 -->
    <ServiceLogPanel
      v-if="logRow"
      :key="logRow.name"
      :tab="tab"
      :row="logRow"
      @close="logRow = null"
    />
  </div>
</template>

<style scoped>
.svc {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-base);
}

/* ---------- 工具条 ---------- */
.svc-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}

/* 分段过滤：每一项都带数量，扫一眼就知道这台机器上有几个在跑 */
.fseg {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: var(--bg-panel-2);
  border: 1px solid var(--border-soft);
}

.fbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
}

.fbtn:hover {
  color: var(--text-1);
}

.fbtn.active {
  background: var(--bg-panel);
  color: var(--text-1);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}

.fbtn .n {
  font-size: 10px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.fbtn.active .n {
  color: var(--accent);
}

/* 有失败时那一项标红：这是用户打开本页最可能要处理的东西 */
.fbtn.bad .n {
  color: var(--danger);
  font-weight: 600;
}

.svc-bar .kw {
  width: 200px;
  flex: none;
}

.grow {
  flex: 1;
}

.stamp {
  flex: none;
  font-size: 10.5px;
  color: var(--text-3);
}

/* ---------- 表 ---------- */
.stable {
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
 * 列宽定死 + 描述列吃掉剩余。
 * 服务名最长会到 `NetworkManager-dispatcher.service`（34 字符），
 * 给 260px 才不至于每条都被截断；描述本来就是补充信息，让它缩。
 */
.thead,
.row {
  display: grid;
  grid-template-columns: minmax(0, 260px) 168px 86px minmax(0, 1fr) 158px;
  align-items: center;
  gap: 8px;
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

/* 表头的「操作」跟着按钮一起靠右，别浮在列中间 */
.thead .c-act {
  text-align: right;
}

.tbody {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.row {
  height: 28px;
  font-size: 11.5px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-soft) 55%, transparent);
  /* 两三百行一次画完会拖排版：滚出视口的行不参与布局绘制 */
  content-visibility: auto;
  contain-intrinsic-size: auto 28px;
}

.row:hover {
  background: var(--bg-panel-2);
}

/* 失败的行整条淡淡着红，滚过去也能一眼看见 */
.row.failed {
  background: color-mix(in srgb, var(--danger) 6%, transparent);
}

.c-name {
  color: var(--text-1);
}

.c-state {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}

.dot.ok {
  background: var(--success);
}

.dot.bad {
  background: var(--danger);
}

.dot.warn {
  background: var(--warning);
}

.dot.off,
.dot.idle {
  background: color-mix(in srgb, var(--text-3) 60%, transparent);
}

.st {
  flex: none;
  font-size: 11.5px;
  color: var(--text-2);
}

.st.ok {
  color: var(--success);
}

.st.bad {
  color: var(--danger);
  font-weight: 600;
}

.st.warn {
  color: var(--warning);
}

.st.off,
.st.idle {
  color: var(--text-3);
}

/* sub 是 systemd 的原始词（running / exited / dead），窄窗口下先牺牲它 */
.sub {
  min-width: 0;
  font-size: 10px;
  color: var(--text-3);
}

.c-boot {
  min-width: 0;
}

.boot {
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  line-height: 16px;
  color: var(--text-3);
  background: var(--bg-panel-2);
  white-space: nowrap;
}

.boot.on {
  color: var(--accent);
  background: var(--accent-soft);
}

.boot.masked {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
}

.c-desc {
  min-width: 0;
  font-size: 11px;
  color: var(--text-3);
}

/* 动作按钮默认不显示：一行三个按钮铺满，表格看着像按钮墙。
 * 只对行内的 .c-act 生效 —— 表头上那个「操作」标签得一直看得见。 */
.row .c-act {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
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

.act.go:hover {
  color: var(--success);
  border-color: var(--success);
}

/* 「日志」是只读动作，和启停不是一类：hover 用中性色，别让人以为点了会改状态 */
.act.log {
  color: var(--text-3);
}

.act.log:hover {
  color: var(--text-1);
  border-color: var(--text-3);
}

.mini-spin {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--text-1) 15%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

.empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}

.sfoot {
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

.fails {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--danger);
}

/* ---------- 状态 ---------- */
.state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--text-2);
}

.state.small {
  padding: 20px;
}

.state h3 {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--text-1);
}

.state p {
  margin: 0;
  max-width: 620px;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.7;
}

.state code {
  padding: 0 3px;
  border-radius: 3px;
  background: var(--bg-panel-2);
}

.state .raw {
  color: var(--text-3);
  word-break: break-all;
}

.state-icon {
  font-size: 26px;
  color: var(--text-3);
}

.err {
  color: var(--danger);
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

/* 窄窗口：先收起说明列，服务名和状态才是必看的 */
@media (max-width: 1080px) {
  .thead,
  .row {
    grid-template-columns: minmax(0, 1fr) 168px 86px 158px;
  }

  .c-desc {
    display: none;
  }
}
</style>
