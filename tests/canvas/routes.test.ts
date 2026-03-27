// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// tests/canvas/routes.test.ts — JAL-013 Route handler unit tests
//
// Tests route handlers in isolation using mock http request/response objects.

import * as http from 'http';
import { EventEmitter } from 'events';
import { handleStatus } from '../../src/apex/canvas/routes/statusRoutes';
import { handleTasks } from '../../src/apex/canvas/routes/taskRoutes';
import { handleEpisodic, handleDurable } from '../../src/apex/canvas/routes/memoryRoutes';
import { handleAllowlist } from '../../src/apex/canvas/routes/policyRoutes';
import { handleApprove, handleDeny, isAuthorized } from '../../src/apex/canvas/routes/approvalRoutes';
import { EnvironmentSnapshot } from '../../src/apex/types';

// ── Mock http.ServerResponse ──────────────────────────────────────────────────

interface MockResponse {
  statusCode: number;
  headers: Record<string, string | number>;
  body: string;
}

function makeMockResponse(): { res: http.ServerResponse; result: MockResponse } {
  const result: MockResponse = { statusCode: 200, headers: {}, body: '' };
  const res = new EventEmitter() as unknown as http.ServerResponse;
  (res as unknown as Record<string, unknown>).writeHead = (
    status: number,
    headers: Record<string, string | number>,
  ) => {
    result.statusCode = status;
    result.headers = headers;
  };
  (res as unknown as Record<string, unknown>).end = (data: string) => {
    result.body = data;
  };
  return { res, result };
}

function makeReq(
  method = 'GET',
  url = '/',
  headers: Record<string, string> = {},
): http.IncomingMessage {
  const req = new EventEmitter() as unknown as http.IncomingMessage;
  (req as unknown as Record<string, unknown>).method = method;
  (req as unknown as Record<string, unknown>).url = url;
  (req as unknown as Record<string, unknown>).headers = headers;
  return req;
}

// ── Stub deps ─────────────────────────────────────────────────────────────────

const stubSnapshot: EnvironmentSnapshot = {
  captured_at: '2026-03-27T00:00:00.000Z',
  processes: [],
  containers: [],
  disk_mounts: [],
  available_memory_mb: 1024,
  network_connections: [],
};

// ── handleStatus ──────────────────────────────────────────────────────────────

describe('handleStatus', () => {
  it('returns 200 with snapshot data', () => {
    const { res, result } = makeMockResponse();
    handleStatus(makeReq(), res, { getSnapshot: () => stubSnapshot });
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.data.available_memory_mb).toBe(1024);
  });

  it('returns 500 on getSnapshot error', () => {
    const { res, result } = makeMockResponse();
    handleStatus(makeReq(), res, {
      getSnapshot: () => { throw new Error('snapshot failed'); },
    });
    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('snapshot failed');
  });
});

// ── handleTasks ───────────────────────────────────────────────────────────────

