/**
 * API Key Auth Middleware Tests (Task 1.3)
 *
 * Tests for createApiKeyMiddleware and generateApiKey.
 */

import { describe, it, expect, vi } from 'vitest';
import { createApiKeyMiddleware, generateApiKey } from '../src/auth.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

function mockReqRes(authHeader?: string) {
  const req = {
    headers: authHeader !== undefined ? { authorization: authHeader } : {},
  } as unknown as IncomingMessage;

  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
    writeHead: vi.fn().mockReturnThis(),
  } as unknown as ServerResponse;

  const next = vi.fn();

  return { req, res, next };
}

describe('createApiKeyMiddleware', () => {
  const API_KEY = 'a'.repeat(64);
  const middleware = createApiKeyMiddleware(API_KEY);

  it('should call next() for valid API key', () => {
    const { req, res, next } = mockReqRes(`Bearer ${API_KEY}`);
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('should return 401 when Authorization header is missing', () => {
    const { req, res, next } = mockReqRes(undefined);
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it('should return 401 when Authorization header has no Bearer prefix', () => {
    const { req, res, next } = mockReqRes(`Basic ${API_KEY}`);
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it('should return 403 when API key is wrong', () => {
    const { req, res, next } = mockReqRes('Bearer wrong-key');
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  });

  it('should return 401 for empty Bearer value', () => {
    const { req, res, next } = mockReqRes('Bearer ');
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    // Empty token after "Bearer " — treated as missing
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });
});

describe('generateApiKey', () => {
  it('should generate a 64-character hex string', () => {
    const key = generateApiKey();
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should generate unique keys', () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    expect(key1).not.toBe(key2);
  });
});
