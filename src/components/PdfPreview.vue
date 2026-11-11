<script setup lang="ts">
/**
 * PDF 预览 —— pdf.js 渲染成 canvas，逐页占位 + 可视区懒渲染。
 *
 * 为什么不直接用 <iframe src="blob:...">：
 *   Chromium 自带的 PDF 阅读器确实零成本，但它是"另一个进程里的黑盒"：
 *   深/浅主题管不了、缩放栏是英文、在我们这个弹窗里还常被当成下载处理。
 *   自己用 pdf.js 画 canvas，至少风格和应用一致、能控制缩放与懒加载。
 *
 * 为什么把 worker 代码以 `?raw` 内联再用 Blob 起：
 *   打包后渲染进程是 file:// 页面，`new Worker('file:///…/pdf.worker.mjs')` 会被
 *   Chromium 当成跨源脚本直接拒绝；Blob URL 是唯一到处都能起 worker 的写法。
 *   代价是 bundle 里多 1.3MB 字符串 —— 反正这段代码按需动态 import，不开 PDF 不加载。
 *
 * 已知限制：没有配置 cMapUrl / standardFontDataUrl。
 *   绝大多数 PDF（Word/WPS 导出、扫描件）字体都是内嵌的，不受影响；
 *   少数"中文未内嵌 + 依赖 Adobe CMaps"的老 PDF 可能出现方框。
 *   真遇到时下载到本地用系统 PDF 阅读器打开即可，不值得为此把 4MB 字体/CMap 打进包。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Loading, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import { installEs2025Shim, ES2025_SHIM } from '../utils/es2025-shim'

const props = defineProps<{
  /** 原始字节的 base64（主进程读出来的） */
  base64: string
  filename: string
  size: number
}>()

/* pdf.js 的类型导出比较绕，这里只用得到四个方法，按结构自己声明一份最小接口，
   省得把 pdfjs-dist/types 里的内部类型一路引进来 */
interface PdfPage {
  getViewport(params: { scale: number }): { width: number; height: number }
  render(params: Record<string, unknown>): { promise: Promise<void>; cancel(): void }
  cleanup(): void
}
interface PdfDoc {
  numPages: number
  getPage(n: number): Promise<PdfPage>
  destroy(): Promise<void>
}
interface PdfLoadingTask {
  promise: Promise<PdfDoc>
  destroy(): Promise<void>
}

const loading = ref(true)
const loadError = ref('')
/**
 * 单页渲染失败的原因（页码 → 消息）。
 * 以前这类错误只 console.warn，结果是这一页永远转圈、界面一片白 ——
 * 用户看不到任何线索，我们也只能靠翻控制台猜。现在直接写在这一页上。
 */
const pageFail = ref<Record<number, string>>({})
const wrap = ref<HTMLDivElement | null>(null)
const pageCount = ref(0)
/** 缩放比例：1 = PDF 的 100% */
const scale = ref(1)
/** 每页的原始尺寸（scale=1），占位 div 用它 × scale 算高，避免加载时页面高度乱跳 */
const pages = ref<{ index: number; w: number; h: number }[]>([])

let doc: PdfDoc | null = null
let loadingTask: PdfLoadingTask | null = null
let observer: IntersectionObserver | null = null
/** 当前正在跑的渲染任务，缩放时要能取消，否则旧尺寸的画布会盖上来 */
let activeTask: { cancel(): void } | null = null
/** 渲染世代：缩放/关闭时 +1，旧任务回来看见代数不对就自己作废 */
let gen = 0
/** 串行链：同一时刻只渲染一页，否则十几页同时开画会把主线程顶住 */
let chain: Promise<void> = Promise.resolve()
const state = new Map<number, { rendered: boolean; rendering: boolean }>()

/** base64 → Uint8Array；atob 给的是"每字符一字节"的串，不能走 TextDecoder */
function toBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 懒加载 pdf.js 主包 + worker 源码，只在真的要看 PDF 时才付出这份体积。
 * 引擎和 Blob URL 都缓存在模块级：同一进程里连开几个 PDF 不该反复建 1.3MB 的 blob
 * （blob 只有 revoke 才会释放，而 pdf.js 的 fake-worker 回退随时可能再用到它，
 * 所以干脆整个进程生命周期都留着）。
 */
