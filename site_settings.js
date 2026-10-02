const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')

const FILE = path.join(__dirname, 'state', 'site-settings.json')
const CARPETS = [
  'white_carpet', 'orange_carpet', 'magenta_carpet', 'light_blue_carpet',
  'yellow_carpet', 'lime_carpet', 'pink_carpet', 'gray_carpet',
  'light_gray_carpet', 'cyan_carpet', 'purple_carpet', 'blue_carpet',
  'brown_carpet', 'green_carpet', 'red_carpet', 'black_carpet'
]
const COLUMN_NAMES = ['smooth_stone', ...CARPETS]

function point(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['x', 'y', 'z'].every(axis => Number.isSafeInteger(value[axis]) && Math.abs(value[axis]) <= 30000000) ||
      Object.keys(value).some(key => !['x', 'y', 'z'].includes(key))) {
    throw new Error(`${label}：请输入有效的整数 X / Y / Z 坐标`)
  }
  return { x: value.x, y: value.y, z: value.z }
}

function vec(value) { return new Vec3(value.x, value.y, value.z) }
function plain(value) { return { x: value.x, y: value.y, z: value.z } }
function residence(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    throw new Error(`${label}：只允许英文、数字、下划线、点和短横线，不要填写 /res tp`)
  }
  return value
}
function nameFromTeleport(command) {
  const match = /^\/res tp ([A-Za-z0-9_.-]+)$/.exec(command || '')
  if (!match) throw new Error('现有领地传送指令格式不正确')
  return match[1]
}

function snapshot(config) {
  return {
    materialResidence: nameFromTeleport(config.sites.material.teleport),
    buildResidence: nameFromTeleport(config.sites.build.teleport),
    materialArrival: plain(config.sites.material.arrival),
    materialAnchor: plain(config.storage.anchor),
    storageAccessOffset: plain(config.storage.accessOffset),
    storageLevels: config.storage.levels,
    storageAccessYStep: config.storage.accessYStep,
    columns: Object.fromEntries(COLUMN_NAMES.map(name => [name, plain(config.storage.columns[name])])),
    foodChestPosition: plain(config.foodChest.position),
    foodChestAccess: plain(config.foodChest.access),
    discardStand: plain(config.storage.leftovers.stand),
    discardFacing: config.storage.leftovers.facing
  }
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('场地设置格式不正确')
  const fields = ['materialResidence', 'buildResidence', 'materialArrival', 'materialAnchor', 'storageAccessOffset', 'storageLevels',
    'storageAccessYStep', 'columns', 'foodChestPosition', 'foodChestAccess', 'discardStand', 'discardFacing']
  if (Object.keys(input).some(key => !fields.includes(key)) || fields.some(key => !(key in input))) {
    throw new Error('场地设置字段不完整，或包含不允许修改的字段')
  }
  if (!input.columns || typeof input.columns !== 'object' || Array.isArray(input.columns) ||
      Object.keys(input.columns).length !== COLUMN_NAMES.length ||
      Object.keys(input.columns).some(name => !COLUMN_NAMES.includes(name))) {
    throw new Error('材料桶配置必须包含平滑石头和全部 16 色地毯')
  }
  if (!Number.isSafeInteger(input.storageLevels) || input.storageLevels < 1 || input.storageLevels > 64) {
    throw new Error('桶列层数只能是 1 至 64 的整数')
  }
  if (!Number.isSafeInteger(input.storageAccessYStep) || input.storageAccessYStep < -8 || input.storageAccessYStep > 8) {
    throw new Error('每层站位 Y 偏移只能是 -8 至 8 的整数')
  }
  if (!['north', 'south', 'east', 'west'].includes(input.discardFacing)) throw new Error('丢弃方向不正确')
  return {
    materialResidence: residence(input.materialResidence, '材料领地名称'),
    buildResidence: residence(input.buildResidence, '建造子领地名称'),
    materialArrival: point(input.materialArrival, '主领地落点'),
    materialAnchor: point(input.materialAnchor, '材料区锚点'),
    storageAccessOffset: point(input.storageAccessOffset, '桶前站位偏移'),
    storageLevels: input.storageLevels,
    storageAccessYStep: input.storageAccessYStep,
    columns: Object.fromEntries(COLUMN_NAMES.map(name => [name, point(input.columns[name], name)])),
    foodChestPosition: point(input.foodChestPosition, '食物箱'),
    foodChestAccess: point(input.foodChestAccess, '食物箱站位'),
    discardStand: point(input.discardStand, '丢弃站位'),
    discardFacing: input.discardFacing
  }
}

function apply(config, input) {
  const data = validate(input)
  config.sites.material.teleport = `/res tp ${data.materialResidence}`
  config.sites.build.teleport = `/res tp ${data.buildResidence}`
  config.sites.material.arrival = vec(data.materialArrival)
  config.storage.anchor = vec(data.materialAnchor)
  config.storage.accessOffset = vec(data.storageAccessOffset)
  config.storage.levels = data.storageLevels
  config.storage.accessYStep = data.storageAccessYStep
  for (const name of COLUMN_NAMES) config.storage.columns[name] = vec(data.columns[name])
  config.foodChest.position = vec(data.foodChestPosition)
  config.foodChest.access = vec(data.foodChestAccess)
  config.storage.leftovers.stand = vec(data.discardStand)
  config.storage.leftovers.facing = data.discardFacing
  return data
}

function load(config, file = FILE) {
  if (!fs.existsSync(file)) return config
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    // Site files saved before residence-name editing did not include these two fields.
    saved.materialResidence ??= nameFromTeleport(config.sites.material.teleport)
    saved.buildResidence ??= nameFromTeleport(config.sites.build.teleport)
    apply(config, saved)
  } catch (error) { throw new Error(`场地坐标配置无效（${file}）：${error.message}`) }
  return config
}

async function save(input, file = FILE) {
  const data = validate(input)
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    await fs.promises.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    await fs.promises.rename(temp, file)
  } finally { await fs.promises.rm(temp, { force: true }).catch(() => {}) }
  return data
}

module.exports = { CARPETS, COLUMN_NAMES, FILE, snapshot, validate, apply, load, save }
