// Co-authored by Apex Wakening Build
// tests/guardian_angle/OllamaAdapter.test.ts — OllamaAdapter unit tests
//
// All tests mock global fetch — no real Ollama server required.

import { OllamaAdapter } from '../../src/apex/auth/OllamaAdapter';

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    body: null,
  } as unknown as Response);
}

function mockFetchStream(lines: string[]): jest.SpyInstance {
  const encoder = new TextEncoder();
  const chunks = lines.map(l => encoder.encode(l + '\n'));
  let index = 0;
  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: true,
    status: 200,
    body: readable,
  } as unknown as Response);
}

const MESSAGES = [
  { role: 'user' as const, content: 'Hello, what is 2+2?' },
];

// ── complete() ────────────────────────────────────────────────────────────────

describe('OllamaAdapter.complete', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends POST to /api/chat and returns content', async () => {
    mockFetch({
      model: 'llama3.2',
      message: { role: 'assistant', content: '4' },
      done: true,
      prompt_eval_count: 10,
      eval_count: 1,
    });

    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const result = await adapter.complete(MESSAGES, 'llama3.2', 'ignored-token', {});

    expect(result.content).toBe('4');
    expect(result.model).toBe('llama3.2');
    expect(result.provider).toBe('ollama');
    expect(result.usage?.output_tokens).toBe(1);
  });

  it('throws on non-200 response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as unknown as Response);

    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' });
    await expect(adapter.complete(MESSAGES, 'llama3.2', '', {})).rejects.toThrow('Ollama API error 500');
  });

  it('uses OLLAMA_BASE_URL env var when no baseUrl option set', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://my-ollama:11434';
    const adapter = new OllamaAdapter();
    expect(adapter.baseUrl).toBe('http://my-ollama:11434');
    delete process.env['OLLAMA_BASE_URL'];
  });

  it('falls back to localhost:11434 when no env var', () => {
    delete process.env['OLLAMA_BASE_URL'];
    const adapter = new OllamaAdapter();
    expect(adapter.baseUrl).toBe('http://localhost:11434');
  });

  it('ignores auth token param', async () => {
    const spy = mockFetch({
      model: 'llama3.2',
      message: { role: 'assistant', content: 'ok' },
      done: true,
    });

    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' });
    await adapter.complete(MESSAGES, 'llama3.2', 'some-token-that-should-be-ignored', {});

    const callBody = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1]?.body as string);
    expect(callBody).not.toHaveProperty('token');
  });
});

// ── stream() ──────────────────────────────────────────────────────────────────

describe('OllamaAdapter.stream', () => {
  afterEach(() => jest.restoreAllMocks());

  it('calls onChunk for each content token', async () => {
    mockFetchStream([
      JSON.stringify({ model: 'llama3.2', message: { role: 'assistant', content: 'Hello' }, done: false }),
      JSON.stringify({ model: 'llama3.2', message: { role: 'assistant', content: ' world' }, done: false }),
      JSON.stringify({ model: 'llama3.2', done: true, eval_count: 2, prompt_eval_count: 5 }),
    ]);

    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const chunks: string[] = [];
    const result = await adapter.stream(MESSAGES, 'llama3.2', '', {}, c => chunks.push(c));

    expect(chunks).toEqual(['Hello', ' world']);
    expect(result.content).toBe('Hello world');
    expect(result.usage?.output_tokens).toBe(2);
    expect(result.usage?.input_tokens).toBe(5);
  });

  it('handles empty content chunks without calling onChunk', async () => {
    mockFetchStream([
      JSON.stringify({ model: 'llama3.2', message: { role: 'assistant', content: 'A' }, done: false }),
      JSON.stringify({ model: 'llama3.2', done: true }),
    ]);

    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const chunks: string[] = [];
    await adapter.stream(MESSAGES, 'llama3.2', '', {}, c => chunks.push(c));

    expect(chunks).toEqual(['A']);
  });
});

// ── completeWithLogprobs() ────────────────────────────────────────────────────

describe('OllamaAdapter.completeWithLogprobs', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns logprobs when Ollama provides them', async () => {
    const logprobs = [{ token: '4', logprob: -0.01 }];
    mockFetch({
      model: 'llama3.2',
      message: { role: 'assistant', content: '4' },
      done: true,
      prompt_eval_count: 5,
      eval_count: 1,
      logprobs,
    });

    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const result = await adapter.completeWithLogprobs(MESSAGES, 'llama3.2');

    expect(result.logprobs).toEqual(logprobs);
    expect(result.eval_count).toBe(1);
  });

  it('returns undefined logprobs when Ollama does not provide them', async () => {
    mockFetch({
      model: 'llama3.2',
      message: { role: 'assistant', content: '4' },
      done: true,
    });

    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' });
    const result = await adapter.completeWithLogprobs(MESSAGES, 'llama3.2');

    expect(result.logprobs).toBeUndefined();
  });

  it('requests logprobs:true in options payload', async () => {
    const spy = mockFetch({
      model: 'llama3.2',
      message: { role: 'assistant', content: 'x' },
      done: true,
    });

    const adapter = new OllamaAdapter({ baseUrl: 'http://localhost:11434' });
    await adapter.completeWithLogprobs(MESSAGES, 'llama3.2');

    const body = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1]?.body as string);
    expect(body.options?.logprobs).toBe(true);
  });
});
