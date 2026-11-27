# 交接：Motrix HarmonyOS PC 移植 —— 当前状态与剩余工作（r64 截止）

> 时间：2026-11-27 23:45
> 产物：`Download/com.lyldeer.dshdesktop/Motrix/com.lyldeer.motrix-2.4.5.64-debug-signed-r64.hap`
> 196,631,434 B · MD5 `c6710dba96c7a4dbfeb6d995ed2f13cf`
> 仓库：`/storage/Users/currentUser/Documents/codes/Motrix/codes/MotrixOHOS`（HEAD `5940f8d`）
> 远端：github `zhao2596989641/Motrix_hmos` + gitcode，均已推送

---

## 一、已经做完的（用户可感知功能 = 全覆盖）

| 域 | 状态 |
|---|---|
| HTTP 下载 / 暂停 / 续传 / 删除（含文件） | ✅ 真机验收 |
| 任务与设置持久化、后台下载、引擎就绪 | ✅ |
| 系统通知、中英文、深浅色、沉浸式标题栏、窗口记忆 | ✅ |
| 托盘（单色图标 / 左键面板 / 右键菜单 / 关窗收托盘）、Dock 进度 | ✅ |
| 深链 `magnet:` / `.torrent` 文件关联 | ✅ 已实现（待点验） |
| 浏览器扩展（MDXP 配对） | ✅ r56 真机联通 |
| 命令行工具 `@motrix/cli` | ✅ r63 真机一键安装，`motrix --version` = 0.5.0 |
| FFmpeg（媒体合流/探测） | ✅ r64 随包自建最小构建，本机 remux 实测通过 |
| 关机自启 | 🟡 只能跳系统设置（鸿蒙不开放程序化开启） |
| 完成后关机 | ⛔ 平台不可用（已隐藏入口） |
| 应用内更新 | ⛔ 已整块隐藏（r54） |
| v1 数据迁移 | ⛔ Electron 专属，无意义 |

## 二、还没做 / 待验（交给 bug 修复对话的重点）

### 1. 真机点验（实现完成，但从未逐项跑过）

限速档位、任务详情、批量操作、创建种子、Tracker、代理、GeoIP、单实例、
reveal / open / 外链、NAT 显示、托盘面板暂停全部、关窗收托盘、
从剪贴板填充 URL、拖 `.torrent` 入窗、非 ASCII 输入法、UPnP/NAT 可达性。

> 这些的代码路径都基于上游 + 至少一次冒烟，但没有系统性的"每项点一遍"。

### 2. 新解锁但未验证

- **插件系统 / 插件市场**（矩阵 C6）：r50 拿到 JIT ACL 后 `WebAssembly === object`，
  宿主日志确认 jitless 垫片已跳过 ⇒ QuickJS-WASM **理论上可用**。
  需要实测：装一个 URL Resolver 或 BT 插件，看是否真的能加载并生效。
  若能跑，侧栏「插件」入口就不该再按"不可用"处理。
- **HLS/DASH 合流**（A18）：ffmpeg 已随包，但还没有用扩展抓过真实的音视频分离任务，
  整条 `bridge-receiver` pipeline 未端到端验证。

### 3. 工程/发布（❌ 未做，发布前必须）

| 项 | 说明 |
|---|---|
| D5 | 删除废弃 HNP 方案（`entry/hnp` 4.9MB + `scripts/build-hnp.sh`） |
| D6 | 评估去掉 `resfile/app/bin/*`（11.6MB，仅本地 repro 兜底） |
| D7 | release 签名（AppCert）+ 签名物料泛化（现在只有 debug 自签） |
| D8 | versionCode / versionName 策略（现在是 `2405` + `00` + 轮次） |
| D9 | **clean install 验证**（卸载重装：权限弹窗 / picker 认领 / db 初始化）—— P0 全程是覆盖安装 |

### 4. 已知限制（有意的取舍）

- FFmpeg 没编 x264 / libmp3lame ⇒ **转码到 H.264、导出 MP3 不可用**；
  `-c copy` 合流、探测、AAC/FLAC/WAV 提取正常。
- FFmpeg `--disable-network` ⇒ 只处理本地文件（合流任务的输入本来就是本地）。
- BT 真实下载未验（本机网络无 BT 出口）。
- 冷启动 ~2.5–3.8s（未优化）。
- HAP 体积 ~188MB（libnode 126MB 未压缩）。

## 三、上架相关的硬约束（已定"暂缓"）

