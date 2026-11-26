/**
 * 平台动作服务（HarmonyOS 移植新增）
 *
 * 为什么需要它：上游 server 模式没有实现 `command:revealInFolder` / `command:openTaskFile`
 * （那两条在 Electron 版走主进程），所以任务右键菜单里「在文件夹中显示」点了没反应。
 * 我们的 ArkWeb 壳里能拿到任务和路径信息，因此由 **ArkTS 侧**接管这两个动作：
 *   渲染层（打过补丁的 dist/renderer-web）把请求转成 `motrix://action/...` 的 URL 变化，
 *   壳里在 `onLoadIntercept` / `onPageBegin` 里捕获并调用系统能力。
 *
 * 设计原则：
 *   · 只处理 `motrix-action://` 这个私有 scheme，其他一切都放行给 Web 正常加载；
 *   · 全部能力失败只 toast 提示，不抛异常、不影响页面；
 *   · 不引入新的权限要求（want + startAbility 都是普通应用可用）。
 */

import { common, Want } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-ACTION';

/** 我们自定义的动作前缀：motrix-action://reveal?path=... */
export const MOTRIX_ACTION_SCHEME = 'motrix-action://';

export interface ActionResult {
  ok: boolean;
  note: string;
}

/**
 * 解析动作 URL。
 *
 * 格式约定（全部用 encodeURIComponent 编码参数）：
 *   motrix-action://reveal?path=<绝对路径>     —— 在系统文件管理器中显示
 *   motrix-action://open?path=<绝对路径>       —— 用默认应用打开文件
 *   motrix-action://external?url=<http(s) URL> —— 用系统浏览器打开外链
 */
export class PlatformActions {
  private readonly context: common.UIAbilityContext;
  /** 拖动窗口的回调（由页面注入，避免这里再依赖 window API） */
  private onDragRequest: (() => void) | null = null;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  /** 注册"拖动窗口"回调（沉浸式拖拽条触发） */
  setDragHandler(handler: () => void): void {
    this.onDragRequest = handler;
  }

  /** 如果 url 是我们的私有动作，就执行并返回 true（调用方据此决定是否拦截） */
  handleIfAction(url: string): boolean {
    if (url.indexOf(MOTRIX_ACTION_SCHEME) !== 0) {
      return false;
    }
    let action = '';
    let params = '';
    const rest = url.slice(MOTRIX_ACTION_SCHEME.length);
    const queryAt = rest.indexOf('?');
    if (queryAt >= 0) {
      action = rest.slice(0, queryAt);
      params = rest.slice(queryAt + 1);
    } else {
      action = rest;
    }
    const args = this.parseQuery(params);
    hilog.info(DOMAIN, TAG, 'action=%{public}s args=%{public}s', action, JSON.stringify(args));

    if (action === 'drag') {
      const handler = this.onDragRequest;
      if (handler !== null) {
        handler();
      }
    } else if (action === 'reveal') {
      void this.revealInFolder(args.path ?? '');
    } else if (action === 'open') {
      void this.openFile(args.path ?? '');
    } else if (action === 'external') {
      void this.openExternal(args.url ?? '');
    } else {
      hilog.warn(DOMAIN, TAG, 'unknown action %{public}s', action);
    }
    return true;
  }

  /**
   * 在系统文件管理器中显示文件/目录。
   *
   * 做法：给文件管理器发 `viewData` want，uri 用 file:// 形式。
   * 各版本文件管理器对"定位到具体文件"支持不一，所以：
   *   1) 先带 uri 尝试定位；
   *   2) 失败则退化为"打开所在目录"。
   * 两条都不成时返回失败，由调用方 toast。
   */
  async revealInFolder(path: string): Promise<ActionResult> {
    if (path.length === 0) {
      return { ok: false, note: '空路径' };
    }
    const directory = this.dirnameOf(path);
    // ① 首选：把文件 uri 交给文件管理器（多数实现会定位到该文件）
    const withFile = await this.startFileManager(`file://${encodeURI(path)}`);
    if (withFile.ok) {
      return withFile;
    }
    // ② 退化：打开所在目录
    const withDir = await this.startFileManager(`file://${encodeURI(directory)}`);
    if (withDir.ok) {
      return withDir;
    }
    return { ok: false, note: `无法打开文件管理器（${withDir.note}）` };
  }

