import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './controller';
import './styles.css';
import { initTurnstile } from './turnstile';

initTurnstile();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
