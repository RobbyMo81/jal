// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/ui/src/components/TerminalMirror.tsx — JAL-014
// Displays incremental command output chunks. Scrolls automatically. Preserves last 500 lines.
import { useEffect, useRef } from 'react';

const MAX_LINES = 500;

interface Props {
  lines: string[];
}

export function TerminalMirror({ lines }: Props): JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <section style={panelStyle}>
      <h2 style={headingStyle}>Terminal Mirror</h2>
      <div style={termStyle}>
        {lines.length === 0 ? (
          <span style={{ color: '#475569' }}>No output yet…</span>
        ) : (
          lines.map((line, i) => (
            <div key={i} style={lineStyle}>{line || '\u00a0'}</div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
      {lines.length >= MAX_LINES && (
        <div style={{ fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
          Showing last {MAX_LINES} lines
        </div>
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
  margin: '0 0 8px 0',
  fontSize: '14px',
  fontWeight: 600,
  color: '#94a3b8',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const termStyle: React.CSSProperties = {
  background: '#020617',
  borderRadius: '4px',
  padding: '10px',
  fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
  fontSize: '12px',
  color: '#a3e635',
  height: '280px',
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

const lineStyle: React.CSSProperties = {
  lineHeight: '1.5',
};
