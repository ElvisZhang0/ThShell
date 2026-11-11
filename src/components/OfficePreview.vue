<script setup lang="ts">
/**
 * 办公文档只读预览 —— docx / xlsx / xls。
 *
 * 为什么是「预览」而不是「编辑」：
 * - docx 是 OOXML（zip 里一堆 xml），改一个段落要重写 document.xml 还要处理样式继承，
 *   纯前端做出来的东西和 Word 排版一定对不上，用户改完再打开就发现格式跑了。
 * - 真要编辑得上 OnlyOffice / Collabora 这种带服务端的方案（镜像 + 许可 + 回写回调）。
 *   这里只解决「在服务器上瞄一眼这份文档写了什么」，够用且零依赖。
 *
 * 渲染策略：
 * - docx：docx-preview，保留样式/分页，页面按 A4 白底排，跟 Word 观感接近。
 * - xlsx/xls：SheetJS 解析成 HTML 表格，多 sheet 给页签切换。
 * - pptx/ppt/doc（老二进制格式）：没有靠谱的纯前端渲染器，明说 + 指条路，
 *   别硬塞一个排版崩掉的画面。
 */
import { computed, nextTick, onMounted, ref, shallowRef, watch } from 'vue'
import { Document, Loading } from '@element-plus/icons-vue'
import { renderAsync } from 'docx-preview'
import * as XLSX from 'xlsx'

const props = defineProps<{
  /** 原始字节的 base64 */
  base64: string
  filename: string
  size: number
}>()

type Kind = 'docx' | 'sheet' | 'unsupported'

const kind = computed<Kind>(() => {
  const f = props.filename.toLowerCase()
  if (f.endsWith('.docx')) return 'docx'
  if (f.endsWith('.xlsx') || f.endsWith('.xls') || f.endsWith('.xlsm')) return 'sheet'
  return 'unsupported'
})

const loading = ref(true)
const loadError = ref('')
const docHost = ref<HTMLDivElement | null>(null)

interface SheetView {
  name: string
  html: string
}
const sheets = shallowRef<SheetView[]>([])
const activeSheet = ref(0)
const sheetHost = ref<HTMLDivElement | null>(null)
/** 单元格被截断的提示（超大表不全渲染，免得卡死） */
const truncated = ref(false)

/** base64 → Uint8Array：atob 只能给字符串，按字节取码点，别用 TextDecoder */
function toBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function renderDocx(bytes: Uint8Array) {
  await nextTick()
  if (!docHost.value) return
  // 传 ArrayBuffer 而不是 Uint8Array：docx-preview 内部走 JSZip，子视图有时会带 offset
  await renderAsync(bytes.slice().buffer, docHost.value, undefined, {
    className: 'docx',
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    experimental: true,
    useBase64URL: true
  })
  fitDocxWidth()
}

/**
 * 纸比弹窗窄不了多少时直接横向滚动很难看，这里按宽度自适应缩放（CSS zoom，Chromium 支持）。
 * 坑：docx-preview 的纸张宽度来自文档里的 sectPr，inline style 优先级高于 CSS，
 * 所以缩放只能用 zoom 而不能用改 width 的方式，否则会被文档自己的页宽顶掉。
 */
function fitDocxWidth() {
  const host = docHost.value
  const page = host?.querySelector('section.docx') as HTMLElement | null
  if (!host || !page) return
  const avail = host.clientWidth - 40 // 对应 .docx-host 左右 padding
  const w = page.offsetWidth
  if (w > avail && w > 0) {
    host.style.setProperty('--docx-zoom', String(Math.max(0.3, avail / w)))
  } else {
    host.style.removeProperty('--docx-zoom')
  }
}

