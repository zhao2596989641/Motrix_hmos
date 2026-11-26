/**
 * 托盘左键面板（HarmonyOS PC / 2in1）
 *
 * 交互约定（与 Windows 托盘逻辑不同，维护者 2026-11-25 明确）：
 *   · **左键点托盘图标** → 就是本页：系统弹出的自定义 ArkUI 面板，负责"看状态 + 就地控制"；
 *   · **右键** → 系统菜单（见 runtime/SystemTray.ets），负责"打开应用/跳到某页"。
 *
 * 版式参考本机已验证的 Clash Verge 鸿蒙版（`codes/clash_verge_ohos/.../pages/TrayPanel.ets`）：
 *   · 窗口透明 + 玻璃模式：面板本体不铺底，只有卡片挂一层薄纱（深色 #1AFFFFFF）；
 *   · 系统色 token 的深/浅两套配色；字号只用 20/16/14/12 四档；
 *   · 每张卡片 borderRadius 16 + 细描边；底部一根分割线 + 一行"打开 Motrix"。
 *
 * 内容（对应主界面仪表板的卡片）：
 *   ① 传输：网速折线图（与服务端 speedHistory 同源）+ 下载/上传速度、下载/上传量
 *   ② 任务概览：进行中 / 等待 / 暂停 / 完成 / 出错
 *   ③ 下载任务：**固定高度、内部滚动**的列表；每行右侧有暂停/继续 + ✕（取消）
 *
 * 数据/命令仍走文件桥（runtime/TrayBridge.ets）：
 *   宿主每秒写 `tray-state.json`；本页把命令追加进 `tray-cmd.jsonl`，宿主轮询后用
 *   自己的 operator cookie 发 RPC（凭据不出宿主进程）。"打开主界面"走公共事件。
 */

import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { commonEventManager, BusinessError } from '@kit.BasicServicesKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import {
  appendTrayTaskCommand,
  appendTrayCommand,
  engineStateText,
  formatBytes,
  formatEta,
  isSnapshotFresh,
  isTaskFinished,
  isTaskRunning,
  readTraySnapshot,
  taskStatusText,
  TraySnapshot,
  TraySpeedPoint,
  TrayTask,
  TRAY_CMD_PAUSE_ALL,
  TRAY_CMD_PAUSE_TASK,
  TRAY_CMD_REMOVE_TASK,
  TRAY_CMD_RETRY_TASK,
  TRAY_CMD_RESUME_ALL,
  TRAY_CMD_RESUME_TASK,
} from '../runtime/TrayBridge';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-TRAYPANEL';

/** 公共事件名：面板 → 主进程（打开主窗口） */
const EVENT_OPEN = 'com.lyldeer.motrix.tray.open';
/** 折线图高度 */
const CHART_H = 92;

/**
 * 面板配色：深 / 浅两套 + 玻璃模式。
 *
 * 数值全部照抄本机 Clash Verge 鸿蒙版的 TrayPanel（同一台设备、同一套系统色）：
 *   · **玻璃模式**（窗口透明成功时）：面板本体全透明，只有卡片挂一层薄纱
 *       深色 card = #1AFFFFFF（白 10%）/ 浅色 card = #1A000000（黑 10%）
 *       卡片描边、指标块底、面板底全部透明；分割线 深 #33FFFFFF / 浅 #1F000000
 *   · **实色兜底**（窗口透明失败）：近实色面板 + 实色卡片，保证可读性
 * 文字三级透明度：深 #E5FFFFFF / #99FFFFFF / #7AFFFFFF，浅 #E5000000 / #99000000 / #75000000。
 */
class TrayPalette {
  dark: boolean = true;
  panel: string = '#00000000';
  card: string = '#1AFFFFFF';
  cardBorder: string = '#00000000';
  tile: string = '#00000000';
  tileBorder: string = '#00000000';
  btnRest: string = '#1FFFFFFF';
  divider: string = '#33FFFFFF';
  font1: string = '#E5FFFFFF';
  font2: string = '#99FFFFFF';
  font3: string = '#7AFFFFFF';
  brand: string = '#317AF7';
  onBrand: string = '#FFFFFF';
  up: string = '#ED6F21';
  down: string = '#317AF7';
  ok: string = '#5BA854';
  err: string = '#E84026';
  grid: string = '#26FFFFFF';

