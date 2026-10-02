/* One-time Microsoft authorization for the independent left account.
 * This deliberately uses its own cache folder, separate from the right bot.
 */
const mineflayer = require('mineflayer')
const config = require('./config')
const { makeSisuAuth } = require('./right_auth_sisu')

const left = config.workers?.left
if (!left?.username || !left?.profilesFolder) {
  throw new Error('config.workers.left must include username and profilesFolder')
}

console.log('[left-auth] Starting a one-time Microsoft authorization for the left worker.')
console.log('[left-auth] Using a separate left-account login cache.')
console.log(`[left-auth] Follow the device-login instructions and sign in as ${left.expectedMinecraftName || left.username}.`)

const connection = {
  ...config.connection,
  username: left.username,
  profilesFolder: left.profilesFolder,
  auth: 'microsoft'
}
connection.auth = makeSisuAuth(connection, __dirname)
const bot = mineflayer.createBot(connection)

let finished = false
function finish(code) {
  if (finished) return
  finished = true
  process.exitCode = code
  try { bot.quit('left account authorization complete') } catch (_) {}
}

bot.once('login', () => {
  console.log(`[left-auth] Minecraft login accepted as: ${bot.username || '(waiting for profile name)'}`)
})
bot.once('spawn', () => {
  const actual = bot.username || ''
  console.log(`[left-auth] Authorization complete. Server profile: ${actual}`)
  if (left.expectedMinecraftName && actual.toLowerCase() !== left.expectedMinecraftName.toLowerCase()) {
    console.error(`[left-auth] STOP: this is not ${left.expectedMinecraftName}. Do not start dual mode; authorize again with the correct Microsoft account.`)
    return finish(1)
  }
  finish(0)
})
bot.on('kicked', reason => { console.error(`[left-auth] Kicked: ${JSON.stringify(reason)}`); finish(1) })
bot.on('error', error => { console.error(`[left-auth] ${error.message}`); finish(1) })
