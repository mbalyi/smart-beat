/** A growing little-endian byte buffer with the string encodings of Guitar Pro 5 files. */

const encoder = new TextEncoder();

export class ByteWriter {
  private buffer = new Uint8Array(4096);
  private length = 0;

  private ensure(extra: number) {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  get size(): number {
    return this.length;
  }

  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  u8(value: number): this {
    this.ensure(1);
    this.buffer[this.length++] = value & 0xff;
    return this;
  }

  /** Signed byte (-128…127). */
  i8(value: number): this {
    return this.u8(value);
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  i16(value: number): this {
    this.ensure(2);
    this.buffer[this.length++] = value & 0xff;
    this.buffer[this.length++] = (value >> 8) & 0xff;
    return this;
  }

  i32(value: number): this {
    this.ensure(4);
    for (let shift = 0; shift < 32; shift += 8)
      this.buffer[this.length++] = (value >> shift) & 0xff;
    return this;
  }

  /** IEEE 754 double, big-endian (used for a note's duration percentage). */
  f64BE(value: number): this {
    this.ensure(8);
    new DataView(this.buffer.buffer).setFloat64(this.length, value, false);
    this.length += 8;
    return this;
  }

  bytes(data: ArrayLike<number>): this {
    this.ensure(data.length);
    for (let i = 0; i < data.length; i++) this.buffer[this.length++] = data[i]! & 0xff;
    return this;
  }

  /** `count` zero bytes. */
  zeros(count: number): this {
    this.ensure(count);
    this.length += count;
    return this;
  }

  /** A length byte followed by the text padded with zeros to `field` bytes (longer text is cut). */
  fixedString(text: string, field: number): this {
    const data = encodeCut(text, Math.min(field, 255));
    this.u8(data.length);
    this.bytes(data);
    return this.zeros(field - data.length);
  }

  /** Int length (text + 1), byte length, text: how most strings are stored. */
  intByteString(text: string): this {
    const data = encodeCut(text, 254);
    this.i32(data.length + 1);
    this.u8(data.length);
    return this.bytes(data);
  }

  /** Int length, text (lyrics). */
  intString(text: string): this {
    const data = encoder.encode(text);
    this.i32(data.length);
    return this.bytes(data);
  }
}

/** UTF-8 bytes of `text`, cut to at most `max` bytes without splitting a character. */
export function encodeCut(text: string, max: number): Uint8Array {
  const data = encoder.encode(text);
  if (data.length <= max) return data;
  let end = max;
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
  return data.slice(0, end);
}
