/**
 * 沉浸式窗口（HarmonyOS 移植新增）
 *
 * 目标：把系统默认的浅色标题栏换成"融进应用"的深色外观，接近 Clash 那种观感。
 * 2in1 上所谓"标题栏"就是窗口 decor（顶部状态栏/底部快捷栏属于系统 shell，应用管不了）。
 *
 * 采用「方案 5a」（保留系统三键 + 只换配色），而不是自绘三键，原因：
 *   · 自绘三键在非自由窗口（最大化/分屏）状态下 setWindowTitleButtonVisible 会抛 801；
 *   · 最小化/最大化/关闭的系统行为（含双击标题栏最大化、Win 手势）不用自己实现；
 *   · 系统三键的点击热区、无障碍、DPI 缩放都由系统处理。
 *
 * 但隐藏标题栏后有个**必须处理的坑**：系统三键会"下沉"悬浮在页面右上角
 * （官方 FAQ faqs-computer-5）。所以这里把三键几何（getTitleButtonRect）读出来交给页面，
 * 页面的自绘标题栏在右侧预留这块空白，避免压住内容。
 *
 * 全部步骤都 try-catch 包裹并**可单独失败**：任何一步不支持都退化为"原样"，
 * 绝不会出现"标题栏没了但也没有自绘标题栏"的死窗口（decorHidden 为 false 时页面用系统标题栏）。
 */

import { window } from '@kit.ArkUI';
import { ConfigurationConstant } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-IMMERSIVE';

/** 深色窗口底色（与 Web UI 背景接近，减少接缝） */
const BACKGROUND_DARK = '#1B1B1F';
const BACKGROUND_LIGHT = '#FFFFFF';
/**
 * decor 高度（官方允许范围 [37,112] vp）。
 *
 * 40 → 54：实测隐藏标题栏后系统三键位置偏高，用户要求下移 7px。
 * 三键在 decor 区域内垂直居中，所以 decor +14 正好让三键中心下移 7。
 * 54 也正好等于上游 `NATIVE_TITLE_BAR_HEIGHT`（Motrix 给 Linux 原生标题栏预留的高度），
 * 说明这个值本身是"能容纳系统三键"的合理高度。
 */
const DECOR_HEIGHT = 54;

export interface ImmersiveState {
  /** 系统标题栏是否已隐藏（页面据此决定是否渲染自绘标题栏） */
  decorHidden: boolean;
  /** 系统造成三键区宽度（vp）；页面右侧要让出这么宽，否则会被压住 */
  titleButtonWidth: number;
  /** 三键区高度（vp） */
  titleButtonHeight: number;
  /** decor 高度（vp）：三键所在那条带的高度，Toast 下移用它 */
  decorHeight: number;
}

export class ImmersiveWindow {
  private mainWindow: window.Window | null = null;
  private state: ImmersiveState = {
    decorHidden: false,
    titleButtonWidth: 0,
    titleButtonHeight: 0,
    decorHeight: DECOR_HEIGHT,
  };

