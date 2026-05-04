// Co-authored by Apex Wakening Build
// tests/guardian_angle/DVUProtocol.test.ts — DVUProtocol unit tests
//
// execute() receives the initial draft as a parameter — no fetch needed for the draft.
// Guardian verify() calls fetch; student correction calls fetch.

import { DVUProtocol } from '../../src/apex/guardian_angle/DVUProtocol';
import { OllamaAdapter } from '../../src/apex/auth/OllamaAdapter';
import type { EntropyAssessment } from '../../src/apex/guardian_angle/types';
import type { OllamaExtendedResult } from '../../src/apex/auth/OllamaAdapter';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAdapter(): OllamaAdapter {
  return new OllamaAdapter({ baseUrl: 'http://localhost:11434' });
}

function makeEntropy(overrides: Partial<EntropyAssessment> = {}): EntropyAssessment {
  return {
    entropy: 0.6,
    confidence: 0.4,
    is_high_entropy: true,
    source: 'logprobs',
    domain: 'reasoning',
    ...overrides,
  };
}

function makeDraft(content: string): OllamaExtendedResult {
  return {
    content,
    model: 'qwen2.5-coder:7b',
    provider: 'ollama',
    usage: { input_tokens: 10, output_tokens: content.split(' ').length },
  };
}

function mockGuardianResponse(guardian: OllamaAdapter, responseJson: string): jest.SpyInstance {
  return jest.spyOn(guardian, 'completeWithLogprobs').mockResolvedValueOnce({
    content: responseJson,
    model: 'deepseek-r1',
    provider: 'ollama',
    usage: { input_tokens: 20, output_tokens: 8 },
  });
}

function mockStudentCorrection(student: OllamaAdapter, content: string): jest.SpyInstance {
  return jest.spyOn(student, 'completeWithLogprobs').mockResolvedValueOnce(makeDraft(content));
}

const MESSAGES = [{ role: 'user' as const, content: 'What is 2+2?' }];

// ── verify() ──────────────────────────────────────────────────────────────────

describe('DVUProtocol.verify', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns pof=null when guardian approves the draft', async () => {
    const guardian = makeAdapter();
    mockGuardianResponse(guardian, '{"pof":null,"reason":"correct","domain":"reasoning"}');

    const protocol = new DVUProtocol(guardian, 'deepseek-r1');
    const pof = await protocol.verify(MESSAGES, 'The answer is 4', 'reasoning');

    expect(pof.index).toBeNull();
    expect(pof.reason).toBe('correct');
  });

  it('returns pof index when guardian finds an error', async () => {
    const guardian = makeAdapter();
    mockGuardianResponse(guardian, '{"pof":3,"reason":"wrong number","domain":"reasoning"}');

    const protocol = new DVUProtocol(guardian, 'deepseek-r1');
    const pof = await protocol.verify(MESSAGES, 'The answer is 5', 'reasoning');

    expect(pof.index).toBe(3);
    expect(pof.reason).toBe('wrong number');
  });

  it('returns parseError=true on unparseable guardian response', async () => {
    const guardian = makeAdapter();
    mockGuardianResponse(guardian, 'I cannot determine if this is correct.');

    const protocol = new DVUProtocol(guardian, 'deepseek-r1');
    const pof = await protocol.verify(MESSAGES, 'some response', 'general');

    expect(pof.index).toBeNull();
    expect(pof.parseError).toBe(true);
  });

  it('extracts JSON when reason text contains a closing brace', async () => {
    const guardian = makeAdapter();
    mockGuardianResponse(
      guardian,
      '{"pof":2,"reason":"refers to set {a} which is undefined","domain":"code_generation"}'
    );

    const protocol = new DVUProtocol(guardian, 'deepseek-r1');
    const pof = await protocol.verify(MESSAGES, 'some code', 'code_generation');

    expect(pof.index).toBe(2);
    expect(pof.reason).toBe('refers to set {a} which is undefined');
    expect(pof.parseError).toBeUndefined();
  });

  it('strips markdown code fences before parsing', async () => {
    const guardian = makeAdapter();
    mockGuardianResponse(
      guardian,
      '```json\n{"pof":1,"reason":"wrong","domain":"reasoning"}\n```'
    );

    const protocol = new DVUProtocol(guardian, 'deepseek-r1');
    const pof = await protocol.verify(MESSAGES, 'some response', 'reasoning');

    expect(pof.index).toBe(1);
    expect(pof.parseError).toBeUndefined();
  });

  it('handles truncated JSON as a parse error', async () => {
    const guardian = makeAdapter();
    // Simulates Gemini being cut off at max_tokens mid-object
    mockGuardianResponse(guardian, '{"pof":0,"reason":"The answer is wro');

    const protocol = new DVUProtocol(guardian, 'deepseek-r1');
    const pof = await protocol.verify(MESSAGES, 'some response', 'reasoning');

    expect(pof.index).toBeNull();
    expect(pof.parseError).toBe(true);
  });

  it('uses low temperature for deterministic auditing', async () => {
    const guardian = makeAdapter();
    const spy = mockGuardianResponse(guardian, '{"pof":null,"reason":"correct","domain":"general"}');

    const protocol = new DVUProtocol(guardian, 'deepseek-r1');
    await protocol.verify(MESSAGES, 'fine', 'general');

    const callOpts = (spy.mock.calls[0] as [unknown, unknown, CompletionOptions])[2];
    expect(callOpts?.temperature).toBe(0.1);
  });
});

