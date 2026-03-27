// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/routes/policyRoutes.ts — JAL-013 GET /policy/allowlist
//
// Returns the versioned package allowlist (entries + metadata).

import * as http from 'http';
import { PackageAllowlist } from '../../policy/PackageAllowlist';
import { sendJson } from './statusRoutes';

// ── PolicyRouteDeps ───────────────────────────────────────────────────────────

export interface PolicyRouteDeps {
  allowlist: PackageAllowlist;
}

// ── handleAllowlist ───────────────────────────────────────────────────────────

export function handleAllowlist(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: PolicyRouteDeps,
): void {
  try {
    const data = deps.allowlist.list();
    sendJson(res, 200, { success: true, data });
  } catch (err) {
    sendJson(res, 500, { success: false, error: (err as Error).message });
  }
}
