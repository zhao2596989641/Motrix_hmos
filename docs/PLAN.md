# Motrix 鸿蒙移植 · 总计划

> 目标：把 **Motrix Turbo 2.4.5**（官方最新版，Electron 45 + React 19 + Node）移植成
> HarmonyOS PC 原生应用，跑在 HAP 里，自己起后端、自己显示官方 Web UI，不依赖任何外部服务。
>
> 项目作者拍板（2026-11-24）：路线 A（server + ArkWeb）、包名 `com.lyldeer.motrix`、
> API 26（target+compatible 均 `26.0.0`）、工程放 `codes/MotrixOHOS/`、
> 签名由项目作者在 DevEco 做一次、之后 CLI 出包。

---

## 一、路线（为什么是它）

Motrix Turbo 自带一条 **headless server 通道**：`src/server/`（fastify + HTTP/WS）+
`src/renderer-web`（React 打包产物）。桌面壳（Electron）与手机/网页壳共用同一套
`src/core/`（架构约束：`src/core/` 不 import electron）。因此鸿蒙移植 = 把这条
server 通道原样搬到端侧 Node 上跑，再用 **ArkWeb** 加载同源 Web UI，Electron 专属能力
（托盘/窗口/对话框/开机自启/深链）由 **ArkTS 壳**补齐。

不采用「华为 Electron-on-OHOS 引擎」路线：引擎本体不在任何仓库里（需重编华为私有仓库，
且只到 Electron 22），与上游 Electron 45 不兼容。

```
┌──────────────────────── HAP (com.lyldeer.motrix) ────────────────────────┐
│ ArkTS 壳（EntryAbility / Index.ets）                                     │
│   · 窗口 + ArkWeb → http://127.0.0.1:<port>/（同源，官方 Web UI）          │
│   · 托盘 / 通知 / 目录授权 / 长时任务 / 退出收尾                          │
│   · libmotrixhost.so（NAPI 引导）→ 同进程起 libnode.so.137               │
│        └─ node --jitless resfile/app/main.mjs                            │
│              ├─ 启动 dist/server/index.mjs（Motrix server）               │
│              ├─ spawn bin/aria2c（Motrix fork，已自签名）                  │
│              └─ spawn bin/motrix-finalize-fs（Rust sidecar，已自签名）     │
└──────────────────────────────────────────────────────────────────────────┘
```

## 二、已经验证的硬事实（都是本机实测，不是推断）

| # | 事实 | 证据 |
|---|---|---|
| 1 | **ELF 能不能跑，判据是"代码签名"，不是权限位** | 未签名 `aria2c` → `EACCES`；`binary-sign-tool -selfSign 1` 之后 → 正常 |
| 2 | **`child_process.spawn` 在鸿蒙沙箱里可用** | node 的 `spawnSync(signed aria2c --version)` 返回 0；`spawn(/bin/sh -c)` 正常 |
| 3 | **`.node` dlopen 也需要签名** | 未签名 `.node` → `ERR_DLOPEN_FAILED Permission denied`；签名后 → 正常 |
| 4 | **Motrix 官方 fork 的 aria2 可直接在鸿蒙跑** | `linux-arm64` 版 `1.37.0-motrix.25`，静态链接，带 Async DNS / SQLite3-Persistence / Metalink |
| 5 | **better-sqlite3 可交叉编译**（NAPI 10，ABI 稳定） | OHOS clang 编出 `.node`，本机 brew node 实测 `pragma/transaction/prepare/all/get/run` 全通 |
| 6 | **Motrix server 在本机跑通** | `healthz:200` / `index:200` / aria2 RPC 连通 / `query:listTasks` 返回 `[]` |
| 7 | 本机有完整 CLI 鸿蒙工具链 | `/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0`（hvigor 7.26.11 / SDK 26.0.0.105 / node 24.18.1） |

