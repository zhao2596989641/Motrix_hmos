# 第三方许可与致谢（汇总）

> 权威清单在上游文件里，这里只是索引与本项目新增依赖的说明。

## 一、上游（vendor/motrix）

- 主体代码：**MIT** —— `vendor/motrix/LICENSE`（Copyright 2018-present Dr_rOot）
- 上游自己的第三方清单：**`vendor/motrix/THIRD_PARTY_NOTICES.md`**
  - 其中美术资产（设置卡片玻璃图标、Dashboard 速度模式图标等）上游记录为 **NOASSERTION**，
    **不属于 MIT**，二次分发需自行确认或替换。
- 许可证原文目录：**`vendor/motrix/THIRD_PARTY_LICENSES/`**（aria2 GPLv2、OpenSSL、MPL-2.0、各 Rust crate）

## 二、本项目新增/随包分发的二进制（不随仓库分发）

| 组件 | 用途 | 许可 | 说明 |
|---|---|---|---|
| `aria2c`（Motrix aria2 fork v1.37.0-motrix.25） | 下载内核，独立进程（spawn） | **GPL-2.0-or-later** | 分发含此二进制的构建时，需满足 GPL-2.0 源码提供义务；源码地址见 `vendor/motrix/THIRD_PARTY_NOTICES.md` 的 aria2 一节 |
| `libnode.so`（Node.js 24.2.0） | 同进程 Node 运行时 | MIT | 由使用者自行提供，见 `docs/ASSETS.md` |
| `better-sqlite3` | SQLite 持久化 | MIT | 交叉编译产物 |
| `libc++_shared.so` | C++ 运行库（Node / native 模块依赖） | Apache-2.0 WITH LLVM-exception | 来自 HarmonyOS SDK |
| `cacert.pem` | HTTPS 根证书 | MPL-2.0 | 来自 curl CA bundle |
| `motrix-finalize-fs` | 落盘收尾 sidecar | MIT | 源码在 `vendor/motrix/packages/finalize-fs/` |

## 三、实现思路参考（非代码复用）

为避免"看起来像照搬"，这里明确说明：本项目代码为本项目独立实现，**未拷贝**下列项目的源码；
只在公开 API 的用法与交互设计上做了参考（这些也是官方文档/样例里公开的内容）：

- **Clash Verge 的 HarmonyOS 版本**：托盘 `statusBarManager` 三段式交互
  （左键 ArkUI 面板 / 右键跳页菜单）、关窗收托盘（`hideAbility` + 后台 Ability 挂靠）、
  面板玻璃配色与卡片版式。
- **bilibili_hmos**：`quickBarManager`（Dock 图标进度条）的调用方式与节流/错误码处理。
- **上游 Motrix / aria2 / Node.js / better-sqlite3**：运行时与构建方式。

如上述项目作者认为有不妥之处，请联系调整致谢措辞。

## 四、非官方声明

本项目与 Motrix 上游作者、aria2 项目均无隶属关系；不使用官方名义发布，也不代表官方立场。
"Motrix" 名称与上游图标仅用于说明本移植的出处。