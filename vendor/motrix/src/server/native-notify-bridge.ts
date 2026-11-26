/**
 * 系统通知桥（HarmonyOS 移植新增）
 *
 * 作用：把 server 内部的通知（任务完成/失败）落到 `<data>/notify-queue.jsonl`，
 * 由 ArkTS 壳定时读取并调用 `notificationManager.publish` 发系统通知。
 *
 * 为什么用文件队列而不是直接调用：Node 跑在**独立线程**里（libnode 在子线程上），
 * 与 ArkTS 之间没有共享内存/回调通道；文件是唯一稳定、无权限要求的通道
 * （IPC/worker 在该沙箱下都试过不可行）。
 *
 * 只转发"值得打扰用户"的两类：完成 / 失败。其余（插件、更新提示等）留在应用内。
 */

import { getLogger } from '@core/logger'
import { setSystemNotificationHook } from '@core/notifications/notification-center'
import fs from 'node:fs'
import path from 'node:path'

const log = getLogger('server')

/** 与 ArkTS 侧约定的文件名 */
export const NOTIFY_QUEUE_FILE = 'notify-queue.jsonl'
const MAX_ENTRIES = 200
const MAX_BYTES = 256 * 1024

export interface NativeNotificationEntry {
  kind: string
  severity: string
  titleKey: string
  titleParams: Record<string, unknown> | null
  bodyKey: string | null
  bodyParams: Record<string, unknown> | null
  at: number
}

function isWorthNotifying(kind: string): boolean {
  const normalized = kind.toLowerCase()
  return (
    normalized.includes('complete') ||
    normalized.includes('error') ||
    normalized.includes('fail')
  )
}

/**
 * 安装通知桥。
 *
 * @param dataDir 端侧数据目录（queue 文件放在这里，ArkTS 能读到）
 * @returns 卸载函数（进程退出时可调用）
 */
export function installNativeNotificationBridge(dataDir: string): () => void {
  const queuePath = path.join(dataDir, NOTIFY_QUEUE_FILE)

  const append = (entry: NativeNotificationEntry): void => {
    if (!isWorthNotifying(entry.kind)) return
    try {
      let lines: string[] = []
      if (fs.existsSync(queuePath)) {
        const raw = fs.readFileSync(queuePath, 'utf8')
        lines = raw.split('\n').filter((line) => line.trim().length > 0)
      }
      lines.push(JSON.stringify(entry))
      if (lines.length > MAX_ENTRIES) {
        lines = lines.slice(-MAX_ENTRIES)
      }
      let payload = `${lines.join('\n')}\n`
      while (Buffer.byteLength(payload) > MAX_BYTES && lines.length > 1) {
        lines.shift()
        payload = `${lines.join('\n')}\n`
      }
      const tmp = `${queuePath}.tmp`
      fs.writeFileSync(tmp, payload)
      fs.renameSync(tmp, queuePath)
      // 端侧诊断（r29）：把"写了几条、写到哪"落日志。
      // 之前 ArkTS 侧收不到通知时，无法区分是 Node 没写、还是写到了别处。
      log.info(
        { kind: entry.kind, queuePath, entries: lines.length },
        'native notification queued'
      )
    } catch (error) {
      // 通知队列写失败绝不能影响下载主流程，但必须留痕（否则彻底无声）
      log.warn({ err: error, queuePath }, 'native notification queue write failed')
    }
  }

  setSystemNotificationHook((row) => {
    append({
      kind: row.kind,
      severity: row.severity,
      titleKey: row.titleKey,
      titleParams: row.titleParams,
      bodyKey: row.bodyKey,
      bodyParams: row.bodyParams,
      at: Date.now(),
    })
  })

  return () => {
    setSystemNotificationHook(null)
  }
}
