const test = require('node:test')
const assert = require('node:assert/strict')
const { missing } = require('./initial_setup')
const accountSettings = require('./connection_settings')

function configured() {
  const point = { x: 100, y: 70, z: 200 }
  return {
    setupTemplate: true,
    connection: { host: 'mc.example.org', port: 25565, username: 'main-cache' },
    workers: {
      right: { username: 'main-cache', expectedMinecraftName: 'MainBot' },
      left: { username: '', expectedMinecraftName: '' }
    },
    sites: {
      material: { teleport: '/res tp warehouse', arrival: point },
      build: { teleport: '/res tp art', arrival: point }
    },
    storage: { anchor: point, columns: { smooth_stone: point }, leftovers: { stand: point } },
    foodChest: { position: point, access: point }
  }
}

test('single bot needs no second account, dual bot does', () => {
  const config = configured()
  assert.deepEqual(missing(config), [])
  assert.match(missing(config, 'dual').join('、'), /第二机器人/)
  config.workers.left = { username: 'other-cache', expectedMinecraftName: 'OtherBot' }
  assert.deepEqual(missing(config, 'dual'), [])
})

test('template coordinates and incomplete primary account block startup', () => {
  const config = configured()
  config.connection.host = ''
  config.workers.right.expectedMinecraftName = ''
  config.foodChest.position = { x: 0, y: 64, z: 0 }
  assert.match(missing(config).join('、'), /服务器地址.*主机器人游戏名.*食物箱位置/)
})

test('account settings update cache label and actual game name together', () => {
  const config = configured()
  const data = accountSettings.snapshot(config)
  data.right = { username: 'new-cache', expectedMinecraftName: 'NewBot' }
  data.host = 'another.example.org'
  accountSettings.apply(config, data)
  assert.equal(config.connection.username, 'new-cache')
  assert.equal(config.connection.expectedMinecraftName, 'NewBot')
  assert.equal(config.workers.right.expectedMinecraftName, 'NewBot')
  assert.equal(config.connection.host, 'another.example.org')
})

test('changing the optional second account gives it a separate auth cache', () => {
  const config = configured()
  config.workers.left.profilesFolder = './auth-cache/old-left'
  const data = accountSettings.snapshot(config)
  data.left = { username: 'new-left-account', expectedMinecraftName: 'NewLeft' }
  accountSettings.apply(config, data)
  assert.match(config.workers.left.profilesFolder, /^\.\/auth-cache\/left_[a-f0-9]{12}$/)
  assert.notEqual(config.workers.left.profilesFolder, './auth-cache/old-left')
})
