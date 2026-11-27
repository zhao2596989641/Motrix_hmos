# 变更记录（按轮次）

> 本项目按「一轮一包」迭代：每轮出 debug HAP、真机验证、记录问题与修法。
> 完整逐项状态见 `docs/FEATURE-MATRIX.md`；构建见 `docs/BUILD.md`。

## r56 · 开屏三段跳 / 扩展桥端口 / 托盘面板减高（2026-11-27）

> r55 真机反馈三件事：开屏先大 logo 再小 logo 再 m·o 字标；集成卡片显示"扩展通道还没启动"；
> 托盘左键面板的下载任务卡太高（没任务时也占一大块）。

- **开屏**：系统启动页改用增强启动页（`startWindow` profile + 整窗背景图），与 ArkUI 遮罩
  共用 `splash_background.png`（1200×800，logo 已合成，浅/深两套）⇒ ①→② 无跳变；
  遮罩撤除从 `onPageEnd` 推迟到"React 真正挂载"（轮询 `html.mtx-booting`，12s 兜底），
  并在鸿蒙壳隐藏网页自带的 `#renderer-boot` 字标。图片由 `scripts/make-splash-assets.mjs` 生成。
- **扩展桥**：r55 用 16801..16806 选端口，真机上 16801 被占后选中 16802，随后 aria2 引擎
  也顺延到 16802 ⇒ `EADDRINUSE`，整个 MDXP 桥启动失败。r56 候选改为 `17891..17896`，
  避开 aria2 RPC 的 16800+20 顺延段。
- **托盘面板**：`PANEL_HEIGHT` 880 → 740，下载任务列表约缩到原来的 2/3。
- **CLI 探测**：失败原因写进 `node-output.log`，`gather-logs.sh` 增加 `cli-probe.json`；
  并补了 `zsh`/带 brew 环境变量的 spawn 探测（对齐 BitFun 的调用方式）。
- 版本 `2.4.5.56` / `240500056`；徽章 `HarmonyOS Port r56`。

## r55 · 浏览器扩展通道打通 + CLI 环境探测（2026-11-27）

> 维护者确认华为浏览器 / 海泰浏览器都能装 Chromium 扩展；本轮把端侧的扩展通道真正打开，
> 同时把“能不能像 BitFun 那样调用户的 brew/npm”做成一份只读探测报告（cli-probe.json）。

- **扩展通道**：宿主不再把 `MOTRIX_MDXP_PORT` 置 0，而是抢 `16801…16806` 里的空闲端口，
  同时设 `MOTRIX_MDXP_HOST=127.0.0.1`、`MOTRIX_REMOTE_EXTENSION_ENABLED=1`、
  `MOTRIX_REMOTE_EXTENSION_PUBLIC_URL=ws://127.0.0.1:<port>`；服务端据此打开远程扩展面，
  集成卡片从“扩展配对不可用”变成可用的扩展管理界面。
- **鸿蒙连接提示**：新增 `HarmonyExtensionHint`，显示实际连接地址 `ws://127.0.0.1:<port>`
  与三步配对说明（装 Chromium 版扩展 → 添加远程服务器 → 输入 8 位配对码），并提醒
  开发者模式加载的扩展要先在「可信扩展」里加 ID。
- **CLI 探测**：宿主 ready 后 20s 写 `cli-probe.json`（brew/npm 目录可见性 + spawn 结果），
  为 r56 的命令行工具集成提供真机依据（BitFun 的做法是直接 spawn harmonybrew 的 brew/node）。
- 版本 `2.4.5.55` / `240500055`；徽章 `HarmonyOS Port r55`。

## r54 · 界面细节收尾：隐藏更新 / 徽章对齐 / 单色托盘 / 开屏 logo / 自启跳转（2026-11-26）

> 收敛阶段的一轮「观感与入口」小改，不动下载逻辑。

