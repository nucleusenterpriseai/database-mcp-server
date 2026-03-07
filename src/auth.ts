/**
 * API Key Authentication Middleware
 *
 * Validates Bearer token on incoming HTTP requests.
 * Uses timing-safe comparison to prevent timing attacks.
 */

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type NextFn = () => void;

/**
 * Create middleware that validates API key from Authorization: Bearer header.
 * Returns 401 for missing/malformed header, 403 for wrong key.
 */
export function createApiKeyMiddleware(apiKey: string) {
  const expectedBuf = Buffer.from(apiKey);

  return (req: IncomingMessage, res: ServerResponse, next: NextFn): void => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing Authorization header' }));
      return;
    }

    const token = header.slice(7);
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing Authorization header' }));
      return;
    }

    const tokenBuf = Buffer.from(token);
    if (expectedBuf.length !== tokenBuf.length || !crypto.timingSafeEqual(expectedBuf, tokenBuf)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid API key' }));
      return;
    }

    next();
  };
}

/**
 * Generate a cryptographically random API key (256-bit, hex-encoded).
 */
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}
