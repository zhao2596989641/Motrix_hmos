#!/usr/bin/env node
// 把 DevEco 最新一次签名配置里的口令同步进 build-profile.local.json5。
//
// 背景（r51 踩坑）：在 DevEco 里点「自动签名」会**重新生成**密钥库（p12）与新口令，
// 并写进 build-profile.json5；而仓库里那份是占位符，本机靠 build-profile.local.json5 出包。
// 一旦 DevEco 重新签名，本地这份的旧口令就对不上新 p12 ⇒ sign-elf-appcert 报
// `KEYSTORE_PASSWORD_ERROR, code: -115`（HAP 签名与 ELF 签名都会挂）。
// DevEco 把最新口令留在 `.hvigor/outputs/sync/output.json` 里，这里读它来同步。
//
// 用法：node scripts/refresh-local-signing.mjs            # 有更新就写回 local 文件
//      node scripts/refresh-local-signing.mjs --check    # 只检查（退出码 1 = 不同步）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SYNC = path.join(ROOT, '.hvigor/outputs/sync/output.json')
const LOCAL = path.join(ROOT, 'build-profile.local.json5')

if (!fs.existsSync(SYNC)) {
  console.error(`!! 找不到 ${path.relative(ROOT, SYNC)}（DevEco 至少同步过一次项目才会有）`)
  process.exit(2)
}
if (!fs.existsSync(LOCAL)) {
  console.error('!! 找不到 build-profile.local.json5（先按 docs/BUILD.md 建一份）')
  process.exit(2)
}

const sync = JSON.parse(fs.readFileSync(SYNC, 'utf8'))
function findMaterial(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 8) return null
  if (node.storePassword && node.keyPassword && node.storeFile) return node
  for (const value of Object.values(node)) {
    const hit = findMaterial(value, depth + 1)
    if (hit) return hit
  }
  return null
}
const material = findMaterial(sync)
if (!material) {
  console.error('!! sync/output.json 里找不到 signingConfigs.material')
  process.exit(2)
}

const text = fs.readFileSync(LOCAL, 'utf8')
const next = text
  .replace(/("storePassword":\s*")[^"]*(")/, `$1${material.storePassword}$2`)
  .replace(/("keyPassword":\s*")[^"]*(")/, `$1${material.keyPassword}$2`)

const changed = next !== text
if (!changed) {
  console.log('[local-signing] build-profile.local.json5 已是最新口令')
  process.exit(0)
}
if (process.argv.includes('--check')) {
  console.log('[local-signing] 口令不同步：请运行 node scripts/refresh-local-signing.mjs')
  process.exit(1)
}
fs.writeFileSync(LOCAL, next)
console.log('[local-signing] 已从 DevEco 同步最新的 storePassword / keyPassword 到 build-profile.local.json5')