- **关于页隐藏更新**：鸿蒙壳里「检查更新」区域与「自动检查更新」开关整块不渲染，
  也不再向 server 查询更新状态（上游 web 形态点它会 500，白跑 RPC）。
- **徽章对齐**：`HarmonyOS Port rNN` 与 `2.4.5` 原来按文字基线排，药丸看起来偏下；
  改为同一行内 `items-center` 居中对齐。
- **托盘单色图标**：按华为 `StatusBarIcon` 规范改为 `rawfile/tray_white.svg`（纯白）/
  `tray_black.svg`（纯黑）24vp×24vp 自适应填充；读不到时退回彩色 startIcon 兜底。
- **开屏只留 logo**（Clash 风格）：删掉转圈与「正在启动内核 / 等待引擎 / 载入界面」文案，
  居中 112vp 图标；错误页保持原样。
- **开机自启改成跳转按钮**：上游确实有开关，但鸿蒙只给查询、不给设置 ⇒
  关于页提示删除，设置 → 通用新增「登录时启动」行：状态（已开启/未开启/设备不支持）+
  「打开系统设置」按钮（`motrix-action://autostart`，壳按 应用详情页 → 应用与元服务 → 设置首页 依次降级）。
- 版本 `2.4.5.54` / `240500054`；徽章 `HarmonyOS Port r54`。

## r53 · 插件"需要处理"红标自愈 + 日志时间改本地时区（2026-11-26）

> 真机反馈两件事：①Smart Link 插件页一直挂"需要处理 / 2 个错误"，清日志没用；
> ②插件日志与 arkts 诊断日志的时间比本地早 8 小时。两者都是上游行为，本轮修掉。

- **红标根因**：插件错误计数存在 `plugin_state` 表，上游只有 `recordError`、**没有任何
  `clearError` 调用方** ⇒ `errorCount` 只增不减；那 2 个错误来自 r50 的
  `plugin.hook.concurrent_protocol_violation`（hook 10s 超时后迟到的 exit 被丢弃的协议噪声）。
  · r53：该 code 不再计入插件错误（只记 warn 日志）；
  · r53：插件**激活成功时清零历史错误**（自愈）——升级后重启一次，红标即消失。
- **时间显示**：上游插件日志用 `toISOString()`（UTC）显示（`plugin-log-row.formatTs`），
  ArkTS 侧 `arkts-diag.log` / `ability-diag.log` 也用了 `toISOString().slice(11,23)`，
  于是北京时间比本地早 8 小时（时间戳 epoch 本身是对的，只是显示格式）。
  · r53：插件日志行、ArkTS 两处诊断日志全部改为**本地时区**显示（HH:MM:SS.mmm）。
- 版本 `2.4.5.53` / `240500053`；徽章 `HarmonyOS Port r53`。

## r52 · 补上官方内置插件（修"插件市场装不上"的真因）（2026-11-26）

> 真机反馈"两个插件下载不下来" → 实为 **官方内置插件**（`motrix.filename-template` 文件名模板、
> `motrix.url-resolver` URL 解析器）。上游把这些 hook 标为 official builtin，**不允许从市场安装**
> （`plugin.install.official_builtin_hook`），必须随应用提供；而我们的构建此前从未跑过
> `fetch-builtins`，`builtin-plugins/` 一直是空目录 ⇒ UI 显示"未安装"、点安装又报错。

- **打包官方内置插件**：新增 `scripts/fetch-builtins.mjs` 包装器——
  上游脚本在本机用 undici fetch 下 GitHub Release 资产会一路 `fetch failed`，
  但 Node 原生 fetch 抓同一资产是 200；于是先用原生 fetch 下到 `build/builtin-artifacts/`（缓存，
  lockfile 变化才重下），再以 `MOTRIX_BUILTIN_ARTIFACT_DIR` 交给上游脚本做
  **sha256 + Ed25519 签名校验**与解包。当前内置两个插件：
  `motrix.filename-template@1.1.1`、`motrix.url-resolver@1.0.0`（均 "sig verified"）。
