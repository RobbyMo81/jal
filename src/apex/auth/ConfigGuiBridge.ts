// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/auth/ConfigGuiBridge.ts — JAL-005 Config-GUI launcher and fallback
//
// Invokes the shared config-gui binary at CONFIG_GUI_BINARY_PATH for
// interactive provider/model selection. If the binary is unavailable,
// emits a non-fatal warning and returns null (caller must handle gracefully).
//
// The config-gui is used ONLY for provider/model selection.
// API keys / auth tokens are NEVER read from its .env output — those are
// handled exclusively by AuthManager + IKeychain.
//
// Config-GUI binary: /home/spoq/ai-vision/tools/config-gui/target/release/ai-vision-config
// Source:            /home/spoq/ai-vision/tools/config-gui
//
// After the binary exits, the bridge reads STAGEHAND_LLM_PROVIDER and
// STAGEHAND_LLM_MODEL from the .env it wrote, then returns a ProviderConfig.
// Any credential (API key) entries in that .env are intentionally ignored.

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ProviderConfig } from '../types';

// ── Constants ──────────────────────────────────────────────────────────────────

const CONFIG_GUI_BINARY_PATH =
  '/home/spoq/ai-vision/tools/config-gui/target/release/ai-vision-config';

/** Env file the config-gui writes to (resolved by the binary from cwd upward). */
const ENV_SEARCH_ROOTS = [
  join(homedir(), 'ai-vision', '.env'),
  join(homedir(), '.env'),
];

// ── ConfigGuiBridge ────────────────────────────────────────────────────────────

export interface ConfigGuiResult {
  config: ProviderConfig;
  /** True if the real binary was used; false if bridge returned a cached/default config. */
  usedBinary: boolean;
  /** Warning message emitted when binary is unavailable. */
  warning?: string;
}

export class ConfigGuiBridge {
  private readonly binaryPath: string;
  private readonly onWarning: (msg: string) => void;

  constructor(opts: {
    binaryPath?: string;
    onWarning?: (msg: string) => void;
  } = {}) {
    this.binaryPath = opts.binaryPath ?? CONFIG_GUI_BINARY_PATH;
    this.onWarning = opts.onWarning ?? ((msg) => process.stderr.write(`[ConfigGuiBridge] WARNING: ${msg}\n`));
  }

  /**
   * Check whether the config-gui binary is available (compiled and on disk).
   */
  isAvailable(): boolean {
    return existsSync(this.binaryPath);
  }

  /**
   * Launch the config-gui interactively and return the provider/model selection.
   *
   * - If binary is unavailable: emits non-fatal warning, returns null.
   * - Inherits stdio so the TUI renders correctly in the user's terminal.
   * - After exit, parses provider+model from the env file the binary wrote.
   * - API key entries in that env file are explicitly NOT returned (auth is separate).
   */
  async launch(): Promise<ConfigGuiResult | null> {
    if (!this.isAvailable()) {
      const msg =
        `Config-GUI binary not found at ${this.binaryPath}. ` +
        `Build it with: cd /home/spoq/ai-vision/tools/config-gui && cargo build --release. ` +
        `Falling back to previously stored provider config.`;
      this.onWarning(msg);
      return null;
    }

    await this.runBinary();

    const config = this.readProviderConfig();
    if (!config) {
      this.onWarning(
        'Config-GUI exited but provider/model selection could not be read. ' +
        'Using previously stored config.'
      );
      return null;
    }

    return { config, usedBinary: true };
  }

  /**
   * Parse provider/model from a .env file written by config-gui.
   * Only reads STAGEHAND_LLM_PROVIDER and STAGEHAND_LLM_MODEL.
   * Never returns API key values — those are intentionally excluded.
   */
  parseEnvFile(content: string): ProviderConfig | null {
    const map: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed === '') continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^"(.*)"$/, '$1');
      map[key] = val;
    }

    const provider = map['STAGEHAND_LLM_PROVIDER'];
    const model = map['STAGEHAND_LLM_MODEL'];

    if (!provider || !model) return null;
    return { provider, model };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private runBinary(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Inherit stdio so the TUI renders in the user's terminal
      const proc = spawn(this.binaryPath, [], { stdio: 'inherit' });

      proc.on('close', (code) => {
        // Exit code 0 = saved; any other code is a user abort or error.
        // We resolve in both cases — the caller checks if env was written.
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`config-gui exited with code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }

  private readProviderConfig(): ProviderConfig | null {
    for (const envPath of ENV_SEARCH_ROOTS) {
      if (existsSync(envPath)) {
        try {
          const content = readFileSync(envPath, 'utf-8');
          const config = this.parseEnvFile(content);
          if (config) return config;
        } catch {
          // Continue to next candidate
        }
      }
    }
    return null;
  }
}
