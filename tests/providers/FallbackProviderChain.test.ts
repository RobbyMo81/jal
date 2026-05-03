import { FallbackProviderChain } from '../../src/apex/providers/FallbackProviderChain';
import type { IProviderAdapter } from '../../src/apex/auth/ProviderGateway';
import type { GatewayMessage, CompletionOptions, CompletionResult } from '../../src/apex/types';

function makeAdapter(name: string, shouldFail = false): IProviderAdapter {
  return {
    provider: name,
    complete: jest.fn(async (_msgs, model, _token, _opts): Promise<CompletionResult> => {
      if (shouldFail) throw new Error(`${name} failed`);
      return { content: `${name} response`, model, provider: name, usage: { input_tokens: 1, output_tokens: 1 } };
    }),
    stream: jest.fn(async (_msgs, model, _token, _opts, onChunk): Promise<CompletionResult> => {
      if (shouldFail) throw new Error(`${name} stream failed`);
      onChunk(`${name} chunk`);
      return { content: `${name} chunk`, model, provider: name, usage: { input_tokens: 1, output_tokens: 1 } };
    }),
  };
}

const messages: GatewayMessage[] = [{ role: 'user', content: 'hello' }];
const opts: CompletionOptions = {};

describe('FallbackProviderChain', () => {
  it('requires at least one link', () => {
    expect(() => new FallbackProviderChain('test', [])).toThrow();
  });

  it('returns first link response when healthy', async () => {
    const a = makeAdapter('a');
    const b = makeAdapter('b');
    const chain = new FallbackProviderChain('c', [
      { adapter: a, model: 'ma', token: '' },
      { adapter: b, model: 'mb', token: '' },
    ]);
    const result = await chain.complete(messages, '', '', opts);
    expect(result.content).toBe('a response');
    expect(a.complete).toHaveBeenCalledTimes(1);
    expect(b.complete).not.toHaveBeenCalled();
  });

  it('falls back to second link when first fails', async () => {
    const a = makeAdapter('a', true);
    const b = makeAdapter('b');
    const chain = new FallbackProviderChain('c', [
      { adapter: a, model: 'ma', token: '' },
      { adapter: b, model: 'mb', token: '' },
    ]);
    const result = await chain.complete(messages, '', '', opts);
    expect(result.content).toBe('b response');
  });

  it('throws when all links fail', async () => {
    const a = makeAdapter('a', true);
    const b = makeAdapter('b', true);
    const chain = new FallbackProviderChain('c', [
      { adapter: a, model: 'ma', token: '' },
      { adapter: b, model: 'mb', token: '' },
    ]);
    await expect(chain.complete(messages, '', '', opts)).rejects.toThrow('exhausted all links');
  });

  it('skips OPEN breaker and tries next link', async () => {
    const a = makeAdapter('a', true);
    const b = makeAdapter('b');
    const chain = new FallbackProviderChain('c', [
      { adapter: a, model: 'ma', token: '', breakerOpts: { failureThreshold: 1 } },
      { adapter: b, model: 'mb', token: '' },
    ]);
    // Trip breaker on first call
    await chain.complete(messages, '', '', opts).catch(() => {});
    // Second call: a is OPEN, falls through to b
    const result = await chain.complete(messages, '', '', opts);
    expect(result.content).toBe('b response');
    expect(a.complete).toHaveBeenCalledTimes(1); // skipped on 2nd call
  });

  it('stream() falls through to second link', async () => {
    const a = makeAdapter('a', true);
    const b = makeAdapter('b');
    const chain = new FallbackProviderChain('c', [
      { adapter: a, model: 'ma', token: '' },
      { adapter: b, model: 'mb', token: '' },
    ]);
    const chunks: string[] = [];
    const result = await chain.stream(messages, '', '', opts, c => chunks.push(c));
    expect(result.content).toBe('b chunk');
    expect(chunks).toEqual(['b chunk']);
  });

  it('completeWithLogprobs() delegates to duck-typed method if available', async () => {
    const adapterWithLogprobs = {
      provider: 'ola',
      complete: jest.fn(),
      stream: jest.fn(),
      completeWithLogprobs: jest.fn(async () => ({
        content: 'logprob response',
        model: 'ola',
        provider: 'ola',
        usage: { input_tokens: 1, output_tokens: 1 },
        logprobs: [],
      })),
    };
    const chain = new FallbackProviderChain('c', [
      { adapter: adapterWithLogprobs as unknown as IProviderAdapter, model: 'm', token: '' },
    ]);
    const result = await chain.completeWithLogprobs(messages, '', {});
    expect(result.content).toBe('logprob response');
    expect(adapterWithLogprobs.completeWithLogprobs).toHaveBeenCalledTimes(1);
  });

  it('getBreakerStates() returns state for each link', () => {
    const chain = new FallbackProviderChain('c', [
      { adapter: makeAdapter('a'), model: 'ma', token: '' },
      { adapter: makeAdapter('b'), model: 'mb', token: '' },
    ]);
    const states = chain.getBreakerStates();
    expect(states).toHaveLength(2);
    expect(states[0]!.state).toBe('CLOSED');
  });
});
