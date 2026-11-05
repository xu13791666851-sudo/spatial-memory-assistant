import { createHash, randomUUID } from 'node:crypto'
import { MAX_JPEG, STALE_MS } from './g03-esp32.mjs'

// Same latest-frame contract as ESP32; the paired foreground client owns capture.
export class PhoneLatest {
  constructor({ log = () => {}, now = () => performance.now() } = {}) {
    Object.assign(this, { log, now, generation: null, sequence: 0, frameId: 0, latest: null, kind: 'phone' })
  }
  start() { this.generation = randomUUID(); this.sequence = 0; this.latest = null; return this.generation }
  stop() { this.latest = null; this.generation = null }
  accept(jpeg, generation, sequence) {
    if (!this.generation || generation !== this.generation) throw Error('phone_generation_invalid')
    if (!Number.isSafeInteger(sequence) || sequence <= this.sequence) throw Error('phone_sequence_invalid')
    if (jpeg.length < 4 || jpeg.length > MAX_JPEG || jpeg.readUInt16BE(0) !== 0xffd8 || jpeg.readUInt16BE(jpeg.length - 2) !== 0xffd9) throw Error('phone_jpeg_invalid')
    this.sequence = sequence
    this.latest = { jpeg, sourceGeneration: generation, frameId: ++this.frameId, receivedMs: this.now(), deviceTimestamp: null,
      sha256: createHash('sha256').update(jpeg).digest('hex') }
    this.log({ type: 'frame.received', source: 'phone', ...this.metadata() })
    return this.latest
  }
  fresh() { return this.latest && this.now() - this.latest.receivedMs <= STALE_MS ? this.latest : null }
  metadata(frame = this.latest) {
    if (!frame) return { available: false }
    const { jpeg, receivedMs, ...meta } = frame
    return { ...meta, bytes: jpeg.length, receivedMs, receiveAgeMs: Math.round(this.now() - receivedMs), exposureAgeMs: null }
  }
}

// Invoked only behind startLan's pairing cookie/host checks.
export function phoneSourceHttp(source, req, res, url) {
  if (!url.pathname.startsWith('/g06/source/')) return false
  const json = (code, data) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
  if (source.kind !== 'phone') { json(409, { error: 'phone_source_not_selected' }); return true }
  if (req.method !== 'POST') { json(405, { error: 'method' }); return true }
  if (req.headers.origin !== `https://${req.headers.host}`) { json(403, { error: 'origin' }); return true }
  if (url.pathname === '/g06/source/start') { json(200, { generation: source.start() }); return true }
  if (url.searchParams.get('generation') !== source.generation || !source.generation) { json(409, { error: 'phone_generation_invalid' }); return true }
  if (url.pathname === '/g06/source/stop') { source.stop(); json(200, { ok: true }); return true }
  if (url.pathname !== '/g06/source/frame') { json(404, { error: 'path' }); return true }
  void (async () => {
    try {
      if (req.headers['content-type'] !== 'image/jpeg') { json(415, { error: 'jpeg_required' }); return }
      const parts = []; let bytes = 0
      for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_JPEG) { json(413, { error: 'image_too_large' }); return }; parts.push(chunk) }
      const frame = source.accept(Buffer.concat(parts), url.searchParams.get('generation'), Number(url.searchParams.get('sequence')))
      json(200, { frameId: frame.frameId })
    } catch { json(400, { error: 'phone_frame_invalid' }) }
  })()
  return true
}
