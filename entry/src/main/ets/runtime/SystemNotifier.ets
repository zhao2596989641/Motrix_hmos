/**
 * 系统通知（HarmonyOS 移植新增）
 *
 * 为什么需要：上游的"通知"只存在于应用内（Notifications 页 + 角标），
 * 窗口最小化/切到别的应用时，下载完成用户完全感知不到。
 *
 * 做法：ArkTS 侧监听 Node 的事件（由宿主写入文件队列），收到"任务完成/失败"就
 * 用 `notificationManager.publish` 发系统通知；点击通知用 `wantAgent` 拉回本应用。
 *
 * 设计取舍：
 *   · 不引入新权限（普通应用发通知只需用户允许"通知"权限，首次发会自动申请）；
 *   · 同类通知用固定 id 覆盖，避免刷屏（下载完成多条时只更新最后一条）；
 *   · 通知内容从 Node 侧的事件 JSON 读，ArkTS 不自己拼业务语义。
 */

import { notificationManager } from '@kit.NotificationKit';
import { common, wantAgent, WantAgent } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-NOTIFY';

/** 通知 id：同类共用一个，新通知覆盖旧的（避免完成 10 个任务弹 10 条） */
const NOTIFICATION_ID_COMPLETE = 1001;
const NOTIFICATION_ID_ERROR = 1002;

export interface NotifyPayload {
  title: string;
  body: string;
  kind: 'complete' | 'error';
}

/** 默认日志器（不传 log 时用，保证调用点永远不用判空） */
function noopLog(message: string): void {
  // 故意什么都不做：调用方不关心诊断输出时走这里
}

export class SystemNotifier {
  private readonly context: common.UIAbilityContext;
  private readonly log: (message: string) => void;
  private wantAgentInstance: WantAgent | null = null;
  private enabled: boolean = true;

  constructor(context: common.UIAbilityContext, log?: (message: string) => void) {
    this.context = context;
    this.log = log !== undefined ? log : noopLog;
    void this.prepareWantAgent();
    void this.prepareNotificationPermission();
  }

  /**
   * 权限/通道自检（r29 新增）。
   *
   * 为什么加：真机上"系统通知完全没有"且两边都是静默失败，无法判断是
   * 没事件、没权限、还是 publish 被拒。这里把三件事一次性查清楚并写进
   * arkts-diag.log：
   *   1. addSlot —— 个别版本 publish 前 slot 不存在会直接失败；
   *   2. isNotificationEnabled —— 用户/系统是否真的允许通知；
   *   3. 没开就 requestEnableNotification 主动申请（会弹系统授权框）。
   */
  private async prepareNotificationPermission(): Promise<void> {
    try {
      // 服务提醒（SERVICE_INFORMATION）= 系统"服务通知"分类：有横幅 + 提示音。
      // 之前用 OTHER_TYPES 会落到"其他通知"里，默认静默、无横幅（用户反馈）。
      await notificationManager.addSlot(notificationManager.SlotType.SERVICE_INFORMATION);
    } catch (error) {
      const err = error as BusinessError;
      this.log(`notify addSlot failed: ${err.code} ${err.message}`);
    }
    let enabled = false;
    try {
      enabled = await notificationManager.isNotificationEnabled();
      this.log(`notify enabled=${enabled}`);
    } catch (error) {
      const err = error as BusinessError;
      this.log(`notify isNotificationEnabled failed: ${err.code} ${err.message}`);
      return;
    }
    if (enabled) {
      return;
    }
    try {
      await notificationManager.requestEnableNotification(this.context);
      enabled = await notificationManager.isNotificationEnabled();
      this.log(`notify request done enabled=${enabled}`);
      this.enabled = enabled;
    } catch (error) {
      const err = error as BusinessError;
      this.log(`notify requestEnableNotification failed: ${err.code} ${err.message}`);
      this.enabled = false;
    }
  }

