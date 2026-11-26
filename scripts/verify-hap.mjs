#!/usr/bin/env node
// HAP 出包自检（r47）
//
// 为什么需要：每轮出包前手工要核对的东西（签名、libs 里 6 个原生件、可执行文件必须带 `.bin`、
// resfile/app 的 main.mjs 是否最新、renderer 产物、module.json 的版本号）加起来十几项，
// 漏一项就可能白跑一轮真机。这里一次跑完，失败会列出**具体哪项不对**。
//
// 用法：
//   node scripts/verify-hap.mjs                            # 校验默认产物 + 对照 AppScope/app.json5
//   node scripts/verify-hap.mjs <hap>                      # 校验指定包
//   node scripts/verify-hap.mjs <hap> --expect-version-code 240500047
//   node scripts/verify-hap.mjs <hap> --skip-signature     # 只做内容自检（签名工具不可用时）
//
// 依赖：`unzip`、`hap-sign-tool`（默认取 CLT），可用环境变量覆盖：
//   UNZIP=/path/to/unzip  HAP_SIGN_TOOL=/path/to/hap-sign-tool
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLT = process.env.CLT || '/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0'
const UNZIP = process.env.UNZIP || 'unzip'
const SIGN_TOOL =
  process.env.HAP_SIGN_TOOL ||
  path.join(CLT, 'sdk/default/openharmony/toolchains/lib/hap-sign-tool')

const args = process.argv.slice(2)
const flags = new Map()
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a.startsWith('--')) {
    if (a === '--skip-signature') flags.set(a, true)
    else flags.set(a, args[++i])
  } else positional.push(a)
}

const hapPath = path.resolve(
  positional[0] ||
    path.join(ROOT, 'entry/build/default/outputs/default/entry-default-signed.hap')
)

const failures = []
const warnings = []
const infos = []

function fail(message) {
  failures.push(message)
  console.log(`  ✗ ${message}`)
}
function warn(message) {
  warnings.push(message)
  console.log(`  ! ${message}`)
}
function ok(message) {
  console.log(`  ✓ ${message}`)
}

function run(command, args) {
  return execFileSync(command, args, {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'buffer',
  })
}

function unzip(args) {
  return run(UNZIP, args)
}

/** `unzip -l` 的条目清单（只取名与大小；HAP 里的条目名不含空格） */
function listEntries(hap) {
  const out = unzip(['-l', hap]).toString('utf8')
  const entries = []
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/)
    if (!m) continue
    entries.push({ size: Number(m[1]), name: m[2].trim() })
  }
  return entries
}

function readEntry(hap, name) {
  try {
    return unzip(['-p', hap, name])
  } catch {
    return null
  }
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex')
}

/** AppScope/app.json5 是 JSON5（有 // 注释）；这里只需要两个字段，宽松去注释即可 */
function readAppScopeVersion() {
  const text = fs.readFileSync(path.join(ROOT, 'AppScope/app.json5'), 'utf8')
  const stripped = text
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  const code = stripped.match(/"versionCode":\s*(\d+)/)
  const name = stripped.match(/"versionName":\s*"([^"]+)"/)
  const bundle = stripped.match(/"bundleName":\s*"([^"]+)"/)
  return {
    versionCode: code ? Number(code[1]) : null,
    versionName: name ? name[1] : null,
    bundleName: bundle ? bundle[1] : null,
  }
}

// ── 0. 文件存在 ───────────────────────────────────────────────────────────────
console.log(`HAP: ${hapPath}`)
if (!fs.existsSync(hapPath)) {
  console.error(`!! 找不到 HAP：${hapPath}`)
  process.exit(2)
}
const stat = fs.statSync(hapPath)
const hapMd5 = md5(fs.readFileSync(hapPath))
console.log(`大小: ${stat.size} B  MD5: ${hapMd5}`)

// ── 1. 包内清单 ───────────────────────────────────────────────────────────────
console.log('\n[1] 包内原生件（libs/arm64-v8a）')
const entries = listEntries(hapPath)
const names = new Set(entries.map((e) => e.name))

