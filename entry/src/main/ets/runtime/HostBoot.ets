/**
 * 端侧 Node 的**提前启动**入口（r48 冷启动）。
 *
 * 背景：Node 起来到 ready 大约 2.5s，而 ArkTS 这侧的窗口/页面/ArkWeb 初始化也要几百毫秒。
 * 原来是在 `Index.aboutToAppear`（页面创建后）才 `new MotrixHost().start()`，两段完全串行。
 * 现在改成：窗口一创建（`onWindowStageCreate`，loadContent 之前）就先发 start，页面这边
 * 只是 await 同一个 Promise —— Node 启动与 UI/ArkWeb 初始化并行。
 *
 * 幂等：`--jitless` 进程内 Node 只能起一次（原生层会拒绝第二次），所以这里也保证只 start 一次。
 */
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { MotrixHost, StartOutcome } from './MotrixHost';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-BOOT';

let sharedHost: MotrixHost | null = null;
let startPromise: Promise<StartOutcome> | null = null;

/**
 * 尽早启动端侧 Node（幂等）。调用方可以立刻拿到 Promise，也可以之后再来 await。
 */
export function preStartHost(context: common.UIAbilityContext): Promise<StartOutcome> {
  if (sharedHost === null) {
    sharedHost = new MotrixHost(context);
  }
  if (startPromise === null) {
    hilog.info(DOMAIN, TAG, 'preStartHost: 提前启动端侧 Node（与 UI 初始化并行）');
    startPromise = sharedHost.start();
    // 只做“避免 unhandled rejection”的兜底；真正的失败由 Index.boot() await 后走错误页。
    startPromise.catch((error: Error) => {
      hilog.error(DOMAIN, TAG, 'preStartHost rejected: %{public}s', error.message);
    });
  }
  return startPromise;
}

/** 取共享的宿主实例 + 启动 Promise（Index 用它，避免重复 new MotrixHost）。 */
export function acquireHost(context: common.UIAbilityContext): HostBootHandle {
  const start = preStartHost(context);
  return { host: sharedHost as MotrixHost, start: start };
}

export interface HostBootHandle {
  host: MotrixHost;
  start: Promise<StartOutcome>;
}