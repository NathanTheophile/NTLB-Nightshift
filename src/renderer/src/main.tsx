import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { RendererErrorBoundary } from './components/RendererErrorBoundary';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('NightShift renderer root was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </StrictMode>,
);
