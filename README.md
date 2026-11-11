# ThShell

一个 FinalShell 风格的轻量级远程运维客户端，桌面端基于 **Electron + Vue 3 + Vite + Element Plus**。

面向日常 SSH 运维：连上服务器 → 敲命令 → 传文件 → 看资源占用，四件事在一个窗口里完成。

---

## 功能

| 模块 | 说明 |
| --- | --- |
| 连接管理 | 分组归类、密码/私钥两种认证、标签色标记环境、测试连接、配置导入导出 |
| 菜单栏 | 标题栏左侧两项：**收起侧边栏**（`Ctrl+B`，收起后按钮变成「展开侧边栏」）和**关于**下拉 —— 里面是「关于 ThShell」（应用版本 + Electron / Chromium / Node 运行时版本）、「配置」、「检查更新」、「使用说明」。使用说明把连接、终端、文件、传输、弹窗五块的操作要点和快捷键表放在一页 |
| 检查更新 | 「关于 → 检查更新」比对更新源里的 `latest.json`：有新版本就显示版本号与更新说明，下载带进度/速度，下载完做 **sha256 校验**（更新源里写了 sha256 就强制校验，防止内网文件服务器上放错版本），然后拉起安装包。启动时静默查一次 —— 有新版只在「关于」按钮上点一个圆点，不弹窗 |
| 终端 | xterm.js 多会话标签，256 色、滚屏 8000 行、`Ctrl+F` 搜索；底部快捷命令条：7 条常驻一键 + 35 条运维命令分组浮层，悬停看说明 |
| SFTP | 本地/远程双栏，单文件与**目录递归下载**（带进度与失败清单），远程文件内置编辑器（UTF-8 / UTF-16 按原编码读写），本地删除走系统回收站 |
| 远程列表 | 多两列：**权限**（`rw-r--r--`，带 setuid/setgid/sticky 的 `s/S/t/T`）和 **用户 / 组**（`root:root`）；**当前 SSH 用户写不了的整串权限标红**（算的是真实 uid/gid，不是用户名），悬停能看到"为什么红"；窗口变窄时按栏宽先收属主列、再收权限列，不挤文件名 |
| 预览 | 双击按类型分流：**图片**进棋盘格预览（滚轮缩放、适应窗口、1:1）、**PDF** 用 pdf.js 分页渲染、Office 与文本走只读预览、`.log` 走日志查看器、其余交给系统程序；列表按文件类型换**形状 + 颜色**不同的图标，形状负责"是什么"、颜色只给图片/视频/PDF/压缩包这类提醒 |
| 弹窗窗口态 | 编辑器 / 日志查看器 / 预览三个弹窗的标题栏右上角有**最小化 · 最大化 · 关闭**三颗按钮，语义和主窗口一致：最大化铺满窗口并把内容区一起拉高；最小化**收成右下角一条**（编辑器未保存的内容、PDF 已渲染的页、图片缩放位置都还在），点小条或展开键就地还原 |
| 日志查看 | 双击 `.log` / `.out` / `messages` 等进**只读**查看器：从文件末尾倒着读，默认最后 200 行、行数可调（50–5000）、可开自动刷新，几百 MB 的日志也秒开；日志不提供编辑 |
| 路径导航 | 路径可直接输入；左栏标签点开是常用位置 + 盘符跳转，右侧按钮调系统目录选择框；右栏标签点开是 `/`、`/tmp`、`/var/log` 等常用远端目录 |
| 右键菜单 | 文件/目录/空白处各有对应菜单：打开、在资源管理器中显示、上传、下载、在终端中打开、复制路径、属性、重命名、删除；贴近窗口边缘会自动翻转 |
| 文件剪贴板 | 复制 / 剪切 / 粘贴，四种组合都支持（本地↔本地、远程↔远程、本地上传、远程下载）；同栏走服务端 `cp`/`mv` 不走网络，剪切后源条目淡显 |
| 传输记录 | 窗口底部一条**可收起**的传输面板：在传的显示进度/速度/剩余时间，传完的留一条记录，写着**文件名、大小、时间、结果，以及「从哪个目录 → 到哪个目录」的完整路径**；记录落盘保存（最多 200 条），重启还在，可一键清空 |
| 监控 | CPU / 内存 / 根分区 / 网络 实时曲线，负载、进程数、运行时长、Swap |
| 主题 | 深色 / 浅色一键切换，界面与终端配色同步，设置里点取消会回滚 |
| 安全 | 密码用 Electron `safeStorage`（Windows DPAPI）加密落盘，销毁时清空会话 |

## 快速开始

```bash
pnpm install
pnpm dev          # 开发模式（Vite HMR + Electron）
```

生产构建与打包：

```bash
pnpm build        # 类型检查 + 渲染层/主进程构建
pnpm dist         # 构建并用 electron-builder 出安装包（release/）
```

> **Windows 提示**：如果终端里存在 `ELECTRON_RUN_AS_NODE=1` 环境变量（部分 IDE / 工具链会注入），
> Electron 会退化成纯 Node 进程并报 `Cannot read properties of undefined (reading 'getPath')`。
> 启动前清掉它即可：`set ELECTRON_RUN_AS_NODE=`（CMD）/ `Remove-Item Env:ELECTRON_RUN_AS_NODE`（PowerShell）。

## 打包发布

| 目标 | 命令 | 能在哪儿跑 | 产物 |
| --- | --- | --- | --- |
| Windows x64 | `pnpm dist:win` | Windows 本机 | `ThShell-0.1.0-win-setup.exe`（安装版）<br>`ThShell-0.1.0-win-portable.exe`（免安装单文件） |
| Linux x64 | `pnpm dist:linux` | Linux 本机；Windows / macOS 上自动转 Docker | `.AppImage` / `.deb` / `.rpm` / `.tar.gz` |
| macOS x64 + arm64 | `pnpm dist:mac` | **只能 macOS** | `-mac-x64.dmg`、`-mac-arm64.dmg`、对应 `.zip` |
| 三平台一起 | GitHub Actions 手动触发，或推 `v*` tag | 云端 | 见 `.github/workflows/build-desktop.yml` |

配置集中在 `electron-builder.yml`（不再塞在 `package.json` 的 `build` 字段里）。

### 为什么 macOS 包只能在 Mac 上打

`dmg` 要 `hdiutil`，签名要 `codesign` + 钥匙串，都是 macOS 独有的工具；在 Windows 上跑
`electron-builder --mac` 会直接报 `Cannot build for macOS on win32`。没有 Mac 就两条路：
让 GitHub Actions 的 `macos-latest` 打（免费额度对个人项目够用），或者借一台 Mac 跑一次。

### 为什么 Linux 包要过 Docker

`deb`/`rpm` 由 `fpm` 生成，`AppImage` 由 `appimagetool` 打包，两个都是 ELF 程序，Windows 上跑不了。
`scripts/build-linux.mjs` 因此做成三步：宿主机构建前端 → 起 `electronuserland/builder` 容器 →
容器里 `pnpm install` 后打包。

> 容器里**必须重新装一遍依赖**。pnpm 的 `node_modules` 是一堆指向全局 store 的符号链接，
> 路径是 `C:\Users\...` 这种 Windows 绝对路径，挂进 Linux 容器全是断链。
> 脚本给 `node_modules` 和 pnpm store 各挂了一块命名卷，第二次打不会重新下载。

### 各发行版该发哪个包

| 发行版 | 推荐 | 说明 |
| --- | --- | --- |
| Ubuntu / Debian / Deepin / UOS | `.deb` | 软件中心双击安装，依赖自动补 |
| CentOS / RHEL / Rocky / Alma / Fedora / openSUSE / 麒麟 | `.rpm` | 同上 |
| 其它、或不想装 | `.AppImage` | 单文件，`chmod +x` 后双击即跑（需要 FUSE2） |
| 兜底 | `.tar.gz` | 解压即用的绿色版 |