let engine: Promise<typeof import('pdfjs-dist')> | null = null

function loadEngine(): Promise<typeof import('pdfjs-dist')> {
  if (!engine) {
    engine = (async () => {
      // 主线程先用上垫片，再加载引擎：pdf.mjs 自己也直接调了这些新 API
      installEs2025Shim()
      const [pdfjs, workerModule] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?raw')
      ])
      // worker 里同样缺，而它跑在 Blob 里、import 不到我们的模块 —— 只能把源码拼在前面
      const source = ES2025_SHIM + '\n' + workerModule.default
      const blob = new Blob([source], { type: 'text/javascript' })
      pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob)
      return pdfjs
    })()
    // 加载失败（极少见）要让下次还能重试，否则会永久卡在 rejected 的 Promise 上
    engine.catch(() => {
      engine = null
    })
  }
  return engine
}

function clampScale(value: number): number {
  return Math.min(2.5, Math.max(0.4, Math.round(value * 100) / 100))
}

/** 适应宽度：容器宽减掉两侧留白，除以首页宽度。上限 1.4 倍，免得小页被放得糊掉 */
function fitScale(pageWidth: number): number {
  const box = wrap.value?.clientWidth ?? 0
  if (!pageWidth || box <= 0) return 1
  return clampScale((box - 32) / pageWidth)
}

async function renderOne(index: number, myGen: number): Promise<void> {
  const st = state.get(index)
  if (!doc || !st || st.rendered || st.rendering) return
  st.rendering = true
  const host = wrap.value?.querySelector<HTMLElement>(`[data-page="${index}"]`)
  try {
    const page = await doc.getPage(index)
    if (myGen !== gen) return
    const viewport = page.getViewport({ scale: scale.value })
    // dpr 上限 2：4K 屏按 3 倍画，单页 canvas 能吃掉上百 MB 显存，肉眼却看不出差别
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const canvas = document.createElement('canvas')
    canvas.className = 'pdf-canvas'
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr))
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr))
    canvas.style.width = `${Math.floor(viewport.width)}px`
    canvas.style.height = `${Math.floor(viewport.height)}px`
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('无法创建 canvas 2d 上下文')

    const task = page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
    })
    activeTask = task
    await task.promise
    activeTask = null
    if (myGen !== gen) return
    // 只换画布，别 replaceChildren 整块清空 —— 页面里可能还挂着本页的失败提示
    host?.querySelectorAll('canvas').forEach((el) => el.remove())
    host?.appendChild(canvas)
    st.rendered = true
    if (pageFail.value[index]) {
      const next = { ...pageFail.value }
      delete next[index]
      pageFail.value = next
    }
    // 画完就释放这一页的中间对象，几十页的文档不释放内存会一路涨
    page.cleanup()
  } catch (err) {
    // 缩放 / 关窗时会主动 cancel，pdf.js 抛 RenderingCancelledException —— 不是错误
    const message = err instanceof Error ? err.message : String(err)
    if (!/cancel/i.test(message)) {
      console.warn('[pdf] 第', index, '页渲染失败', err)
      pageFail.value = { ...pageFail.value, [index]: message }
      // 整篇一页都没画出来才算"打不开"；只是某一页坏了不该把别的页一起藏起来
      const anyRendered = [...state.values()].some((s) => s.rendered)
      if (!anyRendered) loadError.value = `第 ${index} 页渲染失败：${message}`
    }
  } finally {
    st.rendering = false
  }
}

/** 某页失败后点「重试」：清掉失败标记重新排队 */
function retryPage(index: number): void {
  const next = { ...pageFail.value }
  delete next[index]
  pageFail.value = next
  loadError.value = ''
  enqueue(index)
}

function enqueue(index: number): void {
  const st = state.get(index)
  if (!st || st.rendered || st.rendering) return
  const myGen = gen
  chain = chain.then(() => renderOne(index, myGen)).catch(() => {})
}

