// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// src/apex/policy/TieredFirewall.ts — JAL-003 Full tiered policy firewall
//
// Implements deterministic tier classification for every action before execution:
//
//   Tier 1 (auto-approve):  read-only commands; allowlisted package ops; Docker lifecycle
//   Tier 2 (HITL required): rm/chmod/chown; SSH exec; process kill; non-allowlisted pkgs;
//                            Docker destructive ops (prune/rm/rmi)
//   Tier 3 (blocked):       sudo; user/group manipulation; network config (iptables, ufw, etc.)
//                            Docker --privileged
//
// Every classify() call writes a TierDecision audit entry BEFORE execution proceeds.
// Tier 2 tokens are single-use (ApprovalService enforces this) and expire in 5 minutes.

import { TierDecision, PolicyTier, ApprovalToken } from '../types';
import { IPolicyFirewall } from './PolicyFirewall';
import { ApprovalService } from './ApprovalService';
import { IAuditLog } from './AuditLog';
import { PackageAllowlist } from './PackageAllowlist';

// ── Internal types ─────────────────────────────────────────────────────────────

interface TierResult {
  tier: PolicyTier;
  reason: string;
}

interface ShellRule {
  pattern: RegExp;
  reason: string;
}

// ── Tier 3 shell command patterns (absolute blocks) ───────────────────────────
// Ordered by category. All match on word boundaries to avoid false positives.

const TIER3_SHELL_RULES: ShellRule[] = [
  // sudo elevation
  {
    pattern: /(?:^|\s)sudo(?:\s|$)/,
    reason: 'sudo execution is blocked (Tier 3). Elevation is prohibited by policy.'
  },
  // User account management
  {
    pattern: /(?:^|\s)useradd(?:\s|$)/,
    reason: 'User account creation is blocked (Tier 3). User manipulation is prohibited by policy.'
  },
  {
    pattern: /(?:^|\s)usermod(?:\s|$)/,
    reason: 'User account modification is blocked (Tier 3). User manipulation is prohibited by policy.'
  },
  {
    pattern: /(?:^|\s)userdel(?:\s|$)/,
    reason: 'User account deletion is blocked (Tier 3). User manipulation is prohibited by policy.'
  },
  {
    pattern: /(?:^|\s)groupadd(?:\s|$)/,
    reason: 'Group creation is blocked (Tier 3). Permission manipulation is prohibited by policy.'
  },
  {
    pattern: /(?:^|\s)groupmod(?:\s|$)/,
    reason: 'Group modification is blocked (Tier 3). Permission manipulation is prohibited by policy.'
  },
  {
    pattern: /(?:^|\s)groupdel(?:\s|$)/,
    reason: 'Group deletion is blocked (Tier 3). Permission manipulation is prohibited by policy.'
  },
  {
    pattern: /(?:^|\s)visudo(?:\s|$)/,
    reason: 'Sudoers configuration is blocked (Tier 3). Permission manipulation is prohibited by policy.'
  },
  // Network configuration
  {
    pattern: /(?:^|\s)iptables(?:\s|$)/,
    reason: 'iptables network configuration is blocked (Tier 3). Network config changes are prohibited.'
  },
  {
    pattern: /(?:^|\s)ip6tables(?:\s|$)/,
    reason: 'ip6tables network configuration is blocked (Tier 3). Network config changes are prohibited.'
  },
  {
    pattern: /(?:^|\s)nft(?:\s|$)/,
    reason: 'nftables network configuration is blocked (Tier 3). Network config changes are prohibited.'
  },
  {
    pattern: /(?:^|\s)ufw(?:\s|$)/,
    reason: 'ufw firewall configuration is blocked (Tier 3). Network config changes are prohibited.'
  },
  {
    pattern: /(?:^|\s)firewall-cmd(?:\s|$)/,
    reason: 'firewall-cmd configuration is blocked (Tier 3). Network config changes are prohibited.'
  },
  {
    pattern: /(?:^|\s)netplan(?:\s|$)/,
    reason: 'netplan network configuration is blocked (Tier 3). Network config changes are prohibited.'
  },
  {
    pattern: /(?:^|\s)ifconfig(?:\s|$)/,
    reason: 'ifconfig network configuration is blocked (Tier 3). Network config changes are prohibited.'
  },
  // ip with mutating subcommands (ip route add/del/flush, ip link set, ip addr add/del)
  {
    pattern: /(?:^|\s)ip\s+(?:route\s+(?:add|del|flush)|link\s+set|addr\s+(?:add|del|flush))/,
    reason: 'ip network configuration mutation is blocked (Tier 3). Network config changes are prohibited.'
  },
];

