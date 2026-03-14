/**
 * HTTP Server Tests
 *
 * Tests for the HTTP server with per-session MCP transport management.
 * Verifies health check, auth middleware, MCP protocol handling,
 * and multi-session support.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpServer, createTlsHttpServer } from '../src/http-server.js';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const API_KEY = 'c'.repeat(64);

describe('HTTP Server', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const result = createHttpServer({
      port: 0,
      apiKey: API_KEY,
      createMcpServer: () => new McpServer({ name: 'test-db', version: '0.0.1' }),
    });
    server = result.server;

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  async function fetchJson(path: string, options?: RequestInit) {
    const res = await fetch(`${baseUrl}${path}`, options);
    const body = await res.text();
    return { status: res.status, body, headers: res.headers };
  }

  function initPayload() {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });
  }

  // Health check

  it('GET /health should return 200 without auth', async () => {
    const { status, body } = await fetchJson('/health');
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.status).toBe('ok');
    expect(parsed.version).toBeDefined();
  });

  // Auth middleware on /mcp

  it('POST /mcp without auth should return 401', async () => {
    const { status } = await fetchJson('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: initPayload(),
    });
    expect(status).toBe(401);
  });

  it('POST /mcp with wrong key should return 403', async () => {
    const { status } = await fetchJson('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-key',
      },
      body: initPayload(),
    });
    expect(status).toBe(403);
  });

  it('POST /mcp with valid auth + initialize should return 200', async () => {
    const { status, body, headers } = await fetchJson('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json, text/event-stream',
      },
      body: initPayload(),
    });
    expect(status).toBe(200);

    // Response may be JSON or SSE depending on transport
    const contentType = headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const dataLines = body.split('\n').filter((l) => l.startsWith('data: '));
      expect(dataLines.length).toBeGreaterThan(0);
      const parsed = JSON.parse(dataLines[0].slice(6));
      expect(parsed.result).toBeDefined();
      expect(parsed.result.serverInfo).toBeDefined();
    } else {
      const parsed = JSON.parse(body);
      expect(parsed.result).toBeDefined();
      expect(parsed.result.serverInfo).toBeDefined();
    }
  });

  // Multi-session support

  it('should support multiple concurrent client sessions', async () => {
    // Session 1
    const res1 = await fetchJson('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json, text/event-stream',
      },
      body: initPayload(),
    });
    expect(res1.status).toBe(200);

    // Session 2 — should also succeed (not "Server already initialized")
    const res2 = await fetchJson('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json, text/event-stream',
      },
      body: initPayload(),
    });
    expect(res2.status).toBe(200);

    // Both should have different session IDs
    const sid1 = res1.headers.get('mcp-session-id');
    const sid2 = res2.headers.get('mcp-session-id');
    expect(sid1).toBeDefined();
    expect(sid2).toBeDefined();
    expect(sid1).not.toBe(sid2);
  });

  it('should return 404 for unknown session ID', async () => {
    const { status } = await fetchJson('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': 'non-existent-session-id',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(status).toBe(404);
  });

  it('GET /unknown should return 404', async () => {
    const { status } = await fetchJson('/unknown');
    expect(status).toBe(404);
  });
});

// ─── TLS Server Tests (M4) ──────────────────────────────────────────

describe('HTTP Server with TLS', () => {
  let tlsServer: https.Server;
  let tlsBaseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mcp-tls-'));
    const certPath = path.join(tmpDir, 'cert.pem');
    const keyPath = path.join(tmpDir, 'key.pem');

    // Generate self-signed cert
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 1 -nodes -subj "/CN=localhost"`,
      { stdio: 'pipe' },
    );

    const result = createTlsHttpServer({
      port: 0,
      apiKey: API_KEY,
      tls: { cert: certPath, key: keyPath },
      createMcpServer: () => new McpServer({ name: 'test-db-tls', version: '0.0.1' }),
    });
    tlsServer = result.server as https.Server;

    await new Promise<void>((resolve) => {
      tlsServer.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = tlsServer.address() as { port: number };
    tlsBaseUrl = `https://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      tlsServer.close(() => resolve());
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /health over HTTPS should return 200', async () => {
    // Use Node.js https.get with rejectUnauthorized: false for self-signed cert
    const body = await new Promise<string>((resolve, reject) => {
      https.get(`${tlsBaseUrl}/health`, { rejectUnauthorized: false }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });

    const parsed = JSON.parse(body);
    expect(parsed.status).toBe('ok');
    expect(parsed.version).toBeDefined();
  });
});