## 三、里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 调研 + 可行性实测（三份报告在 `share/`） | ✅ |
| M1 | 上游依赖安装、前端/服务端产物构建、better-sqlite3 交叉编译、aria2 选型 | ✅ |
| M2 | **Motrix server 在本机（HarmonyOS PC）跑通** | ✅ |
| M3 | HAP 骨架：AppScope/build-profile/hvigor + libmotrixhost.so + ArkWeb 壳 + 首次启动起 Node | ← 进行中 |
| M4 | 端侧 Node 宿主：端口协商、数据目录、token 注入、就绪探活、退出收尾 | 待做 |
| M5 | 打包：node_modules 运行时根裁剪、resfile 组装、finalize-fs 交叉编译、签名脚本 | 待做 |
| M6 | 系统集成：托盘、通知、开机自启、深链（magnet/.torrent）、单实例、窗口记忆 | 待做 |
| M7 | 真实下载验收（HTTP/BT/磁力）、设置页、暗色、中英文 | 待做 |

## 四、关键技术决策

1. **端侧 Node**：复用 参考宿主项目 验证过的 `libnode.so.137`（Node 24.2.0，`--jitless`）。
   `--jitless` 的代价是 `WebAssembly === undefined` ⇒ 插件系统（QuickJS wasm）不可用，
   核心下载/任务/设置不受影响。插件系统先关闭入口，后续再评估。
2. **不 fork、不 exec Node**：`libmotrixhost.so` 在 ArkTS 进程内 dlopen libnode，
   `node::Start` 跑在独立线程。参考 参考宿主项目 `hostruntime/src/main/cpp/dshhost.cc`（已验证）。
3. **aria2 用 spawn，不用进程内 addon**：官方 fork 二进制静态链接、签名后可执行，
   与上游 `Aria2ProcessManager` 完全兼容（含 sqlite 会话持久化、`--stop-with-process`）。
4. **finalize-fs 保持 Rust sidecar**：交叉编译到 aarch64-musl 静态二进制后签名即可，
   零上游改造。本机验证阶段先用 stub 顶替。
5. **不碰上游源码**：`vendor/motrix/` 是上游快照；平台差异只放
   `entry/`（ArkTS/C++）与 `scripts/`。唯一的例外是构建期两处（`packageManager` 版本、
   `cssMinify`）——见 `docs/UPSTREAM-PATCHES.md`。
6. **数据目录**：`context.filesDir/motrix`（el2，覆盖安装保留）；下载目录走
   `Download/com.lyldeer.motrix`（用户可见、卸载重装同包名仍可访问）。

## 五、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 换包名必须重签（p7b 绑 bundleName） | 出不了安装包 | 项目作者在 DevEco 自动签名一次，之后 CLI 复用物料 |
| `--jitless` 下 WASM 全灭 | 插件系统不可用 | MVP 先关插件市场入口 |
| undici 的 llhttp wasm 解析器 | 直链校验/管理 CLI 可能炸 | 实测后改用内置 fetch（4 个调用点） |
| BT/DHT 入站被系统策略限制 | BT 只能"连出去" | 实测端口绑定；实在不行接受降级 |
| 前端与 server 必须同源 | 加载方式受限 | ArkWeb 直接载 `http://127.0.0.1:<port>/` |
| 30+MB node_modules 进 resfile | HAP 体积/首启解压 | 只带 26 个 runtimeRoots；后续可考虑打包内联 |

## 六、目录约定

```
codes/MotrixOHOS/
├── vendor/motrix/        # 上游 Motrix Turbo 快照（只读参考，平台改动不落这里）
├── entry/                # HAP entry 模块（ArkTS 壳 + C++ 引导 + 资源）
├── AppScope/ build-profile.json5 hvigorfile.ts oh-package.json5
├── scripts/              # 构建/签名/打包脚本
├── build/                # 中间产物（不入库）
├── docs/                 # PLAN / 决策 / 踩坑
└── share/ -> ../../share # 跨会话交接文档（仓库根）
```
