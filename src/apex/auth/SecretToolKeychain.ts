// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/auth/SecretToolKeychain.ts — JAL-005 Linux OS-backed keychain via secret-tool
//
// Uses libsecret's `secret-tool` CLI to store, retrieve, and delete secrets
// in the user's OS keyring (GNOME Keyring, KWallet, etc.).
//
// Install: sudo apt install libsecret-tools
//
// secret-tool attribute schema:
//   service  = <service arg>      (e.g. "apex-auth")
//   account  = <account arg>      (e.g. "session:anthropic")
//
// Tokens are NEVER written to disk by this class — secret-tool manages
// all persistence via the OS keyring daemon.

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { IKeychain } from './IKeychain';

const execFileAsync = promisify(execFile);
const TOOL = 'secret-tool';

export class SecretToolKeychain implements IKeychain {
  /**
   * Verify that secret-tool is available in PATH.
   * Call once at startup before instantiating. Throws if not found.
   */
  static async verify(): Promise<void> {
    try {
      await execFileAsync(TOOL, ['--version']);
    } catch {
      throw new Error(
        'secret-tool not found. Install with: sudo apt install libsecret-tools\n' +
        'On headless/VPS systems, ensure a D-Bus session and libsecret daemon are running.'
      );
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(TOOL, [
        'lookup',
        'service', service,
        'account', account,
      ]);
      const value = stdout.trim();
      return value.length > 0 ? value : null;
    } catch {
      // secret-tool exits non-zero when the key does not exist
      return null;
    }
  }

  async set(service: string, account: string, value: string): Promise<void> {
    // secret-tool reads the secret from stdin to avoid it appearing in argv
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        TOOL,
        [
          'store',
          '--label', `apex:${service}:${account}`,
          'service', service,
          'account', account,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );

      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.stdin.write(value);
      proc.stdin.end();

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`secret-tool store failed (exit ${code}): ${stderr.trim()}`));
        }
      });

      proc.on('error', reject);
    });
  }

  async delete(service: string, account: string): Promise<boolean> {
    try {
      await execFileAsync(TOOL, [
        'clear',
        'service', service,
        'account', account,
      ]);
      return true;
    } catch {
      return false;
    }
  }
}
