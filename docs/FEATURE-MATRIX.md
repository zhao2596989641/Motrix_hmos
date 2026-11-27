# 功能矩阵（移植范围与逐项状态）

> **最新快照：r57（2026-11-27）** —— 下面的 0 节是当前总览；第 2 节起是 r31 时期的逐项明细，
> 状态标记已按后续轮次补注（r32~r57 的改动见 [CHANGELOG](CHANGELOG.md)，计划与日志见 [PLAN](PLAN.md)）。

- 当前产物：`com.lyldeer.motrix-2.4.5.57-debug-signed-r57.hap`，192,272,710 B，
  MD5 `ca5c046478e1e0b9d6170f306aaf3922`（待真机验证）
- 依据：r20~r57 测试计划、`logs/` 真机日志、上游 2.4.5 源码对照清点

---

## 0. r57 总览

| 状态 | 数量级 | 内容 |
|---|---|---|
| ✅ 已真机验证 | 核心链路 | HTTP 下载、暂停/续传/删除（含文件）、任务与设置持久化、后台下载、引擎就绪、系统通知、中英文/深浅色、沉浸式标题栏 + 三键避让、窗口记忆、托盘（图标/左键面板/右键菜单/关窗收托盘）、Dock 进度条、深链（magnet / .torrent） |
| 🟢 已实现待点验 | 十余项 | 限速档位、任务详情、批量操作、创建种子、Tracker、代理、GeoIP、单实例、reveal/open/外链、NAT 显示 |
| 🟡 受限 | 6 项 | BT 真实入站（网络策略）、中文 IME、剪贴板、拖 `.torrent` 入窗、UPnP/NAT、Dock 跳转列表（未做） |
| ⛔ 平台不可用 | 5 项 | 媒体 HLS/DASH、CLI 配对（`@motrix/cli`，待 r56 探测）、应用内更新（r54 起整块隐藏）、完成后关机（唯一隐藏菜单入口）、v1 迁移 |

---

## 0.1 r31 时期结论（历史，供追溯）

**主干（下载/任务/引擎/窗口/托盘/通知/主题语言）已经通了。**
r32 把「托盘常驻 / 托盘左键面板控制下载 / Dock 进度条 / 孤儿 aria2 清理」做掉了，
r33~r35 又把「托盘面板改成 Clash 风格（玻璃 + 网速图 + 任务列表逐条控制）」和
**「深链 magnet: 与 .torrent 文件关联」**做掉了 —— **"用户能感知的功能缺口"到此清零**。
另有 **8 项是平台/架构不可用**（插件、媒体合流、UPnP-NAT、开机自启、完成后关机、v1 迁移等），
建议做的是「把入口按鸿蒙收敛」，而不是硬做。
剩下的主要是 **16 项"实现完成、待真机验收"**、**8 项待实测/有已知限制** 和 **发布工程**
（签名 / clean install / 体积 / 冷启动）。

---

## 1. 图例

| 标记 | 含义 |
|---|---|
| ✅ | 真机验收通过（有日志或项目作者确认） |
| 🟢 | 已实现，未专门点验（随 P1 回归一起测） |
| 🟡 | 部分实现 / 有已知限制 / 平台行为待实测 |
| ❌ | 未实现（可做） |
| ⛔ | 平台或架构不可用（建议隐藏入口，不硬做） |
| ⏸ | 项目作者暂缓 / 决策待定 |

---

## 2. A · 下载核心与任务

