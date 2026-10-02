const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const sharp = require('sharp')
const nbt = require('prismarine-nbt')
const vm = require('node:vm')
const { Schematic } = require('prismarine-schematic')
const { Vec3 } = require('vec3')
const { createProjections, previewConversion, validateOptions, nearest, delta00 } = require('./studio_generator')

test('studio accepts only requested modes and a bounded grid', () => {
  assert.equal(validateOptions({ name: '图1', columns: 2, rows: 2, mode: 'lab00', fit: 'cover' }).mode, 'lab00')
  assert.throws(() => validateOptions({ name: '../bad', columns: 1, rows: 1, mode: 'xyz', fit: 'cover' }), /输出名称/)
  assert.throws(() => validateOptions({ name: 'ok', columns: 9, rows: 8, mode: 'xyz', fit: 'cover' }), /最多生成/)
  assert.throws(() => validateOptions({ name: 'ok', columns: 1, rows: 1, mode: 'rgb', fit: 'cover' }), /颜色算法/)
  for (const mode of ['rgb+', 'lab94', 'lab00', 'xyz']) assert.equal(nearest([220, 220, 220], mode), 0)
  assert.ok(Math.abs(Math.sqrt(delta00([50, 2.6772, -79.7751], [50, 0, -82.7485])) - 2.0425) < 0.0001)
  assert.equal(validateOptions({ name: 'pixels', targetWidth: 129, targetHeight: 128,
    mode: 'rgb+', fit: 'fill', interpolation: 'smooth' }).pixelSize, true)
  assert.throws(() => validateOptions({ name: 'too-big', targetWidth: 8192, targetHeight: 8192,
    mode: 'rgb+', fit: 'fill', interpolation: 'smooth' }), /最多覆盖/)
})

test('imageCutter-sized partial edge becomes a white-padded second projection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wolfx-studio-test-'))
  t.after(async () => {
    const absolute = path.resolve(root)
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
    assert.ok(path.basename(absolute).startsWith('wolfx-studio-test-'))
    await fs.rm(absolute, { recursive: true, force: true })
  })
  const image = await sharp({ create: { width: 129, height: 128, channels: 3, background: '#151515' } }).png().toBuffer()
  const result = await createProjections({ root, image, options: { name: 'edge', targetWidth: 129, targetHeight: 128,
    fit: 'fill', interpolation: 'fast', mode: 'rgb+' } })
  assert.equal(result.columns, 2)
  assert.equal(result.rows, 1)
  assert.equal(result.imageWidth, 129)
  const second = await Schematic.read(await fs.readFile(path.join(root, 'schem', 'edge_1_2.schem')))
  assert.equal(second.getBlock(new Vec3(1, 0, 1)).name, 'black_carpet')
  assert.equal(second.getBlock(new Vec3(2, 0, 1)).name, 'white_carpet')
})

test('separate studio page has valid inline JavaScript', async () => {
  const html = await fs.readFile(path.join(__dirname, 'studio.html'), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new vm.Script(script))
  assert.match(html, /href="\/"/)
  assert.match(html, /id="convert-preview"/)
  assert.match(html, /id="tile-select"/)
  assert.match(html, /id="cancel-conversion"/)
  assert.match(html, /\/api\/studio\/preview/)
  assert.match(html, /\[hidden\] \{ display:none !important \}/)
})

test('preview uses the same conversion as generation without saving files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wolfx-studio-test-'))
  t.after(async () => {
    const absolute = path.resolve(root)
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
    assert.ok(path.basename(absolute).startsWith('wolfx-studio-test-'))
    await fs.rm(absolute, { recursive: true, force: true })
  })
  const image = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#515685' } }).png().toBuffer()
  const options = { name: '', targetWidth: 128, targetHeight: 128,
    fit: 'fill', interpolation: 'smooth', mode: 'lab00' }
  const preview = await previewConversion({ image, options })
  assert.equal(preview.columns, 1)
  assert.equal(preview.rows, 1)
  assert.match(preview.preview, /^data:image\/png;base64,/)
  assert.deepEqual(await fs.readdir(root), [], 'preview created files')
  assert.equal(preview.files, undefined)
  const generated = await createProjections({ root, image, options: { ...options, name: 'same-image' } })
  assert.equal(preview.preview, generated.preview, 'preview and final generation differ')
})

test('studio splits in memory and creates compatible litematic and schem tiles', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wolfx-studio-test-'))
  t.after(async () => {
    const absolute = path.resolve(root)
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
    assert.ok(path.basename(absolute).startsWith('wolfx-studio-test-'))
    await fs.rm(absolute, { recursive: true, force: true })
  })
  const width = 256; const height = 128
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3
    const colour = x < 128 ? [220, 220, 220] : [132, 44, 44]
    pixels.set(colour, offset)
  }
  const image = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const result = await createProjections({ root, image, options: { name: 'test', columns: 2, rows: 1, mode: 'xyz', fit: 'fill' } })
  assert.deepEqual(result.files.map(item => item.schematic), ['test_1_1.schem', 'test_1_2.schem'])
  assert.match(result.preview, /^data:image\/png;base64,/)
  const previewSize = await sharp(Buffer.from(result.preview.slice('data:image/png;base64,'.length), 'base64')).metadata()
  assert.equal(previewSize.width, 256, 'multi-tile preview must preserve 128 pixels per tile for zoom')
  assert.equal(previewSize.height, 128)
  for (const file of result.files) {
    const source = await fs.readFile(path.join(root, '投影文件', file.projection))
    const parsed = nbt.simplify((await nbt.parse(source)).parsed)
    assert.deepEqual(parsed.Regions.MapArt.Size, { x: 130, y: 1, z: 130 })
    const schematic = await Schematic.read(await fs.readFile(path.join(root, 'schem', file.schematic)))
    assert.deepEqual(schematic.size, new Vec3(130, 1, 130))
    assert.equal(schematic.getBlock(new Vec3(1, 0, 0)).name, 'smooth_stone')
    assert.equal(schematic.getBlock(new Vec3(128, 0, 0)).name, 'smooth_stone')
    assert.equal(schematic.getBlock(new Vec3(0, 0, 1)).name, 'air')
    assert.equal(schematic.getBlock(new Vec3(129, 0, 129)).name, 'air')
    assert.equal(schematic.getBlock(new Vec3(64, 0, 64)).name, file.column === 1 ? 'white_carpet' : 'red_carpet')
  }
  assert.deepEqual((await fs.readdir(path.join(root, '投影文件'))).sort(), ['test_1_1.litematic', 'test_1_2.litematic'])
  await assert.rejects(createProjections({ root, image, options: { name: 'test', columns: 2, rows: 1, mode: 'xyz', fit: 'fill' } }), /同名文件已存在/)
  for (const mode of ['rgb+', 'lab94', 'lab00']) {
    const converted = await createProjections({ root, image, options: { name: 'mode-' + mode.replace('+', 'plus'), columns: 1, rows: 1, mode, fit: 'cover' } })
    assert.equal(converted.files.length, 1)
    const schematic = await Schematic.read(await fs.readFile(path.join(root, 'schem', converted.files[0].schematic)))
    assert.equal(schematic.getBlock(new Vec3(1, 0, 0)).name, 'smooth_stone')
    assert.ok(schematic.getBlock(new Vec3(64, 0, 64)).name.endsWith('_carpet'))
  }
})
