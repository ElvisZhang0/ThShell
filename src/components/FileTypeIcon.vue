<script setup lang="ts">
/**
 * 文件类型图标：按种类换图形，只给"值得区分"的种类上颜色。
 *
 * 两条设计决定：
 * 1. **形状负责区分，颜色负责提醒**。全部上色会让文件列表变成调色板 ——
 *    运维的目录里九成是 code / config / log / text，它们保持中性色，
 *    真正需要一眼认出的（图片、视频、音频、PDF、表格、压缩包、证书）才上色。
 * 2. **图形优先选形状差异大的**，而不是形状接近的换配色：
 *    一列 16px 的图标里，`Document` 和 `Files` 的差别比"红纸 vs 蓝纸"大得多。
 *    EP 里没有 `</>` 这类代码符号，`Cpu`（芯片）是次优解，但比再画一张纸强。
 */
import { computed } from 'vue'
import {
  Box,
  Coin,
  Cpu,
  DataBoard,
  Document,
  Files,
  Folder,
  FolderOpened,
  Grid,
  Headset,
  Key,
  Memo,
  Operation,
  Picture,
  Reading,
  SetUp,
  Tickets,
  VideoCamera
} from '@element-plus/icons-vue'
import { kindOf, type FileKind } from '../utils/file-kind'

const props = defineProps<{
  /** 文件名（不是路径）；目录也传名字，靠 isDir 区分 */
  name: string
  isDir?: boolean
  /** 目录展开状态：开了就画开口的文件夹 */
  opened?: boolean
}>()

const kind = computed<FileKind>(() => kindOf(props.name, props.isDir))

const SHAPE: Record<FileKind, unknown> = {
  folder: Folder,
  image: Picture,
  video: VideoCamera,
  audio: Headset,
  pdf: Document,
  doc: Files,
  sheet: Grid,
  slide: DataBoard,
  archive: Box,
  code: Cpu,
  config: Operation,
  log: Tickets,
  text: Memo,
  font: Reading,
  db: Coin,
  exe: SetUp,
  key: Key,
  other: Document
}

const icon = computed(() => (props.opened ? FolderOpened : SHAPE[kind.value]))
</script>

<template>
  <el-icon class="ficon" :class="`k-${kind}`">
    <component :is="icon" />
  </el-icon>
</template>

<style scoped>
/*
 * 尺寸跟全局图标阶梯走（--icon-sm = 16px，行内标准）。
 * 颜色默认中性：九成文件是 code/config/log/text，它们不该抢注意力。
 */
.ficon {
  font-size: var(--icon-sm);
  color: var(--text-3);
  flex: none;
}

.k-folder {
  color: #63b3ed;
}

.k-image {
  color: #34d399;
}

.k-video {
  color: #a78bfa;
}

.k-audio {
  color: #f472b6;
}

.k-pdf {
  color: #f87171;
}

/* 文档 / 代码 / 配置 / 日志 / 文本 / 程序：中性 —— 靠形状区分就够了 */
.k-doc,
.k-code,
.k-config,
.k-log,
.k-text,
.k-exe {
  color: var(--text-2);
}

.k-sheet {
  color: #4ade80;
}

.k-slide {
  color: #fb923c;
}

.k-archive {
  color: #d9a45b;
}

.k-font {
  color: #c084fc;
}

.k-db {
  color: #2dd4bf;
}

.k-key {
  color: #facc15;
}

.k-other {
  color: var(--icon-muted);
}
</style>
