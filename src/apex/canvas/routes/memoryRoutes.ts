// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/routes/memoryRoutes.ts — JAL-013 GET /memory/episodic + /memory/durable
//
// Episodic: returns the 20 most-recent items from the apex_system workspace.
// Durable:  returns all durable context items (user-approved, persistent).

import * as http from 'http';
import { EpisodicStore } from '../../memory/EpisodicStore';
import { DurableStore } from '../../memory/DurableStore';
import { sendJson } from './statusRoutes';

// ── MemoryRouteDeps ───────────────────────────────────────────────────────────

export interface MemoryRouteDeps {
  episodicStore: EpisodicStore;
  durableStore: DurableStore;
}

const APEX_WORKSPACE_ID = 'apex_system';
const EPISODIC_LIMIT = 20;

// ── handleEpisodic ────────────────────────────────────────────────────────────

export function handleEpisodic(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: MemoryRouteDeps,
): void {
  try {
    const items = deps.episodicStore
      .list(APEX_WORKSPACE_ID)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, EPISODIC_LIMIT);

    sendJson(res, 200, { success: true, data: items });
  } catch (err) {
    sendJson(res, 500, { success: false, error: (err as Error).message });
  }
}

// ── handleDurable ─────────────────────────────────────────────────────────────

export function handleDurable(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: MemoryRouteDeps,
): void {
  try {
    const items = deps.durableStore.list();
    sendJson(res, 200, { success: true, data: items });
  } catch (err) {
    sendJson(res, 500, { success: false, error: (err as Error).message });
  }
}