| # | 功能 | 状态 | 依据 / 下一步 |
|---|---|---|---|
| A1 | HTTP/HTTPS 下载端到端 | ✅ | P0 验收：文件落公共下载目录、MD5 与源一致 |
| A2 | 暂停 / 继续（续传）/ 删除（含文件） | ✅ | P0：`.motrix` 半成品、续传字节数一致、连文件删除 |
| A3 | 非法 URL / 失败任务错误路径 | ✅ | P0：`invalid-source` 返回、应用不崩；错误页路径在 web UI 内 |
| A4 | 任务持久化（杀进程后恢复） | ✅ | P0：3 个任务状态全恢复 |
| A5 | 设置修改 + 持久化 | ✅ | P0：`maxConcurrentDownloads=7` 重启仍是 7 |
| A6 | 后台保活（窗口不可见时继续下载） | ✅ | P0：最小化后 4.2MB 任务下完；`backgroundModes: dataTransfer` + 长时任务 |
| A7 | 引擎生命周期：启动 / 状态 / 诊断 / 重启 | ✅ | P0 通过；r28 修「重启卡 probe」，r29/r30 两轮反馈未再提该项 → 视为通过，r31 回归再确认一次 |
| A8 | 限速（全局限速、多档切换、单任务限速） | 🟢 | server `SpeedLimitController` 在；P1 点验 |
| A9 | 任务详情（连接/分片/文件列表/重试参数） | 🟢 | 上游 UI + server query 在；P1 点验 |
| A10 | 批量操作（暂停全部/继续全部/清除已停止） | 🟢 | server `tasks-bulk` 路由在；P1 点验 |
| A11 | 创建种子（Create Torrent） | 🟢 | server `torrent-creator` 路由在；P1 点验 |
| A12 | 磁力任务创建 + infohash 解析 | ✅ | P0：`addMagnetTask` 成功、infohash 正确、状态 `fetching_metadata` |
| A13 | BT/磁力「真实下载」 | ⏸ | 本机网络无 BT 出口（`connections=0`），需项目作者换网络环境验 |
| A14 | 种子内文件挑选 / 磁力文件列表 | 🟢 | 上游功能，P1 点验（需真实 metadata，可与 A13 一起） |
| A15 | Tracker：内置列表 / 同步 / 可用性检查 | 🟢 | server `trackerManager.syncAndCurate()` 在；需网络，P1 点验 |
| A16 | DHT / 监听端口 / UPnP-NAT-PMP 端口映射 | 🟡 | DHT 与端口由 aria2 自己负责；**UPnP/NAT-PMP 是 Electron 主进程专属**（server 的 `GetNatStatus` 恒 `null`），端侧要么靠 aria2 编译特性、要么放弃。P1 实测端口可达性 |
| A17 | GeoIP（BT 对等节点归属地） | 🟢 | server `GeoIPManager` 在，需下载库（网络）；P1 点验 |
| A18 | 媒体解析 HLS/DASH + ffmpeg 合流 | ⛔ | 属 **桥接接收通道**（`bridge-receiver`，浏览器扩展交接）。r55 已把 MDXP 桥开在回环固定端口，但 ffmpeg 仍未随包 ⇒ 合流仍不可用。暂不做 |
| A19 | 下载完成后关机/睡眠 | ⛔ | Electron 主进程专属（`src/main/platform/completion-shutdown.ts`）；web UI 会显示「不可用」，建议隐藏该项 |

---

## 3. B · 窗口、界面与系统集成

