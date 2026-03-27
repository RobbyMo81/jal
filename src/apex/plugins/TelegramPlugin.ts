// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/plugins/TelegramPlugin.ts — JAL-016 Telegram Plugin Adapter
//
// Implements IPlugin for Telegram.
// Uses the Telegram Bot API (HTTPS long-poll is NOT used here — polling
// mode only: coordinator polls this plugin's queue every 10 seconds).
//
// Outbound: sends approval.requested as a message with inline keyboard
//   buttons (Approve / Deny) via Telegram sendMessage.
//
// Inbound: returns pending InboundActions from an internal buffer.
//   In real deployment, a thin relay service would call
//   POST /apex/plugin-actions/:workspace_id/ack/:action_id to enqueue
//   actions when Telegram callback_query events arrive.
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

// ── Telegram Bot API helpers ──────────────────────────────────────────────────

function telegramPost(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; description?: string; result?: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options: https.RequestOptions = {
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch {
          reject(new Error('Telegram API: non-JSON response'));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── TelegramPluginOptions ─────────────────────────────────────────────────────

export interface TelegramPluginOptions {
  /**
   * Telegram bot token (provided by @BotFather).
   * SAFETY GATE: must be loaded from OS keychain before being passed here.
   */
  token: string;
  /** Telegram chat ID (numeric) to send messages to. */
  chatId: string;
  /** Reference to the PluginCoordinator for action queue management. */
  coordinator: PluginCoordinator;
  /** Workspace ID this plugin is bound to. */
  workspaceId: string;
}

// ── TelegramPlugin ────────────────────────────────────────────────────────────

export class TelegramPlugin implements IPlugin {
  readonly name = 'telegram';

  private readonly token: string;
  private readonly chatId: string;
  private readonly coordinator: PluginCoordinator;
  private readonly workspaceId: string;

  private disconnected = false;

  constructor(options: TelegramPluginOptions) {
    this.token = options.token;
    this.chatId = options.chatId;
    this.coordinator = options.coordinator;
    this.workspaceId = options.workspaceId;
  }

  /**
   * Send an outbound plugin event to Telegram.
   * For approval.requested events, sends an inline keyboard message.
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
   * Poll for inbound actions.
   * In Phase 2 polling mode, this returns an empty list — actions arrive
   * via the coordinator's REST endpoint (POST .../ack/:action_id) pushed
   * by a thin Telegram callback relay.
   */
  async poll(): Promise<InboundAction[]> {
    if (this.disconnected) return [];
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

    // Issue single-use tokens for approve and deny
    const approveToken = this.coordinator.issueToken(this.workspaceId, approvalId);
    const denyToken = this.coordinator.issueToken(this.workspaceId, approvalId);

    const text = [
      `🔐 *Apex Approval Request* — Tier ${tier}`,
      ``,
      `*Action:* ${action}`,
      `*Reason:* ${reason}`,
      `*Workspace:* ${event.workspace_id}`,
      `*Event ID:* \`${event.event_id}\``,
      ``,
      `_Expires in 10 minutes. Single-use only._`,
    ].join('\n');

    const inline_keyboard = [
      [
        {
          text: '✅ Approve',
          callback_data: `approve:${approveToken.token_id}:${this.workspaceId}:${approvalId}`,
        },
        {
          text: '❌ Deny',
          callback_data: `deny:${denyToken.token_id}:${this.workspaceId}:${approvalId}`,
        },
      ],
    ];

    const result = await telegramPost(this.token, 'sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard },
    });

    if (!result.ok) {
      throw new Error(`Telegram sendMessage failed: ${result.description ?? 'unknown'}`);
    }
  }

  private async sendNotification(event: PluginEvent): Promise<void> {
    const text = [
      `*Apex Event* \`${event.event_type}\``,
      `Workspace: ${event.workspace_id}`,
      `Task: ${event.task_id ?? 'N/A'}`,
    ].join('\n');

    const result = await telegramPost(this.token, 'sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'Markdown',
    });
    if (!result.ok) {
      throw new Error(`Telegram sendMessage failed: ${result.description ?? 'unknown'}`);
    }
  }
}
