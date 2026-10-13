import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AuthGate } from './components/AuthGate';
import { SettingsProvider } from './components/SettingsProvider';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </AuthGate>
  </React.StrictMode>,
);
