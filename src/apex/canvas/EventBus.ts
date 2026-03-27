// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/EventBus.ts — JAL-013 Canvas Event Bus
//
// Decouples ApexRuntime (publisher) from CanvasServer (subscriber).
// ApexRuntime calls publish() whenever a Canvas-relevant event occurs.
// CanvasServer subscribes via subscribe() and fans the event out to all
// connected WebSocket clients.
//
// EventBus is a simple typed wrapper around Node's EventEmitter.
// No persistence — events are fire-and-forget.

import { EventEmitter } from 'events';
import { CanvasEvent } from '../types';

const CANVAS_EVENT = 'canvas_event';

// ── EventBus ──────────────────────────────────────────────────────────────────

export class EventBus {
  private readonly emitter = new EventEmitter();

  /**
   * Publish an event to all subscribers.
   * Payload must never contain credentials, tokens, or raw secrets.
   */
  publish(event: CanvasEvent): void {
    this.emitter.emit(CANVAS_EVENT, event);
  }

  /** Register a listener for all Canvas events. */
  subscribe(listener: (event: CanvasEvent) => void): void {
    this.emitter.on(CANVAS_EVENT, listener);
  }

  /** Unregister a previously registered listener. */
  unsubscribe(listener: (event: CanvasEvent) => void): void {
    this.emitter.off(CANVAS_EVENT, listener);
  }

  /** Remove all listeners (used during shutdown). */
  clear(): void {
    this.emitter.removeAllListeners(CANVAS_EVENT);
  }
}
