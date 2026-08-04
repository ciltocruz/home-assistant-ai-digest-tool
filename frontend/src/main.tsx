import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import { App } from './App.js';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found.');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
