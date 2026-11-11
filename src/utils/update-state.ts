import { reactive } from 'vue'
import { DEFAULT_UPDATE_FEED } from '../../electron/types'
import type { UpdateCheckResult, UpdateProgress } from '../../electron/types'

/**
 * 把配置里的更新源解析成真正要请求的地址。
 *
 * 空 = 用内置的 GitHub Releases（装完就能用，不需要用户配任何东西）。
 * 这个函数单独抽出来是为了能在冒烟里离线断言 —— 否则只能真发一次请求才知道解析对不对。
 */
export function resolveFeed(feed: string | undefined | null): string {
  const custom = (feed || '').trim()
  return custom || DEFAULT_UPDATE_FEED
}

/**
 * 检查更新的界面状态。
 *
 * 放在模块级而不是组件里：标题栏那个菜单项要显示"有新版本"的小圆点，
 * 弹窗里要显示完整结果，两处必须看同一份数据。用 Pinia 也行，但这点状态不值得单开一个 store。
 */
export const updateState = reactive({
  checking: false,
  /** 最近一次检查结果；null = 还没查过 */
  result: null as UpdateCheckResult | null,
  downloading: false,
  progress: { transferred: 0, total: 0, percent: 0, speed: 0 } as UpdateProgress,
  /** 下载完成后的本地路径 */
  filePath: '',
  /** 安装阶段给用户的一句话 */
  message: '',
  error: ''
})

export function resetDownload(): void {
  updateState.downloading = false
  updateState.progress = { transferred: 0, total: 0, percent: 0, speed: 0 }
  updateState.filePath = ''
  updateState.error = ''
}

/** 检查一次。返回结果方便调用方决定要不要弹窗（启动时的静默检查只看 available） */
export async function runCheck(feed: string): Promise<UpdateCheckResult | null> {
  if (updateState.checking) return updateState.result
  const target = resolveFeed(feed)
  updateState.checking = true
  updateState.error = ''
  updateState.message = ''
  resetDownload()
  try {
    updateState.result = await window.api.update.check(target)
  } catch (err) {
    updateState.result = {
      current: '',
      hasUpdate: false,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    updateState.checking = false
  }
  return updateState.result
}

/** 下载当前平台那个包。返回路径表示成功，null 表示用户取消 */
export async function runDownload(): Promise<string | null> {
  const asset = updateState.result?.asset
  if (!asset || updateState.downloading) return null
  updateState.downloading = true
  updateState.error = ''
  resetProgressOnly()
  const off = window.api.update.onProgress((p) => {
    updateState.progress = p
  })
  try {
    const res = await window.api.update.download(asset)
    if (!res) return null
    updateState.filePath = res.path
    return res.path
  } catch (err) {
    updateState.error = err instanceof Error ? err.message : String(err)
    return null
  } finally {
    off()
    updateState.downloading = false
  }
}

function resetProgressOnly(): void {
  updateState.progress = { transferred: 0, total: 0, percent: 0, speed: 0 }
  updateState.filePath = ''
}

export async function runInstall(): Promise<void> {
  if (!updateState.filePath) return
  try {
    updateState.message = await window.api.update.install(updateState.filePath)
  } catch (err) {
    updateState.error = err instanceof Error ? err.message : String(err)
  }
}

export function cancelDownload(): void {
  window.api.update.cancel()
}