// ── Tier 2 shell command patterns (HITL required) ─────────────────────────────

const TIER2_SHELL_RULES: ShellRule[] = [
  {
    pattern: /(?:^|\s)rm(?:\s|$)/,
    reason: 'rm is a destructive file operation — Tier 2 HITL approval required.'
  },
  {
    pattern: /(?:^|\s)rmdir(?:\s|$)/,
    reason: 'rmdir is a destructive file operation — Tier 2 HITL approval required.'
  },
  {
    pattern: /(?:^|\s)chmod(?:\s|$)/,
    reason: 'chmod changes file permissions — Tier 2 HITL approval required.'
  },
  {
    pattern: /(?:^|\s)chown(?:\s|$)/,
    reason: 'chown changes file ownership — Tier 2 HITL approval required.'
  },
  {
    pattern: /(?:^|\s)ssh(?:\s|$)/,
    reason: 'SSH remote task execution requires Tier 2 HITL approval.'
  },
  {
    pattern: /(?:^|\s)kill(?:\s|$)/,
    reason: 'kill sends signals to processes — Tier 2 HITL approval required.'
  },
  {
    pattern: /(?:^|\s)killall(?:\s|$)/,
    reason: 'killall terminates processes by name — Tier 2 HITL approval required.'
  },
  {
    pattern: /(?:^|\s)pkill(?:\s|$)/,
    reason: 'pkill terminates processes by pattern — Tier 2 HITL approval required.'
  },
];

// ── Tier 2 Docker destructive sub-commands ────────────────────────────────────
// Matched against the sub-command portion of the action, e.g. "prune" from "docker.prune".

const TIER2_DOCKER_SUBCMDS = new Set([
  'prune',
  'rm',
  'rmi',
  'volume rm',
  'network rm',
]);

// ── Package manager install patterns ─────────────────────────────────────────
// Returns { manager, pkg } if command is a package install, null otherwise.

interface PkgInstall {
  manager: string;
  pkg: string;
}

function detectPackageInstall(command: string): PkgInstall | null {
  // npm install <pkg> or npm i <pkg> (skip flags like npm install --save-dev)
  const npmMatch = command.match(/^npm\s+(?:install|i)\s+(?!-)(\S+)/);
  if (npmMatch) return { manager: 'npm', pkg: npmMatch[1] };

  // yarn add <pkg>
  const yarnMatch = command.match(/^yarn\s+add\s+(?!-)(\S+)/);
  if (yarnMatch) return { manager: 'yarn', pkg: yarnMatch[1] };

  // pip install / pip3 install <pkg>
  const pipMatch = command.match(/^pip(?:3)?\s+install\s+(?!-)(\S+)/);
  if (pipMatch) return { manager: 'pip', pkg: pipMatch[1] };

  // apt install / apt-get install <pkg>
  const aptMatch = command.match(/^apt(?:-get)?\s+install\s+(?:-[^\s]+\s+)*(\S+)/);
  if (aptMatch) return { manager: 'apt', pkg: aptMatch[1] };

  return null;
}

// ── TieredFirewall ────────────────────────────────────────────────────────────

const ISO = () => new Date().toISOString();

export class TieredFirewall implements IPolicyFirewall {
  constructor(
    private readonly approvalService: ApprovalService,
    private readonly audit: IAuditLog,
    private readonly allowlist: PackageAllowlist,
    /**
     * Called when a Tier 2 action requires operator approval.
     * The callback receives the pending ApprovalToken; the operator must call
     * approvalService.resolve(token.id, true|false) to unblock execution.
     */
    private readonly onApprovalRequired?: (token: ApprovalToken) => void
  ) {}

