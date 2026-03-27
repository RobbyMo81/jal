// Co-authored by FORGE (Session: forge-20260326213245-2999721)
// src/apex/repl/Repl.ts — JAL-009 Interactive REPL (Phase 1 UI)
//
// Provides an operator-facing command loop backed by Node.js readline.
// Supported commands:
//   run <shell command>                  — shell execution via ShellEngine
//   docker <list|start|stop|inspect> [args]  — Docker ops via DockerEngine
//   status                               — heartbeat, active processes, memory stats
//   help                                 — list commands
//   exit                                 — graceful shutdown
//
// Tier enforcement:
//   Tier 1 — executes immediately, prints result with exit code + stdout/stderr
//   Tier 2 — pauses and prompts "[TIER 2] <action> — Approve? (y/n):"
//   Tier 3 — immediately prints "[TIER 3 BLOCKED] <reason>", returns to prompt
//
// Output streams incrementally via onChunk callback — not buffered until completion.
// All REPL interactions are audit-logged before execution.

import * as readline from 'readline';
import { ApexRuntime, ApexRuntimeOptions } from '../runtime/ApexRuntime';
import { GoalLoop } from '../agent/GoalLoop';
import { ApprovalToken } from '../types';

// ── REPL options ──────────────────────────────────────────────────────────────

export interface ReplOptions {
  /** Override stdin for testing. Defaults to process.stdin. */
  input?: NodeJS.ReadableStream;
  /** Override stdout for testing. Defaults to process.stdout. */
  output?: NodeJS.WritableStream;
  /** Override ApexRuntime constructor options (e.g. for test doubles). */
  runtimeOptions?: ApexRuntimeOptions;
}

// ── Repl ──────────────────────────────────────────────────────────────────────

export class Repl {
  private readonly rl: readline.Interface;
  readonly runtime: ApexRuntime;
  private readonly out: NodeJS.WritableStream;

  constructor(options: ReplOptions = {}) {
    this.out = options.output ?? process.stdout;

    // Create readline first so handleTier2Approval can reference this.rl.
    this.rl = readline.createInterface({
      input: options.input ?? process.stdin,
      output: this.out,
      terminal: !options.input, // disable terminal mode when overriding stdin (tests)
    });

    // If caller injects onApprovalRequired (e.g. tests), use it directly.
    // Otherwise wire to the readline-based interactive prompt.
    const onApprovalRequired: (token: ApprovalToken) => void =
      options.runtimeOptions?.onApprovalRequired ??
      ((token) => this.handleTier2Approval(token));

    const runtimeOpts: ApexRuntimeOptions = {
      ...options.runtimeOptions,
      onApprovalRequired,
    };

    this.runtime = new ApexRuntime(runtimeOpts);
  }

  // ── Public lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start the runtime, print the banner, print ambient status, and enter the REPL loop.
   * Returns once the user types `exit` and the runtime has stopped.
   */
  async run(): Promise<void> {
    await this.runtime.start();
    this.printBanner();
    this.printAmbientStatus();

    try {
      await this.replLoop();
    } finally {
      this.rl.close();
      await this.runtime.stop();
    }
  }

  // ── Private: REPL loop ────────────────────────────────────────────────────────

  private async replLoop(): Promise<void> {
    while (true) {
      const line = await this.readLine('apex> ');
      const trimmed = line.trim();
      if (!trimmed) continue;

      const shouldExit = await this.dispatch(trimmed);
      if (shouldExit) break;
    }
  }

  /**
   * Dispatch a REPL input line to the appropriate handler.
   * Returns true if the REPL should exit.
   */
  async dispatch(line: string): Promise<boolean> {
    const [cmd, ...rest] = line.split(/\s+/);

    switch (cmd?.toLowerCase()) {
      case 'goal':
        await this.handleGoal(rest.join(' '));
        return false;

      case 'run':
        await this.handleRun(rest.join(' '));
        return false;

      case 'docker':
        await this.handleDocker(rest);
        return false;

      case 'status':
        this.handleStatus();
        return false;

      case 'help':
        this.handleHelp();
        return false;

      case 'exit':
        this.writeLine('Shutting down...');
        return true;

      default:
        this.writeLine(`Unknown command: ${cmd ?? ''}. Type 'help' for available commands.`);
        return false;
    }
  }

  // ── Command handlers ──────────────────────────────────────────────────────────

