import path from 'node:path'
import { getLogger } from '@core/logger'
import type { AppliedDownloadProxyPolicy } from '@core/proxy/applied-download-proxy-policy'
import {
  extractAria2ProxyCredentials,
  stripAria2ProxyCredentials,
} from '@core/proxy/aria2-proxy-routing'
import type { ProxyBridgeResolver } from '@core/proxy/proxy-bridge-manager'
import type { Aria2ProxyOptions } from '@core/proxy/serializers'
import { ENGINE_RPC_PORT } from '@shared/constants'
import { AppError, ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import {
  type EngineCompatibilityWarningPayload,
  type EngineDiagnosticReport,
  type EngineFailureInfo,
  type EngineFailurePayload,
  EngineFailureReason,
  type EngineFeatureReport,
  EngineProcessOwnership,
  EngineRecoveryAction,
  EngineRecoveryRecommendation,
  type EngineRecoveryRequest,
  type EngineRecoveryResult,
  EngineState,
  type EngineStatusSnapshot,
} from '@shared/types/engine'
import type { EngineSettings } from '@shared/types/settings'
import type { EventBus } from '../events/event-bus'
import { probePrecise } from '../probe/disk-probe'
import type { SettingsManager } from '../settings/settings-manager'
import type { Aria2Adapter } from './aria2/aria2-adapter'
import type { Aria2ConfigBuilder } from './aria2/aria2-config-builder'
import type { Aria2ProcessManager } from './aria2/aria2-process-manager'
import type { Aria2RpcClient } from './aria2/aria2-rpc-client'
import { recoverAria2SessionIdentity } from './aria2/aria2-session-identity-recovery'
import { isSqliteCorruptionDiagnostic } from './aria2/aria2-sqlite-recovery'
import type { Aria2TrustStore } from './aria2/aria2-trust-store'
import { recommend } from './aria2/aria2-tuning'
import type { EngineStartupGuard } from './aria2/completed-task-startup-guard'
import {
  isMotrixFork,
  STANDARD_ARIA2_CONNECTION_LIMIT,
} from './aria2/feature-report'
import type { DirectResourceMetadataProfile } from './engine-adapter'
import type { EngineSessionRecoveryStore } from './engine-session-recovery'
import { checkPort, findAvailablePort } from './port-check'

const log = getLogger('engine')

/** How long task creation waits for the aria2 engine to become Ready
 *  before failing. Engine cold start = process spawn + RPC connect retry
 *  loop (~5s); 15s is a safe margin that still bounds a stuck engine. */
export const ENGINE_READY_TIMEOUT_MS = 15_000

const BACKOFF_BASE = 1_000
const BACKOFF_MAX = 30_000
const MAX_RESTARTS = 5
const HEALTH_CHECK_INTERVAL = 30_000
const MAX_CONSECUTIVE_FAILURES = 3

function sameProxyOptions(
  left: Aria2ProxyOptions | null,
  right: Aria2ProxyOptions | null
): boolean {
  if (left === null || right === null) return left === right
  return left.allProxy === right.allProxy && left.noProxy === right.noProxy
}

const HOT_ENGINE_OPTIONS = {
  maxConcurrentDownloads: 'max-concurrent-downloads',
  maxConnectionPerServer: 'max-connection-per-server',
  split: 'split',
  minSplitSize: 'min-split-size',
  userAgent: 'user-agent',
  connectTimeout: 'connect-timeout',
  socketTimeout: 'timeout',
  maxTries: 'max-tries',
  retryWait: 'retry-wait',
  lowestSpeedLimit: 'lowest-speed-limit',
  btMaxPeers: 'bt-max-peers',
  btEnableLpd: 'bt-enable-lpd',
  seedRatio: 'seed-ratio',
  remoteTime: 'remote-time',
} as const satisfies Partial<Record<keyof EngineSettings, string>>

function getBackoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE * 2 ** attempt, BACKOFF_MAX)
}

export class EngineSupervisor {
  private sessionRecoveryStore?: EngineSessionRecoveryStore
  private state: EngineState = EngineState.Stopped
  private featureReport: EngineFeatureReport | null = null
  private getEffectiveLimits:
    | (() => { download: number; upload: number })
    | null = null
  private binaryPath: string | null = null
  private restartAttempts = 0
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null
  private consecutiveFailures = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private stopping = false
  private suppressExitHandling = false
  private lastError: string | null = null
  private failure: EngineFailureInfo | null = null
  private lastStartArgs: string[] = []
  // Monotonic per-instance counter for EngineFailurePayload.incidentId.
  // Resets to 0 on every new EngineSupervisor (i.e. every boot) — it is
  // deliberately NOT persisted or derived from anything durable.
  private failureSeq = 0
  private sqliteFallbackActive = false
  private sqliteFallbackAttempted = false
  private restartPromise: Promise<void> | null = null
  private preReadyMaintenance: (() => Promise<void>) | null = null
  private startupGuard: EngineStartupGuard | null = null
  /**
   * HarmonyOS 移植：**实际**连着 RPC 的端口（可能因为顺延而不同于 settings 里的值）。
   * 重启时拿它判断"旧引擎的端口有没有释放"，比 settings 里的配置值可靠。
   */
  private activePort = 0
  /** 最近一次 doStart() 走到了哪一步；重启看门狗超时时用它给出准确死因。 */
  private lastStartStage = 'idle'

