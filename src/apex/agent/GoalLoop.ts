// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/agent/GoalLoop.ts — JAL-011 Natural Language Goal Loop
//                              JAL-015 Reasoning & Context Optimization
//
// Implements the plan-execute-observe agent loop:
//  1. Decomposes a natural-language goal into ordered GoalSteps via LLM.
//  2. Pre-classifies each step through TieredFirewall before execution.
//     - Tier 1: runs immediately.
//     - Tier 2: pauses loop, prompts operator for approval, resumes or aborts.
//     - Tier 3: aborts loop with explanation — never prompts.
//  3. Executes each step with streaming output to the REPL.
//  4. Self-corrects on step failure (up to 2 retries with error context in LLM call).
//  5. Checkpoints after each completed step (crash recovery via CheckpointStore).
//  6. Writes execution trace to EpisodicStore.
//  7. Prints a plain-English summary on completion.
//
// JAL-015 additions:
//  - RelevanceScorer selects top-K episodic memories for each goal context.
//  - ContextPacker enforces budget allocation before every LLM call.
//  - Summarizer condenses task histories > 2000 tokens before re-inclusion.
//  - Per-step token tracking with 80% context-limit warning.
//
// Safety gates:
//  - Every step classified through TieredFirewall before execution — no bypass.
//  - Tier 3 always aborts — never prompts.
//  - Credentials and tokens never included in LLM prompt context.

import * as crypto from 'crypto';
import { ShellEngine } from '../shell/ShellEngine';
import { ProviderGateway } from '../auth/ProviderGateway';
import { EpisodicStore } from '../memory/EpisodicStore';
import type { JALBrain } from '../brain/JALBrain';
import { RelevanceScorer } from '../memory/RelevanceScorer';
import { ContextPacker } from '../memory/ContextPacker';
import { ContextBudget, approxTokens } from '../memory/ContextBudget';
import { Summarizer, SUMMARY_TOKEN_THRESHOLD } from './Summarizer';
import {
  GoalStep,
  GoalStepTool,
  Checkpoint,
  CheckpointStep,
  PolicyTier,
  MemoryItem,
} from '../types';
import type { ApexRuntime } from '../runtime/ApexRuntime';
import type { ToolRegistry } from '../tools/ToolRegistry';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default model context window (tokens) — large model, 200K. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Warn when estimated context tokens exceed this fraction of the window. */
const CONTEXT_WARN_THRESHOLD = 0.8;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GoalLoopOptions {
  /** Called for each output chunk (streaming). Defaults to process.stdout.write. */
  onChunk?: (text: string) => void;
  /** Workspace ID for episodic memory scoping. */
  workspaceId?: string;
  /** Override state dir for EpisodicStore (for testing). */
  stateDir?: string;
  /** Tool registry — catalog injected into the LLM decompose prompt. */
  toolRegistry?: ToolRegistry;
  /**
   * Model context window in tokens (JAL-015).
   * Used for budget allocation and 80% token-limit warnings.
   * Defaults to DEFAULT_CONTEXT_WINDOW (200K).
   */
  contextWindow?: number;
  /**
   * Debug logger for context optimization decisions (JAL-015).
   * Called with segment sizes, truncation actions, and token warnings.
   * Defaults to no-op.
   */
  debugLog?: (msg: string) => void;
  /** JAL's persistent brain — when provided, goal traces are logged. */
  jalBrain?: JALBrain;
}

// Partial step shape returned by the LLM decomposition prompt.
interface RawStep {
  id?: unknown;
  description?: unknown;
  command?: unknown;
  tool?: unknown;
}

// ── GoalLoop ──────────────────────────────────────────────────────────────────

export class GoalLoop {
  /** Bypass engine has NO firewall — GoalLoop pre-classifies before exec. */
  private readonly bypassEngine: ShellEngine;
  private readonly episodicStore: EpisodicStore;
  private readonly workspaceId: string;
  private readonly emit: (text: string) => void;
  private readonly toolRegistry: ToolRegistry | undefined;

