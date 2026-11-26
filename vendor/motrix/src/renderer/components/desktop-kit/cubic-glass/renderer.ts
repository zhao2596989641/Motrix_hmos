import {
  getReducedMotion,
  subscribeReducedMotion,
} from '@renderer/lib/reduced-motion'
import {
  POINTER_POSITION_CONSTRAINT,
  POINTER_TRAVEL,
  POINTER_Y_RESPONSE_SECONDS,
  POINTER_Y_RETURN_RESPONSE_SECONDS,
} from './config'
import {
  isSpringSettled,
  resolveHorizontalResponseSeconds,
  resolvePointerOffset,
  type SpringAxisState,
  stepCriticalSpring,
} from './motion'
import type { CubicGlassEffects, CubicGlassGradientPreset } from './types'
import { createCubicGlassWebGlScene } from './webgl-scene'

export interface CubicGlassRendererController {
  dispose: (contextLost?: boolean) => void
  schedule: () => void
}

// ── 性能参数（HarmonyOS 移植调整）──────────────────────────────────────────
//
// 背景：上游把「呼吸」做成 canvas 元素上的 CSS opacity 动画（9s 循环、60fps）。
// 全屏 4M+ 像素的合成动画在 ArkWeb 的 OSR 合成下要吃掉 ~27% CPU（实测
// gpu 进程 20% + render 进程 7%），整机会跟着卡。
// 处理：把呼吸搬进 WebGL（每帧只是乘一个系数），并把帧率/分辨率按渲染能力分级；
// 这样"动画还在"，但代价降到原来的百分之几。软件光栅（SwiftShader）再降一档。
const BREATH_PERIOD_MS = 9000
const BREATH_MIN_SCALE = 0.968
/**
 * 质量档位（0 = 最高 … 3 = 最省）。
 *
 * 只在"呼吸"这种**持续**动画上使用；指针跟随是瞬时交互，可以给高一点。
 * 每一档：(静态呼吸帧率上限, 指针帧率上限, 静态像素预算, 指针像素预算)
 * 实测：真机 OSR 合成下，全屏每秒 30 次重绘约吃 20% CPU，所以默认从低档起步，
 * 再由下面的自适应逻辑按**真实帧耗时**上下调整。
 */
interface QualityTier {
  idleFrameMs: number
  idlePixels: number
  pointerFrameMs: number
  pointerPixels: number
}

const QUALITY_TIERS: QualityTier[] = [
  { idleFrameMs: 1000 / 20, idlePixels: 1_600_000, pointerFrameMs: 1000 / 45, pointerPixels: 1_200_000 },
  { idleFrameMs: 1000 / 12, idlePixels: 800_000, pointerFrameMs: 1000 / 30, pointerPixels: 600_000 },
  { idleFrameMs: 1000 / 8, idlePixels: 420_000, pointerFrameMs: 1000 / 24, pointerPixels: 320_000 },
  { idleFrameMs: 1000 / 5, idlePixels: 220_000, pointerFrameMs: 1000 / 15, pointerPixels: 180_000 },
]
const MIN_QUALITY_TIER = QUALITY_TIERS.length - 1
/** 单帧耗时超过这个就降档（真机一帧画 30ms 以上时，页面滚动/输入都会明显卡） */
const SLOW_FRAME_MS = 24
/** 单帧耗时低于这个且稳定一段时间就尝试升档 */
const FAST_FRAME_MS = 9
const TIER_RAISE_STREAK = 40

export const IDLE_CUBIC_GLASS_RENDERER: CubicGlassRendererController = {
  dispose: () => {},
  schedule: () => {},
}