function renderSheet(bytes: Uint8Array) {
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true })
  const views: SheetView[] = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    if (!ws) continue
    // 大表只渲染前 2000 行：sheet_to_html 是全量拼字符串，十万行能把渲染进程卡到无响应
    let target = ws
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1')
    if (range.e.r - range.s.r > 2000) {
      truncated.value = true
      target = {
        ...ws,
        '!ref': XLSX.utils.encode_range({ s: range.s, e: { r: range.s.r + 2000, c: range.e.c } })
      }
    }
    views.push({
      name,
      html: XLSX.utils.sheet_to_html(target, { id: `sheet-${views.length}`, editable: false })
    })
  }
  sheets.value = views
}

/**
 * SheetJS 的 sheet_to_html 不带任何语义标记，数字列默认左对齐很难看。
 * 渲染完在 DOM 里扫一遍：纯数字/百分比/金额的单元格打上 .num 右对齐。
 * 坑：v-html 换 sheet 会整块重建 DOM，所以切页签后要重新跑（watch activeSheet）。
 */
const NUM_RE = /^[-+¥$€]?[\d,]+(\.\d+)?%?$/
function polishSheetDom() {
  const host = sheetHost.value
  if (!host) return
  for (const td of host.querySelectorAll('td')) {
    const t = (td.textContent ?? '').trim()
    if (t && NUM_RE.test(t)) td.classList.add('num')
  }
}
watch(activeSheet, () => nextTick(polishSheetDom))

