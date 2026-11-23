import { inject, onScopeDispose, provide, watch, type InjectionKey, type Ref } from 'vue'
import type { ViewKind } from '../stores/app'

/**
 * 面板「正在取数据」的上报通道。
 *
 * 文件/系统/容器三个页签各自异步拉远端数据，拉的时候整片区域是空的，
 * 光看内容分不出「还没开始」和「真的没有东西」。把各自的 loading 汇总到
 * SessionPane，由那边把页签图标换成转圈，用户才知道是自己点对了。
 *
 * 用 provide/inject 而不是全局单例：每个会话页各有一份，多开 tab 不串。
 */
export type PaneBusyReport = (kind: ViewKind, busy: boolean) => void

const PANE_BUSY: InjectionKey<PaneBusyReport> = Symbol('pane-busy')

export function providePaneBusy(report: PaneBusyReport): void {
  provide(PANE_BUSY, report)
}

/**
 * 在面板里调用：任一 source 为 true 就上报「忙」。
 * 不支持 inject（比如单独渲染面板做测试）时静默跳过。
 */
export function usePaneBusy(kind: ViewKind, ...sources: Ref<boolean>[]): void {
  const report = inject(PANE_BUSY, null)
  if (!report || !sources.length) return

  watch(
    sources,
    () => report(kind, sources.some((s) => s.value)),
    { immediate: true, flush: 'sync' }
  )

  // 面板被销毁（切 tab / 断连）时把转圈清掉，别留个一直转的图标
  onScopeDispose(() => report(kind, false))
}
