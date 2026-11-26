/**
 * 托盘后台 Ability（"贴"在状态栏图标上的空 Ability）
 *
 * 【为什么需要】主窗口"点关闭 → 收进托盘"用的是 `UIAbilityContext.hideAbility()`，
 * 而 SDK 对它的前置条件是：本应用已经**贴在状态栏图标上**（启动参数
 * `processMode = NEW_PROCESS_ATTACH_TO_STATUS_BAR_ITEM` + `startupVisibility = STARTUP_HIDE`）。
 * 没有这层"挂靠"，hideAbility 会直接失败（只能退化成 minimize，最小化并不是"收进托盘"）。
 *
 * 实现参考本机已验证过的 Clash Verge 鸿蒙版（同样 2in1 机型）：
 *   TrayIcon.install() 成功后 `startAbility(BackGroundAbility, attach 参数)`，
 *   BackGroundAbility 自己在 onWindowStageCreate 里再 hideAbility 一次兜底（它本来就不能有可见窗口）。
 */

import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-BGABILITY';

export default class BackGroundAbility extends UIAbility {
  onCreate(): void {
    hilog.info(DOMAIN, TAG, 'background ability onCreate');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // 本 Ability 不该有可见窗口；STARTUP_HIDE 已隐藏，这里再兜底一次
    this.context.hideAbility().then(() => {
      hilog.info(DOMAIN, TAG, 'tray holder ready (hidden)');
    }).catch((error: Error) => {
      hilog.warn(DOMAIN, TAG, 'hideAbility failed: %{public}s', error.message);
    });
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'background ability onDestroy');
  }
}