import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { ADMIN_PASSWORD } from './config';

/**
 * Server-enforced admin auth. The admin password (env ADMIN_PASSWORD) is checked
 * ONCE at login; on success we mint a random bearer token kept in memory with a
 * TTL. The token then rides in an httpOnly cookie (set by the login endpoint) and
 * every privileged surface — the admin socket room and the live-game Batman
 * identity — validates it, so the password itself never travels again.
 *
 * Hardening:
 *  - the password compare is CONSTANT-TIME (hash both sides, timingSafeEqual) so
 *    it leaks no length/prefix timing signal;
 *  - login attempts are RATE-LIMITED per client IP with a short lockout, so the
 *    password can't be brute-forced;
 *  - tokens can be revoked (logout) and expire after a TTL.
 *
 * Tokens + failure counters live only in memory: a server restart logs every
 * admin out and clears lockouts (fine for a single-process install).
 */
export const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Login throttling, per client IP.
const MAX_FAILURES = 5; // failures allowed within the window before lockout
const FAILURE_WINDOW_MS = 15 * 60 * 1000; // counting window
const LOCKOUT_MS = 15 * 60 * 1000; // how long a lockout lasts

interface FailRecord {
  failures: number;
  firstAt: number; // start of the current counting window
  lockedUntil: number; // epoch ms; 0 = not locked
}

export class AdminAuth {
  private tokens = new Map<string, number>(); // token → expiry epoch ms
  private fails = new Map<string, FailRecord>(); // ip → failure state

  /** ms remaining on a lockout for this IP, or 0 if not currently locked out. */
  retryAfterMs(ip: string): number {
    const rec = this.fails.get(ip);
    if (!rec) return 0;
    const remaining = rec.lockedUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Constant-time password check; on success mint + return a token, else null.
   * Callers MUST gate this with retryAfterMs() and record failures themselves so
   * the lockout applies regardless of why login was rejected.
   */
  login(password: unknown): string | null {
    if (typeof password !== 'string') return null;
    // Hash both to a fixed 32 bytes so timingSafeEqual never sees a length
    // mismatch (which would itself leak length + throw).
    const a = createHash('sha256').update(password).digest();
    const b = createHash('sha256').update(ADMIN_PASSWORD).digest();
    if (!timingSafeEqual(a, b)) return null;
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
    return token;
  }

  /** Record a failed login for an IP; trips the lockout at MAX_FAILURES. */
  recordFailure(ip: string): void {
    const now = Date.now();
    let rec = this.fails.get(ip);
    if (!rec || now - rec.firstAt > FAILURE_WINDOW_MS) {
      rec = { failures: 0, firstAt: now, lockedUntil: 0 };
    }
    rec.failures++;
    if (rec.failures >= MAX_FAILURES) rec.lockedUntil = now + LOCKOUT_MS;
    this.fails.set(ip, rec);
  }

  /** Clear an IP's failure state (after a successful login). */
  resetFailures(ip: string): void {
    this.fails.delete(ip);
  }

  /** True if the token exists and hasn't expired (prunes expired tokens lazily). */
  validate(token: unknown): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    const expiry = this.tokens.get(token);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  /** Invalidate a token immediately (logout). */
  revoke(token: string | undefined): void {
    if (token) this.tokens.delete(token);
  }
}