  /**
   * 实色兜底：窗口透明失败时用。
   *
   * 玻璃模式的前提是"窗口能透明"；如果 setWindowBackgroundColor 抛错，
   * 面板就等于画在系统默认底色上，白字 + 10% 白卡会直接糊成一片。
   * 所以透明失败时切到近实色配色，保证可读性。
   */
  static solid(dark: boolean): TrayPalette {
    const pal = new TrayPalette(dark);
    if (dark) {
      pal.panel = '#FF1B1B1F';
      pal.card = '#FF232329';
      pal.cardBorder = '#1AFFFFFF';
      pal.tile = '#FF2C2C33';
      pal.tileBorder = '#00000000';
      pal.btnRest = '#FF31313A';
      pal.divider = '#33FFFFFF';
    } else {
      pal.panel = '#FFF7F8FA';
      pal.card = '#FFFFFFFF';
      pal.cardBorder = '#14000000';
      pal.tile = '#FFF1F3F5';
      pal.tileBorder = '#00000000';
      pal.btnRest = '#FFE8EAEE';
      pal.divider = '#1F000000';
    }
    return pal;
  }

  constructor(dark: boolean) {
    this.dark = dark;
    if (dark) {
      return;
    }
    // 浅色：卡片"黑 10%"、按钮"黑 8%"、分割线"黑 12%"，文字用黑系
    this.panel = '#00000000';
    this.card = '#1A000000';
    this.cardBorder = '#00000000';
    this.tile = '#00000000';
    this.tileBorder = '#00000000';
    this.btnRest = '#14000000';
    this.divider = '#1F000000';
    this.font1 = '#E5000000';
    this.font2 = '#99000000';
    this.font3 = '#75000000';
    this.brand = '#0A59F7';
    this.onBrand = '#FFFFFF';
    this.up = '#ED6F21';
    this.down = '#0A59F7';
    this.ok = '#64BB5C';
    this.err = '#E84026';
    this.grid = '#1F000000';
  }
}

@Entry
@Component
struct TrayPanel {
  // ── 字阶（与 Clash 面板一致：20 / 16 / 14 / 12）──
  private fsL1: number = 20;
  private fsL2: number = 16;
  private fsL3: number = 14;
  private fsL4: number = 12;
  // ── 间距（8vp 网格）──
  private gapCard: number = 8;
  private padCard: number = 14;
  private padPage: number = 16;

  @State pal: TrayPalette = new TrayPalette(true);
  @State engine: string = 'unknown';
  @State active: number = 0;
  @State waiting: number = 0;
  @State paused: number = 0;
  @State completed: number = 0;
  @State errorCount: number = 0;
  @State speedDown: number = 0;
  @State speedUp: number = 0;
  @State totalDown: number = 0;
  @State totalUp: number = 0;
  @State hasProgress: boolean = false;
  @State percent: number = 0;
  @State completedBytes: number = 0;
  @State totalBytes: number = 0;
  @State fresh: boolean = false;
  @State tasks: TrayTask[] = [];
  /** 窗口透明是否设置成功；失败就用实色兜底（否则白字压白底看不清） */
  @State transparentOk: boolean = true;
  private lastTransparentOk: boolean = true;

