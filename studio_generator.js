// Local image -> 16-carpet map-art projections. No cropped image files are created.
const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const zlib = require('zlib')
const sharp = require('sharp')
const nbt = require('prismarine-nbt')
const minecraftData = require('minecraft-data')
const { Schematic } = require('prismarine-schematic')
const { Vec3 } = require('vec3')
const { convertLitematic } = require('./convert_litematic')
const config = require('./config')

const TILE = 128
const MODES = ['rgb+', 'lab94', 'lab00', 'xyz']
const MAX_TILES = 64
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
function throwIfCancelled(signal) {
  if (signal?.aborted) throw new Error('图片转换已取消；没有保留未完成的输出')
}
// Flat-map (220/255 shade) colours for the wool/carpet group, checked against
// the local SlopeCraft RGB.TokiColor table. These are map pixels, not textures.
const COLOURS = [
  ['white_carpet', [220, 220, 220]], ['orange_carpet', [186, 109, 44]],
  ['magenta_carpet', [153, 65, 186]], ['light_blue_carpet', [88, 132, 186]],
  ['yellow_carpet', [197, 197, 44]], ['lime_carpet', [109, 176, 21]],
  ['pink_carpet', [208, 109, 142]], ['gray_carpet', [65, 65, 65]],
  ['light_gray_carpet', [132, 132, 132]], ['cyan_carpet', [65, 109, 132]],
  ['purple_carpet', [109, 54, 153]], ['blue_carpet', [44, 65, 153]],
  ['brown_carpet', [88, 65, 44]], ['green_carpet', [88, 109, 44]],
  ['red_carpet', [132, 44, 44]], ['black_carpet', [21, 21, 21]]
]

function toXyz(rgb) {
  // SlopeCraft v4.0.2 converts the 8-bit channels directly; it does not apply sRGB gamma.
  const [r, g, b] = rgb.map(channel => channel / 255)
  return [
    r * 0.412453 + g * 0.357580 + b * 0.180423,
    r * 0.212671 + g * 0.715160 + b * 0.072169,
    r * 0.019334 + g * 0.119193 + b * 0.950227
  ]
}

function toLab(rgb) {
  const f = v => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116
  const [x, y, z] = toXyz(rgb)
  const X = f(x / 0.9504); const Y = f(y); const Z = f(z / 1.0888)
  return [116 * X - 16, 500 * (X - Y), 200 * (Y - Z)]
}

function delta94(a, b) {
  const c1 = Math.hypot(a[1], a[2]); const c2 = Math.hypot(b[1], b[2])
  const dc = c1 - c2
  const dh2 = Math.max(0, (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 - dc ** 2)
  return (a[0] - b[0]) ** 2 + (dc / (1 + 0.045 * c1)) ** 2 + dh2 / (1 + 0.015 * c2) ** 2
}

function delta00(a, b) {
  const [l1, a1, b1] = a; const [l2, a2, b2] = b
  const c1 = Math.hypot(a1, b1); const c2 = Math.hypot(a2, b2)
  const meanC = (c1 + c2) / 2
  const g = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)))
  const ap1 = a1 * (1 + g); const ap2 = a2 * (1 + g)
  const cp1 = Math.hypot(ap1, b1); const cp2 = Math.hypot(ap2, b2)
  const hue = (x, y) => (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
  const h1 = hue(ap1, b1); const h2 = hue(ap2, b2)
  const dl = l2 - l1; const dc = cp2 - cp1
  let dh = cp1 * cp2 === 0 ? 0 : h2 - h1
  if (dh > 180) dh -= 360
  if (dh < -180) dh += 360
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dh * Math.PI / 360)
  const meanL = (l1 + l2) / 2; const meanCp = (cp1 + cp2) / 2
  let meanH = h1 + h2
  if (cp1 * cp2 === 0) meanH = h1 + h2
  else if (Math.abs(h1 - h2) <= 180) meanH = (h1 + h2) / 2
  else meanH = (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2
  const rad = Math.PI / 180
  const t = 1 - 0.17 * Math.cos((meanH - 30) * rad) + 0.24 * Math.cos(2 * meanH * rad) +
    0.32 * Math.cos((3 * meanH + 6) * rad) - 0.20 * Math.cos((4 * meanH - 63) * rad)
  const dh30 = 30 * Math.exp(-(((meanH - 275) / 25) ** 2))
  const rc = 2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7))
  const sl = 1 + 0.015 * (meanL - 50) ** 2 / Math.sqrt(20 + (meanL - 50) ** 2)
  const sc = 1 + 0.045 * meanCp; const sh = 1 + 0.015 * meanCp * t
  const rt = -Math.sin(2 * dh30 * rad) * rc
  const x = dl / sl; const y = dc / sc; const z = dH / sh
  return x * x + y * y + z * z + rt * y * z
}

