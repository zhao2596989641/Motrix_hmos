/**
 * Motrix 主页面 —— 内嵌 ArkWeb 加载端侧 Node 起起来的官方 Web UI。
 *
 * 页面状态机：
 *   BOOTING（起 Node / 等就绪）→ LOADING（Web 首次加载）→ READY
 *                            ↘ ERROR（给出原因 + 重试）
 *
 * 三条硬规则（全部来自 参考宿主项目 的实测教训，别改成"看起来更简单"的版本）：
 *   1. **Cookie 必须在 Web 加载之前注入**：server 的 operator 会话是 httpOnly cookie，
 *      不注入就会停在"输入访问令牌"页，而普通用户根本不知道 token 在哪。
 *      token 由端侧脚本自己登录换取，写进 host-ready.json，这里只读。
 *   2. **`onPageEnd` 里必须先判失败再置 READY**：真机上 404/401 与 onPageEnd 只差几毫秒，
 *      无条件置 READY 会把错误页抹成白屏，还会取消自愈。
 *   3. **启动页要盖住 Web 组件**：LOADING 阶段如果直接露出 Web，用户会看到空白/错误页。
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { i18n } from '@kit.LocalizationKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { MotrixHost, HostReady, StartOutcome } from '../runtime/MotrixHost';
import { acquireHost } from '../runtime/HostBoot';
import { PlatformActions } from '../runtime/PlatformActions';
import { shouldBlockDrag } from '../runtime/WindowState';
import { NotificationPoller, SystemNotifier } from '../runtime/SystemNotifier';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-WEB';
// 加载看门狗：超过这个时间还停在 LOADING，就主动重新导航一次
const LOAD_TIMEOUT_MS = 15_000;

enum Phase {
  BOOTING = 0,
  LOADING = 1,
  READY = 2,
  ERROR = 3,
}

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private host: MotrixHost | null = null;
  /** EntryAbility 提前启动宿主时给的 Promise（见 runtime/HostBoot.ets） */
  private hostStart: Promise<StartOutcome> | null = null;
  /** 是否已经让 Web 去加载真实 URL（否则 onPageEnd 属于预热页 about:blank） */
  private appLoadRequested: boolean = false;
  private retryCount: number = 0;
  private static readonly AUTO_RETRY_MAX: number = 6;
  // 诊断日志落盘目录（ArkTS 的 hilog 在本机 hilog 缓冲里经常捞不到，落文件最可靠）
  private filesDir: string = '';
  /** document start 注入的脚本（见 buildPlatformScript） */
  private platformScript: string = '';
  /** 系统能力（在文件夹中显示 / 打开文件 / 打开外链） */
  private actions: PlatformActions | null = null;
  /** 系统通知（下载完成/失败） */
  private notifier: SystemNotifier | null = null;
  private notificationPoller: NotificationPoller | null = null;
  /** 主窗口引用（自绘标题栏的拖动/最小化/关闭要用） */
  private mainWindowRef: window.Window | null = null;
  /** 子窗口控制器：window.open 出来的页面用它承载（目前只用于"外链转系统浏览器"） */
  private childController: webview.WebviewController = new webview.WebviewController();

  // 系统语言 / 颜色模式（由 EntryAbility 写 AppStorage；变了就注入 Web）
  @StorageProp('motrix.systemLanguage') @Watch('onSystemAppearanceChange')
  private systemLanguage: string = '';
  @StorageProp('motrix.systemColorMode') @Watch('onSystemAppearanceChange')
  private systemColorMode: string = '';
  // 原始枚举值：-1 NOT_SET / 0 DARK / 1 LIGHT。NOT_SET 时说明"应用跟随系统"，
  // 但配置里读不到具体值，此时不能瞎猜 light，交给 ArkWeb 自己的 prefers-color-scheme。
  @StorageProp('motrix.systemColorModeCode') @Watch('onSystemAppearanceChange')
  private systemColorModeCode: number = -999;
  /** 系统标题栏是否已被隐藏（由 EntryAbility 的 ImmersiveWindow 写入）。
   *  只有 true 时才渲染自绘标题栏，否则会出现"两个标题栏都没有"的死窗口。 */
  @StorageProp('motrix.decorHidden') @Watch('onDecorVisibilityChange')
  private decorHidden: boolean = false;
  /** 系统三键区宽度（vp）。隐藏标题栏后三键悬浮在右上角，自绘标题栏右侧必须让出这块 */
  @StorageProp('motrix.titleButtonWidth') private titleButtonWidth: number = 0;
  /** 系统三键区高度（vp） */
  @StorageProp('motrix.titleButtonHeight') private titleButtonHeight: number = 54;
  /** 系统 decor（三键所在那条带）的高度（vp）—— Toast 下移用它，见 --mtx-toast-top */
  @StorageProp('motrix.decorHeight') private decorHeight: number = 54;
  // 托盘右键页面项：EntryAbility 把目标路由写进 AppStorage，序号变化触发注入
  @StorageProp('motrix.trayRouteSeq') @Watch('onTrayRouteChange') private trayRouteSeq: number = 0;
  @StorageProp('motrix.trayRoutePath') private trayRoutePath: string = '';
  // 开机自启状态（EntryAbility 查询后写入）：设置页显示状态 + 跳转系统设置按钮
  @StorageProp('motrix.autoStartupKnown') @Watch('onAutoStartupChange') private autoStartupKnown: boolean = false;
  @StorageProp('motrix.autoStartupSupported') @Watch('onAutoStartupChange') private autoStartupSupported: boolean = false;
  @StorageProp('motrix.autoStartupEnabled') @Watch('onAutoStartupChange') private autoStartupEnabled: boolean = false;

  @State phase: Phase = Phase.BOOTING;
  @State errorText: string = '';
  @State launchUrl: string = '';
  @State logTail: string = '';

  /** 主文档是否已 onPageEnd（只代表 HTML 到了，不代表 React 挂载完） */
  private webPageLoaded: boolean = false;
  /** 渲染层是否已真正挂载（注入脚本的 html.mtx-booting 被移除） */
  private webMounted: boolean = false;
  /** "等渲染层挂载"的轮询定时器（-1 = 没在跑） */
  private readyPollTimer: number = -1;
  private readyPollCount: number = 0;
  private static readonly READY_POLL_INTERVAL_MS: number = 120;
  private static readonly READY_POLL_MAX: number = 100;

  aboutToAppear(): void {
    const context = getContext(this) as common.UIAbilityContext;
    this.filesDir = context.filesDir;
    try {
      webview.WebviewController.setWebDebuggingAccess(true);
    } catch (error) {
      const err = error as BusinessError;
      this.appendDiag(`setWebDebuggingAccess failed: ${err.message}`);
    }
    this.actions = new PlatformActions(context);
    // 沉浸式：拖拽条（注入到 Web 里）触发 → 调 window.startMoving()
    this.actions.setDragHandler(() => {
      this.beginWindowDrag();
    });
    // r48：宿主可能在 EntryAbility.onWindowStageCreate 里就已经被提前启动，这里只是取同一个实例/Promise。
    // 注意顺序（r49）：必须先 acquireHost —— 它的同步前缀会跑完 W^X 探针，之后注入脚本里的
    // pluginRuntime 才能拿到"本进程能不能 JIT/WASM"的真实结论。
    const boot = acquireHost(context);
    this.host = boot.host;
    this.hostStart = boot.start;
    this.platformScript = this.buildPlatformScript();
    this.appendDiag(
      `===== Index.aboutToAppear ===== build=r31 platform language=${this.systemLanguage} colorMode=${this.systemColorMode} code=${this.systemColorModeCode}`
    );
    this.boot();
  }

  /**
   * 诊断日志：同时写 hilog 和 `<filesDir>/arkts-diag.log`。
   *
   * 【为什么必须落文件】本机 hilog 缓冲轮转很快，排查"卡在加载页"这类问题时，
   * 事后 `hilog -x` 里常常一条 MOTRIX-WEB 都没有；写到应用自己的 filesDir 才能事后取证。
   */
  private appendDiag(line: string): void {
    hilog.info(DOMAIN, TAG, '%{public}s', line);
    if (this.filesDir.length === 0) {
      return;
    }
    try {
      const path = `${this.filesDir}/arkts-diag.log`;
      const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.APPEND);
      // r53：本地时间（上游/旧实现用 toISOString ⇒ UTC，北京时间会早 8 小时）
      const now = new Date();
      const pad2 = (value: number): string => value < 10 ? `0${value}` : `${value}`;
      const stamp = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${now.getMilliseconds() < 100 ? (now.getMilliseconds() < 10 ? `00${now.getMilliseconds()}` : `0${now.getMilliseconds()}`) : `${now.getMilliseconds()}`}`;
      fs.writeSync(file.fd, `${stamp} ${line}\n`);
      fs.closeSync(file);
    } catch (error) {
      // 诊断失败不能影响主流程
    }
  }

  /**
   * 生成注入到 Web 的"平台值"脚本（javaScriptOnDocumentStart）。
   *
   * 【为什么必须注入】ArkWeb 里 `prefers-color-scheme` 与 `navigator.language` 都不可靠
   * （本机系统中文 + 深色，Web 里仍报浅色 + en-US）。上游 server 模式没有原生主题桥，
   * 所以由这里把真实系统值塞进页面，并把 `matchMedia('(prefers-color-scheme: …)')`
   * 打上补丁 —— next-themes 的 'system' 模式就能正常解析、也能收到变更事件。
   *
   * 语言则由渲染层的 LanguageSync 读取 `window.__MOTRIX_PLATFORM__.language`，
   * 只在 settings.language === 'system' 时生效（用户显式选过语言就尊重设置）。
   */
  private buildPlatformScript(): string {
    // AppStorage 还没填（极早期）时自己读一次系统配置，别让页面拿到假值
    let language = this.systemLanguage;
    if (language.length === 0) {
      try {
        language = i18n.System.getSystemLanguage();
      } catch (error) {
        language = '';
      }
    }
    if (language.length === 0) {
      language = 'en-US';
    }
    const colorMode = this.resolveColorMode();
    // 端侧 Node 是否拿到可执行内存（JIT/WASM）——由原生壳探针决定，渲染层据此显示插件横幅
    const pluginRuntime: string =
      (this.host !== null && this.host.isJitAvailable()) ? 'ready' : 'unavailable';
    // 开机自启：HarmonyOS 只允许查询、不允许应用自己设置（见 EntryAbility.reportAutoStartupStatus）
    const autoStartup = this.autoStartupStatus();
    return `(function(){
  var state = window.__MOTRIX_PLATFORM__ = window.__MOTRIX_PLATFORM__ || {};
  state.language = ${JSON.stringify(language)};
  state.colorMode = ${JSON.stringify(colorMode)};
  // 移植轮次：关于页用它显示 "HarmonyOS Port rNN" 徽章
  state.portVersion = 'r56';
  // 开机自启状态：'enabled' | 'disabled' | 'unsupported' | 'unknown'
  // 设置页据此显示「已开启 / 未开启 / 设备不支持」+ 跳转系统设置的按钮。
  state.autoStartup = ${JSON.stringify(autoStartup)};
  // 端侧插件运行时是否可用，取决于端侧 Node 能不能拿到**可执行内存**（JIT/WASM）：
  // 有 ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY 的 ACL ⇒ Node 不带 --jitless，
  // 上游 QuickJS 插件沙箱原样可用（'ready'）；否则回退 --jitless（'unavailable'，
  // 渲染层在插件页显示横幅，server 侧插件链已降级为 fail-open）。
  // UI 跑在 ArkWeb 里（Chromium 有 WebAssembly），判断不了端侧 Node 的能力，所以由原生壳给结论。
  state.pluginRuntime = ${JSON.stringify(pluginRuntime)};
  var pool = [];
  var originalMatchMedia = window.matchMedia ? window.matchMedia.bind(window) : null;
  function isColorScheme(query) { return String(query).indexOf('prefers-color-scheme') >= 0; }
  function wantsLight(query) { return String(query).indexOf('light') >= 0; }
  function nativeMatches(query) {
    try { return originalMatchMedia ? originalMatchMedia(query).matches : false; } catch (e) { return false; }
  }
  function makeStub(query, kind) {
    var mql = { media: query, onchange: null, _listeners: [] };
    Object.defineProperty(mql, 'matches', {
      get: function () {
        if (!state.colorMode) return nativeMatches(query);
        return kind === 'light' ? state.colorMode === 'light' : state.colorMode === 'dark';
      }
    });
    mql.addEventListener = function (type, fn) { if (type === 'change' && typeof fn === 'function') mql._listeners.push(fn); };
    mql.removeEventListener = function (type, fn) {
      var i = mql._listeners.indexOf(fn);
      if (i >= 0) mql._listeners.splice(i, 1);
    };
    mql.addListener = mql.addEventListener;
    mql.removeListener = mql.removeEventListener;
    mql.dispatchEvent = function () { return true; };
    mql._fire = function () {
      var event = { matches: mql.matches, media: query, type: 'change' };
      if (typeof mql.onchange === 'function') { try { mql.onchange(event); } catch (e) {} }
      mql._listeners.slice().forEach(function (fn) { try { fn(event); } catch (e) {} });
    };
    pool.push(mql);
    return mql;
  }
  // 始终接管 color-scheme 查询：即使一开始不知道系统模式，等 ArkTS 推来值也能生效
  window.matchMedia = function (query) {
    try {
      var text = String(query);
      if (isColorScheme(text)) return makeStub(text, wantsLight(text) ? 'light' : 'dark');
      return originalMatchMedia ? originalMatchMedia(query) : makeStub(text, 'dark');
    } catch (e) {
      return originalMatchMedia ? originalMatchMedia(query) : makeStub(String(query), 'dark');
    }
  };
  try {
    var proto = Object.getPrototypeOf(navigator);
    Object.defineProperty(proto, 'language', {
      configurable: true,
      get: function () { return state.language; }
    });
    Object.defineProperty(proto, 'languages', {
      configurable: true,
      get: function () { return [state.language]; }
    });
  } catch (e) {}
  // 直接改 html 的 class / color-scheme：不依赖 next-themes 是否监听，立即生效
  function applyThemeClass() {
    if (!state.colorMode) return;
    var root = document.documentElement;
    if (!root) return;
    var other = state.colorMode === 'dark' ? 'light' : 'dark';
    root.classList.remove(other);
    root.classList.add(state.colorMode);
    try { root.style.colorScheme = state.colorMode; } catch (e) {}
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.colorMode === 'dark' ? '#1B1B1F' : '#FFFFFF');
  }
  window.__motrixSetPlatform = function (values) {
    if (!values) return;
    if (values.language) state.language = values.language;
    if (values.colorMode) {
      state.colorMode = values.colorMode;
      pool.forEach(function (mql) { mql._fire(); });
    }
    if (values.autoStartup) state.autoStartup = values.autoStartup;
    applyThemeClass();
    if (typeof window.__motrixApplyPlatform === 'function') {
      try { window.__motrixApplyPlatform(values); } catch (e) {}
    }
    // 渲染层监听这个事件来刷新"平台值"（例如设置页里的开机自启状态）
    try { window.dispatchEvent(new CustomEvent('motrix-platform-change')); } catch (e) {}
  };
  applyThemeClass();
  if (typeof window.__motrixApplyPlatform === 'function') {
    try { window.__motrixApplyPlatform({ language: state.language, colorMode: state.colorMode }); } catch (e) {}
  }
  // ── 首帧防闪：先藏 #root，等渲染层自己报告"已挂载"再露出 ────────────────
  //
  // 真机现象：启动时先闪一下英文界面再变中文。根因是 i18n 的初始语言在某些
  // 情况下拿到的是默认 en-US（例如注入脚本本身出错、或 settings 里是具体语言），
  // 第一帧英文、随后 LanguageSync 切到中文 —— 用户看到的就是"闪一下"。
  // 这里用"隐藏/露出"把这段过渡藏起来：渲染层挂载完成后（index.tsx）移除
  // html.mtx-booting，另外还有 3s 兜底（任何异常都不会让页面永远不可见）。
  var bootGuardStyle = null;
  function installBootGuard() {
    try {
      if (!document.getElementById('mtx-boot-guard')) {
        bootGuardStyle = document.createElement('style');
        bootGuardStyle.id = 'mtx-boot-guard';
        // r56：网页自带的 #renderer-boot（m→o 字标 + shimmer）在鸿蒙壳里永远不显示——
        // 开屏由原生遮罩负责，渲染层挂载前遮罩不撤（见 pollRendererMounted）。
        bootGuardStyle.textContent =
          'html.mtx-booting #root{visibility:hidden !important}' +
          '#renderer-boot{display:none !important}';
        (document.head || document.documentElement).appendChild(bootGuardStyle);
      }
      document.documentElement.classList.add('mtx-booting');
      setTimeout(function () {
        try { document.documentElement.classList.remove('mtx-booting'); } catch (e) {}
      }, 3000);
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installBootGuard, { once: true });
  } else {
    installBootGuard();
  }
  // 诊断：把"第一帧到底是什么语言"记下来，下次一闪就有证据
  function snapshotBoot(tag) {
    try {
      var text = document.body ? String(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 140) : '';
      console.log('MOTRIX-BOOT ' + tag + ' lang=' + document.documentElement.lang +
        ' injected=' + String(state.language || '') + ' settingsLocale=? text=' + text);
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { snapshotBoot('dom'); }, { once: true });
  } else {
    snapshotBoot('dom');
  }
  setTimeout(function () { snapshotBoot('t150'); }, 150);
  setTimeout(function () { snapshotBoot('t450'); }, 450);
  setTimeout(function () { snapshotBoot('t1000'); }, 1000);
  // ── 沉浸式：隐形拖拽条 + 窗口三键避让（Clash 式）────────────────────────
  //
  // 背景：我们已经隐藏了系统标题栏（setWindowDecorVisible(false)），系统三键会悬浮在
  // 右上角。Clash 的做法是"Web 内容铺满 + 三键浮在上面 + 由 Web 侧自己避让"，
  // 而不是画一条标题栏。这里就是那个"Web 侧避让 + 可拖动"的部分：
  //   · 顶部 36px 内、避开左侧按钮区(220px)与右侧三键区的地方，铺一条透明拖拽条；
  //   · 按下拖拽条 → 触发 motrix-action://drag → ArkTS 调 window.startMoving()；
  //   · 三键区通过 CSS 变量留给页面自己避让（默认只做 pointer-events 穿透，
  //     不改变任何布局，避免破坏 Motrix 现有界面）。
  var TITLEBAR_H = 36;
  var WINCTL_W = ${JSON.stringify(this.titleButtonWidth > 0 ? this.titleButtonWidth : 0)};
  // 系统 decor（三键所在那条带）的高度，ArkTS 侧 setWindowDecorHeight 设的值
  var DECOR_H = ${JSON.stringify(this.decorHeight > 0 ? this.decorHeight : 54)};
  var DRAG_MIN_LEFT = 220;
  var DRAG_GAP = 8;
  var dragStrip = null;
  var lastProbePath = '';
  // 当前"真的在标题栏这一条上"的页头（页面切换用的是 hidden 叠加，
  // 隐藏页面的 rect 全是 0，必须跳过）。
  function activePanelHeader() {
    try {
      var list = document.querySelectorAll('[data-slot="panel-shell-header"]');
      for (var i = 0; i < list.length; i++) {
        var h = list[i];
        var hr = h.getBoundingClientRect();
        if (hr.height > 0 && hr.top < TITLEBAR_H) {
          return h;
        }
      }
    } catch (e) {}
    return null;
  }
  // 页头按钮组里"真实交互元素"的最左边缘。
  // 不能直接用容器 left：下载/插件/Trackers 的工具栏容器是 flex-1 撑满的，
  // 用它会算到页头中段，把拖拽带压成零宽（这三个页面拖不动的直接原因）。
  function interactiveLeftEdge(container) {
    var minLeft = -1;
    try {
      var nodes = container.querySelectorAll('button,a,input,select,[role="button"],[role="combobox"],[data-slot="toolbar-button"]');
      for (var i = 0; i < nodes.length; i++) {
        var nr = nodes[i].getBoundingClientRect();
        if (nr.width <= 0 || nr.height <= 0) {
          continue;
        }
        if (nr.top >= TITLEBAR_H) {
          continue;
        }
        if (minLeft < 0 || nr.left < minLeft) {
          minLeft = nr.left;
        }
      }
    } catch (e) {}
    return minLeft;
  }
  // 拖拽带：左侧让开"左上角按钮 + 当前页标题"，右侧让开"右上角页头按钮组 / 系统三键"。
  // ★ 这只是"哪里算空白"的判断依据，不再承担"挡住点击"的职责（见 ensureDragStrip）。
  function resolveDragBounds() {
    var left = DRAG_MIN_LEFT;
    var right = WINCTL_W > 0 ? WINCTL_W : 0;
    try {
      var wrapper = document.querySelector('[data-slot="sidebar-wrapper"]');
      var collapsed = wrapper !== null && wrapper.getAttribute('data-state') === 'collapsed';
      if (!collapsed) {
        return { left: left, right: right };
      }
      var header = activePanelHeader();
      if (header === null) {
        return { left: left, right: right };
      }
      // 右边界：只用按钮组内真实元素的最左边缘（见 interactiveLeftEdge 的注释）
      var actions = header.querySelector('[data-slot="panel-shell-actions"]');
      if (actions !== null && actions !== undefined) {
        var minBtnLeft = interactiveLeftEdge(actions);
        if (minBtnLeft > 0) {
          var rc = window.innerWidth - Math.round(minBtnLeft) + DRAG_GAP;
          if (rc > right) {
            right = rc;
          }
        }
      }
    } catch (e) {}
    // 带宽兜底：算出来太窄（标题或按钮组特别宽）就放弃按钮组避让，只让到三键左侧。
    // 按钮照样点得到 —— 拖拽条是 pointer-events:none，且命中判断会放行一切交互元素。
    if (window.innerWidth - left - right < 80) {
      right = WINCTL_W > 0 ? WINCTL_W : 0;
    }
    return { left: left, right: right };
  }
  function syncDragGeometry() {
    if (!dragStrip || !dragStrip.isConnected) return;
    var b = resolveDragBounds();
    var lcss = b.left + 'px';
    var rcss = b.right + 'px';
    if (dragStrip.style.left !== lcss) {
      dragStrip.style.left = lcss;
    }
    if (dragStrip.style.right !== rcss) {
      dragStrip.style.right = rcss;
    }
    // 换页面就打一条几何（方便事后核对"哪个页面带宽算错了"）
    if (location.pathname !== lastProbePath) {
      lastProbePath = location.pathname;
      probeDragGeometry('page');
    }
  }
  function probeDragGeometry(tag) {
    try {
      var b = resolveDragBounds();
      var w = -1;
      if (dragStrip && dragStrip.isConnected) {
        w = Math.round(dragStrip.getBoundingClientRect().width);
      }
      var wrapper = document.querySelector('[data-slot="sidebar-wrapper"]');
      var state = wrapper !== null ? String(wrapper.getAttribute('data-state')) : 'none';
      console.log('MOTRIX-DRAG build=r31 ' + tag + ' left=' + b.left + ' right=' + b.right + ' width=' + w + ' winctl=' + WINCTL_W + ' sidebar=' + state + ' path=' + location.pathname);
    } catch (e) {}
  }
  function startWindowDrag() {
    try {
      var f = document.createElement('iframe');
      f.style.display = 'none';
      f.src = 'motrix-action://drag';
      document.body.appendChild(f);
      setTimeout(function () { f.remove(); }, 800);
    } catch (e) {}
  }
  function isInteractiveTarget(el) {
    if (!el || !el.closest) return false;
    // ★ 这里**只能**放具体的交互元素，绝不能放容器类选择器（如 panel-shell-actions）。
    //   下载 / 插件 / Trackers 页的工具栏根容器是 flex-1、撑满页头剩余宽度；
    //   把容器算进"交互区"等于把整条标题栏都判成不可拖 → 这三个页面完全拖不动
    //   （用户反馈："下载、trackers、插件收起侧边栏后拖不动，仪表板还行"）。
    var hit = el.closest('button,a,input,select,textarea,label,[role=button],[role=link],[role=menuitem],[contenteditable="true"]');
    return hit !== null;
  }
  function ensureDragStrip() {
    if (!document.body) return;
    if (dragStrip && dragStrip.isConnected) {
      syncDragGeometry();
      return;
    }
    dragStrip = document.createElement('div');
    dragStrip.id = 'mtx-drag-strip';
    var b0 = resolveDragBounds();
    dragStrip.style.cssText = [
      'position:fixed',
      'top:0',
      'left:' + b0.left + 'px',
      'right:' + b0.right + 'px',
      'height:' + TITLEBAR_H + 'px',
      'z-index:2147483000',
      'background:transparent',
      // ★ r30 关键修改：拖拽条**自己不接收任何鼠标事件**。
      //   r29 想在 mousedown 里判断"点在按钮上就放行"，物理上做不到：
      //   preventDefault 只取消默认动作，并不会把 mousedown 转发给下层元素，
      //   所以按钮永远收不到点击（用户反馈"顶上 80% 区域点不到"）。
      //   现在事件落到真实元素上，是否拖窗口由 document 捕获阶段自己判断。
      'pointer-events:none'
    ].join(';');
    document.body.appendChild(dragStrip);
  }
  // 命中判断放在 document 捕获阶段：此时 ev.target 是真实元素。
  // 按钮 / 标题菜单 / 输入框一律放行（连 preventDefault 都不做）。
  document.addEventListener('mousedown', function (ev) {
    if (ev.button !== 0) return;
    if (!dragStrip || !dragStrip.isConnected) return;
    var r = dragStrip.getBoundingClientRect();
    if (ev.clientX < r.left || ev.clientX > r.right) return;
    if (ev.clientY < r.top || ev.clientY > r.bottom) return;
    if (isInteractiveTarget(ev.target)) return;
    ev.preventDefault();
    startWindowDrag();
  }, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureDragStrip, { once: true });
  } else {
    ensureDragStrip();
  }
  // 视口/布局变化时重新计算（三键宽度、页头按钮组位置都可能变；
  // 边栏收起/展开不会触发 resize，所以再挂一个低频定时兜底，幂等且只在变化时写 style）
  window.addEventListener('resize', syncDragGeometry);
  setInterval(syncDragGeometry, 800);
  // 取证：启动 2.5s 后打一条拖拽带几何（落 arkts-diag.log 的 web-console 行），
  // 以后一眼就能看出"装的是哪版 + 带宽对不对"。
  setTimeout(function () {
    probeDragGeometry('boot');
  }, 2500);
  // 把三键宽度暴露给 Web UI（将来页面若想自己避让可以直接用这个变量）
  document.documentElement.style.setProperty('--mtx-winctl-width', (WINCTL_W > 0 ? WINCTL_W : 0) + 'px');
  document.documentElement.style.setProperty('--mtx-titlebar-height', TITLEBAR_H + 'px');
  // ── 三键避让：只改 PanelShell 紧凑态页头的右内边距 ────────────────────────
  //
  // 上游 PanelShell 的 header 本来就有一条给"系统窗口控件"预留的规则：
  //   compact-header:pe-[var(--window-chrome-safe-area-trailing)]
  // 它只在紧凑态（边栏收起）生效，正是我们要的范围。
  // 把该变量指向"三键宽度 + 8px 间隙"即可：
  //   · 只有边栏收起时，五个页面页头的按钮组才左移，避开三键；
  //   · 页面卡片、内容区、其他元素、边栏展开时，一律不受影响；
  //   · header 本身有 transition-[padding]，所以收起/展开的位移动画照旧，
  //     只是终点左移了（用户要求保留动画）；
  //   · 垂直位置完全不动：紧凑态 header 的 py-[5px] + 28px 行高，中轴
  //     与左上角 WindowChrome 按钮同一条线，天然对齐，不需要参考三键。
  var TRAILING_PX = WINCTL_W > 0 ? WINCTL_W + 8 : 24;
  // 注意：不能直接设在 <html> 上 —— SidebarProvider 的根 div 带 .web-window-chrome 类，
  // 它自己声明了 --window-chrome-safe-area-trailing: 24px，元素自身的声明优先于继承，
  // 会盖掉 html 上的值。所以这里只放一个中转变量，由下面的 CSS 规则真正落地。
  document.documentElement.style.setProperty('--mtx-safe-trailing', TRAILING_PX + 'px');
  // Toast 顶部避让：系统三键所在的那条 decor 带（DECOR_H）往下再留 8px
  document.documentElement.style.setProperty('--mtx-toast-top', (DECOR_H + 8) + 'px');

  // ── 三键避让 CSS ──────────────────────────────────────────────────────────
  //
  // 问题：隐藏标题栏后系统三键悬浮在右上角，会压住页面右上角的一批按钮
  // （仪表板"配置"、下载页搜索、Tracker 过滤、插件查找、通知页清空/全部标为已读…）。
  //
  // 做法（r28 调整）：**不再**给整个内容区 main[data-slot="sidebar-inset"] 加
  // padding-right —— 那会把整个界面一起缩进来。改为只覆盖
  // --window-chrome-safe-area-trailing（见上面那段），它只被
  // PanelShell 的 compact-header:pe-[...] 消费：
  //   · 边栏展开时不生效（这些按钮本来就不在右上角，无需避让）；
  //   · 边栏收起时，五个页面页头的按钮组整体左移到三键左侧；
  //   · 其余元素（卡片、列表、图表、页脚）位置完全不变；
  //   · 头部 padding 有 transition，收起/展开的滑动动画保留。
  // 这里只剩 Toast（右上角横条）的定位：它不在页头里，需要单独挪。
  var AVOID_CSS = [
    // 把三键宽度落成 PanelShell 紧凑态页头真正消费的那个变量。
    // 选择器用 :root .web-window-chrome 提高特异性，并加 !important，
    // 否则会被 .web-window-chrome 自己那条 24px 声明挡住。
    ':root .web-window-chrome{',
    '  --window-chrome-safe-area-trailing: var(--mtx-safe-trailing, 24px) !important;',
    '}',
    // Toast（右上角横条）只做**向下**避让：三键在那条 decor 带里，
    // 往下挪到它下面就够了。**不要**再向左避让 —— 用户反馈横条偏左了，
    // 它本来就在最右边，水平位置保持原样即可。
    // 注意：.mtx-toast-viewport 是 toast.tsx 里新加的稳定类名
    // （Base UI 的 Toast.Viewport 没有 data-* 标记，靠结构选择器不可靠）
    '.mtx-toast-viewport, [data-sonner-toaster]{',
    '  top: var(--mtx-toast-top, 62px) !important;',
    '}'
  ].join(' ');
  function applyAvoidCss() {
    try {
      if (!document.getElementById('mtx-avoid-style')) {
        var st = document.createElement('style');
        st.id = 'mtx-avoid-style';
        st.textContent = AVOID_CSS;
        (document.head || document.documentElement).appendChild(st);
      }
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyAvoidCss, { once: true });
  } else {
    applyAvoidCss();
  }
  // React 重渲染可能替换节点，隔几秒补一次（幂等、开销可忽略）
  setInterval(applyAvoidCss, 2000);

  // 一次性探针：把 WebGL 后端 / DPR / 并发数打到 console（Index 的 onConsole 会落到 arkts-diag）
  setTimeout(function () {
    try {
      var probe = document.createElement('canvas');
      var gl = probe.getContext('webgl2');
      if (!gl) { console.log('MOTRIX-GPU webgl2=unavailable'); return; }
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      var name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      console.log('MOTRIX-GPU renderer=' + String(name) +
        ' dpr=' + window.devicePixelRatio +
        ' hw=' + navigator.hardwareConcurrency +
        ' size=' + window.innerWidth + 'x' + window.innerHeight);
    } catch (e) { console.log('MOTRIX-GPU probe-failed ' + e); }
  }, 1200);

  // 托盘右键"跳到某页"的入口：渲染层是 createHashRouter，改 location.hash 即可切路由，
  // 不会重新加载页面（主窗口可能刚从托盘里被唤回，重新加载会白屏几秒）。
  window.__mtxNav = function (path) {
    try {
      if (typeof path !== 'string' || path.length === 0) return false;
      var target = path.charAt(0) === '#' ? path : '#' + path;
      if (window.location.hash === target) return true;
      window.location.hash = target;
      return true;
    } catch (e) { return false; }
  };
})();`;
  }

  /**
   * 解析当前应使用的颜色模式：已知就返回，未知返回空串（交给 ArkWeb 原生判断）。
   * 注意 NOT_SET(-1) 不是"浅色"，是"跟随系统但读不到具体值"。
   */
  private resolveColorMode(): string {
    if (this.systemColorMode.length > 0) {
      return this.systemColorMode;
    }
    let code: number = this.systemColorModeCode;
    if (code === -999 || code === undefined || code === null) {
      try {
        const context = getContext(this) as common.UIAbilityContext;
        code = context.config.colorMode as number;
      } catch (error) {
        code = -1;
      }
    }
    if (code === (ConfigurationConstant.ColorMode.COLOR_MODE_DARK as number)) {
      return 'dark';
    }
    if (code === (ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT as number)) {
      return 'light';
    }
    return '';
  }

  /**
   * 启动/错误页的配色。
   *
   * 这些页面是**原生 ArkUI**（盖在 Web 上面），原来写死白色，于是系统深色时
   * 启动瞬间会闪一块白。这里按系统颜色模式取深/浅两套值。
   */
  private isDarkMode(): boolean {
    return this.systemColorMode === 'dark';
  }

  private panelBackground(): string {
    return this.isDarkMode() ? '#1B1B1F' : '#FFFFFF';
  }

  private primaryTextColor(): string {
    return this.isDarkMode() ? '#F2F3F5' : '#1A1A1A';
  }

  private secondaryTextColor(): string {
    return this.isDarkMode() ? '#A8ADB8' : '#666666';
  }

  private hintTextColor(): string {
    return this.isDarkMode() ? '#7A808C' : '#999999';
  }

  private logPanelBackground(): string {
    return this.isDarkMode() ? '#25262B' : '#F5F5F5';
  }

  private logPanelTextColor(): string {
    return this.isDarkMode() ? '#C9CED8' : '#333333';
  }

  /**
   * 把 Web 里想"新开窗口"的地址转发到合适的去处。
   *
   * 为什么要拦：ArkWeb 没有默认的新窗口容器，`window.open` / `target=_blank` 会静默无反应。
   * 规则：
   *   · 本站内部地址（http://127.0.0.1:<port>）→ 让当前页面自己导航，不开新窗；
   *   · http(s)/mailto 外链 → 系统浏览器；
   *   · motrix-action:// → 自己的系统动作。
   */
  private dispatchExternal(url: string): void {
    if (url.length === 0) {
      return;
    }
    if (url.indexOf('motrix-action://') === 0) {
      this.actions?.handleIfAction(url);
      return;
    }
    // 同源：直接在当前页面打开（保持 SPA 状态）
    if (this.launchUrl.length > 0 && url.indexOf(this.origin()) === 0) {
      try {
        this.controller.loadUrl(url);
      } catch (error) {
        const err = error as BusinessError;
        this.appendDiag(`same-origin loadUrl failed: ${err.message}`);
      }
      return;
    }
    // 外链：交给系统浏览器
    this.actions?.openExternal(url).then((result) => {
      this.appendDiag(`openExternal ${url} -> ok=${result.ok} note=${result.note}`);
    });
  }

  /** 系统标题栏可见性变化：记录一下，方便排查"点不到按钮"这类问题 */
  onDecorVisibilityChange(): void {
    this.appendDiag(`decorHidden=${this.decorHidden}`);
  }

  /**
   * 拖动窗口（由 Web 里注入的隐形拖拽条触发）。
   *
   * 注意 startMoving() 只在**自由窗口**状态可用；最大化/全屏时它会抛 1300004，
   * 那种状态下窗口本来也不需要拖，直接忽略（不记日志，避免刷屏）。
   */
  private beginWindowDrag(): void {
    try {
      if (this.mainWindowRef === null) {
        this.resolveMainWindow();
      }
      const winObj = this.mainWindowRef;
      if (winObj === null) {
        return;
      }
      // ★ 最大化/全屏状态下**绝对不能**调 startMoving()：
      //   系统会理解为"拖动最大化窗口"，于是立即把窗口还原（缩小）并跟随鼠标，
      //   而且还原后的位置由鼠标决定（用户反馈的"最小化后不回原位"就是这个）。
      //   Clash 踩过同样的坑，标准解法就是"最大化时拖拽不生效"。
      if (shouldBlockDrag(winObj)) {
        return;
      }
      winObj.startMoving().catch((error: BusinessError) => {
        if (error.code !== 1300004) {
          this.appendDiag(`startMoving failed: ${error.code} ${error.message}`);
        }
      });
    } catch (error) {
      const err = error as BusinessError;
      this.appendDiag(`beginWindowDrag threw: ${err.message}`);
    }
  }

  private resolveMainWindow(): void {
    try {
      const stage = (getContext(this) as common.UIAbilityContext).windowStage;
      if (stage !== null && stage !== undefined) {
        this.mainWindowRef = stage.getMainWindowSync();
      }
    } catch (error) {
      // 忽略：拿不到窗口就走系统按钮
    }
  }

  private startSystemNotifications(): void {
    if (this.notificationPoller !== null) {
      return;
    }
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const logger = (message: string): void => {
        this.appendDiag(message);
      };
      let notifier = this.notifier;
      if (notifier === null) {
        notifier = new SystemNotifier(context, logger);
        this.notifier = notifier;
      }
      const queuePath = `${context.filesDir}/motrix/notify-queue.jsonl`;
      this.notificationPoller = new NotificationPoller(queuePath, notifier, logger);
      this.notificationPoller.start(2000);
      this.appendDiag(`notification poller started: ${queuePath}`);
    } catch (error) {
      const err = error as BusinessError;
      this.appendDiag(`startSystemNotifications failed: ${err.message}`);
    }
  }

  /** 启动 URL 的语言查询串（zh → ?locale=zh-CN，其它语言留空交给渲染层） */
  private bootLocaleQuery(): string {
    if (this.systemLanguage.indexOf('zh') === 0) {
      return '?locale=zh-CN';
    }
    return '';
  }

  /** 当前 Web 源（http://127.0.0.1:<port>），未就绪时返回空串 */
  private origin(): string {
    const url = this.launchUrl;
    const match = url.match(/^(https?:\/\/[^/]+)/);
    return match !== null ? match[1] : '';
  }

  /** 系统外观变化：把新值推给已在运行的页面（不需要重新加载） */
  onSystemAppearanceChange(): void {
    if (this.launchUrl.length === 0) {
      return;
    }
    const language = this.systemLanguage.length > 0 ? this.systemLanguage : 'zh-Hans';
    const colorMode = this.resolveColorMode();
    const script = `window.__motrixSetPlatform && window.__motrixSetPlatform(${JSON.stringify({
      language: language,
      colorMode: colorMode,
    })});`;
    this.appendDiag(
      `push platform -> language=${language} colorMode=${colorMode || '(unknown)'} code=${this.systemColorModeCode}`
    );
    try {
      this.controller.runJavaScript(script).catch((error: BusinessError) => {
        this.appendDiag(`runJavaScript failed: ${error.message}`);
      });
    } catch (error) {
      const err = error as BusinessError;
      this.appendDiag(`runJavaScript threw: ${err.message}`);
    }
  }

  /**
   * 开机自启状态的字符串形式（注入给渲染层）。
   *
   * unknown  = 壳还没查完（旧壳没有这个字段）→ 设置页不显示状态行，避免误导；
   * unsupported = 设备/版本不支持该能力（非 PC/2in1 或系统太旧）；
   * enabled/disabled = 用户是否已在「应用启动管理」里允许 Motrix 自启。
   */
  private autoStartupStatus(): string {
    if (!this.autoStartupKnown) {
      return 'unknown';
    }
    if (!this.autoStartupSupported) {
      return 'unsupported';
    }
    return this.autoStartupEnabled ? 'enabled' : 'disabled';
  }

  /** 自启状态变化（EntryAbility 查询完成）：把新值推给页面 */
  onAutoStartupChange(): void {
    const status = this.autoStartupStatus();
    this.appendDiag(`push autoStartup -> ${status}`);
    if (this.launchUrl.length === 0) {
      return;
    }
    const script = `window.__motrixSetPlatform && window.__motrixSetPlatform(${JSON.stringify({
      autoStartup: status,
    })});`;
    try {
      this.controller.runJavaScript(script).catch((error: BusinessError) => {
        this.appendDiag(`autoStartup runJavaScript failed: ${error.message}`);
      });
    } catch (error) {
      const err = error as BusinessError;
      this.appendDiag(`autoStartup runJavaScript threw: ${err.message}`);
    }
  }

  /**
   * 托盘右键「跳到某页」：EntryAbility 把路由写进 AppStorage 并递增序号，这里把它注入 Web。
   * 为什么绕一圈：UIAbility 拿不到 WebviewController（它属于页面），只能走 AppStorage 单向通道；
   * 页面拿到后调用注入的 window.__mtxNav（createHashRouter，改 hash 即可切页、不重载）。
   */
  onTrayRouteChange(): void {
    if (this.launchUrl.length === 0) {
      return;
    }
    const path = this.trayRoutePath;
    // 只接受应用内绝对路由，别让奇怪的字符串进到 location.hash
    if (path.length === 0 || path.charAt(0) !== '/') {
      return;
    }
    const script = `window.__mtxNav && window.__mtxNav(${JSON.stringify(path)})`;
    this.appendDiag(`tray route -> ${path}`);
    try {
      this.controller.runJavaScript(script).catch((error: BusinessError) => {
        this.appendDiag(`tray route runJavaScript failed: ${error.message}`);
      });
    } catch (error) {
      const err = error as BusinessError;
      this.appendDiag(`tray route runJavaScript threw: ${err.message}`);
    }
  }

  /**
   * r56：等"渲染层真正挂载"再撤开屏遮罩。
   *
   * 为什么不能只看 onPageEnd：主文档加载完（onPageEnd）时 React 还没挂载，
   * 页面自带的 `#renderer-boot`（m→o 字标 + shimmer）会露出来，用户看到
   * "系统大 logo → ArkUI 小 logo → 网页字标" 三段跳。
   *
   * 判据：注入脚本在 document start 给 `<html>` 加了 `mtx-booting`，
   * 渲染层挂载完成后（两次 rAF）才移除。这里每 120ms 问一次这个 class；
   * 移除即视为已挂载；最多问 12s，超时兜底放行，避免永远停在开屏页。
   */
  private startReadyPoll(): void {
    this.stopReadyPoll();
    this.readyPollCount = 0;
    this.pollRendererMounted();
  }

  private stopReadyPoll(): void {
    if (this.readyPollTimer >= 0) {
      clearTimeout(this.readyPollTimer);
      this.readyPollTimer = -1;
    }
  }

  private pollRendererMounted(): void {
    if (this.phase !== Phase.LOADING) {
      return;
    }
    this.readyPollCount += 1;
    const script = `document.documentElement.classList.contains('mtx-booting') ? '0' : '1'`;
    try {
      this.controller.runJavaScript(script, (error: BusinessError, result: string) => {
        if (this.phase !== Phase.LOADING) {
          return;
        }
        if (!error && result === '1') {
          this.webMounted = true;
          this.appendDiag(`renderer mounted (poll #${this.readyPollCount})`);
          this.maybeBecomeReady();
          return;
        }
        if (this.readyPollCount >= Index.READY_POLL_MAX) {
          this.appendDiag(`ready poll timeout after ${this.readyPollCount} tries, force ready`);
          this.webMounted = true;
          this.maybeBecomeReady();
          return;
        }
        this.readyPollTimer = setTimeout(() => {
          this.pollRendererMounted();
        }, Index.READY_POLL_INTERVAL_MS);
      });
    } catch (error) {
      const err = error as BusinessError;
      this.appendDiag(`ready poll threw: ${err.message}`);
      this.webMounted = true;
      this.maybeBecomeReady();
    }
  }

  /** 主文档 + 渲染层都就绪 ⇒ READY（两个条件缺一不可） */
  private maybeBecomeReady(): void {
    if (this.phase !== Phase.LOADING) {
      return;
    }
    if (!this.webPageLoaded || !this.webMounted) {
      return;
    }
    this.stopReadyPoll();
    this.phase = Phase.READY;
    this.retryCount = 0;
    this.appendDiag('phase -> READY (page + renderer mounted)');
    // 启动过程中如果系统外观/自启状态变过，页面这时才具备接收条件，补推一次
    this.onSystemAppearanceChange();
    this.onAutoStartupChange();
  }

  /** 超过 LOAD_TIMEOUT_MS 仍在 LOADING ⇒ 主动重新导航（ArkUI 的 src 没变不会自动重载） */
  private armLoadWatchdog(): void {
    setTimeout(() => {
      if (this.phase !== Phase.LOADING) {
        return;
      }
      this.appendDiag(`watchdog: ${LOAD_TIMEOUT_MS}ms 仍在 LOADING，主动 loadUrl 重试`);
      try {
        this.controller.loadUrl(this.launchUrl);
      } catch (error) {
        const err = error as BusinessError;
        this.appendDiag(`watchdog loadUrl failed: ${err.message}`);
      }
    }, LOAD_TIMEOUT_MS);
  }

  aboutToDisappear(): void {
    // 页面销毁不等于退出应用；真正的停止由 EntryAbility 的退出链负责
    this.notificationPoller?.stop();
    this.stopReadyPoll();
  }

  /** 起 Node → 等就绪 → 注入 cookie → 加载 Web */
  private async boot(): Promise<void> {
    const host = this.host;
    if (host === null) {
      return;
    }
    try {
      this.phase = Phase.BOOTING;
      // 可能已经在 onWindowStageCreate 里提前 start 了；这里只等结果（重复调用是幂等的）。
      const startOutcome = await (this.hostStart ?? host.start());
      if (!startOutcome.ok) {
        throw new Error(`Node 启动被拒绝：${startOutcome.note}`);
      }
      this.appendDiag('boot: 等待下载引擎就绪');
      const ready: HostReady = await host.waitReady();
      this.appendDiag(`host ready pid=${ready.pid} port=${ready.port} cookieLen=${ready.cookie.length}`);
      this.startSystemNotifications();

      const origin = `http://127.0.0.1:${ready.port}`;
      if (ready.cookie.length > 0) {
        // 把会话 cookie 灌进 ArkWeb 的 cookie store：之后 Web 里的 fetch / WS 都会带上它
        try {
          webview.WebCookieManager.configCookieSync(`${origin}/`, ready.cookie);
          this.appendDiag('cookie injected');
        } catch (error) {
          const err = error as BusinessError;
          this.appendDiag(`configCookieSync failed: ${err.message}`);
        }
      } else {
        this.appendDiag('no session cookie from host (会看到访问令牌页)');
      }

      this.phase = Phase.LOADING;
      this.appendDiag('boot: 正在载入界面');
      // r56：每次导航都重置"渲染层挂载"状态，并开始轮询（见 pollRendererMounted）
      this.stopReadyPoll();
      this.webPageLoaded = false;
      this.webMounted = false;
      // '?locale=' 有两个作用：
      //   1. 渲染层的"健康/恢复"兜底 UI 会读 location.search 的 locale 来决定英文还是中文
      //      （web 模式下它拿不到 session，缺这个参数就恒英文）；
      //   2. 让页面自己知道启动语言，调试日志更明确。
      const bootQuery = this.bootLocaleQuery();
      this.appendDiag(`LOADING url=${origin}/${bootQuery}`);
      this.launchUrl = `${origin}/${bootQuery}`;
      // Web 组件从第一帧就以 about:blank 预热（见 build()），这里显式导航到真实 UI。
      this.appLoadRequested = true;
      this.controller.loadUrl(this.launchUrl);
      // 注意：轮询必须等 onPageEnd 之后才开始 —— 刚 loadUrl 时 runJavaScript 可能还打在
      // 预热页 about:blank 上（没有 mtx-booting），会被误判成“已挂载”。
      this.armLoadWatchdog();
    } catch (error) {
      const err = error as Error;
      this.appendDiag(`boot failed: ${err.message}`);
      // Node 线程已经退出 / 上游 fatal 已落盘 ⇒ 重试没有意义（进程内 Node 不复位），
      // 直接给错误页，别让用户干等 6 轮自动重试。
      const terminal = !host.isRunning() || err.message.indexOf('阶段退出') >= 0;
      this.fail(err.message, terminal);
    }
  }

  /**
   * 读端侧 Node 日志的尾巴。
   *
   * 【为什么要有它】设备上没开 DevEco 时，用户拿不到 hilog；而这个文件里
   * 有 Node 崩溃的完整堆栈。把它显示在错误页上，维护者截图就能把现场带回来。
   */
  private readHostLogTail(maxBytes: number): string {
    try {
      const context = getContext(this) as common.UIAbilityContext;
      const logPath = `${context.filesDir}/node-output.log`;
      const stat = fs.statSync(logPath);
      const size = stat.size;
      const file = fs.openSync(logPath, fs.OpenMode.READ_ONLY);
      const readLen = Math.min(size, maxBytes);
      const buffer = new ArrayBuffer(readLen);
      fs.readSync(file.fd, buffer, { offset: size - readLen, length: readLen });
      fs.closeSync(file);
      const text = bufferToString(buffer);
      // 只保留最后 12 行，错误页放不下更多
      const lines = text.split('\n');
      return lines.slice(Math.max(0, lines.length - 12)).join('\n');
    } catch (error) {
      return '（读不到 node-output.log）';
    }
  }

  /** 失败：预算内静默重试（仍显示启动页），预算用尽才给错误页 */
  private fail(message: string, terminal: boolean = false): void {
    this.errorText = message;
    this.logTail = this.readHostLogTail(8192);
    // r56：任何失败都停掉"等渲染层挂载"轮询；重试时由 boot() 重新开始
    this.stopReadyPoll();
    this.webPageLoaded = false;
    this.webMounted = false;
    if (!terminal && this.retryCount < Index.AUTO_RETRY_MAX) {
      this.retryCount += 1;
      this.phase = Phase.BOOTING;
      // 清掉 launchUrl 让启动页遮住、并把 onPageEnd 重新归零；下次 boot() 会重新 loadUrl
      this.launchUrl = '';
      this.appLoadRequested = false;
      this.appendDiag(`retry ${this.retryCount}/${Index.AUTO_RETRY_MAX}: ${message}`);
      setTimeout(() => {
        this.boot();
      }, 600 * this.retryCount);
      return;
    }
    this.phase = Phase.ERROR;
    this.appendDiag(`ERROR: ${message}`);
  }

  /**
   * 自绘窗口标题栏。
   *
   * 只在系统标题栏已被隐藏（decorHidden=true）时渲染 —— 否则会变成"没有标题栏"的死窗口。
   * 拖拽用 `startMoving()`（官方提供的"应用热区拖动窗口"能力），
   * 三个按钮直接调 window.minimize/maximize/destroyWindow。
   */
  build() {
    // 沉浸式（Clash 式）：**不画标题栏**，Web 内容铺满整窗；
    // 系统三键悬浮在右上角，拖拽热区由注入的 Web 侧"隐形拖条"负责。
    Stack() {
      // Web 组件**从第一帧就存在**：先以 about:blank 把 ArkWeb 内核预热起来（r48 冷启动，
      // 与 Node 启动并行）；宿主 ready 后由 boot() 显式 loadUrl 到真实 UI。
      // 启动页（下方 phase !== READY 的遮罩）会盖住它。
      if (true) {
        Web({ src: 'about:blank', controller: this.controller })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(false)
          .imageAccess(true)
          .onlineImageAccess(true)
          // 官方 UI 自带 prefers-color-scheme，交给页面自己适配，不做强制反色
          .darkMode(WebDarkMode.Auto)
          .forceDarkAccess(false)
          // 把系统语言/颜色模式注入页面（document start，早于页面脚本）
          .javaScriptOnDocumentStart([{ script: this.platformScript, scriptRules: ['*'] }])
          // window.open / target=_blank：ArkWeb 默认会**什么都不做**（因为没有新窗口容器），
          // 于是设置页里的官网/GitHub 链接点了没反应。这里统一接管：
          //   · http(s) 外链 → 交给系统浏览器（更符合桌面习惯，也不会把 UI 困在应用内）
          //   · motrix-action:// → 执行我们自己的系统动作（在文件夹中显示 / 打开文件）
          .onWindowNew((event) => {
            if (!event) {
              return;
            }
            const target = event.targetUrl ?? '';
            this.appendDiag(`onWindowNew url=${target}`);
            // 不创建新窗口：设置为 null 让 ArkWeb 放弃建窗，我们自己转发
            try {
              event.handler.setWebController(null);
            } catch (error) {
              const err = error as BusinessError;
              this.appendDiag(`setWebController(null) failed: ${err.message}`);
            }
            this.dispatchExternal(target);
          })
          // 拦截 motrix-action:// 的自定义 scheme（渲染层用它把平台动作转给 ArkTS）
          .onLoadIntercept((event) => {
            if (!event) {
              return false;
            }
            const url = event.data.getRequestUrl();
            if (url.indexOf('motrix-action://') === 0) {
              this.appendDiag(`action url=${url}`);
              this.actions?.handleIfAction(url);
              return true;
            }
            return false;
          })
          .onPageBegin(() => {
            this.appendDiag('onPageBegin');
          })
          .onProgressChange((event) => {
            if (!event) {
              return;
            }
            // 只在整十进度打点，避免刷爆日志
            const percent = event.newProgress;
            if (percent >= 0 && percent % 10 === 0) {
              this.appendDiag(`onProgress ${percent}%`);
            }
          })
          .onPageEnd(() => {
            this.appendDiag(`onPageEnd appLoadRequested=${this.appLoadRequested}`);
            if (this.phase === Phase.ERROR) {
              return;
            }
            // about:blank 预热页的结束不算"应用就绪"：真实 URL 还没请求（r48）。
            if (!this.appLoadRequested || this.launchUrl.length === 0) {
              return;
            }
            // r56：主文档到了还不够——渲染层（React）还要 ~1s 才挂载。
            // 开屏遮罩留到 webMounted 再撤，避免中途露出网页自带的字标 loading。
            this.webPageLoaded = true;
            this.startReadyPoll();
            this.maybeBecomeReady();
          })
          .onErrorReceive((event) => {
            if (!event) {
              return;
            }
            const error = event.error;
            const isMain = event.request.isMainFrame();
            this.appendDiag(
              `onErrorReceive main=${isMain} code=${error.getErrorCode()} info=${error.getErrorInfo()} url=${event.request.getRequestUrl()}`
            );
            // ★ 只有**主文档**失败才算整页失败。
            //   子资源（图片/字体/被 abort 的请求）失败在 SPA 里非常常见，把它们当整页失败
            //   会触发 boot() 重来 ⇒ 页面被重载，用户看到"突然又回到正在加载"。
            if (isMain) {
              this.fail(`页面加载失败：${error.getErrorInfo()}`);
            }
          })
          .onHttpErrorReceive((event) => {
            if (!event) {
              return;
            }
            const code = event.response.getResponseCode();
            const isMain = event.request.isMainFrame();
            this.appendDiag(`onHttpError main=${isMain} code=${code} url=${event.request.getRequestUrl()}`);
            // ★ 同理：只有主文档的 4xx/5xx 才算页面失败。
            //   实测踩坑：设置页「检查更新」会 POST /rpc/command/command:checkForUpdates，
            //   上游在无外网/无 release 源时返回 500；原来的实现把它当整页失败 ⇒ 自动重试
            //   ⇒ 整页重载（用户体感：点一下检查更新，前端就回"正在加载"）。
            if (isMain && code >= 400) {
              this.fail(`HTTP ${code}（${event.request.getRequestUrl()}）`);
            }
          })
          .onConsole((event) => {
            if (event) {
              this.appendDiag(`web-console: ${event.message.getMessage()}`);
            }
            return false;
          })
      }

      if (this.phase !== Phase.READY) {
        if (this.phase === Phase.ERROR) {
          Column({ space: 14 }) {
            Text('Motrix 启动失败').fontSize(20).fontWeight(FontWeight.Medium)
              .fontColor(this.primaryTextColor())
            Text(this.errorText)
              .fontSize(14)
              .fontColor(this.secondaryTextColor())
              .textAlign(TextAlign.Center)
              .padding({ left: 24, right: 24 })
            Text('应用进程还在（没有闪退）。可以先点「重试」；若反复出现，请关闭应用重开，并把下面的日志发回。')
              .fontSize(12)
              .fontColor(this.hintTextColor())
              .textAlign(TextAlign.Center)
              .padding({ left: 24, right: 24 })
            if (this.logTail.length > 0) {
              Scroll() {
                Text(this.logTail)
                  .fontSize(11)
                  .fontFamily('monospace')
                  .fontColor(this.logPanelTextColor())
                  .textAlign(TextAlign.Start)
                  .width('100%')
                  .padding(10)
              }
              .constraintSize({ maxHeight: 240 })
              .width('92%')
              .backgroundColor(this.logPanelBackground())
              .borderRadius(8)
            }
            Button('重试').onClick(() => {
              this.retryCount = 0;
              this.launchUrl = '';
              this.appLoadRequested = false;
              this.boot();
            })
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
          .backgroundColor(this.panelBackground())
        } else {
          // 开屏（r54 Clash 风格，r56 修三段跳）：
          //   系统增强启动页 + 这个 ArkUI 遮罩都渲染**同一张** splash_background.png，
          //   尺寸/位置完全一致 ⇒ 冷启动只看到一张图，不会大 logo → 小 logo → 字标。
          //   遮罩会一直留到"渲染层真正挂载"（而不是主文档 onPageEnd），见 maybeBecomeReady。
          Stack() {
            Image($r('app.media.splash_background'))
              .width('100%')
              .height('100%')
              .objectFit(ImageFit.Contain)
              .draggable(false)
          }
          .width('100%')
          .height('100%')
          .backgroundColor(this.panelBackground())
        }
      }
    }
    .width('100%')
    .height('100%')
  }
}
/**
 * ArrayBuffer → 字符串（只用于把日志尾巴显示出来）。
 * 用 Uint8Array + 手写 ASCII/UTF-8 解码太重；日志主要是 ASCII，
 * 中文按 UTF-8 逐段解码即可（TextDecoder 在 ArkTS 里可用）。
 */
function bufferToString(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // 去掉尾部不完整的 UTF-8 续字节，避免解码抛错
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) {
    end -= 1;
  }
  const decoder = new util.TextDecoder('utf-8');
  return decoder.decode(bytes.subarray(0, end));
}
