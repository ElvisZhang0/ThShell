import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import App from './App.vue'
import { useAppStore } from './stores/app'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')

/**
 * 冒烟测试专用后门：只在 ?smoke=1 时挂上 store。
 * 页签这类逻辑用真实连接去铺数据太慢（每台要一次 SSH 握手，连不上还要等超时），
 * 而单元测试又覆盖不到"右键菜单落到 DOM 上是什么样"。冒烟脚本直接 push 假页签最省事。
 * 正式启动不会带这个参数，生产环境等于没有这段代码。
 */
if (new URLSearchParams(location.search).has('smoke')) {
  ;(window as unknown as { __store: unknown }).__store = useAppStore(pinia)
}