### 最要紧的一条：CentOS 7 装上也跑不起来

Electron 33 要求 **glibc ≥ 2.28**，这是硬门槛，不是缺依赖补得上：

| 系统 | glibc | 能不能跑 |
| --- | --- | --- |
| Ubuntu 20.04+ / Debian 11+ | 2.31+ | ✓ |
| Ubuntu 18.04 | 2.27 | ✗ `GLIBC_2.28 not found` |
| CentOS 7 | 2.17 | ✗ 同上 |
| CentOS 8 / Stream 8·9、Rocky 8·9、Alma 8·9 | 2.28+ | ✓ |

真要支持 CentOS 7，只能把 Electron 降到 22 及以下（Chromium 108 时代还兼容 2.17），
代价是 JS 引擎老三代、`utils/es2025-shim.ts` 反倒成了多余。不建议。

Linux 上以 root 运行会因 Chromium 沙箱报错，需要加 `--no-sandbox`（或在 desktop 文件里加）。

### 发一版（带检查更新）

发版比原来多一步：生成 `latest.json`。客户端只认这个文件。

```bash
# 1) 打包（三个平台各跑各的，产物都进 release/）
pnpm dist:win
pnpm dist:linux
pnpm dist:mac

# 2) 生成更新描述：扫描 release/，算 sha256 与字节数
pnpm manifest --notes "1. 新增检查更新
2. 修复文件列表权限列误判"

# 3) 把 latest.json 和所有安装包丢进同一个静态目录
#    （nginx / 对象存储 / 共享盘都行），然后把它的地址填进
#    「配置 → 更新源」，例如 https://dl.example.com/thshell/latest.json
```

`latest.json` 长这样（`assets` 是按 平台 + 架构 + 格式 列的，客户端自己挑本机该装的那个）：

```json
{
  "version": "0.2.0",
  "publishedAt": "2026-11-11T03:12:47.492Z",
  "notes": "1. 新增检查更新\n2. 修复……",
  "assets": [
    { "platform": "win32", "arch": "x64", "format": "exe",
      "url": "ThShell-0.2.0-win-setup.exe",
      "size": 103833304, "sha256": "e913629f…" }
  ]
}
```

几个要点：

- **`url` 可以写相对路径**，客户端会按 `latest.json` 自己的地址解析 —— 换域名、挪目录都不用重新生成；
  加 `--base https://dl.example.com/thshell/` 则直接写成绝对地址。
- **`sha256` 写了就强制校验**，对不上直接拒绝安装。内网文件服务器上放错版本、传一半断了，都靠它兜底。
- 客户端优先选 `exe` / `dmg` / `AppImage`，所以 deb、rpm、portable 这些"备胎"同时在库里也不冲突。
- 更新源留空 = 完全不检查更新（内网机器不联网也能正常用）。

**各平台"安装"能做到什么程度**：

| 平台 | 点「安装」之后 |
| --- | --- |
| Windows | 直接拉起安装程序，按提示完成后重开即可（**唯一能真一键装的平台**） |
| macOS | 打开 dmg，自己把应用拖进「应用程序」覆盖 —— 没签名本来也做不了静默替换 |
| Linux deb/rpm | 打开所在目录并给出 `sudo dpkg -i` / `sudo rpm -Uvh` 命令（装系统包要 root） |
| Linux AppImage | 打开所在目录，替换旧的 AppImage 文件 |

### 签名与告警

两个包都没证书，所以：

- **Windows**：首次运行弹 SmartScreen「Windows 已保护你的电脑」→ 更多信息 → 仍要运行。
  消掉需要 OV/EV 代码签名证书。
- **macOS**：Gatekeeper 会拦，右键 →「打开」，或
  `xattr -dr com.apple.quarantine /Applications/ThShell.app`。消掉需要 Apple Developer Program（$99/年）。

签名本身不影响功能，只影响"第一次点开时的信任感"。

### 发版前要改的一处

`electron-builder.yml` 里的 `deb.maintainer` / `rpm.maintainer` 现在是占位邮箱
`zhangmeng@example.com` —— deb 的 control 文件强制要求 Maintainer，改成真实邮箱再发。

### 打包报 `app.asar` 被占用（EBUSY）

现象：`⨯ remove ...\release\win-unpacked\resources\app.asar: The process cannot access the file
because it is being used by another process`。

成因不在 electron-builder：`release*/win-unpacked` 里的 **app.asar 被别的进程握住了句柄**
（IDE 的项目索引、杀软实时扫描都会这样），electron-builder 每次都要先清空 `win-unpacked`，删不掉就失败。
两种解法：

```bash
# 1) 关掉索引这个项目的 IDE（或把 release* 加进 Excluded），或杀软里排除目录
# 2) 先打到项目外的目录，再把成品拷回来
npx electron-builder --win --x64 --config.directories.output="$TEMP/thshell-release"
cp "$TEMP/thshell-release"/*.exe release/
```

第二种更省事，也适合脚本化 —— 只要成品在，`win-unpacked` 是中间产物，放哪儿都行。

## 目录结构

```
electron/
  main.ts                   主进程：窗口、IPC 注册、生命周期
  preload.ts                contextBridge，暴露 window.api
  types.ts                  主进程 / 渲染层共享类型
  modules/
    ssh-manager.ts          SSH 连接池（shell / exec / sftp 通道复用）
    metrics.ts              /proc 采集与速率差分计算
    sftp-service.ts         远端文件读写、递归删除、上传下载、日志尾部读取
    local-fs.ts             本地目录操作、日志尾部读取
    text-guard.ts           编码嗅探（BOM）与二进制拦截，UTF-8 / UTF-16 编解码
    log-tail.ts             从文件末尾往回凑够 N 行（本地/SFTP 共用）
    transfer-log.ts         传输记录落盘（userData/transfers.json，最多 200 条）
    config-store.ts         配置持久化 + safeStorage 加密
src/
  components/               界面组件（侧栏、标签页、终端、文件、监控、弹窗、预览、传输面板）
  stores/app.ts             Pinia 状态：连接、标签、指标、传输
  utils/es2025-shim.ts      pdf.js 6 依赖的 ES2025 新 API 垫片（Electron 35+ 可删）
  utils/transfer-format.ts  传输相关的数字/时间格式化（进度条和记录共用一套）
  utils/file-kind.ts        扩展名 → 文件类型（决定图标形状/颜色、能不能原地预览）
  utils/dialog-win.ts       弹窗的窗口态（normal / max / min）
  style.css                 深色主题变量与 Element Plus 覆盖

build/
  icon.svg                  应用图标矢量源文件（唯一真源）
  icon.png / icon.ico       构建期产物，由 `pnpm icons` 生成
  icons/                    Linux 各尺寸图标
resources/icon.png          运行时窗口图标
electron-builder.yml        多平台打包配置（win / mac / linux 的 target、图标、依赖）
scripts/make-icons.mjs      图标生成脚本
scripts/verify.mjs          冒烟总入口：一条命令串跑多组，出汇总表
scripts/build-linux.mjs     Linux 包构建（Win/mac 上自动转 Docker）
.github/workflows/build-desktop.yml  三平台 CI 打包（mac 包只能靠它）
```

## 应用图标

图标主体是终端提示符 `>_`，而不是字母缩写 —— 因为 16×16 的任务栏尺寸下两个字母会糊成一团，
提示符的折角与光标块依然清晰可辨，而且不需要读文字就能认出这是终端工具。

想调整配色或比例，只改 `build/icon.svg` 然后重跑：

```bash
pnpm icons
```

脚本会输出 16 到 1024 共 9 个 PNG、一个多尺寸 `icon.ico`（自带 ICO 编码，不依赖外部工具），
并同步更新窗口图标。小尺寸会自动放大主体 6%，抵掉缩小时的视觉收窄。

## 界面自检