function attachObserver(): void {
  observer?.disconnect()
  if (!wrap.value) return
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const idx = Number((entry.target as HTMLElement).dataset.page)
        if (idx) enqueue(idx)
      }
    },
    // 上下各预取 480px：滚到哪页哪页已经在画，不会先看到一片空白
    { root: wrap.value, rootMargin: '480px 0px' }
  )
  wrap.value.querySelectorAll<HTMLElement>('.pdf-page').forEach((el) => observer!.observe(el))
}

/** 丢弃所有已画的画布，重新按当前 scale 排队 */
function resetRender(): void {
  gen++
  activeTask?.cancel()
  activeTask = null
  chain = Promise.resolve()
  state.forEach((st) => {
    st.rendered = false
    st.rendering = false
  })
  // 只删画布：页里可能还挂着失败提示，那是 Vue 管的节点，
  // 整块 replaceChildren 会把它们从 DOM 里抽走，虚拟 DOM 就对不上了
  wrap.value?.querySelectorAll('.pdf-page canvas').forEach((el) => el.remove())
}

/**
 * 缩放后必须重新 observe：IntersectionObserver 只在"相交状态变化"时回调，
 * 已经滚到视野里的页不会自己再触发一次；disconnect + 重新 observe 会立刻对
 * 视野内的元素各回调一次，正好把当前可见页重新排进队列。
 */
function reRenderVisible(): void {
  resetRender()
  attachObserver()
}

function zoomBy(delta: number): void {
  const next = clampScale(scale.value + delta)
  if (next === scale.value) return
  scale.value = next
  reRenderVisible()
}

function fitWidth(): void {
  const first = pages.value[0]
  if (!first) return
  const next = fitScale(first.w)
  if (next === scale.value) return
  scale.value = next
  reRenderVisible()
}

async function disposeDoc(): Promise<void> {
  gen++
  observer?.disconnect()
  observer = null
  activeTask?.cancel()
  activeTask = null
  const d = doc
  const task = loadingTask
  doc = null
  loadingTask = null
  try {
    await task?.destroy()
  } catch {
    /* 关窗时 worker 可能已经没了，忽略 */
  }
  try {
    await d?.destroy()
  } catch {
    /* 同上 */
  }
}

async function load(): Promise<void> {
  await disposeDoc()
  loading.value = true
  loadError.value = ''
  pages.value = []
  pageCount.value = 0
  state.clear()
  scale.value = 1
  try {
    const pdfjs = await loadEngine()
    const task = pdfjs.getDocument({
      data: toBytes(props.base64),
      // 让 pdf.js 用系统字体渲染基础 14 种字体（不内嵌 Helvetica/Times 的 PDF 全靠它）
      useSystemFonts: true
    }) as unknown as PdfLoadingTask
    loadingTask = task
    const loaded = await task.promise
    doc = loaded
    pageCount.value = loaded.numPages

    const sizes: { index: number; w: number; h: number }[] = []
    for (let i = 1; i <= loaded.numPages; i++) {
      const page = await loaded.getPage(i)
      const vp = page.getViewport({ scale: 1 })
      sizes.push({ index: i, w: vp.width, h: vp.height })
      page.cleanup()
      state.set(i, { rendered: false, rendering: false })
    }
    pages.value = sizes
    loading.value = false
    // 等占位 div 挂上 DOM，measure 才有宽度可参考
    await nextTick()
    scale.value = fitScale(sizes[0]?.w ?? 0)
    attachObserver()
    // IntersectionObserver 的首次回调是"异步且不保证"的：弹窗还在做入场动画、
    // 或者这一帧 root 高度还是 0 时，第一页可能一直等不到 isIntersecting。
    // 第一页反正就在顶上，直接排进队列最稳 —— 重复排队会被 rendered/rendering 挡住。
    enqueue(1)
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
    loading.value = false
  }
}

watch(
  () => props.base64,
  () => {
    void load()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  void disposeDoc()
})
</script>

