/**
 * 平台动作桥（HarmonyOS 移植新增）
 *
 * 背景：上游 server 模式没有 `command:revealInFolder` / `command:openTaskFile`
 * 的服务端实现（Electron 版走主进程），而 `hasHostFileActions()` 在 web 上也恒为 false，
 * 于是任务菜单里「在文件夹中显示 / 打开文件」**连菜单项都不出现**。
 *
 * 做法：渲染层把动作编码成 `motrix-action://<verb>?<query>`，通过隐藏 iframe 触发一次
 * 导航；ArkTS 壳的 `onLoadIntercept` 拦截这个私有 scheme 并调用系统 want。
 * 这样不需要改 server，也不需要给 Web 增加任何新协议注册。
 */
const SCHEME = 'motrix-action://'

/** 本运行时是否支持宿主文件动作（决定菜单项是否显示） */
export function supportsHostFileActions(): boolean {
  // HarmonyOS 壳注入了平台值，说明有原生宿主可以接动作
  const platform = (globalThis as { __MOTRIX_PLATFORM__?: unknown })
    .__MOTRIX_PLATFORM__
  return platform !== undefined && platform !== null
}

/**
 * 是否运行在 **HarmonyOS 原生壳** 里（而不是普通浏览器打开 web UI）。
 *
 * 用途：把「平台能力不可用」的入口收起来 —— 插件系统（--jitless 下无 WebAssembly）、
 * 集成卡片（浏览器扩展/CLI/AppImage/媒体工具/系统协议）、应用内更新、完成后关机等，
 * 在鸿蒙壳里点了也只会看到"不可用"，不如直接隐藏。
 */
export function isHarmonyShell(): boolean {
  return supportsHostFileActions()
}

function dispatch(verb: string, params: Record<string, string>): void {
  if (typeof document === 'undefined') return
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  const url = `${SCHEME}${verb}${query ? `?${query}` : ''}`
  try {
    // 用一个隐藏 iframe 触发导航：不会打断当前页面，也不会被弹窗拦截器干掉
    const frame = document.createElement('iframe')
    frame.style.display = 'none'
    frame.src = url
    document.body.appendChild(frame)
    window.setTimeout(() => {
      frame.remove()
    }, 1200)
  } catch {
    // 装饰性动作，失败不影响主流程
  }
}

/** 在系统文件管理器中显示给定路径 */
export function revealPathInHost(path: string): void {
  dispatch('reveal', { path })
}

/** 用系统默认应用打开给定路径 */
export function openPathWithHost(path: string): void {
  dispatch('open', { path })
}

/** 用系统浏览器打开外链 */
export function openExternalWithHost(url: string): void {
  dispatch('external', { url })
}
