/**
 * 系统托盘（HarmonyOS PC / 2in1）
 *
 * 能力来源：HMS `DeskTopExtensionKit` 的 `statusBarManager.addToStatusBar()`
 * （`@hms.pcService.statusBarManager.d.ts`，`@since 5.0.0(12)`）。普通三方应用可用、
 * 无需额外权限声明；仅中国大陆境内的 HarmonyOS PC 支持。
 *
 * 【鸿蒙托盘交互与 Windows 不同】（维护者 2026-11-25 明确，本机 Clash 鸿蒙版已验证）
 *   · **左键** → 系统弹出 `quickOperation.abilityName` 指定的 **StatusBarViewExtensionAbility**，
 *     面板里可以放完整 ArkUI 组件，做状态展示与就地控制（见 pages/TrayPanel.ets）；
 *   · **右键** → 系统展示菜单项；菜单项 action 只能"启动应用内的 UIAbility"，
 *     所以菜单负责"**打开应用并跳到对应页面**"。**必须至少有一项"打开 Motrix"**。
 *
 * 【为什么还要 hold 一个后台 Ability】主窗口"点关闭 → 收进托盘"用 hideAbility()，
 * 它的 SDK 前置是本应用已贴在状态栏图标上；`BackGroundAbility` 就是这层挂靠。
 *
 * 【失败处理】设备不支持（抛 801 / 模块不存在）时整块功能静默跳过，只留诊断日志，
 * 不影响应用启动与下载；此时主窗口关闭仍走系统默认（退出）。
 */

import { common, contextConstant, StartOptions, Want } from '@kit.AbilityKit';
import { BusinessError, emitter } from '@kit.BasicServicesKit';
import { statusBarManager } from '@kit.DeskTopExtensionKit';
import { image } from '@kit.ImageKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-TRAY';

/** 菜单码前缀：页面项 = tray:page:<hash 路由> */
const MENU_PAGE_PREFIX = 'tray:page:';
/** 打开主界面（不切页） */
export const TRAY_MENU_SHOW = 'tray:show';
/**
 * 左键面板高度（vp）。
 *
 * 面板内容：标题行 + 传输卡（折线图 + 四项指标）+ 任务概览卡 + 下载任务卡（内部滚动）+ 底部"打开 Motrix"。
 * 880 是"三行任务行 + 三张卡片都不压缩"的折中值（任务列表可内部滚动）；系统若裁切会由内部布局自适应。
 */
const PANEL_HEIGHT = 880;

export class SystemTray {
  private readonly context: common.UIAbilityContext;
  private added: boolean = false;
  private bgHeld: boolean = false;
  private iconClickHandler: ((data: emitter.EventData) => void) | null = null;
  private menuClickHandler: ((data: emitter.EventData) => void) | null = null;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  isInstalled(): boolean {
    return this.added;
  }

  /**
   * 把图标加到系统状态栏。
   *
   * @returns 是否成功（不支持时返回 false，调用方无需处理）
   */
  async add(): Promise<boolean> {
    if (this.added) {
      return true;
    }
    try {
      const icons = await this.loadIcons();
      if (icons === null) {
        hilog.warn(DOMAIN, TAG, 'tray icons unavailable, skip');
        return false;
      }
      const item: statusBarManager.StatusBarItem = {
        icons: icons,
        quickOperation: {
          title: 'Motrix',
          height: PANEL_HEIGHT,
          abilityName: 'TrayStatusBarAbility',
          moduleName: 'entry',
        },
        hoverTips: 'Motrix',
        statusBarGroupMenu: this.buildMenus(),
      };
      statusBarManager.addToStatusBar(this.context, item);
      this.added = true;
      hilog.info(DOMAIN, TAG, 'tray icon added');
      // 挂靠后台 Ability（见文件头注释），必须在图标加成功之后
      setTimeout(() => {
        this.holdBackgroundAbility();
      }, 300);
      return true;
    } catch (error) {
      const err = error as BusinessError;
      // 801 = 能力不支持（非 PC / 非中国大陆版本）
      hilog.warn(DOMAIN, TAG, 'addToStatusBar failed: %{public}d %{public}s',
        err.code, err.message);
      return false;
    }
  }

