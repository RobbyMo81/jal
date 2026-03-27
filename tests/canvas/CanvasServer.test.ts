// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// tests/canvas/CanvasServer.test.ts — JAL-013/JAL-014 CanvasServer integration tests
//
// Starts a real HTTP+WebSocket server on a random port and verifies:
//   - WebSocket auth (valid token accepted, invalid rejected)
//   - Initial system.status snapshot sent on connect
//   - EventBus events fanned out to connected clients
//   - REST endpoints return correct responses
//   - Approval endpoints require session token
//   - GET /canvas serves static files with token injection (JAL-014)

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

function httpGetRaw(port: number, pathname: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: pathname,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers as Record<string, string | string[] | undefined> });
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

// ── Initial snapshot on connect ───────────────────────────────────────────────

describe('CanvasServer — initial snapshot on WebSocket connect', () => {
  it('sends system.status as first message on connect', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const firstMessage = await new Promise<unknown>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(port, SESSION_TOKEN));
        ws.on('message', (data: Buffer) => {
          ws.close();
          resolve(JSON.parse(data.toString()));
        });
        ws.on('error', reject);
      });
      const evt = firstMessage as Record<string, unknown>;
      expect(evt['event_type']).toBe('system.status');
      expect(typeof evt['event_id']).toBe('string');
      expect(typeof evt['created_at']).toBe('string');
    } finally {
      await server.stop();
    }
  });
});

// ── EventBus fan-out ──────────────────────────────────────────────────────────

describe('CanvasServer — EventBus fan-out to connected clients', () => {
  it('fans out a published event to connected clients', async () => {
    const eventBus = new EventBus();
    const server = new CanvasServer(
      {
        sessionToken: SESSION_TOKEN,
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
    await server.start();
    const port = getServerPort(server);
    try {
      const received: unknown[] = [];
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(port, SESSION_TOKEN));
        ws.on('open', () => {
          // First message is the snapshot; then we publish a heartbeat.pulse
          const pulse = makeCanvasEvent('heartbeat.pulse', { count: 42 });
          eventBus.publish(pulse);
        });
        ws.on('message', (data: Buffer) => {
          received.push(JSON.parse(data.toString()));
          if (received.length >= 2) {
            ws.close();
            resolve();
          }
        });
        ws.on('error', reject);
      });
      const heartbeat = received[1] as Record<string, unknown>;
      expect(heartbeat['event_type']).toBe('heartbeat.pulse');
      expect((heartbeat['payload'] as Record<string, unknown>)['count']).toBe(42);
    } finally {
      await server.stop();
    }
  });
});

// ── connectedClients accessor ─────────────────────────────────────────────────

describe('CanvasServer — connectedClients', () => {
  it('tracks connected client count', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      expect(server.connectedClients).toBe(0);
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl(port, SESSION_TOKEN));
        ws.on('open', () => {
          expect(server.connectedClients).toBe(1);
          ws.close();
          resolve();
        });
        ws.on('error', reject);
      });
      // Give a tick for the close handler to fire
      await new Promise((r) => setTimeout(r, 50));
      expect(server.connectedClients).toBe(0);
    } finally {
      await server.stop();
    }
  });
});

// ── REST GET /status ──────────────────────────────────────────────────────────

describe('CanvasServer — REST GET /status', () => {
  it('returns 200 with system snapshot', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const { status, body } = await httpGet(port, '/status');
      expect(status).toBe(200);
      expect((body as Record<string, unknown>)['success']).toBe(true);
      const data = (body as Record<string, unknown>)['data'] as Record<string, unknown>;
      expect(data['captured_at']).toBeDefined();
    } finally {
      await server.stop();
    }
  });
});

// ── REST GET /tasks ───────────────────────────────────────────────────────────

