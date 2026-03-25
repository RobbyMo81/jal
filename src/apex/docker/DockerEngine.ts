// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// src/apex/docker/DockerEngine.ts — JAL-002 Docker Lifecycle Integration
//
// Streaming Docker operations via child_process.spawn with the same
// incremental output contract as JAL-001 ShellEngine.
//
// Safety gates enforced:
//  - --privileged flag blocked unconditionally unless policy approves (Tier 3)
//  - docker prune / rm are Tier 2 destructive ops — policy must approve
//  - All operations flow through IPolicyFirewall.classify() before execution
//  - Policy violations are audit-logged before throwing
//
// Dependency injection: DockerEngine accepts IPolicyFirewall so JAL-003's
// full firewall drops in without modifying this class.

import { spawn, ChildProcess } from 'child_process';
import {
  DockerOptions,
  DockerBuildOptions,
  DockerResult,
  DockerActiveOperation,
  DockerOperationType,
  TierDecision,
  AuditEntry,
} from '../types';
import { IPolicyFirewall, DockerStubFirewall } from '../policy/PolicyFirewall';

// ── Constants ─────────────────────────────────────────────────────────────────

export const DOCKER_DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes

// ── DockerEngine ──────────────────────────────────────────────────────────────

export class DockerEngine {
  private readonly firewall: IPolicyFirewall;
  private readonly operations = new Map<string, DockerActiveOperation>();

  /**
   * @param firewall  Policy firewall to classify operations. Defaults to DockerStubFirewall.
   *                  JAL-003 will supply the full implementation.
   */
  constructor(firewall?: IPolicyFirewall) {
    this.firewall = firewall ?? new DockerStubFirewall();
  }

  // ── Public operations ────────────────────────────────────────────────────

  /**
   * List containers (docker ps -a --format json).
   * Tier 1 auto-approved.
   */
  async list(
    options?: DockerOptions,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal
  ): Promise<DockerResult> {
    const args = ['ps', '-a', '--format', '{{json .}}'];
    return this.run('list', args, options, onChunk, signal);
  }

  /**
   * Start a stopped container.
   * Tier 1 auto-approved.
   */
  async start(
    containerId: string,
    options?: DockerOptions,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal
  ): Promise<DockerResult> {
    this.validateContainerId(containerId);
    const args = ['start', containerId];
    return this.run('start', args, options, onChunk, signal);
  }

  /**
   * Stop a running container.
   * Tier 1 auto-approved.
   */
  async stop(
    containerId: string,
    options?: DockerOptions,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal
  ): Promise<DockerResult> {
    this.validateContainerId(containerId);
    const args = ['stop', containerId];
    return this.run('stop', args, options, onChunk, signal);
  }

  /**
   * Build an image from a Dockerfile context.
   * Tier 1 auto-approved (non-destructive build).
   */
  async build(
    contextPath: string,
    buildOptions?: DockerBuildOptions,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal
  ): Promise<DockerResult> {
    const args = ['build'];
    if (buildOptions?.tag) args.push('-t', buildOptions.tag);
    if (buildOptions?.dockerfile) args.push('-f', buildOptions.dockerfile);
    if (buildOptions?.buildArgs) {
      for (const [k, v] of Object.entries(buildOptions.buildArgs)) {
        args.push('--build-arg', `${k}=${v}`);
      }
    }
    args.push(contextPath);
    return this.run('build', args, buildOptions, onChunk, signal);
  }

  /**
   * Inspect a container (returns JSON metadata).
   * Tier 1 auto-approved.
   */
  async inspect(
    containerId: string,
    options?: DockerOptions,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal
  ): Promise<DockerResult> {
    this.validateContainerId(containerId);
    const args = ['inspect', containerId];
    return this.run('inspect', args, options, onChunk, signal);
  }

  // ── Cancellation ──────────────────────────────────────────────────────────

