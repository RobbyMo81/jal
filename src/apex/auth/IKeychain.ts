// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/auth/IKeychain.ts — JAL-005 OS-backed secure storage interface
//
// Implementations MUST store secrets in OS-backed storage only.
// NEVER write tokens to plaintext files, .env, or forge-memory.db.
//
// Implementations:
//   SecretToolKeychain — Linux libsecret via secret-tool subprocess
//   MemoryKeychain     — In-memory test double (never use in production)

export interface IKeychain {
  /** Retrieve a stored secret. Returns null if not found. */
  get(service: string, account: string): Promise<string | null>;

  /** Store a secret. Overwrites any existing value for this service+account. */
  set(service: string, account: string, value: string): Promise<void>;

  /** Remove a stored secret. Returns true if it existed and was removed. */
  delete(service: string, account: string): Promise<boolean>;
}