1. **签名**：目前是 debug 自签 + DevEco 自动签名 profile；上架必须 AppGallery release 签名。
2. **三条受限权限**：JIT、`READ_WRITE_USER_FILE`、`CUSTOM_SANDBOX` 都是 ACL 受限权限，
   审核看场景。前两条（IDE/开发调测工具场景）对一个下载器来说**很悬**；
   `CUSTOM_SANDBOX` 官方写"面向华为内部开发工具应用开放"，基本是被拒项。
   **注意**：这三条都是 `acls.allowed-acls`（调试期 ACL），正式发布需要开发者中心正式审批。
3. 申请到的 debug ACL 只在**本机 debug 签名**下有效；换 release 签名要重新申请。

> 若将来真要上架，建议方案：去掉 `CUSTOM_SANDBOX`（CLI/FFmpeg 会退化为不可用）、
> 去掉 `READ_WRITE_USER_FILE`、保留 JIT（若有 V8 需要）——即"功能裁剪版"。
> 或者干脆只做个人/侧载分发。

## 四、构建与验证（给接手对话）

```sh
cd /storage/Users/currentUser/Documents/codes/Motrix/codes/MotrixOHOS
export PATH="/storage/Users/currentUser/.harmonybrew/bin:$PATH"

# 1) 换签名前必须先跑（从 DevEco 同步签名配置；提交前 git checkout -- build-profile.json5）
sh scripts/apply-local-signing.sh

# 2) 出包
sh scripts/build-hap.sh                    # 出 debug 签名 HAP
node scripts/verify-hap.mjs entry/build/default/outputs/default/entry-default-signed.hap

# 3) 只改前端（renderer）时不必全量重编：
cd vendor/motrix
node --require ../../scripts/fakeplat.cjs node_modules/vite/bin/vite.js build --config vite.renderer.web.config.ts
node --require ../../scripts/fakeplat.cjs node_modules/vite/bin/vite.js build --config vite.server.config.ts

# 4) 单元测试（本机跑不了原生 tsc，只能 vitest）
node --require ../../scripts/fakeplat.cjs node_modules/vitest/vitest.mjs run src/server/ipc src/core/cli
```

日志：真机导出用 `sh scripts/gather-logs.sh <输出目录>`（**必须在用户自己的系统终端里跑**，
沙箱内 hdc 连不上设备）。产物在 `logs/`：`arkts-diag.log`、`node-output.log`、
`cli-probe.json`、`spawn-probe.json`、`boot-stage.json`。

## 五、这次踩过的坑（避免重蹈）

| 现象 | 原因 / 处理 |
|---|---|
| 应用不能 exec 用户 `node`/`brew`（EPERM） | 不是权限位问题，是 SELinux 域：`debug_hap` 只认本应用证书签名的 ELF。**`CUSTOM_SANDBOX` 换到 `develop_tools_debug_hap` 域后全通** |
| `~/.harmonybrew/bin/*` 读不到（EACCES） | 沙箱不允许跟随 symlink；换域后可读，或改走真实路径（`Cellar/**`、`Homebrew/bin/**`） |
| ffmpeg `configure` 全挂 | configure 要运行它刚编出的探测程序，而鸿蒙拒绝未签名 ELF ⇒ 用 `scripts/build-ffmpeg.sh` 里的 cc 包装器（剥 `.codesign` + 自签） |
| 随包二进制装不上（9568393） | `libs/` 下的可执行文件**必须带扩展名**（`ffmpeg.bin`），并在 `module.json5.executableBinaryPaths` 声明 |
| 改了 `src/core/cli` 后 server 打包报错 | 架构边界：`src/server/` 不得 import `src/main/`；CLI 服务已在 `src/core/cli/`，`node scripts/check-boundaries.mjs` 可自检 |
| 扩展配对无 PIN（历史） | `operatorDelivery='local'` ⇒ server 丢弃配对事件；靠 `MOTRIX_PUBLIC_URL` + `ALLOW_INSECURE_OPERATOR_HTTP=1` 走 web 投递 |
| 桥端口被 aria2 抢占（历史） | 桥候选端口不要和 aria2 的 rpc 端口段重叠（现在用 17891–17896） |

## 六、给 bug 修复对话的优先顺序建议

1. **clean install 回归**（D9）——覆盖安装掩盖了很多首装问题（权限弹窗、picker、db 初始化）；
2. **插件系统实测**（C6）——JIT 已开，可能白捡一个功能；
3. **HLS/DASH 端到端**（A18）——ffmpeg 刚到位，最可能暴露参数问题；
4. **逐项点验清单**（第二节 1）；
5. 工程清理 D5/D6（纯代码卫生，风险低）。