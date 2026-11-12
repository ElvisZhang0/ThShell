import { reactive } from 'vue'
import { DEFAULT_UPDATE_FEED } from '../../electron/types'
import type { UpdateAsset, UpdateCheckResult, UpdateProgress } from '../../electron/types'
// 把 "Error invoking remote method 'update:download': Error: xxx" 剥成 "xxx"。
// 那层壳是 Electron 在交代「哪条通道挂了」，用户只关心后半句。
import { cleanError } from '../stores/app'
import { plain } from './plain'

/**
 * 给界面看的"当前更新源"文案。
 *
 * 真正的通道选择在主进程里做（直连 + 国内加速镜像并发，谁先回用谁），
 * 所以配置留空时这里只能给个概括 —— 具体走了哪条，等结果回来有 `result.feed`。
 */
export function feedLabel(custom: string | undefined | null): string {
  const c = (custom || '').trim()
  return c || DEFAULT_UPDATE_FEED
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
  /** 安装包已下完，正在拉起安装程序 */
  installing: false,
  /**
   * 安装程序已经起来了。
   * 成功启动后要一直禁用按钮 —— Windows 上应用会被安睡程序顶掉退出，
   * 但退出前那一秒界面还活着，不禁用用户能连点两次、起两个安装进程互相抢文件。
   */
  launched: false,
  progress: { transferred: 0, total: 0, percent: 0, speed: 0 } as UpdateProgress,
  /** 下载完成后的本地路径。手动重装、排查问题时要用 */
  filePath: '',
  /** 安装阶段给用户的一句话 */
  message: '',
  error: ''
})

export function resetDownload(): void {
  updateState.downloading = false
  updateState.installing = false
  updateState.launched = false
  updateState.progress = { transferred: 0, total: 0, percent: 0, speed: 0 }
  updateState.filePath = ''
  updateState.error = ''
}

/** 检查一次。返回结果方便调用方决定要不要弹窗（启动时的静默检查只看 available） */
export async function runCheck(feed: string): Promise<UpdateCheckResult | null> {
  if (updateState.checking) return updateState.result
  // 空串交给主进程：它会在「直连 + 国内镜像」里并发挑一条能通的
  const target = (feed || '').trim()
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
      error: cleanError(err)
    }
  } finally {
    updateState.checking = false
  }
  return updateState.result
}

/**
 * 下载当前平台那个包。返回路径表示成功，null 表示取消或失败。
 *
 * ⚠️ 传参必须过 plain()：`result.asset` 是 reactive 包出来的嵌套 Proxy，
 * 直接丢给 ipcRenderer.invoke 会在结构化克隆那一步抛
 * "An object could not be cloned"（本文件曾经就是这个报错的源头）。
 */
export async function runDownload(): Promise<string | null> {
  const asset = updateState.result?.asset as UpdateAsset | undefined
  if (!asset || updateState.downloading) return null
  updateState.downloading = true
  updateState.error = ''
  resetProgressOnly()
  const off = window.api.update.onProgress((p) => {
    updateState.progress = p
  })
  try {
    const res = await window.api.update.download(plain(asset))
    if (!res) return null
    updateState.filePath = res.path
    return res.path
  } catch (err) {
    updateState.error = cleanError(err)
    return null
  } finally {
    off()
    updateState.downloading = false
  }
}

function resetProgressOnly(): void {
  updateState.progress = { transferred: 0, total: 0, percent: 0, speed: 0 }
  updateState.filePath = ''
  updateState.message = ''
}

/** 启动安装程序（已完成下载时单独调用；正常路径走 runUpgrade） */
export async function runInstall(): Promise<void> {
  if (!updateState.filePath || updateState.installing || updateState.launched) return
  updateState.installing = true
  updateState.error = ''
  // 渲染层拿不到 process.platform（关着 nodeIntegration），别为此开一条 IPC：
  // 每个平台真正要做的事，install 返回的那句话会讲清楚
  updateState.message = '正在启动安装程序…'
  try {
    updateState.message = await window.api.update.install(updateState.filePath)
    updateState.launched = true
  } catch (err) {
    updateState.error = cleanError(err)
  } finally {
    updateState.installing = false
  }
}

/**
 * 一键升级：下载 → 校验 → 直接拉起安装程序。
 *
 * 以前拆成「下载」「安装」两个按钮，用户的下一步动作是确定的（下完必然要装），
 * 让他在同一个对话框里点两次毫无意义。取消只在下载阶段有意义，所以取消按钮保留。
 *
 * 下载被取消或失败时不再往下走安装 —— runDownload 已经把原因写进 error 了。
 */
export async function runUpgrade(): Promise<void> {
  // 上一次已经下好了（比如自动安装失败后重试），直接重装，别重下 99MB
  const path = updateState.filePath || (await runDownload())
  if (!path) return
  await runInstall()
}

export function cancelDownload(): void {
  window.api.update.cancel()
}
