// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// src/apex/policy/PackageAllowlist.ts — JAL-003 Versioned package allowlist
//
// The allowlist lives at ~/.apex/policy/package-allowlist.json.
// It is user-editable: the file is plain JSON with a human-readable structure.
// Every mutation (add/remove) increments the version counter and writes an
// audit log entry so the change history is fully traceable.
//
// PackageAllowlist is not a singleton — callers own the instance lifetime.
// The in-memory cache is invalidated on every write so reads reflect the latest
// state without requiring a restart.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { PackageAllowlistEntry, PackageAllowlistFile } from '../types';
import { IAuditLog } from './AuditLog';

export const DEFAULT_ALLOWLIST_PATH = join(homedir(), '.apex', 'policy', 'package-allowlist.json');

export class PackageAllowlist {
  private readonly filePath: string;
  private readonly audit: IAuditLog;
  private cache: PackageAllowlistFile | null = null;

  constructor(audit: IAuditLog, filePath?: string) {
    this.filePath = filePath ?? DEFAULT_ALLOWLIST_PATH;
    this.audit = audit;
  }

  /**
   * Return true if the named package/manager pair appears in the allowlist.
   * Reads from cache; the cache is populated on first read and after every write.
   */
  isAllowed(name: string, manager: string): boolean {
    const file = this.load();
    return file.entries.some(e => e.name === name && e.manager === manager);
  }

  /** Return a snapshot of the current allowlist. */
  list(): PackageAllowlistFile {
    return this.load();
  }

  /**
   * Add a package to the allowlist.
   * Idempotent: a second add for the same name+manager is a no-op.
   * Increments version and audit-logs the change.
   */
  add(name: string, manager: string): void {
    const file = this.load();
    if (file.entries.some(e => e.name === name && e.manager === manager)) return;

    const entry: PackageAllowlistEntry = {
      name,
      manager,
      added_at: new Date().toISOString(),
    };
    file.entries.push(entry);
    file.version += 1;
    file.updated_at = new Date().toISOString();
    this.save(file);

    this.audit.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'PackageAllowlist',
      message: `Package allowlist updated: added ${manager}/${name}`,
      action: 'allowlist.add',
      allowlist_version: file.version,
      package: name,
      manager,
    });
  }

  /**
   * Remove a package from the allowlist.
   * Idempotent: removing a package that isn't listed is a no-op.
   * Increments version and audit-logs the change.
   */
  remove(name: string, manager: string): void {
    const file = this.load();
    const before = file.entries.length;
    file.entries = file.entries.filter(e => !(e.name === name && e.manager === manager));
    if (file.entries.length === before) return;

    file.version += 1;
    file.updated_at = new Date().toISOString();
    this.save(file);

    this.audit.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'PackageAllowlist',
      message: `Package allowlist updated: removed ${manager}/${name}`,
      action: 'allowlist.remove',
      allowlist_version: file.version,
      package: name,
      manager,
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private load(): PackageAllowlistFile {
    if (this.cache) return this.cache;

    if (!existsSync(this.filePath)) {
      const empty: PackageAllowlistFile = {
        version: 1,
        updated_at: new Date().toISOString(),
        entries: [],
      };
      this.save(empty);
      return empty;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
    } catch {
      throw new Error(`[PackageAllowlist] Failed to parse allowlist file: ${this.filePath}`);
    }

    this.cache = parsed as PackageAllowlistFile;
    return this.cache;
  }

  private save(file: PackageAllowlistFile): void {
    this.cache = file;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf-8');
  }
}
