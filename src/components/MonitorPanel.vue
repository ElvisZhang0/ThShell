<script setup lang="ts">
import { computed } from 'vue'
import { Cpu, Odometer, Coin, Connection } from '@element-plus/icons-vue'
import { useAppStore } from '../stores/app'
import type { Tab } from '../stores/app'
import MiniChart from './MiniChart.vue'

const props = defineProps<{ tab: Tab }>()
const store = useAppStore()

const history = computed(() => store.metrics[props.tab.sessionId] ?? [])
const latest = computed(() => history.value[history.value.length - 1])

const cpuSeries = computed(() => history.value.map((m) => m.cpu))
const memSeries = computed(() =>
  history.value.map((m) => (m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0))
)
const rxSeries = computed(() => history.value.map((m) => m.netRx))
const txSeries = computed(() => history.value.map((m) => m.netTx))

const memPercent = computed(() => {
  const m = latest.value
  if (!m || !m.memTotal) return 0
  return (m.memUsed / m.memTotal) * 100
})

const diskPercent = computed(() => {
  const m = latest.value
  if (!m || !m.diskTotal) return 0
  return (m.diskUsed / m.diskTotal) * 100
})

const netMax = computed(() => {
  const max = Math.max(...rxSeries.value, ...txSeries.value, 32)
  return max * 1.15
})

const CIRC = 2 * Math.PI * 16

function dash(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct))
  return `${(clamped / 100) * CIRC} ${CIRC}`
}

function toGb(mb: number): string {
  if (!mb) return '0'
  const gb = mb / 1024
  return gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)
}

function formatRate(kb: number): string {
  if (!kb) return '0 KB/s'
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB/s`
  return `${kb.toFixed(1)} KB/s`
}

function formatUptime(seconds: number): string {
  if (!seconds) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const mi = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${mi} 分`
  return `${mi} 分钟`
}

function severity(pct: number): string {
  if (pct >= 90) return 'danger'
  if (pct >= 70) return 'warn'
  return 'ok'
}
</script>

