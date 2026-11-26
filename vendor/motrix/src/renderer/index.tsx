import {
  setRendererSurface,
  showRendererFailure,
  startRendererHealth,
} from './lib/renderer-health'

/**
 * HarmonyOS 移植：把挂载完成后的第一帧露出来。
 *
 * ArkTS 注入脚本在 document start 阶段加了 `html.mtx-booting`（藏 #root），
 * 用来盖掉"启动时先闪一下英文界面再变中文"的过渡帧。等 React 挂载完成、
 * 并且浏览器确实画了一帧之后，再把这段遮罩去掉（两次 rAF 确保已上屏）。
 * 注入脚本本身还有 3 秒兜底，所以即使这里没跑到，页面也不会一直不可见。
 */
function revealBootGuard(): void {
  try {
    const root = document.documentElement
    if (!root.classList.contains('mtx-booting')) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          root.classList.remove('mtx-booting')
        } catch {
          // 忽略
        }
      })
    })
  } catch {
    // 忽略：非 ArkWeb 环境没有这个 class，什么也不会发生
  }
}

async function bootstrap(): Promise<void> {
  try {
    await startRendererHealth()
    const container = document.getElementById('root')
    if (!container) throw new Error('Renderer root is missing')
    const { startRenderer } = await import('./app-root')
    await startRenderer(container)
    revealBootGuard()
    if (__MOTRIX_TARGET__ === 'web') setRendererSurface('app')
  } catch {
    revealBootGuard()
    showRendererFailure('bootstrap')
  }
}
void bootstrap()