<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  CaretRight,
  Coin,
  Cpu,
  FolderAdd,
  Link,
  Monitor,
  Odometer,
  Refresh,
  Setting,
  User,
  WarningFilled
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Tab } from '../stores/app'
import { cleanError } from '../stores/app'
import { usePaneBusy } from '../utils/pane-busy'
import type {
  LoginSession,
  NetBackend,
  NetInterface,
  SystemInfo,
  UnmountedDisk
} from '../../electron/types'

const props = defineProps<{ tab: Tab }>()

const info = ref<SystemInfo | null>(null)
const loading = ref(false)
usePaneBusy('system', loading)
const error = ref('')
/** 采不到东西（Windows 主机、极简容器没有 /proc）时给一句人话，而不是空白页 */
const unsupported = ref(false)
const loadedAt = ref(0)

async function load() {
  const sessionId = props.tab.sessionId
  if (!sessionId || loading.value) return
  loading.value = true
  error.value = ''
  try {
    const data = await window.api.ssh.sysinfo(sessionId)
    if (!data) {
      unsupported.value = true
      info.value = null
      return
    }
    unsupported.value = false
    info.value = data
    loadedAt.value = Date.now()
    // 未挂载磁盘跟系统档案一起刷：df 看不到它们，得单独问一次 lsblk
    void loadDisks()
  } catch (err) {
    error.value = cleanError(err)
  } finally {
    loading.value = false
  }
}

/**
 * 面板是 v-show 常驻的，所以不能靠 mounted 一次搞定：
 * 切到本页时才采，且只在数据过期（60 秒）时重采 —— 系统信息变化很慢，
 * 每次切页都跑一遍 exec 是白花一次网络往返。
 */
watch(
  () => props.tab.view,
  (view) => {
    if (view === 'system' && Date.now() - loadedAt.value > 60_000) void load()
  }
)

onMounted(() => {
  if (props.tab.view === 'system') void load()
})

/* ---------------- 展示辅助 ---------------- */
function gb(mb: number): string {
  if (!mb) return '—'
  const v = mb / 1024
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} GB`
}

function uptimeText(seconds: number): string {
  if (!seconds) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const mi = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${mi} 分`
  return `${mi} 分钟`
}

/** "2026-11-09 17:49:20 CST +0800" → 时区部分单独拎出来 */
const timezone = computed(() => {
  const parts = (info.value?.date ?? '').split(/\s+/)
  return parts.length >= 4 ? `${parts[2]} ${parts[3]}` : ''
})

/** 时间戳那行去掉尾部的时区，免得下面「时区」一行再重复一遍 */
const clockText = computed(() => {
  const parts = (info.value?.date ?? '').split(/\s+/)
  return parts.length >= 4 ? parts.slice(0, 2).join(' ') : info.value?.date || '—'
})

const virtText = computed(() => {
  const v = info.value?.virt ?? ''
  if (!v || v === 'none') return '物理机'
  const map: Record<string, string> = {
    kvm: 'KVM 虚拟机',
    vmware: 'VMware 虚拟机',
    oracle: 'VirtualBox 虚拟机',
    microsoft: 'Hyper-V 虚拟机',
    docker: 'Docker 容器',
    podman: 'Podman 容器',
    lxc: 'LXC 容器',
    'lxc-libvirt': 'LXC 容器',
    'systemd-nspawn': 'systemd-nspawn 容器',
    openvz: 'OpenVZ 容器',
    wsl: 'WSL'
  }
  return map[v] ?? v
})

function sev(percent: number): string {
  if (percent < 0) return ''
  if (percent >= 90) return 'danger'
  if (percent >= 75) return 'warn'
  return 'ok'
}

function sessionText(s: LoginSession): string {
  return s.from ? `${s.since} · ${s.from}` : s.since
}

/**
 * 网卡分两堆：一眼要看到的（物理网卡 / 业务网卡）和虚拟的（docker 网桥、veth 对、tun）。
 * 宿主机上后者动辄十几张，全平铺的话第一屏全是 vethXXXX，反而看不见真正的业务 IP。
 * 兜底：如果这台机器"全是虚拟网卡"，那就别折了，直接全展示。
 */
