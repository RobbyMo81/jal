// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/routes/approvalRoutes.ts — JAL-013 POST /approvals/:id/approve|deny
//
// SAFETY GATE: session token required in Authorization header (Bearer scheme).
// Approval tokens are single-use (ApprovalService enforces this).
// Returns 401 if token missing/wrong, 404 if approval ID not found, 200 on success.

import * as http from 'http';
import { ApprovalService } from '../../policy/ApprovalService';
import { sendJson } from './statusRoutes';

// ── ApprovalRouteDeps ─────────────────────────────────────────────────────────

export interface ApprovalRouteDeps {
  approvalService: ApprovalService;
  sessionToken: string;
}

// ── Token validation ──────────────────────────────────────────────────────────

/** Returns true when the Authorization header carries the correct session token. */
export function isAuthorized(req: http.IncomingMessage, sessionToken: string): boolean {
  const header = req.headers['authorization'] ?? '';
  // Accept both "Bearer <token>" and raw token for flexibility
  const parts = header.split(' ');
  const provided = parts.length === 2 && parts[0]!.toLowerCase() === 'bearer'
    ? parts[1]!
    : header;
  return provided === sessionToken;
}

// ── handleApprove ─────────────────────────────────────────────────────────────

export function handleApprove(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ApprovalRouteDeps,
  approvalId: string,
): void {
  if (!isAuthorized(req, deps.sessionToken)) {
    sendJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  const resolved = deps.approvalService.resolve(approvalId, true);
  if (!resolved) {
    sendJson(res, 404, { success: false, error: 'Approval not found or already resolved' });
    return;
  }
  sendJson(res, 200, { success: true, data: { approval_id: approvalId, decision: 'approved' } });
}

// ── handleDeny ────────────────────────────────────────────────────────────────

export function handleDeny(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ApprovalRouteDeps,
  approvalId: string,
): void {
  if (!isAuthorized(req, deps.sessionToken)) {
    sendJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  const resolved = deps.approvalService.resolve(approvalId, false);
  if (!resolved) {
    sendJson(res, 404, { success: false, error: 'Approval not found or already resolved' });
    return;
  }
  sendJson(res, 200, { success: true, data: { approval_id: approvalId, decision: 'denied' } });
}
