import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { getLogger } from '@core/logger'
import { AppError, ErrorCode } from '@shared/errors'
import {
  type EngineFeatureReport,
  type EngineProcessInfo,
  EngineProcessOwnership,
} from '@shared/types/engine'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import {
  Aria2ProcessInspector,
  type InspectedProcess,
} from './aria2-process-inspector'
import { Aria2ProcessOutput } from './aria2-process-output'
import { buildFeatureReport } from './feature-report'

const log = getLogger('aria2')

const OWNER_RECORD_VERSION = 1
const STDERR_TAIL_LIMIT = 32 * 1024
// 端侧：探针 execFile 在"上一次 aria2 刚被强杀"之后可能永不回调
// （HarmonyOS 应用域里子进程 exit/SIGCHLD 事件会丢），必须自带超时。
const PROBE_TIMEOUT_MS = 8_000
const OWNER_MARKER_PREFIXES = [
  '--conf-path=',
  '--save-session=',
  '--sqlite3-db-path=',
] as const
const REDACTED_ARG_PREFIXES = [
  '--rpc-secret=',
  '--all-proxy=',
  '--http-proxy-user=',
  '--http-proxy-passwd=',
  '--https-proxy-user=',
  '--https-proxy-passwd=',
  '--ftp-proxy-user=',
  '--ftp-proxy-passwd=',
  '--all-proxy-user=',
  '--all-proxy-passwd=',
] as const

const ownerRecordSchema = z.object({
  version: z.literal(OWNER_RECORD_VERSION),
  pid: z.number().int().positive(),
  binaryPath: z.string().min(1),
  rpcPort: z.number().int().min(1).max(65_535),
  argumentMarkers: z.array(z.string()).min(1),
  startedAt: z.number().int().positive(),
})

type OwnerRecord = z.infer<typeof ownerRecordSchema>

export interface Aria2ProcessManagerOptions {
  ownershipFilePath?: string
  inspector?: Aria2ProcessInspector
}

export interface ExpectedAria2Process {
  binaryPath: string
  args: string[]
}

function redactArgs(args: string[]): string[] {
  return args.map((arg) => {
    const prefix = REDACTED_ARG_PREFIXES.find((candidate) =>
      arg.startsWith(candidate)
    )
    return prefix ? `${prefix}<redacted>` : arg
  })
}

function redactSensitiveText(text: string, args: string[]): string {
  const sensitiveArgs = args.flatMap((arg) => {
    const prefix = REDACTED_ARG_PREFIXES.find((candidate) =>
      arg.startsWith(candidate)
    )
    return prefix ? [{ arg, prefix, value: arg.slice(prefix.length) }] : []
  })
  let redacted = text

  for (const { arg, prefix } of sensitiveArgs) {
    redacted = redacted.replaceAll(arg, `${prefix}<redacted>`)
  }
  for (const value of sensitiveArgs
    .map(({ value }) => value)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(value, '<redacted>')
  }
  return redacted
}

interface SpawnErrorDetails extends Error {
  code?: string
  errno?: string | number
  syscall?: string
  path?: string
  spawnargs?: unknown[]
}

function redactSpawnError(error: Error, fallbackArgs: string[]) {
  const details = error as SpawnErrorDetails
  const spawnargs = Array.isArray(details.spawnargs)
    ? details.spawnargs.filter((arg): arg is string => typeof arg === 'string')
    : fallbackArgs
  const candidateArgs = [...fallbackArgs, ...spawnargs]

  return {
    name: error.name,
    message: redactSensitiveText(error.message, candidateArgs),
    code: details.code,
    errno: details.errno,
    syscall: details.syscall,
    path: details.path,
    spawnargs: redactArgs(spawnargs),
  }
}

