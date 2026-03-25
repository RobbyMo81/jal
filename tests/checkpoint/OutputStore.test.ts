// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/checkpoint/OutputStore.test.ts — JAL-007

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { OutputStore, LARGE_OUTPUT_THRESHOLD_BYTES } from '../../src/apex/checkpoint/OutputStore';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-output-store-'));
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('OutputStore', () => {
  let tmpDir: string;
  let store: OutputStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new OutputStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── store() ──────────────────────────────────────────────────────────────────

  describe('store()', () => {
    it('inlines content that is within the 10 KB threshold', () => {
      const content = 'hello world';
      const ref = store.store(content);

      expect(ref.inline).toBe(content);
      expect(ref.hash).toBe(sha256(content));
      expect(ref.size_bytes).toBe(Buffer.byteLength(content, 'utf8'));
    });

    it('does not write a file for small content', () => {
      const content = 'small';
      store.store(content);

      const outputsDir = path.join(tmpDir, 'outputs');
      expect(fs.existsSync(outputsDir)).toBe(false);
    });

    it('writes large content to disk and returns no inline', () => {
      const content = 'x'.repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 1);
      const ref = store.store(content);

      expect(ref.inline).toBeUndefined();
      expect(ref.hash).toBe(sha256(content));
      expect(ref.size_bytes).toBeGreaterThan(LARGE_OUTPUT_THRESHOLD_BYTES);

      const filePath = path.join(tmpDir, 'outputs', ref.hash);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    });

    it('does not write a duplicate file if the same hash already exists', () => {
      const content = 'x'.repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 100);
      store.store(content);
      store.store(content); // second call — should not error or overwrite

      const filePath = path.join(tmpDir, 'outputs', sha256(content));
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('content exactly at the threshold is inlined (≤ not <)', () => {
      const content = 'a'.repeat(LARGE_OUTPUT_THRESHOLD_BYTES);
      const ref = store.store(content);
      expect(ref.inline).toBe(content);
    });

    it('content one byte over threshold goes to disk', () => {
      const content = 'a'.repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 1);
      const ref = store.store(content);
      expect(ref.inline).toBeUndefined();
      expect(fs.existsSync(path.join(tmpDir, 'outputs', ref.hash))).toBe(true);
    });
  });

  // ── retrieve() ────────────────────────────────────────────────────────────────

  describe('retrieve()', () => {
    it('returns inline content and verifies hash', () => {
      const content = 'hello';
      const ref = store.store(content);
      expect(store.retrieve(ref)).toBe(content);
    });

    it('returns on-disk content for large outputs and verifies hash', () => {
      const content = 'z'.repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 1);
      const ref = store.store(content);
      expect(store.retrieve(ref)).toBe(content);
    });

    it('throws on inline content hash mismatch (tampered ref)', () => {
      const ref = store.store('original');
      const tampered = { ...ref, inline: 'modified', hash: ref.hash };
      expect(() => store.retrieve(tampered)).toThrow(/hash mismatch/);
    });

    it('throws when on-disk file is missing', () => {
      const content = 'y'.repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 1);
      const ref = store.store(content);
      // Delete the file to simulate expiry
      fs.unlinkSync(path.join(tmpDir, 'outputs', ref.hash));
      expect(() => store.retrieve(ref)).toThrow(/not found/);
    });

    it('throws on disk hash mismatch (corrupted file)', () => {
      const content = 'c'.repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 1);
      const ref = store.store(content);
      // Corrupt the file
      fs.writeFileSync(path.join(tmpDir, 'outputs', ref.hash), 'corrupted', 'utf8');
      expect(() => store.retrieve(ref)).toThrow(/hash mismatch/);
    });
  });

  // ── cleanup() ─────────────────────────────────────────────────────────────────

  describe('cleanup()', () => {
    it('returns 0 when outputs dir does not exist', () => {
      expect(store.cleanup()).toBe(0);
    });

    it('deletes files older than retentionDays', () => {
      const content = 'b'.repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 1);
      const ref = store.store(content);
      const filePath = path.join(tmpDir, 'outputs', ref.hash);

      // Back-date the file's mtime to 8 days ago
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(filePath, eightDaysAgo, eightDaysAgo);

      // Default retention is 7 days, so this file should be removed
      const removed = store.cleanup();
      expect(removed).toBe(1);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('keeps files newer than retentionDays', () => {
      const content = 'd'.repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 1);
      const ref = store.store(content);
      const filePath = path.join(tmpDir, 'outputs', ref.hash);

      // Leave mtime as now — should not be removed
      const removed = store.cleanup();
      expect(removed).toBe(0);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('skips .tmp files during cleanup', () => {
      const outputsDir = path.join(tmpDir, 'outputs');
      fs.mkdirSync(outputsDir, { recursive: true });
      const tmpFile = path.join(outputsDir, 'somehash.tmp');
      fs.writeFileSync(tmpFile, 'partial', 'utf8');

      // Back-date the .tmp file
      const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(tmpFile, ancient, ancient);

      const removed = store.cleanup();
      expect(removed).toBe(0);
      expect(fs.existsSync(tmpFile)).toBe(true);
    });

    it('respects APEX_OUTPUT_RETENTION_DAYS env override', () => {
      const origEnv = process.env['APEX_OUTPUT_RETENTION_DAYS'];
      process.env['APEX_OUTPUT_RETENTION_DAYS'] = '1';

      const customStore = new OutputStore(tmpDir);
      expect(customStore.retentionDays).toBe(1);

      process.env['APEX_OUTPUT_RETENTION_DAYS'] = origEnv ?? '';
    });
  });

  // ── sha256 static helper ───────────────────────────────────────────────────────

  describe('sha256()', () => {
    it('produces a 64-character hex string', () => {
      expect(OutputStore.sha256('test')).toHaveLength(64);
    });

    it('is deterministic', () => {
      expect(OutputStore.sha256('abc')).toBe(OutputStore.sha256('abc'));
    });

    it('differs for different inputs', () => {
      expect(OutputStore.sha256('abc')).not.toBe(OutputStore.sha256('def'));
    });
  });
});
