/**
 * Vite 资源后缀的类型声明。
 * tsconfig.web.json 里没有引 vite/client，所以 `?raw` 这类导入要自己补一份，
 * 否则 vue-tsc 会报 "找不到模块"。
 */
declare module '*?raw' {
  const content: string
  export default content
}

declare module '*?url' {
  const url: string
  export default url
}