const PALETTE = COLOURS.map(([name, rgb]) => ({ name, rgb, xyz: toXyz(rgb), lab: toLab(rgb) }))
function rgbPlus(a, b) {
  const [r, g, blue] = a.map(v => Math.max(v / 255, 1e-10))
  const [pr, pg, pb] = b.map(v => Math.max(v / 255, 1e-10))
  const tiny = 1e-10
  const sigma = (r + g + blue + pr + pg + pb) / 3
  const sr = pr + r < sigma ? (pr + r) / (sigma + tiny) : 1
  const sg = pg + g < sigma ? (pg + g) / (sigma + tiny) : 1
  const sb = pb + blue < sigma ? (pb + blue) / (sigma + tiny) : 1
  const dr = r - pr; const dg = g - pg; const db = blue - pb
  const dot = r * pr + g * pg + blue * pb
  const mod = Math.sqrt((r * r + g * g + blue * blue) * (pr * pr + pg * pg + pb * pb))
  const theta = 2 / Math.PI * Math.acos(Math.max(-1, Math.min(1, dot / (mod + tiny) / 1.01)))
  const delta = [Math.abs(dr) / (r + pr + tiny), Math.abs(dg) / (g + pg + tiny), Math.abs(db) / (blue + pb + tiny)]
  const total = delta[0] + delta[1] + delta[2] + tiny
  const stheta = (delta[0] * sr * sr + delta[1] * sg * sg + delta[2] * sb * sb) / total
  return (sr * sr * dr * dr + 2 * sg * sg * dg * dg + sb * sb * db * db) / 4 +
    stheta * Math.max(r, g, blue, pr, pg, pb) * theta * theta
}

function nearest(rgb, mode) {
  const transformed = mode === 'xyz' ? toXyz(rgb) : mode === 'rgb+' ? null : toLab(rgb)
  let best = 0; let minimum = Infinity
  for (let i = 0; i < PALETTE.length; i++) {
    const colour = PALETTE[i]
    let distance
    if (mode === 'rgb+') {
      distance = rgbPlus(rgb, colour.rgb)
    } else if (mode === 'xyz') {
      distance = transformed.reduce((sum, v, channel) => sum + (v - colour.xyz[channel]) ** 2, 0)
    } else distance = mode === 'lab94' ? delta94(transformed, colour.lab) : delta00(transformed, colour.lab)
    if (distance < minimum) { minimum = distance; best = i }
  }
  return best
}

function validateOptions(options) {
  const pixelSize = options.targetWidth !== undefined || options.targetHeight !== undefined
  const columns = Number(options.columns); const rows = Number(options.rows)
  const targetWidth = Number(options.targetWidth); const targetHeight = Number(options.targetHeight)
  if (pixelSize) {
    if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight) || targetWidth < 1 || targetHeight < 1 ||
        targetWidth > 8192 || targetHeight > 8192 || Math.ceil(targetWidth / TILE) * Math.ceil(targetHeight / TILE) > MAX_TILES) {
      throw new Error('缩放尺寸须为正整数且最多覆盖 64 张地图')
    }
  } else if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns * rows > MAX_TILES) {
    throw new Error('横向和纵向均需为正整数，最多生成 64 张地图')
  }
  if (!MODES.includes(options.mode)) throw new Error('颜色算法只能选 RGB+、Lab94、Lab00 或 XYZ')
  if (!(pixelSize ? ['fill', 'inside', 'outside'] : ['cover', 'contain', 'fill']).includes(options.fit)) throw new Error('缩放方式无效')
  if (pixelSize && !['fast', 'smooth'].includes(options.interpolation)) throw new Error('插值方式无效')
  const name = String(options.name || '').trim()
  if (!name || name.length > 70 || !/^[\p{L}\p{N}_-][\p{L}\p{N}._-]*$/u.test(name) || /[. ]$/.test(name)) {
    throw new Error('请填写不含路径符号的输出名称（最多 70 字）')
  }
  return { name, columns, rows, targetWidth, targetHeight, pixelSize, mode: options.mode, fit: options.fit, interpolation: options.interpolation || 'smooth' }
}

