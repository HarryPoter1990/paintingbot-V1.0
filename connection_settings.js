const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const FILE = path.join(__dirname, 'state', 'connection-settings.json')

function snapshot(config) {
  return {
    host: config.connection.host,
    port: config.connection.port,
    right: {
      username: config.workers.right.username || '',
      expectedMinecraftName: config.workers.right.expectedMinecraftName || ''
    },
    left: {
      username: config.workers.left.username || '',
      expectedMinecraftName: config.workers.left.expectedMinecraftName || ''
    }
  }
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('服务器与账号设置格式不正确')
  const value = (text, label) => {
    if (typeof text !== 'string' || text.length > 100 || /[\x00-\x1f\/\\:*?"<>|]/.test(text)) throw new Error(`${label}格式不正确`)
    return text.trim()
  }
  const host = value(input.host, '服务器地址')
  if (host && !/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('服务器地址只填域名或 IP，不要带端口或协议')
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('服务器端口必须是 1 至 65535')
  const worker = (source, label) => ({
    username: value(source?.username, `${label}登录缓存标签`),
    expectedMinecraftName: value(source?.expectedMinecraftName, `${label}游戏名`)
  })
  return { host, port, right: worker(input.right, '主机器人'), left: worker(input.left, '第二机器人') }
}

function apply(config, input) {
  const data = validate(input)
  const previousLeftUsername = config.workers.left.username
  config.connection.host = data.host
  config.connection.port = data.port
  config.connection.username = data.right.username
  config.connection.expectedMinecraftName = data.right.expectedMinecraftName
  for (const side of ['right', 'left']) {
    config.workers[side].username = data[side].username
    config.workers[side].expectedMinecraftName = data[side].expectedMinecraftName
  }
  if (data.left.username && data.left.username !== previousLeftUsername) {
    const key = crypto.createHash('sha256').update(data.left.username).digest('hex').slice(0, 12)
    config.workers.left.profilesFolder = `./auth-cache/left_${key}`
  }
  return data
}

function load(config, file = FILE) {
  if (!fs.existsSync(file)) return config
  try { apply(config, JSON.parse(fs.readFileSync(file, 'utf8'))) }
  catch (error) { throw new Error(`服务器与账号配置无效（${file}）：${error.message}`) }
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

module.exports = { FILE, snapshot, validate, apply, load, save }
