// Three-slot snapshot ring over a SharedArrayBuffer (implementation doc 5.1).
// The writer fills the next slot, publishes its sequence number and calls
// Atomics.notify; readers wake on Atomics.waitAsync, or poll readLatest() from
// a requestAnimationFrame loop. A per-slot sequence makes each read a seqlock,
// so a reader that falls three frames behind retries instead of tearing.

const HEADER_INTS = 8;            // [seq, -, len0, len1, len2, seq0, seq1, seq2]
const SLOTS = 3;

export class SnapshotRing {
  readonly sab: SharedArrayBuffer;
  private header: Int32Array;
  private bytes: Uint8Array;
  private enc = new TextEncoder();
  private dec = new TextDecoder();
  readonly slotBytes: number;

  constructor(sabOrSlotBytes: SharedArrayBuffer | number) {
    if (typeof sabOrSlotBytes === 'number') {
      this.slotBytes = sabOrSlotBytes;
      this.sab = new SharedArrayBuffer(HEADER_INTS * 4 + SLOTS * sabOrSlotBytes);
    } else {
      this.sab = sabOrSlotBytes;
      this.slotBytes = (sabOrSlotBytes.byteLength - HEADER_INTS * 4) / SLOTS;
    }
    this.header = new Int32Array(this.sab, 0, HEADER_INTS);
    this.bytes = new Uint8Array(this.sab, HEADER_INTS * 4);
  }

  get seq(): number {
    return Atomics.load(this.header, 0);
  }

  write(value: unknown): boolean {
    const data = this.enc.encode(JSON.stringify(value));
    if (data.length > this.slotBytes) return false;
    const next = Atomics.load(this.header, 0) + 1;
    const slot = next % SLOTS;
    Atomics.store(this.header, 5 + slot, -1);                  // mark slot as being written
    this.bytes.set(data, slot * this.slotBytes);
    Atomics.store(this.header, 2 + slot, data.length);
    Atomics.store(this.header, 5 + slot, next);
    Atomics.store(this.header, 0, next);
    Atomics.notify(this.header, 0);
    return true;
  }

  /** Latest snapshot, or null when nothing newer than `afterSeq` exists. */
  readLatest<T>(afterSeq = -1): { seq: number; value: T } | null {
    for (let attempt = 0; attempt < 4; attempt++) {
      const seq = Atomics.load(this.header, 0);
      if (seq <= afterSeq || seq === 0) return null;
      const slot = seq % SLOTS;
      const len = Atomics.load(this.header, 2 + slot);
      const copy = this.bytes.slice(slot * this.slotBytes, slot * this.slotBytes + len); // non-shared copy
      if (Atomics.load(this.header, 5 + slot) !== seq) continue;  // overwritten while copying
      return { seq, value: JSON.parse(this.dec.decode(copy)) as T };
    }
    return null;
  }

  /** A specific snapshot, if its slot has not been overwritten yet (lets a lagging reader catch up). */
  readAt<T>(seq: number): T | null {
    const slot = seq % SLOTS;
    if (Atomics.load(this.header, 5 + slot) !== seq) return null;
    const len = Atomics.load(this.header, 2 + slot);
    const copy = this.bytes.slice(slot * this.slotBytes, slot * this.slotBytes + len);
    if (Atomics.load(this.header, 5 + slot) !== seq) return null;
    return JSON.parse(this.dec.decode(copy)) as T;
  }

  /** Resolve when the sequence number moves past `seq` (Atomics.waitAsync where supported). */
  waitPast(seq: number, timeoutMs = 50): Promise<void> {
    const A = Atomics as unknown as {
      waitAsync?: (a: Int32Array, i: number, v: number, t?: number) => { async: boolean; value: Promise<string> | string };
    };
    if (A.waitAsync) {
      const r = A.waitAsync(this.header, 0, seq, timeoutMs);
      return r.async ? (r.value as Promise<string>).then(() => undefined) : Promise.resolve();
    }
    return new Promise(res => setTimeout(res, 1));
  }
}

export const hasWaitAsync = (): boolean => typeof (Atomics as unknown as { waitAsync?: unknown }).waitAsync === 'function';
