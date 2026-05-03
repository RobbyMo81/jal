import { GeminiAdapter } from '../../src/apex/auth/GeminiAdapter';

const adapter = new GeminiAdapter();
const messages = [{ role: 'user' as const, content: 'What is 2+2?' }];

describe('GeminiAdapter', () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  it('has provider = "gemini"', () => {
    expect(adapter.provider).toBe('gemini');
  });

  it('complete() POSTs to Gemini API', async () => {
    const mockResponse = {
      candidates: [{ content: { parts: [{ text: '4' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
      modelVersion: 'gemini-2.0-flash',
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }) as unknown as typeof fetch;

    const result = await adapter.complete(messages, 'gemini-2.0-flash', 'gkey', {});
    expect(result.content).toBe('4');
    expect(result.provider).toBe('gemini');
    expect(result.usage!.input_tokens).toBe(3);

    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('/gemini-2.0-flash:generateContent');
    expect(url).toContain('key=gkey');
  });

  it('throws when no candidates returned', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ candidates: [] }),
    }) as unknown as typeof fetch;
    await expect(adapter.complete(messages, 'gemini-2.0-flash', 'k', {}))
      .rejects.toThrow('no candidates');
  });

  it('stream() emits full content as one chunk', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'four' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
    }) as unknown as typeof fetch;

    const chunks: string[] = [];
    const result = await adapter.stream(messages, 'gemini-2.0-flash', 'k', {}, c => chunks.push(c));
    expect(result.content).toBe('four');
    expect(chunks).toEqual(['four']);
  });

  it('passes systemInstruction when system message present', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: {},
      }),
    }) as unknown as typeof fetch;

    await adapter.complete(
      [{ role: 'system', content: 'Be concise' }, { role: 'user', content: 'hi' }],
      'gemini-2.0-flash', 'k', {}
    );

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body as string);
    expect(body.systemInstruction?.parts[0]?.text).toBe('Be concise');
    expect(body.contents[0].role).toBe('user');
  });

  it('throws on non-ok HTTP response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('rate limit'),
    }) as unknown as typeof fetch;
    await expect(adapter.complete(messages, 'gemini-2.0-flash', 'k', {}))
      .rejects.toThrow('Gemini API 429');
  });
});
