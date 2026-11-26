// 构建期把 process.platform/arch 伪装成 linux/arm64。
//
// 为什么需要：vendor/motrix 的 vite 构建脚本会按 process.platform 判定目标平台，
// 在 HarmonyOS（process.platform === 'openharmony'）上会走进不存在的分支 / 抛错。
// 用法（在 vendor/motrix 下）：
//   node --require ../../scripts/fakeplat.cjs node_modules/vite/bin/vite.js build --config vite.server.config.ts
try {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, writable: true })
} catch (error) {}
try {
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true, writable: true })
} catch (error) {}
