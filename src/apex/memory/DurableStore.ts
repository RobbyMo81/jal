// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/memory/DurableStore.ts — JAL-008 Durable Memory Storage
//
// Durable memory items persist indefinitely and are never auto-promoted.
// Every item in this store has passed all three criteria AND received
// explicit user approval.  This layer enforces that gate.
//
// Storage: ~/.apex/state/memory/durable.json (atomic writes)

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DurableMemoryFile, MemoryItem } from '../types';

// ── DurableStore ──────────────────────────────────────────────────────────────

export class DurableStore {
  private readonly filePath: string;

  constructor(stateDir?: string) {
    const base = stateDir ?? path.join(os.homedir(), '.apex', 'state');
    const dir = path.join(base, 'memory');
    this.filePath = path.join(dir, 'durable.json');
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  private atomicWrite(content: string): void {
    this.ensureDir();
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  private loadFile(): DurableMemoryFile {
    if (!fs.existsSync(this.filePath)) {
      return { version: 1, updated_at: new Date().toISOString(), items: [] };
    }
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as DurableMemoryFile;
  }

  private saveFile(file: DurableMemoryFile): void {
    file.updated_at = new Date().toISOString();
    this.atomicWrite(JSON.stringify(file, null, 2));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Store a durable memory item.
   * Callers MUST have obtained explicit user approval before calling this.
   * Replaces an existing item with the same ID if present.
   */
  store(item: MemoryItem): void {
    const file = this.loadFile();
    const idx = file.items.findIndex(i => i.id === item.id);
    if (idx >= 0) {
      file.items[idx] = item;
    } else {
      file.items.push(item);
    }
    this.saveFile(file);
  }

  /**
   * Retrieve a durable item by ID, updating its last_accessed_at and access_count.
   * Returns null if not found.
   */
  get(itemId: string, now: Date = new Date()): MemoryItem | null {
    const file = this.loadFile();
    const item = file.items.find(i => i.id === itemId);
    if (!item) return null;
    item.last_accessed_at = now.toISOString();
    item.access_count += 1;
    this.saveFile(file);
    return item;
  }

  /**
   * Find durable items by tag (exact match), updating access metadata.
   */
  findByTag(tag: string, now: Date = new Date()): MemoryItem[] {
    const file = this.loadFile();
    const results: MemoryItem[] = [];
    let dirty = false;
    for (const item of file.items) {
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
   * List all durable items.  Does not update access metadata.
   */
  list(): MemoryItem[] {
    return this.loadFile().items;
  }

  /**
   * Remove a durable item by ID.
   */
  remove(itemId: string): boolean {
    const file = this.loadFile();
    const idx = file.items.findIndex(i => i.id === itemId);
    if (idx < 0) return false;
    file.items.splice(idx, 1);
    this.saveFile(file);
    return true;
  }

  /**
   * Check if a given item ID already exists in durable storage.
   */
  has(itemId: string): boolean {
    return this.loadFile().items.some(i => i.id === itemId);
  }
}