  /**
   * 订阅托盘交互事件。
   *
   * 官方机制（`@hms.pcService.statusBarManager.d.ts`）：
   *   · `on('statusBarIconClick')` —— 左键点击图标；
   *     我们有 quickOperation 面板时，系统会先弹面板，这个回调可能不触发（不用它）；
   *   · `on('rightMenuClick')` —— 带 `menuCode` 且 `notifyOnly:true` 的菜单项被点击，
   *     `emitter.EventData.data` 里承载菜单码（不同版本形态不一：字符串 JSON 或对象）。
   */
  registerListeners(handleMenuCode: (menuCode: string) => void): void {
    this.unregisterListeners();
    const onIcon = (data: emitter.EventData): void => {
      // 面板已在左键弹出；这里只留痕，不再额外拉窗口（否则点了图标会同时弹面板+跳主窗）
      hilog.info(DOMAIN, TAG, 'tray icon clicked (panel handled by system)');
    };
    const onMenuEvent = (data: emitter.EventData): void => {
      const code = SystemTray.extractMenuCode(data);
      hilog.info(DOMAIN, TAG, 'tray menu clicked: %{public}s', code);
      if (code.length > 0) {
        handleMenuCode(code);
      }
    };
    this.iconClickHandler = onIcon;
    this.menuClickHandler = onMenuEvent;
    try {
      statusBarManager.on('statusBarIconClick', onIcon);
    } catch (error) {
      const err = error as BusinessError;
      hilog.debug(DOMAIN, TAG, 'statusBarIconClick not supported: %{public}s', err.message);
    }
    try {
      statusBarManager.on('rightMenuClick', onMenuEvent);
    } catch (error) {
      const err = error as BusinessError;
      hilog.debug(DOMAIN, TAG, 'rightMenuClick not supported: %{public}s', err.message);
    }
  }

  private unregisterListeners(): void {
    try {
      if (this.iconClickHandler !== null) {
        statusBarManager.off('statusBarIconClick', this.iconClickHandler);
        this.iconClickHandler = null;
      }
    } catch (error) {
      // 忽略
    }
    try {
      if (this.menuClickHandler !== null) {
        statusBarManager.off('rightMenuClick', this.menuClickHandler);
        this.menuClickHandler = null;
      }
    } catch (error) {
      // 忽略
    }
  }

  /** 移除状态栏图标（退出时调用，避免残留"幽灵图标"） */
  remove(): void {
    this.unregisterListeners();
    if (!this.added) {
      return;
    }
    try {
      statusBarManager.removeFromStatusBar(this.context);
      this.added = false;
      hilog.info(DOMAIN, TAG, 'tray icon removed');
    } catch (error) {
      const err = error as BusinessError;
      hilog.debug(DOMAIN, TAG, 'removeFromStatusBar ignored: %{public}s', err.message);
    }
  }

  /**
   * 右键菜单。
   *
   * 顺序按"用户最常做"排：打开主界面 → 三个常用页面。
   * **不放"退出"**：系统右键菜单自带退出项（维护者 2026-11-26 明确要求去掉我们的，
   * 避免出现两个"退出"）；系统退出会走 onPrepareToTerminate/onDestroy 收尾。
   * 每项都设 `notifyOnly: true` + 唯一 menuCode，点击由 `rightMenuClick` 统一处理：
   *   · 页面项先唤回主窗口，再把 Web UI 的 hash 路由切过去（见 EntryAbility.navigateWeb）。
   */
  private buildMenus(): statusBarManager.StatusBarGroupMenu[] {
    const openGroup: statusBarManager.StatusBarMenuItem[] = [
      this.menuItem('打开 Motrix', TRAY_MENU_SHOW),
    ];
    const pageGroup: statusBarManager.StatusBarMenuItem[] = [
      this.pageItem('下载任务', '/downloads/all'),
      this.pageItem('通知', '/notifications'),
      this.pageItem('设置', '/settings'),
    ];
    return [openGroup, pageGroup];
  }

