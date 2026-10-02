const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const config = require('node:fs').existsSync(require('node:path').join(__dirname, 'config.js'))
  ? require('./config') : require('./config.example')
const settings = require('./site_settings')

test('场地编辑包含平滑石和按原配置排列的十六色地毯，不包含 dth 与投影起点', () => {
  const copy = settings.snapshot(config)
  assert.deepEqual(Object.keys(copy.columns), settings.COLUMN_NAMES)
  assert.equal(Object.keys(copy.columns).length, 17)
  assert.match(copy.materialResidence, /^[A-Za-z0-9_.-]+$/)
  assert.match(copy.buildResidence, /^[A-Za-z0-9_.-]+$/)
  assert.equal('buildTransit' in copy, false)
  assert.equal('buildOrigin' in copy, false)
  assert.equal(copy.foodItemName, config.foodChest.itemName)
  assert.deepEqual(settings.validate(copy), copy)
})

test('补给食物只能三选一，且三种物品在游戏版本中可食用', () => {
  const data = require('minecraft-data')('1.20.4')
  const base = settings.snapshot(config)
  assert.deepEqual(settings.FOOD_ITEMS, ['cooked_cod', 'bread', 'cooked_porkchop'])
  for (const itemName of settings.FOOD_ITEMS) {
    assert.ok(data.itemsByName[itemName])
    assert.ok(data.foodsByName[itemName])
    assert.equal(settings.validate({ ...base, foodItemName: itemName }).foodItemName, itemName)
  }
  assert.throws(() => settings.validate({ ...base, foodItemName: 'apple' }), /食物只能选择/)
  assert.throws(() => settings.validate({ ...base, foodItemName: ['bread', 'cooked_cod'] }), /食物只能选择/)
  assert.throws(() => settings.validate({ ...base, foodItemName: undefined }), /食物只能选择/)
})

test('拒绝无效坐标、缺色和未授权字段', () => {
  const base = settings.snapshot(config)
  assert.throws(() => settings.validate({ ...base, discardStand: { x: '37485', y: 90, z: 13886 } }), /整数/)
  const columns = { ...base.columns }
  delete columns.white_carpet
  assert.throws(() => settings.validate({ ...base, columns }), /16 色/)
  assert.throws(() => settings.validate({ ...base, buildTransit: { x: 1, y: 2, z: 3 } }), /不允许/)
  assert.throws(() => settings.validate({ ...base, materialResidence: '/res tp unsafe' }), /材料领地名称/)
})

test('保存可覆盖旧文件，应用时不改 dth 或投影起点', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'mapart-sites-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'settings.json')
  const copy = settings.snapshot(config)
  await settings.save(copy, file)
  const changed = { ...copy, materialResidence: 'new_store', buildResidence: 'new_store.build', foodItemName: 'bread', discardStand: { x: copy.discardStand.x + 1, y: copy.discardStand.y, z: copy.discardStand.z } }
  await settings.save(changed, file)
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), changed)
  const origin = { ...config.sites.build.origin }
  const transit = { ...config.sites.build.arrival }
  settings.apply(config, changed)
  assert.deepEqual(settings.snapshot(config), changed)
  assert.equal(config.sites.material.teleport, '/res tp new_store')
  assert.equal(config.sites.build.teleport, '/res tp new_store.build')
  assert.equal(config.foodChest.itemName, 'bread')
  assert.deepEqual({ ...config.sites.build.origin }, origin)
  assert.deepEqual({ ...config.sites.build.arrival }, transit)
  const oldFormat = { ...copy }
  delete oldFormat.materialResidence
  delete oldFormat.buildResidence
  delete oldFormat.foodItemName
  await fs.writeFile(file, JSON.stringify(oldFormat))
  assert.doesNotThrow(() => settings.load(config, file))
  assert.equal(config.foodChest.itemName, 'bread')
})

test('场地坐标网页脚本可解析，且默认有锁定入口', async () => {
  const vm = require('node:vm')
  const html = await fs.readFile(path.join(__dirname, 'sites.html'), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new vm.Script(script))
  assert.match(html, /id="unlock"/)
  assert.match(html, /id="save"[^>]*disabled/)
  for (const itemName of settings.FOOD_ITEMS) assert.match(html, new RegExp(`<option value="${itemName}">`))
})
