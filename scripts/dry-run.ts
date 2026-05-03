// scripts/dry-run.ts — Apex pre-flight dry-run
//
// Exercises every major subsystem and reports go/no-go status.
// Run before first daemon launch: npm run dry-run
// (or: env $(grep -v '^#' .env | grep -v '^$' | xargs) npx ts-node --project tsconfig.json scripts/dry-run.ts)

import { ApexRuntime } from '../src/apex/runtime/ApexRuntime';
import { GoalLoop } from '../src/apex/agent/GoalLoop';
import { FallbackProviderChain } from '../src/apex/providers/FallbackProviderChain';
import { GeminiAdapter } from '../src/apex/auth/GeminiAdapter';
import { OpenAIAdapter } from '../src/apex/auth/OpenAIAdapter';
import { OllamaAdapter } from '../src/apex/auth/OllamaAdapter';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PASS = '  ✓';
const FAIL = '  ✗';
const SKIP = '  –';
const results: Array<{ label: string; ok: boolean | 'skip'; detail: string }> = [];

function check(label: string, ok: boolean | 'skip', detail = '') {
  results.push({ label, ok, detail });
  const icon = ok === 'skip' ? SKIP : ok ? PASS : FAIL;
  const d = detail ? `  ${detail}` : '';
  console.log(`${icon} ${label}${d}`);
}

async function probe(label: string, fn: () => Promise<string>): Promise<boolean> {
  try {
    const detail = await fn();
    check(label, true, detail);
    return true;
  } catch (e) {
    check(label, false, (e as Error).message.slice(0, 120));
    return false;
  }
}