  /** 用系统默认应用打开文件 */
  async openFile(path: string): Promise<ActionResult> {
    if (path.length === 0) {
      return { ok: false, note: '空路径' };
    }
    const want: Want = {
      action: 'ohos.want.action.viewData',
      uri: `file://${encodeURI(path)}`,
      type: this.guessMime(path),
    };
    return this.startWant(want, '打开文件');
  }

  /** 用系统浏览器打开 http(s) 外链 */
  async openExternal(url: string): Promise<ActionResult> {
    if (!/^(https?|mailto):/i.test(url)) {
      return { ok: false, note: `不支持的协议：${url}` };
    }
    const want: Want = {
      action: 'ohos.want.action.viewData',
      uri: url,
      entities: ['entity.system.browsable'],
    };
    return this.startWant(want, '打开链接');
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private async startFileManager(uri: string): Promise<ActionResult> {
    // 文件管理器 bundle 名在不同发行版可能不同，按顺序尝试
    const candidates = ['com.huawei.hmos.filemanager', 'com.ohos.filemanager'];
    let lastNote = '';
    for (const bundleName of candidates) {
      const want: Want = {
        bundleName: bundleName,
        action: 'ohos.want.action.viewData',
        uri: uri,
        entities: ['entity.system.default'],
      };
      const result = await this.startWant(want, '文件管理器');
      if (result.ok) {
        return result;
      }
      lastNote = result.note;
    }
    return { ok: false, note: lastNote };
  }

  private startWant(want: Want, label: string): Promise<ActionResult> {
    return new Promise((resolve) => {
      try {
        this.context.startAbility(want)
          .then(() => {
            hilog.info(DOMAIN, TAG, '%{public}s launched: %{public}s', label, JSON.stringify(want));
            resolve({ ok: true, note: `${label}已打开` });
          })
          .catch((error: BusinessError) => {
            hilog.warn(DOMAIN, TAG, '%{public}s failed: %{public}s', label, error.message);
            resolve({ ok: false, note: error.message });
          });
      } catch (error) {
        const err = error as BusinessError;
        hilog.warn(DOMAIN, TAG, '%{public}s threw: %{public}s', label, err.message);
        resolve({ ok: false, note: err.message });
      }
    });
  }

  private dirnameOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash > 0 ? path.slice(0, slash) : path;
  }

  /** 粗略的 MIME 推断：鸿蒙的默认应用匹配对 type 比较宽容，给 application/octet-stream 也能打开 */
  private guessMime(path: string): string {
    const dot = path.lastIndexOf('.');
    if (dot < 0) {
      return 'application/octet-stream';
    }
    const ext = path.slice(dot + 1).toLowerCase();
    const table: Record<string, string> = {
      'tgz': 'application/gzip',
      'gz': 'application/gzip',
      'zip': 'application/zip',
      '7z': 'application/x-7z-compressed',
      'rar': 'application/vnd.rar',
      'mp4': 'video/mp4',
      'mkv': 'video/x-matroska',
      'mp3': 'audio/mpeg',
      'flac': 'audio/flac',
      'pdf': 'application/pdf',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'iso': 'application/x-iso9660-image',
      'torrent': 'application/x-bittorrent',
    };
    return table[ext] ?? 'application/octet-stream';
  }

  private parseQuery(query: string): Record<string, string> {
    const result: Record<string, string> = {};
    if (query.length === 0) {
      return result;
    }
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) {
        continue;
      }
      const key = decodeURIComponent(pair.slice(0, eq));
      const value = decodeURIComponent(pair.slice(eq + 1));
      if (key.length > 0) {
        result[key] = value;
      }
    }
    return result;
  }
}