  /** 绑定窗口并应用沉浸式设置；返回最终状态 */
  apply(mainWindow: window.Window, dark: boolean): ImmersiveState {
    this.mainWindow = mainWindow;

    // ① 窗口底色（零风险，最先做，避免后面步骤失败时还是白底）
    this.applyBackgroundColor(dark);

    // ①.5 **先**读一次三键几何（此时 decor 还是可见的）
    //
    // 真机坑：隐藏 decor 之后 getTitleButtonRect() 返回 width=0（r26 日志实测
    // `btnW=0 btnH=54`），于是"避让三键"的 CSS 宽度算成 0，等于完全没避让。
    // 所以这里在隐藏前后各读一次，再叠加 getDecorButtonStyle() 的排版参数做兜底。
    const rectBefore = this.readRect(mainWindow, 'before-hide');
    const styleWidth = this.readDecorStyleWidth(mainWindow);

    // ② 隐藏系统标题栏（关键步骤）
    let decorHidden = false;
    try {
      const currentlyVisible = mainWindow.getWindowDecorVisible();
      if (currentlyVisible) {
        mainWindow.setWindowDecorVisible(false);
      }
      decorHidden = true;
      hilog.info(DOMAIN, TAG, 'window decor hidden');
    } catch (error) {
      const err = error as BusinessError;
      decorHidden = false;
      hilog.warn(DOMAIN, TAG, 'setWindowDecorVisible(false) failed: %{public}d %{public}s',
        err.code, err.message);
      // 回退：确保系统标题栏可见，用户至少能关窗口
      try {
        mainWindow.setWindowDecorVisible(true);
      } catch {
        // 保持原样
      }
    }

    if (!decorHidden) {
      this.state = {
        decorHidden: false,
        titleButtonWidth: 0,
        titleButtonHeight: 0,
        decorHeight: DECOR_HEIGHT,
      };
      return this.state;
    }

    // ③ 压薄 decor：隐藏标题栏后它仍决定"三键区"的高度
    try {
      mainWindow.setWindowDecorHeight(DECOR_HEIGHT);
    } catch (error) {
      const err = error as BusinessError;
      hilog.debug(DOMAIN, TAG, 'setWindowDecorHeight ignored: %{public}s', err.message);
    }

    // ④ 把系统三键刷成深色（方案 5a 的核心：保留三键，只换配色）
    if (dark) {
      try {
        mainWindow.setDecorButtonStyle({
          colorMode: ConfigurationConstant.ColorMode.COLOR_MODE_DARK,
        });
        hilog.info(DOMAIN, TAG, 'decor buttons switched to dark style');
      } catch (error) {
        const err = error as BusinessError;
        hilog.debug(DOMAIN, TAG, 'setDecorButtonStyle ignored: %{public}d %{public}s',
          err.code, err.message);
      }
    }

    // ⑤ 关掉"拖标题栏移动"（自绘标题栏自己用 startMoving）
    try {
      mainWindow.setWindowTitleMoveEnabled(false);
    } catch (error) {
      const err = error as BusinessError;
      hilog.debug(DOMAIN, TAG, 'setWindowTitleMoveEnabled ignored: %{public}s', err.message);
    }

    // ⑥ 最大化后 hover 顶部不再冒系统标题栏
    try {
      mainWindow.setTitleAndDockHoverShown(false, true)
        .catch((error: BusinessError) => {
          hilog.debug(DOMAIN, TAG, 'setTitleAndDockHoverShown ignored: %{public}s', error.message);
        });
    } catch (error) {
      const err = error as BusinessError;
      hilog.debug(DOMAIN, TAG, 'setTitleAndDockHoverShown threw: %{public}s', err.message);
    }

    // ⑦ 读三键几何：页面右侧必须让出这块空间（隐藏标题栏后三键悬浮在右上角）
    //
    // 三个来源取最大：
    //   1. 隐藏 decor **之前** 的 getTitleButtonRect().width（真机实测隐藏后变 0）；
    //   2. 隐藏 decor 之后的值（某些版本恰好相反，隐藏后才给真值）；
    //   3. getDecorButtonStyle() 的排版参数算出来的宽度
    //      = closeButtonRightMargin + 3*buttonBackgroundSize + 2*spacingBetweenButtons
    //      （默认 20 + 3*28 + 2*12 = 128vp，这是官方默认按钮排布）。
    // 三者都为 0（或 API 不支持）时退回 138vp（三个按钮约 138vp 的历史实测值）。
    const rectAfter = this.readRect(mainWindow, 'after-hide');
    const beforeWidth: number = rectBefore !== null ? rectBefore.width : -1;
    const afterWidth: number = rectAfter !== null ? rectAfter.width : -1;
    let rectWidth = Math.max(beforeWidth > 0 ? beforeWidth : 0, afterWidth > 0 ? afterWidth : 0);
    if (rectWidth <= 0) {
      rectWidth = styleWidth;
    }
    if (rectWidth <= 0) {
      rectWidth = 138;
      hilog.warn(DOMAIN, TAG, 'title button geometry unavailable, falling back to 138vp');
    }
    // 留 6vp 呼吸间隙，避免页面按钮紧贴三键左缘
    const buttonWidth = Math.min(Math.max(rectWidth + 6, 96), 240);
    const buttonHeight = DECOR_HEIGHT;

    hilog.info(DOMAIN, TAG,
      'title button geometry: beforeW=%{public}d afterW=%{public}d styleWidth=%{public}d result=%{public}d',
      beforeWidth, afterWidth, styleWidth, buttonWidth);

    this.state = {
      decorHidden: true,
      titleButtonWidth: buttonWidth,
      titleButtonHeight: buttonHeight,
      decorHeight: DECOR_HEIGHT,
    };
    return this.state;
  }

