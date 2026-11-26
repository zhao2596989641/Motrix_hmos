/**
 * 托盘 / Dock 桥（HarmonyOS 移植新增）
 *
 * 数据结构由宿主 Node 写入（见 scripts/host/main.mjs 的「托盘 / Dock 桥」一节）：
 *   <filesDir>/motrix/tray-state.json  —— 每秒一次的状态快照（原子 rename 写入）
 *   <filesDir>/motrix/tray-cmd.jsonl   —— 控制命令队列（面板/主进程追加，宿主轮询执行）
 *
 * 为什么用文件而不是 IPC：托盘左键面板是 **StatusBarViewExtensionAbility**，
 * 跑在独立扩展进程里，和主进程/宿主 Node 之间没有现成回调通道；两边共用同一个应用
 * 沙箱目录（filesDir），文件是唯一稳定、无权限要求的通道（通知桥也是这么做的）。
 *
 * 控制命令故意**不由 ArkTS 直接打服务端 HTTP**：operator 凭据只留在宿主进程里，
 * 面板不需要知道 token，也就不会把凭据散落到别的进程。
 */

import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-TRAYBRIDGE';

/** 与宿主约定的文件名（改这里必须同步 scripts/host/main.mjs） */
export const TRAY_STATE_FILE = 'tray-state.json';
export const TRAY_CMD_FILE = 'tray-cmd.jsonl';

/** 网速历史点（与主界面仪表板同源：服务端 speedHistory） */
export interface TraySpeedPoint {
  t?: number;
  down?: number;
  up?: number;
}

/** 托盘任务行（宿主从 query:listTasks 投影出来，只保留面板要显示的字段） */
export interface TrayTask {
  id?: string;
  name?: string;
  status?: string;
  progress?: number;
  done?: number;
  total?: number;
  speed?: number;
  up?: number;
  eta?: number;
  error?: string;
  updatedAt?: number;
  rank?: number;
}

/** 任务数/速度/进度快照；字段全部可缺省，读到旧文件也不会炸 */
export interface TraySnapshot {
  at?: number;
  pid?: number;
  engine?: string;
  active?: number;
  waiting?: number;
  paused?: number;
  completed?: number;
  error?: number;
  speedDown?: number;
  speedUp?: number;
  totalDown?: number;
  totalUp?: number;
  hasProgress?: boolean;
  percent?: number;
  completedBytes?: number;
  totalBytes?: number;
  state?: string;
  tasks?: TrayTask[];
  history?: TraySpeedPoint[];
}

/** 命令名（与 scripts/host/main.mjs 的 runTrayCommand 对应） */
export const TRAY_CMD_PAUSE_ALL = 'pauseAll';
export const TRAY_CMD_RESUME_ALL = 'resumeAll';
export const TRAY_CMD_PAUSE_TASK = 'pauseTask';
export const TRAY_CMD_RESUME_TASK = 'resumeTask';
export const TRAY_CMD_REMOVE_TASK = 'removeTask';
/** 已完成/出错任务的"重新下载"（宿主映射 command:retryTasks） */
export const TRAY_CMD_RETRY_TASK = 'retryTask';
/** 深链命令：接一条磁力链 / 一个 .torrent 文件（队列独立，宿主启动时不会清掉） */
export const DEEPLINK_CMD_ADD_MAGNET = 'addMagnet';
export const DEEPLINK_CMD_ADD_TORRENT = 'addTorrent';

/** 托盘数据目录：宿主把它放在 <filesDir>/motrix 下 */
export function trayDir(filesDir: string): string {
  return `${filesDir}/motrix`;
}

export function trayStatePath(filesDir: string): string {
  return `${trayDir(filesDir)}/${TRAY_STATE_FILE}`;
}

export function trayCmdPath(filesDir: string): string {
  return `${trayDir(filesDir)}/${TRAY_CMD_FILE}`;
}

/**
 * 深链命令队列。
 *
 * 为什么与托盘命令分文件：托盘命令文件在宿主启动时会被清空（避免执行上一轮残留），
 * 而**冷启动深链**恰好发生在宿主启动之前——写进同一个文件会被宿主清掉。
 */
export const DEEPLINK_CMD_FILE = 'deeplink-cmd.jsonl';

export function deeplinkCmdPath(filesDir: string): string {
  return `${trayDir(filesDir)}/${DEEPLINK_CMD_FILE}`;
}

/**
 * 读一份状态快照。
 *
 * 宿主用 rename 原子替换，所以这里**不会读到半截 JSON**；但文件可能还没生成
 * （应用刚启动、或宿主已退出），统一返回 null 由调用方降级。
 */
export function readTraySnapshot(filesDir: string): TraySnapshot | null {
  if (filesDir.length === 0) {
    return null;
  }
  try {
    const text = fs.readTextSync(trayStatePath(filesDir));
    if (text.length === 0) {
      return null;
    }
    const parsed = JSON.parse(text) as TraySnapshot;
    return parsed;
  } catch (error) {
    // 文件不存在 / 正在被替换：都按"没有快照"处理，不打错误日志（每秒都会发生）
    hilog.debug(DOMAIN, TAG, 'read tray state skipped: %{public}s', (error as Error).message);
    return null;
  }
}

/** 追加一条命令（换行分隔；宿主每次读完会清空文件） */
export function appendTrayCommand(filesDir: string, command: string): boolean {
  const dir = trayDir(filesDir);
  try {
    fs.mkdirSync(dir, true);
  } catch (error) {
    // 目录已存在：忽略
  }
  try {
    const file = fs.openSync(
      trayCmdPath(filesDir),
      fs.OpenMode.CREATE | fs.OpenMode.APPEND | fs.OpenMode.WRITE_ONLY
    );
    fs.writeSync(file.fd, `${command}\n`);
    fs.closeSync(file);
    return true;
  } catch (error) {
    hilog.warn(DOMAIN, TAG, 'append tray command failed: %{public}s', (error as Error).message);
    return false;
  }
}