function env(key: string): string { return process.env[key] ?? ''; }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  APEX DRY-RUN — pre-flight check');
  console.log('══════════════════════════════════════════════════════════\n');

  // ── 1. Environment vars ──────────────────────────────────────────────────
  console.log('── 1. Environment ──────────────────────────────────────────');
  check('APEX_DEFAULT_PROVIDER', !!env('APEX_DEFAULT_PROVIDER'), env('APEX_DEFAULT_PROVIDER'));
  check('APEX_DEFAULT_MODEL',    !!env('APEX_DEFAULT_MODEL'),    env('APEX_DEFAULT_MODEL'));
  check('APEX_GUARDIAN_ENABLED', env('APEX_GUARDIAN_ENABLED') === 'true', env('APEX_GUARDIAN_ENABLED'));
  check('OLLAMA_BASE_URL',       !!env('OLLAMA_BASE_URL'), env('OLLAMA_BASE_URL'));
  check('APEX_WORKSPACE_ROOTS',  !!env('APEX_WORKSPACE_ROOTS'), env('APEX_WORKSPACE_ROOTS'));
  check('GEMINI_API_KEY',        !!env('GEMINI_API_KEY'), env('GEMINI_API_KEY') ? '(set)' : '(empty)');
  check('OPENAI_API_KEY',        !!env('OPENAI_API_KEY'), env('OPENAI_API_KEY') ? '(set)' : '(empty)');
  const hasAnthropic = !!env('ANTHROPIC_API_KEY');
  check('ANTHROPIC_API_KEY',     hasAnthropic ? true : 'skip',
    hasAnthropic ? '(set)' : '(not set — Claude link will be skipped)');

  // ── 2. Filesystem pre-conditions ─────────────────────────────────────────
  console.log('\n── 2. Filesystem ───────────────────────────────────────────');
  check('.env present',            existsSync(join(process.cwd(), '.env')));
  check('node_modules present',    existsSync(join(process.cwd(), 'node_modules')));
  check('Soul.md present',         existsSync(join(process.cwd(), 'src/apex/Soul.md')));
  check('Behavior.md present',     existsSync(join(process.cwd(), 'src/apex/Behavior.md')));
  check('deploy/install.sh',       existsSync(join(process.cwd(), 'deploy/install.sh')));
  check('deploy/apex.user.service',existsSync(join(process.cwd(), 'deploy/apex.user.service')));
  check('Canvas ui/dist built',    existsSync(join(process.cwd(), 'src/apex/canvas/ui/dist/index.html')));

  // ── 3. Ollama models ──────────────────────────────────────────────────────
  console.log('\n── 3. Local Models (Ollama) ────────────────────────────────');
  const ollama = new OllamaAdapter();
  const msgs = [{ role: 'user' as const, content: 'Reply with ONLY the word: ALIVE' }];
  await probe('qwen3:4b  complete()', async () => {
    const r = await ollama.completeWithLogprobs(msgs, 'qwen3:4b', { temperature: 0 });
    return `"${r.content.trim().slice(0, 40)}"  ${r.usage?.input_tokens ?? '?'}in/${r.usage?.output_tokens ?? '?'}out`;
  });
  await probe('gemma3:latest complete()', async () => {
    const r = await ollama.completeWithLogprobs(msgs, 'gemma3:latest', { temperature: 0 });
    return `"${r.content.trim().slice(0, 40)}"  ${r.usage?.input_tokens ?? '?'}in/${r.usage?.output_tokens ?? '?'}out`;
  });
  await probe('qwen3:4b  stream()', async () => {
    const chunks: string[] = [];
    await ollama.streamWithLogprobs(msgs, 'qwen3:4b', { temperature: 0 }, c => chunks.push(c));
    return `${chunks.length} chunks`;
  });

  // ── 4. Cloud providers ────────────────────────────────────────────────────
  console.log('\n── 4. Cloud Providers ──────────────────────────────────────');
  const pingMsg = [{ role: 'user' as const, content: 'Reply with ONLY the word: PONG' }];

  if (env('GEMINI_API_KEY')) {
    await probe('Gemini 2.5 Flash complete()', async () => {
      const r = await new GeminiAdapter().complete(pingMsg, 'gemini-2.5-flash', env('GEMINI_API_KEY'), { temperature: 0 });
      return `"${r.content.trim().slice(0, 40)}"`;
    });
    await probe('Gemini 2.5 Flash stream()', async () => {
      const chunks: string[] = [];
      await new GeminiAdapter().stream(pingMsg, 'gemini-2.5-flash', env('GEMINI_API_KEY'), { temperature: 0 }, c => chunks.push(c));
      return `${chunks.length} chunk(s)`;
    });
  } else {
    check('Gemini', 'skip', 'GEMINI_API_KEY not set');
  }

  if (env('OPENAI_API_KEY')) {
    await probe('OpenAI gpt-4o-mini complete()', async () => {
      const r = await new OpenAIAdapter().complete(pingMsg, 'gpt-4o-mini', env('OPENAI_API_KEY'), { temperature: 0 });
      return `"${r.content.trim().slice(0, 40)}"`;
    });
  } else {
    check('OpenAI', 'skip', 'OPENAI_API_KEY not set');
  }

  if (env('ANTHROPIC_API_KEY')) {
    const { ClaudeAdapter } = await import('../src/apex/auth/ClaudeAdapter');
    await probe('Claude complete()', async () => {
      const r = await new ClaudeAdapter().complete(pingMsg, 'claude-sonnet-4-6', env('ANTHROPIC_API_KEY'), { temperature: 0 });
      return `"${r.content.trim().slice(0, 40)}"`;
    });
  } else {
    check('Claude', 'skip', 'ANTHROPIC_API_KEY not set — Claude link will be skipped in guardian-chain');
  }

  // ── 5. Provider chains ────────────────────────────────────────────────────
  console.log('\n── 5. Provider Chains ──────────────────────────────────────');
  const jalChain = new FallbackProviderChain('jal-chain', [
    { adapter: ollama, model: 'qwen3:4b',      token: '' },
    { adapter: ollama, model: 'gemma3:latest', token: '' },
  ]);
  await probe('jal-chain complete()', async () => {
    const r = await jalChain.completeWithLogprobs(msgs, '', { temperature: 0 });
    const states = jalChain.getBreakerStates().map(s => `${s.name.split(':').pop()}=${s.state}`).join(' ');
    return `"${r.content.trim().slice(0, 30)}"  breakers: ${states}`;
  });

  const guardianLinks: ConstructorParameters<typeof FallbackProviderChain>[1] = [];
  if (env('ANTHROPIC_API_KEY')) {
    const { ClaudeAdapter } = await import('../src/apex/auth/ClaudeAdapter');
    guardianLinks.push({ adapter: new ClaudeAdapter(), model: 'claude-sonnet-4-6', token: env('ANTHROPIC_API_KEY') });
  }
  if (env('GEMINI_API_KEY')) {
    guardianLinks.push({ adapter: new GeminiAdapter(), model: 'gemini-2.5-flash', token: env('GEMINI_API_KEY') });
  }
  if (env('OPENAI_API_KEY')) {
    guardianLinks.push({ adapter: new OpenAIAdapter(), model: 'gpt-4o-mini', token: env('OPENAI_API_KEY') });
  }
  guardianLinks.push({ adapter: ollama, model: 'gemma3:latest', token: '' });

  const guardianChain = new FallbackProviderChain('guardian-chain', guardianLinks);
  await probe('guardian-chain complete()', async () => {
    const r = await guardianChain.complete(msgs, '', '', { temperature: 0 });
    const states = guardianChain.getBreakerStates().map(s => `${s.name.split(':').pop()}=${s.state}`).join(' ');
    return `"${r.content.trim().slice(0, 30)}"  breakers: ${states}`;
  });

  // ── 6. Guardian Angle DVU pipeline ────────────────────────────────────────
  console.log('\n── 6. Guardian Angle DVU Pipeline ──────────────────────────');
  await probe('DVUProtocol verify() (guardian model)', async () => {
    const { DVUProtocol } = await import('../src/apex/guardian_angle/DVUProtocol');
    const dvu = new DVUProtocol(guardianChain, 'gemini-2.5-flash');
    const pof = await dvu.verify(
      [{ role: 'user', content: 'What is 2 + 2?' }],
      '5',
      'reasoning'
    );
    return `PoF index=${pof.index} reason="${pof.reason.slice(0, 60)}"`;
  });
  await probe('GuardianAngle.complete() — low entropy path', async () => {
    const { GuardianAngle } = await import('../src/apex/guardian_angle/GuardianAngle');
    const ga = new GuardianAngle({
      studentModel: 'qwen3:4b',
      guardianModel: 'gemini-2.5-flash',
      studentAdapter: jalChain,
      guardianAdapter: guardianChain,
      entropyThreshold: 0.99,  // force low-entropy path (accept all drafts)
    });
    const r = await ga.complete(
      [{ role: 'user', content: 'Reply with ONLY the word: GUARDIAN_OK' }],
      '', '', { temperature: 0 }
    );
    return `"${r.content.trim().slice(0, 40)}"  dvu_cycles=${(r as any).dvu_cycles ?? 0}`;
  });

  // ── 7. Runtime wiring ─────────────────────────────────────────────────────
  console.log('\n── 7. ApexRuntime Wiring ───────────────────────────────────');
  const rt = new ApexRuntime({ canvas: false });
  await probe('runtime.start() + identity docs', async () => {
    await rt.start();
    const soul = rt.identityDocs.soul ? 'Soul.md ✓' : 'Soul.md ✗';
    const behavior = rt.identityDocs.behavior ? 'Behavior.md ✓' : 'Behavior.md ✗';
    return `${soul}  ${behavior}  keychain=${rt['_keychainBackend']}`;
  });
  check('jalBrain wired', rt.jalBrain !== null && rt.jalBrain !== undefined,
    `sessions=${rt.jalBrain.getMemory().session_count}`);
  check('guardianBrain wired', rt.guardianBrain !== null && rt.guardianBrain !== undefined);
  check('providerGateway default', true,
    `${rt.providerGateway.getConfig().provider}/${rt.providerGateway.getConfig().model}`);
  check('guardian registered', rt['isStubGateway'] === false);

  // ── 8. GoalLoop ───────────────────────────────────────────────────────────
  console.log('\n── 8. GoalLoop ─────────────────────────────────────────────');
  await probe('goal decomposition (list files in /tmp)', async () => {
    const output: string[] = [];
    const loop = new GoalLoop(rt, rt.providerGateway, {
      onChunk: t => output.push(t),
      jalBrain: rt.jalBrain,
    });
    await loop.run('list all files in /tmp and print the count');
    const full = output.join('');
    const ok = full.includes('OK') || full.includes('completed') || full.includes('Step');
    if (!ok && full.includes('aborted')) throw new Error(`Goal aborted: ${full.slice(0, 120)}`);
    return `${output.length} output chunks`;
  });

  // ── 9. Heartbeat ─────────────────────────────────────────────────────────
  console.log('\n── 9. Heartbeat ────────────────────────────────────────────');
  check('heartbeat scheduler wired', rt.heartbeat !== null);
  check('heartbeat interval',        true, `${rt.heartbeat.intervalSeconds}s`);

  // ── 10. Policy firewall ───────────────────────────────────────────────────
  console.log('\n── 10. Policy Firewall ─────────────────────────────────────');
  await probe('Tier 1: ls /tmp allowed', async () => {
    const d = await rt.firewall.classify('shell.exec', { command: 'ls /tmp' });
    if (d.tier !== 1) throw new Error(`Expected tier 1, got ${d.tier}`);
    return `tier=${d.tier} approved=${d.approved}`;
  });
  await probe('Tier 3: sudo blocked', async () => {
    const d = await rt.firewall.classify('shell.exec', { command: 'sudo rm -rf /' });
    if (d.tier !== 3) throw new Error(`Expected tier 3, got ${d.tier}`);
    return `tier=${d.tier} blocked ✓`;
  });

  // ── 11. Keychain + audit log ──────────────────────────────────────────────
  console.log('\n── 11. Keychain & Audit ────────────────────────────────────');
  await probe('keychain set/get round-trip', async () => {
    const { createKeychain } = await import('../src/apex/auth/KeychainFactory');
    const kc = createKeychain().keychain;
    await kc.set('dry-run', 'test', 'CANARY');
    const val = await kc.get('dry-run', 'test');
    await kc.delete('dry-run', 'test');
    if (val !== 'CANARY') throw new Error(`Expected CANARY, got ${val}`);
    return 'CANARY round-trip ✓';
  });
  await probe('audit log write', async () => {
    rt.auditLog.write({ timestamp: new Date().toISOString(), level: 'info',
      service: 'dry-run', message: 'pre-flight check', action: 'dry_run.check' });
    return 'entry written';
  });

  // ── 12. Brain persistence ─────────────────────────────────────────────────
  console.log('\n── 12. Brain Persistence ───────────────────────────────────');
  await probe('JALBrain write/read', async () => {
    rt.jalBrain.setFact('dry_run', true);
    const val = rt.jalBrain.getMemory().facts['dry_run'];
    if (!val) throw new Error('fact not persisted');
    return `sessions=${rt.jalBrain.getMemory().session_count}  facts.dry_run=true`;
  });
  await probe('GuardianBrain write/read', async () => {
    rt.guardianBrain.addDomainNote('general', 'dry-run verified');
    const dk = rt.guardianBrain.getDomainKnowledge();
    const note = dk.domains['general']?.notes.find(n => n === 'dry-run verified');
    if (!note) throw new Error('note not persisted');
    return 'domain note persisted ✓';
  });

  // ── Stop runtime ──────────────────────────────────────────────────────────
  await rt.stop();

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok === true).length;
  const failed = results.filter(r => r.ok === false).length;
  const skipped = results.filter(r => r.ok === 'skip').length;

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed  ${skipped} skipped  ${failed} failed`);

  if (failed === 0) {
    console.log('\n  ✓ GO — Apex is ready to wake.\n');
    console.log('  Launch daemon:   bash deploy/install.sh');
    console.log('  Follow logs:     journalctl --user -u apex -f');
    console.log('  Canvas:          http://localhost:7474/canvas?token=<see logs>');
  } else {
    console.log('\n  ✗ NO-GO — resolve failures before launching daemon.\n');
    for (const r of results.filter(r => r.ok === false)) {
      console.log(`     ✗ ${r.label}: ${r.detail}`);
    }
  }
  console.log('══════════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('\nDry-run crashed:', (e as Error).message);
  process.exit(1);
});
