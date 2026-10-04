// A small PCM WAV writer used for test fixtures (a fake microphone clip).

export function makeToneWav(seconds: number, sampleRate: number, freqs: number[] = [220, 330, 440]): Buffer {
  const n = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // a voice-like buzz with a syllable envelope, so a recorder has something to capture
    const env = Math.max(0, Math.sin(Math.PI * Math.min(1, t / seconds) * 2)) * 0.5;
    let v = 0;
    for (const f of freqs) v += Math.sin(2 * Math.PI * f * t) / freqs.length;
    data.writeInt16LE(Math.round(v * env * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
