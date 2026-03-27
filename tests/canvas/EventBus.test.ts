// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// tests/canvas/EventBus.test.ts — JAL-013 EventBus unit tests

import { EventBus } from '../../src/apex/canvas/EventBus';
import { CanvasEvent } from '../../src/apex/types';

function makeEvent(type: CanvasEvent['event_type'] = 'heartbeat.pulse'): CanvasEvent {
  return {
    event_id: '00000000-0000-0000-0000-000000000001',
    event_type: type,
    task_id: null,
    tier: null,
    created_at: new Date().toISOString(),
    payload: { test: true },
  };
}

describe('EventBus', () => {
  it('delivers published events to subscribers', () => {
    const bus = new EventBus();
    const received: CanvasEvent[] = [];
    bus.subscribe(e => received.push(e));
    const event = makeEvent();
    bus.publish(event);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it('delivers to multiple subscribers', () => {
    const bus = new EventBus();
    const a: CanvasEvent[] = [];
    const b: CanvasEvent[] = [];
    bus.subscribe(e => a.push(e));
    bus.subscribe(e => b.push(e));
    bus.publish(makeEvent('task.started'));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('unsubscribed listener no longer receives events', () => {
    const bus = new EventBus();
    const received: CanvasEvent[] = [];
    const listener = (e: CanvasEvent) => received.push(e);
    bus.subscribe(listener);
    bus.publish(makeEvent());
    bus.unsubscribe(listener);
    bus.publish(makeEvent());
    expect(received).toHaveLength(1);
  });

  it('clear() removes all listeners', () => {
    const bus = new EventBus();
    const received: CanvasEvent[] = [];
    bus.subscribe(e => received.push(e));
    bus.subscribe(e => received.push(e));
    bus.clear();
    bus.publish(makeEvent());
    expect(received).toHaveLength(0);
  });

  it('publishes events in order', () => {
    const bus = new EventBus();
    const types: string[] = [];
    bus.subscribe(e => types.push(e.event_type));
    bus.publish(makeEvent('task.started'));
    bus.publish(makeEvent('command.output'));
    bus.publish(makeEvent('task.completed'));
    expect(types).toEqual(['task.started', 'command.output', 'task.completed']);
  });
});
