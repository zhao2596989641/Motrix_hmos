# 变更记录（按轮次）

> 本项目按「一轮一包」迭代：每轮出 debug HAP、真机验证、记录问题与修法。
> 完整逐项状态见 `docs/FEATURE-MATRIX.md`；构建见 `docs/BUILD.md`。

## r46 · HAP 减 11.5MB + 启动阶段细分 + Dock 进度重试（2026-11-26）

打包与诊断，不改变下载/引擎行为。

- **HAP 减体积（-11.5MB）**：`resfile/app/bin/{aria2c,motrix-finalize-fs}` 不再随包
  （端侧执行的是 `entry/libs/arm64-v8a/*.bin`，`resfile` 那份纯重复）；
  `build-hap.sh` 第 4 步改为签 `build/bin` 的源文件，`spawn-probe` 不再为不存在的
  resfile 副本记一条无意义 ENOENT。需要旧布局时 `MOTRIX_RESFILE_BIN=1`。
- **启动阶段细分**：宿主在 `boot-stage.json` 的 `stages[]` 里新增
  `server_imported` / `server_healthy` / `operator_token` / `session_cookie` /
  `platform_restore`，下一轮冷启动优化直接看哪一步吃掉时间。
- **Dock 进度条重试**：`TaskbarProgress` 原来先更新 `lastKey` 再推送，导致
  `1020210010`（启动早期快捷栏图标还没出现）这类瞬时失败后进度条**再也不刷新**；
  改为推送成功才记 `lastKey`，失败下一 tick 重试，连续 5 次才放弃。
- 恢复 `scripts/gather-logs.sh`（r44 回档时被删）：用户在自己终端一条命令拉全部诊断文件。
- 关于页徽章：`HarmonyOS Port r46`

## r45 · 引擎状态单例 store（修"切页回仪表板卡在引擎启动中"）（2026-11-26）

只动渲染层的状态读取方式，**不动**服务端、不新增任何"快速重试"。

- `useEngineDisplayStatus` 从"每个挂载实例各自读"改为**模块级单例 store**
  （`src/renderer/hooks/use-engine-display-status.ts`）：
  - 全局一份快照：切页/重挂载立刻拿到上次确认过的状态，**不再从 `starting` 起步闪一下；
    曾经确认过 `ready` 的，即使后续读失败也保持 `ready`**（这是原来卡住的直接原因：
    首个读超时 + 引擎状态没有变化 ⇒ 事件流不再推送 ⇒ 一直停在启动中）
  - 全局最多 **1 条在飞读请求**（coalescer + trailing），修掉"一次挂载 4 个窗口面
    × 2 条读 = 8 条并发"把 ArkWeb 6 条连接池压满的问题
  - 失败退避 5s→10s→20s→30s（带抖动）；**从未确认过引擎时 5s 兜底**，保证冷启动自愈；
    ※ 明确禁止毫秒级快速重试（r43 事故的根因）
  - 事件流 `EngineStateChanged` 仍是主通道（即时、权威），轮询降级为兜底：
    连接正常时 60s，断线 10s；`GetSettings` 只在首次/设置变更时读
  - 会话锁定/epoch 变更会清空快照并使旧响应失效（`sessionGeneration`），
    引擎事件只失效引擎读（`engineGeneration`），不会误伤在飞的设置读
- `http-ws.ts` 增加**只读网络诊断**（仅鸿蒙壳、每类最多 12 行）：
  - `[motrix] query burst: N reads in flight before <channel>`（发起时已有 ≥5 条在飞）
  - `[motrix] slow query <channel> <ms>`（单条读 ≥3s）
  - 目的：下一轮真机日志直接判定"连接池饱和"与"哪条查询慢"，不再靠猜
- 单元测试：`use-engine-display-status.test.tsx` 8 项全部通过（改了 2 项断言，
  新增 1 项"读失败不回退已确认状态"）；相关 dashboard/downloads 70 项测试全通过