改完界面不想手动开窗口看效果，可以跑冒烟模式，它会启动、截图到系统临时目录、自动退出：

```bash
# PowerShell
$env:THSHELL_SMOKE=1; pnpm exec electron .
```

产出：`%TEMP%\thshell-smoke-1.png`（主界面·深色）、`-2`（新建连接·深色）、
`-3`（主界面·浅色）、`-4`（新建连接·浅色）。改主题相关代码时一次就能看到两套皮的效果。

### 一次跑完（推荐）

冒烟模式一多，一个个 `THSHELL_SMOKE=xxx` 地跑既慢又容易漏 —— 改个文件管理器图标，
其实 `text` / `log` / `pdf` / `edit` / `tips` / `icons` 都该过一遍。所以有一个统一入口：

```bash
pnpm verify              # 核心 7 组：text log pdf edit tips icons perm（约 125s）
pnpm verify -- -b        # 先 build 再跑（改了源码就该带这个）
pnpm verify -- log tips  # 只跑指定的几组
pnpm verify -- --layout  # 布局/视觉那批：foot menu jump transfer clip tabs quick monitor sys
pnpm verify -- --all     # 全跑
pnpm verify -- -v        # 逐条打印断言（默认只吐失败行）
pnpm verify -- --list    # 看有哪些组
```

跑完给一张汇总表，任何一组有 FAIL 就以非 0 退出。它还会**自己等每个进程退干净**再跑下一组 ——
ThShell 有单实例锁，上一次的窗口没退干净，下一次会静默 `app.quit()`（零输出、退出码 0），
看着像代码编译坏了。脚本抓到"一条 `[smoke]` 都没有"时会直接提示这一点。

下面这些单模式用法仍然保留，调某个具体功能时更快：

```bash
# 真连一次第一台服务器，验证「配置 → IPC → SSH → 终端」整条链路
$env:THSHELL_SMOKE="connect"; pnpm exec electron .

# 切到文件页并灌几条假进度，目检传输行排版（深色 + 浅色各一张）
$env:THSHELL_SMOKE="transfer"; pnpm exec electron .

# 造 20 个各类型文件：逐行读图标的 k-* class 断言"类型对、种类散"，再双击图片走一遍预览
$env:THSHELL_SMOKE="files"; pnpm exec electron .

# 远程列表的权限 / 属主列：造一组已知权限(755/700/644/600/444)的文件，
# 用 root / 真身 / 陌生人三种身份各列一遍，再验 DOM 的权限串、属主格式、红字与窄窗口收起
$env:THSHELL_SMOKE="perm"; pnpm exec electron .

# 依次右键远程行 / 本地行 / 空白处 / 窗口右下角，目检菜单分组与边缘翻转，并截一张属性面板
$env:THSHELL_SMOKE="menu"; pnpm exec electron .

# 复制 / 剪切后看菜单里的「粘贴」文案是否随来源变化（同栏「粘贴」/ 跨栏「粘贴（上传）」）
$env:THSHELL_SMOKE="clip"; pnpm exec electron .

# 展开两条路径栏的「跳转」下拉，确认常用位置、盘符分组与浅色对比度
$env:THSHELL_SMOKE="jump"; pnpm exec electron .
```

还有一个配色回归专用模式 —— 悬停态没法靠合成事件伪造（CSS `:hover` 只认真实指针），
所以它走 `sendInputEvent` 移动真指针，再把算出来的底色打印出来：

```bash
# 悬停底栏三个图标按钮 + 侧栏「添加服务器」，打印实际底色，并截深/浅两张
$env:THSHELL_SMOKE="foot"; pnpm exec electron .
```

预期输出里 `hover-rename` / `hover-sidebar` 应是 `rgb(33, 39, 52)`（主题的 hover 灰），
`hover-delete` 带红色透明度；一旦又变回白色块，这条会立刻报出来。

指标解析和监控页布局也有各自的回归模式：

```bash
# 用一段真实格式的 /proc 输出喂给采集器，逐项断言内存/磁盘/运行时长/进程数/负载
# 全 PASS 才算解析没问题 —— 这类解析出错时界面只显示「0 / 0 GB」，不会报错
$env:THSHELL_SMOKE="metrics"; pnpm exec electron .

# 连真机切到监控页，打印卡片实际尺寸并截图（深色 + 浅色）
# 可指定窗口宽度，用来复现"窄窗口下最后一张卡片被切掉"这类只在特定宽度出现的问题
$env:THSHELL_SMOKE="monitor"; $env:THSHELL_SMOKE_W="1164"; pnpm exec electron .
```

图标按钮的提示（tooltip）也是遍历检查的 —— 漏了不会报错，只会"点了没反应/不知道是干嘛的"：

```bash
# 逐个触发文件管理里的图标按钮，读它自己的提示文案
$env:THSHELL_SMOKE="tips"; pnpm exec electron .
```

实现上有两个坑：触发用合成的 `mouseenter`（真指针依赖窗口焦点，冒烟实例常不在前台，
头几项会假失败）；读取用触发器的 `aria-describedby` 找到它自己的 popper，
不能按坐标猜"最近的气泡"（上一个气泡还在关闭动画里，会读串）。

图标大小也是量出来的，不靠截图目测 —— "这两个图标一样大吗"用眼睛判断永远有争议，
直接把 `getComputedStyle` 的 `fontSize` 和 SVG 的 `getBoundingClientRect()` 打印出来：

```bash
# 连真机进文件页，分别量页签栏 / 路径栏 / 底栏的图标，断言三者字号一致
$env:THSHELL_SMOKE="icons"; pnpm exec electron .
```

预期 `tabs` / `pathBar` / `foot` 三行都是 `font=16px 框=16×16`；侧栏「连接」按钮是
`font=21px`，它周围没有文字参照，缩到 16px 会又变回一个装饰点。

页签栏的右键菜单（关闭当前 / 其他 / 左侧 / 右侧）也有一组断言，假页签靠冒烟后门直接塞进
store，不占用真实 SSH 连接：

```bash
$env:THSHELL_SMOKE="tabs"; pnpm exec electron .
```

内置编辑器（双击文件进入、本地和远程共用）也有一整条链路用例：在临时目录里造一个文本文件和
一个二进制文件，双击 → 读 → 改 → 保存 → 回读磁盘，再去 `/etc` 双击远程的 `hosts`：

```bash
$env:THSHELL_SMOKE="edit"; pnpm exec electron .
```

文本编码单独有一组按字节验证的用例（UTF-16 的 `.ini` 能不能打开、保存会不会把编码写坏）：

```bash
$env:THSHELL_SMOKE="text"; pnpm exec electron .
```

日志查看器（只读末尾 N 行）单独一组：造一个 10000 行的日志、一个 92MB 的日志、一个 UTF-16 的日志、
一个名字叫 `.log` 的二进制，先用 `readLocalTail` 逐项断言"给的是不是**最后** 200 行"，
再连真机读 `/var/log/messages` 的尾部，最后双击一次 `.log` 验界面：

```bash
$env:THSHELL_SMOKE="log"; pnpm exec electron .
```

界面那几条是重点：不能出现「保存」按钮、`contenteditable` 必须是 `false`（用户明确说日志不用改）、
打开就停在最新一行、把行数切到 500 后底栏跟着变、往文件里追加一行后自动刷新能读到。

PDF 预览一组：冒烟里手搓一个最小合法 PDF（自己算 xref 偏移）写到临时目录，双击打开后断言
「读出了页数 / 没有报错提示 / canvas 出来了 / 尺寸非零 / 画布上真有深色像素」——
最后一条是关键，前四条全绿而画布是白板，正是"pdf.js 渲染时才炸"的典型现场：

```bash
$env:THSHELL_SMOKE="pdf"; pnpm exec electron .
```

