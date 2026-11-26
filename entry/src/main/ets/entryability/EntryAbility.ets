/**
 * Motrix 的入口 Ability。
 *
 * 只做四件事：
 *   1. 建窗口、loadContent 主页面（页面自己负责起 Node 与加载 Web）；
 *   2. 申请长时任务（下载必须能在窗口不可见时继续跑）；
 *   3. 退出时按"先停 Node、再退"的顺序收尾；
 *   4. 把窗口几何/最小尺寸这类"PC 上必须有"的形态调好。
 *
 * 现在**没有**做的（后续里程碑）：托盘、通知、深链（magnet://）、开机自启。
 */

import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { i18n } from '@kit.LocalizationKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError, commonEventManager } from '@kit.BasicServicesKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { wantAgent } from '@kit.AbilityKit';
import { abilityAccessCtrl, Permissions } from '@kit.AbilityKit';
import { WindowMemory } from '../runtime/WindowMemory';
import { ImmersiveWindow } from '../runtime/ImmersiveWindow';
import { SystemTray, TRAY_MENU_SHOW } from '../runtime/SystemTray';
import { TaskbarProgress } from '../runtime/TaskbarProgress';
import {
  appendDeepLinkCommand,
  torrentImportDir,
  DEEPLINK_CMD_ADD_MAGNET,
  DEEPLINK_CMD_ADD_TORRENT,
} from '../runtime/TrayBridge';
import { autoStartupManager } from '@kit.AbilityKit';
import { preStartHost } from '../runtime/HostBoot';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-ABILITY';

export default class EntryAbility extends UIAbility {
  private windowStageRef: window.WindowStage | null = null;
  private keptAlive: boolean = false;
  private diagPath: string = '';
  /** 窗口几何记忆（大小/位置） */
  private windowMemory: WindowMemory | null = null;
  /** 沉浸式窗口（隐藏系统标题栏 + 深色底色 + 自绘标题栏的能力） */
  private immersive: ImmersiveWindow = new ImmersiveWindow();
  /** 系统托盘（PC 2in1 的状态栏图标） */
  private tray: SystemTray | null = null;
  /** 主窗口是否被"收进托盘"（hideAbility）；唤回时必须先 showAbility 再 showWindow */
  private hiddenToTray: boolean = false;
  /** Dock/任务栏图标进度条（quickBarManager） */
  private taskbar: TaskbarProgress = new TaskbarProgress();
  /** 托盘面板 → 主进程的公共事件订阅者 */
  private trayEventSubscriber: commonEventManager.CommonEventSubscriber | null = null;
  /** 最近一次确定的系统颜色模式（0=DARK / 1=LIGHT / -999=未知）。
   *  存在的意义：onConfigurationUpdate 里的 config.colorMode 有时是陈旧的 NOT_SET，
   *  若直接写回 AppStorage 会把 onSystemConfigurationUpdated 刚推来的正确值冲掉。 */
  private lastKnownColorModeCode: number = -999;

