/**
 * 平台值桥（HarmonyOS 移植新增）
 *
 * 为什么需要：ArkWeb 里 `prefers-color-scheme` 与 `navigator.language` 都**不可靠**
 * （本机系统中文 + 深色，Web 里仍报浅色 + en-US）。上游 server 模式本来就没有原生主题桥，
 * 于是由 ArkTS 在 document start 注入 `window.__MOTRIX_PLATFORM__`，渲染层优先读它，
 * 这样 settings 里的 `system` 才能真正"跟随系统"，而不是被硬改成固定值。
 *
 * 注入脚本同时把 `matchMedia('(prefers-color-scheme: …)')` 打了补丁，所以 next-themes
 * 的 system 模式不需要额外处理；这里只负责语言，并提供 `__motrixApplyPlatform` 钩子。
 */
export type PlatformColorMode = 'dark' | 'light'

export interface PlatformValues {
  colorMode?: PlatformColorMode
  language?: string
}

interface PlatformGlobal {
  __MOTRIX_PLATFORM__?: PlatformValues
  __motrixApplyPlatform?: (values: PlatformValues) => void
}

function platformGlobal(): PlatformGlobal {
  return globalThis as unknown as PlatformGlobal
}

/** ArkTS 注入的系统值；未注入（比如在普通浏览器里跑）时返回 undefined */
export function readPlatformValues(): PlatformValues | undefined {
  const values = platformGlobal().__MOTRIX_PLATFORM__
  if (!values || typeof values !== 'object') return
  return values
}

export function readPlatformColorMode(): PlatformColorMode | undefined {
  const mode = readPlatformValues()?.colorMode
  return mode === 'dark' || mode === 'light' ? mode : undefined
}

export function readPlatformLanguage(): string | undefined {
  const language = readPlatformValues()?.language
  return typeof language === 'string' && language.length > 0 ? language : undefined
}

/** 注册平台值变更钩子（语言切换用；主题切换走 matchMedia change 事件，由注入脚本负责） */
export function setPlatformChangeHandler(
  handler: ((values: PlatformValues) => void) | undefined
): void {
  platformGlobal().__motrixApplyPlatform = handler
}
