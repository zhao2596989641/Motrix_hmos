/**
 * 窗口状态判定辅助（HarmonyOS 移植新增）
 *
 * 背景：沉浸式标题栏的拖拽条在**最大化**状态下不能调 `startMoving()` ——
 * 系统会把它理解为"用户拖动最大化窗口的标题栏"，于是**立即把窗口还原（缩小）**
 * 并跟着鼠标走。Clash 也踩过这个坑，标准解法是"最大化时拖拽不生效"。
 *
 * 难点：`window.getWindowProperties()` 里只有 `isFullScreen` / `isLayoutFullScreen`，
 * **没有** "是否最大化" 字段（WindowLayoutInfo 也只有 windowRect）。
 * 所以这里用"窗口矩形与屏幕尺寸比较"的启发式判断：最大化时窗口会占据几乎整个可用屏幕。
 *
 * 阈值取舍：用 0.92/0.88 而不是 0.98 —— 2in1 上最大化窗口可能被 dock/状态栏
 * 占掉一些像素。宁可偶尔"最大化时拖不动"（无害），也不能"非最大化时误判成最大化导致拖不了"。
 */

import { window } from '@kit.ArkUI';
import { display } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-WINSTATE';

export interface WindowStateSnapshot {
  /** 全屏（F11/沉浸式全屏） */
  isFullScreen: boolean;
  /** 看起来是最大化（窗口 ≈ 屏幕） */
  looksMaximized: boolean;
}

/** 读一次窗口状态；任何 API 失败都返回"都不是"（宁可允许拖拽） */
export function readWindowState(win: window.Window): WindowStateSnapshot {
  let isFullScreen = false;
  let looksMaximized = false;
  try {
    const props = win.getWindowProperties();
    isFullScreen = props.isFullScreen === true;
    const rect = props.windowRect;
    if (rect.width > 0 && rect.height > 0) {
      const scr = display.getDefaultDisplaySync();
      const screenW = scr.width;
      const screenH = scr.height;
      if (screenW > 0 && screenH > 0) {
        looksMaximized =
          rect.width >= screenW * 0.92 && rect.height >= screenH * 0.88;
      }
    }
  } catch (error) {
    const err = error as BusinessError;
    hilog.debug(DOMAIN, TAG, 'readWindowState failed: %{public}s', err.message);
  }
  return { isFullScreen, looksMaximized };
}

/** 是否应当**禁止**拖拽（最大化/全屏时禁止，否则窗口会被系统还原并跟随鼠标） */
export function shouldBlockDrag(win: window.Window): boolean {
  const state = readWindowState(win);
  const blocked = state.isFullScreen || state.looksMaximized;
  if (blocked) {
    hilog.info(DOMAIN, TAG,
      'drag blocked: isFullScreen=%{public}s looksMaximized=%{public}s',
      String(state.isFullScreen), String(state.looksMaximized));
  }
  return blocked;
}