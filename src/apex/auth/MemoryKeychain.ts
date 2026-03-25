// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/auth/MemoryKeychain.ts — JAL-005 In-memory IKeychain (test double only)
//
// WARNING: This implementation stores secrets in process memory with NO encryption.
// Use ONLY in unit tests. Never instantiate in production code.

import { IKeychain } from './IKeychain';

export class MemoryKeychain implements IKeychain {
  private readonly store = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service}\x00${account}`;
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.store.get(this.key(service, account)) ?? null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    this.store.set(this.key(service, account), value);
  }

  async delete(service: string, account: string): Promise<boolean> {
    return this.store.delete(this.key(service, account));
  }

  /** Test helper: wipe all stored secrets. */
  clear(): void {
    this.store.clear();
  }
}
