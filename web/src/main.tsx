import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { HostApp } from './host/HostApp';
import './index.css';
import { useSim } from './store/sim';
import { installScrollState } from './ui/scrollState';
import { notePress } from './ui/windows';

// Dev-only test hook: lets capture/automation scripts select sites and drive
// playback deterministically without pixel-hunting the canvas.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__useSim = useSim;
}

// scroll bars turn blue while their content is moving (see index.css)
installScrollState(document);
// where the visitor last pressed: a window that opens by itself keeps clear of it
document.addEventListener('pointerdown', (e) => notePress(e.clientX, e.clientY, performance.now()), true);

// /host/ is the multiplayer host's big screen; everything else is the app
const hosting = window.location.pathname.replace(/\/+$/, '').endsWith('/host');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {hosting ? <HostApp /> : <App />}
  </StrictMode>,
);