- HAP 内新增 `resources/resfile/app/builtin-plugins/…`；宿主已通过 `MOTRIX_BUILTIN_PLUGIN_DIR`
  指过去，registry 会按 builtin 扫描 ⇒ 插件页显示"已安装"，不再需要/不应点"安装"。
- 版本 `2.4.5.52` / `240500052`；徽章 `HarmonyOS Port r52`。

## r51 · 插件健壮化 + JIT 下退回原生网络栈 + 签名口令自动同步（2026-11-26）

> 真机 r50 暴露三件事：①插件沙箱真的能跑（JIT 生效），②**慢插件 hook 超时会 abort 任务创建**，
> ③启动时激活插件让冷启动 +479ms；另有"两个插件下载不下来"待查。

- **JIT 模式下不再安装 jitless 网络垫片**（重要）：r50 仍无条件用纯 JS `fetch/Headers/WebSocket`
  覆盖全局。服务端 `plugin-http-client` 明确用 undici（`Agent/ProxyAgent/fetch`），却拿的是我们
  被替换过的全局 `Headers` ⇒ 插件市场/插件下载这类请求容易出奇怪失败。现在：
  `typeof WebAssembly !== 'undefined'` 时不装任何 shim，直接用 Node 原生 undici；
  jitless 时照旧装（那套 shim 本来就是为 undici-wasm 炸掉准备的）。
- **hook 超时改为 fail-open**：超时（`plugin.hook.timeout` / `timed out after Nms`）≠ 插件明确拒绝。
  以前 role=resolve/post-process 超时会让整条任务链 abort（r50 真机：smart-link 解析 GitHub 仓库页
  超 10s ⇒ 任务创建 500）。现在丢掉该插件的改动、任务继续，只留 warn。
- **启动期插件激活移出关键路径**：`pluginActivation.dispatch({kind:'startup'})` 从 listen 之前
  挪到 listen 之后异步执行（r50 实测启动激活 ~479ms）；任务/命令触发时仍会按需激活。
- **签名口令自动同步**：DevEco 重新自动签名会换密钥库口令，本地 `build-profile.local.json5`
  的旧密文对不上新 p12（`KEYSTORE_PASSWORD_ERROR -115`，本轮踩到）。新增
  `scripts/refresh-local-signing.mjs`（从 `.hvigor/outputs/sync/output.json` 读最新密文），
  `apply-local-signing.sh` 构建前自动调用。
- **RPC 命令失败补日志**：`command:installPlugin` 等返回 500 时，除了 renderer 看到错误，
  node-output.log 里现在有 `[rpc] command failed <channel> <原因>`（fastify 请求日志可能被关掉）。
- 版本 `2.4.5.51` / `240500051`；徽章 `HarmonyOS Port r51`。

## r50 · JIT 正式启用（受限 ACL 已到位，V8 JIT / WebAssembly 恢复）（2026-11-26）

> 维护者在 DevEco 重新自动签名后，调试 profile 的 `acls.allowed-acls` 已包含
> `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`（与 `ALLOW_EXTERNAL_NATIVE_CODE` 并列）——
> 即官方受限权限已对本应用生效（无需再等 3 个工作日审核）。

- **JIT 打开**：r49 的探针驱动逻辑即刻生效 —— `probeExecMemory()` 返回 true ⇒ Node 不再带 `--jitless`，
  V8 JIT 与 **`WebAssembly` 恢复可用**；上游 QuickJS 插件沙箱（快速 JS 引擎 wasm）原样工作。
- **插件运行时**：注入渲染层的 `pluginRuntime` 自动变为 `'ready'` ⇒ 插件页不再显示"端侧不可用"横幅，
  已安装的插件可以真正激活；server 侧 r47 的 fail-open 兜底保留（插件坏了也不会拖垮下载）。
