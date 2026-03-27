// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// tests/plugins/SlackPlugin.test.ts — JAL-016 SlackPlugin unit tests

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { PluginCoordinator } from '../../src/apex/plugins/PluginCoordinator';
import { SlackPlugin } from '../../src/apex/plugins/SlackPlugin';
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
        // Call the callback with the fake response
        cb(res);
        // Emit response data
        process.nextTick(() => {
          res.emit('data', Buffer.from(JSON.stringify({ ok: true, ts: '12345' })));
          res.emit('end');
        });
      });
      return req;
    }),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-slack-test-'));
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
    event_id: 'ev-slack-1',
    event_type: 'approval.requested',
    workspace_id: 'ws-slack',
    task_id: 'task-s1',
    tier: 2,
    created_at: new Date().toISOString(),
    payload: {
      approval_id: 'appr-slack-1',
      action: 'docker prune',
      reason: 'disk cleanup',
    },
    redaction_level: 'standard',
  };
  return { ...partial, signature: coordinator.signEvent(partial) };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('SlackPlugin', () => {
  let coordinator: PluginCoordinator;
  let plugin: SlackPlugin;

  beforeEach(() => {
    coordinator = makeCoordinator();
    plugin = new SlackPlugin({
      token: 'xoxb-test-token',
      channelId: 'C01234567',
      coordinator,
      workspaceId: 'ws-slack',
    });
    jest.clearAllMocks();
  });

  it('has name "slack"', () => {
    expect(plugin.name).toBe('slack');
  });

  it('sends an approval.requested event via Slack chat.postMessage', async () => {
    const https = require('https');
    const event = makeApprovalEvent(coordinator);
    await plugin.send(event);
    expect(https.request).toHaveBeenCalledTimes(1);
    const callArgs = (https.request as jest.Mock).mock.calls[0];
    expect(callArgs[0].path).toBe('/api/chat.postMessage');
    expect(callArgs[0].hostname).toBe('slack.com');
  });

  it('issues two approval tokens (one approve, one deny) per approval request', async () => {
    const event = makeApprovalEvent(coordinator);
    const issueSpy = jest.spyOn(coordinator, 'issueToken');
    await plugin.send(event);
    expect(issueSpy).toHaveBeenCalledTimes(2);
    expect(issueSpy.mock.calls[0]![0]).toBe('ws-slack');
    expect(issueSpy.mock.calls[0]![1]).toBe('appr-slack-1');
  });

  it('does not send after disconnect()', async () => {
    const https = require('https');
    plugin.disconnect();
    const event = makeApprovalEvent(coordinator);
    await plugin.send(event);
    expect(https.request).not.toHaveBeenCalled();
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
});
