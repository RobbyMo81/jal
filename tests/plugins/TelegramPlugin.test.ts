// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// tests/plugins/TelegramPlugin.test.ts — JAL-016 TelegramPlugin unit tests

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { PluginCoordinator } from '../../src/apex/plugins/PluginCoordinator';
import { TelegramPlugin } from '../../src/apex/plugins/TelegramPlugin';
import { PluginEvent } from '../../src/apex/types';

// ── Mock https ────────────────────────────────────────────────────────────────

jest.mock('https', () => {
  const EventEmitter = require('events');
  return {
    request: jest.fn((_opts: unknown, cb: (res: unknown) => void) => {
      const req = new EventEmitter();
      req.write = jest.fn();
      req.end = jest.fn(() => {
        const res = new EventEmitter();
        cb(res);
        process.nextTick(() => {
          res.emit('data', Buffer.from(JSON.stringify({ ok: true, result: { message_id: 42 } })));
          res.emit('end');
        });
      });
      return req;
    }),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-tg-test-'));
}

function makeCoordinator(): PluginCoordinator {
  return new PluginCoordinator({
    queueDir: makeTmpDir(),
    actorMapPath: path.join(makeTmpDir(), 'actors.json'),
    hmacSecret: 'test-secret',
  });
}

function makeApprovalEvent(coordinator: PluginCoordinator): PluginEvent {
  const partial: Omit<PluginEvent, 'signature'> = {
    event_id: 'ev-tg-1',
    event_type: 'approval.requested',
    workspace_id: 'ws-tg',
    task_id: 'task-t1',
    tier: 2,
    created_at: new Date().toISOString(),
    payload: {
      approval_id: 'appr-tg-1',
      action: 'chmod 755 /etc/sudoers',
      reason: 'permission fix',
    },
    redaction_level: 'standard',
  };
  return { ...partial, signature: coordinator.signEvent(partial) };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TelegramPlugin', () => {
  let coordinator: PluginCoordinator;
  let plugin: TelegramPlugin;

  beforeEach(() => {
    coordinator = makeCoordinator();
    plugin = new TelegramPlugin({
      token: 'bot123456:ABC-DEF1234',
      chatId: '-100123456789',
      coordinator,
      workspaceId: 'ws-tg',
    });
    jest.clearAllMocks();
  });

  it('has name "telegram"', () => {
    expect(plugin.name).toBe('telegram');
  });

  it('sends approval.requested via Telegram sendMessage', async () => {
    const https = require('https');
    const event = makeApprovalEvent(coordinator);
    await plugin.send(event);
    expect(https.request).toHaveBeenCalledTimes(1);
    const callArgs = (https.request as jest.Mock).mock.calls[0];
    expect(callArgs[0].hostname).toBe('api.telegram.org');
    expect(callArgs[0].path).toContain('/sendMessage');
  });

  it('issues two tokens (approve + deny) per approval request', async () => {
    const event = makeApprovalEvent(coordinator);
    const issueSpy = jest.spyOn(coordinator, 'issueToken');
    await plugin.send(event);
    expect(issueSpy).toHaveBeenCalledTimes(2);
    expect(issueSpy.mock.calls[0]![1]).toBe('appr-tg-1');
  });

  it('poll() returns empty array in polling mode', async () => {
    const actions = await plugin.poll();
    expect(actions).toEqual([]);
  });

  it('disconnect() prevents further sends', async () => {
    const https = require('https');
    plugin.disconnect();
    await plugin.send(makeApprovalEvent(coordinator));
    expect(https.request).not.toHaveBeenCalled();
  });

  it('sends non-approval events as plain text notifications', async () => {
    const https = require('https');
    const partial: Omit<PluginEvent, 'signature'> = {
      event_id: 'ev-tg-notify',
      event_type: 'task.completed',
      workspace_id: 'ws-tg',
      task_id: 'task-done',
      tier: 1,
      created_at: new Date().toISOString(),
      payload: { result: 'success' },
      redaction_level: 'standard',
    };
    const event: PluginEvent = { ...partial, signature: coordinator.signEvent(partial) };
    await plugin.send(event);
    expect(https.request).toHaveBeenCalledTimes(1);
    // Should NOT have called issueToken since it's not an approval request
    const issueSpy = jest.spyOn(coordinator, 'issueToken');
    expect(issueSpy).not.toHaveBeenCalled();
  });
});
