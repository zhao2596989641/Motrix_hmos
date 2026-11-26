#!/usr/bin/env node
// 按环境开关解注/注释 module.json5 里的**受限权限**条目（目前只有 JIT/W^X 那一条）。
//
// 为什么需要开关：`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` 是受限 ACL 权限，
// **拿到 ACL 之后才能在清单里声明**；没 ACL 却声明会导致应用安装失败。
// 仓库里默认保持注释状态；拿到 ACL 后用：
//   MOTRIX_ENABLE_JIT_PERMISSION=1 sh scripts/build-hap.sh
// 构建时由 build-hap.sh 调用本脚本临时解注、构建完自动还原。
//
// 用法：
//   node scripts/patch-module-permissions.mjs enable|disable|status
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TARGET = path.join(ROOT, 'entry/src/main/module.json5')
const BEGIN = '// >>> MOTRIX_JIT_PERMISSION_BEGIN'
const END = '// <<< MOTRIX_JIT_PERMISSION_END'
/** 只切换标记块之间"像 JSON 的行"，说明性注释一律不动 */
const JSON_LINE = /^\s*(\/\/\s*)?[{"]/

const action = (process.argv[2] || 'status').toLowerCase()
const source = fs.readFileSync(TARGET, 'utf8')
const lines = source.split('\n')
const beginIndex = lines.findIndex((line) => line.includes(BEGIN))
const endIndex = lines.findIndex((line) => line.includes(END))
if (beginIndex < 0 || endIndex < 0 || endIndex <= beginIndex) {
  console.error('!! module.json5 里找不到 JIT 权限的标记块')
  process.exit(2)
}

const body = lines.slice(beginIndex + 1, endIndex)
const enabledLines = body.filter((line) => JSON_LINE.test(line) && !/^\s*\/\//.test(line)).length
const commentedLines = body.filter((line) => /^\s*\/\/\s*[{"]/.test(line)).length

if (action === 'status') {
  console.log(
    `JIT 受限权限：${enabledLines > 0 ? '已解注（构建会声明）' : '注释中（默认）'}` +
      `（启用行 ${enabledLines} / 注释行 ${commentedLines}）`
  )
  process.exit(0)
}
if (action !== 'enable' && action !== 'disable') {
  console.error('用法：node scripts/patch-module-permissions.mjs enable|disable|status')
  process.exit(2)
}

const INDENT = '      ' // 该块在 requestPermissions 数组里的缩进
const rewrite = (line) => {
  if (!JSON_LINE.test(line)) return line // 说明性注释/空行：不动
  const content = line.trim().replace(/^\/\/\s*/, '') // 去掉缩进与 // 注释，拿到 JSON 本体
  if (action === 'enable') return INDENT + content
  return `${INDENT}// ${content}`
}

const next = [
  ...lines.slice(0, beginIndex + 1),
  ...body.map(rewrite),
  ...lines.slice(endIndex),
]
fs.writeFileSync(TARGET, next.join('\n'))
console.log(
  `JIT 受限权限：已${action === 'enable' ? '解注' : '注释'}（${action === 'enable' ? commentedLines : enabledLines} 行）`
)
