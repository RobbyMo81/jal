// Co-authored by Apex Wakening Build
// tests/guardian_angle/GuardianAngle.test.ts — GuardianAngle integration tests
//
// Mocks global fetch so no Ollama server is needed.
// Flow per complete() call:
//   1 fetch  → student draft
//   1 fetch  → guardian verify (only when entropy is high AND domain not sleeping)
//   1 fetch  → student correction (only when guardian finds PoF)
//   1 fetch  → guardian verify again (only when maxCycles > 1)

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'apex-guardian-test-'));
}

// ── Fetch mock helpers ────────────────────────────────────────────────────────

type FetchResp = { content: string; model?: string; logprobs?: Array<{ token: string; logprob: number }> };

function enqueue(resp: FetchResp): void {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      model: resp.model ?? 'test-model',
      message: { role: 'assistant', content: resp.content },
      done: true,
      prompt_eval_count: 5,
      eval_count: resp.content.split(' ').length,
      logprobs: resp.logprobs,
    }),
  } as unknown as Response);
}

// High-entropy logprobs (confidence ~0.08, well above 0.4 entropy threshold)
const HIGH_ENTROPY_LOGPROBS = Array(4).fill({ token: 'x', logprob: -2.5 });
// Low-entropy logprobs (confidence ~0.999, well below 0.4 entropy threshold)
const LOW_ENTROPY_LOGPROBS = Array(4).fill({ token: 'x', logprob: -0.001 });

const MESSAGES = [{ role: 'user' as const, content: 'What is 2+2?' }];

// ── Sleep Mode bypass ─────────────────────────────────────────────────────────

describe('GuardianAngle sleep mode bypass', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true }); jest.restoreAllMocks(); });

  it('skips guardian entirely when domain is sleeping', async () => {
    const { GuardianAngle } = await import('../../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({
      studentModel: 'student', guardianModel: 'guardian',
      stateDir: dir, sleepModeThreshold: 0.5, sleepModeWindow: 2,
    });

    // Force sleep mode
    const tracker = (ga as unknown as { sleepTracker: { record: (d: string, c: boolean) => void } }).sleepTracker;
    tracker.record('general', true);
    tracker.record('general', true);

    enqueue({ content: 'The answer is 4', logprobs: LOW_ENTROPY_LOGPROBS });

    const result = await ga.complete(MESSAGES, 'ignored', 'ignored', {});

    expect(result.content).toBe('The answer is 4');
    // Only 1 fetch call — student only, no guardian
    expect((fetch as jest.Mock).mock.calls.length).toBe(1);
  });
});

// ── Low entropy bypass ────────────────────────────────────────────────────────

describe('GuardianAngle low entropy bypass', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true }); jest.restoreAllMocks(); });

  it('skips guardian when student draft has high-confidence logprobs', async () => {
    const { GuardianAngle } = await import('../../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({
      studentModel: 'student', guardianModel: 'guardian',
      stateDir: dir, entropyThreshold: 0.4,
    });

    enqueue({ content: 'The answer is 4', logprobs: LOW_ENTROPY_LOGPROBS });

    await ga.complete(MESSAGES, 'ignored', 'ignored', {});

    // 1 fetch: student draft only (entropy < threshold → no guardian)
    expect((fetch as jest.Mock).mock.calls.length).toBe(1);
  });
});

// ── DVU correction ────────────────────────────────────────────────────────────