底部传输面板一组：灌两条"进行中"的假进度（一条上传、一条目录下载）+ 两条已结束的假记录，
断言"默认收起 / 收起时也显示 N 个进行中 / 点一下展开 / 每行都有 源 → 目标 / 失败的显示原因 /
记录真的落盘"，另外**量几何**（进度条与数字在不在同一行、条宽有没有被数字挤没、四行是否都被裁掉）：

```bash
$env:THSHELL_SMOKE="transfer"; pnpm exec electron .
```

> 这一组是**布局回归**，不是功能回归 —— 间距/列宽这类问题截图看十遍说法都不一样，
> 直接 `getBoundingClientRect()` 比一句话管用。它顺手清掉自己塞的假记录（`removeTransfer`），
> 不会脏了真实历史。真链路的记账在 `uploaddir` 那组验（真传一次目录，检查记录里的双端路径）。

「系统」页（操作系统 / 硬件负载 / 磁盘挂载 / 网络 / 登录会话）同样先用一段真实格式的 shell 输出
喂解析器逐项断言，再连真机截图，另外还验证了虚拟网卡折叠能展开：

```bash
$env:THSHELL_SMOKE="sys"; pnpm exec electron .
```

终端底部的快捷命令（常驻一键 + 分组浮层 + 悬停说明）也能一条命令验完：

```bash
$env:THSHELL_SMOKE="quick"; pnpm exec electron .
```

它会断言：常驻栏条数与每条都有悬停说明、浮层分组数与命令总数、每条命令都带说明文字、
浮层没有顶出窗格、`fill` 类命令（带占位端口的 `lsof -i:8080`）提示了「只插入不执行」，
最后真点两条命令读终端屏幕确认「run 类真的执行了、fill 类只停在提示符上」。

> `contextBridge` 暴露的 `window.api` 是只读的，挂不了 spy 截获 `ssh.write`，
> 所以行为验证只能读屏幕（`.xterm-rows` 的文本），别去改那个对象 —— 改不动还静默。

> 注意：应用有单实例锁，重复启动会静默退出。若截图没更新，先清掉残留进程：
> `taskkill /F /IM electron.exe`

> 断言全是"看界面长什么样"，界面坏掉之前往往先在渲染进程控制台留一句原因。
> 冒烟会把渲染进程的 `warn` / `error` 以 `[web] …` 打到主进程控制台，加
> `THSHELL_SMOKE_WEBLOG=1` 连 `info` 一起打 —— 排查"按钮点了没反应"这类问题时，
> 比在界面上找线索快得多。

## 实现要点

- **会话在主进程持有**，渲染进程只拿 `sessionId`，密码和私钥不会流进页面上下文。
- **UTF-8 分片**：SSH 数据用 `StringDecoder` 缓冲再投给 xterm，避免中文被 TCP 分片切断后乱码。
- **指标采集**一次 `exec` 取回全部字段，CPU 与网卡速率靠前后两次采样做差分，按会话独立保存基准值。
- **终端尺寸**由 `FitAddon` + `ResizeObserver` 联动，窗口缩放或标签切回时都会重算 `cols/rows` 并同步给 PTY。
- **快捷命令分两层**：常驻一键（`hot: true`，点一下直接跑）+ 分组浮层（35 条，点开才占地方）。
  三十几条命令堆在一条会横滚的栏里根本找不到，所以常驻只留最常用的 7 条，其余进浮层。
  命令表抽在 `src/utils/quick-commands.ts`，`desc` 写的是「这条命令回答什么问题」而不是翻译命令本身。
  - `mode: 'fill'` 的命令带占位参数（`lsof -i:8080`、`systemctl status sshd`），点了**只写进提示符不回车**，
    否则会跑一条写死参数的命令、什么都不输出，看着像命令失效。界面上用虚线边框 + `✎` 区分。
  - 悬停说明是 `el-tooltip` 的 `#content` 插槽，两段：`desc`（干什么）+ `note`（参数怎么读、什么情况会误判）。
    卡片上的命令会按宽度截断，所以气泡里把完整命令再给一遍，避免「点了什么自己看不清」。
  - 气泡内容是 teleport 到 `body` 的，**scoped 样式够不着**，样式写在组件末尾的非 scoped `<style>` 块里；
    颜色靠 `opacity` 分主次而不是写死白色，深浅两套主题（`--tooltip-*` 已经是反色）都不会糊。
  - 浮层挂在 `.terminal-wrap` 上而非快捷栏里，`max-height` 才能按整个终端高度算；
    挂快捷栏里百分比高度会按 32px 的栏去算，等于没有上限。
- **配置文件用 `.mts`**：主进程产物 `main.js` 必须是 CommonJS，所以 `package.json` 不能声明
  `"type": "module"`；只能靠文件扩展名单独把 Vite 配置标成 ESM，以此消掉
  `The CJS build of Vite's Node API is deprecated` 警告。
- **老服务器兼容**：显式放开了 `ssh-rsa` 等 legacy host key 算法，CentOS 6 一类机器也能连。
- **目录下载**分两趟：先完整扫描统计总字节（进度条才有分母），再逐个 `fastGet`；单个文件失败
  不中断整体，最后汇总成失败清单。Windows 下会自动替换文件名里的 `: * ? " < > |`，
  并跳过符号链接目录，避免 `/proc` 这类目录无限递归。
- **传输进度**统一走 `createReporter`（主进程）：
  - ssh2 每 32KB 回调一次，直接转发等于几百上千次 IPC，按 100ms 节流；
  - 速度用两次上报之间的增量算，再按 0.65/0.35 指数平滑，读数稳定不跳字；
  - 传输前先 `stat`/`fs.stat` 取总大小，首帧就有分母，不用等第一个 chunk；
  - 收尾把 `transferred` 对齐到 `total`（否则进度条永远卡在 99%），失败则保留真实值不清零。
  界面只负责格式化，不做二次计算,避免两边算出两个数字。
- **右键菜单**用一个受控组件（`FileContextMenu`）承载，菜单项由调用方按"哪一栏 + 有没有命中条目"
  拼出来，空白处右键自然退化成"对当前目录操作"那套。定位在 `nextTick` 后量一次实际尺寸再决定
  是否翻到光标左上方，否则窗口右下角的菜单会被切掉一半。
- **文件剪贴板**只存 `{ path, name, isDir }`，落地时按来源和目标拆成四条路径：
  同栏交给主进程 `cp`/`mv`；本地上传走 `upload`/`uploadDir`；远程下载走 `download`/`downloadDir`。
  两个坑：远程 `cp` 必须带 `-T`，否则目标目录已存在时会多套一层（`dst/src/src`）；
  Windows 的 `rename` 不能覆盖已存在目录（EPERM），剪切前要先清掉同名目标。
- **路径跳转**：常用位置（桌面/下载/文档）由主进程用 `app.getPath()` 算好再下发，
  渲染层不需要知道 Windows 和 macOS 的目录差异；取不到的位置（有的系统没有「下载」）直接不出现，
  免得点了报错。系统目录框会带上当前路径当 `defaultPath`，否则每次都从「上次访问位置」开始。
- **图标尺寸**统一走 `--icon-xs/sm/md/lg/xl`（14/16/17/19/21）五档，不再各处写死 px。原因：Element Plus
  的图标是 1024 视口的方形 SVG，字形只占 `1em` 的七成多，`font-size: 13px` 时实际只有 10px 左右
  的视觉高度，配上 11.5px 的正文就像一排装饰点。
  **16px（`sm`）是行内标准**：页签栏、路径栏控件、底栏工具、列表里的文件/文件夹图标全在这一档。
  曾经把路径栏和底栏当成「空白区里的小按钮」抬到 19/21px，结果是整条栏被图标压住、和页签栏对不齐 ——
  所谓"看着小"其实是字形留白造成的错觉，不是真的要更大的字号。`lg`(19px) 现在只是备用档，
  `xl`(21px) 只留给**真的孤立、周围没有任何参照物**的图标（侧栏服务器行的「连接」按钮）。
  这类图标还要给成固定方框（24×24），否则悬停底色会被 padding 拉成横条。
  这类"图标偏大/偏小"的反馈已经来过三次，靠截图目测说不清，见下面的 `icons` 冒烟。
