import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { useSim } from './store/sim';
import { installScrollState } from './ui/scrollState';

// Dev-only test hook: lets capture/automation scripts select sites and drive
// playback deterministically without pixel-hunting the canvas.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__useSim = useSim;
}

// scroll bars turn blue while their content is moving (see index.css)
installScrollState(document);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