  /**
   * Cancel an in-flight operation by opId.
   * @returns true if found and signalled, false if already completed.
   */
  cancel(opId: string): boolean {
    const entry = this.operations.get(opId);
    if (!entry) return false;
    entry.cancelled = true;
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      // Already exited
    }
    return true;
  }

  /**
   * Return a read-only snapshot of active operations.
   * Consumed by JAL-007 crash recovery.
   */
  getActiveOperations(): ReadonlyMap<string, Readonly<DockerActiveOperation>> {
    return this.operations;
  }

  // ── Core runner ───────────────────────────────────────────────────────────

  private async run(
    operation: DockerOperationType,
    dockerArgs: string[],
    options: DockerOptions | undefined,
    onChunk: ((chunk: string, stream: 'stdout' | 'stderr') => void) | undefined,
    signal: AbortSignal | undefined
  ): Promise<DockerResult> {
    // Safety gate: reject --privileged in args
    const isPrivileged = dockerArgs.includes('--privileged');

    // Classify the sub-command for destructive op detection
    const subCmd = dockerArgs[0] ?? operation;
    const action = `docker.${subCmd}`;

    const tierDecision = await this.firewall.classify(action, {
      args: dockerArgs,
      privileged: isPrivileged,
      operation,
    });

    if (!tierDecision.approved) {
      this.auditViolation(tierDecision);
      throw new Error(
        `[DockerEngine] POLICY GATE: Operation blocked. ` +
        `action=${action} tier=${tierDecision.tier} reason=${tierDecision.reason}`
      );
    }

    return this.spawn(operation, dockerArgs, options, onChunk, signal, tierDecision);
  }

  private async spawn(
    operation: DockerOperationType,
    args: string[],
    options: DockerOptions | undefined,
    onChunk: ((chunk: string, stream: 'stdout' | 'stderr') => void) | undefined,
    signal: AbortSignal | undefined,
    tierDecision: TierDecision
  ): Promise<DockerResult> {
    const timeoutMs = options?.timeout_ms ?? DOCKER_DEFAULT_TIMEOUT_MS;
    const cwd = options?.cwd ?? process.cwd();
    const env: NodeJS.ProcessEnv = options?.env
      ? { ...process.env, ...options.env }
      : { ...process.env };

    const opId = this.makeOpId();
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    const proc: ChildProcess = spawn('docker', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pid = proc.pid ?? 0;
    const record: DockerActiveOperation = {
      pid,
      operation,
      startedAt,
      outputRef: `${opId}:0b`,
      cancelled: false,
    };
    this.operations.set(opId, record);

    return new Promise<DockerResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const settle = (result: DockerResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        signal?.removeEventListener('abort', onAbort);
        this.operations.delete(opId);
        resolve(result);
      };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, timeoutMs);

      const onAbort = (): void => {
        record.cancelled = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) proc.kill('SIGKILL');
        }, 2_000);
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        record.outputRef = `${opId}:${stdout.length}b`;
        onChunk?.(text, 'stdout');
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        onChunk?.(text, 'stderr');
      });

      proc.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutHandle);
          signal?.removeEventListener('abort', onAbort);
          this.operations.delete(opId);
          reject(err);
        }
      });

      proc.on('close', (code: number | null) => {
        settle({
          exit_code: code ?? -1,
          stdout,
          stderr,
          timed_out: timedOut,
          cancelled: record.cancelled,
          duration_ms: Date.now() - startTime,
          tier_decision: tierDecision,
        });
      });
    });
  }

  // ── Safety helpers ─────────────────────────────────────────────────────────

  /**
   * Validate that a container ID/name doesn't contain shell injection characters.
   * Container IDs are hex strings or simple names — no spaces, special chars.
   */
  private validateContainerId(id: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/.test(id)) {
      throw new Error(
        `[DockerEngine] SAFETY GATE: Invalid container ID format: ${JSON.stringify(id)}`
      );
    }
  }

  /**
   * Emit a structured audit log entry for policy violations.
   * JAL-003 will route this to the audit store. For now, emit to stderr.
   */
  private auditViolation(decision: TierDecision): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      level: 'warn',
      service: 'DockerEngine',
      message: 'Docker privilege model violation blocked by policy',
      action: decision.action,
      tier: decision.tier,
      reason: decision.reason,
    };
    process.stderr.write(JSON.stringify(entry) + '\n');
  }

  private makeOpId(): string {
    return `docker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
