import { OpenAIAdapter } from '../../src/apex/auth/OpenAIAdapter';

const adapter = new OpenAIAdapter();
const messages = [{ role: 'user' as const, content: 'Say hi' }];

describe('OpenAIAdapter', () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  it('has provider = "openai"', () => {
    expect(adapter.provider).toBe('openai');
  });

  it('complete() POSTs to /v1/chat/completions', async () => {
    const mockResponse = {
      id: 'chatcmpl-1',
      model: 'gpt-4o',
      choices: [{ message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }) as unknown as typeof fetch;

    const result = await adapter.complete(messages, 'gpt-4o', 'sk-test', {});
    expect(result.content).toBe('Hi!');
    expect(result.provider).toBe('openai');
    expect(result.usage!.input_tokens).toBe(5);
    expect(result.usage!.output_tokens).toBe(3);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as RequestInit).headers as Record<string,string>)
      .toMatchObject({ 'Authorization': 'Bearer sk-test' });
  });

  it('throws on non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('rate limit'),
    }) as unknown as typeof fetch;
    await expect(adapter.complete(messages, 'gpt-4o', 'sk', {})).rejects.toThrow('OpenAI API 429');
  });

  it('stream() collects SSE data chunks', async () => {
    const sse = [
      'data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{"content":"Hello"}}]}',
      'data: {"id":"c1","model":"gpt-4o","choices":[{"delta":{"content":" world"}}]}',
      'data: [DONE]',
    ].join('\n') + '\n';

    const encoder = new TextEncoder();
    let offset = 0;
    const readableStream = {
      getReader: () => ({
        read: jest.fn().mockImplementation(async () => {
          if (offset < sse.length) {
            const chunk = encoder.encode(sse.slice(offset));
            offset = sse.length;
            return { done: false, value: chunk };
          }
          return { done: true, value: undefined };
        }),
      }),
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: readableStream,
    }) as unknown as typeof fetch;

    const chunks: string[] = [];
    const result = await adapter.stream(messages, 'gpt-4o', 'sk', {}, c => chunks.push(c));
    expect(result.content).toBe('Hello world');
    expect(chunks).toEqual(['Hello', ' world']);
  });

  it('accepts custom baseUrl for compatible endpoints', () => {
    const custom = new OpenAIAdapter('http://localhost:1234');
    expect(custom.provider).toBe('openai');
  });
});
