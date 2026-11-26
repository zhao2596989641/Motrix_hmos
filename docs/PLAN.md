# Motrix 鸿蒙移植 · 工作计划与工作日志（活文档）

> **这是本项目的"总览页"**：当前状态、轮次日志、下一步、待决策都在这。
> 细节分别见 [CHANGELOG](CHANGELOG.md)（每轮改了什么）、[FEATURE-MATRIX](FEATURE-MATRIX.md)（逐项能力清单）、
> [BUILD](BUILD.md)（出包）、[RUNTIME](RUNTIME.md)（原生运行时）、[RELEASE](RELEASE.md) / [TESTING](TESTING.md)。
>
> 远端仓库（main 分支）：`github.com:zhao2596989641/Motrix_hmos` · `gitcode.com:zhao2596989641/Motrix_hmos`
> —— 在网页上直接看本文件即可跟随开发进度。

---

## 一、当前状态（2026-11-26 · r46）

**一句话**：核心链路（下载/暂停/续传/删除/持久化/后台/通知/主题语言/窗口/托盘/深链/Dock 进度）已在真机跑通；
r47 起版本号改为 `2.4.5.47` / `240500047`，并修掉了"装插件会让下载失败"的真机 bug；
插件运行时（QuickJS 沙箱需要 WebAssembly）是否可用，靠本轮的 **W^X 探针**在真机上判定。

| 维度 | 状态 |
|---|---|
| 装机形态 | HAP `com.lyldeer.motrix`，2in1 / aarch64 / API 26（target+compatible 均 `26.0.0`），debug 签名（**只自己用**，见待决策 4） |
| 版本号 | `versionCode 240500052` / `versionName 2.4.5.52`（方案：上游 2405 + 占位 00 + 轮次 052） |
| JIT / 插件 | **受限 ACL 已到位**（调试 profile `acls` 含 `ALLOW_WRITABLE_CODE_MEMORY`）⇒ r50 起 Node 走 V8 JIT，
`WebAssembly` 可用、上游 QuickJS 插件沙箱可工作；坚盾模式自动回退 `--jitless` |
| 端侧运行时 | 进程内 `libnode.so.137`（Node 24.2.0，`--jitless`）+ Motrix server（fastify）+ ArkWeb 同源加载官方 Web UI |
| HAP 体积 | **191,994,335 B**（r46 起 `resfile/app/bin` 不再重复打包，省 11.0 MiB） |
| 冷启动 | r47 **2500ms** → r48 **2026ms**（preflight 247→5ms；服务端细分：engine 663ms 是大头）；r49 预计再降 ~450ms |
| 但测通过的 | r38 / r44（回档基线）；r43 因"快速重试"事故被回档；r45（引擎状态单例 store）由 r46 间接验证 |
| 已知 P0 遗留 | 代理/TUN 未排除 loopback 时前端会报"无法连接服务器"（环境问题，需决策怎么兜，见第四节） |

能力总览（详细逐项见 [FEATURE-MATRIX](FEATURE-MATRIX.md)）：

- ✅ **已真机验证**：HTTP 下载、暂停/续传/删除（含文件）、任务与设置持久化、后台下载、引擎就绪、
  系统通知、中英文/深浅色、沉浸式标题栏 + 三键避让、窗口尺寸位置记忆、托盘（图标/左键面板/右键菜单/关窗收托盘）、
  Dock 进度条、深链（magnet / .torrent 打开方式）
- 🟢 **已实现待点验**：限速档位、任务详情、批量操作、创建种子、Tracker 同步、代理、GeoIP、单实例、
  在文件夹中显示 / 打开文件 / 外链、UPnP/NAT 显示、Dock 跳转列表（未做）
- 🟡 **受限**：BT 真实入站连接（网络策略）、中文输入法、剪贴板、拖 `.torrent` 入窗、托盘双主题图标
- ⛔ **平台不可用**（入口保留/或已隐藏）：插件系统（`--jitless` 无 WebAssembly）、媒体 HLS/DASH、
  浏览器扩展/CLI 配对、应用内更新、完成后关机（**唯一隐藏的入口**）、开机自启（系统只给查询）、v1 迁移