export function startCubicGlassRenderer(
  canvas: HTMLCanvasElement,
  root: HTMLDivElement,
  readPreset: () => CubicGlassGradientPreset,
  readEffects: () => CubicGlassEffects,
  readInteractionElement: () => HTMLElement | null
): CubicGlassRendererController {
  const scene = createCubicGlassWebGlScene(canvas)
  if (!scene) return IDLE_CUBIC_GLASS_RENDERER
  const webGlScene = scene

  let animationFrame = 0
  let idleTimer = 0
  let boundsDirty = true
  let cssHeight = 0
  let cssWidth = 0
  let disposed = false
  let dprQuery: MediaQueryList | null = null
  let finePointerQuery: MediaQueryList | null = null
  let lastTimestamp = 0
  let lastDrawAt = 0
  let rootBounds = { height: 0, left: 0, top: 0, width: 0 }
  let sceneDirty = true
  let pointerClientX = 0
  let pointerClientY = 0
  let pointerInside = false
  let targetX = 0
  let targetY = 0
  let xSpring: SpringAxisState = { value: 0, velocity: 0 }
  let ySpring: SpringAxisState = { value: 0, velocity: 0 }
  const software = webGlScene.software
  // 软件光栅（SwiftShader/llvmpipe）从最低档起步；硬件从次低档起步，再按耗时自适应
  // 硬件起步档：真机是 Maleoon 935 + OSR 合成，全屏 canvas 持续重绘的代价远超桌面浏览器，
  // 所以不要从最高画质起步（20fps/1.6M 像素），默认从第 1 档（12fps/800k）开始，
  // 真掉帧再单向降档。
  let tierIndex = software ? MIN_QUALITY_TIER : 1
  let tier = QUALITY_TIERS[tierIndex]
  let frameCostEma = 0
  let lastFrameStartTimestamp = 0
  let expectedFrameGapMs = tier.idleFrameMs
  const setTier = (next: number) => {
    const clamped = Math.max(0, Math.min(MIN_QUALITY_TIER, next))
    if (clamped === tierIndex) return
    tierIndex = clamped
    tier = QUALITY_TIERS[tierIndex]
    root.dataset.qualityTier = String(tierIndex)
    expectedFrameGapMs = tier.idleFrameMs
    console.info(
      `[cubic-glass] quality tier -> ${tierIndex} (frameCostEma=${frameCostEma.toFixed(1)}ms software=${software})`
    )
  }
  root.dataset.qualityTier = String(tierIndex)
  root.dataset.softwareGl = String(software)
  const interactionElement =
    readInteractionElement() ?? root.parentElement ?? root

  const pointerFollowEnabled = () => {
    const effects = readEffects()
    return (
      effects.enabled &&
      effects.pointerFollow &&
      !getReducedMotion() &&
      finePointerQuery?.matches !== false
    )
  }

  const springIsSettled = () =>
    isSpringSettled(xSpring, targetX) && isSpringSettled(ySpring, targetY)

  /** 呼吸动画是否应当运行（上游语义：effects.enabled && effects.breathing） */
  const breathEnabled = () => {
    const effects = readEffects()
    return effects.enabled && effects.breathing
  }

  const setPointerInside = (inside: boolean) => {
    if (pointerInside === inside) return
    pointerInside = inside
    root.dataset.pointerActive = String(inside)
  }

  const returnToOrigin = (immediate = false) => {
    targetX = 0
    targetY = 0
    setPointerInside(false)
    if (immediate) {
      xSpring = { value: 0, velocity: 0 }
      ySpring = { value: 0, velocity: 0 }
      lastTimestamp = 0
    }
  }

  const refreshBounds = () => {
    const bounds = root.getBoundingClientRect()
    rootBounds = {
      height: bounds.height,
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
    }
    cssWidth = bounds.width
    cssHeight = bounds.height
    boundsDirty = false
  }

  const refreshPointerTarget = () => {
    if (!pointerInside) return
    const preset = readPreset()
    const [travelX, travelY] = POINTER_TRAVEL[preset]
    const effects = readEffects()
    const target = resolvePointerOffset(
      pointerClientX,
      pointerClientY,
      rootBounds,
      { x: travelX, y: travelY },
      effects.positionConstraint
        ? POINTER_POSITION_CONSTRAINT[preset]
        : undefined
    )
    targetX = target.x
    targetY = target.y
  }

  /**
   * 排下一帧。
   *
   * 关键约束：**不能**用"每帧 rAF 回来再判断时间没到就重排"的方式限帧 ——
   * 那会让 rAF 以 60fps 常驻，OSR 合成下每次都会要一个新合成帧，代价远大于动画本身。
   * 这里用 setTimeout 精确等到"下一帧该画的时刻"，再要一次 rAF（拿到对齐的 timestamp）。
   */
  function scheduleFrame(delayMs: number = 0) {
    if (
      disposed ||
      animationFrame !== 0 ||
      idleTimer !== 0 ||
      document.visibilityState === 'hidden'
    ) {
      return
    }
    if (delayMs <= 0) {
      animationFrame = requestAnimationFrame(draw)
      return
    }
    idleTimer = window.setTimeout(() => {
      idleTimer = 0
      if (disposed || document.visibilityState === 'hidden') return
      animationFrame = requestAnimationFrame(draw)
    }, delayMs)
  }

  function draw(timestamp: number) {
    animationFrame = 0
    if (disposed) return

    if (boundsDirty) {
      refreshBounds()
    }
    if (cssWidth < 1 || cssHeight < 1) return

    // 帧率闸门：呼吸走静态档，指针跟随走高一点的档位。
    const pointerBusy = pointerInside || !springIsSettled()
    const interval = pointerBusy ? tier.pointerFrameMs : tier.idleFrameMs
    if (lastDrawAt !== 0 && timestamp - lastDrawAt < interval - 1) {
      scheduleFrame(interval - (timestamp - lastDrawAt))
      return
    }

    if (!pointerFollowEnabled()) returnToOrigin(true)
    refreshPointerTarget()
    const wasSettled = springIsSettled()
    if (!wasSettled) {
      const deltaSeconds =
        lastTimestamp === 0 ? 1 / 60 : (timestamp - lastTimestamp) / 1000
      const horizontalResponse = resolveHorizontalResponseSeconds(
        readEffects().horizontalSpeed
      )
      const xResponse = pointerInside
        ? horizontalResponse
        : horizontalResponse * 0.88
      const yResponse = pointerInside
        ? POINTER_Y_RESPONSE_SECONDS
        : POINTER_Y_RETURN_RESPONSE_SECONDS
      xSpring = stepCriticalSpring(xSpring, targetX, xResponse, deltaSeconds)
      ySpring = stepCriticalSpring(ySpring, targetY, yResponse, deltaSeconds)
      if (springIsSettled()) {
        xSpring = { value: targetX, velocity: 0 }
        ySpring = { value: targetY, velocity: 0 }
      }
    }
    lastTimestamp = timestamp
    lastDrawAt = timestamp
    const moving = !springIsSettled()

    const requestedPixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const pixelBudgetRatio = Math.sqrt(
      (moving ? tier.pointerPixels : tier.idlePixels) / (cssWidth * cssHeight)
    )
    const pixelRatio = Math.min(requestedPixelRatio, pixelBudgetRatio)
    const width = Math.max(1, Math.round(cssWidth * pixelRatio))
    const height = Math.max(1, Math.round(cssHeight * pixelRatio))

    const breathPhase = (timestamp % BREATH_PERIOD_MS) / BREATH_PERIOD_MS
    const breath = breathEnabled()
      ? BREATH_MIN_SCALE +
        (1 - BREATH_MIN_SCALE) * (0.5 + 0.5 * Math.cos(breathPhase * Math.PI * 2))
      : 1

    const drawStart = performance.now()
    webGlScene.render({
      breath,
      height,
      offsetX: xSpring.value,
      offsetY: ySpring.value,
      preset: readPreset(),
      refreshScene: sceneDirty,
      width,
    })
    sceneDirty = false
    root.dataset.renderer = 'webgl2'
    canvas.dataset.ready = 'true'

    // ── 自适应降档 ────────────────────────────────────────────────────────
    // ⚠ 不要用"这一帧 JS 侧耗时"判断 GPU 压力：WebGL 的 drawArrays 只是把命令放进队列，
    //   JS 侧永远只有 0.1ms，而真正的 GPU/合成开销是异步的。实测因此误判为"很快"，
    //   反而升档到最高画质（越修越卡）。所以这里只做**单向**降档：靠 rAF 的实际间隔
    //   估算是否掉帧（rAF 间隔明显大于我们请求的间隔 ⇒ 合成端跟不上）。
    const drawCost = performance.now() - drawStart
    frameCostEma = frameCostEma === 0 ? drawCost : frameCostEma * 0.8 + drawCost * 0.2
    if (expectedFrameGapMs > 0) {
      const observedGap = timestamp - lastFrameStartTimestamp
      lastFrameStartTimestamp = timestamp
      if (observedGap > expectedFrameGapMs * 2.5 && observedGap < 2000) {
        // 明显掉帧：降一档（只降不升，避免在抖动区间来回切）
        setTier(tierIndex + 1)
      }
    } else {
      lastFrameStartTimestamp = timestamp
    }
    if (moving || breathEnabled()) {
      // 到点再要下一帧，而不是原地继续吃 rAF
      scheduleFrame(moving ? 0 : Math.max(0, tier.idleFrameMs))
    } else {
      lastTimestamp = 0
      lastDrawAt = 0
    }
  }

  const scheduleSceneDraw = () => {
    sceneDirty = true
    if (!pointerFollowEnabled()) {
      returnToOrigin(getReducedMotion())
    }
    scheduleFrame()
  }

  const invalidateBounds = () => {
    boundsDirty = true
    scheduleSceneDraw()
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (
      (event.pointerType && event.pointerType !== 'mouse') ||
      !pointerFollowEnabled()
    ) {
      return
    }
    if (boundsDirty) refreshBounds()
    const inside =
      event.clientX >= rootBounds.left &&
      event.clientX <= rootBounds.left + rootBounds.width &&
      event.clientY >= rootBounds.top &&
      event.clientY <= rootBounds.top + rootBounds.height
    if (!inside) {
      const needsReturnFrame = pointerInside || !springIsSettled()
      returnToOrigin()
      if (needsReturnFrame) scheduleFrame()
      return
    }

    pointerClientX = event.clientX
    pointerClientY = event.clientY
    setPointerInside(true)
    refreshPointerTarget()
    scheduleFrame()
  }

  const handlePointerLeave = () => {
    const needsReturnFrame = pointerInside || !springIsSettled()
    returnToOrigin()
    if (needsReturnFrame) scheduleFrame()
  }

  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(invalidateBounds)
  resizeObserver?.observe(root)

  const themeObserver =
    typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(scheduleSceneDraw)
  themeObserver?.observe(document.documentElement, {
    attributeFilter: ['class'],
    attributes: true,
  })

  const handleDprChange = () => {
    bindDprQuery()
    invalidateBounds()
  }
  const bindDprQuery = () => {
    dprQuery?.removeEventListener('change', handleDprChange)
    dprQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
        : null
    dprQuery?.addEventListener('change', handleDprChange)
  }
  const handleReducedMotionChange = () => {
    if (getReducedMotion()) returnToOrigin(true)
    scheduleSceneDraw()
  }
  const handlePointerCapabilityChange = () => {
    if (!finePointerQuery?.matches) returnToOrigin(true)
    scheduleSceneDraw()
  }
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame)
      animationFrame = 0
      if (idleTimer !== 0) window.clearTimeout(idleTimer)
      idleTimer = 0
      returnToOrigin(true)
      return
    }
    lastTimestamp = 0
    scheduleSceneDraw()
  }
  bindDprQuery()
  const stopMotionSync = subscribeReducedMotion(handleReducedMotionChange)
  if (typeof window.matchMedia === 'function') {
    finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)')
    finePointerQuery.addEventListener('change', handlePointerCapabilityChange)
  }
  interactionElement.addEventListener('pointerleave', handlePointerLeave)
  interactionElement.addEventListener('pointercancel', handlePointerLeave)
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('blur', handlePointerLeave)
  window.addEventListener('resize', invalidateBounds)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  scheduleSceneDraw()

  const dispose = (contextLost = false) => {
    if (disposed) return
    disposed = true
    if (animationFrame !== 0) cancelAnimationFrame(animationFrame)
    if (idleTimer !== 0) window.clearTimeout(idleTimer)
    idleTimer = 0
    resizeObserver?.disconnect()
    themeObserver?.disconnect()
    dprQuery?.removeEventListener('change', handleDprChange)
    stopMotionSync()
    finePointerQuery?.removeEventListener(
      'change',
      handlePointerCapabilityChange
    )
    interactionElement.removeEventListener('pointerleave', handlePointerLeave)
    interactionElement.removeEventListener('pointercancel', handlePointerLeave)
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('blur', handlePointerLeave)
    window.removeEventListener('resize', invalidateBounds)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    webGlScene.dispose(contextLost)
  }

  return { dispose, schedule: scheduleSceneDraw }
}
