import { decodeBytes } from "./tokenizer.js";

/**
 * Maps byte ranges to small integer codes (FNV-1a hash, open addressing, byte-exact comparison), so a
 * string column with millions of rows but few distinct values (atom names, residue names, chains) decodes
 * to a code array plus a short dictionary without allocating a string per row.
 */
export class ByteInterner {
  readonly values: string[] = [];
  private pool = new Uint8Array(1024);
  private poolLen = 0;
  private offsets: number[] = [0];
  private table = new Int32Array(64).fill(-1);
  private hashes: number[] = [];

  intern(buf: Uint8Array, start: number, end: number): number {
    let h = 0x811c9dc5;
    for (let i = start; i < end; i++) h = Math.imul(h ^ buf[i]!, 16777619);
    h >>>= 0;
    const mask = this.table.length - 1;
    let slot = h & mask;
    for (;;) {
      const id = this.table[slot]!;
      if (id < 0) break;
      if (this.hashes[id] === h && this.equals(id, buf, start, end)) return id;
      slot = (slot + 1) & mask;
    }
    const id = this.values.length;
    this.values.push(decodeBytes(buf, start, end));
    this.hashes.push(h);
    this.store(buf, start, end);
    this.table[slot] = id;
    if (this.values.length * 2 > this.table.length) this.grow();
    return id;
  }

  private equals(id: number, buf: Uint8Array, start: number, end: number): boolean {
    const a = this.offsets[id]!, n = this.offsets[id + 1]! - a;
    if (n !== end - start) return false;
    for (let i = 0; i < n; i++) if (this.pool[a + i] !== buf[start + i]) return false;
    return true;
  }

  private store(buf: Uint8Array, start: number, end: number): void {
    const n = end - start;
    if (this.poolLen + n > this.pool.length) {
      const p = new Uint8Array(Math.max(this.pool.length * 2, this.poolLen + n));
      p.set(this.pool.subarray(0, this.poolLen));
      this.pool = p;
    }
    this.pool.set(buf.subarray(start, end), this.poolLen);
    this.poolLen += n;
    this.offsets.push(this.poolLen);
  }

  private grow(): void {
    const table = new Int32Array(this.table.length * 2).fill(-1);
    const mask = table.length - 1;
    for (let id = 0; id < this.hashes.length; id++) {
      let slot = this.hashes[id]! & mask;
      while (table[slot]! >= 0) slot = (slot + 1) & mask;
      table[slot] = id;
    }
    this.table = table;
  }
}
