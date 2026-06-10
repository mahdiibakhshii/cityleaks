import { randomBytes } from 'crypto';
import { ADMIN_PASSWORD } from './config';

/**
 * Minimal server-enforced admin auth. The admin password (env ADMIN_PASSWORD,
 * default 252525) is checked ONCE at login; on success we mint a random bearer
 * token kept in memory with a TTL. Every privileged surface — the admin socket
 * room and the live-game Batman identity — validates that token, so the password
 * itself never travels again and admin actions can't be triggered by anyone who
 * merely knows the socket event names.
 *
 * Tokens live only in memory: a server restart logs every admin out (fine for a
 * single-process install — no shared store needed).
 */
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export class AdminAuth {
  private tokens = new Map<string, number>(); // token → expiry epoch ms

  /** Check a password; on success mint + return a token, else null. */
  login(password: unknown): string | null {
    if (typeof password !== 'string' || password !== ADMIN_PASSWORD) return null;
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, Date.now() + TOKEN_TTL_MS);
    return token;
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
}
