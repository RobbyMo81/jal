// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/memory/EpisodicStore.ts — JAL-008 Episodic Memory Storage
//
// Episodic memory is workspace-scoped and time-bounded:
//  - Items expire 30 days after last access (TTL reset on every retrieval)
//  - Each workspace has a 50 MB quota; LRU eviction fires when quota is exceeded
//  - Storage: ~/.apex/state/memory/episodic/<workspace_id>.json (atomic writes)

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EpisodicMemoryFile, MemoryItem } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

/** 30 days in milliseconds. */
export const EPISODIC_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/** 50 MB per-workspace quota. */
export const EPISODIC_QUOTA_BYTES = 50 * 1024 * 1024;

// ── EpisodicStore ─────────────────────────────────────────────────────────────

export class EpisodicStore {
  private readonly memoryDir: string;

  constructor(stateDir?: string) {
    const base = stateDir ?? path.join(os.homedir(), '.apex', 'state');
    this.memoryDir = path.join(base, 'memory', 'episodic');
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private ensureDir(): void {
    fs.mkdirSync(this.memoryDir, { recursive: true });
  }

  /** Sanitize workspace_id to a safe filename segment. */
  private workspaceFilename(workspaceId: string): string {
    // Replace any character not alphanumeric/dash/underscore/dot with underscore
    const safe = workspaceId.replace(/[^a-zA-Z0-9\-_.]/g, '_');
    // Prefix with a hash so two workspaces that differ only in special chars don't collide
    const hash = crypto.createHash('sha256').update(workspaceId, 'utf8').digest('hex').slice(0, 8);
    return `${hash}_${safe.slice(0, 64)}.json`;
  }

  private filePath(workspaceId: string): string {
    return path.join(this.memoryDir, this.workspaceFilename(workspaceId));
  }

  private atomicWrite(filePath: string, content: string): void {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  }

  private loadFile(workspaceId: string): EpisodicMemoryFile {
    const fp = this.filePath(workspaceId);
    if (!fs.existsSync(fp)) {
      return { version: 1, workspace_id: workspaceId, total_bytes: 0, updated_at: new Date().toISOString(), items: [] };
    }
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as EpisodicMemoryFile;
  }

  private saveFile(file: EpisodicMemoryFile): void {
    this.ensureDir();
    file.updated_at = new Date().toISOString();
    file.total_bytes = file.items.reduce((s, i) => s + i.size_bytes, 0);
    this.atomicWrite(this.filePath(file.workspace_id), JSON.stringify(file, null, 2));
  }

  // ── Eviction ───────────────────────────────────────────────────────────────

  /**
   * Remove expired items (TTL > 30 days since last_accessed_at) and then
   * evict LRU items until the workspace is under the 50 MB quota.
   * Returns the number of items removed.
   */
  evict(workspaceId: string, now: Date = new Date()): number {
    const file = this.loadFile(workspaceId);
    const beforeCount = file.items.length;

    // Step 1: TTL eviction
    const cutoff = now.getTime() - EPISODIC_TTL_MS;
    file.items = file.items.filter(i => new Date(i.last_accessed_at).getTime() >= cutoff);

    // Step 2: LRU eviction until under quota
    // Sort ascending by last_accessed_at so oldest are evicted first
    file.items.sort((a, b) => new Date(a.last_accessed_at).getTime() - new Date(b.last_accessed_at).getTime());
    let totalBytes = file.items.reduce((s, i) => s + i.size_bytes, 0);
    while (totalBytes > EPISODIC_QUOTA_BYTES && file.items.length > 0) {
      const evicted = file.items.shift()!;
      totalBytes -= evicted.size_bytes;
    }

    this.saveFile(file);
    return beforeCount - file.items.length;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Store a new item in episodic memory.
   * Triggers eviction after storing if quota would be exceeded.
   */
  store(item: MemoryItem): void {
    const file = this.loadFile(item.workspace_id);
    // Replace existing item with same id if present
    const idx = file.items.findIndex(i => i.id === item.id);
    if (idx >= 0) {
      file.total_bytes -= file.items[idx]!.size_bytes;
      file.items[idx] = item;
    } else {
      file.items.push(item);
    }
    file.total_bytes = file.items.reduce((s, i) => s + i.size_bytes, 0);
    this.saveFile(file);

    // Evict if over quota
    if (file.total_bytes > EPISODIC_QUOTA_BYTES) {
      this.evict(item.workspace_id);
    }
  }

  /**
   * Retrieve an item by ID, updating its last_accessed_at and access_count.
   * Returns null if the item does not exist or has expired.
   */
  get(workspaceId: string, itemId: string, now: Date = new Date()): MemoryItem | null {
    const file = this.loadFile(workspaceId);
    const idx = file.items.findIndex(i => i.id === itemId);
    if (idx < 0) return null;

    const item = file.items[idx]!;
    // Check TTL
    if (new Date(item.last_accessed_at).getTime() + EPISODIC_TTL_MS < now.getTime()) {
      // Expired — remove and persist
      file.items.splice(idx, 1);
      this.saveFile(file);
      return null;
    }

    // Touch: update access metadata
    item.last_accessed_at = now.toISOString();
    item.access_count += 1;
    this.saveFile(file);
    return item;
  }

  /**
   * Find items by tag (exact match on any tag in the item's tags array).
   * Updates last_accessed_at on all matching items.
   */
  findByTag(workspaceId: string, tag: string, now: Date = new Date()): MemoryItem[] {
    const file = this.loadFile(workspaceId);
    const cutoff = now.getTime() - EPISODIC_TTL_MS;
    const results: MemoryItem[] = [];

    let dirty = false;
    for (const item of file.items) {
      // Skip expired
      if (new Date(item.last_accessed_at).getTime() < cutoff) continue;
      if (item.tags.includes(tag)) {
        item.last_accessed_at = now.toISOString();
        item.access_count += 1;
        results.push(item);
        dirty = true;
      }
    }

    if (dirty) this.saveFile(file);
    return results;
  }

  /**
   * List all non-expired items in a workspace, without updating access metadata.
   */
  list(workspaceId: string, now: Date = new Date()): MemoryItem[] {
    const file = this.loadFile(workspaceId);
    const cutoff = now.getTime() - EPISODIC_TTL_MS;
    return file.items.filter(i => new Date(i.last_accessed_at).getTime() >= cutoff);
  }

  /**
   * Remove a single item by ID.
   */
  remove(workspaceId: string, itemId: string): boolean {
    const file = this.loadFile(workspaceId);
    const idx = file.items.findIndex(i => i.id === itemId);
    if (idx < 0) return false;
    file.items.splice(idx, 1);
    this.saveFile(file);
    return true;
  }

  /**
   * Return current usage stats for a workspace.
   */
  stats(workspaceId: string, now: Date = new Date()): { item_count: number; total_bytes: number; quota_bytes: number } {
    const items = this.list(workspaceId, now);
    return {
      item_count: items.length,
      total_bytes: items.reduce((s, i) => s + i.size_bytes, 0),
      quota_bytes: EPISODIC_QUOTA_BYTES,
    };
  }
}