const VIRTUAL_IFACE = /^(veth|virbr|vnet|docker|br-|tun|tap|dummy|kube)/
const realNets = computed(() => (info.value?.nets ?? []).filter((n) => !VIRTUAL_IFACE.test(n.name)))
const primaryNets = computed(() => (realNets.value.length ? realNets.value : (info.value?.nets ?? [])))
const extraNets = computed(() =>
  realNets.value.length ? (info.value?.nets ?? []).filter((n) => VIRTUAL_IFACE.test(n.name)) : []
)
const showExtraNets = ref(false)

/* ================= 未挂载磁盘 ================= */

const unmounted = ref<UnmountedDisk[]>([])
const diskLoading = ref(false)
const diskError = ref('')

async function loadDisks(): Promise<void> {
  const sessionId = props.tab.sessionId
  if (!sessionId) return
  diskLoading.value = true
  diskError.value = ''
  try {
    unmounted.value = await window.api.syscfg.disks(sessionId)
  } catch (err) {
    // 老机器可能没有 lsblk：不当成错误页，给一句说明就够了
    unmounted.value = []
    diskError.value = cleanError(err)
  } finally {
    diskLoading.value = false
  }
}

const mountOpen = ref(false)
const mountBusy = ref(false)
const mountLog = ref('')
const mountTarget = ref<UnmountedDisk | null>(null)
const mountForm = reactive({ device: '', mountPoint: '', fstype: '', persist: true })

