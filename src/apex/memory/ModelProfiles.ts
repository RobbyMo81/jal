// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/memory/ModelProfiles.ts — JAL-008 Model Profile Configuration
//
// Manages per-model context window sizes and budget override profiles stored at
// ~/.apex/config/model-profiles.json.  Also provides the deterministic mapping
// from context window size to ModelSize tier:
//
//   large  — ≥ 100 000 tokens
//   medium — 16 000 – 99 999 tokens
//   small  — < 16 000 tokens

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ModelProfile, ModelProfilesFile, ModelSize } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MODEL_SIZE_LARGE_THRESHOLD = 100_000;
export const MODEL_SIZE_MEDIUM_THRESHOLD = 16_000;

/** Default profiles for common models. */
const DEFAULT_PROFILES: Record<string, ModelProfile> = {
  'claude-3-opus-20240229':         { model_id: 'claude-3-opus-20240229',         context_window: 200_000 },
  'claude-3-sonnet-20240229':       { model_id: 'claude-3-sonnet-20240229',       context_window: 200_000 },
  'claude-3-haiku-20240307':        { model_id: 'claude-3-haiku-20240307',        context_window: 200_000 },
  'claude-opus-4-6':                { model_id: 'claude-opus-4-6',                context_window: 200_000 },
  'claude-sonnet-4-6':              { model_id: 'claude-sonnet-4-6',              context_window: 200_000 },
  'claude-haiku-4-5-20251001':      { model_id: 'claude-haiku-4-5-20251001',      context_window: 200_000 },
  'gpt-4o':                         { model_id: 'gpt-4o',                         context_window: 128_000 },
  'gpt-4-turbo':                    { model_id: 'gpt-4-turbo',                    context_window: 128_000 },
  'gpt-3.5-turbo':                  { model_id: 'gpt-3.5-turbo',                  context_window: 16_385 },
  'llama-3-8b':                     { model_id: 'llama-3-8b',                     context_window: 8_192 },
  'llama-3-70b':                    { model_id: 'llama-3-70b',                    context_window: 8_192 },
  'mistral-7b':                     { model_id: 'mistral-7b',                     context_window: 8_192 },
  'mixtral-8x7b':                   { model_id: 'mixtral-8x7b',                   context_window: 32_768 },
};

// ── ModelProfiles ─────────────────────────────────────────────────────────────

export class ModelProfiles {
  private readonly filePath: string;

  constructor(configDir?: string) {
    const base = configDir ?? path.join(os.homedir(), '.apex', 'config');
    this.filePath = path.join(base, 'model-profiles.json');
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

  private loadFile(): ModelProfilesFile {
    if (!fs.existsSync(this.filePath)) {
      return {
        version: 1,
        updated_at: new Date().toISOString(),
        profiles: { ...DEFAULT_PROFILES },
      };
    }
    const file = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as ModelProfilesFile;
    // Merge defaults under user overrides so new default entries appear automatically
    for (const [id, def] of Object.entries(DEFAULT_PROFILES)) {
      if (!file.profiles[id]) {
        file.profiles[id] = def;
      }
    }
    return file;
  }

  private saveFile(file: ModelProfilesFile): void {
    file.updated_at = new Date().toISOString();
    this.atomicWrite(JSON.stringify(file, null, 2));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Classify a context window size as large / medium / small.
   *
   *   large  — ≥ 100 000 tokens
   *   medium — 16 000 – 99 999 tokens
   *   small  — < 16 000 tokens
   */
  static getModelSize(contextWindow: number): ModelSize {
    if (contextWindow >= MODEL_SIZE_LARGE_THRESHOLD) return 'large';
    if (contextWindow >= MODEL_SIZE_MEDIUM_THRESHOLD) return 'medium';
    return 'small';
  }

  /**
   * Retrieve the profile for a given model ID.
   * Returns the built-in default if the model is not explicitly registered,
   * or undefined if the model has never been seen.
   */
  getProfile(modelId: string): ModelProfile | undefined {
    return this.loadFile().profiles[modelId];
  }

  /**
   * List all registered model profiles (defaults merged with user overrides).
   */
  listProfiles(): ModelProfile[] {
    return Object.values(this.loadFile().profiles);
  }

  /**
   * Set or update a model profile.  Persists to disk immediately.
   */
  setProfile(profile: ModelProfile): void {
    const file = this.loadFile();
    file.profiles[profile.model_id] = profile;
    this.saveFile(file);
  }

  /**
   * Remove a user-defined profile override.
   * After removal, the built-in default (if any) is restored on next load.
   */
  removeProfile(modelId: string): boolean {
    const file = this.loadFile();
    if (!file.profiles[modelId]) return false;
    delete file.profiles[modelId];
    this.saveFile(file);
    return true;
  }

  /**
   * Return the context window for a model, or undefined if unknown.
   */
  getContextWindow(modelId: string): number | undefined {
    return this.getProfile(modelId)?.context_window;
  }
}
