// Constant-space RFC 6455 boundary tracker. Payload bytes are counted, never inspected.
export const WS_WINDOW_BYTES = 256 * 1024;
export class FrameBoundary {
  constructor() { this.header = Buffer.alloc(14); this.used = 0; this.need = 2; this.remaining = 0n; this.invalid = false; this.closed = false; }
  get boundary() { return !this.invalid && this.used === 0 && this.remaining === 0n; }
  push(bytes) {
    let offset = 0;
    while (offset < bytes.length && !this.invalid) {
      if (this.remaining) {
        const count = Number(this.remaining < BigInt(bytes.length - offset) ? this.remaining : BigInt(bytes.length - offset));
        this.remaining -= BigInt(count); offset += count;
        continue;
      }
      this.header[this.used++] = bytes[offset++];
      if (this.used === 2) {
        const length = this.header[1] & 127;
        this.need = 2 + (length === 126 ? 2 : length === 127 ? 8 : 0) + (this.header[1] & 128 ? 4 : 0);
      }
      if (this.used !== this.need) continue;
      const length = this.header[1] & 127;
      if (length === 127 && (this.header[2] & 128)) { this.invalid = true; break; }
      this.remaining = length === 127 ? this.header.readBigUInt64BE(2) : BigInt(length === 126 ? this.header.readUInt16BE(2) : length);
      if ((this.header[0] & 15) === 8) this.closed = true;
      this.used = 0; this.need = 2;
    }
    return !this.invalid;
  }
}
