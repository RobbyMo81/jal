#!/usr/bin/env ts-node
/**
 * scripts/exercise.ts — JAL comprehensive exercise suite
 *
 * Routes all direct LLM questions through the Guardian Angle pipeline
 * (DVU: Draft-Verify-Update) and runs two GoalLoop agent exercises.
 * Covers all six Guardian domains:
 *   reasoning, code_generation, shell_commands, file_operations, system_admin, general
 *
 * Usage: npm run exercise
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ApexRuntime } from '../src/apex/runtime/ApexRuntime';
import { GoalLoop } from '../src/apex/agent/GoalLoop';
import type { GuardianDVUResult } from '../src/apex/guardian_angle/types';
import type { GatewayMessage, CompletionResult } from '../src/apex/types';

// ── Terminal colours ─────────────────────────────────────────────────────────

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
};
const c = (col: keyof typeof C, s: string) => `${C[col]}${s}${C.reset}`;
const bold = (s: string) => c('bold', s);
const dim  = (s: string) => c('dim',  s);

// ── .env loader ──────────────────────────────────────────────────────────────

function loadEnv(): void {
  try {
    const raw = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch { /* .env absent — fall through */ }
}

// ── Exercise types ────────────────────────────────────────────────────────────

interface LLMExercise {
  kind: 'llm';
  label: string;
  domain: string;
  messages: GatewayMessage[];
  note: string;
}

interface GoalExercise {
  kind: 'goal';
  label: string;
  domain: string;
  goal: string;
  note: string;
}

type Exercise = LLMExercise | GoalExercise;

const Q = (text: string): GatewayMessage[] => [{ role: 'user', content: text }];

// ── Exercise catalogue ────────────────────────────────────────────────────────