/** /dev/sdb1 + 卷标 → /mnt/data；没有卷标就用设备名，别给个空输入框 */
function suggestMountPoint(d: UnmountedDisk): string {
  const raw = d.label || d.path.replace(/^\/dev\//, '')
  const safe = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `/mnt/${safe || 'disk'}`
}

function openMount(d: UnmountedDisk): void {
  mountTarget.value = d
  mountForm.device = d.path
  mountForm.fstype = d.fstype
  mountForm.mountPoint = suggestMountPoint(d)
  mountForm.persist = true
  mountLog.value = ''
  mountOpen.value = true
}

async function doMount(): Promise<void> {
  const sessionId = props.tab.sessionId
  if (!sessionId || mountBusy.value) return
  const mountPoint = mountForm.mountPoint.trim()
  if (!mountPoint.startsWith('/')) {
    ElMessage.warning('挂载点要写成绝对路径，例如 /data')
    return
  }

  if (mountForm.persist) {
    try {
      await ElMessageBox.confirm(
        `把 ${mountForm.device} 挂到 ${mountPoint}，并在 /etc/fstab 追加一行（原文件会自动备份）。`,
        '挂载并开机自动挂载',
        { type: 'warning', confirmButtonText: '挂载', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
  }

  mountBusy.value = true
  try {
    const res = await window.api.syscfg.mount(sessionId, {
      device: mountForm.device,
      mountPoint,
      fstype: mountForm.fstype,
      persist: mountForm.persist
    })
    mountLog.value = res.log
    if (res.ok) {
      ElMessage.success(`${mountForm.device} 已挂到 ${mountPoint}`)
      mountOpen.value = false
      loadedAt.value = 0
      await Promise.all([load(), loadDisks()])
    } else {
      ElMessage.error('挂载失败，看弹窗里的输出')
    }
  } catch (err) {
    mountLog.value = cleanError(err)
    ElMessage.error('挂载失败')
  } finally {
    mountBusy.value = false
  }
}

/* ================= 网络配置 ================= */

const netOpen = ref(false)
const netLoading = ref(false)
const netBusy = ref(false)
const netLog = ref('')
const netCfg = ref<{ backend: NetBackend; hint: string } | null>(null)
const netForm = reactive({
  device: '',
  backend: 'none' as NetBackend,
  connName: '',
  method: 'manual' as 'dhcp' | 'manual',
  ip: '',
  prefix: '24',
  gateway: '',
  dns: ''
})

/** 打开时先用 sysinfo 里已经采到的地址垫底，探测回来再覆盖 —— 不然要等两次往返才有内容 */
async function openNet(n: NetInterface): Promise<void> {
  const sessionId = props.tab.sessionId
  if (!sessionId) return

  const first = n.ipv4[0] ?? ''
  const [ip, prefix] = first.split('/')
  netForm.device = n.name
  netForm.backend = 'none'
  netForm.connName = ''
  netForm.method = first ? 'manual' : 'dhcp'
  netForm.ip = ip ?? ''
  netForm.prefix = prefix || '24'
  netForm.gateway = info.value?.gateways[0] ?? ''
  netForm.dns = (info.value?.dns ?? []).join(', ')
  netCfg.value = null
  netLog.value = ''
  netOpen.value = true

  netLoading.value = true
  try {
    const cfg = await window.api.syscfg.netConfig(sessionId, n.name)
    netCfg.value = { backend: cfg.backend, hint: cfg.hint }
    netForm.backend = cfg.backend
    netForm.connName = cfg.connName
    if (cfg.addresses.length || cfg.method === 'dhcp') {
      netForm.method = cfg.method
      if (cfg.addresses[0]) {
        const [cfgIp, cfgPrefix] = cfg.addresses[0].split('/')
        netForm.ip = cfgIp ?? netForm.ip
        netForm.prefix = cfgPrefix || netForm.prefix
      }
      if (cfg.gateway) netForm.gateway = cfg.gateway
      if (cfg.dns.length) netForm.dns = cfg.dns.join(', ')
    }
  } catch (err) {
    netLog.value = cleanError(err)
  } finally {
    netLoading.value = false
  }
}

const backendText = computed(() => {
  const map: Record<NetBackend, string> = {
    nmcli: 'NetworkManager',
    ifcfg: 'ifcfg 文件',
    netplan: 'netplan',
    none: '未识别'
  }
  return map[netForm.backend] ?? netForm.backend
})

async function doApplyNet(): Promise<void> {
  const sessionId = props.tab.sessionId
  if (!sessionId || netBusy.value) return

  if (netForm.method === 'manual') {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(netForm.ip.trim())) {
      ElMessage.warning('IP 地址格式不对')
      return
    }
    const prefix = Number(netForm.prefix)
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) {
      ElMessage.warning('前缀长度要在 1-32 之间')
      return
    }
    if (netForm.gateway && !/^\d{1,3}(\.\d{1,3}){3}$/.test(netForm.gateway.trim())) {
      ElMessage.warning('网关格式不对')
      return
    }
  }

  const newAddr = netForm.method === 'manual' ? `${netForm.ip.trim()}/${netForm.prefix}` : 'DHCP'
  const oldAddr = info.value?.nets.find((n) => n.name === netForm.device)?.ipv4[0] ?? ''
  const changesIp = netForm.method === 'manual' && !!oldAddr && !oldAddr.startsWith(`${netForm.ip.trim()}/`)

  try {
    await ElMessageBox.confirm(
      changesIp
        ? `地址从 ${oldAddr} 改成 ${newAddr}：应用的一瞬间这条 SSH 就断了，需要用新地址重连。`
        : `将写入 ${newAddr}，并重启 ${netForm.device} 的网络。连接可能短暂中断。`,
      '应用网络配置',
      { type: 'warning', confirmButtonText: '保存并应用', cancelButtonText: '取消' }
    )
  } catch {
    return
  }

  netBusy.value = true
  try {
    const res = await window.api.syscfg.netApply(sessionId, {
      device: netForm.device,
      backend: netForm.backend,
      connName: netForm.connName,
      method: netForm.method,
      addresses: netForm.method === 'manual' ? [newAddr] : [],
      gateway: netForm.method === 'manual' ? netForm.gateway.trim() : '',
      dns: netForm.dns
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    })
    netLog.value = res.log
    if (res.ok) {
      ElMessage.success('已提交，1 秒后生效')
      if (changesIp) netOpen.value = false
      loadedAt.value = 0
    } else {
      ElMessage.error('保存失败，看弹窗里的输出')
    }
  } catch (err) {
    netLog.value = cleanError(err)
    ElMessage.error('保存失败')
  } finally {
    netBusy.value = false
  }
}
</script>

<template>
  <div class="sys">
    <div class="sys-bar">
      <span v-if="info" class="host mono truncate">{{ info.hostname }}</span>
      <span v-if="info" class="stamp">采集于 {{ new Date(loadedAt).toLocaleTimeString('zh-CN') }}</span>
      <div class="grow" />
      <el-button text size="small" :icon="Refresh" :loading="loading" @click="load">
        重新采集
      </el-button>
    </div>

    <div class="sys-body">
      <!-- 采不到：说清楚为什么，不留白屏 -->
      <div v-if="unsupported" class="state">
        <el-icon class="state-icon"><Monitor /></el-icon>
        <h3>该主机没有返回系统信息</h3>
        <p>系统信息取自 <code>/proc</code> 与 <code>iproute2</code>，Windows 主机或极简容器通常取不到。</p>
        <el-button text :icon="Refresh" @click="load">再试一次</el-button>
      </div>

      <div v-else-if="error" class="state">
        <h3>采集失败</h3>
        <p class="err mono">{{ error }}</p>
        <el-button text :icon="Refresh" @click="load">重试</el-button>
      </div>

      <div v-else-if="!info" class="state">
        <div class="spinner" />
        <p>正在读取系统信息…</p>
      </div>

      <template v-else>
        <div class="grid">
          <!-- 系统 -->
          <section class="block">
            <h4><el-icon><Monitor /></el-icon>操作系统</h4>
            <div class="kv"><span class="k">发行版</span><span class="v">{{ info.os || '—' }}</span></div>
            <div class="kv"><span class="k">内核</span><span class="v mono">{{ info.kernel || '—' }}</span></div>
            <div class="kv"><span class="k">架构</span><span class="v mono">{{ info.arch || '—' }}</span></div>
            <div class="kv"><span class="k">主机名</span><span class="v mono">{{ info.hostname || '—' }}</span></div>
            <div class="kv"><span class="k">虚拟化</span><span class="v">{{ virtText }}</span></div>
            <div class="kv">
              <span class="k">系统时间</span>
              <span class="v mono">{{ clockText }}</span>
            </div>
            <div v-if="timezone" class="kv">
              <span class="k">时区</span><span class="v mono">{{ timezone }}</span>
            </div>
          </section>

          <!-- 硬件与负载 -->
          <section class="block">
            <h4><el-icon><Cpu /></el-icon>硬件与负载</h4>
            <div class="kv"><span class="k">CPU</span><span class="v">{{ info.cpuModel || '—' }}</span></div>
            <div class="kv"><span class="k">核心数</span><span class="v mono">{{ info.cpuCores || '—' }} 核</span></div>
            <div class="kv"><span class="k">内存</span><span class="v mono">{{ gb(info.memTotal) }}</span></div>
            <div class="kv">
              <span class="k">Swap</span>
              <span class="v mono">{{ info.swapTotal ? gb(info.swapTotal) : '未启用' }}</span>
            </div>
            <div class="kv">
              <span class="k">负载</span>
              <span class="v mono">
                {{ info.load1.toFixed(2) }} / {{ info.load5.toFixed(2) }} / {{ info.load15.toFixed(2) }}
              </span>
            </div>
            <div class="kv"><span class="k">运行时长</span><span class="v">{{ uptimeText(info.uptime) }}</span></div>
            <div class="kv"><span class="k">进程数</span><span class="v mono">{{ info.processes }}</span></div>
          </section>
        </div>

        <!-- 磁盘挂载 -->
        <section class="block wide">
          <h4><el-icon><Coin /></el-icon>磁盘挂载<span class="badge">{{ info.disks.length }}</span></h4>
          <div class="tbl">
            <div class="tr th">
              <span class="c-mnt">挂载点</span>
              <span class="c-type">类型</span>
              <span class="c-num">容量</span>
              <span class="c-num">已用</span>
              <span class="c-num">可用</span>
              <span class="c-use">使用率</span>
              <span class="c-inode">inode</span>
            </div>
            <div v-for="d in info.disks" :key="d.mount + d.device" class="tr">
              <span class="c-mnt">
                <span class="mono mnt">{{ d.mount }}</span>
                <span class="dev mono truncate">{{ d.device }}</span>
              </span>
              <span class="c-type mono">{{ d.fstype }}</span>
              <span class="c-num mono">{{ d.size }}</span>
              <span class="c-num mono">{{ d.used }}</span>
              <span class="c-num mono">{{ d.avail }}</span>
              <span class="c-use">
                <span class="bar"><i :class="sev(d.usePercent)" :style="{ width: Math.min(100, d.usePercent) + '%' }" /></span>
                <span class="pct mono" :class="sev(d.usePercent)">{{ d.usePercent }}%</span>
              </span>
              <span class="c-inode">
                <span class="mono" :class="sev(d.inodePercent)">
                  {{ d.inodePercent >= 0 ? d.inodePercent + '%' : '—' }}
                </span>
                <span v-if="d.inodeTotal" class="inode-detail mono">
                  {{ d.inodeUsed }}/{{ d.inodeTotal }}
                </span>
              </span>
            </div>
          </div>

          <!-- 未挂载的磁盘：df 里根本不会出现，只能靠 lsblk 单独列 -->
          <div class="unmounted">
            <div class="um-head">
              <span class="um-title">未挂载的磁盘</span>
              <span class="badge">{{ unmounted.length }}</span>
              <div class="grow" />
              <el-button text size="small" :icon="Refresh" :loading="diskLoading" @click="loadDisks">
                重新扫描
              </el-button>
            </div>

            <div v-if="diskError" class="um-empty err">{{ diskError }}</div>
            <div v-else-if="diskLoading && !unmounted.length" class="um-empty">正在扫描块设备…</div>
            <div v-else-if="!unmounted.length" class="um-empty">
              没有未挂载的分区（所有块设备都已挂到目录上）
            </div>
            <div v-else class="um-list">
              <div v-for="d in unmounted" :key="d.path" class="um-row">
                <span class="um-dev mono">{{ d.path }}</span>
                <span class="um-size mono">{{ d.size }}</span>
                <span class="um-fs mono" :class="{ plain: !d.fstype }">
                  {{ d.isSwap ? 'swap' : d.fstype || '未格式化' }}
                </span>
                <span class="um-note truncate" :title="d.label || d.model">
                  {{ d.label || d.model || (d.type === 'lvm' ? 'LVM 逻辑卷' : '—') }}
                </span>
                <span class="um-act">
                  <span v-if="d.isSwap" class="um-tag">swap 不能挂目录</span>
                  <span v-else-if="!d.fstype" class="um-tag">先格式化</span>
                  <el-button
                    v-else
                    text
                    size="small"
                    type="primary"
                    :icon="FolderAdd"
                    @click="openMount(d)"
                  >
                    挂载
                  </el-button>
                </span>
              </div>
            </div>
          </div>
        </section>

        <div class="stack">
          <!-- 网络 -->
          <section class="block wide">
            <h4><el-icon><Link /></el-icon>网络<span class="badge">{{ primaryNets.length }}</span></h4>
            <div v-for="n in primaryNets" :key="n.name" class="iface">
              <div class="iface-head">
                <span class="ifname mono">{{ n.name }}</span>
                <span class="chip" :class="n.up ? 'up' : 'down'">{{ n.up ? 'UP' : 'DOWN' }}</span>
                <span v-if="n.mac" class="mac mono">{{ n.mac }}</span>
                <div class="grow" />
                <el-button text size="small" :icon="Setting" @click="openNet(n)">配置</el-button>
              </div>
              <div class="ips">
                <span v-for="ip in n.ipv4" :key="ip" class="ip mono">{{ ip }}</span>
                <span v-for="ip in n.ipv6" :key="ip" class="ip mono v6">{{ ip }}</span>
              </div>
            </div>

            <!-- 虚拟网卡（docker 网桥、veth 对）折叠起来，别把业务网卡挤下去 -->
            <div v-if="extraNets.length" class="extra">
              <button class="extra-toggle" @click="showExtraNets = !showExtraNets">
                <el-icon class="caret" :class="{ open: showExtraNets }"><CaretRight /></el-icon>
                另有 {{ extraNets.length }} 张虚拟网卡（网桥 / veth，docker 之类运行时产生）
              </button>
              <div v-show="showExtraNets" class="extra-list">
                <div v-for="n in extraNets" :key="n.name" class="extra-row">
                  <span class="ifname mono">{{ n.name }}</span>
                  <span class="chip" :class="n.up ? 'up' : 'down'">{{ n.up ? 'UP' : 'DOWN' }}</span>
                  <span class="extra-ips mono">
                    {{ [...n.ipv4, ...n.ipv6].join(' , ') || '无地址' }}
                  </span>
                  <span class="mac mono">{{ n.mac || '—' }}</span>
                </div>
              </div>
            </div>

            <div v-if="!primaryNets.length" class="empty">没有读取到网卡信息</div>

            <div class="kv net-kv">
              <span class="k">默认网关</span><span class="v mono">{{ info.gateways.join(' , ') || '—' }}</span>
            </div>
            <div class="kv net-kv">
              <span class="k">DNS</span><span class="v mono">{{ info.dns.join(' , ') || '—' }}</span>
            </div>
          </section>

          <!-- 登录会话 -->
          <section class="block wide">
            <h4><el-icon><User /></el-icon>登录会话<span class="badge">{{ info.sessions.length }}</span></h4>
            <div v-for="(s, i) in info.sessions" :key="i" class="session">
              <span class="s-user mono">{{ s.user }}</span>
              <span class="s-tty mono">{{ s.tty }}</span>
              <span class="s-time mono">{{ sessionText(s) }}</span>
            </div>
            <div v-if="!info.sessions.length" class="empty">当前没有交互登录</div>
            <p class="hint">
              <el-icon><Odometer /></el-icon>
              本页是一次性快照，按需点右上角「重新采集」；实时曲线请看「监控」页
            </p>
          </section>
        </div>
      </template>
    </div>

    <!-- 挂载磁盘 -->
    <el-dialog v-model="mountOpen" title="挂载磁盘" width="520px" :close-on-click-modal="false">
      <div class="dlg">
        <div class="dlg-row">
          <span class="dlg-k">设备</span>
          <span class="dlg-v mono">{{ mountForm.device }}</span>
          <span class="chip">{{ mountTarget?.size }}</span>
          <span class="chip">{{ mountForm.fstype }}</span>
        </div>

        <div class="dlg-row">
          <span class="dlg-k">挂载点</span>
          <el-input v-model="mountForm.mountPoint" class="mono" placeholder="/data" />
        </div>

        <el-checkbox v-model="mountForm.persist" class="dlg-check">
          写入 /etc/fstab，开机自动挂载
        </el-checkbox>

        <div class="dlg-tip">
          挂载点不存在会自动建目录，用的是 <code>defaults,nofail</code>：盘不在也能开机。
          挂之前会备份 /etc/fstab。目标目录里原有的文件不会删除，只是被这块盘暂时盖住。
        </div>

        <pre v-if="mountLog" class="dlg-log mono">{{ mountLog }}</pre>
      </div>
      <template #footer>
        <el-button @click="mountOpen = false">取消</el-button>
        <el-button type="primary" :loading="mountBusy" @click="doMount">挂载</el-button>
      </template>
    </el-dialog>

    <!-- 配置网络 -->
    <el-dialog v-model="netOpen" title="配置网络" width="520px" :close-on-click-modal="false">
      <div v-loading="netLoading" class="dlg">
        <div class="dlg-row">
          <span class="dlg-k">网卡</span>
          <span class="dlg-v mono">{{ netForm.device }}</span>
          <span class="chip">{{ backendText }}</span>
        </div>

        <div class="dlg-row">
          <span class="dlg-k">地址来源</span>
          <el-radio-group v-model="netForm.method" size="small">
            <el-radio-button value="manual">静态</el-radio-button>
            <el-radio-button value="dhcp">DHCP</el-radio-button>
          </el-radio-group>
        </div>

        <template v-if="netForm.method === 'manual'">
          <div class="dlg-row">
            <span class="dlg-k">IP 地址</span>
            <el-input v-model="netForm.ip" class="mono" placeholder="172.30.10.206" />
            <span class="dlg-slash mono">/</span>
            <el-input v-model="netForm.prefix" class="mono dlg-prefix" placeholder="22" />
          </div>
          <div class="dlg-row">
            <span class="dlg-k">网关</span>
            <el-input v-model="netForm.gateway" class="mono" placeholder="172.30.10.1" />
          </div>
        </template>

        <div class="dlg-row">
          <span class="dlg-k">DNS</span>
          <el-input v-model="netForm.dns" class="mono" placeholder="8.8.8.8, 1.1.1.1" />
        </div>

        <div v-if="netCfg?.hint" class="dlg-tip">{{ netCfg.hint }}</div>

        <div class="dlg-warn">
          <el-icon><WarningFilled /></el-icon>
          <span>
            保存后重启网络，连接会短暂中断；<b>改了 IP 的话这条 SSH 会直接断开</b>，
            需要用新地址重新连接。
          </span>
        </div>

        <pre v-if="netLog" class="dlg-log mono">{{ netLog }}</pre>
      </div>
      <template #footer>
        <el-button @click="netOpen = false">取消</el-button>
        <el-button
          type="primary"
          :loading="netBusy"
          :disabled="netForm.backend === 'none'"
          @click="doApplyNet"
        >
          保存并应用
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.sys {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-base);
}

.sys-bar {
  height: 32px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-panel);
}