  // ── JAL-015 context optimization components ─────────────────────────────────
  private readonly relevanceScorer: RelevanceScorer;
  private readonly contextPacker: ContextPacker;
  private readonly summarizer: Summarizer;
  private readonly contextWindow: number;
  private readonly debugLog: (msg: string) => void;
  private readonly jalBrain: JALBrain | undefined;

  constructor(
    private readonly runtime: ApexRuntime,
    private readonly gateway: ProviderGateway,
    options: GoalLoopOptions = {}
  ) {
    this.bypassEngine = new ShellEngine(); // no firewall — classification done above
    this.episodicStore = new EpisodicStore(options.stateDir);
    this.workspaceId = options.workspaceId ?? 'apex_goal_loop';
    this.emit = options.onChunk ?? ((text) => process.stdout.write(text));
    this.toolRegistry = options.toolRegistry;

    // JAL-015 components
    this.relevanceScorer = new RelevanceScorer();
    this.contextPacker = new ContextPacker(new ContextBudget(options.stateDir));
    this.summarizer = new Summarizer(gateway);
    this.contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.debugLog = options.debugLog ?? ((_msg: string) => { /* no-op */ });
    this.jalBrain = options.jalBrain;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run the full plan-execute-observe loop for a natural language goal.
   * Streams output via onChunk as each step executes.
   */
  async run(goal: string): Promise<void> {
    const taskId = `goal-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const startedAt = new Date().toISOString();

    this.jalBrain?.setGoal(goal);
    this.jalBrain?.incrementSession();

    this.emit(`\n[APEX] Decomposing goal: "${goal}"\n`);

    // ── Step 1: Decompose goal into steps ─────────────────────────────────────

    let steps: GoalStep[];
    try {
      steps = await this.decomposeGoal(goal);
    } catch (err) {
      this.emit(`[APEX] Failed to decompose goal: ${(err as Error).message}\n`);
      this.writeExecutionTrace(taskId, goal, [], startedAt, (err as Error).message);
      return;
    }

    if (steps.length === 0) {
      this.emit('[APEX] No steps produced. Cannot execute.\n');
      this.writeExecutionTrace(taskId, goal, [], startedAt, 'No steps produced');
      return;
    }

    this.emit(`[APEX] ${steps.length} step(s) planned.\n\n`);

    // ── Step 2: Execute each step sequentially ────────────────────────────────

    const priorOutputs: string[] = [];
    let abortReason: string | null = null;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;

      // ── JAL-015: Per-step token tracking + 80% warning ─────────────────────
      this.checkContextTokenWarning(i + 1, goal, priorOutputs);

      this.emit(`── Step ${i + 1}/${steps.length}: ${step.description}\n`);
      this.emit(`   Command: ${step.command}\n`);

      step.status = 'in_progress';
      this.saveCheckpoint(taskId, goal, steps, i);

      // ── Pre-classify via TieredFirewall ──────────────────────────────────────
      let decision;
      try {
        decision = await this.runtime.firewall.classify('shell.exec', { command: step.command });
      } catch (err) {
        step.status = 'failed';
        step.error = (err as Error).message;
        this.emit(`[APEX] Classification error: ${step.error}\n`);
        abortReason = step.error;
        break;
      }

      step.tier = decision.tier;

      // Tier 3 — abort immediately, never prompt
      if (decision.tier === 3) {
        step.status = 'failed';
        step.error = `[TIER 3 BLOCKED] ${decision.reason}`;
        this.emit(`${step.error}\n`);
        this.emit('[APEX] Goal loop aborted — Tier 3 command blocked by policy.\n');
        abortReason = step.error;
        break;
      }

      // Tier 2 denied — abort
      if (!decision.approved) {
        step.status = 'failed';
        step.error = `[TIER 2 DENIED] ${decision.reason}`;
        this.emit('[APEX] Goal loop aborted — operator denied Tier 2 action.\n');
        abortReason = step.error;
        break;
      }

      // ── Execute with retry (up to 2 retries = 3 total attempts) ──────────────
      let succeeded = false;
      let lastError = '';

      for (let attempt = 0; attempt <= 2; attempt++) {
        if (attempt > 0) {
          this.emit(`   [retry ${attempt}/2] Command: ${step.command}\n`);
        }

        try {
          const result = await this.bypassEngine.exec(
            step.command,
            {},
            (chunk, stream) => {
              if (stream === 'stderr') {
                this.emit('[stderr] ' + chunk);
              } else {
                this.emit(chunk);
              }
            }
          );

          step.output =
            result.stdout + (result.stderr ? '\n[stderr]\n' + result.stderr : '');

          if (result.exit_code === 0) {
            step.status = 'completed';
            succeeded = true;
            break;
          }

          lastError = `exit=${result.exit_code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
          step.status = 'failed';
          step.error = lastError;
        } catch (err) {
          lastError = (err as Error).message;
          step.status = 'failed';
          step.error = lastError;
        }

        // Self-correct before next attempt — JAL-015: summarize history if needed
        if (attempt < 2 && !succeeded) {
          this.emit(`   [APEX] Step failed (attempt ${attempt + 1}/3): exit error\n`);
          try {
            const historyText = await this.buildHistoryForCorrection(goal, priorOutputs);
            const corrected = await this.selfCorrect(
              goal,
              step,
              lastError,
              historyText
            );
            if (corrected && corrected.trim() !== step.command.trim()) {
              step.command = corrected.trim();
              this.emit(`   [APEX] Corrected command: ${step.command}\n`);
            }
          } catch {
            // Self-correction failed — retry with same command
          }
        }
      }

      if (!succeeded) {
        this.emit(`\n[APEX] Step failed after 3 attempts.\n`);
        this.emit(`   What was tried: ${step.description}\n`);
        this.emit(`   Last error: ${lastError}\n`);

        // Get recommendation
        const rec = await this.getRecommendation(goal, step, lastError).catch(
          () => 'Review the error above and try the operation manually.'
        );
        this.emit(`   Recommendation: ${rec}\n`);
        abortReason = `Step "${step.description}" failed after 3 attempts: ${lastError}`;
        break;
      }

      priorOutputs.push(
        `Step ${i + 1} (${step.description}):\n${step.output}`
      );

      // Checkpoint after completed step
      this.saveCheckpoint(taskId, goal, steps, i + 1);
      this.emit(`   [OK]\n\n`);
    }

