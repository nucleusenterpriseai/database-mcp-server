/**
 * HTTP Server for MCP Database Server
 *
 * Wraps StreamableHTTPServerTransport with API key auth and health check.
 * Supports multiple concurrent client sessions via per-session transports.
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

export interface HttpServerOptions {
  port: number;
  apiKey: string;
  createMcpServer: () => McpServer;
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
 * Handle an MCP request with per-session transport management.
 *
 * - Requests without Mcp-Session-Id create a new transport + MCP server.
 * - Requests with Mcp-Session-Id are routed to the existing transport.
 */
function createMcpRequestHandler(
  sessions: Map<string, StreamableHTTPServerTransport>,
  createMcpServer: () => McpServer,
) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Route to existing session
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    // Reject non-initialization requests with unknown session ID
    if (sessionId) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    // New session — create transport + MCP server
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, transport);
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
 * Create an HTTP server with health check and MCP transport.
 *
 * - GET /health — no auth, returns { status: 'ok', version }
 * - POST /mcp — requires Bearer auth, MCP JSON-RPC endpoint
 * - GET /mcp — requires Bearer auth, SSE endpoint for server notifications
 * - DELETE /mcp — requires Bearer auth, session termination
 * - Everything else — 404
 *
 * Supports multiple concurrent client sessions.
 */
export function createHttpServer(options: HttpServerOptions): HttpServerResult {
  const authMiddleware = createApiKeyMiddleware(options.apiKey);
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const handleMcpRequest = createMcpRequestHandler(sessions, options.createMcpServer);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // Health check — no auth
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: SERVER_VERSION }));
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
 * Supports multiple concurrent client sessions.
 */
export function createTlsHttpServer(options: TlsHttpServerOptions): HttpServerResult {
  const authMiddleware = createApiKeyMiddleware(options.apiKey);
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const handleMcpRequest = createMcpRequestHandler(sessions, options.createMcpServer);

  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: SERVER_VERSION }));
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
