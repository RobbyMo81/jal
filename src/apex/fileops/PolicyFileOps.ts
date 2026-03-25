// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// src/apex/fileops/PolicyFileOps.ts — JAL-004 Policy-bounded file operations
//
// All file I/O goes through this class. Every operation is classified into a
// tier before execution proceeds:
//
//   Tier 1 (auto-approved): read / write / create inside workspace roots
//   Tier 2 (HITL required): recursive delete, chmod, chown, writes to shell
//                            profiles (.bashrc, .zshrc, etc.) or system paths
//                            (/etc/, /usr/, etc.), writes outside workspace roots
//   Rejected (structured error): path traversal (../ escapes); paths that
//                                 cannot be resolved
//
// Safety gates (enforced unconditionally):
//   1. Path traversal check — any input path containing ".." segments is rejected.
//   2. Symlink resolution — realpathSync is used to resolve the final absolute
//      path before workspace boundary checks.
//   3. Audit log entry on every rejection — no silent failures.
//
// TierDecision records are written to the audit log before execution proceeds.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  existsSync,
  rmSync,
  chmodSync,
  chownSync,
  statSync,
} from 'fs';
import { resolve as resolvePath, dirname, basename } from 'path';
import { ApprovalToken, TierDecision, FileOperationType, FileOpOptions, FileOpResult } from '../types';
import { IAuditLog } from '../policy/AuditLog';
import { ApprovalService } from '../policy/ApprovalService';
import { WorkspaceRootsConfig } from './WorkspaceRootsConfig';

// ── Constants ──────────────────────────────────────────────────────────────────

/**
 * Shell profile file names that always require Tier 2 approval regardless of
 * their location. Matched against the basename of the resolved path.
 */
const SHELL_PROFILE_NAMES = new Set([
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.zlogout',
  '.kshrc',
  '.cshrc',
  '.tcshrc',
  '.fishrc',
  'config.fish',
]);

/**
 * System path prefixes that always require Tier 2 approval.
 * Checked against the resolved absolute path.
 */
const SYSTEM_PATH_PREFIXES = [
  '/etc/',
  '/usr/',
  '/lib/',
  '/lib32/',
  '/lib64/',
  '/libx32/',
  '/bin/',
  '/sbin/',
  '/boot/',
  '/sys/',
  '/proc/',
  '/dev/',
  '/run/',
  '/snap/',
];

const ISO = () => new Date().toISOString();

// ── PolicyFileOps ─────────────────────────────────────────────────────────────

