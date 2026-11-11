<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Box,
  CircleCheck,
  Coin,
  Delete,
  Document,
  Files,
  Film,
  FolderOpened,
  Grid,
  InfoFilled,
  Loading,
  Refresh,
  RefreshRight,
  Search,
  SwitchButton,
  VideoPause
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Tab } from '../stores/app'
import { cleanError } from '../stores/app'
import type {
  DockerComposeProject,
  DockerContainer,
  DockerContainerDetail,
  DockerImage,
  DockerNetwork,
  DockerOverview,
  DockerVolume
} from '../../electron/types'

const props = defineProps<{ tab: Tab }>()

type TabKey = 'containers' | 'images' | 'networks' | 'volumes' | 'overview'

const subTabs: { key: TabKey; label: string; icon: typeof Box }[] = [
  { key: 'containers', label: '容器', icon: Box },
  { key: 'images', label: '镜像', icon: Files },
  { key: 'networks', label: '网络', icon: Grid },
  { key: 'volumes', label: '卷', icon: FolderOpened },
  { key: 'overview', label: '概览', icon: InfoFilled }
]

const sub = ref<TabKey>('containers')
const loading = ref(false)
const busy = ref('')
const error = ref('')
const loadedAt = ref(0)

const overview = ref<DockerOverview | null>(null)
const containers = ref<DockerContainer[]>([])
const images = ref<DockerImage[]>([])
const networks = ref<DockerNetwork[]>([])
const volumes = ref<DockerVolume[]>([])
const compose = ref<DockerComposeProject[]>([])

const keyword = ref('')
const onlyRunning = ref(false)
const autoRefresh = ref(true)
let timer: number | undefined

const sessionId = () => props.tab.sessionId

/* ---------------- 数据加载 ---------------- */

async function loadAll(quiet = false) {
  const sid = sessionId()
  if (!sid) return
  if (!quiet) loading.value = true
  error.value = ''
  try {
    overview.value = await window.api.docker.overview(sid)
    containers.value = await window.api.docker.containers(sid)
    loadedAt.value = Date.now()
    // 其余子页按需加载，别在打开页面时就跑 5 条命令
    await loadSub(sub.value, true)
  } catch (err) {
    error.value = cleanError(err)
    if (!quiet) ElMessage.error(error.value)
  } finally {
    loading.value = false
  }
}

async function loadSub(key: TabKey, force = false) {
  const sid = sessionId()
  if (!sid) return
  try {
    if (key === 'containers') {
      containers.value = await window.api.docker.containers(sid)
    } else if (key === 'images') {
      images.value = await window.api.docker.images(sid)
    } else if (key === 'networks') {
      networks.value = await window.api.docker.networks(sid)
    } else if (key === 'volumes') {
      volumes.value = await window.api.docker.volumes(sid)
    } else {
      overview.value = await window.api.docker.overview(sid)
      compose.value = await window.api.docker.compose(sid)
    }
    if (key !== 'overview') overview.value = await window.api.docker.overview(sid)
    if (force) loadedAt.value = Date.now()
  } catch (err) {
    error.value = cleanError(err)
  }
}

/** 轮询只刷当前子页，5 秒一次；概览的 df 计算较重，不跟着刷 */
function startTimer() {
  stopTimer()
  if (!autoRefresh.value) return
  timer = window.setInterval(() => {
    if (props.tab.view !== 'docker' || busy.value || logVisible.value) return
    if (sub.value === 'overview') return
    void loadSub(sub.value)
  }, 5000)
}

function stopTimer() {
  if (timer) {
    window.clearInterval(timer)
    timer = undefined
  }
}

watch(
  () => props.tab.view,
  (view) => {
    if (view === 'docker') {
      if (Date.now() - loadedAt.value > 5000) void loadAll(true)
      startTimer()
    } else {
      stopTimer()
    }
  }
)

watch(sub, (key) => {
  void loadSub(key, true)
})

watch(autoRefresh, () => {
  if (props.tab.view === 'docker') startTimer()
})

onMounted(() => {
  if (props.tab.view === 'docker') {
    void loadAll()
    startTimer()
  }
})

onBeforeUnmount(stopTimer)

/* ---------------- 展示辅助 ---------------- */

