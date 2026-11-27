import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

interface Props {
  lang: 'en' | 'ta';
}

export const OfflineIndicator: React.FC<Props> = ({ lang }) => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="fixed bottom-20 left-4 right-4 sm:left-auto sm:right-6 sm:w-80 z-50 flex items-center gap-2.5 rounded-2xl bg-amber-500/95 backdrop-blur-md px-3.5 py-2.5 text-xs font-bold text-white shadow-xl border border-amber-400 animate-in fade-in duration-300">
      <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-amber-600 shrink-0">
        <WifiOff className="w-4 h-4 text-white" />
      </div>
      <div>
        <p className="leading-tight">
          {lang === 'ta'
            ? 'இணையமற்ற நிலை — சேமிக்கப்பட்ட தகவல்கள் காட்டப்படுகின்றன.'
            : 'Offline Mode — Showing last cached thermal readings & relief spots.'}
        </p>
      </div>
    </div>
  );
};
