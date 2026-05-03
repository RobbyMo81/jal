import { ClaudeAdapter } from '../../src/apex/auth/ClaudeAdapter';

const adapter = new ClaudeAdapter();
const messages = [{ role: 'user' as const, content: 'Hello' }];

describe('ClaudeAdapter', () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  it('has provider = "claude"', () => {
    expect(adapter.provider).toBe('claude');
  });

  it('complete() POSTs to Anthropic API and returns content', async () => {
    const mockResponse = {
      id: 'msg_1',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Hello there' }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: 'end_turn',
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }) as unknown as typeof fetch;

    const result = await adapter.complete(messages, 'claude-sonnet-4-6', 'sk-test', {});
    expect(result.content).toBe('Hello there');
    expect(result.provider).toBe('claude');
    expect(result.usage!.input_tokens).toBe(5);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init as RequestInit).headers as Record<string,string>)
      .toMatchObject({ 'x-api-key': 'sk-test' });
  });

  it('throws on non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    }) as unknown as typeof fetch;

    await expect(adapter.complete(messages, 'claude-sonnet-4-6', 'bad-key', {}))
      .rejects.toThrow('Claude API 401');
  });

  it('stream() collects SSE chunks', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":5}}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"!"}}',
      'data: {"type":"message_delta","usage":{"output_tokens":2}}',
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
    const result = await adapter.stream(messages, 'claude-sonnet-4-6', 'sk-test', {}, c => chunks.push(c));
    expect(result.content).toBe('Hi!');
    expect(chunks).toEqual(['Hi', '!']);
    expect(result.usage!.output_tokens).toBe(2);
  });

  it('splits system messages into system field', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        id: 'x', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      }),
    }) as unknown as typeof fetch;

    await adapter.complete(
      [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'hi' }],
      'claude-sonnet-4-6', 'sk', {}
    );

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body as string);
    expect(body.system).toBe('Be helpful');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
