// Render the alert voice library once with MeloTTS on Workers AI (implementation 6.1).
// Each phrase in CLIP_PHRASES becomes one MP3 clip; all clips are packed into
// apps/web/public/voice/clips.bin with a manifest of byte ranges (clips.json).
// About 180 short fragments at 18.63 neurons per audio minute: well under 100 neurons.
//
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... pnpm gen:voice        (needs ffmpeg on PATH)
//
// Without CF_API_TOKEN it falls back to the local wrangler OAuth login.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIP_PHRASES } from '../packages/nl/src/templates';

const OUT = new URL('../apps/web/public/voice/', import.meta.url);

function wranglerToken(): string | null {
  const candidates = [
    join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
    join(homedir(), '.config/.wrangler/config/default.toml'),
    join(homedir(), '.wrangler/config/default.toml'),
  ];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/);
    if (m) return m[1]!;
  }
  return null;
}

async function accountId(token: string): Promise<string> {
  if (process.env.CF_ACCOUNT_ID) return process.env.CF_ACCOUNT_ID;
  const r = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: { Authorization: `Bearer ${token}` } });
  const j = (await r.json()) as { result?: { id: string }[] };
  const id = j.result?.[0]?.id;
  if (!id) throw new Error('No Cloudflare account found; set CF_ACCOUNT_ID');
  return id;
}

async function synth(token: string, account: string, text: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/myshell-ai/melotts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: text, lang: 'en' }),
    });
    if (r.ok) {
      const j = (await r.json()) as { result?: { audio?: string } };
      if (j.result?.audio) return Buffer.from(j.result.audio, 'base64');
    }
    await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
  }
  throw new Error(`MeloTTS failed for "${text}"`);
}

async function main(): Promise<void> {
  const token = process.env.CF_API_TOKEN ?? wranglerToken();
  if (!token) throw new Error('Set CF_API_TOKEN or run `npx wrangler login` first');
  const account = await accountId(token);
  const work = mkdtempSync(join(tmpdir(), 'wingmind-voice-'));
  mkdirSync(OUT, { recursive: true });
  const parts: Buffer[] = [];
  const manifest: { version: 1; clips: Record<string, [number, number]> } = { version: 1, clips: {} };
  let offset = 0;
  try {
    for (const [i, phrase] of CLIP_PHRASES.entries()) {
      const wav = await synth(token, account, phrase);
      const inFile = join(work, `${i}.wav`);
      const outFile = join(work, `${i}.mp3`);
      writeFileSync(inFile, wav);
      // trim leading and trailing silence, mono 24 kHz, 48 kbps
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', inFile, '-af',
        'silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=1:stop_threshold=-45dB:stop_silence=0.04,atempo=1.12',
        '-ac', '1', '-ar', '24000', '-b:a', '48k', outFile]);
      const mp3 = readFileSync(outFile);
      manifest.clips[phrase] = [offset, mp3.length];
      parts.push(mp3);
      offset += mp3.length;
      process.stdout.write(`\r${i + 1}/${CLIP_PHRASES.length} ${phrase.padEnd(40)}`);
    }
    writeFileSync(new URL('clips.bin', OUT), Buffer.concat(parts));
    writeFileSync(new URL('clips.json', OUT), `${JSON.stringify(manifest)}\n`);
    console.log(`\nwrote ${CLIP_PHRASES.length} clips, ${(offset / 1024).toFixed(0)} KB`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
