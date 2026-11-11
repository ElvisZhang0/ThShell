/**
 * markdown → HTML，给编辑器右侧的实时预览用。
 *
 * 两个关键决定：
 * 1. 用 markdown-it 而不是自己写正则：表格、嵌套列表、代码块围栏、行内 HTML
 *    这些边界条件自己写必踩坑，markdown-it 是 CommonMark 标准实现里最贴 Vue 生态的一个。
 * 2. 渲染结果必须过 DOMPurify：这里渲染的是服务器上的文件内容，可能是别人提交的
 *    README。`html: true` 允许内联 HTML（md 里写 <br>、<kbd> 很常见），
 *    也就等于允许 <img onerror=...>，必须在插入 DOM 前洗一遍。
 */
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({
  // 允许内联 HTML：md 文档里手写 <br> / <details> / <kbd> 太常见，禁掉反而不像预览
  html: true,
  // 裸链接自动成链：日志里贴的 URL 点得动
  linkify: true,
  // 不用 breaks：GitHub 的软换行规则会让从 Word 复制的长段落碎成一行行
  breaks: false
})

/**
 * 外链处理。
 * Electron 里点 <a href> 默认会在当前窗口导航走 —— file:// 页面被目标页面顶掉，
 * 表现就是"点了个链接，整个应用变成网页"。统一加 target=_blank 交给系统处理。
 */
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

/** md 源码 → 可安全插入 v-html 的 HTML 字符串 */
export function renderMarkdown(source: string): string {
  const html = md.render(source)
  return DOMPurify.sanitize(html, {
    // target / rel 是上面 link_open 加的，不加进白名单会被洗掉
    ADD_ATTR: ['target', 'rel'],
    // 只保留 HTML 配置：SVG/MathML 相关的放开面太大，预览用不着
    USE_PROFILES: { html: true }
  })
}