.host {
  font-size: 12px;
  color: var(--text-1);
  font-weight: 500;
  max-width: 240px;
}

.stamp {
  font-size: 11px;
  color: var(--text-3);
}

.grow {
  flex: 1;
}

.sys-body {
  flex: 1;
  min-height: 0;
  /* 必须自己写 overflow：SideBar 里的 .scroll-y 是 scoped 的，别指望它跨界生效 */
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

/* 磁盘 / 网络 / 会话都是横跨整行的大块，依次往下排 */
.stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

@media (max-width: 1120px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.block {
  min-width: 0;
  padding: 10px 12px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
}

.block h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}

.block h4 .el-icon {
  font-size: var(--icon-sm);
  color: var(--accent);
}

.badge {
  margin-left: auto;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 500;
  line-height: 16px;
  color: var(--text-3);
  background: var(--bg-panel-2);
}

/* 键值行：标签定宽，值吃掉剩余宽度并允许换行（发行版名、CPU 型号都可能很长） */
.kv {
  display: flex;
  gap: 10px;
  padding: 3px 0;
  font-size: 12px;
  line-height: 1.5;
}

.kv .k {
  flex: none;
  width: 62px;
  color: var(--text-3);
}

.kv .v {
  flex: 1;
  min-width: 0;
  color: var(--text-1);
  word-break: break-word;
}

/* ---------- 磁盘表 ---------- */
.wide {
  padding-bottom: 10px;
}

.tbl {
  display: flex;
  flex-direction: column;
  font-size: 12px;
}

.tr {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 4px;
  border-radius: 5px;
}

.tr:not(.th):hover {
  background: var(--bg-hover);
}

.tr.th {
  padding-bottom: 4px;
  font-size: 10.5px;
  color: var(--text-3);
  border-bottom: 1px solid var(--border-soft);
}

.c-mnt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.c-mnt .mnt {
  color: var(--text-1);
}

/* 设备名太长（/dev/mapper/ubuntu--vg-ubuntu--lv），缩到第二行并截断 */
.c-mnt .dev {
  font-size: 10.5px;
  color: var(--text-3);
}

.c-type {
  width: 68px;
  flex: none;
  color: var(--text-2);
}

.c-num {
  width: 78px;
  flex: none;
  text-align: right;
  color: var(--text-2);
}

.c-use {
  width: 168px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  overflow: hidden;
  background: color-mix(in srgb, var(--text-1) 12%, transparent);
}

.bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
}

