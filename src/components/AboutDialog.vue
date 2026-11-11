<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AppInfo } from '../../electron/types'
import LogoMark from './LogoMark.vue'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const info = ref<AppInfo | null>(null)

const PLATFORM_TEXT: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux'
}

const platformText = computed(() => {
  const i = info.value
  if (!i) return '—'
  const name = PLATFORM_TEXT[i.platform] ?? i.platform
  return `${name} · ${i.arch}`
})

/** 版本号每次打开拉一次：主进程升级后不用重启界面也能看对 */
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    try {
      info.value = await window.api.app.info()
    } catch {
      info.value = null
    }
  }
)
</script>

<template>
  <el-dialog v-model="visible" title="关于 ThShell" width="440px">
    <div class="about">
      <div class="head">
        <div class="logo"><LogoMark /></div>
        <div class="titles">
          <div class="name">
            ThShell
            <span class="ver mono">v{{ info?.version ?? '—' }}</span>
          </div>
          <div class="desc">SSH / SFTP 远程终端与文件管理</div>
        </div>
      </div>

      <div class="rows">
        <div class="row">
          <span class="k">Electron</span>
          <span class="v mono">{{ info?.electron ?? '—' }}</span>
        </div>
        <div class="row">
          <span class="k">Chromium</span>
          <span class="v mono">{{ info?.chrome ?? '—' }}</span>
        </div>
        <div class="row">
          <span class="k">Node</span>
          <span class="v mono">{{ info?.node ?? '—' }}</span>
        </div>
        <div class="row">
          <span class="k">运行平台</span>
          <span class="v mono">{{ platformText }}</span>
        </div>
      </div>

      <p class="note">
        会话、密钥与密码全部留在本机，除你配置的服务器外不连接任何第三方服务。
      </p>

      <div class="foot">© 2026 张萌</div>
    </div>
  </el-dialog>
</template>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.logo {
  width: 52px;
  height: 52px;
  flex: none;
  filter: drop-shadow(0 6px 16px rgba(45, 212, 191, 0.28));
}

.titles {
  min-width: 0;
}

.name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 17px;
  font-weight: 650;
  color: var(--text-1);
}

.ver {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text-3);
}

.desc {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-2);
}

.rows {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-panel-2);
}

.row {
  display: flex;
  align-items: center;
  padding: 7px 12px;
  font-size: 11.5px;
}

.row + .row {
  border-top: 1px solid var(--border-soft);
}

.k {
  width: 82px;
  flex: none;
  color: var(--text-3);
}

.v {
  color: var(--text-1);
}

.note {
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-3);
}

.foot {
  padding-top: 2px;
  font-size: 10.5px;
  color: var(--text-3);
  text-align: right;
}
</style>
