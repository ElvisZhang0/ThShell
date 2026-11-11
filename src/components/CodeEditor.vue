<script setup lang="ts">
/**
 * 内置代码编辑器 —— CodeMirror 6 的薄封装。
 *
 * 为什么是 CodeMirror 而不是 Monaco：
 * - Monaco 打进来 5MB+，还要单独起 worker、单独引 CSS，Electron 里配起来一堆副作用；
 *   CodeMirror 6 是模块化的，用到的语言包才进包，这里只多 ~300KB。
 * - 两者的「能看懂代码」能力对运维改配置文件足够：行号、折叠、括号匹配、
 *   语法高亮、Ctrl+F 搜索、多光标、自动缩进，CM6 全都有。
 *
 * 主题跟着 <html data-theme> 走：用 Compartment 热替换，不重建编辑器，
 * 所以切主题时光标位置、撤销历史都还在。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, Compartment } from '@codemirror/state'
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
  lineNumbers as cmLineNumbers,
  type ViewUpdate
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  defaultHighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  StreamLanguage,
  type LanguageSupport
} from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { oneDark, oneDarkHighlightStyle } from '@codemirror/theme-one-dark'

/* 语言包按需引入：都在这里静态 import，Vite 会做 tree-shake，没用到的不会进包 */
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { markdown } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { xml } from '@codemirror/lang-xml'

/* 小众语言没有官方包，用 legacy-modes 里的流式解析器顶上 */
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'

const props = defineProps<{
  modelValue: string
  /** 用来判断语言：只认文件名，不读内容（按内容猜会猜错） */
  filename?: string
  readonly?: boolean
  /**
   * 要不要行号。日志查看器会关掉 —— 它显示的只是"末尾 N 行"，
   * 行号从 1 开始数会让人以为那是文件里的真实行号（第 477 行其实是第 9977 行），
   * 而日志的时间戳本身就是坐标，行号在这里只帮倒忙。
   * 只在建编辑器时读一次，不做热切换（两个用处各开一个实例，不需要）。
   */
  lineNumbers?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'save'): void
}>()

const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
let observer: MutationObserver | null = null

/** 语言和主题都要能热替换，各占一个 compartment */
const langComp = new Compartment()
const themeComp = new Compartment()
/** 只读状态也要能热替换：无写权限的文件是"进来时才知道只读"，不能靠重建编辑器 */
const readonlyComp = new Compartment()

function languageFor(name = ''): LanguageSupport | null {
  const file = name.toLowerCase()
  const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1) : ''
  // 无扩展名的配置文件靠文件名认（.bashrc / Dockerfile / nginx.conf 这类）
  const base = file.split('/').pop() ?? file

  if (base === 'dockerfile' || base.startsWith('dockerfile.') || ext === 'dockerfile') {
    return StreamLanguage.define(dockerFile) as unknown as LanguageSupport
  }
  if (base.includes('nginx')) return StreamLanguage.define(nginx) as unknown as LanguageSupport
  if (base === '.bashrc' || base === '.bash_profile' || base === '.profile' || base === '.zshrc') {
    return StreamLanguage.define(shell) as unknown as LanguageSupport
  }

  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return javascript({ jsx: true })
    case 'ts':
    case 'tsx':
      return javascript({ jsx: ext === 'tsx', typescript: true })
    case 'json':
    case 'jsonc':
    case 'json5':
      return json()
    case 'py':
      return python()
    case 'sql':
      return sql()
    case 'md':
    case 'markdown':
      return markdown()
    case 'yml':
    case 'yaml':
      return yaml()
    case 'xml':
    case 'html':
    case 'htm':
    case 'svg':
      return xml()
    case 'sh':
    case 'bash':
    case 'zsh':
      return StreamLanguage.define(shell) as unknown as LanguageSupport
    case 'ini':
    case 'conf':
    case 'cnf':
    case 'properties':
    case 'env':
    case 'toml':
      return StreamLanguage.define(properties) as unknown as LanguageSupport
    default:
      // 认不出来就当纯文本 —— 错误的高亮比没有高亮更碍事
      return null
  }
}

/** 深色：oneDark 打底，只把背景换成应用自己的 #0d1118，免得弹窗里一块不一样的灰 */
const darkTheme = [
  oneDark,
  EditorView.theme(
    {
      '&': { backgroundColor: 'transparent', color: '#dbe4f0' },
      '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: '#5b6779' },
      '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,.035)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#9fb0c6' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: 'rgba(45,212,191,.22) !important'
      },
      '.cm-cursor': { borderLeftColor: '#5eead4' }
    },
    { dark: true }
  )
]

