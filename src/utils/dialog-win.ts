import { reactive } from 'vue'

/**
 * 弹窗的「窗口态」——让它像主窗口一样能最小化、最大化、关闭。
 *
 * 关键决定：**最小化只改样式，不动 `visible`**。
 * 这些弹窗都带 `destroy-on-close`，一旦 `visible = false`，正文 DOM 就被销毁了：
 * 编辑器里没保存的修改、PDF 已经渲染好的画布、图片的缩放位置全丢。
 * 收起到右下角小条的价值恰恰就是「腾出屏幕但东西还在」，所以走 CSS 收窄。
 */
export type WinMode = 'normal' | 'max' | 'min'

export interface DialogWindow {
  mode: WinMode
  /** 最大化 / 还原 */
  toggleMax(): void
  minimize(): void
  restore(): void
  /** 每次打开新文件前调一次，别让上一次的窗口态留下来 */
  reset(): void
}

export function useDialogWindow(): DialogWindow {
  const state = reactive<{ mode: WinMode }>({ mode: 'normal' })
  return {
    get mode() {
      return state.mode
    },
    toggleMax() {
      state.mode = state.mode === 'max' ? 'normal' : 'max'
    },
    minimize() {
      state.mode = 'min'
    },
    restore() {
      state.mode = 'normal'
    },
    reset() {
      state.mode = 'normal'
    }
  }
}