  private menuItem(title: string, code: string): statusBarManager.StatusBarMenuItem {
    const item: statusBarManager.StatusBarMenuItem = {
      title: title,
      menuCode: code,
      menuAction: {
        // notifyOnly 时 abilityName 仍必须是合法名字（空串会弹"未知打开方式"，Clash 实机踩过）
        abilityName: this.context.abilityInfo.name,
        moduleName: this.context.abilityInfo.moduleName,
        notifyOnly: true,
        // menuAction.menuCode 在 6.1.1(24) 起标 deprecated，但官方文档同时说明：
        // 若 item 级 menuCode 也存在则以它为准 —— 两个都写，兼容更老的系统版本，
        // 代价只是一条废弃字段（Clash 鸿蒙版就是这么干的）。
        menuCode: code,
      },
    };
    return item;
  }

  private pageItem(title: string, route: string): statusBarManager.StatusBarMenuItem {
    return this.menuItem(title, `${MENU_PAGE_PREFIX}${route}`);
  }

  /** 菜单码解析：兼容"字符串 JSON"与"对象 map"两种回调形态 */
  private static extractMenuCode(data: emitter.EventData): string {
    const payload = data.data;
    if (payload === undefined || payload === null) {
      return '';
    }
    if (typeof payload === 'string') {
      const text = payload as string;
      try {
        const parsed = JSON.parse(text) as Record<string, Object>;
        return SystemTray.pickCode(parsed);
      } catch (error) {
        return text;
      }
    }
    const map = payload as Record<string, Object>;
    return SystemTray.pickCode(map);
  }

  private static pickCode(map: Record<string, Object>): string {
    const raw = map['menuCode'] !== undefined ? map['menuCode'] : map['code'];
    if (raw === undefined || raw === null) {
      return '';
    }
    const text = String(raw);
    return text;
  }

  /**
   * 把本进程挂到状态栏图标上（官方 PC 托盘后台保活做法）。
   *
   * hideAbility() 的 SDK 前置就是"应用已挂到状态栏"；没有这步，
   * "关闭窗口收进托盘"会失败，只能退化成最小化。
   */
  private holdBackgroundAbility(): void {
    if (this.bgHeld) {
      return;
    }
    try {
      const bundleName = this.context.abilityInfo.bundleName;
      const want: Want = {
        bundleName: bundleName,
        moduleName: this.context.abilityInfo.moduleName,
        abilityName: 'BackGroundAbility',
      };
      const options: StartOptions = {
        processMode: contextConstant.ProcessMode.NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM,
        startupVisibility: contextConstant.StartupVisibility.STARTUP_HIDE,
      };
      this.context.startAbility(want, options).then(() => {
        this.bgHeld = true;
        hilog.info(DOMAIN, TAG, 'background ability attached to status bar');
      }).catch((error: BusinessError) => {
        hilog.warn(DOMAIN, TAG, 'hold background ability failed: %{public}d %{public}s',
          error.code, error.message);
      });
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(DOMAIN, TAG, 'hold background ability threw: %{public}s', err.message);
    }
  }

  /**
   * 加载白/黑两套图标。
   *
   * statusBarManager 要求 `image.PixelMap`（不是 Resource），所以从资源读成 PixelMap。
   * 白/黑分别对应深色/浅色任务栏（系统自己挑）。
   */
  private async loadIcons(): Promise<statusBarManager.StatusBarIcon | null> {
    try {
      const white = await this.loadPixelMap($r('app.media.startIcon').id);
      const black = await this.loadPixelMap($r('app.media.startIcon').id);
      if (white === null || black === null) {
        return null;
      }
      return { white: white, black: black };
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(DOMAIN, TAG, 'loadIcons failed: %{public}s', err.message);
      return null;
    }
  }

  private async loadPixelMap(resourceId: number): Promise<image.PixelMap | null> {
    try {
      const data = await this.context.resourceManager.getMediaContent(resourceId);
      const source = image.createImageSource(data.buffer as ArrayBuffer);
      if (source === undefined || source === null) {
        return null;
      }
      return await source.createPixelMap();
    } catch (error) {
      const err = error as BusinessError;
      hilog.debug(DOMAIN, TAG, 'loadPixelMap failed: %{public}s', err.message);
      return null;
    }
  }
}