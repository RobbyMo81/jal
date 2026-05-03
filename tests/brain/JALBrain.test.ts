import * as os from 'os';
import * as path from 'path';
import { JALBrain } from '../../src/apex/brain/JALBrain';

function makeBrain(): JALBrain {
  const dir = path.join(os.tmpdir(), `jal-brain-${Date.now()}`);
  return new JALBrain(dir);
}

describe('JALBrain', () => {
  it('starts with null goal and zero sessions', () => {
    const brain = makeBrain();
    const mem = brain.getMemory();
    expect(mem.active_goal).toBeNull();
    expect(mem.session_count).toBe(0);
  });

  it('setGoal persists across reads', () => {
    const brain = makeBrain();
    brain.setGoal('build a rocket');
    expect(brain.getMemory().active_goal).toBe('build a rocket');
    brain.setGoal(null);
    expect(brain.getMemory().active_goal).toBeNull();
  });

  it('incrementSession accumulates', () => {
    const brain = makeBrain();
    brain.incrementSession();
    brain.incrementSession();
    expect(brain.getMemory().session_count).toBe(2);
  });

  it('recordProvider persists last provider and model', () => {
    const brain = makeBrain();
    brain.recordProvider('jal-chain', 'qwen3:4b');
    const mem = brain.getMemory();
    expect(mem.last_provider).toBe('jal-chain');
    expect(mem.last_model).toBe('qwen3:4b');
  });

  it('setFact stores arbitrary key/value', () => {
    const brain = makeBrain();
    brain.setFact('theme', 'dark');
    expect(brain.getMemory().facts['theme']).toBe('dark');
  });

  it('logReasoning and getReasoningTrace round-trips', () => {
    const brain = makeBrain();
    brain.logReasoning('my goal', ['step 1', 'step 2'], 'completed');
    const trace = brain.getReasoningTrace(10);
    expect(trace).toHaveLength(1);
    expect(trace[0]!.data.goal).toBe('my goal');
    expect(trace[0]!.data.steps).toEqual(['step 1', 'step 2']);
    expect(trace[0]!.data.outcome).toBe('completed');
  });

  it('logProviderEvent and getProviderEvents round-trips', () => {
    const brain = makeBrain();
    brain.logProviderEvent('failure', 'claude', 'claude-sonnet-4-6', 'timeout');
    const events = brain.getProviderEvents(5);
    expect(events).toHaveLength(1);
    expect(events[0]!.data.event).toBe('failure');
    expect(events[0]!.data.provider).toBe('claude');
    expect(events[0]!.data.error).toBe('timeout');
  });
});
