<script setup lang="ts">
import { computed } from 'vue'
import { Plus, Connection, FolderOpened, Odometer } from '@element-plus/icons-vue'
import { useAppStore } from '../stores/app'
import LogoMark from './LogoMark.vue'

const emit = defineEmits<{ (e: 'new-server'): void }>()
const store = useAppStore()

const recent = computed(() =>
  [...store.config.servers]
    .filter((s) => s.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .slice(0, 4)
)

const features = [
  { icon: Connection, title: 'SSH 终端', desc: '多会话标签 · 256 色' },
  { icon: FolderOpened, title: 'SFTP 文件', desc: '双栏管理 · 上传下载' },
  { icon: Odometer, title: '实时监控', desc: 'CPU / 内存 / 网络' }
]
</script>

<template>
  <div class="welcome">
    <div class="inner">
      <div class="hero">
        <div class="mark"><LogoMark /></div>
        <h1>ThShell</h1>
        <p class="tagline">一个安静的 SSH 工作台 —— 连上，然后专心干活</p>
      </div>

      <div class="features">
        <div v-for="item in features" :key="item.title" class="feature">
          <el-icon class="f-icon"><component :is="item.icon" /></el-icon>
          <div>
            <div class="f-title">{{ item.title }}</div>
            <div class="f-desc">{{ item.desc }}</div>
          </div>
        </div>
      </div>

      <div v-if="recent.length" class="recent">
        <div class="recent-title">最近连接</div>
        <div class="recent-list">
          <button
            v-for="server in recent"
            :key="server.id"
            class="recent-item"
            @click="store.openServer(server)"
          >
            <span class="dot" :style="{ background: server.color || '#2dd4bf' }" />
            <span class="r-name truncate">{{ server.name }}</span>
            <span class="r-host mono truncate">{{ server.host }}</span>
          </button>
        </div>
      </div>

      <el-button type="primary" size="large" :icon="Plus" class="cta" @click="emit('new-server')">
        新建连接
      </el-button>

      <div class="tips">
        <span><kbd>双击</kbd> 侧栏服务器建立连接</span>
        <span><kbd>Ctrl</kbd> + <kbd>F</kbd> 在终端中查找</span>
        <span><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd> 粘贴</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  overflow-y: auto;
  background:
    radial-gradient(600px 320px at 50% 0%, rgba(45, 212, 191, 0.07), transparent 70%),
    var(--bg-base);
}

.inner {
  width: 100%;
  max-width: 560px;
  padding: 40px 24px;
  text-align: center;
}

.hero {
  margin-bottom: 34px;
}

.mark {
  width: 58px;
  height: 58px;
  margin: 0 auto 16px;
  filter: drop-shadow(0 10px 30px rgba(45, 212, 191, 0.28));
}

h1 {
  margin: 0 0 8px;
  font-size: 25px;
  font-weight: 650;
  letter-spacing: 0.5px;
  color: var(--text-1);
}

.tagline {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
}

.features {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 28px;
  text-align: left;
}

.feature {
  display: flex;
  gap: 10px;
  padding: 12px;
  border-radius: var(--radius);
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
}

.f-icon {
  font-size: 15px;
  color: var(--accent);
  margin-top: 1px;
}

.f-title {
  font-size: 12px;
  color: var(--text-1);
  margin-bottom: 3px;
}

.f-desc {
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-3);
}

.recent {
  margin-bottom: 24px;
  text-align: left;
}

.recent-title {
  font-size: 10.5px;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 8px;
}

.recent-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border-radius: 7px;
  border: 1px solid var(--border-soft);
  background: var(--bg-panel);
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  transition: all 0.12s;
}

.recent-item:hover {
  border-color: var(--accent-line);
  background: var(--bg-panel-2);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.r-name {
  font-size: 12px;
  color: var(--text-1);
  flex: 1;
  min-width: 0;
}

.r-host {
  font-size: 10px;
  color: var(--text-3);
  max-width: 96px;
}

.cta {
  width: 190px;
}

.tips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px 16px;
  margin-top: 30px;
  font-size: 10.5px;
  color: var(--text-3);
}

kbd {
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-2);
}
</style>
