const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Worker } = require('node:worker_threads')

function createStudioJobs(root) {
  let active = null
  function status() {
    if (!active) return { running: false }
    return { running: true, id: active.id, kind: active.kind, phase: active.phase, done: active.done,
      total: active.total, cancelling: active.cancelling }
  }
  function cancel(expectedId) {
    if (!active || (expectedId && active.id !== expectedId)) return false
    if (!active.cancelling) {
      active.cancelling = true
      active.worker.postMessage({ type: 'cancel' })
    }
    return true
  }
  function run(kind, image, options) {
    if (active) throw new Error('已有图片转换正在进行；请等待完成或先取消')
    if (!['preview', 'generate'].includes(kind)) throw new Error('未知图片任务类型')
    const worker = new Worker(path.join(__dirname, 'studio_worker.js'), {
      workerData: { kind, root, image, options }
    })
    const task = { id: randomUUID(), worker, kind, phase: 'prepare', done: 0, total: 1, cancelling: false }
    active = task
    const promise = new Promise((resolve, reject) => {
      let settled = false
      function finish(error, result) {
        if (settled) return
        settled = true
        if (active === task) active = null
        if (error) reject(error)
        else resolve(result)
      }
      worker.on('message', message => {
        if (message.type === 'progress') {
          task.phase = message.phase
          task.done = message.done
          task.total = message.total
        } else if (message.type === 'result') finish(null, message.result)
        else if (message.type === 'failure') finish(new Error(message.error))
      })
      worker.on('error', error => finish(error))
      worker.on('exit', code => {
        if (!settled) finish(new Error(`图片工作线程提前退出（代码 ${code}）`))
      })
    })
    promise.jobId = task.id
    return promise
  }
  return { run, cancel, status }
}

module.exports = { createStudioJobs }