.bar i.warn {
  background: var(--warning);
}

.bar i.danger {
  background: var(--danger);
}

/* inode 单独一列：百分比下面挂已用/总数，inode 撑满比空间撑满隐蔽得多 */
.c-inode {
  width: 108px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.35;
  color: var(--text-2);
}

.inode-detail {
  font-size: 10px;
  color: var(--text-3);
}

.pct {
  width: 34px;
  text-align: right;
  color: var(--text-2);
}

.pct.warn,
.c-inode.warn {
  color: var(--warning);
}

.pct.danger,
.c-inode.danger {
  color: var(--danger);
}

/* ---------- 网络 ---------- */
.iface {
  padding: 6px 0;
  border-bottom: 1px dashed var(--border-soft);
}

.iface:last-of-type {
  border-bottom: none;
}

.iface-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ifname {
  font-size: 12px;
  color: var(--text-1);
}

.chip {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 9.5px;
  line-height: 15px;
  letter-spacing: 0.03em;
}

.chip.up {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 15%, transparent);
}

.chip.down {
  color: var(--text-3);
  background: var(--bg-panel-2);
}

.mac {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--text-3);
}

.ips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.ip {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11.5px;
  color: var(--text-1);
  background: var(--bg-panel-2);
  border: 1px solid var(--border-soft);
}

