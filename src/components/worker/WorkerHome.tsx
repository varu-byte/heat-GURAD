import React, { useState } from 'react';
import {
  MapPin,
  LocateFixed,
  Thermometer,
  Droplets,
  AlertTriangle,
  Clock,
  ShieldCheck,
  TreeDeciduous,
  Building2,
  Radio,
  CheckCircle2,
  Info,
  Languages,
  RefreshCw,
  Wifi,
  WifiOff,
  Route,
} from 'lucide-react';
import { ZoneDetail, Language } from '../../types';
import { TRANSLATIONS } from '../../utils/translations';
import { RISK_CONFIG, getHeatAdvice } from '../../utils/heatIndex';
import { ForecastUncertaintyPanel } from './ForecastUncertaintyPanel';
import {
  subscribeWeatherStatus,
  getWeatherStatus,
  fetchLiveWeatherData,
  getChennaiCurrentHour,
  WeatherServiceStatus,
} from '../../services/weather';
import { PointWeatherReading } from '../../services/location';

interface Props {
  zones: ZoneDetail[];
  selectedZoneId: string;
  onSelectZone: (id: string) => void;
  lang: Language;
  setLang: (l: Language) => void;
  onAutoDetectLocation: () => void;
  isLocating: boolean;
  userCoords: { lat: number; lng: number } | null;
  locationWeather: PointWeatherReading | null;
  locationWeatherStatus: {
    isLive: boolean;
    updatedTimeStr: string;
    error: string | null;
  } | null;
  locationMessage: { type: 'error' | 'info'; text: string } | null;
  onRefreshLocationWeather: () => Promise<void>;
  onNavigateTab: (tab: 'map' | 'coolroute' | 'nearby' | 'alerts') => void;
}

