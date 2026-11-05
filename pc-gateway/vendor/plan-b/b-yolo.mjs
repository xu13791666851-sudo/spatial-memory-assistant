import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export function startPcYolo(session, log, { python = process.env.B_PYTHON || 'python' } = {}) {
  const child = spawn(python, ['b-yolo.py'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let ready = false, busy = false, stopped = false, last = '', timer, sentAt = 0, resolveStart, rejectStart
  const started = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject })
  const startupTimer = setTimeout(() => { rejectStart(Error('pc_yolo_start_timeout')); stop() }, 60000)
  const stop = () => { stopped = true; clearInterval(timer); clearTimeout(startupTimer); child.kill() }
  child.on('error', () => { rejectStart(Error('pc_yolo_process_unavailable')); log({ type: 'pc_yolo.failed' }); stop() })
  child.on('exit', code => { ready = false; clearTimeout(startupTimer); rejectStart(Error('pc_yolo_start_failed')); log({ type: 'pc_yolo.exit', code }); clearInterval(timer); session.say?.('电脑检测进程已停止，请检查运行环境后重启。') })
  child.stdin.on('error', () => stop())
  child.stderr.on('data', () => {})
  createInterface({ input: child.stdout }).on('line', async line => {
    try {
      if (line.length > 700 * 1024) throw Error('worker_output_limit')
      const result = JSON.parse(line)
      if (result.ready) { ready = true; clearTimeout(startupTimer); resolveStart(); log({ type: 'pc_yolo.ready', device: result.device }); return }
      if (result.error) throw Error(result.error)
      session.quality = result.quality
      await session.gate.accept(result)
    } catch (error) { log({ type: 'pc_yolo.rejected', reason: error.message }) }
    finally { busy = false }
  })
  timer = setInterval(() => {
    if (busy && performance.now() - sentAt > 10000) { log({ type: 'pc_yolo.timeout' }); stop(); return }
    if (stopped || !ready || busy || !session.task || ['CANCELLED', 'COMPLETED'].includes(session.state)) return
    const frame = session.source.fresh()
    if (!frame || last === `${frame.sourceGeneration}:${frame.frameId}`) return
    const lease = session.gate.lease()
    if (!lease) return
    busy = true; sentAt = performance.now(); last = `${frame.sourceGeneration}:${frame.frameId}`
    child.stdin.write(JSON.stringify({ ...lease, jpeg: undefined, fullJpeg: lease.jpeg.toString('base64') }) + '\n')
  }, 100)
  timer.unref()
  return { stop, started, get ready() { return ready } }
}
