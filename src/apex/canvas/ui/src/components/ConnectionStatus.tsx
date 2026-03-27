// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/ui/src/components/ConnectionStatus.tsx — JAL-014 Connection status indicator
import type { ConnectionStatus as ConnStatus } from '../types';

interface Props {
  status: ConnStatus;
}

const LABELS: Record<ConnStatus, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
};

const COLORS: Record<ConnStatus, string> = {
  connected: '#22c55e',
  reconnecting: '#f59e0b',
  disconnected: '#ef4444',
};

export function ConnectionStatus({ status }: Props): JSX.Element {
  const color = COLORS[status];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          display: 'inline-block',
        }}
      />
      {LABELS[status]}
    </div>
  );
}
