import { createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface WorkerClaims {
  workerId: string;
  exp: number; // epoch seconds
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');

/** Compact HMAC-SHA256 token: base64url(json).base64url(sig). Not a JWT on purpose - no alg negotiation. */
export function signWorkerToken(secret: string, workerId: string, ttlSeconds: number, nowMs = Date.now()): { token: string; expiresAt: string } {
  const claims: WorkerClaims = { workerId, exp: Math.floor(nowMs / 1000) + ttlSeconds };
  const body = b64(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return { token: `${body}.${sig}`, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

export function verifyWorkerToken(secret: string, token: string, nowMs = Date.now()): WorkerClaims | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as WorkerClaims;
    if (typeof claims.workerId !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 <= nowMs) return null;
    return claims;
  } catch {
    return null;
  }
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer (.+)$/.exec(header);
  return m?.[1] ?? null;
}
