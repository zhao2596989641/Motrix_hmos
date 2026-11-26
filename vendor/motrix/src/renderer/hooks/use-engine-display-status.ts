import {
  onOperatorSessionLost,
  useOperatorSession,
} from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type EngineFailureReason,
  EngineState,
  type EngineStatusSnapshot,
} from '@shared/types/engine'
import type { AppSettings } from '@shared/types/settings'
import { useSyncExternalStore } from 'react'
import { z } from 'zod'
import { useTaskList } from './use-task-list'

export type EngineDisplayState =
  | 'ready'
  | 'starting'
  | 'reconnecting'
  | 'failed'
  | 'disconnected'
  | 'stopped'
export type WebConnectionStatus =
  | 'polling'
  | 'reconnecting'
  | 'unavailable'
  | 'originMismatch'
export interface EngineDisplayStatus {
  state: EngineDisplayState
  version: string
  rpcPort: number
  listenPort: number
  failureReason: EngineFailureReason | null
  connection?: WebConnectionStatus | null
}

function mapState(state: EngineState | undefined): EngineDisplayState {
  if (state === EngineState.Restarting) return 'reconnecting'
  return state ?? 'disconnected'
}

const engineStateSchema = z.enum(EngineState)

const DEFAULT_STATUS: EngineDisplayStatus = {
  state: 'starting',
  version: '?',
  rpcPort: 0,
  listenPort: 0,
  failureReason: null,
}

/**
 * HarmonyOS 移植：把 engine 状态收敛成**模块级单例 store**。
 *
 * 为什么（真机 bug）：仪表板每次导航都会卸载重建，而旧实现每个挂载实例各开
 * 两条读请求（`GetEngineStatus` + `GetSettings`）。在 ArkWeb 上同一 host 只有
 * 6 条连接，页面切换时几个组件同时挂载 → 一批请求排队 → 15s 客户端超时 →
 * 刚挂载的实例手里只有 "starting"（没有上一份快照可保留）→ 界面卡在
 * 「引擎启动中」，直到下一次轮询成功为止。
 *
 * 现在的契约：
 *   · 全局只有一份快照，所有窗口面读同一份 → 返回页面立刻显示上次的真实状态；
 *   · 全局最多 1 条在飞读请求（coalescer），失败按 5s→10s→20s→30s 退避，
 *     **禁止毫秒级快速重试**（r43 的教训：快速重试会把连接池彻底压死）；
 *   · 状态变化由事件流（`EngineStateChanged`）即时推送，轮询只做兜底；
 *   · 还没有任何成功读数时按 5s 兜底，保证冷启动能自愈。
 */
const FRESH_MS = 20_000
const CONNECTED_REFRESH_MS = 60_000
const DISCONNECTED_REFRESH_MS = 10_000
const UNCONFIRMED_REFRESH_MS = 5_000
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 30_000
const READ_DEADLINE_MS = 15_000
const EDGE_MIN_INTERVAL_MS = 5_000

const subscribers = new Set<() => void>()
let snapshot: EngineDisplayStatus = DEFAULT_STATUS
let listenersAttached = false
/** Bumped whenever the whole observation set is invalidated (session reset,
 *  listener teardown). Guards every read. */
let sessionGeneration = 0
/** Bumped when an engine event supersedes an older engine read. Engine-only,
 *  so a state event cannot evict a healthy in-flight settings read. */
let engineGeneration = 0
let lastEngineReadAt = 0
let lastAttemptAt = 0
let lastSettingsReadAt = 0
let engineFailureCount = 0
let engineTrailing = false
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let teardownTimer: ReturnType<typeof setTimeout> | null = null
let detachSessionListener: (() => void) | null = null
let detachConnectionListener: (() => void) | null = null

interface PendingRead {
  promise: Promise<void>
}

let engineRequest: PendingRead | null = null
let settingsRequest: PendingRead | null = null

function sessionUsable(): boolean {
  const state = useOperatorSession.getState().state
  return state !== 'locked' && state !== 'logging-out'
}

