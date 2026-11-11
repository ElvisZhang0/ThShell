import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { ConfigStore } from './modules/config-store'
import { SshManager } from './modules/ssh-manager'
import { clearMetricsState, collectMetrics } from './modules/metrics'
import { collectSystemInfo } from './modules/sysinfo'
import {
  dockerCompose,
  dockerContainerAction,
  dockerContainerDetail,
  dockerContainerLogs,
  dockerContainers,
  dockerImages,
  dockerNetworks,
  dockerOverview,
  dockerPrune,
  dockerPullImage,
  dockerRemoveImage,
  dockerRemoveNetwork,
  dockerRemoveVolume,
  dockerVolumes,
  probeDocker
} from './modules/docker'
import {
  checkRemoteWritable,
  downloadDirectory,
  downloadRemote,
  listRemote,
  mkdirRemote,
  readRemoteBinary,
  readRemoteFile,
  readRemoteTail,
  removeRemote,
  renameRemote,
  uploadDirectory,
  uploadLocal,
  writeRemoteFile
} from './modules/sftp-service'
import { copyLocal, moveLocal, pasteRemote } from './modules/file-ops'
import {
  cancelDownload,
  checkForUpdates,
  compareVersions,
  downloadUpdate,
  installUpdate,
  parseManifest,
  pickAsset,
  withFallbackUrls
} from './modules/updater'
import {
  appendTransfer,
  clearTransferLog,
  loadTransferLog,
  removeTransfer
} from './modules/transfer-log'
import {
  isLocalWritable,
  listLocal,
  localDrives,
  localHome,
  localPlaces,
  mkdirLocal,
  openLocalPath,
  readLocalBinary,
  readLocalFile,
  readLocalTail,
  removeLocal,
  renameLocal,
  writeLocalFile
} from './modules/local-fs'
import { DEFAULT_UPDATE_FEEDS } from './types'
import type { AppInfo, FileEntry, PasteMode, ServerConfig, TransferProgress, UpdateAsset } from './types'
import type { TextEncoding } from './modules/text-guard'

const isDev = !!process.env.VITE_DEV_SERVER_URL
const store = new ConfigStore()

let mainWindow: BrowserWindow | null = null
/** 最近一次 sftp:list 的会话 id，仅冒烟模式使假进度用 */
let lastSessionId = ''

/** preload 事件统一从这里出，窗口销毁后 send 会抛，用 safeSend 兜一层 */
function safeSend(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

const ssh = new SshManager(
  (payload) => safeSend('ssh:data', payload),
  (payload) => safeSend('ssh:state', payload)
)

/** 统一把异常转成前端可直接展示的中文消息 */
function register(channel: string, handler: (...args: any[]) => any): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await handler(...args)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(message)
    }
  })
}

/**
 * 不要原生菜单栏。
 *
 * 这个应用的功能全在自己的界面里（标题栏有新建 / 导入 / 设置），而 Electron 的默认菜单
 * 是英文的 File / Edit / View / Window / Help，里面还挂着 Reload 和 Toggle Developer Tools。
 * 它平时被 `autoHideMenuBar` 藏着，**但按一下 Alt 就会冒出来**，还把自绘标题栏顶下去一截，
 * 看着像界面坏了。所以直接摘掉 —— Windows / Linux 上"没有菜单栏"本来就是正常形态。
 */
function setupAppMenu(): void {
  if (process.platform === 'darwin') {
    // macOS 没有"无菜单"这个选项：删干净之后 Cmd+C / Cmd+V / Cmd+Q 全都没了。
    // 只留最小的三组，菜单文字交给系统本地化
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    )
    return
  }
  Menu.setApplicationMenu(null)
}

