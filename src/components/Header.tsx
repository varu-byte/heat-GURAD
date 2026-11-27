import React from 'react';
import {
  Flame,
  Languages,
  SunMedium,
  Moon,
  Type,
  Eye,
  ShieldAlert,
  HardHat,
  WifiOff,
} from 'lucide-react';
import { Language } from '../types';
import { TRANSLATIONS } from '../utils/translations';
import { PWAInstallButton } from './common/PWAInstallButton';

interface HeaderProps {
  lang: Language;
  setLang: (l: Language) => void;
  isAuthority: boolean;
  onToggleAuthority: (next: boolean) => void;
  highContrast: boolean;
  setHighContrast: (v: boolean | ((prev: boolean) => boolean)) => void;
  largeText: boolean;
  setLargeText: (v: boolean | ((prev: boolean) => boolean)) => void;
  darkMode: boolean;
  setDarkMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  isOnline: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  lang,
  setLang,
  isAuthority,
  onToggleAuthority,
  highContrast,
  setHighContrast,
  largeText,
  setLargeText,
  darkMode,
  setDarkMode,
  isOnline,
}) => {
  const t = TRANSLATIONS[lang];

  return (
    <header className="sticky top-0 z-40 w-full border-b border-stone-200/80 bg-stone-900 text-white shadow-md dark:border-stone-800 transition-colors">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
        {/* Brand */}
        <div className="flex items-center gap-2.5">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 via-orange-600 to-red-600 shadow-md shadow-orange-500/20">
            <Flame className="h-6 w-6 text-white animate-pulse" />
            <span className="absolute -top-1 -right-1 flex h-3 w-3">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isOnline ? 'bg-emerald-400' : 'bg-amber-400'}`}></span>
              <span className={`relative inline-flex rounded-full h-3 w-3 ${isOnline ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
            </span>
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-black text-base sm:text-lg tracking-tight text-white flex items-center gap-1.5">
                {t.appTitle}
              </h1>
              {!isOnline && (
                <span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-500/30">
                  <WifiOff className="w-2.5 h-2.5" /> Offline
                </span>
              )}
            </div>
            <p className="text-[11px] text-orange-200/80 line-clamp-1 hidden xs:block">
              {lang === 'ta' ? 'சென்னை வெளிப்புற தொழிலாளர் வெப்பத் தணிப்பு' : 'Thermal Safety for Outdoor Workers • GCC'}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center flex-wrap gap-1.5 sm:gap-2">
          {/* PWA Install Button */}
          <PWAInstallButton lang={lang} />

          {/* Language Selector: Explicit English / Tamil buttons */}
          <div className="flex items-center rounded-xl bg-stone-800 p-0.5 border border-stone-700 shadow-2xs">
            <button
              onClick={() => setLang('en')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                lang === 'en'
                  ? 'bg-amber-400 text-stone-950 shadow-sm'
                  : 'text-stone-300 hover:text-white'
              }`}
              title="Switch interface to English"
            >
              <span>English</span>
            </button>
            <button
              onClick={() => setLang('ta')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                lang === 'ta'
                  ? 'bg-amber-400 text-stone-950 shadow-sm'
                  : 'text-stone-300 hover:text-white'
              }`}
              title="இடைமுகத்தை தமிழில் மாற்றுக (Switch to Tamil)"
            >
              <span>தமிழ்</span>
            </button>
          </div>

          {/* Accessibility: High Contrast (Vital for direct sunlight) */}
          <button
            onClick={() => setHighContrast((prev) => !prev)}
            className={`p-1.5 rounded-lg border text-xs transition cursor-pointer ${
              highContrast
                ? 'bg-yellow-400 text-black border-yellow-300 font-extrabold shadow-sm'
                : 'bg-stone-800 text-stone-300 border-stone-700 hover:bg-stone-700'
            }`}
            title="High Contrast Mode for Sunlight Readability"
            aria-label="High Contrast"
          >
            <Eye className="w-4 h-4" />
          </button>

          {/* Accessibility: Large Text */}
          <button
            onClick={() => setLargeText((prev) => !prev)}
            className={`p-1.5 rounded-lg border text-xs transition cursor-pointer ${
              largeText
                ? 'bg-orange-500 text-white border-orange-400 font-extrabold shadow-sm'
                : 'bg-stone-800 text-stone-300 border-stone-700 hover:bg-stone-700'
            }`}
            title="Toggle Large Text for Visibility"
            aria-label="Large Text"
          >
            <Type className="w-4 h-4" />
          </button>

          {/* Dark / Light Mode */}
          <button
            onClick={() => setDarkMode((prev) => !prev)}
            className={`p-1.5 rounded-lg border text-xs transition active:scale-90 cursor-pointer flex items-center justify-center ${
              darkMode
                ? 'bg-stone-800 border-amber-500/40 text-amber-400 hover:bg-stone-700 hover:border-amber-400 shadow-xs'
                : 'bg-stone-800 border-blue-400/40 text-blue-300 hover:bg-stone-700 hover:border-blue-300 shadow-xs'
            }`}
            title={darkMode ? (lang === 'ta' ? 'பகல் முறைக்கு மாற்றுக' : 'Switch to Light Mode') : (lang === 'ta' ? 'இரவு முறைக்கு மாற்றுக' : 'Switch to Dark Mode')}
            aria-label={darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            {darkMode ? (
              <SunMedium className="w-4 h-4 text-amber-400 transition-transform hover:rotate-45" />
            ) : (
              <Moon className="w-4 h-4 text-blue-300 transition-transform hover:-rotate-12" />
            )}
          </button>

          {/* Role Switcher: Worker (/) vs Read-Only Authority (/authority) */}
          <button
            onClick={() => onToggleAuthority(!isAuthority)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition shadow-sm cursor-pointer ${
              isAuthority
                ? 'bg-red-600 text-white hover:bg-red-700 border border-red-500'
                : 'bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700'
            }`}
          >
            {isAuthority ? (
              <>
                <HardHat className="w-3.5 h-3.5 text-amber-300" />
                <span className="hidden sm:inline">{t.switchWorker}</span>
                <span className="sm:hidden">{lang === 'ta' ? 'தொழிலாளர்' : 'Worker'}</span>
              </>
            ) : (
              <>
                <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
                <span className="hidden sm:inline">{t.switchAuthority}</span>
                <span className="sm:hidden">{lang === 'ta' ? 'அதிகாரி' : 'GCC'}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </header>
  );
};