function canPublish(
  requestSessionGeneration: number,
  requestEngineGeneration: number
): boolean {
  return (
    listenersAttached &&
    sessionGeneration === requestSessionGeneration &&
    engineGeneration === requestEngineGeneration
  )
}

function canPublishSettings(requestSessionGeneration: number): boolean {
  return listenersAttached && sessionGeneration === requestSessionGeneration
}

function notify(): void {
  for (const listener of subscribers) listener()
}

function publish(patch: Partial<EngineDisplayStatus>): void {
  const next: EngineDisplayStatus = { ...snapshot, ...patch }
  if (
    next.state === snapshot.state &&
    next.version === snapshot.version &&
    next.rpcPort === snapshot.rpcPort &&
    next.listenPort === snapshot.listenPort &&
    next.failureReason === snapshot.failureReason
  )
    return
  snapshot = next
  notify()
}

function clearRefreshTimer(): void {
  if (refreshTimer === null) return
  clearTimeout(refreshTimer)
  refreshTimer = null
}

function isWebVisible(): boolean {
  return (
    transport.platform !== 'web' || document.visibilityState !== 'hidden'
  )
}

/** Delay until the next safety-net read. Backoff only grows on failures;
 *  a confirmation (a successful read or a state event) resets it. */
function nextRefreshDelay(): number {
  if (engineFailureCount > 0) {
    const base = Math.min(
      RETRY_BASE_MS * 2 ** Math.min(engineFailureCount - 1, 3),
      RETRY_MAX_MS
    )
    // Jitter keeps several windows from retrying in lockstep.
    return base * (1 + Math.random() * 0.25)
  }
  if (lastEngineReadAt === 0) return UNCONFIRMED_REFRESH_MS
  return transport.getConnectionState?.() === 'connected'
    ? CONNECTED_REFRESH_MS
    : DISCONNECTED_REFRESH_MS
}

function scheduleRefresh(): void {
  clearRefreshTimer()
  if (!listenersAttached) return
  // Electron drives this from IPC events; only the web transport polls.
  if (transport.platform !== 'web') return
  if (!isWebVisible() || !sessionUsable()) return
  const wait = Math.max(0, nextRefreshDelay() - (Date.now() - lastAttemptAt))
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    refreshEngineStatus()
    if (!lastSettingsReadAt) refreshSettings()
  }, wait)
}

function reportEngineReadFailure(error: unknown): void {
  const message =
    error instanceof Error ? error.message : String(error ?? 'unknown')
  console.warn(`[motrix] engine status read failed: ${message}`)
}

function refreshEngineStatus(): void {
  if (!listenersAttached || !sessionUsable()) return
  if (engineRequest !== null) {
    // A newer edge arrived while a read was in flight: refetch once after it
    // settles instead of stacking requests on a saturated connection pool.
    engineTrailing = true
    return
  }
  const requestSessionGeneration = sessionGeneration
  const requestEngineGeneration = engineGeneration
  const read: PendingRead = { promise: Promise.resolve() }
  let settled = false
  let watchdog: ReturnType<typeof setTimeout> | undefined

  const settle = (failed: boolean, error?: unknown): void => {
    if (settled) return
    settled = true
    if (watchdog !== undefined) clearTimeout(watchdog)
    if (engineRequest === read) engineRequest = null
    if (canPublish(requestSessionGeneration, requestEngineGeneration)) {
      if (failed) {
        engineFailureCount += 1
        // Bounded: two lines per failure episode is enough to diagnose a
        // device log without flooding the ArkTS console bridge.
        if (engineFailureCount <= 2) reportEngineReadFailure(error)
      } else {
        engineFailureCount = 0
      }
    }
    if (engineTrailing) {
      engineTrailing = false
      if (listenersAttached && sessionUsable()) {
        refreshEngineStatus()
        return
      }
    }
    scheduleRefresh()
  }

  lastAttemptAt = Date.now()
  watchdog = setTimeout(
    () => settle(true, new Error('read deadline exceeded')),
    READ_DEADLINE_MS
  )
  read.promise = transport
    .invoke(Queries.GetEngineStatus)
    .then((value) => {
      if (canPublish(requestSessionGeneration, requestEngineGeneration)) {
        const status = value as EngineStatusSnapshot
        lastEngineReadAt = Date.now()
        publish({
          state: mapState(status.state),
          version: status.featureReport?.version ?? '?',
          failureReason: status.failure?.reason ?? null,
        })
      }
      settle(false)
    })
    .catch((error: unknown) => settle(true, error))
  engineRequest = read
}