- 关于页徽章：`HarmonyOS Port r45`

## r44 · 回到 r38 基线上的 A+C 小批（2026-11-26 15:05）

在 r38 的稳定基线上，只加"不改任何网络/状态行为"的改动：

- **A（零行为风险）**
  - 关于页：`HarmonyOS Port r44` 徽章 + 开机自启提示（鸿蒙只给查询、不给设置）
  - `boot-stage.json` 记录完整启动阶段时间线（`stages[]` + 每步 deltaMs）
  - 仓库：签名物料从 `build-profile.json5` 移除（改占位符），本机真实物料放
    `build-profile.local.json5`（gitignore），构建前跑 `scripts/apply-local-signing.sh`
  - 仓库历史清理：移除误提交的 `.bitfun/`（IDE 缓存，7.9MB）与历史里的签名物料串
- **C（入口）**：只隐藏「完成后关机」入口；插件 / 集成卡片 / 应用内更新**保持可见**（r38 原样）
- **不动**：状态查询/重试、HAP 体积、仪表板逻辑 —— 这些等后续单独小批再上

> 上一版 r43 的"无法连接服务器"教训：任何"失败快速重试"都必须先限制并发，
> 否则会把 ArkWeb 对同一 host 的 6 条连接池塞满，连带 event-ticket 一起死。

## 回档：源码回到 r38（2026-11-26 14:35）

r39~r43 的改动（入口收敛 / HAP 减体积 / 关于页徽章与自启提示 / 仪表板状态缓存）**全部回退到 r38 快照**，
原因：真机上出现"前端无法连接服务器"，排查日志（node-output.log 948 次 `NetworkTransactionTimeout`、
arkts-diag `signal timed out`）指向 **系统代理/梯子劫持了 127.0.0.1**，
与这些改动无直接关系，但为保证可用先回退到已验证版本。

保留（非功能性）：
- `scripts/sign-elf-appcert.mjs` 的 `.profile` strip 修复（否则重复构建会签名失败）
- `docs/RELEASE.md`、`docs/TESTING.md` 等文档
- 仓库本身

回退后验证：重新构建的 renderer 产物 hash 与 r38 HAP 内完全一致
（`app-root-nnoPDFU1.js` / `index-X2IvZFmr.js`），versionCode 回到 1000000。

**环境注意事项（重要）**：鸿蒙上任何"系统代理/TUN 未排除 127.0.0.1"的状态都会让 ArkWeb → 本地 server
的请求超时，表现为"前端无法连接服务器"或数据不刷新。测试前请把 `127.0.0.1/32`、`::1`、`localhost`
加进代理例外，或关闭梯子。

## r43 · 入口恢复显示 + 仪表板"引擎启动中"卡住修复

- **入口恢复**：插件 / 集成卡片 / 应用内更新重新显示（仅保留「完成后关机」隐藏）——
  维护者要再尝试适配这些能力，先不藏
- **修复"切页回仪表板显示引擎启动中、页头按钮消失"**：
  - `useEngineDisplayStatus` 增加**模块级最后一次状态缓存**：dashboard 重挂载立刻显示上次 known-good 状态，
    不再从默认 `starting` 起步
  - 查询失败时 **1.5 秒快速重试**（最多 2 次告警），不再等 30 秒轮询
  - 失败打 `[motrix] engine status read failed` 到 web-console（arkts-diag 可见）
  - dashboard 挂载打印 `[motrix] dashboard mounted`，便于下次日志定位

## r42 · 关于页"开机自启"提示 + 日志收集脚本

- 关于页在 HarmonyOS 下多一行提示：**「开机自启：HarmonyOS 不允许三方应用自行设置，请在设置→应用启动管理里允许 Motrix」**
  （鸿蒙只给 `autoStartupManager` 查询能力，见 `docs/RUNTIME.md`；之前用户无处得知）
- 新增 `scripts/gather-logs.sh`：在用户系统终端一条命令把 6 个诊断文件拉到本地 `logs/`
- 文案走 i18n（en-US / zh-CN），其它语言 fallback 英文

