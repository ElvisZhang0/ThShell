<script setup lang="ts">
/**
 * Markdown 实时预览面板（编辑器右半栏）。
 *
 * 为什么做防抖：markdown-it 每次都是整篇重排，几万字的文档逐字符渲染会明显掉帧。
 * 120ms 是"打字停顿可感知但又不觉得慢"的折中 —— 比 requestAnimationFrame 稳，
 * 也不会像 300ms 那样拖出一段空白。
 *
 * 为什么不用 v-html 直接渲染 md：见 utils/markdown.ts，内容来自服务器文件，
 * 必须过 DOMPurify 才能插入 DOM。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { renderMarkdown } from '../utils/markdown'

const props = defineProps<{
  content: string
}>()

const html = ref('')
const empty = computed(() => !props.content.trim())
let timer: number | null = null
/** 首次渲染不走防抖：挂载时先出内容，否则会闪一下空白 */
let first = true

function flush(source: string): void {
  html.value = renderMarkdown(source)
}

watch(
  () => props.content,
  (next) => {
    if (first) {
      first = false
      flush(next)
      return
    }
    if (timer != null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      flush(next)
    }, 120)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (timer != null) window.clearTimeout(timer)
})
</script>

<template>
  <div class="md-preview">
    <div v-if="empty" class="md-empty">开始输入 Markdown，这里会实时渲染</div>
    <!-- html 已经在 utils/markdown.ts 里过了 DOMPurify -->
    <div v-else class="md-body" v-html="html" />
  </div>
</template>

<style scoped>
.md-preview {
  height: 100%;
  overflow: auto;
  padding: 18px 22px 48px;
  background: var(--bg-panel);
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.75;
  /* 预览栏的滚动条别跟代码编辑器的深色滚动条打架 */
  scrollbar-width: thin;
}

.md-empty {
  padding-top: 40px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-3);
}

/* ---------- 排版：按 GitHub 观感做一版，全部走主题变量 ---------- */
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4),
.md-body :deep(h5),
.md-body :deep(h6) {
  margin: 22px 0 10px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--text-1);
}

.md-body :deep(h1) {
  font-size: 20px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.md-body :deep(h2) {
  font-size: 17px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--border-soft);
}

.md-body :deep(h3) {
  font-size: 15px;
}

.md-body :deep(h4) {
  font-size: 13.5px;
}

.md-body :deep(h5),
.md-body :deep(h6) {
  font-size: 13px;
  color: var(--text-2);
}

/* 首块不要顶出上边距，否则上面会多一块空白 */
.md-body :deep(h1:first-child),
.md-body :deep(h2:first-child),
.md-body :deep(h3:first-child),
.md-body :deep(p:first-child),
.md-body :deep(ul:first-child),
.md-body :deep(ol:first-child),
.md-body :deep(pre:first-child),
.md-body :deep(table:first-child) {
  margin-top: 0;
}

.md-body :deep(p) {
  margin: 0 0 10px;
}

.md-body :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.md-body :deep(a:hover) {
  text-decoration: underline;
}

.md-body :deep(strong) {
  color: var(--text-1);
  font-weight: 600;
}

.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 0 0 10px;
  padding-left: 22px;
}

.md-body :deep(li) {
  margin: 3px 0;
}

.md-body :deep(li > p) {
  margin: 0;
}

/* 引用块：用左侧竖线而不是缩进，长引用读起来段落感更清楚 */
.md-body :deep(blockquote) {
  margin: 0 0 12px;
  padding: 2px 12px;
  border-left: 3px solid var(--accent-line);
  background: var(--accent-soft);
  border-radius: 0 4px 4px 0;
  color: var(--text-2);
}

.md-body :deep(code) {
  padding: 1.5px 5px;
  border-radius: 4px;
  background: var(--bg-elevated);
  color: var(--text-1);
  font-family: var(--font-mono, Consolas, monospace);
  font-size: 12px;
}

/* 代码块：横向可滚动，别折行（折行的代码没法看） */
.md-body :deep(pre) {
  margin: 0 0 12px;
  padding: 10px 12px;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-base);
  line-height: 1.55;
}

.md-body :deep(pre code) {
  padding: 0;
  background: transparent;
  font-size: 12px;
  white-space: pre;
}

.md-body :deep(table) {
  margin: 0 0 14px;
  border-collapse: collapse;
  font-size: 12.5px;
  display: block;
  overflow-x: auto;
}

.md-body :deep(th),
.md-body :deep(td) {
  padding: 5px 10px;
  border: 1px solid var(--border);
  text-align: left;
}

.md-body :deep(th) {
  background: var(--bg-panel-2);
  color: var(--text-2);
  font-weight: 600;
}

.md-body :deep(tr:nth-child(2n) td) {
  background: var(--bg-panel-2);
}

.md-body :deep(hr) {
  height: 1px;
  margin: 18px 0;
  border: 0;
  background: var(--border);
}

/* 图片：md 里贴的截图往往比栏宽大，等比缩到容器内 */
.md-body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
}

/* 任务列表（- [ ] xxx 手写成文本时也至少能看） */
.md-body :deep(input[type='checkbox']) {
  margin-right: 5px;
  accent-color: var(--accent);
}
</style>
