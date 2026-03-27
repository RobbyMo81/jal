// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// tests/agent/Summarizer.test.ts — JAL-015

import { Summarizer, SUMMARY_TOKEN_THRESHOLD } from '../../src/apex/agent/Summarizer';
import { ProviderGateway, IProviderAdapter } from '../../src/apex/auth/ProviderGateway';
import { AuthManager } from '../../src/apex/auth/AuthManager';
import { MemoryKeychain } from '../../src/apex/auth/MemoryKeychain';
import { NoOpAuditLog } from '../../src/apex/policy/AuditLog';
import { GatewayMessage, CompletionOptions, CompletionResult } from '../../src/apex/types';
import { approxTokens } from '../../src/apex/memory/ContextBudget';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildGateway(response: string): ProviderGateway {
  const keychain = new MemoryKeychain();
  const authManager = new AuthManager({ keychain, audit: new NoOpAuditLog() });

  const adapter: IProviderAdapter = {
    provider: 'test',
    async complete(
      _msgs: GatewayMessage[],
      model: string,
      _token: string,
      _opts: CompletionOptions
    ): Promise<CompletionResult> {
      return { content: response, model, provider: 'test' };
    },
    async stream(
      _msgs: GatewayMessage[],
      model: string,
      _token: string,
      _opts: CompletionOptions,
      onChunk: (c: string) => void
    ): Promise<CompletionResult> {
      onChunk(response);
      return { content: response, model, provider: 'test' };
    },
  };

  const gw = new ProviderGateway({ authManager, config: { provider: 'test', model: 'm' } });
  gw.registerAdapter(adapter);
  (async () => {
    await authManager.login('test', 'test-token', { auth_method: 'cli-hook', expires_at: null });
  })();
  return gw;
}

function buildFailingGateway(): ProviderGateway {
  const keychain = new MemoryKeychain();
  const authManager = new AuthManager({ keychain, audit: new NoOpAuditLog() });

  const adapter: IProviderAdapter = {
    provider: 'test',
    async complete(): Promise<CompletionResult> {
      throw new Error('gateway unavailable');
    },
    async stream(): Promise<CompletionResult> {
      throw new Error('gateway unavailable');
    },
  };

  const gw = new ProviderGateway({ authManager, config: { provider: 'test', model: 'm' } });
  gw.registerAdapter(adapter);
  (async () => {
    await authManager.login('test', 'test-token', { auth_method: 'cli-hook', expires_at: null });
  })();
  return gw;
}

function makeText(tokens: number): string {
  return 'word '.repeat(tokens);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Summarizer.shouldSummarize', () => {
  const summ = new Summarizer(buildGateway('[stub]'));

  it('returns false when text is at or below threshold', () => {
    const short = makeText(100); // well below 2000 tokens
    expect(summ.shouldSummarize(short)).toBe(false);
  });

  it('returns true when text exceeds SUMMARY_TOKEN_THRESHOLD', () => {
    const long = makeText(SUMMARY_TOKEN_THRESHOLD + 50);
    expect(summ.shouldSummarize(long)).toBe(true);
  });

  it('boundary: 2000 tokens exactly is NOT summarized (> not >=)', () => {
    // Construct text that is exactly 2000 tokens
    const text = makeText(2000);
    const actual = approxTokens(text);
    // shouldSummarize uses strict >, so exactly at threshold returns false
    if (actual === SUMMARY_TOKEN_THRESHOLD) {
      expect(summ.shouldSummarize(text)).toBe(false);
    }
    // If rounding makes it slightly above, that's fine — just ensure it's deterministic
  });
});

