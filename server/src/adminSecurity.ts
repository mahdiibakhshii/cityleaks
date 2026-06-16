/**
 * Small shared helpers for admin auth that both the HTTP layer (index.ts) and
 * the socket layer (GameServer.ts) need:
 *  - the admin session cookie name + a dependency-free cookie reader,
 *  - a timestamped audit line for privileged / destructive actions,
 *  - a strict note-id validator (blocks path traversal in file names).
 *
 * The admin token lives ONLY in an httpOnly, Secure, SameSite=Strict cookie —
 * never in a URL query string — so it can't leak into nginx/PM2 access logs,
 * browser history, or Referer headers.
 */

export const ADMIN_COOKIE = 'cl_admin';

/** Read the admin token from a Cookie header (an HTTP req or a socket handshake). */
export function readAdminToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === ADMIN_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** Timestamped audit line for privileged / destructive admin actions. */
export function auditLog(action: string, detail = ''): void {
  console.log(`[admin-audit] ${new Date().toISOString()} ${action}${detail ? ` — ${detail}` : ''}`);
}

/**
 * A safe note id is the server-generated form `n<digits>` (see NoteStore). Using
 * it to build a filename is only safe if it can't contain path separators / `..`,
 * so we validate the shape explicitly rather than relying on lookups elsewhere.
 */
export function isValidNoteId(id: unknown): id is string {
  return typeof id === 'string' && /^n\d+$/.test(id);
}
