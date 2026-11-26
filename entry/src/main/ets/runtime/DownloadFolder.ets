/**
 * 公共下载目录的"认领"——端侧唯一能拿到**用户可见**下载目录的正路。
 *
 * 为什么不能像桌面那样直接 mkdir：
 *   应用进程**没有**在公共 Download 根下创建目录的权限（真机实测：EPERM）。
 *   唯一可行的是 `DocumentViewPicker` 的 `DocumentPickerMode.DOWNLOAD`：
 *     · 自动创建 `Download/<包名>/`，跳过文件选择界面；
 *     · 返回的 URI **自带持久化权限**，卸载重装（同包名）后仍可访问；
 *     · 该授权是**路径级**的，进程内 node:fs / aria2 子进程吃同一份授权。
 *
 * 两步走（参考宿主项目 实测更优的次序，照抄）：
 *   ① 先按包名直拼路径并**探写**：命中说明之前已经建过归属，不必再调 save()；
 *   ② 不命中才用 DOWNLOAD 模式 save() 建立归属。
 *
 * 失败不阻断启动：拿不到就退回应用沙箱内的 `<data>/Downloads`，并在 note 里说明。
 */

import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { fileUri } from '@kit.CoreFileKit';
import { bundleManager } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x0000;
const TAG = 'MOTRIX-DIR';
const WRITE_PROBE_NAME = '.motrix-write-probe';

export interface DownloadFolderClaim {
  /** 可写的下载目录绝对路径；空串 = 认领失败 */
  path: string;
  /** 人类可读结论（写进日志与诊断页） */
  note: string;
  /** 是否是用户可见的公共目录（false = 退回沙箱） */
  isPublic: boolean;
}

function readBundleName(): string {
  try {
    const flags: number = bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION;
    const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(flags);
    return info.name;
  } catch (error) {
    const err = error as BusinessError;
    hilog.warn(DOMAIN, TAG, '取包名失败: %{public}s', err.message);
    return '';
  }
}

function pathOfUri(uri: string): string {
  try {
    return new fileUri.FileUri(uri).path;
  } catch (error) {
    const err = error as BusinessError;
    hilog.warn(DOMAIN, TAG, 'URI → 路径失败: %{public}s', err.message);
    return '';
  }
}

function isDirectory(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch (error) {
    return false;
  }
}

/**
 * 探写：真正 open+write+unlink 一次，而不是只看 stat/access。
 * （hmfs 上 stat 会撒谎；"能 stat 到"不等于"能写"。）
 */
export function probePathWritable(path: string): boolean {
  if (path.length === 0) {
    return false;
  }
  const probe = `${path}/${WRITE_PROBE_NAME}`;
  let file: fs.File | undefined = undefined;
  try {
    file = fs.openSync(probe, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    fs.writeSync(file.fd, 'ok');
    fs.closeSync(file);
    file = undefined;
    fs.unlinkSync(probe);
    return true;
  } catch (error) {
    const err = error as BusinessError;
    hilog.info(DOMAIN, TAG, '探写失败（按不可写处理）: %{public}d %{public}s', err.code, err.message);
    return false;
  } finally {
    if (file !== undefined) {
      try {
        fs.closeSync(file);
      } catch (error) {
        /* ignore */
      }
    }
  }
}

/** 认领公共下载目录：Download/<包名> */
export async function claimPublicDownload(context: common.UIAbilityContext): Promise<DownloadFolderClaim> {
  const bundleName = readBundleName();
  if (bundleName.length === 0) {
    return { path: '', note: '拿不到包名，无法定位 Download 下的专属目录', isPublic: false };
  }
  const direct = `/storage/Users/currentUser/Download/${bundleName}`;
  // ① 命中已存在的专属目录（之前建过归属）
  if (isDirectory(direct) && probePathWritable(direct)) {
    hilog.info(DOMAIN, TAG, '公共目录命中已存在的专属目录: %{public}s', direct);
    return { path: direct, note: `已存在且可写: ${direct}`, isPublic: true };
  }
  // ② 用 DOWNLOAD 模式建立归属
  try {
    const options = new picker.DocumentSaveOptions();
    options.pickerMode = picker.DocumentPickerMode.DOWNLOAD;
    const view = new picker.DocumentViewPicker(context);
    const uris: string[] = await view.save(options);
    let path = uris.length > 0 ? pathOfUri(uris[0]) : '';
    // 返回值可能是目录 URI，也可能是 picker 预置的那个空文件 URI —— 两种都要能吃
    if (path.length > 0 && !isDirectory(path)) {
      const slash = path.lastIndexOf('/');
      if (slash > 0) {
        path = path.substring(0, slash);
      }
    }
    if (path.length > 0 && probePathWritable(path)) {
      hilog.info(DOMAIN, TAG, '公共目录已认领: %{public}s', path);
      return { path, note: `DOWNLOAD 模式认领成功: ${path}`, isPublic: true };
    }
    return {
      path: '',
      note: `DOWNLOAD 模式返回了 ${path.length > 0 ? path : '(空)'}，但仍不可写`,
      isPublic: false,
    };
  } catch (error) {
    const err = error as BusinessError;
    hilog.warn(DOMAIN, TAG, 'DOWNLOAD 模式不可用: %{public}d %{public}s', err.code, err.message);
    return {
      path: '',
      note: `DOWNLOAD 模式不可用（${err.code} ${err.message}）`,
      isPublic: false,
    };
  }
}