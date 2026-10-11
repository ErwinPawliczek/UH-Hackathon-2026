import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { installScrollState } from '../ui/scrollState';
import { PlayApp } from './PlayApp';

installScrollState(document);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PlayApp />
  </StrictMode>,
);