---

## 二、轮次工作日志（r1 → r46）

> 早期轮次合并记录；r32 起每轮单独一包、单独一次真机验证。详见 [CHANGELOG](CHANGELOG.md)。

| 轮次 | 内容 | 结论 |
|---|---|---|
| r1–r17 | 路线选型（server + 端侧 Node + ArkWeb）与硬事实验证；解决 `9568393` 安装失败、better-sqlite3 dlopen、undici WASM 三大卡点 | ✅ P0 真机可用 |
| r18–r31 | 稳定性/体验打磨：启动看门狗、沉浸式标题栏、窗口记忆、三键避让、通知桥、引擎重启修复、主题语言 | ✅ 逐项验过 |
| r32 | 托盘常驻（关窗收托盘）+ 左键玻璃面板 v1 + Dock 进度条 + 启动清孤儿 aria2c | ✅ |
| r35 | 深链与文件关联（`magnet:` + 自定义 UTD `.torrent`）+ 面板视觉修正 | ✅ |
| r36–r38 | 托盘面板迭代：百分比换算、按钮/间距、三行任务行、固定排序、实时性修复 | ✅ |
| r39 / r40 | 入口收敛 + HAP 减 11.5MB + 启动诊断（后被回档） | ⏸ 回档，r46 重新落地了体积部分 |
| r41 | 关于页"移植轮次"徽章 + `boot-stage.json` 阶段时间线 | ✅ |
| r42 | 关于页开机自启提示 + `scripts/gather-logs.sh` | ✅（脚本后丢失，r46 恢复） |
| r43 | 尝试"失败 1.5s 快速重试"修仪表板卡启动中 | ❌ **事故**：压满 ArkWeb 6 条连接 → "无法连接服务器"，全部回档 |
| 回档 | 源码回到 r38 快照，产物 hash 与 r38 完全一致 | ✅ 可用基线 |
| r44 | 在 r38 基线上重做 A+C 小批（关于页徽章/自启提示、启动时间线、只隐藏关机入口）+ 仓库去敏 | ✅ 真机通过 |
| r45 | 引擎状态**单例 store**（修"切页回仪表板卡在引擎启动中"）+ 只读网络诊断（`query burst`/`slow query`） | ✅ 由 r46 间接验证 |
| r46 | `resfile/app/bin` 不随包（**-11.0 MiB**）、启动阶段细分、Dock 进度条失败重试、恢复 gather-logs | ✅ 真机安装可用 |
| r47 | 版本号方案（`2.4.5.47`/`240500047`）、**插件不可用时的安全降级**（不再拖垮下载）、W^X 探针、出包自检脚本 | ✅ 真机安装/探针通过（下载回归待用户确认） |
| r48 | 冷启动：宿主不等引擎就绪、spawn 诊断移出关键路径、healthz 快轮询、宿主提前启动 + ArkWeb 预热、服务端启动细分打点 | ✅ 真机验证：宿主 ready **2500→2026ms**；点图标→仪表板 ≈5.6s→4.2s；引擎"启动中→就绪"符合预期 |
| r49 | 引擎启动快连（RPC 退避 500ms→20/40/80…）、JIT 探针驱动（有 ACL 自动走 JIT，否则回退 jitless）、插件运行时状态动态化、受限权限构建开关 | ✅ 代码就绪（JIT 在 r50 生效） |
| r50 | **JIT 正式启用**（ACL 到位）：Node 不带 `--jitless`、WebAssembly 恢复、上游 QuickJS 插件沙箱可用；清单声明跟随文件状态 | ✅ 真机验证 JIT/WASM/插件沙箱；发现慢插件超时 abort 任务 + 启动激活 +479ms（r51 修） |
| r51 | 插件健壮化：JIT 下退回原生 undici（不装垫片）、hook 超时 fail-open、startup 激活挪后、RPC 错误日志、签名口令自动同步 | ✅ 代码已出包；真机反馈"两个插件装不上" => 实为内置插件问题（r52） |
| r52 | **打包官方内置插件**（filename-template / url-resolver）：新增 fetch-builtins 包装器绕过 undici 下载失败，sha256+签名校验后随包提供 | ⏳ 待真机验证（插件页应显示已安装） |

