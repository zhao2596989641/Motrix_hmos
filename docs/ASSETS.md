# 原生资产（不进仓库，但构建 HAP 必须）

> 这些文件太大或需要在特定环境交叉编译，因此不提交到 git。
> 每个文件放到位后，`entry/libs/arm64-v8a/` 与 `build/bin/` 里各有约定名字；文件名**必须带 `.`**
> （例如 `aria2c.bin`），否则安装器会报 `9568393 verify code signature failed`（见 docs/RUNTIME.md）。

## 1. libnode.so.137（Node.js 24.2.0，`--jitless`）

- 作用：同进程嵌入的 Node 运行时；`libmotrixhost.so` 通过 `dlopen` + `node::Start` 在子线程启动它。
- 许可：Node.js 为 MIT。
- 来源：HarmonyOS 上可用的 libnode 构建（本移植使用自己在另一嵌入式 Node 宿主项目中验证过的构建产物）。
  Node.js 官方并不发布 HarmonyOS 预编译库，你需要自行准备一个可用的 `libnode.so`（Node 24.2.x，
  带 `--jitless` 可用），并保证它依赖的 `libc++_shared.so` 等库可从 `libs/arm64-v8a/` 解析。
- 放置位置：`entry/libs/arm64-v8a/libnode.so.137`
- 参考校验值（本项目实测）：`md5 685f1099c1fcfeeb8051dadae41c9dae`，大小 ≈ 126 MB。

## 2. aria2c.bin（Motrix 的 aria2 fork：v1.37.0-motrix.25）

- 作用：下载内核，由 Node 侧 `child_process.spawn` 起进程（RPC 模式）。
- 许可：**GPL-2.0-or-later**（aria2 自身）。完整文本见 `vendor/motrix/THIRD_PARTY_LICENSES/aria2-COPYING`；
  源码：<https://github.com/motrixapp/aria2/tree/v1.37.0-motrix.25>。
- 获取：从上游 fork 自行交叉编译（aarch64-linux-ohos，静态链接，启用 Async DNS / SQLite3-Persistence / Metalink），
  或从你信任的 Motrix 桌面发行版中取同版本二进制。
- 放置位置：`entry/libs/arm64-v8a/aria2c.bin`
- 参考校验值：`md5 41e1ead33dbff9a87692d87a2ffa4480`，大小 ≈ 11 MB。
- 注意：**可执行 ELF 需要签名**（`binary-sign-tool -selfSign 1` 或本项目 `scripts/sign-elf.sh`），否则 `execve` 被拒。

## 3. motrix-finalize-fs.bin（Rust sidecar）

- 作用：下载落盘的最后一公里（原子 rename / 校验 / 目录收尾）。
- 许可：MIT（源码就在 `vendor/motrix/packages/finalize-fs/`）。
- 构建：`sh scripts/build-finalize-fs.sh`（交叉编译到 `aarch64-unknown-linux-ohos`）。
- 放置位置：`entry/libs/arm64-v8a/motrix-finalize-fs.bin`
- 参考校验值：`md5 13a627c047cf4ddc137d089da0d63bd9`，大小 ≈ 570 KB。

## 4. better-sqlite3 原生模块

- 作用：任务/设置持久化（SQLite）。Node 侧以 `require('better-sqlite3')` 使用。
- 许可：MIT。
- 构建：`sh scripts/build-better-sqlite3.sh`（`entry/libs/arm64-v8a/libbetter_sqlite3.so`，
  运行期由宿主脚本把 `.node` 请求重定向到该 `.so`，见 `scripts/host/main.mjs` 的 `installNativeRedirect`）。
- 放置位置：`entry/libs/arm64-v8a/libbetter_sqlite3.so`
- 参考校验值：`md5 40ec2b6ab25ef1fc3c12bce246ac847b`，大小 ≈ 1.7 MB。

## 5. 前端 / 服务端产物

- `resfile/app/bin/` 自 r39 起**不再打包**（端侧只执行 `entry/libs/arm64-v8a/*.bin`，少 11.5MB）；
  需要旧行为时构建前设 `MOTRIX_RESFILE_BIN=1`。
- `vendor/motrix/dist/server/index.mjs`、`vendor/motrix/dist/renderer-web/`：
  由 `vendor/motrix` 的 vite 配置构建（命令见 README）。`scripts/build-hap.sh` 会把它们拷进
  `entry/src/main/resources/resfile/app/`。
- `cacert.pem`：随包的 CA 根证书（aria2 的 HTTPS 需要），来自 curl 项目的 CA bundle（MPL-2.0）。

## 6. 签名物料

- `build-profile.json5` 的 `signingConfigs.material` 指向你本机的 `.p12/.cer/.p7b`；
  **不要把这些文件提交进仓库**（`.gitignore` 已排除）。
- 首次使用可在 DevEco Studio 里生成自动签名，或按 `docs/BUILD.md` 用 CLI 生成并把路径填进 `build-profile.json5`。