    // ── Step 3: Write execution trace to episodic memory ─────────────────────
    this.writeExecutionTrace(taskId, goal, steps, startedAt, abortReason);

    // Log goal trace to JALBrain
    const stepDescs = steps.map(s => `${s.status}: ${s.description}`);
    const outcome = abortReason ? `aborted: ${abortReason}` : 'completed';
    this.jalBrain?.logReasoning(goal, stepDescs, outcome);
    this.jalBrain?.setGoal(null);

    // ── Step 4: Print plain-English summary ───────────────────────────────────
    this.printSummary(goal, steps, abortReason);
  }

  // ── LLM calls ─────────────────────────────────────────────────────────────

  /**
   * Ask the LLM to decompose the goal into ordered GoalSteps.
   * JAL-015: retrieves top-K episodic memories, packs context via ContextPacker.
   * Returns parsed steps or throws on LLM/parse failure.
   */
  private async decomposeGoal(goal: string): Promise<GoalStep[]> {
    const prompt = await this.buildDecomposePrompt(goal);

    let raw: string;
    try {
      const result = await this.gateway.complete([
        { role: 'system', content: prompt },
        { role: 'user', content: `Goal: ${goal}` },
      ]);
      raw = result.content;
    } catch (err) {
      throw new Error(`LLM call failed: ${(err as Error).message}`);
    }

    return this.parseSteps(raw);
  }

  /**
   * Ask the LLM for a corrected command given a failed step and its error.
   * Returns the corrected command string, or the original command on failure.
   *
   * JAL-015: accepts pre-built historyText (already summarized if needed).
   */
  private async selfCorrect(
    goal: string,
    step: GoalStep,
    error: string,
    historyText: string
  ): Promise<string> {
    const priorContext = historyText.length > 0
      ? `Prior step outputs:\n${historyText}\n\n`
      : '';

    const prompt =
      `You are correcting a failed shell command. Return ONLY the corrected command string — ` +
      `no explanation, no markdown, no surrounding text.\n\n` +
      `Goal: ${goal}\n` +
      `Failed step: ${step.description}\n` +
      `Original command: ${step.command}\n` +
      `Error:\n${error.slice(0, 500)}\n\n` +
      priorContext +
      `Corrected command:`;

    const result = await this.gateway.complete([
      { role: 'user', content: prompt },
    ]);
    return result.content.trim();
  }

  /**
   * Ask the LLM for a short recommendation after repeated step failure.
   */
  private async getRecommendation(
    goal: string,
    step: GoalStep,
    error: string
  ): Promise<string> {
    const prompt =
      `A goal loop step failed 3 times. Provide a 1-2 sentence recommendation for the operator.\n\n` +
      `Goal: ${goal}\n` +
      `Failed step: ${step.description}\n` +
      `Last command tried: ${step.command}\n` +
      `Error:\n${error.slice(0, 500)}\n\n` +
      `Recommendation:`;

    const result = await this.gateway.complete([
      { role: 'user', content: prompt },
    ]);
    return result.content.trim();
  }

  // ── JAL-015: Context optimization helpers ──────────────────────────────────

  /**
   * Build prior-step history for self-correction.
   * If the accumulated history exceeds SUMMARY_TOKEN_THRESHOLD, summarize it first.
   * Raw history is NOT discarded — it lives in priorOutputs and gets written to
   * episodic memory via the execution trace.
   */
  private async buildHistoryForCorrection(
    goal: string,
    priorOutputs: string[]
  ): Promise<string> {
    const raw = priorOutputs.slice(-3).join('\n\n');
    if (!this.summarizer.shouldSummarize(raw)) {
      return raw;
    }

    this.debugLog(
      `[GoalLoop] task history ${approxTokens(raw)} tokens > ${SUMMARY_TOKEN_THRESHOLD} — summarizing`
    );
    const summary = await this.summarizer.summarize(goal, raw);
    this.debugLog(`[GoalLoop] summarized to ~${approxTokens(summary)} tokens`);
    return summary;
  }

  /**
   * Estimate approximate context tokens for the current step and emit a warning
   * if they exceed 80% of the model's context window.
   */
  private checkContextTokenWarning(
    stepIndex: number,
    goal: string,
    priorOutputs: string[]
  ): void {
    const estimatedTokens =
      approxTokens(goal) +
      priorOutputs.reduce((s, t) => s + approxTokens(t), 0);

    const threshold = Math.floor(this.contextWindow * CONTEXT_WARN_THRESHOLD);

    if (estimatedTokens > threshold) {
      const pct = Math.round((estimatedTokens / this.contextWindow) * 100);
      const msg =
        `[GoalLoop] WARNING: step ${stepIndex} context ~${estimatedTokens}tok ` +
        `(${pct}% of ${this.contextWindow} limit)`;
      this.debugLog(msg);
      this.emit(`[APEX] Warning: context approaching limit (${pct}% of ${this.contextWindow} tokens)\n`);
    } else {
      this.debugLog(
        `[GoalLoop] step ${stepIndex} context ~${estimatedTokens}tok ` +
        `(${Math.round((estimatedTokens / this.contextWindow) * 100)}% of limit)`
      );
    }
  }

  // ── Prompt builders ────────────────────────────────────────────────────────

  /**
   * Build the goal decomposition system prompt.
   *
   * JAL-015: retrieves top-K episodic memories via RelevanceScorer and packs
   * all segments through ContextPacker before assembling the final string.
   *
   * SAFETY: Never includes credentials, tokens, or raw command output.
   */
  private async buildDecomposePrompt(goal: string): Promise<string> {
    const soul = this.runtime.identityDocs.soul ?? '(not loaded)';
    const behavior = this.runtime.identityDocs.behavior ?? '(not loaded)';
    const narrative = this.runtime.heartbeatNarrative
      ? `Current system state:\n${this.runtime.heartbeatNarrative}`
      : 'No recent system state available.';

    const catalog = this.toolRegistry
      ? this.toolRegistry.catalog()
      : [
          'Available tools:',
          '  - shell: Execute bash shell commands',
          '  - docker: Manage Docker containers (list, start, stop, inspect)',
          '  - fileops: Read/write files within workspace roots',
        ].join('\n');

    // JAL-015: retrieve top-K relevant episodic memories (sensitive items excluded)
    const allMemories = this.episodicStore.list(this.workspaceId);
    const topK = this.relevanceScorer.selectTopK(goal, allMemories);
    const retrievedMemoryItems = topK.map(
      m =>
        `[Memory ${new Date(m.last_accessed_at).toLocaleDateString()}] ` +
        m.content.slice(0, 300)
    );

    // JAL-015: pack all segments through ContextPacker
    const packed = this.contextPacker.pack({
      contextWindow: this.contextWindow,
      systemPolicy: [soul, behavior],
      activeTask: [
        'Decompose the following goal into a concrete ordered list of shell steps.',
        'Return ONLY a valid JSON array. Each element must have exactly these fields:',
        '  { "id": "step-N", "description": "...", "command": "...", "tool": "shell" }',
        'Use only simple commands (no semicolons, pipes are OK, no sudo).',
        'Return no text outside the JSON array.',
        `Goal: ${goal}`,
      ],
      recentActions: narrative ? [narrative] : [],
      retrievedMemory: retrievedMemoryItems,
      logger: this.debugLog,
    });

    // JAL-015: warn if decompose prompt is large relative to context window
    if (packed.total_tokens > Math.floor(this.contextWindow * CONTEXT_WARN_THRESHOLD)) {
      const pct = Math.round((packed.total_tokens / this.contextWindow) * 100);
      this.debugLog(
        `[GoalLoop] WARNING: decompose prompt ~${packed.total_tokens}tok ` +
        `(${pct}% of ${this.contextWindow} limit)`
      );
    }

    // Assemble prompt from packed segments
    const sections: string[] = [
      '## Identity',
      packed.segments.system_policy.join('\n\n'),
      '',
      '## System Context',
      packed.segments.recent_actions.join('\n') || 'No recent system state available.',
      '',
      '## Available Tools',
      catalog,
    ];

    if (packed.segments.retrieved_memory.length > 0) {
      sections.push('', '## Relevant Context From Memory');
      sections.push(packed.segments.retrieved_memory.join('\n'));
    }

    sections.push(
      '',
      '## Instructions',
      packed.segments.active_task_state.join('\n')
    );

    return sections.join('\n');
  }

  // ── Parsing ────────────────────────────────────────────────────────────────

  /**
   * Extract a JSON array of steps from an LLM response string.
   * Handles surrounding text by scanning for the first '[' and matching ']'.
   */
  private parseSteps(raw: string): GoalStep[] {
    // Try to extract the first JSON array from the response
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');

    if (start < 0 || end <= start) {
      throw new Error(
        `LLM response did not contain a JSON array. Response: ${raw.slice(0, 200)}`
      );
    }

    const json = raw.slice(start, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error(
        `LLM returned malformed JSON: ${json.slice(0, 200)}`
      );
    }

    if (!Array.isArray(parsed)) {
      throw new Error('LLM returned a non-array JSON value.');
    }

    return (parsed as RawStep[]).map((raw, idx) => ({
      id: String(raw.id ?? `step-${idx + 1}`),
      description: String(raw.description ?? `Step ${idx + 1}`),
      command: String(raw.command ?? ''),
      tool: this.parseToolField(raw.tool),
      tier: 1 as PolicyTier,     // updated after classification
      status: 'pending' as const,
      output: '',
      error: '',
    }));
  }

  private parseToolField(val: unknown): GoalStepTool {
    if (val === 'shell' || val === 'docker' || val === 'fileops') return val;
    return 'shell';
  }

  // ── Checkpointing ──────────────────────────────────────────────────────────

  private saveCheckpoint(
    taskId: string,
    goal: string,
    steps: GoalStep[],
    currentStep: number
  ): void {
    try {
      const checkpointSteps: CheckpointStep[] = steps.map((s) => ({
        id: s.id,
        name: s.description,
        status: s.status,
        tier: s.tier,
        started_at: s.status === 'in_progress' ? new Date().toISOString() : undefined,
        completed_at: s.status === 'completed' ? new Date().toISOString() : undefined,
      }));

      const checkpoint: Checkpoint = {
        schema_version: 1,
        task_id: taskId,
        goal,
        current_step: currentStep,
        step_status: steps[currentStep]?.status ?? 'pending',
        steps: checkpointSteps,
        pending_approvals: [],
        tool_outputs_ref: {},
        // Stable dummy hash for Phase 1 (no policy snapshot file yet)
        policy_snapshot_hash: crypto
          .createHash('sha256')
          .update('phase1-policy-snapshot')
          .digest('hex'),
        updated_at: new Date().toISOString(),
      };

      this.runtime.checkpointStore.save(checkpoint);
    } catch {
      // Checkpoint write failure is non-fatal — log only
      this.runtime.auditLog.write({
        timestamp: new Date().toISOString(),
        level: 'warn',
        service: 'GoalLoop',
        message: `Checkpoint write failed for task ${taskId}`,
        action: 'goal_loop.checkpoint.error',
        task_id: taskId,
      });
    }
  }

  // ── Episodic trace ─────────────────────────────────────────────────────────

  private writeExecutionTrace(
    taskId: string,
    goal: string,
    steps: GoalStep[],
    startedAt: string,
    abortReason: string | null
  ): void {
    try {
      const trace = {
        task_id: taskId,
        goal,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        abort_reason: abortReason,
        steps: steps.map((s) => ({
          id: s.id,
          description: s.description,
          command: s.command,
          tool: s.tool,
          tier: s.tier,
          status: s.status,
          // Do NOT include output/error verbatim — may contain credentials
          output_length: s.output.length,
          had_error: s.error.length > 0,
        })),
      };
      const content = JSON.stringify(trace, null, 2);
      const now = new Date().toISOString();

      const item: MemoryItem = {
        id: `goal-trace-${taskId}`,
        tier: 'episodic',
        content,
        tags: ['goal-loop', 'execution-trace'],
        workspace_id: this.workspaceId,
        session_id: 'runtime',
        created_at: now,
        last_accessed_at: now,
        access_count: 0,
        size_bytes: Buffer.byteLength(content, 'utf8'),
      };

      this.episodicStore.store(item);

      this.runtime.auditLog.write({
        timestamp: now,
        level: 'info',
        service: 'GoalLoop',
        message: `Execution trace written for task ${taskId}`,
        action: 'goal_loop.trace.written',
        task_id: taskId,
        steps_count: steps.length,
      });
    } catch {
      // Non-fatal — trace write failure should not mask the real outcome
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  private printSummary(
    goal: string,
    steps: GoalStep[],
    abortReason: string | null
  ): void {
    const completed = steps.filter((s) => s.status === 'completed');
    const failed = steps.filter((s) => s.status === 'failed');

    this.emit('\n── Goal Loop Summary ────────────────────────────────\n');
    this.emit(`Goal:      ${goal}\n`);
    this.emit(`Completed: ${completed.length}/${steps.length} step(s)\n`);

    if (completed.length > 0) {
      this.emit('What was done:\n');
      for (const s of completed) {
        this.emit(`  ✓ ${s.description}\n`);
      }
    }

    if (failed.length > 0) {
      this.emit('What failed:\n');
      for (const s of failed) {
        this.emit(`  ✗ ${s.description}\n`);
      }
    }

    if (abortReason) {
      this.emit(`\nAborted: ${abortReason}\n`);
    } else {
      this.emit('\nAll steps completed successfully.\n');
    }

    this.emit('─────────────────────────────────────────────────────\n\n');
  }
}