**踩过的坑（写进 [BUILD](BUILD.md)/[RUNTIME](RUNTIME.md)，别再踩）**：
HAP `libs/` 下可执行文件必须带扩展名（否则 `9568393`）；签名过的 ELF 覆盖会 `EPERM`（先删后铺）；
ArkTS 注入脚本里不能出现反引号；ArkUI `@Builder` 参数按值传递（状态值必须内联）；
ArkWeb 同一 host 只有 **6 条连接**——任何"失败快速重试"都必须先限并发，否则全线超时。

---

## 三、下一步计划（按优先级）

| # | 任务 | 为什么现在做 | 依赖 | 预估 |
|---|---|---|---|---|
| 1 | **插件运行时落地**：探针已判 **`execmemAllowed:false`** ⇒ 放开 JIT 不可行。改为在 `quick-js-worker` 接一个 **`node:vm` 兼容层**（无 WebAssembly 时自动切换），先在本地 `dev-local-repro` 用真实 libnode + 真实 server 装内置插件跑通 | 你装了插件跑不起来；方案已定 | 无（本机可全流程验证） | 1–2 轮 |
| ~~2~~ | ~~冷启动（第一轮）~~ | **r48 已做**：拆掉"等引擎就绪"、spawn 诊断移出关键路径、宿主/ArkWeb 并行启动、服务端启动细分打点 | 已出包 | 待真机 | 
| 2b | **冷启动（第二轮）**：r48 细分已定位——engine start **663ms**（其中 `stage rpc` **515ms** 是固定 500ms 退避），r49 已改快连（预计 -450ms）；其余 geoip 3ms / session 5ms / recovery 15ms / listen 9ms 都不值得动 | 用户可感知 | 已做进 r49 | 已完成 |
| 2c | **冷启动（第三轮，可选）**：r49 后若仍想更快，可考虑把渲染层首屏（约 1s）再削：按路由懒加载/首屏查询合并 | 锦上添花 | r49 真机数据 | 按需 |
| ~~3~~ | ~~发布工程~~ | **只自己用 ⇒ 大幅收口**：不做 release 签名/市场分发；`versionCode` 方案已落地，出包自检已脚本化（`scripts/verify-hap.mjs`） | 已按 r47 落地 | — |
| 3 | **待点验能力扫尾**：限速、任务详情、批量、创建种子、Tracker、代理、GeoIP、单实例、reveal/open | 这些"已实现未验"，验完才能叫完成 | 真机逐项点验（可配 devbridge 半自动） | 2–3 轮 |
| 4 | **代理/TUN 兜底**（待决策，见第四节）：`ProxyController.applyProxyOverride` + bypass `127.0.0.1`，做成可开关 | 环境一变整个前端连不上，体验最差 | 决策 + 一轮验证 | 一轮 |
| 5 | **功能收口**：Dock 跳转列表、拖 `.torrent` 入窗（若 ArkWeb 允许）、托盘双主题图标、中文 IME 可行性调研 | 锦上添花 | 调研 | 按需 |
| 6 | **维护工程**：清理仓库里的本机绝对路径、`scripts/` 参数化、CI（可选，端侧跑不了） | 手感 | 无 | 穿插做 |

回滚纪律（不变）：**一轮一包、每包写测试清单、真机验证通过后再叠下一轮**；
出问题先装回上一版定位，再改。

---

## 四、待维护者拍板的事（2026-11-26 已定 4 项，1 项待定）

1. **代理/TUN 兜底**：**保持现状、不做代码**。维护者在 Clash/代理里自行把 `127.0.0.1`、`::1`、`localhost`
   加进例外即可（r45 的 `query burst`/`slow query` 诊断可用来确认是否代理问题）。
