/**
 * SSRF Host Validation Tests (TDD)
 */

import { describe, it, expect, vi } from 'vitest';
import { validateHost } from '../src/host_validator.js';

// Mock DNS resolution to avoid real network calls in tests
vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn().mockRejectedValue(new Error('no records')),
  resolve6: vi.fn().mockRejectedValue(new Error('no records')),
}));

import { resolve4, resolve6 } from 'node:dns/promises';

describe('validateHost', () => {
  // ─── Valid hosts ───────────────────────────────────────────────────
  it('allows public hostname', async () => {
    expect(await validateHost('db.example.com')).toEqual({ valid: true });
  });

  it('allows public RDS endpoint', async () => {
    expect(await validateHost('my-db.us-east-1.rds.amazonaws.com')).toEqual({ valid: true });
  });

  it('allows public IP', async () => {
    expect(await validateHost('54.123.45.67')).toEqual({ valid: true });
  });

  // ─── Blocked: loopback ─────────────────────────────────────────────
  it('blocks 127.0.0.1', async () => {
    const result = await validateHost('127.0.0.1');
    expect(result.valid).toBe(false);
  });

  it('blocks 127.0.0.2', async () => {
    const result = await validateHost('127.0.0.2');
    expect(result.valid).toBe(false);
  });

  it('blocks ::1', async () => {
    const result = await validateHost('::1');
    expect(result.valid).toBe(false);
  });

  it('blocks localhost', async () => {
    const result = await validateHost('localhost');
    expect(result.valid).toBe(false);
  });

  // ─── Blocked: private IPs ─────────────────────────────────────────
  it('blocks 10.0.1.5', async () => {
    const result = await validateHost('10.0.1.5');
    expect(result.valid).toBe(false);
  });

  it('blocks 172.16.0.1', async () => {
    const result = await validateHost('172.16.0.1');
    expect(result.valid).toBe(false);
  });

  it('blocks 172.31.255.255', async () => {
    const result = await validateHost('172.31.255.255');
    expect(result.valid).toBe(false);
  });

  it('blocks 192.168.1.1', async () => {
    const result = await validateHost('192.168.1.1');
    expect(result.valid).toBe(false);
  });

  // ─── Blocked: link-local / metadata ────────────────────────────────
  it('blocks 169.254.169.254 (AWS metadata)', async () => {
    const result = await validateHost('169.254.169.254');
    expect(result.valid).toBe(false);
  });

  it('blocks 169.254.0.1 (link-local)', async () => {
    const result = await validateHost('169.254.0.1');
    expect(result.valid).toBe(false);
  });

  // ─── Blocked: all-interfaces ───────────────────────────────────────
  it('blocks 0.0.0.0', async () => {
    const result = await validateHost('0.0.0.0');
    expect(result.valid).toBe(false);
  });

  // ─── Blocked: hostname patterns ────────────────────────────────────
  it('blocks *.internal', async () => {
    const result = await validateHost('api.internal');
    expect(result.valid).toBe(false);
  });

  it('blocks *.local', async () => {
    const result = await validateHost('myhost.local');
    expect(result.valid).toBe(false);
  });

  // ─── Edge cases ────────────────────────────────────────────────────
  it('blocks empty host', async () => {
    const result = await validateHost('');
    expect(result.valid).toBe(false);
  });

  it('allows 172.32.0.1 (not in private range)', async () => {
    expect(await validateHost('172.32.0.1')).toEqual({ valid: true });
  });

  // ─── DNS resolution check (C2) ────────────────────────────────────
  it('blocks hostname resolving to 127.0.0.1', async () => {
    vi.mocked(resolve4).mockResolvedValueOnce(['127.0.0.1']);
    const result = await validateHost('evil.example.com');
    expect(result.valid).toBe(false);
    expect('reason' in result && result.reason).toContain('127.0.0.1');
  });

  it('blocks hostname resolving to private IP 10.x', async () => {
    vi.mocked(resolve4).mockResolvedValueOnce(['10.0.0.5']);
    const result = await validateHost('sneaky-ssrf.example.com');
    expect(result.valid).toBe(false);
    expect('reason' in result && result.reason).toContain('10.0.0.5');
  });

  it('allows hostname resolving to public IP', async () => {
    vi.mocked(resolve4).mockResolvedValueOnce(['52.1.2.3']);
    const result = await validateHost('legit-db.example.com');
    expect(result.valid).toBe(true);
  });
});
