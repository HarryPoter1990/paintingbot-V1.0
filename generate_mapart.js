/*
 * Image -> 16-colour carpet Sponge schematic generator.
 *
 * Example:
 *   npm run generate -- --input input.png --output schem/my-map.schem --width 128 --height 128 --dither
 */
const fs = require('fs/promises')
const path = require('path')
const sharp = require('sharp')
const minecraftData = require('minecraft-data')
const Block = require('prismarine-block')
const { Schematic } = require('prismarine-schematic')
const { Vec3 } = require('vec3')
const config = require('./config')

// Representative RGB colours for the 16 Minecraft carpet colours. They are
// intentionally used as a palette, rather than pretending all source pixels
// can be reproduced exactly with sixteen blocks.
const PALETTE = [
  ['white_carpet', [233, 236, 236]],
  ['orange_carpet', [240, 118, 19]],
  ['magenta_carpet', [189, 68, 179]],
  ['light_blue_carpet', [58, 175, 217]],
  ['yellow_carpet', [248, 198, 39]],
  ['lime_carpet', [112, 185, 25]],
  ['pink_carpet', [237, 141, 172]],
  ['gray_carpet', [62, 68, 71]],
  ['light_gray_carpet', [142, 142, 134]],
  ['cyan_carpet', [21, 137, 145]],
  ['purple_carpet', [121, 42, 172]],
  ['blue_carpet', [53, 57, 157]],
  ['brown_carpet', [114, 71, 40]],
  ['green_carpet', [84, 109, 27]],
  ['red_carpet', [161, 39, 34]],
  ['black_carpet', [20, 21, 25]]
]

function usage() {
  return [
    '用法:',
    '  npm run generate -- --input <图片> [--output <文件.schem>] [--width 128] [--height 128] [--fit cover|contain|fill] [--dither] [--transparent-air]',
    '',
    '示例:',
    '  npm run generate -- --input image.png --output schem/cat.schem --width 128 --height 128 --dither'
  ].join('\n')
}

function parseArgs(argv) {
  const args = {
    width: 128,
    height: 128,
    fit: 'cover',
    dither: false,
    transparentAir: false,
    output: null,
    input: null
  }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--input') args.input = argv[++index]
    else if (token === '--output') args.output = argv[++index]
    else if (token === '--width') args.width = Number(argv[++index])
    else if (token === '--height') args.height = Number(argv[++index])
    else if (token === '--fit') args.fit = argv[++index]
    else if (token === '--dither') args.dither = true
    else if (token === '--transparent-air') args.transparentAir = true
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`未知参数：${token}`)
  }
  if (args.help) return args
  if (!args.input) throw new Error('缺少 --input 图片路径')
  if (!Number.isInteger(args.width) || !Number.isInteger(args.height) || args.width < 1 || args.height < 1) {
    throw new Error('宽度和高度必须是正整数')
  }
  if (!['cover', 'contain', 'fill'].includes(args.fit)) throw new Error('--fit 只能是 cover、contain 或 fill')
  if (!args.output) {
    const source = path.parse(args.input)
    args.output = path.join('schem', `${source.name}-${args.width}x${args.height}.schem`)
  }
  return args
}

function linear(value) {
  const unit = value / 255
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
}

function nearestColour(rgb) {
  let selected = PALETTE[0]
  let distance = Infinity
  const source = rgb.map(linear)
  for (const colour of PALETTE) {
    const candidate = colour[1].map(linear)
    const score = (source[0] - candidate[0]) ** 2 + (source[1] - candidate[1]) ** 2 + (source[2] - candidate[2]) ** 2
    if (score < distance) {
      distance = score
      selected = colour
    }
  }
  return selected
}

function distributeError(pixels, width, height, x, y, error) {
  const targets = [
    [x + 1, y, 7 / 16],
    [x - 1, y + 1, 3 / 16],
    [x, y + 1, 5 / 16],
    [x + 1, y + 1, 1 / 16]
  ]
  for (const [targetX, targetY, factor] of targets) {
    if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue
    const offset = (targetY * width + targetX) * 4
    for (let channel = 0; channel < 3; channel++) {
      pixels[offset + channel] = Math.max(0, Math.min(255, pixels[offset + channel] + error[channel] * factor))
    }
  }
}

