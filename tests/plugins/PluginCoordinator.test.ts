// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// tests/plugins/PluginCoordinator.test.ts — JAL-016 PluginCoordinator unit tests

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { PluginCoordinator } from '../../src/apex/plugins/PluginCoordinator';
import {
  IPlugin,
  InboundAction,
  PluginEvent,
  PluginActorMap,
} from '../../src/apex/types';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-plugin-test-'));
  return dir;
}

function makeCoordinator(queueDir?: string, actorMapPath?: string): PluginCoordinator {
  return new PluginCoordinator({
    queueDir: queueDir ?? makeTmpDir(),
    actorMapPath: actorMapPath ?? path.join(makeTmpDir(), 'plugin-actors.json'),
    hmacSecret: 'test-secret-deterministic',
  });
}

class MockPlugin implements IPlugin {
  readonly name: string;
  sent: PluginEvent[] = [];
  polled = 0;
  disconnectCalled = false;
  inboundActions: InboundAction[] = [];

  constructor(name: string) { this.name = name; }
  async send(event: PluginEvent): Promise<void> { this.sent.push(event); }
  async poll(): Promise<InboundAction[]> {
    this.polled++;
    return this.inboundActions.splice(0);
  }
  disconnect(): void { this.disconnectCalled = true; }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PluginCoordinator', () => {

  describe('HMAC signing', () => {
    it('signs outbound events with HMAC-SHA256', async () => {
      const coord = makeCoordinator();
      const plugin = new MockPlugin('test');
      coord.register(plugin);

      await coord.dispatch('approval.requested', 'ws-1', 'task-1', 2, {
        action: 'rm -rf /tmp/test',
        reason: 'policy test',
        approval_id: 'appr-1',
      });

      expect(plugin.sent).toHaveLength(1);
      const event = plugin.sent[0]!;
      expect(event.signature).toBeTruthy();
      // Verify signature independently
      const { signature: _sig, ...rest } = event;
      const canonical = JSON.stringify(rest, Object.keys(rest).sort());
      const expected = crypto
        .createHmac('sha256', 'test-secret-deterministic')
        .update(canonical)
        .digest('hex');
      expect(event.signature).toBe(expected);
    });

    it('produces different signatures for different events', async () => {
      const coord = makeCoordinator();
      const plugin = new MockPlugin('test');
      coord.register(plugin);

      await coord.dispatch('approval.requested', 'ws-1', null, 2, { action: 'cmd-1', approval_id: 'a1' });
      await coord.dispatch('approval.requested', 'ws-1', null, 2, { action: 'cmd-2', approval_id: 'a2' });

      expect(plugin.sent[0]!.signature).not.toBe(plugin.sent[1]!.signature);
    });
  });

  describe('Redaction', () => {
    it('standard redaction strips file paths from payload', async () => {
      const coord = makeCoordinator();
      const plugin = new MockPlugin('test');
      coord.register(plugin);

      await coord.dispatch('approval.requested', 'ws-1', null, 2, {
        action: 'edit /home/user/.bashrc',
        reason: 'modifying $HOME/.bashrc',
        approval_id: 'appr-r1',
      }, 'standard');

      const payload = plugin.sent[0]!.payload;
      expect(payload['action']).not.toContain('/home/user/.bashrc');
      expect(payload['reason']).not.toContain('$HOME');
    });

    it('standard redaction strips code blocks', async () => {
      const coord = makeCoordinator();
      const plugin = new MockPlugin('test');
      coord.register(plugin);

      await coord.dispatch('approval.requested', 'ws-1', null, 2, {
        action: 'execute script',
        description: 'Run ```bash\nrm -rf /tmp\n``` now',
        approval_id: 'appr-r2',
      }, 'standard');

      expect(plugin.sent[0]!.payload['description']).not.toContain('rm -rf');
      expect(plugin.sent[0]!.payload['description']).toContain('[redacted:code]');
    });

    it('full redaction replaces all payload values', async () => {
      const coord = makeCoordinator();
      const plugin = new MockPlugin('test');
      coord.register(plugin);

      await coord.dispatch('task.started', 'ws-1', 't1', 1, {
        goal: 'do something important',
        details: 'lots of detail',
      }, 'full');

      const payload = plugin.sent[0]!.payload;
      expect(payload['goal']).toBe('[redacted]');
      expect(payload['details']).toBe('[redacted]');
    });

    it('none redaction passes payload unchanged', async () => {
      const coord = makeCoordinator();
      const plugin = new MockPlugin('test');
      coord.register(plugin);

      await coord.dispatch('task.started', 'ws-1', 't2', 1, {
        goal: 'do something',
      }, 'none');

      expect(plugin.sent[0]!.payload['goal']).toBe('do something');
    });
  });