export class Aria2ProcessManager {
  private process: ChildProcess | null = null
  private running = false
  private readonly ownershipFilePath: string | null
  private readonly inspector: Aria2ProcessInspector
  private recentStderr = ''
  private outputGeneration = 0
  /** 最近一次成功 probe 的能力报告（key 含二进制 size+mtime，见 probeCacheKey）。 */
  private probeCache: { key: string; report: EngineFeatureReport } | null = null

  onExit: ((code: number | null, signal: string | null) => void) | null = null
  onError: ((err: Error) => void) | null = null

  constructor(options: Aria2ProcessManagerOptions = {}) {
    this.ownershipFilePath = options.ownershipFilePath ?? null
    this.inspector = options.inspector ?? new Aria2ProcessInspector()
  }

  async probe(binaryPath: string): Promise<EngineFeatureReport> {
    // 端侧修复（"重启引擎卡在 probe"）：
    // 真机日志显示 restart 的 stop 阶段过了以后，start 的第一阶段 probe
    // 永远不返回 —— 就是这里的 execFile 回调没到。二进制没变时没必要重复探，
    // 直接复用上一次成功的能力报告，重启就能正常往下走。
    const cacheKey = this.probeCacheKey(binaryPath)
    if (this.probeCache !== null && this.probeCache.key === cacheKey) {
      log.info({ binaryPath }, 'aria2 probe served from cache')
      return this.probeCache.report
    }

    try {
      const versionOutput = await this.execForOutput(binaryPath, ['--version'])
      const report = this.parseVersionOutput(versionOutput)
      if (!report) {
        throw new AppError(
          ErrorCode.EngineStartFailed,
          `Unrecognized aria2 version output from ${binaryPath}`
        )
      }
      this.probeCache = { key: cacheKey, report }
      return report
    } catch (error) {
      // 二进制变了（升级 HAP）导致 key 不匹配时也可能赶上 execFile 挂死；
      // 只要之前成功探过，就沿用那份报告继续启动，并在日志里明确说明。
      if (this.probeCache !== null) {
        log.warn(
          { binaryPath, err: error },
          'aria2 probe failed; reusing last successful feature report'
        )
        return this.probeCache.report
      }
      throw error
    }
  }

  private probeCacheKey(binaryPath: string): string {
    try {
      const stat = statSync(binaryPath)
      return `${binaryPath}|${String(stat.size)}|${String(stat.mtimeMs)}`
    } catch {
      return `${binaryPath}|unstattable`
    }
  }

