// Co-authored by Apex Wakening Build (JAL-019)
// src/apex/auth/FileKeychain.ts — File-backed keychain with OS permission gating
//
// Stores credentials in ~/.apex/keychain.json (mode 0o600 — owner read/write only).
// Survives process restarts without requiring libsecret or any OS daemon.
//
// Security posture: credentials are protected by UNIX file permissions, not
// by OS keyring encryption. Acceptable for local dev / single-user workstations.
// For production deployments, install libsecret-tools and use SecretToolKeychain.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { IKeychain } from './IKeychain';

export class FileKeychain implements IKeychain {
  private readonly filePath: string;
  private store: Record<string, string>;

  constructor(stateDir?: string) {
    const dir = stateDir ?? join(homedir(), '.apex');
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'keychain.json');
    this.store = this.load();
    this.lockDown();
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.store[this.key(service, account)] ?? null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    this.store[this.key(service, account)] = value;
    this.save();
  }

  async delete(service: string, account: string): Promise<boolean> {
    const k = this.key(service, account);
    if (k in this.store) {
      delete this.store[k];
      this.save();
      return true;
    }
    return false;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private key(service: string, account: string): string {
    return `${service}:${account}`;
  }

  private load(): Record<string, string> {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), { mode: 0o600 });
  }

  private lockDown(): void {
    if (existsSync(this.filePath)) {
      try { chmodSync(this.filePath, 0o600); } catch { /* non-fatal on systems where chmod is restricted */ }
    }
  }
}
