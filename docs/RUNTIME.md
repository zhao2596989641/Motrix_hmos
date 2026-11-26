# 端侧 Node 运行时（Motrix 专用）

> 上位文档：[PLAN.md](./PLAN.md)。相关实证：[`share/RESEARCH-RUNTIME-2026-11-24.md`](../../../../share/RESEARCH-RUNTIME-2026-11-24.md)、
> [`share/RESEARCH-SHELL-2026-11-24.md`](../../../../share/RESEARCH-SHELL-2026-11-24.md)。

## 形态

```
EntryAbility (ArkTS)
  └─ MotrixHost.start()
       └─ libmotrixhost.so: startHost(argv, envPairs)      ← NAPI，见 entry/src/main/cpp/motrixhost.cc
            └─ dlopen(<libs>/libnode.so.137, RTLD_GLOBAL) + dlsym("_ZN4node5StartEiPPc")
            └─ std::thread → node::Start(--jitless --experimental-sqlite main.mjs)
                 └─ resfile/app/main.mjs
                      ├─ import dist/server/index.mjs（Motrix server，自动 main()）
                      ├─ spawn <bundle>/libs/arm64/aria2c.bin（Motrix fork 1.37.0-motrix.25，静态）
                      ├─ spawn <bundle>/libs/arm64/motrix-finalize-fs.bin（Rust sidecar）
                      └─ 写 <data>/host-ready.json { pid, port, cookie }
```

## 为什么这样切

| 决定 | 理由（实测） |
|---|---|
| 同进程 `node::Start`，不 fork 一个 node 可执行文件 | HAP 里只有 `libnode.so`，没有独立 node；参考宿主项目 同形态已在真机跑了几十个版本 |
| 不把 libnode 写进 `motrixhost` 的 `DT_NEEDED` | 写进去会被加载器以 RTLD_LOCAL 先载入，之后 dlopen 的 `.node` 解析不到 `napi_*`；musl 下事后 RTLD_GLOBAL 无效 |
| **aria2 用 spawn，不做进程内 addon** | 实测：`child_process.spawn` 在鸿蒙沙箱可用；但随包 ELF 只有放在 HAP `libs/` 并在 `executableBinaryPaths` 里声明才能 exec（el2/resfile 即使自签也 EPERM） |
| 端侧脚本自己登录拿 cookie，ArkTS 只读文件 | ArkTS 侧 `@ohos.net.http` 打 127.0.0.1 会受系统代理影响而超时（参考宿主项目 实测），Node 自己打自己一定通 |
| `--jitless` | 不申请可写可执行内存；代价是 `WebAssembly === undefined` ⇒ 插件系统（QuickJS wasm）不可用 |
| **原生 addon 走 HAP `libs/`** | 沙箱里的 `.node` dlopen 一律被系统拦（`No error information`）；只有 `libs/<abi>/` 放行（见下） |

## 原生库为什么必须走 `libs/`（r6 闪退的直接死因）

r6 真机 `node-output.log` 最后几行：

```
fatal Error: Error loading shared library .../resfile/app/node_modules/better-sqlite3/
  build/Release/better_sqlite3.node: No error information   { code: 'ERR_DLOPEN_FAILED' }
{"msg":"shutting down"}
```

不是缺依赖、也不是没签名（`binary-sign-tool display-sign` 显示 `self-sign` ok）。鸿蒙的判据是
**路径域**：运行时解包到沙箱里的原生库，`dlopen` 被系统拦，报错就是那句没有 errno 的
`No error information`；随 HAP `libs/<abi>/` 提供的才放行（参考宿主项目 真机 E18/E39，同款报错）。

hvigor 又只打包**扁平**的 `libs/<abi>/*.so`（嵌套 `.node` 不进包，参考宿主项目 E40①）。因此：

1. 构建期：`better_sqlite3.node`（device 变体，`DT_NEEDED libnode.so.137`）
   → `entry/libs/arm64-v8a/libbetter_sqlite3.so`（`scripts/build-node-bundle.mjs` 负责）；
   resfile 里**不再放**这个 `.node`。
2. 运行期：`scripts/host/main.mjs` 的 `installNativeRedirect()` 同时接管
   `fs.existsSync` / `Module._extensions['.node']` / `Module._resolveFilename`，
   把"沙箱 `.node` → 平铺 `libbetter_sqlite3.so`"的路径改写掉。
   libsDir 由 `MOTRIX_APP_ROOT` 上四级推导（`<bundle>/libs/arm64`），`MOTRIX_NATIVE_LIBS` 可覆盖。