describe('GuardianAngle DVU correction', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true }); jest.restoreAllMocks(); });

  it('invokes guardian and corrects draft when entropy is high', async () => {
    const { GuardianAngle } = await import('../../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({
      studentModel: 'student', guardianModel: 'guardian',
      stateDir: dir, entropyThreshold: 0.4, maxDVUCycles: 1,
    });

    // 1. Student draft: high entropy
    enqueue({ content: 'The answer is 5', logprobs: HIGH_ENTROPY_LOGPROBS });
    // 2. Guardian verify: finds error (maxCycles=1 → one verify, one correction)
    enqueue({ content: '{"pof":3,"reason":"should be 4","domain":"reasoning"}' });
    // 3. Student correction
    enqueue({ content: 'The answer is 4', logprobs: LOW_ENTROPY_LOGPROBS });

    const result = await ga.complete(MESSAGES, 'ignored', 'ignored', {});

    expect(result.content).toBe('The answer is 4');
    // 3 total fetch calls: student draft + guardian verify + student correction
    expect((fetch as jest.Mock).mock.calls.length).toBe(3);
  });

  it('accepts draft when guardian returns null pof', async () => {
    const { GuardianAngle } = await import('../../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({
      studentModel: 'student', guardianModel: 'guardian',
      stateDir: dir, entropyThreshold: 0.4,
    });

    enqueue({ content: 'The answer is 4', logprobs: HIGH_ENTROPY_LOGPROBS });
    enqueue({ content: '{"pof":null,"reason":"correct","domain":"reasoning"}' });

    const result = await ga.complete(MESSAGES, 'ignored', 'ignored', {});

    expect(result.content).toBe('The answer is 4');
    expect((fetch as jest.Mock).mock.calls.length).toBe(2); // draft + verify
  });

  it('logs intervention when a correction is made', async () => {
    const { GuardianAngle } = await import('../../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({
      studentModel: 'student', guardianModel: 'guardian',
      stateDir: dir, entropyThreshold: 0.4, maxDVUCycles: 1,
    });

    enqueue({ content: 'The answer is 5', logprobs: HIGH_ENTROPY_LOGPROBS });
    enqueue({ content: '{"pof":3,"reason":"wrong number","domain":"reasoning"}' });
    enqueue({ content: 'The answer is 4', logprobs: LOW_ENTROPY_LOGPROBS });

    await ga.complete(MESSAGES, 'ignored', 'ignored', {});

    const interventions = ga.getInterventionLogger().query();
    expect(interventions.length).toBeGreaterThan(0);
    expect(interventions[0]?.student_draft).toBe('The answer is 5');
    expect(interventions[0]?.corrected_output).toBe('The answer is 4');
    expect(interventions[0]?.pof_index).toBe(3);
  });

  it('does not log intervention when guardian approves without correction', async () => {
    const { GuardianAngle } = await import('../../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({
      studentModel: 'student', guardianModel: 'guardian',
      stateDir: dir, entropyThreshold: 0.4,
    });

    enqueue({ content: 'The answer is 4', logprobs: HIGH_ENTROPY_LOGPROBS });
    enqueue({ content: '{"pof":null,"reason":"correct","domain":"reasoning"}' });

    await ga.complete(MESSAGES, 'ignored', 'ignored', {});

    expect(ga.getInterventionLogger().query()).toHaveLength(0);
  });
});

// ── Parse error isolation ─────────────────────────────────────────────────────

describe('GuardianAngle parse error isolation', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true }); jest.restoreAllMocks(); });

  it('does not record parse errors as correct in the sleep tracker', async () => {
    const { GuardianAngle } = await import('../../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({
      studentModel: 'student', guardianModel: 'guardian',
      stateDir: dir, entropyThreshold: 0.4,
      sleepModeThreshold: 0.5, sleepModeWindow: 2,
    });

    // Two requests: student has high entropy, guardian returns garbage both times
    for (let i = 0; i < 2; i++) {
      enqueue({ content: 'The answer is 5', logprobs: HIGH_ENTROPY_LOGPROBS });
      enqueue({ content: 'not valid json at all' });
      enqueue({ content: 'also invalid json' });
    }

    await ga.complete(MESSAGES, 'ignored', 'ignored', {});
    await ga.complete(MESSAGES, 'ignored', 'ignored', {});

    // "What is 2+2?" maps to the 'general' domain via detectDomain.
    // It must NOT be sleeping — parse errors are inconclusive, not successes.
    const stats = ga.getSleepStats();
    expect(stats['general']?.in_sleep_mode).toBe(false);
  });
});

// ── forcedVerifyDomains ───────────────────────────────────────────────────────

