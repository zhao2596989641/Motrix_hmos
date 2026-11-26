/**
 * MotrixHost —— 端侧 Node 运行时的 ArkTS 侧封装。
 *
 * 职责边界（不要在这里塞业务）：
 *   1. 决定端口、算出所有路径、组装 argv/env，交给 libmotrixhost；
 *   2. 等端口真的应答（TCP 探活，不用 @ohos.net.http —— 它对本机回环会受系统代理影响）；
 *   3. 读 host-ready.json（**必须校验 pid**）拿到会话 cookie，交给调用方注入 Web。
 *
 * 为什么就绪判定用 TCP 而不是 HTTP：
 *   参考宿主项目 实测（`docs/70` E37）：应用进程内的 `@ohos.net.http` 打 `127.0.0.1` 会全超时，
 *   因为系统代理设置会截走请求。TCP connect 不受影响。
 */

import { socket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { ConfigurationConstant } from '@kit.AbilityKit';
import { i18n } from '@kit.LocalizationKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import motrixhost from 'libmotrixhost.so';
import { claimPublicDownload, DownloadFolderClaim, probePathWritable } from './DownloadFolder';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-HOST';

/** 回环端口：首选 21420；被占就顺延（端口写进 host-ready.json，读侧不假设固定值）。 */
const PORT_PREFERRED = 21420;
const PORT_FALLBACK_TRIES = 16;
/** 等 server 就绪的上限：冷启动要解压/建库/起 aria2，给足时间。 */
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_INTERVAL_MS = 500;
/** host-ready.json 的 startedAt 早于"本次启动时刻"这么多毫秒，就认定是上一次进程留下的旧文件 */
const READY_FRESH_SKEW_MS = 5_000;
const READY_FILE = 'host-ready.json';
/** Node 侧 process.exit 被拦截时写的失败标记（见 scripts/host/main.mjs 的兜底层） */
const FAILED_FILE = 'host-failed.json';

export interface HostFailure {
  code: number;
  stage: string;
  at: number;
  reason: string;
}

export interface HostReady {
  pid: number;
  port: number;
  cookie: string;
  token: string;
  startedAt: number;
}

export interface StartOutcome {
  ok: boolean;
  note: string;
}

/**
 * 原生探针结果：本进程能不能申请**可执行匿名内存**（W^X）。
 *
 * 为什么问它（r49）：HarmonyOS 内核级管控禁止匿名内存可执行（r47 实测 errno=EINVAL），
 * 官方给的合法途径是受限 ACL 权限 `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`
 * （场景正是"应用内置 V8 等语言虚拟机"）。拿到权限后本进程可以 JIT，于是：
 *   · Node 不必再带 `--jitless`（V8 JIT + WebAssembly 可用，性能更好）；
 *   · 上游 QuickJS 插件沙箱（wasm）原样可用。
 * 没拿到（含用户开"坚盾守护模式"）就回退 `--jitless`，功能不受影响。
 */
export interface ExecMemoryProbe {
  execmemAllowed: boolean;
  mprotectRxErrno: number;
  mmapRwxErrno: number;
  pageSize: number;
}

export class MotrixHost {
  private readonly context: common.UIAbilityContext;
  private readonly sandboxHome: string;
  private readonly dataDir: string;
  private port: number = PORT_PREFERRED;
  private downloadClaim: DownloadFolderClaim | null = null;
  /** 本次启动的起始时刻：用来识别上一次进程遗留的 host-ready.json */
  private bootEpochMs: number = 0;
  private started: boolean = false;
  /** 本进程是否拿到可执行内存（JIT/WASM 可用）。只有 ACL 权限生效时为 true */
  private jitAvailable: boolean = false;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.sandboxHome = context.filesDir;
    this.dataDir = `${this.sandboxHome}/motrix`;
  }

  /** 本进程能否 JIT/WASM（ACL 权限生效时为 true；注入给渲染层的 pluginRuntime 用） */
  isJitAvailable(): boolean {
    return this.jitAvailable;
  }

  /** 数据目录（可写：db / settings / plugins / 日志） */
  get dataDirPath(): string {
    return this.dataDir;
  }

  /** app 根（resfile 解出的只读根） */
  private get appRoot(): string {
    return `${this.context.resourceDir}/app`;
  }

  /** 本次实际用的下载目录（认领成功=公共目录；失败=沙箱内 <data>/Downloads） */
  get downloadDir(): string {
    const claimed = this.downloadClaim;
    return claimed !== null && claimed.path.length > 0
      ? claimed.path
      : `${this.dataDir}/Downloads`;
  }

  /** 传给宿主的 MOTRIX_PUBLIC_DOWNLOAD（认领失败时为空数组 ⇒ 不设这一项） */
  private get pdfPublicDownload(): string[] {
    const claimed = this.downloadClaim;
    return claimed !== null && claimed.path.length > 0
      ? [`MOTRIX_PUBLIC_DOWNLOAD=${claimed.path}`]
      : [];
  }

  /**
   * 启动 Node 并等待 server 就绪。
   *
   * 幂等：进程内 Node 只能起一次（原生层会拒绝第二次），所以这里也记着 started。
   */
  async start(): Promise<StartOutcome> {
    if (this.started) {
      return { ok: true, note: 'Node 已在运行' };
    }
    this.ensureDirs();
    // r49：先问内核给不给可执行匿名内存，再决定 Node 用不用 --jitless。
    // 同步 NAPI，必须在**任何 await 之前**做完：EntryAbility 提前 preStart 时，
    // Index.aboutToAppear 要在构建注入脚本时就能拿到结论（决定 pluginRuntime）。
    this.jitAvailable = false;
    try {
      const probe = motrixhost.probeExecMemory() as ExecMemoryProbe;
      this.jitAvailable = probe !== undefined && probe !== null && probe.execmemAllowed === true;
      hilog.info(DOMAIN, TAG,
        'exec memory probe: jit=%{public}s (mprotectRxErrno=%{public}d mmapRwxErrno=%{public}d)',
        String(this.jitAvailable), probe.mprotectRxErrno, probe.mmapRwxErrno);
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(DOMAIN, TAG, 'exec memory probe failed（按不可用处理）: %{public}s', err.message);
    }
    this.bootEpochMs = Date.now();
    // ★ 上一次进程遗留的 host-ready.json 必须先处理掉：
    //   它的端口/ cookie 都是旧的（cookie 早就失效），而且 server 还没起来。
    //   不清掉就会立刻去加载 http://127.0.0.1:<旧端口>/ ⇒ ERR_CONNECTION_REFUSED，
    //   真机上表现为"卡在正在载入界面…"（2026-11-24 实测踩过）。
    this.dropStaleReady();
    // 上一次的失败标记不能影响本次判定（Node 自己也会清，这里双保险）
    this.clearFailureMarker();
    // 先认领用户可见的下载目录（DOWNLOAD 模式 picker），**再**起 Node：
    // 应用进程不能在公共 Download 根下 mkdir（EPERM），必须由 picker 建立归属；
    // 而宿主要把结果当 MOTRIX_PUBLIC_DOWNLOAD 传下去，所以顺序不能反。
    this.downloadClaim = await claimPublicDownload(this.context);
    hilog.info(DOMAIN, TAG, 'download folder: %{public}s (public=%{public}s)',
      this.downloadClaim.path, String(this.downloadClaim.isPublic));
    this.port = await this.resolvePort();

    const env = this.buildEnv(this.port);
    const argv: string[] = this.jitAvailable
      ? [
        // 拿到可执行内存权限：走 JIT（V8 优化编译 + WebAssembly 可用）。
        // Node 22 起 node:sqlite 需要它（我们有 libnode 自带 SQLite）
        '--experimental-sqlite',
        // 排到脚本路径**之前**：Node 把第一个非选项参数当脚本
        `${this.appRoot}/main.mjs`,
      ]
      : [
        // 没有权限（或用户开了"坚盾守护模式"）：不申请可写可执行内存，
        // 代价是 WebAssembly === undefined（插件沙箱不可用，见插件页横幅）
        '--jitless',
        '--experimental-sqlite',
        `${this.appRoot}/main.mjs`,
      ];
    hilog.info(DOMAIN, TAG, 'startHost port=%{public}d appRoot=%{public}s', this.port, this.appRoot);
    const result = motrixhost.startHost(argv, env);
    hilog.info(DOMAIN, TAG, 'startHost returned started=%{public}s note=%{public}s',
      String(result.started), String(result.note));
    if (!result.started) {
      return { ok: false, note: String(result.note) };
    }
    this.started = true;
    return { ok: true, note: String(result.note) };
  }

  /** Node 线程还活着吗（进程级事实） */
  isRunning(): boolean {
    return motrixhost.isHostRunning();
  }

  /**
   * 等 host-ready.json 出现且 pid 对得上，然后返回内容。
   *
   * 为什么一定要校验 pid：应用重启窗口里，上一次进程写的 host-ready.json 还在，
   * 里面的 cookie 早就失效；直接拿去注入 Web 会得到"登录了但一直 401"。
   */
  async waitReady(): Promise<HostReady> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const readyPath = `${this.dataDir}/${READY_FILE}`;
    let lastNote = '';
    while (Date.now() < deadline) {
      // ★ 先看失败标记：Node 侧的 process.exit 已被拦截，应用不会消失；
      //   这里要把"哪一步死的 + exit code"带回 UI，而不是傻等 120s。
      const failure = this.readFailureMarker();
      if (failure !== null) {
        const stage = typeof failure.stage === 'string' && failure.stage.length > 0
          ? failure.stage
          : '启动';
        throw new Error(
          `Motrix 内核在「${stage}」阶段退出（exit code ${failure.code}）—— 详情见下方日志`
        );
      }
      if (!motrixhost.isHostRunning()) {
        throw new Error('Node 线程已退出（详情看 node-output.log）');
      }
      const parsed = this.tryReadReady(readyPath);
      if (parsed !== null) {
        // 文件新鲜还不够：端口必须真的有人监听（server listen 完成前会有极短窗口）
        if (await this.portAnswers(parsed.port)) {
          return parsed;
        }
        lastNote = `host-ready.json 已写出，但端口 ${parsed.port} 还没开始监听`;
      } else {
        lastNote = '尚未写出新的 host-ready.json';
      }
      await sleep(READY_POLL_INTERVAL_MS);
    }
    throw new Error(`等待 server 就绪超时（${READY_TIMEOUT_MS}ms）：${lastNote}`);
  }

  /** 端口是否已被监听（TCP connect 探活） */
  async portAnswers(port: number): Promise<boolean> {
    const tcp: socket.TCPSocket = socket.constructTCPSocketInstance();
    try {
      await tcp.connect({
        address: { address: '127.0.0.1', port },
        timeout: READY_POLL_INTERVAL_MS,
      });
      return true;
    } catch (error) {
      return false;
    } finally {
      tcp.close().catch((error: BusinessError) => {
        hilog.debug(DOMAIN, TAG, 'close probe socket failed: %{public}s', error.message);
      });
    }
  }

  /** 停止：写文件信号，让端侧脚本自己退出（进程内 Node 无法从外部线程停） */
  requestStop(): void {
    try {
      const stopPath = `${this.sandboxHome}/host-stop-request`;
      const file = fs.openSync(stopPath, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, `${Date.now()} arkts`);
      fs.closeSync(file);
    } catch (error) {
      hilog.warn(DOMAIN, TAG, '写 host-stop-request 失败');
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private ensureDirs(): void {
    for (const dir of [this.dataDir, `${this.dataDir}/tmp`, `${this.dataDir}/home`]) {
      try {
        if (!fs.accessSync(dir)) {
          fs.mkdirSync(dir, true);
        }
      } catch (error) {
        hilog.warn(DOMAIN, TAG, 'mkdir %{public}s failed', dir);
      }
    }
  }

  /** 端口协商：探一次"当前是否已被监听"，被占就顺延；全被占则退回首选值由 server 报错 */
  private async resolvePort(): Promise<number> {
    for (let i = 0; i < PORT_FALLBACK_TRIES; i++) {
      const candidate = PORT_PREFERRED + i;
      const busy = await this.portAnswers(candidate);
      if (!busy) {
        return candidate;
      }
    }
    return PORT_PREFERRED;
  }

  private tryReadReady(readyPath: string): HostReady | null {
    try {
      if (!fs.accessSync(readyPath)) {
        return null;
      }
      const raw = fs.readTextSync(readyPath);
      const parsed = JSON.parse(raw) as HostReady;
      if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') {
        return null;
      }
      // 新鲜度：startedAt 必须不早于本次启动（留 5s 容差），否则是上一次进程留下的旧文件
      if (typeof parsed.startedAt !== 'number' || parsed.startedAt + READY_FRESH_SKEW_MS < this.bootEpochMs) {
        return null;
      }
      return parsed;
    } catch (error) {
      return null;
    }
  }

  /** 读 Node 侧写的失败标记（process.exit 被拦截时才有）；没有/损坏都当"没有" */
  private readFailureMarker(): HostFailure | null {
    try {
      // 与 node-output.log / boot-stage.json 同级（<filesDir>），不是 <data>/motrix
      const path = `${this.sandboxHome}/${FAILED_FILE}`;
      if (!fs.accessSync(path)) {
        return null;
      }
      const parsed = JSON.parse(fs.readTextSync(path)) as HostFailure;
      if (typeof parsed.code !== 'number') {
        return null;
      }
      return parsed;
    } catch (error) {
      return null;
    }
  }

  private clearFailureMarker(): void {
    try {
      const path = `${this.sandboxHome}/${FAILED_FILE}`;
      if (fs.accessSync(path)) {
        fs.unlinkSync(path);
      }
    } catch (error) {
      hilog.debug(DOMAIN, TAG, 'clear host-failed.json failed');
    }
  }

  /**
   * 删掉上一次进程遗留的 host-ready.json（按 startedAt 判定；解析不了也删）。
   *
   * 为什么不靠 pid：Node 与本进程同 pid，但 ArkTS 拿不到自己的 pid，
   * 原来的 pid 校验等于"只要字段是数字就通过"，真机上直接踩坑（旧 cookie + 旧端口）。
   */
  private dropStaleReady(): void {
    const readyPath = `${this.dataDir}/${READY_FILE}`;
    try {
      if (!fs.accessSync(readyPath)) {
        return;
      }
      let stale = true;
      try {
        const parsed = JSON.parse(fs.readTextSync(readyPath)) as HostReady;
        stale = typeof parsed.startedAt !== 'number'
          || parsed.startedAt + READY_FRESH_SKEW_MS < this.bootEpochMs;
      } catch (error) {
        stale = true;
      }
      if (stale) {
        fs.unlinkSync(readyPath);
        hilog.info(DOMAIN, TAG, 'dropped stale host-ready.json');
      }
    } catch (error) {
      hilog.debug(DOMAIN, TAG, 'drop stale host-ready.json failed');
    }
  }

  /**
   * 系统语言（如 zh-Hans / en-Latn-US）；失败返回空串，宿主那边会跳过。
   * 先问 i18n（权威值），再退回 context.config.language（应用当前配置，跟随系统）。
   */
  private readSystemLanguage(): string {
    try {
      const language = i18n.System.getSystemLanguage();
      if (typeof language === 'string' && language.length > 0) {
        return language;
      }
    } catch (error) {
      // 继续走兜底
    }
    try {
      const configured = this.context.config.language;
      if (typeof configured === 'string' && configured.length > 0) {
        return configured;
      }
    } catch (error) {
      // 忽略
    }
    return '';
  }

  /** 系统颜色模式：'dark' / 'light' / ''（未知） */
  private readSystemColorMode(): string {
    try {
      const mode = this.context.config.colorMode;
      if (mode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK) {
        return 'dark';
      }
      if (mode === ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT) {
        return 'light';
      }
      return '';
    } catch (error) {
      return '';
    }
  }

  private buildEnv(port: number): string[] {
    const env: string[] = [
      `MOTRIX_SANDBOX_HOME=${this.sandboxHome}`,
      `MOTRIX_APP_ROOT=${this.appRoot}`,
      `MOTRIX_DATA_DIR=${this.dataDir}`,
      `MOTRIX_PORT=${port}`,
      `PORT=${port}`,
      // 认领失败就**不传**：宿主会退回 <data>/Downloads 并在日志里说明
      ...(this.pdfPublicDownload),

      // 系统语言 / 颜色模式：ArkWeb 里 prefers-color-scheme 与 navigator.language 都不可靠
      // （实测系统中文+深色，Web 里仍报浅色+en-US），所以由 ArkTS 读真实配置传给宿主，
      // 宿主再写回 Motrix 的 settings（见 scripts/host/main.mjs 的 harmonizePlatformSettings）。
      `MOTRIX_SYSTEM_LANGUAGE=${this.readSystemLanguage()}`,
      // server 侧 locale 解析也会用这两个（见 vendor/motrix/src/server/index.ts
      // 的 resolveServerLocale：settings 的 'system' → MOTRIX_HOST_LANGUAGE → LANG）。
      // 传原始标签（zh-Hans / en-Latn-US…），server 自己会解析到受支持语言码。
      `MOTRIX_HOST_LANGUAGE=${this.readSystemLanguage()}`,
      `MOTRIX_SYSTEM_COLOR_MODE=${this.readSystemColorMode()}`,

      // 调试包才允许把会话凭据导出成可读文件（发布包恒为 0）：
      // 真机验收/自动化测试需要用它直连端侧 HTTP API，UI 里的 IME 合成事件
      // 走不通（ArkWeb 的输入法通道不打 DOM input 事件，React 收不到）。
      `MOTRIX_DEV_DUMP=${this.context.applicationInfo.debug ? '1' : '0'}`,

      // 必须：libuv 的 io_uring 在鸿蒙被 seccomp 直接杀进程（SIGSYS, syscall 425）
      'UV_USE_IO_URING=0',
      'LOG_LEVEL=info',
    ];
    return env;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}