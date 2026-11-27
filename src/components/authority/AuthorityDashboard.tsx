import React, { useCallback, useEffect, useState } from 'react';
import {
  BellRing,
  Building,
  Clock,
  Info,
  LogOut,
  Map as MapIcon,
  ShieldCheck,
  Sliders,
  Users,
} from 'lucide-react';
import { User } from 'firebase/auth';
import { Language, ReliefPoint } from '../../types';
import {
  getReadings,
  getCurrentReading,
  subscribeWeatherStatus,
  getWeatherStatus,
  WeatherServiceStatus,
} from '../../../services/weather';
import { heatIndex } from '../../utils/heatIndex';
import staticReliefPoints from '../../../data/relief-points.json';
import { HotspotMap, AuthorityHotspotArea } from './HotspotMap';
import { AlertEscalationCenter } from './AlertEscalationCenter';
import { LocationsAndRecipientsManager } from './LocationsAndRecipientsManager';
import { EscalationSettingsPanel } from './EscalationSettingsPanel';
import {
  EscalationOverviewResponse,
  fetchEscalationOverview,
} from '../../services/escalationApi';
import {
  checkIsAdmin,
  signInWithGoogle,
  signOutFirebase,
  subscribeAuth,
} from '../../services/firebase';

type AuthorityTab = 'escalation' | 'hotspots' | 'locations' | 'settings';

interface AreaMetadata {
  id: string;
  name: string;
  name_ta: string;
  ward_no: number;
  lat: number;
  lng: number;
}

const CHENNAI_AREAS: AreaMetadata[] = [
  { id: 't-nagar', name: 'T. Nagar', name_ta: 'தி. நகர்', ward_no: 141, lat: 13.0418, lng: 80.2341 },
  { id: 'koyambedu', name: 'Koyambedu', name_ta: 'கோயம்பேடு', ward_no: 127, lat: 13.0694, lng: 80.1948 },
  { id: 'guindy', name: 'Guindy', name_ta: 'கிண்டி', ward_no: 168, lat: 13.0067, lng: 80.2025 },
  { id: 'marina', name: 'Marina Beach', name_ta: 'மெரினா கடற்கரை', ward_no: 111, lat: 13.0500, lng: 80.2824 },
  { id: 'ennore', name: 'Ennore', name_ta: 'எண்ணூர்', ward_no: 1, lat: 13.2030, lng: 80.3230 },
  { id: 'velachery', name: 'Velachery', name_ta: 'வேளச்சேரி', ward_no: 178, lat: 12.9815, lng: 80.2180 },
  { id: 'tambaram', name: 'Tambaram', name_ta: 'தாம்பரம்', ward_no: 200, lat: 12.9249, lng: 80.1000 },
  { id: 'anna-nagar', name: 'Anna Nagar', name_ta: 'அண்ணா நகர்', ward_no: 100, lat: 13.0850, lng: 80.2101 },
  { id: 'adyar', name: 'Adyar', name_ta: 'அடையாறு', ward_no: 173, lat: 13.0012, lng: 80.2565 },
  { id: 'perambur', name: 'Perambur', name_ta: 'பெரம்பூர்', ward_no: 70, lat: 13.1075, lng: 80.2334 },
];

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

interface PriorityRow extends AuthorityHotspotArea {
  shadeWithin500m: number;
  waterWithin500m: number;
  reliefPointsWithin500m: number;
  reliefGap: number;
  priorityScore: number;
  suggestedActionEn: string;
  suggestedActionTa: string;
}

interface Props {
  lang: Language;
}

