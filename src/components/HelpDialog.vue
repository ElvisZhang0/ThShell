<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

/** 快捷键表：和 README 里那张表保持一致，改一处记得改另一处 */
const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl + B', '收起 / 展开侧边栏'],
  ['Ctrl + F', '终端内查找'],
  ['Ctrl + Shift + C / V', '终端里复制 / 粘贴'],
  ['F5', '刷新焦点所在的那一栏（本地 / 远程）'],
  ['F2', '重命名选中项'],
  ['Delete', '删除选中项（本地进回收站，远程直接删）'],
  ['F12', '开关开发者工具']
]
</script>

<template>
  <el-dialog v-model="visible" title="使用说明" width="640px" class="help-dialog">
    <div class="help">
      <section>
        <h4>1 · 连接服务器</h4>
        <p>
          侧栏底部「新建连接」或标题栏的同名按钮都可以加服务器。填好主机、端口、用户名，
          认证方式选密码或私钥。加完<strong>双击侧栏那一行</strong>就连接，每个连接是一个标签页。
        </p>
      </section>

      <section>
        <h4>2 · 终端</h4>
        <p>
          终端上方有一排常用命令，点一下直接执行；虚线边框的那几条带参数，点了只写进提示符、不回车，
          改完参数自己按回车。其余命令在「更多」浮层里分组，鼠标悬停有说明。
        </p>
      </section>

      <section>
        <h4>3 · 文件管理</h4>
        <p>
          左栏本地、右栏远程。双击目录进入，双击文件按类型分流：
          <strong>文本</strong>进编辑器（Ctrl+S 保存）、<strong>图片 / PDF / Office</strong>进预览、
          <strong>日志</strong>进只读查看器（默认实时读最后 200 行，行数可调）。
          右键菜单里还有上传、下载、复制路径、重命名、删除、属性。
        </p>
        <p>
          远程列表的「权限」列是 POSIX 权限位。<span class="warn">标红</span>表示当前 SSH 用户对该条目
          没有写权限。用 root 登录时不会标红 —— root 不受权限位约束，标了反而误导。
        </p>
      </section>

      <section>
        <h4>4 · 传输与状态</h4>
        <p>
          上传下载的进度和<strong>历史记录</strong>在底部面板，记录里写了「从哪个目录到哪个目录」，
          默认收起，收起时也能看到当前进度。状态栏显示当前会话的 CPU / 内存 / 网速，点开还有系统信息和 Docker 面板。
        </p>
      </section>

      <section>
        <h4>5 · 弹窗</h4>
        <p>
          编辑器、查看器、预览的标题栏右上角有<strong>最小化 / 最大化 / 关闭</strong>，
          双击标题栏也能最大化。最小化只是收成右下角一条，正文没有卸载，
          未保存的内容、已经翻到的页码都还在，点一下那条就展开。
        </p>
      </section>

      <section>
        <h4>6 · 检查更新</h4>
        <p>
          「关于 → 检查更新」会去更新源比对版本。有新版本时可以看到更新说明、下载（带进度和速度），
          下载完点「安装」拉起安装包 —— Windows 上是真正的一键安装，Linux 的 deb/rpm 会给出安装命令。
          启动时也会静默查一次，有新版只在「关于」按钮上点一个小圆点，不弹窗打断你。
        </p>
        <p>
          更新源默认指向 <strong>GitHub Releases</strong>（<code class="mono">releases/latest/download/latest.json</code>），
          不用自己搭服务器。想换的话在 <strong>配置 → 更新源</strong> 里改：内网机器可以指向共享盘或自己的静态目录。
          那一格清空就不检查更新 —— 内网不联网也能正常用。
        </p>
      </section>

      <section>
        <h4>7 · 快捷键</h4>
        <table class="keys">
          <tbody>
            <tr v-for="[key, desc] in SHORTCUTS" :key="key">
              <td class="k mono">{{ key }}</td>
              <td class="d">{{ desc }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </el-dialog>
</template>

<style scoped>
.help {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 62vh;
  overflow-y: auto;
  padding-right: 4px;
}

section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}

p {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.85;
  color: var(--text-2);
}

strong {
  color: var(--text-1);
  font-weight: 600;
}

.warn {
  color: var(--danger);
}

.keys {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.keys tr + tr td {
  border-top: 1px solid var(--border-soft);
}

.keys td {
  padding: 6px 10px;
  font-size: 11.5px;
}

.k {
  width: 168px;
  color: var(--text-1);
  background: var(--bg-panel-2);
}

.d {
  color: var(--text-2);
}
</style>
