const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { Authflow } = require('prismarine-auth')
const { makeSisuAuth } = require('./right_auth_sisu')

test('isolated authentication passes credentials to the actual connection options', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mapart-sisu-test-'))
  const oldDir = path.join(fixtureRoot, 'old')
  fs.mkdirSync(oldDir)
  const username = 'sandbox-worker-account'
  const hash = crypto.createHash('sha1').update(username, 'binary').digest('hex').slice(0, 6)
  const oldCachePath = path.join(oldDir, `${hash}_live-cache.json`)
  const originalCache = JSON.stringify({ token: { refresh_token: 'test-only-refresh-token' } })
  fs.writeFileSync(oldCachePath, originalCache)
  const original = Authflow.prototype.getMinecraftJavaToken
  Authflow.prototype.getMinecraftJavaToken = async () => ({
    token: 'test-only-token',
    profile: { name: 'SandboxBot' },
    entitlements: {},
    certificates: {}
  })
  try {
    const client = new EventEmitter()
    const options = { username, disableChatSigning: true, connect: () => {} }
    const connected = new Promise((resolve, reject) => {
      client.once('error', reject)
      const auth = makeSisuAuth({ username, auth: 'microsoft', profilesFolder: oldDir }, fixtureRoot)
      options.connect = resolve
      auth(client, options)
    })
    await connected
    assert.equal(client.username, 'SandboxBot')
    assert.equal(client.session.accessToken, 'test-only-token')
    assert.equal(options.accessToken, 'test-only-token')
    assert.equal(options.haveCredentials, true)
    assert.equal(client.authflow.options.flow, 'sisu')
    const seed = await client.authflow.msa.cache.getCached()
    assert.equal(seed.token.refresh_token, 'test-only-refresh-token')
    await client.authflow.msa.cache.setCachedPartial({ token: { refresh_token: 'new-test-token' } })
    assert.equal(fs.readFileSync(oldCachePath, 'utf8'), originalCache)
    assert.equal(fs.existsSync(path.join(fixtureRoot, 'auth-cache', `sisu-${hash}`, `${hash}_sisu-cache.json`)), true)
  } finally {
    Authflow.prototype.getMinecraftJavaToken = original
    if (!fixtureRoot.startsWith(path.join(os.tmpdir(), 'mapart-sisu-test-'))) throw new Error('Unsafe test fixture path')
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
