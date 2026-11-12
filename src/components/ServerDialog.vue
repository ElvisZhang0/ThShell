<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { FolderOpened, Key, Lock, Plus, Promotion } from '@element-plus/icons-vue'
import { useAppStore, cleanError } from '../stores/app'
import { plain } from '../utils/plain'
import type { AuthType, ServerConfig } from '../../electron/types'

const props = defineProps<{
  modelValue: boolean
  serverId: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
}>()

const store = useAppStore()
const formRef = ref<FormInstance>()
const testing = ref(false)

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const isEdit = computed(() => !!props.serverId)

const presetColors = ['#2dd4bf', '#38bdf8', '#a78bfa', '#fbbf24', '#f87171', '#34d399', '#94a3b8']

const form = reactive<ServerConfig>({
  id: '',
  name: '',
  host: '',
  port: 22,
  username: 'root',
  authType: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  groupId: 'default',
  color: '#2dd4bf',
  note: '',
  createdAt: 0
})

const rules: FormRules = {
  name: [{ required: true, message: '给连接起个名字，方便识别', trigger: 'blur' }],
  host: [{ required: true, message: '填写服务器 IP 或域名', trigger: 'blur' }],
  username: [{ required: true, message: '填写登录用户名', trigger: 'blur' }],
  port: [
    {
      validator: (_r, value, cb) => {
        const port = Number(value)
        if (!port || port < 1 || port > 65535) cb(new Error('端口范围 1-65535'))
        else cb()
      },
      trigger: 'blur'
    }
  ]
}

/**
 * 编辑时磁盘上已经存着的密码 / 私钥口令。
 *
 * 表单里这两个框**不回填**：屏幕上摆一串明文没必要，而且"留空 = 不修改"
 * 这层语义比"看到是什么"更有用。它们在这里只负责一件事 ——
 * 用户没动密码框时，保存/测试要把原值带上，不能拿空串把它顶掉。
 */
const keptPassword = ref('')
const keptPassphrase = ref('')

function resetForm() {
  const source = props.serverId ? store.serverById(props.serverId) : undefined
  if (source) {
    /*
     * ⚠️ 这里绝对不能写 structuredClone(source)。
     *
     * source 是 Pinia state 里的对象，也就是响应式 **Proxy**，结构化克隆遇到
     * Proxy 直接抛 DataCloneError，resetForm 当场中断 —— 表单一个字段都填不上，
     * 表现就是「编辑连接没有回显」，而且不报错弹窗、只在控制台留一行。
     * （这个 bug 真实存在过，绕了好一圈才在控制台里看见。）
     */
    const s = plain(source)
    keptPassword.value = s.password ?? ''
    keptPassphrase.value = s.passphrase ?? ''
    Object.assign(form, { ...s, password: '', passphrase: '' })
  } else {
    keptPassword.value = ''
    keptPassphrase.value = ''
    Object.assign(form, {
      id: '',
      name: '',
      host: '',
      port: 22,
      username: 'root',
      authType: 'password' as AuthType,
      password: '',
      privateKey: '',
      passphrase: '',
      groupId: store.config.groups[0]?.id ?? 'default',
      color: '#2dd4bf',
      note: '',
      createdAt: 0
    })
  }
  formRef.value?.clearValidate()
}

// 同时盯 serverId：对话框已经开着时再切一台（少见，但脚本/快捷键能触发），
// 只监听 modelValue 的话它一直是 true，不会重置表单，界面上就会停在上一台的数据
watch(
  () => [props.modelValue, props.serverId] as const,
  ([open]) => {
    if (open) resetForm()
  }
)

async function pickKeyFile() {
  try {
    const files = await window.api.dialog.pickFiles()
    if (!files.length) return
    const key = await window.api.local.readFile(files[0])
    form.privateKey = key.content
    ElMessage.success('私钥已载入')
  } catch (err) {
    ElMessage.error('读取私钥失败：' + cleanError(err))
  }
}

async function newGroup() {
  try {
    const { value } = await ElMessageBox.prompt('分组名称', '新建分组', {
      inputValidator: (v) => (v?.trim() ? true : '名称不能为空')
    })
    const id = store.addGroup(value.trim())
    form.groupId = id
  } catch {
    /* 取消 */
  }
}