const runningCount = computed(() => containers.value.filter((c) => c.state === 'running').length)
const pausedCount = computed(() => containers.value.filter((c) => c.state === 'paused').length)
const stoppedCount = computed(
  () => containers.value.length - runningCount.value - pausedCount.value
)
const totalReclaimable = computed(() => {
  const rows = overview.value?.df ?? []
  let bytes = 0
  for (const row of rows) {
    const m = /([\d.]+)\s*([kKmMgGtT]?B)/.exec(row.reclaimable)
    if (!m) continue
    const n = Number(m[1])
    const unit = m[2].toUpperCase()
    const scale: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }
    bytes += n * (scale[unit] ?? 1)
  }
  if (!bytes) return ''
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${(bytes / 1e3).toFixed(0)} KB`
})

const filteredContainers = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return containers.value.filter((c) => {
    if (onlyRunning.value && c.state !== 'running') return false
    if (!kw) return true
    return (
      c.name.toLowerCase().includes(kw) ||
      c.image.toLowerCase().includes(kw) ||
      c.id.toLowerCase().includes(kw) ||
      c.ports.toLowerCase().includes(kw)
    )
  })
})

const filteredImages = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return images.value
  return images.value.filter(
    (i) =>
      `${i.repository}:${i.tag}`.toLowerCase().includes(kw) || i.id.toLowerCase().includes(kw)
  )
})

/** 状态 pill 的语义色：running 绿、paused 黄、exited 灰、dead 红、restarting 蓝 */
function stateClass(state: string): string {
  if (state === 'running') return 'on'
  if (state === 'paused') return 'warn'
  if (state === 'restarting') return 'info'
  if (state === 'dead') return 'bad'
  return 'off'
}

function stateText(state: string): string {
  const map: Record<string, string> = {
    running: '运行中',
    exited: '已退出',
    paused: '已暂停',
    created: '已创建',
    restarting: '重启中',
    dead: '已死亡',
    removing: '删除中'
  }
  return map[state] ?? state
}

function gb(bytes: number): string {
  if (!bytes) return '—'
  const v = bytes / 1024 ** 3
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} GB`
}

/** 端口列表太长时只显示前两个，其余折叠成 +N */
function shortPorts(ports: string): string {
  if (!ports) return '—'
  const items = ports
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (items.length <= 2) return items.join(', ')
  return `${items.slice(0, 2).join(', ')} +${items.length - 2}`
}

/* ---------------- 容器操作 ---------------- */