  constructor(
    private eventBus: EventBus,
    private settingsManager: SettingsManager,
    private processManager: Aria2ProcessManager,
    private configBuilder: Aria2ConfigBuilder,
    private trustStore: Aria2TrustStore,
    private rpcClient: Aria2RpcClient,
    private adapter: Aria2Adapter,
    private proxyBridge: Pick<ProxyBridgeResolver, 'resolveForDownload'>,
    private appliedDownloadProxyPolicy?: Pick<
      AppliedDownloadProxyPolicy,
      'commit' | 'markUnavailable'
    > &
      Partial<Pick<AppliedDownloadProxyPolicy, 'publishStartupRoute'>>
  ) {
    // Wire up process exit handler
    this.processManager.onExit = (code, _signal) => {
      if (this.stopping || this.suppressExitHandling) return
      if (this.state === EngineState.Ready) {
        this.handleUnexpectedExit(code)
      }
    }
  }

  getState(): EngineState {
    return this.state
  }

  getFeatureReport(): EngineFeatureReport | null {
    return this.featureReport
  }

  getLastError(): string | null {
    return this.lastError
  }

  getStatus(): EngineStatusSnapshot {
    return {
      state: this.state,
      featureReport: this.featureReport,
      failure: this.failure,
      managedPid: this.processManager.isRunning()
        ? this.processManager.getPid()
        : null,
    }
  }

  async start(binaryPath: string): Promise<void> {
    this.stopping = false
    this.binaryPath = binaryPath
    this.restartAttempts = 0
    this.sqliteFallbackActive = false
    this.sqliteFallbackAttempted = false
    await this.doStart()
  }

  restart(): Promise<void> {
    if (this.restartPromise) return this.restartPromise
    if (!this.binaryPath) {
      return Promise.reject(
        new Error('EngineSupervisor.restart called before start')
      )
    }
    const path = this.binaryPath
    const restartPromise = this.performRestart(path).finally(() => {
      if (this.restartPromise === restartPromise) {
        this.restartPromise = null
      }
    })
    this.restartPromise = restartPromise
    return restartPromise
  }

