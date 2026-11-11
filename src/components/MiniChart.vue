<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    data: number[]
    color?: string
    /** 固定上限；不传则按当前数据最大值自适应 */
    max?: number
    /** 是否画面积填充 */
    area?: boolean
  }>(),
  { color: '#2dd4bf', area: true }
)

const uid = `g${Math.random().toString(36).slice(2, 8)}`

const normalized = computed(() => {
  const list = props.data
  if (!list.length) return [] as number[]
  const upper = props.max ?? Math.max(...list, 1)
  return list.map((v) => {
    const ratio = upper > 0 ? v / upper : 0
    return Math.max(0, Math.min(1, ratio))
  })
})

const linePath = computed(() => {
  const list = normalized.value
  if (list.length < 2) return ''
  const step = 100 / (list.length - 1)
  return list
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(36 - v * 33).toFixed(2)}`)
    .join(' ')
})

const areaPath = computed(() => {
  const path = linePath.value
  if (!path) return ''
  return `${path} L100,36 L0,36 Z`
})

const lastPoint = computed(() => {
  const list = normalized.value
  if (!list.length) return null
  const v = list[list.length - 1]
  const step = list.length > 1 ? 100 / (list.length - 1) : 100
  return { x: (list.length - 1) * step, y: 36 - v * 33 }
})
</script>

<template>
  <svg class="mini-chart" viewBox="0 0 100 36" preserveAspectRatio="none">
    <defs>
      <linearGradient :id="uid" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" :stop-color="color" stop-opacity="0.32" />
        <stop offset="100%" :stop-color="color" stop-opacity="0" />
      </linearGradient>
    </defs>

    <line v-for="y in [9, 18, 27]" :key="y" x1="0" :y1="y" x2="100" :y2="y" class="grid" />

    <path v-if="area && areaPath" :d="areaPath" :fill="`url(#${uid})`" />
    <path
      v-if="linePath"
      :d="linePath"
      fill="none"
      :stroke="color"
      stroke-width="1.4"
      stroke-linejoin="round"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
    <circle
      v-if="lastPoint"
      :cx="lastPoint.x"
      :cy="lastPoint.y"
      r="1.6"
      :fill="color"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>

<style scoped>
.mini-chart {
  width: 100%;
  height: 100%;
  display: block;
}

.grid {
  stroke: var(--grid-line);
  stroke-width: 0.4;
  vector-effect: non-scaling-stroke;
}
</style>
