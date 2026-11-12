/**
 * 跨进程传对象前必须解包。
 *
 * Pinia 的 state / 模块级 `reactive` 都是响应式 Proxy，contextBridge 在把参数
 * 送过边界时走结构化克隆，而 Proxy 不可克隆 —— 抛出来的是
 * "An object could not be cloned"，在界面上长得像「下载失败」「连接失败」，
 * 排查时极容易怀疑到网络、认证、文件权限头上，其实跟那些毫无关系。
 *
 * 这里用 JSON 深拷贝而不是 structuredClone：后者对 Proxy 同样抛 DataCloneError。
 * 走这条路的都是纯 JSON 结构（连接配置、更新描述），不涉及 Date / Map，
 * 深拷贝不会丢信息。
 *
 * 判断标准很简单：参数来源只要沾了 `reactive(...)` 或某个 store 的 state，
 * 传出去之前就套一层 plain()。
 */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