- **写入安全**：配置文件先写 `.tmp` 再 `rename`，中途断电不会留下半截 JSON。
- **Element Plus 的浅色默认值必须显式映射**：EP 内部有一整套近白的 `--el-fill-color-*` 色阶
  （`#f5f7fa` 之类），不映射的话任何"悬停 / 选中 / 禁用"底色都会在深色界面上糊成一块白 ——
  text 按钮悬停变白块就是这个原因。同理 `.el-popper.is-dark` 取 `--el-text-color-primary` 当底色，
  而我们把那个变量映射成了正文色，气泡就被整个反成白底黑字。提示气泡现在单独用
  `--tooltip-bg/fg/border`，深浅主题都保持"与背景反向"，不跟面板色走。
- **纯图标的 text 按钮要做成正方形**：`.pane-foot` 里用 `:has(span)` 区分有无文字，
  图标按钮 28×28 无 padding。否则 hover 底色会被 padding 拉成一条横向长条，配上方角图标很别扭。
  删除这类破坏性操作单独挂 `.del`，悬停转红，不和「重命名」长一样。
- **底栏图标要按"动作"分配，别按"位置"凑**：眼睛 = 看、笔 = 改，这两个不能互换。
  曾经是「重命名用 `EditPen` 铅笔、编辑用 `View` 眼睛」，用户一眼就看出来不对 ——
  笔明明该是编辑。现在：
  - 「打开」按钮**按选中文件类型切图标和文案**：文本 → `EditPen`「编辑」，
    日志 → `View`「查看日志」，office/PDF → `View`「预览文档」（以前这三类只有双击能用，
    按钮对 office 是灰的，等于白占一个位置）；
  - 重命名用**自己画的图标**（`RenameIcon.vue`）：方框 + 字母 A + 右侧光标竖线，
    也就是 Windows 资源管理器「重命名」那个符号。EP 293 个图标里没有这个形状；
    试过 `Tickets`（渲染成"带横线的纸"，跟文件图标混）、`PriceTag`（吊牌，语义还是偏），
    都不如它一眼就认出来。画的时候有两点要注意：
    - 跟 EP 图标一样用 **1024 视口**，字形留白比例对齐，放进 `<el-icon>` 才是 16px、基线才对；
    - 笔画要粗（64/1024 ≈ 1px @16px），细了在 16px 下糊成一团。
  - 自绘图标那个按钮要单独加 `.sq` 类：EP 会把 slot 内容包一层 `<span>`，
    原来靠 `:not(:has(span))` 判"纯图标按钮给 28×28 正方形"的规则就命中不了，
    按钮会变成带 padding 的横条，跟旁边对不齐。
- **指标解析用的是"整段输出 + 分隔符切分"**：一次 `exec` 把 `/proc/stat`、`meminfo`、`net/dev`、
  `loadavg`、`uptime`、`df`、`ps` 全取回来，用 `@@TAG@@` 分段。踩过的坑：`split('@@')` 之后分隔符
  已经没了（`A@@MEM@@B` → `['A','MEM','B']`），取值时却又拿 `tag + '@@'` 去 `indexOf`，永远匹配不上，
  结果内存/磁盘/运行时长/进程数全部静默解析成 0 —— 界面只显示「0 / 0 GB」和「运行时长 —」，不报错。
  这种错误必须靠固定用例兜住，所以有 `THSHELL_SMOKE=metrics` 拿一段真实格式的输出逐项断言。
- **监控卡片用 `repeat(4, minmax(0, 1fr))` 而不是 `1fr`**：`1fr` 的最小尺寸是 `min-content`，
  卡片里又全是 `nowrap` 的文字，窗口一窄四列撑不开就会整体溢出、最后一张被窗口右边缘切掉，
  连带把整页撑出横向溢出。宽度 ≤1120 时退成 2×2，避免长数值贴边。
- **页签栏右键菜单**四项（当前/其他/左侧/右侧）共用一套判定：拿被右键页签的下标去比
  `0` 和 `length - 1`，够不着的那几项加 `.disabled`（`pointer-events: none`，点不中也点不动）。
  批量关要"先 `slice` 快照再逆序关"：边遍历边 `splice` 会把下标带偏，而逆序关能让活动页的落点
  始终落在没被删除的那一侧。
- **写断言时不要紧跟着截图**：`capturePage()` 会让窗口短暂失焦，而失焦会触发右键菜单的
  `closeMenu`，于是"先截图、再点菜单项"就变成点击全部落空 —— 断言还全绿，非常难查。
  冒烟里把截图统一挪到所有交互断言之后，单独跑一轮。
- **右键不会触发 `click`**：终端和侧栏的菜单都只监听 `window` 的 `click` 来关闭，所以菜单开着时
  再去右键别处会叠出两个菜单。页签栏右键时会先往 `document` 派发一次冒泡 click，让它们自己收掉。
- **「能不能编辑」分两层判，别合并**：渲染层按扩展名白名单 + 体积上限做快速筛选（列表里逐行调用，
  要快），主进程拿到 Buffer 后再按 BOM / NUL 兜底。只有第一层挡不住 `.log` 里塞二进制、
  无扩展名的 core dump；只有第二层又得等读完整才报错，双击就是一次无谓的网络往返。
  另一个坑：`readFileSync(p, 'utf-8')` 会先把二进制替换成 U+FFFD，判断必须发生在 `toString()` 之前。
- **体积上限是护栏，不是产品规则**：上限 `20MB`、提醒线 `3MB`，两个数字都放在
  `electron/types.ts` 里由主进程和渲染层共用（各写一份迟早对不上，表现是"按钮能点但打不开"）。
  为什么不干脆放开：一份文本读进来之后至少同时存在四份（主进程 Buffer、解码出的字符串、
  Vue 里的 `content`、"原始内容"），再加 CodeMirror 的文档结构；几百 MB 的日志塞进去会卡到
  "连取消都点不到"，比一句明确的拒绝更糟。超过提醒线只提示不拦（10MB 日志是正常需求），
  实测 6MB / 16 万行挂进 CodeMirror 约 300ms（只渲染视口），20MB 仍有余量。
  顺带：底栏的字节数是"停手 200ms 再算"的，大文件每敲一个字都全量算一遍纯属浪费。
- **「有 NUL 字节」不等于二进制**：UTF-16 的 ASCII 部分每隔一个字节就是 `0x00`，而 Windows 上
  记事本"Unicode"另存出来的 `.ini` / `.reg` / `.bat` 正是 UTF-16 —— 一句"这不是文本文件"就把
  明明能编辑的配置文件挡在门外。所以判定顺序是 **先看 BOM，再看 NUL**：
  UTF-8 BOM / UTF-16 LE·BE BOM 各自按原编码解码，都认不出来才走 NUL 判断。
  读写是配套的：`readFile` 把 `encoding` + `bom` 一起返回，界面原样交给 `writeFile`，
  **按原编码写回** —— UTF-16 的配置文件被改成 UTF-8，读它的老程序会整份乱码，那比打不开更糟。
  边界也明确：不带 BOM 的 UTF-16 不去猜（靠"奇偶位 NUL 多不多"猜误判率不低），
  仍然拒绝，只是报错文案会把这种可能性说出来。
- **双击的语义按文件类型分流**：目录进去、文本进内置编辑器、日志进只读查看器、
  其它交给系统默认程序。运维场景里双击一个 `nginx.conf` 弹出记事本是纯干扰。
  右键菜单同步给出「在编辑器中打开 / 查看日志」，但只有对应类型才出现
  （列了也打不开，不如不给）。