function refreshSettings(): void {
  if (!listenersAttached || !sessionUsable() || settingsRequest !== null)
    return
  const requestSessionGeneration = sessionGeneration
  const read: PendingRead = { promise: Promise.resolve() }
  read.promise = transport
    .invoke(Queries.GetSettings)
    .then((value) => {
      if (!canPublishSettings(requestSessionGeneration)) return
      const settings = value as AppSettings
      lastSettingsReadAt = Date.now()
      publish({
        rpcPort: settings?.engine?.rpcPort ?? snapshot.rpcPort,
        listenPort: settings?.engine?.listenPort ?? snapshot.listenPort,
      })
    })
    .catch(() => {
      // Ports are decorative for the status surfaces; engine health is not
      // coupled to them and a failed read retries with the next poll.
    })
    .finally(() => {
      if (settingsRequest === read) settingsRequest = null
    })
  settingsRequest = read
}

function onEngineStateEvent(...args: unknown[]): void {
  if (!listenersAttached || !sessionUsable()) return
  const next = engineStateSchema.safeParse(args[0])
  if (!next.success) return
  // The event is authoritative for `state`. Bump the engine generation so an
  // older in-flight read cannot publish a stale state over it, and refetch
  // the payload (version / failure reason) through the coalescer.
  engineGeneration += 1
  lastEngineReadAt = Date.now()
  publish({ state: mapState(next.data), failureReason: null })
  refreshEngineStatus()
}

function onSettingsEvent(): void {
  if (!listenersAttached || !sessionUsable()) return
  if (Date.now() - lastSettingsReadAt < 2_000) return
  refreshSettings()
}

function onForeground(): void {
  if (!listenersAttached || !isWebVisible() || !sessionUsable()) return
  if (Date.now() - lastAttemptAt < EDGE_MIN_INTERVAL_MS) return
  refreshEngineStatus()
  if (!lastSettingsReadAt) refreshSettings()
}

function onVisibilityChange(): void {
  if (!listenersAttached) return
  if (document.visibilityState === 'hidden') {
    clearRefreshTimer()
    return
  }
  onForeground()
  scheduleRefresh()
}

function onSessionChange(
  state: ReturnType<typeof useOperatorSession.getState>,
  previous: ReturnType<typeof useOperatorSession.getState>
): void {
  if (!listenersAttached) return
  if (!sessionUsable()) {
    // Locked / logging out: drop privileged observations. The generation bump
    // inside resetStatus makes any late response a no-op.
    resetStatus()
    return
  }
  // A new login epoch owns fresh observations; anything from the old session
  // was invalidated by resetStatus.
  if (state.epoch !== previous.epoch) {
    resetStatus()
    refreshEngineStatus()
    refreshSettings()
    scheduleRefresh()
  }
}

function onConnectionChange(event: { state: string }): void {
  if (!listenersAttached || event.state !== 'connected') return
  onForeground()
}

