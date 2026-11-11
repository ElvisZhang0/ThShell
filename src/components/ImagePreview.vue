<script setup lang="ts">
/**
 * 图片预览（只读）。
 *
 * 为什么不用 <img src="file:///…"> 直接指过去：
 * 远程图片根本没有本地路径；而且 file:// 在渲染进程里被 CSP 挡着。
 * 主进程读过字节给 base64，两边（本地 / 远程）走同一条路。
 *
 * 为什么不做「拖拽平移」：浏览器自带的滚动容器已经能拖（按住滚轮 / 触控板），
 * 自己实现一套还要接管 pointer 事件、算边界、处理惯性 —— 收益不值这个复杂度。
 * 缩放给了三档：适应窗口（默认，加载时算一次）、1:1、±。Ctrl/⌘ + 滚轮也能缩放。
 *
 * SVG 放进 <img> 是安全的：img 上下文里脚本不会执行，比内联进 DOM 少一层顾虑。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Loading, RefreshLeft, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import { imageMime } from '../utils/file-kind'
import { formatSize } from '../utils/transfer-format'

const props = defineProps<{
  /** 原始字节的 base64 */
  base64: string
  filename: string
  size: number
}>()

const src = computed(() => `data:${imageMime(props.filename)};base64,${props.base64}`)
const loading = ref(true)
const failed = ref('')
const natural = ref({ w: 0, h: 0 })
/** 1 = 图片原始像素大小 */
const scale = ref(1)
const scrollEl = ref<HTMLElement | null>(null)
const imgEl = ref<HTMLImageElement | null>(null)

const MIN_SCALE = 0.05
const MAX_SCALE = 16

const shownW = computed(() => Math.max(1, Math.round(natural.value.w * scale.value)))
const shownH = computed(() => Math.max(1, Math.round(natural.value.h * scale.value)))
const percent = computed(() => Math.round(scale.value * 100))

function clamp(v: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
}

/** 用户自己调过缩放之后就不再自动 fit —— 窗口一变就把 110% 弹回"适应窗口"很烦 */
const userZoomed = ref(false)

/** 适应窗口：整张图放进可视区，但不放大超过 4 倍（16px 的图标放大 20 倍只剩马赛克） */
function fit(): void {
  userZoomed.value = false
  const box = scrollEl.value
  if (!box || !natural.value.w || !natural.value.h) return
  const pad = 24
  const next = Math.min(
    (box.clientWidth - pad) / natural.value.w,
    (box.clientHeight - pad) / natural.value.h,
    4
  )
  scale.value = clamp(next)
}

/** 按原始像素 1:1 */
function setActual(): void {
  userZoomed.value = true
  scale.value = 1
}

function zoomBy(delta: number): void {
  userZoomed.value = true
  scale.value = clamp(Math.round((scale.value + delta) * 100) / 100)
}

function onWheel(e: WheelEvent): void {
  // 只有按住 Ctrl/⌘ 才缩放：普通滚轮先留给人滚着看（缩放抢过来会让人滚不动图）
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  zoomBy(e.deltaY < 0 ? 0.1 : -0.1)
}

function onLoad(): void {
  const img = imgEl.value
  loading.value = false
  if (!img) return
  natural.value = { w: img.naturalWidth, h: img.naturalHeight }
  // 解出来 0×0 基本就是文件坏了（截断的 PNG 会这样，img 却照样触发 load）
  if (!img.naturalWidth || !img.naturalHeight) {
    failed.value = '图片尺寸为 0，文件可能已损坏或被截断'
    return
  }
  void nextTick(fit)
}

function onError(): void {
  loading.value = false
  failed.value = '这个图片解不开，文件可能损坏，或是浏览器不支持的格式'
}

/** 窗口大小变了要重新适应，否则"适应窗口"只对打开那一刻的窗口尺寸成立 */
let resizeObserver: ResizeObserver | null = null
watch(scrollEl, (el) => {
  resizeObserver?.disconnect()
  if (!el) return
  resizeObserver = new ResizeObserver(() => {
    if (loading.value || failed.value) return
    // 手动缩放过就别抢方向盘：最小化→展开、最大化都会改容器尺寸，
    // 每次都重新 fit 会让用户刚调好的比例白调
    if (userZoomed.value) return
    fit()
  })
  resizeObserver.observe(el)
})

onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <div class="img">
    <div class="img-bar">
      <el-icon v-if="loading" class="is-loading"><Loading /></el-icon>
      <span class="img-name mono truncate" :title="`${filename}（${formatSize(size, false)}）`">
        {{ filename }}
      </span>
      <span class="img-dim mono">
        {{ natural.w ? `${natural.w} × ${natural.h}` : '' }}
      </span>
      <span class="img-gap" />
      <button class="img-btn" title="缩小" :disabled="scale <= MIN_SCALE" @click="zoomBy(-0.1)">
        <el-icon><ZoomOut /></el-icon>
      </button>
      <span class="img-scale mono">{{ percent }}%</span>
      <button class="img-btn" title="放大" :disabled="scale >= MAX_SCALE" @click="zoomBy(0.1)">
        <el-icon><ZoomIn /></el-icon>
      </button>
      <button class="img-btn wide" title="缩放到适应窗口" @click="fit">适应窗口</button>
      <button class="img-btn wide" title="按原始像素显示" @click="setActual">1:1</button>
    </div>

    <div ref="scrollEl" class="img-scroll" @wheel="onWheel">
      <div v-if="loading" class="img-tip">
        <el-icon class="is-loading"><Loading /></el-icon>
        正在解码 {{ filename }}…
      </div>

      <el-alert
        v-else-if="failed"
        class="img-alert"
        type="error"
        :closable="false"
        show-icon
        title="这个图片看不了"
        :description="failed"
      />

      <!-- 容器尺寸跟着缩放走，滚动条由浏览器给：比自己算平移简单也更稳 -->
      <div
        v-show="!failed"
        class="img-stage"
        :style="{ width: shownW + 'px', height: shownH + 'px' }"
      >
        <img
          ref="imgEl"
          class="img-el"
          :src="src"
          :alt="filename"
          :class="{ zoomed: scale >= 1 }"
          :style="{ width: shownW + 'px', height: shownH + 'px' }"
          decoding="async"
          @load="onLoad"
          @error="onError"
        />
      </div>
    </div>

    <div class="img-foot">
      <!-- 体积在外层对话框的底栏已经写了，这里只补"是什么格式"，别重复两遍同一个数字 -->
      <span class="img-meta">{{ imageMime(filename).replace('image/', '').toUpperCase() }}</span>
      <span class="img-hint">Ctrl / ⌘ + 滚轮缩放</span>
      <span class="img-gap" />
      <el-button
        v-if="!failed"
        size="small"
        text
        :icon="RefreshLeft"
        title="回到适应窗口"
        @click="fit"
      >
        重置
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.img {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.img-bar,
.img-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0 2px 8px;
  font-size: 11px;
  color: var(--text-3);
}

.img-foot {
  padding: 8px 2px 0;
  border-top: 1px solid var(--border-soft);
  margin-top: 8px;
}

.img-name {
  font-size: 11.5px;
  color: var(--text-2);
  max-width: 46%;
}

.img-dim {
  color: var(--text-3);
}

.img-gap {
  flex: 1;
  min-width: 0;
}

.img-scale {
  min-width: 42px;
  text-align: center;
  color: var(--text-2);
}

/* 和 PdfPreview 的 .pdf-btn 保持一套尺寸与外观：
   两个预览面板的工具条长得一样，用户来回切才不用重新找按钮。
   边框必须有 —— 图标按钮没有边界就会和「适应窗口 / 1:1」粘成一排字 */
.img-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 22px;
  padding: 0 6px;
  font-size: 11.5px;
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
}

.img-btn.wide {
  padding: 0 9px;
}

.img-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-1);
}

.img-btn:disabled {
  color: var(--text-3);
  opacity: 0.6;
  cursor: not-allowed;
}

/*
 * 棋盘格底色：透明 PNG 放在纯色底上分不出哪块是透明的。
 * 用极低对比的两色斜纹，深浅主题都能看清（不让它比图还显眼）。
 */
.img-scroll {
  flex: 1;
  min-height: 0;
  /* flex + 子元素 margin:auto 是"内容小就居中、内容大就能滚"的唯一稳妥组合；
     换成 justify-content:center 会把溢出的左上角裁掉，滚不过去 */
  display: flex;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background-color: var(--bg-panel-2);
  background-image:
    linear-gradient(45deg, var(--grid-line) 25%, transparent 25%),
    linear-gradient(-45deg, var(--grid-line) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--grid-line) 75%),
    linear-gradient(-45deg, transparent 75%, var(--grid-line) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}

/* 图比容器小的时候居中；比容器大就正常滚动 */
.img-stage {
  flex: none;
  margin: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 1px;
}

.img-el {
  display: block;
  max-width: none;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.28);
}

/* 只有放大时才关掉平滑：像素级检查要看清锯齿，
   但缩小（比如大图适应窗口）关掉平滑会让照片变得到处是噪点 */
.img-el.zoomed {
  image-rendering: pixelated;
}

.img-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  font-size: 11.5px;
  color: var(--text-3);
}

.img-alert {
  margin: 12px;
}

.img-hint {
  color: var(--text-3);
  opacity: 0.7;
}
</style>