  /** 能力层诊断落到文件（hilog 缓冲几秒就被冲掉，排查"切换不生效"只能靠它） */
  private diag(line: string): void {
    hilog.info(DOMAIN, TAG, '%{public}s', line);
    if (this.diagPath.length === 0) {
      return;
    }
    try {
      const file = fs.openSync(
        this.diagPath,
        fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.APPEND
      );
      // r53：本地时间（上游/旧实现用 toISOString ⇒ UTC，北京时间会早 8 小时）
      const now = new Date();
      const pad2 = (value: number): string => value < 10 ? `0${value}` : `${value}`;
      const stamp = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${now.getMilliseconds() < 100 ? (now.getMilliseconds() < 10 ? `00${now.getMilliseconds()}` : `0${now.getMilliseconds()}`) : `${now.getMilliseconds()}`}`;
      fs.writeSync(file.fd, `${stamp} ${line}\n`);
      fs.closeSync(file);
    } catch (error) {
      // 诊断失败不影响主流程
    }
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, 'onCreate');
    try {
      this.diagPath = `${this.context.filesDir}/ability-diag.log`;
    } catch (error) {
      this.diagPath = '';
    }
    this.diag('===== onCreate =====');
    try {
      this.windowMemory = new WindowMemory(this.context.filesDir);
    } catch (error) {
      this.windowMemory = null;
    }
    this.setupTray();
    this.setupTrayEvents();
    // 冷启动深链：从磁力链/种子文件直接拉起应用时，want.uri 在 onCreate 就能拿到
    this.handleDeepLink(want, 'onCreate');
    this.reportAutoStartupStatus();

    // 应用默认**不跟随**系统深浅色（实测系统深色时 context.config.colorMode 仍是 LIGHT）。
    // 官方口径：主动 setColorMode(COLOR_MODE_NOT_SET) 才是"跟随系统"。
    // 放在 publishSystemAppearance 之前，保证读到的就是跟随后的真实值。
    try {
      this.context.getApplicationContext().setColorMode(
        ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET
      );
    } catch (error) {
      const err = error as BusinessError;
      this.diag(`setColorMode(NOT_SET) failed: ${err.message}`);
    }
    this.publishSystemAppearance();
    this.requestRuntimePermissions();
  }

  /**
   * 系统语言 / 深色模式变化时，把新值推到 AppStorage，页面收到后注入 Web。
   *
   * 【为什么要绕 AppStorage】UIAbility 拿得到 onConfigurationUpdate，但 Web 组件的
   * controller 在页面里；用 AppStorage 做一条单向通道最省事（页面 @StorageProp + @Watch）。
   */
  onConfigurationUpdate(config: Configuration): void {
    let code = -999;
    try {
      code = config.colorMode as number;
    } catch (error) {
      code = -998;
    }
    this.diag(`onConfigurationUpdate colorMode=${code}`);
    // ★ 这里的 config.colorMode 实测**不可信**：系统切到深色后 2~3 秒它还会回一个 1(LIGHT)，
    //   把 onSystemConfigurationUpdated 刚推来的正确值覆盖掉（日志 03:43:27 dark → 03:43:30 light）。
    //   所以颜色模式只认 onSystemConfigurationUpdated；这里只更新语言。
    this.publishSystemLanguage();
  }

  /** 只刷新语言（onConfigurationUpdate 用；颜色模式不可信，见调用处注释） */
  private publishSystemLanguage(): void {
    let language = '';
    try {
      language = i18n.System.getSystemLanguage();
    } catch (error) {
      language = '';
    }
    if (language.length === 0) {
      return;
    }
    AppStorage.setOrCreate('motrix.systemLanguage', language);
    this.diag(`publishSystemLanguage language=${language}`);
  }

  private publishSystemAppearance(explicitCode: number = -999): void {
    let language = '';
    try {
      language = i18n.System.getSystemLanguage();
    } catch (error) {
      language = '';
    }

    // 取值优先级：调用方给的（onConfigurationUpdate 的新 config）> 已知值 > 当前 config
    let code = explicitCode;
    if (code !== (ConfigurationConstant.ColorMode.COLOR_MODE_DARK as number) &&
      code !== (ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT as number)) {
      if (this.lastKnownColorModeCode === (ConfigurationConstant.ColorMode.COLOR_MODE_DARK as number) ||
        this.lastKnownColorModeCode === (ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT as number)) {
        code = this.lastKnownColorModeCode;
      } else {
        try {
          code = this.context.config.colorMode as number;
        } catch (error) {
          code = ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET as number;
        }
      }
    }

    let text = '';
    if (code === (ConfigurationConstant.ColorMode.COLOR_MODE_DARK as number)) {
      text = 'dark';
      this.lastKnownColorModeCode = code;
    } else if (code === (ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT as number)) {
      text = 'light';
      this.lastKnownColorModeCode = code;
    } else if (this.lastKnownColorModeCode === (ConfigurationConstant.ColorMode.COLOR_MODE_DARK as number)) {
      text = 'dark';
    } else if (this.lastKnownColorModeCode === (ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT as number)) {
      text = 'light';
    }

    AppStorage.setOrCreate('motrix.systemLanguage', language);
    AppStorage.setOrCreate('motrix.systemColorMode', text);
    AppStorage.setOrCreate('motrix.systemColorModeCode', code);
    // 窗口底色跟着主题走（深浅切换时不闪白）
    if (text.length > 0) {
      this.applyWindowBackground(text === 'dark');
    }
    this.diag(
      `publishSystemAppearance language=${language} colorMode=${text} code=${code} explicit=${explicitCode}`
    );
  }

  /** 让应用跟随系统深浅色，并订阅"系统配置变化"（API 24+，比 onConfigurationUpdate 更直接） */
  private applyFollowSystemColorMode(): void {
    const appContext = this.context.getApplicationContext();
    try {
      appContext.setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
      this.diag('setColorMode(NOT_SET) ok');
    } catch (error) {
      const err = error as BusinessError;
      hilog.error(DOMAIN, TAG, 'setColorMode(NOT_SET) failed: %{public}s', err.message);
    }
    try {
      appContext.onSystemConfigurationUpdated({
        onColorModeUpdated: (mode: ConfigurationConstant.ColorMode) => {
          this.diag(`onSystemConfigurationUpdated.onColorModeUpdated mode=${mode as number}`);
          this.publishColorMode(mode);
        },
        onLanguageUpdated: (language: string) => {
          this.diag(`onSystemConfigurationUpdated.onLanguageUpdated language=${language}`);
          AppStorage.setOrCreate('motrix.systemLanguage', language);
        },
      });
      this.diag('onSystemConfigurationUpdated registered');
    } catch (error) {
      const err = error as BusinessError;
      this.diag(`onSystemConfigurationUpdated failed: ${err.message}`);
    }
    // setColorMode 生效后重新读一次（并打数值，方便区分 NOT_SET=-1 / DARK=0 / LIGHT=1）
    setTimeout(() => {
      this.publishSystemAppearance();
    }, 300);
  }

  private publishColorMode(mode: ConfigurationConstant.ColorMode): void {
    const code = mode as number;
    if (code === (ConfigurationConstant.ColorMode.COLOR_MODE_DARK as number)) {
      this.lastKnownColorModeCode = code;
      AppStorage.setOrCreate('motrix.systemColorMode', 'dark');
      AppStorage.setOrCreate('motrix.systemColorModeCode', code);
      return;
    }
    if (code === (ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT as number)) {
      this.lastKnownColorModeCode = code;
      AppStorage.setOrCreate('motrix.systemColorMode', 'light');
      AppStorage.setOrCreate('motrix.systemColorModeCode', code);
      return;
    }
    // NOT_SET：跟随系统但拿不到具体值 —— 保留上一次已知值，别覆盖成空
    AppStorage.setOrCreate('motrix.systemColorModeCode', code);
  }

  /**
   * 申请运行期权限（user_grant 那几条）。
   *
   * 为什么必须在这里主动申请：这两条是 `user_grant`，**装在手机上不会自动授予**，
   * 用户必须看到弹窗点"允许"（或去 设置 → 应用 → 权限 里打开）。
   * 不申请的话：下载目录/文档目录的写入会以 EPERM 的形式失败，而且失败点离权限很远，
   * 看起来像"代码写错了"。
   *
   * 失败不阻断启动：拿不到下载目录权限只是"不能存到公共目录"，
   * 宿主会退回沙箱目录（见 scripts/host/main.mjs 的 ensureWritableDir）。
   */
  private requestRuntimePermissions(): void {
    const permissions: Permissions[] = [
      'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
      'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
    ];
    try {
      const manager = abilityAccessCtrl.createAtManager();
      manager.requestPermissionsFromUser(this.context, permissions)
        .then((result) => {
          for (let i = 0; i < result.authResults.length; i++) {
            hilog.info(DOMAIN, TAG, 'permission %{public}s => %{public}d',
              result.permissions[i], result.authResults[i]);
          }
        })
        .catch((error: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'requestPermissionsFromUser failed: %{public}s', error.message);
        });
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(DOMAIN, TAG, 'permission request threw: %{public}s', err.message);
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.windowStageRef = windowStage;
    // 关闭按钮拦截（收进托盘）：窗口一被创建就能挂监听，不用等 loadContent
    this.setupCloseToTray(windowStage);
    // r48 冷启动：Node 启动（~2.5s）与页面/ArkWeb 初始化**并行**执行，
    // 不要让 UI 先就绪再开始等 Node。页面里只 await 同一个 Promise（见 runtime/HostBoot.ets）。
    try {
      preStartHost(this.context);
    } catch (error) {
      const err = error as Error;
      hilog.warn(DOMAIN, TAG, 'preStartHost threw: %{public}s', err.message);
    }
    windowStage.loadContent('pages/Index', (error: BusinessError) => {
      if (error.code) {
        hilog.error(DOMAIN, TAG, 'loadContent failed: %{public}s', JSON.stringify(error));
        return;
      }
      hilog.info(DOMAIN, TAG, 'loadContent done');
      this.tuneWindow(windowStage);
      // 窗口几何恢复（必须在 loadContent 之后：之前窗口还没真正成形）
      this.restoreWindowGeometry(windowStage);
      // ★ 官方要求：setColorMode 必须在"窗口已创建 + 页面已 loadContent"之后调用。
      //   之前放在 onCreate 里（太早）等于没生效，所以系统深色时应用仍是浅色。
      this.applyFollowSystemColorMode();
      // 沉浸式：隐藏系统标题栏 + 深色窗口底色（页面据此渲染自绘标题栏）
      this.applyImmersiveWindow(windowStage);
      // Dock/任务栏图标进度条：读宿主写的 tray-state.json，窗口在不在都继续跑
      this.taskbar.start(this.context, this.context.filesDir, (line: string) => {
        this.diag(line);
      });
    });
    this.acquireBackgroundTask();
  }

  onWindowStageDestroy(): void {
    // 窗口即将销毁：把最后一次几何落盘（防抖可能有未刷的那一次）
    this.windowMemory?.flush();
    this.windowStageRef = null;
  }

  /**
   * 系统托盘：加到 PC 状态栏图标区。
   *
   * 能力来自 HMS `DeskTopExtensionKit` 的 statusBarManager（普通三方应用可用，仅中国大陆 PC）。
   * 不支持时（手机/平板/海外版）静默跳过，不影响任何其他功能。
   */
  private setupTray(): void {
    try {
      const tray = new SystemTray(this.context);
      this.tray = tray;
      tray.add().then((ok) => {
        this.diag(`tray add -> ${ok}`);
        if (ok) {
          tray.registerListeners((menuCode) => {
            this.onTrayMenu(menuCode);
          });
        }
      }).catch((error: BusinessError) => {
        this.diag(`tray add failed: ${error.message}`);
      });
    } catch (error) {
      const err = error as BusinessError;
      this.diag(`setupTray threw: ${err.message}`);
    }
  }

  /** 托盘菜单/左键点击的处理 */
  private onTrayMenu(menuCode: string): void {
    this.diag(`tray menu: ${menuCode}`);
    // 注意：右键菜单里没有"退出"（系统自带），这里只处理"打开/跳页"
    const pagePrefix = 'tray:page:';
    if (menuCode.indexOf(pagePrefix) === 0) {
      // 页面项：先把窗口唤回（可能在托盘里），再切 Web 路由。
      // 延后 400ms：hideAbility 唤回是异步的，窗口还没真正可见时 WebView 可能被系统暂停，
      // 立刻 runJavaScript 要么排队要么丢（Clash 鸿蒙版也是延后导航的）。
      const route = menuCode.slice(pagePrefix.length);
      this.restoreMainWindow();
      setTimeout(() => {
        this.navigateWeb(route);
      }, 400);
      return;
    }
    // 默认（含 TRAY_MENU_SHOW）
    this.restoreMainWindow();
  }

  /**
   * 托盘左键面板 / 右键菜单共用的唤回路径。
   *
   * hideAbility() 是 **Ability 级隐藏**，只 showWindow() 拉不回来：
   * 必须先 showAbility()（把 Ability 拉回前台）再 showWindow()，最后 restore()
   * 兜底（Clash 鸿蒙版实机验证过的顺序，别改）。
   */
  private restoreMainWindow(): void {
    const stage = this.windowStageRef;
    if (stage === null) {
      return;
    }
    let win: window.Window;
    try {
      win = stage.getMainWindowSync();
    } catch (error) {
      this.diag(`restoreMainWindow getMainWindow failed: ${(error as BusinessError).message}`);
      return;
    }
    const reveal = (): void => {
      win.showWindow().then(() => {
        this.hiddenToTray = false;
        this.diag('main window shown');
        win.restore().catch((error: BusinessError) => {
          this.diag(`restore after showWindow failed: ${error.message}`);
        });
      }).catch((error: BusinessError) => {
        this.diag(`showWindow failed, try restore: ${error.message}`);
        win.restore().then(() => {
          this.hiddenToTray = false;
        }).catch((inner: BusinessError) => {
          this.diag(`restore failed: ${inner.message}`);
        });
      });
    };
    if (this.hiddenToTray) {
      this.context.showAbility().then(reveal).catch((error: BusinessError) => {
        this.diag(`showAbility failed, still try showWindow: ${error.message}`);
        reveal();
      });
      return;
    }
    reveal();
  }

  /**
   * 关闭按钮 = 收进托盘，应用继续跑（对齐 Windows 下载器的习惯，也是维护者明确要求）。
   *
   * `windowStage.on('windowStageClose')` 只在用户点主窗三键区 × 时触发，
   * 同步返回 true 即拦截关闭；随后 hideAbility() 把整个应用藏起来。
   * 托盘没装上就**不拦截**（否则用户收进去没有回程入口，成了"幽灵进程"）。
   */
  private setupCloseToTray(windowStage: window.WindowStage): void {
    try {
      windowStage.on('windowStageClose', (): boolean => {
        const trayAvailable = this.tray !== null && this.tray.isInstalled();
        if (!trayAvailable) {
          this.diag('close -> no tray, default close');
          return false;
        }
        this.diag('close -> hide ability to tray');
        this.hideMainWindowToTray();
        return true;
      });
      this.diag('close button intercepted: hideAbility -> tray');
    } catch (error) {
      const err = error as BusinessError;
      this.diag(`setupCloseToTray failed (fallback default close): ${err.message}`);
    }
  }

  private hideMainWindowToTray(): void {
    const stage = this.windowStageRef;
    this.context.hideAbility().then(() => {
      this.hiddenToTray = true;
      this.diag('main window hidden; process + tray continue');
    }).catch((error: BusinessError) => {
      this.diag(`hideAbility failed, fallback minimize: ${error.message}`);
      if (stage === null) {
        return;
      }
      try {
        stage.getMainWindowSync().minimize().then(() => {
          this.hiddenToTray = true;
          this.diag('main window minimized (fallback)');
        }).catch((inner: BusinessError) => {
          this.diag(`minimize failed: ${inner.message}`);
        });
      } catch (inner) {
        this.diag(`minimize throw: ${(inner as BusinessError).message}`);
      }
    });
  }

  /**
   * 把 Web UI 切到指定 hash 路由（托盘右键页面项用）。
   *
   * 渲染层是 createHashRouter，所以直接改 location.hash 即可，不会重新加载页面。
   * 页面侧在 Index.ets 里注入的 `window.__mtxNav` 负责这件事；
   * 这里通过 AppStorage 把"要去的路由"递过去，由页面 @Watch 触发 runJavaScript
   * （UIAbility 拿不到 WebviewController，只能走这条单向通道）。
   */
  private navigateWeb(route: string): void {
    AppStorage.setOrCreate('motrix.trayRoutePath', route);
    const seq = (AppStorage.get<number>('motrix.trayRouteSeq') ?? 0) + 1;
    AppStorage.setOrCreate('motrix.trayRouteSeq', seq);
    this.diag(`tray navigate requested: ${route} (seq=${seq})`);
  }

  /**
   * 订阅托盘面板（独立扩展进程）发来的公共事件。
   *
   * 面板与主进程是两个进程，文件只能传数据、不能"叫醒"主进程，
   * 所以「打开主界面 / 退出」走公共事件（Clash 鸿蒙版同款做法）。
   */
  private setupTrayEvents(): void {
    try {
      const info: commonEventManager.CommonEventSubscribeInfo = {
        events: ['com.lyldeer.motrix.tray.open'],
      };
      commonEventManager.createSubscriber(info,
        (err: BusinessError, subscriber: commonEventManager.CommonEventSubscriber): void => {
          if (err) {
            this.diag(`tray event subscriber failed: ${err.code} ${err.message}`);
            return;
          }
          this.trayEventSubscriber = subscriber;
          commonEventManager.subscribe(subscriber,
            (subErr: BusinessError, data: commonEventManager.CommonEventData): void => {
              if (subErr) {
                this.diag(`tray event receive failed: ${subErr.code}`);
                return;
              }
              const event = data.event;
              this.diag(`tray event: ${event}`);
              if (event === 'com.lyldeer.motrix.tray.open') {
                this.restoreMainWindow();
              }
            });
        });
    } catch (error) {
      const err = error as BusinessError;
      this.diag(`setupTrayEvents threw: ${err.message}`);
    }
  }

  /** 把主窗口拉到前台（托盘点击/二次启动时用） */
  private bringMainWindowToFront(): void {
    try {
      const stage = this.windowStageRef;
      if (stage !== null) {
        const win = stage.getMainWindowSync();
        win.showWindow().catch((error: BusinessError) => {
          this.diag(`showWindow failed: ${error.message}`);
        });
      }
    } catch (error) {
      const err = error as BusinessError;
      this.diag(`bringMainWindowToFront failed: ${err.message}`);
    }
  }

  /**
   * 开机自启状态检测。
   *
   * 重要事实（实测 SDK）：`autoStartupManager` **只提供查询**，没有"设置为自启"的 API
   * （只有 getAutoStartupStatusForSelf / isAutoStartupSupported）。
   * 鸿蒙上开机自启**必须由用户在 设置 → 应用启动管理 手动打开**，应用无法自行声明。
   * 所以这里只做两件事：查询状态 + 把结果放到 AppStorage，页面上可以提示用户去系统设置开。
   */
  private reportAutoStartupStatus(): void {
    try {
      if (!autoStartupManager.isAutoStartupSupported()) {
        AppStorage.setOrCreate('motrix.autoStartupSupported', false);
        // known=true 表示"已查询过"：页面上才能区分"设备不支持"与"还没查到"
        AppStorage.setOrCreate('motrix.autoStartupKnown', true);
        this.diag('auto startup not supported on this device');
        return;
      }
      autoStartupManager.getAutoStartupStatusForSelf()
        .then((enabled: boolean) => {
          AppStorage.setOrCreate('motrix.autoStartupSupported', true);
          AppStorage.setOrCreate('motrix.autoStartupEnabled', enabled);
          AppStorage.setOrCreate('motrix.autoStartupKnown', true);
          this.diag(`auto startup: supported=true enabled=${enabled}`);
        })
        .catch((error: BusinessError) => {
          AppStorage.setOrCreate('motrix.autoStartupSupported', false);
          AppStorage.setOrCreate('motrix.autoStartupKnown', true);
          this.diag(`auto startup query failed: ${error.message}`);
        });
    } catch (error) {
      const err = error as BusinessError;
      AppStorage.setOrCreate('motrix.autoStartupSupported', false);
      AppStorage.setOrCreate('motrix.autoStartupKnown', true);
      this.diag(`auto startup threw: ${err.message}`);
    }
  }

  /**
   * 应用沉浸式窗口设置。
   *
   * 结果通过 AppStorage 传给页面（`motrix.decorHidden`）：
   * 页面只在**系统标题栏确实已隐藏**时才渲染自绘标题栏，
   * 否则会出现"两个标题栏都没有"的死窗口。
   */
  private applyImmersiveWindow(windowStage: window.WindowStage): void {
    try {
      const mainWindow = windowStage.getMainWindowSync();
      // EntryAbility 里没有 systemColorMode 字段（那是页面的 @StorageProp），
      // 直接从 AppStorage 读当前值。
      const currentMode = AppStorage.get<string>('motrix.systemColorMode') ?? '';
      const dark = currentMode !== 'light';
      const state = this.immersive.apply(mainWindow, dark);
      AppStorage.setOrCreate('motrix.decorHidden', state.decorHidden);
      // 三键几何：隐藏标题栏后系统三键悬浮在右上角，页面要按这个宽度右侧留白
      AppStorage.setOrCreate('motrix.titleButtonWidth', state.titleButtonWidth);
      AppStorage.setOrCreate('motrix.titleButtonHeight', state.titleButtonHeight);
      AppStorage.setOrCreate('motrix.decorHeight', state.decorHeight);
      this.diag(
        `immersive: decorHidden=${state.decorHidden} dark=${dark} btnW=${state.titleButtonWidth} btnH=${state.titleButtonHeight} decorH=${state.decorHeight}`
      );
    } catch (error) {
      const err = error as BusinessError;
      this.diag(`applyImmersiveWindow failed: ${err.message}`);
      AppStorage.setOrCreate('motrix.decorHidden', false);
    }
  }

  /** 主题变了只更新窗口底色与三键配色（不重设装饰可见性，避免闪一下） */
  private applyWindowBackground(dark: boolean): void {
    try {
      this.immersive.applyBackgroundColor(dark);
      this.immersive.applyButtonColorMode(dark);
    } catch (error) {
      // 忽略
    }
  }

  /** 恢复上次窗口大小/位置，并订阅后续变化（见 runtime/WindowMemory.ets） */
  private restoreWindowGeometry(windowStage: window.WindowStage): void {
    const memory = this.windowMemory;
    if (memory === null) {
      return;
    }
    try {
      const mainWindow = windowStage.getMainWindowSync();
      memory.restore(mainWindow)
        .then(() => {
          memory.watch(mainWindow);
        })
        .catch((error: BusinessError) => {
          this.diag(`window restore failed: ${error.message}`);
        });
    } catch (error) {
      const err = error as BusinessError;
      this.diag(`restoreWindowGeometry failed: ${err.message}`);
    }
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, 'onForeground');
  }

  /** 应用已在运行时又被拉起（桌面图标再点 / 托盘点击）→ 把窗口带到前台 */
  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.diag('onNewWant -> restore main window');
    this.restoreMainWindow();
    this.handleDeepLink(want, 'onNewWant');
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, 'onBackground');
  }

  /**
   * 深链入口（磁力链 / .torrent 文件关联）。
   *
   * 处理方式是"转成宿主命令"而不是 ArkTS 直接发 RPC：
   *   · ArkTS 侧打 127.0.0.1 会受系统代理影响（历史踩坑），宿主自己打自己一定通；
   *   · operator 凭据只留在宿主进程里；
   *   · 冷启动时宿主还没起来也没关系——命令先落队列，宿主起来后马上执行。
   *
   * 磁力链 → `addMagnet`；种子文件 → 先读字节拷到 <dataDir>/imports/ 再 `addTorrent`（宿主转 base64）。
   */
  private handleDeepLink(want: Want, source: string): void {
    let uri = '';
    try {
      uri = want.uri !== undefined && want.uri !== null ? want.uri : '';
    } catch (error) {
      uri = '';
    }
    if (uri.length === 0) {
      return;
    }
    const shown = uri.length > 120 ? `${uri.slice(0, 120)}…` : uri;
    this.diag(`deep link (${source}): ${shown}`);
    if (uri.indexOf('magnet:') === 0) {
      const ok = appendDeepLinkCommand(this.context.filesDir, DEEPLINK_CMD_ADD_MAGNET, uri);
      this.diag(`deep link magnet queued ok=${ok}`);
      return;
    }
    if (uri.indexOf('file://') === 0 || uri.indexOf('content://') === 0) {
      this.importTorrentFile(uri);
      return;
    }
    this.diag('deep link ignored (unsupported scheme)');
  }

  /** 把系统"打开方式"给过来的 .torrent 拷贝到应用数据目录（URI 只在本次启动有效） */
  private importTorrentFile(uri: string): void {
    const MAX_TORRENT_BYTES = 8 * 1024 * 1024;
    try {
      const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      let size = 0;
      try {
        const stat = fs.statSync(file.fd);
        size = stat.size;
      } catch (error) {
        size = 0;
      }
      if (size <= 0 || size > MAX_TORRENT_BYTES) {
        this.diag(`torrent import skipped (size=${size})`);
        fs.closeSync(file.fd);
        return;
      }
      const buffer = new ArrayBuffer(size);
      const read = fs.readSync(file.fd, buffer);
      fs.closeSync(file.fd);
      const dir = torrentImportDir(this.context.filesDir);
      fs.mkdirSync(dir, true);
      const target = `${dir}/${Date.now()}-${Math.floor(Math.random() * 1000000)}.torrent`;
      const out = fs.openSync(
        target,
        fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC
      );
      fs.writeSync(out.fd, buffer);
      fs.closeSync(out.fd);
      const ok = appendDeepLinkCommand(this.context.filesDir, DEEPLINK_CMD_ADD_TORRENT, target);
      this.diag(`deep link torrent imported bytes=${read}/${size} queued=${ok}`);
    } catch (error) {
      const err = error as BusinessError;
      this.diag(`deep link torrent import failed: ${err.message}`);
    }
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'onDestroy');
    this.windowMemory?.flush();
    // 退订托盘面板事件（扩展进程还在发就会变成无人接收）
    if (this.trayEventSubscriber !== null) {
      try {
        commonEventManager.unsubscribe(this.trayEventSubscriber, () => {
          // 退订失败不影响退出
        });
      } catch (error) {
        // 忽略
      }
      this.trayEventSubscriber = null;
    }
    // 清 Dock 图标进度条，别让应用退出后还挂着一条不会动的进度
    this.taskbar.clear().catch(() => {
      // 退出路径，失败无所谓
    });
    // 移除状态栏图标，避免系统里残留"幽灵图标"
    this.tray?.remove();
    this.tray = null;
  }

  /**
   * 关闭窗口时的收尾。
   *
   * 注意：注册了 windowStageClose 监听之后，系统不会再调用 onPrepareToTerminate，
   * 所以这个回调只在"监听注册失败"的旧设备上是唯一入口。
   */
  onPrepareToTerminate(): boolean {
    this.requestGracefulStop();
    return true;
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** PC 形态：给窗口一个合理的最小尺寸，避免被拖到很小后布局崩掉 */
  private tuneWindow(windowStage: window.WindowStage): void {
    try {
      const mainWindow = windowStage.getMainWindowSync();
      mainWindow.setWindowLimits({ minWidth: 900, minHeight: 600 })
        .catch((error: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'setWindowLimits failed: %{public}s', error.message);
        });
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(DOMAIN, TAG, 'tuneWindow failed: %{public}s', err.message);
    }
  }

  /**
   * 申请长时任务：没有它，窗口一不可见系统就会挂起/回收进程，
   * 下载（aria2 子进程 + Node）会一起停。
   *
   * 失败不阻断启动：拿不到长时任务只是"后台可能被杀"，不应该让应用起不来。
   */
  private acquireBackgroundTask(): void {
    if (this.keptAlive) {
      return;
    }
    try {
      const context = this.context;
      // 长时任务需要一个 WantAgent 作为通知点击入口：这里指向本 Ability 自己
      const info: wantAgent.WantAgentInfo = {
        wants: [
          {
            bundleName: context.abilityInfo.bundleName,
            abilityName: context.abilityInfo.name,
          },
        ],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG],
      };
      wantAgent.getWantAgent(info)
        .then((agent: Object) => {
          return backgroundTaskManager.startBackgroundRunning(
            context,
            backgroundTaskManager.BackgroundMode.DATA_TRANSFER,
            agent,
          );
        })
        .then(() => {
          this.keptAlive = true;
          hilog.info(DOMAIN, TAG, 'background running acquired');
        })
        .catch((error: BusinessError) => {
          hilog.warn(DOMAIN, TAG, 'startBackgroundRunning failed: %{public}s %{public}d',
            error.message, error.code);
        });
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(DOMAIN, TAG, 'acquireBackgroundTask threw: %{public}s', err.message);
    }
  }

  /** 优雅停止：写文件信号让端侧 Node 自己退出（进程内 Node 无法从外部线程停） */
  private requestGracefulStop(): void {
    try {
      const stopPath = `${this.context.filesDir}/host-stop-request`;
      // 用 CoreFileKit 写一行就够；失败也不该阻断退出
      const file = fs.openSync(stopPath, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, `${Date.now()} ability`);
      fs.closeSync(file);
      hilog.info(DOMAIN, TAG, 'stop request written');
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(DOMAIN, TAG, 'write stop request failed: %{public}s', err.message);
    }
  }
}