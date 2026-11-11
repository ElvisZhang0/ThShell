<script setup lang="ts">
/**
 * 应用标识：与 build/icon.svg 同源的矢量图形。
 * 内联 SVG 而不是引外部 png，这样在任意 DPI 下标题栏和欢迎页都保持锐利。
 */
const uid = `logo-${Math.random().toString(36).slice(2, 8)}`
const bgId = `${uid}-bg`
const markId = `${uid}-mark`
</script>

<template>
  <svg class="logo-mark" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient :id="bgId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#212c3c" />
        <stop offset="52%" stop-color="#151c27" />
        <stop offset="100%" stop-color="#0a0e14" />
      </linearGradient>
      <linearGradient :id="markId" x1="0.05" y1="0" x2="0.95" y2="1">
        <stop offset="0%" stop-color="#7cf0dd" />
        <stop offset="42%" stop-color="#2dd4bf" />
        <stop offset="100%" stop-color="#38bdf8" />
      </linearGradient>
    </defs>

    <rect x="0" y="0" width="1024" height="1024" rx="232" ry="232" :fill="`url(#${bgId})`" />
    <rect
      x="1.5"
      y="1.5"
      width="1021"
      height="1021"
      rx="230.5"
      ry="230.5"
      fill="none"
      stroke="#ffffff"
      stroke-opacity="0.09"
      stroke-width="3"
    />

    <g transform="translate(512 512) scale(1.05) translate(-512 -512)">
      <path
        d="M316 340 L496 512 L316 684"
        fill="none"
        :stroke="`url(#${markId})`"
        stroke-width="88"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <rect x="572" y="640" width="180" height="88" rx="44" ry="44" :fill="`url(#${markId})`" />
    </g>
  </svg>
</template>

<style scoped>
.logo-mark {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
