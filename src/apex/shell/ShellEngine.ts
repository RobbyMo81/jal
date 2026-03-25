// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// src/apex/shell/ShellEngine.ts — JAL-001 Native Shell Execution Engine
//
// Implements streaming command execution via child_process.spawn with:
//  - bash / zsh / powershell shell selection
//  - incremental stdout/stderr streaming via callbacks
//  - AbortSignal-based user cancellation
//  - 15-minute default timeout (policy-extensible)
//  - PID + output-ref tracking for crash recovery (consumed by JAL-007)
//  - Command injection check on all inputs
//  - sudo blocked unconditionally at this layer

import { spawn, ChildProcess } from 'child_process';
import { ExecOptions, ExecResult, ShellType } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes

/**
 * Shell metacharacters that enable command injection:
 * semicolons/newlines (command chaining), backticks and $() (command substitution).
 * Pipes and redirects are intentionally allowed as they appear in legitimate commands.
 */
const INJECTION_RE = /[;`\r\n]|\$\(|\$\{/;

// ── Active execution record ───────────────────────────────────────────────────

export interface ActiveExecution {
  /** OS-level process ID — used by JAL-007 for crash recovery. */
  readonly pid: number;
  /** The full command string that was submitted. */
  readonly command: string;
  /** ISO timestamp of when execution started. */
  readonly startedAt: string;
  /**
   * Output reference string for crash recovery (JAL-007).
   * Format: "<execId>:<bytesWritten>b"
   * Updated in-place as output accumulates.
   */
  outputRef: string;
  /** Set to true when the caller has requested cancellation. */
  cancelled: boolean;
}

// ── ShellEngine ───────────────────────────────────────────────────────────────

export class ShellEngine {
  private readonly executions = new Map<string, ActiveExecution>();

  // ── Static safety gates ──────────────────────────────────────────────────

  /**
   * Check a string for shell injection metacharacters.
   * Throws a descriptive error if any are found.
   * Callers should invoke this on any user-supplied input before
   * interpolating it into a command string.
   */
  static checkInjection(input: string): void {
    if (INJECTION_RE.test(input)) {
      throw new Error(
        `[ShellEngine] SAFETY GATE: Command injection metacharacters detected in input. ` +
        `Rejected: ${JSON.stringify(input)}`
      );
    }
  }

  /**
   * Block sudo at the execution layer unconditionally.
   * sudo elevation is deferred to Tier 3 policy (JAL-003).
   */
  static checkSudo(command: string): void {
    if (/(?:^|\s)sudo(?:\s|$)/.test(command)) {
      throw new Error(
        `[ShellEngine] SAFETY GATE: sudo is blocked at the execution layer. ` +
        `Elevation requires Tier 3 policy approval (JAL-003).`
      );
    }
  }

  /**
   * Resolve the OS binary and argument array for a given ShellType.
   */
  static resolveShell(shell: ShellType, command: string): { bin: string; args: string[] } {
    switch (shell) {
      case 'bash':
        return { bin: 'bash', args: ['-c', command] };
      case 'zsh':
        return { bin: 'zsh', args: ['-c', command] };
      case 'powershell':
        // pwsh is the cross-platform PowerShell Core binary
        return { bin: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command', command] };
    }
  }

  // ── Core execution ───────────────────────────────────────────────────────

  /**
   * Execute a shell command with full streaming, cancellation, and timeout support.
   *
   * Safety gates enforced unconditionally:
   *  1. sudo block — throws before spawn if "sudo" appears in the command.
   *  2. Injection check — throws if injection metacharacters are present.
   *
   * @param command  Shell command string to execute.
   * @param options  Shell type, timeout, cwd, env overrides.
   * @param onChunk  Optional streaming callback — called for each stdout/stderr chunk.
   * @param signal   Optional AbortSignal; aborting cancels the running process.
   * @returns        Resolved ExecResult once the process exits or is terminated.
   */
  async exec(
    command: string,
    options: ExecOptions = {},
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal
  ): Promise<ExecResult> {
    // Safety gate 1 — sudo
    ShellEngine.checkSudo(command);
    // Safety gate 2 — injection
    ShellEngine.checkInjection(command);

    const shell: ShellType = options.shell ?? 'bash';
    const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const cwd = options.cwd ?? process.cwd();
    const env: NodeJS.ProcessEnv = options.env
      ? { ...process.env, ...options.env }
      : { ...process.env };

    const { bin, args } = ShellEngine.resolveShell(shell, command);
    const execId = this.makeExecId();
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    const proc: ChildProcess = spawn(bin, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pid = proc.pid ?? 0;

    // Register for crash recovery (JAL-007 reads this map)
    const record: ActiveExecution = {
      pid,
      command,
      startedAt,
      outputRef: `${execId}:0b`,
      cancelled: false,
    };
    this.executions.set(execId, record);

    return new Promise<ExecResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const settle = (result: ExecResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        signal?.removeEventListener('abort', onAbort);
        this.executions.delete(execId);
        resolve(result);
      };

      // Force-kill after timeout
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, timeoutMs);

      // Cancellation via AbortSignal
      const onAbort = (): void => {
        record.cancelled = true;
        proc.kill('SIGTERM');
        // Escalate to SIGKILL if process does not exit promptly
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
        record.outputRef = `${execId}:${stdout.length}b`;
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
          this.executions.delete(execId);
          reject(err);
        }
      });

      proc.on('close', (code: number | null) => {
        settle({
          exit_code: code ?? -1,
          stdout,
          stderr,
          timed_out: timedOut,
          duration_ms: Date.now() - startTime,
        });
      });
    });
  }

  // ── Cancellation ─────────────────────────────────────────────────────────

  /**
   * Cancel an active execution by execId.
   * Sends SIGTERM to the process. Cancellation is recorded in the execution record.
   *
   * @returns true if the execution was found, false if already completed.
   */
  cancel(execId: string): boolean {
    const entry = this.executions.get(execId);
    if (!entry) return false;
    entry.cancelled = true;
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      // Process may have already exited — not an error condition
    }
    return true;
  }

  // ── Crash recovery surface (consumed by JAL-007) ──────────────────────────

  /**
   * Return a read-only snapshot of all currently active executions.
   * Consumed by JAL-007 on crash recovery to enumerate in-flight PIDs.
   */
  getActiveExecutions(): ReadonlyMap<string, Readonly<ActiveExecution>> {
    return this.executions;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private makeExecId(): string {
    return `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
