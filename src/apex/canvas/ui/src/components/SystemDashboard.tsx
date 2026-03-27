// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/ui/src/components/SystemDashboard.tsx — JAL-014
// Shows live CPU (top process), RAM, disk usage bars, and container list.
// Updates on every system.status event.
import type { SystemStatusPayload, DiskMount, ContainerState } from '../types';

interface Props {
  snapshot: SystemStatusPayload | null;
}

function UsageBar({ label, percent }: { label: string; percent: number }): JSX.Element {
  const clampedPct = Math.min(100, Math.max(0, percent));
  const color = clampedPct >= 85 ? '#ef4444' : clampedPct >= 60 ? '#f59e0b' : '#22c55e';
  return (
    <div style={{ marginBottom: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '2px' }}>
        <span>{label}</span>
        <span>{clampedPct.toFixed(1)}%</span>
      </div>
      <div style={{ height: '6px', background: '#334155', borderRadius: '3px', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${clampedPct}%`,
            background: color,
            borderRadius: '3px',
            transition: 'width 0.3s ease',
          }}
        />
      </div>
    </div>
  );
}

function ContainerBadge({ container }: { container: ContainerState }): JSX.Element {
  const isUp = container.status.toLowerCase().startsWith('up');
  const color = isUp ? '#22c55e' : '#ef4444';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        background: '#1e293b',
        borderRadius: '4px',
        fontSize: '12px',
        marginBottom: '4px',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{container.name}</span>
      <span style={{ color: '#94a3b8', fontSize: '11px' }}>{container.status}</span>
    </div>
  );
}

export function SystemDashboard({ snapshot }: Props): JSX.Element {
  if (!snapshot) {
    return (
      <section style={panelStyle}>
        <h2 style={headingStyle}>System</h2>
        <p style={{ color: '#64748b', fontSize: '13px' }}>Waiting for system data…</p>
      </section>
    );
  }

  const topCpuProcess = snapshot.processes.reduce(
    (top, p) => (p.cpu_percent > (top?.cpu_percent ?? -1) ? p : top),
    null as (typeof snapshot.processes)[0] | null,
  );
  const avgCpu = snapshot.processes.length > 0
    ? snapshot.processes.reduce((sum, p) => sum + p.cpu_percent, 0) / snapshot.processes.length
    : 0;

  const totalMemMb = snapshot.available_memory_mb > 0
    ? snapshot.available_memory_mb / 0.15  // rough estimate: available ≈ 15% free
    : 0;
  const usedMemMb = totalMemMb - snapshot.available_memory_mb;
  const memPercent = totalMemMb > 0 ? (usedMemMb / totalMemMb) * 100 : 0;

  return (
    <section style={panelStyle}>
      <h2 style={headingStyle}>System</h2>

      <div style={{ marginBottom: '12px' }}>
        <UsageBar label="CPU (avg)" percent={avgCpu} />
        <UsageBar label="RAM" percent={memPercent} />
        {snapshot.disk_mounts.map((d: DiskMount) => (
          <UsageBar key={d.mount} label={`Disk ${d.mount}`} percent={d.use_percent} />
        ))}
      </div>

      {topCpuProcess && (
        <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '12px' }}>
          Top CPU: <span style={{ color: '#e2e8f0' }}>{topCpuProcess.name}</span>{' '}
          ({topCpuProcess.cpu_percent.toFixed(1)}% CPU, PID {topCpuProcess.pid})
        </div>
      )}

      {snapshot.containers.length > 0 && (
        <div>
          <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>
            Containers ({snapshot.containers.length})
          </div>
          {snapshot.containers.map((c: ContainerState) => (
            <ContainerBadge key={c.id} container={c} />
          ))}
        </div>
      )}

      <div style={{ fontSize: '11px', color: '#475569', marginTop: '8px' }}>
        Updated: {new Date(snapshot.captured_at).toLocaleTimeString()}
      </div>
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
