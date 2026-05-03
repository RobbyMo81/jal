import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { BrainStore } from '../../src/apex/brain/BrainStore';
import type { WorkingMemory, BrainTraceEntry } from '../../src/apex/brain/types';

interface TestMemory extends WorkingMemory {
  value: string;
}

const DEFAULT: TestMemory = { updated_at: '', facts: {}, value: 'default' };

function makeTmpBrain(): BrainStore<TestMemory> {
  const dir = path.join(os.tmpdir(), `brain-test-${Date.now()}`);
  return new BrainStore<TestMemory>(dir);
}

describe('BrainStore', () => {
  it('creates directory on construction', () => {
    const dir = path.join(os.tmpdir(), `brain-mkdir-${Date.now()}`);
    new BrainStore<TestMemory>(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('readMemory returns defaults when file absent', () => {
    const store = makeTmpBrain();
    const mem = store.readMemory(DEFAULT);
    expect(mem.value).toBe('default');
  });

  it('round-trips working memory', () => {
    const store = makeTmpBrain();
    const mem: TestMemory = { updated_at: '', facts: { x: 1 }, value: 'hello' };
    store.writeMemory(mem);
    const loaded = store.readMemory(DEFAULT);
    expect(loaded.value).toBe('hello');
    expect(loaded.facts).toEqual({ x: 1 });
    expect(loaded.updated_at).toBeTruthy(); // written by writeMemory
  });

  it('readDoc returns defaults when file absent', () => {
    const store = makeTmpBrain();
    const doc = store.readDoc<{ n: number }>('test.json', { n: 42 });
    expect(doc.n).toBe(42);
  });

  it('round-trips JSON doc', () => {
    const store = makeTmpBrain();
    store.writeDoc('data.json', { foo: 'bar' });
    const loaded = store.readDoc<{ foo: string }>('data.json', { foo: '' });
    expect(loaded.foo).toBe('bar');
  });

  it('appendLog then readLog returns entries newest-first', () => {
    const store = makeTmpBrain();
    const e1: BrainTraceEntry = { id: '1', timestamp: '2026-01-01T00:00:00Z', type: 't', data: { n: 1 } };
    const e2: BrainTraceEntry = { id: '2', timestamp: '2026-01-02T00:00:00Z', type: 't', data: { n: 2 } };
    store.appendLog('trace', e1);
    store.appendLog('trace', e2);
    const log = store.readLog('trace');
    expect(log).toHaveLength(2);
    expect(log[0]!.id).toBe('2'); // newest first
    expect(log[1]!.id).toBe('1');
  });

  it('readLog respects limit', () => {
    const store = makeTmpBrain();
    for (let i = 0; i < 10; i++) {
      store.appendLog('t', { id: `${i}`, timestamp: '', type: 't', data: {} });
    }
    const log = store.readLog('t', 3);
    expect(log).toHaveLength(3);
  });

  it('readLog returns empty array when file absent', () => {
    const store = makeTmpBrain();
    expect(store.readLog('missing')).toEqual([]);
  });
});
