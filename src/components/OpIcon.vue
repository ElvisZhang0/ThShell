<script setup lang="ts">
/**
 * 容器操作列的图标集。
 *
 * 为什么不用 Element Plus 的图标：那一套是通用图标库，缺「启动 / 停止」这种
 * 容器领域最基础的语义，只能拿相近的凑 —— 启动用 CircleCheck（对勾，语义是
 * "已完成")、进容器终端用 Film（胶片），一排看下来彼此不成体系。
 *
 * 这里统一成 24 网格、2 描边、currentColor，形状直接对齐 Docker Desktop /
 * Portainer / lazydocker 的惯例：启动 ▶、停止 ■。实心块只给这两个 + 暂停用，
 * 其余全部描边，避免一排图标里有的很重有的很轻。
 */
export type OpIconName =
  | 'start'
  | 'stop'
  | 'restart'
  | 'pause'
  | 'resume'
  | 'terminal'
  | 'logs'
  | 'detail'
  | 'remove'

defineProps<{ name: OpIconName }>()
</script>

<template>
  <svg
    class="op-svg"
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <!-- 启动 / 恢复：实心三角。stroke 同色描一圈是为了把三个角磨圆 -->
    <path
      v-if="name === 'start' || name === 'resume'"
      d="M8.2 5.4 18.4 12 8.2 18.6Z"
      fill="currentColor"
      stroke-width="2.6"
    />

    <!-- 停止：实心圆角方块。比整格略小，免得在一排细线里显得过重 -->
    <rect v-else-if="name === 'stop'" x="6.6" y="6.6" width="10.8" height="10.8" rx="2" fill="currentColor" stroke="none" />

    <!-- 重启：顺时针圆箭头（lucide rotate-cw 的几何，圆弧终点和箭头折角对齐） -->
    <template v-else-if="name === 'restart'">
      <path d="M20.6 12a8.6 8.6 0 1 1-8.6-8.6c2.41 0 4.72.96 6.45 2.62L20.6 8.1" />
      <path d="M20.6 3.2v4.9h-4.9" />
    </template>

    <!-- 暂停：两条实心竖条 -->
    <template v-else-if="name === 'pause'">
      <rect x="7.3" y="5.4" width="3.2" height="13.2" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.5" y="5.4" width="3.2" height="13.2" rx="1.2" fill="currentColor" stroke="none" />
    </template>

    <!-- 进入容器：`>_` 提示符。比胶片直白，跟终端页签里的观感也一致 -->
    <template v-else-if="name === 'terminal'">
      <path d="M5.2 16.4 10.4 11.4 5.2 6.4" />
      <path d="M12.6 19h7.4" />
    </template>

    <!-- 日志：带折角的文档 + 两行字 -->
    <template v-else-if="name === 'logs'">
      <path d="M14 2.8H7a2 2 0 0 0-2 2v14.4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.8z" />
      <path d="M14 2.8v5h5" />
      <path d="M8.8 13h6.4" />
      <path d="M8.8 16.8h6.4" />
    </template>

    <!-- 详情：描边圆 + i。原来用实心 InfoFilled，一排线条里就它最重 -->
    <template v-else-if="name === 'detail'">
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 16.4v-4.8" />
      <path d="M12 8.2h.01" stroke-width="2.4" />
    </template>

    <!-- 删除：垃圾桶 -->
    <template v-else-if="name === 'remove'">
      <path d="M4 6.2h16" />
      <path d="M9.4 6.2V4.6a1.6 1.6 0 0 1 1.6-1.6h2a1.6 1.6 0 0 1 1.6 1.6v1.6" />
      <path d="M18.4 6.2 17.5 19a2 2 0 0 1-2 1.9H8.5a2 2 0 0 1-2-1.9L5.6 6.2" />
      <path d="M10.2 10.6v5.6" />
      <path d="M13.8 10.6v5.6" />
    </template>
  </svg>
</template>

<style scoped>
.op-svg {
  display: block;
  flex: none;
}
</style>