async function run() {
  loading.value = true
  loadError.value = ''
  try {
    const bytes = toBytes(props.base64)
    if (kind.value === 'docx') {
      // docx 渲染要往真实 DOM 里塞节点，必须先把 loading 摘掉让分支挂载，
      // 否则 docHost 是 null，renderAsync 静默返回 —— 空白弹窗就是这么来的
      loading.value = false
      await nextTick()
      await renderDocx(bytes)
      return
    }
    if (kind.value === 'sheet') {
      renderSheet(bytes)
      await nextTick()
      polishSheetDom()
    }
  } catch (err) {
    // 常见：文件其实是 .doc 改了后缀、或者加密文档
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

onMounted(run)
</script>

<template>
  <div class="office">
    <div v-if="loading" class="office-loading">
      <el-icon class="is-loading"><Loading /></el-icon>
      正在解析 {{ filename }}…
    </div>

    <el-alert
      v-else-if="loadError"
      type="error"
      :closable="false"
      show-icon
      title="这个文件打不开"
      :description="loadError"
    />

    <!-- pptx / ppt / doc：说清楚为什么，别留白屏 -->
    <div v-else-if="kind === 'unsupported'" class="office-tip">
      <el-icon class="tip-icon"><Document /></el-icon>
      <h4>{{ filename }}</h4>
      <p>
        <b>pptx / ppt / doc</b>（老二进制格式）目前没有可靠的浏览器端渲染器，
        强行解析只会得到排版错乱的结果，所以这里不做预览。
      </p>
      <p class="muted">
        本地文件：右键 →「用默认程序打开」，直接交给 Office / WPS。<br />
        远程文件：先「下载到本地」再打开，或直接在服务器上用
        <code>libreoffice --headless --convert-to pdf</code> 转成 PDF 后再看。
      </p>
    </div>

    <!-- docx：docx-preview 渲染出来就是一页页纸 -->
    <div v-else-if="kind === 'docx'" ref="docHost" class="docx-host" />

    <!-- xlsx：多 sheet 页签 + 表格 -->
    <div v-else class="sheet-host">
      <div v-if="sheets.length > 1" class="sheet-tabs">
        <button
          v-for="(s, i) in sheets"
          :key="s.name"
          class="sheet-tab"
          :class="{ active: i === activeSheet }"
          @click="activeSheet = i"
        >
          {{ s.name }}
        </button>
      </div>
      <div v-if="truncated" class="sheet-note">表格过大，只渲染前 2000 行</div>
      <div
        v-if="sheets.length"
        ref="sheetHost"
        class="sheet-body"
        v-html="sheets[activeSheet]?.html"
      />
    </div>
  </div>
</template>

<style scoped>
.office {
  height: 100%;
  overflow: auto;
  background: var(--bg-base);
}

.office-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 28px 18px;
  color: var(--text-2);
  font-size: 13px;
}

/* ---------- docx ---------- */
.docx-host {
  --docx-zoom: 1;
  padding: 20px;
}

/* docx-preview 会把样式表塞进容器，这里只覆盖「纸」的观感：
   纸固定白底，居中、圆角、柔和阴影，深浅主题下都像一份真文档 */
.docx-host :deep(.docx-wrapper) {
  background: transparent;
  padding: 0;
  zoom: var(--docx-zoom);
}

/* 坑：纸张宽度是文档 sectPr 的 inline style，写死 CSS 宽度会被顶掉；
   这里只做「文档没写页宽时的兜底」（白纸缩成一小条就是这种），
   正常 Word 导出的 docx 自带页宽，走 inline style 不受影响 */
.docx-host :deep(.docx-wrapper > section.docx) {
  margin: 0 auto 20px;
  width: 794px;
  max-width: 100%;
  min-height: 360px;
  background: #fff;
  color: #000;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2), 0 8px 28px rgba(0, 0, 0, 0.18);
  border-radius: 4px;
}

.docx-host :deep(.docx-wrapper > section.docx:last-child) {
  margin-bottom: 0;
}

/* ---------- xlsx ---------- */
.sheet-host {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.sheet-tabs {
  display: flex;
  gap: 2px;
  padding: 8px 12px 0;
  overflow-x: auto;
  flex: 0 0 auto;
}

.sheet-tab {
  padding: 6px 14px;
  font-size: 12px;
  color: var(--text-2);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  white-space: nowrap;
}

.sheet-tab:hover {
  color: var(--text-1);
}

.sheet-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.sheet-note {
  padding: 6px 12px 0;
  font-size: 11px;
  color: var(--warn, #d97706);
}

.sheet-body {
  flex: 1 1 auto;
  overflow: auto;
  padding: 12px 14px 18px;
}

/* SheetJS 只输出 table，不带样式，这里补一套能看的表格皮肤。
   坑：border-collapse: collapse 会让 table 的 border-radius 失效，
   圆角必须用 separate + border-spacing: 0，再靠单元格自身 border 画线 */
.sheet-body :deep(table) {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12.5px;
  font-family: var(--font-mono, Consolas, monospace);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.sheet-body :deep(td) {
  border: none;
  border-bottom: 1px solid var(--border);
  padding: 7px 12px;
  color: var(--text-1);
  white-space: nowrap;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 数字/百分比列右对齐（polishSheetDom 打的标） */
.sheet-body :deep(td.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.sheet-body :deep(tbody tr:hover td) {
  background: var(--bg-elevated, rgba(255, 255, 255, 0.04));
}

/* 首行当表头：sticky + 强调色下边线，别跟数据行长得一样 */
.sheet-body :deep(tr:first-child td) {
  background: var(--bg-elevated, rgba(255, 255, 255, 0.05));
  color: var(--text-2);
  font-weight: 600;
  font-family: var(--font-sans, inherit);
  border-bottom: 2px solid var(--accent);
  position: sticky;
  top: 0;
  z-index: 1;
}

.sheet-body :deep(tr:last-child td) {
  border-bottom: none;
}

/* ---------- 不支持的类型 ---------- */
.office-tip {
  padding: 34px 28px;
  max-width: 620px;
  margin: 0 auto;
  text-align: center;
  color: var(--text-2);
}

.office-tip .tip-icon {
  font-size: 40px;
  color: var(--text-3);
  margin-bottom: 10px;
}

.office-tip h4 {
  margin: 0 0 12px;
  font-size: 15px;
  color: var(--text-1);
  word-break: break-all;
}

.office-tip p {
  margin: 0 0 10px;
  font-size: 12.5px;
  line-height: 1.8;
}

.office-tip .muted {
  color: var(--text-3);
}

.office-tip code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-panel);
  color: var(--accent);
  font-family: var(--font-mono, Consolas, monospace);
}
</style>