  describe('Approval token lifecycle', () => {
    it('issues a token with correct fields', () => {
      const coord = makeCoordinator();
      const token = coord.issueToken('ws-1', 'appr-1');
      expect(token.workspace_id).toBe('ws-1');
      expect(token.approval_id).toBe('appr-1');
      expect(token.used).toBe(false);
      expect(token.token_id).toBeTruthy();
      expect(new Date(token.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('consumeToken succeeds on valid token', () => {
      const coord = makeCoordinator();
      const token = coord.issueToken('ws-1', 'appr-2');
      const result = coord.consumeToken(token.token_id, 'ws-1', 'appr-2');
      expect(result).not.toBeNull();
      expect(result!.token_id).toBe(token.token_id);
    });

    it('token is single-use: second consume returns null', () => {
      const coord = makeCoordinator();
      const token = coord.issueToken('ws-1', 'appr-3');
      coord.consumeToken(token.token_id, 'ws-1', 'appr-3');
      const second = coord.consumeToken(token.token_id, 'ws-1', 'appr-3');
      expect(second).toBeNull();
    });

    it('consumeToken rejects wrong workspace_id', () => {
      const coord = makeCoordinator();
      const token = coord.issueToken('ws-correct', 'appr-4');
      const result = coord.consumeToken(token.token_id, 'ws-wrong', 'appr-4');
      expect(result).toBeNull();
    });

    it('consumeToken rejects wrong approval_id', () => {
      const coord = makeCoordinator();
      const token = coord.issueToken('ws-1', 'appr-5');
      const result = coord.consumeToken(token.token_id, 'ws-1', 'wrong-appr');
      expect(result).toBeNull();
    });

    it('consumeToken rejects expired tokens', () => {
      const coord = makeCoordinator();
      const token = coord.issueToken('ws-1', 'appr-6');
      // Forcefully expire the token by mutating (test-only)
      (token as { expires_at: string }).expires_at = new Date(Date.now() - 1000).toISOString();
      const result = coord.consumeToken(token.token_id, 'ws-1', 'appr-6');
      expect(result).toBeNull();
    });

    it('stop() expires all in-flight tokens', () => {
      const coord = makeCoordinator();
      const t1 = coord.issueToken('ws-1', 'appr-7');
      const t2 = coord.issueToken('ws-1', 'appr-8');
      coord.stop();
      // After stop, tokens should be expired/cleared
      const r1 = coord.consumeToken(t1.token_id, 'ws-1', 'appr-7');
      const r2 = coord.consumeToken(t2.token_id, 'ws-1', 'appr-8');
      expect(r1).toBeNull();
      expect(r2).toBeNull();
    });
  });

  describe('Actor identity mapping', () => {
    it('resolves a mapped actor', () => {
      const tmpDir = makeTmpDir();
      const actorMapPath = path.join(tmpDir, 'plugin-actors.json');
      const map: PluginActorMap = {
        version: 1,
        actors: [
          { platform_id: 'U12345', plugin_name: 'slack', apex_identity: 'kirk' },
          { platform_id: '987654', plugin_name: 'telegram', apex_identity: 'operator' },
        ],
      };
      fs.writeFileSync(actorMapPath, JSON.stringify(map), 'utf-8');
      const coord = makeCoordinator(makeTmpDir(), actorMapPath);

      expect(coord.resolveActorIdentity('slack', 'U12345')).toBe('kirk');
      expect(coord.resolveActorIdentity('telegram', '987654')).toBe('operator');
    });

    it('returns null for unmapped actor (no fallback)', () => {
      const coord = makeCoordinator();
      expect(coord.resolveActorIdentity('slack', 'UNKNOWN')).toBeNull();
    });

    it('does not cross-match platforms', () => {
      const tmpDir = makeTmpDir();
      const actorMapPath = path.join(tmpDir, 'plugin-actors.json');
      const map: PluginActorMap = {
        version: 1,
        actors: [{ platform_id: 'U12345', plugin_name: 'slack', apex_identity: 'kirk' }],
      };
      fs.writeFileSync(actorMapPath, JSON.stringify(map), 'utf-8');
      const coord = makeCoordinator(makeTmpDir(), actorMapPath);
      // Same ID but wrong platform — must return null
      expect(coord.resolveActorIdentity('telegram', 'U12345')).toBeNull();
    });

    it('handles missing actor map file gracefully (returns null)', () => {
      const coord = makeCoordinator();
      // actorMapPath does not exist — should not throw
      expect(coord.resolveActorIdentity('slack', 'anyone')).toBeNull();
    });
  });

  describe('acknowledgeAction', () => {
    function makeActionWithToken(
      coord: PluginCoordinator,
      workspaceId: string,
      approvalId: string,
      actorId: string,
      pluginName: string,
    ): InboundAction {
      // Issue an approval token so consumeToken succeeds
      const pluginToken = coord.issueToken(workspaceId, approvalId);
      const actionBase: Omit<InboundAction, 'signature'> = {
        action_id: crypto.randomUUID(),
        workspace_id: workspaceId,
        action_type: 'approve',
        actor_platform_id: actorId,
        plugin_name: pluginName,
        approval_id: approvalId,
        // token = the PluginApprovalToken.token_id (the single-use approval gate)
        token: pluginToken.token_id,
        received_at: new Date().toISOString(),
      };
      // signature = HMAC of all non-signature fields
      const sig = coord.signInbound(actionBase);
      return { ...actionBase, signature: sig };
    }

    it('rejects action with invalid HMAC signature', () => {
      const coord = makeCoordinator();
      const action: InboundAction = {
        action_id: 'act-1',
        workspace_id: 'ws-1',
        action_type: 'approve',
        actor_platform_id: 'U12345',
        plugin_name: 'slack',
        approval_id: 'appr-1',
        token: 'some-token-id',
        signature: 'bad-signature',
        received_at: new Date().toISOString(),
      };
      const result = coord.acknowledgeAction('ws-1', action);
      expect(result.success).toBe(false);
      expect(result.error).toContain('signature');
    });

    it('rejects action from unmapped actor', () => {
      const coord = makeCoordinator();
      const action = makeActionWithToken(coord, 'ws-1', 'appr-x', 'UNMAPPED_USER', 'slack');
      const result = coord.acknowledgeAction('ws-1', action);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unmapped actor');
    });

    it('accepts action from mapped actor with valid token', () => {
      const tmpDir = makeTmpDir();
      const actorMapPath = path.join(tmpDir, 'plugin-actors.json');
      const map: PluginActorMap = {
        version: 1,
        actors: [{ platform_id: 'U99999', plugin_name: 'slack', apex_identity: 'kirk' }],
      };
      fs.writeFileSync(actorMapPath, JSON.stringify(map), 'utf-8');
      const coord = makeCoordinator(makeTmpDir(), actorMapPath);
      const action = makeActionWithToken(coord, 'ws-1', 'appr-ok', 'U99999', 'slack');
      const result = coord.acknowledgeAction('ws-1', action);
      expect(result.success).toBe(true);
      expect(result.apex_identity).toBe('kirk');
    });
  });

  describe('Inbound action queue', () => {
    it('dequeueActions returns empty array for unknown workspace', () => {
      const coord = makeCoordinator();
      expect(coord.dequeueActions('unknown-ws')).toEqual([]);
    });

    it('persists received actions to queue dir on disk', async () => {
      const queueDir = makeTmpDir();
      const coord = makeCoordinator(queueDir);
      const plugin = new MockPlugin('test');
      plugin.inboundActions.push({
        action_id: 'act-disk-1',
        workspace_id: 'ws-disk',
        action_type: 'approve',
        actor_platform_id: 'U1',
        plugin_name: 'test',
        approval_id: 'appr-disk',
        token: 'tok',
        signature: 'sig',
        received_at: new Date().toISOString(),
      });
      coord.register(plugin);

      // Manually trigger poll
      // Access private method via cast for testing purposes
      await (coord as unknown as { pollAll(): Promise<void> }).pollAll();

      const wsDir = path.join(queueDir, 'ws-disk');
      expect(fs.existsSync(wsDir)).toBe(true);
      const files = fs.readdirSync(wsDir);
      expect(files).toHaveLength(1);
    });
  });

  describe('Plugin registration and dispatch', () => {
    it('dispatches to all registered plugins', async () => {
      const coord = makeCoordinator();
      const slack = new MockPlugin('slack');
      const telegram = new MockPlugin('telegram');
      coord.register(slack);
      coord.register(telegram);

      await coord.dispatch('task.started', 'ws-1', 'task-1', 1, { goal: 'test' }, 'none');

      expect(slack.sent).toHaveLength(1);
      expect(telegram.sent).toHaveLength(1);
    });

    it('stop() calls disconnect on all plugins', () => {
      const coord = makeCoordinator();
      const slack = new MockPlugin('slack');
      const telegram = new MockPlugin('telegram');
      coord.register(slack);
      coord.register(telegram);

      coord.stop();

      expect(slack.disconnectCalled).toBe(true);
      expect(telegram.disconnectCalled).toBe(true);
    });

    it('outbound event has all required envelope fields', async () => {
      const coord = makeCoordinator();
      const plugin = new MockPlugin('test');
      coord.register(plugin);

      await coord.dispatch('approval.requested', 'ws-env', 'task-env', 2, {
        action: 'delete file',
        approval_id: 'appr-env',
      });

      const event = plugin.sent[0]!;
      expect(event.event_id).toBeTruthy();
      expect(event.event_type).toBe('approval.requested');
      expect(event.workspace_id).toBe('ws-env');
      expect(event.task_id).toBe('task-env');
      expect(event.tier).toBe(2);
      expect(event.created_at).toBeTruthy();
      expect(event.redaction_level).toBe('standard');
      expect(event.signature).toBeTruthy();
    });
  });
});