const EXERCISES: Exercise[] = [

  // ─────────────────────────────────────────────────────────────────────────
  // REASONING — classic traps where the intuitive answer is wrong
  // ─────────────────────────────────────────────────────────────────────────
  {
    kind:    'llm',
    label:   'R1 · Bat-and-ball cognitive trap',
    domain:  'reasoning',
    note:    'Correct: ball = $0.05. Intuitive wrong answer is $0.10.',
    messages: Q(
      'A bat and a ball cost $1.10 in total. The bat costs exactly $1.00 more than the ball. ' +
      'How much does the ball cost? Work through the algebra step by step.'
    ),
  },
  {
    kind:    'llm',
    label:   'R2 · Monty Hall — exact probability',
    domain:  'reasoning',
    note:    'Switching wins with probability 2/3, not 1/2.',
    messages: Q(
      'You are on a game show with 3 doors. Behind one is a car; behind the others are goats. ' +
      'You pick door 1. The host (who knows what is behind each door) opens door 3 to reveal a goat. ' +
      'Should you switch to door 2 or stay with door 1? ' +
      'Give the exact probability of winning for each strategy and explain why.'
    ),
  },
  {
    kind:    'llm',
    label:   'R3 · Last digit of 7^100 via cycle',
    domain:  'reasoning',
    note:    'Powers of 7 have last-digit cycle 7,9,3,1 (period 4). 100 mod 4 = 0 → last digit = 1.',
    messages: Q(
      'What is the last digit of 7^100? ' +
      'Identify the repeating cycle of last digits in successive powers of 7 and use it ' +
      'to derive the answer without computing the full number.'
    ),
  },
  {
    kind:    'llm',
    label:   'R4 · Three-way logic puzzle',
    domain:  'reasoning',
    note:    'Pick from the MIXED box — since all labels wrong, it cannot contain mixed; whatever comes out is its true label.',
    messages: Q(
      'You have three boxes: one labelled "Apples", one "Oranges", one "Mixed". ' +
      'ALL three labels are wrong. You may pick exactly one fruit from exactly one box ' +
      '(without looking inside). Which box should you pick from to determine the correct ' +
      'labels for all three boxes? Explain fully.'
    ),
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CODE GENERATION — subtle bugs, performance, and language traps
  // ─────────────────────────────────────────────────────────────────────────
  {
    kind:    'llm',
    label:   'C1 · IEEE 754 — 0.1 + 0.2 === 0.3',
    domain:  'code_generation',
    note:    'Returns false. 0.1+0.2 = 0.30000000000000004 due to binary floating-point representation.',
    messages: Q(
      'What does the expression `0.1 + 0.2 === 0.3` evaluate to in JavaScript? ' +
      'State the exact value of `0.1 + 0.2`, explain the root cause, and give the idiomatic ' +
      'fix for comparing floating-point values.'
    ),
  },
  {
    kind:    'llm',
    label:   'C2 · Sequential async vs Promise.all',
    domain:  'code_generation',
    note:    'Sequential: N×latency total. Promise.all: 1×latency total (10x speedup for N=10).',
    messages: Q(
      'Identify the performance problem in this code:\n\n' +
      '```js\nasync function fetchAll(urls) {\n' +
      '  const results = [];\n' +
      '  for (const url of urls) {\n' +
      '    results.push(await fetch(url));\n' +
      '  }\n' +
      '  return results;\n}\n```\n\n' +
      'Rewrite it to maximise throughput. If each fetch takes 200 ms and N=10 URLs, ' +
      'what is the total wall-clock time before and after the fix?'
    ),
  },
  {
    kind:    'llm',
    label:   'C3 · Deadlock — four Coffman conditions',
    domain:  'code_generation',
    note:    'Name the four Coffman conditions; fix via consistent lock ordering (remove circular wait).',
    messages: Q(
      'Thread A holds lock_1 and waits for lock_2. ' +
      'Thread B holds lock_2 and waits for lock_1. ' +
      'Both threads block indefinitely.\n\n' +
      '1. Name this condition.\n' +
      '2. State all four Coffman conditions that must hold for it to occur.\n' +
      '3. Give the minimal code change that prevents it without adding new synchronisation primitives.'
    ),
  },
  {
    kind:    'llm',
    label:   'C4 · TypeScript generics — contravariance trap',
    domain:  'code_generation',
    note:    'Function parameter types are contravariant; TypeScript bivariant by default (strictFunctionTypes changes this).',
    messages: Q(
      'Is this TypeScript assignment safe?\n\n' +
      '```ts\ntype Handler = (event: MouseEvent) => void;\n' +
      'const h: Handler = (event: Event) => console.log(event.type);\n```\n\n' +
      'Explain whether it compiles, whether it is type-safe, and what the terms ' +
      '"covariance" and "contravariance" mean in the context of function parameters. ' +
      'What TypeScript compiler flag changes the behaviour for function types?'
    ),
  },
  {
    kind:    'llm',
    label:   'C5 · Sieve of Eratosthenes — complexity',
    domain:  'code_generation',
    note:    'Time: O(n log log n). Write a correct implementation and state its space complexity.',
    messages: Q(
      'Write a clean TypeScript implementation of the Sieve of Eratosthenes that returns ' +
      'all prime numbers up to N. Then:\n' +
      '1. State the time complexity and explain why it is O(n log log n) and not O(n^2).\n' +
      '2. State the space complexity.\n' +
      '3. Show the output for N=30.'
    ),
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SHELL COMMANDS — precision, safety, and POSIX correctness
  // ─────────────────────────────────────────────────────────────────────────
  {
    kind:    'llm',
    label:   'S1 · Find large files — space-safe, sorted',
    domain:  'shell_commands',
    note:    'Correct: find -size +50M -printf; NUL-delimited piping; sort -rh; no broken pipes on spaces in names.',
    messages: Q(
      'Write a single bash pipeline to find all regular files under /var/log larger than 50 MB, ' +
      'print each file\'s size and path in human-readable form (e.g. "123M /var/log/big.log"), ' +
      'sorted by size largest-first. The command must NOT break on filenames that contain spaces.'
    ),
  },
  {
    kind:    'llm',
    label:   'S2 · Atomic in-place file edit without temp file',
    domain:  'shell_commands',
    note:    'sed -i creates a temp file internally; true atomic swap uses a write-then-mv approach.',
    messages: Q(
      'You want to atomically replace every occurrence of the string "localhost:8080" with ' +
      '"api.example.com:443" in /etc/myapp/config.yaml on Linux. ' +
      'Write the exact command. Then explain whether `sed -i` is truly atomic and what would ' +
      'happen to a reader that opens the file in the middle of the operation.'
    ),
  },
  {
    kind:    'llm',
    label:   'S3 · Parallel xargs with rate-limiting',
    domain:  'shell_commands',
    note:    'xargs -P N for parallelism; sleep or pv for rate-limiting; -0 for NUL delimiters.',
    messages: Q(
      'You have a file urls.txt with 10,000 URLs, one per line. ' +
      'Write a bash command using xargs to curl each URL in parallel with at most 20 concurrent ' +
      'workers, saving each response to a numbered file. ' +
      'Add rate-limiting so no more than 5 new requests start per second.'
    ),
  },

  // ─────────────────────────────────────────────────────────────────────────
  // GENERAL — architecture and systems concepts
  // ─────────────────────────────────────────────────────────────────────────
  {
    kind:    'llm',
    label:   'G1 · SIGTERM vs SIGKILL + Node.js shutdown',
    domain:  'general',
    note:    'SIGTERM is catchable; SIGKILL is not. Correct graceful shutdown: process.on("SIGTERM").',
    messages: Q(
      'Explain the difference between SIGTERM and SIGKILL in Unix/Linux.\n' +
      '1. Which one can a process catch or ignore, and how?\n' +
      '2. Which one should a graceful shutdown handler use, and why?\n' +
      '3. Write a correct Node.js SIGTERM handler that flushes an open writable stream ' +
      '   and then calls process.exit(0).'
    ),
  },
  {
    kind:    'llm',
    label:   'G2 · CAP theorem — partition trade-off',
    domain:  'general',
    note:    'P is unavoidable in real networks; real choice is C vs A during a partition. CP=HBase, AP=Cassandra.',
    messages: Q(
      'The CAP theorem states a distributed system can guarantee at most 2 of Consistency, ' +
      'Availability, and Partition tolerance. ' +
      'Explain why Partition tolerance is not optional for any system that communicates over a network. ' +
      'Give one real-world CP system and one AP system, naming the exact availability or consistency ' +
      'trade-off each one makes during a network partition.'
    ),
  },
  {
    kind:    'llm',
    label:   'G3 · Mutex vs semaphore — when each applies',
    domain:  'general',
    note:    'Mutex: ownership + binary; Semaphore: counting, no ownership. Classic: mutex for critical section, semaphore for bounded pool.',
    messages: Q(
      'Explain the fundamental difference between a mutex and a semaphore. ' +
      'Specifically:\n' +
      '1. Which one enforces ownership (only the locking thread may unlock)?\n' +
      '2. Give one concrete scenario where you would use a mutex and one where you would use ' +
      '   a counting semaphore, and explain why each fits better.\n' +
      '3. What is a binary semaphore and how does it differ from a mutex in practice?'
    ),
  },

  // ─────────────────────────────────────────────────────────────────────────
  // AGENT GoalLoop — plan-execute-observe with real shell invocations
  // ─────────────────────────────────────────────────────────────────────────
  {
    kind:    'goal',
    label:   'GL1 · TypeScript LOC by subdirectory',
    domain:  'file_operations',
    note:    'Exercises: find + wc -l + awk decomposition over src/ tree.',
    goal:    'Count the total lines of TypeScript source code in the src/ directory. ' +
             'Report the line count for each immediate subdirectory of src/ and a grand total.',
  },
  {
    kind:    'goal',
    label:   'GL2 · System health snapshot',
    domain:  'system_admin',
    note:    'Exercises: df, free, uptime, ps aux decomposition.',
    goal:    'Produce a system health report with four sections: ' +
             '(1) disk usage on all mounted filesystems, ' +
             '(2) total and available RAM and swap, ' +
             '(3) 1/5/15-minute load averages, ' +
             '(4) top 5 processes by CPU usage with their PID and command name.',
  },
];

// ── DVU result type guard ─────────────────────────────────────────────────────

function isDVU(r: CompletionResult): r is GuardianDVUResult {
  return 'guardian_invoked' in r;
}

// ── DVU status line formatter ─────────────────────────────────────────────────

function dvuLine(r: GuardianDVUResult): string {
  if (r.sleep_mode_active) {
    return c('yellow', 'guardian=SLEEP_MODE');
  }
  if (!r.guardian_invoked) {
    return c('green', `guardian=skipped  entropy=${r.entropy_score.toFixed(3)} (below threshold)`);
  }

  const entropy = `entropy=${r.entropy_score.toFixed(3)}`;
  const cycles  = `cycles=${r.dvu_cycles}`;

  let pof: string;
  if (!r.pof) {
    pof = dim('pof=none');
  } else if (r.pof.parseError) {
    pof = c('yellow', 'pof=PARSE_ERROR');
  } else if (r.pof.index !== null) {
    pof = c('red', `pof@word[${r.pof.index}] "${(r.pof.reason ?? '').slice(0, 70)}"`);
  } else {
    pof = c('green', 'pof=null (approved)');
  }

  return [entropy, cycles, pof].join('  ');
}

// ── Horizontal rule ───────────────────────────────────────────────────────────

const HR  = dim('  ' + '─'.repeat(60));
const BOX = (title: string) => {
  const pad = 56 - title.length;
  const l = Math.floor(pad / 2);
  const r2 = pad - l;
  return bold(`╔${'═'.repeat(58)}╗\n║${' '.repeat(l)}${title}${' '.repeat(r2)}║\n╚${'═'.repeat(58)}╝`);
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();

  const guardianEnabled = process.env['APEX_GUARDIAN_ENABLED'] === 'true';

  console.log('\n' + BOX('JAL COMPREHENSIVE EXERCISE SUITE'));
  console.log(dim(`  ${EXERCISES.length} exercises  •  6 domains  •  guardian_enabled=${guardianEnabled}\n`));

  // ── Boot runtime ───────────────────────────────────────────────────────────
  const rt = new ApexRuntime({ canvas: false });
  await rt.start();

  const savedCfg = rt.providerGateway.getConfig();

  // Switch to guardian as default for DVU exercises
  if (guardianEnabled) {
    rt.providerGateway.switchConfig({ provider: 'guardian', model: savedCfg.model });
  }

  // ── Run exercises ──────────────────────────────────────────────────────────
  let completed = 0;
  let errors    = 0;
  let totalCycles = 0;
  let totalParseErrors = 0;
  let guardianInvocations = 0;

  for (let i = 0; i < EXERCISES.length; i++) {
    const ex = EXERCISES[i]!;
    const idx = `[${String(i + 1).padStart(2)}/${EXERCISES.length}]`;

    console.log(`\n${HR}`);
    console.log(`${bold(idx)} ${bold(ex.label)}  ${dim('domain:' + ex.domain)}`);
    console.log(dim(`       ${ex.note}`));
    console.log();

    const t0 = Date.now();

    // ── LLM exercise ─────────────────────────────────────────────────────────
    if (ex.kind === 'llm') {
      const q = (ex.messages[0] as GatewayMessage).content;
      console.log(c('cyan', '  Q  ') + q.slice(0, 140) + (q.length > 140 ? c('dim', '…') : ''));
      console.log();

      try {
        const result = await rt.providerGateway.complete(ex.messages);
        const ms = Date.now() - t0;

        // Pretty-print answer (wrap at 100 chars, indent)
        const answer = result.content.trim();
        const lines  = answer.split('\n').slice(0, 20); // cap at 20 lines for display
        const capped = lines.length < answer.split('\n').length;
        for (const ln of lines) {
          const wrapped = ln.match(/.{1,100}/g) ?? [''];
          for (const seg of wrapped) {
            console.log('  ' + seg);
          }
        }
        if (capped) console.log(dim('  … (truncated for display)'));

        console.log();
        if (isDVU(result)) {
          console.log(dim(`  DVU  `) + dvuLine(result) + dim(`  •  ${ms}ms`));
          totalCycles += result.dvu_cycles;
          if (result.pof?.parseError) totalParseErrors++;
          if (result.guardian_invoked) guardianInvocations++;
        } else {
          console.log(dim(`  time  ${ms}ms  (no DVU — guardian disabled or routing to jal-chain)`));
        }

        completed++;
      } catch (err) {
        const ms = Date.now() - t0;
        console.log(c('red', `  ERROR: ${(err as Error).message.slice(0, 200)}`) + dim(`  •  ${ms}ms`));
        errors++;
      }

    // ── GoalLoop exercise ─────────────────────────────────────────────────────
    } else {
      // GoalLoop uses the student chain, not guardian
      rt.providerGateway.switchConfig(savedCfg);

      console.log(c('cyan', '  Goal  ') + ex.goal);
      console.log(HR);

      try {
        const loop = new GoalLoop(rt, rt.providerGateway, {
          jalBrain:     rt.jalBrain,
          toolRegistry: rt.toolRegistry,
          onChunk:      (chunk) => process.stdout.write(chunk),
        });
        await loop.run(ex.goal);
        completed++;
      } catch (err) {
        console.log(c('red', `  ERROR: ${(err as Error).message.slice(0, 300)}`));
        errors++;
      }

      const ms = Date.now() - t0;
      console.log(HR);
      console.log(dim(`  goal loop total: ${ms}ms`));

      // Restore guardian config for remaining LLM exercises
      if (guardianEnabled) {
        rt.providerGateway.switchConfig({ provider: 'guardian', model: savedCfg.model });
      }
    }
  }

  // ── Guardian sleep tracker stats ───────────────────────────────────────────
  if (guardianEnabled) {
    console.log('\n' + BOX('GUARDIAN SLEEP TRACKER'));

    const gateway = rt.providerGateway as unknown as {
      adapters: Map<string, { getSleepStats?: () => Record<string, {
        in_sleep_mode: boolean;
        accuracy:      number;
        window_size:   number;
        correct_count: number;
        last_updated:  string;
      }> }>;
    };
    const ga = gateway.adapters.get('guardian');
    const stats = ga?.getSleepStats?.();

    if (stats && Object.keys(stats).length > 0) {
      console.log();
      console.log(
        dim('  domain             ') +
        dim('status   ') +
        dim('accuracy  ') +
        dim('window  ') +
        dim('correct')
      );
      console.log(dim('  ' + '─'.repeat(60)));
      for (const [domain, s] of Object.entries(stats)) {
        const status = s.in_sleep_mode
          ? c('yellow', 'SLEEPING')
          : c('green',  'ACTIVE  ');
        const acc  = (s.accuracy * 100).toFixed(1).padStart(5) + '%';
        const win  = String(s.window_size).padStart(4);
        const cor  = String(s.correct_count).padStart(4);
        console.log(`  ${domain.padEnd(20)}${status}  ${acc}     ${win}    ${cor}`);
      }
    } else {
      console.log(dim('  (no domains seen during this session)'));
    }
  }

  // ── Brain snapshot ─────────────────────────────────────────────────────────
  console.log('\n' + BOX('JAL BRAIN SNAPSHOT'));
  const mem = rt.jalBrain.getMemory();
  console.log();
  if (mem.active_goal) {
    console.log(`  active_goal  : ${mem.active_goal}`);
  }
  console.log(`  sessions     : ${mem.session_count}`);
  console.log(`  last_provider: ${mem.last_provider ?? '(none)'}`);
  console.log(`  last_model   : ${mem.last_model ?? '(none)'}`);
  console.log(`  updated_at   : ${mem.updated_at}`);

  // ── Session summary ────────────────────────────────────────────────────────
  console.log('\n' + BOX('SESSION SUMMARY'));
  console.log();
  const llmCount  = EXERCISES.filter(e => e.kind === 'llm').length;
  const goalCount = EXERCISES.filter(e => e.kind === 'goal').length;
  console.log(`  exercises       : ${EXERCISES.length}  (${llmCount} LLM  +  ${goalCount} GoalLoop)`);
  console.log(`  completed       : ${completed}`);
  console.log(`  errors          : ${errors > 0 ? c('red', String(errors)) : c('green', '0')}`);
  if (guardianEnabled) {
    console.log(`  guardian calls  : ${guardianInvocations}`);
    console.log(`  DVU cycles      : ${totalCycles}`);
    console.log(`  parse errors    : ${totalParseErrors > 0 ? c('yellow', String(totalParseErrors)) : c('green', '0')}`);
  }
  console.log();

  await rt.stop();
}

main().catch((err) => {
  console.error(c('red', `\nFatal: ${(err as Error).message}`));
  process.exit(1);
});