- **日志和文本是两条路，不要合并**：日志要的是"最后 N 行"，不是"整份内容"。
  主进程从文件末尾往回读一个窗口（起始 64KB，不够就翻倍，顶到 8MB），凑够行数就停 ——
  92MB 的日志读尾部只要 2ms，整份 56ms 还没算解码和挂进 CodeMirror 的代价。
  三个必须处理对的细节：
  - **切片起点会落在字符中间**：只要不是从文件头开始读，第一行一律丢掉（它本来就是半截），
    否则开头几个字节会变成 U+FFFD；UTF-16 还要把起点对齐到偶数偏移，不然整段错位。
  - **编码得单独嗅**：BOM 在文件第 0 字节，尾巴上没有。所以先单独读文件头 4 字节判断编码。
  - **二进制护栏照旧**：`access.log` 里也可能是 gzip 或 core dump，切片出现 NUL 就拒绝（UTF-16 除外）。
  远端不能直接 `sftp.readFile` 读整份，也不用 `createReadStream`（end 含不含头尾绕不清），
  而是 `open` + 定位 `read` + `close`：单次 `read` 返回的字节数可能少于请求，要循环读满。
- **日志查看器不显示行号**：加载的只是末尾 N 行，行号从 1 数会让人以为是文件真实行号
  （第 477 行其实是第 9977 行）。日志的时间戳本身就是坐标，行号在这里只帮倒忙。
- **自动刷新只在"用户停在底部"时才滚到底**：往上翻着看历史时被弹回最新一行最恼人，
  所以刷新前先量 `scrollHeight - scrollTop - clientHeight`，超过 60px 就保住原滚动位置。
- **PDF 预览自己画 canvas，不用 Chromium 内置阅读器**：`<iframe src="blob:…">` 零成本，
  但那是"另一个进程里的黑盒"：主题管不了、缩放栏是英文、在弹窗里常被当成下载。
  现在由 `pdfjs-dist` 渲染成 canvas，逐页占位 + 可视区懒渲染（`IntersectionObserver`，
  上下各预取 480px），同一时刻只画一页（串在一条 Promise 链上），缩放时按"世代号"作废旧任务。
  三个必须踩对的点：
  - **CSP 要放开 `blob:`**：`file://` 下 `new Worker('file:///…/pdf.worker.mjs')` 会被当成
    跨源脚本拒绝，Blob URL 是唯一到处都能起 worker 的写法。而 `script-src` 少了 `blob:` 时，
    worker 和它的 fake-worker 后备会一起被拦，界面只剩一句
    `Setting up fake worker failed: Failed to fetch dynamically imported module: blob:…`。
    所以 `index.html` 里 `script-src` / `connect-src` 都要带 `blob:`，另单写一条 `worker-src`。
  - **pdf.js 6 用了好几批 ES2025 新 API**，而 Electron 33 是 Chromium 130：
    `Uint8Array#toHex` / `toBase64` / `fromBase64`（133+）缺了**加载就失败**，报
    `a.toHex is not a function`；`Map#getOrInsertComputed`（141 左右）缺了是
    **加载能过、渲染第一页才炸**，而 pdf.js 把这个异常当成"单页渲染失败"吞掉 ——
    界面上没有报错、只有一片空白。后者最难查，`pdf` 冒烟里"画布上真有深色像素"就是为它留的。
    这批由 `src/utils/es2025-shim.ts` 一起垫上；worker 跑在 Blob 里 import 不到模块，
    所以同一份源码以字符串形式前置到 worker 源码前面（`new Function` + `unsafe-eval`）。
    升到 Electron 35+ 后整个文件可以删，各 API 内部都会先判断原生是否存在。
  - **别指望 `IntersectionObserver` 的首次回调**：弹窗还在做入场动画、或这一帧 root 高度
    还是 0 时，第一页可能一直等不到 `isIntersecting`（`observe` 了却永远不画）。
    所以挂完 observer 后第一页直接 `enqueue` 一次，重复排队会被 `rendered` / `rendering` 挡住。
  - **单页失败必须写在页面上**：`renderOne` 的 catch 原来只 `console.warn`，于是出错时
    界面上是一片"永远转圈的白纸"，用户无法描述、我们也只能翻控制台猜。现在失败原因记在
    `pageFail[页号]`，直接铺在本该是白纸的那一页上（「第 N 页没画出来 + 原因 + 重试」）；
    **整篇一页都没画出来**才升级成 `loadError` 的大提示 —— 40 页里坏 1 页不该把其余 39 页藏掉。
    连带注意：占位 div 里除了 canvas 还可能有这块提示，所以换画布只能用
    `querySelectorAll('canvas').forEach(remove)` + `appendChild`，不能 `replaceChildren()`
    整块清空，否则会把 Vue 管的节点从 DOM 里抽走，虚拟 DOM 与真实 DOM 对不上。
- **图片预览只有三个要点**，但每个都踩过：
  - **`data:` URL + `<img>`**，不解码成 ImageBitmap：SVG 放进 `<img>` 时脚本不执行（安全），
    而且 `<img>` 自带 `naturalWidth`，能顺手把"文件损坏/截断"（解码出来 0×0）认出来。
  - **棋盘格底**（`linear-gradient` 四段拼 16px 方格）不是装饰：透明 PNG 放在纯色上，
    分不清哪块是透明、哪块是白。用的是极低对比的两色，不会比图片本身更抢眼。
  - **`display:flex` + 子元素 `margin:auto`** 才是"图小就居中、图大就能滚"的唯一稳妥组合；
    换成 `justify-content:center` 会把溢出的左上角裁掉，滚不回去。
    另外 `image-rendering: pixelated` 只在**放大**时开：缩小也关掉平滑会让照片满屏噪点。
- **文件图标：形状负责区分，颜色负责提醒**。九成文件是代码/配置/日志/文本，
  所以它们统一走中性灰，只有图片、视频、音频、PDF、表格、压缩包、证书这类"一眼要认出来"的上色；
  形状也尽量挑差异大的（`Cpu` 当代码、`Box` 当压缩包、`Tickets` 当日志、`Headset` 当音频），
  16px 下形状比细节更可辨。冒烟里不去看截图，而是读每行的 `k-*` class 逐个断言
  （"20 行各自对、种类 ≥ 10"），否则"图标好像不一样"这种结论毫无信息量。
- **`openModeOf()` 必须只有一个判定入口**：以前"双击本地 / 双击远程 / 底栏按钮 / 按钮图标 /
  按钮文案 / 右键菜单"六处各写一遍三选一，结果右键「预览文档」写死成只找本地文件，
  在远程栏点它会去本地找同名文件（找不到就报"文件不存在"）。现在六处都问同一个函数，
  图标和文案也由它派生，不可能再各说各话。
- **"这个文件我能不能写"只能用 uid/gid 算，不能拿用户名比**：同一个用户名在不同机器上 uid
  可能不同，容器和共享存储里"同名不同 uid"极其常见。所以连上之后跑一次 `id -u; id -G`
  （uid + 全部附加组）缓存整个会话，列目录时用文件自身的 `uid`/`gid` 去比三档位。三个必须按顺序：
  1. **`other` 位有 w 就是谁都能写**，先判掉 —— 反过来先比属主会把"公开可写"判成不可写；
  2. **root 不受权限位约束**（uid 0 直接可写），否则用 root 登录会满屏红字，人被逼着去 sudo；
  3. 剩下的按"属主 → 属组 → 其他"比对应那一位。
  拿不到身份（老系统没有 `id`、exec 被策略禁掉）就返回 `undefined`，界面保持中性色：
  **猜错方向比不标更糟** —— 把能写的标红，人会以为要提权；把不能写的漏标，人会白试一次保存。
- **属主/属组名不用自己解析 `/etc/passwd`**：`readdir` 的长格式
  （`-rw-r--r-- 1 root root 1234 Nov 10 12:00 name`）前三列里不会有空格，
  文件名里的空格从后面才开始，所以取前四个字段就够了。服务器回空长格式时退回数字 `uid:gid`。