async function act(c: DockerContainer, action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'remove', force = false) {
  const sid = sessionId()
  if (!sid) return
  const label: Record<string, string> = {
    start: '启动',
    stop: '停止',
    restart: '重启',
    pause: '暂停',
    unpause: '恢复',
    remove: '删除'
  }
  if (action === 'remove') {
    try {
      await ElMessageBox.confirm(
        `确定删除容器「${c.name}」吗？${c.state === 'running' ? '容器正在运行，会强制停止并删除。' : ''}`,
        '删除容器',
        { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
    force = c.state === 'running'
  }
  busy.value = c.id
  try {
    await window.api.docker.containerAction(sid, c.id, action, force)
    ElMessage.success(`已${label[action]} ${c.name}`)
    await loadSub('containers')
    overview.value = await window.api.docker.overview(sid)
  } catch (err) {
    ElMessage.error(cleanError(err))
  } finally {
    busy.value = ''
  }
}

/** 进容器：把 docker exec 写进当前会话的终端，比在对话框里做伪 TTY 稳 */
function openShell(c: DockerContainer) {
  const sid = sessionId()
  if (!sid) return
  const name = c.name.replace(/[^\w.@-]/g, '')
  window.api.ssh.write(sid, `docker exec -it ${name} sh || docker exec -it ${name} bash\n`)
  props.tab.view = 'terminal'
}

/* ---------------- 日志 ---------------- */

const logVisible = ref(false)
const logText = ref('')
const logTarget = ref<DockerContainer | null>(null)
const logTail = ref(300)
const logLoading = ref(false)
const logFollow = ref(true)

async function openLogs(c: DockerContainer) {
  logTarget.value = c
  logVisible.value = true
  logText.value = ''
  await refreshLogs()
}

async function refreshLogs() {
  const sid = sessionId()
  if (!sid || !logTarget.value) return
  logLoading.value = true
  try {
    logText.value = await window.api.docker.containerLogs(sid, logTarget.value.id, logTail.value)
    if (logFollow.value) {
      // 等 DOM 更新后再滚到底，否则拿到的是旧高度
      requestAnimationFrame(() => {
        const el = document.querySelector('.log-body')
        if (el) el.scrollTop = el.scrollHeight
      })
    }
  } catch (err) {
    logText.value = `读取日志失败：${cleanError(err)}`
  } finally {
    logLoading.value = false
  }
}

/* ---------------- 详情 ---------------- */

const detailVisible = ref(false)
const detail = ref<DockerContainerDetail | null>(null)
const detailName = ref('')
const detailLoading = ref(false)

async function openDetail(c: DockerContainer) {
  const sid = sessionId()
  if (!sid) return
  detailName.value = c.name
  detail.value = null
  detailVisible.value = true
  detailLoading.value = true
  try {
    detail.value = await window.api.docker.containerDetail(sid, c.id)
  } catch (err) {
    ElMessage.error(cleanError(err))
  } finally {
    detailLoading.value = false
  }
}

/** inspect 是 unknown，这里按 docker inspect 的公开结构取字段，取不到就空 */
const inspect = computed<Record<string, any>>(() => (detail.value?.inspect as any) ?? {})

const inspectRows = computed(() => {
  const c = inspect.value
  if (!c || !c.Id) return []
  const cfg = c.Config ?? {}
  const state = c.State ?? {}
  const host = c.HostConfig ?? {}
  const nets = c.NetworkSettings?.Networks ?? {}
  const netList = Object.keys(nets).map((key) => {
    const ip = nets[key]?.IPAddress
    return ip ? `${key}: ${ip}` : key
  })
  const mounts = (c.Mounts ?? []).map(
    (m: any) => `${m.Source || m.Name} → ${m.Destination} (${m.Mode || m.Type})`
  )
  const ports = Object.keys(c.NetworkSettings?.Ports ?? {}).map((p) => p)
  const cmd = Array.isArray(cfg.Cmd) ? cfg.Cmd.join(' ') : ''
  const entry = Array.isArray(cfg.Entrypoint) ? cfg.Entrypoint.join(' ') : cfg.Entrypoint || ''
  const restart = host.RestartPolicy?.Name || 'no'
  const env = (cfg.Env ?? []) as string[]
  return [
    { k: '容器 ID', v: c.Id },
    { k: '镜像', v: cfg.Image || '' },
    { k: '启动命令', v: [entry, cmd].filter(Boolean).join(' ') || '—' },
    { k: '状态', v: `${state.Status || ''}${state.ExitCode ? `（退出码 ${state.ExitCode}）` : ''}` },
    { k: '创建时间', v: c.Created || '' },
    { k: '启动时间', v: state.StartedAt || '' },
    { k: '重启策略', v: restart },
    { k: '工作目录', v: cfg.WorkingDir || '—' },
    { k: '网络', v: netList.join('；') || '—' },
    { k: '端口', v: ports.join('；') || '—' },
    { k: '挂载', v: mounts.join('；') || '—' },
    { k: '日志驱动', v: host.LogConfig?.Type || '—' },
    { k: '日志路径', v: c.LogPath || '—' },
    { k: '宿主 PID', v: String(state.Pid ?? '—') },
    { k: '环境变量', v: env.length ? env.join('\n') : '—', block: true }
  ]
})

/* ---------------- 镜像 / 网络 / 卷 ---------------- */

const pullRef = ref('')
const pulling = ref(false)

async function pullImage() {
  const sid = sessionId()
  const ref0 = pullRef.value.trim()
  if (!sid || !ref0) return
  pulling.value = true
  try {
    const out = await window.api.docker.pullImage(sid, ref0)
    ElMessage.success(`拉取完成：${out.split('\n').pop() || ref0}`)
    pullRef.value = ''
    await loadSub('images', true)
    overview.value = await window.api.docker.overview(sid)
  } catch (err) {
    ElMessage.error(cleanError(err))
  } finally {
    pulling.value = false
  }
}

async function removeImage(img: DockerImage) {
  const sid = sessionId()
  if (!sid) return
  const ref0 = `${img.repository}:${img.tag}`
  try {
    await ElMessageBox.confirm(`确定删除镜像「${ref0}」吗？`, '删除镜像', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await window.api.docker.removeImage(sid, img.id, false)
    ElMessage.success(`已删除 ${ref0}`)
    await loadSub('images')
    overview.value = await window.api.docker.overview(sid)
  } catch (err) {
    // 被容器占用时 docker 会拒绝，提示里带 force 的后续动作
    try {
      await ElMessageBox.confirm(
        `${cleanError(err)}\n\n要强制删除吗？（-f，可能留下悬空层）`,
        '删除失败',
        { type: 'warning', confirmButtonText: '强制删除', cancelButtonText: '取消' }
      )
      await window.api.docker.removeImage(sid, img.id, true)
      ElMessage.success(`已强制删除 ${ref0}`)
      await loadSub('images')
    } catch (inner) {
      if (inner !== 'cancel' && inner !== 'close') ElMessage.error(cleanError(inner))
    }
  }
}

async function removeNetwork(net: DockerNetwork) {
  const sid = sessionId()
  if (!sid) return
  try {
    await ElMessageBox.confirm(`确定删除网络「${net.name}」吗？`, '删除网络', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await window.api.docker.removeNetwork(sid, net.id)
    ElMessage.success(`已删除网络 ${net.name}`)
    await loadSub('networks')
  } catch (err) {
    ElMessage.error(cleanError(err))
  }
}

async function removeVolume(vol: DockerVolume) {
  const sid = sessionId()
  if (!sid) return
  try {
    await ElMessageBox.confirm(
      `确定删除卷「${vol.name}」吗？卷里是容器的持久化数据，删除后不可恢复。`,
      '删除卷',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await window.api.docker.removeVolume(sid, vol.name)
    ElMessage.success(`已删除卷 ${vol.name}`)
    await loadSub('volumes')
  } catch (err) {
    ElMessage.error(cleanError(err))
  }
}

/** 清理：每一项都二次确认，卷清理单独标红说明会丢数据 */
async function prune(target: 'container' | 'image' | 'volume' | 'builder' | 'all') {
  const sid = sessionId()
  if (!sid) return
  const label: Record<string, string> = {
    container: '所有已停止的容器',
    image: '所有悬空镜像（无标签层）',
    volume: '所有未被使用的卷（数据会丢）',
    builder: '所有构建缓存',
    all: '已停止容器 + 悬空镜像 + 构建缓存'
  }
  try {
    await ElMessageBox.confirm(`确定清理${label[target]}吗？操作不可恢复。`, '清理资源', {
      type: target === 'volume' ? 'error' : 'warning',
      confirmButtonText: '清理',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  busy.value = `prune-${target}`
  try {
    const out = await window.api.docker.prune(sid, target)
    ElMessage.success(out.split('\n').pop() || '清理完成')
    await loadAll(true)
  } catch (err) {
    ElMessage.error(cleanError(err))
  } finally {
    busy.value = ''
  }
}

function reload() {
  keyword.value = ''
  void loadAll()
}
</script>

<template>
  <div class="dk">
    <!-- 顶部条：docker 版本 + 容器/镜像计数 + 刷新 -->
    <div class="dk-bar">
      <span class="engine mono" :title="overview?.info.serverVersion || ''">
        Docker {{ overview?.info.serverVersion || '—' }}
      </span>
      <span class="chip on"><i />{{ runningCount }} 运行</span>
      <span v-if="pausedCount" class="chip warn">{{ pausedCount }} 暂停</span>
      <span class="chip off">{{ stoppedCount }} 停止</span>
      <span class="chip">{{ images.length || overview?.info.images || 0 }} 镜像</span>
      <span v-if="totalReclaimable" class="chip reclaim">可回收 {{ totalReclaimable }}</span>
      <div class="grow" />
      <span v-if="loadedAt" class="stamp">{{ new Date(loadedAt).toLocaleTimeString('zh-CN') }}</span>
      <el-tooltip :content="autoRefresh ? '关闭自动刷新（5 秒）' : '开启自动刷新（5 秒）'" :show-after="400">
        <button class="icon-btn" :class="{ off: !autoRefresh }" @click="autoRefresh = !autoRefresh">
          <el-icon><Loading v-if="autoRefresh" /><VideoPause v-else /></el-icon>
        </button>
      </el-tooltip>
      <el-tooltip content="刷新" :show-after="400">
        <button class="icon-btn" :disabled="loading" @click="reload">
          <el-icon :class="{ spin: loading }"><Refresh /></el-icon>
        </button>
      </el-tooltip>
    </div>

    <!-- 子页签 -->
    <div class="dk-sub">
      <div class="seg">
        <button
          v-for="t in subTabs"
          :key="t.key"
          class="seg-btn"
          :class="{ active: sub === t.key }"
          @click="sub = t.key"
        >
          <el-icon><component :is="t.icon" /></el-icon>
          {{ t.label }}
        </button>
      </div>

      <template v-if="sub === 'containers' || sub === 'images'">
        <el-input
          v-model="keyword"
          class="kw"
          size="small"
          placeholder="搜索名称 / 镜像 / 端口"
          :prefix-icon="Search"
          clearable
        />
      </template>
      <el-checkbox v-if="sub === 'containers'" v-model="onlyRunning" size="small" class="only-on">
        只看运行中
      </el-checkbox>

      <div class="grow" />
      <template v-if="sub === 'images'">
        <el-input
          v-model="pullRef"
          class="pull"
          size="small"
          placeholder="拉取镜像，如 nginx:1.27"
          @keyup.enter="pullImage"
        />
        <el-button size="small" type="primary" plain :loading="pulling" @click="pullImage">
          拉取
        </el-button>
      </template>
    </div>

    <div v-if="error" class="err-bar">
      <el-icon><InfoFilled /></el-icon>
      <span class="mono">{{ error }}</span>
      <el-button text size="small" @click="reload">重试</el-button>
    </div>

    <div class="dk-body" :class="sub">
      <!-- 加载中 -->
      <div v-if="loading && !containers.length && !images.length" class="state">
        <div class="spinner" />
        <p>正在读取 Docker 信息…</p>
      </div>

      <!-- 容器 -->
      <template v-else-if="sub === 'containers'">
        <div class="thead">
          <span class="c-name">名称</span>
          <span class="c-image">镜像</span>
          <span class="c-state">状态</span>
          <span class="c-ports">端口</span>
          <span class="c-age">创建</span>
          <span class="c-act">操作</span>
        </div>
        <div v-if="!filteredContainers.length" class="empty">没有容器</div>
        <div v-for="c in filteredContainers" :key="c.id" class="row">
          <span class="c-name">
            <el-icon class="row-ic" :class="stateClass(c.state)"><Box /></el-icon>
            <span class="nm truncate" :title="c.name">{{ c.name }}</span>
            <span class="sid mono">{{ c.id.slice(0, 12) }}</span>
          </span>
          <span class="c-image mono truncate" :title="c.image">{{ c.image }}</span>
          <span class="c-state">
            <span class="pill" :class="stateClass(c.state)">{{ stateText(c.state) }}</span>
            <span class="status-text truncate" :title="c.status">{{ c.status }}</span>
          </span>
          <span class="c-ports mono truncate" :title="c.ports">{{ shortPorts(c.ports) }}</span>
          <span class="c-age">{{ c.runningFor || c.created }}</span>
          <span class="c-act">
            <el-tooltip v-if="c.state !== 'running'" content="启动" :show-after="400">
              <button class="op" data-op="start" :disabled="busy === c.id" @click="act(c, 'start')">
                <el-icon><CircleCheck /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip v-if="c.state === 'running'" content="停止" :show-after="400">
              <button class="op" data-op="stop" :disabled="busy === c.id" @click="act(c, 'stop')">
                <el-icon><SwitchButton /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip v-if="c.state === 'running'" content="重启" :show-after="400">
              <button class="op" data-op="restart" :disabled="busy === c.id" @click="act(c, 'restart')">
                <el-icon><RefreshRight /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip v-if="c.state === 'running'" content="暂停" :show-after="400">
              <button class="op" data-op="pause" :disabled="busy === c.id" @click="act(c, 'pause')">
                <el-icon><VideoPause /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip v-if="c.state === 'paused'" content="恢复" :show-after="400">
              <button class="op" data-op="unpause" :disabled="busy === c.id" @click="act(c, 'unpause')">
                <el-icon><CircleCheck /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip v-if="c.state === 'running'" content="进入容器终端" :show-after="400">
              <button class="op" data-op="shell" @click="openShell(c)">
                <el-icon><Film /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip content="日志" :show-after="400">
              <button class="op" data-op="logs" @click="openLogs(c)">
                <el-icon><Document /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip content="详情" :show-after="400">
              <button class="op" data-op="detail" @click="openDetail(c)">
                <el-icon><InfoFilled /></el-icon>
              </button>
            </el-tooltip>
            <el-tooltip content="删除" :show-after="400">
              <button class="op del" data-op="remove" :disabled="busy === c.id" @click="act(c, 'remove')">
                <el-icon><Delete /></el-icon>
              </button>
            </el-tooltip>
          </span>
        </div>
      </template>

      <!-- 镜像 -->
      <template v-else-if="sub === 'images'">
        <div class="thead">
          <span class="c-image-wide">仓库:标签</span>
          <span class="c-id">镜像 ID</span>
          <span class="c-size">大小</span>
          <span class="c-age">创建</span>
          <span class="c-act">操作</span>
        </div>
        <div v-if="!filteredImages.length" class="empty">没有镜像</div>
        <div v-for="img in filteredImages" :key="img.id + img.tag" class="row">
          <span class="c-image-wide">
            <el-icon class="row-ic"><Files /></el-icon>
            <span class="nm truncate" :title="`${img.repository}:${img.tag}`">
              {{ img.repository }}<span class="tag">:{{ img.tag }}</span>
            </span>
          </span>
          <span class="c-id mono truncate">{{ img.id }}</span>
          <span class="c-size">{{ img.size }}</span>
          <span class="c-age">{{ img.created }}</span>
          <span class="c-act">
            <el-tooltip content="删除镜像" :show-after="400">
              <button class="op del" @click="removeImage(img)"><el-icon><Delete /></el-icon></button>
            </el-tooltip>
          </span>
        </div>
      </template>

      <!-- 网络 -->
      <template v-else-if="sub === 'networks'">
        <div class="thead">
          <span class="c-name">名称</span>
          <span class="c-id">网络 ID</span>
          <span class="c-driver">驱动</span>
          <span class="c-scope">范围</span>
          <span class="c-act">操作</span>
        </div>
        <div v-if="!networks.length" class="empty">没有自定义网络</div>
        <div v-for="net in networks" :key="net.id" class="row">
          <span class="c-name">
            <el-icon class="row-ic"><Grid /></el-icon>
            <span class="nm truncate">{{ net.name }}</span>
            <span v-if="net.internal" class="tag">internal</span>
          </span>
          <span class="c-id mono truncate">{{ net.id.slice(0, 12) }}</span>
          <span class="c-driver">{{ net.driver }}</span>
          <span class="c-scope">{{ net.scope }}</span>
          <span class="c-act">
            <el-tooltip content="删除网络" :show-after="400">
              <button class="op del" @click="removeNetwork(net)"><el-icon><Delete /></el-icon></button>
            </el-tooltip>
          </span>
        </div>
      </template>

      <!-- 卷 -->
      <template v-else-if="sub === 'volumes'">
        <div class="thead">
          <span class="c-name">卷名</span>
          <span class="c-driver">驱动</span>
          <span class="c-scope">范围</span>
          <span class="c-act">操作</span>
        </div>
        <div v-if="!volumes.length" class="empty">没有卷</div>
        <div v-for="vol in volumes" :key="vol.name" class="row">
          <span class="c-name">
            <el-icon class="row-ic"><FolderOpened /></el-icon>
            <span class="nm truncate">{{ vol.name }}</span>
          </span>
          <span class="c-driver">{{ vol.driver }}</span>
          <span class="c-scope">{{ vol.scope }}</span>
          <span class="c-act">
            <el-tooltip content="删除卷" :show-after="400">
              <button class="op del" @click="removeVolume(vol)"><el-icon><Delete /></el-icon></button>
            </el-tooltip>
          </span>
        </div>
      </template>

      <!-- 概览 -->
      <template v-else>
        <div class="ov-grid">
          <section class="block">
            <h4><el-icon><InfoFilled /></el-icon>引擎</h4>
            <div class="kv"><span class="k">主机</span><span class="v mono">{{ overview?.info.name || '—' }}</span></div>
            <div class="kv"><span class="k">版本</span><span class="v mono">{{ overview?.info.serverVersion || '—' }}</span></div>
            <div class="kv"><span class="k">系统</span><span class="v">{{ overview?.info.operatingSystem || '—' }}</span></div>
            <div class="kv"><span class="k">内核</span><span class="v mono">{{ overview?.info.kernelVersion || '—' }}</span></div>
            <div class="kv"><span class="k">架构</span><span class="v mono">{{ overview?.info.architecture || '—' }}</span></div>
            <div class="kv"><span class="k">存储驱动</span><span class="v mono">{{ overview?.info.driver || '—' }}</span></div>
            <div class="kv"><span class="k">数据目录</span><span class="v mono truncate" :title="overview?.info.rootDir">{{ overview?.info.rootDir || '—' }}</span></div>
            <div class="kv"><span class="k">CPU / 内存</span><span class="v">{{ overview?.info.cpus || 0 }} 核 / {{ gb(overview?.info.memoryTotal || 0) }}</span></div>
            <div class="kv"><span class="k">Swarm</span><span class="v">{{ overview?.info.swarm ? '已启用' : '未启用' }}</span></div>
            <div v-if="overview?.info.warnings" class="kv">
              <span class="k">警告</span><span class="v warn-text">{{ overview.info.warnings }}</span>
            </div>
          </section>

          <section class="block">
            <h4><el-icon><Coin /></el-icon>资源占用与可回收</h4>
            <div class="df-head">
              <span class="df-type">类型</span>
              <span class="df-num">总数</span>
              <span class="df-num">活跃</span>
              <span class="df-size">大小</span>
              <span class="df-size">可回收</span>
            </div>
            <div v-for="row in overview?.df ?? []" :key="row.type" class="df-row">
              <span class="df-type">{{ row.type }}</span>
              <span class="df-num">{{ row.total }}</span>
              <span class="df-num">{{ row.active }}</span>
              <span class="df-size mono">{{ row.size }}</span>
              <span class="df-size mono reclaim">{{ row.reclaimable }}</span>
            </div>
            <div class="prune-row">
              <el-button size="small" :loading="busy === 'prune-container'" @click="prune('container')">
                清理停止的容器
              </el-button>
              <el-button size="small" :loading="busy === 'prune-image'" @click="prune('image')">
                清理悬空镜像
              </el-button>
              <el-button size="small" :loading="busy === 'prune-builder'" @click="prune('builder')">
                清理构建缓存
              </el-button>
              <el-button size="small" type="danger" plain :loading="busy === 'prune-volume'" @click="prune('volume')">
                清理未用卷
              </el-button>
              <el-button size="small" type="danger" :loading="busy === 'prune-all'" @click="prune('all')">
                一键清理
              </el-button>
            </div>
          </section>

          <section class="block wide">
            <h4><el-icon><Grid /></el-icon>Compose 项目</h4>
            <div v-if="!compose.length" class="empty small">
              没有检测到运行中的 compose 项目
            </div>
            <div v-for="p in compose" :key="p.name" class="compose-row">
              <span class="nm mono">{{ p.name }}</span>
              <span class="pill" :class="p.status.includes('running') ? 'on' : 'off'">{{ p.status }}</span>
              <span class="path mono truncate" :title="p.configFiles">{{ p.configFiles }}</span>
            </div>
          </section>
        </div>
      </template>
    </div>

    <!-- 日志 -->
    <el-dialog
      v-model="logVisible"
      :title="`容器日志 · ${logTarget?.name ?? ''}`"
      width="72%"
      class="log-dialog"
      @closed="logText = ''"
    >
      <div class="log-tools">
        <el-radio-group v-model="logTail" size="small" @change="refreshLogs">
          <el-radio-button :value="100">100 行</el-radio-button>
          <el-radio-button :value="300">300 行</el-radio-button>
          <el-radio-button :value="1000">1000 行</el-radio-button>
          <el-radio-button :value="3000">3000 行</el-radio-button>
        </el-radio-group>
        <el-checkbox v-model="logFollow" size="small">自动滚到底</el-checkbox>
        <div class="grow" />
        <el-button size="small" :icon="Refresh" :loading="logLoading" @click="refreshLogs">
          刷新
        </el-button>
      </div>
      <pre class="log-body mono">{{ logText || '（没有输出）' }}</pre>
    </el-dialog>

    <!-- 详情 -->
    <el-dialog v-model="detailVisible" :title="`容器详情 · ${detailName}`" width="68%" class="detail-dialog">
      <div v-if="detailLoading" class="state small"><div class="spinner" /></div>
      <template v-else-if="detail">
        <div v-if="detail.stats" class="stats-row">
          <div class="stat"><span class="k">CPU</span><b>{{ detail.stats.cpu }}</b></div>
          <div class="stat"><span class="k">内存</span><b>{{ detail.stats.mem }}</b><i>{{ detail.stats.memPerc }}</i></div>
          <div class="stat"><span class="k">网络 I/O</span><b>{{ detail.stats.netIO }}</b></div>
          <div class="stat"><span class="k">磁盘 I/O</span><b>{{ detail.stats.blockIO }}</b></div>
          <div class="stat"><span class="k">进程数</span><b>{{ detail.stats.pids }}</b></div>
        </div>
        <div class="detail-list">
          <div v-for="row in inspectRows" :key="row.k" class="kv" :class="{ block: row.block }">
            <span class="k">{{ row.k }}</span>
            <span class="v mono">{{ row.v }}</span>
          </div>
        </div>
        <details class="raw">
          <summary>原始 inspect JSON</summary>
          <pre class="mono">{{ detail.raw }}</pre>
        </details>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.dk {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-base);
}

.dk-bar {
  height: 32px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-panel);
}

.engine {
  font-size: 12px;
  color: var(--text-1);
  font-weight: 500;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--bg-base);
  border: 1px solid var(--border-soft);
  font-size: 11px;
  color: var(--text-2);
}

.chip i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}

.chip.on {
  color: var(--success, #34d399);
  border-color: color-mix(in srgb, var(--success, #34d399) 35%, transparent);
}

.chip.on i {
  background: var(--success, #34d399);
}

.chip.warn {
  color: #fbbf24;
}

.chip.reclaim {
  color: #fbbf24;
  border-color: rgba(251, 191, 36, 0.3);
}

.grow {
  flex: 1;
}

.stamp {
  font-size: 11px;
  color: var(--text-3);
}

.icon-btn {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  font-size: var(--icon-md);
}

.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.icon-btn.off {
  color: var(--text-3);
}

.spin {
  animation: rot 1s linear infinite;
}

@keyframes rot {
  to {
    transform: rotate(360deg);
  }
}

.dk-sub {
  height: 36px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-panel);
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
  height: 24px;
  padding: 0 9px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-3);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.12s;
}

.seg-btn .el-icon {
  font-size: var(--icon-xs);
}

.seg-btn:hover {
  color: var(--text-1);
  background: var(--bg-hover);
}

.seg-btn.active {
  color: #062520;
  background: linear-gradient(135deg, #5eead4, #2dd4bf);
  font-weight: 600;
}

.kw {
  width: 190px;
}

.only-on {
  margin-left: 2px;
}

.pull {
  width: 200px;
}

.err-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 11px;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--danger) 25%, transparent);
}

.dk-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 0 8px;
}

.thead,
.row {
  display: grid;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
}

/* 列宽模板写在容器上而不是行上：列表为空时表头也不会坍缩成竖排 */
.dk-body.containers .thead,
.dk-body.containers .row {
  grid-template-columns: 230px 230px 170px 190px 92px minmax(180px, 1fr);
}

.dk-body.images .thead,
.dk-body.images .row {
  grid-template-columns: minmax(240px, 1.4fr) 170px 90px 92px 120px;
}

.dk-body.networks .thead,
.dk-body.networks .row {
  grid-template-columns: minmax(200px, 1fr) 170px 110px 90px 100px;
}

.dk-body.volumes .thead,
.dk-body.volumes .row {
  grid-template-columns: minmax(240px, 1fr) 110px 90px 100px;
}

.thead {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 28px;
  font-size: 11px;
  color: var(--text-3);
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-soft);
}

.row {
  height: 36px;
  font-size: 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-soft) 55%, transparent);
}

.row:hover {
  background: var(--bg-hover);
}

/* 列宽由 .dk-body.<sub> 的模板统一控制，单元格只负责内部布局 */

.c-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.nm {
  color: var(--text-1);
  font-weight: 500;
}

.sid {
  font-size: 10px;
  color: var(--text-3);
  flex: none;
}

.row-ic {
  font-size: var(--icon-sm);
  color: var(--text-3);
  flex: none;
}

.row-ic.on {
  color: var(--success, #34d399);
}

.row-ic.warn {
  color: #fbbf24;
}

.row-ic.info {
  color: #60a5fa;
}

.row-ic.bad {
  color: var(--danger);
}

.pill {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10px;
  border: 1px solid transparent;
  flex: none;
}

.pill.on {
  color: var(--success, #34d399);
  background: color-mix(in srgb, var(--success, #34d399) 14%, transparent);
  border-color: color-mix(in srgb, var(--success, #34d399) 30%, transparent);
}

.pill.off {
  color: var(--text-3);
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
}

.pill.warn {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.12);
  border-color: rgba(251, 191, 36, 0.3);
}

.pill.info {
  color: #60a5fa;
  background: rgba(96, 165, 250, 0.12);
  border-color: rgba(96, 165, 250, 0.3);
}

.pill.bad {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  border-color: color-mix(in srgb, var(--danger) 30%, transparent);
}

.status-text {
  font-size: 10px;
  color: var(--text-3);
  max-width: 150px;
}

/* 容器表其余列 */

.row .c-state {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.row .c-age {
  color: var(--text-3);
  font-size: 11px;
}

.row .c-act {
  display: flex;
  align-items: center;
  gap: 2px;
  justify-content: flex-end;
}

.op {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  font-size: var(--icon-sm);
}

.op:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-1);
}

.op:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.op.del:hover {
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
}

/* 镜像表其余列 */

.row .c-image-wide {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.row .c-id {
  color: var(--text-3);
  font-size: 11px;
}

.row .c-size,
.row .c-driver {
  color: var(--text-2);
}

.row .c-scope {
  color: var(--text-3);
}

.tag {
  color: var(--text-3);
  font-size: 11px;
}

.empty {
  padding: 28px 12px;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
}

.empty.small {
  padding: 10px 2px;
  text-align: left;
}

.state {
  display: grid;
  place-items: center;
  gap: 10px;
  padding: 48px 12px;
  color: var(--text-3);
  font-size: 12px;
}

.spinner {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid rgba(45, 212, 191, 0.18);
  border-top-color: var(--accent);
  animation: rot 0.8s linear infinite;
}

/* 概览 */
.ov-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 12px;
}

@media (max-width: 1120px) {
  .ov-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.block {
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 12px 14px;
  min-width: 0;
}

.block.wide {
  grid-column: 1 / -1;
}

.block h4 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}

.block h4 .el-icon {
  font-size: var(--icon-sm);
  color: var(--accent);
}

.kv {
  display: flex;
  gap: 12px;
  padding: 3px 0;
  font-size: 12px;
  border-bottom: 1px dashed color-mix(in srgb, var(--border-soft) 60%, transparent);
}

.kv:last-child {
  border-bottom: none;
}

.kv .k {
  width: 88px;
  flex: none;
  color: var(--text-3);
}

.kv .v {
  flex: 1;
  min-width: 0;
  color: var(--text-1);
  word-break: break-word;
}

.kv.block {
  flex-direction: column;
  gap: 4px;
  background: transparent;
  border: none;
  padding: 6px 0 0;
}

.kv.block .v {
  white-space: pre-wrap;
  font-size: 11px;
  color: var(--text-2);
}

.warn-text {
  color: #fbbf24 !important;
}

.df-head,
.df-row {
  display: grid;
  grid-template-columns: 1fr 60px 60px 90px 100px;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
}

.df-head {
  color: var(--text-3);
  font-size: 11px;
  border-bottom: 1px solid var(--border-soft);
}

.df-row {
  border-bottom: 1px dashed color-mix(in srgb, var(--border-soft) 60%, transparent);
}

.df-type {
  color: var(--text-1);
}

.df-num,
.df-size {
  text-align: right;
  color: var(--text-2);
}

.reclaim {
  color: #fbbf24;
}

.prune-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.compose-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 0;
  font-size: 12px;
  border-bottom: 1px dashed color-mix(in srgb, var(--border-soft) 60%, transparent);
}

.compose-row .path {
  flex: 1;
  min-width: 0;
  color: var(--text-3);
  font-size: 11px;
}

/* 日志 / 详情 */
.log-tools {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.log-body {
  margin: 0;
  height: 52vh;
  overflow: auto;
  padding: 12px;
  border-radius: 8px;
  background: #0b0f15;
  color: #d5e2f0;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
}

.stats-row {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.stat {
  background: var(--bg-base);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.stat .k {
  font-size: 11px;
  color: var(--text-3);
}

.stat b {
  font-size: 13px;
  color: var(--text-1);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stat i {
  font-style: normal;
  font-size: 10px;
  color: var(--text-3);
}

.detail-list {
  max-height: 44vh;
  overflow-y: auto;
}

.raw {
  margin-top: 10px;
}

.raw summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-3);
}

.raw pre {
  margin: 8px 0 0;
  max-height: 30vh;
  overflow: auto;
  padding: 10px;
  border-radius: 8px;
  background: var(--bg-base);
  font-size: 11px;
  color: var(--text-2);
}
</style>
