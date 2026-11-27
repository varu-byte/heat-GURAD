import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { BottomNav, WorkerTab } from './components/worker/BottomNav';
import { WorkerHome } from './components/worker/WorkerHome';
import { WorkerMap } from './components/worker/WorkerMap';
import { WorkerCoolRoute } from './components/worker/WorkerCoolRoute';
import { WorkerNearby } from './components/worker/WorkerNearby';
import { WorkerAlerts } from './components/worker/WorkerAlerts';
import { AuthorityDashboard } from './components/authority/AuthorityDashboard';
import { OfflineIndicator } from './components/common/OfflineIndicator';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { ZoneDetail, ReliefPoint, HeatAlert, Language } from './types';
import {
  fetchAllZones,
  fetchReliefPoints,
  fetchAlerts,
  fetchBreaks,
} from './services/api';
import {
  getUserLocation,
  findNearestArea,
  fetchLocationWeather,
  PointWeatherReading,
  LocationError,
} from './services/location';
import { useOnlineStatus } from './hooks/useOnlineStatus';

function isAuthorityPath(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.replace(/\/+$/, '') === '/authority';
}

export default function App() {
  const isOnline = useOnlineStatus();

  // App settings & accessibility (Default to English as requested)
  const [lang, setLang] = useState<Language>(() => {
    return (localStorage.getItem('c_heat_lang') as Language) || 'en';
  });
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('c_heat_dark');
    return saved !== null ? saved === 'true' : true;
  });
  const [highContrast, setHighContrast] = useState<boolean>(() => {
    return localStorage.getItem('c_heat_contrast') === 'true';
  });
  const [largeText, setLargeText] = useState<boolean>(() => {
    return localStorage.getItem('c_heat_largetext') === 'true';
  });

  // Route state synced with /authority vs /
  const [isAuthority, setIsAuthority] = useState<boolean>(isAuthorityPath);
  const [activeWorkerTab, setActiveWorkerTab] = useState<WorkerTab>('home');

  // Worker Data states
  const [zones, setZones] = useState<ZoneDetail[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState<string>('koyambedu');
  const [reliefPoints, setReliefPoints] = useState<ReliefPoint[]>([]);
  const [alerts, setAlerts] = useState<HeatAlert[]>([]);
  const [todayBreakCount, setTodayBreakCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Transient session-only GPS Coordinates & Exact Location Weather (never stored)
  const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locationWeather, setLocationWeather] = useState<PointWeatherReading | null>(null);
  const [locationWeatherStatus, setLocationWeatherStatus] = useState<{
    isLive: boolean;
    updatedTimeStr: string;
    error: string | null;
  } | null>(null);
  const [locationMessage, setLocationMessage] = useState<{
    type: 'error' | 'info';
    text: string;
  } | null>(null);
  const [isLocating, setIsLocating] = useState<boolean>(false);

  // Sync browser back/forward buttons with /authority route
  useEffect(() => {
    const onPopState = () => {
      setIsAuthority(isAuthorityPath());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const handleToggleAuthority = (next: boolean) => {
    setIsAuthority(next);
    const targetPath = next ? '/authority' : '/';
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }
  };

  // Save preferences
  useEffect(() => {
    localStorage.setItem('c_heat_lang', lang);
  }, [lang]);

  useEffect(() => {
    localStorage.setItem('c_heat_dark', darkMode.toString());
    if (darkMode) {
      document.documentElement.classList.add('dark');
      document.body.classList.add('dark');
      document.documentElement.style.colorScheme = 'dark';
    } else {
      document.documentElement.classList.remove('dark');
      document.body.classList.remove('dark');
      document.documentElement.style.colorScheme = 'light';
    }
  }, [darkMode]);

  useEffect(() => {
    localStorage.setItem('c_heat_contrast', highContrast.toString());
  }, [highContrast]);

  useEffect(() => {
    localStorage.setItem('c_heat_largetext', largeText.toString());
  }, [largeText]);

  // Load worker data resiliently
  const loadData = useCallback(async () => {
    const [zonesRes, reliefRes, alertsRes, breaksRes] = await Promise.allSettled([
      fetchAllZones(),
      fetchReliefPoints(),
      fetchAlerts(),
      fetchBreaks(),
    ]);

    if (zonesRes.status === 'fulfilled') {
      setZones(zonesRes.value);
      setError(null);
    } else {
      console.warn('Unable to fetch zones:', zonesRes.reason);
      setError('Unable to fetch live heat data. Showing cached readings if available.');
    }

    if (reliefRes.status === 'fulfilled') {
      setReliefPoints(reliefRes.value);
    }
    if (alertsRes.status === 'fulfilled') {
      setAlerts(alertsRes.value);
    }
    if (breaksRes.status === 'fulfilled') {
      setTodayBreakCount(breaksRes.value.total_today || 0);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, [loadData]);

  // "Use my location": called ONLY on explicit user tap. Never persisted anywhere.
  const handleAutoDetectLocation = async () => {
    setIsLocating(true);
    setLocationMessage(null);
    try {
      const coords = await getUserLocation();
      setUserCoords(coords);

      const weatherRes = await fetchLocationWeather(coords.lat, coords.lng);
      setLocationWeather(weatherRes.reading);
      setLocationWeatherStatus({
        isLive: weatherRes.isLive,
        updatedTimeStr: weatherRes.updatedTimeStr,
        error: weatherRes.error,
      });
    } catch (err: any) {
      // Clear unverified coordinates on failure
      setUserCoords(null);
      setLocationWeather(null);
      setLocationWeatherStatus(null);

      // Fall back to the nearest of the 5 areas (T. Nagar, Koyambedu, Guindy, Marina, Ennore)
      const currentZone = zones.find((z) => z.id === selectedZoneId);
      const refLat = currentZone?.lat ?? 13.06;
      const refLng = currentZone?.lng ?? 80.22;
      const nearest5 = findNearestArea(refLat, refLng);
      setSelectedZoneId(nearest5.id);

      const isDenied = err instanceof LocationError && err.code === 'DENIED';
      const fallbackMsg =
        lang === 'ta'
          ? isDenied
            ? `இருப்பிட அனுமதி மறுக்கப்பட்டது. அருகிலுள்ள பகுதி (${nearest5.name}) காட்டப்படுகிறது.`
            : `உங்கள் இருப்பிடத்தைக் கண்டறிய முடியவில்லை. அருகிலுள்ள பகுதி (${nearest5.name}) காட்டப்படுகிறது.`
          : isDenied
            ? `Location permission was denied. Showing nearest area: ${nearest5.name}.`
            : `${err?.message || 'Location is unavailable.'} Showing nearest area: ${nearest5.name}.`;

      setLocationMessage({ type: 'error', text: fallbackMsg });
    } finally {
      setIsLocating(false);
    }
  };

  const handleSelectZoneManual = (zoneId: string) => {
    setSelectedZoneId(zoneId);
    setUserCoords(null);
    setLocationWeather(null);
    setLocationWeatherStatus(null);
    setLocationMessage(null);
  };

  const handleRefreshLocationWeather = useCallback(async () => {
    if (!userCoords) return;
    try {
      const weatherRes = await fetchLocationWeather(userCoords.lat, userCoords.lng);
      setLocationWeather(weatherRes.reading);
      setLocationWeatherStatus({
        isLive: weatherRes.isLive,
        updatedTimeStr: weatherRes.updatedTimeStr,
        error: weatherRes.error,
      });
    } catch (err: any) {
      setLocationWeatherStatus((prev) => ({
        isLive: false,
        updatedTimeStr: prev?.updatedTimeStr || '',
        error: err?.message || 'Unable to refresh weather for your location.',
      }));
    }
  }, [userCoords]);

  // Refresh single-point user location weather every 15 minutes while location is active
  useEffect(() => {
    if (!userCoords) return;
    const interval = setInterval(() => {
      handleRefreshLocationWeather();
    }, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, [userCoords, handleRefreshLocationWeather]);

  return (
    <ErrorBoundary>
      <div
        className={`${darkMode ? 'dark' : ''} min-h-screen flex flex-col bg-stone-100 text-stone-900 dark:bg-stone-950 dark:text-stone-100 transition-colors ${
          highContrast ? 'high-contrast-mode contrast-125' : ''
        } ${largeText ? 'large-text-mode text-base' : 'text-sm'}`}
      >
      {/* Universal Header */}
      <Header
        lang={lang}
        setLang={setLang}
        isAuthority={isAuthority}
        onToggleAuthority={handleToggleAuthority}
        highContrast={highContrast}
        setHighContrast={setHighContrast}
        largeText={largeText}
        setLargeText={setLargeText}
        darkMode={darkMode}
        setDarkMode={setDarkMode}
        isOnline={isOnline}
      />

      {/* Main Content Area */}
      <main className="flex-1 w-full">
        {isAuthority ? (
          /* Read-Only GCC Authority Portal (/authority) */
          <AuthorityDashboard lang={lang} />
        ) : loading && zones.length === 0 ? (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3 text-center p-4">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-orange-500 border-t-transparent" />
            <p className="text-xs sm:text-sm font-bold text-stone-600 dark:text-stone-400">
              {lang === 'ta'
                ? 'சென்னை வானிலை தகவல்கள் பெறப்படுகின்றன...'
                : 'Connecting to Open-Meteo Live Weather...'}
            </p>
            {error && <p className="text-xs text-rose-500">{error}</p>}
          </div>
        ) : (
          /* Outdoor Worker View */
          <div>
            {activeWorkerTab === 'home' && (
              <WorkerHome
                zones={zones}
                selectedZoneId={selectedZoneId}
                onSelectZone={handleSelectZoneManual}
                lang={lang}
                setLang={setLang}
                onAutoDetectLocation={handleAutoDetectLocation}
                isLocating={isLocating}
                userCoords={userCoords}
                locationWeather={locationWeather}
                locationWeatherStatus={locationWeatherStatus}
                locationMessage={locationMessage}
                onRefreshLocationWeather={handleRefreshLocationWeather}
                onNavigateTab={(tab) => setActiveWorkerTab(tab)}
              />
            )}

            {activeWorkerTab === 'map' && (
              <WorkerMap
                zones={zones}
                reliefPoints={reliefPoints}
                selectedZoneId={selectedZoneId}
                onSelectZone={handleSelectZoneManual}
                lang={lang}
                userCoords={userCoords}
                locationWeather={locationWeather}
                locationWeatherStatus={locationWeatherStatus}
                onLocateMe={handleAutoDetectLocation}
                isLocating={isLocating}
                locationMessage={locationMessage}
                onNavigateTab={(tab) => setActiveWorkerTab(tab)}
              />
            )}

            {activeWorkerTab === 'coolroute' && (
              <WorkerCoolRoute
                zones={zones}
                reliefPoints={reliefPoints}
                selectedZoneId={selectedZoneId}
                userCoords={userCoords}
                onLocateMe={handleAutoDetectLocation}
                isLocating={isLocating}
                lang={lang}
              />
            )}

            {activeWorkerTab === 'nearby' && (
              <WorkerNearby
                reliefPoints={reliefPoints}
                zones={zones}
                selectedZoneId={selectedZoneId}
                userCoords={userCoords}
                lang={lang}
              />
            )}

            {activeWorkerTab === 'alerts' && (
              <WorkerAlerts
                alerts={alerts}
                zones={zones}
                selectedZoneId={selectedZoneId}
                lang={lang}
                onRefreshBreaks={loadData}
                todayBreakCount={todayBreakCount}
              />
            )}

            {/* Worker Mobile-first Bottom Navigation Tabs */}
            <BottomNav
              activeTab={activeWorkerTab}
              setActiveTab={setActiveWorkerTab}
              lang={lang}
              alertsCount={alerts.filter((a) => a.level === 'extreme').length}
            />
          </div>
        )}
      </main>

      {/* Offline Toast Indicator */}
      <OfflineIndicator lang={lang} />
    </div>
    </ErrorBoundary>
  );
}
