# 构建与装机（HarmonyOS PC）

> 上位文档：[PLAN.md](./PLAN.md) · [RUNTIME.md](./RUNTIME.md)

## 0. 本机工具链（实测路径，别猜）

| 件 | 路径 | 版本 |
|---|---|---|
| CLT 根 | `/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0` | — |
| hvigor | `<CLT>/hvigor/bin/hvigorw.js` | 7.26.11 |
| node（编 HAP 用） | `<CLT>/node/bin/node` | v24.18.1 |
| SDK | `<CLT>/sdk/default` | API 26 / 26.0.0.105 |
| OHOS NDK | `<CLT>/sdk/default/openharmony/native` | llvm 15 |
| 签名工具 | `<CLT>/sdk/default/openharmony/toolchains/lib/binary-sign-tool` | — |
| Rust | `brew` 的 1.100.0（自带 `aarch64-unknown-linux-ohos`） | — |

> 注意：brew 里也有一份 `ohos-sdk`（26.0.0.18_2），但它的 `lld` 缺 `libxml2.so.16`，
> 一链接就挂。**一律用 CLT 那套**。`scripts/hmos-env.sh` 已经把路径定死。

## 1. 一次性准备

### 1.1 依赖安装（上游 npm 依赖 + 前端/服务端产物）

```bash
cd codes/MotrixOHOS/vendor/motrix
# 1) 用 linux 平台伪装跑 pnpm（rolldown/lightningcss/esbuild 的原生包按平台选，
#    而本机 process.platform = openharmony，会去找不存在的 openharmony-arm64 包）
cat > /tmp/motrix-fakeplat.cjs <<'EOF'
try { Object.defineProperty(process,'platform',{value:'linux',configurable:true,writable:true}) } catch(e) {}
try { Object.defineProperty(process,'arch',{value:'arm64',configurable:true,writable:true}) } catch(e) {}
EOF
node --require /tmp/motrix-fakeplat.cjs \
  <harmonybrew>/Cellar/pnpm/11.26.0_1/libexec/lib/node_modules/pnpm/bin/pnpm.mjs \
  install --ignore-scripts --no-frozen-lockfile

# 2) 把 node_modules 里的原生件全部自签名（否则 dlopen/exec 一律 EACCES）
sh ../../scripts/sign-host-natives.sh

# 3) 构建三段产物（同样要伪装平台）
for c in vite.renderer.web.config.ts vite.server.config.ts vite.worker.config.ts; do
  node --require /tmp/motrix-fakeplat.cjs node_modules/vite/bin/vite.js build --config $c
done
```

> **为什么 `--ignore-scripts`**：postinstall 会去 rebuild 面向 Electron ABI 的
> better-sqlite3、下载 aria2 二进制；两者我们都不用（自己交叉编译 / 用官方 fork）。
> **为什么原生件必须签名**：HarmonyOS 判"能不能 dlopen/exec"看的是代码签名，
> 未签名一律 `Permission denied`（2026-11-24 实测，见 share/ 下的调研报告）。

### 1.2 两个上游二进制

| 件 | 来源 | 落地 |
|---|---|---|
| `aria2c`（Motrix fork 1.37.0-motrix.25，linux-arm64 静态版） | `https://github.com/motrixapp/aria2/releases/download/v1.37.0-motrix.25/aria2c-1.37.0-motrix.25-linux-arm64.tar.gz` | `build/bin/aria2c`（脚本会自动签名） |
| `motrix-finalize-fs`（Rust sidecar） | 本仓交叉编译：`sh scripts/build-finalize-fs.sh` | `build/bin/motrix-finalize-fs` |

> 这个 fork 版 aria2 带 **Async DNS + SQLite3-Persistence + Metalink**，
> 上游 `Aria2ConfigBuilder` 需要的选项它全有（stock 1.37 缺 `--async-dns`，会直接起不来）。

### 1.3 签名物料

