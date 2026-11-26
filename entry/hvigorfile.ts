// @ts-nocheck
import { hapTasks } from '@ohos/hvigor-ohos-plugin';

/*
 * 随包可执行 ELF 走官方 hap-bin（PC/2in1，API 24+）：
 *   entry/libs/arm64-v8a/{aria2c,motrix-finalize-fs}
 *   + module.json5 的 extractNativeLibs:true / executableBinaryPaths
 *   + build-profile.json5 的 nativeLib.collectAllLibs:true / debugSymbol.strip:false
 *
 * 安装时系统把 libs 解压到 <bundle>/libs/arm64/，并给清单里的文件执行属性。
 *
 * 【HNP 为什么不再用】HNP 安装器对 debug 普通应用的内容校验过不去：
 *   hdc install -r 从 9568409（extract）推进到 9568407（install native package failed），
 *   试过 public/private、0644/0755、去 setgid/去 .codesign，均失败；
 *   安装器日志拿不到。hap-bin 是官方给普通应用的替代通道，故弃用 HNP。
 *   历史的打包任务/脚本仍留在 scripts/build-hnp.sh，仅作记录，不再被构建调用。
 */

export default {
  system: hapTasks,
};