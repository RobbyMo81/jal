// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// tests/canvas/CanvasServer.test.ts — JAL-013 CanvasServer integration tests
//
// Starts a real HTTP+WebSocket server on a random port and verifies:
//   - WebSocket auth (valid token accepted, invalid rejected)
//   - Initial system.status snapshot sent on connect
//   - EventBus events fanned out to connected clients
//   - REST endpoints return correct responses
//   - Approval endpoints require session token

import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocket } from 'ws';
import { CanvasServer } from '../../src/apex/canvas/CanvasServer';
import { EventBus } from '../../src/apex/canvas/EventBus';
import { makeCanvasEvent } from '../../src/apex/canvas/CanvasServer';
import { NoOpAuditLog } from '../../src/apex/policy/AuditLog';
import { ApprovalService } from '../../src/apex/policy/ApprovalService';
import { CheckpointStore } from '../../src/apex/checkpoint/CheckpointStore';
import { EpisodicStore } from '../../src/apex/memory/EpisodicStore';
import { DurableStore } from '../../src/apex/memory/DurableStore';
import { PackageAllowlist } from '../../src/apex/policy/PackageAllowlist';
import { EnvironmentSnapshot } from '../../src/apex/types';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const SESSION_TOKEN = 'test-session-token-64chars-abc123def456789012345678901234567890';

const STUB_SNAPSHOT: EnvironmentSnapshot = {
  captured_at: '2026-03-27T00:00:00.000Z',
  processes: [{ pid: 1, name: 'init', cpu_percent: 0.1, mem_percent: 0.5, status: 'S' }],
  containers: [],
  disk_mounts: [{ mount: '/', total_bytes: 100, used_bytes: 50, avail_bytes: 50, use_percent: 50 }],
  available_memory_mb: 2048,
  network_connections: [],
};

let stateDir: string;

function makeTestServer(): { server: CanvasServer; port: number } {
  const eventBus = new EventBus();
  const approvalService = new ApprovalService();
  const checkpointStore = new CheckpointStore(stateDir);
  const episodicStore = new EpisodicStore(stateDir);
  const durableStore = new DurableStore(stateDir);
  const allowlist = new PackageAllowlist(new NoOpAuditLog());

  // Use port 0 so OS assigns a random free port
  const server = new CanvasServer(
    {
      sessionToken: SESSION_TOKEN,
      eventBus,
      approvalService,
      checkpointStore,
      episodicStore,
      durableStore,
      allowlist,
      auditLog: new NoOpAuditLog(),
      getSnapshot: () => STUB_SNAPSHOT,
    },
    { port: 0, host: '127.0.0.1' },
  );
  // Port is determined after start() — we'll query it then
  return { server, port: 0 };
}

function getServerPort(server: CanvasServer): number {
  // Access the private httpServer via type cast to read the bound port
  const httpServer = (server as unknown as Record<string, unknown>)['httpServer'] as http.Server | null;
  if (!httpServer) throw new Error('Server not started');
  const addr = httpServer.address();
  if (!addr || typeof addr !== 'object') throw new Error('Could not get port');
  return addr.port;
}

