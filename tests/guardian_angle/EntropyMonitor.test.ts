// Co-authored by Apex Wakening Build
// tests/guardian_angle/EntropyMonitor.test.ts — EntropyMonitor unit tests

import { EntropyMonitor } from '../../src/apex/guardian_angle/EntropyMonitor';

const monitor = new EntropyMonitor(0.4);

// ── assess() from logprobs ────────────────────────────────────────────────────

describe('EntropyMonitor.assess (logprobs)', () => {
  it('returns low entropy for high-confidence logprobs', () => {
    const logprobs = [
      { token: 'The', logprob: -0.001 },
      { token: ' answer', logprob: -0.002 },
      { token: ' is', logprob: -0.001 },
      { token: ' 4', logprob: -0.001 },
    ];
    const result = monitor.assess('The answer is 4', 'reasoning', logprobs);
    expect(result.is_high_entropy).toBe(false);
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.source).toBe('logprobs');
  });

  it('returns high entropy for low-confidence logprobs', () => {
    const logprobs = [
      { token: 'Maybe', logprob: -2.5 },
      { token: ' it', logprob: -1.8 },
      { token: ' could', logprob: -2.1 },
      { token: ' be', logprob: -1.9 },
    ];
    const result = monitor.assess('Maybe it could be', 'general', logprobs);
    expect(result.is_high_entropy).toBe(true);
    expect(result.entropy).toBeGreaterThanOrEqual(0.4);
    expect(result.source).toBe('logprobs');
  });

  it('normalizes entropy to [0, 1]', () => {
    const logprobs = [{ token: 'x', logprob: -10 }]; // very low confidence
    const result = monitor.assess('x', 'general', logprobs);
    expect(result.entropy).toBeGreaterThanOrEqual(0);
    expect(result.entropy).toBeLessThanOrEqual(1);
  });
});

// ── assess() from text heuristic ─────────────────────────────────────────────

describe('EntropyMonitor.assess (text fallback)', () => {
  it('returns low entropy for confident text', () => {
    const result = monitor.assess(
      'The capital of France is Paris. The Eiffel Tower is in Paris.',
      'reasoning'
    );
    expect(result.is_high_entropy).toBe(false);
    expect(result.source).toBe('text_heuristic');
  });

  it('returns high entropy for text full of uncertainty markers', () => {
    const result = monitor.assess(
      'Perhaps it might be possible that maybe it could be Paris, I think, but I\'m not sure.',
      'reasoning'
    );
    expect(result.is_high_entropy).toBe(true);
    expect(result.source).toBe('text_heuristic');
  });

  it('handles empty text gracefully', () => {
    const result = monitor.assess('', 'general');
    expect(result.entropy).toBe(0);
    expect(result.is_high_entropy).toBe(false);
  });
});

// ── detectDomain() ────────────────────────────────────────────────────────────

describe('EntropyMonitor.detectDomain', () => {
  it('detects shell_commands from bash keywords', () => {
    const domain = monitor.detectDomain([
      { role: 'user', content: 'How do I use grep to find files?' },
    ]);
    expect(domain).toBe('shell_commands');
  });

  it('detects system_admin from docker keywords', () => {
    const domain = monitor.detectDomain([
      { role: 'user', content: 'How do I start a docker container?' },
    ]);
    expect(domain).toBe('system_admin');
  });

  it('detects code_generation from code blocks', () => {
    const domain = monitor.detectDomain([
      { role: 'user', content: 'Write a function to add two numbers:\n```ts\nfunction add' },
    ]);
    expect(domain).toBe('code_generation');
  });

  it('detects reasoning from math keywords', () => {
    const domain = monitor.detectDomain([
      { role: 'user', content: 'Solve the equation x^2 + 2x = 0' },
    ]);
    expect(domain).toBe('reasoning');
  });

  it('falls back to general for unclassified content', () => {
    const domain = monitor.detectDomain([
      { role: 'user', content: 'Tell me a joke.' },
    ]);
    expect(domain).toBe('general');
  });

  it('respects priority order (system_admin before shell_commands for docker)', () => {
    const domain = monitor.detectDomain([
      { role: 'user', content: 'docker exec bash' },
    ]);
    expect(domain).toBe('system_admin');
  });
});

// ── custom threshold ──────────────────────────────────────────────────────────

describe('EntropyMonitor threshold', () => {
  it('respects custom threshold in constructor', () => {
    const strictMonitor = new EntropyMonitor(0.01); // tiny threshold — any uncertainty triggers it
    // "might" is an uncertainty marker, so entropy > 0 > 0.01 threshold
    const result = strictMonitor.assess('This might be the answer.', 'general');
    expect(result.is_high_entropy).toBe(true);
  });

  it('threshold=1 never triggers guardian', () => {
    const neverMonitor = new EntropyMonitor(1.0);
    const logprobs = [{ token: 'x', logprob: -5 }];
    const result = neverMonitor.assess('x', 'general', logprobs);
    expect(result.is_high_entropy).toBe(false);
  });
});
