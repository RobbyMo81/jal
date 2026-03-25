// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/checkpoint/OutputStore.ts — JAL-007 Tool Output Storage
//
// Manages tool output persistence for checkpoint-based crash recovery:
//  - Outputs ≤ 10 KB are inlined in the ToolOutputRef
//  - Outputs > 10 KB are written to disk at ~/.apex/state/outputs/<sha256>
//  - All outputs are identified by SHA256 hash (verified on retrieval)
//  - Retention: files older than APEX_OUTPUT_RETENTION_DAYS (default 7) are pruned

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolOutputRef } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Outputs at or below this size are inlined in the checkpoint JSON. */
export const LARGE_OUTPUT_THRESHOLD_BYTES = 10 * 1024; // 10 KB

/** Default number of days to retain on-disk output files. */
const DEFAULT_RETENTION_DAYS = 7;

// ── OutputStore ───────────────────────────────────────────────────────────────

export class OutputStore {
  private readonly outputsDir: string;
  readonly retentionDays: number;

  constructor(stateDir?: string) {
    const base = stateDir ?? path.join(os.homedir(), '.apex', 'state');
    this.outputsDir = path.join(base, 'outputs');
    const envDays = Number(process.env['APEX_OUTPUT_RETENTION_DAYS']);
    this.retentionDays = Number.isFinite(envDays) && envDays > 0
      ? envDays
      : DEFAULT_RETENTION_DAYS;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private ensureDir(): void {
    fs.mkdirSync(this.outputsDir, { recursive: true });
  }

  private outputPath(hash: string): string {
    return path.join(this.outputsDir, hash);
  }

  static sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Store a tool output string and return a ToolOutputRef.
   *
   * - Outputs ≤ LARGE_OUTPUT_THRESHOLD_BYTES are returned as inline refs.
   * - Larger outputs are written atomically to disk; the file path is derived
   *   from the SHA256 hash so duplicate content is never written twice.
   */
  store(content: string): ToolOutputRef {
    const hash = OutputStore.sha256(content);
    const size_bytes = Buffer.byteLength(content, 'utf8');

    if (size_bytes <= LARGE_OUTPUT_THRESHOLD_BYTES) {
      // Small enough to inline — no disk write needed.
      return { hash, size_bytes, inline: content };
    }

    // Large output: write to disk atomically, skip if already present.
    this.ensureDir();
    const filePath = this.outputPath(hash);
    if (!fs.existsSync(filePath)) {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, filePath);
    }
    return { hash, size_bytes };
  }

  /**
   * Retrieve the output content for a ToolOutputRef.
   *
   * For inline refs the content is returned directly after hash verification.
   * For on-disk refs the file is read and its hash is verified before returning.
   *
   * @throws Error if the hash does not match (corruption) or the file is missing.
   */
  retrieve(ref: ToolOutputRef): string {
    if (ref.inline !== undefined) {
      const actual = OutputStore.sha256(ref.inline);
      if (actual !== ref.hash) {
        throw new Error(
          `OutputStore: inline hash mismatch. Expected ${ref.hash}, got ${actual}`
        );
      }
      return ref.inline;
    }

    const filePath = this.outputPath(ref.hash);
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `OutputStore: output file not found for hash ${ref.hash} — file may have expired`
      );
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const actual = OutputStore.sha256(content);
    if (actual !== ref.hash) {
      throw new Error(
        `OutputStore: disk hash mismatch for ${ref.hash}. File may be corrupted.`
      );
    }
    return content;
  }

  /**
   * Delete on-disk output files older than `retentionDays`.
   * Called at startup or periodically to prevent unbounded disk growth.
   * Errors on individual files are silently ignored.
   */
  cleanup(): number {
    if (!fs.existsSync(this.outputsDir)) return 0;

    const cutoffMs = Date.now() - this.retentionDays * 24 * 60 * 60 * 1_000;
    const entries = fs.readdirSync(this.outputsDir);
    let removed = 0;

    for (const entry of entries) {
      // Skip temp files still being written
      if (entry.endsWith('.tmp')) continue;
      const filePath = this.outputPath(entry);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoffMs) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch {
        // Best-effort: ignore missing or unreadable files
      }
    }

    return removed;
  }
}