.ip.v6 {
  color: var(--text-2);
  font-size: 11px;
}

/* 折叠起来的虚拟网卡 */
.extra {
  margin-top: 4px;
}

.extra-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 0;
  border: none;
  background: none;
  font-size: 11px;
  color: var(--text-3);
  cursor: pointer;
}

.extra-toggle:hover {
  color: var(--accent);
}

.extra-toggle .caret {
  font-size: var(--icon-xs);
  transition: transform 0.15s;
}

.extra-toggle .caret.open {
  transform: rotate(90deg);
}

.extra-list {
  margin-top: 4px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--bg-base);
}

.extra-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 3px 0;
  font-size: 11.5px;
}

.extra-ips {
  flex: 1;
  min-width: 0;
  color: var(--text-2);
  font-size: 11px;
  word-break: break-all;
}

.extra-row .mac {
  margin-left: auto;
  flex: none;
}

.net-kv {
  padding-top: 6px;
}

/* ---------- 登录会话 ---------- */
.session {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
}

.s-user {
  color: var(--text-1);
  width: 64px;
  flex: none;
}

.s-tty {
  color: var(--accent);
  width: 48px;
  flex: none;
  font-size: 11px;
}

.s-time {
  flex: 1;
  min-width: 0;
  color: var(--text-3);
  font-size: 11px;
}

