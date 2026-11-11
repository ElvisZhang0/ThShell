import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 用 .mts 后缀是为了让 Vite 以 ESM 方式加载配置。
 *
 * 项目里 package.json 不能加 "type": "module" —— 主进程产物 main.js 必须是 CommonJS，
 * 一旦整个包声明成 ESM，Electron 会用 ESM 解析主进程入口直接崩。
 * 所以只能靠文件扩展名单独把配置文件标成 ESM，以此消掉
 * "The CJS build of Vite's Node API is deprecated" 这条警告。
 */
const projectRoot = import.meta.dirname

// 每次启动清掉上一次的主进程产物，避免旧代码残留
try {
  rmSync(resolve(projectRoot, 'dist-electron'), { recursive: true, force: true })
} catch {
  /* 首次运行目录不存在，忽略 */
}

export default defineConfig({
  plugins: [
    vue(),
    electron({
      main: {
        entry: 'electron/main.ts',
        onstart(args) {
          // 一些 IDE / 终端工具链会在父进程里注入 ELECTRON_RUN_AS_NODE=1。
          // Electron 读到它会退化成纯 Node 进程：窗口不出现，而且通常一条日志都不打，
          // 排查时毫无线索。子进程 spawn 时会继承当前环境，所以这里必须清掉。
          if (process.env.ELECTRON_RUN_AS_NODE) {
            delete process.env.ELECTRON_RUN_AS_NODE
            console.log('\n[electron] 已清除继承来的 ELECTRON_RUN_AS_NODE（否则窗口不会出现）')
          }
          console.log('[electron] 启动主进程…')
          args.startup()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            minify: false,
            // ssh2 / cpu-features 是原生/可选原生模块，必须保持 require，不能被打包
            rollupOptions: {
              external: ['ssh2', 'cpu-features', 'electron'],
              output: {
                format: 'cjs',
                entryFileNames: 'main.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            minify: false,
            rollupOptions: {
              external: ['electron'],
              // 强制 cjs：Electron 的 sandbox preload 只认 CommonJS，
              // 若被输出成 .mjs 会直接白屏
              output: {
                format: 'cjs',
                entryFileNames: 'preload.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      }
    })
  ],
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src')
    }
  },
  server: {
    port: 5180,
    strictPort: false
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000
  }
})