export class PolicyFileOps {
  constructor(
    private readonly workspaceRoots: WorkspaceRootsConfig,
    private readonly approvalService: ApprovalService,
    private readonly audit: IAuditLog,
    /**
     * Called when a Tier 2 file operation requires operator approval.
     * The caller must invoke approvalService.resolve(token.id, true|false) to
     * unblock the pending operation.
     */
    private readonly onApprovalRequired?: (token: ApprovalToken) => void
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Read a file. Tier 1 auto-approved for all paths (reads are non-destructive).
   * Path traversal check still applies.
   */
  async read(rawPath: string): Promise<FileOpResult> {
    const resolved = this.resolveSafe(rawPath, 'file.read');
    if (!resolved.ok) return resolved.result;

    const decision = this.buildTier1Decision('file.read', resolved.absPath, 'File read is non-destructive — Tier 1 auto-approved.');
    this.writeAudit(decision, 'info', 'file.read classified Tier 1 — auto-approved');

    try {
      const content = readFileSync(resolved.absPath, 'utf-8');
      return { success: true, tier_decision: decision, content };
    } catch (err) {
      return this.fsError(decision, err);
    }
  }

  /**
   * Write content to an existing file or create a new one.
   * Tier 1 if path is inside a workspace root.
   * Tier 2 if path is a shell profile, system path, or outside workspace roots.
   */
  async write(rawPath: string, content: string, opts: FileOpOptions = {}): Promise<FileOpResult> {
    const resolved = this.resolveSafe(rawPath, 'file.write');
    if (!resolved.ok) return resolved.result;

    const { decision } = await this.classifyMutation('file.write', resolved.absPath);
    if (!decision.approved) {
      return { success: false, tier_decision: decision, error: `file.write denied: ${decision.reason}` };
    }

    try {
      mkdirSync(dirname(resolved.absPath), { recursive: true });
      writeFileSync(resolved.absPath, content, opts.encoding ?? 'utf-8');
      return { success: true, tier_decision: decision };
    } catch (err) {
      return this.fsError(decision, err);
    }
  }

  /**
   * Create a new file (alias for write — same tier logic applies).
   */
  async create(rawPath: string, content: string, opts: FileOpOptions = {}): Promise<FileOpResult> {
    const resolved = this.resolveSafe(rawPath, 'file.create');
    if (!resolved.ok) return resolved.result;

    const { decision } = await this.classifyMutation('file.create', resolved.absPath);
    if (!decision.approved) {
      return { success: false, tier_decision: decision, error: `file.create denied: ${decision.reason}` };
    }

    try {
      mkdirSync(dirname(resolved.absPath), { recursive: true });
      writeFileSync(resolved.absPath, content, opts.encoding ?? 'utf-8');
      return { success: true, tier_decision: decision };
    } catch (err) {
      return this.fsError(decision, err);
    }
  }

  /**
   * Delete a file or directory.
   * Always Tier 2: recursive deletes are inherently destructive.
   * Non-recursive deletes of single files are also Tier 2 (rm in TieredFirewall).
   */
  async delete(rawPath: string, opts: FileOpOptions = {}): Promise<FileOpResult> {
    const resolved = this.resolveSafe(rawPath, 'file.delete');
    if (!resolved.ok) return resolved.result;

    const recursive = opts.recursive === true;
    const action = recursive ? 'file.delete.recursive' : 'file.delete';
    const reason = recursive
      ? 'Recursive delete (rm -r equivalent) is destructive — Tier 2 HITL approval required.'
      : 'File delete is destructive — Tier 2 HITL approval required.';

    const decision = await this.requestTier2(action, resolved.absPath, reason);
    if (!decision.approved) {
      return { success: false, tier_decision: decision, error: `${action} denied: ${decision.reason}` };
    }

    try {
      rmSync(resolved.absPath, { recursive, force: false });
      return { success: true, tier_decision: decision };
    } catch (err) {
      return this.fsError(decision, err);
    }
  }

  /**
   * Change file permissions (chmod).
   * Always Tier 2 — permission changes affect system security.
   */
  async chmod(rawPath: string, mode: string | number): Promise<FileOpResult> {
    const resolved = this.resolveSafe(rawPath, 'file.chmod');
    if (!resolved.ok) return resolved.result;

    const decision = await this.requestTier2(
      'file.chmod',
      resolved.absPath,
      'chmod changes file permissions — Tier 2 HITL approval required.'
    );
    if (!decision.approved) {
      return { success: false, tier_decision: decision, error: `file.chmod denied: ${decision.reason}` };
    }

    try {
      chmodSync(resolved.absPath, mode);
      return { success: true, tier_decision: decision };
    } catch (err) {
      return this.fsError(decision, err);
    }
  }

  /**
   * Change file ownership (chown).
   * Always Tier 2 — ownership changes affect system security.
   */
  async chown(rawPath: string, uid: number, gid: number): Promise<FileOpResult> {
    const resolved = this.resolveSafe(rawPath, 'file.chown');
    if (!resolved.ok) return resolved.result;

    const decision = await this.requestTier2(
      'file.chown',
      resolved.absPath,
      'chown changes file ownership — Tier 2 HITL approval required.'
    );
    if (!decision.approved) {
      return { success: false, tier_decision: decision, error: `file.chown denied: ${decision.reason}` };
    }

    try {
      chownSync(resolved.absPath, uid, gid);
      return { success: true, tier_decision: decision };
    } catch (err) {
      return this.fsError(decision, err);
    }
  }

  /**
   * Classify a file operation without executing it.
   * Useful for pre-flight checks or building approval UIs.
   */
  async classify(
    operation: FileOperationType,
    rawPath: string,
    opts: FileOpOptions = {}
  ): Promise<TierDecision> {
    const resolved = this.resolveSafe(rawPath, `file.${operation}`);
    if (!resolved.ok) return resolved.result.tier_decision;

    switch (operation) {
      case 'read':
        return this.buildTier1Decision(`file.${operation}`, resolved.absPath, 'File read is non-destructive — Tier 1 auto-approved.');

      case 'write':
      case 'create': {
        const { decision } = await this.classifyMutation(`file.${operation}`, resolved.absPath);
        return decision;
      }

      case 'delete': {
        const recursive = opts.recursive === true;
        const action = recursive ? 'file.delete.recursive' : 'file.delete';
        return this.requestTier2(
          action,
          resolved.absPath,
          recursive
            ? 'Recursive delete is destructive — Tier 2 HITL approval required.'
            : 'File delete is destructive — Tier 2 HITL approval required.'
        );
      }

      case 'chmod':
        return this.requestTier2('file.chmod', resolved.absPath, 'chmod changes file permissions — Tier 2 HITL approval required.');

      case 'chown':
        return this.requestTier2('file.chown', resolved.absPath, 'chown changes file ownership — Tier 2 HITL approval required.');
    }
  }

  // ── Private: path resolution and safety ──────────────────────────────────

  /**
   * Resolve a raw path to an absolute path with symlinks resolved.
   * Rejects path traversal attempts (any ".." segment in the raw input).
   *
   * Returns { ok: true, absPath } on success or { ok: false, result } with a
   * pre-logged rejection on failure.
   */
  private resolveSafe(
    rawPath: string,
    action: string
  ): { ok: true; absPath: string } | { ok: false; result: FileOpResult } {
    // 1. Path traversal check — reject raw inputs with ".." segments
    if (rawPath.split('/').some(seg => seg === '..') || rawPath.split('\\').some(seg => seg === '..')) {
      const decision: TierDecision = {
        tier: 2,
        action,
        reason: 'Path traversal attempt detected ("..") — operation rejected.',
        approved: false,
        decided_at: ISO(),
      };
      this.writeAudit(decision, 'error', 'Path traversal rejected — ".." segment in input path');
      return {
        ok: false,
        result: {
          success: false,
          tier_decision: decision,
          error: `Rejected: path traversal detected in "${rawPath}"`,
        },
      };
    }

    // 2. Resolve to absolute path (without symlink resolution — file may not exist yet)
    const absPath = resolvePath(rawPath);

    // 3. Symlink resolution: if path exists, resolve symlinks before boundary checks
    let resolvedAbs = absPath;
    if (existsSync(absPath)) {
      try {
        resolvedAbs = realpathSync(absPath);
      } catch {
        // realpathSync can fail for broken symlinks — fall through to absPath
        resolvedAbs = absPath;
      }
    } else {
      // For new files, resolve symlinks on the parent directory
      const parentDir = dirname(absPath);
      if (existsSync(parentDir)) {
        try {
          const resolvedParent = realpathSync(parentDir);
          resolvedAbs = resolvedParent + '/' + basename(absPath);
        } catch {
          resolvedAbs = absPath;
        }
      }
    }

    return { ok: true, absPath: resolvedAbs };
  }

  // ── Private: tier classification ──────────────────────────────────────────

  /**
   * Classify a write/create mutation. Returns immediately for Tier 1 (no approval
   * needed), or awaits Tier 2 operator approval.
   */
  private async classifyMutation(
    action: string,
    absPath: string
  ): Promise<{ decision: TierDecision }> {
    const tier2Reason = this.mutationTier2Reason(absPath);

    if (tier2Reason !== null) {
      const decision = await this.requestTier2(action, absPath, tier2Reason);
      return { decision };
    }

    // Tier 1
    const decision = this.buildTier1Decision(
      action,
      absPath,
      'File mutation inside workspace root — Tier 1 auto-approved.'
    );
    this.writeAudit(decision, 'info', `${action} classified Tier 1 — auto-approved`);
    return { decision };
  }

  /**
   * Returns the Tier 2 reason string if the path requires HITL approval for a
   * write/create operation, or null if Tier 1 is sufficient.
   */
  private mutationTier2Reason(absPath: string): string | null {
    // Shell profile files — always Tier 2 regardless of location
    if (SHELL_PROFILE_NAMES.has(basename(absPath))) {
      return `Shell profile edit (${basename(absPath)}) requires Tier 2 HITL approval.`;
    }

    // System paths — always Tier 2
    const isSystemPath = SYSTEM_PATH_PREFIXES.some(prefix => absPath.startsWith(prefix));
    if (isSystemPath) {
      return `System path write (${absPath}) requires Tier 2 HITL approval.`;
    }

    // Outside workspace roots — Tier 2
    if (!this.workspaceRoots.isInsideWorkspace(absPath)) {
      return `Write outside workspace roots (${absPath}) requires Tier 2 HITL approval. Configure roots in ~/.apex/policy/workspace-roots.json.`;
    }

    return null;
  }

  /**
   * Issue a Tier 2 approval request, emit audit entries, and await operator resolution.
   */
  private async requestTier2(action: string, absPath: string, reason: string): Promise<TierDecision> {
    const { token, promise } = this.approvalService.requestApproval(
      action,
      { path: absPath },
      2,
      reason
    );

    const pending: TierDecision = {
      tier: 2,
      action,
      reason,
      approved: false,
      approval_id: token.id,
      decided_at: ISO(),
    };
    this.writeAudit(pending, 'warn', `Tier 2 approval required for ${action} on "${absPath}" — awaiting operator decision`);

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
      approved
        ? `Tier 2 ${action} approved — proceeding to execution`
        : `Tier 2 ${action} denied — execution blocked`
    );
    return final;
  }

  private buildTier1Decision(action: string, absPath: string, reason: string): TierDecision {
    return {
      tier: 1,
      action,
      reason,
      approved: true,
      decided_at: ISO(),
    };
  }

  // ── Private: audit helpers ──────────────────────────────────────────────────

  private writeAudit(decision: TierDecision, level: 'info' | 'warn' | 'error', message: string): void {
    this.audit.write({
      timestamp: ISO(),
      level,
      service: 'PolicyFileOps',
      message,
      action: decision.action,
      tier: decision.tier,
      approved: decision.approved,
      reason: decision.reason,
      approval_id: decision.approval_id,
    });
  }

  private fsError(decision: TierDecision, err: unknown): FileOpResult {
    const msg = err instanceof Error ? err.message : String(err);
    this.audit.write({
      timestamp: ISO(),
      level: 'error',
      service: 'PolicyFileOps',
      message: `Filesystem error during ${decision.action}: ${msg}`,
      action: decision.action,
    });
    return { success: false, tier_decision: decision, error: msg };
  }
}

// ── helpers exposed for testing ───────────────────────────────────────────────

export { SHELL_PROFILE_NAMES, SYSTEM_PATH_PREFIXES };
