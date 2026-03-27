// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/ui/src/hooks/useWebSocket.ts — JAL-014 WebSocket with exponential backoff reconnect
import { useEffect, useRef, useCallback, useState } from 'react';
import type { CanvasEvent, ConnectionStatus } from '../types';

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const BACKOFF_FACTOR = 2;

interface UseWebSocketOptions {
  /** WebSocket URL including session token query param */
  url: string;
  onEvent: (event: CanvasEvent) => void;
}

interface UseWebSocketResult {
  status: ConnectionStatus;
  /** Manually close the WebSocket and stop reconnecting */
  close: () => void;
}

/**
 * Manages a WebSocket connection with exponential backoff auto-reconnect.
 * SAFETY GATE: token is passed in via URL query param — never stored in localStorage.
 */
export function useWebSocket({ url, onEvent }: UseWebSocketOptions): UseWebSocketResult {
  const [status, setStatus] = useState<ConnectionStatus>('reconnecting');
  const wsRef = useRef<WebSocket | null>(null);
  const attemptsRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = useRef(false);

  const clearReconnectTimeout = (): void => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const connect = useCallback((): void => {
    if (closedRef.current) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      attemptsRef.current = 0;
      setStatus('connected');
    };

    ws.onmessage = (evt: MessageEvent<string>) => {
      try {
        const event = JSON.parse(evt.data) as CanvasEvent;
        onEvent(event);
      } catch {
        // malformed frame — ignore
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (closedRef.current) return;

      setStatus('reconnecting');
      const delay = Math.min(BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attemptsRef.current), MAX_DELAY_MS);
      attemptsRef.current += 1;
      timeoutRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onclose fires after onerror — reconnect handled there
      setStatus('reconnecting');
    };
  }, [url, onEvent]);

  useEffect(() => {
    closedRef.current = false;
    connect();

    return () => {
      closedRef.current = true;
      clearReconnectTimeout();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const close = useCallback((): void => {
    closedRef.current = true;
    clearReconnectTimeout();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus('disconnected');
  }, []);

  return { status, close };
}