const requiredLibs = [
  'libnode.so.137',
  'libbetter_sqlite3.so',
  'libc++_shared.so',
  'libmotrixhost.so',
  'aria2c.bin',
  'motrix-finalize-fs.bin',
]
const libPrefix = 'libs/arm64-v8a/'
for (const lib of requiredLibs) {
  if (names.has(libPrefix + lib)) ok(lib)
  else fail(`缺 ${libPrefix}${lib}`)
}
// 可执行文件必须带 `.bin`：hap-sign-tool 的 IsNativeFile 会跳过无扩展名条目，
// 装包时 installd 又枚举目录内全部文件 ⇒ 签名条目数对不上 → 9568393。
for (const bare of ['aria2c', 'motrix-finalize-fs']) {
  if (names.has(libPrefix + bare)) {
    fail(`存在无后缀可执行文件 ${libPrefix}${bare}（会导致安装 9568393）`)
  }
}

console.log('\n[2] resfile/app 布局')
if (names.has('resources/resfile/app/main.mjs')) {
  const inHap = readEntry(hapPath, 'resources/resfile/app/main.mjs')
  const onDisk = fs.readFileSync(path.join(ROOT, 'scripts/host/main.mjs'))
  if (inHap && md5(inHap) === md5(onDisk)) {
    ok('main.mjs 与 scripts/host/main.mjs 一致')
  } else {
    fail('main.mjs 与 scripts/host/main.mjs 不一致（是否忘了重新构建 resfile？）')
  }
} else {
  fail('缺 resources/resfile/app/main.mjs')
}

const resfileBinEntries = [...names].filter((n) =>
  n.startsWith('resources/resfile/app/bin/')
)
if (resfileBinEntries.length === 0) {
  ok('resfile/app/bin 未随包（r46 起省约 11MB，符合预期）')
} else {
  warn(`resfile/app/bin 有 ${resfileBinEntries.length} 个条目（仅本地 repro 需要）`)
}

const resfileModules = [...names].filter((n) =>
  n.startsWith('resources/resfile/app/node_modules/')
)
if (resfileModules.length > 100) ok(`resfile/app/node_modules 条目 ${resfileModules.length} 个`)
else fail(`resfile/app/node_modules 条目过少（${resfileModules.length}）`)

for (const required of ['cacert.pem', 'extra/aria2.conf', 'jitless-shim.mjs']) {
  const hit = [...names].some(
    (n) => n === `resources/resfile/app/${required}` || n.endsWith(`/${required}`)
  )
  if (hit) ok(`resfile/app/${required}`)
  else warn(`缺 resfile/app/${required}`)
}

console.log('\n[3] 渲染层产物')
const rendererAssets = entries
  .map((e) => e.name)
  .filter((n) => n.startsWith('resources/resfile/app/dist/renderer-web/assets/'))
const appRootAssets = rendererAssets.filter((n) => /app-root-.*\.js$/.test(n))
const indexAssets = rendererAssets.filter((n) => /\/index-.*\.js$/.test(n))
if (appRootAssets.length === 1) ok(`renderer app-root: ${path.basename(appRootAssets[0])}`)
else warn(`renderer app-root 数量异常：${appRootAssets.length}`)
if (indexAssets.length >= 1) ok(`renderer index: ${indexAssets.map((n) => path.basename(n)).join(', ')}`)
else warn('renderer index-*.js 缺失')
const stateAssets = rendererAssets.filter((n) => /\.css$/.test(n))
if (stateAssets.length >= 1) ok(`renderer css: ${stateAssets.length} 个`)
else warn('renderer CSS 缺失')

