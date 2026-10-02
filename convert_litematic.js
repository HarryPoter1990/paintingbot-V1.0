/*
 * Direct Litematica -> Sponge .schem converter for this carpet builder.
 * It intentionally accepts only air, smooth_stone and the 16 carpet colours.
 *
 * Example:
 *   npm.cmd run convert -- --input "投影文件/try.litematic" --output "schem/try.schem"
 */
const fs = require('fs/promises')
const path = require('path')
const nbt = require('prismarine-nbt')
const minecraftData = require('minecraft-data')
const Block = require('prismarine-block')
const { Schematic } = require('prismarine-schematic')
const { Vec3 } = require('vec3')
const config = require('./config')

const parseNbt = buffer => new Promise((resolve, reject) => {
  nbt.parse(buffer, (error, value) => error ? reject(error) : resolve(nbt.simplify(value)))
})

function parseArgs(argv) {
  const args = { input: null, output: null }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--input') args.input = argv[++index]
    else if (token === '--output') args.output = argv[++index]
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`未知参数：${token}`)
  }
  if (args.help) return args
  if (!args.input) throw new Error('缺少 --input，例如：--input "投影文件/try.litematic"')
  if (!args.output) args.output = args.input.replace(/\.litematic$/i, '.schem')
  if (args.output === args.input) throw new Error('输出文件必须是 .schem，不能覆盖 .litematic')
  return args
}

function regionBounds(region) {
  const size = region.Size
  if (!size) throw new Error('区域缺少 Size')
  const start = new Vec3(
    region.Position.x + (size.x < 0 ? size.x + 1 : 0),
    region.Position.y + (size.y < 0 ? size.y + 1 : 0),
    region.Position.z + (size.z < 0 ? size.z + 1 : 0)
  )
  return { start, size: new Vec3(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)) }
}

function paletteIndexAt(blockStates, paletteSize, index) {
  if (paletteSize <= 1 || !blockStates?.length) return 0
  const bits = Math.max(2, Math.ceil(Math.log2(paletteSize)))
  const valuesPerLong = Math.floor(64 / bits)
  const longIndex = Math.floor(index / valuesPerLong)
  if (longIndex >= blockStates.length) throw new Error(`BlockStates 数据不足，索引 ${index}`)
  const word = BigInt.asUintN(64, BigInt(String(blockStates[longIndex])))
  const shift = BigInt((index % valuesPerLong) * bits)
  return Number((word >> shift) & ((1n << BigInt(bits)) - 1n))
}

function blockName(paletteEntry) {
  return (paletteEntry?.Name || 'minecraft:air').replace(/^minecraft:/, '')
}

async function readLitematic(input) {
  const root = await parseNbt(await fs.readFile(input))
  const regions = Object.values(root.Regions || {})
  if (regions.length === 0) throw new Error('该 litematic 没有 Regions')

  const bounds = regions.map(regionBounds)
  const min = new Vec3(
    Math.min(...bounds.map(item => item.start.x)),
    Math.min(...bounds.map(item => item.start.y)),
    Math.min(...bounds.map(item => item.start.z))
  )
  const max = new Vec3(
    Math.max(...bounds.map(item => item.start.x + item.size.x - 1)),
    Math.max(...bounds.map(item => item.start.y + item.size.y - 1)),
    Math.max(...bounds.map(item => item.start.z + item.size.z - 1))
  )
  const size = max.minus(min).offset(1, 1, 1)
  const cells = new Array(size.x * size.y * size.z).fill('air')
  const materials = {}

  for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
    const region = regions[regionIndex]
    const { start, size: regionSize } = bounds[regionIndex]
    const palette = region.BlockStatePalette || []
    for (let y = 0; y < regionSize.y; y++) {
      for (let z = 0; z < regionSize.z; z++) {
        for (let x = 0; x < regionSize.x; x++) {
          const localIndex = x + z * regionSize.x + y * regionSize.x * regionSize.z
          const paletteIndex = paletteIndexAt(region.BlockStates, palette.length, localIndex)
          const name = blockName(palette[paletteIndex])
          if (name !== 'air' && !config.SUPPORTED_BLOCKS.includes(name)) {
            throw new Error(`投影实际使用了不支持的方块：${name}，区域坐标 ${x},${y},${z}`)
          }
          const target = start.plus(new Vec3(x, y, z)).minus(min)
          const targetIndex = target.x + target.z * size.x + target.y * size.x * size.z
          cells[targetIndex] = name
          if (name !== 'air') materials[name] = (materials[name] || 0) + 1
        }
      }
    }
  }
  return { size, cells, materials }
}

async function writeSchematic(converted, output) {
  const version = config.connection.version
  const mcData = minecraftData(version)
  const blockClass = Block(version)
  const palette = [0]
  const paletteIndexes = new Map([[0, 0]])
  const blocks = new Array(converted.cells.length).fill(0)

  for (let index = 0; index < converted.cells.length; index++) {
    const name = converted.cells[index]
    if (name === 'air') continue
    const definition = mcData.blocksByName[name]
    if (!definition) throw new Error(`Minecraft ${version} 中没有方块：${name}`)
    const stateId = blockClass.fromStateId(definition.defaultState, 0).stateId
    let paletteIndex = paletteIndexes.get(stateId)
    if (paletteIndex === undefined) {
      paletteIndex = palette.length
      paletteIndexes.set(stateId, paletteIndex)
      palette.push(stateId)
    }
    blocks[index] = paletteIndex
  }

  const schematic = new Schematic(version, converted.size, new Vec3(0, 0, 0), palette, blocks)
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, await schematic.write())
  const verify = await Schematic.read(await fs.readFile(output), version)
  const verifiedSize = verify.size || new Vec3(verify.width, verify.height, verify.length)
  if (!verifiedSize.equals(converted.size)) throw new Error('输出 .schem 尺寸校验失败')
}

async function convertLitematic(input, output) {
  const converted = await readLitematic(input)
  await writeSchematic(converted, output)
  return converted
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：npm.cmd run convert -- --input "投影文件/try.litematic" --output "schem/try.schem"')
    return
  }
  const converted = await convertLitematic(args.input, args.output)
  const reportPath = args.output.replace(/\.schem$/i, '.materials.json')
  await fs.writeFile(reportPath, JSON.stringify({
    source: path.resolve(args.input),
    schematic: path.resolve(args.output),
    size: converted.size,
    materials: converted.materials
  }, null, 2))
  console.log(`转换完成：${args.output}`)
  console.log(`尺寸：${converted.size.x} × ${converted.size.y} × ${converted.size.z}`)
  console.log(`材料统计：${reportPath}`)
  console.table(converted.materials)
}

module.exports = { convertLitematic }

if (require.main === module) {
  main().catch(error => {
    console.error(`[convert] ${error.message}`)
    process.exitCode = 1
  })
}