async function imagePixels(args) {
  const resize = {
    width: args.width,
    height: args.height,
    fit: args.fit,
    position: 'centre',
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  }
  const { data, info } = await sharp(args.input).resize(resize).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.width !== args.width || info.height !== args.height || info.channels !== 4) throw new Error('无法读取转换后的 RGBA 图像')
  return Buffer.from(data)
}

function quantize(pixels, args) {
  const output = new Array(args.width * args.height).fill(null)
  const report = Object.fromEntries(PALETTE.map(([name]) => [name, 0]))
  for (let y = 0; y < args.height; y++) {
    for (let x = 0; x < args.width; x++) {
      const offset = (y * args.width + x) * 4
      if (args.transparentAir && pixels[offset + 3] < 128) continue
      const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]]
      const colour = nearestColour(rgb)
      output[y * args.width + x] = colour[0]
      report[colour[0]]++
      if (args.dither) {
        distributeError(pixels, args.width, args.height, x, y, [
          rgb[0] - colour[1][0],
          rgb[1] - colour[1][1],
          rgb[2] - colour[1][2]
        ])
      }
    }
  }
  return { blocks: output, report }
}

async function writeSchematic(names, args) {
  const version = config.connection.version
  const mcData = minecraftData(version)
  const blockClass = Block(version)
  const palette = [0]
  const blockIndexes = new Array(args.width * args.height).fill(0)
  const paletteIndexes = new Map([[0, 0]])

  for (let z = 0; z < args.height; z++) {
    for (let x = 0; x < args.width; x++) {
      const name = names[z * args.width + x]
      if (!name) continue
      const definition = mcData.blocksByName[name]
      if (!definition) throw new Error(`当前 Minecraft 版本没有方块：${name}`)
      const block = blockClass.fromStateId(definition.defaultState, 0)
      let index = paletteIndexes.get(block.stateId)
      if (index === undefined) {
        index = palette.length
        paletteIndexes.set(block.stateId, index)
        palette.push(block.stateId)
      }
      blockIndexes[z * args.width + x] = index
    }
  }

  const schematic = new Schematic(
    version,
    new Vec3(args.width, 1, args.height),
    new Vec3(0, 0, 0),
    palette,
    blockIndexes
  )
  await fs.mkdir(path.dirname(args.output), { recursive: true })
  await fs.writeFile(args.output, await schematic.write())
  // Read it again immediately: a generated file is delivered only if the same
  // parser used by the builder can understand it.
  const verification = await Schematic.read(await fs.readFile(args.output), version)
  const verificationWidth = verification.width || verification.size?.x
  const verificationHeight = verification.height || verification.size?.y
  const verificationLength = verification.length || verification.size?.z
  if (verificationWidth !== args.width || verificationLength !== args.height || verificationHeight !== 1) {
    throw new Error('生成的 schematic 尺寸校验失败')
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  const pixels = await imagePixels(args)
  const { blocks, report } = quantize(pixels, args)
  await writeSchematic(blocks, args)
  const reportPath = args.output.replace(/\.schem$/i, '.materials.json')
  await fs.writeFile(reportPath, JSON.stringify({
    input: path.resolve(args.input),
    schematic: path.resolve(args.output),
    width: args.width,
    height: args.height,
    fit: args.fit,
    dither: args.dither,
    transparentAir: args.transparentAir,
    materials: report,
    totalCarpets: Object.values(report).reduce((sum, value) => sum + value, 0)
  }, null, 2))
  console.log(`已生成：${args.output}`)
  console.log(`材料统计：${reportPath}`)
  console.table(report)
}

main().catch(error => {
  console.error(`[generate] ${error.stack || error.message}`)
  process.exitCode = 1
})
