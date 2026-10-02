const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { convertLitematic } = require('./convert_litematic')

async function resolveProjection(inputPath) {
  const extension = path.extname(inputPath).toLowerCase()
  if (extension === '.schem') return inputPath
  if (extension !== '.litematic') throw new Error(`投影必须是 .litematic 或 .schem：${inputPath}`)

  const source = await fs.readFile(inputPath)
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)
  const name = path.basename(inputPath, extension).replace(/[^a-zA-Z0-9._-]/g, '_')
  const output = path.join(path.dirname(inputPath), '.generated', `${name}-${hash}.schem`)
  try {
    await fs.access(output)
  } catch {
    console.log(`[projection] 自动转换 ${inputPath} → ${output}`)
    await convertLitematic(inputPath, output)
  }
  return output
}

module.exports = { resolveProjection }