function createWindow(): void {
  // 打包后 __dirname 在 app.asar 内，Electron 的 fs 补丁能直接读 asar 里的 png
  const iconPath = path.join(__dirname, '../resources/icon.png')

  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    title: 'ThShell',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#141821',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox 关闭：preload 里需要 Node 的 Buffer 做编码转换；
      // 页面本身没有 node 权限，风险可控。
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 菜单摘掉后，Reload / DevTools 的快捷键一并消失（它们本来挂在菜单项上）。
  // 开发时还要用，所以自己接回来：F12 或 Ctrl+Shift+I 开关开发者工具。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = (input.key || '').toLowerCase()
    const isF12 = input.key === 'F12'
    const isCtrlShiftI = input.control && input.shift && key === 'i'
    if (!isF12 && !isCtrlShiftI) return
    mainWindow?.webContents.toggleDevTools()
    event.preventDefault()
  })

  // 页面加载失败时也要把窗口亮出来。show:false 配 ready-to-show 的写法有个坑：
  // 一旦 did-fail-load，窗口会永远隐藏，表现就是「点了没反应」，很容易误判成
  // Electron 根本没启动。
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error(`[window] 页面加载失败：${code} ${desc} ${url}`)
    mainWindow?.show()
  })

  // 再兜一层：5 秒还没显示就强制亮出来，宁可看到一个空白窗口也不要静默
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('[window] ready-to-show 未触发，强制显示窗口')
      mainWindow.show()
    }
  }, 5000)

  /**
   * 自动化冒烟入口：THSHELL_SMOKE=1 启动 → 截图写到系统临时目录 → 自动退出。
   * 改完界面跑一次，不用人工开窗口就能确认没有白屏、错位或样式崩坏。
   */
  if (process.env.THSHELL_SMOKE) {
    const mode = process.env.THSHELL_SMOKE
    mainWindow.webContents.once('did-finish-load', async () => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const js = (code: string) => mainWindow!.webContents.executeJavaScript(code)
      /**
       * 把渲染进程的 warn/error 转出来。
       * 冒烟断言全是"看界面长什么样"，而界面坏了之前往往先在控制台留一句原因
       * （比如 PDF 渲染失败会 console.warn 一个 RenderingCancelledException 之外的东西），
       * 不转出来就只剩一个 FAIL，还得反复猜。THSHELL_SMOKE_WEBLOG=1 连 info 也打。
       */
      const webLogAll = process.env.THSHELL_SMOKE_WEBLOG === '1'
      mainWindow!.webContents.on('console-message', (...args: unknown[]) => {
        // Electron 33 是 (event, level, message, line, source)，新版收成一个 details 对象
        const details = args[1] as { level?: string | number; message?: string }
        const level = typeof details === 'object' ? details.level : (args[1] as number)
        const message = typeof details === 'object' ? details.message : (args[2] as string)
        if (!message) return
        const loud = level === 2 || level === 3 || level === 'warning' || level === 'error'
        if (!loud && !webLogAll) return
        console.log(`[web] ${message}`)
      })
      // 默认丢系统临时目录；需要留档给用户看时用 THSHELL_SHOT_DIR 指到指定目录
      const shotDir = process.env.THSHELL_SHOT_DIR || os.tmpdir()
      const shot = async (name: string) => {
        try {
          if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true })
          // 窗口被别的窗口盖住 / 最小化时，capturePage 会返回**上一帧**：
          // 断言全绿但截图停在几秒前的画面上，最容易让人误判"功能没生效"
          try {
            mainWindow!.show()
            mainWindow!.moveTop()
            // moveTop 之后要等合成器真的画一帧；不等的话拿到的是"上移之前"的那张
            await new Promise((r) => setTimeout(r, 250))
          } catch {
            /* 窗口状态异常不该让截图失败 */
          }
          const image = await mainWindow!.capturePage()
          fs.writeFileSync(path.join(shotDir, name), image.toPNG())
        } catch (err) {
          console.error('[smoke] 截图失败', err)
        }
      }

      /**
       * 冒烟收尾统一走这里。
       * 用 app.quit() 时偶尔退不掉：before-quit 里要断开 SSH，而卸载 xterm 那一套
       * 可能卡住，进程就挂在那儿、还占着单实例锁，让下一次冒烟静默退出。
       * 冒烟实例没有"正常关闭"的需求，断完连接直接 exit 更省事。
       */
      const finish = () => {
        try {
          ssh.disconnectAll()
        } catch {
          /* 已经断了就算了 */
        }
        app.exit(0)
      }

      /**
       * sh 模式：不开界面，直接在一个会话里跑命令，把输出打到控制台。
       * 纯诊断用（比开窗口点来点去快）：THSHELL_SMOKE=sh THSHELL_SH_CMD="cmd1;;cmd2"
       * THSHELL_SH_HOST 指定主机（默认配置里第一台）。
       */
      if (mode === 'sh') {
        const cfg = store.load()
        const host = process.env.THSHELL_SH_HOST
        const srv = host ? cfg.servers.find((s) => s.host === host) : cfg.servers[0]
        if (!srv) {
          console.log('[sh] 找不到服务器')
          finish()
          return
        }
        const sessionId = await ssh.connect(srv, 200, 50)
        const cmds = (process.env.THSHELL_SH_CMD || 'uname -a').split(';;')
        for (const cmd of cmds) {
          const res = await ssh.exec(sessionId, cmd)
          console.log(`\n### ${cmd}\n${(res.stdout || '').trim()}`)
          if (res.stderr?.trim()) console.log(`[stderr] ${res.stderr.trim()}`)
        }
        finish()
        return
      }

      /**
       * shots 模式：只做「把每个页面截齐」这一件事，不做断言。
       * 用 THSHELL_SHOT_DIR 指到项目外的目录，跑一次得到全套界面截图，用来交付/目检。
       * 顺序刻意从静态页走到活数据页：弹窗会抢焦点，放在最前面截完就关掉。
       */
      if (mode === 'shots') {
        await wait(1800)
        await shot('01-welcome.png')

        // 新建连接弹窗
        await js(`document.querySelectorAll('.actions .el-button')[0]?.click()`)
        await wait(900)
        await shot('02-dialog-new-server.png')
        await js(`document.querySelector('.el-dialog__headerbtn')?.click()`)
        await wait(500)

        // 设置弹窗（第三个按钮是圆形图标按钮）
        await js(`document.querySelector('.actions .el-button.is-circle')?.click()`)
        await wait(800)
        await shot('03-dialog-settings.png')
        await js(`document.querySelector('.el-dialog__headerbtn')?.click()`)
        await wait(400)

        // 双击侧栏第一台服务器，走完 配置→IPC→SSH→终端
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(5500)
        await shot('04-terminal.png')

        const seg = (text: string) =>
          js(
            `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('${text}'))?.click()`
          )

        await seg('文件')
        await wait(2000)
        await shot('05-files.png')

        // 监控页要等两次采样做差分，别截太早（否则 CPU 曲线是空的）
        await seg('监控')
        await wait(3500)
        await shot('06-monitor.png')

        await seg('系统')
        await wait(3000)
        await shot('07-system.png')

        // 浅色主题下再看一眼系统页和文件页（浅色最容易暴露对比度问题）
        await js(`document.documentElement.dataset.theme = 'light'`)
        await wait(900)
        await shot('08-system-light.png')
        await seg('文件')
        await wait(1400)
        await shot('09-files-light.png')

        // 切回深色截右键菜单：远程栏第一行，菜单里是全套文件操作
        await js(`document.documentElement.dataset.theme = 'dark'`)
        await wait(700)
        await js(
          `(() => {
            const row = document.querySelectorAll('.fm .panes .pane')[1]?.querySelector('.row')
            if (!row) return 'no-row'
            const r = row.getBoundingClientRect()
            row.dispatchEvent(new MouseEvent('contextmenu', {
              bubbles: true, cancelable: true, clientX: r.left + 120, clientY: r.top + 12
            }))
            return 'ok'
          })()`
        )
        await wait(600)
        await shot('10-remote-menu.png')

        finish()
        return
      }

      /**
       * nativebar 模式：验证「切浅色后 Windows 原生标题栏跟着变浅」。
       * capturePage 只能截 web 内容，截不到系统标题栏，所以用 desktopCapturer 截全屏。
       * 启动后先把主题从配置值切到 light（走 applyTheme → IPC → nativeTheme 真链路），
       * 等 DWM 生效再截屏；再切回 dark 截一张对照。
       */
      if (mode === 'nativebar') {
        await wait(2500)
        await js(
          `(() => { const s = window.__store; if (!s) return 'no-store';
            s.config.settings.theme = 'light'; s.applyTheme(); return 'ok' })()`
        )
        await wait(1500)
        const grab = async (name: string) => {
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 2560, height: 1440 }
          })
          if (sources[0]) fs.writeFileSync(path.join(shotDir, name), sources[0].thumbnail.toPNG())
        }
        await grab('native-titlebar-light.png')
        await js(
          `(() => { const s = window.__store; s.config.settings.theme = 'dark'; s.applyTheme(); return 'ok' })()`
        )
        await wait(1500)
        await grab('native-titlebar-dark.png')
        console.log('[smoke] nativebar 完成')
        finish()
        return
      }

      /**
       * docker 模式：连第一台服务器 → 等「容器」页签出现（说明 probe 命中）→
       * 截图容器/镜像/概览/日志/详情，并把行数打到控制台当断言。
       * 没装 docker 的机器上这个页签不该出现，这里也顺便验证一下。
       */
      if (mode === 'docker') {
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(5500)

        const clickSeg = (text: string) =>
          js(
            `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('${text}'))?.click()`
          )

        // 等 probe 回来（多台机器可能要走一次 docker info）
        let hasTab = false
        for (let i = 0; i < 40; i++) {
          hasTab = (await js(
            `!![...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('容器'))`
          )) as boolean
          if (hasTab) break
          await wait(250)
        }
        console.log(`[smoke] ${hasTab ? 'PASS' : 'FAIL'} 「容器」页签${hasTab ? '已出现' : '没有出现'}`)
        if (!hasTab) {
          finish()
          return
        }

        await clickSeg('容器')
        await wait(3000)
        // 诊断：直接在主进程跑一遍 docker ps，和界面渲染对照，"行数 0"才能分清是没容器还是解析挂了
        try {
          const sid = (await js(`window.__store?.tabs.find((t) => t.sessionId)?.sessionId || ''`)) as string
          if (sid) {
            const raw = await ssh.exec(sid, `docker ps -a --format '{{json .}}' 2>&1 | head -2`)
            console.log(
              `[smoke] docker ps 原始输出(code=${raw.code}): ${JSON.stringify(raw.stdout.slice(0, 240))}`
            )
          }
        } catch (err) {
          console.log('[smoke] docker ps 诊断失败', err)
        }
        const rows = (await js(`document.querySelectorAll('.dk .row').length`)) as number
        const states = (await js(
          `[...document.querySelectorAll('.dk .row .pill')].map((e) => e.textContent.trim()).slice(0, 8)`
        )) as string[]
        console.log(`[smoke] ${rows > 0 ? 'PASS' : 'FAIL'} 容器行数=${rows} 状态=${states.join('/')}`)
        await shot('thshell-docker-containers.png')

        // 日志弹窗（取第一个容器的日志按钮）
        await js(`document.querySelector('.dk .row [data-op="logs"]')?.click()`)
        await wait(2500)
        const logLen = (await js(
          `(document.querySelector('.log-body')?.textContent || '').trim().length`
        )) as number
        console.log(`[smoke] ${logLen > 20 ? 'PASS' : 'FAIL'} 日志长度=${logLen}`)
        await shot('thshell-docker-logs.png')
        await js(`document.querySelector('.log-dialog .el-dialog__headerbtn')?.click()`)
        await wait(600)

        // 详情（stats + inspect 关键字段）
        await js(`document.querySelector('.dk .row [data-op="detail"]')?.click()`)
        await wait(2500)
        const detailRows = (await js(`document.querySelectorAll('.detail-list .kv').length`)) as number
        console.log(`[smoke] ${detailRows > 5 ? 'PASS' : 'FAIL'} 详情字段=${detailRows}`)
        await shot('thshell-docker-detail.png')
        // 关弹窗要用各自的 class 精确匹配：两个 dialog 的 headerbtn 结构一样，
        // 全局 querySelector 会命中已经关掉的那个，等于没关
        await js(`document.querySelector('.detail-dialog .el-dialog__headerbtn')?.click()`)
        await wait(800)

        await clickSeg('镜像')
        await wait(2200)
        const imgRows = (await js(`document.querySelectorAll('.dk .row').length`)) as number
        console.log(`[smoke] ${imgRows > 0 ? 'PASS' : 'FAIL'} 镜像行数=${imgRows}`)
        await shot('thshell-docker-images.png')

        await clickSeg('概览')
        await wait(2200)
        await shot('thshell-docker-overview.png')

        await clickSeg('网络')
        await wait(1800)
        const netRows = (await js(`document.querySelectorAll('.dk .row').length`)) as number
        console.log(`[smoke] ${netRows > 0 ? 'PASS' : 'FAIL'} 网络行数=${netRows}`)
        await shot('thshell-docker-networks.png')

        await clickSeg('卷')
        await wait(1800)
        const volRows = (await js(`document.querySelectorAll('.dk .row').length`)) as number
        console.log(`[smoke] ${volRows > 0 ? 'PASS' : 'FAIL'} 卷行数=${volRows}`)
        await shot('thshell-docker-volumes.png')

        // 进入容器终端：点第一行的 shell 按钮，会切到终端页并执行 docker exec -it
        // 有些镜像（distroless/scratch）没有 sh，失败也正常，只截图不断言。
        // 注意：clickSeg 只切顶层页签，Docker 面板内部的子页签还停在「卷」，
        // 要再点 .dk-sub 里的「容器」子页签，shell 按钮才存在。
        await clickSeg('容器')
        await wait(1500)
        await js(
          `[...document.querySelectorAll('.dk-sub .seg-btn')].find((b) => b.textContent.includes('容器'))?.click()`
        )
        await wait(2500)
        try {
          await js(`document.querySelector('.dk .row [data-op="shell"]')?.click()`)
          await wait(4000)
          const buf = (await js(
            `(document.querySelector('.xterm-rows')?.textContent || '').slice(-300)`
          )) as string
          console.log(`[smoke] exec 终端尾部=${JSON.stringify(buf.slice(-120))}`)
          await shot('thshell-docker-exec.png')
          // 退出容器，别把 shell 卡在容器里
          await js(
            `(() => { const s = window.__store; const t = s.tabs.find((x) => x.sessionId); return t ? t.id : '' })()`
          )
        } catch (err) {
          console.log('[smoke] exec 终端跳过', err)
        }

        finish()
        return
      }

      /**
       * uploaddir 模式：验证「上传文件夹」。
       * 造一个含子目录 + 空目录的本地临时目录，走 preload 的真链路 uploadDir 传到
       * 远程 /tmp，再用 ssh find 核对结构（空目录在不在是关键 —— 只传文件的话它会丢），
       * 顺便截图「上传到远程」的下拉菜单。跑完两端都清理。
       */
      if (mode === 'uploaddir') {
        const src = path.join(os.tmpdir(), 'thshell-upload-src')
        const remoteTest = '/tmp/thshell-upload-test'
        fs.rmSync(src, { recursive: true, force: true })
        fs.mkdirSync(path.join(src, 'sub'), { recursive: true })
        fs.mkdirSync(path.join(src, 'empty', 'deeper'), { recursive: true })
        fs.writeFileSync(path.join(src, 'a.txt'), 'hello thshell\n')
        fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'nested\n')

        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(5000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(2000)

        // 下拉菜单截图：确认「上传文件夹」在菜单里
        await js(
          `[...document.querySelectorAll('footer button')].find((b) => b.textContent.includes('上传到远程'))?.click()`
        )
        await wait(700)
        const menuLabels = (await js(
          `[...document.querySelectorAll('.el-dropdown-menu__item')].map((e) => e.textContent.trim())`
        )) as string[]
        console.log(`[smoke] ${menuLabels.some((l) => l.includes('文件夹')) ? 'PASS' : 'FAIL'} 菜单=${JSON.stringify(menuLabels)}`)
        await shot('thshell-upload-menu.png')
        await js(`document.body.click()`)
        await wait(400)

        const sid = (await js(
          `window.__store?.tabs.find((t) => t.sessionId)?.sessionId || ''`
        )) as string
        console.log(`[smoke] ${sid ? 'PASS' : 'FAIL'} sessionId=${sid ? 'ok' : '空'}`)
        if (sid) {
          await ssh.exec(sid, `rm -rf ${remoteTest}`)
          const res = (await js(
            `window.api.sftp.uploadDir(${JSON.stringify(sid)}, ${JSON.stringify(src)}, ${JSON.stringify(remoteTest)})`
          )) as { total: number; uploaded: number; failed: unknown[] }
          console.log(
            `[smoke] ${res.total === 2 && res.uploaded === 2 ? 'PASS' : 'FAIL'} 上传 ${res.uploaded}/${res.total} 失败=${res.failed.length}`
          )
          const tree = await ssh.exec(sid, `cd ${remoteTest} && find . | sort`)
          const lines = tree.stdout.trim().split('\n')
          const hasEmpty = lines.includes('./empty') && lines.includes('./empty/deeper')
          const hasNested = lines.includes('./sub/b.txt')
          console.log(
            `[smoke] ${hasEmpty ? 'PASS' : 'FAIL'} 空目录已建=${hasEmpty}；${hasNested ? 'PASS' : 'FAIL'} 子目录文件=${hasNested}`
          )
          console.log(`[smoke] 远端树=${JSON.stringify(lines.join(' '))}`)

          // 真传一次就该落一条记录 —— 这条走的是完整的 IPC → reporter → 落盘链路，
          // 上面 transfer 模式里那两条是手塞的，证明不了"真实传输会记账"
          const rec = loadTransferLog().find((r) => r.from === src && r.to === remoteTest)
          const okRec = !!rec && rec.dir === true && rec.direction === 'upload' && rec.size > 0
          console.log(
            `[smoke] ${okRec ? 'PASS' : 'FAIL'} 上传已记入传输记录：${
              rec ? `${rec.name} ${rec.from} → ${rec.to}（${rec.size} 字节）` : '没找到'
            }`
          )
          // 冒烟造的记录不留在用户真实历史里
          if (rec) removeTransfer([rec.id])

          await ssh.exec(sid, `rm -rf ${remoteTest}`)
        }
        fs.rmSync(src, { recursive: true, force: true })
        finish()
        return
      }

      /**
       * editor 模式：验证 CodeMirror 编辑器。
       * 双击远程 /root/.bashrc 打开编辑器，断言 .cm-editor / 行号 / 语法高亮是否渲染，
       * 再切浅色主题截一张（主题是 Compartment 热替换，不该重建编辑器）。
       */
      if (mode === 'editor') {
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(5000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(2000)

        const opened = (await js(
          `(() => {
            // 只在第二个 .rows（远程栏）里找：本地 C:\\Users\\13311 恰好也有个空的 .bashrc
            const rows = document.querySelectorAll('.rows')[1]?.querySelectorAll('.row') ?? []
            const row = [...rows].find((r) => r.textContent.includes('.bashrc'))
            if (!row) return 'no-row'
            row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
            return 'ok'
          })()`
        )) as string
        console.log(`[smoke] ${opened === 'ok' ? 'PASS' : 'FAIL'} 打开文件=${opened}`)
        await wait(1800)

        const hasCm = (await js(`!!document.querySelector('.edit-dialog .cm-editor')`)) as boolean
        const lines = (await js(`document.querySelectorAll('.edit-dialog .cm-line').length`)) as number
        const gutters = (await js(`document.querySelectorAll('.edit-dialog .cm-lineNumbers .cm-gutterElement').length`)) as number
        const tokens = (await js(`document.querySelectorAll('.edit-dialog .cm-line span[class*="ͼ"]').length`)) as number
        console.log(`[smoke] ${hasCm ? 'PASS' : 'FAIL'} CodeMirror 挂载=${hasCm}`)
        console.log(`[smoke] ${lines > 0 ? 'PASS' : 'FAIL'} 渲染行数=${lines} 行号=${gutters}`)
        console.log(`[smoke] ${tokens > 0 ? 'PASS' : 'FAIL'} 高亮 token=${tokens}`)
        await shot('thshell-editor-dark.png')

        await js(
          `(() => { const s = window.__store; s.config.settings.theme = 'light'; s.applyTheme(); return 'ok' })()`
        )
        await wait(1200)
        await shot('thshell-editor-light.png')

        // 切回深色，别把用户配置留成浅色
        await js(
          `(() => { const s = window.__store; s.config.settings.theme = 'dark'; s.applyTheme(); return 'ok' })()`
        )
        await wait(600)
        await js(`document.querySelector('.edit-dialog .el-dialog__headerbtn')?.click()`)
        await wait(600)
        finish()
        return
      }

      /**
       * office 模式：验证办公文档只读预览。
       * 依赖环境里预置的三个测试文件（mkfixtures 生成在用户主目录）：
       * thshell-preview-test.docx / .xlsx / .pptx，分别覆盖 docx 渲染、xlsx 表格 + 多 sheet、
       * 以及"不支持预览"的提示分支。
       */
      if (mode === 'office') {
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(5000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(2500)

        const openLocalFile = (suffix: string) =>
          js(
            `(() => {
              const rows = document.querySelectorAll('.rows')[0]?.querySelectorAll('.row') ?? []
              const row = [...rows].find((r) => r.textContent.includes('thshell-preview-test.${suffix}'))
              if (!row) return 'no-row'
              row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
              return 'ok'
            })()`
          )
        const closeDialog = () =>
          js(`document.querySelector('.preview-dialog .el-dialog__headerbtn')?.click()`)

        // ---- docx ----
        console.log(`[smoke] 打开 docx: ${await openLocalFile('docx')}`)
        await wait(3000)
        const docxPages = (await js(
          `document.querySelectorAll('.preview-dialog section.docx').length`
        )) as number
        const docxText = (await js(
          `(document.querySelector('.preview-dialog .docx-host')?.textContent || '').slice(0, 80)`
        )) as string
        console.log(`[smoke] ${docxPages > 0 ? 'PASS' : 'FAIL'} docx 页数=${docxPages} 文本=${JSON.stringify(docxText.trim())}`)
        await shot('thshell-office-docx.png')
        await closeDialog()
        await wait(700)

        // ---- xlsx ----
        console.log(`[smoke] 打开 xlsx: ${await openLocalFile('xlsx')}`)
        await wait(2500)
        const cells = (await js(`document.querySelectorAll('.preview-dialog .sheet-body td').length`)) as number
        const tabs = (await js(
          `[...document.querySelectorAll('.preview-dialog .sheet-tab')].map((e) => e.textContent.trim())`
        )) as string[]
        const firstCell = (await js(
          `document.querySelector('.preview-dialog .sheet-body td')?.textContent?.trim() || ''`
        )) as string
        console.log(`[smoke] ${cells > 10 ? 'PASS' : 'FAIL'} 单元格=${cells} sheet=${JSON.stringify(tabs)} 首格=${JSON.stringify(firstCell)}`)
        await shot('thshell-office-xlsx.png')
        // 切第二个 sheet
        if (tabs.length > 1) {
          await js(`document.querySelectorAll('.preview-dialog .sheet-tab')[1]?.click()`)
          await wait(600)
          const secondCell = (await js(
            `document.querySelector('.preview-dialog .sheet-body td')?.textContent?.trim() || ''`
          )) as string
          console.log(`[smoke] ${secondCell === '指标' ? 'PASS' : 'FAIL'} 第二个 sheet 首格=${JSON.stringify(secondCell)}`)
          await shot('thshell-office-xlsx-sheet2.png')
        }
        await closeDialog()
        await wait(700)

        // ---- pptx：应当落到"不支持预览"的提示 ----
        console.log(`[smoke] 打开 pptx: ${await openLocalFile('pptx')}`)
        await wait(1800)
        const tip = (await js(
          `!!document.querySelector('.preview-dialog .office-tip')`
        )) as boolean
        console.log(`[smoke] ${tip ? 'PASS' : 'FAIL'} pptx 走了提示分支=${tip}`)
        await closeDialog()
        await wait(500)

        // ---- 远程 docx：走 sftp readBinary 的真链路 ----
        const sid = (await js(
          `window.__store?.tabs.find((t) => t.sessionId)?.sessionId || ''`
        )) as string
        if (sid) {
          const sftp = await ssh.getSftp(sid)
          // onProgress 必须给：uploadLocal 里 reporter 会直接调用它，缺了就是 TypeError
          await uploadLocal(
            sftp,
            path.join(os.homedir(), 'thshell-preview-test.docx'),
            '/root/thshell-preview-test.docx',
            () => {},
            sid
          )
          // 上传不会自动刷新列表，按 F5 刷新远程栏（先点一下远程行把焦点切过去）
          await js(
            `[...document.querySelectorAll('.rows')[1]?.querySelectorAll('.row') ?? []][0]?.click()`
          )
          await js(
            `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }))`
          )
          await wait(1500)
          const ls = await ssh.exec(sid, 'ls -la /root/thshell-preview-test.docx 2>&1')
          console.log(`[smoke] 远端文件: ${ls.stdout.trim()}`)
          const remoteRowCount = (await js(
            `document.querySelectorAll('.rows')[1]?.querySelectorAll('.row').length ?? 0`
          )) as number
          console.log(`[smoke] 远程栏行数=${remoteRowCount}`)
          const openRemote = await js(
            `(() => {
              const rows = document.querySelectorAll('.rows')[1]?.querySelectorAll('.row') ?? []
              const row = [...rows].find((r) => r.textContent.includes('thshell-preview-test.docx'))
              if (!row) return 'no-row'
              row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
              return 'ok'
            })()`
          )
          await wait(3000)
          const remotePages = (await js(
            `document.querySelectorAll('.preview-dialog section.docx').length`
          )) as number
          const badge = (await js(
            `document.querySelector('.preview-dialog .edit-badge')?.textContent?.trim() || ''`
          )) as string
          console.log(
            `[smoke] ${remotePages > 0 && badge === '远程' ? 'PASS' : 'FAIL'} 远程 docx 页数=${remotePages} 徽标=${badge} 打开=${openRemote}`
          )
          await shot('thshell-office-docx-remote.png')
          await closeDialog()
          await wait(500)
          await ssh.exec(sid, 'rm -f /root/thshell-preview-test.docx')
        }

        finish()
        return
      }

      // tabs 模式：验证页签栏的右键菜单（关闭当前 / 其他 / 左侧 / 右侧）。      // 用真实连接铺数据要 4 次 SSH 握手，连不上的还得等超时，所以走 ?smoke=1 挂出来的
      // store 后门直接塞假页签，重点看"菜单项、禁用态、关闭后还剩谁"。
      if (mode === 'tabs') {
        await wait(1500)

        const seed = async (n: number, active: number) =>
          js(`(() => {
            const s = window.__store
            if (!s) return 'no-store'
            s.tabs.splice(0, s.tabs.length)
            for (let i = 0; i < ${n}; i++) {
              s.tabs.push({
                id: 'tab-' + i,
                sessionId: '',
                serverId: 'srv-' + i,
                title: 'demo-' + (i + 1),
                subtitle: 'root@10.0.0.' + (i + 1),
                status: 'connected',
                view: 'terminal',
                epoch: 0
              })
            }
            s.activeTabId = s.tabs[${active}].id
            return s.tabs.length
          })()`)

        const rightClickTab = (i: number) =>
          js(`(() => {
            const el = document.querySelectorAll('.tabbar .tab')[${i}]
            if (!el) return 'no-tab'
            const r = el.getBoundingClientRect()
            el.dispatchEvent(new MouseEvent('contextmenu', {
              bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.top + 12
            }))
            return 'ok'
          })()`)

        /** 空白区域右键：不指向任何页签，应该落到当前活动页签上 */
        const rightClickBlank = () =>
          js(`(() => {
            const el = document.querySelector('.tabbar .tabs')
            if (!el) return 'no-bar'
            const r = el.getBoundingClientRect()
            el.dispatchEvent(new MouseEvent('contextmenu', {
              bubbles: true, cancelable: true, clientX: r.right - 6, clientY: r.top + 12
            }))
            return 'ok'
          })()`)

        const readMenu = () =>
          js(`(() => {
            const m = document.querySelector('.ctx-menu')
            if (!m) return null
            return [...m.querySelectorAll('.ctx-item')].map((e) => ({
              text: e.textContent.trim(),
              disabled: e.classList.contains('disabled')
            }))
          })()`) as Promise<{ text: string; disabled: boolean }[] | null>

        const clickItem = (text: string) =>
          js(`(() => {
            const el = [...document.querySelectorAll('.ctx-menu .ctx-item')]
              .find((e) => e.textContent.includes('${text}'))
            if (!el) return 'no-item'
            el.click()
            return 'ok'
          })()`)

        const readTabs = () =>
          js(`(() => {
            const s = window.__store
            return { count: s.tabs.length, ids: s.tabs.map((t) => t.id), active: s.activeTabId }
          })()`) as Promise<{ count: number; ids: string[]; active: string }>

        /**
         * 等菜单出现再读，别写死 wait。
         * v-if 卸载→重挂之间有一帧的间隔，固定 300ms 偶尔会读到"菜单还不存在"，
         * 表现为禁用态断言莫名 FAIL（上一版就踩了）。
         */
        const waitMenu = async () => {
          for (let i = 0; i < 30; i++) {
            const items = await readMenu()
            if (items?.length) return items
            await wait(50)
          }
          return null
        }

        const stateOf = async (text: string) => {
          const items = await waitMenu()
          return items?.find((i) => i.text.includes(text))?.disabled
        }

        const checks: [string, boolean, string][] = []

        // 5 个页签，活动页在中间；右键第 2 个
        await seed(5, 2)
        await wait(250)
        await rightClickTab(1)
        let items = await waitMenu()
        checks.push(['菜单项数量', items?.length === 4, `${items?.length} 项（期望 4）`])
        checks.push([
          '菜单文案',
          (items ?? []).map((i) => i.text.replace(/\s+/g, '')).join('/') ===
            '关闭当前标签页/关闭其他标签页/关闭左侧标签页/关闭右侧标签页',
          (items ?? []).map((i) => i.text).join(' | ')
        ])
        checks.push(['5 个页签时四项全可用', (items ?? []).every((i) => !i.disabled), ''])

        // 关闭左侧：应只剩被右键的那个及其右侧
        checks.push(['点中「关闭左侧」', (await clickItem('关闭左侧')) === 'ok', ''])
        await wait(300)
        let tabs = await readTabs()
        checks.push(['关闭左侧', tabs.count === 4 && tabs.ids[0] === 'tab-1', tabs.ids.join(',')])
        checks.push(['关闭左侧后活动页不变', tabs.active === 'tab-2', tabs.active])

        // 第一个页签 → 左侧禁用；最后一个 → 右侧禁用
        await rightClickTab(0)
        checks.push(['首项时「关闭左侧」禁用', (await stateOf('关闭左侧')) === true, ''])
        checks.push(['「关闭其他」仍可用', (await stateOf('关闭其他')) === false, ''])

        // 空白处右键：不指向任何页签，应作用于当前活动页签
        await js('window.__store.activeTabId = window.__store.tabs[0].id')
        await rightClickBlank()
        checks.push(['空白处右键能弹菜单', (await waitMenu())?.length === 4, ''])

        checks.push(['点中「关闭右侧」', (await clickItem('关闭右侧')) === 'ok', ''])
        await wait(300)
        tabs = await readTabs()
        checks.push(['关闭右侧', tabs.count === 1 && tabs.ids[0] === 'tab-1', tabs.ids.join(',')])

        // 只剩一个页签：其他/左/右三项都该禁用，「关闭当前」仍可用
        await rightClickTab(0)
        checks.push(['单页签时「关闭其他」禁用', (await stateOf('关闭其他')) === true, ''])
        checks.push(['单页签时「关闭左侧」禁用', (await stateOf('关闭左侧')) === true, ''])
        checks.push(['单页签时「关闭右侧」禁用', (await stateOf('关闭右侧')) === true, ''])
        checks.push(['单页签时「关闭当前」可用', (await stateOf('关闭当前')) === false, ''])

        checks.push(['点中「关闭当前」', (await clickItem('关闭当前')) === 'ok', ''])
        await wait(300)
        tabs = await readTabs()
        checks.push(['关闭当前', tabs.count === 0 && tabs.active === '', `${tabs.count} 个 / active=${tabs.active || '空'}`])

        /**
         * 截图放在所有交互断言之后，单独一轮。
         * capturePage 会让窗口短暂失焦，而失焦会触发菜单的 closeMenu ——
         * 先截图再点菜单项，就会出现"断言全过、点击全落空"的诡异现象（踩过）。
         */
        await seed(5, 2)
        await wait(250)
        await rightClickTab(1)
        await waitMenu()
        await wait(500)
        await shot('thshell-tabs-menu.png')

        await seed(1, 0)
        await wait(250)
        await rightClickTab(0)
        await waitMenu()
        await wait(500)
        await shot('thshell-tabs-disabled.png')

        let failed = 0
        for (const [name, ok, detail] of checks) {
          if (!ok) failed += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`)
        }
        console.log(`[smoke] tabs ${failed ? failed + ' 项失败' : '全部通过'}`)

        finish()
        return
      }

      // edit 模式：双击文件进内置编辑器（本地 + 远程），验证"能编辑的判断、读、改、存"整条链路。
      // 用真实的临时目录和 /etc 下的真文件，别拿假数据糊过去 —— 读写落到磁盘才算数。
      if (mode === 'edit') {
        await wait(1500)

        const dir = path.join(os.tmpdir(), 'thshell-edit-smoke')
        fs.rmSync(dir, { recursive: true, force: true })
        fs.mkdirSync(dir, { recursive: true })
        const textFile = path.join(dir, 'conf.txt')
        const binFile = path.join(dir, 'blob.bin')
        fs.writeFileSync(textFile, 'server {\n  listen 80;\n}\n', 'utf-8')
        // 头几个字节就给 NUL，模拟"扩展名看不出来但确实是二进制"的文件
        fs.writeFileSync(binFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]))

        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(5000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(1800)

        /** 把某一栏切到指定目录：路径输入框是 v-model，得先派发 input 再回车 */
        const goto = (pane: number, target: string) =>
          js(`(() => {
            const el = document.querySelectorAll('.fm .pane')[${pane}]?.querySelector('.path-input')
            if (!el) return 'no-input'
            el.value = ${JSON.stringify(target)}
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
            return 'ok'
          })()`)

        const dblclickRow = (pane: number, name: string) =>
          js(`(() => {
            const rows = document.querySelectorAll('.fm .pane')[${pane}]?.querySelectorAll('.rows .row') || []
            const row = [...rows].find((r) => r.textContent.includes(${JSON.stringify(name)}))
            if (!row) return 'no-row'
            row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
            return 'ok'
          })()`)

        const editorState = () =>
          js(`(() => {
            const dlg = document.querySelector('.edit-dialog')
            if (!dlg) return null
            // 编辑器换成 CodeMirror 之后没有 textarea 了，内容在 .cm-line 里
            const lines = [...dlg.querySelectorAll('.cm-line')].map((l) => l.textContent)
            // el-dialog 关掉后外壳可能还留在 DOM 里（display:none），不能只看节点在不在
            const overlay = dlg.closest('.el-overlay') || dlg
            const open =
              getComputedStyle(overlay).display !== 'none' && overlay.getBoundingClientRect().height > 0
            return {
              open,
              badge: dlg.querySelector('.edit-badge')?.textContent.trim() || '',
              name: dlg.querySelector('.edit-name')?.textContent.trim() || '',
              value: lines.join('\\n'),
              dirty: !!dlg.querySelector('.edit-dirty'),
              saveDisabled: !!dlg.querySelector('.el-button--primary')?.disabled
            }
          })()`) as Promise<{
          open: boolean
          badge: string
          name: string
          value: string
          dirty: boolean
          saveDisabled: boolean
        } | null>

        const checks: [string, boolean, string][] = []

        // ---------- 本地：双击文本文件 → 编辑器 ----------
        await goto(0, dir)
        await wait(900)
        const openLocal = await dblclickRow(0, 'conf.txt')
        await wait(700)
        let st = await editorState()
        checks.push(['双击本地文本文件', openLocal === 'ok' && !!st, openLocal])
        checks.push(['弹窗标为「本地」', st?.badge === '本地', st?.badge || '无'])
        checks.push(['文件名正确', st?.name === 'conf.txt', st?.name || '无'])
        checks.push(['读到了内容', (st?.value || '').includes('listen 80'), (st?.value || '').slice(0, 24)])
        checks.push(['初始不算脏', st?.dirty === false, ''])
        checks.push(['未改动时保存按钮禁用', st?.saveDisabled === true, ''])

        // ---------- 改内容 → 脏 → 保存 → 落盘 ----------
        /**
         * 往 CodeMirror 里插入文本。
         * 不能再直接改 value（contenteditable 没有 value），走 DOM 层插入：
         * 先把选区折叠到文末，再 execCommand('insertText')。CM6 用 DOM 观察器接管浏览器输入，
         * 这样插进去的字对它来说就是一次正常编辑，会走 onUpdate → v-model 更新。
         */
        const typeIntoEditor = (text: string) =>
          js(`(() => {
            const cm = document.querySelector('.edit-dialog .cm-content')
            if (!cm) return 'no-cm'
            cm.focus()
            const sel = window.getSelection()
            const range = document.createRange()
            range.selectNodeContents(cm)
            range.collapse(false)
            sel.removeAllRanges()
            sel.addRange(range)
            return document.execCommand('insertText', false, ${JSON.stringify(text)}) ? 'ok' : 'exec-failed'
          })()`)

        mainWindow!.focus()
        const typed = await typeIntoEditor('\n// patched by smoke')
        await wait(400)
        st = await editorState()
        checks.push(['改动后标记未保存', st?.dirty === true, `type=${typed}`])
        checks.push(['改动后保存按钮可用', st?.saveDisabled === false, ''])
        await wait(300)
        await shot('thshell-editor-dirty.png')

        await js(
          `document.querySelector('.edit-dialog .el-button--primary')?.click()`
        )
        await wait(1200)
        const saved = fs.readFileSync(textFile, 'utf-8')
        checks.push(['保存写回磁盘', saved.includes('patched by smoke'), JSON.stringify(saved.slice(-24))])
        st = await editorState()
        checks.push(['保存后弹窗仍开着', st?.open === true, ''])
        checks.push(['保存后脏标记清掉', st?.dirty === false, ''])

        const closeHit = await js(
          `(() => {
            const btn = [...document.querySelectorAll('.edit-dialog .el-button')]
              .find((b) => b.textContent.includes('关闭'))
            if (!btn) return 'no-btn'
            btn.click()
            return 'ok'
          })()`
        )
        // 弹窗有淡出动画，关掉之后 DOM 还会留一小会儿；轮询到它真消失再断言
        let closedOk = false
        for (let i = 0; i < 20; i++) {
          const state = await editorState()
          if (state === null || state.open === false) {
            closedOk = true
            break
          }
          await wait(100)
        }
        if (!closedOk) {
          const dump = await js(`(() => {
            const box = document.querySelector('.el-message-box')
            const dlg = document.querySelector('.edit-dialog')
            return JSON.stringify({
              box: box ? box.textContent.trim().slice(0, 40) : '',
              dialog: dlg ? dlg.className : 'gone',
              overlay: dlg?.closest('.el-overlay') ? getComputedStyle(dlg.closest('.el-overlay')).display : ''
            })
          })()`)
          console.log(`[smoke] 关闭失败诊断: hit=${closeHit} ${dump}`)
        }
        checks.push(['关闭编辑器', closedOk, ''])

        // ---------- 二进制：右键没有「在编辑器中打开」，直接读也会被主进程挡掉 ----------
        const rightClickRow = (name: string) =>
          js(`(() => {
            const rows = document.querySelectorAll('.fm .pane')[0]?.querySelectorAll('.rows .row') || []
            const row = [...rows].find((r) => r.textContent.includes(${JSON.stringify(name)}))
            if (!row) return 'no-row'
            const r = row.getBoundingClientRect()
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8 }))
            return 'ok'
          })()`)

        const menuText = () =>
          js(`JSON.stringify([...document.querySelectorAll('.ctx-menu .ctx-item')].map((e) => e.textContent.trim()))`)

        await rightClickRow('conf.txt')
        await wait(400)
        checks.push(['文本文件有「在编辑器中打开」', String(await menuText()).includes('在编辑器中打开'), ''])
        await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
        await wait(200)

        await rightClickRow('blob.bin')
        await wait(400)
        const binMenu = await menuText()
        checks.push(['二进制文件不给「编辑器打开」', !String(binMenu).includes('在编辑器中打开'), String(binMenu).slice(0, 60)])
        // 文件右键菜单是监听 mousedown(capture) 关的，派发 click 关不掉，别搞错事件类型
        await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
        await wait(200)

        const binRead = await js(
          `window.api.local.readFile(${JSON.stringify(binFile)}).then(() => 'read-ok').catch((e) => String(e.message || e))`
        )
        checks.push(['主进程挡住二进制', String(binRead).includes('文本文件'), String(binRead).slice(0, 40)])

        // ---------- 远程：双击 /etc/hosts → 编辑器 ----------
        await goto(1, '/etc')
        await wait(1600)
        const openRemote = await dblclickRow(1, 'hosts')
        await wait(1000)
        st = await editorState()
        checks.push(['双击远程文本文件', openRemote === 'ok' && !!st, openRemote])
        checks.push(['弹窗标为「远程」', st?.badge === '远程', st?.badge || '无'])
        checks.push(['远程内容非空', (st?.value || '').length > 0, `${(st?.value || '').length} 字符`])
        checks.push(['远程未改动时保存禁用', st?.saveDisabled === true, ''])
        await wait(300)
        await shot('thshell-editor.png')

        /* 窗口态：编辑器正文是 CodeMirror，"最大化"必须真的把编辑器拉高 ——
           只是外壳变大、里面还是 58vh 的话，这功能等于没做（图片预览那边踩过一次） */
        const readBox = `(() => {
          const dlg = document.querySelector('.edit-dialog')
          if (!dlg) return null
          const r = dlg.getBoundingClientRect()
          const cm = dlg.querySelector('.cm-editor')
          const body = dlg.querySelector('.el-dialog__body')
          return {
            vh: window.innerHeight,
            h: Math.round(r.height),
            bottom: Math.round(r.bottom),
            cmH: cm ? Math.round(cm.getBoundingClientRect().height) : 0,
            bodyShown: !!body && getComputedStyle(body).display !== 'none',
            lines: dlg.querySelectorAll('.cm-line').length,
            btns: dlg.querySelectorAll('.win-ctl .wc').length
          }
        })()`
        type EditBox = {
          vh: number
          h: number
          bottom: number
          cmH: number
          bodyShown: boolean
          lines: number
          btns: number
        }
        const clickEditWin = (title: string) =>
          js(
            `[...document.querySelectorAll('.edit-dialog .win-ctl .wc')].find((b) => (b.getAttribute('title') || '').startsWith(${JSON.stringify(
              title
            )}))?.click()`
          )

        const eb0 = (await js(readBox)) as EditBox | null
        checks.push(['编辑器标题栏也有三颗窗口按钮', eb0?.btns === 3, `${eb0?.btns} 颗`])

        await clickEditWin('最大化')
        await wait(600)
        const ebMax = (await js(readBox)) as EditBox | null
        checks.push([
          '编辑器最大化后外壳铺满',
          !!ebMax && !!eb0 && ebMax.h > eb0.h + 40,
          `${eb0?.h} → ${ebMax?.h}px`
        ])
        checks.push([
          '最大化后编辑器本体跟着长高',
          !!ebMax && !!eb0 && ebMax.cmH > eb0.cmH + 60,
          `${eb0?.cmH} → ${ebMax?.cmH}px`
        ])
        checks.push(['最大化后底边没出屏', !!ebMax && ebMax.bottom <= ebMax.vh, `底边 ${ebMax?.bottom} / ${ebMax?.vh}`])

        await clickEditWin('最小化')
        await wait(500)
        const ebMin = (await js(readBox)) as EditBox | null
        checks.push([
          '编辑器最小化也收成一条',
          !!ebMin && ebMin.h <= 44 && !ebMin.bodyShown,
          `高 ${ebMin?.h}px`
        ])

        await js(`document.querySelector('.edit-dialog .edit-head.min')?.click()`)
        await wait(500)
        const ebBack = (await js(readBox)) as EditBox | null
        checks.push([
          '展开回来编辑器内容还在（没被销毁重建）',
          !!ebBack && !!eb0 && ebBack.h > 200 && ebBack.bodyShown && ebBack.lines === eb0.lines,
          `高 ${ebBack?.h}px，${ebBack?.lines} 行`
        ])

        let failed = 0
        for (const [name, ok, detail] of checks) {
          if (!ok) failed += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`)
        }
        console.log(`[smoke] edit ${failed ? failed + ' 项失败' : '全部通过'}`)

        fs.rmSync(dir, { recursive: true, force: true })
        finish()
        return
      }

      // text 模式：文本编码的读写往返。
      // 起因是"Windows 上的 .ini 打不开"：UTF-16 文件的 ASCII 部分每隔一个字节就是 0x00，
      // 被 looksBinary 当成二进制挡掉了。这里按字节验，别只验"能打开"——
      // 保存时写错编码等于把文件写坏，比打不开更糟。
      if (mode === 'text') {
        await wait(1200)

        const dir = path.join(os.tmpdir(), 'thshell-text-smoke')
        fs.rmSync(dir, { recursive: true, force: true })
        fs.mkdirSync(dir, { recursive: true })

        const cjk = '[server]\n端口 = 8080\n名称 = 测试机\n'
        const winIni = path.join(dir, 'win.ini')
        const plainIni = path.join(dir, 'plain.ini')
        const bom8Ini = path.join(dir, 'bom8.ini')
        const noBom16 = path.join(dir, 'nobom.ini')
        const blobIni = path.join(dir, 'blob.ini')

        // UTF-16 LE + BOM：记事本"Unicode"另存出来的 .ini 就长这样
        fs.writeFileSync(winIni, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(cjk, 'utf16le')]))
        fs.writeFileSync(plainIni, cjk, 'utf-8')
        fs.writeFileSync(bom8Ini, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(cjk, 'utf-8')]))
        // 不带 BOM 的 UTF-16：我们不猜，仍按二进制挡下（记录这条边界）
        fs.writeFileSync(noBom16, Buffer.from(cjk, 'utf16le'))
        // 扩展名叫 .ini 但内容是二进制：白名单放行 ≠ 内容放行
        fs.writeFileSync(blobIni, Buffer.from([0x00, 0x01, 0x02, 0x50, 0x4b, 0x00, 0x00]))

        const checks: [string, boolean, string][] = []
        const push = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail])
        const tryRead = (p: string) => {
          try {
            return readLocalFile(p)
          } catch (err) {
            return { content: `__throw__${(err as Error).message}`, encoding: 'utf-8', bom: false } as any
          }
        }

        const w = tryRead(winIni)
        push('UTF-16 ini 能读出来', w.content === cjk, w.content.startsWith('__throw__') ? w.content : '')
        push('识别为 utf-16le', w.encoding === 'utf-16le', w.encoding)
        push('记下了 BOM', w.bom === true, `${w.bom}`)

        // 原编码写回：多加一行，再按字节核
        writeLocalFile(winIni, cjk + '刚才改过 = 是\n', 'utf-16le', true)
        const back = fs.readFileSync(winIni)
        push(
          '写回仍是 UTF-16LE + BOM',
          back[0] === 0xff && back[1] === 0xfe && back.subarray(2).toString('utf16le') === cjk + '刚才改过 = 是\n',
          `头两字节 ${back[0]?.toString(16)} ${back[1]?.toString(16)}`
        )
        // 关键：不能混进 UTF-8 的字节序列，否则读它的老程序整份乱码
        push('没写成 UTF-8', !back.includes(Buffer.from('端口', 'utf-8')), '')

        const b8 = tryRead(bom8Ini)
        push('UTF-8 BOM 去掉了', b8.content === cjk && b8.bom === true, `${b8.bom}`)
        writeLocalFile(bom8Ini, cjk, 'utf-8', true)
        const b8back = fs.readFileSync(bom8Ini)
        push(
          'UTF-8 BOM 写回时补回',
          b8back[0] === 0xef && b8back[1] === 0xbb && b8back[2] === 0xbf,
          b8back.subarray(0, 3).toString('hex')
        )

        const pl = tryRead(plainIni)
        push('普通 UTF-8 照常', pl.content === cjk && pl.bom === false && pl.encoding === 'utf-8', pl.encoding)
        writeLocalFile(plainIni, 'x = 1\n')
        push('默认写回不带 BOM', fs.readFileSync(plainIni)[0] === 0x78, '')

        const blob = tryRead(blobIni)
        push('真二进制仍被挡住', blob.content.startsWith('__throw__') && blob.content.includes('文本文件'), blob.content.slice(0, 24))
        const nb = tryRead(noBom16)
        push(
          '无 BOM 的 UTF-16 仍判二进制',
          nb.content.startsWith('__throw__') && nb.content.includes('文本文件'),
          '宁可打不开也不猜错编码'
        )

        // ---------- 体积上限：旧上限是 5MB，现在放到 20MB ----------
        // 6MB 正好卡在"以前打不开、现在能打开"的区间，拿它当判据最直接。
        // 用 .txt 不用 .log：.log 现在双击走只读日志查看器（那条链路由 log 模式单独验），
        // 这里要验的是"大号普通文本挂在 CodeMirror 里到底卡不卡"。
        const bigLog = path.join(dir, 'big.txt')
        const hugeLog = path.join(dir, 'huge.txt')
        fs.writeFileSync(bigLog, 'line of log content 0123456789 abcdef\n'.repeat(160000))
        fs.writeFileSync(hugeLog, Buffer.alloc(25 * 1024 * 1024, 0x41))
        const bigStat = fs.statSync(bigLog).size
        const bigRead = tryRead(bigLog)
        push(
          `6MB（${Math.round(bigStat / 1024 / 1024)}MB）能读`,
          !bigRead.content.startsWith('__throw__') && bigRead.content.length > 5 * 1024 * 1024,
          `${bigRead.content.length} 字符`
        )
        const huge = tryRead(hugeLog)
        push(
          '超 20MB 仍拒绝',
          huge.content.startsWith('__throw__') && huge.content.includes('20MB'),
          huge.content.replace('__throw__', '').slice(0, 30)
        )

        // ---------- 界面上真的双击一次 .ini ----------
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(5000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(1800)
        await js(`(() => {
          const el = document.querySelectorAll('.fm .pane')[0]?.querySelector('.path-input')
          if (!el) return 'no-input'
          el.value = ${JSON.stringify(dir)}
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
          return 'ok'
        })()`)
        await wait(1000)
        const hit = await js(`(() => {
          const rows = document.querySelectorAll('.fm .pane')[0]?.querySelectorAll('.rows .row') || []
          const row = [...rows].find((r) => r.textContent.includes('win.ini'))
          if (!row) return 'no-row'
          row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
          return 'ok'
        })()`)
        await wait(1400)
        const ui = (await js(`(() => {
          const dlg = document.querySelector('.edit-dialog')
          if (!dlg) return { open: false }
          const overlay = dlg.closest('.el-overlay') || dlg
          const text = [...dlg.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\\n')
          return {
            open: getComputedStyle(overlay).display !== 'none' && overlay.getBoundingClientRect().height > 0,
            enc: dlg.querySelector('.edit-enc')?.textContent.trim() || '',
            text
          }
        })()`)) as { open: boolean; enc?: string; text?: string }
        push('双击 .ini 打开编辑器', hit === 'ok' && ui.open === true, hit)
        push('界面标出 UTF-16 LE', ui.enc === 'UTF-16 LE', ui.enc || '没有编码标记')
        push('编辑器内容解码正确', (ui.text || '').includes('端口 = 8080'), (ui.text || '').slice(0, 20))
        await wait(300)
        await shot('thshell-text-utf16.png')

        // ---------- 6MB 的文件在界面里到底卡不卡 ----------
        // 放不放开上限不能只凭"能读"，要看真挂进 CodeMirror 要多久
        await js(`(() => {
          const btn = [...document.querySelectorAll('.edit-dialog .el-button')].find((b) => b.textContent.includes('关闭'))
          btn?.click()
        })()`)
        await wait(800)
        const t0 = Date.now()
        const bigHit = await js(`(() => {
          const rows = document.querySelectorAll('.fm .pane')[0]?.querySelectorAll('.rows .row') || []
          const row = [...rows].find((r) => r.textContent.includes('big.txt'))
          if (!row) return 'no-row'
          row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
          return 'ok'
        })()`)
        let rendered = 0
        for (let i = 0; i < 40 && !rendered; i += 1) {
          await wait(250)
          rendered = (await js(`document.querySelectorAll('.edit-dialog .cm-line').length`)) as number
        }
        const cost = Date.now() - t0
        push('6MB 文件能挂进编辑器', bigHit === 'ok' && rendered > 0, `${rendered} 行已渲染`)
        push('打开耗时在可接受范围', cost < 8000, `${cost}ms`)
        await wait(300)
        await shot('thshell-text-big.png')

        let failed = 0
        for (const [name, ok, detail] of checks) {
          if (!ok) failed += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`)
        }
        console.log(`[smoke] text ${failed ? failed + ' 项失败' : '全部通过'}（${checks.length} 项）`)

        fs.rmSync(dir, { recursive: true, force: true })
        finish()
        return
      }

      // log 模式：日志"只看末尾 N 行"这条链路。
      // 重点不是"能不能读"，而是：几百 MB 的日志能不能秒开、给的是不是**最后**那么多行、
      // 界面上到底有没有编辑入口（用户明确说日志不需要改）。
      if (mode === 'log') {
        await wait(1200)

        const dir = path.join(os.tmpdir(), 'thshell-log-smoke')
        fs.rmSync(dir, { recursive: true, force: true })
        fs.mkdirSync(dir, { recursive: true })

        const many = path.join(dir, 'many.log')
        const short = path.join(dir, 'short.log')
        const u16 = path.join(dir, 'u16.log')
        const fake = path.join(dir, 'fake.log')
        const huge = path.join(dir, 'huge.log')

        const row = (n: number) => `2026-11-10 10:00:00 INFO 第 ${n} 行 请求完成`
        fs.writeFileSync(many, Array.from({ length: 10000 }, (_, i) => row(i + 1)).join('\n') + '\n')
        fs.writeFileSync(short, Array.from({ length: 50 }, (_, i) => row(i + 1)).join('\n') + '\n')
        // UTF-16LE + BOM 的日志：尾巴上没有 BOM，编码只能从文件头嗅
        fs.writeFileSync(
          u16,
          Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(Array.from({ length: 300 }, (_, i) => row(i + 1)).join('\r\n'), 'utf16le')])
        )
        // 扩展名叫 .log 的二进制：白名单放行 ≠ 内容放行
        fs.writeFileSync(fake, Buffer.from([0x1f, 0x8b, 0x00, 0x00, 0x50, 0x4b, 0x00, 0x00]))
        // 40MB：这个体积正是"整份读必卡"的量级
        {
          const fd = fs.openSync(huge, 'w')
          const block = Buffer.from('2026-11-10 10:00:00 INFO 这是一条很长的访问日志 xxxxxxxxxxxxxxxxxxxxxxxxxxxx\n'.repeat(500))
          for (let i = 0; i < 2200; i += 1) fs.writeSync(fd, block)
          fs.writeSync(fd, Buffer.from('TAIL-MARKER-9527\n'))
          fs.closeSync(fd)
        }

        const checks: [string, boolean, string][] = []
        const push = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail])
        const tail = async (p: string, n?: number) => {
          try {
            return await readLocalTail(p, n)
          } catch (err) {
            return { content: `__throw__${(err as Error).message}`, lines: -1, size: 0, truncated: false, encoding: 'utf-8' as const }
          }
        }
        const firstOf = (t: string) => t.split('\n')[0]
        const lastOf = (t: string) => t.split('\n').filter((l) => l !== '').pop() || ''

        // ---------- 默认 200 行，且必须是「最后」200 行 ----------
        const t200 = await tail(many)
        push('默认给 200 行', t200.lines === 200, `${t200.lines} 行`)
        push('是文件最后的 200 行', lastOf(t200.content).includes('第 10000 行'), lastOf(t200.content).slice(-16))
        push('第一行是第 9801 行（10000-200+1）', firstOf(t200.content).includes('第 9801 行'), firstOf(t200.content).slice(-16))
        push('标出前面还有内容', t200.truncated === true, `${t200.truncated}`)
        push('文件大小没读错', t200.size === fs.statSync(many).size, `${t200.size}`)

        // ---------- 行数可调 ----------
        const t500 = await tail(many, 500)
        push('改成 500 行就真给 500 行', t500.lines === 500, `${t500.lines} 行`)
        push('500 行的起点也对', firstOf(t500.content).includes('第 9501 行'), firstOf(t500.content).slice(-16))
        const t20 = await tail(many, 20)
        push('小于 50 的行数被夹到 50', t20.lines === 50, `${t20.lines} 行`)

        // ---------- 比请求短的文件：全给，且不谎称"前面还有" ----------
        const tShort = await tail(short, 500)
        push('短文件全给', tShort.lines === 50, `${tShort.lines} 行`)
        push('短文件不标截断', tShort.truncated === false, `${tShort.truncated}`)

        // ---------- UTF-16 日志的尾巴 ----------
        const t16 = await tail(u16)
        push('UTF-16 日志识别正确', t16.encoding === 'utf-16le', t16.encoding)
        push('UTF-16 尾巴解码正确', lastOf(t16.content).includes('第 300 行'), lastOf(t16.content).slice(-14))

        // ---------- 二进制护栏 ----------
        const tFake = await tail(fake)
        push(
          '名字叫 .log 的二进制被挡住',
          tFake.content.startsWith('__throw__') && tFake.content.includes('文本文件'),
          tFake.content.replace('__throw__', '').slice(0, 24)
        )

        // ---------- 40MB：这才是日志查看器存在的理由 ----------
        const hugeSize = fs.statSync(huge).size
        const h0 = Date.now()
        const tHuge = await tail(huge)
        const hugeCost = Date.now() - h0
        push(`大日志（${Math.round(hugeSize / 1024 / 1024)}MB）能读`, tHuge.lines === 200, `${tHuge.lines} 行`)
        push('读到的是真末尾', lastOf(tHuge.content).includes('TAIL-MARKER-9527'), lastOf(tHuge.content))
        // 整份读进来要几十 MB 内存 + 解码 + 挂进 CodeMirror；只读尾部只有几十 KB
        push('大文件读尾部 < 1s', hugeCost < 1000, `${hugeCost}ms`)
        let wholeCost = 0
        {
          const w0 = Date.now()
          fs.readFileSync(huge)
          wholeCost = Date.now() - w0
        }
        push('比整份读快得多', hugeCost < wholeCost, `尾部 ${hugeCost}ms vs 整份 ${wholeCost}ms`)

        // ---------- 界面：双击 .log 应该进"只读日志查看器" ----------
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(4000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(1800)
        await js(`(() => {
          const el = document.querySelectorAll('.fm .pane')[0]?.querySelector('.path-input')
          if (!el) return 'no-input'
          el.value = ${JSON.stringify(dir)}
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
          return 'ok'
        })()`)
        await wait(1000)
        const hit = await js(`(() => {
          const rows = document.querySelectorAll('.fm .pane')[0]?.querySelectorAll('.rows .row') || []
          const row = [...rows].find((r) => r.textContent.includes('many.log'))
          if (!row) return 'no-row'
          row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
          return 'ok'
        })()`)
        await wait(1600)

        const readDlg = () =>
          js(`(() => {
            const dlg = document.querySelector('.log-dialog')
            if (!dlg) return { open: false }
            const overlay = dlg.closest('.el-overlay') || dlg
            const lines = [...dlg.querySelectorAll('.cm-line')].map((l) => l.textContent)
            const scroller = dlg.querySelector('.cm-scroller')
            const content = dlg.querySelector('.cm-content')
            return {
              open: getComputedStyle(overlay).display !== 'none' && overlay.getBoundingClientRect().height > 0,
              meta: dlg.querySelector('.log-meta')?.textContent.trim() || '',
              tag: dlg.querySelector('.log-tag')?.textContent.trim() || '',
              cut: dlg.querySelector('.log-cut')?.textContent.trim() || '',
              saveBtn: [...dlg.querySelectorAll('.el-button')].some((b) => b.textContent.includes('保存')),
              editable: content?.getAttribute('contenteditable') ?? 'missing',
              last: lines.filter((l) => l && l.trim()).pop() || '',
              lineCount: lines.length,
              gutter: !!dlg.querySelector('.cm-gutter'),
              atBottom: scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40 : false,
              // 编辑器弹窗不该被打开
              editorOpen: !!document.querySelector('.edit-dialog')
            }
          })()`)

        let ui = (await readDlg()) as Record<string, any>
        // 滚动这条要留出测量的时间：弹窗刚挂上时 CodeMirror 的 scrollHeight 还在长，
        // 差值和阈值只差几像素就会偶发假失败（内容其实已经到底了）。
        // 最多轮询 2.5 秒，一旦到底立刻停 —— 只重试一次是不够的，日志是边读边渲染的。
        for (let i = 0; i < 5 && ui.atBottom !== true; i += 1) {
          await wait(500)
          ui = { ...ui, ...((await readDlg()) as Record<string, any>) }
        }
        push('双击 .log 打开日志查看器', hit === 'ok' && ui.open === true, hit)
        push('走的是日志弹窗，不是编辑器', ui.editorOpen === false, ui.editorOpen ? '编辑弹窗也开了' : '')
        push('标了「日志 · 只读」', ui.tag === '日志 · 只读', ui.tag || '没有标记')
        push('底栏显示末尾 200 行', ui.meta.includes('末尾 200 行'), ui.meta)
        push('标出前面还有内容', ui.cut.includes('前面还有'), ui.cut || '没有提示')
        push('没有保存按钮', ui.saveBtn === false, ui.saveBtn ? '有保存按钮' : '')
        push('编辑器是真只读', ui.editable === 'false', `contenteditable=${ui.editable}`)
        // 行号从 1 开始数会让人以为那是文件真实行号（第 477 行其实是第 9977 行），日志里不要它
        push('日志不显示行号', ui.gutter === false, ui.gutter ? '还挂着行号栏' : '')
        push('打开就停在最新一行', ui.atBottom === true, `已渲染 ${ui.lineCount} 行，last=${String(ui.last).slice(-18)}`)

        // ---------- 行数可调 ----------
        await js(`document.querySelector('.log-dialog .log-pick .el-select__wrapper')?.click()`)
        await wait(600)
        await js(`(() => {
          const items = [...document.querySelectorAll('.el-select-dropdown__item')]
          const it = items.find((el) => el.textContent.trim() === '500 行')
          if (!it) return 'no-item'
          it.click()
          return 'ok'
        })()`)
        await wait(1400)
        ui = (await readDlg()) as Record<string, any>
        push('切到 500 行后底栏跟着变', ui.meta.includes('末尾 500 行'), ui.meta)

        // ---------- 实时：往文件里追加一行，自动刷新要能看见 ----------
        // 这一条才是"实时读取"的真正含义 —— 不是打开时读一次就完了
        await js(`document.querySelector('.log-dialog .log-bar .el-checkbox')?.click()`)
        await wait(400)
        fs.appendFileSync(many, '2026-11-10 10:30:00 ERROR 刚刚写进去的一行\n')
        await wait(4500)
        ui = (await readDlg()) as Record<string, any>
        push('自动刷新读到了新写入的行', String(ui.last).includes('刚刚写进去的一行'), String(ui.last).slice(-22))

        // ---------- 远程链路：SFTP 的 open / 定位 read / close 也要过一遍 ----------
        // 本地的 loop 好验，远程那套"读不满要再往前翻倍"最容易出错，得真连一台机器读
        const remote = (await js(`(async () => {
          const sid = window.__store?.tabs.find((t) => t.sessionId)?.sessionId || ''
          if (!sid) return { skip: true }
          const cands = [
            // 真日志优先：几百 KB 以上，能逼出"一个窗口不够、要往前翻倍再读"那条路
            { p: '/var/log/messages', n: 1000, end: '' },
            { p: '/etc/ssl/certs/ca-certificates.crt', n: 2000, end: '-----END CERTIFICATE-----' },
            { p: '/etc/services', n: 200, end: '' },
            { p: '/etc/hosts', n: 50, end: '' }
          ]
          for (const c of cands) {
            try {
              const r = await window.api.sftp.readTail(sid, c.p, c.n)
              const rows = r.content.split('\\n')
              return {
                skip: false, path: c.p, end: c.end,
                lines: r.lines, truncated: r.truncated, size: r.size,
                tail: rows[rows.length - 1],
                bad: r.content.includes('\\uFFFD')
              }
            } catch (e) { /* 换下一个候选文件 */ }
          }
          return { skip: false, error: '所有候选文件都读不了' }
        })()`)) as Record<string, any>
        if (remote.skip) {
          console.log('[smoke] SKIP 远程尾部：当前没有可用的 SSH 会话')
        } else {
          push('远程也能读尾部', !remote.error && remote.lines > 0, remote.path || remote.error || '')
          // 切片从文件中途开始，起点落在半个汉字里就会出 U+FFFD —— 这条最容易被忽略
          push('远程尾部没有乱码', remote.bad === false, remote.bad ? '出现了 U+FFFD' : '')
          push(
            '远程读到的是真末尾',
            !remote.end || String(remote.tail).includes(remote.end),
            String(remote.tail || '').slice(-24)
          )
        }

        await wait(300)
        await shot('thshell-log.png')

        /* 日志弹窗是三段结构（路径行 + 工具条 + 编辑器），最大化最容易在这里翻车：
           工具条被 flex 压扁 / 编辑器没跟着长高 */
        const readLogBox = `(() => {
          const dlg = document.querySelector('.log-dialog')
          if (!dlg) return null
          const r = dlg.getBoundingClientRect()
          const cm = dlg.querySelector('.cm-editor')
          const bar = dlg.querySelector('.log-bar')
          const pick = dlg.querySelector('.log-pick')
          return {
            vh: window.innerHeight,
            h: Math.round(r.height),
            bottom: Math.round(r.bottom),
            cmH: cm ? Math.round(cm.getBoundingClientRect().height) : 0,
            barH: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
            pickH: pick ? Math.round(pick.getBoundingClientRect().height) : 0
          }
        })()`
        type LogBox = { vh: number; h: number; bottom: number; cmH: number; barH: number; pickH: number }
        const lb0 = (await js(readLogBox)) as LogBox | null
        await js(
          `[...document.querySelectorAll('.log-dialog .win-ctl .wc')].find((b) => (b.getAttribute('title') || '').startsWith('最大化'))?.click()`
        )
        await wait(600)
        const lbMax = (await js(readLogBox)) as LogBox | null
        push(
          '日志弹窗最大化后编辑器跟着长高',
          !!lbMax && !!lb0 && lbMax.cmH > lb0.cmH + 60 && lbMax.bottom <= lbMax.vh,
          `${lb0?.cmH} → ${lbMax?.cmH}px，底边 ${lbMax?.bottom}/${lbMax?.vh}`
        )
        // 工具条里的 select 只有 24px 高，被压一下就只剩半个
        push(
          '最大化后工具条没被压扁',
          !!lbMax && !!lb0 && lbMax.barH >= lb0.barH && lbMax.pickH >= 20,
          `条高 ${lb0?.barH} → ${lbMax?.barH}px`
        )
        await shot('thshell-log-max.png')
        // 还原回原尺寸：后面还要用底栏的「关闭」走一遍正常关窗
        await js(
          `[...document.querySelectorAll('.log-dialog .win-ctl .wc')].find((b) => (b.getAttribute('title') || '').startsWith('还原'))?.click()`
        )
        await wait(400)
        const lbBack = (await js(readLogBox)) as LogBox | null
        push(
          '点还原能回到原来的尺寸',
          !!lbBack && !!lb0 && Math.abs(lbBack.h - lb0.h) <= 4,
          `${lbMax?.h} → ${lbBack?.h}px（原 ${lb0?.h}）`
        )

        // ---------- 底栏图标语义：眼睛=看、笔=改，重命名不能再抢那支笔 ----------
        // 关掉弹窗，选中 many.log，然后看底栏第 4 个按钮（打开）是不是换成了「查看日志」
        await js(`(() => {
          const b = [...document.querySelectorAll('.log-dialog .el-button')].find((x) => x.textContent.includes('关闭'))
          b?.click()
        })()`)
        await wait(700)
        await js(`(() => {
          const rows = document.querySelectorAll('.fm .pane')[0]?.querySelectorAll('.rows .row') || []
          const row = [...rows].find((r) => r.textContent.includes('many.log'))
          row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          return 'ok'
        })()`)
        await wait(400)
        const foot = (await js(`(() => {
          const p = document.querySelectorAll('.fm .pane')[0]
          if (!p) return { err: 'no-pane' }
          const btns = [...p.querySelectorAll('.pane-foot .el-button')]
          const pathOf = (b) => b?.querySelector('svg')?.innerHTML || ''
          // 0 新建文件夹 / 1 重命名 / 2 删除 / 3 打开
          return {
            same: pathOf(btns[3]) === pathOf(btns[1])
          }
        })()`)) as Record<string, any>
        // 图标形状只有"跟重命名不一样"这一条能自动断言，文案靠下一步真悬停
        push('重命名和打开不是同一个图标', foot.same === false, foot.same ? '两个按钮图形一样' : '')
        await js(`document.querySelectorAll('.fm .pane')[0]?.querySelectorAll('.pane-foot .el-button')[3]?.dispatchEvent(new MouseEvent('mouseenter'))`)
        let openTip = ''
        for (let i = 0; i < 8 && !openTip; i += 1) {
          await wait(300)
          openTip = ((await js(`(() => {
            const b = document.querySelectorAll('.fm .pane')[0]?.querySelectorAll('.pane-foot .el-button')[3]
            const id = b?.getAttribute('aria-describedby')
            const tip = id ? document.getElementById(id) : null
            return tip && getComputedStyle(tip).visibility !== 'hidden' ? tip.textContent.trim() : ''
          })()`)) as string) || ''
        }
        push('选中日志时按钮变成「查看日志」', openTip === '查看日志', openTip || '没有提示')

        let failed = 0
        for (const [name, ok, detail] of checks) {
          if (!ok) failed += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`)
        }
        console.log(`[smoke] log ${failed ? failed + ' 项失败' : '全部通过'}（${checks.length} 项）`)

        fs.rmSync(dir, { recursive: true, force: true })
        finish()
        return
      }

      // pdf 模式：PDF 预览。
      // 这条链路出过"浏览器能打开、我们打不开"的事故 —— 根因是 CSP 里没有 blob:，
      // pdf.js 的 worker（用 Blob 起的 module worker）被拦掉，回退的 fake worker 也被拦。
      // 所以要真造一个 PDF、真渲染、真去数画布上的黑像素，不能只看"弹窗开了"。
      if (mode === 'pdf') {
        await wait(1500)

        const dir = path.join(os.tmpdir(), 'thshell-pdf-smoke')
        fs.rmSync(dir, { recursive: true, force: true })
        fs.mkdirSync(dir, { recursive: true })
        const pdfPath = path.join(dir, 'demo.pdf')

        /**
         * 手搓一个最小合法 PDF（1 页 + Helvetica 一行字）。
         * 依赖库生成太麻烦，而要验的只是"pdf.js 能不能解析并画出来"，
         * 所以 xref 表自己算偏移 —— 少这一张表 pdf.js 会走"坏 xref 重建"，
         * 那样验的就不是正常路径了。
         */
        {
          const content = 'BT /F1 18 Tf 40 96 Td (ThShell PDF OK 2026) Tj ET'
          const bodies = [
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 340 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
            `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
            '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
          ]
          let out = '%PDF-1.4\n'
          const offsets: number[] = []
          bodies.forEach((body, i) => {
            offsets.push(out.length)
            out += `${i + 1} 0 obj\n${body}\nendobj\n`
          })
          const xrefAt = out.length
          out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
          for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
          out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
          fs.writeFileSync(pdfPath, Buffer.from(out, 'latin1'))
        }

        const checks: [string, boolean, string][] = []
        const push = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail])
        push('造出来的 PDF 有内容', fs.statSync(pdfPath).size > 400, `${fs.statSync(pdfPath).size} 字节`)

        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(4000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(1800)
        await js(`(() => {
          const el = document.querySelectorAll('.fm .pane')[0]?.querySelector('.path-input')
          if (!el) return 'no-input'
          el.value = ${JSON.stringify(dir)}
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
          return 'ok'
        })()`)
        await wait(1000)
        const hit = await js(`(() => {
          const rows = document.querySelectorAll('.fm .pane')[0]?.querySelectorAll('.rows .row') || []
          const row = [...rows].find((r) => r.textContent.includes('demo.pdf'))
          if (!row) return 'no-row'
          row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
          return 'ok'
        })()`)
        await wait(2200)

        // 渲染是异步的（解析 → 取页 → 画 canvas），轮询到画布出来为止
        let state = { open: false, alert: '', pages: '', canvases: 0, w: 0, h: 0, dark: 0 }
        for (let i = 0; i < 24; i += 1) {
          state = (await js(`(() => {
            const dlg = document.querySelector('.preview-dialog')
            if (!dlg) return { open: false, alert: '', pages: '', canvases: 0, w: 0, h: 0, dark: 0 }
            const overlay = dlg.closest('.el-overlay') || dlg
            const canvas = dlg.querySelector('.pdf-page canvas')
            let w = 0, h = 0, dark = 0
            if (canvas) {
              w = canvas.width
              h = canvas.height
              try {
                const d = canvas.getContext('2d').getImageData(0, 0, w, h).data
                // 数"够黑的像素"：文字画上去才会有，空白页是 0
                for (let k = 0; k < d.length; k += 4) {
                  if (d[k] < 160 && d[k + 1] < 160 && d[k + 2] < 160) dark += 1
                }
              } catch (e) { dark = -1 }
            }
            return {
              open: getComputedStyle(overlay).display !== 'none' && overlay.getBoundingClientRect().height > 0,
              alert: dlg.querySelector('.pdf-alert')?.textContent?.trim() || '',
              pages: dlg.querySelector('.pdf-pages')?.textContent?.trim() || '',
              canvases: dlg.querySelectorAll('.pdf-page canvas').length,
              w, h, dark
            }
          })()`)) as typeof state
          // 「有画布」和「画布上有字」不是同一时刻：canvas 挂上去之后才真正往上画，
          // 所以两个条件都满足才停，否则会把"还没画完"当成"白板"
          if ((state.canvases > 0 && state.dark > 100) || state.alert) break
          await wait(300)
        }

        push('双击 PDF 打开了预览', hit === 'ok' && state.open === true, hit)
        // 这条就是用户看到的那句 "Setting up fake worker failed…"，现在是零容忍
        push('没有报错提示', !state.alert, state.alert.slice(0, 90))
        push('读出了页数', state.pages.includes('1 页'), state.pages || '没显示页数')
        push('画布渲染出来了', state.canvases > 0, `${state.canvases} 个 canvas`)
        push('画布尺寸正常', state.w > 0 && state.h > 0, `${state.w}×${state.h}`)
        push('画布上真有内容（不是白板）', state.dark > 100, `深色像素 ${state.dark}`)

        await wait(300)
        await shot('thshell-pdf.png')

        let failed = 0
        for (const [name, ok, detail] of checks) {
          if (!ok) failed += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`)
        }
        console.log(`[smoke] pdf ${failed ? failed + ' 项失败' : '全部通过'}（${checks.length} 项）`)

        fs.rmSync(dir, { recursive: true, force: true })
        finish()
        return
      }

      /**
       * files 模式：文件类型图标 + 图片预览。
       *
       * 图标这种"一列 16px 小图形"的东西，截图看十遍也只能说"好像不一样"，
       * 所以这里直接读每一行图标的 class（`k-image` / `k-archive` …）逐项断言。
       * 图片预览则要真解一次：造一张 24×24 的真 PNG（自算 zlib + CRC），
       * 断言 naturalWidth 和缩放按钮，最后截图目检。
       */
      if (mode === 'files') {
        const dir = path.join(os.tmpdir(), 'thshell-files-smoke')
        fs.rmSync(dir, { recursive: true, force: true })
        fs.mkdirSync(dir, { recursive: true })

        // 24×24，左上红块 / 右下蓝块 / 其余青绿，101 字节
        const PNG = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAALElEQVR42mP4b2ODFcntW0ASYhg1' +
            'aEQbRKqGUYNGDaKGQRo9/7GiUYNGtEEApCRjru8t4yEAAAAASUVORK5CYII=',
          'base64'
        )

        /** [文件名, 内容, 期望的图标种类] */
        const files: [string, string | Buffer, string][] = [
          ['shot.png', PNG, 'image'],
          ['icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>\n', 'image'],
          ['notes.md', '# 说明\n', 'text'],
          ['app.py', 'print(1)\n', 'code'],
          ['Main.java', 'class A {}\n', 'code'],
          ['config.yml', 'a: 1\n', 'config'],
          ['access.log', '2026-11-10 10:00:00 ok\n', 'log'],
          ['backup.zip', 'PK', 'archive'],
          ['photo.tar.gz', 'gz', 'archive'],
          ['movie.mp4', 'mp4', 'video'],
          ['song.mp3', 'ID3', 'audio'],
          ['report.docx', 'PK', 'doc'],
          ['sheet.xlsx', 'PK', 'sheet'],
          ['slides.pptx', 'PK', 'slide'],
          ['manual.pdf', '%PDF-1.4\n', 'pdf'],
          ['tool.exe', 'MZ', 'exe'],
          ['server.pem', '-----BEGIN-----\n', 'key'],
          ['app.db', 'SQLite', 'db'],
          ['blob.dat', 'x', 'other'],
          ['README', 'readme\n', 'text']
        ]
        for (const [name, content] of files) {
          fs.writeFileSync(path.join(dir, name), content as string | Buffer)
        }

        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(4000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(1800)
        await js(`(() => {
          const el = document.querySelectorAll('.fm .pane')[0]?.querySelector('.path-input')
          if (!el) return 'no-input'
          el.value = ${JSON.stringify(dir)}
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
          return 'ok'
        })()`)
        await wait(1200)

        const checks: [string, boolean, string][] = []
        const push = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail])

        const rows = (await js(`(() => {
          const pane = document.querySelectorAll('.fm .pane')[0]
          if (!pane) return []
          return [...pane.querySelectorAll('.rows .row')].map((r) => ({
            name: r.querySelector('.fname')?.textContent?.trim() || '',
            // 图标的种类写在 class 上（k-image / k-archive …），比读 SVG 的 path 稳
            kind: [...(r.querySelector('.ficon')?.classList || [])]
              .find((c) => c.startsWith('k-'))?.slice(2) || ''
          }))
        })()`)) as { name: string; kind: string }[]

        const wrong: string[] = []
        for (const [name, , want] of files) {
          const row = rows.find((r) => r.name === name)
          if (!row) wrong.push(`${name}(没出现)`)
          else if (row.kind !== want) wrong.push(`${name}=${row.kind || '无'}（应 ${want}）`)
        }
        push('每个文件都用了对应类型的图标', wrong.length === 0, wrong.join('、') || `${rows.length} 行`)
        push(
          '图标种类够散（不是一张纸打天下）',
          new Set(rows.map((r) => r.kind)).size >= 10,
          `${new Set(rows.map((r) => r.kind)).size} 种`
        )

        // 先把列表本身截一张（弹窗会盖住左栏），再看预览。
        // 截图前再点一次「文件」：SSH 掉线后视图会被切回终端，那时截到的是终端页
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(500)
        await shot('thshell-files.png')

        // 双击真 PNG，看预览面板
        const hit = await js(`(() => {
          const pane = document.querySelectorAll('.fm .pane')[0]
          const row = [...(pane?.querySelectorAll('.rows .row') || [])]
            .find((r) => r.querySelector('.fname')?.textContent?.trim() === 'shot.png')
          if (!row) return 'no-row'
          row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
          return 'ok'
        })()`)
        await wait(1800)

        const readImg = `(() => {
          const dlg = document.querySelector('.preview-dialog')
          if (!dlg) return null
          const img = dlg.querySelector('.img-el')
          return {
            open: true,
            tag: (dlg.querySelector('.preview-tag')?.textContent || '').trim(),
            dim: (dlg.querySelector('.img-dim')?.textContent || '').trim(),
            pct: parseInt((dlg.querySelector('.img-scale')?.textContent || '0'), 10) || 0,
            natW: img?.naturalWidth || 0,
            natH: img?.naturalHeight || 0,
            complete: !!img?.complete,
            err: (dlg.querySelector('.img-alert')?.textContent || '').trim().slice(0, 80),
            hasStage: !!dlg.querySelector('.img-scroll')
          }
        })()`
        const img1 = (await js(readImg)) as {
          open: boolean
          tag: string
          dim: string
          pct: number
          natW: number
          natH: number
          complete: boolean
          err: string
          hasStage: boolean
        } | null

        push('双击图片打开了预览', hit === 'ok' && !!img1?.open, hit)
        push('是图片预览面板，不是 office 预览', img1?.tag === '图片预览', img1?.tag || '没有标签')
        push(
          '图真的解码出来了',
          img1?.complete === true && img1?.natW === 24 && img1?.natH === 24,
          `${img1?.natW}×${img1?.natH}`
        )
        push('尺寸显示 24 × 24', img1?.dim === '24 × 24', img1?.dim || '空')
        push('没有报错提示', !img1?.err, img1?.err || '')
        push('有棋盘格底（能看出透明区域）', img1?.hasStage === true)
        // 24px 的小图适应窗口时会放大到 4 倍上限，正好能看清像素
        push('默认按适应窗口放大', !!img1 && img1.pct >= 100 && img1.pct <= 1600, `${img1?.pct}%`)

        await js(
          `[...document.querySelectorAll('.preview-dialog .img-btn')].find((b) => b.textContent.trim() === '1:1')?.click()`
        )
        await wait(400)
        const pct11 = ((await js(readImg)) as { pct: number } | null)?.pct ?? 0
        push('切到 1:1 就是 100%', pct11 === 100, `${pct11}%`)

        await js(`document.querySelector('.preview-dialog .img-btn[title="放大"]')?.click()`)
        await wait(400)
        const pctZoom = ((await js(readImg)) as { pct: number } | null)?.pct ?? 0
        push('还能再放大', pctZoom === 110, `${pctZoom}%`)

        /* ---------- 弹窗的窗口态：最大化 / 最小化 / 关闭 ----------
           一律量几何。"看起来变大了"这种结论截图给不出来，而且缩略图还会骗人。 */
        const readWin = `(() => {
          const dlg = document.querySelector('.preview-dialog')
          if (!dlg) return null
          const r = dlg.getBoundingClientRect()
          const body = dlg.querySelector('.el-dialog__body')
          const stage = dlg.querySelector('.img-scroll')
          const overlay = dlg.closest('.el-overlay')
          return {
            vw: window.innerWidth,
            vh: window.innerHeight,
            w: Math.round(r.width),
            h: Math.round(r.height),
            bottom: Math.round(r.bottom),
            bodyShown: !!body && getComputedStyle(body).display !== 'none',
            stageH: stage ? Math.round(stage.getBoundingClientRect().height) : 0,
            clickThru: !!overlay && getComputedStyle(overlay).pointerEvents === 'none',
            btns: [...dlg.querySelectorAll('.win-ctl .wc')].map((b) => b.getAttribute('title'))
          }
        })()`
        type WinBox = {
          vw: number
          vh: number
          w: number
          h: number
          bottom: number
          bodyShown: boolean
          stageH: number
          clickThru: boolean
          btns: string[]
        }

        const w0 = (await js(readWin)) as WinBox | null
        push('标题栏有最小化/最大化/关闭三颗按钮', w0?.btns.length === 3, (w0?.btns || []).join(' / '))

        const clickWin = (title: string) =>
          js(
            `[...document.querySelectorAll('.preview-dialog .win-ctl .wc')].find((b) => (b.getAttribute('title') || '').startsWith(${JSON.stringify(
              title
            )}))?.click()`
          )

        await clickWin('最大化')
        await wait(500)
        const wMax = (await js(readWin)) as WinBox | null
        push(
          '最大化铺满了窗口',
          !!wMax && !!w0 && wMax.w > w0.w && wMax.w >= wMax.vw - 24 && wMax.h >= wMax.vh * 0.9,
          `${wMax?.w}×${wMax?.h}（窗口 ${wMax?.vw}×${wMax?.vh}，原来 ${w0?.w}×${w0?.h}）`
        )
        // 只是外框变大、里面还是 68vh 的话，这功能等于没做
        push('内容区跟着长高了', !!wMax && !!w0 && wMax.stageH > w0.stageH + 40, `${w0?.stageH} → ${wMax?.stageH}px`)
        push('最大化后底边没被顶出屏幕', !!wMax && wMax.bottom <= wMax.vh, `底边 ${wMax?.bottom} / ${wMax?.vh}`)
        await shot('thshell-files-preview-max.png')

        await clickWin('最小化')
        await wait(500)
        const wMin = (await js(readWin)) as WinBox | null
        const minCls = (await js(`!!document.querySelector('.preview-dialog.min')`)) as boolean
        push(
          '最小化收成了右下角一条',
          minCls && !!wMin && wMin.h <= 44 && !wMin.bodyShown,
          `高 ${wMin?.h}px，正文${wMin?.bodyShown ? '还在' : '已隐藏'}`
        )
        // 遮罩不收掉点击的话，小条看着在、后面的文件列表却点不动
        push('收起后遮罩不再挡着后面的界面', !!wMin && wMin.clickThru === true)
        await shot('thshell-files-preview-min.png')

        await js(`document.querySelector('.preview-dialog .edit-head.min')?.click()`)
        await wait(500)
        const wBack = (await js(readWin)) as WinBox | null
        const backMin = (await js(`!!document.querySelector('.preview-dialog.min')`)) as boolean
        push(
          '点小条能展开回来，内容还在',
          !backMin && !!wBack && wBack.h > 200 && wBack.bodyShown && wBack.stageH > 40,
          `高 ${wBack?.h}px，图区 ${wBack?.stageH}px`
        )
        // 收起再展开如果重建了组件，缩放会跳回"适应窗口"，这里继续是刚才的 110% 才说明没重来
        const pctBack = ((await js(readImg)) as { pct: number } | null)?.pct ?? 0
        push('展开后缩放位置没被重置', pctBack === 110, `${pctBack}%`)

        await shot('thshell-files-preview.png')

        await js(`document.querySelector('.preview-dialog .win-ctl .wc.close')?.click()`)
        await wait(500)
        const gone = (await js(`!document.querySelector('.preview-dialog')`)) as boolean
        push('关闭键真的关掉了', gone)

        let failed = 0
        for (const [name, ok, detail] of checks) {
          if (!ok) failed += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`)
        }
        console.log(`[smoke] files ${failed ? failed + ' 项失败' : '全部通过'}（${checks.length} 项）`)

        fs.rmSync(dir, { recursive: true, force: true })
        finish()
        return
      }

      /**
       * perm 模式：远程列表的「权限」和「用户 / 组」两列。
       *
       * 这三段逻辑都是"算错了照样能显示"的：权限串由 mode 位拼、属主从 SFTP 长格式里抠、
       * 能不能写要拿登录用户的 uid + 全部 gid 去比三档位。所以不靠截图，
       * 先造一组已知权限的文件，再用三种身份（root / 真身 / 陌生人）各列一遍逐项断言，
       * 最后才看 DOM 里红字对不对。
       */
      if (mode === 'perm') {
        await wait(1500)
        const checks: [string, boolean, string][] = []
        const push = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail])

        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(5000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(1800)

        const sid = (await js(
          `window.__store?.tabs.find((t) => t.sessionId)?.sessionId || ''`
        )) as string
        const sftp = sid ? await ssh.getSftp(sid) : null
        if (!sid || !sftp) {
          console.log('[smoke] SKIP perm：当前没有可用的 SSH 会话')
          finish()
          return
        }

        const who = await ssh.getIdentity(sid)
        push(
          '问到了登录用户的 uid 和全部 gid',
          !!who && who.uid >= 0 && who.gids.length > 0,
          who ? `uid=${who.uid} gids=${who.gids.join(',')}` : '拿不到'
        )

        // 已知权限的一组样本：目录 755、子目录 700、文件 644 / 600 / 444。
        // 用 shell 一步做完：chmod 走 exec 比走 SFTP 少几次往返
        const dir = '/tmp/thshell-perm-smoke'
        await ssh.exec(
          sid,
          `rm -rf ${dir} && mkdir -p ${dir}/sub && printf a > ${dir}/f644 && printf b > ${dir}/f600 && printf c > ${dir}/f444 && chmod 755 ${dir} && chmod 700 ${dir}/sub && chmod 644 ${dir}/f644 && chmod 600 ${dir}/f600 && chmod 444 ${dir}/f444`
        )

        const asRoot = await listRemote(sftp, dir, { uid: 0, gids: [0], username: 'root' })
        const asMe = await listRemote(sftp, dir, who)
        const asOther = await listRemote(sftp, dir, {
          uid: 100007,
          gids: [100007],
          username: 'smoke-nobody'
        })
        const byName = (list: FileEntry[], n: string) => list.find((e) => e.name === n)
        const isRootUser = who?.uid === 0

        push(
          '权限串按 ls 的写法给',
          byName(asMe, 'f644')?.modeText === 'rw-r--r--' && byName(asMe, 'f600')?.modeText === 'rw-------',
          `${byName(asMe, 'f644')?.modeText || '空'} / ${byName(asMe, 'f600')?.modeText || '空'}`
        )
        push(
          '只读文件和目录的权限也对',
          byName(asMe, 'sub')?.modeText === 'rwx------' && byName(asMe, 'f444')?.modeText === 'r--r--r--',
          `${byName(asMe, 'sub')?.modeText} / ${byName(asMe, 'f444')?.modeText}`
        )
        push(
          '属主和属组都抠出来了',
          !!byName(asMe, 'f644')?.owner && !!byName(asMe, 'f644')?.group,
          `${byName(asMe, 'f644')?.owner}:${byName(asMe, 'f644')?.group}`
        )
        // root 不看权限位：444 也判可写。判成不可写会让人莫名其妙去 sudo
        push(
          'root 无视权限位',
          asRoot.length > 0 && asRoot.every((e) => e.writable === true),
          `${asRoot.filter((e) => e.writable !== true).length} 条判为不可写`
        )
        // 陌生人：这组样本的 other 位都没有 w，一条都不该可写
        push(
          '不属于自己/自己组的文件判为不可写',
          asOther.length > 0 && asOther.every((e) => e.writable === false),
          `${asOther.filter((e) => e.writable).length} 条判为可写`
        )
        push(
          '属主自己按 owner 位判定',
          byName(asMe, 'f600')?.writable === true &&
            byName(asMe, 'f444')?.writable === (isRootUser ? true : false),
          `600=${byName(asMe, 'f600')?.writable} 444=${byName(asMe, 'f444')?.writable}${
            isRootUser ? '（root 例外）' : ''
          }`
        )

        // ---- DOM：远程栏真的进这个目录，看两列渲染成什么样 ----
        await js(`(() => {
          const el = document.querySelectorAll('.fm .pane')[1]?.querySelector('.path-input')
          if (!el) return 'no-input'
          el.value = ${JSON.stringify(dir)}
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
          return 'ok'
        })()`)
        await wait(1800)

        const dom = (await js(`(() => {
          const pane = document.querySelectorAll('.fm .pane')[1]
          const rows = [...(pane?.querySelectorAll('.rows .row') || [])]
          return {
            head: [...(pane?.querySelectorAll('.list-head span') || [])].map((s) => s.textContent.trim()),
            rows: rows.map((r) => ({
              name: r.querySelector('.fname')?.textContent?.trim() || '',
              mode: r.querySelector('.col-mode')?.textContent?.trim() || '',
              owner: r.querySelector('.col-owner')?.textContent?.trim() || '',
              red: !!r.querySelector('.col-mode.nowrite')
            }))
          }
        })()`)) as {
          head: string[]
          rows: { name: string; mode: string; owner: string; red: boolean }[]
        }

        push(
          '表头多了「权限」和「用户 / 组」两列',
          dom.head.includes('权限') && dom.head.includes('用户 / 组'),
          dom.head.join(' | ')
        )
        push(
          '每一行都显示了 9 位权限串',
          dom.rows.length >= 4 && dom.rows.every((r) => /^[rwxsStT-]{9}$/.test(r.mode)),
          `${dom.rows.length} 行，例 ${dom.rows[0]?.mode || '空'}`
        )
        push(
          '用户 / 组按 `user:group` 显示',
          dom.rows.length >= 4 && dom.rows.every((r) => /^[^:]+:[^:]+$/.test(r.owner)),
          dom.rows[0]?.owner || '空'
        )
        // 红字必须和主进程算的一模一样：多标一行会让人白跑一趟 sudo，少标一行会白试一次保存
        const mismatched = dom.rows.filter(
          (r) => r.red !== (byName(asMe, r.name)?.writable === false)
        )
        push(
          '红字只出现在真正写不了的行',
          dom.rows.length >= 4 && mismatched.length === 0,
          mismatched.map((r) => r.name).join(',') || '全部一致'
        )
        if (!isRootUser) {
          push('444 那一行确实是红的', dom.rows.find((r) => r.name === 'f444')?.red === true, '')
        }

        /* 用 root 登录时永远不会有一行是红的（root 无视权限位），
           于是 `.nowrite` 这条 CSS 在真机上永远走不到。这里手动挂一下类，
           量一下颜色到底变没变 —— 只验"钩子接上了"，不伪造整行数据 */
        const redStyle = (await js(`(() => {
          const el = document.querySelector('.list.remote .row .col-mode')
          if (!el) return null
          const before = getComputedStyle(el).color
          el.classList.add('nowrite')
          const after = getComputedStyle(el).color
          el.classList.remove('nowrite')
          return { before, after }
        })()`)) as { before: string; after: string } | null
        push(
          '标红真的接到了危险色上',
          !!redStyle && redStyle.after !== redStyle.before,
          `${redStyle?.before} → ${redStyle?.after}`
        )

        /* 窄窗口下这两列会把文件名挤没：容器查询该按"每栏宽度"收起它们 */
        const [winW, winH] = mainWindow!.getSize()
        mainWindow!.setSize(1080, 760)
        // 改窗口尺寸后布局要再过一帧才稳，800ms 偶尔会量到中间态
        await wait(1200)
        const narrow = (await js(`(() => {
          const pane = document.querySelectorAll('.fm .pane')[1]
          const list = pane?.querySelector('.list')
          const row = pane?.querySelector('.list .row')
          const owner = pane?.querySelector('.col-owner')
          const modeCell = pane?.querySelector('.col-mode')
          const nameCell = pane?.querySelector('.col-name')
          return {
            paneW: Math.round(list?.getBoundingClientRect().width || 0),
            ownerShown: !!owner && getComputedStyle(owner).display !== 'none',
            modeShown: !!modeCell && getComputedStyle(modeCell).display !== 'none',
            template: row ? getComputedStyle(row).gridTemplateColumns : '',
            nameW: Math.round(nameCell?.getBoundingClientRect().width || 0),
            listW: row ? Math.round(row.getBoundingClientRect().width) : 0
          }
        })()`)) as {
          paneW: number
          ownerShown: boolean
          modeShown: boolean
          template: string
          nameW: number
          listW: number
        }
        push(
          '窄窗口下先舍属主列，不挤文件名',
          narrow.paneW >= 560 || (!narrow.ownerShown && narrow.nameW > 90),
          `栏宽 ${narrow.paneW}px（行宽 ${narrow.listW}），属主列${narrow.ownerShown ? '还在' : '已收起'}，权限列${
            narrow.modeShown ? '还在' : '已收起'
          }，文件名 ${narrow.nameW}px，栅格 ${narrow.template}`
        )
        mainWindow!.setSize(winW, winH)
        await wait(1000)
        await shot('thshell-perm.png')

        // 属性面板也跟着改成同一套说法（`rw-r--r-- (644)` + `root:root`），顺手验一下
        await js(`(() => {
          const pane = document.querySelectorAll('.fm .pane')[1]
          const row = [...(pane?.querySelectorAll('.rows .row') || [])].find((r) =>
            r.textContent.includes('f644')
          )
          row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          row?.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 620, clientY: 300 })
          )
          return 'ok'
        })()`)
        await wait(600)
        await js(
          `[...document.querySelectorAll('.ctx-menu .ctx-item')].find((e) => e.textContent.trim() === '属性')?.click()`
        )
        await wait(600)
        const propsText = (await js(`(() => {
          return [...document.querySelectorAll('.props .prop-row')].map((r) => ({
            k: r.querySelector('.prop-k')?.textContent?.trim() || '',
            v: r.querySelector('.prop-v')?.textContent?.replace(/\\s+/g, ' ').trim() || ''
          }))
        })()`)) as { k: string; v: string }[]
        const propOf = (k: string) => propsText.find((r) => r.k === k)?.v || ''
        push(
          '属性面板的权限带八进制',
          /^[rwxsStT-]{9} \(\d{3}\)$/.test(propOf('权限')),
          propOf('权限') || '没有这一行'
        )
        push(
          '属性面板写了属主 / 属组',
          /^[^:]+:[^:]+/.test(propOf('属主 / 属组')),
          propOf('属主 / 属组') || '没有这一行'
        )
        await shot('thshell-perm-props.png')
        await js(
          `document.querySelector('.props')?.closest('.el-dialog')?.querySelector('.el-dialog__footer .el-button')?.click()`
        )
        await wait(400)
        await ssh.exec(sid, `rm -rf ${dir}`)

        let failed = 0
        for (const [name, ok, detail] of checks) {
          if (!ok) failed += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`)
        }
        console.log(`[smoke] perm ${failed ? failed + ' 项失败' : '全部通过'}（${checks.length} 项）`)

        finish()
        return
      }

      // sys 模式：系统信息页。先用一段真实格式的 shell 输出喂解析器逐项断言，
      // 再连真机切到「系统」页截图 —— 解析这种事只在真机上肉眼看，坏了也看不出来。
      if (mode === 'sys') {
        await wait(1500)

        const canned = [
          '@@OS@@',
          'NAME="Ubuntu"',
          'VERSION="22.04.4 LTS (Jammy Jellyfish)"',
          'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
          'ID=ubuntu',
          '@@KERNEL@@',
          'Linux 5.15.0-119-generic x86_64',
          '@@HOST@@',
          'th-node-01',
          '@@CPU@@',
          'model name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz',
          '8',
          '@@MEM@@',
          'MemTotal:       32767684 kB',
          'MemFree:         1234567 kB',
          'MemAvailable:   20000000 kB',
          '@@UP@@',
          '10666560.78 42000000.00',
          '@@LOAD@@',
          '0.52 0.41 0.38 2/345 6789',
          '@@PROC@@',
          '187',
          '@@DATE@@',
          '2026-11-09 17:49:20 CST +0800',
          '@@VIRT@@',
          'kvm',
          '@@DISK@@',
          '/dev/sda1 ext4 40G 12G 26G 32% /boot',
          '/dev/mapper/vg-root ext4 200G 150G 40G 79% /',
          'tmpfs tmpfs 16G 0 16G 0% /dev/shm',
          '@@INODE@@',
          '/dev/sda1 ext4 2621440 300 2621140 1% /boot',
          '/dev/mapper/vg-root ext4 13107200 120000 12987200 1% /',
          'tmpfs tmpfs 4000000 2 3999998 1% /dev/shm',
          '@@LINK@@',
          '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00',
          '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000\\    link/ether 00:50:56:a1:b2:c3 brd ff:ff:ff:ff:ff:ff',
          '3: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state DOWN mode DEFAULT group default\\    link/ether 02:42:1a:2b:3c:4d brd ff:ff:ff:ff:ff:ff',
          '@@ADDR@@',
          '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
          '2: eth0    inet 172.30.10.206/22 brd 172.30.11.255 scope global eth0\\       valid_lft forever preferred_lft forever',
          '2: eth0    inet6 fe80::250:56ff:fea1:b2c3/64 scope link \\       valid_lft forever preferred_lft forever',
          '3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever',
          '@@ROUTE@@',
          'default via 172.30.11.1 dev eth0 proto static',
          '172.30.8.0/22 dev eth0 proto kernel scope link src 172.30.10.206',
          '@@DNS@@',
          'nameserver 172.30.0.2',
          'nameserver 114.114.114.114',
          '@@WHO@@',
          'root     pts/0        2026-11-09 16:45 (10.200.58.237)',
          'root     pts/1        2026-11-09 17:02 ()'
        ].join('\n')

        const fakeExec = async () => ({ code: 0, stdout: canned, stderr: '' })
        const s = await collectSystemInfo(fakeExec)

        const eth0 = s?.nets.find((n) => n.name === 'eth0')
        const docker0 = s?.nets.find((n) => n.name === 'docker0')
        const rootDisk = s?.disks.find((d) => d.mount === '/')

        const checks: [string, boolean, string][] = [
          ['发行版名', s?.os === 'Ubuntu 22.04.4 LTS', s?.os ?? '空'],
          ['内核', s?.kernel === 'Linux 5.15.0-119-generic', s?.kernel ?? '空'],
          ['架构', s?.arch === 'x86_64', s?.arch ?? '空'],
          ['主机名', s?.hostname === 'th-node-01', s?.hostname ?? '空'],
          ['CPU 型号', (s?.cpuModel ?? '').includes('E5-2680'), s?.cpuModel ?? '空'],
          ['核心数', s?.cpuCores === 8, `${s?.cpuCores}`],
          ['内存 MB', s?.memTotal === 32000, `${s?.memTotal}`],
          ['Swap 未启用', s?.swapTotal === 0, `${s?.swapTotal}`],
          ['运行时长', s?.uptime === 10666561, `${s?.uptime}s`],
          ['负载', s?.load1 === 0.52, `${s?.load1}`],
          ['进程数', s?.processes === 187, `${s?.processes}`],
          ['虚拟化', s?.virt === 'kvm', s?.virt ?? '空'],
          ['磁盘行数', s?.disks.length === 3, `${s?.disks.length}`],
          ['根分区使用率', rootDisk?.usePercent === 79, `${rootDisk?.usePercent}`],
          ['根分区 inode 已合并', rootDisk?.inodePercent === 1, `${rootDisk?.inodePercent}`],
          ['网卡排除 lo', s?.nets.length === 2, (s?.nets ?? []).map((n) => n.name).join(',')],
          ['eth0 是 UP', eth0?.up === true, `${eth0?.up}`],
          ['eth0 取到 IPv4', eth0?.ipv4[0] === '172.30.10.206/22', eth0?.ipv4.join(',') ?? '空'],
          ['跳过链路本地 IPv6', (eth0?.ipv6.length ?? -1) === 0, (eth0?.ipv6 ?? []).join(',')],
          ['docker0 是 DOWN', docker0?.up === false, `${docker0?.up}`],
          ['默认网关', s?.gateways[0] === '172.30.11.1', (s?.gateways ?? []).join(',')],
          ['DNS 两条', s?.dns.length === 2, (s?.dns ?? []).join(',')],
          ['登录会话两条', s?.sessions.length === 2, `${s?.sessions.length}`]
        ]

        // 连真机看界面：解析对了不代表页面排得下
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(5000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('系统'))?.click()`
        )
        await wait(2500)
        const dom = (await js(`(() => {
          const rows = document.querySelectorAll('.sys .tbl .tr:not(.th)').length
          const ifaces = document.querySelectorAll('.sys .iface').length
          const table = document.querySelector('.sys .tbl')?.textContent || ''
          const body = document.querySelector('.sys-body')?.textContent || ''
          return { rows, ifaces, overlay: table.includes('overlay2'), fold: !!document.querySelector('.sys .extra-toggle'), unsupported: body.includes('没有返回系统信息') }
        })()`)) as {
          rows: number
          ifaces: number
          overlay: boolean
          fold: boolean
          unsupported: boolean
        }
        checks.push(['真机：磁盘行渲染', dom.rows > 0, `${dom.rows} 行`])
        checks.push(['真机：滤掉 docker 分层挂载', !dom.overlay, ''])
        checks.push(['真机：业务网卡渲染', dom.ifaces > 0, `${dom.ifaces} 张`])
        checks.push(['真机：虚拟网卡折叠', dom.fold === true, ''])
        checks.push(['真机：采到了系统信息', !dom.unsupported, ''])
        await wait(400)
        await shot('thshell-sysinfo.png')
        // 网络和会话在折叠线以下，滚到底再拍一张
        await js(`(() => { const b = document.querySelector('.sys-body'); if (b) b.scrollTop = 99999; return 'ok' })()`)
        await wait(400)
        await shot('thshell-sysinfo-net.png')

        // 折叠区要能展开：这里坏掉的话界面上看不出问题，只是"点了没反应"
        await js(`document.querySelector('.sys .extra-toggle')?.click()`)
        await wait(400)
        const extraRows = (await js(`document.querySelectorAll('.sys .extra-row').length`)) as number
        checks.push(['展开虚拟网卡', extraRows > 0, `${extraRows} 行`])
        await shot('thshell-sysinfo-fold.png')

        let failed = 0
        for (const [name, ok, detail] of checks) {
          if (!ok) failed += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`)
        }
        console.log(`[smoke] sys ${failed ? failed + ' 项失败' : '全部通过'}`)

        finish()
        return
      }

      // metrics 模式：拿一段真实格式的 /proc 输出喂给采集器，验证解析。
      // 这类"整段输出拼接 + split 取值"的代码最容易静默解析成 0，
      // 界面上只表现为「0 / 0 GB」，不报错，所以必须有一条固定的回归用例。
      if (mode === 'metrics') {
        const canned = [
          'cpu  120000 400 30000 900000 2000 0 800 0 0 0',
          '@@MEM@@',
          'MemTotal:       16333868 kB',
          'MemFree:          234567 kB',
          'MemAvailable:    8765432 kB',
          'Buffers:          123456 kB',
          'Cached:          4567890 kB',
          'SwapTotal:       8388604 kB',
          'SwapFree:        1048576 kB',
          '@@NET@@',
          'Inter-|   Receive                          |  Transmit',
          ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
          '    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0',
          '  eth0: 500000 500 0 0 0 0 0 0 250000 400 0 0 0 0 0 0',
          '@@LOAD@@',
          '0.52 0.41 0.38 2/345 6789',
          '@@UP@@',
          '123456.78 987654.32',
          '@@DISK@@',
          '/dev/vda1      41152736  12345678  26708058  32% /',
          '@@PS@@',
          '187'
        ].join('\n')

        clearMetricsState('smoke-metrics')
        const fakeExec = async () => ({ code: 0, stdout: canned, stderr: '' })
        const first = await collectMetrics('smoke-metrics', fakeExec)
        const second = await collectMetrics('smoke-metrics', fakeExec)

        const checks: [string, boolean, string][] = [
          ['内存总量', first?.memTotal === 15951, `${first?.memTotal} MB（期望 15951）`],
          ['内存已用', first?.memUsed === 7391, `${first?.memUsed} MB（期望 7391）`],
          ['Swap 总量', first?.swapTotal === 8192, `${first?.swapTotal} MB（期望 8192）`],
          ['磁盘总量', first?.diskTotal === 40188, `${first?.diskTotal} MB（期望 40188）`],
          ['磁盘已用', first?.diskUsed === 12056, `${first?.diskUsed} MB（期望 12056）`],
          ['运行时长', first?.uptime === 123457, `${first?.uptime}s（期望 123457）`],
          ['进程数', first?.processes === 187, `${first?.processes}（期望 187）`],
          ['负载 1 分钟', first?.load1 === 0.52, `${first?.load1}（期望 0.52）`],
          ['网络不计 lo', second?.netRx === 0, `rx=${second?.netRx} KB/s（同段数据应差 0）`]
        ]
        let failed = 0
        for (const [name, ok, detail] of checks) {
          if (!ok) failed += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
        }
        console.log(`[smoke] metrics ${failed ? failed + ' 项失败' : '全部通过'}`)
        clearMetricsState('smoke-metrics')

        finish()
        return
      }

      // tips 模式：逐个把指针移到文件管理里的图标按钮上，记录能不能弹出提示。
      // 提示是"有就有、没有也不会报错"的东西，靠肉眼一个个试太容易漏，
      // 干脆遍历一遍把"无提示"的点名出来。
      if (mode === 'tips') {
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(3000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(1800)

        // 窗口没拿到焦点时，sendInputEvent 的鼠标移动不一定被算作悬停，
        // 前几项会连着"无提示"（假失败）。先激活窗口再热一下指针。
        mainWindow!.focus()
        mainWindow!.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 400 })
        await wait(400)

        // [名称, 栏序号, 选择器, 同选择器内的序号]
        const targets: [string, number, string, number][] = [          ['本地·上一级', 0, '.pane-bar .ic', 0],
          ['本地·打开目录', 0, '.pane-bar .ic', 1],
          ['本地·刷新', 0, '.pane-bar .ic', 2],
          ['远程·上一级', 1, '.pane-bar .ic', 0],
          ['远程·刷新', 1, '.pane-bar .ic', 1],
          ['本地·新建文件夹', 0, '.pane-foot .el-button', 0],
          ['本地·重命名', 0, '.pane-foot .el-button', 1],
          ['本地·删除', 0, '.pane-foot .el-button', 2],
          ['远程·新建文件夹', 1, '.pane-foot .el-button', 0],
          ['远程·删除', 1, '.pane-foot .el-button', 2],
          ['远程·编辑', 1, '.pane-foot .el-button', 3]
        ]

        let missing = 0
        for (const [name, paneIdx, selector, idx] of targets) {
          const expr = `(document.querySelectorAll('.fm .pane')[${paneIdx}] || {querySelectorAll: () => []})
                          .querySelectorAll(${JSON.stringify(selector)})[${idx}]`

          /**
           * 触发方式用合成的 mouseenter，而不是移动真指针。
           * 真指针依赖窗口焦点，冒烟实例常常不在前台，头几项会"无提示"（假失败）；
           * 而 el-tooltip 监听的是 mouseenter 事件本身，合成事件一样能展开。
           * （注意：CSS :hover 不认合成事件，所以"悬停底色"那条验证仍必须用真指针。）
           */
          const enter = () =>
            js(`(() => { const el = ${expr}; if (!el) return ''; el.dispatchEvent(new MouseEvent('mouseenter')); return 'ok' })()`)

          /**
           * 直接问"这个按钮"自己的提示，而不是在 body 里猜。
           * el-tooltip 展开时会给触发器写上 aria-describedby 指向自己的 popper，
           * 用这条关系取文案是确定的；按坐标猜"最近的气泡"会被还没关干净的
           * 上一个气泡骗到（出现过「刷新: 上一级」这种假通过）。
           */
          const readTip = () =>
            js(
              `(() => {
                 const el = ${expr}
                 if (!el) return ''
                 const id = el.getAttribute('aria-describedby')
                 if (!id) return ''
                 const tip = document.getElementById(id)
                 if (!tip) return ''
                 const r = tip.getBoundingClientRect()
                 if (!r.width || getComputedStyle(tip).visibility === 'hidden') return ''
                 return tip.textContent.trim()
               })()`
            )

          const leave = () => js(`(() => { const el = ${expr}; el && el.dispatchEvent(new MouseEvent('mouseleave')); return 'ok' })()`)

          if ((await enter()) !== 'ok') {
            console.log(`[smoke] SKIP ${name}: 找不到元素`)
            continue
          }
          // show-after 是 400ms，但相邻两个提示之间有开关动画，偶尔会慢半拍。
          // 轮询到出现为止（最多约 2.4s），比写死一个 wait 稳。
          let text = ''
          for (let i = 0; i < 8 && !text; i += 1) {
            await wait(300)
            text = ((await readTip()) as string) || ''
          }
          await leave()
          await wait(400)

          const ok = !!text
          if (!ok) missing += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'MISS'} ${name}: ${text || '无提示'}`)
        }
        console.log(`[smoke] tips ${missing ? missing + ' 处缺提示' : '全部有提示'}`)

        // 截图前把"刷新"的提示展开，留一张带气泡的图给人看
        await js(
          `(() => {
             const pane = document.querySelectorAll('.fm .pane')[1]
             const el = pane ? pane.querySelectorAll('.pane-bar .ic')[1] : null
             if (el) el.dispatchEvent(new MouseEvent('mouseenter'))
             return 'ok'
           })()`
        )
        await wait(900)

        await shot('thshell-tips.png')
        finish()
        return
      }

      // icons 模式：把各处图标的实际字号量出来。
      // "这个图标太大/太小"被反馈过三次了，靠截图目测永远说不清 ——
      // 直接把 computed fontSize 和 svg 的实际像素框打出来，比一句"看起来不对"有用。
      if (mode === 'icons') {
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(4000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(1800)

        const picked = (await js(`(() => {
          const box = (el) => {
            if (!el) return null
            const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg')
            const r = (svg || el).getBoundingClientRect()
            return {
              fontSize: getComputedStyle(el).fontSize,
              w: Math.round(r.width),
              h: Math.round(r.height)
            }
          }
          return {
            tabs: box(document.querySelector('.seg-btn .el-icon')),
            pathBar: box(document.querySelector('.pane-bar .ic')),
            foot: box(document.querySelector('.pane-foot .el-button .el-icon')),
            footBtn: box(document.querySelector('.pane-foot .el-button')),
            link: box(document.querySelector('.connect-btn'))
          }
        })()`)) as Record<string, { fontSize: string; w: number; h: number } | null>

        let failed = 0
        for (const [name, v] of Object.entries(picked)) {
          console.log(`[smoke] ${name}: font=${v?.fontSize ?? '无'} 框=${v ? v.w + '×' + v.h : '无'}`)
        }
        // 用户的要求很具体：路径栏和底栏的图标要跟页签图标一样大
        const want = picked.tabs?.fontSize
        const same = (k: string) => !!want && picked[k]?.fontSize === want && (picked[k]?.w ?? 0) > 0
        for (const [label, key] of [
          ['路径栏图标与页签一致', 'pathBar'],
          ['底栏图标与页签一致', 'foot']
        ] as const) {
          const ok = same(key)
          if (!ok) failed += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${label}：${picked[key]?.fontSize ?? '无'}`)
        }
        console.log(`[smoke] icons ${failed ? failed + ' 项不一致' : '全部一致'}`)

        await shot('thshell-icons.png')
        finish()
        return
      }

      // quick 模式：终端底部的快捷命令栏 + 全部命令浮层。
      // 这类"工具条"的价值全在能不能找到东西，所以要同时验：数量、每条是否带说明、
      // 浮层有没有顶出窗格、fill 类命令是不是真的只写进提示符不回车。
      if (mode === 'quick') {
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(4000)

        const checks: [string, boolean, string][] = []
        const push = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail])

        /**
         * 读某个元素的提示文案。
         * 用合成的 mouseenter 而不是移动真指针：冒烟实例常不在前台，真指针的 hover
         * 前几项会读成"无提示"（假失败）。el-tooltip 监听的是事件本身，合成事件一样能展开。
         * 文案按 aria-describedby 找自己的 popper，不在 body 里按坐标猜。
         */
        const tipOf = async (selector: string, idx: number) => {
          const expr = `document.querySelectorAll(${JSON.stringify(selector)})[${idx}]`
          await js(`(() => { const el = ${expr}; if (el) el.dispatchEvent(new MouseEvent('mouseenter')); })()`)
          let text = ''
          for (let i = 0; i < 8 && !text; i += 1) {
            await wait(300)
            text = (await js(`(() => {
              const el = ${expr}
              if (!el) return ''
              const id = el.getAttribute('aria-describedby')
              const tip = id ? document.getElementById(id) : null
              if (!tip) return ''
              if (!tip.getBoundingClientRect().width) return ''
              if (getComputedStyle(tip).visibility === 'hidden') return ''
              return tip.textContent.trim()
            })()`)) as string
          }
          await js(`(() => { const el = ${expr}; if (el) el.dispatchEvent(new MouseEvent('mouseleave')); })()`)
          await wait(320)
          return text
        }

        const bar = (await js(`(() => {
          const chips = [...document.querySelectorAll('.quick-chip')]
          return { n: chips.length, cmds: chips.map((c) => c.textContent.trim()) }
        })()`)) as { n: number; cmds: string[] }
        push('常驻一键命令', bar.n >= 6, `${bar.n} 条：${bar.cmds.join(' / ')}`)

        // 常驻栏每条都要有悬停说明
        const barNoTip: string[] = []
        for (let i = 0; i < bar.n; i += 1) {
          const t = await tipOf('.quick-chip', i)
          if (!t) barNoTip.push(bar.cmds[i])
          else if (i === 0) push('悬停显示命令说明', t.length > 0, t.replace(/\s+/g, ' ').slice(0, 40))
        }
        push('常驻栏全部有说明', barNoTip.length === 0, barNoTip.join(',') || '无缺失')

        // 打开全部命令浮层
        await js(`document.querySelector('.quick-label')?.click()`)
        await wait(500)
        const panel = (await js(`(() => {
          const p = document.querySelector('.quick-panel')
          if (!p) return { open: false }
          const items = [...p.querySelectorAll('.qp-chip')]
          const noDesc = items.filter((c) => !((c.querySelector('.qp-desc') || {}).textContent || '').trim())
          const r = p.getBoundingClientRect()
          return {
            open: getComputedStyle(p).display !== 'none',
            groups: p.querySelectorAll('.qp-glabel').length,
            groupNames: [...p.querySelectorAll('.qp-glabel')].map((g) => g.textContent.trim()),
            items: items.length,
            noDesc: noDesc.length,
            fills: p.querySelectorAll('.qp-chip.fill').length,
            top: Math.round(r.top),
            height: Math.round(r.height),
            viewH: window.innerHeight
          }
        })()`)) as {
          open: boolean
          groups: number
          groupNames: string[]
          items: number
          noDesc: number
          fills: number
          top: number
          height: number
          viewH: number
        }
        push('浮层能展开', panel.open, '')
        push('分组数', panel.groups >= 5, panel.groupNames.join(' / '))
        push('命令总数', panel.items >= 28, `${panel.items} 条`)
        push('每条都有说明文字', panel.noDesc === 0, panel.noDesc ? `${panel.noDesc} 条缺说明` : '')
        push('带占位参数的命令', panel.fills >= 2, `${panel.fills} 条`)
        // 浮层向上展开，顶边不能被顶出窗口
        push('浮层没有顶出窗格', panel.top >= 0 && panel.height > 100, `top=${panel.top} h=${panel.height} 窗高=${panel.viewH}`)

        // 浮层里的命令也要有悬停说明；顺便验 fill 类多一行"只插入不执行"
        const fillTip = await tipOf('.qp-chip.fill', 0)
        push('浮层命令有说明', !!fillTip, fillTip.replace(/\s+/g, ' ').slice(0, 50))
        push('fill 类提示了"只插入"', fillTip.includes('插入'), '')

        /**
         * 行为验证：不截获 IPC，直接看终端里发生了什么。
         * contextBridge 暴露的对象是只读的，挂不了 spy，所以只能读屏幕：
         * - run 类点完应该真打出结果（df -h 的输出里有 Filesystem）
         * - fill 类点完应该只停在提示符上，最后一行是"提示符 + 命令"，没有输出
         * 先测 run 再测 fill，否则那条没回车的命令会被下一条命令拼在一起。
         */
        const lastRows = async (n: number) =>
          (await js(`(() => {
            const rows = [...document.querySelectorAll('.xterm-rows > div')]
              .map((d) => (d.textContent || '').replace(/\\u00a0/g, ' ').trimEnd())
              .filter((r) => r.trim())
            return rows.slice(-${n})
          })()`)) as string[]

        await js(`(() => {
          const chip = [...document.querySelectorAll('.quick-chip')].find((c) => c.textContent.includes('df -h'))
          chip?.click()
        })()`)
        await wait(1500)
        const runTail = await lastRows(40)
        // 不能断言 "Filesystem"：中文 locale 的机器上 df 表头是「文件系统」。
        // 使用率那一列（34% /）不受语言影响，拿它当判据。
        push(
          '普通命令真的执行了',
          runTail.some((r) => /\d+%/.test(r) && r.includes('/')),
          runTail.slice(-2).join(' | ') || '终端是空的'
        )

        const closedAfterRun = (await js(`(() => {
          const p = document.querySelector('.quick-panel')
          return p ? getComputedStyle(p).display === 'none' : false
        })()`)) as boolean
        push('执行后面板收起', closedAfterRun, '')

        // 重新打开浮层，点那条带占位端口的 lsof
        await js(`document.querySelector('.quick-label')?.click()`)
        await wait(400)
        await js(`document.querySelectorAll('.qp-chip.fill')[0]?.click()`)
        await wait(600)
        const fillTail = await lastRows(4)
        const lastLine = fillTail.slice(-1)[0] ?? ''
        push('fill 类只插入不回车', lastLine.includes('lsof -i:8080'), lastLine.slice(-48))

        // 截图放到所有交互之后：capturePage 会让窗口短暂失焦，前面的断言会被打断
        await js(`(() => {
          const p = document.querySelector('.quick-panel')
          if (p && getComputedStyle(p).display === 'none') document.querySelector('.quick-label')?.click()
        })()`)
        // 真指针默认停在窗口中间，可能正好压住某张卡片弹出一个不属于本次验证的气泡。
        // 先把它挪到右下角状态栏，截图才只剩我主动触发的那个提示。
        const [cw, ch] = mainWindow!.getContentSize()
        mainWindow!.webContents.sendInputEvent({ type: 'mouseMove', x: cw - 8, y: ch - 8 })
        await wait(400)
        await shot('thshell-quick.png')

        // 再拍一张带气泡的：气泡的 max-width / 行距只在真实渲染下才看得出好不好读
        // 第 9 张卡片是 `du -sh * | sort -h`，带 note，三行都齐
        await js(`(() => {
          const el = document.querySelectorAll('.qp-chip')[9]
          if (el) el.dispatchEvent(new MouseEvent('mouseenter'))
        })()`)
        await wait(800)
        await shot('thshell-quick-tip.png')

        let failed = 0
        for (const [name, ok, detail] of checks) {
          if (!ok) failed += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`)
        }
        console.log(`[smoke] quick ${failed ? failed + ' 项失败' : '全部通过'}（${checks.length} 项）`)

        finish()
        return
      }

      // monitor 模式：连上真机后切到监控页，打印卡片布局的实际尺寸并截图。
      // 卡片被裁、圆环数字跑位这类问题肉眼只能看出"不对"，量一遍才知道是谁撑破了容器。
      if (mode === 'monitor') {
        // 窗口宽度可指定，用来复现"窄窗口下卡片被裁"这类只在特定宽度出现的问题
        const probeW = Number(process.env.THSHELL_SMOKE_W || 0)
        if (probeW > 0) mainWindow!.setContentSize(probeW, 823)
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(3000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('监控'))?.click()`
        )
        // 指标每秒一采，等几拍再去量，否则还是空态
        await wait(6500)

        const layout = await js(
          `(() => {
             const pick = (el) => {
               if (!el) return null
               const r = el.getBoundingClientRect()
               return { l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }
             }
             const cards = [...document.querySelectorAll('.monitor .card')]
             const wrap = document.querySelector('.monitor')
             return JSON.stringify({
               dpr: window.devicePixelRatio,
               inner: window.innerWidth,
               scrollW: document.documentElement.scrollWidth,
               monitor: pick(wrap),
               monitorScrollW: wrap ? wrap.scrollWidth : null,
               grid: pick(document.querySelector('.monitor .cards')),
               cards: cards.map(pick),
               ringText: cards[0] ? pick(cards[0].querySelector('.ring-text')) : null
             }, null, 1)
           })()`
        )
        console.log('[smoke] layout', layout)
        await shot('thshell-monitor.png')

        await js(`document.documentElement.dataset.theme = 'light'`)
        await wait(700)
        await shot('thshell-monitor-light.png')

        finish()
        return
      }

      // jump 模式：验证路径栏的「跳转」下拉（常用位置 + 盘符）和远程常用目录
      if (mode === 'jump') {
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(3000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(2000)

        // 常用位置是从主进程现取的，顺便确认「桌面/下载/文档」都解析到了
        const places = await js(
          `window.api.local.places().then((p) => JSON.stringify(p.map((x) => x.label + '=' + x.path)))`
        )
        console.log('[smoke] places', places)

        await js(`document.querySelector('.pane-tag.local.jump')?.click()`)
        await wait(600)
        await shot('thshell-jump-local.png')

        const closeDropdown = () =>
          js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
        await closeDropdown()
        await wait(300)

        await js(`document.querySelector('.pane-tag.remote.jump')?.click()`)
        await wait(600)
        await shot('thshell-jump-remote.png')

        // 点「根目录」应把远程栏切到 /
        await js(
          `[...document.querySelectorAll('.pl-dropdown .el-dropdown-menu__item')]` +
            `.find((e) => e.textContent.includes('根目录'))?.click()`
        )
        await wait(900)
        await shot('thshell-jump-remote-root.png')

        // 浅色主题下再看一眼：标签底色、caret、路径列对比度
        await js(`document.documentElement.dataset.theme = 'light'`)
        await wait(600)
        await js(`document.querySelector('.pane-tag.local.jump')?.click()`)
        await wait(600)
        await shot('thshell-jump-light.png')

        finish()
        return
      }

      // foot 模式：把鼠标"悬停"到文件管理底栏的三个图标按钮上，验证 hover 底色和
      // 原生 tooltip 的配色 —— 这两处最容易掉回 Element Plus 的浅色默认值（白块）。
      // 合成事件不会移动真实光标，所以用 mouseenter + 手动等 tooltip 的 show-after。
      if (mode === 'foot') {
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(3000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(1800)

        // 先选一行，否则重命名/删除是 disabled，hover 底色看不出来
        await js(
          `document.querySelectorAll('.fm .pane')[0]?.querySelectorAll('.rows .row')[3]?.click()`
        )
        await wait(400)

        // 窗口不在前台时，sendInputEvent 的移动不一定算作悬停，底色会读到透明（假失败）
        mainWindow!.focus()
        mainWindow!.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 400 })
        await wait(350)

        // 合成的 mouseenter 只能触发 tooltip，触发不了 CSS :hover —— 要验悬停底色
        // 必须真的把指针移进去，走 sendInputEvent 让 Chromium 自己算 hit-test。
        const hoverFoot = async (index: number) => {
          const box = await js(
            `(() => {
               const b = document.querySelectorAll('.fm .pane')[0]?.querySelectorAll('.pane-foot .el-button')[${index}]
               if (!b) return ''
               const r = b.getBoundingClientRect()
               return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
             })()`
          )
          if (!box) return 'no-button'
          const point = JSON.parse(box as string)
          mainWindow!.webContents.sendInputEvent({
            type: 'mouseMove',
            x: Math.round(point.x),
            y: Math.round(point.y)
          })
          // 指针移动 → :hover 生效有延迟，轮询到"不再是透明"为止，别赌一个固定 wait
          let out = ''
          for (let i = 0; i < 6; i += 1) {
            await wait(200)
            out = (await js(
              `(() => {
                 const b = document.querySelectorAll('.fm .pane')[0]?.querySelectorAll('.pane-foot .el-button')[${index}]
                 if (!b) return 'gone'
                 const s = getComputedStyle(b)
                 const r = b.getBoundingClientRect()
                 return s.backgroundColor + '  ' + Math.round(r.width) + 'x' + Math.round(r.height)
               })()`
            )) as string
            if (!out.startsWith('rgba(0, 0, 0, 0)')) break
          }
          return out
        }

        console.log('[smoke] hover-rename', await hoverFoot(1))
        await wait(900)
        await shot('thshell-foot-hover.png')

        // 再悬停删除：应当转成红色而不是同一个灰底
        await js(
          `document.querySelectorAll('.fm .pane')[0]?.querySelectorAll('.pane-foot .el-button')[1]
             ?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))`
        )
        await wait(200)
        console.log('[smoke] hover-delete', await hoverFoot(2))
        await wait(900)
        await shot('thshell-foot-danger.png')

        // 提示气泡的"有没有 / 文案对不对"由 tips 模式负责，这里只看悬停底色，
        // 免得同一件事两套判定（两套就会有其中一套偶尔假失败）。
        // 同一个坑还会出现在别处的 text 按钮上（侧栏「添加服务器」），顺手确认一下
        const sideHint = await js(
          `(() => {
             const b = document.querySelector('.sidebar-foot .el-button')
             if (!b) return 'no-button'
             const r = b.getBoundingClientRect()
             return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
           })()`
        )
        if (sideHint) {
          const p = JSON.parse(sideHint as string)
          mainWindow!.webContents.sendInputEvent({
            type: 'mouseMove',
            x: Math.round(p.x),
            y: Math.round(p.y)
          })
          // 指针移动 → :hover 生效有延迟，轮询到变为止，别写死一个 wait 赌运气
          let bg = ''
          for (let i = 0; i < 6; i += 1) {
            await wait(220)
            bg = (await js(
              `getComputedStyle(document.querySelector('.sidebar-foot .el-button')).backgroundColor`
            )) as string
            if (bg && bg !== 'rgba(0, 0, 0, 0)') break
          }
          console.log('[smoke] hover-sidebar', bg)
          await shot('thshell-foot-sidebar.png')
        }

        // 浅色主题下再看一眼，确认 hover 底色不会糊成一片
        await js(`document.documentElement.dataset.theme = 'light'`)
        await wait(500)
        await hoverFoot(2)
        await wait(900)
        await shot('thshell-foot-light.png')

        finish()
        return
      }

      // clip 模式：验证文件剪贴板在菜单里的呈现 —— 复制/剪切后"粘贴"文案要跟着来源变，
      // 剪切的源要淡显。只点菜单不真的粘贴，避免往服务器写垃圾。
      if (mode === 'clip') {
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(3000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(1800)

        const rightClick = (paneIndex: number, rowIndex: number, x: number, y: number) =>
          js(
            `document.querySelectorAll('.fm .pane')[${paneIndex}]` +
              `?.querySelectorAll('.rows .row')[${rowIndex}]` +
              `?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }))`
          )
        const closeMenu = () =>
          js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
        const clickItem = (label: string) =>
          js(
            `[...document.querySelectorAll('.ctx-item')]` +
              `.find((e) => e.querySelector('span')?.textContent.trim() === ${JSON.stringify(label)})?.click()`
          )

        // 远程复制 → 再右键，菜单里应出现「粘贴」和「粘贴（上传）」的分工
        await rightClick(1, 2, 620, 300)
        await wait(400)
        await shot('thshell-clip-1-menu.png')
        await clickItem('复制')
        await wait(500)

        await rightClick(1, 4, 620, 340)
        await wait(450)
        await shot('thshell-clip-2-remote-paste.png')

        // 本地剪切 → 源行应淡显，远程栏的粘贴应变成「粘贴（上传）」
        await closeMenu()
        await wait(250)
        await rightClick(0, 5, 300, 340)
        await wait(400)
        await clickItem('剪切')
        await wait(500)
        await shot('thshell-clip-3-cut-local.png')

        await rightClick(1, 4, 620, 340)
        await wait(450)
        await shot('thshell-clip-4-upload-label.png')

        finish()
        return
      }

      // update 模式：检查更新。
      // 在本机起一个临时 HTTP 服务当"更新源"，把 有新版本 / 已是最新 / JSON 坏了 / 404 /
      // 校验和对不上 这几条路都走一遍。不依赖外网，也不碰用户真实的配置文件。
      if (mode === 'update') {
        await wait(800)
        const http = await import('node:http')
        const cryptoMod = await import('node:crypto')

        // 假装是个 80KB 的安装包
        const payload = cryptoMod.randomBytes(80 * 1024)
        const goodSha = cryptoMod.createHash('sha256').update(payload).digest('hex')
        const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
        const format =
          process.platform === 'win32' ? 'exe' : process.platform === 'darwin' ? 'dmg' : 'deb'

        const manifestOf = (
          version: string,
          sha: string,
          extra: { url?: string; mirrors?: string[] } = {}
        ) => ({
          version,
          publishedAt: new Date().toISOString(),
          notes: '1. 新增检查更新\n2. 修复若干问题',
          assets: [
            {
              platform: process.platform,
              arch,
              format,
              // 故意用相对路径：客户端要能按 latest.json 的位置解析出来
              url: extra.url ?? `files/ThShell-${version}-${process.platform}.${format}`,
              mirrors: extra.mirrors,
              size: payload.length,
              sha256: sha
            }
          ]
        })

        const server = http.createServer((req, res) => {
          const url = (req.url || '/').split('?')[0]
          if (url === '/new.json') {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(manifestOf('9.9.9', goodSha)))
            return
          }
          if (url === '/same.json') {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(manifestOf(app.getVersion(), goodSha)))
            return
          }
          if (url === '/badsha.json') {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(manifestOf('9.9.9', '0'.repeat(64))))
            return
          }
          if (url === '/broken.json') {
            res.end('{ 这不是 JSON')
            return
          }
          // 主地址不存在、镜像好用 —— 测换源兜底（GitHub 下不动时的真实场景）
          if (url === '/mirror.json') {
            res.setHeader('content-type', 'application/json')
            res.end(
              JSON.stringify(
                manifestOf('9.9.9', goodSha, {
                  url: 'gone/ThShell-missing.bin',
                  mirrors: [`files/ThShell-9.9.9-${process.platform}.${format}`]
                })
              )
            )
            return
          }
          // 主地址和镜像全挂 —— 报错里要说清楚每一个源都试过了
          if (url === '/allgone.json') {
            res.setHeader('content-type', 'application/json')
            res.end(
              JSON.stringify(
                manifestOf('9.9.9', goodSha, {
                  url: 'gone/a.bin',
                  mirrors: ['gone/b.bin']
                })
              )
            )
            return
          }
          if (url.startsWith('/files/')) {
            res.setHeader('content-type', 'application/octet-stream')
            res.setHeader('content-length', String(payload.length))
            res.end(payload)
            return
          }
          res.statusCode = 404
          res.end('not found')
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
        const port = (server.address() as { port: number }).port
        const base = `http://127.0.0.1:${port}`

        const checks: [string, boolean, string][] = []
        const push = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail])

        // 1. 版本比较：字符串比较会把 0.10 判成小于 0.9
        push('0.10.0 > 0.9.9', compareVersions('0.10.0', '0.9.9') === 1)
        push('0.1.0 = v0.1.0', compareVersions('v0.1.0', '0.1.0') === 0)
        push('0.1.0 < 0.1.1', compareVersions('0.1.0', '0.1.1') === -1)

        // 2. 有新版本
        const newer = await checkForUpdates(`${base}/new.json`)
        push('查到新版本', newer.hasUpdate && newer.latest === '9.9.9', `${newer.current} → ${newer.latest ?? '无'}`)
        push('挑出了本平台的包', !!newer.asset, newer.asset ? `${newer.asset.platform}/${newer.asset.arch}/${newer.asset.format}` : '无')
        push('相对地址解析成了绝对地址', !!newer.asset?.url.startsWith(base), newer.asset?.url ?? '')

        // 3. 已是最新
        const same = await checkForUpdates(`${base}/same.json`)
        push('同版本时判定为已是最新', !same.hasUpdate && !same.error, same.latest ?? '')

        // 4. 更新源写坏了
        const broken = await checkForUpdates(`${base}/broken.json`)
        push('JSON 坏掉时给出可读的错误', !!broken.error, broken.error ?? '无')
        const missing = await checkForUpdates(`${base}/nope.json`)
        push('404 时把状态码带出来', (missing.error ?? '').includes('404'), missing.error ?? '无')

        // 内置候选：直连 + 两个国内加速镜像。空源会并发试这三条，
        // 冒烟里只验常量形态，不真去连 GitHub（那要等超时）
        push('内置三条更新通道', DEFAULT_UPDATE_FEEDS.length === 3, `${DEFAULT_UPDATE_FEEDS.length} 条`)
        push(
          '后两条是国内加速镜像',
          DEFAULT_UPDATE_FEEDS.slice(1).every((u) => /ghfast\.top|gh-proxy\.com/.test(u)),
          DEFAULT_UPDATE_FEEDS.slice(1).map((u) => u.split('/')[2]).join(' / ')
        )
        push(
          '每条都指向 releases/latest/download',
          DEFAULT_UPDATE_FEEDS.every((u) => u.endsWith('/releases/latest/download/latest.json'))
        )

        // 多通道并发：一个坏一个好，应该用好的那个，并把实际通道回报出来
        const multi = await checkForUpdates([`${base}/nope.json`, `${base}/new.json`])
        push('通道里有一个通就行', multi.hasUpdate && multi.latest === '9.9.9', `${multi.latest ?? '无'}`)
        push('回报了实际走通的那条', (multi.feed ?? '') === `${base}/new.json`, multi.feed ?? '无')

        // 下载地址自动补镜像：latest.json 里不写 mirrors 也能换道
        const direct = withFallbackUrls({
          platform: 'win32',
          arch: 'x64',
          format: 'exe',
          url: 'https://github.com/ElvisZhang0/ThShell/releases/latest/download/a.exe'
        })
        push(
          '直连地址自动补上镜像',
          (direct.mirrors?.length ?? 0) >= 2 && direct.mirrors!.every((u) => u.includes('github.com')),
          `${direct.mirrors?.length ?? 0} 条备用`
        )
        const fromMirror = withFallbackUrls({
          platform: 'win32',
          arch: 'x64',
          format: 'exe',
          url: 'https://ghfast.top/https://github.com/x/y/releases/download/v1/a.exe'
        })
        push(
          '镜像地址反推出直连',
          fromMirror.mirrors?.[0] === 'https://github.com/x/y/releases/download/v1/a.exe',
          fromMirror.mirrors?.[0] ?? '无'
        )

        // 5. 下载 + 校验和
        let lastPercent = 0
        const file = newer.asset
          ? await downloadUpdate(newer.asset, (p) => {
              lastPercent = p.percent
            })
          : null
        const size = file && fs.existsSync(file) ? fs.statSync(file).size : -1
        push('下载完成且大小一致', size === payload.length, `${size} 字节`)
        push('下载过程有进度上报', lastPercent > 0, `${lastPercent}%`)
        const got = file ? cryptoMod.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : ''
        push('sha256 与更新源一致', got === goodSha, got.slice(0, 12))

        // 6. 校验和对不上时必须拒绝（内网文件服务器放错版本就靠它兜底）
        const bad = await checkForUpdates(`${base}/badsha.json`)
        let badErr = ''
        if (bad.asset) {
          try {
            await downloadUpdate(bad.asset, () => {})
          } catch (err) {
            badErr = err instanceof Error ? err.message : String(err)
          }
        }
        push('校验不通过时拒绝安装包', badErr.includes('校验'), badErr || '没有报错')

        // 7. 结构校验：少 version 的 manifest 要当场说清楚
        let shapeErr = ''
        try {
          parseManifest({ assets: [] })
        } catch (err) {
          shapeErr = err instanceof Error ? err.message : String(err)
        }
        push('缺字段的 manifest 被拒绝', shapeErr.includes('version'), shapeErr)

        // 免安装版不能当更新包：拉起它只是又开一个实例，用户以为更新了其实没换
        const portablePick = pickAsset(
          parseManifest({
            version: '9.9.9',
            assets: [{ platform: process.platform, arch, format: 'portable', url: 'a.exe' }]
          })
        )
        push('免安装版不会被当成更新包', !portablePick, portablePick ? portablePick.format : '已排除')

        // 9. 镜像兜底：GitHub 下不动时靠它 —— 主地址 404 要自动换 mirrors
        const mirrored = await checkForUpdates(`${base}/mirror.json`)
        push(
          '镜像地址也按相对路径解析',
          !!mirrored.asset?.mirrors?.length && mirrored.asset.mirrors[0].startsWith(base),
          mirrored.asset?.mirrors?.[0] ?? '无'
        )
        let mirrorFile: string | null = null
        let mirrorErr = ''
        if (mirrored.asset) {
          try {
            mirrorFile = await downloadUpdate(mirrored.asset, () => {})
          } catch (err) {
            mirrorErr = err instanceof Error ? err.message : String(err)
          }
        }
        const mirrorSize = mirrorFile && fs.existsSync(mirrorFile) ? fs.statSync(mirrorFile).size : -1
        push('主源 404 时自动换镜像下完', mirrorSize === payload.length, mirrorErr || `${mirrorSize} 字节`)

        // 10. 全挂时要把每个源的失败原因都带出来，别只说"下载失败"
        const allGone = await checkForUpdates(`${base}/allgone.json`)
        let allErr = ''
        if (allGone.asset) {
          try {
            await downloadUpdate(allGone.asset, () => {})
          } catch (err) {
            allErr = err instanceof Error ? err.message : String(err)
          }
        }
        push(
          '所有源都失败时逐个说明',
          allErr.includes('所有下载地址') && allErr.includes('主源'),
          allErr.slice(0, 70)
        )

        server.close()

        // 8. 界面上「检查更新」能打开（没配更新源时应该是引导去配置，而不是空白）
        await wait(400)
        await js(`document.querySelectorAll('.menubar .el-dropdown .mb')[0]?.click()`)
        await wait(600)
        const items = (await js(
          `[...document.querySelectorAll('.tb-dropdown .el-dropdown-menu__item')].map((i) => i.textContent.trim())`
        )) as string[]
        push('下拉里有「检查更新」', items.some((t) => t.includes('检查更新')), items.join(' | '))

        await js(
          `[...document.querySelectorAll('.tb-dropdown .el-dropdown-menu__item')]
            .find((i) => i.textContent.includes('检查更新'))?.click()`
        )
        await wait(1500)
        // 取"最后打开的那个可见弹窗"的正文：比按标题匹配稳，
        // 弹窗的标题节点在 Element Plus 各版本里位置不一样
        const dlgText = (await js(`(() => {
          const ds = [...document.querySelectorAll('.el-dialog')]
            .filter((el) => el.getBoundingClientRect().width > 0)
          const d = ds[ds.length - 1]
          return d ? (d.textContent || '').trim() : ''
        })()`)) as string
        push('弹窗打开了', dlgText.length > 0, dlgText.slice(0, 40))
        // 更新源为空时现在会自动去查 GitHub —— 这条只断言"有反馈、不是空白"，
        // 不断言具体文案（联网结果取决于网络，不该让冒烟跟着飘）
        push(
          '查更新的瞬间就有反馈，不是空白',
          dlgText.includes('检查') || dlgText.includes('版本') || dlgText.includes('更新源'),
          dlgText.slice(0, 60)
        )
        await shot('thshell-update.png')
        await js(`[...document.querySelectorAll('.el-dialog')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .pop()?.querySelector('.el-dialog__headerbtn')?.click()`)

        for (const [name, ok, detail] of checks) {
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`)
        }
        const badCount = checks.filter((c) => !c[1]).length
        console.log(`[smoke] update ${badCount ? badCount + ' 项失败' : '全部通过'}（${checks.length} 项）`)
        finish()
        return
      }

      // bar 模式：标题栏菜单栏（收起侧边栏 + 关于下拉里的 关于/配置/使用说明）。
      // 这组不依赖 SSH —— 侧边栏和三个弹窗都跟服务器状态无关，所以能独立跑，
      // 连不上测试机时也能拿它验界面。
      if (mode === 'bar') {
        await wait(1200)

        const checks: [string, boolean, string][] = []
        const push = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail])

        const items = (await js(
          `[...document.querySelectorAll('.menubar .mb')].map((b) => b.textContent.trim())`
        )) as string[]
        push('菜单栏有两项', items.length === 2, items.join(' | '))
        push('第一项是「收起侧边栏」', (items[0] || '').includes('收起侧边栏'), items[0] || '无')
        push('第二项是「关于」', (items[1] || '').includes('关于'), items[1] || '无')

        // 收起是 v-show（display:none），量宽度比读 style 可靠
        const sideW = async () =>
          (await js(`(() => {
            const el = document.querySelector('.sidebar')
            if (!el) return -1
            if (getComputedStyle(el).display === 'none') return 0
            return Math.round(el.getBoundingClientRect().width)
          })()`)) as number

        const before = await sideW()
        push('侧边栏初始可见', before > 100, `${before}px`)

        await js(`document.querySelectorAll('.menubar .mb')[0]?.click()`)
        await wait(450)
        const folded = await sideW()
        const label = (await js(`document.querySelectorAll('.menubar .mb')[0]?.textContent.trim()`)) as string
        push('点一下收起了侧边栏', folded === 0, `${before} → ${folded}px`)
        push('按钮文案变成「展开侧边栏」', label.includes('展开'), label)
        await shot('thshell-bar-folded.png')

        await js(`document.querySelectorAll('.menubar .mb')[0]?.click()`)
        await wait(450)
        const reopened = await sideW()
        push('再点一下展开回来', reopened > 100, `${reopened}px`)

        // Ctrl+B 走的是 App 里的同一个 keydown 监听；用合成事件，不碰真键盘
        const ctrlB = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))`
        await js(ctrlB)
        await wait(400)
        const byKey = await sideW()
        push('Ctrl+B 也能收起', byKey === 0, `${byKey}px`)
        await js(ctrlB)
        await wait(400)
        push('Ctrl+B 再按一次展开', (await sideW()) > 100)

        // 判断某个弹窗是不是真的开着：藏起来的 el-dialog 宽度是 0
        const dialogOpen = async (title: string) =>
          (await js(`(() => {
            const d = [...document.querySelectorAll('.el-dialog')]
              .filter((el) => el.getBoundingClientRect().width > 0)
              .find((el) => (el.querySelector('.el-dialog__title')?.textContent || '').includes(${JSON.stringify(title)}))
            return !!d
          })()`)) as boolean

        const closeDialog = () =>
          js(`[...document.querySelectorAll('.el-dialog')]
            .filter((el) => el.getBoundingClientRect().width > 0)
            .pop()?.querySelector('.el-dialog__headerbtn')?.click()`)

        const openAbout = async () => {
          await js(`document.querySelectorAll('.menubar .el-dropdown .mb')[0]?.click()`)
          await wait(600)
        }
        const clickMenu = (text: string) =>
          js(`[...document.querySelectorAll('.tb-dropdown .el-dropdown-menu__item')]
            .find((i) => i.textContent.trim() === ${JSON.stringify(text)})?.click()`)

        await openAbout()
        const menuItems = (await js(
          `[...document.querySelectorAll('.tb-dropdown .el-dropdown-menu__item')].map((i) => i.textContent.trim())`
        )) as string[]
        push('下拉有四项', menuItems.length === 4, menuItems.join(' | '))
        push(
          '四项是 关于 / 配置 / 检查更新 / 使用说明',
          menuItems.join('|') === '关于 ThShell|配置|检查更新|使用说明',
          menuItems.join('|')
        )
        await shot('thshell-bar-about.png')

        // 下拉项的选中底色必须跟侧栏选中项是同一个 token（--accent-soft）。
        // EP 默认用 primary-light-9，深色主题下会浮出一层青绿，跟侧栏不是一套语言。
        // 用"把变量解析成实际颜色再比对"来断言，比写死 rgba 值耐主题切换。
        const tint = (await js(`(() => {
          const root = document.querySelector('.tb-dropdown')
          if (!root) return { same: false, why: '下拉没挂上 .tb-dropdown' }
          const item = [...root.querySelectorAll('.el-dropdown-menu__item')]
            .find((i) => i.textContent.includes('检查更新'))
          if (!item) return { same: false, why: '没找到检查更新那一项' }
          item.focus()
          const got = getComputedStyle(item).backgroundColor
          const raw = getComputedStyle(root).getPropertyValue('--accent-soft').trim()
          const probe = document.createElement('div')
          probe.style.backgroundColor = raw
          document.body.appendChild(probe)
          const want = getComputedStyle(probe).backgroundColor
          probe.remove()
          return { same: got === want, got, want }
        })()`)) as { same: boolean; got?: string; want?: string; why?: string }
        push(
          '下拉选中底色与侧栏选中项一致',
          tint.same,
          tint.why ?? `选中 ${tint.got} / 侧栏 ${tint.want}`
        )
        await shot('thshell-bar-dropdown-tint.png')

        await clickMenu('配置')
        await wait(700)
        push('「配置」打开设置弹窗', await dialogOpen('设置'))
        // 更新源已经内置，设置里不该再冒出那个输入框 —— 加回来就等于又把选择推给用户
        const feedInput = (await js(`(() => {
          const d = [...document.querySelectorAll('.el-dialog')]
            .filter((el) => el.getBoundingClientRect().width > 0).pop()
          if (!d) return -1
          return [...d.querySelectorAll('input')].filter(
            (i) => /latest\\.json|releases\\/latest/.test(i.placeholder || '') ||
                   /^https:\\/\\/github/.test(i.value || '')
          ).length
        })()`)) as number
        push('设置里没有「更新源」输入框', feedInput === 0, feedInput < 0 ? '弹窗没找到' : `相关输入框 ${feedInput} 个`)
        await closeDialog()
        await wait(500)

        await openAbout()
        await clickMenu('使用说明')
        await wait(700)
        push('「使用说明」打开帮助弹窗', await dialogOpen('使用说明'))
        await shot('thshell-bar-help.png')
        await closeDialog()
        await wait(500)

        await openAbout()
        await clickMenu('关于 ThShell')
        await wait(700)
        push('「关于」打开关于弹窗', await dialogOpen('关于 ThShell'))
        const verText = (await js(`(() => {
          const d = [...document.querySelectorAll('.el-dialog')]
            .filter((el) => el.getBoundingClientRect().width > 0)
            .find((el) => (el.querySelector('.el-dialog__title')?.textContent || '').includes('关于 ThShell'))
          if (!d) return ''
          return [...d.querySelectorAll('.row')].map((r) => r.textContent.trim()).join(' / ')
        })()`)) as string
        // Electron / Chromium / Node 三个版本号必须真的取到，不能是占位的「—」
        push('版本档案取到了（不是占位符）', /\d+\.\d+\.\d+/.test(verText) && !verText.includes('—'), verText)
        await shot('thshell-bar-about-dialog.png')
        await closeDialog()
        await wait(400)

        for (const [name, ok, detail] of checks) {
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`)
        }
        const bad = checks.filter((c) => !c[1]).length
        console.log(`[smoke] bar ${bad ? bad + ' 项失败' : '全部通过'}（${checks.length} 项）`)
        finish()
        return
      }

      // menu 模式：连上第一台服务器 → 文件页 → 依次右键远程行、本地行、再点开属性，
      // 用来目检右键菜单的分组、图标、禁用态和边缘防溢出。
      if (mode === 'menu') {
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(3000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        await wait(1800)

        const rightClick = (paneIndex: number, rowIndex: number, x: number, y: number) =>
          js(
            `document.querySelectorAll('.fm .pane')[${paneIndex}]` +
              `?.querySelectorAll('.rows .row')[${rowIndex}]` +
              `?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }))`
          )

        const closeMenu = () =>
          js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)

        // 远程文件 → 下载/编辑/在终端中打开那套
        await rightClick(1, 2, 620, 300)
        await wait(500)
        await shot('thshell-menu-remote.png')

        // 本地文件
        await closeMenu()
        await wait(250)
        await rightClick(0, 3, 300, 320)
        await wait(450)
        await shot('thshell-menu-local.png')

        // 属性面板
        await js(
          `[...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('属性'))?.click()`
        )
        await wait(700)
        await shot('thshell-props.png')

        // 关掉属性，右键远程栏空白处 → 当前目录那套菜单
        await js(`document.querySelector('.el-dialog__headerbtn')?.click()`)
        await wait(400)
        await js(
          `document.querySelectorAll('.fm .pane')[1]?.querySelector('.rows')` +
            `?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 640 }))`
        )
        await wait(450)
        await shot('thshell-menu-blank.png')

        // 贴着窗口右下角右键 → 菜单应该自动翻到光标左上方，不被窗口切掉
        await closeMenu()
        await wait(250)
        const bounds = mainWindow!.getContentBounds()
        await js(
          `document.querySelectorAll('.fm .pane')[1]?.querySelector('.rows')` +
            `?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,` +
            ` clientX: ${bounds.width - 8}, clientY: ${bounds.height - 8} }))`
        )
        await wait(450)
        await shot('thshell-menu-edge.png')

        // 验证「在终端中打开」：右键远程目录 → 点菜单 → 终端里应出现 cd 命令
        await closeMenu()
        await wait(250)
        await rightClick(1, 0, 620, 240)
        await wait(400)
        await js(
          `[...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('在终端中打开'))?.click()`
        )
        await wait(900)
        await shot('thshell-terminal-cd.png')

        // 侧栏服务器行的「连接」按钮只在悬停时出现，得真的把指针移过去才能看到尺寸
        const row = (await js(`(() => {
          const el = document.querySelector('.server-item')
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: Math.round(r.right - 18), y: Math.round(r.top + r.height / 2) }
        })()`)) as { x: number; y: number } | null
        if (row) {
          mainWindow!.focus()
          mainWindow!.webContents.sendInputEvent({ type: 'mouseMove', x: row.x, y: row.y })
          await wait(700)
          await shot('thshell-sidebar-hover.png')
        }

        /* 原生菜单栏必须不存在：Electron 默认那份是英文的 File / Edit / View / Window / Help，
           平时 autoHideMenuBar 藏着，但按一下 Alt 就冒出来，还把自绘标题栏顶下去一截。
           菜单栏画在原生框上，capturePage 截不到，所以只能在主进程直接看有没有 */
        const appMenu = Menu.getApplicationMenu()
        const menuOk =
          process.platform === 'darwin'
            ? !!appMenu // macOS 不能没有菜单，否则 Cmd+C / Cmd+Q 全废
            : appMenu === null
        const failed = menuOk ? 0 : 1
        console.log(
          `[smoke] ${menuOk ? 'PASS' : 'FAIL'} 没有原生菜单栏（按 Alt 不会冒出 File/Edit/…）：${
            appMenu ? appMenu.items.map((i) => i.label || i.role).join(' / ') : 'null'
          }`
        )
        console.log(`[smoke] menu ${failed ? '1 项失败' : '全部通过'}（另出 9 张目检截图）`)

        finish()
        return
      }

      // transfer 模式：连上第一台服务器 → 切到文件页 → 灌几条假进度，
      // 专门用来目检传输行与底部传输面板的排版，不用真传文件。
      if (mode === 'transfer') {
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(3000)
        await js(
          `[...document.querySelectorAll('.seg-btn')].find((b) => b.textContent.includes('文件'))?.click()`
        )
        // 等文件页把目录列出来，list 的入参就是当前标签页真实的 sessionId
        await wait(1800)

        const checks: [string, boolean, string][] = []
        const push = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail])

        const MB = 1024 * 1024
        const base = { sessionId: lastSessionId, elapsed: 12_000 }
        const rows = [
          {
            transferId: 'smoke-up',
            direction: 'upload',
            filename: 'database-2026-11-09.tar.gz',
            from: 'D:\\backup\\2026-11-09\\database-2026-11-09.tar.gz',
            to: '/data/backup/database-2026-11-09.tar.gz',
            transferred: 512 * MB,
            total: 1434 * MB,
            speed: Math.round(12.4 * MB),
            done: false
          },
          {
            transferId: 'smoke-dir',
            direction: 'download',
            filename: 'dmbak（1284 个文件）',
            from: '/home/oracle/dmbak',
            to: 'C:\\Users\\admin\\Downloads\\dmbak',
            dir: true,
            transferred: 2140 * MB,
            total: 8602 * MB,
            speed: Math.round(6.8 * MB),
            fileCount: 1284,
            fileDone: 372,
            done: false
          }
        ]
        for (const row of rows) mainWindow!.webContents.send('sftp:progress', { ...base, ...row })
        await wait(400)

        // 展开/收起状态是记在 localStorage 的，上一次跑完可能还是展开的 ——
        // 先把状态归一化成"收起"，再断言收起态，否则这一组能不能过取决于上一次跑成什么样
        if (await js(`!!document.querySelector('.dock .dock-list')`)) {
          await js(`document.querySelector('.dock .head')?.click()`)
          await wait(300)
        }

        // 底部的传输面板默认是收起的：先断言"收起时不占地方"，再点开看内容
        const collapsed = (await js(`(() => {
          const dock = document.querySelector('.dock')
          if (!dock) return { ok: false, h: 0, head: '' }
          return {
            ok: !dock.querySelector('.dock-list'),
            h: Math.round(dock.getBoundingClientRect().height),
            head: dock.querySelector('.head')?.textContent?.replace(/\\s+/g, ' ').trim() || ''
          }
        })()`)) as { ok: boolean; h: number; head: string }
        push('底部有传输面板', collapsed.h > 0, `高 ${collapsed.h}px`)
        push('默认收起（不占主区域）', collapsed.ok && collapsed.h <= 36, `高 ${collapsed.h}px`)
        push('收起时也显示「N 个进行中」', collapsed.head.includes('个进行中'), collapsed.head.slice(0, 60))

        await js(`document.querySelector('.dock .head')?.click()`)
        await wait(500)

        const expanded = (await js(`(() => {
          const dock = document.querySelector('.dock')
          const rows = dock ? [...dock.querySelectorAll('.row')] : []
          const text = rows.map((r) => r.textContent.replace(/\\s+/g, ' ').trim())
          const path = rows[0]?.querySelector('.path')?.textContent?.replace(/\\s+/g, ' ').trim() || ''
          return {
            open: !!dock?.querySelector('.dock-list'),
            n: rows.length,
            path,
            text,
            h: Math.round(dock?.getBoundingClientRect().height || 0)
          }
        })()`)) as { open: boolean; n: number; path: string; text: string[]; h: number }
        push('点一下能展开', expanded.open && expanded.h > 36, `高 ${expanded.h}px`)
        push('进行中的任务都在列表里', expanded.n >= 2, `${expanded.n} 行`)
        push(
          '每行都有「源 → 目标」',
          expanded.n >= 2 && expanded.text.every((t) => t.includes('→')),
          expanded.path.slice(0, 70)
        )
        // 两个方向的路径都要原样保留：上传的本地路径带反斜杠和盘符，最容易被转义吃掉
        push(
          '上传的源路径是原始本地路径',
          expanded.text.some((t) => t.includes('D:\\backup\\2026-11-09')),
          expanded.text.find((t) => t.includes('D:\\backup'))?.slice(0, 80) || '没找到'
        )

        // 记录是主进程写的：塞两条假的，等它推 transfer:changed 让界面重拉
        const now = Date.now()
        const fake = [
          {
            id: 'smoke-rec-ok',
            direction: 'download' as const,
            filename: 'dmbak（1284 个文件）',
            from: '/home/oracle/dmbak',
            to: 'C:\\Users\\admin\\Downloads\\dmbak',
            name: 'dmbak',
            dir: true,
            size: 8602 * MB,
            at: now - 60_000,
            ms: 214_000
          },
          {
            id: 'smoke-rec-fail',
            direction: 'upload' as const,
            filename: 'qc_data.csv',
            from: 'D:\\export\\qc_data.csv',
            to: '/database/qc_data.csv',
            name: 'qc_data.csv',
            size: 32 * MB,
            at: now - 3_600_000,
            ms: 1_200,
            error: '权限不足：/database/qc_data.csv'
          }
        ]
        for (const rec of fake) appendTransfer(rec)
        mainWindow!.webContents.send('transfer:changed')
        await wait(600)

        const withHistory = (await js(`(() => {
          const dock = document.querySelector('.dock')
          const rows = dock ? [...dock.querySelectorAll('.row')] : []
          const text = rows.map((r) => r.textContent.replace(/\\s+/g, ' ').trim())
          return { n: rows.length, text, fail: text.filter((t) => t.includes('失败')).length }
        })()`)) as { n: number; text: string[]; fail: number }
        push('历史记录进了同一个列表', withHistory.n >= 4, `${withHistory.n} 行`)
        push('记下了源目录', withHistory.text.some((t) => t.includes('/home/oracle/dmbak')), '')
        push('记下了目标目录', withHistory.text.some((t) => t.includes('Downloads\\dmbak')), '')
        push('目录传输标了「文件夹」', withHistory.text.some((t) => t.includes('文件夹')), '')
        push('失败的那条显示原因', withHistory.fail === 1, `${withHistory.fail} 行失败`)

        // 排版这种事用眼睛看每回说法都不一样，直接量：进度条和它那行的数字中心对不上，
        // 就说明 flex 被挤换行了（数字掉到条下面，一行变两行）
        // 「不用滚」只能量前 4 行：用户真实历史攒到十几条时整块本来就该滚，
        // 拿 scrollHeight 去比会把"记录多了"错判成"行变高了"
        const geom = (await js(`(() => {
          const dock = document.querySelector('.dock')
          const list = dock?.querySelector('.dock-list')
          const live = [...(dock?.querySelectorAll('.row.live') || [])]
            .find((r) => r.textContent.includes('database-2026-11-09'))
          if (!list || !live) return { sameLine: false, barW: 0, first4: false, overflow: 999, rows: 0 }
          const bar = live.querySelector('.bar').getBoundingClientRect()
          const bytes = live.querySelector('.bytes').getBoundingClientRect()
          const rows = [...list.querySelectorAll('.row')]
          const box = list.getBoundingClientRect()
          const fourth = rows[3]?.getBoundingClientRect()
          return {
            sameLine: Math.abs(bar.top + bar.height / 2 - (bytes.top + bytes.height / 2)) < 8,
            barW: Math.round(bar.width),
            first4: rows.length >= 4 && !!fourth && fourth.bottom <= box.bottom + 1,
            overflow: list.scrollHeight - list.clientHeight,
            rows: dock.querySelectorAll('.row').length
          }
        })()`)) as { sameLine: boolean; barW: number; first4: boolean; overflow: number; rows: number }
        push('进度条和数字在同一行', geom.sameLine, `条宽 ${geom.barW}px`)
        push('进度条还有宽度（没被数字挤没）', geom.barW > 200, `条宽 ${geom.barW}px`)
        push('前四行装得进面板，不用滚', geom.first4, `${geom.rows} 行，整块溢出 ${geom.overflow}px`)

        // 记在文件里（重启还在），不是只活在内存
        const persisted = loadTransferLog().filter((r) => r.id.startsWith('smoke-rec-'))
        push('记录落盘且带双端路径', persisted.length === 2 && !!persisted[0].from && !!persisted[0].to, `${persisted.length} 条`)

        await shot('thshell-transfer.png')

        // 顺手验一下另一套皮下的对比度（进度条轨道、路径灰）。
        // 不能写死"设成 light 再看变没变"：用户配置本来就是浅色时什么都没发生，
        // 断言会假失败。所以按当前主题反过来切一次，断言"切了之后底色真的变了"。
        const current = (await js(`document.documentElement.dataset.theme || 'dark'`)) as string
        const flipped = current === 'light' ? 'dark' : 'light'
        const bgBefore = (await js(`getComputedStyle(document.body).backgroundColor`)) as string
        await js(`document.documentElement.dataset.theme = '${flipped}'`)
        await wait(500)
        const bgAfter = (await js(`getComputedStyle(document.body).backgroundColor`)) as string
        push('主题切换真的生效', bgAfter !== bgBefore, `${current}→${flipped} ${bgBefore}→${bgAfter}`)

        // 第二张统一出浅色皮（深色那张上面已经截过了）
        await js(`document.documentElement.dataset.theme = 'light'`)
        await wait(600)
        await shot('thshell-transfer-light.png')

        // 自己造的假记录要清掉，不能留在用户真实的传输历史里
        removeTransfer(fake.map((r) => r.id))

        // 面板是记在 localStorage 的，冒烟点开了就会一直开着。
        // 冒烟结束收回收起态，别让用户下次开应用看到一条莫名其妙展开的底栏
        if (await js(`!!document.querySelector('.dock .dock-list')`)) {
          await js(`document.querySelector('.dock .head')?.click()`)
          await wait(300)
        }
        push('冒烟结束把面板收回了收起态', !(await js(`!!document.querySelector('.dock .dock-list')`)), '')

        let failed = 0
        for (const [name, ok, detail] of checks) {
          if (!ok) failed += 1
          console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`)
        }
        console.log(`[smoke] transfer ${failed ? failed + ' 项失败' : '全部通过'}（${checks.length} 项）`)

        finish()
        return
      }

      // connect 模式：自动双击侧栏第一台服务器，验证「配置读取 → IPC → SSH → 终端」整条链路
      if (mode === 'connect') {
        await wait(1500)
        await js(
          `document.querySelector('.server-item')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await wait(5000)
        await shot('thshell-connect.png')

        // 顺带看一眼终端右键菜单（样式和文件管理的菜单共用一套全局类）
        await js(
          `document.querySelector('.term-host')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 300 }))`
        )
        await wait(500)
        await shot('thshell-term-menu.png')

        // 真页签上再验一遍右键菜单：假页签没有 sessionId，走不到"关闭时断开 SSH"那条路径
        await js(
          `document.querySelector('.tabbar .tab')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 60 }))`
        )
        await wait(600)
        await shot('thshell-tab-menu-real.png')
        const closed = await js(`(() => {
          const el = [...document.querySelectorAll('.ctx-menu .ctx-item')]
            .find((e) => e.textContent.includes('关闭当前'))
          if (!el) return 'no-item'
          el.click()
          return 'ok'
        })()`)
        await wait(800)
        const left = await js(`document.querySelectorAll('.tabbar .tab').length`)
        console.log(
          `[smoke] ${closed === 'ok' && left === 0 ? 'PASS' : 'FAIL'} 真页签右键关闭: ${closed} / 剩余 ${left} 个页签`
        )

        finish()
        return
      }

      await wait(2200)
      await shot('thshell-smoke-1.png')

      // 弹窗（深色）
      await js(`document.querySelectorAll('.actions button')[0]?.click()`)
      await wait(800)
      await shot('thshell-smoke-2.png')

      // 关弹窗，切浅色主题，再各截一张 —— 一套冒烟覆盖两种主题
      await js(`document.querySelector('.el-dialog__headerbtn')?.click()`)
      await wait(500)
      await js(`document.documentElement.dataset.theme = 'light'`)
      await wait(700)
      await shot('thshell-smoke-3.png')
      await js(`document.querySelectorAll('.actions button')[0]?.click()`)
      await wait(800)
      await shot('thshell-smoke-4.png')

      finish()
    })
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    const devUrl = new URL(process.env.VITE_DEV_SERVER_URL)
    // 冒烟时带 ?smoke=1，渲染层据此挂出测试用的 store 后门
    if (process.env.THSHELL_SMOKE) devUrl.searchParams.set('smoke', '1')
    mainWindow.loadURL(devUrl.toString())
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'), {
      search: process.env.THSHELL_SMOKE ? 'smoke=1' : undefined
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ---------- 单实例：第二次启动时聚焦已有窗口 ----------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.meng.thshell')
    setupAppMenu()
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  ssh.disconnectAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  ssh.disconnectAll()
})

function registerIpc(): void {
  // ---------- 配置 ----------
  register('config:load', () => store.load())
  register('config:save', (config) => store.save(config))

  // ---------- 原生窗口主题 ----------
  // 应用内的浅色只改 <html data-theme>，Windows 的原生标题栏跟的是系统深色模式，
  // 界面切浅色后标题栏还是黑的。nativeTheme.themeSource 会写 DWMWA_USE_IMMERSIVE_DARK_MODE，
  // 把标题栏一起带上（system = 还给系统设置）。
  register('theme:set', (theme: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = theme
  })

  register('config:export', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出连接配置',
      defaultPath: 'thshell-servers.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    fs.writeFileSync(result.filePath, JSON.stringify(store.exportSanitized(), null, 2), 'utf-8')
    return result.filePath
  })

  register('config:import', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入连接配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const raw = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'))
    if (!Array.isArray(raw.servers)) throw new Error('文件格式不正确：缺少 servers 数组')
    return raw
  })

  // ---------- SSH ----------
  register('ssh:connect', (config: ServerConfig, cols: number, rows: number) =>
    ssh.connect(config, cols, rows)
  )
  register('ssh:disconnect', (sessionId: string) => {
    ssh.disconnect(sessionId)
    clearMetricsState(sessionId)
  })
  ipcMain.on('ssh:write', (_e, sessionId: string, data: string) => ssh.write(sessionId, data))
  ipcMain.on('ssh:resize', (_e, sessionId: string, cols: number, rows: number) =>
    ssh.resize(sessionId, cols, rows)
  )
  register('ssh:exec', (sessionId: string, command: string) => ssh.exec(sessionId, command))
  register('ssh:metrics', (sessionId: string) =>
    collectMetrics(sessionId, (command) => ssh.exec(sessionId, command))
  )
  register('ssh:sysinfo', (sessionId: string) =>
    collectSystemInfo((command) => ssh.exec(sessionId, command))
  )

  // ---------- Docker ----------
  // 统一绑一条 exec 出来，模块里只关心命令本身，不碰会话管理
  const dock = (sessionId: string) => (command: string) => ssh.exec(sessionId, command)
  register('docker:probe', (sessionId: string) => probeDocker(dock(sessionId)))
  register('docker:overview', (sessionId: string) => dockerOverview(dock(sessionId)))
  register('docker:containers', (sessionId: string) => dockerContainers(dock(sessionId)))
  register('docker:container-action', (sessionId: string, id: string, action: any, force?: boolean) =>
    dockerContainerAction(dock(sessionId), id, action, force)
  )
  register('docker:container-logs', (sessionId: string, id: string, tail?: number) =>
    dockerContainerLogs(dock(sessionId), id, tail)
  )
  register('docker:container-detail', (sessionId: string, id: string) =>
    dockerContainerDetail(dock(sessionId), id)
  )
  register('docker:images', (sessionId: string) => dockerImages(dock(sessionId)))
  register('docker:pull-image', (sessionId: string, ref: string) =>
    dockerPullImage(dock(sessionId), ref)
  )
  register('docker:remove-image', (sessionId: string, ref: string, force?: boolean) =>
    dockerRemoveImage(dock(sessionId), ref, force)
  )
  register('docker:networks', (sessionId: string) => dockerNetworks(dock(sessionId)))
  register('docker:volumes', (sessionId: string) => dockerVolumes(dock(sessionId)))
  register('docker:remove-network', (sessionId: string, id: string) =>
    dockerRemoveNetwork(dock(sessionId), id)
  )
  register('docker:remove-volume', (sessionId: string, name: string) =>
    dockerRemoveVolume(dock(sessionId), name)
  )
  register('docker:compose', (sessionId: string) => dockerCompose(dock(sessionId)))
  register('docker:prune', (sessionId: string, target: any) => dockerPrune(dock(sessionId), target))

  // ---------- SFTP ----------
  /**
   * 进度广播 + 落盘记录。
   *
   * 记录在这里写（而不是渲染层）有三点好处：路径只有主进程有原件，
   * 窗口关掉/刷新时记账不会丢，而且成功和失败走的是同一个收口 ——
   * 结束事件只发一次 done，两边不各记一份就不会出现"界面有、文件里没有"。
   */
  const emitProgress = (p: TransferProgress) => {
    if (p.done) {
      appendTransfer({
        id: p.transferId,
        direction: p.direction,
        filename: p.filename,
        from: p.from,
        to: p.to,
        // 名字去掉「（N 个文件）」后缀，列表里这一列要短
        name: p.filename.replace(/（\d+ 个文件）$/, ''),
        dir: p.dir,
        size: p.total,
        at: Date.now(),
        ms: p.elapsed,
        error: p.error
      })
      // 让界面重新拉一次列表：记录是主进程写的，渲染层只能被动知道
      safeSend('transfer:changed')
    }
    safeSend('sftp:progress', p)
  }

  register('transfer:list', () => loadTransferLog())
  register('transfer:clear', () => clearTransferLog())

  register('sftp:list', async (sessionId: string, remotePath: string) => {
    // 冒烟模式要知道当前标签页的真实 sessionId 才能灌假进度，顺手记一下
    lastSessionId = sessionId
    const sftp = await ssh.getSftp(sessionId)
    // 身份只问一次（SshManager 内部缓存），拿不到就传 undefined —— 权限列照样显示，只是不标红
    const who = await ssh.getIdentity(sessionId)
    return listRemote(sftp, remotePath, who)
  })
  register('sftp:download', async (sessionId: string, remotePath: string, localPath: string) => {
    const sftp = await ssh.getSftp(sessionId)
    return downloadRemote(sftp, remotePath, localPath, emitProgress, sessionId)
  })
  register('sftp:downloadDir', async (sessionId: string, remotePath: string, localPath: string) => {
    const sftp = await ssh.getSftp(sessionId)
    return downloadDirectory(sftp, remotePath, localPath, emitProgress, sessionId)
  })
  register('sftp:upload', async (sessionId: string, localPath: string, remotePath: string) => {
    const sftp = await ssh.getSftp(sessionId)
    return uploadLocal(sftp, localPath, remotePath, emitProgress, sessionId)
  })
  register('sftp:uploadDir', async (sessionId: string, localDir: string, remotePath: string) => {
    const sftp = await ssh.getSftp(sessionId)
    return uploadDirectory(sftp, localDir, remotePath, emitProgress, sessionId)
  })
  register('sftp:mkdir', async (sessionId: string, remotePath: string) => {
    const sftp = await ssh.getSftp(sessionId)
    await mkdirRemote(sftp, remotePath)
  })
  register('sftp:remove', async (sessionId: string, remotePath: string, isDir: boolean) => {
    const sftp = await ssh.getSftp(sessionId)
    await removeRemote(sftp, remotePath, isDir)
  })
  register('sftp:rename', async (sessionId: string, oldPath: string, newPath: string) => {
    const sftp = await ssh.getSftp(sessionId)
    await renameRemote(sftp, oldPath, newPath)
  })
  // 办公文档预览：原始字节走 base64（readFile 会 UTF-8 解码 + 拦二进制）
  register('sftp:readBinary', async (sessionId: string, remotePath: string) => {
    const sftp = await ssh.getSftp(sessionId)
    return readRemoteBinary(sftp, remotePath)
  })
  register('sftp:readFile', async (sessionId: string, remotePath: string) => {
    const sftp = await ssh.getSftp(sessionId)
    return readRemoteFile(sftp, remotePath)
  })
  // 日志：只读末尾 N 行，不整份传回来
  register('sftp:readTail', async (sessionId: string, remotePath: string, lines?: number) => {
    const sftp = await ssh.getSftp(sessionId)
    return readRemoteTail(sftp, remotePath, lines)
  })
  register(
    'sftp:writeFile',
    async (
      sessionId: string,
      remotePath: string,
      content: string,
      encoding?: TextEncoding,
      bom?: boolean
    ) => {
      const sftp = await ssh.getSftp(sessionId)
      await writeRemoteFile(sftp, remotePath, content, encoding, bom)
    }
  )
  // 写权限探测：探测本身失败（网络抖动 / 会话掉了）时按「可写」处理，
  // 让用户还能点保存 —— 真正的失败由 writeFile 报错，不要因为探测误判把人挡在门外
  register('sftp:canWrite', async (sessionId: string, remotePath: string) => {
    try {
      return await checkRemoteWritable((cmd) => ssh.exec(sessionId, cmd), remotePath)
    } catch {
      return true
    }
  })

  // ---------- 本地文件 ----------
  register('local:home', () => localHome())
  register('local:list', (dirPath: string) => listLocal(dirPath))
  register('local:mkdir', (dirPath: string) => mkdirLocal(dirPath))
  register('local:remove', (targetPath: string) => removeLocal(targetPath))
  register('local:rename', (oldPath: string, newPath: string) => renameLocal(oldPath, newPath))
  register('local:readFile', (filePath: string) => readLocalFile(filePath))
  // 日志：只读末尾 N 行。几百 MB 的 .log 双击也能秒开
  register('local:readTail', (filePath: string, lines?: number) => readLocalTail(filePath, lines))
  register('local:readBinary', (filePath: string) => readLocalBinary(filePath))
  register(
    'local:writeFile',
    (filePath: string, content: string, encoding?: TextEncoding, bom?: boolean) =>
      writeLocalFile(filePath, content, encoding, bom)
  )
  register('local:canWrite', (filePath: string) => isLocalWritable(filePath))
  register('local:openPath', (targetPath: string) => openLocalPath(targetPath))
  // 在资源管理器中定位：path 不存在时 showItemInFolder 是静默 no-op，不会抛
  register('local:reveal', (targetPath: string) => {
    shell.showItemInFolder(targetPath)
  })
  register('local:drives', () => localDrives())
  register('local:places', () => localPlaces())

  // 文件剪贴板的落地动作：同栏直接复制/移动，跨栏由渲染层拆成上传/下载
  register('local:paste', (srcPaths: string[], destDir: string, mode: PasteMode) =>
    mode === 'cut' ? moveLocal(srcPaths, destDir) : copyLocal(srcPaths, destDir)
  )
  register(
    'remote:paste',
    (sessionId: string, srcPaths: string[], destDir: string, mode: PasteMode) =>
      pasteRemote(ssh, sessionId, srcPaths, destDir, mode)
  )

  // ---------- 系统对话框 ----------
  register('dialog:pickFiles', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })
  register('dialog:pickDir', async (defaultPath?: string) => {
    const result = await dialog.showOpenDialog({
      // 不传 defaultPath 的话对话框每次都从「上次访问位置」开始，跨盘跳转很别扭
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory'],
      title: '选择目录'
    })
    return result.canceled ? null : result.filePaths[0]
  })
  register('dialog:pickSave', async (defaultName: string) => {
    const result = await dialog.showSaveDialog({ defaultPath: defaultName })
    return result.canceled ? null : result.filePath
  })

  // ---------- 应用 ----------
  register('app:version', () => app.getVersion())
  register('app:platform', () => process.platform)
  // 「关于」弹窗的版本档案：应用版本 + Electron / Chromium / Node。
  // 后面三个渲染进程也能从 userAgent 里抠，但抠出一堆不准确的字符串不如直接问；
  // app.getVersion() 必须走主进程，preload 里拿不到。
  register(
    'app:info',
    () =>
      ({
        name: 'ThShell',
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch
      }) satisfies AppInfo
  )
  ipcMain.on('app:minimize', () => mainWindow?.minimize())
  ipcMain.on('app:toggleMaximize', () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on('app:close', () => mainWindow?.close())

  // ---------- 检查更新 ----------
  register('update:check', (feed: string) => checkForUpdates(feed))
  register('update:download', async (asset: UpdateAsset) => {
    const filePath = await downloadUpdate(asset, (progress) => {
      mainWindow?.webContents.send('update:progress', progress)
    })
    // null = 用户取消，不是错误
    return filePath ? { path: filePath } : null
  })
  ipcMain.on('update:cancel', () => cancelDownload())
  register('update:install', (filePath: string) => installUpdate(filePath))
}
