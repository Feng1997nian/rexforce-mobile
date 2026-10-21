export const REXFORCE = Object.freeze({
  SERVICE_UUID: "0000ffe5-0000-1000-8000-00805f9a34fb",
  TX_UUID: "0000ffe4-0000-1000-8000-00805f9a34fb",
  RX_UUID: "0000ffe9-0000-1000-8000-00805f9a34fb",
  FRAME_LENGTH: 244,
  TIMESTAMP_MODULO: 65535,
});

export function decodePoint(high, low, checksum) {
  if (((high + low) & 0xff) !== checksum) return null;
  let raw = (high << 8) | low;
  if (raw >= 0x8000) raw -= 0x10000;
  return raw / 10;
}

export function calibrationCommand(measuredKg, referenceKg) {
  if (!Number.isFinite(measuredKg) || !Number.isFinite(referenceKg) || referenceKg <= 0) {
    throw new Error("请输入有效的显示值和标准砝码重量");
  }
  const factor = Math.round((measuredKg / referenceKg) * 10000);
  if (factor < 0 || factor > 0xffffffff) throw new Error("校准因子超出范围");
  return new Uint8Array([
    0x54, 0xaa,
    (factor >>> 24) & 0xff,
    (factor >>> 16) & 0xff,
    (factor >>> 8) & 0xff,
    factor & 0xff,
  ]);
}

export class RexForceStreamParser {
  constructor() {
    this.buffer = new Uint8Array(0);
    this.lastRawTimestamp = null;
    this.timestampEpoch = 0;
    this.stats = { frames: 0, validPoints: 0, invalidPoints: 0, discardedBytes: 0 };
  }

  reset() {
    this.buffer = new Uint8Array(0);
    this.lastRawTimestamp = null;
    this.timestampEpoch = 0;
    this.stats = { frames: 0, validPoints: 0, invalidPoints: 0, discardedBytes: 0 };
  }

  push(chunk) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer || chunk);
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer);
    merged.set(bytes, this.buffer.length);
    this.buffer = merged;

    const events = [];
    while (this.buffer.length >= 2) {
      if (this.buffer[0] === 0x54 && this.buffer[1] === 0xdd) {
        if (this.buffer.length < 6) break;
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, 6);
        events.push({ type: "temperature", raw: view.getInt32(2, false) });
        this.buffer = this.buffer.slice(6);
        continue;
      }

      if (this.buffer[0] !== 0x01 || (this.buffer[1] !== 0x03 && this.buffer[1] !== 0x05)) {
        this.buffer = this.buffer.slice(1);
        this.stats.discardedBytes += 1;
        continue;
      }
      if (this.buffer.length < REXFORCE.FRAME_LENGTH) break;

      const frame = this.buffer.slice(0, REXFORCE.FRAME_LENGTH);
      this.buffer = this.buffer.slice(REXFORCE.FRAME_LENGTH);
      events.push(this.parseFrame(frame));
    }
    return events;
  }

  unwrapTimestamp(raw) {
    if (this.lastRawTimestamp !== null && raw < this.lastRawTimestamp && this.lastRawTimestamp - raw > 30000) {
      this.timestampEpoch += REXFORCE.TIMESTAMP_MODULO;
    }
    this.lastRawTimestamp = raw;
    return this.timestampEpoch + raw;
  }

  parseFrame(frame) {
    const mode = frame[1] === 0x03 ? "single" : "dual";
    const rawTimestamp = (frame[2] << 8) | frame[3];
    const baseTimestampMs = this.unwrapTimestamp(rawTimestamp);
    const stride = mode === "single" ? 3 : 6;
    const intervalMs = mode === "single" ? 1 : 2;
    const samples = [];

    for (let offset = 4, index = 0; offset < frame.length; offset += stride, index += 1) {
      const primary = decodePoint(frame[offset], frame[offset + 1], frame[offset + 2]);
      const secondary = mode === "dual"
        ? decodePoint(frame[offset + 3], frame[offset + 4], frame[offset + 5])
        : null;
      if (primary === null || (mode === "dual" && secondary === null)) {
        this.stats.invalidPoints += 1;
        continue;
      }
      this.stats.validPoints += 1;
      samples.push({
        timestampMs: baseTimestampMs + index * intervalMs,
        primaryKg: primary,
        secondaryKg: mode === "dual" ? secondary : 0,
        totalKg: primary + (mode === "dual" ? secondary : 0),
      });
    }
    this.stats.frames += 1;
    return { type: "frame", mode, rawTimestamp, baseTimestampMs, samples };
  }
}

export function buildMockFrame({ timestamp = 0, mode = "single", values = [] } = {}) {
  const frame = new Uint8Array(REXFORCE.FRAME_LENGTH);
  frame[0] = 0x01;
  frame[1] = mode === "single" ? 0x03 : 0x05;
  frame[2] = (timestamp >> 8) & 0xff;
  frame[3] = timestamp & 0xff;
  const pointCount = mode === "single" ? 80 : 40;
  for (let i = 0; i < pointCount; i += 1) {
    const pair = mode === "single" ? [values[i] ?? 0] : (values[i] ?? [0, 0]);
    const list = Array.isArray(pair) ? pair : [pair];
    list.forEach((kg, channel) => {
      const raw = Math.max(-32768, Math.min(32767, Math.round(kg * 10)));
      const unsigned = raw < 0 ? raw + 65536 : raw;
      const high = (unsigned >> 8) & 0xff;
      const low = unsigned & 0xff;
      const offset = 4 + i * (mode === "single" ? 3 : 6) + channel * 3;
      frame[offset] = high;
      frame[offset + 1] = low;
      frame[offset + 2] = (high + low) & 0xff;
    });
  }
  return frame;
}
