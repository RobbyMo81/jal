// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/ui/src/components/MemoryPanel.tsx — JAL-014
// Lists recent episodic entries (last 20) and all durable context keys with values. Read-only.
import { useEffect, useState } from 'react';
import type { EpisodicEntry, DurableEntry } from '../types';

export function MemoryPanel(): JSX.Element {
  const [episodic, setEpisodic] = useState<EpisodicEntry[]>([]);
  const [durable, setDurable] = useState<DurableEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchMemory(): Promise<void> {
      try {
        const [episodicRes, durableRes] = await Promise.all([
          fetch('/memory/episodic'),
          fetch('/memory/durable'),
        ]);
        if (!episodicRes.ok || !durableRes.ok) {
          throw new Error('Failed to fetch memory');
        }
        const episodicData = (await episodicRes.json()) as { entries: EpisodicEntry[] };
        const durableData = (await durableRes.json()) as { entries: DurableEntry[] };
        if (!cancelled) {
          setEpisodic(episodicData.entries ?? []);
          setDurable(durableData.entries ?? []);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setLoading(false);
        }
      }
    }

    void fetchMemory();
    return () => { cancelled = true; };
  }, []);

  return (
    <section style={panelStyle}>
      <h2 style={headingStyle}>Memory</h2>

      {loading && <p style={{ color: '#64748b', fontSize: '13px' }}>Loading…</p>}
      {error && <p style={{ color: '#ef4444', fontSize: '13px' }}>Error: {error}</p>}

      {!loading && !error && (
        <>
          <div style={{ marginBottom: '16px' }}>
            <div style={subHeadingStyle}>Episodic ({episodic.length})</div>
            {episodic.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#475569' }}>No episodic entries</div>
            ) : (
              <div style={{ maxHeight: '180px', overflowY: 'auto' }}>
                {episodic.map((e) => (
                  <div key={e.id} style={entryStyle}>
                    <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '2px' }}>
                      {new Date(e.created_at).toLocaleString()}
                      {e.tags.length > 0 && (
                        <span style={{ marginLeft: '6px' }}>
                          {e.tags.map((t) => (
                            <span key={t} style={tagStyle}>{t}</span>
                          ))}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '12px', color: '#cbd5e1', wordBreak: 'break-word' }}>
                      {e.content}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div style={subHeadingStyle}>Durable Context ({durable.length})</div>
            {durable.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#475569' }}>No durable entries</div>
            ) : (
              <div style={{ maxHeight: '150px', overflowY: 'auto' }}>
                {durable.map((e) => (
                  <div key={e.key} style={kvStyle}>
                    <span style={{ color: '#7dd3fc', fontFamily: 'monospace' }}>{e.key}</span>
                    <span style={{ color: '#94a3b8', margin: '0 6px' }}>→</span>
                    <span style={{ color: '#e2e8f0', wordBreak: 'break-all' }}>{e.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
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

const subHeadingStyle: React.CSSProperties = {
  fontSize: '11px',
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '6px',
};

const entryStyle: React.CSSProperties = {
  padding: '6px 8px',
  background: '#1e293b',
  borderRadius: '4px',
  marginBottom: '4px',
};

const kvStyle: React.CSSProperties = {
  padding: '4px 8px',
  background: '#1e293b',
  borderRadius: '4px',
  marginBottom: '4px',
  fontSize: '12px',
};

const tagStyle: React.CSSProperties = {
  background: '#1d4ed8',
  color: '#bfdbfe',
  padding: '0 4px',
  borderRadius: '3px',
  fontSize: '10px',
  marginLeft: '3px',
};
