<script setup lang="ts">
/**
 * 弹窗标题栏右端的三颗窗口按钮（最小化 / 最大化·还原 / 关闭）。
 *
 * 字形是手画 SVG，不用 Element Plus 的图标组件 —— 那套是「功能图标」，
 * 比如 `FullScreen` 是四个角的括号，看着像"全屏播放"而不是"最大化"；
 * 原生标题栏用的是 10px 见方的 1px 细线：一条横线、一个空心方框、
 * 两个错开的方框（还原）、一个叉。这里照着画一遍，弹窗里的按钮和外层
 * 窗口那三颗才是一套东西，不用先愣一下再判断"这颗是干什么的"。
 *
 * 悬停也照搬：整格淡色填充，关闭键悬停变 Windows 的 #c42b1c 红底白叉。
 */
const props = defineProps<{ maximized: boolean; minned: boolean }>()

const emit = defineEmits<{
  (e: 'minimize'): void
  (e: 'restore'): void
  (e: 'toggle-max'): void
  (e: 'close'): void
}>()
</script>

<template>
  <!-- 冒泡必须掐断：最小化后整条标题栏是"点一下展开"，点到这里的按钮不该顺手展开 -->
  <div class="win-ctl" @click.stop @dblclick.stop>
    <!-- 收起状态下这颗变成"展开"：没有它就只能靠点标题栏，等于藏了个功能 -->
    <button v-if="props.minned" class="wc" title="展开（内容还在）" @click="emit('restore')">
      <svg class="g" viewBox="0 0 10 10" aria-hidden="true">
        <rect x="0.5" y="3.5" width="6" height="6" />
        <path d="M3.5 3.5v-3h6v6h-3" />
      </svg>
    </button>

    <template v-else>
      <button class="wc" title="最小化到右下角（内容不丢）" @click="emit('minimize')">
        <svg class="g" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 5.5h9" />
        </svg>
      </button>
      <button
        class="wc"
        :title="props.maximized ? '还原窗口' : '最大化'"
        @click="emit('toggle-max')"
      >
        <!-- 最大化是一个空心方框；已经是最大化时换成"两个错开的方框" -->
        <svg v-if="!props.maximized" class="g" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="0.5" y="0.5" width="9" height="9" />
        </svg>
        <svg v-else class="g" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="0.5" y="3.5" width="6" height="6" />
          <path d="M3.5 3.5v-3h6v6h-3" />
        </svg>
      </button>
    </template>

    <button class="wc close" title="关闭" @click="emit('close')">
      <svg class="g" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.win-ctl {
  flex: none;
  /* 靠右：它模仿的是窗口右上角，永远在最外侧。
     -8px 是为了往内边距里再探一点，三颗按钮更贴近卡片边沿，
     不然离右边 16px 加 34px 的按钮，看着像飘在标题中间 */
  margin-left: auto;
  margin-right: -8px;
  display: flex;
  align-items: center;
}

.wc {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 2px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

/* 字形：10px 见方、1px 细线、不填充。0.5 的偏移让线正好压在像素上，不糊 */
.g {
  width: 10px;
  height: 10px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
}

.wc:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.wc:active {
  background: var(--bg-active, var(--bg-hover));
}

/* 关闭键悬停给红底白叉：Windows 原生就是这个色，一颗红的比四个灰的更容易点准 */
.wc.close:hover {
  background: #c42b1c;
  color: #fff;
}

.wc.close:active {
  background: #b1261a;
}
</style>