<template>
  <div class="monitor">
    <template v-if="latest">
      <div class="cards">
        <!-- CPU -->
        <div class="card">
          <div class="ring-wrap">
            <svg viewBox="0 0 40 40" class="ring">
              <circle cx="20" cy="20" r="16" class="track" />
              <circle
                cx="20"
                cy="20"
                r="16"
                class="bar"
                stroke="#2dd4bf"
                :stroke-dasharray="dash(latest.cpu)"
                transform="rotate(-90 20 20)"
              />
            </svg>
            <div class="ring-text">
              <span class="value">{{ latest.cpu.toFixed(0) }}</span>
              <span class="unit">%</span>
            </div>
          </div>
          <div class="card-info">
            <div class="card-title">
              <el-icon><Cpu /></el-icon>CPU
            </div>
            <div class="card-sub">负载 {{ latest.load1.toFixed(2) }}</div>
          </div>
        </div>

        <!-- 内存 -->
        <div class="card">
          <div class="ring-wrap">
            <svg viewBox="0 0 40 40" class="ring">
              <circle cx="20" cy="20" r="16" class="track" />
              <circle
                cx="20"
                cy="20"
                r="16"
                class="bar"
                stroke="#a78bfa"
                :stroke-dasharray="dash(memPercent)"
                transform="rotate(-90 20 20)"
              />
            </svg>
            <div class="ring-text">
              <span class="value">{{ memPercent.toFixed(0) }}</span>
              <span class="unit">%</span>
            </div>
          </div>
          <div class="card-info">
            <div class="card-title">
              <el-icon><Coin /></el-icon>内存
            </div>
            <div class="card-sub">
              {{ toGb(latest.memUsed) }} / {{ toGb(latest.memTotal) }} GB
            </div>
          </div>
        </div>

        <!-- 磁盘 -->
        <div class="card">
          <div class="ring-wrap">
            <svg viewBox="0 0 40 40" class="ring">
              <circle cx="20" cy="20" r="16" class="track" />
              <circle
                cx="20"
                cy="20"
                r="16"
                class="bar"
                stroke="#fbbf24"
                :stroke-dasharray="dash(diskPercent)"
                transform="rotate(-90 20 20)"
              />
            </svg>
            <div class="ring-text">
              <span class="value">{{ diskPercent.toFixed(0) }}</span>
              <span class="unit">%</span>
            </div>
          </div>
          <div class="card-info">
            <div class="card-title">
              <el-icon><Odometer /></el-icon>根分区
            </div>
            <div class="card-sub">
              {{ toGb(latest.diskUsed) }} / {{ toGb(latest.diskTotal) }} GB
            </div>
          </div>
        </div>

        <!-- 网络 -->
        <div class="card wide">
          <div class="net-body">
            <div class="net-row">
              <span class="net-label down">↓ 下行</span>
              <span class="net-value mono">{{ formatRate(latest.netRx) }}</span>
            </div>
            <div class="net-row">
              <span class="net-label up">↑ 上行</span>
              <span class="net-value mono">{{ formatRate(latest.netTx) }}</span>
            </div>
          </div>
          <div class="card-info">
            <div class="card-title">
              <el-icon><Connection /></el-icon>网络
            </div>
            <div class="card-sub">接口累计速率</div>
          </div>
        </div>
      </div>

      <div class="charts">
        <div class="chart-box">
          <div class="chart-head">
            <span>CPU 使用率</span>
            <span class="chart-val mono">{{ latest.cpu.toFixed(1) }}%</span>
          </div>
          <MiniChart :data="cpuSeries" color="#2dd4bf" :max="100" />
        </div>

        <div class="chart-box">
          <div class="chart-head">
            <span>内存使用率</span>
            <span class="chart-val mono">{{ memPercent.toFixed(1) }}%</span>
          </div>
          <MiniChart :data="memSeries" color="#a78bfa" :max="100" />
        </div>

        <div class="chart-box">
          <div class="chart-head">
            <span>网络吞吐</span>
            <span class="chart-val mono">
              <span class="down">↓{{ formatRate(latest.netRx) }}</span>
              <span class="up">↑{{ formatRate(latest.netTx) }}</span>
            </span>
          </div>
          <div class="dual-chart">
            <MiniChart :data="rxSeries" color="#38bdf8" :max="netMax" :area="false" />
            <MiniChart :data="txSeries" color="#fb923c" :max="netMax" :area="false" />
          </div>
        </div>
      </div>

      <div class="meta-bar">
        <div class="meta-item">
          <span class="meta-k">运行时长</span>
          <span class="meta-v">{{ formatUptime(latest.uptime) }}</span>
        </div>
        <div class="meta-item">
          <span class="meta-k">进程数</span>
          <span class="meta-v">{{ latest.processes }}</span>
        </div>
        <div class="meta-item">
          <span class="meta-k">负载 1/5/15</span>
          <span class="meta-v mono">
            {{ latest.load1.toFixed(2) }} / {{ latest.load5.toFixed(2) }} /
            {{ latest.load15.toFixed(2) }}
          </span>
        </div>
        <div class="meta-item">
          <span class="meta-k">Swap</span>
          <span class="meta-v">
            {{ latest.swapTotal ? toGb(latest.swapUsed) + ' / ' + toGb(latest.swapTotal) + ' GB' : '未启用' }}
          </span>
        </div>
        <div class="meta-item right">
          <span class="meta-k">采样</span>
          <span class="meta-v">{{ history.length }} / 60</span>
        </div>
      </div>
    </template>

    <div v-else class="waiting">
      <div class="spinner" />
      <p>正在采集服务器指标…</p>
      <p class="hint">若长时间无数据，可能是该主机不是 Linux，或未开放 /proc 读取</p>
    </div>
  </div>
</template>

