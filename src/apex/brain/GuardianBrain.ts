// src/apex/brain/GuardianBrain.ts — Guardian Angle's persistent sphere of influence
//
// Sphere: ~/.apex/brains/guardian/
//   working_memory.json        — active domain, student/guardian models, intervention count
//   domain_knowledge.json      — per-domain patterns built from intervention history
//   verification_history.ndjson — per-request DVU outcomes
//   fallback_events.ndjson      — chain exhaustion and link failure events

import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { BrainStore } from './BrainStore';
import type {
  GuardianWorkingMemory,
  DomainKnowledge,
  VerificationEntry,
  FallbackEventEntry,
} from './types';

const DEFAULT_MEMORY: GuardianWorkingMemory = {
  updated_at: '',
  facts: {},
  active_domain: null,
  last_student_model: null,
  last_guardian_model: null,
  total_interventions: 0,
};

const DEFAULT_DOMAIN_KNOWLEDGE: DomainKnowledge = {
  updated_at: '',
  domains: {},
};

export class GuardianBrain {
  private readonly store: BrainStore<GuardianWorkingMemory>;

  constructor(brainDir?: string) {
    const dir = brainDir ?? join(homedir(), '.apex', 'brains', 'guardian');
    this.store = new BrainStore<GuardianWorkingMemory>(dir);
  }

  // ── Working memory ─────────────────────────────────────────────────────────

  getMemory(): GuardianWorkingMemory {
    return this.store.readMemory(DEFAULT_MEMORY);
  }

  recordModels(studentModel: string, guardianModel: string): void {
    const mem = this.getMemory();
    mem.last_student_model = studentModel;
    mem.last_guardian_model = guardianModel;
    this.store.writeMemory(mem);
  }

  setActiveDomain(domain: string | null): void {
    const mem = this.getMemory();
    mem.active_domain = domain;
    this.store.writeMemory(mem);
  }

  incrementInterventions(): void {
    const mem = this.getMemory();
    mem.total_interventions += 1;
    this.store.writeMemory(mem);
  }

  // ── Domain knowledge ───────────────────────────────────────────────────────

  getDomainKnowledge(): DomainKnowledge {
    return this.store.readDoc<DomainKnowledge>('domain_knowledge.json', DEFAULT_DOMAIN_KNOWLEDGE);
  }

  addDomainNote(domain: string, note: string): void {
    const dk = this.getDomainKnowledge();
    if (!dk.domains[domain]) {
      dk.domains[domain] = { notes: [], last_updated: '' };
    }
    const d = dk.domains[domain]!;
    d.notes.push(note);
    if (d.notes.length > 50) d.notes = d.notes.slice(-50); // cap per domain
    d.last_updated = new Date().toISOString();
    dk.updated_at = new Date().toISOString();
    this.store.writeDoc('domain_knowledge.json', dk);
  }

  // ── Verification history ───────────────────────────────────────────────────

  logVerification(
    domain: string,
    studentModel: string,
    guardianModel: string,
    entropyScore: number,
    dvuCycles: number,
    corrected: boolean
  ): void {
    const entry: VerificationEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'verification',
      data: {
        domain,
        student_model: studentModel,
        guardian_model: guardianModel,
        entropy_score: entropyScore,
        dvu_cycles: dvuCycles,
        corrected,
      },
    };
    this.store.appendLog('verification_history', entry);
    if (corrected) this.incrementInterventions();
  }

  getVerificationHistory(limit = 100): VerificationEntry[] {
    return this.store.readLog('verification_history', limit) as VerificationEntry[];
  }

  // ── Fallback events ────────────────────────────────────────────────────────

  logFallbackEvent(
    event: 'chain_exhausted' | 'link_failed' | 'link_recovered',
    chain: string,
    linkProvider: string,
    linkModel: string,
    error?: string
  ): void {
    const entry: FallbackEventEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'fallback_event',
      data: {
        event,
        chain,
        link_provider: linkProvider,
        link_model: linkModel,
        error,
      },
    };
    this.store.appendLog('fallback_events', entry);
  }

  getFallbackEvents(limit = 50): FallbackEventEntry[] {
    return this.store.readLog('fallback_events', limit) as FallbackEventEntry[];
  }
}
