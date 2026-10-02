// Check a configured Microsoft account without joining a game server.
const { EventEmitter } = require('events')
const config = require('./config')
const { makeSisuAuth } = require('./right_auth_sisu')

async function main () {
  const side = process.argv[2]
  if (!['right', 'left'].includes(side)) throw new Error('Usage: node auth_check.js right|left')
  const profile = config.workers?.[side]
  if (!profile?.username || !profile.expectedMinecraftName || (side === 'left' && !profile.profilesFolder)) {
    throw new Error(`${side} account is not fully configured`)
  }
  const connection = {
    ...config.connection,
    username: profile.username,
    ...(profile.profilesFolder ? { profilesFolder: profile.profilesFolder } : {})
  }
  const options = {
    ...connection,
    onMsaCode () { throw new Error('Microsoft sign-in is required; check stopped before joining any server') },
    connect () {}
  }
  const client = new EventEmitter()
  await new Promise((resolve, reject) => {
    client.once('error', reject)
    options.connect = resolve
    makeSisuAuth(connection, __dirname)(client, options)
  })
  if (!client.session?.accessToken || options.accessToken !== client.session.accessToken ||
      options.haveCredentials !== true || client.username !== profile.expectedMinecraftName) {
    throw new Error(`Wrong Minecraft account: expected ${profile.expectedMinecraftName}, got ${client.username || '(none)'}`)
  }
  console.log(`[auth] verified ${client.username}; no game server was contacted`)
}

main().catch(error => {
  console.error(`[auth] check failed: ${error.message}`)
  process.exitCode = 1
})
