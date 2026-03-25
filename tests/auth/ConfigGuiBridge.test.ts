// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/auth/ConfigGuiBridge.test.ts — JAL-005 ConfigGuiBridge unit tests
//
// Tests env file parsing and availability detection without launching the TUI.

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ConfigGuiBridge } from '../../src/apex/auth/ConfigGuiBridge';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-config-gui-'));
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── isAvailable ───────────────────────────────────────────────────────────────

describe('ConfigGuiBridge.isAvailable', () => {
  it('returns false when binary path does not exist', () => {
    const bridge = new ConfigGuiBridge({
      binaryPath: '/nonexistent/path/binary',
    });
    expect(bridge.isAvailable()).toBe(false);
  });

  it('returns true when binary path exists', () => {
    const fakeBinary = path.join(tmpDir, 'fake-binary');
    fs.writeFileSync(fakeBinary, '#!/bin/sh\necho test', { mode: 0o755 });

    const bridge = new ConfigGuiBridge({ binaryPath: fakeBinary });
    expect(bridge.isAvailable()).toBe(true);
  });
});

// ── parseEnvFile ──────────────────────────────────────────────────────────────

describe('ConfigGuiBridge.parseEnvFile', () => {
  const bridge = new ConfigGuiBridge({ binaryPath: '/nonexistent' });

  it('parses provider and model from env content', () => {
    const content = [
      '# comment',
      'STAGEHAND_LLM_PROVIDER=anthropic',
      'STAGEHAND_LLM_MODEL=claude-sonnet-4-6',
      'ANTHROPIC_API_KEY=sk-secret',
    ].join('\n');

    const config = bridge.parseEnvFile(content);
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('anthropic');
    expect(config!.model).toBe('claude-sonnet-4-6');
  });

  it('does NOT expose API key values', () => {
    const content = [
      'STAGEHAND_LLM_PROVIDER=openai',
      'STAGEHAND_LLM_MODEL=gpt-4o',
      'OPENAI_API_KEY=sk-super-secret',
    ].join('\n');

    const config = bridge.parseEnvFile(content);
    // Only ProviderConfig is returned — no key field exists
    expect(JSON.stringify(config)).not.toContain('sk-super-secret');
    expect(config!.provider).toBe('openai');
  });

  it('handles quoted values', () => {
    const content = [
      'STAGEHAND_LLM_PROVIDER="anthropic"',
      'STAGEHAND_LLM_MODEL="claude-opus-4-6"',
    ].join('\n');

    const config = bridge.parseEnvFile(content);
    expect(config!.provider).toBe('anthropic');
    expect(config!.model).toBe('claude-opus-4-6');
  });

  it('returns null when provider is missing', () => {
    const content = 'STAGEHAND_LLM_MODEL=claude-sonnet-4-6\n';
    expect(bridge.parseEnvFile(content)).toBeNull();
  });

  it('returns null when model is missing', () => {
    const content = 'STAGEHAND_LLM_PROVIDER=anthropic\n';
    expect(bridge.parseEnvFile(content)).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(bridge.parseEnvFile('')).toBeNull();
  });

  it('ignores comment lines', () => {
    const content = [
      '# STAGEHAND_LLM_PROVIDER=commented-out',
      'STAGEHAND_LLM_PROVIDER=anthropic',
      'STAGEHAND_LLM_MODEL=claude-haiku-4-5-20251001',
    ].join('\n');

    const config = bridge.parseEnvFile(content);
    expect(config!.provider).toBe('anthropic');
  });

  it('handles lines without equals sign gracefully', () => {
    const content = [
      'THIS_IS_NOT_VALID',
      'STAGEHAND_LLM_PROVIDER=anthropic',
      'STAGEHAND_LLM_MODEL=claude-sonnet-4-6',
    ].join('\n');

    const config = bridge.parseEnvFile(content);
    expect(config).not.toBeNull();
  });
});

// ── launch — binary unavailable ───────────────────────────────────────────────

describe('ConfigGuiBridge.launch — binary unavailable', () => {
  it('returns null and emits warning when binary is missing', async () => {
    const warnings: string[] = [];
    const bridge = new ConfigGuiBridge({
      binaryPath: '/nonexistent/binary',
      onWarning: (msg) => warnings.push(msg),
    });

    const result = await bridge.launch();

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Config-GUI binary not found/);
    expect(warnings[0]).toMatch(/cargo build/);
  });

  it('warning message is non-fatal (does not throw)', async () => {
    const bridge = new ConfigGuiBridge({
      binaryPath: '/nonexistent/binary',
      onWarning: () => {},
    });

    await expect(bridge.launch()).resolves.not.toThrow();
  });
});