  private execForOutput(binaryPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        fn()
      }
      const child = execFile(binaryPath, args, (err, stdout) => {
        if (err) {
          settle(() =>
            reject(
              new AppError(
                ErrorCode.EngineStartFailed,
                `Failed to probe aria2 binary at ${binaryPath}: ${err.message}`,
                err
              )
            )
          )
          return
        }
        settle(() => resolve(stdout))
      })
      timer = setTimeout(() => {
        settle(() =>
          reject(
            new AppError(
              ErrorCode.EngineStartFailed,
              `Timed out probing aria2 binary at ${binaryPath} after ${String(PROBE_TIMEOUT_MS)}ms`
            )
          )
        )
        // 超时的探针进程要自己收掉，否则下一轮 restart 还会接着被拖住。
        try {
          child.kill('SIGKILL')
        } catch {
          // 进程可能已经不存在；这里只是尽力而为
        }
      }, PROBE_TIMEOUT_MS)
    })
  }

  async spawn(
    binaryPath: string,
    args: string[],
    env?: NodeJS.ProcessEnv
  ): Promise<void> {
    this.recentStderr = ''
    const outputGeneration = ++this.outputGeneration
    const options: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    if (env) options.env = env
    const child = spawn(binaryPath, args, options)

    this.process = child
    this.running = true

    log.info(
      { pid: child.pid, args: redactArgs(args) },
      'aria2 process spawned'
    )

    if (child.pid) {
      await this.writeOwnershipRecord(child.pid, binaryPath, args).catch(
        (err) => {
          log.warn({ err }, 'failed to persist aria2 ownership record')
        }
      )
    }

    for (const stream of ['stdout', 'stderr'] as const) {
      const output = new Aria2ProcessOutput(
        stream,
        ({ level, fields, message }) => {
          if (
            stream === 'stderr' &&
            this.outputGeneration === outputGeneration
          ) {
            this.recentStderr = `${this.recentStderr}${fields.data}\n`.slice(
              -STDERR_TAIL_LIMIT
            )
          }
          log[level]({ enginePid: child.pid, ...fields }, message)
        },
        (text) => redactSensitiveText(text, args)
      )
      child[stream]?.on('data', (data: Buffer) => output.write(data))
      child[stream]?.on('end', () => output.end())
      // Pipes may still deliver output after exit. Close is the fallback for
      // streams destroyed without end and flushes an unterminated last line.
      child.on('close', () => output.end())
    }

    child.on('exit', (code, signal) => {
      log.info({ code, signal }, 'aria2 process exited')
      this.running = false
      this.process = null
      if (child.pid) void this.clearOwnershipRecord(child.pid)
      this.onExit?.(code, signal)
    })

    child.on('error', (err) => {
      log.error({ err: redactSpawnError(err, args) }, 'aria2 process error')
      this.running = false
      this.process = null
      if (child.pid) void this.clearOwnershipRecord(child.pid)
      this.onError?.(err)
    })
  }

  /**
   * 优雅停止 aria2，超时后强制 kill。
   *
   * 【两个必须修的历史 bug（HarmonyOS 移植时真机踩到）】
   *   1. 超时分支只 `child.kill('SIGKILL')` 却**不 resolve** Promise ——
   *      如果 SIGKILL 之后 `exit` 事件没到（进程已消失、或 kill 本身失败），
   *      Promise 永久 pending ⇒ "重启引擎"卡死在 stopping，界面毫无反应。
   *   2. `child.kill('SIGTERM')` 没 try-catch —— 抛 ESRCH/EPERM 时同样永久 pending。
   *
   * 现在：任何路径都保证 resolve（含兜底定时器），并把内部状态复位，
   * 避免后续 start() 认为旧进程还在。
   */
  gracefulStop(timeoutMs = 5000): Promise<void> {
    const child = this.process
    if (!child || !this.running) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      let settled = false
      const originalOnExit = this.onExit

      const finish = () => {
        if (settled) return
        settled = true
        this.onExit = originalOnExit
        resolve()
      }

      // 兜底 1：SIGKILL 之后再等一会儿，若 exit 事件仍未到就强制收尾
      let hardTimeout: ReturnType<typeof setTimeout> | null = null
      const forceFinish = () => {
        // 必须清掉硬兜底：否则它会在 timeoutMs+3s 时把 running/process 复位，
        // 而那时重启流程可能已经 spawn 了新引擎 —— 会把新进程的引用清空，
        // 导致新 aria2 变成没人管的孤儿进程。
        if (hardTimeout !== null) {
          clearTimeout(hardTimeout)
          hardTimeout = null
        }
        try {
          child.kill('SIGKILL')
        } catch (error) {
          // 进程可能已经不存在了；但也可能是**真机上 signal 投递失败**。
          // 之前这里静默 catch，导致"aria2 没死、重启一直卡住"完全无迹可寻。
          log.warn({ err: error, pid: child.pid }, 'aria2 SIGKILL delivery failed')
        }
        setTimeout(() => {
          // 复位内部状态：否则下一次 start() 会以为旧进程还在。
          // 只在 process 仍指向这个 child 时复位，避免误伤已经启动的新引擎。
          if (this.process === child) {
            this.running = false
            this.process = null
          }
          finish()
        }, 400)
      }

      const timeout = setTimeout(forceFinish, timeoutMs)
      // 兜底 2：即使 exit 一直不来，也不能让调用方永远等下去
      hardTimeout = setTimeout(() => {
        log.warn(
          { pid: child.pid, timeoutMs },
          'aria2 exit event never arrived; forcing internal state reset'
        )
        if (this.process === child) {
          this.running = false
          this.process = null
        }
        finish()
      }, timeoutMs + 3_000)

      this.onExit = (code, signal) => {
        clearTimeout(timeout)
        if (hardTimeout !== null) {
          clearTimeout(hardTimeout)
          hardTimeout = null
        }
        originalOnExit?.(code, signal)
        finish()
      }

      try {
        child.kill('SIGTERM')
        log.info({ pid: child.pid, timeoutMs }, 'aria2 SIGTERM sent')
      } catch (error) {
        // SIGTERM 发不出去（进程已退出/权限不足）→ 直接走强杀
        log.warn({ err: error, pid: child.pid }, 'aria2 SIGTERM delivery failed')
        clearTimeout(timeout)
        forceFinish()
      }
    })
  }

  kill(): void {
    if (!this.process || !this.running) return
    this.process.kill('SIGKILL')
  }

  isRunning(): boolean {
    return this.running
  }

  getPid(): number | null {
    return this.process?.pid ?? null
  }

  /** Last bounded stderr tail from the current or most recent spawn attempt. */
  getRecentStderr(): string {
    return this.recentStderr
  }

  async inspectPort(
    port: number,
    expected: ExpectedAria2Process
  ): Promise<EngineProcessInfo | null> {
    const inspected = await this.inspector.inspectListeningPort(port)
    if (!inspected) return null

    const currentPid = this.getPid()
    if (this.running && currentPid === inspected.pid) {
      return this.toProcessInfo(
        inspected,
        EngineProcessOwnership.CurrentApp,
        true
      )
    }

    const record = await this.readOwnershipRecord()
    const executableMatches = this.executableMatches(
      inspected,
      expected.binaryPath
    )
    const launchFingerprintMatches = this.launchFingerprintMatches(
      inspected.commandLine,
      expected.args
    )
    const recordMatches =
      record?.pid === inspected.pid &&
      record.rpcPort === port &&
      this.samePath(record.binaryPath, expected.binaryPath) &&
      record.argumentMarkers.every((marker) => expected.args.includes(marker))
    const expectedUsesRpcSecret = expected.args.some((arg) =>
      arg.startsWith('--rpc-secret=')
    )
    // A private launch secret can authenticate a legacy orphan from the
    // bundled executable alone. In explicit no-token mode there is no private
    // marker, so require the mode-0600 ownership record before termination.
    const identityMatches =
      recordMatches || (expectedUsesRpcSecret && executableMatches)

    if (
      this.isAria2(inspected) &&
      identityMatches &&
      launchFingerprintMatches
    ) {
      return this.toProcessInfo(
        inspected,
        EngineProcessOwnership.VerifiedOrphan,
        true
      )
    }

    if (this.isAria2(inspected)) {
      return this.toProcessInfo(
        inspected,
        EngineProcessOwnership.ExternalAria2,
        false
      )
    }

    const ownership =
      inspected.name === 'unknown'
        ? EngineProcessOwnership.Unknown
        : EngineProcessOwnership.Other
    return this.toProcessInfo(inspected, ownership, false)
  }

  async forceTerminateVerified(
    expectedPid: number,
    port: number,
    expected: ExpectedAria2Process
  ): Promise<void> {
    const processInfo = await this.inspectPort(port, expected)
    if (
      !processInfo ||
      processInfo.pid !== expectedPid ||
      !processInfo.safeToTerminate
    ) {
      throw new AppError(
        ErrorCode.EngineProcessOwnershipUnverified,
        'The process changed or is not verified as Motrix-owned'
      )
    }

    if (
      processInfo.ownership === EngineProcessOwnership.CurrentApp &&
      this.getPid() === expectedPid
    ) {
      this.kill()
    } else {
      this.inspector.forceTerminate(expectedPid)
    }

    const deadline = Date.now() + 5_000
    while (this.inspector.isAlive(expectedPid) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    if (this.inspector.isAlive(expectedPid)) {
      throw new AppError(
        ErrorCode.EngineProcessTerminationFailed,
        `aria2 process ${expectedPid} did not exit after force termination`
      )
    }
    await this.clearOwnershipRecord(expectedPid)
  }

  private toProcessInfo(
    inspected: InspectedProcess,
    ownership: EngineProcessOwnership,
    safeToTerminate: boolean
  ): EngineProcessInfo {
    return {
      pid: inspected.pid,
      name: inspected.name,
      executableName: inspected.executablePath
        ? path.basename(inspected.executablePath)
        : null,
      ownership,
      safeToTerminate,
    }
  }

  private isAria2(inspected: InspectedProcess): boolean {
    return [inspected.name, inspected.executablePath ?? ''].some((value) =>
      /(^|[/\\])aria2c(?:\.exe)?$/i.test(value)
    )
  }

  private executableMatches(
    inspected: InspectedProcess,
    expectedPath: string
  ): boolean {
    if (inspected.executablePath) {
      return this.samePath(inspected.executablePath, expectedPath)
    }
    return inspected.commandLine?.includes(expectedPath) ?? false
  }

  private launchFingerprintMatches(
    commandLine: string | null,
    expectedArgs: string[]
  ): boolean {
    if (!commandLine) return false
    const markerMatches = this.ownerMarkers(expectedArgs).filter((marker) =>
      commandLine.includes(marker)
    ).length
    const secret = expectedArgs.find((arg) => arg.startsWith('--rpc-secret='))
    const authenticationModeMatches = secret
      ? commandLine.includes(secret)
      : !/(?:^|[\s"'])--rpc-secret(?:=|\s)/.test(commandLine)
    return markerMatches >= 2 && authenticationModeMatches
  }

  private samePath(left: string, right: string): boolean {
    const normalize = (value: string) => {
      const normalized = path.normalize(value)
      return process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized
    }
    return normalize(left) === normalize(right)
  }

  private ownerMarkers(args: string[]): string[] {
    return args.filter((arg) =>
      OWNER_MARKER_PREFIXES.some((prefix) => arg.startsWith(prefix))
    )
  }

  private async writeOwnershipRecord(
    pid: number,
    binaryPath: string,
    args: string[]
  ): Promise<void> {
    if (!this.ownershipFilePath) return
    const portArg = args.find((arg) => arg.startsWith('--rpc-listen-port='))
    const rpcPort = Number(portArg?.slice('--rpc-listen-port='.length))
    const record = ownerRecordSchema.parse({
      version: OWNER_RECORD_VERSION,
      pid,
      binaryPath,
      rpcPort,
      argumentMarkers: this.ownerMarkers(args),
      startedAt: Date.now(),
    })
    await writeFileAtomic(this.ownershipFilePath, JSON.stringify(record), {
      mode: 0o600,
    })
  }

  private async readOwnershipRecord(): Promise<OwnerRecord | null> {
    if (!this.ownershipFilePath) return null
    try {
      const parsed = JSON.parse(await readFile(this.ownershipFilePath, 'utf8'))
      const result = ownerRecordSchema.safeParse(parsed)
      return result.success ? result.data : null
    } catch {
      return null
    }
  }

  private async clearOwnershipRecord(expectedPid: number): Promise<void> {
    if (!this.ownershipFilePath) return
    const current = await this.readOwnershipRecord()
    if (current && current.pid !== expectedPid) return
    await unlink(this.ownershipFilePath).catch(() => {})
  }

  private parseVersionOutput(stdout: string): EngineFeatureReport | null {
    const versionMatch = stdout.match(/aria2 version (\S+)/)
    if (!versionMatch) return null
    const version = versionMatch[1]

    const featuresMatch = stdout.match(/Enabled Features:\s*(.+)/)
    const features = featuresMatch
      ? featuresMatch[1].split(',').map((f) => f.trim())
      : []

    return buildFeatureReport(version, features)
  }
}