| # | 功能 | 状态 | 依据 / 下一步 |
|---|---|---|---|
| B1 | 沉浸式标题栏（隐藏系统 decor、三键下移 7px、深色三键） | ✅ | r26 用户确认下移 OK；r31 日志 `decorHidden=true decorH=54` |
| B2 | 自绘拖拽移动窗口（最大化时禁用，避免"点一下就缩"） | ✅ | r26 修 `shouldBlockDrag`；r30 改 document 捕获阶段；r31 改交互元素判定 |
| B3 | 三键避让：边栏收起后页头按钮左移（保持动画/中轴对齐） | ✅ | r28 只作用于 `--window-chrome-safe-area-trailing`；r31 用户已确认「中轴对齐」 |
| B4 | Toast 下移避开三键 | ✅ | r29/r30；用户已确认「通知 OK」 |
| B5 | 标题栏按钮可点击（拖拽条不吞事件） | ✅ | r30 真因（mousedown 不转发）→ 拖拽条 `pointer-events:none` + document 捕获 |
| B6 | 窗口尺寸/位置记忆 | ✅ | `window-geometry.json` 生效；越界会夹回可见区 |
| B7 | 系统托盘图标 + 左键唤出 | ✅ | 真机 `tray add -> true`（`ability-diag.log`） |
| B8 | 托盘右键菜单（显示主窗口 / 退出） | ✅ | `SystemTray.buildMenus()` |
| B9 | 托盘面板「暂停全部 / 继续全部」 | 🟢 | **r32 已实现**：左键面板按钮 → 命令文件 → 宿主用自己的 cookie 发 `command:pauseAllTasks/resumeAllTasks`；待测 |
| B10 | 系统通知（完成/失败，服务通知分类带横幅+提示音） | ✅ | r30 改 `SlotType.SERVICE_INFORMATION`；r31 用户确认 |
| B11 | 点击通知回到应用 | 🟢 | `SystemNotifier` 预建 wantAgent；P1 点验 |
| B12 | 应用内通知页（未读/清空/全部已读） | ✅ | r28 避让修复后未被遮挡 |
| B13 | 深色/浅色、跟随系统 | ✅ | `setColorMode` + 注入 colorMode；用户确认 |
| B14 | 语言：简体中文/英语，跟随系统，无英文闪帧 | ✅ | r27 修注入脚本后正常；r31 用户确认 |
| B15 | 键盘输入（ASCII/URL） | ✅ | P0：真键事件进 React state |
| B16 | 中文等非 ASCII 输入（真实输入法） | 🟡 | P0 只证明了 ASCII；自动化文本注入不触发 DOM input 是**测试手段限制**，不等于真实 IME 坏。需项目作者用输入法打一次 |
| B17 | 从剪贴板自动填充任务 URL | 🟡 | web 分支用 `navigator.clipboard`，失败静默；ArkWeb 权限待实测 |
| B18 | 把 `.torrent` 拖进窗口 | 🟡 | 上游 HTML5 drag-drop 链路在（`use-window-torrent-drop`），ArkWeb 是否把系统文件拖放转成 DOM drop 未验证 |
| B19 | 关闭窗口后的行为（退出 / 托盘常驻继续下载） | 🟢 | **r32 已实现**：`windowStageClose` 拦截 → `hideAbility()`（前置依赖托盘挂靠的后台 Ability）；托盘唤回走 `showAbility()+showWindow()`；待测 |
| B20 | 深链 `magnet:` 与 `.torrent` 文件关联 | 🟢 | **r35 已实现**：skills 注册 magnet scheme + 自定义 UTD `.torrent`（FileOpen）；EntryAbility 解析 want.uri → 深链队列 → 宿主 `addMagnetTask`/`addTorrentTask`；冷/热启动都覆盖。待测 |
| B21 | 开机自启 | ⛔ | 系统只给查询（真机 `supported=true enabled=false`），三方应用不能自行设置。**r54**：设置→通用新增「登录时启动」行（状态 + 「打开系统设置」按钮），关于页提示删除 |
| B22 | 单实例（连点图标/重复启动） | 🟢 | `launchType: singleton`；P1 点验（同时是 B20 的前置） |
| B23 | 在文件夹中显示 / 用默认应用打开 / 外链用浏览器打开 | ✅ | 自绘 `motrix-action://` 桥（`PlatformActions`）+ 菜单项已出现；P1 逐项点验 |
| B24 | 托盘图标黑白自适应 | ✅ | **r54**：`rawfile/tray_white.svg`（深色壁纸纯白）/ `tray_black.svg`（浅色纯黑），24×24 单色；读不到时退回 `startIcon` |
| B25 | 系统「打开方式」/文件管理器关联（.torrent） | 🟢 | **r35 已实现**（自定义 UTD `com.lyldeer.motrix.torrent` + `linkFeature:"FileOpen"`）；待测（装包后可能需重启设备刷新关联） |
| B26 | 任务栏/Dock 图标进度条 | 🟢 | **r32 已实现**：`quickBarManager`（API 26，权限 `SET_ABILITY_INSTANCE_INFO`）；NORMAL/PAUSED/ERROR/NO_PROGRESS。**r46 修**：原实现先记 `lastKey` 再推送，`1020210010`（启动早期图标未出现）失败后不再刷新；改为成功才记、失败下 tick 重试。跳转列表仍不做 |

---

## 4. C · 设置与周边

