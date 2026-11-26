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

/** 是否运行在 HarmonyOS 原生壳里（而不是普通浏览器打开 web UI） */
export function isHarmonyShell(): boolean {
  return supportsHostFileActions()
}

/**
 * 端侧插件运行时是否可用（原生壳注入 `pluginRuntime: 'unavailable'`）。
 *
 * 为什么由原生壳给结论：插件沙箱跑在**端侧 Node**（`--jitless` ⇒ 没有 WebAssembly），
 * 而 UI 自己跑在 ArkWeb 里（Chromium 有 WebAssembly）——所以渲染层无法自行判断，
 * 只能读注入值。普通浏览器/上游形态没有这个字段，按"可用"处理。
 */
export function pluginsRuntimeAvailable(): boolean {
  const platform = (
    globalThis as { __MOTRIX_PLATFORM__?: { pluginRuntime?: unknown } }
  ).__MOTRIX_PLATFORM__
  if (platform === undefined || platform === null) return true
  return platform.pluginRuntime !== 'unavailable'
}

/** 移植轮次（原生壳注入 __MOTRIX_PLATFORM__.portVersion），用于关于页徽章 */
export function harmonyPortVersion(): string | null {
  const platform = (
    globalThis as { __MOTRIX_PLATFORM__?: { portVersion?: unknown } }
  ).__MOTRIX_PLATFORM__
  const version = platform?.portVersion
  return typeof version === 'string' && version.length > 0 ? version : null
}

/**
 * 开机自启状态（原生壳注入）。
 *
 * 为什么需要：HarmonyOS 不允许三方应用自己打开开机自启（`autoStartupManager` 只有查询，
 * 没有设置），用户必须去「设置 → 应用和元服务 → 应用启动管理」手动添加。
 * 所以设置页只能显示当前状态 + 给一个跳转按钮，状态由原生壳查询后注入。
 *
 * `unknown` 表示壳还没查到（或旧壳没这个字段），此时不显示状态行，避免误导。
 */
export type HarmonyAutoStartupStatus =
  | 'enabled'
  | 'disabled'
  | 'unsupported'
  | 'unknown'

export function harmonyAutoStartupStatus(): HarmonyAutoStartupStatus {
  const platform = (
    globalThis as { __MOTRIX_PLATFORM__?: { autoStartup?: unknown } }
  ).__MOTRIX_PLATFORM__
  const value = platform?.autoStartup
  if (
    value === 'enabled' ||
    value === 'disabled' ||
    value === 'unsupported'
  ) {
    return value
  }
  return 'unknown'
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

/**
 * 打开系统设置里的「应用启动管理」附近页面（开机自启只能在那里由用户手动打开）。
 *
 * 鸿蒙设置应用没有公开「应用启动管理」页的 uri，所以壳里按顺序尝试：
 * 应用详情页 → 应用与元服务 → 设置首页，第一个能拉起的就用。
 */
export function openAutoStartupSettings(): void {
  dispatch('autostart', {})
}