- **清单声明策略**：`module.json5` 的受限权限声明改为**跟随文件状态**（r50 起仓库默认**已声明**，因为 ACL 已具备）；
  `build-hap.sh` 默认不再擅自改动；`MOTRIX_ENABLE_JIT_PERMISSION=1` 仍可用于"仓库注释态临时解注出包"。
- **降级路径不变**：用户开启「坚盾守护模式」时内核拒绝可执行内存 → 探针 false → 自动回退 `--jitless`，不闪退。
- 版本 `2.4.5.50` / `240500050`；徽章 `HarmonyOS Port r50`。

## r49 · 引擎启动快连 + JIT 受限权限就绪（探针驱动、可降级）（2026-11-26）

> 开发者 AI 确认：**匿名内存可执行是内核级管控**（`EINVAL` 就是官方预期），合法途径只有受限 ACL
> `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`，官方可申请场景正是「应用内置 JavaScript
> 虚拟机（V8 等）」——本项目完全匹配；PC/2in1 支持、个人实名开发者可申请、约 3 个工作日。
> 拿到 ACL 后本进程即可 JIT/WASM，于是本版把 JIT 做成**探针驱动 + 可降级**，权限到位即自动生效。

- **引擎启动快 ~450ms**：`aria2-rpc-client.connect()` 的重试退避从固定 `500ms` 改成
  前快后慢 `20/40/80/160/250ms` 再 500ms 封顶。r48 真机 `boot:` 日志显示引擎启动 **663ms**，
  其中 `engine start stage slow: stage=rpc ms=515` —— 就是死等 500ms 造成的。
- **JIT 探针驱动（自动降级）**：原生新增 `probeExecMemory()`（NAPI）；`MotrixHost.start()` 先探针
  再决定 argv —— 可执行内存可用 ⇒ 不带 `--jitless`（V8 JIT + `WebAssembly` 可用）；
  不可用（含用户开启**坚盾守护模式**）⇒ 回退 `--jitless`，功能不受影响、不闪退。
- **插件运行时状态动态化**：注入渲染层的 `pluginRuntime` 由 `isJitAvailable()` 决定，
  JIT 可用时插件页不再显示"端侧不可用"横幅、上游 QuickJS 沙箱原样工作；
  不可用时横幅 + server 侧 fail-open 兜底（r47）保持不变。
- **受限权限构建开关**：`module.json5` 增加带标记的注释块 + `scripts/patch-module-permissions.mjs`
  （enable/disable/status，round-trip 精确）。拿到 ACL 后用
  `MOTRIX_ENABLE_JIT_PERMISSION=1 sh scripts/build-hap.sh` 构建：临时解注 → hvigor → 自动还原。
  **默认不声明**（没 ACL 声明会让安装失败）。
- 版本 `2.4.5.49` / `240500049`；徽章 `HarmonyOS Port r49`。

## r48 · 冷启动优化（并行启动 + 不等引擎 + 启动耗时细分）（2026-11-26）

> 目标：缩短"点图标 → 仪表板可用"。r47 基线：宿主 ready **2500ms**，启动到首个可用画面约 4.7s。

- **宿主不再等引擎就绪**（最大的结构性改动）：
  上游 `/healthz` 只有 `accepting && engine Ready` 才回 200；旧实现为了这个 200 把**引擎启动**
  也算进宿主关键路径。现在只等"HTTP 入口应答"（200 或 **503** 都算端口已通），
  UI 先加载、引擎状态由事件流更新为"启动中 → 就绪"（r45 起引擎状态已是单例 store，本来就支持）。
  新增启动阶段 `http_listening`（记录 healthz 状态与等待毫秒）。
- **spawn 诊断挪出关键路径**：`spawn-probe.json` 那 5 个 `spawnSync`（约 200ms）以前挡在
  `import server` 之前；现在推迟到 ready 之后 20s 再跑（纯诊断，不参与任何判据）。
  → r47 的 `preflight 247ms` 应基本消失。
