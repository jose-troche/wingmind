// Turnstile check on session start (implementation 7.1). Enabled when the
// TURNSTILE_SECRET secret is set; see README for why production leaves it off
// while the console needs cross-origin isolation.

export async function verifyTurnstile(secret: string, token: string, remoteIp: string): Promise<boolean> {
  if (!token) return false;
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (remoteIp && remoteIp !== 'local') body.append('remoteip', remoteIp);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  if (!r.ok) return false;
  const j = (await r.json()) as { success?: boolean };
  return j.success === true;
}
