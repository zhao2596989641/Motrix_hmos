# Motrix for HarmonyOS PC（非官方移植）

把 [Motrix Turbo 2.4.5](https://github.com/agalwood/Motrix)（Electron + React + Node 的现代下载管理器）
移植到 **HarmonyOS PC（2in1 / aarch64 / API 26）** 的原生 HAP。

> ⚠️ **非官方**：本项目是个人移植成果，与 Motrix 上游作者无关，不使用官方名义发布；
> 上游代码为 MIT，本项目在其基础上做平台适配（见 [LICENSE](LICENSE)）。

---

## 它长什么样 / 怎么工作

HarmonyOS 上没有可用的 Electron 运行时，因此采用「**复用官方 Web UI + 复刻官方 headless server**」的路线：

```
┌──────────────────────── HAP: com.lyldeer.motrix ─────────────────────────┐
│ ArkTS 壳（EntryAbility / pages/Index）                                    │
│   · 窗口 + 沉浸式标题栏（隐藏系统 decor、三键下移、自绘拖拽）              │
│   · ArkWeb 加载 http://127.0.0.1:<port>/ —— 与 server 同源，官方 Web UI    │
│   · 系统托盘（左键 ArkUI 面板 / 右键菜单）、系统通知、Dock 进度条           │
│   · 深链（magnet:）与 .torrent 文件关联                                   │
│   · libmotrixhost.so（NAPI 引导）→ 同进程 dlopen libnode.so.137           │
│         └─ node --jitless resfile/app/main.mjs                           │
│              ├─ 启动官方 dist/server/index.mjs（fastify，Web UI 后端）     │
│              ├─ spawn aria2c.bin（Motrix aria2 fork）                     │
│              └─ spawn motrix-finalize-fs（Rust sidecar）                  │
└──────────────────────────────────────────────────────────────────────────┘
```

**没有 fork 上游业务代码**：`vendor/motrix/` 是上游快照，平台相关改动集中在
`entry/`（ArkTS/C++）与 `scripts/`（构建/宿主）；少量上游补丁（约 20 个文件）带中文注释，
用于服务端适配与 UI 平台值注入。

## 已实现的功能

- 下载：HTTP/HTTPS/FTP、磁力、`.torrent`；暂停/继续/删除/重试/批量操作
- 任务持久化（SQLite，重启恢复）、设置持久化、后台保活（长时任务）
- 引擎：随包 aria2 fork 进程，启动/重启/诊断/端口冲突处理、孤儿进程清理
- 界面：官方 Web UI 全功能页面（仪表板/下载/BT/Tracker/通知/设置）+ 深色/中英双语
- 桌面集成：
  - 沉浸式标题栏 + 拖拽移动（最大化时禁用）+ 三键避让
  - 系统托盘：左键 **ArkUI 面板**（网速图 / 任务概览 / 任务列表逐条暂停·继续·重试·取消）、右键菜单跳页
  - 关窗收进托盘（后台继续下载）、托盘唤回
  - 系统通知（完成/失败，服务信息分类）、点击回到应用
  - Dock/任务栏图标下载进度条
  - 深链 `magnet:?xt=…`、文件管理器「打开方式」打开 `.torrent`
  - 在文件夹中显示 / 打开文件 / 外链用系统浏览器
- 已知限制：**插件系统不可用**（`--jitless` 下无 WebAssembly，QuickJS 跑不起来）；
  UPnP/NAT-PMP、完成后关机、浏览器扩展配对等 Electron 专属能力不提供。

功能矩阵与逐项验收记录见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

## 目录结构

```
entry/                    HAP entry 模块
  src/main/ets/           ArkTS 壳（entryability / pages / runtime / tray）
  src/main/cpp/           libmotrixhost.so（dlopen libnode + 线程里 node::Start）
  src/main/resources/     HAP 资源（resfile/ 由构建脚本生成，不进仓库）
  libs/arm64-v8a/         随包原生件（不进仓库，见 docs/ASSETS.md）
vendor/motrix/            上游 Motrix Turbo 2.4.5 快照（MIT）+ 本项目补丁
scripts/                  构建 / 签名 / 宿主 / 交叉编译 / 调试工具
docs/                     构建、运行时、资产、第三方许可、变更记录
```

## 构建

前置：HarmonyOS SDK（API 26）+ hvigor、Node.js 24+、aarch64 交叉编译工具链（`clang`）。
完整步骤见 **[docs/BUILD.md](docs/BUILD.md)**；需要先按 **[docs/ASSETS.md](docs/ASSETS.md)**
准备 3 个不进仓库的原生件（`libnode.so.137` / `aria2c.bin` / `motrix-finalize-fs.bin`）
与前端/服务端产物，然后：

```sh
# 1) 首次：安装 vendor 依赖并构建 Web/服务端产物
cd vendor/motrix && pnpm install
node --require ./scripts/fakeplat.cjs node_modules/vite/bin/vite.js build --config vite.server.config.ts
node --require ./scripts/fakeplat.cjs node_modules/vite/bin/vite.js build --config vite.renderer.web.config.ts

# 2) 交叉编译 sidecar + native 模块（可选，见 docs/ASSETS.md）
sh scripts/build-better-sqlite3.sh
sh scripts/build-finalize-fs.sh

# 3) 组装 + 签名 HAP
cd ../.. && sh scripts/build-hap.sh
```

> 脚本里有若干机器相关的绝对路径（SDK、签名物料），首次使用请按 `docs/BUILD.md` 改成你自己的。

## 许可与声明

- **上游 Motrix**：MIT（`vendor/motrix/LICENSE`，Copyright 2018-present Dr_rOot）。
  MIT 允许修改、移植、再分发，但要求保留版权与许可声明 —— 本仓库完整保留上游
  `LICENSE` / `THIRD_PARTY_NOTICES.md` / `THIRD_PARTY_LICENSES/`。
- **本项目（移植部分）**：MIT，见根目录 [LICENSE](LICENSE)。
- **上游第三方资产**：上游明确列出部分美术资产为 `NOASSERTION`（不属 MIT），
  详见 `vendor/motrix/THIRD_PARTY_NOTICES.md`；若二次分发请自行确认或替换。
- **随构建分发的二进制**：`aria2c` 为 **GPL-2.0-or-later**（Motrix 的 aria2 fork），
  `libnode.so` 为 Node.js（MIT），`better-sqlite3`（MIT），`libc++_shared.so`
  （Apache-2.0 WITH LLVM-exception），`cacert.pem`（MPL-2.0）。
  这些二进制**不随仓库分发**，只由构建流程产出；发布含 aria2 的构建时请满足 GPL-2.0 的源码提供义务。
  详见 [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md)。

## 致谢

- [Motrix](https://github.com/agalwood/Motrix)（upstream）—— 本项目的基础与 UI
- [aria2](https://github.com/aria2/aria2) 与 Motrix 的 aria2 fork
- [Node.js](https://nodejs.org/) / [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

## 免责声明

本项目为个人学习与自用性质的开源移植，按 MIT「AS IS」提供，不保证稳定与数据安全。
使用前请自行备份；由此产生的下载内容、版权与合规问题由使用者自行负责。