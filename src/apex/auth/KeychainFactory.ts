// Co-authored by Apex Wakening Build (JAL-019)
// src/apex/auth/KeychainFactory.ts — Keychain backend selection
//
// Selects the best available credential store at startup:
//   1. SecretToolKeychain — OS libsecret (GNOME Keyring / KWallet). Most secure.
//   2. FileKeychain       — ~/.apex/keychain.json, chmod 600. Survives restarts.
//   3. MemoryKeychain     — in-process only. Last resort; credentials lost on exit.
//
// Uses synchronous probing so it can be called from ApexRuntime constructor.

import { execFileSync } from 'child_process';
import { SecretToolKeychain } from './SecretToolKeychain';
import { FileKeychain } from './FileKeychain';
import { MemoryKeychain } from './MemoryKeychain';
import type { IKeychain } from './IKeychain';

export type KeychainBackend = 'secret-tool' | 'file' | 'memory';

export interface KeychainSelection {
  keychain: IKeychain;
  backend: KeychainBackend;
  /** Human-readable reason for the selection — log this at startup. */
  reason: string;
}

/**
 * Synchronously probe available keychain backends and return the best one.
 * Safe to call from a constructor.
 */
export function createKeychain(stateDir?: string): KeychainSelection {
  // ── Tier 1: OS keyring via secret-tool ────────────────────────────────────
  try {
    execFileSync('secret-tool', ['--version'], { stdio: 'ignore', timeout: 2000 });
    return {
      keychain: new SecretToolKeychain(),
      backend: 'secret-tool',
      reason: 'OS keyring via secret-tool (libsecret). Credentials encrypted by OS keyring daemon.',
    };
  } catch {
    // secret-tool not available — fall through
  }

  // ── Tier 2: File keychain ─────────────────────────────────────────────────
  // Credentials persist across restarts. Protected by UNIX file permissions (0o600).
  // Acceptable for single-user workstations. Not suitable for multi-user servers.
  try {
    const keychain = new FileKeychain(stateDir);
    return {
      keychain,
      backend: 'file',
      reason:
        'FileKeychain (~/.apex/keychain.json, mode 0o600). ' +
        'Credentials survive restarts. ' +
        'Install libsecret-tools for OS keyring: sudo apt install libsecret-tools',
    };
  } catch {
    // Filesystem issue — fall through
  }

  // ── Tier 3: Memory keychain (fallback) ───────────────────────────────────
  return {
    keychain: new MemoryKeychain(),
    backend: 'memory',
    reason:
      'MemoryKeychain (ephemeral). Credentials lost on process exit. ' +
      'Check filesystem permissions on ~/.apex/ or install libsecret-tools.',
  };
}
