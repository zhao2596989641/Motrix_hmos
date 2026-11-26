/**
 * 状态栏图标左键弹窗（StatusBarViewExtensionAbility）
 *
 * 鸿蒙 PC 的托盘交互和 Windows 不一样（维护者 2026-11-25 明确）：
 *   · **左键** → 系统弹出我们这个「托盘面板」，里面可以放完整 ArkUI 组件，
 *     适合做"看状态 + 就地控制"（暂停全部/继续全部/打开主界面/退出）；
 *   · **右键** → 系统展示菜单项，点菜单项负责"把应用打开到对应页面"
 *     （见 runtime/SystemTray.ets 的 buildMenus）。
 *
 * 本 Ability 只做一件事：把面板页面 loadContent 起来。
 * 面板的数据/命令走文件桥（runtime/TrayBridge.ets），与主进程、宿主 Node 解耦。
 */

import { StatusBarViewExtensionAbility } from '@kit.DeskTopExtensionKit';
import { UIExtensionContentSession, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-TRAYPANEL';

export default class TrayStatusBarAbility extends StatusBarViewExtensionAbility {
  onCreate(): void {
    hilog.info(DOMAIN, TAG, 'tray panel extension onCreate');
  }

  onSessionCreate(want: Want, session: UIExtensionContentSession): void {
    hilog.info(DOMAIN, TAG, 'tray panel session create');
    try {
      session.loadContent('pages/TrayPanel');
    } catch (error) {
      hilog.error(DOMAIN, TAG, 'loadContent(pages/TrayPanel) failed: %{public}s',
        (error as Error).message);
    }
  }

  onSessionDestroy(session: UIExtensionContentSession): void {
    hilog.info(DOMAIN, TAG, 'tray panel session destroyed');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'tray panel extension onDestroy');
  }
}