2. **入口收敛**：**待定**（插件页、设置"集成"卡片、关于页"检查更新"目前都可见；只隐藏「完成后关机」）。
3. **插件系统**：探针已答——应用域 **W^X 禁止可执行内存**（`execmemAllowed:false`），
   所以**放开 JIT 这条路走不通**（B 方案定为唯一可行路线）：
   在 `quick-js-worker` 里把 QuickJS-WASM 沙箱换成 **`node:vm` 兼容层**（上游 worker 2051 行不动，
   只换引擎适配层，按 `typeof WebAssembly === 'undefined'` 自动切换）。**只自己用**，`vm` 不是安全边界可接受。
   落地前先在 `dev-local-repro`（真实 libnode + 真实 server）里装内置插件跑通，再上真机。
4. **发布方式**：**只自己用** ⇒ debug 签名即可，不做 release 签名/应用市场；版本号方案已落地。
5. **数据目录/下载目录**：**保持现状**（`el2 filesDir/motrix` + `Download/com.lyldeer.motrix`）。
   已核对上游：没有"打开数据目录"入口、也没有用户可见的备份功能 ⇒ 按维护者要求不新增。

## 五、里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 调研 + 可行性实测 | ✅ |
| M1 | 上游依赖、构建产物、better-sqlite3 交叉编译、aria2 选型 | ✅ |
| M2 | Motrix server 在鸿蒙 PC 上跑通 | ✅ |
| M3 | HAP 骨架：libmotrixhost.so + ArkWeb 壳 + 首次启动起 Node | ✅ |
| M4 | 端侧 Node 宿主：端口协商、数据目录、token、探活、退出收尾 | ✅ |
| M5 | 打包：node_modules 裁剪、resfile 组装、finalize-fs、签名脚本 | ✅（r46 又瘦 11 MiB） |
| M6 | 系统集成：托盘、通知、深链、单实例、窗口记忆、Dock 进度 | ✅（除开机自启受系统限制） |
| M7 | 真实下载验收 + 设置/主题/语言 | ✅ 核心验过，长尾见第三节 3 |
| M8 | 发布工程（release 签名 / versionCode / clean install） | ⬜ 下一步 |

---

## 六、路线与技术决策

Motrix Turbo 自带 headless server 通道（`src/server/` fastify + HTTP/WS）与 `dist/renderer-web`（React）。
鸿蒙移植 = 把这条通道原样搬到端侧 Node 上跑，用 **ArkWeb 同源加载** `http://127.0.0.1:<port>/`，
Electron 专属能力（托盘/窗口/对话框/自启/深链）由 **ArkTS 壳**补齐。

```
┌──────────────────────── HAP (com.lyldeer.motrix) ────────────────────────┐
│ ArkTS 壳（EntryAbility / Index.ets）                                     │
│   · 窗口 + ArkWeb → http://127.0.0.1:<port>/（同源，官方 Web UI）          │
│   · 托盘 / 通知 / 深链 / 目录授权 / 长时任务 / 退出收尾                   │
│   · libmotrixhost.so（NAPI 引导）→ 同进程起 libnode.so.137               │
│        └─ node --jitless resfile/app/main.mjs                            │
│              ├─ dist/server/index.mjs（Motrix server）                    │
│              ├─ spawn libs/arm64/aria2c.bin（Motrix fork，应用证书签名）   │
│              └─ spawn libs/arm64/motrix-finalize-fs.bin（Rust sidecar）    │
└──────────────────────────────────────────────────────────────────────────┘
```

关键决策：

1. **端侧 Node 复用 `libnode.so.137`（Node 24.2.0，`--jitless`）**；代价是 WebAssembly 不可用（插件系统）。
2. **进程内 dlopen + `node::Start` 独立线程**，不 exec 外部 node。
3. **aria2 用 spawn**（官方 fork 静态二进制，签名后可执行），与上游 `Aria2ProcessManager` 兼容。
4. **finalize-fs 保持 Rust sidecar**（交叉编译 + 签名，零上游改造）。
5. **尽量不碰上游源码**：`vendor/motrix/` 是上游快照；渲染层必要的移植改动记录在
   `docs/UPSTREAM-PATCHES.md`（平台判定、入口可见性、引擎状态 store、诊断日志）。
6. **数据目录** `context.filesDir/motrix`（el2，覆盖安装保留）；下载目录走 `Download/com.lyldeer.motrix`。

---

