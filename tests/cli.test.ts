/**
 * CLI Tests (Task 1.5)
 *
 * Tests for CLI commands: generate-key, --version, --help.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const CLI_PATH = path.resolve(__dirname, '../src/cli.ts');
const TSX = path.resolve(__dirname, '../node_modules/.bin/tsx');

function runCli(args: string[]): string {
  return execFileSync(TSX, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    timeout: 10_000,
  }).trim();
}

describe('CLI', () => {
  it('generate-key should output a 64-char hex string', () => {
    const output = runCli(['generate-key']);
    // Output may include a label line — extract the hex key
    const lines = output.split('\n');
    const keyLine = lines.find((l) => /^[0-9a-f]{64}$/.test(l.trim()));
    expect(keyLine).toBeDefined();
    expect(keyLine!.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('--version should output the version', () => {
    const output = runCli(['--version']);
    expect(output).toMatch(/\d+\.\d+\.\d+/);
  });

  it('--help should output usage information', () => {
    const output = runCli(['--help']);
    expect(output).toContain('start');
    expect(output).toContain('generate-key');
  });
});