export const AuthorityDashboard: React.FC<Props> = ({ lang }) => {
  const reliefPoints = staticReliefPoints as ReliefPoint[];
  const [activeTab, setActiveTab] = useState<AuthorityTab>('escalation');

  // Hotspots & Priority Table states (Read-Only Open-Meteo + static relief points)
  const [areas, setAreas] = useState<AuthorityHotspotArea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weatherStatus, setWeatherStatus] = useState<WeatherServiceStatus>(getWeatherStatus);

  // Escalation System Overview & Firebase Auth state
  const [overview, setOverview] = useState<EscalationOverviewResponse | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);

  const loadEscalationData = useCallback(async () => {
    try {
      const data = await fetchEscalationOverview();
      setOverview(data);
      setOverviewError(null);
    } catch (err: any) {
      setOverviewError(err?.message || 'Unable to connect to escalation engine.');
    }
  }, []);

  useEffect(() => {
    const unsub = subscribeAuth(async (user) => {
      setFirebaseUser(user);
      const adminOk = await checkIsAdmin(user);
      setIsAdmin(adminOk);
    });
    return () => unsub();
  }, []);

  const handleSignInAdmin = async () => {
    try {
      const user = await signInWithGoogle();
      setFirebaseUser(user);
      const adminOk = await checkIsAdmin(user);
      setIsAdmin(adminOk);
    } catch (err: any) {
      console.warn('Admin sign-in cancelled or failed:', err?.message);
    }
  };

  useEffect(() => {
    const unsubscribe = subscribeWeatherStatus(setWeatherStatus);
    let cancelled = false;

    async function loadReadOnlyData() {
      try {
        const computed = await Promise.all(
          CHENNAI_AREAS.map(async (area) => {
            const [hourly, current] = await Promise.all([
              getReadings(area.id),
              getCurrentReading(area.id),
            ]);

            const currentHi = heatIndex(current.temp, current.humidity);
            const extremeHoursToday = hourly.reduce((count, h) => {
              const hourHi = heatIndex(h.temp, h.humidity);
              return hourHi > 41 ? count + 1 : count;
            }, 0);

            return {
              ...area,
              temp: current.temp,
              humidity: current.humidity,
              heatIndex: currentHi,
              extremeHoursToday,
            };
          })
        );

        if (!cancelled) {
          setAreas(computed);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Unable to load weather readings.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadReadOnlyData();
    loadEscalationData();

    const interval = setInterval(() => {
      loadReadOnlyData();
      loadEscalationData();
    }, 60000);

    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(interval);
    };
  }, [loadEscalationData]);

  const priorityRows: PriorityRow[] = areas
    .map((area) => {
      let shadeWithin500m = 0;
      let waterWithin500m = 0;

      reliefPoints.forEach((rp) => {
        const dist = haversineMeters(area.lat, area.lng, rp.lat, rp.lng);
        if (dist <= 500) {
          if (rp.type === 'shade') shadeWithin500m += 1;
          if (rp.type === 'water') waterWithin500m += 1;
        }
      });

      const reliefPointsWithin500m = shadeWithin500m + waterWithin500m;
      const reliefGap = Math.max(0, 3 - reliefPointsWithin500m);
      const priorityScore = area.extremeHoursToday * reliefGap;

      let suggestedActionEn = 'Maintain existing points';
      let suggestedActionTa = 'தற்போதைய மையங்களை பராமரிக்கவும்';
      if (shadeWithin500m === 0 && waterWithin500m === 0) {
        suggestedActionEn = 'Add shade, add water point';
        suggestedActionTa = 'நிழல் மற்றும் குடிநீர் மையம் அமைக்கவும்';
      } else if (shadeWithin500m === 0) {
        suggestedActionEn = 'Add shade';
        suggestedActionTa = 'நிழல் மையம் அமைக்கவும்';
      } else if (waterWithin500m === 0) {
        suggestedActionEn = 'Add water point';
        suggestedActionTa = 'குடிநீர் மையம் அமைக்கவும்';
      }

      return {
        ...area,
        shadeWithin500m,
        waterWithin500m,
        reliefPointsWithin500m,
        reliefGap,
        priorityScore,
        suggestedActionEn,
        suggestedActionTa,
      };
    })
    .sort(
      (a, b) =>
        b.priorityScore - a.priorityScore ||
        b.reliefGap - a.reliefGap ||
        b.heatIndex - a.heatIndex
    );

  const activeAlertsCount = overview?.stats.totalActiveAlerts ?? 0;

  return (
    <div className="max-w-7xl mx-auto px-3.5 sm:px-6 py-5 space-y-6 pb-16">
      {/* Authority Header Banner */}
      <div className="bg-stone-900 text-white rounded-3xl p-5 sm:p-6 shadow-xl border border-stone-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-600 text-white shadow-md shrink-0">
            <Building className="h-7 w-7" />
          </div>
          <div>
            <span className="text-[11px] font-extrabold uppercase tracking-widest text-amber-400">
              {lang === 'ta'
                ? 'ஹீட்கார்ட் • அதிகாரப்பூர்வ வெப்ப கட்டுப்பாட்டு மையம்'
                : 'HeatGuard · Greater Chennai Corporation Authority Console'}
            </span>
            <h2 className="text-lg sm:text-xl font-black tracking-tight">
              {lang === 'ta'
                ? 'தானியங்கி வெப்ப எச்சரிக்கை & ஹாட்ஸ்பாட் மேலாண்மை'
                : 'Automatic Alert Escalation & Regional Hotspot Command'}
            </h2>
            <p className="text-xs text-stone-400">
              {lang === 'ta'
                ? 'Open-Meteo நேரடி தரவு • FCM & SMS எச்சரிக்கை அமைப்பு • நிலையான நிவாரண மைய வரைபடம்'
                : 'Live Open-Meteo 4-tier detection • FCM & SMS auto-escalation • Read-only ward hotspot analytics'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start lg:self-auto">
          {firebaseUser ? (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-stone-800 border border-stone-700 text-xs font-bold text-stone-200">
                <ShieldCheck
                  className={`w-4 h-4 ${isAdmin ? 'text-emerald-400' : 'text-amber-400'}`}
                />
                <span>
                  {isAdmin ? 'Admin:' : 'Signed in:'} {firebaseUser.email}
                </span>
              </span>
              <button
                type="button"
                onClick={() => signOutFirebase()}
                className="p-2 rounded-xl bg-stone-800 hover:bg-stone-700 border border-stone-700 text-stone-300 transition cursor-pointer"
                title="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleSignInAdmin}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-bold transition cursor-pointer"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>Admin Google Sign-In</span>
            </button>
          )}
        </div>
      </div>

      {/* Authority Section Navigation Tabs */}
      <nav
        aria-label="Authority Console Sections"
        className="flex flex-wrap items-center gap-2 bg-white dark:bg-stone-900 p-2 rounded-2xl border border-stone-200 dark:border-stone-800"
      >
        <button
          type="button"
          onClick={() => setActiveTab('escalation')}
          className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-extrabold transition cursor-pointer ${
            activeTab === 'escalation'
              ? 'bg-stone-900 text-white dark:bg-orange-600'
              : 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'
          }`}
        >
          <BellRing className="w-4 h-4" />
          <span>Alert Escalation Center</span>
          {activeAlertsCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-md bg-rose-600 text-white text-[10px] font-black tabular-nums">
              {activeAlertsCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('locations')}
          className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-extrabold transition cursor-pointer ${
            activeTab === 'locations'
              ? 'bg-stone-900 text-white dark:bg-orange-600'
              : 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>Locations &amp; Recipients</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('settings')}
          className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-extrabold transition cursor-pointer ${
            activeTab === 'settings'
              ? 'bg-stone-900 text-white dark:bg-orange-600'
              : 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'
          }`}
        >
          <Sliders className="w-4 h-4" />
          <span>Admin Controls</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('hotspots')}
          className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-extrabold transition cursor-pointer ${
            activeTab === 'hotspots'
              ? 'bg-stone-900 text-white dark:bg-orange-600'
              : 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800'
          }`}
        >
          <MapIcon className="w-4 h-4" />
          <span>Hotspots &amp; Priority Report (Read-Only)</span>
        </button>
      </nav>

      {/* TAB 1: ALERT ESCALATION CENTER */}
      {activeTab === 'escalation' && (
        overview ? (
          <AlertEscalationCenter
            lang={lang}
            overview={overview}
            onRefresh={loadEscalationData}
            firebaseUser={firebaseUser}
            isAdmin={isAdmin}
            onSignInAdmin={handleSignInAdmin}
          />
        ) : overviewError ? (
          <div className="rounded-2xl bg-rose-500/10 border border-rose-500/30 p-4 text-xs font-semibold text-rose-700 dark:text-rose-300">
            {overviewError}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="h-9 w-9 animate-spin rounded-full border-4 border-orange-500 border-t-transparent" />
            <p className="text-xs font-bold text-stone-500">
              Loading Alert Escalation Center...
            </p>
          </div>
        )
      )}

      {/* TAB 2: LOCATIONS & RECIPIENTS */}
      {activeTab === 'locations' && overview && (
        <LocationsAndRecipientsManager
          overview={overview}
          isAdmin={isAdmin}
          onSignInAdmin={handleSignInAdmin}
          onRefresh={loadEscalationData}
        />
      )}

      {/* TAB 3: ADMIN CONTROLS */}
      {activeTab === 'settings' && overview && (
        <EscalationSettingsPanel
          settings={overview.settings}
          isAdmin={isAdmin}
          adminEmail={firebaseUser?.email || null}
          onSignInAdmin={handleSignInAdmin}
          onRefresh={loadEscalationData}
        />
      )}

      {/* TAB 4: PRESERVED READ-ONLY HOTSPOTS, PRIORITY TABLE & SUMMARY */}
      {activeTab === 'hotspots' && (
        loading && areas.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="h-9 w-9 animate-spin rounded-full border-4 border-orange-500 border-t-transparent" />
            <p className="text-xs sm:text-sm font-bold text-stone-600 dark:text-stone-400">
              {lang === 'ta'
                ? 'Open-Meteo நேரடி வெப்பநிலை பெறப்படுகிறது...'
                : 'Loading live heat readings via getReadings()...'}
            </p>
          </div>
        ) : error && areas.length === 0 ? (
          <div className="rounded-2xl bg-rose-500/10 border border-rose-500/30 p-4 text-xs sm:text-sm font-semibold text-rose-700 dark:text-rose-300">
            {error}
          </div>
        ) : (
          <div className="space-y-8">
            {/* SECTION 1: HOTSPOTS */}
            <HotspotMap
              areas={areas}
              reliefPoints={reliefPoints}
              weatherStatus={weatherStatus}
              lang={lang}
            />

            {/* SECTION 2: PRIORITY TABLE */}
            <section className="space-y-3">
              <div>
                <span className="text-[11px] font-extrabold uppercase tracking-widest text-amber-500">
                  02 &middot; {lang === 'ta' ? 'முன்னுரிமை அட்டவணை' : 'PRIORITY TABLE'}
                </span>
                <h3 className="text-base sm:text-lg font-black text-stone-900 dark:text-stone-100">
                  {lang === 'ta'
                    ? 'தீவிர வெப்ப நேரங்கள் × நிவாரண இடைவெளி தரவரிசை'
                    : 'Areas Ranked by (Extreme Hours Today × Relief Gap)'}
                </h3>
                <p className="text-xs text-stone-600 dark:text-stone-400 mt-0.5">
                  {lang === 'ta'
                    ? 'நிவாரண இடைவெளி = 500 மீட்டருக்குள் உள்ள நிழல்/தண்ணீர் மையங்கள் குறைய குறைய மதிப்பெண் அதிகரிக்கும்: max(0, 3 − மையங்கள்).'
                    : 'Relief Gap = max(0, 3 − shade/water points within 500 m). Fewer points within 500 m yields a higher score.'}
                </p>
              </div>

              <div className="bg-white dark:bg-stone-900 rounded-3xl border border-stone-200 dark:border-stone-800 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-stone-50 dark:bg-stone-950/70 border-b border-stone-200 dark:border-stone-800 text-[11px] font-extrabold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                        <th className="py-3 px-4">{lang === 'ta' ? 'தரம்' : 'Rank'}</th>
                        <th className="py-3 px-4">{lang === 'ta' ? 'பகுதி' : 'Area'}</th>
                        <th className="py-3 px-4 text-right">{lang === 'ta' ? 'தற்போதைய HI' : 'Heat Index'}</th>
                        <th className="py-3 px-4 text-right">{lang === 'ta' ? 'தீவிர மணி (>41°C)' : 'Extreme Hrs'}</th>
                        <th className="py-3 px-4 text-right">{lang === 'ta' ? 'நிழல் (≤500m)' : 'Shade ≤500m'}</th>
                        <th className="py-3 px-4 text-right">{lang === 'ta' ? 'தண்ணீர் (≤500m)' : 'Water ≤500m'}</th>
                        <th className="py-3 px-4 text-right">{lang === 'ta' ? 'இடைவெளி' : 'Relief Gap'}</th>
                        <th className="py-3 px-4 text-right">{lang === 'ta' ? 'மதிப்பெண் (மணி × இடைவெளி)' : 'Score (Hrs × Gap)'}</th>
                        <th className="py-3 px-4">{lang === 'ta' ? 'பரிந்துரைக்கப்படும் நடவடிக்கை' : 'Suggested Action'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-200/80 dark:divide-stone-800 text-xs sm:text-sm">
                      {priorityRows.map((row, idx) => (
                        <tr
                          key={row.id}
                          className="hover:bg-stone-50/80 dark:hover:bg-stone-800/40 transition-colors"
                        >
                          <td className="py-3 px-4 font-black text-stone-900 dark:text-stone-100">
                            #{idx + 1}
                          </td>
                          <td className="py-3 px-4">
                            <div className="font-bold text-stone-900 dark:text-stone-100">
                              {lang === 'ta' ? row.name_ta : row.name}
                            </div>
                            <div className="text-[11px] text-stone-500">Ward {row.ward_no}</div>
                          </td>
                          <td className="py-3 px-4 text-right font-bold tabular-nums">
                            <span
                              className={
                                row.heatIndex > 41
                                  ? 'text-rose-600 dark:text-rose-400'
                                  : row.heatIndex >= 36
                                    ? 'text-orange-600 dark:text-orange-400'
                                    : row.heatIndex >= 32
                                      ? 'text-amber-600 dark:text-amber-400'
                                      : 'text-emerald-600 dark:text-emerald-400'
                              }
                            >
                              {row.heatIndex.toFixed(1)}°C
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right font-bold tabular-nums text-stone-800 dark:text-stone-200">
                            {row.extremeHoursToday}h
                          </td>
                          <td className="py-3 px-4 text-right tabular-nums text-stone-700 dark:text-stone-300">
                            {row.shadeWithin500m}
                          </td>
                          <td className="py-3 px-4 text-right tabular-nums text-stone-700 dark:text-stone-300">
                            {row.waterWithin500m}
                          </td>
                          <td className="py-3 px-4 text-right font-extrabold tabular-nums text-orange-600 dark:text-orange-400">
                            {row.reliefGap}
                          </td>
                          <td className="py-3 px-4 text-right font-black tabular-nums text-stone-900 dark:text-white">
                            <span>{row.priorityScore}</span>
                            <span className="block text-[10px] font-normal text-stone-500">
                              ({row.extremeHoursToday} × {row.reliefGap})
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span className="inline-block px-2.5 py-1 rounded-lg bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-xs font-bold text-stone-800 dark:text-stone-200">
                              {lang === 'ta' ? row.suggestedActionTa : row.suggestedActionEn}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            {/* SECTION 3: SUMMARY */}
            <section className="space-y-3">
              <div>
                <span className="text-[11px] font-extrabold uppercase tracking-widest text-emerald-500">
                  03 &middot; {lang === 'ta' ? 'சுருக்கம்' : 'SUMMARY'}
                </span>
                <h3 className="text-base sm:text-lg font-black text-stone-900 dark:text-stone-100">
                  {lang === 'ta'
                    ? 'மதிய ஓய்வு நேர வழிகாட்டுதல்'
                    : 'Recommended Midday-Rest Window'}
                </h3>
              </div>

              <div className="bg-amber-50 dark:bg-amber-950/25 border border-amber-300 dark:border-amber-800/70 rounded-3xl p-5 sm:p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-start gap-3.5">
                  <div className="h-11 w-11 rounded-2xl bg-amber-500/20 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0">
                    <Clock className="w-6 h-6" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-md bg-amber-500 text-stone-950 text-[11px] font-black uppercase tracking-wide">
                        {lang === 'ta' ? 'பரிந்துரை (Recommendation)' : 'Recommendation'}
                      </span>
                      <span className="px-2.5 py-0.5 rounded-md bg-stone-200 dark:bg-stone-800 text-stone-700 dark:text-stone-300 text-[11px] font-bold uppercase tracking-wide">
                        {lang === 'ta' ? 'கட்டாயப்படுத்தப்படவில்லை (Not Enforced)' : 'Not Enforced'}
                      </span>
                    </div>
                    <p className="text-sm sm:text-base font-extrabold text-stone-900 dark:text-stone-100">
                      {lang === 'ta'
                        ? 'வெப்ப அபாயம் தீவிரமாக (> 41°C) இருக்கும்போது, 12:00 – 16:00 மணி வரை கடினமான வெளிப்புற வேலைகளுக்கு ஓய்வு அளிக்கப் பரிந்துரைக்கப்படுகிறது.'
                        : 'Recommended midday-rest window: 12:00–16:00 when heat index risk is extreme (> 41°C).'}
                    </p>
                    <p className="text-xs text-stone-600 dark:text-stone-400 flex items-center gap-1.5">
                      <Info className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {lang === 'ta'
                          ? 'இது பொது சுகாதார ஆலோசனை மட்டுமே; இந்தத் தளத்தில் சட்டப்படி கட்டாய அமலாக்கம் செய்யப்படவில்லை.'
                          : 'Advisory guidance only — labeled as a recommendation and not enforced through this portal.'}
                      </span>
                    </p>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )
      )}
    </div>
  );
};