<template>
  <div class="pdf">
    <div class="pdf-bar">
      <el-icon v-if="loading" class="is-loading"><Loading /></el-icon>
      <span class="pdf-name mono truncate" :title="filename">{{ filename }}</span>
      <span class="pdf-pages mono">{{ pageCount ? `${pageCount} 页` : '' }}</span>
      <span class="pdf-gap" />
      <button class="pdf-btn" title="缩小" :disabled="scale <= 0.4" @click="zoomBy(-0.15)">
        <el-icon><ZoomOut /></el-icon>
      </button>
      <span class="pdf-scale mono">{{ Math.round(scale * 100) }}%</span>
      <button class="pdf-btn" title="放大" :disabled="scale >= 2.5" @click="zoomBy(0.15)">
        <el-icon><ZoomIn /></el-icon>
      </button>
      <button class="pdf-btn wide" title="缩放到适合栏宽" @click="fitWidth">适应宽度</button>
    </div>

    <div ref="wrap" class="pdf-scroll">
      <div v-if="loading" class="pdf-tip">
        <el-icon class="is-loading"><Loading /></el-icon>
        正在解析 {{ filename }}…
      </div>

      <el-alert
        v-else-if="loadError"
        class="pdf-alert"
        type="error"
        :closable="false"
        show-icon
        title="这个 PDF 打不开"
        :description="loadError"
      />

      <div
        v-for="p in pages"
        :key="p.index"
        class="pdf-page"
        :data-page="p.index"
        :style="{
          width: Math.round(p.w * scale) + 'px',
          height: Math.round(p.h * scale) + 'px'
        }"
      >
        <div v-if="pageFail[p.index]" class="pdf-fail">
          <div class="pdf-fail-t">第 {{ p.index }} 页没画出来</div>
          <div class="pdf-fail-m mono">{{ pageFail[p.index] }}</div>
          <button class="pdf-btn" @click="retryPage(p.index)">重试</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pdf {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-base);
}

/* 顶部工具条：文件名 + 页码 + 缩放，贴着预览面板顶部，不悬浮 */
.pdf-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  font-size: 11.5px;
  color: var(--text-2);
}

.pdf-name {
  max-width: 42%;
  color: var(--text-1);
  font-size: 12px;
}

.pdf-pages {
  flex: none;
  color: var(--text-3);
}

.pdf-gap {
  flex: 1;
}

.pdf-scale {
  min-width: 42px;
  text-align: center;
  color: var(--text-2);
}

.pdf-btn {
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

.pdf-btn.wide {
  padding: 0 9px;
}

.pdf-btn:hover:not(:disabled) {
  color: var(--text-1);
  background: var(--bg-hover);
}

.pdf-btn:disabled {
  color: var(--text-3);
  cursor: not-allowed;
  opacity: 0.6;
}

.pdf-scroll {
  position: relative;
  flex: 1 1 auto;
  overflow: auto;
  padding: 14px 0 28px;
  /* 页面之间的灰底：浅色主题下是浅灰，深色下是接近黑，纸才有对比 */
  background: var(--bg-base);
}

.pdf-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 18px;
  color: var(--text-2);
  font-size: 13px;
}

.pdf-alert {
  margin: 12px 16px;
}

/* 占位 + 画布同尺寸：未渲染时是灰块，渲染完直接被 canvas 替换 */
.pdf-page {
  position: relative; /* 单页失败提示要靠它铺满整页 */
  margin: 0 auto 14px;
  border-radius: 2px;
  background: #fff;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

.pdf-page:last-child {
  margin-bottom: 0;
}

.pdf-page :deep(.pdf-canvas) {
  display: block;
}

/* 单页失败：仍留在本该是白纸的位置上，写清楚哪一页、为什么，并给一个重试 */
.pdf-fail {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  text-align: center;
  background: var(--bg-panel-2);
}

.pdf-fail-t {
  font-size: 12px;
  color: var(--danger);
}

.pdf-fail-m {
  max-width: 100%;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-3);
  word-break: break-all;
}
</style>
