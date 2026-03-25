// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/memory/EpisodicStore.test.ts — JAL-008

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EpisodicStore, EPISODIC_TTL_MS, EPISODIC_QUOTA_BYTES } from '../../src/apex/memory/EpisodicStore';
import { MemoryItem } from '../../src/apex/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-episodic-'));
}

let idCounter = 0;
function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  const now = new Date().toISOString();
  idCounter++;
  return {
    id: `item-${idCounter}`,
    tier: 'episodic',
    content: 'test content',
    tags: ['tag1'],
    workspace_id: 'ws1',
    session_id: 'sess1',
    created_at: now,
    last_accessed_at: now,
    access_count: 0,
    size_bytes: Buffer.byteLength('test content', 'utf8'),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EpisodicStore', () => {
  let tmpDir: string;
  let store: EpisodicStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new EpisodicStore(tmpDir);
    idCounter = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── store / get ───────────────────────────────────────────────────────────

  describe('store() / get()', () => {
    it('stores and retrieves an item by id', () => {
      const item = makeItem();
      store.store(item);
      const result = store.get('ws1', item.id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(item.id);
    });

    it('returns null for unknown item id', () => {
      expect(store.get('ws1', 'nonexistent')).toBeNull();
    });

    it('updates last_accessed_at and access_count on get()', () => {
      const item = makeItem();
      store.store(item);
      const later = new Date(Date.now() + 1_000);
      const result = store.get('ws1', item.id, later);
      expect(result!.access_count).toBe(1);
      expect(result!.last_accessed_at).toBe(later.toISOString());
    });

    it('replaces existing item with same id on re-store', () => {
      const item = makeItem({ content: 'original' });
      store.store(item);
      store.store({ ...item, content: 'updated' });
      const result = store.get('ws1', item.id);
      expect(result!.content).toBe('updated');
    });

    it('returns null and removes expired items on get()', () => {
      const pastAccess = new Date(Date.now() - EPISODIC_TTL_MS - 1_000);
      const item = makeItem({ last_accessed_at: pastAccess.toISOString() });
      store.store(item);
      const result = store.get('ws1', item.id, new Date());
      expect(result).toBeNull();
      // Ensure it was removed
      expect(store.list('ws1')).toHaveLength(0);
    });
  });

  // ── findByTag ─────────────────────────────────────────────────────────────

  describe('findByTag()', () => {
    it('finds items matching a tag', () => {
      const a = makeItem({ tags: ['alpha', 'beta'] });
      const b = makeItem({ tags: ['beta'] });
      const c = makeItem({ tags: ['gamma'] });
      store.store(a);
      store.store(b);
      store.store(c);
      const results = store.findByTag('ws1', 'beta');
      expect(results.map(i => i.id).sort()).toEqual([a.id, b.id].sort());
    });

    it('returns empty array when no tags match', () => {
      store.store(makeItem({ tags: ['alpha'] }));
      expect(store.findByTag('ws1', 'zzz')).toHaveLength(0);
    });

    it('does not return expired items', () => {
      const expired = makeItem({
        tags: ['x'],
        last_accessed_at: new Date(Date.now() - EPISODIC_TTL_MS - 1_000).toISOString(),
      });
      store.store(expired);
      expect(store.findByTag('ws1', 'x', new Date())).toHaveLength(0);
    });
  });

  // ── list ──────────────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns all non-expired items', () => {
      store.store(makeItem({ id: 'a' }));
      store.store(makeItem({ id: 'b' }));
      expect(store.list('ws1')).toHaveLength(2);
    });

    it('excludes expired items', () => {
      store.store(makeItem({ id: 'live' }));
      store.store(makeItem({
        id: 'dead',
        last_accessed_at: new Date(Date.now() - EPISODIC_TTL_MS - 1_000).toISOString(),
      }));
      expect(store.list('ws1')).toHaveLength(1);
    });
  });

  // ── remove ────────────────────────────────────────────────────────────────

  describe('remove()', () => {
    it('removes an item and returns true', () => {
      const item = makeItem();
      store.store(item);
      expect(store.remove('ws1', item.id)).toBe(true);
      expect(store.get('ws1', item.id)).toBeNull();
    });

    it('returns false when item not found', () => {
      expect(store.remove('ws1', 'ghost')).toBe(false);
    });
  });

  // ── evict: TTL ────────────────────────────────────────────────────────────

  describe('evict(): TTL', () => {
    it('removes items older than 30 days', () => {
      const fresh = makeItem({ id: 'fresh' });
      const stale = makeItem({
        id: 'stale',
        last_accessed_at: new Date(Date.now() - EPISODIC_TTL_MS - 1_000).toISOString(),
      });
      store.store(fresh);
      store.store(stale);
      const removed = store.evict('ws1', new Date());
      expect(removed).toBe(1);
      expect(store.list('ws1')).toHaveLength(1);
      expect(store.list('ws1')[0]!.id).toBe('fresh');
    });
  });

  // ── evict: LRU quota ──────────────────────────────────────────────────────

  describe('evict(): LRU quota', () => {
    it('evicts oldest items when workspace exceeds 50 MB', () => {
      // Create two items that together exceed the quota.
      // store() triggers eviction automatically when over quota.
      const halfQuotaBytes = Math.floor(EPISODIC_QUOTA_BYTES / 2) + 1;
      const content = 'x'.repeat(halfQuotaBytes);
      const older = makeItem({
        id: 'older',
        content,
        size_bytes: halfQuotaBytes,
        last_accessed_at: new Date(Date.now() - 10_000).toISOString(),
      });
      const newer = makeItem({
        id: 'newer',
        content,
        size_bytes: halfQuotaBytes,
        last_accessed_at: new Date(Date.now()).toISOString(),
      });
      store.store(older);
      store.store(newer);
      // After storing both items, store() triggers automatic eviction.
      // The older item should have been evicted.
      const remaining = store.list('ws1');
      const ids = remaining.map(i => i.id);
      expect(ids).not.toContain('older');
    });

    it('evict() removes expired items and returns count', () => {
      // Store one fresh and one TTL-expired item, then call evict() directly.
      const fresh = makeItem({ id: 'evict-fresh' });
      const expired = makeItem({
        id: 'evict-expired',
        last_accessed_at: new Date(Date.now() - EPISODIC_TTL_MS - 1_000).toISOString(),
      });
      store.store(fresh);
      store.store(expired);
      const removed = store.evict('ws1', new Date());
      expect(removed).toBe(1);
      expect(store.list('ws1').map(i => i.id)).toContain('evict-fresh');
      expect(store.list('ws1').map(i => i.id)).not.toContain('evict-expired');
    });
  });

  // ── stats ─────────────────────────────────────────────────────────────────

  describe('stats()', () => {
    it('returns correct item count and total bytes', () => {
      const a = makeItem({ size_bytes: 100 });
      const b = makeItem({ size_bytes: 200 });
      store.store(a);
      store.store(b);
      const s = store.stats('ws1');
      expect(s.item_count).toBe(2);
      expect(s.total_bytes).toBe(300);
      expect(s.quota_bytes).toBe(EPISODIC_QUOTA_BYTES);
    });
  });

  // ── workspace isolation ───────────────────────────────────────────────────

  describe('workspace isolation', () => {
    it('items in different workspaces do not interfere', () => {
      store.store(makeItem({ id: 'ws1-item', workspace_id: 'ws1' }));
      store.store(makeItem({ id: 'ws2-item', workspace_id: 'ws2' }));
      expect(store.list('ws1').map(i => i.id)).toEqual(['ws1-item']);
      expect(store.list('ws2').map(i => i.id)).toEqual(['ws2-item']);
    });
  });
});
