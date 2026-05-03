import { CircuitBreaker } from '../../src/apex/providers/CircuitBreaker';

describe('CircuitBreaker', () => {
  it('starts CLOSED', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.isOpen()).toBe(false);
    expect(cb.isAvailable()).toBe(true);
  });

  it('opens after failureThreshold failures', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 3, failureWindowMs: 5000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('CLOSED');
    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');
    expect(cb.isOpen()).toBe(true);
    expect(cb.isAvailable()).toBe(false);
  });

  it('transitions OPEN → HALF_OPEN after recoveryMs', () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker('test', { failureThreshold: 2, recoveryMs: 500 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');

    jest.advanceTimersByTime(600);
    expect(cb.getState()).toBe('HALF_OPEN');
    expect(cb.isAvailable()).toBe(true);
    jest.useRealTimers();
  });

  it('closes on success from HALF_OPEN', () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker('test', { failureThreshold: 2, recoveryMs: 500 });
    cb.recordFailure();
    cb.recordFailure();
    jest.advanceTimersByTime(600);
    expect(cb.getState()).toBe('HALF_OPEN');
    cb.recordSuccess();
    expect(cb.getState()).toBe('CLOSED');
    jest.useRealTimers();
  });

  it('re-opens on failure from HALF_OPEN', () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker('test', { failureThreshold: 2, recoveryMs: 500 });
    cb.recordFailure();
    cb.recordFailure();
    jest.advanceTimersByTime(600);
    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');
    jest.useRealTimers();
  });

  it('resets failure window when failures are old', () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker('test', { failureThreshold: 3, failureWindowMs: 1000 });
    cb.recordFailure();
    cb.recordFailure();
    jest.advanceTimersByTime(2000); // old failures expire
    cb.recordFailure(); // only 1 fresh failure
    expect(cb.getState()).toBe('CLOSED');
    jest.useRealTimers();
  });

  it('clears failure window on success', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.getState()).toBe('CLOSED'); // 1 failure after success reset
  });
});