  private async handleRun(command: string): Promise<void> {
    if (!command) {
      this.writeLine('Usage: run <shell command>');
      return;
    }

    this.runtime.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'Repl',
      message: `REPL run command: ${command}`,
      action: 'repl.run',
      command,
    });

    try {
      const result = await this.runtime.shellEngine.exec(
        command,
        {},
        (chunk, stream) => {
          // Stream output incrementally as chunks arrive
          if (stream === 'stderr') {
            this.write('[stderr] ' + chunk);
          } else {
            this.write(chunk);
          }
        }
      );

      this.writeLine('');
      this.writeLine(`[exit: ${result.exit_code}]${result.timed_out ? ' (timed out)' : ''}`);

      this.runtime.auditLog.write({
        timestamp: new Date().toISOString(),
        level: result.exit_code === 0 ? 'info' : 'warn',
        service: 'Repl',
        message: `run completed: exit=${result.exit_code}`,
        action: 'repl.run.result',
        command,
        exit_code: result.exit_code,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Detect Tier 3 block from firewall error message
      if (msg.includes('POLICY GATE') || msg.includes('SAFETY GATE')) {
        const tier3Match = msg.match(/tier=3/) || msg.includes('Tier 3') || msg.includes('TIER 3');
        if (tier3Match) {
          this.writeLine(`[TIER 3 BLOCKED] ${msg}`);
        } else {
          this.writeLine(`[BLOCKED] ${msg}`);
        }
      } else {
        this.writeLine(`Error: ${msg}`);
      }

      this.runtime.auditLog.write({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: 'Repl',
        message: `run failed: ${msg}`,
        action: 'repl.run.error',
        command,
      });
    }
  }

  private async handleDocker(args: string[]): Promise<void> {
    const subCmd = args[0]?.toLowerCase();

    if (!subCmd) {
      this.writeLine('Usage: docker <list|start|stop|inspect> [args]');
      return;
    }

    this.runtime.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'Repl',
      message: `REPL docker command: ${subCmd} ${args.slice(1).join(' ')}`,
      action: 'repl.docker',
      subcommand: subCmd,
    });

    const onChunk = (chunk: string, stream: 'stdout' | 'stderr'): void => {
      if (stream === 'stderr') {
        this.write('[stderr] ' + chunk);
      } else {
        this.write(chunk);
      }
    };

    try {
      let result;
      switch (subCmd) {
        case 'list':
          result = await this.runtime.dockerEngine.list(undefined, onChunk);
          break;
        case 'start': {
          const id = args[1];
          if (!id) { this.writeLine('Usage: docker start <container-id>'); return; }
          result = await this.runtime.dockerEngine.start(id, undefined, onChunk);
          break;
        }
        case 'stop': {
          const id = args[1];
          if (!id) { this.writeLine('Usage: docker stop <container-id>'); return; }
          result = await this.runtime.dockerEngine.stop(id, undefined, onChunk);
          break;
        }
        case 'inspect': {
          const id = args[1];
          if (!id) { this.writeLine('Usage: docker inspect <container-id>'); return; }
          result = await this.runtime.dockerEngine.inspect(id, undefined, onChunk);
          break;
        }
        default:
          this.writeLine(`Unknown docker subcommand: ${subCmd}. Supported: list, start, stop, inspect`);
          return;
      }

      this.writeLine('');
      this.writeLine(`[exit: ${result.exit_code}]${result.timed_out ? ' (timed out)' : ''}`);

      this.runtime.auditLog.write({
        timestamp: new Date().toISOString(),
        level: result.exit_code === 0 ? 'info' : 'warn',
        service: 'Repl',
        message: `docker ${subCmd} completed: exit=${result.exit_code}`,
        action: 'repl.docker.result',
        subcommand: subCmd,
        exit_code: result.exit_code,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes('tier=3') || msg.includes('Tier 3') || msg.includes('TIER 3')) {
        this.writeLine(`[TIER 3 BLOCKED] ${msg}`);
      } else if (msg.includes('POLICY GATE') || msg.includes('SAFETY GATE')) {
        this.writeLine(`[BLOCKED] ${msg}`);
      } else {
        this.writeLine(`Error: ${msg}`);
      }

      this.runtime.auditLog.write({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: 'Repl',
        message: `docker ${subCmd} failed: ${msg}`,
        action: 'repl.docker.error',
        subcommand: subCmd,
      });
    }
  }

  private async handleGoal(goal: string): Promise<void> {
    if (!goal) {
      this.writeLine('Usage: goal <natural language description>');
      return;
    }

    this.runtime.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'Repl',
      message: `Goal loop started: ${goal}`,
      action: 'repl.goal.start',
      goal,
    });

    const loop = new GoalLoop(
      this.runtime,
      this.runtime.providerGateway,
      {
        onChunk: (text) => this.write(text),
      }
    );

    try {
      await loop.run(goal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLine(`[APEX] Goal loop error: ${msg}`);
    }

    this.runtime.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'Repl',
      message: `Goal loop finished: ${goal}`,
      action: 'repl.goal.finish',
      goal,
    });
  }

  private handleStatus(): void {
    const activeExecs = this.runtime.shellEngine.getActiveExecutions();
    const heartbeatRunning = this.runtime.heartbeat.isRunning;
    const intervalSec = this.runtime.heartbeat.intervalSeconds;
    const shortTermItems = this.runtime.memoryManager.listShortTerm();

    this.writeLine('─── Apex Status ───────────────────────────────────');
    this.writeLine(`  Heartbeat:       ${heartbeatRunning ? 'running' : 'stopped'} (interval: ${intervalSec}s)`);
    this.writeLine(`  Active shell:    ${activeExecs.size} process(es)`);
    this.writeLine(`  Short-term mem:  ${shortTermItems.length} item(s)`);
    this.writeLine('───────────────────────────────────────────────────');

    this.runtime.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'Repl',
      message: 'status queried',
      action: 'repl.status',
      heartbeat_running: heartbeatRunning,
      active_executions: activeExecs.size,
    });
  }

  private handleHelp(): void {
    this.writeLine('Available commands:');
    this.writeLine('  goal <natural language>            Run the agent goal loop');
    this.writeLine('  run <command>                      Execute a shell command');
    this.writeLine('  docker list                        List all containers');
    this.writeLine('  docker start <id>                  Start a container');
    this.writeLine('  docker stop <id>                   Stop a container');
    this.writeLine('  docker inspect <id>                Inspect a container');
    this.writeLine('  status                             Show runtime status');
    this.writeLine('  help                               Show this help message');
    this.writeLine('  exit                               Graceful shutdown');
  }

  // ── Tier 2 approval handler ───────────────────────────────────────────────────

  /**
   * Called by TieredFirewall when a Tier 2 action requires operator approval.
   * Prompts stdin for y/n and resolves the approval token accordingly.
   * This is called while classify() is suspended — readline is not waiting
   * for a main-prompt line at this point, so rl.question() is safe to call.
   */
  private handleTier2Approval(token: ApprovalToken): void {
    const prompt = `\n[TIER 2] ${token.action} — ${token.reason}\nApprove? (y/n): `;

    this.runtime.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'warn',
      service: 'Repl',
      message: `Tier 2 approval requested: ${token.action}`,
      action: 'repl.tier2.prompt',
      approval_id: token.id,
    });

    this.rl.question(prompt, (answer) => {
      const approved = answer.trim().toLowerCase() === 'y';
      this.runtime.approvalService.resolve(token.id, approved);

      if (!approved) {
        this.writeLine('Denied.');
      }

      this.runtime.auditLog.write({
        timestamp: new Date().toISOString(),
        level: approved ? 'info' : 'warn',
        service: 'Repl',
        message: `Tier 2 ${approved ? 'approved' : 'denied'}: ${token.action}`,
        action: 'repl.tier2.resolved',
        approval_id: token.id,
        approved,
      });
    });
  }

  // ── Ambient status ────────────────────────────────────────────────────────────

  /**
   * Print the latest heartbeat narrative before the first REPL prompt.
   * Shows what changed, what is urgent, and what is healthy since last session.
   * Only printed if a narrative exists in durable context.
   */
  private printAmbientStatus(): void {
    const narrative = this.runtime.heartbeatNarrative;
    if (!narrative) return;

    this.writeLine('');
    this.writeLine('─── Ambient Status (last heartbeat narrative) ──────');
    for (const line of narrative.split('\n')) {
      this.writeLine(`  ${line}`);
    }
    this.writeLine('────────────────────────────────────────────────────');
    this.writeLine('');
  }

  // ── Banner ────────────────────────────────────────────────────────────────────

  private printBanner(): void {
    const provider = 'local';
    const intervalSec = this.runtime.heartbeatIntervalSeconds;
    this.writeLine('');
    this.writeLine('╔══════════════════════════════════════════════╗');
    this.writeLine(`║  Apex v${this.runtime.version} — Phase 1 REPL               ║`);
    this.writeLine(`║  Provider: ${provider.padEnd(34)}║`);
    this.writeLine(`║  Heartbeat interval: ${String(intervalSec + 's').padEnd(24)}║`);
    this.writeLine('╚══════════════════════════════════════════════╝');
    this.writeLine("Type 'help' for available commands.\n");
  }

  // ── Readline helpers ──────────────────────────────────────────────────────────

  private readLine(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, resolve);
    });
  }

  private write(text: string): void {
    this.out.write(text);
  }

  private writeLine(text: string): void {
    this.out.write(text + '\n');
  }
}
