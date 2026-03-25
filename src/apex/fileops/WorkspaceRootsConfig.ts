// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// src/apex/fileops/WorkspaceRootsConfig.ts — JAL-004 Workspace roots configuration
//
// Manages the list of approved workspace roots for Tier 1 file operations.
// Workspace roots are stored in ~/.apex/policy/workspace-roots.json.
// Falls back to APEX_WORKSPACE_ROOTS env var if the file does not exist.
//
// Every mutation (add/remove) increments the version counter and writes an
// audit log entry so the change history is fully traceable.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, resolve as resolvePath } from 'path';
import { homedir } from 'os';
import { WorkspaceRootsFile } from '../types';
import { IAuditLog } from '../policy/AuditLog';

export const DEFAULT_ROOTS_PATH = join(homedir(), '.apex', 'policy', 'workspace-roots.json');

export class WorkspaceRootsConfig {
  private readonly filePath: string;
  private readonly audit: IAuditLog;
  private cache: WorkspaceRootsFile | null = null;

  constructor(audit: IAuditLog, filePath?: string) {
    this.filePath = filePath ?? DEFAULT_ROOTS_PATH;
    this.audit = audit;
  }

  /**
   * Return true if the given absolute path is inside any configured workspace root.
   * The comparison is done on normalised absolute paths.
   */
  isInsideWorkspace(absolutePath: string): boolean {
    const roots = this.load().roots;
    return roots.some(root => {
      const normRoot = root.endsWith('/') ? root : root + '/';
      return absolutePath === root || absolutePath.startsWith(normRoot);
    });
  }

  /** Return the current list of workspace roots. */
  list(): WorkspaceRootsFile {
    return this.load();
  }

  /**
   * Add a workspace root.
   * The path is normalised to an absolute path before storing.
   * Idempotent: adding the same root twice is a no-op.
   * Increments version and audit-logs the change.
   */
  add(rawPath: string): void {
    const absPath = resolvePath(rawPath);
    const file = this.load();
    if (file.roots.includes(absPath)) return;

    file.roots.push(absPath);
    file.version += 1;
    file.updated_at = new Date().toISOString();
    this.save(file);

    this.audit.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'WorkspaceRootsConfig',
      message: `Workspace roots updated: added ${absPath}`,
      action: 'workspace_roots.add',
      roots_version: file.version,
      root: absPath,
    });
  }

  /**
   * Remove a workspace root.
   * Idempotent: removing a root that is not listed is a no-op.
   * Increments version and audit-logs the change.
   */
  remove(rawPath: string): void {
    const absPath = resolvePath(rawPath);
    const file = this.load();
    const before = file.roots.length;
    file.roots = file.roots.filter(r => r !== absPath);
    if (file.roots.length === before) return;

    file.version += 1;
    file.updated_at = new Date().toISOString();
    this.save(file);

    this.audit.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'WorkspaceRootsConfig',
      message: `Workspace roots updated: removed ${absPath}`,
      action: 'workspace_roots.remove',
      roots_version: file.version,
      root: absPath,
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private load(): WorkspaceRootsFile {
    if (this.cache) return this.cache;

    // Try the JSON file first
    if (existsSync(this.filePath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      } catch {
        throw new Error(`[WorkspaceRootsConfig] Failed to parse workspace roots file: ${this.filePath}`);
      }
      this.cache = parsed as WorkspaceRootsFile;
      return this.cache;
    }

    // Fall back to APEX_WORKSPACE_ROOTS env var (colon-separated paths)
    const envRoots = process.env['APEX_WORKSPACE_ROOTS'];
    const roots: string[] = envRoots
      ? envRoots.split(':').map(p => resolvePath(p.trim())).filter(Boolean)
      : [];

    const initial: WorkspaceRootsFile = {
      version: 1,
      updated_at: new Date().toISOString(),
      roots,
    };
    this.save(initial);
    return initial;
  }

  private save(file: WorkspaceRootsFile): void {
    this.cache = file;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf-8');
  }
}