  /**
   * Classify an action and enforce tier policy.
   *
   * - Tier 1: writes an audit entry and returns approved=true immediately.
   * - Tier 2: writes a pending audit entry, calls onApprovalRequired, awaits
   *           operator resolution, then writes the final decision and returns.
   * - Tier 3: writes an audit entry and returns approved=false immediately.
   *           There is no bypass path for Tier 3.
   *
   * A TierDecision audit entry is always written BEFORE execution proceeds.
   */
  async classify(action: string, context: Record<string, unknown>): Promise<TierDecision> {
    const { tier, reason } = this.determineTier(action, context);

    if (tier === 3) {
      const decision: TierDecision = {
        tier: 3,
        action,
        reason,
        approved: false,
        decided_at: ISO(),
      };
      this.writeAudit(decision, 'error', 'Tier 3 action blocked by policy — no bypass path exists');
      return decision;
    }

    if (tier === 2) {
      const { token, promise } = this.approvalService.requestApproval(
        action,
        context,
        2,
        reason
      );

      // Write the pending decision to audit BEFORE awaiting operator input.
      const pending: TierDecision = {
        tier: 2,
        action,
        reason,
        approved: false,
        approval_id: token.id,
        decided_at: ISO(),
      };
      this.writeAudit(pending, 'warn', 'Tier 2 approval required — awaiting operator decision');

      // Notify the operator. They must call approvalService.resolve(token.id, ...).
      this.onApprovalRequired?.(token);

      const approved = await promise;

      const final: TierDecision = {
        tier: 2,
        action,
        reason: approved
          ? `Tier 2 approved by operator (token: ${token.id})`
          : `Tier 2 denied/expired (token: ${token.id})`,
        approved,
        approval_id: token.id,
        decided_at: ISO(),
      };
      this.writeAudit(
        final,
        approved ? 'info' : 'warn',
        approved ? 'Tier 2 action approved — proceeding to execution' : 'Tier 2 action denied — execution blocked'
      );
      return final;
    }

    // Tier 1 — auto-approve
    const decision: TierDecision = {
      tier: 1,
      action,
      reason,
      approved: true,
      decided_at: ISO(),
    };
    this.writeAudit(decision, 'info', 'Tier 1 action auto-approved');
    return decision;
  }

  // ── Private: tier determination ─────────────────────────────────────────────

  private determineTier(action: string, context: Record<string, unknown>): TierResult {
    // Docker-namespaced actions
    if (action.startsWith('docker.')) {
      return this.classifyDockerAction(action, context);
    }

    // Shell execution
    if (action === 'shell.exec') {
      const command = String(context['command'] ?? '');
      return this.classifyShellCommand(command);
    }

    // Unknown action type — default to Tier 2 (safer than Tier 1; not as severe as Tier 3)
    return {
      tier: 2,
      reason: `Unrecognised action '${action}' — defaulting to Tier 2 for safety.`,
    };
  }

  private classifyDockerAction(action: string, context: Record<string, unknown>): TierResult {
    // --privileged is Tier 3 regardless of operation
    if (context['privileged'] === true) {
      return {
        tier: 3,
        reason: 'Docker --privileged execution is blocked (Tier 3). Requires explicit operator-approved policy exception.',
      };
    }

    const subCmd = action.slice('docker.'.length);
    if (TIER2_DOCKER_SUBCMDS.has(subCmd)) {
      return {
        tier: 2,
        reason: `${action} is a destructive Docker operation — Tier 2 HITL approval required.`,
      };
    }

    return {
      tier: 1,
      reason: `${action} is a Docker lifecycle/read operation — Tier 1 auto-approved.`,
    };
  }

  private classifyShellCommand(command: string): TierResult {
    // Tier 3 check first — absolute block
    for (const rule of TIER3_SHELL_RULES) {
      if (rule.pattern.test(command)) {
        return { tier: 3, reason: rule.reason };
      }
    }

    // Package install — check allowlist before Tier 2 fallback
    const pkgInstall = detectPackageInstall(command);
    if (pkgInstall) {
      const { manager, pkg } = pkgInstall;
      if (this.allowlist.isAllowed(pkg, manager)) {
        return {
          tier: 1,
          reason: `Package ${manager}/${pkg} is in the approved allowlist — Tier 1 auto-approved.`,
        };
      }
      return {
        tier: 2,
        reason: `Package ${manager}/${pkg} is not in the allowlist at ~/.apex/policy/package-allowlist.json — Tier 2 approval required.`,
      };
    }

    // Tier 2 check
    for (const rule of TIER2_SHELL_RULES) {
      if (rule.pattern.test(command)) {
        return { tier: 2, reason: rule.reason };
      }
    }

    // Default: Tier 1 auto-approve
    return { tier: 1, reason: 'Command classified as Tier 1 (read/non-destructive) — auto-approved.' };
  }

  // ── Private: audit helpers ──────────────────────────────────────────────────

  private writeAudit(
    decision: TierDecision,
    level: 'info' | 'warn' | 'error',
    message: string
  ): void {
    this.audit.write({
      timestamp: ISO(),
      level,
      service: 'TieredFirewall',
      message,
      action: decision.action,
      tier: decision.tier,
      approved: decision.approved,
      reason: decision.reason,
      approval_id: decision.approval_id,
    });
  }
}