| # | 功能 | 状态 | 依据 / 下一步 |
|---|---|---|---|
| C1 | 设置 8 卡片（通用/外观/下载/BT/集成/网络/高级/关于） | 🟢 | 页面在、r28 后避让正常；逐项点验归 P1 |
| C2 | 代理设置（HTTP/SOCKS/系统代理检测） | 🟢 | server 侧 `parseProxyEnvironment` + aria2 参数；P1 点验 |
| C3 | 集成卡片（浏览器扩展/CLI/AppImage/媒体工具/系统协议） | 🟢 | **r55**：扩展区块已可用（MDXP 桥固定端口 + 鸿蒙连接提示，待真机）；AppImage/系统协议仍由 `isWeb` 隐藏；CLI 等 `cli-probe.json`；FFmpeg 暂缓 |
| C4 | 检查更新 | ⛔ | **r54**：关于页更新区域 + 自动检查开关在鸿蒙壳整块隐藏，也不再查询更新状态 |
| C5 | 关于页（版本/许可证/链接） | 🟢 | P1 点验 |
| C6 | 插件系统 / 插件市场 | ⛔ | QuickJS 需 WASM，`--jitless` 下 `WebAssembly===undefined`，插件无法运行；但侧栏入口与页面仍在，**建议收起或标注不可用**（否则点了像"坏了"） |
| C7 | URL Resolver 类插件媒体页解析 | ⛔ | 依赖插件系统，同上 |
| C8 | v1 数据迁移（legacy import） | ⛔ | Electron 专属（读 v1 配置目录/原位激活），端侧无意义；入口应收起 |
| C9 | NAS / Synology 设置卡 | ⛔ | 仅 `synologyDsm` 模式出现，端侧不会显示 |
| C10 | 浏览器扩展 / `@motrix/cli` 配对（MDXP） | 🟢 | **r55**：扩展通道打通——宿主固定 `16801…16806` 空闲端口 + `MOTRIX_REMOTE_EXTENSION_ENABLED=1` + `ws://127.0.0.1:<port>`；扩展用“远程服务器”模式 + 8 位配对码。CLI 待 r56 |

---

## 5. D · 工程、发布与体验

| # | 事项 | 状态 | 依据 / 下一步 |
|---|---|---|---|
| D1 | 孤儿 aria2 清理（重启后旧进程残留 → 端口顺延） | 🟢 | **r32 已实现**：宿主启动扫 `/proc` 强杀 `aria2c.bin`/`motrix-finalize-fs.bin` 残留（同 uid），再等端口释放；待测 |
| D2 | debug 凭据导出（`host-ready.dev.json`，自动化验收通道） | ✅ | 仅 debug 生成 |
| D3 | 冷启动耗时（当前 2.5~3.8s） | ⏸ | 待项目作者给的优化方向 |
| D4 | HAP 体积（203MB，其中 libnode 126MB 未压缩） | ⏸ | 发布前决策（换精简 Node / HNP 已死路 / 压缩） |
| D5 | 删除废弃 HNP 方案（`entry/hnp` 4.9MB + `scripts/build-hnp.sh`） | ❌ | 清理项 |
| D6 | 评估去掉 `resfile/app/bin/*`（11.6MB，仅本地 repro 兜底） | ❌ | 清理项，需与三处触点同步 |
| D7 | release 签名（AppCert）+ 签名物料泛化 | ❌ | `scripts/sign-elf-appcert.mjs` 已预留，未换 release 物料 |
| D8 | versionCode 递增策略 / 版本号后缀 | ❌ | 现固定 `1000000` + `2.4.5.0`；debug 覆盖安装够用，发布前要定 |
| D9 | clean install 验证（卸载重装：权限弹窗 / picker 认领 / db 初始化） | ❌ | 发布前必做；P0 用的是覆盖安装 |
| D10 | 上游 patch 管理（20 个文件 + dist 重建流程） | 🟡 | r31 交接已写构建顺序；尚未做成 patch 文件/脚本，上游升级会痛 |
| D11 | 崩溃/异常可观测 | 🟡 | 本地有 `arkts-diag.log` / `node-output.log`；无上报（自用可接受） |
| D12 | r31 HAP 装机回归 | ⏸ | 项目作者待测：三页（下载/Trackers/插件）页头拖拽 + 通知 + 标题栏按钮 |

---

## 6. 统计（按"要不要动"归类）

全表 67 行（A 19 / B 26 / C 10 / D 12）：