  /**
   * 读一次三键矩形并落到 hilog（方便真机排查"避让宽度是不是 0"）。
   * 注意 TitleButtonRect 只有 right/top/width/height，没有 left。
   */
  private readRect(mainWindow: window.Window, tag: string): window.TitleButtonRect | null {
    try {
      const rect: window.TitleButtonRect = mainWindow.getTitleButtonRect();
      hilog.info(DOMAIN, TAG, 'title button rect (%{public}s): right=%{public}d top=%{public}d width=%{public}d height=%{public}d',
        tag, rect.right, rect.top, rect.width, rect.height);
      return rect;
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(DOMAIN, TAG, 'getTitleButtonRect (%{public}s) failed: %{public}d %{public}s',
        tag, err.code, err.message);
      return null;
    }
  }

  /**
   * 用 getDecorButtonStyle() 推算三键区宽度（vp）。
   *
   * 官方默认值（@ohos.window.d.ts:1264-1288）：
   *   buttonBackgroundSize 28 / spacingBetweenButtons 12 / closeButtonRightMargin 20
   * 三键总占位 = 右间距 + 3*按钮 + 2*间距 = 20 + 84 + 24 = 128vp。
   * 不支持的设备返回 0（调用方会用别的来源兜底）。
   */
  private readDecorStyleWidth(mainWindow: window.Window): number {
    try {
      const style: window.DecorButtonStyle = mainWindow.getDecorButtonStyle();
      const size = style.buttonBackgroundSize !== undefined && style.buttonBackgroundSize > 0
        ? style.buttonBackgroundSize : 28;
      const gap = style.spacingBetweenButtons !== undefined && style.spacingBetweenButtons > 0
        ? style.spacingBetweenButtons : 12;
      const margin = style.closeButtonRightMargin !== undefined && style.closeButtonRightMargin > 0
        ? style.closeButtonRightMargin : 20;
      const width = margin + 3 * size + 2 * gap;
      hilog.info(DOMAIN, TAG, 'decor button style: size=%{public}d gap=%{public}d margin=%{public}d -> %{public}d',
        size, gap, margin, width);
      return width;
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(DOMAIN, TAG, 'getDecorButtonStyle failed: %{public}d %{public}s', err.code, err.message);
      return 0;
    }
  }

  /** 主题变化时更新窗口底色（不重设装饰可见性，避免闪） */
  applyBackgroundColor(dark: boolean): void {
    const win = this.mainWindow;
    if (win === null) {
      return;
    }
    try {
      win.setWindowBackgroundColor(dark ? BACKGROUND_DARK : BACKGROUND_LIGHT);
    } catch (error) {
      const err = error as BusinessError;
      hilog.debug(DOMAIN, TAG, 'setWindowBackgroundColor failed: %{public}s', err.message);
    }
  }

  /** 主题变化时同步三键配色 */
  applyButtonColorMode(dark: boolean): void {
    const win = this.mainWindow;
    if (win === null) {
      return;
    }
    try {
      win.setDecorButtonStyle({
        colorMode: dark
          ? ConfigurationConstant.ColorMode.COLOR_MODE_DARK
          : ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT,
      });
    } catch (error) {
      // 忽略：部分窗口状态不支持
    }
  }

  get current(): ImmersiveState {
    return this.state;
  }

  // ── 拖拽（自绘标题栏的拖拽区调用） ─────────────────────────────────────────

  /**
   * 开始拖动窗口。
   *
   * 注意：`startMoving()` 只在**自由窗口**状态可用（最大化/全屏时抛 1300004），
   * 那种状态下窗口本来也不需要拖，直接忽略即可。
   */
  async startMoving(): Promise<void> {
    const win = this.mainWindow;
    if (win === null) {
      return;
    }
    try {
      await win.startMoving();
    } catch (error) {
      const err = error as BusinessError;
      if (err.code !== 1300004) {
        hilog.warn(DOMAIN, TAG, 'startMoving failed: %{public}d %{public}s', err.code, err.message);
      }
    }
  }
}