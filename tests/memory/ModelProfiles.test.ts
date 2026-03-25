// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/memory/ModelProfiles.test.ts — JAL-008

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ModelProfiles } from '../../src/apex/memory/ModelProfiles';
import { ModelProfile } from '../../src/apex/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-modelprofiles-'));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ModelProfiles', () => {
  let tmpDir: string;
  let mp: ModelProfiles;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mp = new ModelProfiles(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── getModelSize ──────────────────────────────────────────────────────────

  describe('getModelSize()', () => {
    it('classifies ≥100K as large', () => {
      expect(ModelProfiles.getModelSize(200_000)).toBe('large');
      expect(ModelProfiles.getModelSize(100_000)).toBe('large');
    });

    it('classifies 16K–99999 as medium', () => {
      expect(ModelProfiles.getModelSize(16_000)).toBe('medium');
      expect(ModelProfiles.getModelSize(32_768)).toBe('medium');
      expect(ModelProfiles.getModelSize(99_999)).toBe('medium');
    });

    it('classifies <16K as small', () => {
      expect(ModelProfiles.getModelSize(8_192)).toBe('small');
      expect(ModelProfiles.getModelSize(4_096)).toBe('small');
      expect(ModelProfiles.getModelSize(15_999)).toBe('small');
    });
  });

  // ── built-in defaults ─────────────────────────────────────────────────────

  describe('built-in default profiles', () => {
    it('has a profile for claude-opus-4-6', () => {
      const p = mp.getProfile('claude-opus-4-6');
      expect(p).toBeDefined();
      expect(p!.context_window).toBe(200_000);
    });

    it('has a profile for gpt-4o', () => {
      const p = mp.getProfile('gpt-4o');
      expect(p).toBeDefined();
      expect(p!.context_window).toBe(128_000);
    });

    it('returns undefined for unknown model', () => {
      expect(mp.getProfile('totally-unknown-model')).toBeUndefined();
    });
  });

  // ── setProfile / getProfile ───────────────────────────────────────────────

  describe('setProfile() / getProfile()', () => {
    it('stores a custom profile', () => {
      const profile: ModelProfile = {
        model_id: 'my-custom-model',
        context_window: 50_000,
        budget_overrides: { system_policy_pct: 30 },
      };
      mp.setProfile(profile);
      const retrieved = mp.getProfile('my-custom-model');
      expect(retrieved).toBeDefined();
      expect(retrieved!.context_window).toBe(50_000);
      expect(retrieved!.budget_overrides?.system_policy_pct).toBe(30);
    });

    it('persists profiles across instances', () => {
      mp.setProfile({ model_id: 'persist-model', context_window: 8_000 });
      const mp2 = new ModelProfiles(tmpDir);
      expect(mp2.getProfile('persist-model')?.context_window).toBe(8_000);
    });

    it('updates an existing profile', () => {
      mp.setProfile({ model_id: 'update-me', context_window: 16_000 });
      mp.setProfile({ model_id: 'update-me', context_window: 32_000 });
      expect(mp.getProfile('update-me')!.context_window).toBe(32_000);
    });
  });

  // ── removeProfile ─────────────────────────────────────────────────────────

  describe('removeProfile()', () => {
    it('removes a user-defined profile and returns true', () => {
      mp.setProfile({ model_id: 'remove-me', context_window: 8_000 });
      expect(mp.removeProfile('remove-me')).toBe(true);
      expect(mp.getProfile('remove-me')).toBeUndefined();
    });

    it('returns false when profile does not exist', () => {
      expect(mp.removeProfile('never-existed')).toBe(false);
    });
  });

  // ── getContextWindow ──────────────────────────────────────────────────────

  describe('getContextWindow()', () => {
    it('returns context window for known model', () => {
      expect(mp.getContextWindow('gpt-4o')).toBe(128_000);
    });

    it('returns undefined for unknown model', () => {
      expect(mp.getContextWindow('unknown-xyz')).toBeUndefined();
    });
  });

  // ── listProfiles ──────────────────────────────────────────────────────────

  describe('listProfiles()', () => {
    it('returns at least the built-in defaults', () => {
      const profiles = mp.listProfiles();
      expect(profiles.length).toBeGreaterThan(5);
      expect(profiles.map(p => p.model_id)).toContain('claude-opus-4-6');
    });
  });
});