function rgbFromSpace(values, mode) {
  if (mode === 'rgb+') return values.map(v => Math.trunc(Math.max(0, Math.min(1, v)) * 255))
  let [x, y, z] = values
  if (mode === 'lab94' || mode === 'lab00') {
    const [l, a, b] = values
    const inverse = v => v > Math.cbrt(0.008856) ? v ** 3 : (v - 16 / 116) / 7.787
    const X = (l + 16) / 116
    x = inverse(X) * 0.9504
    y = inverse(X - a / 500)
    z = inverse(X - a / 500 - b / 200) * 1.0888
  }
  return [
    3.2404814 * x - 1.5371516 * y - 0.4985363 * z,
    -0.9692550 * x + 1.8759900 * y + 0.0415559 * z,
    0.0556466 * x - 0.2040413 * y + 1.0573111 * z
  ].map(v => Math.trunc(Math.max(0, Math.min(1, v)) * 255))
}

function colourSpace(rgb, mode) {
  return mode === 'rgb+' ? rgb.map(v => Math.max(v / 255, 1e-10)) : mode === 'xyz' ? toXyz(rgb) : toLab(rgb)
}

async function calculateLayout(buffer, options) {
  const metadata = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata()
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000) throw new Error('原图像素过大')
  const requestedWidth = options.pixelSize ? options.targetWidth : options.columns * TILE
  const requestedHeight = options.pixelSize ? options.targetHeight : options.rows * TILE
  let imageWidth = requestedWidth; let imageHeight = requestedHeight
  if (options.pixelSize && options.fit !== 'fill') {
    const scale = options.fit === 'inside'
      ? Math.min(requestedWidth / metadata.width, requestedHeight / metadata.height)
      : Math.max(requestedWidth / metadata.width, requestedHeight / metadata.height)
    imageWidth = Math.max(1, Math.round(metadata.width * scale))
    imageHeight = Math.max(1, Math.round(metadata.height * scale))
  }
  const columns = Math.ceil(imageWidth / TILE); const rows = Math.ceil(imageHeight / TILE)
  if (columns * rows > MAX_TILES) throw new Error(`缩放后会生成 ${columns * rows} 张，超过 64 张上限`)
  return { imageWidth, imageHeight, columns, rows, width: columns * TILE, height: rows * TILE }
}

async function quantizeImage(buffer, options, signal, onProgress, layout) {
  throwIfCancelled(signal)
  const { imageWidth, imageHeight, columns, rows, width, height } = layout || await calculateLayout(buffer, options)
  throwIfCancelled(signal)
  const { data, info } = await sharp(buffer, { limitInputPixels: 40_000_000 })
    .resize(imageWidth, imageHeight, { fit: options.pixelSize ? 'fill' : options.fit, position: 'centre',
      background: '#ffffff', kernel: options.interpolation === 'fast' ? sharp.kernel.nearest : sharp.kernel.lanczos3 })
    .flatten({ background: '#ffffff' }).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  if (info.width !== imageWidth || info.height !== imageHeight || info.channels !== 3) throw new Error('图片 RGB 解码失败')
  throwIfCancelled(signal)
  const pixels = new Float32Array(width * height * 3)
  const indexes = new Uint8Array(width * height)
  const preview = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const imagePixel = (y * width + x) * 3
    const sourcePixel = (y * imageWidth + x) * 3
    const rgb = x < imageWidth && y < imageHeight ? [...data.subarray(sourcePixel, sourcePixel + 3)] : [255, 255, 255]
    pixels.set(colourSpace(rgb, options.mode), imagePixel)
  }
  // imageCutter crops first; each tile is converted independently, so error
  // diffusion must not leak across its border into another projection.
  for (let tileY = 0; tileY < rows; tileY++) for (let tileX = 0; tileX < columns; tileX++) {
    throwIfCancelled(signal)
    const left = tileX * TILE; const top = tileY * TILE
    for (let localY = 0; localY < TILE; localY++) {
      const y = top + localY
      const direction = localY % 2 === 0 ? 1 : -1
      for (let step = 0; step < TILE; step++) {
      const x = left + (direction === 1 ? step : TILE - step - 1)
      const pixel = (y * width + x) * 3
      const rgb = rgbFromSpace([pixels[pixel], pixels[pixel + 1], pixels[pixel + 2]], options.mode)
      const chosen = nearest(rgb, options.mode)
      indexes[y * width + x] = chosen
      const colour = PALETTE[chosen].rgb
      for (let c = 0; c < 3; c++) preview[pixel + c] = colour[c]
      const current = colourSpace(rgb, options.mode)
      const target = options.mode === 'rgb+' ? colour.map(v => v / 255) : options.mode === 'xyz' ? PALETTE[chosen].xyz : PALETTE[chosen].lab
      for (const [dx, dy, factor] of [[direction, 0, 7 / 16], [-direction, 1, 3 / 16], [0, 1, 5 / 16], [direction, 1, 1 / 16]]) {
        const tx = x + dx; const ty = y + dy
        if (tx < left || tx >= left + TILE || ty >= top + TILE) continue
        const next = (ty * width + tx) * 3
        for (let c = 0; c < 3; c++) pixels[next + c] += (current[c] - target[c]) * factor
      }
      }
      if ((localY & 31) === 31) {
        await new Promise(resolve => setImmediate(resolve))
        throwIfCancelled(signal)
      }
    }
    onProgress?.({ phase: 'convert', done: tileY * columns + tileX + 1, total: columns * rows })
  }
  throwIfCancelled(signal)
  const previewPng = await sharp(preview, { raw: { width, height, channels: 3 } })
    .png().toBuffer()
  throwIfCancelled(signal)
  return { indexes, width, height, imageWidth, imageHeight, columns, rows, previewPng }
}