.empty {
  padding: 6px 0;
  font-size: 11.5px;
  color: var(--text-3);
}

.hint {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 10px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--border-soft);
  font-size: 10.5px;
  color: var(--text-3);
}

.hint .el-icon {
  font-size: var(--icon-xs);
}

/* ---------- 空/错/加载态 ---------- */
.state {
  margin: auto;
  padding: 24px;
  text-align: center;
  color: var(--text-2);
}

.state h3 {
  margin: 8px 0 6px;
  font-size: 13px;
  color: var(--text-1);
}

.state p {
  margin: 0 0 10px;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.7;
}

.state code {
  padding: 0 3px;
  border-radius: 3px;
  background: var(--bg-panel-2);
}

.state-icon {
  font-size: 26px;
  color: var(--text-3);
}

.err {
  color: var(--danger);
  word-break: break-all;
  max-width: 520px;
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

/* ---------- 未挂载的磁盘 ---------- */
.unmounted {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-soft);
}

.um-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
}

.um-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}

.um-empty {
  padding: 10px 2px;
  font-size: 11.5px;
  color: var(--text-3);
}

.um-empty.err {
  color: var(--danger);
  max-width: none;
}

.um-row {
  display: grid;
  /* 设备 / 容量 / 文件系统 三列定宽（都是短字符串），说明列吃掉剩下的空间 */
  grid-template-columns: minmax(90px, 130px) 64px 78px minmax(0, 1fr) 92px;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 2px;
  font-size: 12px;
  border-bottom: 1px dashed color-mix(in srgb, var(--border-soft) 55%, transparent);
}