**兜底层**：Node 的 `process.exit` 与 ArkTS 同进程 ⇒ 上游 fatal 一旦 exit，**整个应用消失**。
`main.mjs` 把 `process.exit` 拦下并写 `host-failed.json`，ArkTS 侧据此直接给错误页
（应用留在前台，能截图、能带回日志）。唯一放行通道是 `host-stop-request` 的正常退出。

## 可执行文件走官方 hap-bin（HNP 已弃用，2026-11-24 实测定案）

r7（spawn resfile 路径）与 r8（spawn `<data>/bin` 物化副本）都死在同一个位置：

```
fatal Error: spawn EPERM
  at NativeFinalizeFilesystemAdapter.startChild (.../dist/server/index.mjs:194:18494)
```

真机 SELinux 策略（`/system/etc/selinux`，2026-11-24 读取）：

| 位置 | label | `debug_hap` 域能否 exec |
|---|---|---|
| 应用数据目录 el2（r8 物化） | `debug_hap_data_file` | **否**（策略只有 `(allow develop_tools_debug_hap debug_hap_data_file (file (execute ...)))`；参考宿主项目 恰好是 develop_tools 域，所以它的本地复现能跑） |
| resfile / HAP el1 | `data_app_el1_file` | 策略允许，但 r7 实测仍 EPERM（mount/模式/签名域因素，未再押注） |
| HNP 公共包 | `hnp_file` | 可以 exec，但**安装器过不去**：debug 普通应用实测 9568409 / 9568407，拿不到安装器日志 |
| HAP `libs/` + `executableBinaryPaths` | `data_app_el1_file` | **可以**（`(allow normal_hap_attr data_app_el1_file (file (execute)))`） |

所以现在走**官方 hap-bin（PC/2in1，API 24+）**：

1. `scripts/build-hap.sh` 把两个可执行文件铺到 `entry/libs/arm64-v8a/`，
   文件名带 `.bin` 后缀：`aria2c.bin`、`motrix-finalize-fs.bin`
   （`nativeLib.collectAllLibs: true` 才会收无 `.so` 后缀的文件；
   `debugSymbol.strip: false` 防止 strip 破坏已签内容）。
2. `module.json5`：
   ```json5
   "extractNativeLibs": true,
   "executableBinaryPaths": [
     { "path": "libs/arm64-v8a/aria2c.bin" },
     { "path": "libs/arm64-v8a/motrix-finalize-fs.bin" }
   ]
   ```
   安装时系统把 `libs/` 解压到 `<bundle>/libs/arm64/`，并给清单里的文件执行属性。
3. `main.mjs` 的 `resolveBundledExecutable()` 优先解析
   `<bundle>/libs/arm64/<name>.bin`（兼容旧的 `<name>`），
   `MOTRIX_ARIA2_BIN` / `MOTRIX_FINALIZE_FS_BIN` 指向解压后的真实路径；
   `materializeExecutable()` 只保留为本地 libnode 复现的兜底（真机上 el2 必 EPERM）。

### 为什么文件名必须带 `.`（9568393 的真正原因）

HAP 签名工具（SDK 自带 C++ `hap-sign-tool`）的 `IsNativeFile()` 对**无扩展名**条目直接返回
false，于是 `aria2c` / `motrix-finalize-fs` 不会进入 HAP 签名块里的
`NativeLibSignInfo`；而安装器 `installd` 的 `GetNativeLibraryFileNames()` 会枚举
`libs/{abi}/` 下**所有**文件。两边数量不一致 ⇒ 安装报：

```
CODE_SIGN: ParseNativeLibSignInfo: Libs signature not found: signMap_ size:5, signMapPreSize:1
BMSInstaller: enable code signature failed: 8519738
hdc: code:9568393 error: verify code signature failed.
```

改名为 `aria2c.bin` / `motrix-finalize-fs.bin` 后，签名块的 native lib 条目从 4 个变 6 个，
与安装器枚举结果一致，`hdc install -r` 通过。**这条与 bin 自身的 `.codesign`
（自签 / 应用证书签）无关**——r12/r13 两种签法都报 9568393，因为它验的是 HAP 级
`NativeLibSignInfo`，不是嵌套 ELF 签名。