- **setuid/setgid/sticky 不能当普通 x 抹平**：`/tmp` 的 `rwxrwxrwt` 要是显示成 `rwxrwxrwx`，
  人会以为谁都能删别人的文件，其实有 sticky 挡着。规则是"有执行位用小写、没有用大写"（`s/S/t/T`）。
- **窄窗口下按"这一栏"的宽度收起列，用容器查询而不是媒体查询**：窗口宽不宽不重要，重要的是
  文件栏还剩多少像素（1080 的最小窗口下每栏只有 400 出头）。`.list` 上挂
  `container-type: inline-size`，`< 560px` 先收属主列、`< 450px` 再收权限列。
  冒烟里会真的把窗口 `setSize(1080)`，断言属主列收起且文件名还有 175px —— 光靠肉眼看截图
  分不出"是收起了还是被挤成 0 宽"。
- **弹窗的"最小化"必须只改样式，不能走 `visible`**：这三个弹窗都带 `destroy-on-close`，
  `visible = false` 会直接销毁正文 DOM —— 编辑器里没保存的修改、PDF 已渲染的画布、
  图片的缩放位置全没了。而"收起来"的全部价值就是**腾出屏幕但东西还在**。
  所以最小化只是给 `.el-dialog` 挂一个 `min` 类，靠 CSS 把它缩成右下角一条，
  正文和底栏 `display: none`（组件没卸载）。两个连带细节：
  - **遮罩要变成"透明且 `pointer-events: none`"**，否则收起后小条成了摆设 —— 后面的文件列表
    全被那层看不见的遮罩挡着。用 `.el-overlay:has(.el-dialog.min)` 选（`:has()` 在 Chromium 130 可用）。
    顺带治好了另一个坑：预览弹窗开着 `close-on-click-modal`，遮罩可点的话，收起后点任何地方
    都会把里面的内容关掉。
  - **三个弹窗可以同时收起**，各给一个 `bottom` 档位（30 / 68 / 106px），否则叠成一坨。
- **"最大化"不能只把外框放大**：内容区还是写死的 `68vh` / `58vh`，框变大了里面不动，等于没做。
  做法是给 `.el-dialog.max` 定高 + `display: flex; flex-direction: column`，正文区 `flex: 1 1 auto`
  自己吃掉剩余高度。**不要反过来硬算** `height: calc(100vh - 148px)`：头部/底栏换个字号就得重算，
  算多了会把底栏顶出屏幕。日志弹窗的路径行和工具条还要 `flex: none`，否则窗口一矮它们先被压扁。
- **`:global()` 必须把整条选择器包进去**。写 `:global(.el-dialog.max) .preview-body` 时，
  Vue 的 scoped 编译器会把后面的 `.preview-body` 连空格一起吞掉，编译出来是
  `.el-dialog.max { height: auto }` —— 正好把上面那条定高改回去。表现是"最大化只变宽不变高"，
  而且没有任何报错；靠冒烟里 `1426×754（窗口 1444×881）` 这种几何断言才看得出来。
- **窗口尺寸变了别跟用户抢方向盘**：图片预览的 `ResizeObserver` 原来无条件 `fit()`，
  于是"最小化→展开"或"最大化"都会把用户刚调好的 110% 弹回"适应窗口"。
  加一个 `userZoomed` 标记，用户手动缩放/点了 1:1 之后就不再自动 fit。
- **弹窗的窗口按钮要照原生标题栏画**，不能拿功能图标凑：一开始用 Element Plus 的 `FullScreen`
  当"最大化"，那是四角括号，看着像"全屏播放"，跟外层窗口那颗空心方框完全不是一套东西。
  改成手画 SVG —— 10px 见方、1px 细线：一条横线、一个空心方框、两个错开的方框（还原）、一个叉；
  悬停整格淡色填充，关闭键悬停 `#c42b1c` 红底白叉，和 Windows 原生同色。
  顺带补上**双击标题栏 = 最大化 / 还原**（原生窗口的默认行为，原来只有按钮能点）。
- **传输记录必须记"从哪儿到哪儿"**：进度条只说明"正在传"，传完就消失，于是
  "这个 dump 到底落在 /data 还是 /home" 只能靠回忆 —— 运维排查时这条信息恰恰最要紧。
  三个设计决定：
  - **路径由主进程记，不由界面记**：`emitProgress` 是唯一收口，成功和失败都从这儿过；
    而界面上只有一个进度事件，路径的"原件"在主进程，窗口关掉/刷新也不该丢账。
    成功与失败同一条口子，就不会出现"界面有、文件里没有"。
  - **记录与进度分两份数据**：进度是"此刻正在发生"，完成即消失；记录是"发生过什么"，要留着。
    界面把两者拼在同一个面板里（进行中在上、记录在下），但**记录里要排掉"刚完成、
    进度还显示 100%"那一条**，否则同一次传输会短暂出现两行，看着像传了两次。
  - **落盘单独一个文件**（`userData/transfers.json`，最多 200 条，写 `.tmp` 再 rename）：
    记录会一直增长而配置基本不变，混进 `config.json` 只会把配置文件拖肥、把迁移逻辑搞复杂。
  - 面板默认**收起**，但收起那一行本身显示"N 个进行中 + 当前文件 + 百分比"，
    所以收起不等于看不见；展开态记在 `localStorage`，下次还是你走时的样子。
- **EP 的主色按钮禁用态要单独压暗**：它拿 `--el-color-primary-light-5` 当禁用底色，而深色主题里
  这个色阶是"更亮的薄荷"，禁用按钮看起来比可点的还亮 —— 点下去没反应，比灰掉更让人困惑。
- **「监控」和「系统」是两件事**：前者是每 3 秒刷的资源曲线（CPU/内存/网速，要差分），
  后者是"进来看一眼"的机器档案（发行版、内核、磁盘挂载、IP、登录会话），一次 exec 取全，
  不做差分、不轮询，按需重新采集。合并成一个页会让两边都变笨重。
- **系统信息的解析比指标更依赖格式**，几个必须按实际输出处理的点：
  - `df -hPT` 的挂载点可能含空格，所以正则把 `Use%` 之后整段当成挂载点，不能按列切；
  - 网卡"通不通"要看 `state UP`，**不能看 flags 里的 UP** —— docker0 这种没插线的网桥同样带 UP 标志，
    但 state 是 DOWN（bond/tun 之类永远报 UNKNOWN，这种才退回看 flags）；
  - 地址只收 `scope global`，否则 127.0.0.1 和 fe80:: 链路本地会把列表灌满；
  - docker 宿主机的噪音要主动折叠：`.../overlay2/<hash>/merged` 的挂载、几十张 vethXXXX 网卡
    都不是"这台机器有什么盘 / 有什么 IP"，前者直接滤掉，后者折进一行「另有 N 张虚拟网卡」。
- **别跨组件复用 scoped 类**：`SideBar.vue` 里的 `.scroll-y` 是带 `data-v` 的 scoped 样式，
  在别的组件上写 `class="scroll-y"` 是不生效的 —— 表现是"内容被裁掉、滚不动"，而且不报错。
  滚动容器自己写 `overflow-y: auto`。
- **主题**：所有颜色收敛成 CSS 变量，`<html data-theme>` 一处切换即整体换肤；浅色不是简单反色，
  背景/面板/输入框分了三层色阶，否则白底白框会糊成一片。终端配色由同一个 `theme` 驱动，
  避免「深色界面 + 浅色终端」的割裂。
