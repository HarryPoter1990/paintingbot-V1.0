// Offline preflight check. It does not log in or move the bot.
const fs = require('fs/promises')
const { Schematic } = require('prismarine-schematic')
const { Vec3 } = require('vec3')
const config = require('./config')
const { resolveProjection } = require('./projection_resolver')

function rotate(local, rotation) {
  if (rotation !== 0) throw new Error(`仅支持原始 0° 投影，当前 rotation：${rotation}`)
  return new Vec3(local.x, local.y, local.z)
}

function world(local) {
  return config.sites.build.origin.plus(rotate(local, config.sites.build.rotation))
}

async function main() {
  const resolvedPath = await resolveProjection(config.schematicPath)
  const data = await fs.readFile(resolvedPath)
  const schematic = await Schematic.read(data)
  const width = schematic.width || schematic.size?.x
  const height = schematic.height || schematic.size?.y
  const length = schematic.length || schematic.size?.z
  const materials = {}
  const materialBounds = {}
  const unsupported = []
  let total = 0

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = schematic.getBlock(new Vec3(x, y, z))
        if (!block || block.name === 'air') continue
        total++
        materials[block.name] = (materials[block.name] || 0) + 1
        const current = materialBounds[block.name] || { min: new Vec3(x, y, z), max: new Vec3(x, y, z) }
        current.min = new Vec3(Math.min(current.min.x, x), Math.min(current.min.y, y), Math.min(current.min.z, z))
        current.max = new Vec3(Math.max(current.max.x, x), Math.max(current.max.y, y), Math.max(current.max.z, z))
        materialBounds[block.name] = current
        if (!config.SUPPORTED_BLOCKS.includes(block.name)) unsupported.push({ x, y, z, block: block.name })
      }
    }
  }

  console.log(`投影：${config.schematicPath}`)
  console.log(`机器人读取：${resolvedPath}`)
  console.log(`尺寸：${width} × ${height} × ${length}`)
  console.log(`非空气方块：${total}`)
  console.log(`世界起点：${world(new Vec3(0, 0, 0))}`)
  console.log(`本地 X 最后一格：${world(new Vec3(width - 1, 0, 0))}`)
  console.log(`本地 Z 最后一格：${world(new Vec3(0, 0, length - 1))}`)
  console.table(materials)
  for (const [name, bounds] of Object.entries(materialBounds)) {
    if (name !== 'smooth_stone') continue
    console.log(`${name} 本地范围：${bounds.min} → ${bounds.max}`)
    console.log(`${name} 世界范围：${world(bounds.min)} → ${world(bounds.max)}`)
  }

  if (unsupported.length > 0) {
    console.error('发现不支持的方块；机器人不会开铺：')
    console.table(unsupported.slice(0, 20))
    process.exitCode = 1
    return
  }
  console.log('预检通过：仅包含16色地毯、smooth_stone 和空气。')
}

main().catch(error => {
  console.error(`[inspect] ${error.message}`)
  process.exitCode = 1
})