## r41 · 关于页"移植轮次"徽章 + 启动时间线

- 关于页版本号旁新增 **`HarmonyOS Port rNN`**（当前轮次为 r42） 徽章：原生壳注入 `__MOTRIX_PLATFORM__.portVersion`，
  用户一眼能确认装的是哪一版移植（也方便排查"装的是不是最新包"）
- `boot-stage.json` 从"只记最后一步"改为记录**完整阶段时间线**（`stages[]`，含每步相对启动的 deltaMs），
  冷启动优化时可以直接看每一步耗时
- 新增 `docs/RELEASE.md`（发布/装机/合规清单）与 `docs/TESTING.md`（真机测试方法）

## r39 / r40 · 入口收敛 + 体积与启动优化

**入口收敛**（把「平台能力不可用」的入口收起来，而不是让用户点进去看到"不可用"）：

- 侧边栏隐藏「插件」入口（`--jitless` 下无 WebAssembly，QuickJS 不可用）
- 设置页隐藏「集成」卡片（浏览器扩展 / CLI / AppImage / 媒体工具 / 系统协议端侧都不可用；
  协议关联由原生 skills + 自定义 UTD 实现，不需要用户设置）
- 下载页统计栏隐藏「完成后关机」菜单（Electron 主进程专属）
- 关于页隐藏应用内更新（含自动更新开关）
- 判定方式：`isHarmonyShell()`（原生壳会注入 `window.__MOTRIX_PLATFORM__`）
- 重新构建了 `vendor/motrix/dist/renderer-web`（只有渲染层改动，服务端未动）

**体积与启动**：

- **HAP 203.5MB → 192.0MB（-11.5MB）**：不再把 `aria2c` / `motrix-finalize-fs` 塞进
  `resfile/app/bin` 重复存放；端侧执行副本仍在 `entry/libs/arm64-v8a/*.bin`（libs 优先解析）
- 启动诊断探针（4~5 次 `spawnSync`）从启动链路改为 ready 之后延迟 8 秒执行，少占用首屏时间
- `versionCode` 改为「1000000 + 轮次号」（r39 ⇒ 1000039）
- 修复重复构建时 `.profile section already exists` 的签名失败（先 strip 旧签名段再签）
- 删除废弃 HNP 方案目录与脚本

## r38 · 托盘面板：固定排序 / 顶部标题行移除

- 任务列表改为按 `createdAt` 倒序固定排序（新任务在上，暂停/继续/完成都不换位）
- 面板去掉顶部「Motrix + 就绪」行，引擎状态移到底部「打开 Motrix」右侧
- 系统托盘标题 / 悬停提示：「Motrix 下载器」→「Motrix」

## r37 · 托盘面板：三行任务行 + 实时性修复

- **修复面板数据不刷新**：ArkUI `@Builder` 参数按值传递，速度/计数等变化值改为内联渲染；
  `ForEach` key 补全所有显示字段（否则速度变化但百分比不变时行不重建）
- 任务行改为三行：文件名 / 进度条 / 进度文案
- 动作按钮改用官方 `Button(Circle)`（`padding(0)` 修图标偏移）；图标统一主文字色
- 已完成/出错任务提供「圆环箭头 = 重新下载」（`retryTasks`）

## r36 · 托盘面板：按钮与百分比修正

- 修正百分比显示：上游 `task.progress` 是 0~1 比例，宿主统一换算为 0~100 并保留 1 位小数
- 按钮与文案间距、圆钮尺寸、进度条状态色（进行中/暂停/完成/出错）
- 重试命令链路（面板 → 文件队列 → 宿主 RPC）

## r35 · 深链与文件关联 + 面板视觉修正

- 注册 `magnet:` scheme；自定义 UTD `com.lyldeer.motrix.torrent` + `linkFeature: FileOpen`
  让 `.torrent` 出现在「打开方式」