## 启动自检（真机没有 DevEco 时的判据）

`main.mjs` 在 import server 之前做一次 spawn 自检，结果同时写日志和
`<SANDBOX_HOME>/spawn-probe.json`：

- 当前 SELinux 域（读 `/proc/self/attr/current`）；
- `system-toybox` / `libs-aria2c` / `libs-finalize-fs` / `el2-*` / `resfile-*`
  六条 spawn 的 status / errno / 前 160 字节输出。

看到 `domain=…debug_hap` 且 `libs-aria2c` / `libs-finalize-fs` 为 `ok`
即说明 hap-bin exec 通道打通；`el2-*` / `resfile-*` 为 `EPERM` 是预期。
若 `libs-*` 是 `ENOENT`，先查 `executableBinaryPaths` 与 `<bundle>/libs/arm64/` 的实际文件名。

## 与 ArkTS 的契约

**输入（`startHost(argv, envPairs)`）**

| env | 含义 |
|---|---|
| `MOTRIX_SANDBOX_HOME` | `context.filesDir`（也用于 `node-output.log`、`host-stop-request`） |
| `MOTRIX_APP_ROOT` | `<resourceDir>/app`（resfile 解出的只读根：`dist/`、`bin/`、`node_modules/`） |
| `MOTRIX_DATA_DIR` | `<filesDir>/motrix`（可写：db/settings/plugins/日志） |
| `MOTRIX_PUBLIC_DOWNLOAD` | 用户可见下载目录 `Download/com.lyldeer.motrix` |
| `MOTRIX_PORT` / `PORT` | 回环端口（默认 21420） |
| `UV_USE_IO_URING` | 必须是 `0`：libuv 的 io_uring 在鸿蒙被 seccomp 杀掉（SIGSYS，syscall 425） |

**输出**

| 文件 | 内容 | 读侧纪律 |
|---|---|---|
| `<data>/host-ready.json` | `{ pid, port, cookie, token, startedAt }` | **必须校验 `pid`**：应用重启窗口里可能读到上一次进程的旧文件，cookie 已失效 |
| `<SANDBOX_HOME>/node-output.log` | Node 的 stdout/stderr | 冷启动截断；原生层 tail 线程转发到 hilog（TAG `MOTRIX-NODELIVE`） |
| `<SANDBOX_HOME>/spawn-probe.json` | 启动自检：SELinux 域 + 六条 spawn 结果 | 排查 exec/hap-bin 问题先看它 |

**停止**：写 `<SANDBOX_HOME>/host-stop-request`，端侧脚本轮询到即 `process.exit(0)`。
`stopHost()` 恒返回 `ok:false` —— 进程内 Node 无法从外部线程停，这比"假装停成功"诚实。

## 构建期依赖（不在仓库里）

| 件 | 来源 | 说明 |
|---|---|---|
| `entry/libs/arm64-v8a/libnode.so.137` | 参考宿主项目 项目（同机已有） | 126MB，Node 24.2.0，`--jitless` 自建版 |
| `entry/libs/arm64-v8a/libbetter_sqlite3.so` | `build/native/device/better_sqlite3.node` | **构建期自动生成**（`build-node-bundle.mjs`）；`DT_NEEDED libnode.so.137`，从 libs/ 加载才不被拦 |
| `entry/libs/arm64-v8a/{aria2c.bin,motrix-finalize-fs.bin}` | `build-hap.sh` 第 4b 步（从 `resfile/app/bin/` 铺入） | **构建期自动生成**；安装到 `<bundle>/libs/arm64/`，由 `executableBinaryPaths` 授予执行属性；**文件名必须带 `.`**（否则 HAP 签名块漏项 → 9568393） |
| `entry/src/main/cpp/node-headers/` | 同上传入 | 编 `motrixhost` 需要；几十 MB，不入库 |
| `resfile/app/bin/aria2c` | 上游 `motrixapp/aria2` release | 静态二进制；打包前用应用证书签（`sign-elf-appcert.sh`） |
| `resfile/app/bin/motrix-finalize-fs` | `packages/finalize-fs` 交叉编译 | 打包前用应用证书签；无 `.codesign` 时 el2/resfile 仍不能 exec |

签名脚本见 [`scripts/sign-host-natives.sh`](../../../../scripts/sign-host-natives.sh)。