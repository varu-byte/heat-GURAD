import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  let hasActiveController = Boolean(navigator.serviceWorker.controller);
  let isReloadingForUpdate = false;

  // Automatically reload when a newly deployed service worker takes control
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hasActiveController) {
      hasActiveController = true;
      return;
    }
    if (isReloadingForUpdate) return;
    isReloadingForUpdate = true;
    window.location.reload();
  });

  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      // Proactively check for updated deployments every 30 minutes
      window.setInterval(() => {
        registration.update().catch(() => {});
      }, 30 * 60 * 1000);
    },
    onRegisterError(error) {
      console.warn('Service worker registration notice:', error);
    },
  });
}

createRoot(document.getElementById('root')!).render(<App />);