  private async performRestart(path: string): Promise<void> {
    // 记旧端口：重启后要确认它真的被释放了
    let previousPort = this.activePort
    if (previousPort <= 0) {
      try {
        previousPort = this.settingsManager.getEngine().rpcPort
      } catch {
        previousPort = 0
      }
    }
    const startedAt = Date.now()
    log.info({ previousPort }, 'engine restart requested')

    // ── stop：这里**必须短超时**。
    // 真机实测：用户点「立即重启」后界面毫无反应，日志只有 requested、没有 finished。
    // 原因是 stop() 内部的 gracefulStop(30_000) —— aria2 若不响应 SIGTERM 要等满 30 秒，
    // 用户早就以为"没反应"了。重启场景不需要等这么久落盘（session 每 15s 也在存）。
    log.info('engine restart: stopping')
    // 双保险：即便进程管理器内部又出现"永不 resolve"的路径，
    // 这里也不会让整次重启卡死（8 秒后放弃等待、继续往下走）。
    await Promise.race([
      this.stopForRestart(),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          log.warn('engine restart: stop hard timeout, continuing anyway')
          resolve()
        }, 8_000)
      }),
    ])
    log.info({ elapsedMs: Date.now() - startedAt }, 'engine restart: stopped')

    // 等端口真正释放：stop() 在 aria2 已经不在时立即返回，但端口可能还被内核 hold
    // 一小会儿（TIME_WAIT / 旧进程正在退出）。不等它 start 会撞端口检查。
    if (previousPort > 0) {
      const deadline = Date.now() + 1_500
      for (;;) {
        const free = await checkPort(previousPort)
        if (free) break
        if (Date.now() >= deadline) {
          log.warn({ previousPort }, 'engine restart: port still busy, will shift if needed')
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      log.info('engine restart: port released')
    }

    log.info('engine restart: starting')
    // 看门狗：上一版真机日志停在 'engine restart: starting' 之后**再无任何输出**，
    // 界面就一直转圈。这里给整次启动套上限；超时不仅报错，还带上
    // lastStartStage —— 下次一看日志就知道是哪个 await 卡住了。
    let startSettled = false
    let startWatchdog: ReturnType<typeof setTimeout> | null = null
    const startTimeout = new Promise<never>((_, reject) => {
      startWatchdog = setTimeout(() => {
        if (startSettled) return
        log.error(
          { stage: this.lastStartStage, elapsedMs: Date.now() - startedAt },
          'engine restart: start timed out'
        )
        reject(
          new Error(
            `下载引擎启动超时（卡在阶段 ${this.lastStartStage}）`
          )
        )
      }, 30_000)
    })
    try {
      await Promise.race([this.start(path), startTimeout])
    } finally {
      startSettled = true
      if (startWatchdog !== null) clearTimeout(startWatchdog)
    }
    log.info(
      { state: this.state, elapsedMs: Date.now() - startedAt },
      'engine restart finished'
    )

    // ★ 校验最终状态：start() 内部失败时**不会抛错**（它把状态设成 Failed 就返回），
    //   所以这里必须自己检查，否则 UI 会以为"重启成功"、实际引擎没起来
    //   （真机表现：首页显示"就绪"、诊断显示"无法运行"这种自相矛盾的状态）。
    if (this.state !== EngineState.Ready) {
      const reason = this.lastError ?? '未知原因'
      log.error(
        { state: this.state, reason, elapsedMs: Date.now() - startedAt },
        'engine restart did not reach Ready'
      )
      throw new Error(`下载引擎重启失败（状态 ${this.state}）：${reason}`)
    }
  }

  /**
   * 重启专用的 stop：与 stop() 完全一致，只把 gracefulStop 的 30s 收到 6s。
   *
   * 为什么单独一份而不是给 stop() 加参数：stop() 在**退出应用**时要留足时间让
   * aria2 落盘 session（30s 是有意为之），重启场景不需要那么久。
   */
  private async stopForRestart(): Promise<void> {
    this.prepareForShutdown()
    if (this.processManager.isRunning()) {
      try {
        await this.processManager.gracefulStop(3_000)
      } catch (error) {
        log.warn({ err: error }, 'engine restart: graceful stop failed, forcing kill')
        try {
          this.processManager.kill()
        } catch {
          // 忽略
        }
      }
    }
    this.rpcClient.disconnect()
    this.activePort = 0
    this.setState(EngineState.Stopped)
  }

  /**
   * 包一层启动阶段：把阶段名记到 lastStartStage，并在**卡住**时也留下日志。
   *
   * 为什么要"卡住也留日志"：真机上 restart 卡死时日志停在 'engine restart: starting'，
   * 之后什么都没有，完全无法定位是 probe / 配置 / 端口 / spawn / RPC 哪一步。
   * 这里 5 秒还没返回就先 warn 一条（不等它结束），后面靠看门狗把阶段名抛出来。
   */
  private async stage<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    this.lastStartStage = name
    const startedAt = Date.now()
    const slowTimer = setTimeout(() => {
      log.warn({ stage: name }, 'engine start stage still running after 5s')
    }, 5_000)
    try {
      const result = await fn()
      const ms = Date.now() - startedAt
      if (ms > 500) log.info({ stage: name, ms }, 'engine start stage slow')
      return result
    } catch (error) {
      log.error({ stage: name, ms: Date.now() - startedAt, err: error }, 'engine start stage failed')
      throw error
    } finally {
      clearTimeout(slowTimer)
    }
  }

  /**
   * 端侧补丁：RPC 端口被占时**顺延**而不是 fatal。
   *
   * 上游 doStart() 端口被占时直接 EngineState.Failed + PortConflict 事件、没有重试。
   * 真机最常见的场景是"上次被强杀、aria2 子进程成了孤儿还赖在端口上"，
   * 用户看到的是"引擎起不来 / 重启一直转圈"。这里挑下一个空闲端口，
   * 尽量写回 settings（这样 UI 显示的端口也是真的）；写不回去也能照常跑。
   */
  private async ensureRpcPortAvailable(
    settings: EngineSettings
  ): Promise<EngineSettings> {
    if (await checkPort(settings.rpcPort)) return settings
    const nextPort = await findAvailablePort(settings.rpcPort + 1, 20)
    if (nextPort === null) {
      // 找不到空闲端口：沿用原值，让后面的失败路径给出准确诊断
      return settings
    }
    log.warn(
      { from: settings.rpcPort, to: nextPort },
      'engine rpc port busy, shifted to a free port'
    )
    try {
      await this.settingsManager.update({ engine: { rpcPort: nextPort } })
    } catch (error) {
      log.warn({ err: error }, 'failed to persist shifted rpc port; runtime port only')
    }
    return { ...settings, rpcPort: nextPort }
  }

  setEffectiveLimitsProvider(
    fn: () => { download: number; upload: number }
  ): void {
    this.getEffectiveLimits = fn
  }

  /** Required reconciliation runs under a paused startup, before Ready. */
  setStartupGuard(guard: EngineStartupGuard): void {
    this.startupGuard = guard
  }

  setSessionRecoveryStore(store: EngineSessionRecoveryStore): void {
    this.sessionRecoveryStore = store
  }

  /** Register best-effort engine maintenance that runs after RPC connects but before Ready. */
  setPreReadyMaintenance(maintenance: () => Promise<void>): void {
    this.preReadyMaintenance = maintenance
  }

  /**
   * HOT-update the aria2 speed limits via `aria2.changeGlobalOption`. No-op
   * when the engine is not Ready (cold start picks up limits via `buildArgs`).
   */
  async applySpeedLimits(limits: {
    download: number
    upload: number
  }): Promise<void> {
    if (this.state !== EngineState.Ready) return
    await this.rpcClient.changeGlobalOption({
      'max-overall-download-limit': String(limits.download),
      'max-overall-upload-limit': String(limits.upload),
    })
  }

  /**
   * HOT-update the aria2 DNS resolver via `aria2.changeGlobalOption`.
   * No-op when the engine is not Ready (cold start picks up the value via
   * `buildArgs`). Applies to new and waiting downloads only — active
   * downloads keep the resolver they started with.
   */
  async applyAsyncDns(asyncDns: boolean): Promise<void> {
    if (this.state !== EngineState.Ready) return
    await this.rpcClient.changeGlobalOption({
      'async-dns': String(asyncDns),
    })
  }

  /**
   * HOT-update the default directory inherited by downloads created directly
   * through aria2 JSON-RPC. Motrix-owned task creation continues to pass its
   * selected directory per task.
   */
  async applyDefaultSaveDir(dir: string): Promise<void> {
    if (this.state !== EngineState.Ready) return
    await this.rpcClient.changeGlobalOption({ dir })
  }

  /** HOT-update changed runtime engine settings without restarting aria2. */
  async applyEngineSettings(
    previous: EngineSettings,
    next: EngineSettings
  ): Promise<void> {
    const persistedNext = await this.persistCompatibilityLimits(next)
    if (this.state !== EngineState.Ready) return

    const compatiblePrevious = this.applyCompatibilityLimits(previous)
    const compatibleNext = this.applyCompatibilityLimits(persistedNext)
    const params: Record<string, string> = {}
    for (const [key, option] of Object.entries(HOT_ENGINE_OPTIONS) as Array<
      [keyof typeof HOT_ENGINE_OPTIONS, string]
    >) {
      if (compatiblePrevious[key] !== compatibleNext[key]) {
        params[option] = String(compatibleNext[key])
      }
    }
    if (Object.keys(params).length === 0) return
    await this.rpcClient.changeGlobalOption(params)
  }

  private applyCompatibilityLimits(settings: EngineSettings): EngineSettings {
    const report = this.featureReport
    if (!report || isMotrixFork(report)) return settings

    return {
      ...settings,
      maxConnectionPerServer: Math.min(
        settings.maxConnectionPerServer,
        STANDARD_ARIA2_CONNECTION_LIMIT
      ),
      split: Math.min(settings.split, STANDARD_ARIA2_CONNECTION_LIMIT),
    }
  }

  private async persistCompatibilityLimits(
    settings: EngineSettings
  ): Promise<EngineSettings> {
    const compatible = this.applyCompatibilityLimits(settings)
    if (
      compatible.maxConnectionPerServer === settings.maxConnectionPerServer &&
      compatible.split === settings.split
    ) {
      return settings
    }

    const persisted: EngineSettings = {
      ...compatible,
      // Named profiles re-apply their fixed values during validation. Move
      // the adjusted settings to custom so 16 remains the durable truth.
      performanceProfile: 'custom',
    }
    try {
      await this.settingsManager.update({
        engine: {
          performanceProfile: persisted.performanceProfile,
          maxConnectionPerServer: persisted.maxConnectionPerServer,
          split: persisted.split,
        },
      })
    } catch (error) {
      // A settings write failure must not revive the original startup crash.
      // The in-memory compatibility values still let this engine run safely.
      log.warn(
        { err: error },
        'failed to persist aria2 compatibility limits; using runtime limits'
      )
      return compatible
    }
    return persisted
  }

  private async resolveRuntimeEngineSettings(
    settings: EngineSettings
  ): Promise<EngineSettings> {
    if (settings.performanceProfile !== 'auto') return settings

    const downloadPath = this.settingsManager.getApp().defaultSaveDir
    try {
      const probe = await probePrecise(downloadPath)
      const tuning = recommend(probe, null)
      return {
        ...settings,
        diskCache: tuning.diskCache,
        split: tuning.split,
        minSplitSize: tuning.minSplitSize,
      }
    } catch (error) {
      log.warn(
        { err: error, downloadPath },
        'automatic performance probe failed; using profile defaults'
      )
      return settings
    }
  }

  /**
   * HOT-update the aria2 proxy via `aria2.changeGlobalOption`. No-op when
   * the engine is not Ready (cold start picks up proxy via `buildArgs`).
   * Pass `null` to clear the proxy (sends empty strings, which aria2
   * treats as "no proxy" at runtime).
   */
  async applyProxyChange(
    opts: { allProxy: string; noProxy: string } | null
  ): Promise<boolean> {
    if (this.state !== EngineState.Ready) return false
    await this.writeGlobalProxyOptions(opts)
    return true
  }

  private async writeGlobalProxyOptions(
    opts: Aria2ProxyOptions | null
  ): Promise<void> {
    const proxyCredentials = opts
      ? extractAria2ProxyCredentials(opts.allProxy)
      : { username: '', password: '' }
    const proxyEndpoint = opts ? stripAria2ProxyCredentials(opts.allProxy) : ''
    if (!proxyCredentials || proxyEndpoint === null) {
      throw new TypeError('Unsupported aria2 proxy credentials')
    }
    const params = {
      'all-proxy': proxyEndpoint,
      'http-proxy': '',
      'http-proxy-user': '',
      'http-proxy-passwd': '',
      'https-proxy': '',
      'https-proxy-user': '',
      'https-proxy-passwd': '',
      'ftp-proxy': '',
      'ftp-proxy-user': '',
      'ftp-proxy-passwd': '',
      'all-proxy-user': proxyCredentials.username,
      'all-proxy-passwd': proxyCredentials.password,
      'no-proxy': opts?.noProxy ?? '',
      'proxy-method': 'get',
    }
    await this.rpcClient.changeGlobalOption(params)
  }

  /**
   * Synchronously fence process-exit handling before asynchronous app cleanup.
   * Windows can terminate child processes as soon as session end begins, so
   * waiting until stop() reaches gracefulStop() can misclassify that expected
   * exit as an engine crash.
   */
  prepareForShutdown(): void {
    this.stopping = true
    this.stopHealthCheck()
    this.clearRestartTimer()
  }

  async stop(): Promise<void> {
    this.prepareForShutdown()

    if (this.processManager.isRunning()) {
      // SIGTERM aria2 directly. Its signal handler sets
      // globalHaltRequested, afterEachIteration() calls requestHalt(), the
      // run loop exits, onEndOfRun() flushes piece progress to the SQLite
      // DB (WAL fsync) and getResult() writes the final session — both the
      // text backend (--save-session=) and the DB backend
      // (--enable-sqlite3-persistence=true) when configured.
      //
      // We do NOT call aria2.shutdown (adds 3s scheduling delay; SIGTERM
      // is equivalent and immediate). We do NOT preemptively call
      // saveSession either — the signal handler covers both backends and
      // calling it from here would race the run-loop teardown.
      //
      // Timeout is 30s, up from 5s, to cover SQLite WAL commit + fsync
      // for the active task table on large queues.
      await this.processManager.gracefulStop(30_000)
    }
    this.rpcClient.disconnect()
    this.activePort = 0

    this.setState(EngineState.Stopped)
    // NOTE: stopping stays true — prevents doStart() from spawning a new
    // process after stop() returns but before the Electron process exits.
    // It is reset in start() when the engine is explicitly restarted.
  }

  private async doStart(): Promise<void> {
    if (!this.binaryPath || this.stopping) return

    this.setState(EngineState.Starting)
    this.lastError = null
    this.failure = null

    let phase: 'probe' | 'config' | 'spawn' | 'rpc' = 'probe'
    let engineSettings: EngineSettings | null = null

    try {
      const featureReport = await this.stage('probe', () =>
        this.processManager.probe(this.binaryPath)
      )
      if (this.stopping) return

      this.featureReport = featureReport
      // The adapter's durable-remove trust gate reads its own featureReport,
      // and nothing calls adapter.connect() in production — inject the report
      // we just probed so the gate reflects the real engine version.
      this.adapter.setFeatureReport(featureReport)
      if (!isMotrixFork(featureReport)) {
        const payload: EngineCompatibilityWarningPayload = {
          version: featureReport.version,
          connectionLimit: STANDARD_ARIA2_CONNECTION_LIMIT,
        }
        this.eventBus.emit(Events.EngineCompatibilityWarning, payload)
      }

      // Step 2: Ensure config and build args
      phase = 'config'
      await this.stage('config', () => this.configBuilder.ensureUserConfig())
      if (this.stopping) return
      const processEnv = await this.stage('env', () =>
        this.trustStore.prepareEnvironment()
      )
      if (this.stopping) return

      // 阶段标记（这些步骤不是单个 await，用打点方式记录，卡住时日志能指到这里）
      this.lastStartStage = 'settings'
      const configuredEngineSettings = this.settingsManager.getEngine()
      const resolvedEngineSettings = this.applyCompatibilityLimits(
        await this.resolveRuntimeEngineSettings(
          await this.persistCompatibilityLimits(configuredEngineSettings)
        )
      )
      engineSettings = this.sqliteFallbackActive
        ? { ...resolvedEngineSettings, sqlite3Persistence: false }
        : resolvedEngineSettings
      // Aria2RpcClient is long-lived and caches its credential. Refresh it on
      // every start so an explicit settings rotation authenticates the first
      // RPC sent to the newly spawned aria2 process.
      this.rpcClient.setSecret(engineSettings.rpcSecret)
      // 端侧：端口被占要顺延（见 ensureRpcPortAvailable 注释）。
      // 必须在 buildArgs 之前改端口，否则 aria2 与 RPC 客户端端口不一致。
      engineSettings = await this.stage('port', () =>
        this.ensureRpcPortAvailable(engineSettings as EngineSettings)
      )
      this.lastStartStage = 'proxy'
      const configuredProxy = structuredClone(this.settingsManager.getProxy())
      const resolvedProxy =
        await this.proxyBridge.resolveForDownload(configuredProxy)
      if (this.stopping) return
      const defaultSaveDir = this.settingsManager.getApp().defaultSaveDir
      // Provider is wired by the shell (Task 8) before start() in production;
      // the { 0, 0 } (unlimited) fallback only fires in tests or if start()
      // runs before the controller attaches.
      const effective = this.getEffectiveLimits?.() ?? {
        download: 0,
        upload: 0,
      }
      const sqliteActive =
        featureReport.hasSqlitePersistence &&
        engineSettings.sqlite3Persistence === true
      const loadTextSession =
        !sqliteActive && (await this.configBuilder.hasSavedSession())
      if (this.stopping) return
      log.debug(
        {
          rpcPort: engineSettings.rpcPort,
          rpcSecretLength: engineSettings.rpcSecret.length,
        },
        'preparing aria2 RPC configuration'
      )
      const args = this.configBuilder.buildArgs(
        engineSettings,
        featureReport.hasSqlitePersistence,
        resolvedProxy,
        effective,
        defaultSaveDir,
        loadTextSession
      )
      this.lastStartArgs = args

      // Step 3: Port check
      const portAvailable = await checkPort(engineSettings.rpcPort)
      if (!portAvailable) {
        const processInfo = await this.processManager.inspectPort(
          engineSettings.rpcPort,
          { binaryPath: this.binaryPath, args }
        )
        this.recordFailure(
          EngineFailureReason.PortInUse,
          `RPC port ${engineSettings.rpcPort} is already in use`
        )
        this.eventBus.emit(Events.PortConflict, {
          port: engineSettings.rpcPort,
          process: processInfo,
        })
        this.setState(EngineState.Failed)
        return
      }

      // Repair known fork session identities only after the RPC ownership
      // check, and before the completed-task guard reads persisted run intent.
      if (sqliteActive) {
        this.lastStartStage = 'sqlite-recovery'
        const recovery = await recoverAria2SessionIdentity(
          this.configBuilder.resolveSqliteDbPath(engineSettings),
          () => !this.stopping && !this.processManager.isRunning(),
          this.sessionRecoveryStore
        )
        if (recovery)
          log.warn(recovery, 'recovered aria2 metadata task identities')
      }

      // Step 4: Spawn process (abort if stop() was called during earlier awaits)
      if (this.stopping) return
      phase = 'spawn'
      this.lastStartStage = 'guard'
      const guardedStartup = await this.startupGuard?.prepare(args)
      if (this.stopping) return
      const startArgs = guardedStartup?.args ?? args
      this.lastStartArgs = startArgs
      await this.stage('spawn', () =>
        this.processManager.spawn(this.binaryPath, startArgs, processEnv)
      )

      // Step 5: Connect RPC
      if (this.stopping) {
        await this.processManager.gracefulStop()
        return
      }
      phase = 'rpc'
      await this.stage('rpc', () =>
        this.rpcClient.connect(engineSettings.rpcPort)
      )
      // 记下真正连上的端口：重启时用它判断旧引擎端口是否释放
      this.activePort = engineSettings.rpcPort
      if (this.stopping) {
        this.rpcClient.disconnect()
        await this.processManager.gracefulStop()
        return
      }
      // Unlike best-effort maintenance, failure here must stop the paused
      // process. Otherwise a known completed GID can recreate deleted files.
      await guardedStartup?.reconcile(() => this.stopping)
      if (this.stopping) {
        this.rpcClient.disconnect()
        await this.processManager.gracefulStop()
        return
      }
      if (this.preReadyMaintenance) {
        try {
          await this.preReadyMaintenance()
        } catch (error) {
          // Startup reconciliation also runs after Ready. Maintenance narrows
          // the visibility/resume window but must not make aria2 unavailable.
          log.warn({ err: error }, 'pre-ready engine maintenance failed')
        }
        if (this.stopping) {
          this.rpcClient.disconnect()
          await this.processManager.gracefulStop()
          return
        }
      }
      // Raw JSON-RPC clients commonly omit per-task options. Seed the global
      // template so their new HTTP/FTP tasks retain aria2's historical Motrix
      // resume behavior. Motrix-owned recovery still overrides `continue`
      // explicitly per task where safety requires it.
      await this.rpcClient.changeGlobalOption({ continue: 'true' })
      // Inspect only a sanitized compatibility decision. Raw global options
      // can contain passwords, custom headers and cookie paths and must never
      // be cached on the adapter or published to task composition.
      let pendingMetadataProfile: DirectResourceMetadataProfile | null = null
      try {
        pendingMetadataProfile =
          typeof this.adapter.inspectDirectResourceMetadataProfile ===
          'function'
            ? await this.adapter.inspectDirectResourceMetadataProfile()
            : null
      } catch (error) {
        log.debug(
          { err: error },
          'aria2 HTTP metadata request profile inspection failed closed'
        )
      }

      // Step 6: Ready
      if (this.stopping) {
        this.rpcClient.disconnect()
        await this.processManager.gracefulStop()
        return
      }
      const publishReady = () => {
        this.adapter.setDirectResourceMetadataProfile?.(pendingMetadataProfile)
        this.setState(EngineState.Ready)
      }
      if (this.appliedDownloadProxyPolicy?.publishStartupRoute) {
        const published =
          await this.appliedDownloadProxyPolicy.publishStartupRoute(
            async () => {
              // A proxy update can be persisted after buildArgs() captured its
              // startup route but before aria2 connects. Re-resolve under the
              // policy writer and repair aria2 before publishing Ready.
              const latestConfiguredProxy = structuredClone(
                this.settingsManager.getProxy()
              )
              const latestResolvedProxy =
                await this.proxyBridge.resolveForDownload(latestConfiguredProxy)
              if (!sameProxyOptions(resolvedProxy, latestResolvedProxy)) {
                await this.writeGlobalProxyOptions(latestResolvedProxy)
              }
              return latestResolvedProxy
            },
            publishReady,
            () => !this.stopping
          )
        if (!published) return
      } else {
        this.appliedDownloadProxyPolicy?.commit(resolvedProxy)
        publishReady()
      }
      this.lastError = null
      this.failure = null
      this.restartAttempts = 0
      this.consecutiveFailures = 0
      this.startHealthCheck()
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      const stderr = this.processManager.getRecentStderr?.() ?? ''
      // Preserve the startup identity failure instead of its later connection
      // refusal. Only capture the fixed diagnostic, never raw task options.
      const gidConflict = stderr.match(
        /\bGID [0-9a-f]{16} is not unique\./i
      )?.[0]
      if (phase === 'rpc' && gidConflict) this.lastError = gidConflict

      // A process can be alive even though RPC connection failed. Always
      // tear down a process spawned by this supervisor before entering Failed;
      // otherwise stop() used to skip it and leave aria2 holding the port.
      if (this.processManager.isRunning()) {
        this.suppressExitHandling = true
        try {
          await this.processManager.gracefulStop(5_000)
        } catch (cleanupError) {
          log.warn({ err: cleanupError }, 'failed-start cleanup failed')
        } finally {
          this.suppressExitHandling = false
        }
      }
      this.rpcClient.disconnect()

      if (
        engineSettings &&
        (await this.tryActivateSqliteFallback(
          engineSettings,
          `${this.lastError}\n${stderr}`
        ))
      ) {
        this.setState(EngineState.Restarting)
        await this.doStart()
        return
      }

      const reason =
        phase === 'probe'
          ? EngineFailureReason.BinaryUnavailable
          : phase === 'spawn'
            ? EngineFailureReason.SpawnFailed
            : phase === 'rpc'
              ? EngineFailureReason.RpcUnavailable
              : EngineFailureReason.Unknown
      this.recordFailure(reason, this.lastError)
      log.error({ err: this.lastError }, 'start failed')
      this.setState(EngineState.Failed)
    }
  }

  private async tryActivateSqliteFallback(
    settings: EngineSettings,
    diagnostic: string
  ): Promise<boolean> {
    if (
      this.sqliteFallbackAttempted ||
      this.sqliteFallbackActive ||
      !this.featureReport?.hasSqlitePersistence ||
      !settings.sqlite3Persistence ||
      !isSqliteCorruptionDiagnostic(diagnostic)
    ) {
      return false
    }

    this.sqliteFallbackAttempted = true
    let quarantine: Awaited<
      ReturnType<Aria2ConfigBuilder['quarantineSqliteDatabase']>
    > | null = null
    try {
      quarantine = await this.configBuilder.quarantineSqliteDatabase(settings)
    } catch (error) {
      // Disabling the backend still gives the text session a chance to start.
      // Keep the original database untouched if the recoverable move failed.
      log.warn({ err: error }, 'failed to quarantine corrupt aria2 database')
    }

    this.sqliteFallbackActive = true
    try {
      await this.settingsManager.update({
        engine: { sqlite3Persistence: false },
      })
    } catch (error) {
      log.warn(
        { err: error },
        'failed to persist aria2 SQLite fallback setting; using runtime fallback'
      )
    }
    log.warn(
      {
        databasePath: quarantine?.databasePath,
        quarantinePaths: quarantine?.moved,
        textSessionAvailable: await this.configBuilder.hasSavedSession(),
      },
      'corrupt aria2 SQLite persistence quarantined; retrying with text session'
    )
    return true
  }

  private handleUnexpectedExit(code: number | null): void {
    this.stopHealthCheck()
    this.recordFailure(
      EngineFailureReason.UnexpectedExit,
      code === null
        ? 'aria2 exited unexpectedly'
        : `aria2 exited unexpectedly with code ${code}`
    )
    this.restartWithBackoff()
  }

  private restartWithBackoff(): void {
    if (this.restartAttempts >= MAX_RESTARTS) {
      if (!this.failure) {
        this.recordFailure(
          EngineFailureReason.Unknown,
          'aria2 restart attempts were exhausted'
        )
      }
      this.setState(EngineState.Failed)
      return
    }

    this.setState(EngineState.Restarting)
    const delay = getBackoffDelay(this.restartAttempts)
    this.restartAttempts++

    this.restartTimer = setTimeout(async () => {
      if (this.processManager.isRunning()) {
        this.suppressExitHandling = true
        try {
          await this.processManager.gracefulStop(5_000)
        } finally {
          this.suppressExitHandling = false
        }
      }
      this.rpcClient.disconnect()
      await this.doStart()
    }, delay)
  }

  private startHealthCheck(): void {
    this.consecutiveFailures = 0
    this.healthCheckTimer = setInterval(async () => {
      if (this.state !== EngineState.Ready) return

      try {
        await this.rpcClient.getVersion()
        this.consecutiveFailures = 0
      } catch {
        this.consecutiveFailures++
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.stopHealthCheck()
          this.recordFailure(
            EngineFailureReason.HealthCheckFailed,
            'aria2 stopped responding to health checks'
          )
          this.restartWithBackoff()
        }
      }
    }, HEALTH_CHECK_INTERVAL)
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private setState(newState: EngineState): void {
    const prev = this.state
    if (prev === newState) return
    this.state = newState

    if (newState !== EngineState.Ready) {
      this.adapter.setDirectResourceMetadataProfile?.(null)
      this.appliedDownloadProxyPolicy?.markUnavailable()
    }

    this.eventBus.emit(Events.EngineStateChanged, newState)

    if (prev === EngineState.Ready && newState !== EngineState.Ready) {
      this.eventBus.emit(Events.EngineDisconnected)
    }
    if (prev !== EngineState.Ready && newState === EngineState.Ready) {
      this.eventBus.emit(Events.EngineRecovered)
    }
  }

  async diagnose(): Promise<EngineDiagnosticReport> {
    const binaryPath = this.binaryPath
    const engineSettings = this.settingsManager.getEngine()
    let binaryAvailable = false
    let binaryVersion: string | null = null

    if (binaryPath) {
      try {
        const report = await this.processManager.probe(binaryPath)
        binaryAvailable = true
        binaryVersion = report.version
      } catch {
        // The report below carries the failed binary check.
      }
    }

    const portAvailable = await checkPort(engineSettings.rpcPort)
    const expected = this.expectedProcess()
    let processInfo =
      !portAvailable && expected
        ? await this.processManager.inspectPort(
            engineSettings.rpcPort,
            expected
          )
        : null
    if (
      !processInfo &&
      this.state === EngineState.Ready &&
      this.processManager.isRunning() &&
      this.processManager.getPid() !== null
    ) {
      processInfo = {
        // Checked above; the non-null assertion only bridges TS narrowing
        // across the second method call.
        pid: this.processManager.getPid() as number,
        name: binaryPath ? path.basename(binaryPath) : 'aria2c',
        executableName: binaryPath ? path.basename(binaryPath) : null,
        ownership: EngineProcessOwnership.CurrentApp,
        safeToTerminate: true,
      }
    }
    const expectedListener =
      this.state === EngineState.Ready &&
      processInfo?.ownership === EngineProcessOwnership.CurrentApp
    const canForceTerminate =
      this.state !== EngineState.Ready && Boolean(processInfo?.safeToTerminate)
    const canSwitchPort =
      this.state !== EngineState.Ready && !portAvailable && !canForceTerminate
    const canRetry =
      this.state !== EngineState.Ready && binaryAvailable && portAvailable
    const suggestedRpcPort = canSwitchPort
      ? await findAvailablePort(engineSettings.rpcPort + 1)
      : null
    const defaultRpcIsCurrent = engineSettings.rpcPort === ENGINE_RPC_PORT
    const defaultRpcAvailable = defaultRpcIsCurrent
      ? portAvailable
      : await checkPort(ENGINE_RPC_PORT)
    const defaultRpcProcess =
      !defaultRpcIsCurrent && !defaultRpcAvailable && expected
        ? await this.processManager.inspectPort(ENGINE_RPC_PORT, expected)
        : defaultRpcIsCurrent
          ? processInfo
          : null
    const defaultRpcRequiresTermination = Boolean(
      defaultRpcProcess?.safeToTerminate
    )
    const recommendation =
      this.state === EngineState.Ready
        ? EngineRecoveryRecommendation.None
        : canForceTerminate
          ? EngineRecoveryRecommendation.ForceTerminate
          : canSwitchPort
            ? EngineRecoveryRecommendation.SwitchPort
            : canRetry
              ? EngineRecoveryRecommendation.Retry
              : EngineRecoveryRecommendation.None

    return {
      ...this.getStatus(),
      generatedAt: Date.now(),
      binary: {
        name: binaryPath ? path.basename(binaryPath) : 'aria2c',
        available: binaryAvailable,
        version: binaryVersion,
      },
      rpc: {
        port: engineSettings.rpcPort,
        available: portAvailable,
        expectedListener,
        connection: this.rpcClient.getConnectionStatus(),
      },
      process: processInfo,
      defaultRpc: {
        port: ENGINE_RPC_PORT,
        isCurrent: defaultRpcIsCurrent,
        available: defaultRpcAvailable,
        process: defaultRpcProcess,
        canRestore:
          !defaultRpcIsCurrent &&
          (defaultRpcAvailable || defaultRpcRequiresTermination),
        requiresTermination: defaultRpcRequiresTermination,
      },
      suggestedRpcPort,
      canRetry,
      canForceTerminate,
      canSwitchPort: canSwitchPort && suggestedRpcPort !== null,
      recommendation,
    }
  }

  async recover(request: EngineRecoveryRequest): Promise<EngineRecoveryResult> {
    if (!this.binaryPath) {
      throw new AppError(
        ErrorCode.EngineStartFailed,
        'Engine recovery is unavailable before the first start attempt'
      )
    }

    const previousRpcPort = this.settingsManager.getEngine().rpcPort

    if (
      request.action === EngineRecoveryAction.RestoreDefaultPort &&
      previousRpcPort === ENGINE_RPC_PORT
    ) {
      return {
        ok: this.state === EngineState.Ready,
        previousRpcPort,
        rpcPort: previousRpcPort,
        status: this.getStatus(),
      }
    }

    if (request.action === EngineRecoveryAction.ForceTerminate) {
      const expected = this.expectedProcess()
      if (!expected || request.expectedPid === undefined) {
        throw new AppError(
          ErrorCode.EngineProcessOwnershipUnverified,
          'A verified aria2 process is required for force termination'
        )
      }
      await this.processManager.forceTerminateVerified(
        request.expectedPid,
        previousRpcPort,
        expected
      )
    }

    if (request.action === EngineRecoveryAction.SwitchPort) {
      const nextPort = await findAvailablePort(previousRpcPort + 1)
      if (nextPort === null) {
        throw new AppError(
          ErrorCode.EngineStartFailed,
          'No available RPC port was found'
        )
      }
      await this.settingsManager.update({ engine: { rpcPort: nextPort } })
    }

    if (request.action === EngineRecoveryAction.RestoreDefaultPort) {
      const defaultPortAvailable = await checkPort(ENGINE_RPC_PORT)
      if (!defaultPortAvailable) {
        const expected = this.expectedProcess()
        const processInfo = expected
          ? await this.processManager.inspectPort(ENGINE_RPC_PORT, expected)
          : null
        if (
          !expected ||
          !processInfo?.safeToTerminate ||
          request.expectedPid !== processInfo.pid
        ) {
          throw new AppError(
            ErrorCode.EngineProcessOwnershipUnverified,
            `Port ${ENGINE_RPC_PORT} is occupied by a process that Motrix cannot safely terminate`
          )
        }
        await this.processManager.forceTerminateVerified(
          processInfo.pid,
          ENGINE_RPC_PORT,
          expected
        )
      }
      await this.settingsManager.update({
        engine: { rpcPort: ENGINE_RPC_PORT },
      })
    }

    await this.restart()
    const rpcPort = this.settingsManager.getEngine().rpcPort
    return {
      ok: this.state === EngineState.Ready,
      previousRpcPort,
      rpcPort,
      status: this.getStatus(),
    }
  }

  private expectedProcess(): { binaryPath: string; args: string[] } | null {
    if (!this.binaryPath || this.lastStartArgs.length === 0) return null
    return { binaryPath: this.binaryPath, args: this.lastStartArgs }
  }

  private recordFailure(
    reason: EngineFailureReason,
    technicalMessage: string | null
  ): void {
    this.lastError = technicalMessage
    const occurredAt = Date.now()
    this.failure = {
      reason,
      occurredAt,
      technicalMessage,
    }
    const payload: EngineFailurePayload = {
      incidentId: `engine:${occurredAt}:${this.failureSeq++}`,
      reason,
      occurredAt,
      technicalMessage,
    }
    this.eventBus.emit(Events.EngineFailureOccurred, payload)
  }

  /**
   * Resolve once the engine is (or becomes) Ready; reject on Failed or after
   * `timeoutMs`. Used to gate task creation so cold-start requests wait for
   * the engine instead of hitting a not-yet-connected RPC socket. Always
   * removes its listener and clears its timer on settle.
   */
  async waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.state === EngineState.Ready) return
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const onState = (...args: unknown[]): void => {
        const next = args[0] as EngineState
        if (next !== EngineState.Ready && next !== EngineState.Failed) return
        clearTimeout(timer)
        this.eventBus.off(Events.EngineStateChanged, onState)
        if (next === EngineState.Ready) {
          resolve()
        } else {
          reject(
            new AppError(
              ErrorCode.EngineTimeout,
              'engine entered failed state while waiting for ready'
            )
          )
        }
      }
      timer = setTimeout(() => {
        this.eventBus.off(Events.EngineStateChanged, onState)
        reject(
          new AppError(
            ErrorCode.EngineTimeout,
            `engine not ready within ${timeoutMs}ms`
          )
        )
      }, timeoutMs)
      this.eventBus.on(Events.EngineStateChanged, onState)
    })
  }

  assertReady(): void {
    if (this.state !== EngineState.Ready) {
      throw new AppError(
        ErrorCode.EngineConnectionLost,
        `engine is not ready (${this.state})`
      )
    }
  }
}
