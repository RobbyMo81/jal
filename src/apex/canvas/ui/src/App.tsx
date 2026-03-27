// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/ui/src/App.tsx — JAL-014 Canvas operational dashboard root
//
// SAFETY GATE: session token is read from window.__APEX_TOKEN__ (injected by CanvasServer
// into the served index.html) and passed as a WebSocket query param — never stored in localStorage.
import { useReducer, useCallback } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { ConnectionStatus } from './components/ConnectionStatus';
import { SystemDashboard } from './components/SystemDashboard';
import { TerminalMirror } from './components/TerminalMirror';
import { ApprovalModal } from './components/ApprovalModal';
import { HeartbeatPanel } from './components/HeartbeatPanel';
import { MemoryPanel } from './components/MemoryPanel';
import type {
  CanvasEvent,
  SystemStatusPayload,
  ApprovalRequestedPayload,
  HeartbeatPulsePayload,
} from './types';

// ── State ─────────────────────────────────────────────────────────────────────

const MAX_TERMINAL_LINES = 500;

interface AppState {
  snapshot: SystemStatusPayload | null;
  terminalLines: string[];
  pendingApprovals: ApprovalRequestedPayload[];
  heartbeatPulses: HeartbeatPulsePayload[];
}

type AppAction =
  | { type: 'SYSTEM_STATUS'; payload: SystemStatusPayload }
  | { type: 'COMMAND_OUTPUT'; chunk: string }
  | { type: 'APPROVAL_REQUESTED'; approval: ApprovalRequestedPayload }
  | { type: 'APPROVAL_RESOLVED'; id: string }
  | { type: 'HEARTBEAT_PULSE'; pulse: HeartbeatPulsePayload };

const initialState: AppState = {
  snapshot: null,
  terminalLines: [],
  pendingApprovals: [],
  heartbeatPulses: [],
};

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SYSTEM_STATUS':
      return { ...state, snapshot: action.payload };

    case 'COMMAND_OUTPUT': {
      // Append new chunk lines; preserve last MAX_TERMINAL_LINES
      const incoming = action.chunk.split('\n');
      const merged = [...state.terminalLines, ...incoming];
      const trimmed = merged.length > MAX_TERMINAL_LINES
        ? merged.slice(merged.length - MAX_TERMINAL_LINES)
        : merged;
      return { ...state, terminalLines: trimmed };
    }

    case 'APPROVAL_REQUESTED':
      // Deduplicate by approval_id
      if (state.pendingApprovals.some((a) => a.approval_id === action.approval.approval_id)) {
        return state;
      }
      return { ...state, pendingApprovals: [...state.pendingApprovals, action.approval] };

    case 'APPROVAL_RESOLVED':
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter((a) => a.approval_id !== action.id),
      };

    case 'HEARTBEAT_PULSE':
      return { ...state, heartbeatPulses: [...state.heartbeatPulses, action.pulse] };

    default:
      return state;
  }
}

// ── Token resolution ──────────────────────────────────────────────────────────

declare global {
  interface Window {
    __APEX_TOKEN__?: string;
  }
}

function getSessionToken(): string {
  return window.__APEX_TOKEN__ ?? '';
}

// ── App ───────────────────────────────────────────────────────────────────────

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);
  const sessionToken = getSessionToken();

  const wsUrl = sessionToken
    ? `ws://${window.location.host}/ws?token=${encodeURIComponent(sessionToken)}`
    : '';

  const handleEvent = useCallback((event: CanvasEvent): void => {
    switch (event.event_type) {
      case 'system.status':
        dispatch({ type: 'SYSTEM_STATUS', payload: event.payload as unknown as SystemStatusPayload });
        break;

      case 'command.output': {
        const chunk = String((event.payload as { chunk?: unknown }).chunk ?? '');
        dispatch({ type: 'COMMAND_OUTPUT', chunk });
        break;
      }

      case 'approval.requested':
        dispatch({
          type: 'APPROVAL_REQUESTED',
          approval: event.payload as unknown as ApprovalRequestedPayload,
        });
        break;

      case 'approval.resolved':
        dispatch({
          type: 'APPROVAL_RESOLVED',
          id: String((event.payload as { approval_id?: unknown }).approval_id ?? ''),
        });
        break;

      case 'heartbeat.pulse':
        dispatch({ type: 'HEARTBEAT_PULSE', pulse: event.payload as unknown as HeartbeatPulsePayload });
        break;

      // task.started / task.completed / task.failed handled via terminal output — no state needed here
      default:
        break;
    }
  }, []);

  const { status } = useWebSocket({ url: wsUrl, onEvent: handleEvent });

  const handleApprovalResolved = useCallback((id: string): void => {
    dispatch({ type: 'APPROVAL_RESOLVED', id });
  }, []);

  return (
    <div style={appStyle}>
      {/* Header */}
      <header style={headerStyle}>
        <span style={{ fontWeight: 700, fontSize: '15px', color: '#e2e8f0' }}>Apex Canvas</span>
        <ConnectionStatus status={status} />
      </header>

      {/* Approval modals — rendered on top of everything */}
      {state.pendingApprovals.map((approval) => (
        <ApprovalModal
          key={approval.approval_id}
          approval={approval}
          sessionToken={sessionToken}
          onResolved={handleApprovalResolved}
        />
      ))}

      {/* Main grid */}
      <main style={gridStyle}>
        <div style={{ gridArea: 'system' }}>
          <SystemDashboard snapshot={state.snapshot} />
        </div>
        <div style={{ gridArea: 'terminal' }}>
          <TerminalMirror lines={state.terminalLines} />
        </div>
        <div style={{ gridArea: 'heartbeat' }}>
          <HeartbeatPanel pulses={state.heartbeatPulses} />
        </div>
        <div style={{ gridArea: 'memory' }}>
          <MemoryPanel />
        </div>
      </main>
    </div>
  );
}

const appStyle: React.CSSProperties = {
  background: '#020617',
  minHeight: '100vh',
  color: '#e2e8f0',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  display: 'flex',
  flexDirection: 'column',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 20px',
  borderBottom: '1px solid #1e293b',
  background: '#0f172a',
  flexShrink: 0,
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateAreas: `
    "system terminal"
    "heartbeat memory"
  `,
  gridTemplateColumns: '1fr 1fr',
  gridTemplateRows: 'auto auto',
  gap: '16px',
  padding: '16px',
  flex: 1,
};
