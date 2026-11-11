<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch, type Component } from 'vue'
import {
  CopyDocument,
  Delete,
  DocumentCopy,
  Download,
  EditPen,
  Files,
  Folder,
  FolderAdd,
  FolderOpened,
  InfoFilled,
  Monitor,
  Refresh,
  Scissor,
  Upload,
  View
} from '@element-plus/icons-vue'

export interface MenuItem {
  /** 分隔线用 'sep'，其余是普通项 */
  key: string
  label?: string
  /** 右侧快捷键提示，纯展示，实际按键由 FileManager 统一监听 */
  kbd?: string
  /** 图标键，见下面的 ICONS 映射 */
  icon?: string
  danger?: boolean
  disabled?: boolean
}

const ICONS: Record<string, Component> = {
  open: View,
  edit: EditPen,
  folder: Folder,
  copy: CopyDocument,
  copyFile: DocumentCopy,
  cut: Scissor,
  paste: Files,
  upload: Upload,
  download: Download,
  newFolder: FolderAdd,
  reveal: FolderOpened,
  terminal: Monitor,
  info: InfoFilled,
  rename: EditPen,
  delete: Delete,
  refresh: Refresh
}

const props = defineProps<{
  visible: boolean
  x: number
  y: number
  items: MenuItem[]
}>()

const emit = defineEmits<{ (e: 'pick', key: string): void; (e: 'close'): void }>()

const root = ref<HTMLElement | null>(null)
const left = ref(props.x)
const top = ref(props.y)

/**
 * 靠近窗口右/下边缘时把菜单翻到光标内侧。
 * 不这么做的话，屏幕右下角的文件右键出来菜单会被窗口切掉一半，得先移开再右键。
 */
async function place() {
  left.value = props.x
  top.value = props.y
  await nextTick()
  const el = root.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const pad = 6
  if (props.x + rect.width + pad > window.innerWidth) {
    left.value = Math.max(pad, props.x - rect.width)
  }
  if (props.y + rect.height + pad > window.innerHeight) {
    top.value = Math.max(pad, props.y - rect.height)
  }
}

function onPick(item: MenuItem) {
  if (item.disabled || item.key === 'sep') return
  emit('pick', item.key)
  emit('close')
}

function onDocDown(event: MouseEvent) {
  if (root.value && !root.value.contains(event.target as Node)) emit('close')
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}

function bind() {
  document.addEventListener('mousedown', onDocDown, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', emitClose)
  window.addEventListener('blur', emitClose)
  // 列表滚动时菜单会悬在原地，跟着关掉
  document.addEventListener('scroll', emitClose, true)
}

function unbind() {
  document.removeEventListener('mousedown', onDocDown, true)
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', emitClose)
  window.removeEventListener('blur', emitClose)
  document.removeEventListener('scroll', emitClose, true)
}

function emitClose() {
  emit('close')
}

watch(
  () => props.visible,
  async (on) => {
    if (on) {
      await place()
      bind()
    } else {
      unbind()
    }
  }
)

onBeforeUnmount(unbind)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="root"
      class="ctx-menu"
      :style="{ left: left + 'px', top: top + 'px' }"
      @contextmenu.prevent
    >
      <template v-for="item in items" :key="item.key">
        <div v-if="item.key === 'sep'" class="ctx-sep" />
        <div
          v-else
          class="ctx-item"
          :class="{ danger: item.danger, disabled: item.disabled }"
          @click="onPick(item)"
        >
          <el-icon v-if="item.icon && ICONS[item.icon]" class="ctx-icon">
            <component :is="ICONS[item.icon]" />
          </el-icon>
          <span>{{ item.label }}</span>
          <span v-if="item.kbd" class="ctx-kbd">{{ item.kbd }}</span>
        </div>
      </template>
    </div>
  </Teleport>
</template>
