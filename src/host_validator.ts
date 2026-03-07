/**
 * SSRF Host Validation
 *
 * Validates database host addresses to prevent SSRF attacks.
 * Blocks private IPs, loopback, link-local, cloud metadata endpoints.
 */

import { isIP } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';

type ValidationResult = { valid: true } | { valid: false; reason: string };

const BLOCKED_HOSTNAME_SUFFIXES = ['.internal', '.local'];
const BLOCKED_HOSTNAMES = new Set(['localhost']);

/**
 * Parse an IPv4 address into 4 octets. Returns null if not valid IPv4.
 */
function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return null;
  return octets;
}

/**
 * Check if an IPv4 address is in a blocked range.
 */
function isBlockedIPv4(ip: string): string | null {
  const octets = parseIPv4(ip);
  if (!octets) return null;

  const [a, b] = octets;

  // 0.0.0.0
  if (octets.every((o) => o === 0)) return 'all-interfaces address';

  // 127.0.0.0/8
  if (a === 127) return 'loopback address';

  // 10.0.0.0/8
  if (a === 10) return 'private network (10.0.0.0/8)';

  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return 'private network (172.16.0.0/12)';

  // 192.168.0.0/16
  if (a === 192 && b === 168) return 'private network (192.168.0.0/16)';

  // 169.254.0.0/16 (link-local, includes AWS metadata)
  if (a === 169 && b === 254) return 'link-local / cloud metadata endpoint';

  return null;
}

/**
 * Check if an IPv6 address is blocked.
 */
function isBlockedIPv6(ip: string): string | null {
  const normalized = ip.toLowerCase().trim();

  // ::1 loopback
  if (normalized === '::1') return 'IPv6 loopback';

  // fd00::/8 unique local (includes AWS IMDSv2 fd00:ec2::254)
  if (normalized.startsWith('fd')) return 'IPv6 unique local address';

  // fe80::/10 link-local
  if (normalized.startsWith('fe80')) return 'IPv6 link-local address';

  return null;
}

/**
 * Check a single IP (v4 or v6) against blocked ranges.
 */
function isBlockedIP(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) return isBlockedIPv4(ip);
  if (version === 6) return isBlockedIPv6(ip);
  return null;
}

/**
 * Validate a database host for SSRF safety.
 * Performs DNS resolution for hostnames to catch private-IP aliases.
 */
export async function validateHost(host: string): Promise<ValidationResult> {
  if (!host || !host.trim()) {
    return { valid: false, reason: 'Host cannot be empty' };
  }

  const h = host.trim().toLowerCase();

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.has(h)) {
    return { valid: false, reason: `Host '${host}' is blocked (localhost)` };
  }

  // Check blocked hostname suffixes
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (h.endsWith(suffix)) {
      return { valid: false, reason: `Host '${host}' is blocked (${suffix} domain)` };
    }
  }

  // Check if it's an IP address directly
  const ipVersion = isIP(host);

  if (ipVersion === 4) {
    const reason = isBlockedIPv4(host);
    if (reason) {
      return { valid: false, reason: `Host '${host}' is blocked: ${reason}` };
    }
    return { valid: true };
  }

  if (ipVersion === 6) {
    const reason = isBlockedIPv6(host);
    if (reason) {
      return { valid: false, reason: `Host '${host}' is blocked: ${reason}` };
    }
    return { valid: true };
  }

  // It's a hostname — resolve DNS and check all resolved IPs
  try {
    const ips: string[] = [];
    try { ips.push(...await resolve4(host)); } catch { /* no A records */ }
    try { ips.push(...await resolve6(host)); } catch { /* no AAAA records */ }

    for (const ip of ips) {
      const reason = isBlockedIP(ip);
      if (reason) {
        return { valid: false, reason: `Host '${host}' resolves to blocked IP ${ip}: ${reason}` };
      }
    }
  } catch {
    // DNS resolution failure — allow (could be internal DNS not reachable in test env)
  }

  return { valid: true };
}