async function previewConversion({ image, options, signal, onProgress }) {
  const parsed = validateOptions({ ...options, name: 'preview' })
  if (!Buffer.isBuffer(image) || !image.length || image.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 25 MB')
  const converted = await quantizeImage(image, parsed, signal, onProgress)
  return {
    columns: converted.columns, rows: converted.rows,
    imageWidth: converted.imageWidth, imageHeight: converted.imageHeight,
    mode: parsed.mode, dither: 'Floyd-Steinberg serpentine (fixed)',
    preview: 'data:image/png;base64,' + converted.previewPng.toString('base64')
  }
}

const tag = (type, value) => ({ type, value })
const compound = value => tag('compound', value)
const vectorTag = (x, y, z) => compound({ x: tag('int', x), y: tag('int', y), z: tag('int', z) })

function litematicTile(indexes, width, tileX, tileY, name) {
  const size = 130; const palette = ['air', 'smooth_stone', ...PALETTE.map(c => c.name)]
  const cells = new Uint8Array(size * size)
  for (let x = 1; x <= TILE; x++) cells[x] = 1
  for (let z = 1; z <= TILE; z++) {
    for (let x = 1; x <= TILE; x++) {
      const imageIndex = (tileY * TILE + z - 1) * width + tileX * TILE + x - 1
      cells[z * size + x] = indexes[imageIndex] + 2
    }
  }
  const bits = Math.max(2, Math.ceil(Math.log2(palette.length)))
  const perLong = Math.floor(64 / bits)
  const states = Array.from({ length: Math.ceil(cells.length / perLong) }, () => 0n)
  for (let i = 0; i < cells.length; i++) {
    const long = Math.floor(i / perLong)
    states[long] |= BigInt(cells[i]) << BigInt((i % perLong) * bits)
  }
  const region = compound({
    Position: vectorTag(0, 0, 0), Size: vectorTag(size, 1, size),
    BlockStatePalette: tag('list', { type: 'compound', value: palette.map(block => ({ Name: tag('string', `minecraft:${block}`) })) }),
    BlockStates: tag('longArray', states.map(value => BigInt.asIntN(64, value))),
    Entities: tag('list', { type: 'compound', value: [] }),
    TileEntities: tag('list', { type: 'compound', value: [] }),
    PendingBlockTicks: tag('list', { type: 'compound', value: [] }),
    PendingFluidTicks: tag('list', { type: 'compound', value: [] })
  })
  const now = BigInt(Date.now())
  const root = {
    type: 'compound', name: '', value: {
      MinecraftDataVersion: tag('int', minecraftData(config.connection.version).version.dataVersion),
      Version: tag('int', 5),
      Metadata: compound({
        Name: tag('string', name), Author: tag('string', 'Wolfx Map Art Studio'),
        Description: tag('string', '16-carpet flat map art; 128x128 interior and smooth-stone first row'),
        EnclosingSize: vectorTag(size, 1, size), RegionCount: tag('int', 1),
        TotalBlocks: tag('int', TILE * TILE + TILE), TotalVolume: tag('int', size * size),
        TimeCreated: tag('long', now), TimeModified: tag('long', now)
      }),
      Regions: compound({ MapArt: region })
    }
  }
  return zlib.gzipSync(nbt.writeUncompressed(root))
}

async function createProjections({ root, image, options, signal, onProgress }) {
  const parsed = validateOptions(options)
  if (!Buffer.isBuffer(image) || !image.length || image.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 25 MB')
  throwIfCancelled(signal)
  const projectionDir = path.join(root, '投影文件')
  const schemDir = path.join(root, 'schem')
  const layout = await calculateLayout(image, parsed)
  throwIfCancelled(signal)
  const names = []
  for (let row = 0; row < layout.rows; row++) for (let col = 0; col < layout.columns; col++) {
    names.push({ row, col, base: layout.columns * layout.rows === 1 ? parsed.name : `${parsed.name}_${row + 1}_${col + 1}` })
  }
  // Never replace a projection or its progress identity with a similarly named new image.
  for (const item of names) for (const file of [path.join(projectionDir, item.base + '.litematic'), path.join(schemDir, item.base + '.schem')]) {
    throwIfCancelled(signal)
    try { await fs.access(file); throw new Error(`同名文件已存在：${path.basename(file)}；请换输出名称`) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const quantified = await quantizeImage(image, parsed, signal, onProgress, layout)
  throwIfCancelled(signal)
  const tempRoot = path.resolve(os.tmpdir())
  const temporary = await fs.mkdtemp(path.join(tempRoot, 'wolfx-studio-'))
  const created = []
  try {
    for (const item of names) {
      throwIfCancelled(signal)
      const litematic = path.join(temporary, item.base + '.litematic')
      const schematic = path.join(temporary, item.base + '.schem')
      await fs.writeFile(litematic, litematicTile(quantified.indexes, quantified.width, item.col, item.row, item.base))
      const converted = await convertLitematic(litematic, schematic)
      const check = await Schematic.read(await fs.readFile(schematic), config.connection.version)
      if (!check.size.equals(new Vec3(130, 1, 130)) || converted.materials.smooth_stone !== TILE) {
        throw new Error(`投影校验失败：${item.base}`)
      }
      await fs.writeFile(path.join(temporary, item.base + '.materials.json'), JSON.stringify({
        source: '地图画工作台（原图上传；裁剪图仅在内存中生成）',
        schematic: path.join('schem', item.base + '.schem'),
        mode: parsed.mode, dither: 'Floyd-Steinberg (fixed)', tile: { row: item.row + 1, column: item.col + 1 },
        size: converted.size, materials: converted.materials
      }, null, 2))
      onProgress?.({ phase: 'package', done: names.indexOf(item) + 1, total: names.length })
    }
    throwIfCancelled(signal)
    await fs.mkdir(projectionDir, { recursive: true })
    await fs.mkdir(schemDir, { recursive: true })
    for (const item of names) {
      throwIfCancelled(signal)
      for (const [source, destination] of [
        [item.base + '.litematic', path.join(projectionDir, item.base + '.litematic')],
        [item.base + '.schem', path.join(schemDir, item.base + '.schem')],
        [item.base + '.materials.json', path.join(schemDir, item.base + '.materials.json')]
      ]) {
        throwIfCancelled(signal)
        await fs.copyFile(path.join(temporary, source), destination, require('fs').constants.COPYFILE_EXCL)
        created.push(destination)
      }
    }
    throwIfCancelled(signal)
    return {
      files: names.map(item => ({ row: item.row + 1, column: item.col + 1, projection: item.base + '.litematic', schematic: item.base + '.schem' })),
      columns: quantified.columns, rows: quantified.rows, imageWidth: quantified.imageWidth,
      imageHeight: quantified.imageHeight, mode: parsed.mode, dither: 'Floyd-Steinberg serpentine (fixed)',
      preview: 'data:image/png;base64,' + quantified.previewPng.toString('base64')
    }
  } catch (error) {
    // Only remove files created by this request; never touch an existing task or projection.
    for (const file of created) await fs.rm(file, { force: true }).catch(() => {})
    throw error
  } finally {
    if (path.dirname(path.resolve(temporary)) === tempRoot && path.basename(temporary).startsWith('wolfx-studio-')) {
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }
}

module.exports = { TILE, MODES, COLOURS, validateOptions, nearest, delta94, delta00, litematicTile, previewConversion, createProjections }
