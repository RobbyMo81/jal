// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/cli/auth-login.ts — JAL-005 CLI hook: apex auth login
//
// Contract (from acceptance criteria):
//   apex auth login --provider <name> --json
//   → writes { status, provider, expires_at, message } to stdout
//   → exits 0 on success, 1 on failure
//
// Auth methods supported (--method flag, default: cli-hook):
//   cli-hook   — reads token from stdin (for CI / piped auth flows)
//   api-key    — prompts for API key interactively (readline fallback)
//
// Token is stored in OS keychain via AuthManager. Never written to disk.
//
// Usage examples:
//   echo "$MY_TOKEN" | npx ts-node src/apex/cli/auth-login.ts --provider anthropic --json
//   npx ts-node src/apex/cli/auth-login.ts --provider openai --method api-key --json

import * as readline from 'readline';
import { AuthManager } from '../auth/AuthManager';
import { SecretToolKeychain } from '../auth/SecretToolKeychain';
import { AuditLog } from '../policy/AuditLog';
import { AuthLoginResult, AuthMethod } from '../types';

// ── Arg parsing ────────────────────────────────────────────────────────────────

interface CliArgs {
  provider: string | null;
  method: AuthMethod;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // strip 'node' and script path
  let provider: string | null = null;
  let method: AuthMethod = 'cli-hook';
  let json = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--provider':
        provider = args[++i] ?? null;
        break;
      case '--method':
        method = (args[++i] ?? 'cli-hook') as AuthMethod;
        break;
      case '--json':
        json = true;
        break;
    }
  }

  return { provider, method, json };
}

// ── Token acquisition ──────────────────────────────────────────────────────────

/** Read token from stdin (non-interactive — for piped CI flows). */
async function readTokenFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

/** Prompt interactively for a token/API key (readline, masked). */
async function promptToken(provider: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // write prompt to stderr so stdout stays clean for --json
  });

  return new Promise((resolve) => {
    rl.question(`Enter API key / token for ${provider}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Output helpers ─────────────────────────────────────────────────────────────

function emit(result: AuthLoginResult, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    const prefix = result.status === 'success' ? '✓' : '✗';
    process.stderr.write(`${prefix} ${result.message}\n`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { provider, method, json } = parseArgs(process.argv);

  if (!provider) {
    const result: AuthLoginResult = {
      status: 'failure',
      provider: '',
      expires_at: null,
      message: 'Missing required flag: --provider <name>',
    };
    emit(result, json);
    process.exit(1);
  }

  // Acquire token based on method
  let token: string;
  try {
    if (method === 'cli-hook' || !process.stdin.isTTY) {
      token = await readTokenFromStdin();
    } else {
      token = await promptToken(provider);
    }
  } catch (err) {
    const result: AuthLoginResult = {
      status: 'failure',
      provider,
      expires_at: null,
      message: `Failed to read token: ${err instanceof Error ? err.message : String(err)}`,
    };
    emit(result, json);
    process.exit(1);
  }

  if (!token) {
    const result: AuthLoginResult = {
      status: 'failure',
      provider,
      expires_at: null,
      message: 'Empty token received — aborting login.',
    };
    emit(result, json);
    process.exit(1);
  }

  // Verify OS keychain is available
  try {
    await SecretToolKeychain.verify();
  } catch (err) {
    const result: AuthLoginResult = {
      status: 'failure',
      provider,
      expires_at: null,
      message: `OS keychain unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
    emit(result, json);
    process.exit(1);
  }

  const keychain = new SecretToolKeychain();
  const audit = new AuditLog();
  const manager = new AuthManager({ keychain, audit });

  const result = await manager.login(provider, token, { auth_method: method });

  emit(result, json);
  process.exit(result.status === 'success' ? 0 : 1);
}

main().catch((err) => {
  const result: AuthLoginResult = {
    status: 'failure',
    provider: '',
    expires_at: null,
    message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  };
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(1);
});
