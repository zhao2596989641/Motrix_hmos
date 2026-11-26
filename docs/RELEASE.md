# 发布 / 装机清单（HarmonyOS PC）

> 当前仓库只发布**源码**；HAP 由本地构建产出，不随仓库分发。
> 本文给"要出一个能长期用的包"时的检查项。

## 一、构建前

- [ ] `docs/ASSETS.md` 里的 4 个原生件就位（libnode / aria2c / better-sqlite3 / finalize-fs）
- [ ] `vendor/motrix` 依赖已安装，且 `dist/server`、`dist/renderer-web` 是最新（改过 `src/renderer/**` 必须重跑 vite）
- [ ] 签名物料（`.p12 / .cer / .p7b`）填进 `build-profile.json5` 的 `signingConfigs.material`（**别提交**）
- [ ] `AppScope/app.json5` 的 `versionCode` = `1000000 + 轮次号`，`versionName` 跟随上游 `2.4.5.0`
- [ ] 若换了包名：`module.json5` 的 `executableBinaryPaths`、`build-profile.json5` 的 `bundleName`、
      以及签名 profile 都要同步（p7b 绑 bundleName，旧物料直接作废）

## 二、构建

```sh
sh scripts/build-hap.sh          # 产物：entry/build/default/outputs/default/entry-default-signed.hap
```

自检（必做）：

- [ ] `hap-sign-tool verify-app -inFile <hap> -outCertChain /tmp/v.cer -outProfile /tmp/v.p7b` → `hap verify successed!`
- [ ] 包内自检：
  - `libs/arm64-v8a/` 下 4 个原生件都在，且**可执行文件带 `.` 后缀**（`aria2c.bin` / `motrix-finalize-fs.bin`）
  - `resources/resfile/app/main.mjs` 是最新的宿主脚本
  - `resources/resfile/app/dist/renderer-web/assets/` 的 hash 与最近一次前端构建一致
  - `module.json` 的 `versionCode` 正确

## 三、装机验证（clean install 与覆盖安装都要做）

```sh
HDC=/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0/sdk/default/openharmony/toolchains/hdc
$HDC uninstall com.lyldeer.motrix      # clean install 才有意义
$HDC install <hap>
```

- [ ] 首次启动：下载目录 picker 认领成功（`<filesDir>/ability-diag.log` 有 `download dir` 相关记录）
- [ ] 引擎就绪（仪表板 Ready），能完成一次小文件下载（校验 MD5）
- [ ] 托盘图标出现，左键面板、右键菜单可用
- [ ] 关窗 → 收进托盘、后台继续；托盘唤回正常
- [ ] 通知：任务完成有系统横幅；点击能回应用
- [ ] Dock 进度条随下载变化，空闲后消失
- [ ] 深链：`aa start -U "magnet:?xt=…"` 能建任务；文件管理器「打开方式」能打开 `.torrent`
- [ ] 设置：7 张卡片（无"集成"）、侧边栏无"插件"、关于页有 `HarmonyOS Port rNN` 徽章
- [ ] 关于页版本号 + 应用信息里的 versionCode 与预期一致
- [ ] 权限弹窗：下载目录 / 文档目录只在你主动选目录时出现

## 四、发布合规（开源与二进制）

- [ ] 源码仓库保留上游 `vendor/motrix/LICENSE` / `THIRD_PARTY_NOTICES.md` / `THIRD_PARTY_LICENSES/`
- [ ] HAP 里含 `aria2c`（GPL-2.0-or-later）：发布安装包时同时提供
      - aria2 fork 源码地址（见 `vendor/motrix/THIRD_PARTY_NOTICES.md`）
      - 许可文本（`THIRD_PARTY_LICENSES/aria2-COPYING`）
- [ ] `libnode`（MIT）、`better-sqlite3`（MIT）、`libc++_shared.so`（Apache-2.0 WITH LLVM-exception）、
      `cacert.pem`（MPL-2.0）的声明齐全（仓库 `docs/THIRD-PARTY.md`）
- [ ] 上游 `NOASSERTION` 美术资产：不要单独再许可；如需商用请替换
- [ ] 非官方声明：README 与关于页都不要暗示官方发布

## 五、版本记录

每出一版：`docs/CHANGELOG.md` 加一节（改了什么 / 真机验证结果 / 已知问题），
`git tag vX.Y.Z-harmonyos`。仓库里同时保留 `docs/FEATURE-MATRIX.md` 的逐项状态。