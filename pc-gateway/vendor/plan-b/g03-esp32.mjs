import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'

export const MAX_JPEG = 190 * 1024 // Fits the existing 256 KiB base64 GCP limit.
export const STALE_MS = 2000

// The installed Espressif stream supplies Content-Length for every JPEG.
export class MjpegParser {
  constructor(onFrame) { this.onFrame = onFrame; this.buffer = Buffer.alloc(0); this.length = null; this.timestamp = null }
  push(chunk) {
    // Bound allocations even if the upstream supplies an oversized network chunk.
    if (chunk.length > MAX_JPEG + 4096) throw Error('MJPEG chunk too large')
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      if (this.length === null) {
        const end = this.buffer.indexOf('\r\n\r\n')
        if (end < 0) { if (this.buffer.length > 4096) throw Error('MJPEG header too large'); return }
        const header = this.buffer.subarray(0, end).toString('ascii')
        const length = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i)
        if (!length || !/Content-Type:\s*image\/jpeg/i.test(header)) throw Error('Invalid MJPEG part')
        this.length = Number(length[1])
        if (this.length < 4 || this.length > MAX_JPEG) throw Error('Invalid JPEG size')
        this.timestamp = header.match(/X-Timestamp:\s*([\d.]+)/i)?.[1] || null
        this.buffer = this.buffer.subarray(end + 4)
      }
      if (this.buffer.length < this.length) return
      const jpeg = Buffer.from(this.buffer.subarray(0, this.length))
      this.buffer = this.buffer.subarray(this.length); this.length = null
      if (jpeg.readUInt16BE(0) !== 0xffd8 || jpeg.readUInt16BE(jpeg.length - 2) !== 0xffd9) throw Error('Incomplete JPEG')
      this.onFrame(jpeg, this.timestamp)
    }
  }
}

export class Esp32Latest {
  constructor({ streamUrl, token, log = () => {} }) {
    const url = new URL(streamUrl)
    // shortcut: this stage pins the verified device IP; update it after a confirmed DHCP address change.
    if (url.protocol !== 'http:' || url.username || url.password || !/^(172\.16\.2\.116)$/.test(url.hostname)) throw Error('Use the verified ESP32 LAN address')
    Object.assign(this, { streamUrl, token, log, latest: null, frameId: 0, attempts: 0, stopped: false })
  }
  start() {
    if (this.stopped) return
    this.latest = null
    const sourceGeneration = randomUUID(); this.attempts++
    this.log({ type: 'source.connecting', sourceGeneration, attempt: this.attempts })
    let failed = false
    const fail = reason => {
      if (failed || this.stopped) return
      failed = true; this.latest = null; this.request?.destroy()
      this.log({ type: 'source.disconnected', sourceGeneration, reason })
      if (this.attempts < 3) this.retry = setTimeout(() => this.start(), 1000)
    }
    const parser = new MjpegParser((jpeg, deviceTimestamp) => {
      const frame = { jpeg, sourceGeneration, frameId: ++this.frameId, receivedMs: performance.now(),
        deviceTimestamp, sha256: createHash('sha256').update(jpeg).digest('hex') }
      this.latest = frame
      this.log({ type: 'frame.received', ...this.metadata(frame) })
    })
    this.request = http.get(this.streamUrl, { headers: { 'X-Device-Token': this.token }, agent: false }, res => {
      if (res.statusCode !== 200 || !String(res.headers['content-type']).startsWith('multipart/x-mixed-replace')) { res.resume(); fail(`HTTP/content-type ${res.statusCode}`); return }
      res.on('data', data => { try { parser.push(data) } catch (error) { fail(error.message) } })
      res.on('end', () => fail('stream ended'))
      res.on('error', () => fail('stream response error'))
    })
    this.request.setTimeout(5000, () => fail('no bytes for 5000ms'))
    this.request.on('error', () => fail('stream request error'))
  }
  metadata(frame = this.latest) {
    if (!frame) return { available: false }
    const { jpeg, receivedMs, ...meta } = frame
    return { ...meta, bytes: jpeg.length, receivedMs, receiveAgeMs: Math.round(performance.now() - receivedMs), exposureAgeMs: null }
  }
  fresh() { return this.latest && performance.now() - this.latest.receivedMs <= STALE_MS ? this.latest : null }
  stop() { this.stopped = true; clearTimeout(this.retry); this.request?.destroy(); this.latest = null }
}
