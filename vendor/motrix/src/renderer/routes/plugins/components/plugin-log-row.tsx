import { cn } from '@renderer/lib/utils'
import type { PluginLogEntry } from '@shared/types/plugin'

const LEVEL_CLASS: Record<PluginLogEntry['level'], string> = {
  trace: 'text-muted-foreground',
  debug: 'text-muted-foreground',
  info: 'text-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
  fatal: 'text-destructive font-semibold',
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/**
 * HarmonyOS 移植 r53：插件日志时间改为**本机时区**。
 *
 * 上游用的是 `toISOString().slice(11, 23)`——那是 UTC 时间；真机上北京时间会显示成
 * 比本地早 8 小时（用户会误以为日志时间错了）。改成用本地时间逐项拼，
 * `dateTime`/`title` 保留 ISO（无障碍与悬停提示仍是标准格式）。
 */
function formatTs(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
    d.getMilliseconds(),
    3
  )}`
}

export function PluginLogRow({ entry }: { entry: PluginLogEntry }) {
  const extraFields = Object.entries(entry).filter(
    ([k]) => !['ts', 'level', 'msg', 'entryId', 'logSequence'].includes(k)
  )
  return (
    <div className="grid grid-cols-[5.25rem_3.5rem_minmax(0,1fr)] items-start border-b border-border/50 px-3 py-2 font-mono text-[11px] leading-4 transition-colors last:border-b-0 hover:bg-muted/25">
      <time
        dateTime={new Date(entry.ts).toISOString()}
        title={new Date(entry.ts).toLocaleString()}
        className="tabular-nums text-muted-foreground"
      >
        {formatTs(entry.ts)}
      </time>
      <span
        className={cn(
          'font-semibold uppercase tracking-wide',
          LEVEL_CLASS[entry.level]
        )}
      >
        {entry.level}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words text-foreground">
        {entry.msg}
        {extraFields.length > 0 && (
          <span className="ms-2 text-muted-foreground">
            {extraFields
              .map(
                ([k, v]) =>
                  `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`
              )
              .join(' ')}
          </span>
        )}
      </span>
    </div>
  )
}