function attachListeners(): void {
  if (listenersAttached) return
  listenersAttached = true
  detachSessionListener = useOperatorSession.subscribe(onSessionChange)
  detachConnectionListener = transport.onConnectionChange
    ? transport.onConnectionChange(onConnectionChange)
    : null
  transport.on(Events.EngineStateChanged, onEngineStateEvent)
  transport.on(Events.SettingsChanged, onSettingsEvent)
  if (transport.platform === 'web') {
    window.addEventListener('focus', onForeground)
    window.addEventListener('online', onForeground)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  // Re-mounts reuse a fresh snapshot (that is the point of the store); stale
  // or missing observations trigger one coalesced read.
  const stale = Date.now() - lastAttemptAt >= FRESH_MS
  if (stale) refreshEngineStatus()
  if (!lastSettingsReadAt) refreshSettings()
  scheduleRefresh()
}

function detachListeners(): void {
  if (!listenersAttached) return
  listenersAttached = false
  transport.off(Events.EngineStateChanged, onEngineStateEvent)
  transport.off(Events.SettingsChanged, onSettingsEvent)
  detachSessionListener?.()
  detachSessionListener = null
  detachConnectionListener?.()
  detachConnectionListener = null
  if (transport.platform === 'web') {
    window.removeEventListener('focus', onForeground)
    window.removeEventListener('online', onForeground)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  clearRefreshTimer()
  sessionGeneration += 1
  engineGeneration += 1
  engineRequest = null
  settingsRequest = null
  engineTrailing = false
  // The snapshot itself is intentionally retained: returning to a page shows
  // the last confirmed state instead of flashing "starting".
}

function resetStatus(): void {
  sessionGeneration += 1
  engineGeneration += 1
  clearRefreshTimer()
  engineRequest = null
  settingsRequest = null
  engineTrailing = false
  engineFailureCount = 0
  lastEngineReadAt = 0
  lastAttemptAt = 0
  lastSettingsReadAt = 0
  publish(DEFAULT_STATUS)
}

function cancelDeferredTeardown(): void {
  if (teardownTimer === null) return
  clearTimeout(teardownTimer)
  teardownTimer = null
}

function scheduleDeferredTeardown(): void {
  if (teardownTimer !== null) return
  // React may unmount the outgoing route a frame before mounting the incoming
  // one; deferring keeps the store warm across that gap.
  teardownTimer = setTimeout(() => {
    teardownTimer = null
    if (subscribers.size === 0) detachListeners()
  }, 0)
}

export function subscribeEngineStatus(listener: () => void): () => void {
  cancelDeferredTeardown()
  subscribers.add(listener)
  attachListeners()
  return () => {
    subscribers.delete(listener)
    if (subscribers.size === 0) scheduleDeferredTeardown()
  }
}

export function getEngineStatusSnapshot(): EngineDisplayStatus {
  return snapshot
}

const getServerSnapshot = getEngineStatusSnapshot

/** Both engine surfaces consume the task store's connection/data health.
 *  Losing the browser event stream does not mean aria2 has stopped. */
export function useEngineDisplayStatus(): EngineDisplayStatus {
  const { realtimeConnected, status: taskStatus } = useTaskList()
  const session = useOperatorSession()
  const status = useSyncExternalStore(
    subscribeEngineStatus,
    getEngineStatusSnapshot,
    getServerSnapshot
  )

  let connectionStatus: WebConnectionStatus | null = null
  if (
    transport.platform === 'web' &&
    (!realtimeConnected || taskStatus === 'error')
  ) {
    connectionStatus =
      taskStatus === 'error'
        ? 'unavailable'
        : session.status?.eventOriginMatches === false
          ? 'originMismatch'
          : taskStatus === 'ready'
            ? 'polling'
            : 'reconnecting'
  }
  return { ...status, connection: connectionStatus }
}

/** Clear privileged observations when the operator session is confirmed lost.
 *  Listeners stay attached (the window may still be mounted behind the lock
 *  screen); a new epoch restarts the reads via `onSessionChange`. */
export function clearEngineStatusSession(): void {
  resetStatus()
}

onOperatorSessionLost(clearEngineStatusSession)

/** Internal: tests only. Resets the module-level external store. */
export function __resetEngineStatusStoreForTests(): void {
  cancelDeferredTeardown()
  detachListeners()
  subscribers.clear()
  sessionGeneration += 1
  engineGeneration += 1
  snapshot = DEFAULT_STATUS
  lastEngineReadAt = 0
  lastAttemptAt = 0
  lastSettingsReadAt = 0
  engineFailureCount = 0
  engineTrailing = false
  engineRequest = null
  settingsRequest = null
}