/** 浅色：跟应用浅色变量同一套色，不用 oneDark 的反色 */
const lightTheme = [
  EditorView.theme(
    {
      '&': { backgroundColor: 'transparent', color: '#1f2937' },
      '.cm-content': { caretColor: '#0f766e' },
      '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: '#9aa6b6' },
      '.cm-activeLine': { backgroundColor: 'rgba(13,148,136,.05)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#0f766e' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: 'rgba(13,148,136,.18) !important'
      },
      '.cm-cursor': { borderLeftColor: '#0f766e' }
    },
    { dark: false }
  ),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true })
]

function currentTheme(): typeof darkTheme {
  return document.documentElement.dataset.theme === 'light' ? lightTheme : darkTheme
}

/** 只读 = 既不能改内容（readOnly）也点不出光标（editable），两个都得设 */
function readonlyExt(readonly: boolean) {
  return [EditorState.readOnly.of(!!readonly), EditorView.editable.of(!readonly)]
}

function build(): void {
  if (!host.value) return
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      // basicSetup 的等价物（用到的都列出来，方便看清到底开了什么）
      props.lineNumbers === false ? [] : cmLineNumbers(),
      EditorView.lineWrapping, // 长行折行；日志类单行几万字符不会横向跑飞
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            emit('save')
            return true
          }
        }
      ]),
      readonlyComp.of(readonlyExt(props.readonly)),
      langComp.of(languageFor(props.filename) ?? []),
      themeComp.of(currentTheme()),
      EditorView.updateListener.of((u: ViewUpdate) => {
        if (u.docChanged) emit('update:modelValue', u.state.doc.toString())
      })
    ]
  })
  view = new EditorView({ state, parent: host.value })
}

onMounted(() => {
  build()
  // 主题是隔壁 store 直接改 <html data-theme>，这里只能监听属性变化跟着换
  observer = new MutationObserver(() => {
    view?.dispatch({ effects: themeComp.reconfigure(currentTheme()) })
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})

onBeforeUnmount(() => {
  observer?.disconnect()
  view?.destroy()
  view = null
})

// 换文件时整体替换内容（对话框复用的同一个实例）
watch(
  () => props.modelValue,
  (next) => {
    if (!view) return
    const now = view.state.doc.toString()
    if (next === now) return
    view.dispatch({ changes: { from: 0, to: now.length, insert: next } })
  }
)

// 同一对话框里换了文件名（文件管理器没这么做，但留着更安全）
watch(
  () => props.filename,
  (name) => {
    view?.dispatch({ effects: langComp.reconfigure(languageFor(name) ?? []) })
  }
)

// 只读是"读完才知道"的：先开弹窗再探测权限，所以这里必须支持热切换，
// 否则无写权限的文件一进来还能编辑（Enter 一按就改了缓冲，只是保存会失败）
watch(
  () => props.readonly,
  (readonly) => {
    view?.dispatch({ effects: readonlyComp.reconfigure(readonlyExt(!!readonly)) })
  }
)

defineExpose({
  /** 让父组件能主动聚焦（打开弹窗即光标就位） */
  focus: () => view?.focus(),
  /**
   * 滚到底部。日志查看器用：打开就该停在最新一行，而不是文件的开头 ——
   * 看日志的人关心的永远是"刚才发生了什么"。
   *
   * 用 `scrollIntoView` 这个 effect 而不是直接改 `scrollDOM.scrollTop`：
   * 后者写完会被 CodeMirror 的下一次 measure 覆盖（打开弹窗时布局还没稳定，
   * 出现过"滚了等于没滚、停在第 20 行"）。effect 会被 CM 排队到测量之后执行，稳。
   * 只滚动、不动选区 —— 选到文末会让整屏出现一片淡青色，像出了错。
   */
  scrollToEnd: () => {
    if (!view) return
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.length, { y: 'end' }) })
  }
})
</script>

<template>
  <div ref="host" class="cm-host" />
</template>

<style scoped>
.cm-host {
  height: 100%;
  overflow: hidden;
  font-size: 12.5px;
}

/* CodeMirror 自己带面板（搜索框）样式，这里只把字体对到应用的等宽字体栈 */
.cm-host :deep(.cm-editor) {
  height: 100%;
}

.cm-host :deep(.cm-scroller) {
  font-family: var(--font-mono, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace);
  line-height: 1.55;
}

.cm-host :deep(.cm-editor.cm-focused) {
  outline: none;
}

/* Ctrl+F 搜索面板：默认是亮白底，跟深色主题打架 */
.cm-host :deep(.cm-panels) {
  background: var(--bg-panel, #161c26);
  color: var(--text-1, #dbe4f0);
}

.cm-host :deep(.cm-panel.cm-search input),
.cm-host :deep(.cm-panel.cm-search button) {
  background: var(--bg-base, #0d1118);
  color: var(--text-1, #dbe4f0);
  border: 1px solid var(--border, #232c39);
  border-radius: 4px;
}
</style>
