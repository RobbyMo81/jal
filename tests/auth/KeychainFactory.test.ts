// Co-authored by Apex Wakening Build (JAL-019)
// tests/auth/KeychainFactory.test.ts — KeychainFactory selection logic

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'apex-factory-test-'));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockSecretToolAvailable(): jest.SpyInstance {
  return jest.spyOn(require('child_process') as typeof import('child_process'), 'execFileSync')
    .mockImplementation((cmd: unknown) => {
      if (cmd === 'secret-tool') return Buffer.from('secret-tool 0.20\n');
      throw new Error('unexpected execFileSync call');
    });
}

function mockSecretToolMissing(): jest.SpyInstance {
  return jest.spyOn(require('child_process') as typeof import('child_process'), 'execFileSync')
    .mockImplementation((cmd: unknown) => {
      if (cmd === 'secret-tool') throw new Error('secret-tool not found');
      throw new Error('unexpected execFileSync call');
    });
}

describe('KeychainFactory.createKeychain', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true }); jest.restoreAllMocks(); });

  it('selects SecretToolKeychain when secret-tool is available', () => {
    mockSecretToolAvailable();
    const { createKeychain } = require('../../src/apex/auth/KeychainFactory') as typeof import('../../src/apex/auth/KeychainFactory');
    const selection = createKeychain(dir);
    expect(selection.backend).toBe('secret-tool');
    expect(selection.reason).toContain('libsecret');
  });

  it('falls back to FileKeychain when secret-tool is not available', () => {
    mockSecretToolMissing();
    const { createKeychain } = require('../../src/apex/auth/KeychainFactory') as typeof import('../../src/apex/auth/KeychainFactory');
    const selection = createKeychain(dir);
    expect(selection.backend).toBe('file');
    expect(selection.reason).toContain('keychain.json');
  });

  it('returned keychain is functional (set/get)', async () => {
    mockSecretToolMissing();
    const { createKeychain } = require('../../src/apex/auth/KeychainFactory') as typeof import('../../src/apex/auth/KeychainFactory');
    const { keychain } = createKeychain(dir);
    await keychain.set('svc', 'acct', 'tok-123');
    expect(await keychain.get('svc', 'acct')).toBe('tok-123');
  });

  it('FileKeychain backend persists across re-creation', async () => {
    mockSecretToolMissing();
    const { createKeychain } = require('../../src/apex/auth/KeychainFactory') as typeof import('../../src/apex/auth/KeychainFactory');
    const { keychain: kc1 } = createKeychain(dir);
    await kc1.set('svc', 'acct', 'persistent-value');

    jest.restoreAllMocks();
    mockSecretToolMissing();
    const { keychain: kc2 } = createKeychain(dir);
    expect(await kc2.get('svc', 'acct')).toBe('persistent-value');
  });
});
