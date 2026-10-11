import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { useSim } from './store/sim';

// Dev-only test hook: lets capture/automation scripts select sites and drive
// playback deterministically without pixel-hunting the canvas.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__useSim = useSim;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