> 仓库里的 `build-profile.json5` 是**占位符**（签名口令/路径已抹掉）。
> 本机真实物料存成 `build-profile.local.json5`（已 gitignore），构建前跑：
> `sh scripts/apply-local-signing.sh`；提交前 `git checkout -- build-profile.json5` 还原。
（**必须项目作者在 DevEco 做一次**）

`.p7b` 调试 profile 里写死了 `bundleName` 与设备 UDID，**不能从别的工程复用**：
换包名会报 `00303074`。做法：

1. DevEco Studio 打开 `codes/MotrixOHOS`；
2. File → Project Structure → Signing Configs → 勾 "Automatically generate signature"（需登录 + 连设备）；
3. 完成后 `build-profile.json5` 的 `signingConfigs` 里会出现 material 四路径 + 两个加密口令。

**顺序要求**：先写 `module.json5` 的 `requestPermissions`，再做自动签名
（签名 profile 会按声明的权限申请受限 ACL，顺序反了会出现"权限写了但装不上"）。

## 2. 出包

```bash
cd codes/MotrixOHOS
sh scripts/build-hap.sh            # debug
sh scripts/build-hap.sh release    # release
```

脚本顺序（不能乱）：交叉编译 better-sqlite3 → 交叉编译 finalize-fs →
组装 `resfile/app` → **签名 resfile 里的原生二进制** → `hvigorw assembleHap`。

> 签名必须在打包之前：HAP 组装后再改包内字节会破坏 HAP 签名。

产物：`entry/build/default/outputs/default/entry-default-signed.hap`

## 3. 装机与看日志

```bash
CLT=/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0
HDC=$CLT/sdk/default/openharmony/toolchains/hdc
$HDC install -r entry/build/default/outputs/default/entry-default-signed.hap
```

> **必须用 `-r` 覆盖安装**：el2（用户数据）里的下载任务库/设置不能被清掉。

日志（端侧 Node 的 stdout/stderr 全部落到文件，原生层再转发 hilog）：

```bash
# Node 侧输出（最有信息量）
$HDC shell "cat /data/app/el2/100/base/com.lyldeer.motrix/haps/entry/files/node-output.log" | tail -50
# 宿主交接文件（端口 + 会话 cookie 是否拿到）
$HDC shell "cat /data/app/el2/100/base/com.lyldeer.motrix/haps/entry/files/motrix/host-ready.json"
# hilog：原生引导 / Web 壳
$HDC shell hilog -T MOTRIX-SHIM,MOTRIX-NODELIVE,MOTRIX-HOST,MOTRIX-WEB -x
```

## 4. 已知坑（构建期）

| 现象 | 原因 | 处置 |
|---|---|---|
| `Permission denied` 执行任何原生件 | 未签名（或 OHOS clang 留的**占位** `.codesign` 不被认可） | `sh scripts/sign-elf.sh <elf>`（先剥段再签） |
| `Cannot find module './rolldown-binding.openharmony-arm64.node'` | rolldown 按 `process.platform` 选原生包 | 构建期用 `/tmp/motrix-fakeplat.cjs` 伪装 linux |
| `libgcc_s.so.1` not found（lightningcss） | Alpine 版 prebuild 依赖 GCC 运行时 | 用 `patchelf --replace-needed libgcc_s.so.1 libc++_shared.so` 改写 + 重签名 |
| `XML` 符号缺失 / `Error loading shared library libxml2.so.16` | brew 的 `ohos-sdk` lld 坏了 | 一律用 CLT 的 clang/lld |
| cargo 编一半 `Operation not permitted` 执行 build script | build-script 是未签名 ELF | `RUSTC_WRAPPER=scripts/toolchain/rustc-sign-wrapper.sh` |
| cargo `dlopen failed: libserde_derive-*.so: Permission denied` | proc-macro 产物同样要签名 | 同上（wrapper 现在也签 `.so`） |
| `00303074 bundleName ... does not match SigningConfigs` | 用了别人的 p7b | 在 DevEco 重新自动签名 |