function wsUrl(port: number, token: string): string {
  return `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
      });
    });
    req.on('error', reject);
  });
}

function httpPost(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Length': '0', ...headers },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-server-test-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// ── WebSocket auth ────────────────────────────────────────────────────────────

describe('CanvasServer — WebSocket authentication', () => {
  it('rejects WebSocket connections with wrong token', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(port, 'wrong-token'));
        ws.on('error', () => resolve());   // connection refused / closed → expected
        ws.on('unexpected-response', () => resolve());
        ws.on('open', () => {
          ws.close();
          reject(new Error('Should have been rejected'));
        });
      });
    } finally {
      await server.stop();
    }
  });

  it('accepts WebSocket connections with correct token', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(port, SESSION_TOKEN));
        ws.on('open', () => { ws.close(); resolve(); });
        ws.on('error', reject);
      });
    } finally {
      await server.stop();
    }
  });
});

// ── Initial snapshot ──────────────────────────────────────────────────────────

describe('CanvasServer — initial snapshot on connect', () => {
  it('sends system.status event as first message after connect', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const firstMessage = await new Promise<unknown>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(port, SESSION_TOKEN));
        ws.on('message', (data) => {
          ws.close();
          resolve(JSON.parse(data.toString()));
        });
        ws.on('error', reject);
      });
      const event = firstMessage as Record<string, unknown>;
      expect(event['event_type']).toBe('system.status');
      expect(event['event_id']).toBeDefined();
      expect(event['created_at']).toBeDefined();
      const payload = event['payload'] as Record<string, unknown>;
      expect(payload['available_memory_mb']).toBe(2048);
    } finally {
      await server.stop();
    }
  });
});

// ── EventBus fan-out ──────────────────────────────────────────────────────────

describe('CanvasServer — EventBus fan-out', () => {
  it('broadcasts EventBus events to connected clients', async () => {
    const eventBus = new EventBus();
    const approvalService = new ApprovalService();
    const server = new CanvasServer(
      {
        sessionToken: SESSION_TOKEN,
        eventBus,
        approvalService,
        checkpointStore: new CheckpointStore(stateDir),
        episodicStore: new EpisodicStore(stateDir),
        durableStore: new DurableStore(stateDir),
        allowlist: new PackageAllowlist(new NoOpAuditLog()),
        auditLog: new NoOpAuditLog(),
        getSnapshot: () => STUB_SNAPSHOT,
      },
      { port: 0, host: '127.0.0.1' },
    );
    await server.start();
    const port = getServerPort(server);
    try {
      const received: unknown[] = [];
      const ws = new WebSocket(wsUrl(port, SESSION_TOKEN));

      // Wait for connect + initial snapshot
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });
      // Drain the initial snapshot message
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      ws.removeAllListeners('message');

      // Now watch for the broadcast
      const broadcastPromise = new Promise<void>((resolve) => {
        ws.on('message', (data) => {
          received.push(JSON.parse(data.toString()));
          resolve();
        });
      });

      const event = makeCanvasEvent('task.started', { goal: 'test goal' }, 'task-99', 1);
      eventBus.publish(event);
      await broadcastPromise;
      ws.close();

      expect(received).toHaveLength(1);
      const msg = received[0] as Record<string, unknown>;
      expect(msg['event_type']).toBe('task.started');
      expect(msg['task_id']).toBe('task-99');
    } finally {
      await server.stop();
    }
  });
});

// ── REST endpoints ────────────────────────────────────────────────────────────

describe('CanvasServer — REST GET /status', () => {
  it('returns 200 with system snapshot', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const { status, body } = await httpGet(port, '/status');
      expect(status).toBe(200);
      expect((body as Record<string, unknown>)['success']).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

describe('CanvasServer — REST GET /tasks', () => {
  it('returns 200 with empty list when no checkpoints', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const { status, body } = await httpGet(port, '/tasks');
      expect(status).toBe(200);
      expect((body as Record<string, unknown>)['data']).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});

describe('CanvasServer — REST GET /memory/episodic', () => {
  it('returns 200 with empty list', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const { status, body } = await httpGet(port, '/memory/episodic');
      expect(status).toBe(200);
      expect(Array.isArray((body as Record<string, unknown>)['data'])).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

describe('CanvasServer — REST GET /memory/durable', () => {
  it('returns 200 with empty list', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const { status, body } = await httpGet(port, '/memory/durable');
      expect(status).toBe(200);
      expect(Array.isArray((body as Record<string, unknown>)['data'])).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

describe('CanvasServer — REST GET /policy/allowlist', () => {
  it('returns 200 with allowlist', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const { status, body } = await httpGet(port, '/policy/allowlist');
      expect(status).toBe(200);
      expect((body as Record<string, unknown>)['success']).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

describe('CanvasServer — REST /approvals', () => {
  it('POST /approvals/:id/approve returns 401 without token', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const { status } = await httpPost(port, '/approvals/some-id/approve');
      expect(status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  it('POST /approvals/:id/deny returns 401 without token', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const { status } = await httpPost(port, '/approvals/some-id/deny');
      expect(status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  it('POST /approvals/:id/approve returns 404 for non-existent approval (with valid token)', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const { status } = await httpPost(port, '/approvals/nonexistent/approve', {
        authorization: `Bearer ${SESSION_TOKEN}`,
      });
      expect(status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it('POST /approvals/:id/approve returns 200 for real pending approval', async () => {
    const eventBus = new EventBus();
    const approvalService = new ApprovalService();
    const server = new CanvasServer(
      {
        sessionToken: SESSION_TOKEN,
        eventBus,
        approvalService,
        checkpointStore: new CheckpointStore(stateDir),
        episodicStore: new EpisodicStore(stateDir),
        durableStore: new DurableStore(stateDir),
        allowlist: new PackageAllowlist(new NoOpAuditLog()),
        auditLog: new NoOpAuditLog(),
        getSnapshot: () => STUB_SNAPSHOT,
      },
      { port: 0, host: '127.0.0.1' },
    );
    await server.start();
    const port = getServerPort(server);
    try {
      const { token } = approvalService.requestApproval(
        'shell.exec', { cmd: 'ls' }, 2, 'testing approval'
      );
      const { status, body } = await httpPost(port, `/approvals/${token.id}/approve`, {
        authorization: `Bearer ${SESSION_TOKEN}`,
      });
      expect(status).toBe(200);
      const data = (body as Record<string, unknown>)['data'] as Record<string, unknown>;
      expect(data['decision']).toBe('approved');
    } finally {
      await server.stop();
    }
  });
});

// ── 404 for unknown routes ────────────────────────────────────────────────────

describe('CanvasServer — 404 for unknown routes', () => {
  it('returns 404 for unknown path', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const { status } = await httpGet(port, '/unknown/path');
      expect(status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

// ── makeCanvasEvent ───────────────────────────────────────────────────────────

describe('makeCanvasEvent', () => {
  it('creates event with UUID and timestamp', () => {
    const event = makeCanvasEvent('heartbeat.pulse', { count: 1 }, 'task-1', 1);
    expect(event.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.event_type).toBe('heartbeat.pulse');
    expect(event.task_id).toBe('task-1');
    expect(event.tier).toBe(1);
    expect(event.payload['count']).toBe(1);
    expect(event.created_at).toBeDefined();
  });

  it('defaults task_id and tier to null', () => {
    const event = makeCanvasEvent('system.status', {});
    expect(event.task_id).toBeNull();
    expect(event.tier).toBeNull();
  });
});

// ── setSessionToken ───────────────────────────────────────────────────────────

describe('CanvasServer — setSessionToken', () => {
  it('allows setting token after construction', async () => {
    const eventBus = new EventBus();
    const newToken = 'new-token-after-construction';
    const server = new CanvasServer(
      {
        sessionToken: '',   // empty at construction
        eventBus,
        approvalService: new ApprovalService(),
        checkpointStore: new CheckpointStore(stateDir),
        episodicStore: new EpisodicStore(stateDir),
        durableStore: new DurableStore(stateDir),
        allowlist: new PackageAllowlist(new NoOpAuditLog()),
        auditLog: new NoOpAuditLog(),
        getSnapshot: () => STUB_SNAPSHOT,
      },
      { port: 0, host: '127.0.0.1' },
    );
    server.setSessionToken(newToken);
    await server.start();
    const port = getServerPort(server);
    try {
      // Old empty token should fail
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(port, ''));
        ws.on('error', () => resolve());
        ws.on('unexpected-response', () => resolve());
        ws.on('open', () => { ws.close(); reject(new Error('Should have been rejected')); });
      });
      // New token should succeed
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(port, newToken));
        ws.on('open', () => { ws.close(); resolve(); });
        ws.on('error', reject);
      });
    } finally {
      await server.stop();
    }
  });
});