/**
 * 追加一条带 taskId 的命令（JSON 行）。
 *
 * 为什么批量命令用裸字符串、单任务用 JSON：宿主的 readTrayCommands 两种都认，
 * 裸字符串最省事；带参数时只能上 JSON。
 */
export function appendTrayTaskCommand(
  filesDir: string,
  command: string,
  taskId: string
): boolean {
  if (taskId.length === 0) {
    return false;
  }
  const payload = JSON.stringify({ cmd: command, taskId: taskId });
  return appendRawLine(filesDir, payload);
}

function appendRawLine(filesDir: string, line: string): boolean {
  const dir = trayDir(filesDir);
  try {
    fs.mkdirSync(dir, true);
  } catch (error) {
    // 目录已存在：忽略
  }
  try {
    const file = fs.openSync(
      trayCmdPath(filesDir),
      fs.OpenMode.CREATE | fs.OpenMode.APPEND | fs.OpenMode.WRITE_ONLY
    );
    fs.writeSync(file.fd, `${line}\n`);
    fs.closeSync(file);
    return true;
  } catch (error) {
    hilog.warn(DOMAIN, TAG, 'append tray line failed: %{public}s', (error as Error).message);
    return false;
  }
}

/**
 * 追加一条深链命令。
 *
 * @param command DEEPLINK_CMD_ADD_MAGNET / DEEPLINK_CMD_ADD_TORRENT
 * @param value   磁力链原文 或 .torrent 的本地绝对路径
 */
interface DeepLinkPayload {
  cmd: string;
  uri: string;
  path: string;
}

export function appendDeepLinkCommand(
  filesDir: string,
  command: string,
  value: string
): boolean {
  if (value.length === 0) {
    return false;
  }
  const isTorrent = command === DEEPLINK_CMD_ADD_TORRENT;
  // ArkTS 要求对象字面量有明确类型（arkts-no-untyped-obj-literals）
  const payloadBody: DeepLinkPayload = {
    cmd: command,
    uri: isTorrent ? '' : value,
    path: isTorrent ? value : '',
  };
  const payload = JSON.stringify(payloadBody);
  const dir = trayDir(filesDir);
  try {
    fs.mkdirSync(dir, true);
  } catch (error) {
    // 目录已存在：忽略
  }
  try {
    const file = fs.openSync(
      deeplinkCmdPath(filesDir),
      fs.OpenMode.CREATE | fs.OpenMode.APPEND | fs.OpenMode.WRITE_ONLY
    );
    fs.writeSync(file.fd, `${payload}\n`);
    fs.closeSync(file);
    return true;
  } catch (error) {
    hilog.warn(DOMAIN, TAG, 'append deeplink command failed: %{public}s', (error as Error).message);
    return false;
  }
}

/** .torrent 导入落盘目录（EntryAbility 把系统给的文件拷到这里，宿主再读） */
export function torrentImportDir(filesDir: string): string {
  return `${trayDir(filesDir)}/imports`;
}

/** 任务是否"正在进行"（决定列表右侧显示暂停还是继续） */
export function isTaskRunning(status: string): boolean {
  return status === 'downloading' || status === 'queued' || status === 'fetching_metadata'
    || status === 'metadata_ready' || status === 'finalizing';
}

/** 任务是否已终结（面板对这类只给"移除"，不再给暂停/继续） */
export function isTaskFinished(status: string): boolean {
  return status === 'completed' || status === 'seeding' || status === 'error' || status === 'removed';
}

/** 任务状态 → 中文短标签（面板用） */
export function taskStatusText(status: string): string {
  if (status === 'downloading') {
    return '下载中';
  }
  if (status === 'queued') {
    return '等待中';
  }
  if (status === 'paused') {
    return '已暂停';
  }
  if (status === 'completed') {
    return '已完成';
  }
  if (status === 'seeding') {
    return '做种中';
  }
  if (status === 'error') {
    return '出错';
  }
  if (status === 'fetching_metadata') {
    return '获取元数据';
  }
  if (status === 'metadata_ready') {
    return '待确认';
  }
  if (status === 'finalizing') {
    return '收尾中';
  }
  return status;
}

/** 快照是否还是"活的"（宿主每秒写；超过 5 秒没更新说明宿主没了） */
export function isSnapshotFresh(snapshot: TraySnapshot): boolean {
  const at = typeof snapshot.at === 'number' ? snapshot.at : 0;
  if (at <= 0) {
    return false;
  }
  return Date.now() - at < 5000;
}

/** 字节数 → 人类可读（面板用；不用 i18n，单位保持国际习惯） */
export function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) {
    return `${Math.round(value)} ${units[unit]}`;
  }
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${fixed} ${units[unit]}`;
}

/** 剩余时间 → "3 分 20 秒" / "1 小时 02 分"（面板用，不做 i18n） */
export function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) {
    return '';
  }
  const total = Math.floor(seconds);
  if (total < 60) {
    return `${total} 秒`;
  }
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    return `${minutes} 分 ${total % 60} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/** 引擎状态 → 面板文案 */
export function engineStateText(state: string): string {
  if (state === 'ready') {
    return '就绪';
  }
  if (state === 'starting') {
    return '启动中';
  }
  if (state === 'restarting') {
    return '重启中';
  }
  if (state === 'failed') {
    return '异常';
  }
  if (state === 'stopped') {
    return '已停止';
  }
  return '未知';
}