async function testConnection() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  testing.value = true
  try {
    // 表单是 reactive 对象，跨 IPC 前必须转成普通对象，
    // 否则会报 "An object could not be cloned"
    const payload = plain({
      ...form,
      id: form.id || 'temp-test',
      // 密码框留空时用已保存的那个，否则"测试连接"会因为空密码而认证失败
      password: form.password || keptPassword.value,
      passphrase: form.passphrase || keptPassphrase.value
    })
    const sessionId = await window.api.ssh.connect(payload, 80, 24)
    await window.api.ssh.disconnect(sessionId)
    ElMessage.success('连接成功，认证通过')
  } catch (err) {
    ElMessage.error(cleanError(err))
  } finally {
    testing.value = false
  }
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  const payload: ServerConfig = {
    ...form,
    // 留空 = 沿用原密码，直接提交空串会把已经存好的密码清掉
    password: form.password || keptPassword.value,
    passphrase: form.passphrase || keptPassphrase.value,
    name: form.name.trim(),
    host: form.host.trim(),
    username: form.username.trim(),
    port: Number(form.port) || 22,
    id: form.id || `srv-${Date.now()}`,
    createdAt: form.createdAt || Date.now()
  }
  store.upsertServer(payload)
  ElMessage.success(isEdit.value ? '配置已更新' : '连接已创建')
  visible.value = false
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="isEdit ? '编辑连接' : '新建连接'"
    width="620px"
    top="7vh"
    destroy-on-close
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="86px" label-position="right">
      <div class="row-2">
        <el-form-item label="连接名称" prop="name">
          <el-input v-model="form.name" placeholder="如：阿里云 ECS 生产" />
        </el-form-item>
        <el-form-item label="分组">
          <div class="group-row">
            <el-select v-model="form.groupId" style="flex: 1">
              <el-option
                v-for="group in store.config.groups"
                :key="group.id"
                :label="group.name"
                :value="group.id"
              />
            </el-select>
            <el-button :icon="Plus" circle size="small" @click="newGroup" />
          </div>
        </el-form-item>
      </div>

      <div class="row-3">
        <el-form-item label="主机地址" prop="host">
          <el-input v-model="form.host" placeholder="47.92.120.0" />
        </el-form-item>
        <el-form-item label="端口" prop="port">
          <el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" style="width: 100%" />
        </el-form-item>
      </div>

      <el-form-item label="用户名" prop="username">
        <el-input v-model="form.username" placeholder="root" />
      </el-form-item>

      <el-form-item label="认证方式">
        <el-radio-group v-model="form.authType">
          <el-radio-button value="password">
            <el-icon><Lock /></el-icon> 密码
          </el-radio-button>
          <el-radio-button value="key">
            <el-icon><Key /></el-icon> 私钥
          </el-radio-button>
        </el-radio-group>
      </el-form-item>

      <template v-if="form.authType === 'password'">
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            :placeholder="isEdit && keptPassword ? '已保存（留空则不修改）' : '登录密码（本地加密保存）'"
          />
        </el-form-item>
      </template>

      <template v-else>
        <el-form-item label="私钥内容">
          <div class="key-box">
            <el-input
              v-model="form.privateKey"
              type="textarea"
              :rows="5"
              placeholder="粘贴 OpenSSH 私钥内容（-----BEGIN OPENSSH PRIVATE KEY-----）"
              class="mono"
            />
            <el-button :icon="FolderOpened" size="small" @click="pickKeyFile">
              从文件读取
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="私钥口令">
          <el-input
            v-model="form.passphrase"
            type="password"
            show-password
            :placeholder="isEdit && keptPassphrase ? '已保存（留空则不修改）' : '私钥无口令可留空'"
          />
        </el-form-item>
      </template>

      <el-form-item label="标签色">
        <div class="colors">
          <span
            v-for="color in presetColors"
            :key="color"
            class="swatch"
            :class="{ active: form.color === color }"
            :style="{ background: color }"
            @click="form.color = color"
          />
        </div>
      </el-form-item>

      <el-form-item label="备注">
        <el-input v-model="form.note" type="textarea" :rows="2" placeholder="用途、负责人等" />
      </el-form-item>
    </el-form>

    <template #footer>
      <div class="footer">
        <el-button :icon="Promotion" :loading="testing" @click="testConnection">测试连接</el-button>
        <div class="grow" />
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="submit">{{ isEdit ? '保存' : '创建' }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}

.row-3 {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 0 12px;
}

.group-row {
  display: flex;
  gap: 6px;
  width: 100%;
}

.key-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.key-box :deep(textarea) {
  font-family: var(--font-mono);
  font-size: 11px;
}

.colors {
  display: flex;
  gap: 9px;
  align-items: center;
}

.swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
  transition: transform 0.12s;
}

.swatch:hover {
  transform: scale(1.15);
}

.swatch.active {
  border-color: var(--text-1);
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.08);
}

.footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.grow {
  flex: 1;
}

:deep(.el-radio-button__inner) {
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
