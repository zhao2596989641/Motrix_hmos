#!/usr/bin/env node
// 按环境开关解注/注释 module.json5 里的**受限 ACL 权限**条目。
//
// 为什么需要开关：受限权限（system_basic）必须先在签名 profile 里拿到 ACL，
// **拿到 ACL 之后才能在清单里声明**；没 ACL 却声明会导致应用安装失败。
//
// 目前两块：
//   · jit       ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY（V8 JIT/WASM，r50 已获批）
//   · user-file ohos.permission.READ_WRITE_USER_FILE（PC/2in1 用户目录读写，给集成里的 CLI 工具用）
//
// 用法：
//   node scripts/patch-module-permissions.mjs status
//   node scripts/patch-module-permissions.mjs enable  [jit|user-file|all]
//   node scripts/patch-module-permissions.mjs disable [jit|user-file|all]
//   省略 target 时只操作 jit（保持 build-hap.sh 的旧调用兼容）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TARGET = path.join(ROOT, 'entry/src/main/module.json5')

/** 只切换标记块之间"像 JSON 的行"，说明性注释一律不动 */
const JSON_LINE = /^\s*(\/\/\s*)?[{"]/

const BLOCKS = [
  {
    key: 'jit',
    label: 'JIT 受限权限',
    begin: '// >>> MOTRIX_JIT_PERMISSION_BEGIN',
    end: '// <<< MOTRIX_JIT_PERMISSION_END',
  },
  {
    key: 'user-file',
    label: '用户目录读写权限',
    begin: '// >>> MOTRIX_USER_FILE_PERMISSION_BEGIN',
    end: '// <<< MOTRIX_USER_FILE_PERMISSION_END',
  },
]

const action = (process.argv[2] || 'status').toLowerCase()
const targetArg = (process.argv[3] || 'jit').toLowerCase()
const selected =
  targetArg === 'all'
    ? BLOCKS
    : BLOCKS.filter((block) => block.key === targetArg)
if (selected.length === 0) {
  console.error(`未知目标：${targetArg}（可选 jit | user-file | all）`)
  process.exit(2)
}

let source = fs.readFileSync(TARGET, 'utf8')
let lines = source.split('\n')

function locate(block) {
  const beginIndex = lines.findIndex((line) => line.includes(block.begin))
  const endIndex = lines.findIndex((line) => line.includes(block.end))
  if (beginIndex < 0 || endIndex < 0 || endIndex <= beginIndex) {
    console.error(`!! module.json5 里找不到 ${block.label} 的标记块`)
    process.exit(2)
  }
  return { beginIndex, endIndex }
}

if (action === 'status') {
  for (const block of BLOCKS) {
    const { beginIndex, endIndex } = locate(block)
    const body = lines.slice(beginIndex + 1, endIndex)
    const enabled = body.filter(
      (line) => JSON_LINE.test(line) && !/^\s*\/\//.test(line)
    ).length
    const commented = body.filter((line) => /^\s*\/\/\s*[{"]/.test(line)).length
    console.log(
      `${block.label}：${enabled > 0 ? '已解注（构建会声明）' : '注释中（默认）'}` +
        `（启用行 ${enabled} / 注释行 ${commented}）`
    )
  }
  process.exit(0)
}
if (action !== 'enable' && action !== 'disable') {
  console.error(
    '用法：node scripts/patch-module-permissions.mjs enable|disable|status [jit|user-file|all]'
  )
  process.exit(2)
}

const INDENT = '      ' // 该块在 requestPermissions 数组里的缩进
for (const block of selected) {
  const { beginIndex, endIndex } = locate(block)
  const body = lines.slice(beginIndex + 1, endIndex)
  const rewrite = (line) => {
    if (!JSON_LINE.test(line)) return line // 说明性注释/空行：不动
    const content = line.trim().replace(/^\/\/\s*/, '')
    if (action === 'enable') return INDENT + content
    return `${INDENT}// ${content}`
  }
  lines = [
    ...lines.slice(0, beginIndex + 1),
    ...body.map(rewrite),
    ...lines.slice(endIndex),
  ]
}

fs.writeFileSync(TARGET, lines.join('\n'))
console.log(
  `${selected.map((block) => block.label).join('、')}：已${action === 'enable' ? '解注' : '注释'}`
)