  /** 预创建 wantAgent（点击通知回到本应用） */
  private async prepareWantAgent(): Promise<void> {
    try {
      const info: wantAgent.WantAgentInfo = {
        wants: [
          {
            bundleName: this.context.abilityInfo.bundleName,
            abilityName: this.context.abilityInfo.name,
          },
        ],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG],
      };
      this.wantAgentInstance = await wantAgent.getWantAgent(info);
    } catch (error) {
      const err = error as BusinessError;
      // 拿不到 wantAgent 不影响发通知，只是点通知不会跳转
      hilog.warn(DOMAIN, TAG, 'getWantAgent failed: %{public}s', err.message);
    }
  }

  /**
   * 发一条系统通知。
   *
   * 失败不抛异常：通知是"锦上添花"，权限被拒/系统限制时静默降级，
   * 绝不能因为通知失败影响下载主流程。
   */
  async notify(payload: NotifyPayload): Promise<void> {
    if (!this.enabled) {
      this.log('notify skipped: disabled by permission state');
      return;
    }
    const isError = payload.kind === 'error';
    try {
      const request: notificationManager.NotificationRequest = {
        id: isError ? NOTIFICATION_ID_ERROR : NOTIFICATION_ID_COMPLETE,
        // 服务提醒分类（"服务通知"）：才有横幅和提示音。
        // 原来完成用 OTHER_TYPES、失败用 SOCIAL_COMMUNICATION，会分别落到
        // "其他通知" / "社交通信" 里，静默无横幅。统一改成一档。
        notificationSlotType: notificationManager.SlotType.SERVICE_INFORMATION,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: payload.title,
            text: payload.body,
          },
        },
        // 带 wantAgent 时点击可拉起应用；「自动清除」让用户划掉后不再堆积
        wantAgent: this.wantAgentInstance ?? undefined,
        tapDismissed: true,
        // 同名覆盖：同一个 id + 相同 label 会替换旧通知
        label: isError ? 'motrix-error' : 'motrix-complete',
      };
      await notificationManager.publish(request);
      this.log(`notify published id=${String(request.id)} title=${payload.title}`);
    } catch (error) {
      const err = error as BusinessError;
      this.log(`notify publish failed code=${err.code} msg=${err.message}`);
      // 1600004 = 通知被用户关闭：关掉后续尝试，避免每次下载都报错
      if (err.code === 1600004) {
        this.enabled = false;
        this.log('notifications disabled by user, stop trying');
      }
    }
  }

  /** 清掉所有本应用通知（例如用户清空任务列表时） */
  async clearAll(): Promise<void> {
    try {
      await notificationManager.cancelAll();
    } catch (error) {
      const err = error as BusinessError;
      hilog.debug(DOMAIN, TAG, 'cancelAll failed: %{public}s', err.message);
    }
  }
}

/** 队列里的一行（由 server 的 native-notify-bridge 写入） */
interface NotifyQueueEntry {
  kind: string;
  severity: string;
  titleKey: string;
  titleParams: Record<string, string> | null;
  bodyKey: string | null;
  bodyParams: Record<string, string> | null;
  at: number;
}

/**
 * 通知队列轮询器。
 *
 * Node 与 ArkTS 之间唯一的稳定通道是文件（Node 跑在独立线程，没有回调通道）。
 * server 把"值得打扰用户"的通知追加到 `<data>/notify-queue.jsonl`，
 * 这里每 2 秒读一次，发系统通知后把文件清空。
 *
 * 为什么不用 socket/IPC：沙箱下 ArkTS 侧无法可靠连到 Node 起的 socket，
 * 而且会给 UI 线程增加复杂度。文件轮询的 2 秒延迟对"下载完成"完全够用。
 */
export class NotificationPoller {
  private readonly queuePath: string;
  private readonly notifier: SystemNotifier;
  private readonly log: (message: string) => void;
  private timer: number = -1;
  private running: boolean = false;
  /** 已处理过的条目指纹（at+kind），防止文件清理失败时重复弹 */
  private seen: Set<string> = new Set();

  constructor(queuePath: string, notifier: SystemNotifier, log?: (message: string) => void) {
    this.queuePath = queuePath;
    this.notifier = notifier;
    this.log = log !== undefined ? log : noopLog;
  }

  start(intervalMs: number = 2000): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs) as number;
    hilog.info(DOMAIN, TAG, 'notification poller started (%{public}dms)', intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer >= 0) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.running) {
      return;
    }
    let raw = '';
    try {
      if (!fs.accessSync(this.queuePath)) {
        return;
      }
      raw = fs.readTextSync(this.queuePath);
      if (raw.trim().length === 0) {
        return;
      }
      // 先清空再处理：即使发通知失败，也不会每 2 秒重复读同一批
      const file = fs.openSync(this.queuePath, fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      fs.closeSync(file);
    } catch (error) {
      return;
    }

    const lines = raw.split('\n');
    this.log(`notify queue read ${lines.length} line(s)`);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let entry: NotifyQueueEntry | null = null;
      try {
        entry = JSON.parse(trimmed) as NotifyQueueEntry;
      } catch (error) {
        continue;
      }
      if (entry === null) {
        continue;
      }
      const fingerprint = `${entry.at}:${entry.kind}`;
      if (this.seen.has(fingerprint)) {
        continue;
      }
      this.seen.add(fingerprint);
      if (this.seen.size > 200) {
        this.seen = new Set([fingerprint]);
      }
      await this.dispatch(entry);
    }
  }

  private async dispatch(entry: NotifyQueueEntry): Promise<void> {
    const kind = String(entry.kind || '');
    const isError = /error|fail/i.test(kind);
    const isComplete = /complete/i.test(kind);
    this.log(`notify dispatch kind=${kind} matched=${isError || isComplete}`);
    if (!isError && !isComplete) {
      return;
    }
    // 标题/正文用固定中文：Node 侧只给 i18n key，翻译表在 Web 侧，ArkTS 拿不到，
    // 所以用与 Web 中文一致的说法。
    const title = isError ? '下载失败' : '下载完成';
    const params = (entry.titleParams ?? entry.bodyParams ?? {}) as Record<string, string>;
    const name = params.name ?? params.taskName ?? '';
    let body = '';
    if (name.length > 0) {
      body = isError ? `${name} 下载失败` : `${name} 已完成`;
    } else {
      body = isError ? '有任务下载失败，点此查看' : '有任务已完成，点此查看';
    }
    await this.notifier.notify({ title, body, kind: isError ? 'error' : 'complete' });
  }
}
