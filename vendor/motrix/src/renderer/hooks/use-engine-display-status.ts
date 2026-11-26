import { useOperatorSession } from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  type EngineFailureReason,
  EngineState,
  type EngineStatusSnapshot,
} from '@shared/types/engine'
import type { AppSettings } from '@shared/types/settings'
import { useEffect, useRef, useState } from 'react'
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

const DEFAULTS: EngineDisplayStatus = {
  state: 'starting',
  version: '?',
  rpcPort: 0,
  listenPort: 0,
  failureReason: null,
}

/**
 * 模块级"最后一次已知状态"。
 *
 * 为什么需要：dashboard 每次导航都会卸载重建，hook 的初始值原本是 DEFAULTS（starting）；
 * 重建瞬间会闪一下"引擎启动中"，如果首个查询恰好失败（或被 15s 超时打断），
 * 就会一直停在"启动中"直到下一次轮询。用缓存兜底后：
 *   · 重建立刻显示上次的 ready/失败态；
 *   · 查询失败也保持上次状态，不再退化成"启动中"。
 */
let lastKnownStatus: EngineDisplayStatus | null = null

/** Both engine surfaces consume the task store's connection/data health.
 * Losing the browser event stream does not mean aria2 has stopped. */
export function useEngineDisplayStatus(): EngineDisplayStatus {
  const { realtimeConnected, status: taskStatus } = useTaskList()
  const session = useOperatorSession()
  const [status, setStatus] = useState<EngineDisplayStatus>(
    () => lastKnownStatus ?? DEFAULTS
  )

  /** 所有状态更新都走这里：顺手写模块级缓存，供下次挂载秒开 */
  const applyStatus = (
    updater: (previous: EngineDisplayStatus) => EngineDisplayStatus
  ): void => {
    setStatus((previous) => {
      const next = updater(previous)
      lastKnownStatus = next
      return next
    })
  }

  const connection = useRef(realtimeConnected)
  const refreshConnection = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (session.state === 'locked' || session.state === 'logging-out') {
      lastKnownStatus = null
      setStatus(DEFAULTS)
      return
    }
    let disposed = false
    const isCurrentSession = () =>
      !disposed && session.epoch === useOperatorSession.getState().epoch

    // Engine observations must remain available even if settings is slow.
    // Each reader owns its own coalescer, invalidation generation and timer.
    const reader = <T>(load: () => Promise<T>, apply: (value: T) => void) => {
      let generation = 0
      let inFlight = false
      let trailing = false
      let failures = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const refresh = async (invalidate = false) => {
        if (!isCurrentSession()) return
        if (invalidate) generation++
        if (inFlight) {
          trailing = true
          return
        }
        inFlight = true
        clearTimeout(timer)
        const current = generation
        try {
          const value = await load()
          if (isCurrentSession() && current === generation) {
            failures = 0
            apply(value)
          }
        } catch (error) {
          // Retain the last observation; task/connection health is separate.
          failures += 1
          if (failures <= 2) {
            // 落 arkts-diag：区分"查询失败"与"引擎真的在启动"（下次真机日志一眼可见）
            console.warn(
              '[motrix] engine status read failed, retrying: ' +
                String((error as Error)?.message ?? error)
            )
          }
        } finally {
          inFlight = false
          if (isCurrentSession()) {
            if (trailing) {
              trailing = false
              void refresh()
            } else if (transport.platform === 'web')
              // 有失败就先 1.5s 快速重试，别让界面停在"启动中"半分钟
              timer = setTimeout(
                () => {
                  if (document.visibilityState !== 'hidden') void refresh()
                },
                failures > 0 ? 1_500 : connection.current ? 30_000 : 5_000
              )
          }
        }
      }
      return { refresh, dispose: () => clearTimeout(timer) }
    }
    const engine = reader(
      () =>
        transport.invoke(
          Queries.GetEngineStatus
        ) as Promise<EngineStatusSnapshot>,
      (value) =>
        applyStatus((previous) => ({
          ...previous,
          state: mapState(value.state),
          version: value.featureReport?.version ?? '?',
          failureReason: value.failure?.reason ?? null,
        }))
    )
    const settings = reader(
      () => transport.invoke(Queries.GetSettings) as Promise<AppSettings>,
      (value) =>
        applyStatus((previous) => ({
          ...previous,
          rpcPort: value?.engine?.rpcPort ?? previous.rpcPort,
          listenPort: value?.engine?.listenPort ?? previous.listenPort,
        }))
    )
    const refresh = () => {
      void engine.refresh()
      void settings.refresh()
    }
    const onEngine = (...args: unknown[]) => {
      if (!isCurrentSession()) return
      const next = engineStateSchema.safeParse(args[0])
      if (next.success)
        applyStatus((previous) => ({
          ...previous,
          state: mapState(next.data),
          failureReason: null,
        }))
      void engine.refresh(true)
    }
    const onSettings = () => {
      void settings.refresh(true)
    }
    const foreground = () => {
      if (document.visibilityState !== 'hidden') refresh()
    }
    transport.on(Events.EngineStateChanged, onEngine)
    transport.on(Events.SettingsChanged, onSettings)
    window.addEventListener('online', foreground)
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    refreshConnection.current = refresh
    refresh()
    return () => {
      disposed = true
      engine.dispose()
      settings.dispose()
      refreshConnection.current = null
      transport.off(Events.EngineStateChanged, onEngine)
      transport.off(Events.SettingsChanged, onSettings)
      window.removeEventListener('online', foreground)
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', foreground)
    }
  }, [session.epoch, session.state])

  useEffect(() => {
    if (connection.current === realtimeConnected) return
    connection.current = realtimeConnected
    // A transport edge does not invalidate a healthy in-flight HTTP read.
    refreshConnection.current?.()
  }, [realtimeConnected])

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