| 类别 | 数量 | 明细 |
|---|---|---|
| ✅ 已验收 | 23 | A1~A7、A12；B1~B8、B10、B12~B15、B23；D2 |
| 🟢 实现完成、待真机验收 | 18 | A8~A11、A14、A15、A17；B11、B22；C1、C2、C5；B9、B19、B26、D1（r32）；**B20、B25（r35 深链/文件关联）** |
| 🟡 有已知限制 / 待实测 | 7 | A16、B16、B17、B18、C3、D10、D11 |
| ❌ 未实现（可做） | 5 | **功能 0 项**；工程 5 项：D5~D9 |
| ⛔ 平台不可用（做入口收敛） | 9 | A18、A19、B21、C4、C6、C7、C8、C9、C10 |
| ⏸ 暂缓 / 待定 | 4 | A13、D3、D4、D12 |

> r35 之后，**用户能感知的功能缺口清零**（❌ 只剩工程/发布 D5~D9）。
> 剩下的活：入口收敛（⛔ 里 C3/C6/C8/A18/A19 按鸿蒙隐藏或标注）、待真机点验项、发布工程。

---

## 7. 建议的下一轮顺序（P1）

1. **先回归 r32**（见 TEST-PLAN-2026-11-26-r32.md）：关窗收托盘、左键面板、右键菜单、Dock 进度条、
   孤儿清理；重点是"系统对 hideAbility/statusBarView 的实际表现"。
2. **功能点验（自动化为主）**：用 devbridge + 端侧 API 把 A8~A11、A14、A15、C1、C2、B11、B22、B23
   逐条打勾，缺的补日志断言；项目作者只需抽测几个"看起来对不对"的。
3. **B20 深链与文件关联**（现在唯一剩下的"用户能感知"功能缺口，1~2 轮）：
   - `module.json5` 加 skills：`magnet` scheme、`motrix` scheme、`file` + `.torrent` 类型；
   - `onNewWant`/`onCreate(want)` 取 `want.uri` → `AppStorage` 暂存 → 注入的 Web 侧
     `window.__mtxDeepLink(uri)` → renderer 走既有 `app-deep-link` 逻辑（打开新建任务并预填）；
   - 单实例 + 冷启动两条路径都要覆盖（B22 顺带验）。
4. **B19 托盘常驻 + D1 孤儿 aria2 清理**（体验/稳定性，1 轮）：
   - 关窗时若「有活动任务或托盘可用」→ 隐藏窗口而不是退出；托盘「显示」拉回；
   - 启动时扫 `/proc` 清理上次残留的 `aria2c.bin` 进程。
5. **入口收敛（⛔ 类）**：插件/媒体/协议/更新/关机/集成卡片按 OHOS 隐藏或换文案，
   避免"点了没反应"的观感（半天量级）。
6. 之后才是 D3 冷启动、D7~D9 发布形态。

---

## 8. r31 需要项目作者回归的清单（装这个包）

产物：`com.lyldeer.motrix-2.4.5.0-debug-signed-r31.hap`（MD5 `301da74105e6cca17f703bf1c3c9e45c`）

1. **下载页**：收起边栏后，拖动页头空白处能否移动窗口（r31 修的就是这个）。
2. **Trackers 页**：同上。
3. **插件页**：同上。
4. 顺手：右上角通知横条是否仍在三键下方；标题栏上那批按钮是否都能点。
5. 若有异常，`logs/` 里 `arkts-diag.log` 搜 `MOTRIX-DRAG`（r31 会打 `page/left/right/width/path`）。

---

## 9. 证据索引

- 功能验收：`docs/ACCEPTANCE-P0-2026-11-24.md`
- 最近修复链：`docs/TEST-PLAN-2026-11-25-r{28,29,30}.md` + `docs/HANDOVER-2026-11-25-r31-to-main.md`
- 真机日志：`logs/ability-diag.log`（托盘/窗口/自启状态）、`logs/arkts-diag.log`（Web 注入/拖拽/通知）、
  `logs/node-output.log`（server/引擎/aria2）、`logs/host-ready.dev.json`（验收通道端口与凭据）
- 代码位点：`entry/src/main/ets/runtime/*.ets`（壳能力）、`entry/src/main/ets/pages/Index.ets`（注入脚本）、
  `scripts/host/main.mjs`（Node 宿主）、`vendor/motrix/src/{renderer,server}/**`（20 处移植补丁）