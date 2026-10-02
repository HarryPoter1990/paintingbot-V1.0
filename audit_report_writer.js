const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

async function writeAuditReport(destination, report, fileSystem = fs) {
  // Serialize before touching the existing report. Readers should only ever
  // see the old complete snapshot or the new complete snapshot.
  const contents = JSON.stringify(report, null, 2)
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  await fileSystem.mkdir(path.dirname(destination), { recursive: true })
  try {
    await fileSystem.writeFile(temporary, contents, { flag: 'wx' })
    await fileSystem.rename(temporary, destination)
  } catch (error) {
    try { await fileSystem.unlink(temporary) } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') console.warn(`[audit] could not remove temporary report ${temporary}: ${cleanupError.message}`)
    }
    throw error
  }
}

module.exports = { writeAuditReport }
