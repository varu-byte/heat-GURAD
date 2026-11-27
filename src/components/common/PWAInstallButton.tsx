import React, { useState } from 'react';
import { Download, Smartphone } from 'lucide-react';
import { usePWAInstall } from '../../hooks/usePWAInstall';

interface Props {
  lang: 'en' | 'ta';
}

export const PWAInstallButton: React.FC<Props> = ({ lang }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        onClick={install}
        className="flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-orange-700 transition active:scale-95 cursor-pointer"
        title="Install Chennai Heat Guard App"
      >
        <Download className="w-3.5 h-3.5" />
        <span>{lang === 'ta' ? 'செயலி நிறுவு' : 'Install PWA'}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          className="flex items-center gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-1.5 text-xs font-semibold text-orange-700 dark:text-orange-300 hover:bg-orange-500/20 transition cursor-pointer"
        >
          <Smartphone className="w-3.5 h-3.5" />
          <span>{lang === 'ta' ? 'iOS நிறுவல்' : 'Install on iOS'}</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl dark:bg-stone-900 border border-stone-200 dark:border-stone-800">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400">
                  <Smartphone className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="font-bold text-stone-900 dark:text-stone-100 text-base">
                    {lang === 'ta' ? 'ஐபோனில் நிறுவ' : 'Install on iPhone / iPad'}
                  </h3>
                  <p className="text-xs text-stone-500">Chennai Heat Guard PWA</p>
                </div>
              </div>
              <div className="mt-4 space-y-2 text-xs text-stone-700 dark:text-stone-300 leading-relaxed bg-stone-50 dark:bg-stone-800/50 p-3.5 rounded-xl border border-stone-200/60 dark:border-stone-700/60">
                <p>
                  1. Tap the <strong>Share</strong> button (box with arrow) in Safari bottom bar.
                </p>
                <p>
                  2. Scroll down and tap <strong>Add to Home Screen</strong> (முகப்புத் திரையில் சேர்க்க).
                </p>
                <p>3. Tap <strong>Add</strong> at the top right to access offline anytime.</p>
              </div>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 w-full rounded-xl bg-orange-600 py-2.5 text-xs font-semibold text-white hover:bg-orange-700 transition"
              >
                {lang === 'ta' ? 'சரி, புரிந்தது' : 'Got it'}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
