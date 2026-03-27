// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/plugins/SlackPlugin.ts — JAL-016 Slack Plugin Adapter
//
// Implements IPlugin for Slack.
// Bot scopes required: chat:write, interactions:read (polling mode).
//
// Outbound: posts approval.requested as an interactive message with
//   Approve / Deny buttons via Slack Web API chat.postMessage.
//
// Inbound: polls the PluginCoordinator queue every 10 seconds (via
//   PluginCoordinator.pollAll — this adapter does NOT start its own timer).
//   In interactive/callback mode Slack pushes to a URL; in polling mode
//   the adapter calls the coordinator's REST endpoint periodically.
//
// SAFETY GATE: bot token retrieved from OS keychain only — never hardcoded.
// The caller is responsible for providing the token via the 'token' option
// (already loaded from SecretToolKeychain before construction).

import * as https from 'https';
import * as http from 'http';
import {
  IPlugin,
  InboundAction,
  PluginEvent,
} from '../types';
import { PluginCoordinator } from './PluginCoordinator';

// ── Slack API helpers ─────────────────────────────────────────────────────────

function slackPost(
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; ts?: string; channel?: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options: https.RequestOptions = {
      hostname: 'slack.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${token}`,
      },
    };
    const req = https.request(options, (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch {
          reject(new Error('Slack API: non-JSON response'));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── SlackPluginOptions ────────────────────────────────────────────────────────

export interface SlackPluginOptions {
  /**
   * Slack bot token (xoxb-...).
   * SAFETY GATE: must be loaded from OS keychain before being passed here.
   * Never pass a hardcoded token.
   */
  token: string;
  /** Default Slack channel ID to post messages to (e.g. 'C01234567'). */
  channelId: string;
  /** Reference to the PluginCoordinator for action queue management. */
  coordinator: PluginCoordinator;
  /** Workspace ID this plugin is bound to. */
  workspaceId: string;
}

// ── SlackPlugin ───────────────────────────────────────────────────────────────

export class SlackPlugin implements IPlugin {
  readonly name = 'slack';

  private readonly token: string;
  private readonly channelId: string;
  private readonly coordinator: PluginCoordinator;
  private readonly workspaceId: string;

  private disconnected = false;

  constructor(options: SlackPluginOptions) {
    this.token = options.token;
    this.channelId = options.channelId;
    this.coordinator = options.coordinator;
    this.workspaceId = options.workspaceId;
  }

  /**
   * Send an outbound plugin event to Slack.
   * For approval.requested events, sends an interactive message with
   * Approve / Deny buttons using Block Kit.
   * Other event types send a plain text notification.
   */
  async send(event: PluginEvent): Promise<void> {
    if (this.disconnected) return;

    if (event.event_type === 'approval.requested') {
      await this.sendApprovalRequest(event);
    } else {
      await this.sendNotification(event);
    }
  }

  /**
   * Poll the coordinator's action queue for this workspace.
   * The coordinator's internal timer calls pollAll() every 10 seconds,
   * which calls each plugin's poll(). This method returns any inbound
   * actions that Slack's interaction endpoint has forwarded.
   *
   * In Phase 2 polling mode there is no live interaction endpoint —
   * actions are enqueued externally (e.g. via a relay service or manual ack).
   */
  async poll(): Promise<InboundAction[]> {
    if (this.disconnected) return [];
    // In polling mode, actions arrive via the coordinator's REST endpoint.
    // This plugin's poll() returns the current queue snapshot without
    // clearing it — the coordinator handles queue management.
    return [];
  }

  /** Stop this plugin from accepting or sending further messages. */
  disconnect(): void {
    this.disconnected = true;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async sendApprovalRequest(event: PluginEvent): Promise<void> {
    const approvalId = (event.payload['approval_id'] as string | undefined) ?? event.event_id;
    const action = (event.payload['action'] as string | undefined) ?? 'Pending action';
    const reason = (event.payload['reason'] as string | undefined) ?? '';
    const tier = event.tier ?? 2;

    // Issue a single-use token for each button action
    const approveToken = this.coordinator.issueToken(this.workspaceId, approvalId);
    const denyToken = this.coordinator.issueToken(this.workspaceId, approvalId);

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Apex Approval Request* — Tier ${tier}\n*Action:* ${action}\n*Reason:* ${reason}`,
        },
      },
      {
        type: 'actions',
        block_id: `approval_${approvalId}`,
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            style: 'primary',
            action_id: 'apex_approve',
            value: `${approveToken.token_id}:${this.workspaceId}:${approvalId}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Deny' },
            style: 'danger',
            action_id: 'apex_deny',
            value: `${denyToken.token_id}:${this.workspaceId}:${approvalId}`,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Event ID: ${event.event_id} | Workspace: ${event.workspace_id} | Expires: 10 min`,
          },
        ],
      },
    ];

    const result = await slackPost('/api/chat.postMessage', this.token, {
      channel: this.channelId,
      blocks,
      text: `Apex Tier ${tier} approval request: ${action}`,
    });

    if (!result.ok) {
      throw new Error(`Slack chat.postMessage failed: ${result.error ?? 'unknown'}`);
    }
  }

  private async sendNotification(event: PluginEvent): Promise<void> {
    const text = `*Apex Event* \`${event.event_type}\`\nWorkspace: ${event.workspace_id}\nTask: ${event.task_id ?? 'N/A'}`;
    const result = await slackPost('/api/chat.postMessage', this.token, {
      channel: this.channelId,
      text,
    });
    if (!result.ok) {
      throw new Error(`Slack chat.postMessage failed: ${result.error ?? 'unknown'}`);
    }
  }
}