describe('handleTasks', () => {
  it('returns 200 with empty list when no checkpoints', () => {
    const { res, result } = makeMockResponse();
    const checkpointStore = {
      list: () => [] as string[],
      load: (_id: string) => null,
    };
    handleTasks(makeReq(), res, { checkpointStore: checkpointStore as never });
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  it('omits tool_outputs_ref from task summaries', () => {
    const { res, result } = makeMockResponse();
    const checkpoint = {
      schema_version: 1,
      task_id: 'task-1',
      goal: 'test goal',
      current_step: 0,
      step_status: 'completed' as const,
      steps: [],
      pending_approvals: [],
      tool_outputs_ref: { 'step-0': { hash: 'abc', size_bytes: 100 } },
      policy_snapshot_hash: 'hash',
      updated_at: '2026-03-27T00:00:00.000Z',
    };
    const checkpointStore = {
      list: () => ['task-1'],
      load: (_id: string) => checkpoint,
    };
    handleTasks(makeReq(), res, { checkpointStore: checkpointStore as never });
    const body = JSON.parse(result.body);
    expect(body.data[0].tool_outputs_ref).toBeUndefined();
    expect(body.data[0].task_id).toBe('task-1');
  });
});

// ── handleEpisodic & handleDurable ────────────────────────────────────────────

describe('handleEpisodic', () => {
  it('returns 200 with items from apex_system workspace', () => {
    const { res, result } = makeMockResponse();
    const item = {
      id: 'item-1', tier: 'episodic', content: 'test', tags: [],
      workspace_id: 'apex_system', session_id: 'sess',
      created_at: '2026-03-27T00:00:00.000Z',
      last_accessed_at: '2026-03-27T00:00:00.000Z',
      access_count: 0, size_bytes: 4,
    };
    const episodicStore = { list: (_ws: string) => [item] };
    const durableStore = { list: () => [] };
    handleEpisodic(makeReq(), res, {
      episodicStore: episodicStore as never,
      durableStore: durableStore as never,
    });
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('item-1');
  });
});

describe('handleDurable', () => {
  it('returns 200 with all durable items', () => {
    const { res, result } = makeMockResponse();
    const item = {
      id: 'durable-1', tier: 'durable', content: 'durable content', tags: ['heartbeat'],
      workspace_id: 'apex_system', session_id: 'sess',
      created_at: '2026-03-27T00:00:00.000Z',
      last_accessed_at: '2026-03-27T00:00:00.000Z',
      access_count: 0, size_bytes: 14,
    };
    const episodicStore = { list: (_ws: string) => [] };
    const durableStore = { list: () => [item] };
    handleDurable(makeReq(), res, {
      episodicStore: episodicStore as never,
      durableStore: durableStore as never,
    });
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.data[0].id).toBe('durable-1');
  });
});

// ── handleAllowlist ───────────────────────────────────────────────────────────

describe('handleAllowlist', () => {
  it('returns 200 with allowlist data', () => {
    const { res, result } = makeMockResponse();
    const allowlist = {
      list: () => ({ version: 1, updated_at: '2026-03-27T00:00:00.000Z', entries: [] }),
    };
    handleAllowlist(makeReq(), res, { allowlist: allowlist as never });
    const body = JSON.parse(result.body);
    expect(body.success).toBe(true);
    expect(body.data.version).toBe(1);
  });
});

// ── isAuthorized ──────────────────────────────────────────────────────────────

describe('isAuthorized', () => {
  const token = 'abc123secret';

  it('accepts valid Bearer token', () => {
    const req = makeReq('POST', '/', { authorization: `Bearer ${token}` });
    expect(isAuthorized(req, token)).toBe(true);
  });

  it('rejects missing Authorization header', () => {
    const req = makeReq('POST', '/', {});
    expect(isAuthorized(req, token)).toBe(false);
  });

  it('rejects wrong token', () => {
    const req = makeReq('POST', '/', { authorization: 'Bearer wrongtoken' });
    expect(isAuthorized(req, token)).toBe(false);
  });

  it('rejects Bearer prefix without token', () => {
    const req = makeReq('POST', '/', { authorization: 'Bearer ' });
    expect(isAuthorized(req, token)).toBe(false);
  });
});

// ── handleApprove / handleDeny ────────────────────────────────────────────────

describe('handleApprove', () => {
  const token = 'valid-session-token';

  it('returns 401 without correct token', () => {
    const { res, result } = makeMockResponse();
    const approvalService = { resolve: jest.fn() };
    handleApprove(makeReq('POST', '/', {}), res, {
      approvalService: approvalService as never,
      sessionToken: token,
    }, 'approval-1');
    expect(result.statusCode).toBe(401);
    expect(approvalService.resolve).not.toHaveBeenCalled();
  });

  it('returns 404 when approval not found', () => {
    const { res, result } = makeMockResponse();
    const approvalService = { resolve: jest.fn().mockReturnValue(false) };
    handleApprove(
      makeReq('POST', '/', { authorization: `Bearer ${token}` }),
      res,
      { approvalService: approvalService as never, sessionToken: token },
      'nonexistent-id',
    );
    expect(result.statusCode).toBe(404);
  });

  it('returns 200 when approval resolved successfully', () => {
    const { res, result } = makeMockResponse();
    const approvalService = { resolve: jest.fn().mockReturnValue(true) };
    handleApprove(
      makeReq('POST', '/', { authorization: `Bearer ${token}` }),
      res,
      { approvalService: approvalService as never, sessionToken: token },
      'approval-1',
    );
    expect(result.statusCode).toBe(200);
    expect(approvalService.resolve).toHaveBeenCalledWith('approval-1', true);
    const body = JSON.parse(result.body);
    expect(body.data.decision).toBe('approved');
  });
});

describe('handleDeny', () => {
  const token = 'valid-session-token';

  it('returns 401 without correct token', () => {
    const { res, result } = makeMockResponse();
    const approvalService = { resolve: jest.fn() };
    handleDeny(makeReq('POST', '/', {}), res, {
      approvalService: approvalService as never,
      sessionToken: token,
    }, 'approval-1');
    expect(result.statusCode).toBe(401);
  });

  it('calls resolve with false and returns denied', () => {
    const { res, result } = makeMockResponse();
    const approvalService = { resolve: jest.fn().mockReturnValue(true) };
    handleDeny(
      makeReq('POST', '/', { authorization: `Bearer ${token}` }),
      res,
      { approvalService: approvalService as never, sessionToken: token },
      'approval-1',
    );
    expect(approvalService.resolve).toHaveBeenCalledWith('approval-1', false);
    const body = JSON.parse(result.body);
    expect(body.data.decision).toBe('denied');
  });
});