- **healthz 轮询 300ms → 60ms**：端口一通就继续，少等一个轮询周期。
- **宿主提前启动 + ArkWeb 预热（并行）**：
  · `EntryAbility.onWindowStageCreate` 里（loadContent 之前）就 `preStartHost()`，
    Node 启动与窗口/页面初始化并行；`Index` 只 await 同一个 Promise（新增 `runtime/HostBoot.ets`）。
  · Web 组件**从第一帧就以 `about:blank` 存在**，ArkWeb 内核预热与 Node 启动并行；
    宿主 ready 后再 `loadUrl` 到真实 UI（`onPageEnd` 已加"预热页不算就绪"的保护）。
- **启动耗时细分**：`server/index.ts` 在 `startServer()` 内加 `boot:` 日志（`startServer-entry` →
  `geoip-started` → `plugin-activation-done` → `proxy-applied` → `engine-start-before/done` →
  `session-restored` → `startup-recovery-done` → `http-listening`，每行带 `elapsedMs`）。
  下一轮按这份细分削服务端启动（listen 之前的 1000ms+ 是大头）。
- 版本：`2.4.5.48` / `versionCode 240500048`；徽章 `HarmonyOS Port r48`（见 Index.ets）。

## r47 · 版本号方案 + 插件安全降级 + W^X 探针 + 出包自检（2026-11-26）

> 真机验证：待测。产物 `2.4.5.47`（versionCode `240500047`）。

- **版本号方案（项目作者定）**：`versionCode = 上游 2405 + 占位 00 + 轮次 047`（`240500047`），
  `versionName = 2.4.5.47`；轮次到三位数后占位让一位（r101 → `24050101`）。
  写进 `AppScope/app.json5` 注释，后续每轮只改这两处。
- **插件运行时安全降级（修一个真 bug）**：真机日志实证，装插件后**HTTP 任务直接失败**——
  `plugin chain aborted: ashkan4472.folder-categories: WebAssembly is not defined`。
  现在 `WebAssembly === undefined` 时：
  · `ActivationDispatcher.dispatch` 跳过激活（告警只记一次，不刷屏）；
  · `abortsChainOnFailure` 降级为 **fail-open**：critical 角色插件失败也不再 abort 任务链；
  · 插件页顶部显示横幅（中英双语）：端侧插件沙箱不可用、插件保留但不激活、下载不受影响。
  这样"插件坏"不再拖垮下载功能，也不影响后续换运行时方案。
- **W^X 探针**：`motrixhost.so` 在起 Node 之前试 `mmap(RW) → mprotect(RX)` 与 `mmap(RWX)`，
  结果写 `<dataDir>/wx-probe.json` 并打 hilog `MOTRIX-WX`。这是判断"能否放开 JIT
  （从而让上游 QuickJS 插件沙箱原样可用）"的**唯一判据**——本机实验已证明 libnode 本身支持
  JIT/WASM（不带 `--jitless` 时 `quickjs-emscripten` 能正常 eval），只剩设备域策略未知。
- **出包自检脚本** `scripts/verify-hap.mjs`：一次校验签名、6 个原生件、可执行文件 `.bin` 后缀、
  `main.mjs` 与源码一致、`node_modules`/renderer 产物、`module.json` 版本号与 `ets` 轮次串。
- **上游对照结论**：上游**没有**"打开数据目录"入口，也**没有**用户可见的备份功能
  （任务列表备份只用于导入流程）⇒ 按项目作者要求**不新增**，数据目录保持现状。

## r46 · HAP 减 11.5MB + 启动阶段细分 + Dock 进度重试（2026-11-26）

> 真机验证：2026-11-26 **通过**（项目作者装包后确认可用）。产物 191,994,335 B，MD5 `51a7876508945ebff2bc53b0814564da`。

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