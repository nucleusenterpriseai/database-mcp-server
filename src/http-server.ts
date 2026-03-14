/**
 * HTTP Server for MCP Database Server
 *
 * Per-session transport architecture following the official MCP SDK pattern:
 * - Each client initialization creates a new transport + McpServer pair
 * - Sessions tracked in a Map keyed by Mcp-Session-Id
 * - DELETE properly removes sessions from the map
 * - Database driver (expensive) is shared; MCP layer (cheap) is per-session
 *
 * Session safeguards:
 * - Max concurrent sessions cap (default 100) — returns 503 when full
 * - Idle TTL (default 30 min) — auto-expires sessions with no activity
 *
 * Uses Node.js built-in http module — no Express dependency needed.
 */

import http from 'node:http';
import https from 'node:https';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createApiKeyMiddleware } from './auth.js';
import { SERVER_VERSION } from './config.js';

/** Default max concurrent sessions per server instance. */
const DEFAULT_MAX_SESSIONS = 100;

/** Default idle session TTL in milliseconds (30 minutes). */
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

/** How often to run the idle session reaper (60 seconds). */
const REAPER_INTERVAL_MS = 60 * 1000;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

export interface HttpServerOptions {
  port: number;
  apiKey: string;
  createMcpServer: () => McpServer;
  maxSessions?: number;
  sessionTtlMs?: number;
}

export interface TlsHttpServerOptions extends HttpServerOptions {
  tls: {
    cert: string;
    key: string;
  };
}

export interface HttpServerResult {
  server: http.Server | https.Server;
}

/**
 * Start a periodic reaper that closes idle sessions.
 */
function startSessionReaper(
  sessions: Map<string, SessionEntry>,
  ttlMs: number,
): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      if (now - entry.lastActivity > ttlMs) {
        entry.transport.close?.();
        sessions.delete(sid);
      }
    }
  }, REAPER_INTERVAL_MS);
}

/**
 * Handle an MCP request with per-session transport management.
 *
 * - Requests without Mcp-Session-Id create a new transport + MCP server.
 * - Requests with Mcp-Session-Id are routed to the existing transport.
 * - DELETE removes the session from the map.
 * - Returns 503 when max concurrent sessions reached.
 */
function createMcpRequestHandler(
  sessions: Map<string, SessionEntry>,
  createMcpServer: () => McpServer,
  maxSessions: number,
) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Route to existing session
    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId)!;
      entry.lastActivity = Date.now();
      await entry.transport.handleRequest(req, res);
      return;
    }

    // Reject non-initialization requests with unknown/expired session ID
    if (sessionId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    // Enforce max concurrent sessions
    if (sessions.size >= maxSessions) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many active sessions' }));
      return;
    }

    // New session — create transport + MCP server
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, lastActivity: Date.now() });
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  };
}

/**
 * Create an HTTP server with health check and per-session MCP transport.
 *
 * - GET /health — no auth, returns { status: 'ok', version, activeSessions }
 * - POST /mcp — requires Bearer auth, MCP JSON-RPC endpoint
 * - GET /mcp — requires Bearer auth, SSE endpoint for server notifications
 * - DELETE /mcp — requires Bearer auth, session termination
 * - Everything else — 404
 *
 * Supports multiple concurrent client sessions with limits and TTL.
 */
export function createHttpServer(options: HttpServerOptions): HttpServerResult {
  const authMiddleware = createApiKeyMiddleware(options.apiKey);
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessions = new Map<string, SessionEntry>();
  const handleMcpRequest = createMcpRequestHandler(sessions, options.createMcpServer, maxSessions);
  const reaper = startSessionReaper(sessions, ttlMs);
  reaper.unref();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // Health check — no auth
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: SERVER_VERSION, activeSessions: sessions.size }));
      return;
    }

    // MCP endpoint — auth required
    if (pathname === '/mcp') {
      authMiddleware(req, res, () => {
        handleMcpRequest(req, res);
      });
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return { server };
}

/**
 * Create an HTTPS server with TLS support.
 * Same as createHttpServer but wraps in TLS using provided cert/key paths.
 * Supports multiple concurrent client sessions with limits and TTL.
 */
export function createTlsHttpServer(options: TlsHttpServerOptions): HttpServerResult {
  const authMiddleware = createApiKeyMiddleware(options.apiKey);
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessions = new Map<string, SessionEntry>();
  const handleMcpRequest = createMcpRequestHandler(sessions, options.createMcpServer, maxSessions);
  const reaper = startSessionReaper(sessions, ttlMs);
  reaper.unref();

  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: SERVER_VERSION, activeSessions: sessions.size }));
      return;
    }

    if (pathname === '/mcp') {
      authMiddleware(req, res, () => {
        handleMcpRequest(req, res);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  };

  const server = https.createServer(
    {
      cert: fs.readFileSync(options.tls.cert),
      key: fs.readFileSync(options.tls.key),
    },
    requestHandler,
  );

  return { server };
}
