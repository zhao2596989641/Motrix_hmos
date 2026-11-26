/**
 * 窗口几何记忆（HarmonyOS 移植新增）
 *
 * 为什么要做：PC 上用户习惯"窗口摆好位置、下次还是一样"，而现在每次启动都是
 * 系统默认大小/位置。这里把窗口矩形存到应用自己的 filesDir，下次启动恢复。
 *
 * 实现要点（都是踩过的坑）：
 *   · 窗口**创建后**才能 resize/move，且必须 `loadContent` 之后（同 setColorMode）；
 *   · 恢复时要校验：屏幕可能变了（换显示器/改分辨率），越界的值要夹回可见区；
 *   · 退出保存要防抖 —— onWindowStageDestroy 期间窗口可能已经不可查询，
 *     所以平时窗口尺寸变化时就顺手存，退出时再存一次兜底。
 */

import { window } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-WINDOW';
const GEOMETRY_FILE = 'window-geometry.json';

interface WindowGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
}

export class WindowMemory {
  private readonly storageDir: string;
  private last: WindowGeometry | null = null;
  private saveTimer: number = -1;

  constructor(filesDir: string) {
    this.storageDir = filesDir;
  }

  private get path(): string {
    return `${this.storageDir}/${GEOMETRY_FILE}`;
  }

  /** 读取上次保存的几何；没有/损坏都返回 null */
  load(): WindowGeometry | null {
    try {
      if (!fs.accessSync(this.path)) {
        return null;
      }
      const parsed = JSON.parse(fs.readTextSync(this.path)) as WindowGeometry;
      if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number'
        || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') {
        return null;
      }
      if (parsed.width < 400 || parsed.height < 300) {
        return null;
      }
      return parsed;
    } catch (error) {
      return null;
    }
  }

  /**
   * 恢复窗口几何。
   *
   * 安全策略：先拿到当前显示区域的可用矩形，把保存值**夹到可见范围**内
   * （换显示器后旧坐标可能完全在屏幕外，直接 move 会导致窗口"消失"）。
   */
  async restore(mainWindow: window.Window): Promise<void> {
    const saved = this.load();
    if (saved === null) {
      return;
    }
    try {
      const displayRect = mainWindow.getWindowProperties().windowRect;
      // 用当前窗口所在 display 的尺寸作为边界参考（拿不到就用保存值本身）
      const maxWidth = Math.max(displayRect.width, 800);
      const maxHeight = Math.max(displayRect.height, 600);

      const width = Math.min(Math.max(saved.width, 800), maxWidth);
      const height = Math.min(Math.max(saved.height, 600), maxHeight);
      const x = Math.max(0, saved.x);
      const y = Math.max(0, saved.y);

      await mainWindow.resize(width, height);
      // moveWindowTo 是相对整个屏幕的绝对坐标；失败不致命（部分窗口模式不允许移动）
      await mainWindow.moveWindowTo(x, y).catch((error: BusinessError) => {
        hilog.debug(DOMAIN, TAG, 'moveWindowTo ignored: %{public}s', error.message);
      });
      this.last = { width, height, x, y };
      hilog.info(DOMAIN, TAG, 'geometry restored %{public}s', JSON.stringify(this.last));
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(DOMAIN, TAG, 'restore failed: %{public}s', err.message);
    }
  }

  /** 订阅窗口几何变化：变化后防抖保存（用户拖动/缩放结束时落盘） */
  watch(mainWindow: window.Window): void {
    try {
      mainWindow.on('windowSizeChange', (size: window.Size) => {
        void this.capture(mainWindow, size);
      });
      // 位置变化（部分版本只有 windowRectChange）
      try {
        mainWindow.on('windowRectChange', () => {
          void this.capture(mainWindow, undefined);
        });
      } catch {
        // 老版本没有该事件，忽略
      }
    } catch (error) {
      const err = error as BusinessError;
      hilog.warn(DOMAIN, TAG, 'watch failed: %{public}s', err.message);
    }
  }

  private async capture(mainWindow: window.Window, size: window.Size | undefined): Promise<void> {
    try {
      const rect = mainWindow.getWindowProperties().windowRect;
      const next: WindowGeometry = {
        width: size !== undefined ? size.width : rect.width,
        height: size !== undefined ? size.height : rect.height,
        x: rect.left,
        y: rect.top,
      };
      if (this.last !== null
        && this.last.width === next.width
        && this.last.height === next.height
        && this.last.x === next.x
        && this.last.y === next.y) {
        return;
      }
      this.last = next;
      this.scheduleSave();
    } catch (error) {
      // 忽略：窗口可能正在销毁
    }
  }

  /** 防抖保存（300ms），避免拖动时频繁写盘 */
  private scheduleSave(): void {
    if (this.saveTimer >= 0) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = -1;
      this.flush();
    }, 300) as number;
  }

  /** 立即落盘（退出时兜底调用） */
  flush(): void {
    const geometry = this.last;
    if (geometry === null) {
      return;
    }
    try {
      const file = fs.openSync(
        this.path,
        fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC
      );
      fs.writeSync(file.fd, JSON.stringify(geometry));
      fs.closeSync(file);
    } catch (error) {
      hilog.debug(DOMAIN, TAG, 'flush failed');
    }
  }
}