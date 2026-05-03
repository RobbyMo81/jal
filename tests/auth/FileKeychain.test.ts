// Co-authored by Apex Wakening Build (JAL-019)
// tests/auth/FileKeychain.test.ts — FileKeychain unit tests

import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileKeychain } from '../../src/apex/auth/FileKeychain';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'apex-keychain-test-'));
}

describe('FileKeychain', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => rmSync(dir, { recursive: true }));

  it('returns null for unknown key', async () => {
    const kc = new FileKeychain(dir);
    expect(await kc.get('apex-auth', 'session:ollama')).toBeNull();
  });

  it('stores and retrieves a credential', async () => {
    const kc = new FileKeychain(dir);
    await kc.set('apex-auth', 'session:ollama', 'ollama-local');
    expect(await kc.get('apex-auth', 'session:ollama')).toBe('ollama-local');
  });

  it('persists across instances (survives restart)', async () => {
    const kc1 = new FileKeychain(dir);
    await kc1.set('apex-auth', 'session:anthropic', 'sk-ant-123');

    const kc2 = new FileKeychain(dir);
    expect(await kc2.get('apex-auth', 'session:anthropic')).toBe('sk-ant-123');
  });

  it('deletes a credential and returns true', async () => {
    const kc = new FileKeychain(dir);
    await kc.set('svc', 'acct', 'val');
    const deleted = await kc.delete('svc', 'acct');
    expect(deleted).toBe(true);
    expect(await kc.get('svc', 'acct')).toBeNull();
  });

  it('delete returns false for non-existent key', async () => {
    const kc = new FileKeychain(dir);
    const deleted = await kc.delete('svc', 'ghost');
    expect(deleted).toBe(false);
  });

  it('persists delete across instances', async () => {
    const kc1 = new FileKeychain(dir);
    await kc1.set('svc', 'acct', 'val');
    await kc1.delete('svc', 'acct');

    const kc2 = new FileKeychain(dir);
    expect(await kc2.get('svc', 'acct')).toBeNull();
  });

  it('stores multiple distinct credentials', async () => {
    const kc = new FileKeychain(dir);
    await kc.set('svc', 'a', 'val-a');
    await kc.set('svc', 'b', 'val-b');
    expect(await kc.get('svc', 'a')).toBe('val-a');
    expect(await kc.get('svc', 'b')).toBe('val-b');
  });

  it('creates keychain file with restrictive permissions', async () => {
    const kc = new FileKeychain(dir);
    await kc.set('svc', 'acct', 'val');
    const file = join(dir, 'keychain.json');
    const mode = statSync(file).mode & 0o777;
    // Mode should be 0o600 (owner read/write only)
    expect(mode).toBe(0o600);
  });

  it('handles corrupted keychain file gracefully (starts fresh)', () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    writeFileSync(join(dir, 'keychain.json'), 'NOT VALID JSON', { mode: 0o600 });
    expect(() => new FileKeychain(dir)).not.toThrow();
  });
});