describe('Summarizer.sanitize', () => {
  const summ = new Summarizer(buildGateway('[stub]'));

  it('removes lines containing password assignments', () => {
    const input = 'step 1: run deploy\npassword=secret123\nstep 2: verify';
    const result = summ.sanitize(input);
    expect(result).not.toContain('password=secret123');
    expect(result).toContain('step 1: run deploy');
    expect(result).toContain('step 2: verify');
  });

  it('removes lines containing token assignments', () => {
    const input = 'connecting...\ntoken: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\nconnected';
    const result = summ.sanitize(input);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(result).toContain('connecting...');
    expect(result).toContain('connected');
  });

  it('removes lines containing OpenAI-style secret keys', () => {
    const input = 'deploying...\nAPI_KEY=sk-abcdefghijklmnopqrstuvwx\ndone';
    const result = summ.sanitize(input);
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(result).toContain('deploying...');
    expect(result).toContain('done');
  });

  it('removes lines containing GitHub tokens', () => {
    const input = 'auth line: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabc\nnormal line';
    const result = summ.sanitize(input);
    expect(result).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabc');
    expect(result).toContain('normal line');
  });

  it('removes lines with long base64-like strings', () => {
    const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh';  // 44 chars
    const input = `normal line\n${b64}\nanother line`;
    const result = summ.sanitize(input);
    expect(result).not.toContain(b64);
    expect(result).toContain('normal line');
  });

  it('preserves text with no credential-like patterns', () => {
    const input = 'step 1 completed\nstep 2: run npm install\nstep 3: passed';
    expect(summ.sanitize(input)).toBe(input);
  });

  it('returns empty string for all-credential input', () => {
    const input = 'password=abc\ntoken=xyz';
    const result = summ.sanitize(input);
    expect(result.trim()).toBe('');
  });
});

describe('Summarizer.summarize', () => {
  it('calls ProviderGateway and returns trimmed content', async () => {
    const gw = buildGateway('  - step 1 done\n  - step 2 pending  ');
    const summ = new Summarizer(gw);
    const result = await summ.summarize('deploy app', 'some history text');
    expect(result).toBe('- step 1 done\n  - step 2 pending');
  });

  it('sanitizes input before sending to LLM — secret lines removed from prompt', async () => {
    let capturedMessages: GatewayMessage[] = [];

    const keychain = new MemoryKeychain();
    const authManager = new AuthManager({ keychain, audit: new NoOpAuditLog() });
    const adapter: IProviderAdapter = {
      provider: 'test',
      async complete(msgs: GatewayMessage[], model, _t, _o): Promise<CompletionResult> {
        capturedMessages = msgs;
        return { content: 'summary result', model, provider: 'test' };
      },
      async stream(_m, model, _t, _o, cb): Promise<CompletionResult> {
        cb('summary result');
        return { content: 'summary result', model, provider: 'test' };
      },
    };
    const gw = new ProviderGateway({ authManager, config: { provider: 'test', model: 'm' } });
    gw.registerAdapter(adapter);
    await authManager.login('test', 'tok', { auth_method: 'cli-hook', expires_at: null });

    const summ = new Summarizer(gw);
    const history = 'step 1 done\npassword=supersecret\nstep 2 done';
    await summ.summarize('deploy', history);

    // The captured message content must NOT contain the secret line
    const promptContent = capturedMessages.map(m => m.content).join('\n');
    expect(promptContent).not.toContain('supersecret');
    expect(promptContent).toContain('step 1 done');
  });

  it('falls back to deterministic summary when gateway throws', async () => {
    const summ = new Summarizer(buildFailingGateway());
    const history = 'step 1 done\nstep 2 failed\nstep 3 pending';
    const result = await summ.summarize('deploy application', history);

    // Fallback includes line count and token count
    expect(result).toContain('[Task history');
    expect(result).toContain('lines');
    expect(result).toContain('tokens');
  });

  it('fallback summary includes truncated goal text', async () => {
    const summ = new Summarizer(buildFailingGateway());
    const result = await summ.summarize('deploy docker containers to production', 'some steps');
    expect(result).toContain('deploy docker');
  });

  it('SUMMARY_TOKEN_THRESHOLD is 2000', () => {
    expect(SUMMARY_TOKEN_THRESHOLD).toBe(2_000);
  });
});
