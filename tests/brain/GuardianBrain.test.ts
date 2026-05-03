import * as os from 'os';
import * as path from 'path';
import { GuardianBrain } from '../../src/apex/brain/GuardianBrain';

let _brainCounter = 0;
function makeBrain(): GuardianBrain {
  const dir = path.join(os.tmpdir(), `guardian-brain-${Date.now()}-${_brainCounter++}`);
  return new GuardianBrain(dir);
}

describe('GuardianBrain', () => {
  it('starts with null active domain and zero interventions', () => {
    const brain = makeBrain();
    const mem = brain.getMemory();
    expect(mem.active_domain).toBeNull();
    expect(mem.total_interventions).toBe(0);
  });

  it('recordModels persists student and guardian models', () => {
    const brain = makeBrain();
    brain.recordModels('qwen3:4b', 'claude-sonnet-4-6');
    const mem = brain.getMemory();
    expect(mem.last_student_model).toBe('qwen3:4b');
    expect(mem.last_guardian_model).toBe('claude-sonnet-4-6');
  });

  it('setActiveDomain updates working memory', () => {
    const brain = makeBrain();
    brain.setActiveDomain('reasoning');
    expect(brain.getMemory().active_domain).toBe('reasoning');
  });

  it('logVerification with corrected=true increments interventions', () => {
    const brain = makeBrain();
    brain.logVerification('code_generation', 'qwen3:4b', 'claude', 0.7, 1, true);
    expect(brain.getMemory().total_interventions).toBe(1);
  });

  it('logVerification with corrected=false does NOT increment interventions', () => {
    const brain = makeBrain();
    brain.logVerification('reasoning', 'qwen3:4b', 'claude', 0.2, 0, false);
    expect(brain.getMemory().total_interventions).toBe(0);
  });

  it('getVerificationHistory returns entries', () => {
    const brain = makeBrain();
    brain.logVerification('shell_commands', 'q', 'c', 0.5, 1, true);
    brain.logVerification('reasoning', 'q', 'c', 0.3, 0, false);
    const history = brain.getVerificationHistory(10);
    expect(history).toHaveLength(2);
    expect(history[0]!.data.domain).toBe('reasoning'); // newest first
  });

  it('addDomainNote and getDomainKnowledge round-trips', () => {
    const brain = makeBrain();
    brain.addDomainNote('reasoning', 'watch for hallucination on math');
    const dk = brain.getDomainKnowledge();
    expect(dk.domains['reasoning']?.notes).toContain('watch for hallucination on math');
  });

  it('domain notes are capped at 50', () => {
    const brain = makeBrain();
    for (let i = 0; i < 60; i++) brain.addDomainNote('general', `note ${i}`);
    const dk = brain.getDomainKnowledge();
    expect(dk.domains['general']?.notes.length).toBe(50);
  });

  it('logFallbackEvent and getFallbackEvents round-trips', () => {
    const brain = makeBrain();
    brain.logFallbackEvent('link_failed', 'guardian-chain', 'claude', 'claude-sonnet-4-6', 'rate limit');
    const events = brain.getFallbackEvents(5);
    expect(events).toHaveLength(1);
    expect(events[0]!.data.event).toBe('link_failed');
    expect(events[0]!.data.error).toBe('rate limit');
  });
});
