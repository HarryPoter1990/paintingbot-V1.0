const fs = require('fs/promises')
const path = require('path')
const { Schematic } = require('prismarine-schematic')
const { Vec3 } = require('vec3')

const schemDir = path.join(__dirname, 'schem')

function safeLitematicName(value) {
  if (typeof value !== 'string') throw new Error('上传文件缺少名称')
  const name = path.basename(value)
  if (name !== value || !/^[^\\/:*?"<>|]+\.litematic$/i.test(name)) {
    throw new Error('只允许上传名称正常的 .litematic 文件')
  }
  return name
}

function safeSchematicName(value) {
  if (typeof value !== 'string') throw new Error('缩略图缺少 schem 文件名')
  const name = path.basename(value)
  if (name !== value || !/^[^\\/:*?"<>|]+\.schem$/i.test(name)) {
    throw new Error('只允许名称正常的 .schem 文件')
  }
  return name
}

const previewColors = {
  white_carpet: '#E9ECEC', orange_carpet: '#F9801D', magenta_carpet: '#C74EBD', light_blue_carpet: '#3AB3DA',
  yellow_carpet: '#FED83D', lime_carpet: '#80C71F', pink_carpet: '#F38BAA', gray_carpet: '#474F52',
  light_gray_carpet: '#9D9D97', cyan_carpet: '#169C9C', purple_carpet: '#8932B8', blue_carpet: '#3C44AA',
  brown_carpet: '#835432', green_carpet: '#5E7C16', red_carpet: '#B02E26', black_carpet: '#1D1D21',
  smooth_stone: '#9C9C9C'
}

async function schematicPreview(rawName, completedRows = []) {
  const name = safeSchematicName(rawName)
  const source = await fs.readFile(path.join(schemDir, name))
  const schematic = await Schematic.read(source)
  const width = schematic.size.x
  const height = schematic.size.y
  const length = schematic.size.z
  const rows = []
  for (let z = 0; z < length; z += 1) {
    let x = 0
    while (x < width) {
      let blockName = 'air'
      for (let y = height - 1; y >= 0; y -= 1) {
        const candidate = schematic.getBlock(new Vec3(x, y, z)).name
        if (candidate !== 'air') { blockName = candidate; break }
      }
      const color = previewColors[blockName] || (blockName === 'air' ? '#F2F5FA' : '#CBD5E1')
      let end = x + 1
      while (end < width) {
        let nextName = 'air'
        for (let y = height - 1; y >= 0; y -= 1) {
          const candidate = schematic.getBlock(new Vec3(end, y, z)).name
          if (candidate !== 'air') { nextName = candidate; break }
        }
        const nextColor = previewColors[nextName] || (nextName === 'air' ? '#F2F5FA' : '#CBD5E1')
        if (nextColor !== color) break
        end += 1
      }
      rows.push('<rect x="' + x + '" y="' + z + '" width="' + (end - x) + '" height="1" fill="' + color + '"/>')
      x = end
    }
  }
  const completed = [...new Set(completedRows.filter(row => Number.isInteger(row) && row >= 0 && row < length))]
  const overlay = completed.map(row => '<rect x="0" y="' + row + '" width="' + width + '" height="1" fill="#0D9488" opacity=".34"/>').join('')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + length + '" shape-rendering="crispEdges">' + rows.join('') + overlay + '</svg>'
  return { name, width, height, length, completedRows: completed.length, image: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') }
}

module.exports = { safeLitematicName, previewColors, schematicPreview }