.um-row:last-child {
  border-bottom: none;
}

.um-dev {
  color: var(--text-1);
}

.um-size {
  color: var(--text-2);
}

.um-fs {
  color: var(--text-2);
}

.um-fs.plain {
  color: var(--text-3);
  font-style: italic;
}

.um-note {
  min-width: 0;
  font-size: 11px;
  color: var(--text-3);
}

.um-act {
  display: flex;
  justify-content: flex-end;
}

.um-tag {
  font-size: 11px;
  color: var(--text-3);
}

/* ---------- 挂载 / 配网弹窗 ---------- */
.dlg {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 12px;
}

.dlg-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dlg-k {
  flex: none;
  width: 62px;
  font-size: 12px;
  color: var(--text-3);
}

.dlg-v {
  color: var(--text-1);
}

.dlg-slash {
  color: var(--text-3);
}

.dlg-prefix {
  width: 62px;
  flex: none;
}

.dlg-check {
  margin-top: -2px;
}

.dlg-tip {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-hover);
  color: var(--text-3);
  font-size: 11.5px;
  line-height: 1.7;
}

.dlg-tip code {
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text-1) 8%, transparent);
  font-family: var(--font-mono);
}

.dlg-warn {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  color: var(--danger);
  font-size: 11.5px;
  line-height: 1.65;
}

.dlg-warn .el-icon {
  flex: none;
  margin-top: 2px;
}

.dlg-log {
  margin: 0;
  max-height: 170px;
  overflow: auto;
  padding: 10px;
  border-radius: 6px;
  background: #0b0f15;
  color: #d5e2f0;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
