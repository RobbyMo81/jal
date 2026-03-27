// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/routes/taskRoutes.ts — JAL-013 GET /tasks
//
// Returns recent task checkpoints (up to 20), sorted by updated_at descending.
// Omits tool_outputs_ref to keep response size bounded — callers retrieve
// full output blobs via the checkpoint store directly if needed.

import * as http from 'http';
import { CheckpointStore } from '../../checkpoint/CheckpointStore';
import { sendJson } from './statusRoutes';

// ── TaskRouteDeps ─────────────────────────────────────────────────────────────

export interface TaskRouteDeps {
  checkpointStore: CheckpointStore;
}

const MAX_TASKS = 20;

// ── handleTasks ───────────────────────────────────────────────────────────────

export function handleTasks(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: TaskRouteDeps,
): void {
  try {
    const taskIds = deps.checkpointStore.list();

    // Load each checkpoint, omit large tool_outputs_ref blob
    const tasks = taskIds
      .map(id => deps.checkpointStore.load(id))
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, MAX_TASKS)
      .map(({ tool_outputs_ref: _omit, ...summary }) => summary);

    sendJson(res, 200, { success: true, data: tasks });
  } catch (err) {
    sendJson(res, 500, { success: false, error: (err as Error).message });
  }
}
