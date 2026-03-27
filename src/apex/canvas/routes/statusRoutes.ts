// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/routes/statusRoutes.ts — JAL-013 GET /status
//
// Returns the current environment snapshot as a JSON response.
// Snapshot is collected synchronously; SnapshotCollector is read-only.

import * as http from 'http';
import { EnvironmentSnapshot } from '../../types';

// ── StatusRouteDeps ───────────────────────────────────────────────────────────

export interface StatusRouteDeps {
  getSnapshot: () => EnvironmentSnapshot;
}

// ── handleStatus ──────────────────────────────────────────────────────────────

export function handleStatus(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: StatusRouteDeps,
): void {
  try {
    const snapshot = deps.getSnapshot();
    sendJson(res, 200, { success: true, data: snapshot });
  } catch (err) {
    sendJson(res, 500, { success: false, error: (err as Error).message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
