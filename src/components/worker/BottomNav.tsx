import React from 'react';
import { Home, MapPin, Compass, BellRing, Route } from 'lucide-react';
import { Language } from '../../types';
import { TRANSLATIONS } from '../../utils/translations';

export type WorkerTab = 'home' | 'map' | 'coolroute' | 'nearby' | 'alerts';

interface Props {
  activeTab: WorkerTab;
  setActiveTab: (tab: WorkerTab) => void;
  lang: Language;
  alertsCount?: number;
}

export const BottomNav: React.FC<Props> = ({ activeTab, setActiveTab, lang, alertsCount = 0 }) => {
  const t = TRANSLATIONS[lang];

  const tabs: Array<{ id: WorkerTab; label: string; icon: React.ReactNode; badge?: number }> = [
    {
      id: 'home',
      label: t.tabHome,
      icon: <Home className="w-5 h-5" />,
    },
    {
      id: 'map',
      label: t.tabMap,
      icon: <MapPin className="w-5 h-5" />,
    },
    {
      id: 'coolroute',
      label: t.tabCoolRoute,
      icon: <Route className="w-5 h-5" />,
    },
    {
      id: 'nearby',
      label: t.tabNearby,
      icon: <Compass className="w-5 h-5" />,
    },
    {
      id: 'alerts',
      label: t.tabAlerts,
      icon: <BellRing className="w-5 h-5" />,
      badge: alertsCount,
    },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-stone-900/95 backdrop-blur-md border-t border-stone-800 text-stone-300 pb-[env(safe-area-inset-bottom)] shadow-lg">
      <div className="max-w-lg mx-auto flex items-center justify-around px-1.5 py-1.5">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex flex-col items-center justify-center flex-1 min-h-[44px] py-1.5 px-1 rounded-xl transition-all duration-200 cursor-pointer ${
                isActive
                  ? 'text-orange-400 font-bold'
                  : 'text-stone-400 hover:text-stone-200'
              }`}
            >
              <div className="relative">
                {tab.icon}
                {tab.badge && tab.badge > 0 ? (
                  <span className="absolute -top-1.5 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white shadow-xs">
                    {tab.badge}
                  </span>
                ) : null}
              </div>
              <span className="text-[11px] mt-1 tracking-tight truncate max-w-[78px] whitespace-nowrap">
                {tab.label}
              </span>
              {isActive && (
                <span className="w-4 h-0.5 bg-orange-500 rounded-full mt-0.5" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};
