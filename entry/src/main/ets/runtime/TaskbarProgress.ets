/**
 * Dock / 任务栏图标进度条（HarmonyOS 移植新增）
 *
 * 能力来源：Desktop Extension Kit 的 `quickBarManager`（API 26 / HarmonyOS 7 +）。
 *   · `isQuickBarCapabilitySupported(ctx)` —— 探测是否支持
 *   · `setProgressState(ctx, NORMAL | PAUSED | ERROR | NO_PROGRESS)` —— 状态
 *   · `setProgressValue(ctx, completed, total)` —— **整数百分比**，completed ∈ [0,100]，
 *     total ∈ (0,100] 且 completed ≤ total（不能直接塞字节数）
 *   · 权限：ohos.permission.SET_ABILITY_INSTANCE_INFO（normal/system_grant，已在 module.json5 声明）
 *
 * 实机注意（照抄 bilibili_hmos 的踩坑）：
 *   · 错误码 1020210010 = 快捷栏图标不存在（应用没有窗口/图标）；
 *   · 错误码 1020210011 = 调用太频繁 → 必须节流，这里 2 秒一次且只在变化时推；
 *   · `quickBarManager` 是 **namespace**，ArkTS 有 `arkts-no-ns-as-obj` 禁令，
 *     必须静态调用（HMS SDK 有完整类型声明）。
 *
 * 数据源：宿主每秒写的 `tray-state.json`（见 runtime/TrayBridge.ets）。
 */

import { quickBarManager } from '@kit.DeskTopExtensionKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { readTraySnapshot, isSnapshotFresh, TraySnapshot } from './TrayBridge';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-QBAR';

/** 官方建议间隔 2s；再密会报 1020210011 */
const PUSH_MIN_GAP_MS = 2000;
const TICK_MS = 1000;

/** 快捷栏目标状态（避免用元组/联合类型，ArkTS 下最省事） */
interface QuickTarget {
  state: number;
  percent: number;
}

export class TaskbarProgress {
  private context: common.UIAbilityContext | null = null;
  private filesDir: string = '';
  private supported: boolean = false;
  private checked: boolean = false;
  private timer: number = -1;
  private lastKey: string = '';
  private lastPushAt: number = 0;
  private lastErrorCode: number = 0;
  /** 诊断回调：把关键结论同步到 ability-diag.log（真机上 hilog 缓冲不住） */
  private diag: ((line: string) => void) | null = null;

  /** 启动：探测能力 + 起定时器。任何失败都静默降级，不影响主流程 */
  start(context: common.UIAbilityContext, filesDir: string, diag?: (line: string) => void): void {
    if (this.timer !== -1) {
      return;
    }
    this.context = context;
    this.filesDir = filesDir;
    this.diag = diag !== undefined ? diag : null;
    this.timer = setInterval(() => {
      this.tick();
    }, TICK_MS);
    this.tick();
    hilog.info(DOMAIN, TAG, 'taskbar progress started');
  }

  /** 退出前清掉进度，避免 Dock 图标上挂着一个永远不动的进度条 */
  async clear(): Promise<void> {
    if (this.timer !== -1) {
      clearInterval(this.timer);
      this.timer = -1;
    }
    await this.push(quickBarManager.ProgressState.NO_PROGRESS, 0);
  }

  /** 探测一次能力（每次 tick 前只做一次；不支持就永久跳过） */
  private async ensureChecked(): Promise<boolean> {
    if (this.checked) {
      return this.supported;
    }
    const context = this.context;
    if (context === null) {
      return false;
    }
    this.checked = true;
    try {
      this.supported = await quickBarManager.isQuickBarCapabilitySupported(context);
      this.log(`quick bar supported: ${this.supported}`);
    } catch (error) {
      const err = error as BusinessError;
      this.supported = false;
      this.log(`quick bar probe failed: ${err.code} ${err.message}`);
    }
    return this.supported;
  }

  /** 每秒读一次快照 → 只有"状态或百分比变了"才推（且至少间隔 2s） */
  private async tick(): Promise<void> {
    const context = this.context;
    if (context === null) {
      return;
    }
    if (!(await this.ensureChecked())) {
      return;
    }
    const snapshot = readTraySnapshot(this.filesDir);
    const target = this.resolveTarget(snapshot);
    const key = `${target.state}:${target.percent}`;
    if (key === this.lastKey) {
      return;
    }
    const now = Date.now();
    if (now - this.lastPushAt < PUSH_MIN_GAP_MS) {
      return;
    }
    this.lastKey = key;
    await this.push(target.state, target.percent);
  }

  /**
   * 快照 → 快捷栏要显示的状态。
   *
   * 语义对齐 Windows 任务栏进度条：
   *   · 有活动任务 → NORMAL + 整体百分比
   *   · 没有活动但有暂停任务 → PAUSED（进度条停在原处、变琥珀色）
   *   · 没有任务 → NO_PROGRESS（清空）
   *   · 引擎/任务出错 → ERROR
   * 快照过期（宿主退出）也按 NO_PROGRESS 处理。
   */
  private resolveTarget(snapshot: TraySnapshot | null): QuickTarget {
    if (snapshot === null || !isSnapshotFresh(snapshot)) {
      return { state: quickBarManager.ProgressState.NO_PROGRESS, percent: 0 };
    }
    const percent = this.clampPercent(snapshot);
    const state = typeof snapshot.state === 'string' ? snapshot.state : 'idle';
    if (state === 'normal') {
      return { state: quickBarManager.ProgressState.NORMAL, percent };
    }
    if (state === 'paused') {
      return { state: quickBarManager.ProgressState.PAUSED, percent };
    }
    if (state === 'error') {
      return { state: quickBarManager.ProgressState.ERROR, percent };
    }
    return { state: quickBarManager.ProgressState.NO_PROGRESS, percent: 0 };
  }

  private clampPercent(snapshot: TraySnapshot): number {
    const raw = typeof snapshot.percent === 'number' ? snapshot.percent : 0;
    const hasProgress = snapshot.hasProgress === true;
    if (!hasProgress) {
      return 0;
    }
    if (!isFinite(raw) || raw <= 0) {
      // 有进度但算出来 0：给 1，用户能看出"在动"，而不是以为坏了
      return 1;
    }
    if (raw >= 100) {
      return 99;
    }
    return Math.floor(raw);
  }

  /** 诊断一行：同时进 hilog 与调用方给的 diag（文件） */
  private log(line: string): void {
    hilog.info(DOMAIN, TAG, '%{public}s', line);
    if (this.diag !== null) {
      this.diag(line);
    }
  }

  private async push(state: number, percent: number): Promise<void> {
    const context = this.context;
    if (context === null) {
      return;
    }
    this.lastPushAt = Date.now();
    try {
      await quickBarManager.setProgressState(context, state);
      if (state === quickBarManager.ProgressState.NO_PROGRESS) {
        return;
      }
      const completed = percent <= 0 ? 1 : percent;
      await quickBarManager.setProgressValue(context, completed, 100);
      hilog.debug(DOMAIN, TAG, 'quick bar push state=%{public}d percent=%{public}d', state, completed);
    } catch (error) {
      const err = error as BusinessError;
      // 同一个错误码只记一次，避免每秒刷屏
      if (err.code !== this.lastErrorCode) {
        this.lastErrorCode = err.code;
        this.log(`quick bar push failed: ${err.code} ${err.message}`);
      }
    }
  }
}
