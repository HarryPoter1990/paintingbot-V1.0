// Create only a local, ignored template. Never overwrite an existing setup.
const fs = require('node:fs')
const path = require('node:path')
const target = path.join(__dirname, 'config.js')
if (!fs.existsSync(target)) {
  try { fs.copyFileSync(path.join(__dirname, 'config.example.js'), target, fs.constants.COPYFILE_EXCL) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