// ── execute() ─────────────────────────────────────────────────────────────────

describe('DVUProtocol.execute', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns initial draft approved with 0 cycles when guardian finds no error', async () => {
    const student = makeAdapter();
    const guardian = makeAdapter();
    mockGuardianResponse(guardian, '{"pof":null,"reason":"correct","domain":"reasoning"}');

    const protocol = new DVUProtocol(guardian, 'deepseek-r1');
    const result = await protocol.execute(
      MESSAGES, student, 'qwen2.5-coder:7b', makeEntropy(), makeDraft('The answer is 4')
    );

    expect(result.content).toBe('The answer is 4');
    expect(result.dvu_cycles).toBe(0);
    expect(result.guardian_invoked).toBe(true);
    expect(result.pof?.index).toBeNull();
  });

  it('runs one correction cycle when guardian finds an error then approves', async () => {
    const student = makeAdapter();
    const guardian = makeAdapter();

    // First verify: error
    mockGuardianResponse(guardian, '{"pof":3,"reason":"wrong number, should be 4","domain":"reasoning"}');
    // Student correction
    mockStudentCorrection(student, 'The answer is 4');
    // Second verify: approved
    mockGuardianResponse(guardian, '{"pof":null,"reason":"correct","domain":"reasoning"}');

    const protocol = new DVUProtocol(guardian, 'deepseek-r1');
    const result = await protocol.execute(
      MESSAGES, student, 'qwen2.5-coder:7b', makeEntropy(),
      makeDraft('The answer is 5'), { maxCycles: 2 }
    );

    expect(result.content).toBe('The answer is 4');
    expect(result.dvu_cycles).toBe(1);
    expect(result.pof?.index).toBeNull(); // last pof is the approval
  });

  it('respects maxCycles=1: one verify, one correction if needed, stops', async () => {
    const student = makeAdapter();
    const guardian = makeAdapter();

    mockGuardianResponse(guardian, '{"pof":0,"reason":"wrong","domain":"general"}');
    mockStudentCorrection(student, 'corrected answer');

    const protocol = new DVUProtocol(guardian, 'deepseek-r1');
    const result = await protocol.execute(
      MESSAGES, student, 'model', makeEntropy({ domain: 'general' }),
      makeDraft('wrong answer'), { maxCycles: 1 }
    );

    // With maxCycles=1: one verify (error found), one correction, done
    expect(result.dvu_cycles).toBe(1);
    expect(result.content).toBe('corrected answer');
    // Only 1 guardian verify call + 1 student call
    const guardianCalls = (jest.spyOn(guardian, 'completeWithLogprobs') as jest.Mock).mock.calls.length;
    expect(guardianCalls).toBeLessThanOrEqual(1);
  });

  it('does not treat parse error as Guardian approval — exhausts cycles without breaking', async () => {
    const student = makeAdapter();
    const guardian = makeAdapter();

    // Both verification calls return garbage (simulates Gemini truncation)
    mockGuardianResponse(guardian, 'ERROR: context window exceeded');
    mockGuardianResponse(guardian, '{"pof":0,"reason":"truncated at max_to');

    const protocol = new DVUProtocol(guardian, 'deepseek-r1');
    const result = await protocol.execute(
      MESSAGES, student, 'qwen2.5-coder:7b', makeEntropy(),
      makeDraft('The answer is 5'), { maxCycles: 2 }
    );

    // No DVU cycles — parse errors are inconclusive, not approval
    expect(result.dvu_cycles).toBe(0);
    // Draft is unchanged — no correction triggered
    expect(result.content).toBe('The answer is 5');
    // Parse error flag propagated to result
    expect(result.pof?.parseError).toBe(true);
  });

  it('returns provider=guardian in result', async () => {
    const student = makeAdapter();
    const guardian = makeAdapter();
    mockGuardianResponse(guardian, '{"pof":null,"reason":"correct","domain":"general"}');

    const protocol = new DVUProtocol(guardian, 'deepseek-r1');
    const result = await protocol.execute(
      MESSAGES, student, 'model', makeEntropy({ domain: 'general' }), makeDraft('ok')
    );

    expect(result.provider).toBe('guardian');
    expect(result.domain).toBe('general');
    expect(result.entropy_score).toBe(0.6);
  });
});

// ── type import (avoid unused import error) ───────────────────────────────────
import type { CompletionOptions } from '../../src/apex/types';
