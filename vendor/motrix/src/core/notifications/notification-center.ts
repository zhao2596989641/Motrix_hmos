import type { Logger } from '@core/logger'
import type { MotrixDatabase } from '@core/session/motrix-database'
import type { EventChannel } from '@shared/protocol/events'
import { Events } from '@shared/protocol/events'
import { resolveFailureDescriptor } from '@shared/task-error/descriptor'
import type {
  AppNotification,
  NotificationSeverity,
} from '@shared/types/notification'
import type { TaskDiagnosisOccurrence } from '@shared/types/task-occurrence'

/**
 * HarmonyOS 移植：系统通知转发钩子。
 *
 * 上游的通知只到应用内（Notifications 页 + 角标）。移植版需要把"任务完成/失败"
 * 也发到系统通知栏，否则窗口最小化时用户感知不到。
 *
 * 这里放一个进程级钩子而不是改每个调用点：`notify()` 是唯一入口，
 * 挂一次就能覆盖全部通知。默认 `null`（不影响上游任何行为），
 * 由 server 启动时注入实现（见 src/server/native-notify-bridge.ts）。
 */
export type SystemNotificationHook = (row: {
  kind: string
  severity: string
  titleKey: string
  titleParams: Record<string, unknown> | null
  bodyKey: string | null
  bodyParams: Record<string, unknown> | null
}) => void

let systemNotificationHook: SystemNotificationHook | null = null

export function setSystemNotificationHook(hook: SystemNotificationHook | null): void {
  systemNotificationHook = hook
}

export interface NotifyInput {
  sourceKey: string
  kind: string
  severity: NotificationSeverity
  titleKey: string
  titleParams?: Record<string, string>
  bodyKey?: string
  bodyParams?: Record<string, string>
  taskId?: string
  createdAt?: number
}

export interface NotificationCenterDeps {
  // Structural subset is fine — the concrete MotrixDatabase type is used so
  // tests can pass a real in-memory instance without a hand-rolled mock.
  store: MotrixDatabase
  // Both shells pass `eventBus.emit.bind(eventBus)`. Must not throw — both
  // shells pass `EventBus.emit`, which isolates listeners (see
  // `EventBusOptions.onListenerError`).
  emit: (channel: EventChannel, payload?: unknown) => void
  now?: () => number
  /** A shell-specific display policy. Omitted by the server to show all kinds. */
  getHiddenKinds?: () => readonly string[]
  log: Pick<Logger, 'warn' | 'error'>
}

/**
 * Domain logic for the notification center: store-transactional writes
 * (Task 10's `MotrixDatabase` methods) plus best-effort event fan-out.
 *
 * The store write always happens first and is the source of truth for
 * whether anything changed; events are a secondary side effect. Emits go
 * straight to `deps.emit` — the `EventBus` is the single isolation choke
 * point, so a throwing subscriber on one channel can neither unwind the
 * mutating call nor suppress a second, independent emit (see `notify()`,
 * which fires two channels back to back).
 */
export class NotificationCenter {
  private readonly now: () => number

  constructor(private readonly deps: NotificationCenterDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Insert a notification through the ledger-guarded store write. A `null`
   * result means `sourceKey` was already delivered (or superseded) — no
   * display row is created and no event is emitted. A fresh row emits
   * `NotificationAdded(row)` then `NotificationsChanged`; the bus isolates
   * each listener, so a throwing subscriber on the first channel cannot
   * suppress the second.
   */
  notify(input: NotifyInput): { fresh: boolean } {
    const row = this.deps.store.insertNotificationWithLedger({
      sourceKey: input.sourceKey,
      taskId: input.taskId ?? null,
      kind: input.kind,
      severity: input.severity,
      titleKey: input.titleKey,
      titleParams: input.titleParams ?? null,
      bodyKey: input.bodyKey ?? null,
      bodyParams: input.bodyParams ?? null,
      createdAt: input.createdAt ?? this.now(),
    })
    if (row === null) return { fresh: false }

    this.deps.emit(Events.NotificationAdded, row)
    this.deps.emit(Events.NotificationsChanged)
    // HarmonyOS 移植：转发给系统通知桥（钩子为 null 时是空操作）
    if (systemNotificationHook !== null) {
      try {
        systemNotificationHook({
          kind: String(row.kind ?? ''),
          severity: String(row.severity ?? 'info'),
          titleKey: String(row.titleKey ?? ''),
          titleParams: (row.titleParams ?? null) as Record<string, unknown> | null,
          bodyKey: row.bodyKey === null || row.bodyKey === undefined ? null : String(row.bodyKey),
          bodyParams: (row.bodyParams ?? null) as Record<string, unknown> | null,
        })
      } catch {
        // 系统通知失败绝不能影响通知落库与事件分发
      }
    }
    return { fresh: true }
  }

  /**
   * Refine an already-terminal notification's body once a later diagnosis
   * occurrence resolves a more specific reason. Matches the display row by
   * `terminalOccurrenceId` (the `sourceKey` a terminal notify() used) and
   * patches it to the diagnosis descriptor's best (first) reason candidate.
   * Never inserts a row and never emits `NotificationAdded` — this only
   * ever refines an existing row's body.
   */
  applyDiagnosisUpgrade(occ: TaskDiagnosisOccurrence): boolean {
    const descriptor = resolveFailureDescriptor(occ.diagnosis)
    const [candidate] = descriptor.reasonCandidates
    const changed = this.deps.store.updateNotificationBySourceKey(
      occ.terminalOccurrenceId,
      { bodyKey: candidate.key, bodyParams: candidate.params ?? null }
    )
    if (changed) this.deps.emit(Events.NotificationsChanged)
    return changed
  }

  markRead(id: string): boolean {
    const changed = this.deps.store.markNotificationRead(id, this.now())
    if (changed) this.deps.emit(Events.NotificationsChanged)
    return changed
  }

  markAllRead(): number {
    const count = this.deps.store.markAllNotificationsRead(
      this.now(),
      this.deps.getHiddenKinds?.()
    )
    if (count > 0) this.deps.emit(Events.NotificationsChanged)
    return count
  }

  delete(id: string): boolean {
    const changed = this.deps.store.deleteNotification(id)
    if (changed) this.deps.emit(Events.NotificationsChanged)
    return changed
  }

  clear(): number {
    const count = this.deps.store.clearNotifications(
      this.deps.getHiddenKinds?.()
    )
    if (count > 0) this.deps.emit(Events.NotificationsChanged)
    return count
  }

  list(limit?: number): AppNotification[] {
    return this.deps.store.listNotifications(
      limit,
      this.deps.getHiddenKinds?.()
    )
  }

  unreadCount(): number {
    return this.deps.store.getUnreadNotificationCount(
      this.deps.getHiddenKinds?.()
    )
  }
}