  private filesDir: string = '';
  private timer: number = -1;
  // 折线图
  private chartSettings: RenderingContextSettings = new RenderingContextSettings(true);
  private chartCtx: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.chartSettings);
  private chartReady: boolean = false;
  private chartW: number = 300;
  private chartH: number = CHART_H;
  private downSeries: number[] = [];
  private upSeries: number[] = [];
  private lastDark: boolean = true;

  aboutToAppear(): void {
    this.resolveContext();
    this.pal = this.buildPalette(this.detectDark());
    this.lastDark = this.pal.dark;
    this.lastTransparentOk = this.transparentOk;
    this.setupWindow();
    this.refresh();
    this.timer = setInterval(() => {
      this.refresh();
    }, 1000);
  }

  aboutToDisappear(): void {
    if (this.timer !== -1) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }

  /** 面板被系统复用/重新弹出时立刻对一次状态，避免看到上次的旧数字 */
  onPageShow(): void {
    this.refresh();
  }

  // ── 上下文 / 窗口 ─────────────────────────────────────────────────────────
  private resolveContext(): void {
    try {
      const ctx = getContext(this) as common.UIExtensionContext;
      this.filesDir = ctx.filesDir;
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'resolve context failed: %{public}s', (error as Error).message);
    }
  }

  /** 造调色板：透明可用走玻璃模式，否则实色兜底 */
  private buildPalette(dark: boolean): TrayPalette {
    return this.transparentOk ? new TrayPalette(dark) : TrayPalette.solid(dark);
  }

  private detectDark(): boolean {
    try {
      const ctx = getContext(this) as common.UIExtensionContext;
      return ctx.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    } catch (error) {
      return true;
    }
  }

  /**
   * 让面板窗口透明：玻璃模式的前提。
   * 三个 API 各自单独兜错 —— `setWindowContainerColor` 在 tablet/2in1 上可能不可用，
   * 塞在一个 try 里会把它后面的 `setWindowDecorVisible` 一起废掉（Clash 踩过）。
   */
  private async setupWindow(): Promise<void> {
    let win: window.Window | null = null;
    try {
      win = await window.getLastWindow(getContext(this));
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'get window failed: %{public}s', (error as Error).message);
      return;
    }
    if (win === null) {
      return;
    }
    try {
      await win.setWindowBackgroundColor('#00000000');
    } catch (error) {
      this.transparentOk = false;
      this.lastTransparentOk = false;
      this.pal = this.buildPalette(this.lastDark);
      hilog.warn(DOMAIN, TAG, 'setWindowBackgroundColor failed, use solid palette: %{public}s',
        (error as Error).message);
    }
    try {
      await win.setWindowContainerColor('#00000000', '#00000000');
    } catch (error) {
      hilog.info(DOMAIN, TAG, 'setWindowContainerColor skipped: %{public}s', (error as Error).message);
    }
    try {
      win.setWindowDecorVisible(false);
    } catch (error) {
      hilog.info(DOMAIN, TAG, 'setWindowDecorVisible skipped: %{public}s', (error as Error).message);
    }
    hilog.info(DOMAIN, TAG, 'panel window ready (transparent)');
  }

  // ── 数据刷新 ──────────────────────────────────────────────────────────────
  private refresh(): void {
    const dark = this.detectDark();
    if (dark !== this.lastDark || this.transparentOk !== this.lastTransparentOk) {
      this.lastDark = dark;
      this.lastTransparentOk = this.transparentOk;
      this.pal = this.buildPalette(dark);
    }
    const snapshot: TraySnapshot | null = readTraySnapshot(this.filesDir);
    if (snapshot === null) {
      this.fresh = false;
      return;
    }
    this.fresh = isSnapshotFresh(snapshot);
    this.engine = typeof snapshot.engine === 'string' ? snapshot.engine : 'unknown';
    this.active = typeof snapshot.active === 'number' ? snapshot.active : 0;
    this.waiting = typeof snapshot.waiting === 'number' ? snapshot.waiting : 0;
    this.paused = typeof snapshot.paused === 'number' ? snapshot.paused : 0;
    this.completed = typeof snapshot.completed === 'number' ? snapshot.completed : 0;
    this.errorCount = typeof snapshot.error === 'number' ? snapshot.error : 0;
    this.speedDown = typeof snapshot.speedDown === 'number' ? snapshot.speedDown : 0;
    this.speedUp = typeof snapshot.speedUp === 'number' ? snapshot.speedUp : 0;
    this.totalDown = typeof snapshot.totalDown === 'number' ? snapshot.totalDown : 0;
    this.totalUp = typeof snapshot.totalUp === 'number' ? snapshot.totalUp : 0;
    this.hasProgress = snapshot.hasProgress === true && this.active + this.paused > 0;
    this.percent = typeof snapshot.percent === 'number' ? snapshot.percent : 0;
    this.completedBytes = typeof snapshot.completedBytes === 'number' ? snapshot.completedBytes : 0;
    this.totalBytes = typeof snapshot.totalBytes === 'number' ? snapshot.totalBytes : 0;
    if (snapshot.tasks !== undefined && snapshot.tasks !== null) {
      this.tasks = snapshot.tasks;
    } else {
      this.tasks = [];
    }
    this.collectChartData(snapshot.history);
    this.drawChart();
  }

  private collectChartData(history: TraySpeedPoint[] | undefined): void {
    const downs: number[] = [];
    const ups: number[] = [];
    if (history !== undefined && history !== null) {
      const start = history.length > 60 ? history.length - 60 : 0;
      for (let i = start; i < history.length; i++) {
        const point = history[i];
        downs.push(typeof point.down === 'number' ? point.down : 0);
        ups.push(typeof point.up === 'number' ? point.up : 0);
      }
    }
    this.downSeries = downs;
    this.upSeries = ups;
  }

  // ── 折线图（Canvas）──────────────────────────────────────────────────────
  private drawChart(): void {
    if (!this.chartReady) {
      return;
    }
    const w = this.chartW;
    const h = this.chartH;
    if (w < 40 || h < 30) {
      return;
    }
    try {
      const ctx = this.chartCtx;
      const pal = this.pal;
      ctx.clearRect(0, 0, w, h);
      const top = 6;
      const bottom = 6;
      const left = 2;
      const right = 2;
      const innerW = w - left - right;
      const innerH = h - top - bottom;

      // 三条横向网格线
      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      for (let i = 0; i <= 3; i++) {
        const y = top + (innerH * i) / 3;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + innerW, y);
        ctx.stroke();
      }

      const count = Math.max(this.downSeries.length, this.upSeries.length);
      if (count < 2) {
        return;
      }
      let max = 1;
      for (let i = 0; i < this.downSeries.length; i++) {
        if (this.downSeries[i] > max) {
          max = this.downSeries[i];
        }
      }
      for (let i = 0; i < this.upSeries.length; i++) {
        if (this.upSeries[i] > max) {
          max = this.upSeries[i];
        }
      }

      // 下载：面积 + 折线
      if (this.downSeries.length >= 2) {
        ctx.beginPath();
        for (let i = 0; i < this.downSeries.length; i++) {
          const x = left + (innerW * i) / (count - 1);
          const y = top + innerH - (this.downSeries[i] / max) * innerH;
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        const lastX = left + (innerW * (this.downSeries.length - 1)) / (count - 1);
        ctx.lineTo(lastX, top + innerH);
        ctx.lineTo(left, top + innerH);
        ctx.closePath();
        const gradient = ctx.createLinearGradient(0, top, 0, top + innerH);
        gradient.addColorStop(0, pal.dark ? 'rgba(49,122,247,0.34)' : 'rgba(10,89,247,0.30)');
        gradient.addColorStop(1, pal.dark ? 'rgba(49,122,247,0.02)' : 'rgba(10,89,247,0.02)');
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < this.downSeries.length; i++) {
          const x = left + (innerW * i) / (count - 1);
          const y = top + innerH - (this.downSeries[i] / max) * innerH;
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.strokeStyle = pal.down;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // 上传：只画折线
      if (this.upSeries.length >= 2) {
        ctx.beginPath();
        for (let i = 0; i < this.upSeries.length; i++) {
          const x = left + (innerW * i) / (count - 1);
          const y = top + innerH - (this.upSeries[i] / max) * innerH;
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.strokeStyle = pal.up;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'draw chart failed: %{public}s', (error as Error).message);
    }
  }

  // ── 命令 / 事件 ──────────────────────────────────────────────────────────
  private controlEnabled(): boolean {
    return this.fresh && this.engine === 'ready';
  }

  private sendBulk(command: string): void {
    const ok = appendTrayCommand(this.filesDir, command);
    hilog.info(DOMAIN, TAG, 'bulk command: %{public}s ok=%{public}s', command, String(ok));
  }

  private sendTaskCommand(command: string, taskId: string): void {
    const ok = appendTrayTaskCommand(this.filesDir, command, taskId);
    hilog.info(DOMAIN, TAG, 'task command: %{public}s id=%{public}s ok=%{public}s',
      command, taskId, String(ok));
  }

  private publishOpen(): void {
    try {
      const options: commonEventManager.CommonEventPublishData = { data: 'open' };
      commonEventManager.publish(EVENT_OPEN, options, (err: BusinessError): void => {
        if (err) {
          hilog.warn(DOMAIN, TAG, 'publish open failed: %{public}s', err.message);
        }
      });
    } catch (error) {
      hilog.warn(DOMAIN, TAG, 'publish open throw: %{public}s', (error as Error).message);
    }
  }

  // ── 小构件 ───────────────────────────────────────────────────────────────
  // ── UI ───────────────────────────────────────────────────────────────────
  build() {
    Column() {
      Column() {
        // ★ 卡片统一放在这个"带左右内边距"的容器里：
        //   ArkUI 里 width('100%') + margin(left/right) 会溢出父容器（视觉上就是"卡片贴边"），
        //   所以"离窗口边框的间距"必须由父容器 padding 提供，不能给卡片自己加 margin。
        Column() {
          // ── 卡片 1：传输（折线图 + 四项指标，对齐主界面"传输统计"卡片）──
        Column() {
          Row() {
            Text('传输')
              .fontSize(this.fsL2)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.pal.font1)
            Blank()
            Row() {
              Row()
                .width(6)
                .height(6)
                .borderRadius(3)
                .backgroundColor(this.pal.up)
              Text('上传')
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
                .margin({ left: 4, right: 10 })
              Row()
                .width(6)
                .height(6)
                .borderRadius(3)
                .backgroundColor(this.pal.down)
              Text('下载')
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
                .margin({ left: 4 })
            }
          }
          .width('100%')

          Canvas(this.chartCtx)
            .width('100%')
            .height(CHART_H)
            .margin({ top: 6 })
            .onReady((): void => {
              this.chartReady = true;
              this.drawChart();
            })
            .onAreaChange((_oldValue: Area, newValue: Area): void => {
              const nextW = Number(newValue.width);
              const nextH = Number(newValue.height);
              if (!Number.isNaN(nextW) && nextW > 0) {
                this.chartW = nextW;
              }
              if (!Number.isNaN(nextH) && nextH > 0) {
                this.chartH = nextH;
              }
              this.drawChart();
            })

          Row({ space: 8 }) {
            Column() {
              Text('下载速度')
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
                .maxLines(1)
              Text(`${formatBytes(this.speedDown)}/s`)
                .fontSize(this.fsL2)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.pal.font1)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .margin({ top: 2 })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
            .padding(10)
            .borderRadius(12)
            .backgroundColor(this.pal.tile)

            Column() {
              Text('上传速度')
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
                .maxLines(1)
              Text(`${formatBytes(this.speedUp)}/s`)
                .fontSize(this.fsL2)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.pal.font1)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .margin({ top: 2 })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
            .padding(10)
            .borderRadius(12)
            .backgroundColor(this.pal.tile)
          }
          .width('100%')
          .margin({ top: 8 })

          Row({ space: 8 }) {
            Column() {
              Text('下载量（本次任务）')
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
                .maxLines(1)
              Text(formatBytes(this.totalDown))
                .fontSize(this.fsL2)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.pal.font1)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .margin({ top: 2 })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
            .padding(10)
            .borderRadius(12)
            .backgroundColor(this.pal.tile)

            Column() {
              Text('上传量（本次任务）')
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
                .maxLines(1)
              Text(formatBytes(this.totalUp))
                .fontSize(this.fsL2)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.pal.font1)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .margin({ top: 2 })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
            .padding(10)
            .borderRadius(12)
            .backgroundColor(this.pal.tile)
          }
          .width('100%')
          .margin({ top: 8 })
        }
        .width('100%')
        .padding(this.padCard)
        .borderRadius(16)
        .backgroundColor(this.pal.card)
        .border({ width: 1, color: this.pal.cardBorder })
        .margin({ bottom: this.gapCard })

          // ── 卡片 2：任务概览（对齐主界面"任务磁贴"卡片）──
        Column() {
          Row() {
            Text('任务概览')
              .fontSize(this.fsL2)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.pal.font1)
            Blank()
            if (this.hasProgress) {
              Text(`总进度 ${this.percent}%`)
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
            }
          }
          .width('100%')

          if (this.hasProgress) {
            Progress({ value: this.percent, total: 100, type: ProgressType.Linear })
              .width('100%')
              .height(4)
              .color(this.pal.brand)
              .backgroundColor(this.pal.tile)
              .margin({ top: 8 })
          }

          Row() {
            Column() {
              Text(`${this.active}`)
                .fontSize(this.fsL1)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.pal.font1)
              Text('进行中')
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
                .margin({ top: 1 })
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Center)

            Column() {
              Text(`${this.waiting}`)
                .fontSize(this.fsL1)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.pal.font1)
              Text('等待')
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
                .margin({ top: 1 })
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Center)

            Column() {
              Text(`${this.paused}`)
                .fontSize(this.fsL1)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.pal.font1)
              Text('暂停')
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
                .margin({ top: 1 })
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Center)

            Column() {
              Text(`${this.completed}`)
                .fontSize(this.fsL1)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.pal.font1)
              Text('完成')
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
                .margin({ top: 1 })
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Center)

            Column() {
              Text(`${this.errorCount}`)
                .fontSize(this.fsL1)
                .fontWeight(FontWeight.Medium)
                .fontColor(this.errorCount > 0 ? this.pal.err : this.pal.font1)
              Text('出错')
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
                .margin({ top: 1 })
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Center)
          }
          .width('100%')
          .margin({ top: 8 })
        }
        .width('100%')
        .padding(this.padCard)
        .borderRadius(16)
        .backgroundColor(this.pal.card)
        .border({ width: 1, color: this.pal.cardBorder })
        .margin({ bottom: this.gapCard })

          // ── 卡片 3：下载任务（固定高度 + 内部滚动 + 每行操作按钮）──
        Column() {
          Row() {
            Text('下载任务')
              .fontSize(this.fsL2)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.pal.font1)
            Blank()
            Button('全部暂停', { type: ButtonType.Capsule })
              .height(26)
              .fontSize(this.fsL4)
              .fontColor(this.pal.font1)
              .backgroundColor(this.pal.btnRest)
              .padding({ left: 10, right: 10 })
              .enabled(this.controlEnabled())
              .opacity(this.controlEnabled() ? 1 : 0.4)
              .onClick(() => {
                this.sendBulk(TRAY_CMD_PAUSE_ALL);
              })
            Button('全部继续', { type: ButtonType.Capsule })
              .height(26)
              .fontSize(this.fsL4)
              .fontColor(this.pal.font1)
              .backgroundColor(this.pal.btnRest)
              .padding({ left: 10, right: 10 })
              .margin({ left: 6 })
              .enabled(this.controlEnabled())
              .opacity(this.controlEnabled() ? 1 : 0.4)
              .onClick(() => {
                this.sendBulk(TRAY_CMD_RESUME_ALL);
              })
          }
          .width('100%')

          if (this.tasks.length === 0) {
            Column() {
              Text(this.fresh ? '暂无下载任务' : '未连接到 Motrix 后台')
                .fontSize(this.fsL4)
                .fontColor(this.pal.font3)
            }
            .width('100%')
            .layoutWeight(1)
            .justifyContent(FlexAlign.Center)
          } else {
            List({ space: 0 }) {
              ForEach(this.tasks, (task: TrayTask, index: number) => {
                ListItem() {
                  this.taskRow(task, index)
                }
              }, (task: TrayTask) => this.taskRowKey(task))
            }
            .width('100%')
            .layoutWeight(1)
            .scrollBar(BarState.Off)
            .edgeEffect(EdgeEffect.Fade)
            .margin({ top: 4 })
          }
        }
        .width('100%')
        .padding(this.padCard)
        .borderRadius(16)
        .backgroundColor(this.pal.card)
        .border({ width: 1, color: this.pal.cardBorder })
        .margin({ bottom: this.gapCard })
        .layoutWeight(1)
        }
        .width('100%')
        .layoutWeight(1)
        .padding({ left: this.padPage, right: this.padPage, top: 6 })

        // ── 底部：分割线 + 打开主界面（对齐 Clash 面板的底部菜单行）──
        Divider()
          .strokeWidth(1)
          .color(this.pal.divider)
        Row() {
          Text('打开 Motrix')
            .fontSize(this.fsL2)
            .fontColor(this.pal.font1)
          Blank()
          Row() {
            Circle()
              .width(7)
              .height(7)
              .fill(this.engine === 'ready'
                ? this.pal.ok
                : (this.engine === 'failed' ? this.pal.err : this.pal.font3))
            Text(engineStateText(this.engine))
              .fontSize(this.fsL4)
              .fontColor(this.pal.font2)
              .margin({ left: 5 })
          }
        }
        .width('100%')
        .height(40)
        .padding({ left: this.padPage, right: this.padPage })
        .hoverEffect(HoverEffect.Highlight)
        .onClick(() => {
          this.publishOpen();
        })
      }
      .width('100%')
      .layoutWeight(1)
      .backgroundColor(this.pal.panel)
      .border({ width: 1, color: this.pal.cardBorder })
    }
    .width('100%')
    .height('100%')
  }

  /**
   * 官方圆形图标按钮。
   *
   * 用系统 Button（`ButtonType.Circle` + `ButtonStyleMode.NORMAL` + `ControlSize.SMALL`），
   * 不再自己拿 Row + SymbolGlyph 拼：官方控件自带按压反馈、焦点环、无障碍语义和正确圆形热区；
   * 尺寸比官方 SMALL 再小一档（26vp），面板里够用且不抢空间。
   */
  /**
   * 官方圆形图标按钮。
   *
   * 用系统 Button（`ButtonType.Circle` + `ButtonStyleMode.NORMAL`）：自带按压反馈、
   * 焦点环与无障碍语义。图标**一律用主文字色**（浅色主题下就是近黑），不用品牌蓝——
   * 任务行动作键不该抢视觉焦点。
   * `padding(0)` 是必须的：Button 默认带内边距，会把 SymbolGlyph 顶偏（实机看着"图标偏右"）。
   */
  @Builder
  iconButton(symbol: Resource, handler: () => void) {
    Button({ type: ButtonType.Circle, stateEffect: true }) {
      SymbolGlyph(symbol)
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor([this.pal.font1])
    }
    .width(26)
    .height(26)
    .padding(0)
    .buttonStyle(ButtonStyleMode.NORMAL)
    .backgroundColor(this.pal.btnRest)
    .onClick(handler)
  }

  /** 进度条颜色：出错红 / 暂停灰 / 完成绿 / 其它品牌蓝 */
  private taskBarColor(status: string): string {
    if (status === 'error') {
      return this.pal.err;
    }
    if (status === 'paused') {
      return this.pal.font3;
    }
    if (status === 'completed' || status === 'seeding') {
      return this.pal.ok;
    }
    return this.pal.brand;
  }

  /**
   * ForEach 的 key。
   *
   * 把行内**会显示的所有字段**都编进去：ArkUI 的 ForEach 在 key 不变时不会重建行，
   * 只把进度百分比放进 key 会让"速度 / 尺寸 / ETA"停在上一次的值（这也是上一版
   * 看起来"不实时"的原因之一）。
   */
  private taskRowKey(task: TrayTask): string {
    const id = task.id !== undefined ? task.id : '';
    const status = task.status !== undefined ? task.status : '';
    const pct = task.progress !== undefined ? task.progress.toFixed(1) : '0.0';
    const speed = task.speed !== undefined ? Math.round(task.speed) : 0;
    const up = task.up !== undefined ? Math.round(task.up) : 0;
    const done = task.done !== undefined ? task.done : 0;
    const total = task.total !== undefined ? task.total : 0;
    const eta = task.eta !== undefined ? Math.round(task.eta) : 0;
    const error = task.error !== undefined ? task.error.length : 0;
    return `${id}|${status}|${pct}|${speed}|${up}|${done}|${total}|${eta}|${error}`;
  }

  /**
   * 任务行（三行结构）：
   *   ① 文件名（独占一行，长名字显示最完整）
   *   ② 进度条（独占一行，最长可读）
   *   ③ 进度文案（独占一行：`12.6% · 90.9 MB/724 MB · 1.2 MB/s · 剩 3 分`）
   * 右侧是官方圆钮动作组：暂停/继续（完成态为"重新下载"）+ ✕。
   */
  @Builder
  taskRow(task: TrayTask, index: number) {
    Column() {
      if (index > 0) {
        Divider()
          .strokeWidth(1)
          .color(this.pal.divider)
      }
      Row() {
        Column() {
          Text(task.name !== undefined && task.name.length > 0 ? task.name : '（未命名任务）')
            .fontSize(this.fsL3)
            .fontColor(this.pal.font1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')

          Progress({
            value: Math.max(0, Math.min(100, task.progress !== undefined ? task.progress : 0)),
            total: 100,
            type: ProgressType.Linear
          })
            .width('100%')
            .height(3)
            .color(this.taskBarColor(task.status !== undefined ? task.status : ''))
            .backgroundColor(this.pal.tile)
            .margin({ top: 6 })

          Text(this.taskDetailText(task))
            .fontSize(this.fsL4)
            .fontColor(task.status === 'error' ? this.pal.err : this.pal.font3)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .margin({ top: 5 })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        // 右侧动作组：两个官方圆钮，间距 8；与文字区隔 12
        Row({ space: 8 }) {
          if (isTaskFinished(task.status !== undefined ? task.status : '')) {
            // 已完成/出错：圆环箭头 = 重新下载
            this.iconButton($r('sys.symbol.arrow_clockwise'), () => {
              const id = task.id !== undefined ? task.id : '';
              this.sendTaskCommand(TRAY_CMD_RETRY_TASK, id);
            })
          } else {
            if (isTaskRunning(task.status !== undefined ? task.status : '')) {
              this.iconButton($r('sys.symbol.pause'), () => {
                const id = task.id !== undefined ? task.id : '';
                this.sendTaskCommand(TRAY_CMD_PAUSE_TASK, id);
              })
            } else {
              this.iconButton($r('sys.symbol.play_fill'), () => {
                const id = task.id !== undefined ? task.id : '';
                this.sendTaskCommand(TRAY_CMD_RESUME_TASK, id);
              })
            }
          }
          this.iconButton($r('sys.symbol.xmark'), () => {
            const id = task.id !== undefined ? task.id : '';
            this.sendTaskCommand(TRAY_CMD_REMOVE_TASK, id);
          })
        }
        .margin({ left: 12 })
      }
      .width('100%')
      .padding({ top: 9, bottom: 9 })
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
  }

  private taskDetailText(task: TrayTask): string {
    const status = task.status !== undefined ? task.status : '';
    // 进度统一保留 1 位小数（与主界面 formatProgressPercent 一致）
    const pct = Math.max(0, Math.min(100, task.progress !== undefined ? task.progress : 0));
    const pctText = `${pct.toFixed(1)}%`;
    if (status === 'error') {
      const message = task.error !== undefined && task.error.length > 0 ? task.error : '下载失败';
      return `${pctText} · ${message}`;
    }
    const total = task.total !== undefined ? task.total : 0;
    const done = task.done !== undefined ? task.done : 0;
    const speed = task.speed !== undefined ? task.speed : 0;
    const eta = task.eta !== undefined ? task.eta : 0;
    const parts: string[] = [];
    parts.push(pctText);
    if (total > 0) {
      parts.push(`${formatBytes(done)}/${formatBytes(total)}`);
    }
    if (isTaskRunning(status) && speed > 0) {
      parts.push(`${formatBytes(speed)}/s`);
    } else {
      parts.push(taskStatusText(status));
    }
    if (isTaskRunning(status) && eta > 0) {
      const text = formatEta(eta);
      if (text.length > 0) {
        parts.push(text);
      }
    }
    return parts.join(' · ');
  }
}
