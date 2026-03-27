// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/ui/src/main.tsx — JAL-014 Canvas frontend entry point
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
