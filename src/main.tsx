import React from 'react';
import { createRoot } from 'react-dom/client';
import { HeroUIProvider, ToastProvider } from '@heroui/react';
import './theme';
import './index.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <React.StrictMode>
    <HeroUIProvider className="h-full w-full">
      {/* Where notices from the office and the agents appear. Without it HeroUI's addToast() shows nothing. */}
      <ToastProvider placement="bottom-right" />
      <App />
    </HeroUIProvider>
  </React.StrictMode>,
);