export const WorkerHome: React.FC<Props> = ({
  zones,
  selectedZoneId,
  onSelectZone,
  lang,
  setLang,
  onAutoDetectLocation,
  isLocating,
  userCoords,
  locationWeather,
  locationWeatherStatus,
  locationMessage,
  onRefreshLocationWeather,
  onNavigateTab,
}) => {
  const t = TRANSLATIONS[lang];
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [weatherStatus, setWeatherStatus] = useState<WeatherServiceStatus>(getWeatherStatus);
  const [isRetrying, setIsRetrying] = useState<boolean>(false);

  React.useEffect(() => {
    return subscribeWeatherStatus(setWeatherStatus);
  }, []);

  const usingUserLocation = Boolean(userCoords && locationWeather);

  const handleRetryWeather = async () => {
    setIsRetrying(true);
    try {
      if (usingUserLocation) {
        await onRefreshLocationWeather();
      } else {
        await fetchLiveWeatherData(true);
      }
    } catch (err) {
      // Error handled in weather/location service
    } finally {
      setIsRetrying(false);
    }
  };

  const currentZone = zones.find((z) => z.id === selectedZoneId) || zones[0];
  if (!currentZone) {
    return (
      <div className="flex items-center justify-center min-h-[50vh] p-4 text-center">
        <p className="text-stone-500">Loading Chennai Heat Data...</p>
      </div>
    );
  }

  // When "Use my location" succeeded, use weather & hourly forecast for the user's exact coordinates
  const activeHourlyReadings = usingUserLocation && locationWeather
    ? locationWeather.hourly
        .filter((h) => h.hour_num >= 6 && h.hour_num <= 22)
        .map((h) => ({
          hour: h.hour,
          hour_num: h.hour_num,
          temp: h.temp,
          humidity: h.humidity,
          heat_index: h.heat_index,
          predicted_heat_index: h.heat_index,
          risk: h.risk,
          is_safer: h.heat_index < 33,
          is_avoid: h.heat_index > 41,
        }))
    : currentZone.hourly_readings;

  const activeSaferHours = usingUserLocation
    ? activeHourlyReadings.filter((h) => h.is_safer).map((h) => h.hour)
    : currentZone.safer_hours;

  const activeAvoidHours = usingUserLocation
    ? activeHourlyReadings.filter((h) => h.is_avoid).map((h) => h.hour)
    : currentZone.avoid_hours;

  const reading = usingUserLocation && locationWeather
    ? {
        ...currentZone.current_reading,
        temp: locationWeather.temp,
        humidity: locationWeather.humidity,
        heat_index: locationWeather.heat_index,
        predicted_heat_index: locationWeather.heat_index,
        risk: locationWeather.risk,
        time: locationWeather.time,
        source: 'api' as const,
      }
    : currentZone.current_reading;

  const effectiveIsLive = usingUserLocation && locationWeatherStatus
    ? locationWeatherStatus.isLive
    : weatherStatus.isLive;
  const effectiveUpdatedTimeStr = usingUserLocation && locationWeatherStatus
    ? locationWeatherStatus.updatedTimeStr
    : weatherStatus.lastUpdatedTimeStr;
  const effectiveWeatherError = usingUserLocation && locationWeatherStatus
    ? locationWeatherStatus.error
    : weatherStatus.error;

  const risk = reading.risk;
  const riskInfo = RISK_CONFIG[risk];
  const advice = getHeatAdvice(risk, reading.heat_index, lang);

  // Current real hour in Chennai for timeline indicator
  const currentHourNum = getChennaiCurrentHour();

  // Active viewing hour data from timeline
  const activeTimelineItem =
    selectedHour !== null
      ? activeHourlyReadings.find((h) => h.hour_num === selectedHour)
      : null;

  const displayHI = activeTimelineItem
    ? activeTimelineItem.heat_index
    : reading.heat_index;
  const displayTemp = activeTimelineItem ? activeTimelineItem.temp : reading.temp;
  const displayHum = activeTimelineItem ? activeTimelineItem.humidity : reading.humidity;
  const displayPredHI = activeTimelineItem
    ? activeTimelineItem.predicted_heat_index
    : reading.predicted_heat_index || activeHourlyReadings[0]?.predicted_heat_index;
  const displayRisk = activeTimelineItem ? activeTimelineItem.risk : risk;
  const displayRiskInfo = RISK_CONFIG[displayRisk];

  return (
    <div className="max-w-3xl mx-auto px-3.5 sm:px-6 py-4 space-y-4 pb-24">
      {/* Language Selection Bar: English | தமிழ் */}
      <div className="bg-white dark:bg-stone-900 rounded-2xl p-2.5 sm:px-4 sm:py-2.5 border border-stone-200 dark:border-stone-800 flex items-center justify-between gap-2 shadow-xs">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400">
            <Languages className="w-4 h-4" />
          </div>
          <div>
            <span className="text-xs font-bold text-stone-800 dark:text-stone-200 block">
              Language / மொழி
            </span>
            <span className="text-[10px] text-stone-500">
              {lang === 'en' ? 'Click தமிழ் to turn interface into Tamil' : 'ஆங்கிலத்திற்கு English-ஐ அழுத்தவும்'}
            </span>
          </div>
        </div>

        <div className="flex items-center rounded-xl bg-stone-100 dark:bg-stone-800 p-1 border border-stone-200 dark:border-stone-700">
          <button
            onClick={() => setLang('en')}
            className={`px-3 py-1.5 rounded-lg text-xs font-extrabold transition cursor-pointer ${
              lang === 'en'
                ? 'bg-orange-600 text-white shadow-xs'
                : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-white'
            }`}
          >
            English
          </button>
          <button
            onClick={() => setLang('ta')}
            className={`px-3 py-1.5 rounded-lg text-xs font-extrabold transition cursor-pointer ${
              lang === 'ta'
                ? 'bg-orange-600 text-white shadow-xs'
                : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-white'
            }`}
          >
            தமிழ்
          </button>
        </div>
      </div>

      {/* 1. Location Display / Area Selector & "Use my location" */}
      <div className="bg-white dark:bg-stone-900 rounded-2xl p-3 sm:p-4 shadow-sm border border-stone-200 dark:border-stone-800 space-y-2.5">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
          <div className="flex-1 flex items-center gap-2">
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
              usingUserLocation
                ? 'bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400'
                : 'bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400'
            }`}>
              <MapPin className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              {usingUserLocation && userCoords ? (
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm sm:text-base font-black text-blue-700 dark:text-blue-300">
                      {lang === 'ta' ? 'உங்கள் இருப்பிடம் (Your location)' : 'Your location'}
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                      {userCoords.lat.toFixed(4)}, {userCoords.lng.toFixed(4)}
                    </span>
                  </div>
                  <select
                    id="zone-select"
                    value=""
                    onChange={(e) => {
                      if (!e.target.value) return;
                      setSelectedHour(null);
                      onSelectZone(e.target.value);
                    }}
                    className="mt-0.5 bg-transparent text-[11px] font-semibold text-stone-500 dark:text-stone-400 focus:outline-hidden cursor-pointer"
                  >
                    <option value="">
                      {lang === 'ta' ? 'அல்லது பகுதியைத் தேர்வு செய்க...' : 'Or switch to a Chennai area...'}
                    </option>
                    {zones.map((z) => (
                      <option key={z.id} value={z.id} className="dark:bg-stone-900 dark:text-stone-100">
                        {lang === 'ta' ? z.name_ta : z.name} (Ward {z.ward_no})
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <>
                  <label htmlFor="zone-select" className="text-[11px] font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400 block">
                    {t.selectZone}
                  </label>
                  <select
                    id="zone-select"
                    value={currentZone.id}
                    onChange={(e) => {
                      setSelectedHour(null);
                      onSelectZone(e.target.value);
                    }}
                    className="w-full bg-transparent text-sm sm:text-base font-extrabold text-stone-900 dark:text-stone-100 focus:outline-hidden cursor-pointer"
                  >
                    {zones.map((z) => (
                      <option key={z.id} value={z.id} className="dark:bg-stone-900 dark:text-stone-100">
                        {lang === 'ta' ? z.name_ta : z.name} (Ward {z.ward_no})
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          </div>

          {/* "Use my location" button (called ONLY on tap) */}
          <button
            type="button"
            onClick={() => {
              setSelectedHour(null);
              onAutoDetectLocation();
            }}
            disabled={isLocating}
            className="flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-orange-50 hover:bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:hover:bg-orange-900/60 dark:text-orange-300 text-xs font-bold border border-orange-200 dark:border-orange-800 transition active:scale-95 cursor-pointer disabled:opacity-50"
          >
            <LocateFixed className={`w-4 h-4 ${isLocating ? 'animate-spin' : ''}`} />
            <span>
              {isLocating
                ? t.detectingLocation
                : lang === 'ta'
                  ? 'என் இருப்பிடத்தைப் பயன்படுத்து'
                  : 'Use my location'}
            </span>
          </button>
        </div>

        {/* Clear denial / unavailable message with 5-area fallback */}
        {locationMessage && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-xs font-semibold text-amber-900 dark:text-amber-200">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <span>{locationMessage.text}</span>
          </div>
        )}
      </div>

      {/* 2. Big Heat Index Card with Risk Level & Felt Temperature */}
      <div
        className={`relative overflow-hidden rounded-3xl p-5 sm:p-7 border shadow-lg transition-all ${
          displayRisk === 'extreme'
            ? 'bg-gradient-to-br from-rose-950 via-red-900 to-stone-900 border-red-700 text-white'
            : displayRisk === 'high'
              ? 'bg-gradient-to-br from-orange-950/95 via-orange-900/85 to-stone-900 border-orange-500/70 text-white'
              : displayRisk === 'moderate'
                ? 'bg-gradient-to-br from-yellow-950/90 via-amber-900/80 to-stone-900 border-yellow-500/60 text-white'
                : 'bg-gradient-to-br from-emerald-950 via-teal-900 to-stone-900 border-emerald-600 text-white'
        }`}
      >
        {/* Top Badges: Source, Live Status with Time, & Risk Level */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-black uppercase tracking-wider ${displayRiskInfo.badgeClass}`}
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              {lang === 'ta' ? displayRiskInfo.labelTa : displayRiskInfo.labelEn}
            </span>

            {usingUserLocation && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/25 text-blue-200 border border-blue-400/50 px-2.5 py-1 text-[11px] font-black">
                <LocateFixed className="w-3 h-3" />
                {lang === 'ta' ? 'உங்கள் இருப்பிடம்' : 'Your location'}
              </span>
            )}

            {/* Live Status Badge: "Live" with update time, or "Offline" if failed */}
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-black tracking-wide border shadow-2xs ${
                effectiveIsLive
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                  : 'bg-amber-500/20 text-amber-300 border-amber-500/50'
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  effectiveIsLive
                    ? 'bg-emerald-400 animate-pulse'
                    : 'bg-amber-400'
                }`}
              />
              {effectiveIsLive
                ? `Live • ${effectiveUpdatedTimeStr || (reading.time ? new Date(reading.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Now')}`
                : 'Offline'}
            </span>

            {/* Source indicator */}
            {reading.source === 'sensor' ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 text-[11px] font-semibold">
                <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
                {t.sourceSensor}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-white/10 text-stone-300 border border-white/20 px-2 py-0.5 text-[11px] font-medium">
                Open-Meteo
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleRetryWeather}
              disabled={isRetrying || weatherStatus.loading}
              title={t.retryWeather || 'Refresh live weather'}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-stone-200 text-[11px] font-semibold transition active:scale-95 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${isRetrying || weatherStatus.loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <span className="text-[11px] text-stone-300/80 block">
              {activeTimelineItem
                ? `${activeTimelineItem.hour} Forecast`
                : `${t.lastUpdated}: ${effectiveUpdatedTimeStr || (reading.time ? new Date(reading.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Just now')}`}
            </span>
          </div>
        </div>

        {/* Loading State Feedback Banner */}
        {(weatherStatus.loading || isRetrying) && (
          <div className="mb-3 flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-blue-500/20 border border-blue-400/40 text-blue-200 text-xs animate-pulse">
            <div className="flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-400 shrink-0" />
              <span>{t.weatherConnecting || 'Fetching live weather from Open-Meteo...'}</span>
            </div>
            <span className="text-[10px] text-blue-300/80 font-mono">15m Cache</span>
          </div>
        )}

        {/* Error State Feedback Banner with Retry */}
        {effectiveWeatherError && !weatherStatus.loading && !isRetrying && (
          <div className="mb-3 flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-amber-500/20 border border-amber-400/40 text-amber-200 text-xs">
            <div className="flex items-center gap-2">
              <WifiOff className="w-4 h-4 text-amber-400 shrink-0" />
              <span className="line-clamp-1">{effectiveWeatherError}</span>
            </div>
            <button
              onClick={handleRetryWeather}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/30 hover:bg-amber-500/50 text-amber-100 font-bold text-[11px] transition shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              <span>{t.retryWeather || 'Retry'}</span>
            </button>
          </div>
        )}

        {/* Main Temperature Display: "Feels like", with Air Temp and Humidity beside it */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
          {/* Feels Like Section */}
          <div className="md:col-span-6 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase font-black tracking-wider text-orange-200 block">
                {t.feelsLike || 'Feels like'}
              </span>
              <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded-md bg-orange-500/20 text-orange-200 border border-orange-400/30">
                Rothfusz
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-6xl sm:text-7xl font-black tracking-tighter drop-shadow-md">
                {displayHI}
              </span>
              <span className="text-3xl sm:text-4xl font-extrabold text-orange-300">°C</span>
            </div>
            <p className="text-xs text-stone-200 mt-1">
              {riskInfo.description}
            </p>
          </div>

          {/* Air Temperature and Humidity directly BESIDE it */}
          <div className="md:col-span-6 grid grid-cols-2 gap-2 bg-black/35 backdrop-blur-xs p-3 sm:p-4 rounded-2xl border border-white/15">
            {/* Air Temp Metric */}
            <div className="flex items-center gap-2.5 p-2 rounded-xl bg-white/5 border border-white/10 shadow-xs">
              <div className="p-2 rounded-xl bg-orange-500/25 text-orange-300 shrink-0">
                <Thermometer className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[10px] uppercase font-bold text-stone-300 block">{t.actualTemp}</span>
                <span className="text-base sm:text-lg font-black text-white">{displayTemp}°C</span>
              </div>
            </div>

            {/* Humidity Metric */}
            <div className="flex items-center gap-2.5 p-2 rounded-xl bg-white/5 border border-white/10 shadow-xs">
              <div className="p-2 rounded-xl bg-cyan-500/25 text-cyan-300 shrink-0">
                <Droplets className="w-5 h-5" />
              </div>
              <div>
                <span className="text-[10px] uppercase font-bold text-stone-300 block">{t.humidity}</span>
                <span className="text-base sm:text-lg font-black text-white">{displayHum}%</span>
              </div>
            </div>

            {/* Urban Canopy */}
            <div className="flex items-center gap-2 p-1.5 rounded-lg">
              <div className="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 shrink-0">
                <TreeDeciduous className="w-4 h-4" />
              </div>
              <div>
                <span className="text-[10px] text-stone-300 block">{t.urbanCanopy}</span>
                <span className="text-xs font-bold text-white">{currentZone.tree_cover_pct}%</span>
              </div>
            </div>

            {/* Built-up area */}
            <div className="flex items-center gap-2 p-1.5 rounded-lg">
              <div className="p-1.5 rounded-lg bg-purple-500/20 text-purple-300 shrink-0">
                <Building2 className="w-4 h-4" />
              </div>
              <div>
                <span className="text-[10px] text-stone-300 block">{t.builtUpArea}</span>
                <span className="text-xs font-bold text-white">{currentZone.built_up_pct}%</span>
              </div>
            </div>
          </div>
        </div>

        {/* Prediction Model: Predicted vs Measured */}
        <div className="mt-4 pt-3.5 border-t border-white/15 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-stone-200">
              {t.predictedVsMeasured}:
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-stone-800/80 text-amber-300 font-mono font-bold">
              Est: {displayPredHI}°C
            </span>
            <span className="text-stone-400">vs</span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-stone-800/80 text-emerald-300 font-mono font-bold">
              Felt: {displayHI}°C
            </span>
          </div>

          <div className="text-[11px] text-stone-300">
            {currentZone.built_up_pct > 85 ? (
              <span className="text-amber-300">
                ⚠ Urban concrete island adds +{(displayHI - displayTemp).toFixed(1)}°C
              </span>
            ) : (
              <span>Tree canopy buffering heat</span>
            )}
          </div>
        </div>
      </div>

      {/* 3. Safer and Avoid-Work Hour Windows (Chips) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Safer Hours */}
        <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50 rounded-2xl p-3.5 flex items-start gap-3">
          <div className="p-2 rounded-xl bg-emerald-500 text-white shrink-0 mt-0.5">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
              {t.saferHours}
            </h2>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {activeSaferHours.length > 0 ? (
                activeSaferHours.map((sh) => (
                  <span
                    key={sh}
                    className="inline-block px-2 py-0.5 rounded-md bg-emerald-600 text-white font-mono text-xs font-bold shadow-2xs"
                  >
                    {sh}
                  </span>
                ))
              ) : (
                <span className="text-xs text-stone-600 dark:text-stone-400">
                  {lang === 'ta' ? 'அதிகாலை 06:00 - 08:30 மட்டுமே' : 'Early morning (before 09:00) only'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Avoid Work Hours */}
        <div className="bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/50 rounded-2xl p-3.5 flex items-start gap-3">
          <div className="p-2 rounded-xl bg-rose-600 text-white shrink-0 mt-0.5">
            <Clock className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-rose-800 dark:text-rose-300">
              {t.avoidHours}
            </h2>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {activeAvoidHours.length > 0 ? (
                activeAvoidHours.map((ah) => (
                  <span
                    key={ah}
                    className="inline-block px-2 py-0.5 rounded-md bg-rose-600 text-white font-mono text-xs font-bold shadow-2xs"
                  >
                    {ah}
                  </span>
                ))
              ) : (
                <span className="text-xs text-rose-700 dark:text-rose-400 font-semibold">
                  11:30 - 15:30 (Peak Sun)
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 4. Day Risk Timeline Bar (06:00 - 22:00) */}
      <div className="bg-white dark:bg-stone-900 rounded-2xl p-4 shadow-sm border border-stone-200 dark:border-stone-800">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-orange-500" />
            <h2 className="text-xs sm:text-sm font-bold text-stone-900 dark:text-stone-100">
              {t.dayRiskTimeline}
            </h2>
          </div>
          <span className="text-[11px] text-stone-500">Tap hour to view</span>
        </div>

        {/* Timeline Horizontal Bar */}
        <div className="flex items-stretch gap-1 overflow-x-auto py-2 px-0.5 scrollbar-thin">
          {activeHourlyReadings.map((hr) => {
            const isCurrent = hr.hour_num === currentHourNum;
            const isSelected = selectedHour === hr.hour_num;
            const barBg =
              hr.risk === 'extreme'
                ? 'bg-rose-600'
                : hr.risk === 'high'
                  ? 'bg-orange-500'
                  : hr.risk === 'moderate'
                    ? 'bg-yellow-500 text-stone-950'
                    : 'bg-emerald-500';

            return (
              <button
                key={hr.hour}
                onClick={() => setSelectedHour(isSelected ? null : hr.hour_num)}
                className={`flex-1 min-w-[34px] flex flex-col items-center p-1 rounded-xl transition-all cursor-pointer ${
                  isSelected
                    ? 'ring-2 ring-orange-500 bg-orange-50 dark:bg-orange-950/40 font-bold scale-105'
                    : isCurrent
                      ? 'bg-stone-100 dark:bg-stone-800 ring-1 ring-stone-400'
                      : 'hover:bg-stone-50 dark:hover:bg-stone-800/50'
                }`}
              >
                <span className="text-[10px] text-stone-500 font-mono">
                  {hr.hour.split(':')[0]}
                </span>
                <span className={`w-full h-8 rounded-md my-1 ${barBg} flex items-center justify-center text-[10px] font-black shadow-2xs ${hr.risk === 'moderate' ? 'text-stone-950' : 'text-white'}`}>
                  {Math.round(hr.heat_index)}
                </span>
                <span className="text-[9px] text-stone-500 font-medium">
                  {hr.temp}°
                </span>
                {isCurrent && (
                  <span className="w-1.5 h-1.5 rounded-full bg-orange-600 mt-0.5" title="Now" />
                )}
              </button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center justify-center gap-4 mt-2.5 pt-2 border-t border-stone-100 dark:border-stone-800 text-[11px] text-stone-600 dark:text-stone-400">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
            <span>&lt;32°C Low</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
            <span>32-36°C Moderate</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-orange-500" />
            <span>36-41°C High</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-600" />
            <span>&gt;41°C Extreme</span>
          </div>
        </div>
      </div>

      {/* 4b. 24h / 48h / 72h Forecast With Uncertainty & Calibration */}
      <ForecastUncertaintyPanel
        lat={usingUserLocation && userCoords ? userCoords.lat : currentZone.lat}
        lng={usingUserLocation && userCoords ? userCoords.lng : currentZone.lng}
        locationLabel={
          usingUserLocation
            ? lang === 'ta'
              ? 'உங்கள் இருப்பிடம்'
              : 'Your location'
            : lang === 'ta'
              ? currentZone.name_ta
              : currentZone.name
        }
        lang={lang}
      />

      {/* 5. Protective Advice & Mandatory Actions */}
      <div className="bg-white dark:bg-stone-900 rounded-2xl p-4 sm:p-5 shadow-sm border border-stone-200 dark:border-stone-800">
        <div className="flex items-center gap-2 mb-2">
          <div className="p-1.5 rounded-lg bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-stone-900 dark:text-stone-100">
              {advice.title}
            </h2>
            <p className="text-xs text-stone-500">{t.safetyGuidance}</p>
          </div>
        </div>

        <p className="text-xs sm:text-sm text-stone-700 dark:text-stone-300 mt-2 leading-relaxed bg-stone-50 dark:bg-stone-800/40 p-3 rounded-xl border border-stone-200/60 dark:border-stone-700/60">
          {advice.advice}
        </p>

        <div className="mt-3.5 space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400">
            {t.recommendedActions}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {advice.actions.map((act, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 p-2.5 rounded-xl bg-orange-50/50 dark:bg-orange-950/20 border border-orange-200/50 dark:border-orange-800/30 text-xs text-stone-800 dark:text-stone-200"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <span>{act}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Quick actions for workers */}
        <div className="mt-4 pt-3 border-t border-stone-100 dark:border-stone-800 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onNavigateTab('coolroute')}
            className="flex-1 min-w-[140px] py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
          >
            <Route className="w-4 h-4" />
            <span>{t.tabCoolRoute}</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigateTab('nearby')}
            className="flex-1 min-w-[140px] py-2.5 px-3 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm cursor-pointer"
          >
            <MapPin className="w-4 h-4" />
            <span>{t.tabNearby} ({currentZone.relief_points_count})</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigateTab('alerts')}
            className="flex-1 min-w-[140px] py-2.5 px-3 rounded-xl bg-stone-800 hover:bg-stone-700 text-white text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Info className="w-4 h-4 text-amber-400" />
            <span>{lang === 'ta' ? 'ஓய்வு பதிவு செய்' : 'Log a 15m Break'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