describe('GuardianAngle forcedVerifyDomains', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true }); jest.restoreAllMocks(); });

  it('invokes Guardian on a forced domain even when entropy is low', async () => {
    const { GuardianAngle } = await import('../../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({
      studentModel: 'student', guardianModel: 'guardian',
      stateDir: dir, entropyThreshold: 0.4,
      forcedVerifyDomains: ['general'],  // force-verify the domain for "What is 2+2?"
    });

    // Student response with LOW entropy — would normally bypass Guardian
    enqueue({ content: 'The answer is 4', logprobs: LOW_ENTROPY_LOGPROBS });
    // Guardian verify: approves
    enqueue({ content: '{"pof":null,"reason":"correct","domain":"general"}' });

    await ga.complete(MESSAGES, 'ignored', 'ignored', {});

    // Guardian was forced to run even though entropy was low — 2 fetch calls total
    expect((fetch as jest.Mock).mock.calls.length).toBe(2);
  });

  it('does not invoke Guardian on a non-forced domain with low entropy', async () => {
    const { GuardianAngle } = await import('../../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({
      studentModel: 'student', guardianModel: 'guardian',
      stateDir: dir, entropyThreshold: 0.4,
      forcedVerifyDomains: [],  // no forced domains
    });

    enqueue({ content: 'The answer is 4', logprobs: LOW_ENTROPY_LOGPROBS });

    await ga.complete(MESSAGES, 'ignored', 'ignored', {});

    // Guardian skipped — only 1 fetch call (student draft only)
    expect((fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  it('default forced domains include shell_commands', async () => {
    const { GuardianAngle } = await import('../../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({
      studentModel: 'student', guardianModel: 'guardian',
      stateDir: dir, entropyThreshold: 0.4,
      // forcedVerifyDomains not set → defaults to ['shell_commands', 'code_generation']
    });

    // Message that triggers shell_commands domain detection (must contain one of: bash|grep|awk|...)
    const shellMsg = [{ role: 'user' as const, content: 'Use find and grep to search log files' }];
    enqueue({ content: 'find /var/log -name "*.log" | grep ERROR', logprobs: LOW_ENTROPY_LOGPROBS });
    enqueue({ content: '{"pof":null,"reason":"correct","domain":"shell_commands"}' });

    await ga.complete(shellMsg, 'ignored', 'ignored', {});

    // Guardian must have run (2 calls) even though entropy was low
    expect((fetch as jest.Mock).mock.calls.length).toBe(2);
  });
});

// ── Sleep tracker — no false signal from low-entropy bypasses ─────────────────

describe('GuardianAngle sleep tracker accuracy', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true }); jest.restoreAllMocks(); });

  it('does not record low-entropy bypasses as correct in the sleep tracker', async () => {
    const { GuardianAngle } = await import('../../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({
      studentModel: 'student', guardianModel: 'guardian',
      stateDir: dir, entropyThreshold: 0.4,
      forcedVerifyDomains: [],  // no forced domains — everything bypasses on low entropy
      sleepModeThreshold: 0.5, sleepModeWindow: 2,
    });

    // Two low-entropy responses — used to incorrectly push domain toward sleep
    enqueue({ content: 'The answer is 4', logprobs: LOW_ENTROPY_LOGPROBS });
    enqueue({ content: 'The answer is 4', logprobs: LOW_ENTROPY_LOGPROBS });

    await ga.complete(MESSAGES, 'ignored', 'ignored', {});
    await ga.complete(MESSAGES, 'ignored', 'ignored', {});

    // Domain must NOT appear in sleep stats at all — no Guardian verdicts recorded
    const stats = ga.getSleepStats();
    expect(stats['general']).toBeUndefined();
  });
});

// ── getSleepStats ─────────────────────────────────────────────────────────────

describe('GuardianAngle.getSleepStats', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true }); jest.restoreAllMocks(); });

  it('returns sleep stats object', async () => {
    const { GuardianAngle } = await import('../../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({ studentModel: 'a', guardianModel: 'b', stateDir: dir });
    const stats = ga.getSleepStats();
    expect(typeof stats).toBe('object');
  });
});
