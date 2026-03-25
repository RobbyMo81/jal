// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/memory/DurableStore.test.ts — JAL-008

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DurableStore } from '../../src/apex/memory/DurableStore';
import { MemoryItem } from '../../src/apex/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-durable-'));
}

let counter = 0;
function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date().toISOString();
  counter++;
  return {
    id: `durable-${counter}`,
    tier: 'durable',
    content: 'durable content',
    tags: ['important'],
    workspace_id: 'ws1',
    session_id: 'sess1',
    created_at: now,
    last_accessed_at: now,
    access_count: 0,
    size_bytes: Buffer.byteLength('durable content', 'utf8'),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DurableStore', () => {
  let tmpDir: string;
  let store: DurableStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new DurableStore(tmpDir);
    counter = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── store / get ───────────────────────────────────────────────────────────

  describe('store() / get()', () => {
    it('stores and retrieves a durable item', () => {
      const item = makeItem();
      store.store(item);
      const result = store.get(item.id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(item.id);
      expect(result!.content).toBe('durable content');
    });

    it('returns null for unknown id', () => {
      expect(store.get('unknown')).toBeNull();
    });

    it('updates last_accessed_at and access_count on get()', () => {
      const item = makeItem();
      store.store(item);
      const later = new Date(Date.now() + 1_000);
      const result = store.get(item.id, later);
      expect(result!.access_count).toBe(1);
      expect(result!.last_accessed_at).toBe(later.toISOString());
    });

    it('replaces existing item on re-store with same id', () => {
      const item = makeItem({ content: 'v1' });
      store.store(item);
      store.store({ ...item, content: 'v2' });
      expect(store.get(item.id)!.content).toBe('v2');
    });
  });

  // ── list ──────────────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns all stored items', () => {
      store.store(makeItem({ id: 'a' }));
      store.store(makeItem({ id: 'b' }));
      const items = store.list();
      expect(items.map(i => i.id).sort()).toEqual(['a', 'b'].sort());
    });

    it('returns empty array when nothing stored', () => {
      expect(store.list()).toHaveLength(0);
    });
  });

  // ── findByTag ─────────────────────────────────────────────────────────────

  describe('findByTag()', () => {
    it('finds items by exact tag match', () => {
      store.store(makeItem({ id: 'x', tags: ['alpha', 'beta'] }));
      store.store(makeItem({ id: 'y', tags: ['beta'] }));
      store.store(makeItem({ id: 'z', tags: ['gamma'] }));
      const results = store.findByTag('beta');
      expect(results.map(i => i.id).sort()).toEqual(['x', 'y'].sort());
    });

    it('returns empty when tag not found', () => {
      store.store(makeItem({ tags: ['foo'] }));
      expect(store.findByTag('bar')).toHaveLength(0);
    });
  });

  // ── remove ────────────────────────────────────────────────────────────────

  describe('remove()', () => {
    it('removes an item and returns true', () => {
      const item = makeItem();
      store.store(item);
      expect(store.remove(item.id)).toBe(true);
      expect(store.get(item.id)).toBeNull();
    });

    it('returns false when item not found', () => {
      expect(store.remove('nonexistent')).toBe(false);
    });
  });

  // ── has ───────────────────────────────────────────────────────────────────

  describe('has()', () => {
    it('returns true when item exists', () => {
      const item = makeItem();
      store.store(item);
      expect(store.has(item.id)).toBe(true);
    });

    it('returns false when item absent', () => {
      expect(store.has('ghost')).toBe(false);
    });
  });

  // ── persistence ───────────────────────────────────────────────────────────

  describe('persistence', () => {
    it('items survive a new DurableStore instance on same stateDir', () => {
      const item = makeItem({ id: 'persist-test' });
      store.store(item);
      const store2 = new DurableStore(tmpDir);
      expect(store2.has('persist-test')).toBe(true);
    });
  });
});
