// Sanity check — live OllamaAdapter against real Ollama instance
import { OllamaAdapter } from '../src/apex/auth/OllamaAdapter';

async function main(): Promise<void> {
  const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' });

  // ── complete() qwen3:4b ───────────────────────────────────────────────────
  const r1 = await adapter.complete(
    [{ role: 'user', content: 'What is 3 + 3? Reply with only the number.' }],
    'qwen3:4b', 'unused', { temperature: 0 }
  );
  console.log('complete()    qwen3:4b  →', JSON.stringify(r1.content.trim()));
  console.log('              tokens    →', r1.usage?.input_tokens, 'in /', r1.usage?.output_tokens, 'out');

  // ── stream() qwen3:4b ─────────────────────────────────────────────────────
  const chunks: string[] = [];
  const r2 = await adapter.stream(
    [{ role: 'user', content: 'Count 1 2 3, separated by spaces only.' }],
    'qwen3:4b', 'unused', { temperature: 0 },
    c => chunks.push(c)
  );
  console.log('stream()      qwen3:4b  →', JSON.stringify(r2.content.trim()));
  console.log('              chunks    →', chunks.length, 'received');

  // ── completeWithLogprobs() ────────────────────────────────────────────────
  const r3 = await adapter.completeWithLogprobs(
    [{ role: 'user', content: 'Say exactly: APEX_ALIVE' }],
    'qwen3:4b', { temperature: 0 }
  );
  console.log('logprobs()    qwen3:4b  →', JSON.stringify(r3.content.trim().slice(0, 40)));
  console.log('              logprobs  →', r3.logprobs !== undefined
    ? `${r3.logprobs.length} tokens returned`
    : 'not supported by this model/version (entropy fallback will be used)');

  // ── complete() gemma3:latest ──────────────────────────────────────────────
  const r4 = await adapter.complete(
    [{ role: 'user', content: 'What is 7 + 8? Reply with only the number.' }],
    'gemma3:latest', 'unused', { temperature: 0 }
  );
  console.log('complete()    gemma3    →', JSON.stringify(r4.content.trim()));
  console.log('              tokens    →', r4.usage?.input_tokens, 'in /', r4.usage?.output_tokens, 'out');

  console.log('\n✓ All checks passed — OllamaAdapter is live.');
}

main().catch(e => {
  console.error('FAIL:', (e as Error).message);
  process.exit(1);
});
