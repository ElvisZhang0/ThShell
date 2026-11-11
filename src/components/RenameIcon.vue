<script setup lang="ts">
/**
 * 「重命名」图标：方框 + 字母 A + 右侧光标竖线。
 *
 * 为什么自己画：Element Plus 293 个图标里没有这个形状，而它是 Windows 资源管理器
 * 「重命名」的通用符号（A 代表文字、竖线代表输入光标），用户一眼就认得。
 *
 * 为什么是 1024 视口：EP 的图标全是 1024 方形 SVG，字形只占 `1em` 的七成多。
 * 跟着用同样的视口和留白，放进 <el-icon> 后大小、基线都自动对齐，不用单独调字号。
 *
 * 笔画故意画粗（64/1024 ≈ 1px @16px）：底栏图标只有 16px，细了会糊成一团。
 */
</script>

<template>
  <svg
    viewBox="0 0 1024 1024"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
  >
    <g
      fill="none"
      stroke="currentColor"
      stroke-width="64"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <!-- 文本框：留出右侧位置给光标 -->
      <rect x="40" y="112" width="640" height="800" rx="84" />
      <!-- 字母 A：只留三笔，多了在 16px 下就成墨点了 -->
      <path d="M190 770 L330 250 L470 770" />
      <path d="M240 604 H420" />
      <!-- 输入光标 -->
      <path d="M872 112 V912" />
    </g>
  </svg>
</template>