<style scoped>
.monitor {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  overflow-y: auto;
}

.cards {
  display: grid;
  /* 关键：1fr 的最小值是 min-content，卡片里全是 nowrap 文字，
     窄窗口下四列撑不开就会整体溢出、最后一张被窗口切掉。
     minmax(0, 1fr) 才允许真正压缩；再窄就退成两列，别硬挤。 */
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  flex: none;
}

/* 窗口最小宽度是 1080（内容区约 1064），那时四列每张只剩 ~187px，
   长数值（如 1234.5 / 2048.0 GB）就会贴边。窄到这个程度就退成 2×2。 */
@media (max-width: 1120px) {
  .cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.card {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
}

.ring-wrap {
  position: relative;
  width: 54px;
  height: 54px;
  flex: none;
}

.ring {
  width: 100%;
  height: 100%;
  transform: rotate(0deg);
}

.ring .track {
  fill: none;
  /* 原来的 white 7% 在深色面板上几乎看不见，环看着像没画出来；
     跟着正文色取 13% 深浅主题都能看出"这是个环、进度占多少" */
  stroke: color-mix(in srgb, var(--text-1) 13%, transparent);
  stroke-width: 3.4;
}

.ring .bar {
  fill: none;
  stroke-width: 3.4;
  stroke-linecap: round;
  transition: stroke-dasharray 0.5s ease;
}

.ring-text {
  position: absolute;
  inset: 0;
  display: flex;
  /* 原来用 baseline，文字被顶到圆环上沿外面去；数字要居中才像"环里的百分比" */
  align-items: center;
  justify-content: center;
  gap: 1px;
}

.ring-text .value {
  font-size: 15px;
  font-weight: 650;
  color: var(--text-1);
  font-family: var(--font-mono);
}

.ring-text .unit {
  font-size: 10px;
  color: var(--text-3);
}

.card-info {
  min-width: 0;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--text-2);
  margin-bottom: 3px;
}

/* 不设尺寸会跟着 1em 走 = 11.5px，字形只有 8px 多，缩在这个宽度里像噪点 */
.card-title .el-icon {
  font-size: var(--icon-xs);
}

.card-sub {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card.wide .net-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 96px;
}

.net-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.net-label {
  font-size: 10px;
  color: var(--text-3);
}

.net-label.down {
  color: #38bdf8;
}

.net-label.up {
  color: #fb923c;
}

.net-value {
  font-size: 12px;
  color: var(--text-1);
}

.charts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  flex: 1;
  min-height: 220px;
}

.chart-box {
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  min-height: 0;
}

.chart-box:nth-child(3) {
  grid-column: span 2;
}

.chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--text-2);
  margin-bottom: 6px;
  flex: none;
}

.chart-val {
  font-size: 11px;
  color: var(--text-3);
  display: flex;
  gap: 8px;
}

.chart-val .down {
  color: #38bdf8;
}

.chart-val .up {
  color: #fb923c;
}

.chart-box :deep(.mini-chart) {
  flex: 1;
  min-height: 60px;
}

.dual-chart {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.dual-chart :deep(.mini-chart) {
  flex: 1;
  min-height: 34px;
}

.meta-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 9px 14px;
  border-radius: var(--radius);
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
}

.meta-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.meta-item.right {
  margin-left: auto;
}

.meta-k {
  font-size: 10.5px;
  color: var(--text-3);
}

.meta-v {
  font-size: 11.5px;
  color: var(--text-2);
}

.waiting {
  margin: auto;
  text-align: center;
  color: var(--text-3);
}

.waiting p {
  font-size: 12px;
  margin: 12px 0 0;
}

.waiting .hint {
  font-size: 11px;
  color: var(--text-3);
  opacity: 0.7;
}

.spinner {
  width: 26px;
  height: 26px;
  margin: 0 auto;
  border-radius: 50%;
  border: 2px solid rgba(45, 212, 191, 0.18);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
