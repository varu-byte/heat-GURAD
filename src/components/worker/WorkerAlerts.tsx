import React, { useEffect, useState } from 'react';
import {
  AlertOctagon,
  Bell,
  BellRing,
  Check,
  CheckCircle,
  Coffee,
  Flame,
  HeartPulse,
  LogOut,
  MapPin,
  PhoneCall,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { User } from 'firebase/auth';
import { HeatAlert, Language, MonitoredLocation, ZoneDetail } from '../../types';
import { TRANSLATIONS } from '../../utils/translations';
import { recordBreakLog } from '../../services/api';
import {
  fetchEscalationOverview,
  submitWorkerSubscription,
} from '../../services/escalationApi';
import {
  fetchUserRecipientsFromFirestore,
  listenForegroundFcmMessages,
  registerFcmDeviceToken,
  saveRecipientToFirestore,
  signInWithGoogle,
  signOutFirebase,
  subscribeAuth,
} from '../../services/firebase';

interface Props {
  alerts: HeatAlert[];
  zones: ZoneDetail[];
  selectedZoneId: string;
  lang: Language;
  onRefreshBreaks?: () => void;
  todayBreakCount: number;
}

export const WorkerAlerts: React.FC<Props> = ({
  alerts,
  zones,
  selectedZoneId,
  lang,
  onRefreshBreaks,
  todayBreakCount,
}) => {
  const t = TRANSLATIONS[lang];
  const currentZone = zones.find((z) => z.id === selectedZoneId) || zones[0];

  const [breakLoggedRecently, setBreakLoggedRecently] = useState(false);
  const [isLoggingBreak, setIsLoggingBreak] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<string>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const [pushStatusMsg, setPushStatusMsg] = useState<string | null>(null);
  const [foregroundBanner, setForegroundBanner] = useState<{
    title: string;
    body: string;
  } | null>(null);

  // Worker Firebase Auth & Multi-Location SMS/Push Subscription State
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [monitoredLocations, setMonitoredLocations] = useState<MonitoredLocation[]>([]);
  const [subName, setSubName] = useState('');
  const [subPhone, setSubPhone] = useState('');
  const [subLocations, setSubLocations] = useState<string[]>([selectedZoneId || 'koyambedu']);
  const [subPushEnabled, setSubPushEnabled] = useState(true);
  const [subSmsEnabled, setSubSmsEnabled] = useState(true);
  const [subConsent, setSubConsent] = useState(false);
  const [subActive, setSubActive] = useState(true);
  const [subMinRisk, setSubMinRisk] = useState<'moderate' | 'high' | 'extreme'>('high');
  const [isSavingSub, setIsSavingSub] = useState(false);
  const [subFeedback, setSubFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    fetchEscalationOverview()
      .then((res) => setMonitoredLocations(res.locations))
      .catch(() => {});

    let unsubFcm = () => {};
    listenForegroundFcmMessages((msg) => {
      setForegroundBanner({ title: msg.title, body: msg.body });
    }).then((unsub) => {
      unsubFcm = unsub;
    });

    const unsubAuth = subscribeAuth(async (user) => {
      setFirebaseUser(user);
      if (user) {
        setSubName((prev) => prev || user.displayName || user.email?.split('@')[0] || '');
        try {
          const existing = await fetchUserRecipientsFromFirestore();
          if (existing.length > 0) {
            const first = existing[0];
            setSubName(first.name);
            setSubPhone(first.phone);
            setSubLocations(first.locationIds);
            setSubPushEnabled(first.pushEnabled);
            setSubSmsEnabled(first.smsEnabled);
            setSubConsent(first.consentGranted);
            setSubActive(first.active);
            setSubMinRisk(first.minRiskLevel);
          }
        } catch {
          // Ignore if no existing subscription yet
        }
      }
    });

    return () => {
      unsubAuth();
      unsubFcm();
    };
  }, []);

  // Handle "I took a break"
  const handleTakeBreak = async () => {
    setIsLoggingBreak(true);
    try {
      await recordBreakLog({
        zone_id: currentZone.id,
        zone_name: currentZone.name,
        duration_mins: 15,
        note: '15m Shaded Rest & Hydration',
      });
      setBreakLoggedRecently(true);
      if (onRefreshBreaks) onRefreshBreaks();

      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate([100, 50, 100]);
      }

      setTimeout(() => {
        setBreakLoggedRecently(false);
      }, 4000);
    } catch (err) {
      console.error('Break record error:', err);
    } finally {
      setIsLoggingBreak(false);
    }
  };

  // Handle Firebase Cloud Messaging / Browser Push registration
  const handleEnablePushNotifications = async () => {
    setPushStatusMsg(null);
    try {
      const targetLocs = subLocations.length > 0 ? subLocations : [currentZone.id];
      const result = await registerFcmDeviceToken(targetLocs, true);
      setNotificationPermission('granted');
      setPushStatusMsg(
        result.method === 'fcm'
          ? 'FCM push token registered for subscribed zones.'
          : 'Browser push alerts enabled for subscribed zones.'
      );
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('HeatGuard Alerts Active', {
          body: `Monitoring ${targetLocs.join(', ')}. You will receive risk alerts automatically.`,
          icon: '/icon.svg',
        });
      }
    } catch (err: any) {
      setNotificationPermission(
        typeof Notification !== 'undefined' ? Notification.permission : 'denied'
      );
      setPushStatusMsg(err?.message || 'Unable to register browser push notifications.');
    }
  };

  const toggleSubLocation = (locId: string) => {
    setSubLocations((prev) =>
      prev.includes(locId) ? prev.filter((id) => id !== locId) : [...prev, locId]
    );
  };

  const handleSaveSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubFeedback(null);

    if (!firebaseUser) {
      try {
        await signInWithGoogle();
      } catch (err: any) {
        setSubFeedback({ type: 'error', text: err?.message || 'Sign-in cancelled.' });
      }
      return;
    }

    if (!subConsent) {
      setSubFeedback({
        type: 'error',
        text: 'Please grant explicit opt-in consent before subscribing to HeatGuard alerts.',
      });
      return;
    }

    if (subLocations.length === 0) {
      setSubFeedback({ type: 'error', text: 'Select at least one location to monitor.' });
      return;
    }

    setIsSavingSub(true);
    try {
      const saved = await submitWorkerSubscription({
        name: subName.trim() || firebaseUser.displayName || 'HeatGuard Subscriber',
        phone: subPhone.trim(),
        locationIds: subLocations,
        pushEnabled: subPushEnabled,
        smsEnabled: subSmsEnabled,
        consentGranted: subConsent,
        active: subActive,
        minRiskLevel: subMinRisk,
      });
      await saveRecipientToFirestore(saved).catch(() => {});
      setSubFeedback({
        type: 'success',
        text: `Preferences saved for ${saved.locationIds.join(', ')}. You will only receive alerts for your selected locations.`,
      });
    } catch (err: any) {
      setSubFeedback({
        type: 'error',
        text: err?.message || 'Could not save subscription preferences.',
      });
    } finally {
      setIsSavingSub(false);
    }
  };

  const locationOptions =
    monitoredLocations.length > 0
      ? monitoredLocations.map((l) => ({ id: l.locationId, label: l.name }))
      : zones.map((z) => ({ id: z.id, label: z.name }));

  return (
    <div className="max-w-3xl mx-auto px-3.5 sm:px-6 py-4 space-y-4 pb-24">
      {/* 1. Header */}
      <div>
        <h2 className="text-lg sm:text-xl font-black text-stone-900 dark:text-stone-100 flex items-center gap-2">
          <BellRing className="w-5 h-5 text-red-600 animate-bounce" />
          {t.alertsTitle}
        </h2>
        <p className="text-xs text-stone-500 mt-0.5">
          {lang === 'ta'
            ? 'அதிகாரப்பூர்வ மாநகராட்சி எச்சரிக்கைகள் மற்றும் ஓய்வு பதிவு'
            : 'Official advisories, location alert opt-in, and rest logging'}
        </p>
      </div>

      {/* Live Foreground FCM Alert Banner */}
      {foregroundBanner && (
        <div className="rounded-2xl bg-rose-600 text-white p-4 shadow-md flex items-start justify-between gap-3">
          <div className="space-y-0.5 text-xs">
            <div className="font-black uppercase tracking-wider">{foregroundBanner.title}</div>
            <p>{foregroundBanner.body}</p>
          </div>
          <button
            type="button"
            onClick={() => setForegroundBanner(null)}
            className="text-xs underline shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 2. Interactive "I Took a Break" (15m) Counter Card */}
      <div className="bg-gradient-to-br from-amber-500 via-orange-600 to-red-600 rounded-3xl p-5 sm:p-6 text-white shadow-xl">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-orange-100 bg-white/20 px-2.5 py-0.5 rounded-full inline-block">
              {lang === 'ta' ? 'உடல் வெப்பத் தணிப்பு' : 'Mandatory Rest Protocol'}
            </span>
            <h3 className="text-lg sm:text-xl font-black tracking-tight">
              {lang === 'ta'
                ? 'இடைவேளை எடுத்து நீரேற்றம் செய்யுங்கள்'
                : 'Hydrate and Rest in Shade for 15 Mins'}
            </h3>
            <p className="text-xs text-orange-100/90 leading-relaxed max-w-md">
              {lang === 'ta'
                ? 'அதிக வெப்பத்தில் ஒவ்வொரு மணி நேரமும் 15 நிமிடம் நிழலில் அமர்வது பக்கவாதத்தைத் தடுக்கிறது.'
                : 'Taking 15 minutes of shaded rest per hour prevents heat stroke and body exhaustion.'}
            </p>
          </div>

          <div className="flex flex-col items-center sm:items-end w-full sm:w-auto">
            <span className="text-3xl sm:text-4xl font-black tracking-tight drop-shadow-sm tabular-nums">
              {todayBreakCount}
            </span>
            <span className="text-[11px] text-orange-100 font-medium">
              {t.breaksToday}
            </span>
          </div>
        </div>

        <div className="mt-4 pt-3.5 border-t border-white/20">
          <button
            onClick={handleTakeBreak}
            disabled={isLoggingBreak}
            className={`w-full py-3.5 px-4 rounded-2xl text-sm font-extrabold shadow-md flex items-center justify-center gap-2 transition active:scale-98 cursor-pointer ${
              breakLoggedRecently
                ? 'bg-emerald-600 text-white'
                : 'bg-white text-stone-900 hover:bg-stone-100 dark:bg-stone-900 dark:text-white dark:hover:bg-stone-800'
            }`}
          >
            {breakLoggedRecently ? (
              <>
                <Check className="w-5 h-5 text-emerald-300" />
                <span>{t.tookBreakSuccess}</span>
              </>
            ) : (
              <>
                <Coffee className="w-5 h-5 text-orange-600" />
                <span>{t.takeBreakBtn}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* 3. Firebase Cloud Messaging (FCM) Browser Push Activation */}
      <div className="bg-white dark:bg-stone-900 rounded-2xl p-4 shadow-sm border border-stone-200 dark:border-stone-800 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400">
              <Bell className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-xs sm:text-sm font-bold text-stone-900 dark:text-stone-100">
                {lang === 'ta'
                  ? 'தீவிர வெப்ப எச்சரிக்கை அறிவிப்பு (FCM Push)'
                  : 'HeatGuard Push Alerts (Firebase Cloud Messaging)'}
              </h4>
              <p className="text-[11px] text-stone-500">
                {lang === 'ta'
                  ? 'தேர்ந்தெடுத்த பகுதிகளுக்கு வெப்ப எச்சரிக்கை அறிவிப்புகளைப் பெறுங்கள்'
                  : 'Register browser push for automatic risk escalation updates'}
              </p>
            </div>
          </div>

          {notificationPermission === 'granted' ? (
            <button
              type="button"
              onClick={handleEnablePushNotifications}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 text-xs font-bold cursor-pointer"
            >
              <CheckCircle className="w-4 h-4 text-emerald-600" />
              <span>{t.notificationsActive}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleEnablePushNotifications}
              className="px-3.5 py-2 rounded-xl bg-stone-900 hover:bg-stone-800 text-white dark:bg-orange-600 dark:hover:bg-orange-700 text-xs font-bold transition cursor-pointer"
            >
              {t.enableNotifications}
            </button>
          )}
        </div>
        {pushStatusMsg && (
          <p className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
            {pushStatusMsg}
          </p>
        )}
      </div>

      {/* 4. Location-Targeted SMS & Push Opt-In Preferences */}
      <form
        onSubmit={handleSaveSubscription}
        className="bg-white dark:bg-stone-900 rounded-2xl p-4 sm:p-5 shadow-sm border border-stone-200 dark:border-stone-800 space-y-3.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-xs sm:text-sm font-extrabold text-stone-900 dark:text-stone-100 flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-orange-500" />
              Subscribe to Location Heat Alerts (SMS &amp; Push)
            </h4>
            <p className="text-[11px] text-stone-500">
              Receive alerts only for locations you choose. Explicit opt-in consent is required and can be paused anytime.
            </p>
          </div>
          {firebaseUser ? (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                {firebaseUser.email}
              </span>
              <button
                type="button"
                onClick={() => signOutFirebase()}
                className="p-1 text-stone-400 hover:text-stone-700 cursor-pointer"
                title="Sign out"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => signInWithGoogle()}
              className="px-3 py-1.5 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-stone-800 text-white text-xs font-bold cursor-pointer"
            >
              Sign in with Google
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <input
            type="text"
            placeholder="Your Name"
            value={subName}
            onChange={(e) => setSubName(e.target.value)}
            className="px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800"
          />
          <input
            type="tel"
            placeholder="Mobile (+91xxxxxxxxxx)"
            value={subPhone}
            onChange={(e) => setSubPhone(e.target.value)}
            className="px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800"
          />
          <select
            value={subMinRisk}
            onChange={(e) =>
              setSubMinRisk(e.target.value as 'moderate' | 'high' | 'extreme')
            }
            className="px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 font-semibold"
          >
            <option value="moderate">Alert at MODERATE+</option>
            <option value="high">Alert at HIGH+</option>
            <option value="extreme">Alert at EXTREME Only</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <span className="text-[11px] font-bold text-stone-500 block">
            Select Your Work Locations:
          </span>
          <div className="flex flex-wrap gap-1.5">
            {locationOptions.map((loc) => {
              const selected = subLocations.includes(loc.id);
              return (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => toggleSubLocation(loc.id)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition cursor-pointer ${
                    selected
                      ? 'bg-orange-600 text-white border-orange-500'
                      : 'bg-stone-50 dark:bg-stone-950 text-stone-600 dark:text-stone-400 border-stone-200 dark:border-stone-800'
                  }`}
                >
                  {loc.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={subPushEnabled}
              onChange={(e) => setSubPushEnabled(e.target.checked)}
            />
            <span>Push Notifications</span>
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={subSmsEnabled}
              onChange={(e) => setSubSmsEnabled(e.target.checked)}
            />
            <span>SMS Alerts</span>
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={subActive}
              onChange={(e) => setSubActive(e.target.checked)}
            />
            <span>Subscription Active</span>
          </label>
        </div>

        <label className="flex items-start gap-2 text-[11px] text-stone-700 dark:text-stone-300 cursor-pointer bg-stone-50 dark:bg-stone-950 p-2.5 rounded-xl border border-stone-200 dark:border-stone-800">
          <input
            type="checkbox"
            checked={subConsent}
            onChange={(e) => setSubConsent(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I explicitly opt in to receive heat risk warnings and safety instructions via my selected channels for the chosen locations only.
          </span>
        </label>

        {subFeedback && (
          <div
            className={`px-3 py-2 rounded-xl text-xs font-semibold border ${
              subFeedback.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-800 dark:text-emerald-300'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-800 dark:text-rose-300'
            }`}
          >
            {subFeedback.text}
          </div>
        )}

        <button
          type="submit"
          disabled={isSavingSub}
          className="w-full py-2.5 px-4 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-orange-600 dark:hover:bg-orange-700 text-white text-xs font-extrabold flex items-center justify-center gap-1.5 cursor-pointer transition disabled:opacity-50"
        >
          <ShieldCheck className="w-4 h-4" />
          <span>
            {!firebaseUser
              ? 'Sign in with Google to Save Preferences'
              : isSavingSub
                ? 'Saving Alert Preferences...'
                : 'Save My Location Alert Preferences'}
          </span>
        </button>
      </form>

      {/* 5. GCC Live Broadcast Bulletins */}
      <div className="space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400">
          {lang === 'ta'
            ? 'மாநகராட்சி நேரடி எச்சரிக்கை செய்திகள்'
            : 'Active GCC Broadcast Bulletins'}
        </h3>

        {alerts.length === 0 ? (
          <div className="bg-white dark:bg-stone-900 p-6 rounded-2xl text-center border border-stone-200 dark:border-stone-800">
            <p className="text-xs text-stone-500">No active emergency alerts at this hour.</p>
          </div>
        ) : (
          alerts.map((alert) => {
            const isExtreme = alert.level === 'extreme';
            const isHigh = alert.level === 'high';
            return (
              <div
                key={alert.id}
                className={`rounded-2xl p-4 sm:p-5 border shadow-xs transition ${
                  isExtreme
                    ? 'bg-rose-50 dark:bg-rose-950/30 border-rose-300 dark:border-rose-900'
                    : isHigh
                      ? 'bg-orange-50 dark:bg-orange-950/30 border-orange-300 dark:border-orange-900'
                      : 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-900'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
                        isExtreme
                          ? 'bg-rose-600 text-white animate-pulse'
                          : isHigh
                            ? 'bg-orange-500 text-white'
                            : 'bg-amber-500 text-stone-900'
                      }`}
                    >
                      <Flame className="w-3 h-3" />
                      {alert.level.toUpperCase()} ALERT
                    </span>
                    <span className="text-xs font-bold text-stone-800 dark:text-stone-200">
                      {alert.zone_name}
                    </span>
                  </div>
                  <span className="text-[10px] text-stone-500 tabular-nums">
                    {new Date(alert.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>

                <p className="text-xs sm:text-sm font-semibold text-stone-900 dark:text-stone-100 leading-relaxed">
                  {lang === 'ta' ? alert.message_ta : alert.message}
                </p>

                <div className="mt-2.5 pt-2 border-t border-stone-200/60 dark:border-stone-800 text-[11px] text-stone-500 flex items-center justify-between">
                  <span>Issued by: {alert.sent_by}</span>
                  <span className="font-mono font-bold text-rose-600 dark:text-rose-400">
                    HI: {alert.heat_index}°C
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 6. Heat Stroke Medical First Aid Guide */}
      <div className="bg-white dark:bg-stone-900 rounded-2xl p-5 shadow-sm border border-stone-200 dark:border-stone-800 space-y-3.5">
        <div className="flex items-center gap-2">
          <HeartPulse className="w-5 h-5 text-rose-600" />
          <h3 className="text-sm sm:text-base font-extrabold text-stone-900 dark:text-stone-100">
            {t.heatStrokeGuide}
          </h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 space-y-1.5">
            <span className="font-bold text-amber-900 dark:text-amber-300 flex items-center gap-1.5">
              <ShieldAlert className="w-4 h-4 text-amber-600" />
              {t.heatExhaustion}
            </span>
            <ul className="list-disc list-inside text-stone-700 dark:text-stone-300 space-y-1 text-[11px] leading-relaxed">
              <li>{lang === 'ta' ? 'அதிக வியர்வை மற்றும் குளிர்ச்சியான தோல்' : 'Heavy sweating, cold pale skin'}</li>
              <li>{lang === 'ta' ? 'தலைசுற்றல், சோர்வு, மயக்கம்' : 'Dizziness, fatigue, weakness'}</li>
              <li>{lang === 'ta' ? 'தசைப் பிடிப்பு (Cramps) மற்றும் வாந்தி உணர்வு' : 'Muscle cramps, nausea'}</li>
            </ul>
            <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-300 pt-1">
              {lang === 'ta'
                ? 'தீர்வு: உடனே நிழலுக்குச் சென்று நீர்/மோர் பருகவும்.'
                : 'Action: Move to shade, loosen clothing, sip cool water.'}
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/60 space-y-1.5">
            <span className="font-bold text-rose-900 dark:text-rose-300 flex items-center gap-1.5">
              <AlertOctagon className="w-4 h-4 text-rose-600" />
              {t.heatStroke}
            </span>
            <ul className="list-disc list-inside text-stone-700 dark:text-stone-300 space-y-1 text-[11px] leading-relaxed">
              <li>{lang === 'ta' ? 'உயர் உடல் சூடு (>40°C), வியர்வை நின்று போதல்' : 'High body temp (>40°C), no sweating'}</li>
              <li>{lang === 'ta' ? 'சிவப்பான, உலர்வான சூடான தோல்' : 'Red, hot, dry skin'}</li>
              <li>{lang === 'ta' ? 'குழப்பம், சுயநினைவிழப்பு அல்லது வலிப்பு' : 'Confusion, slurred speech, fainting'}</li>
            </ul>
            <p className="text-[11px] font-black text-rose-800 dark:text-rose-300 pt-1">
              {lang === 'ta'
                ? 'அவசரம்: உடனே 108 அழைக்கவும்! குளிர்ந்த நீர் தெளிக்கவும்.'
                : 'EMERGENCY: Call 108 immediately! Pour cool water.'}
            </p>
          </div>
        </div>

        <a
          href="tel:108"
          className="w-full py-3 px-4 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2 shadow-md transition active:scale-98 cursor-pointer"
        >
          <PhoneCall className="w-4 h-4 animate-pulse" />
          <span>{t.callEmergency}</span>
        </a>
      </div>
    </div>
  );
};
