// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/ui/src/components/ApprovalModal.tsx — JAL-014
// Modal that appears when approval.requested arrives.
// SAFETY GATE: approval buttons disabled after first click to prevent double-submit.
import { useState } from 'react';
import type { ApprovalRequestedPayload } from '../types';

interface Props {
  approval: ApprovalRequestedPayload;
  sessionToken: string;
  onResolved: (id: string) => void;
}

export function ApprovalModal({ approval, sessionToken, onResolved }: Props): JSX.Element {
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null);

  async function handleAction(action: 'approve' | 'deny'): Promise<void> {
    if (submitted) return; // SAFETY GATE: prevent double-submit
    setSubmitted(true);
    setPending(action);
    setError(null);

    try {
      const res = await fetch(`/approvals/${approval.approval_id}/${action}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      onResolved(approval.approval_id);
    } catch (err) {
      setError((err as Error).message);
      // Re-enable buttons on error so operator can retry
      setSubmitted(false);
      setPending(null);
    }
  }

  const tierColor = approval.tier >= 3 ? '#ef4444' : '#f59e0b';

  return (
    <div style={overlayStyle}>
      <div style={modalStyle} role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '4px',
              background: tierColor,
              color: '#000',
              fontSize: '11px',
              fontWeight: 700,
            }}
          >
            TIER {approval.tier}
          </span>
          <h2 id="approval-title" style={{ margin: 0, fontSize: '16px', color: '#f1f5f9' }}>
            Approval Required
          </h2>
        </div>

        <div style={{ marginBottom: '12px' }}>
          <div style={labelStyle}>Action</div>
          <div style={valueStyle}>{approval.action}</div>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <div style={labelStyle}>Risk Reason</div>
          <div style={{ ...valueStyle, color: '#fbbf24' }}>{approval.reason}</div>
        </div>

        {error && (
          <div style={{ color: '#ef4444', fontSize: '12px', marginBottom: '12px' }}>
            Error: {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            style={{ ...btnStyle, background: '#ef4444', opacity: submitted ? 0.5 : 1 }}
            onClick={() => void handleAction('deny')}
            disabled={submitted}
            aria-busy={pending === 'deny'}
          >
            {pending === 'deny' ? 'Denying…' : 'Deny'}
          </button>
          <button
            style={{ ...btnStyle, background: '#22c55e', opacity: submitted ? 0.5 : 1 }}
            onClick={() => void handleAction('approve')}
            disabled={submitted}
            aria-busy={pending === 'approve'}
          >
            {pending === 'approve' ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const modalStyle: React.CSSProperties = {
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: '10px',
  padding: '24px',
  width: '420px',
  maxWidth: '90vw',
  boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
};

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '4px',
};

const valueStyle: React.CSSProperties = {
  fontSize: '13px',
  color: '#e2e8f0',
  wordBreak: 'break-word',
};

const btnStyle: React.CSSProperties = {
  padding: '8px 20px',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '14px',
  fontWeight: 600,
  color: '#fff',
};