- `EntryAbility.handleDeepLink`（冷启动 onCreate / 热启动 onNewWant）→ 深链命令队列 →
  宿主 `addMagnetTask` / `addTorrentTask`（种子文件转 base64，导入副本用完即删）
- 托盘面板卡片改由带左右 padding 的容器承载（修复 `width(100%) + margin` 溢出导致的"贴边"）
- 面板配色按 Clash 鸿蒙版数值重写（玻璃模式：面板全透明、卡片白/黑 10%；含透明失败实色兜底）

## r32 · 托盘常驻 + 左键面板 v1 + Dock 进度条 + 孤儿清理

- 关窗 = 收进托盘：`windowStageClose` 拦截 → `hideAbility()`（前置：`BackGroundAbility` 挂靠状态栏）
- 托盘左键弹 `StatusBarViewExtensionAbility` ArkUI 面板；右键菜单「打开 / 下载任务 / 通知 / 设置」
- Dock 图标进度条：`quickBarManager`（`SET_ABILITY_INSTANCE_INFO` 权限，2 秒节流，四态）
- 启动时扫 `/proc` 清理上次残留的 `aria2c.bin` / `motrix-finalize-fs.bin`
- 数据交换用文件桥：`tray-state.json`（宿主每秒写）+ `tray-cmd.jsonl`（面板写、宿主执行）

## r18 ~ r31 · 体验与稳定性打磨（bug 修复线）

- 启动链路：卡在载入界面 → 页面看门狗 + 启动阶段诊断 + boot guard
- 窗口：沉浸式标题栏（隐藏系统 decor、三键下移、深色三键）、自绘拖拽条（最大化禁用）、
  窗口尺寸/位置记忆、三键避让（页头按钮 + Toast 下移，只影响页头不缩整页）
- 输入与主题：英文闪帧（注入脚本语言/主题值 + 启动遮罩）、跟随系统深浅色、中英双语
- 通知：系统通知桥（文件队列 → `notificationManager`，服务信息分类带横幅/提示音）
- 引擎：重启卡死（probe 结果缓存 + 阶段打点 + 30s 看门狗 + RPC 端口顺延）
- 拖拽/点击：拖拽条 `pointer-events:none` + document 捕获阶段判断（否则标题栏按钮收不到 mousedown）
- 关键教训：ArkTS 注入脚本里**不能出现反引号**（会提前终止模板字符串，整段注入脚本 SyntaxError）

## r1 ~ r17 · 从零到真机可用（P0）

- 路线选型：Motrix server 模式 + 端侧 Node + ArkWeb 同源加载（不走 Electron-on-OHOS）
- 硬事实验证：HAP 内 ELF 执行靠**代码签名**而非权限位；`.node` 同样需要签名；
  `spawn` 在应用沙箱可用；`--jitless` 下 WebAssembly 不可用
- 关键卡点与解法：
  - 安装失败 `9568393`：`libs/` 下可执行文件**必须带扩展名**（`aria2c.bin`），
    否则 `hap-sign-tool` 的 `IsNativeFile` 会跳过，导致签名条目数量不一致
  - `better-sqlite3` 运行期 `.node` dlopen 被拦 → 交叉编译成 `libbetter_sqlite3.so` 随 HAP 提供 + 运行期模块重定向
  - undici 的 llhttp WASM 在 `--jitless` 下炸 → 用纯 JS fetch 垫片接管
- P0 验收通过：HTTP 下载（MD5 一致）、暂停/续传/删除、设置与任务持久化、
  后台下载、通知、中英文与暗色、引擎就绪

---

## 尚未完成 / 后续计划

1. **入口收敛**：插件页、媒体工具、系统协议、检查更新、完成后关机等平台不可用入口，按鸿蒙隐藏或标注
2. **待真机点验**：限速档位、任务详情、批量操作、创建种子、Tracker 同步、代理设置等
3. **发布工程**：clean install 验证、release 签名、`versionCode` 策略、HAP 体积、冷启动优化、上游补丁管理