describe('CanvasServer — REST GET /tasks', () => {
  it('returns 200 with empty task list initially', async () => {
    const { server } = makeTestServer();
    await server.start();
    const port = getServerPort(server);
    try {
      const { status, body } = await httpGet(port, '/tasks');
      expect(status).toBe(200);
      expect((body as Record<string, unknown>)['success']).toBe(true);
      expect(Array.isArray((body as Record<string, unknown>)['data'])).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

// ── REST GET /memory/episodic ─────────────────────────────────────────────────

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

  it('POST /approvals/:id/approve returns 404 for nonexistent id with valid token', async () => {
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

// ── GET /canvas — static file serving (JAL-014) ───────────────────────────────

describe('CanvasServer — GET /canvas static file serving', () => {
  /**
   * The UI_DIST_DIR in CanvasServer.ts is resolved relative to the compiled
   * __dirname, which in ts-jest = src/apex/canvas/. We write files there for
   * tests that need a built dist to exist.
   */
  const canvasDir = path.resolve(__dirname, '..', '..', 'src', 'apex', 'canvas');
  const distDir = path.join(canvasDir, 'ui', 'dist');

  function ensureDist(): boolean {
    const existed = fs.existsSync(distDir);
    if (!existed) {
      fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
      fs.writeFileSync(
        path.join(distDir, 'index.html'),
        '<!doctype html><html><head><!-- __APEX_SESSION_TOKEN_SCRIPT__ --></head><body><div id="root"></div></body></html>',
        'utf-8',
      );
    }
    return existed;
  }

  function cleanupDist(existed: boolean): void {
    if (!existed) {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  }

  it('returns 404 with hint when dist directory does not exist', async () => {
    // Only test this when dist is genuinely absent
    if (fs.existsSync(distDir)) return;

    const server = makeTestServer().server;
    await server.start();
    const port = getServerPort(server);
    try {
      const { status, body } = await httpGetRaw(port, '/canvas');
      expect(status).toBe(404);
      expect(body).toContain('Canvas UI not built');
    } finally {
      await server.stop();
    }
  });

  it('GET /canvas and GET /canvas/ return the same status code', async () => {
    const server = makeTestServer().server;
    await server.start();
    const port = getServerPort(server);
    try {
      const r1 = await httpGetRaw(port, '/canvas');
      const r2 = await httpGetRaw(port, '/canvas/');
      expect(r1.status).toBe(r2.status);
    } finally {
      await server.stop();
    }
  });

  it('serves index.html with injected session token', async () => {
    const existed = ensureDist();
    const server = makeTestServer().server;
    await server.start();
    const port = getServerPort(server);
    try {
      const { status, body, headers } = await httpGetRaw(port, '/canvas');
      expect(status).toBe(200);
      expect(headers['content-type']).toMatch(/text\/html/);
      // Token must be injected as window.__APEX_TOKEN__
      expect(body).toContain('__APEX_TOKEN__');
      expect(body).toContain(SESSION_TOKEN);
      // Template placeholder must be replaced
      expect(body).not.toContain('<!-- __APEX_SESSION_TOKEN_SCRIPT__ -->');
    } finally {
      await server.stop();
      cleanupDist(existed);
    }
  });

  it('serves /canvas/ (trailing slash) with same content as /canvas', async () => {
    const existed = ensureDist();
    const server = makeTestServer().server;
    await server.start();
    const port = getServerPort(server);
    try {
      const r1 = await httpGetRaw(port, '/canvas');
      const r2 = await httpGetRaw(port, '/canvas/');
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r1.body).toBe(r2.body);
    } finally {
      await server.stop();
      cleanupDist(existed);
    }
  });

  it('serves JS asset with application/javascript content-type', async () => {
    const existed = ensureDist();
    const jsPath = path.join(distDir, 'assets', 'test-canvas.js');
    fs.writeFileSync(jsPath, 'export const x = 1;', 'utf-8');

    const server = makeTestServer().server;
    await server.start();
    const port = getServerPort(server);
    try {
      const { status, headers } = await httpGetRaw(port, '/canvas/assets/test-canvas.js');
      expect(status).toBe(200);
      expect(headers['content-type']).toMatch(/javascript/);
    } finally {
      await server.stop();
      fs.rmSync(jsPath, { force: true });
      cleanupDist(existed);
    }
  });

  it('falls back to index.html for unknown sub-paths (SPA routing)', async () => {
    const existed = ensureDist();
    const server = makeTestServer().server;
    await server.start();
    const port = getServerPort(server);
    try {
      const { status, headers } = await httpGetRaw(port, '/canvas/some/deep/route');
      expect(status).toBe(200);
      expect(headers['content-type']).toMatch(/text\/html/);
    } finally {
      await server.stop();
      cleanupDist(existed);
    }
  });

  it('blocks path traversal: /canvas/../../../etc/passwd does not serve sensitive files', async () => {
    const existed = ensureDist();
    const server = makeTestServer().server;
    await server.start();
    const port = getServerPort(server);
    try {
      // Path traversal attempt — Node's http normalizes the URL, but we verify
      // our safety gate ensures the resolved path stays inside dist/
      const { status, body } = await httpGetRaw(port, '/canvas/../../../etc/passwd');
      // Should be 200 (falls back to index.html from canvas) or 404/403 — never passwd content
      if (status === 200) {
        expect(body).not.toMatch(/root:x:|nobody:x:/);
      }
    } finally {
      await server.stop();
      cleanupDist(existed);
    }
  });

  it('sets X-Content-Type-Options: nosniff on static responses', async () => {
    const existed = ensureDist();
    const server = makeTestServer().server;
    await server.start();
    const port = getServerPort(server);
    try {
      const { status, headers } = await httpGetRaw(port, '/canvas');
      expect(status).toBe(200);
      expect(headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await server.stop();
      cleanupDist(existed);
    }
  });
});