// ── 2. module.json ────────────────────────────────────────────────────────────
console.log('\n[4] module.json 元数据')
let moduleJson = null
for (const candidate of ['module.json', 'pack.info']) {
  if (names.has(candidate)) {
    const buf = readEntry(hapPath, candidate)
    if (candidate === 'module.json' && buf) {
      try {
        moduleJson = JSON.parse(buf.toString('utf8'))
      } catch (error) {
        warn(`module.json 解析失败：${error.message}`)
      }
    }
  }
}
const expected = readAppScopeVersion()
if (moduleJson && moduleJson.app) {
  const app = moduleJson.app
  const checks = [
    ['bundleName', app.bundleName, flags.get('--expect-bundle') || expected.bundleName],
    [
      'versionCode',
      app.versionCode,
      flags.get('--expect-version-code')
        ? Number(flags.get('--expect-version-code'))
        : expected.versionCode,
    ],
    [
      'versionName',
      app.versionName,
      flags.get('--expect-version-name') || expected.versionName,
    ],
  ]
  for (const [label, actual, want] of checks) {
    if (want === null || want === undefined) {
      warn(`${label} 无法从源码推导（实际 ${actual}）`)
    } else if (String(actual) === String(want)) {
      ok(`${label} = ${actual}`)
    } else {
      fail(`${label} = ${actual}（期望 ${want}）`)
    }
  }
  const minApi = app.minAPIVersion
  if (minApi === undefined || minApi >= 260000026) ok(`minAPIVersion = ${minApi}`)
  else warn(`minAPIVersion = ${minApi}（本项目目标 26.0.0）`)
} else {
  warn('包里没有可解析的 module.json')
}

// 徽章轮次（编译进 ets/modules.abc，只能做存在性抽查）——从 Index.ets 注入脚本里读，别写死
function readPortVersion() {
  try {
    const text = fs.readFileSync(
      path.join(ROOT, 'entry/src/main/ets/pages/Index.ets'),
      'utf8'
    )
    const m = text.match(/state\.portVersion\s*=\s*'([^']+)'/)
    return m ? m[1] : null
  } catch {
    return null
  }
}
const appScopeBadge = readPortVersion() || 'r?'
const moduleAbc = entries.find((e) => e.name.endsWith('modules.abc'))
if (moduleAbc) {
  const buf = readEntry(hapPath, moduleAbc.name)
  if (buf && buf.includes(Buffer.from(appScopeBadge, 'utf8'))) {
    ok(`ets/modules.abc 含移植轮次字符串 ${appScopeBadge}`)
  } else {
    warn(`ets/modules.abc 未找到 ${appScopeBadge}（徽章可能没更新）`)
  }
}

// ── 3. 签名 ──────────────────────────────────────────────────────────────────
console.log('\n[5] HAP 签名')
if (flags.get('--skip-signature')) {
  warn('已按 --skip-signature 跳过')
} else if (!fs.existsSync(SIGN_TOOL)) {
  warn(`找不到 hap-sign-tool：${SIGN_TOOL}（可用 HAP_SIGN_TOOL 指定）`)
} else {
  const tmpCert = path.join(os.tmpdir(), `verify-${process.pid}.cer`)
  const tmpProfile = path.join(os.tmpdir(), `verify-${process.pid}.p7b`)
  try {
    const out = run(SIGN_TOOL, [
      'verify-app',
      '-inFile',
      hapPath,
      '-outCertChain',
      tmpCert,
      '-outProfile',
      tmpProfile,
    ]).toString('utf8')
    if (out.includes('verify-app success') || out.includes('hap verify successed')) {
      ok('verify-app successed')
    } else {
      fail(`签名校验输出异常：${out.split('\n').slice(-2).join(' ')}`)
    }
  } catch (error) {
    fail(`签名校验失败：${String(error.message ?? error).split('\n')[0]}`)
  } finally {
    for (const file of [tmpCert, tmpProfile]) {
      try {
        fs.rmSync(file, { force: true })
      } catch {}
    }
  }
}

// ── 4. 汇总 ──────────────────────────────────────────────────────────────────
console.log('\n── 汇总 ──')
infos.push(`MD5 ${hapMd5}`, `${(stat.size / 1024 / 1024).toFixed(1)} MiB`)
console.log(infos.join(' · '))
if (warnings.length > 0) {
  console.log(`警告 ${warnings.length} 项（不阻断）：`)
  for (const w of warnings) console.log(`  · ${w}`)
}
if (failures.length > 0) {
  console.log(`\n❌ 自检失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('\n✅ HAP 自检通过')