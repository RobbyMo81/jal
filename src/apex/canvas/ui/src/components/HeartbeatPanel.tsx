// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/ui/src/components/HeartbeatPanel.tsx — JAL-014
// Shows last pulse timestamp, last narrative summary, and timeline of recent notable/urgent events.
import type { HeartbeatPulsePayload, HeartbeatDelta } from '../types';

interface Props {
  pulses: HeartbeatPulsePayload[];
}

const CLASSIFICATION_COLORS: Record<string, string> = {
  urgent: '#ef4444',
  notable: '#f59e0b',
  routine: '#64748b',
};

function DeltaRow({ delta }: { delta: HeartbeatDelta }): JSX.Element {
  const color = CLASSIFICATION_COLORS[delta.classification] ?? '#64748b';
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '6px' }}>
      <span
        style={{
          fontSize: '10px',
          padding: '1px 5px',
          borderRadius: '3px',
          background: color,
          color: '#000',
          fontWeight: 700,
          flexShrink: 0,
          marginTop: '1px',
        }}
      >
        {delta.classification.toUpperCase()}
      </span>
      <span style={{ fontSize: '12px', color: '#cbd5e1' }}>{delta.description}</span>
    </div>
  );
}

export function HeartbeatPanel({ pulses }: Props): JSX.Element {
  const lastPulse = pulses[pulses.length - 1] ?? null;

  // Collect recent notable/urgent deltas across last 5 pulses
  const recentDeltas: HeartbeatDelta[] = pulses
    .slice(-5)
    .flatMap((p) => p.deltas ?? [])
    .filter((d) => d.classification !== 'routine')
    .slice(-20);

  return (
    <section style={panelStyle}>
      <h2 style={headingStyle}>Heartbeat</h2>

      {!lastPulse ? (
        <p style={{ color: '#64748b', fontSize: '13px' }}>No heartbeat received yet…</p>
      ) : (
        <>
          <div style={{ marginBottom: '12px' }}>
            <div style={labelStyle}>Last Pulse</div>
            <div style={{ fontSize: '13px', color: '#e2e8f0' }}>
              {new Date(lastPulse.timestamp).toLocaleString()}
            </div>
          </div>

          {lastPulse.narrative && (
            <div style={{ marginBottom: '12px' }}>
              <div style={labelStyle}>Narrative</div>
              <div
                style={{
                  fontSize: '12px',
                  color: '#cbd5e1',
                  background: '#020617',
                  borderRadius: '4px',
                  padding: '8px',
                  lineHeight: '1.5',
                  maxHeight: '100px',
                  overflowY: 'auto',
                }}
              >
                {lastPulse.narrative}
              </div>
            </div>
          )}

          {recentDeltas.length > 0 && (
            <div>
              <div style={labelStyle}>Recent Events</div>
              <div style={{ maxHeight: '160px', overflowY: 'auto' }}>
                {recentDeltas.map((d, i) => (
                  <DeltaRow key={i} delta={d} />
                ))}
              </div>
            </div>
          )}

          {recentDeltas.length === 0 && (
            <div style={{ fontSize: '12px', color: '#475569' }}>No notable events</div>
          )}
        </>
      )}
    </section>
  );
}

const panelStyle: React.CSSProperties = {
  background: '#0f172a',
  border: '1px solid #1e293b',
  borderRadius: '8px',
  padding: '16px',
};

const headingStyle: React.CSSProperties = {
  margin: '0 0 12px 0',
  fontSize: '14px',
  fontWeight: 600,
  color: '#94a3b8',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '4px',
};
