// Isolated Microsoft authentication for each worker account.
// Existing Live-cache tokens can seed the new flow; refreshed tokens stay in
// auth-cache/ and never overwrite the original cache.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const minecraftFolder = require('minecraft-folder-path')
const { Authflow, Titles } = require('prismarine-auth')
const FileCache = require('prismarine-auth/src/common/cache/FileCache')
const { authenticate } = require('minecraft-protocol/src/client/microsoftAuth')

class SeededSisuCache extends FileCache {
  constructor (target, source) {
    super(target)
    this.source = source
  }

  async loadInitialValue () {
    if (fs.existsSync(this.cacheLocation)) return super.loadInitialValue()
    try {
      const original = JSON.parse(fs.readFileSync(this.source, 'utf8'))
      return original.token ? { token: original.token } : {}
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw error
    }
  }
}

function accountHash (username) {
  return crypto.createHash('sha1').update(username, 'binary').digest('hex').slice(0, 6)
}

function makeSisuAuth (connection, projectRoot = __dirname) {
  const username = connection.username
  if (!username || connection.auth !== 'microsoft') throw new Error('Sisu requires a Microsoft account')
  const hash = accountHash(username)
  const oldDir = connection.profilesFolder || path.join(minecraftFolder, 'nmp-cache')
  const newDir = path.join(projectRoot, 'auth-cache', `sisu-${hash}`)
  fs.mkdirSync(newDir, { recursive: true })

  const cacheFactory = ({ cacheName, username: cacheUsername }) => {
    if (cacheUsername !== username) throw new Error('Authentication cache account changed unexpectedly')
    const cachePath = path.join(newDir, `${hash}_${cacheName}-cache.json`)
    if (cacheName === 'sisu') {
      return new SeededSisuCache(cachePath, path.join(oldDir, `${hash}_live-cache.json`))
    }
    return new FileCache(cachePath)
  }

  return function sisuAuth (client, options) {
    client.authflow = new Authflow(username, cacheFactory, {
      flow: 'sisu',
      authTitle: Titles.MinecraftNintendoSwitch,
      deviceType: 'Nintendo'
    }, options.onMsaCode)
    // Encryption reads accessToken/haveCredentials from this same options
    // object. Authenticating a copy would make the server see an offline login.
    authenticate(client, options).catch(error => client.emit('error', error))
  }
}

module.exports = { makeSisuAuth }
