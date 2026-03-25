// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// src/apex/policy/PolicyFirewall.ts — JAL-002 Policy firewall interface and Docker stub
//
// IPolicyFirewall is the contract. JAL-003 will provide a full implementation.
// DockerStubFirewall enforces only the Docker-specific safety gates documented
// in JAL-002 acceptance criteria — it does NOT implement full tier logic.

import { TierDecision } from '../types';

// ── Interface ──────────────────────────────────────────────────────────────────

export interface IPolicyFirewall {
  /**
   * Classify an action and return a tier decision.
   * The decision is synchronous (or promise-based) and must be awaited before
   * any execution proceeds.
   *
   * @param action   Dot-namespaced action string, e.g. "docker.list", "docker.rm"
   * @param context  Additional context about the request (args, privileged, etc.)
   */
  classify(action: string, context: Record<string, unknown>): Promise<TierDecision>;
}

// ── Docker safety gate stub (pre-JAL-003) ─────────────────────────────────────

const DESTRUCTIVE_DOCKER_CMDS = new Set(['prune', 'rm', 'rmi', 'volume rm', 'network rm']);
const ISO = () => new Date().toISOString();

/**
 * Minimal policy stub for Docker operations.
 * Enforces only the two safety gates required by JAL-002:
 *   1. --privileged mode is blocked (Tier 3).
 *   2. docker prune/rm variants are Tier 2 (destructive, require approval).
 * All other Docker operations are auto-approved as Tier 1.
 *
 * JAL-003 will replace this with a full policy engine. DockerEngine accepts
 * IPolicyFirewall so the real firewall drops in without code changes.
 */
export class DockerStubFirewall implements IPolicyFirewall {
  async classify(action: string, context: Record<string, unknown>): Promise<TierDecision> {
    const isPrivileged = context['privileged'] === true;
    const subCmd = (action.replace(/^docker\./, ''));

    if (isPrivileged) {
      return {
        tier: 3,
        action,
        reason: 'Privileged Docker execution is blocked by default. Requires explicit policy exception.',
        approved: false,
        decided_at: ISO(),
      };
    }

    if (DESTRUCTIVE_DOCKER_CMDS.has(subCmd)) {
      return {
        tier: 2,
        action,
        reason: `${action} is a destructive Docker operation requiring Tier 2 (HITL) approval.`,
        approved: false,
        decided_at: ISO(),
      };
    }

    // All other Docker operations are Tier 1 (auto-approved read/lifecycle ops)
    return {
      tier: 1,
      action,
      reason: 'Docker lifecycle operation — Tier 1 auto-approved.',
      approved: true,
      decided_at: ISO(),
    };
  }
}