- **原生菜单栏要整个摘掉，不能只藏起来**：`autoHideMenuBar: true` 平时确实看不见，
  但**按一下 `Alt` 就会冒出 File / Edit / View / Window / Help**，而且它占的是窗口顶部真实的一行，
  自绘标题栏会被顶下去一截 —— 看着像界面错位。Windows/Linux 直接 `Menu.setApplicationMenu(null)`。
  - macOS **不能摘**：`Cmd+C` / `Cmd+V` / `Cmd+Q` / `Cmd+W` 都挂在这些菜单项的 role 上，
    摘了整台机器的编辑快捷键就废了。所以只保留 `appMenu` / `editMenu` / `windowMenu` 三组。
  - 菜单摘掉后**挂在菜单项上的快捷键一并消失**：`Reload`（`Cmd/Ctrl+R`）和 `Toggle DevTools`
    本来都是菜单项，`F12` 也就不响应了。用 `webContents.on('before-input-event')` 自己接回
    `F12` 与 `Ctrl + Shift + I`，接的时候记得 `event.preventDefault()`，否则按键还会往下传。
  - 这个缺陷**截图截不到**：`capturePage` 抓的是内容区，原生菜单在框外面，冒烟只能断言
    `Menu.getApplicationMenu() === null`（macOS 反过来断言非空）。
- **菜单摘掉之后得自己补一个**：标题栏左侧的菜单栏（收起侧边栏 / 关于）是网页做的，不是原生菜单。
  三个理由：原生菜单是英文的、样式跟深色主题对不上、而且用户真正要的只有"收起侧边栏"和一页说明，
  不值得为它维护一套 `Menu` 模板。菜单栏和右侧「新建连接 / 导入 / ⚙」之间用一条竖线隔开 ——
  一行里挤两组控件，不划线会看成同一组。
  - 侧边栏收起用 `v-show` 而不是 `v-if`：`v-if` 会把 `SideBar` 卸载，分组展开状态、滚动位置全丢，
    再展开时用户得重新找地方。`.sidebar` 一旦 `display:none`，`workspace` 的 `flex:1` 自然铺满。
  - 收起状态存 `localStorage` 而不是 `config.settings`：这是"临时把屏幕让出来"的操作，
    写进配置文件会污染导入/导出的 schema。
  - `Ctrl + B` 在输入框和 `contenteditable` 里不抢 —— 编辑器里那是「加粗」。
  - 版本号必须走主进程拿：`app.getVersion()` 在 preload 里取不到，而 `process.versions` 里的
    Electron / Chromium / Node 又要跟应用版本拼在一起，所以合成一个 `app:info` 一次取回，
    别在渲染层从 `userAgent` 里抠字符串。
- **检查更新没用 electron-updater，自己写了一个**，原因有硬伤：
  - 它只认 electron-builder 那套 `latest.yml`，**Linux 那边只支持 AppImage** —— 而 CentOS / 麒麟
    上装的是 rpm，deb 同理，等于一半用户漏掉；
  - macOS 未签名时 Squirrel.Mac 直接拒绝，做不了；
  - 我们的"更新源"就是一个静态目录，没必要为它上 S3 或 GitHub Releases。
  于是方案退到最朴素的形态：一个 `latest.json` 说清"新版本有哪些包、在哪儿、sha256 多少"，
  客户端自己比对、自己下载、自己校验、自己拉起安装包。跨平台一致，也没有隐藏行为。
  - 版本比较自己写（`0.10.0 > 0.9.9`）：字符串比较会把 `0.10.0` 判成小于 `0.9.9`，这是最经典的坑。
  - `url` 支持相对路径，用 `new URL(url, feed)` 解析 —— 一个目录里放 json 和安装包最省事，
    换域名也不用重新生成。
  - 下载用 `net.fetch` 而不是 Node 的 `https`：前者走 Chromium 的网络栈，**自动带上系统代理**，
    内网环境经常是必须的。
  - 边下边算 sha256，`content-length` 与 `size` 双重校验，写 `.part` 再 rename —— 半截文件不会被当成安装包。
  - 启动时的静默检查**只点一个圆点，不弹窗**：用的是运维的机器，弹窗打断比漏更新更烦。

## 已知限制

- 监控页与系统页都依赖 Linux 的 `/proc`（系统页还要 `iproute2` 的 `ip`、`df`、`who`），
  Windows 主机能连、能敲命令，但这两页没有数据（系统页会直接显示「该主机不支持」）。
- 目录上传/下载都支持递归，但下载不保留 mtime 与权限位（上传走 `fastPut` 会保留）。
- 内置编辑器只认 UTF-8（含 BOM）和带 BOM 的 UTF-16。**无 BOM 的 UTF-16、GBK/GB18030
  （中文 Windows 的「ANSI」）不支持**：前者的字节分布和二进制没法可靠区分，后者要引入
  编码转换库。这类文件请在服务器上用 `iconv -f GBK -t UTF-8` 转一下再编辑。
- 剪贴板不支持多选（列表本身就是单选）；重复粘贴到同一目录会被拒绝，不会自动生成「副本」命名。
- 内置编辑器上限 **20MB**（超过 3MB 会提示"可能有点卡"但不拦）。再大的文本请下载后用专门的工具看 ——
  编辑器要把整份内容解成字符串放进窗口，几百 MB 会直接把界面拖死。
  **日志（`.log` / `.out` / `messages` 等）不受这条限制**：它们双击走的是只读日志查看器，
  只从文件末尾往回读几十 KB，几百 MB 也一样秒开；代价是看不到末尾之外的内容（要看全份就下载）。
- 日志只看末尾，**不显示行号** —— 加载的只是最后 N 行，行号从 1 数会让人误以为是文件里的真实行号
  （第 477 行其实是第 9977 行）。时间戳本身就是日志的坐标。
- PDF 预览没有配置 `cMapUrl` / `standardFontDataUrl`：绝大多数 PDF（Word/WPS 导出、扫描件）字体
  都是内嵌的，不受影响；少数"中文未内嵌、依赖 Adobe CMaps"的老 PDF 可能出现方框，
  遇到时下载到本地用系统阅读器打开即可（为它把 4MB 字体/CMap 打进安装包不划算）。
- 传输记录只留最近 **200 条**（超出的丢最旧的），且**只记本地发起的文件传输** ——
  远程到远程的复制/移动走的是服务端 `cp`/`mv`，不经过传输通道，也就没有记录。
- 图片预览走浏览器解码，认 PNG / JPEG / GIF / WebP / BMP / ICO / SVG / AVIF。
  **HEIC（iPhone 照片）、RAW、PSD** 解不了，双击会交给系统程序打开（它们照样有自己的图标）。
- 权限/属主列只对远程列表有意义：本地是 Windows，没有 POSIX 权限位，所以左栏不加这两列。
- **用 root 登录时权限列永远不会标红**（root 不受权限位约束，`r--r--r--` 也照样能写）。
  这不是 bug —— 标红是给"需要 sudo 才能改"的普通用户看的。
- 密码认证依赖服务器开放 `password` 方式，纯密钥登录的机器请选「私钥」。
- `ssh2` 的可选原生加密绑定（`cpu-features`）在缺少 VS Build Tools 的 Windows 上会编译失败，
  自动回退纯 JS 实现，功能不受影响，仅加解密略慢。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| 双击侧栏服务器 | 建立连接 |
| `Ctrl + B` | 收起 / 展开侧边栏 |
| `Ctrl + F` | 终端内查找 |
| `Ctrl + Shift + C` | 复制选中内容 |
| `Ctrl + Shift + V` | 粘贴 |
| `F5` | 刷新焦点所在的那一栏（本地 / 远程） |
| `Ctrl + C` / `Ctrl + X` | 复制 / 剪切选中项 |
| `Ctrl + V` | 粘贴到当前栏的目录 |
| `F2` | 重命名选中项 |
| `Delete` | 删除选中项（本地走回收站，远程直接删） |
| `F12` / `Ctrl + Shift + I` | 开关开发者工具（原生菜单已摘掉，这两个键在 `before-input-event` 里接管） |
| 右键 | 文件 / 目录 / 空白处各有对应菜单 |
