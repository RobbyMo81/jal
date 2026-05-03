// Co-authored by Apex Wakening Build
// tests/guardian_angle/InterventionLogger.test.ts — InterventionLogger unit tests

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { InterventionLogger } from '../../src/apex/guardian_angle/InterventionLogger';
import type { InterventionRecord } from '../../src/apex/guardian_angle/types';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'apex-intervention-test-'));
}

function makeRecord(overrides: Partial<InterventionRecord> = {}): InterventionRecord {
  return {
    id: 'test-id-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    domain: 'reasoning',
    student_model: 'qwen2.5-coder:7b',
    guardian_model: 'deepseek-r1:latest',
    student_draft: 'The answer is 5',
    guardian_feedback: 'Error at word 3: answer should be 4',
    pof_index: 3,
    corrected_output: 'The answer is 4',
    entropy_score: 0.65,
    correction_cycles: 1,
    ...overrides,
  };
}

describe('InterventionLogger', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => rmSync(dir, { recursive: true }));

  it('returns empty array when no records logged', () => {
    const logger = new InterventionLogger(dir);
    expect(logger.query()).toEqual([]);
    expect(logger.count()).toBe(0);
  });

  it('logs and retrieves a single record', () => {
    const logger = new InterventionLogger(dir);
    const record = makeRecord();
    logger.log(record);

    const results = logger.query();
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('test-id-1');
    expect(results[0]?.student_draft).toBe('The answer is 5');
  });

  it('logs multiple records and retrieves them all', () => {
    const logger = new InterventionLogger(dir);
    logger.log(makeRecord({ id: 'r1', timestamp: '2026-01-01T00:00:00.000Z' }));
    logger.log(makeRecord({ id: 'r2', timestamp: '2026-01-02T00:00:00.000Z' }));
    logger.log(makeRecord({ id: 'r3', timestamp: '2026-01-03T00:00:00.000Z' }));

    expect(logger.query()).toHaveLength(3);
    expect(logger.count()).toBe(3);
  });

  it('returns records newest-first', () => {
    const logger = new InterventionLogger(dir);
    logger.log(makeRecord({ id: 'old', timestamp: '2026-01-01T00:00:00.000Z' }));
    logger.log(makeRecord({ id: 'new', timestamp: '2026-01-03T00:00:00.000Z' }));

    const results = logger.query();
    expect(results[0]?.id).toBe('new');
    expect(results[1]?.id).toBe('old');
  });

  it('filters by domain', () => {
    const logger = new InterventionLogger(dir);
    logger.log(makeRecord({ id: 'r1', domain: 'reasoning' }));
    logger.log(makeRecord({ id: 'r2', domain: 'code_generation' }));
    logger.log(makeRecord({ id: 'r3', domain: 'reasoning' }));

    const reasoning = logger.query({ domain: 'reasoning' });
    expect(reasoning).toHaveLength(2);
    expect(reasoning.every(r => r.domain === 'reasoning')).toBe(true);
    expect(logger.count('code_generation')).toBe(1);
  });

  it('respects limit option', () => {
    const logger = new InterventionLogger(dir);
    for (let i = 0; i < 10; i++) {
      logger.log(makeRecord({ id: `r${i}`, timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }));
    }
    const limited = logger.query({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it('filters by since timestamp', () => {
    const logger = new InterventionLogger(dir);
    logger.log(makeRecord({ id: 'old', timestamp: '2026-01-01T00:00:00.000Z' }));
    logger.log(makeRecord({ id: 'new', timestamp: '2026-06-01T00:00:00.000Z' }));

    const recent = logger.query({ since: '2026-03-01T00:00:00.000Z' });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.id).toBe('new');
  });

  it('exposes the file path', () => {
    const logger = new InterventionLogger(dir);
    expect(logger.filePath).toContain('interventions.ndjson');
  });

  it('survives malformed lines in the log file', () => {
    const { appendFileSync } = require('fs') as typeof import('fs');
    const logger = new InterventionLogger(dir);
    logger.log(makeRecord({ id: 'r1' }));
    appendFileSync(logger.filePath, 'not-valid-json\n', 'utf8');
    logger.log(makeRecord({ id: 'r2' }));

    // Should return 2 valid records, silently skip the malformed line
    expect(logger.query()).toHaveLength(2);
  });
});