## 七、关键实测事实（真机验证，不是推断）

| # | 事实 | 证据 |
|---|---|---|
| 1 | ELF 能不能跑，判据是**代码签名** | 未签名 `aria2c` → `EACCES`；`binary-sign-tool -selfSign 1` 后可执行；随包 ELF 需**应用证书**签名（自签会被安装器拒：`9568393`） |
| 2 | `child_process.spawn` 在应用沙箱可用 | `spawnSync(signed aria2c --version)` = 0 |
| 3 | `.node` dlopen 同样要签名 | 未签名 → `ERR_DLOPEN_FAILED`；签名 / 以 flat `libbetter_sqlite3.so` 随 `libs/` 提供则正常 |
| 4 | 官方 fork aria2 可直接跑 | `1.37.0-motrix.25` linux-arm64 静态版 |
| 5 | better-sqlite3 可交叉编译（NAPI 10） | OHOS clang 编出 `.node`，读写/事务全通 |
| 6 | ArkWeb 同一 host **6 条** HTTP/1.1 连接 | r43 事故日志（948× `NetworkTransactionTimeout`）+ r45 单例化后恢复 |
| 7 | ArkWeb 尺寸：dpr 1.9、窗口约 1101×734 CSS px | 真机 dump |
| 8 | `statusBarManager` 托盘：左键 = `StatusBarViewExtensionAbility`，右键 = 菜单；`hideAbility()` 需状态栏挂靠的 `BackGroundAbility` | 真机验证 |
| 9 | **应用域禁止可执行内存（W^X）**：`mmap(RW)→mprotect(RX)` 与 `mmap(RWX)` 都返回 `EINVAL` | r47 `wx-probe.json`：`execmemAllowed:false` |
| 9b | 该管控是**官方内核级策略**（官方文档记载 `EINVAL` 为预期）；合法途径只有受限 ACL `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`（场景=内置 V8/LuaJIT 等语言虚拟机，PC/2in1+Tablet 支持，个人实名可申请，约 3 工作日） | 开发者 AI 回复（2026-11-26，附官方文档编号） |
| 10 | `node:vm` 在 `--jitless` 下**可用**（无 WebAssembly 也行） | r47 本机 libnode 实测（eval/跨 context/async 均正常） |

---

## 八、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 换包名必须重签（p7b 绑 bundleName/UDID） | 出不了安装包 | 维护者在 DevEco 做一次自动签名，之后 CLI 复用物料（`build-profile.local.json5` 不入库） |
| `--jitless` 无 WASM | 插件系统不可用 | 入口保留但不支持；后续按第四节 3 决策 |
| 代理/TUN 劫持 loopback | 前端"无法连接服务器" | 文档要求加例外；r45 诊断日志可判定；必要时按第四节 1 上 bypass |
| BT 入站受系统策略限制 | BT 只能连出去 | 已实测可下载；极端情况接受降级 |
| 端侧跑不了原生 `tsc`（SIGSYS）/ Biome 无包 | 本地没有类型检查 | 用 `vitest run` + 打包产物验证；见 [BUILD](BUILD.md) 第 4 节 |

---

## 九、目录约定

```
codes/MotrixOHOS/
├── vendor/motrix/            # 上游 Motrix Turbo 快照（平台改动尽量不落这里，例外见 UPSTREAM-PATCHES）
├── entry/                    # HAP entry：ArkTS 壳（Index/TrayPanel/runtime）、C++ 引导、资源
│   └── src/main/resources/resfile/app/   # 端侧 server + 渲染层 + 运行期 node_modules（构建期生成）
├── scripts/                  # 构建 / 签名 / 打包 / 出包自检(verify-hap) / devbridge / host 宿主入口
├── build/                    # 中间产物（不入库）
├── docs/                     # PLAN(本文件) / CHANGELOG / FEATURE-MATRIX / BUILD / RUNTIME / RELEASE / TESTING / testplans/
└── entry/build/default/outputs/default/entry-default-signed.hap   # 产物（不入库）
```

> 跨会话交接文档（含真机日志、测试清单位置）在仓库外的 `share/`；长期有效的内容会同步进本目录。