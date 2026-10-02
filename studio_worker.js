const { parentPort, workerData } = require('node:worker_threads')
const { previewConversion, createProjections } = require('./studio_generator')

const controller = new AbortController()
parentPort.on('message', message => {
  if (message?.type === 'cancel') controller.abort()
})

async function run() {
  const input = {
    image: Buffer.from(workerData.image), options: workerData.options,
    signal: controller.signal,
    onProgress: progress => parentPort.postMessage({ type: 'progress', ...progress })
  }
  return workerData.kind === 'preview'
    ? previewConversion(input)
    : createProjections({ ...input, root: workerData.root })
}

run().then(result => {
  parentPort.postMessage({ type: 'result', result })
}).catch(error => {
  parentPort.postMessage({ type: 'failure', error: error.message })
}).finally(() => parentPort.close())
