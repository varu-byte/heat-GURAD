import React, { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  Clock,
  Info,
  Lock,
  MessageSquare,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Minus,
  XCircle,
} from 'lucide-react';
import { User } from 'firebase/auth';
import {
  AlertHistoryEvent,
  Language,
  RiskLevel,
} from '../../types';
import {
  AiBriefResponse,
  EscalationOverviewResponse,
  LiveDemoSmsResponse,
  fetchAiSituationBrief,
  retryFailedNotifications,
  runMonitoringSweepNow,
  sendLiveDemoSms,
  simulateHeatStep,
} from '../../services/escalationApi';
import {
  BOOTSTRAPPED_ADMIN_EMAIL,
  commitAlertTransitionTransaction,
} from '../../services/firebase';

interface SimulationStepDef {
  stepIndex: number;
  label: string;
  targetRisk: RiskLevel;
  previousRisk: RiskLevel;
  airTemp: number;
  humidity: number;
  expectedHi: number;
}

const SIMULATION_SEQUENCE: SimulationStepDef[] = [
  { stepIndex: 0, label: '1. Baseline (LOW)', targetRisk: 'low', previousRisk: 'low', airTemp: 28, humidity: 55, expectedHi: 28.9 },
  { stepIndex: 1, label: '2. Escalate → MODERATE', targetRisk: 'moderate', previousRisk: 'low', airTemp: 30.5, humidity: 58, expectedHi: 33.4 },
  { stepIndex: 2, label: '3. Escalate → HIGH', targetRisk: 'high', previousRisk: 'moderate', airTemp: 33.0, humidity: 55, expectedHi: 37.8 },
  { stepIndex: 3, label: '4. Critical → EXTREME', targetRisk: 'extreme', previousRisk: 'high', airTemp: 36.2, humidity: 65, expectedHi: 51.7 },
  { stepIndex: 4, label: '5. De-escalate → HIGH', targetRisk: 'high', previousRisk: 'extreme', airTemp: 32.5, humidity: 56, expectedHi: 37.0 },
  { stepIndex: 5, label: '6. De-escalate → MODERATE', targetRisk: 'moderate', previousRisk: 'high', airTemp: 30.2, humidity: 57, expectedHi: 32.6 },
  { stepIndex: 6, label: '7. Recovery → LOW', targetRisk: 'low', previousRisk: 'moderate', airTemp: 27.5, humidity: 54, expectedHi: 28.2 },
];

function riskBadgeClasses(risk: RiskLevel): string {
  switch (risk) {
    case 'low':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40';
    case 'moderate':
      return 'bg-yellow-500/20 text-yellow-800 dark:text-yellow-300 border-yellow-500/50';
    case 'high':
      return 'bg-orange-500/20 text-orange-800 dark:text-orange-300 border-orange-500/50';
    case 'extreme':
      return 'bg-rose-600 text-white border-rose-500 shadow-xs';
  }
}

function statusChipClasses(status: string): string {
  switch (status) {
    case 'sent':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30';
    case 'simulated':
      return 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30';
    case 'partial':
    case 'retrying':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30';
    case 'failed':
      return 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30';
    default:
      return 'bg-stone-500/10 text-stone-600 dark:text-stone-400 border-stone-500/20';
  }
}

interface Props {
  lang: Language;
  overview: EscalationOverviewResponse;
  onRefresh: () => Promise<void>;
  firebaseUser: User | null;
  isAdmin: boolean;
  onSignInAdmin: () => Promise<void>;
}

export const AlertEscalationCenter: React.FC<Props> = ({
  lang,
  overview,
  onRefresh,
  firebaseUser,
  isAdmin,
  onSignInAdmin,
}) => {
  const { stats, settings, locations, states, history, diagnostics } = overview;

  // Action states
  const [isSweeping, setIsSweeping] = useState(false);
  const [isRetryingFailed, setIsRetryingFailed] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // AI Situation Brief
  const [aiBriefLocationId, setAiBriefLocationId] = useState<string>(
    states[0]?.locationId || locations[0]?.locationId || 't-nagar'
  );
  const [aiBrief, setAiBrief] = useState<AiBriefResponse | null>(null);
  const [isLoadingAi, setIsLoadingAi] = useState(false);

  // Billing info toggle
  const [showBlazeGuide, setShowBlazeGuide] = useState(false);

  // Live Phone Alert Demo states (Custom HTTP SMS Gateway + Direct Phone Fallback)
  const [demoPhone, setDemoPhone] = useState('');
  const [demoLocationId, setDemoLocationId] = useState<string>(
    locations.find((l) => l.enabled)?.locationId || 't-nagar'
  );
  const [demoRiskLevel, setDemoRiskLevel] = useState<'high' | 'extreme'>('extreme');
  const [demoConsent, setDemoConsent] = useState(false);
  const [isSendingDemoSms, setIsSendingDemoSms] = useState(false);
  const [demoSmsResult, setDemoSmsResult] = useState<LiveDemoSmsResponse | null>(null);
  const [demoSmsError, setDemoSmsError] = useState<string | null>(null);

  // Simulation Mode states
  const [simActive, setSimActive] = useState(false);
  const [simLocationId, setSimLocationId] = useState<string>(
    locations.find((l) => l.enabled)?.locationId || 't-nagar'
  );
  const [simStepIdx, setSimStepIdx] = useState<number>(0);
  const [simPushEnabled, setSimPushEnabled] = useState(true);
  const [simSmsEnabled, setSimSmsEnabled] = useState(true);
  const [simFailSms, setSimFailSms] = useState(false);
  const [simFailPush, setSimFailPush] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [simAutoPlaying, setSimAutoPlaying] = useState(false);
  const [simEvents, setSimEvents] = useState<AlertHistoryEvent[]>([]);
  const [simCurrentRisk, setSimCurrentRisk] = useState<RiskLevel>('low');
  const [simLatestEvent, setSimLatestEvent] = useState<AlertHistoryEvent | null>(null);

  // History Search & Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [filterLocation, setFilterLocation] = useState('all');
  const [filterRisk, setFilterRisk] = useState('all');
  const [filterDate, setFilterDate] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  const latestEscalations = useMemo(
    () => history.filter((e) => e.direction === 'escalation' || e.direction === 'reminder').slice(0, 4),
    [history]
  );

  const latestDeescalations = useMemo(
    () => history.filter((e) => e.direction === 'de-escalation' || e.direction === 'recovery').slice(0, 4),
    [history]
  );

  const simEscalations = useMemo(
    () => simEvents.filter((e) => e.direction === 'escalation' || e.direction === 'reminder'),
    [simEvents]
  );

  const simDeescalations = useMemo(
    () => simEvents.filter((e) => e.direction === 'de-escalation' || e.direction === 'recovery'),
    [simEvents]
  );

  const filteredHistory = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return history.filter((evt) => {
      if (filterLocation !== 'all' && evt.locationId !== filterLocation) return false;
      if (filterRisk !== 'all' && evt.currentRisk !== filterRisk) return false;
      if (filterStatus !== 'all' && evt.deliveryStatus !== filterStatus) return false;
      if (filterDate && !evt.timestamp.startsWith(filterDate)) return false;
      if (q) {
        const hay = `${evt.locationName} ${evt.previousRisk} ${evt.currentRisk} ${evt.safetyInstructions || ''} ${evt.deliveryStatus}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [history, searchQuery, filterLocation, filterRisk, filterStatus, filterDate]);

  const handleManualSweep = async () => {
    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }
    setIsSweeping(true);
    setActionFeedback(null);
    try {
      const res = await runMonitoringSweepNow();
      // Commit triggered transitions to Firestore atomically via runTransaction when Admin is signed in
      for (const st of res.states) {
        const matchedEvt = res.eventsTriggered.find((e) => e.locationId === st.locationId) || null;
        if (matchedEvt) {
          await commitAlertTransitionTransaction(st, matchedEvt).catch((err) =>
            console.warn('Firestore transaction sync notice:', err)
          );
        }
      }
      await onRefresh();
      setActionFeedback({
        type: 'success',
        message: `Evaluated ${res.evaluatedCount} enabled locations; triggered ${res.eventsTriggered.length} alert transitions.`,
      });
    } catch (err: any) {
      setActionFeedback({
        type: 'error',
        message: err?.message || 'Unable to run monitoring sweep.',
      });
    } finally {
      setIsSweeping(false);
    }
  };

  const handleRetryFailed = async () => {
    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }
    setIsRetryingFailed(true);
    setActionFeedback(null);
    try {
      const res = await retryFailedNotifications();
      await onRefresh();
      setActionFeedback({
        type: 'success',
        message: `Retried ${res.retried} failed deliveries; recovered ${res.recovered}.`,
      });
    } catch (err: any) {
      setActionFeedback({
        type: 'error',
        message: err?.message || 'Failed to retry failed SMS deliveries.',
      });
    } finally {
      setIsRetryingFailed(false);
    }
  };

  const handleGenerateAiBrief = async () => {
    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }
    setIsLoadingAi(true);
    setActionFeedback(null);
    try {
      const brief = await fetchAiSituationBrief(aiBriefLocationId);
      setAiBrief(brief);
    } catch (err: any) {
      setActionFeedback({
        type: 'error',
        message: err?.message || 'Unable to fetch AI situation brief.',
      });
    } finally {
      setIsLoadingAi(false);
    }
  };

  const runSimulationStep = async (stepIndex: number) => {
    const step = SIMULATION_SEQUENCE[stepIndex];
    if (!step) return;

    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }

    setSimActive(true);
    setSimRunning(true);
    setActionFeedback(null);

    try {
      const outcome = await simulateHeatStep({
        locationId: simLocationId,
        airTemp: step.airTemp,
        humidity: step.humidity,
        forcePreviousRisk: step.stepIndex === 0 ? 'low' : simCurrentRisk,
        simulateSmsFailure: simFailSms,
        simulatePushFailure: simFailPush,
        forceChannels: { push: simPushEnabled, sms: simSmsEnabled },
      });

      setSimStepIdx(stepIndex);
      setSimCurrentRisk(outcome.state.currentRisk);
      if (outcome.event) {
        setSimLatestEvent(outcome.event);
        setSimEvents((prev) => [outcome.event!, ...prev]);
      }
    } catch (err: any) {
      setActionFeedback({
        type: 'error',
        message: err?.message || 'Simulation step failed.',
      });
    } finally {
      setSimRunning(false);
    }
  };

  const handleSimulateTrajectory = async () => {
    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }
    setSimActive(true);
    setSimAutoPlaying(true);
    setSimEvents([]);
    setSimLatestEvent(null);
    let rollingPrev: RiskLevel = 'low';

    try {
      for (let i = 1; i < SIMULATION_SEQUENCE.length; i++) {
        const step = SIMULATION_SEQUENCE[i];
        setSimStepIdx(i);
        const outcome = await simulateHeatStep({
          locationId: simLocationId,
          airTemp: step.airTemp,
          humidity: step.humidity,
          forcePreviousRisk: rollingPrev,
          simulateSmsFailure: simFailSms,
          simulatePushFailure: simFailPush,
          forceChannels: { push: simPushEnabled, sms: simSmsEnabled },
        });
        rollingPrev = outcome.state.currentRisk;
        setSimCurrentRisk(rollingPrev);
        if (outcome.event) {
          setSimLatestEvent(outcome.event);
          setSimEvents((prev) => [outcome.event!, ...prev]);
        }
        await new Promise((r) => setTimeout(r, 420));
      }
    } catch (err: any) {
      setActionFeedback({
        type: 'error',
        message: err?.message || 'Simulation sequence aborted.',
      });
    } finally {
      setSimAutoPlaying(false);
    }
  };

  const handleResetSimulation = () => {
    setSimActive(false);
    setSimAutoPlaying(false);
    setSimStepIdx(0);
    setSimCurrentRisk('low');
    setSimEvents([]);
    setSimLatestEvent(null);
  };

  return (
    <div className="space-y-6">
      {/* 1. Admin Auth & Autonomous Engine Status Strip */}
      <div className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-orange-600 dark:text-orange-400">
              <BellRing className="w-4 h-4" />
              {lang === 'ta' ? 'தானியங்கி வெப்ப எச்சரிக்கை மையம்' : 'Alert Escalation Center'}
            </span>
            <span className="text-stone-300 dark:text-stone-700">&middot;</span>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              {stats.schedulerStatus.intervalMinutes}m Backend Monitor Active
            </span>
          </div>
          <h3 className="text-base sm:text-lg font-black text-stone-900 dark:text-stone-100">
            {lang === 'ta'
              ? 'நிகழ்நேர வெப்ப அபாய கண்காணிப்பு & தானியங்கி அறிவிப்பு'
              : 'Autonomous Multi-City Risk Detection, Escalation & Delivery Tracking'}
          </h3>
          <p className="text-xs text-stone-500 dark:text-stone-400 tabular-nums">
            Last run:{' '}
            {stats.schedulerStatus.lastRunAt
              ? new Date(stats.schedulerStatus.lastRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : 'Initializing'}{' '}
            &middot; Next check:{' '}
            {stats.schedulerStatus.nextRunAt
              ? new Date(stats.schedulerStatus.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : 'Scheduled'}{' '}
            &middot; Gateway:{' '}
            {diagnostics.sms.smsReady
              ? 'Custom SMS Gateway Live'
              : 'Local Fallback (Direct Phone Links)'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs font-bold text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="w-4 h-4" />
              <span>Admin: {firebaseUser?.email}</span>
            </span>
          ) : (
            <button
              type="button"
              onClick={onSignInAdmin}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-orange-600 dark:hover:bg-orange-700 text-white text-xs font-bold transition cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Sign in as Admin ({BOOTSTRAPPED_ADMIN_EMAIL.split('@')[0]})</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleManualSweep}
            disabled={isSweeping}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 dark:bg-stone-800 dark:hover:bg-stone-700 border border-stone-200 dark:border-stone-700 text-xs font-bold text-stone-900 dark:text-stone-100 transition cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSweeping ? 'animate-spin' : ''}`} />
            <span>{isSweeping ? 'Evaluating...' : 'Run Monitoring Sweep Now'}</span>
          </button>
        </div>
      </div>

      {actionFeedback && (
        <div
          className={`rounded-xl px-4 py-3 text-xs font-semibold border flex items-center justify-between gap-2 ${
            actionFeedback.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-800 dark:text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-800 dark:text-rose-300'
          }`}
        >
          <span>{actionFeedback.message}</span>
          <button
            type="button"
            onClick={() => setActionFeedback(null)}
            className="underline text-[11px] cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 2. KPI Metrics Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <div className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-3.5 col-span-2 sm:col-span-2 lg:col-span-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400">
            Total Active Alerts
          </span>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-2xl font-black text-stone-900 dark:text-stone-100 tabular-nums">
              {stats.totalActiveAlerts}
            </span>
            <span className="text-[11px] text-stone-500 tabular-nums">
              of {locations.filter((l) => l.enabled).length} enabled regions
            </span>
          </div>
        </div>

        <div className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-3.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            LOW (&lt;32°C)
          </span>
          <div className="mt-1 text-2xl font-black text-stone-900 dark:text-stone-100 tabular-nums">
            {stats.riskCounts.low}
          </div>
        </div>

        <div className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-3.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-yellow-600 dark:text-yellow-400">
            MODERATE
          </span>
          <div className="mt-1 text-2xl font-black text-stone-900 dark:text-stone-100 tabular-nums">
            {stats.riskCounts.moderate}
          </div>
        </div>

        <div className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-3.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-orange-600 dark:text-orange-400">
            HIGH
          </span>
          <div className="mt-1 text-2xl font-black text-stone-900 dark:text-stone-100 tabular-nums">
            {stats.riskCounts.high}
          </div>
        </div>

        <div className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-3.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-rose-600 dark:text-rose-400">
            EXTREME
          </span>
          <div className="mt-1 text-2xl font-black text-stone-900 dark:text-stone-100 tabular-nums">
            {stats.riskCounts.extreme}
          </div>
        </div>

        <div className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-3.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400">
            SMS / Push Sent
          </span>
          <div className="mt-1 text-lg font-black text-stone-900 dark:text-stone-100 tabular-nums">
            {stats.smsStats.sent} <span className="text-xs font-medium text-stone-500">/ {stats.pushStats.sent}</span>
          </div>
          <span className="text-[10px] text-stone-500 tabular-nums">
            {stats.pushStats.registeredTokens} push devices
          </span>
        </div>

        <div className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-3.5 flex flex-col justify-between">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-rose-600 dark:text-rose-400">
              Failed Alerts
            </span>
            <div className="mt-1 text-2xl font-black text-stone-900 dark:text-stone-100 tabular-nums">
              {stats.failedNotificationsCount}
            </div>
          </div>
          {stats.failedNotificationsCount > 0 && (
            <button
              type="button"
              onClick={handleRetryFailed}
              disabled={isRetryingFailed}
              className="mt-1 text-[11px] font-bold text-orange-600 dark:text-orange-400 hover:underline text-left cursor-pointer"
            >
              {isRetryingFailed ? 'Retrying...' : 'Retry Failed Now'}
            </button>
          )}
        </div>
      </div>

      {/* 2.5 Live Phone Alert Demo Card (Custom HTTP SMS Gateway + 1-Tap WhatsApp/SMS Fallback) */}
      <section className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-4 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h4 className="text-sm sm:text-base font-black text-stone-900 dark:text-stone-100 flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span>Quick Live Alert Demo (SMS Gateway &amp; Direct Fallback)</span>
            </h4>
            <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
              Dispatch a single test alert via your configured HTTP SMS gateway (<code>SMS_API_URL</code> / <code>SMS_API_KEY</code>), or send directly from your phone via WhatsApp or SMS.
            </p>
          </div>
          <span
            className={`px-2.5 py-1 rounded-md border text-[11px] font-extrabold uppercase self-start sm:self-center whitespace-nowrap ${
              diagnostics.sms.smsReady
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                : 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300 border-stone-300 dark:border-stone-700'
            }`}
          >
            {diagnostics.sms.smsReady ? 'SMS Gateway Live' : 'Direct Phone Fallback Mode'}
          </span>
        </div>

        {!diagnostics.sms.smsReady && (
          <div className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs text-stone-700 dark:text-stone-300 space-y-1">
            <p className="font-bold">
              Direct phone fallback is active (no server SMS gateway configured yet).
            </p>
            <p className="text-[11px] text-stone-500 dark:text-stone-400">
              Use the <b>WhatsApp</b> or <b>Phone SMS</b> buttons below right now with zero setup, or add{' '}
              <code>SMS_API_URL</code> and <code>SMS_API_KEY</code> to your server <code>.env</code> for automated HTTP SMS gateway delivery.
            </p>
          </div>
        )}

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setDemoSmsError(null);
            setDemoSmsResult(null);
            if (!isAdmin) {
              setDemoSmsError('Sign in with the admin account above to send a live demo alert.');
              return;
            }
            if (!demoConsent) {
              setDemoSmsError('Please check the consent box confirming this is an opted-in recipient phone.');
              return;
            }
            setIsSendingDemoSms(true);
            try {
              const res = await sendLiveDemoSms({
                phone: demoPhone,
                locationId: demoLocationId,
                riskLevel: demoRiskLevel,
                consentConfirmed: true,
              });
              setDemoSmsResult(res);
              await onRefresh();
            } catch (err: any) {
              setDemoSmsError(err?.message || 'Failed to send live demo alert.');
            } finally {
              setIsSendingDemoSms(false);
            }
          }}
          className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end"
        >
          <div className="md:col-span-3 space-y-1">
            <label htmlFor="demo-sms-phone" className="text-[11px] font-bold uppercase text-stone-500 block">
              Recipient Phone Number
            </label>
            <input
              id="demo-sms-phone"
              type="tel"
              required
              value={demoPhone}
              onChange={(e) => setDemoPhone(e.target.value)}
              placeholder="+916374799286"
              className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-700 text-xs font-mono font-bold text-stone-900 dark:text-stone-100"
            />
          </div>

          <div className="md:col-span-3 space-y-1">
            <label htmlFor="demo-sms-loc" className="text-[11px] font-bold uppercase text-stone-500 block">
              Alert Region
            </label>
            <select
              id="demo-sms-loc"
              value={demoLocationId}
              onChange={(e) => setDemoLocationId(e.target.value)}
              className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-700 text-xs font-bold text-stone-900 dark:text-stone-100"
            >
              {locations.map((l) => (
                <option key={`demo-${l.locationId}`} value={l.locationId}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2 space-y-1">
            <label htmlFor="demo-sms-risk" className="text-[11px] font-bold uppercase text-stone-500 block">
              Severity
            </label>
            <select
              id="demo-sms-risk"
              value={demoRiskLevel}
              onChange={(e) => setDemoRiskLevel(e.target.value as 'high' | 'extreme')}
              className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-700 text-xs font-bold text-stone-900 dark:text-stone-100"
            >
              <option value="extreme">EXTREME (&gt;41°C)</option>
              <option value="high">HIGH (36–41°C)</option>
            </select>
          </div>

          <div className="md:col-span-4 flex flex-wrap sm:flex-nowrap gap-2">
            <button
              type="submit"
              disabled={isSendingDemoSms || !demoPhone.trim()}
              className="flex-1 min-h-[42px] px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold transition cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              {isSendingDemoSms ? 'Sending...' : 'Send Gateway SMS'}
            </button>

            {(() => {
              const rawDigits = demoPhone.replace(/\D/g, '');
              const normalizedDigits =
                rawDigits.length === 10 && /^[6-9]/.test(rawDigits)
                  ? `91${rawDigits}`
                  : rawDigits;
              const locName =
                locations.find((l) => l.locationId === demoLocationId)?.name || 'Chennai';
              const alertText =
                demoRiskLevel === 'extreme'
                  ? `[Chennai Heat Guard] EXTREME HEAT ALERT (${locName}): Feels like 43.2C. Pause heavy outdoor work 12:00-16:00, move to shade, drink ORS/water every 20 min.`
                  : `[Chennai Heat Guard] HIGH HEAT WARNING (${locName}): Feels like 38.4C. Take 15 min shade breaks hourly and hydrate regularly.`;
              const hasValidPhone = normalizedDigits.length >= 10;
              const waHref = hasValidPhone
                ? `https://wa.me/${normalizedDigits}?text=${encodeURIComponent(alertText)}`
                : undefined;
              const smsHref = hasValidPhone
                ? `sms:+${normalizedDigits}?body=${encodeURIComponent(alertText)}`
                : undefined;

              return (
                <>
                  <a
                    href={waHref || '#'}
                    target={waHref ? '_blank' : undefined}
                    rel={waHref ? 'noopener noreferrer' : undefined}
                    onClick={(e) => {
                      if (!waHref) e.preventDefault();
                    }}
                    title="Open pre-filled alert in WhatsApp"
                    className={`min-h-[42px] px-3 py-2 rounded-xl border text-xs font-bold inline-flex items-center justify-center whitespace-nowrap transition ${
                      waHref
                        ? 'bg-green-50 hover:bg-green-100 text-green-800 border-green-300 dark:bg-green-950/50 dark:text-green-300 dark:border-green-800'
                        : 'bg-stone-100 text-stone-400 border-stone-200 dark:bg-stone-800 dark:text-stone-500 dark:border-stone-700 pointer-events-none'
                    }`}
                  >
                    WhatsApp
                  </a>
                  <a
                    href={smsHref || '#'}
                    onClick={(e) => {
                      if (!smsHref) e.preventDefault();
                    }}
                    title="Open pre-filled alert in your device SMS app"
                    className={`min-h-[42px] px-3 py-2 rounded-xl border text-xs font-bold inline-flex items-center justify-center whitespace-nowrap transition ${
                      smsHref
                        ? 'bg-sky-50 hover:bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-950/50 dark:text-sky-300 dark:border-sky-800'
                        : 'bg-stone-100 text-stone-400 border-stone-200 dark:bg-stone-800 dark:text-stone-500 dark:border-stone-700 pointer-events-none'
                    }`}
                  >
                    Phone SMS
                  </a>
                </>
              );
            })()}
          </div>

          <div className="md:col-span-12">
            <label className="inline-flex items-center gap-2 text-xs text-stone-600 dark:text-stone-300 cursor-pointer">
              <input
                type="checkbox"
                checked={demoConsent}
                onChange={(e) => setDemoConsent(e.target.checked)}
              />
              <span>I confirm this is my own or explicitly opted-in mobile number for a single live demo alert.</span>
            </label>
          </div>
        </form>

        {demoSmsError && (
          <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-xs text-rose-800 dark:text-rose-200">
            {demoSmsError}
          </div>
        )}

        {demoSmsResult && (
          <div
            className={`p-3 rounded-xl border text-xs space-y-1.5 ${
              demoSmsResult.sentViaCarrier
                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                : 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200'
            }`}
          >
            <div className="font-extrabold">
              {demoSmsResult.sentViaCarrier
                ? `Live SMS Dispatched to ${demoSmsResult.maskedPhone} via Custom SMS Gateway`
                : `Fallback Mode (${demoSmsResult.status}) — ${demoSmsResult.maskedPhone}`}
            </div>
            <p className="text-[11px]">{demoSmsResult.responseText}</p>
            <div className="p-2 rounded-lg bg-white/70 dark:bg-stone-900/70 font-mono text-[11px] text-stone-700 dark:text-stone-300">
              {demoSmsResult.messagePreview}
            </div>
          </div>
        )}
      </section>

      {/* 3. Manual Simulation Mode Panel */}
      <section className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-4 sm:p-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm sm:text-base font-black text-stone-900 dark:text-stone-100">
                Manual Heat Escalation Simulation
              </h4>
              {simActive && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-violet-600 text-white text-[11px] font-black uppercase tracking-wider">
                  SIMULATION MODE &middot; ZERO REAL SMS/ALERTS
                </span>
              )}
            </div>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Demonstrates LOW &rarr; MODERATE &rarr; HIGH &rarr; EXTREME &rarr; HIGH &rarr; MODERATE &rarr; LOW transitions, notification previews, and recovery messages without contacting real recipients.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSimulateTrajectory}
              disabled={simAutoPlaying || simRunning}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-extrabold transition shadow-xs cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{simAutoPlaying ? 'Simulating Trajectory...' : 'Simulate Heat Escalation'}</span>
            </button>

            <button
              type="button"
              onClick={handleResetSimulation}
              disabled={!simActive && simEvents.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-stone-100 hover:bg-stone-200 dark:bg-stone-800 dark:hover:bg-stone-700 border border-stone-200 dark:border-stone-700 text-xs font-bold text-stone-700 dark:text-stone-200 transition cursor-pointer disabled:opacity-40"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Simulation</span>
            </button>
          </div>
        </div>

        {/* Controls: Location + Channels + Stepper */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 pt-2 border-t border-stone-200 dark:border-stone-800">
          <div className="lg:col-span-4 space-y-2">
            <label className="text-[11px] font-bold uppercase tracking-wider text-stone-500 block">
              Target Region
            </label>
            <select
              value={simLocationId}
              onChange={(e) => setSimLocationId(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs font-bold text-stone-900 dark:text-stone-100"
            >
              {locations.map((l) => (
                <option key={l.locationId} value={l.locationId}>
                  {l.name} {!l.enabled ? '(Disabled)' : ''}
                </option>
              ))}
            </select>

            <div className="flex flex-wrap gap-3 pt-1 text-xs">
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-stone-700 dark:text-stone-300">
                <input
                  type="checkbox"
                  checked={simPushEnabled}
                  onChange={(e) => setSimPushEnabled(e.target.checked)}
                />
                <span>Push Channel</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-stone-700 dark:text-stone-300">
                <input
                  type="checkbox"
                  checked={simSmsEnabled}
                  onChange={(e) => setSimSmsEnabled(e.target.checked)}
                />
                <span>SMS Channel</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-rose-700 dark:text-rose-400">
                <input
                  type="checkbox"
                  checked={simFailSms}
                  onChange={(e) => setSimFailSms(e.target.checked)}
                />
                <span>Simulate SMS Failure</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-rose-700 dark:text-rose-400">
                <input
                  type="checkbox"
                  checked={simFailPush}
                  onChange={(e) => setSimFailPush(e.target.checked)}
                />
                <span>Simulate Push Failure</span>
              </label>
            </div>
          </div>

          <div className="lg:col-span-8 space-y-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-stone-500 block">
              Step-by-Step Transition Trigger (Current Sim Risk:{' '}
              <strong className="uppercase">{simCurrentRisk}</strong>)
            </span>
            <div className="flex flex-wrap gap-1.5">
              {SIMULATION_SEQUENCE.map((step) => {
                const isSelected = simActive && simStepIdx === step.stepIndex;
                return (
                  <button
                    key={step.stepIndex}
                    type="button"
                    disabled={simRunning || simAutoPlaying}
                    onClick={() => runSimulationStep(step.stepIndex)}
                    className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition cursor-pointer ${
                      isSelected
                        ? `${riskBadgeClasses(step.targetRisk)} ring-2 ring-violet-500`
                        : 'bg-stone-50 hover:bg-stone-100 dark:bg-stone-950 dark:hover:bg-stone-800 border-stone-200 dark:border-stone-800 text-stone-700 dark:text-stone-300'
                    }`}
                  >
                    {step.label} (~{step.expectedHi}°C)
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Simulation Previews & Escalation vs De-escalation Lists */}
        {simActive && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pt-3 border-t border-stone-200 dark:border-stone-800">
            {/* Notification Preview */}
            <div className="rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-extrabold uppercase tracking-wider text-violet-600 dark:text-violet-400">
                  Notification Preview
                </span>
                {simLatestEvent && (
                  <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase border ${riskBadgeClasses(simLatestEvent.currentRisk)}`}>
                    {simLatestEvent.previousRisk} &rarr; {simLatestEvent.currentRisk}
                  </span>
                )}
              </div>

              {simLatestEvent ? (
                <div className="space-y-2 text-xs">
                  <div className="p-2.5 rounded-lg bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-stone-900 dark:text-stone-100 flex items-center gap-1">
                        <BellRing className="w-3.5 h-3.5 text-orange-500" />
                        Push Notification
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border uppercase ${statusChipClasses(simLatestEvent.pushStatus)}`}>
                        {simLatestEvent.pushStatus}
                      </span>
                    </div>
                    <p className="font-bold text-stone-800 dark:text-stone-200">
                      {simLatestEvent.pushPreview?.title}
                    </p>
                    <p className="text-[11px] text-stone-600 dark:text-stone-400">
                      {simLatestEvent.pushPreview?.body}
                    </p>
                  </div>

                  <div className="p-2.5 rounded-lg bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-stone-900 dark:text-stone-100 flex items-center gap-1">
                        <MessageSquare className="w-3.5 h-3.5 text-blue-500" />
                        SMS Preview ({simLatestEvent.smsPreview?.recipientPhonesMasked?.length || 0} targeted)
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border uppercase ${statusChipClasses(simLatestEvent.smsStatus)}`}>
                        {simLatestEvent.smsStatus}
                      </span>
                    </div>
                    <p className="text-[11px] text-stone-600 dark:text-stone-400 font-mono">
                      {simLatestEvent.smsPreview?.message}
                    </p>
                    {simLatestEvent.smsPreview?.recipientPhonesMasked &&
                      simLatestEvent.smsPreview.recipientPhonesMasked.length > 0 && (
                        <p className="text-[10px] text-stone-500 tabular-nums">
                          Targets: {simLatestEvent.smsPreview.recipientPhonesMasked.join(', ')}
                        </p>
                      )}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-stone-500">
                  Run a simulation step above to inspect Push and SMS notification payloads.
                </p>
              )}
            </div>

            {/* Simulated Escalation History */}
            <div className="rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 p-3.5 space-y-2">
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-orange-600 dark:text-orange-400 flex items-center gap-1">
                <ArrowUpRight className="w-3.5 h-3.5" />
                Simulation Escalation History ({simEscalations.length})
              </span>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {simEscalations.length === 0 ? (
                  <p className="text-xs text-stone-500">No simulated escalations yet.</p>
                ) : (
                  simEscalations.map((e) => (
                    <div
                      key={e.id}
                      className="p-2 rounded-lg bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 text-[11px] space-y-0.5"
                    >
                      <div className="flex items-center justify-between font-bold">
                        <span>
                          {e.previousRisk.toUpperCase()} &rarr; {e.currentRisk.toUpperCase()}
                        </span>
                        <span className="tabular-nums text-stone-500">{e.heatIndex.toFixed(1)}°C</span>
                      </div>
                      <p className="text-stone-600 dark:text-stone-400 line-clamp-2">{e.safetyInstructions}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Simulated De-escalation History */}
            <div className="rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 p-3.5 space-y-2">
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                <ArrowDownRight className="w-3.5 h-3.5" />
                Simulation De-Escalation History ({simDeescalations.length})
              </span>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {simDeescalations.length === 0 ? (
                  <p className="text-xs text-stone-500">No simulated de-escalations yet.</p>
                ) : (
                  simDeescalations.map((e) => (
                    <div
                      key={e.id}
                      className="p-2 rounded-lg bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 text-[11px] space-y-0.5"
                    >
                      <div className="flex items-center justify-between font-bold">
                        <span>
                          {e.previousRisk.toUpperCase()} &rarr; {e.currentRisk.toUpperCase()} ({e.direction})
                        </span>
                        <span className="tabular-nums text-stone-500">{e.heatIndex.toFixed(1)}°C</span>
                      </div>
                      <p className="text-stone-600 dark:text-stone-400 line-clamp-2">{e.safetyInstructions}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 4. Monitored Locations Live State Grid */}
      <section className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h4 className="text-sm sm:text-base font-black text-stone-900 dark:text-stone-100">
              Live Regional Risk States ({locations.filter((l) => l.enabled).length} Enabled)
            </h4>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Thresholds: &lt;{settings.moderateThreshold}°C LOW &middot; {settings.moderateThreshold}–{settings.highThreshold}°C MODERATE &middot; {settings.highThreshold}–{settings.extremeThreshold}°C HIGH &middot; &gt;{settings.extremeThreshold}°C EXTREME
            </p>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={aiBriefLocationId}
              onChange={(e) => setAiBriefLocationId(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 text-xs font-semibold"
            >
              {locations.filter((l) => l.enabled).map((l) => (
                <option key={l.locationId} value={l.locationId}>
                  {l.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleGenerateAiBrief}
              disabled={isLoadingAi}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-stone-900 hover:bg-stone-800 dark:bg-stone-800 dark:hover:bg-stone-700 text-white text-xs font-bold transition cursor-pointer disabled:opacity-50"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>{isLoadingAi ? 'Analyzing...' : 'AI Trend Brief'}</span>
            </button>
          </div>
        </div>

        {aiBrief && (
          <div className="bg-stone-900 text-stone-100 dark:bg-stone-900 border border-stone-700 rounded-2xl p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                HeatGuard AI Risk Brief {aiBrief.aiAvailable ? '(Gemini Live)' : '(Protocol Fallback)'}
              </span>
              <button
                type="button"
                onClick={() => setAiBrief(null)}
                className="text-xs text-stone-400 hover:text-white cursor-pointer"
              >
                Close
              </button>
            </div>
            <p className="text-xs text-stone-200">{aiBrief.riskRationale}</p>
            <p className="text-xs font-semibold text-amber-300">{aiBrief.safetyInstructions}</p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {locations
            .filter((l) => l.enabled)
            .map((loc) => {
              const st = states.find((s) => s.locationId === loc.locationId);
              const risk: RiskLevel = st?.currentRisk || 'low';
              return (
                <div
                  key={loc.locationId}
                  className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-4 space-y-2.5 transition-all duration-300"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h5 className="text-sm font-black text-stone-900 dark:text-stone-100">
                        {loc.name}
                      </h5>
                      <span className="text-[11px] text-stone-500">
                        {loc.region || 'Tamil Nadu'} &middot; {loc.lat.toFixed(2)}, {loc.lng.toFixed(2)}
                      </span>
                    </div>
                    <span
                      className={`px-2.5 py-0.5 rounded-md border text-[11px] font-black uppercase transition-colors duration-300 ${riskBadgeClasses(
                        risk
                      )}`}
                    >
                      {risk}
                    </span>
                  </div>

                  {st ? (
                    <>
                      <div className="grid grid-cols-3 gap-2 pt-1 text-xs">
                        <div>
                          <span className="text-[10px] text-stone-500 block">Feels Like</span>
                          <span className="font-black text-stone-900 dark:text-stone-100 tabular-nums">
                            {st.currentHeatIndex.toFixed(1)}°C
                          </span>
                        </div>
                        <div>
                          <span className="text-[10px] text-stone-500 block">Air / RH</span>
                          <span className="font-bold text-stone-800 dark:text-stone-200 tabular-nums">
                            {st.currentTemp}° / {st.currentHumidity}%
                          </span>
                        </div>
                        <div>
                          <span className="text-[10px] text-stone-500 block">3h Trend</span>
                          <span className="inline-flex items-center gap-1 font-bold text-stone-800 dark:text-stone-200 capitalize">
                            {st.trend === 'rising' ? (
                              <TrendingUp className="w-3.5 h-3.5 text-rose-500" />
                            ) : st.trend === 'falling' ? (
                              <TrendingDown className="w-3.5 h-3.5 text-emerald-500" />
                            ) : (
                              <Minus className="w-3.5 h-3.5 text-stone-400" />
                            )}
                            {st.trend}
                          </span>
                        </div>
                      </div>
                      <div className="pt-2 border-t border-stone-100 dark:border-stone-800 flex items-center justify-between text-[11px] text-stone-500 tabular-nums">
                        <span>Prev: {st.previousRisk.toUpperCase()}</span>
                        <span>
                          Eval:{' '}
                          {new Date(st.lastEvaluatedAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-stone-500">
                      Waiting for first monitoring cycle evaluation...
                    </p>
                  )}
                </div>
              );
            })}
        </div>
      </section>

      {/* 5. Latest Escalations & Latest De-escalations */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Escalations */}
        <div className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-black text-stone-900 dark:text-stone-100 flex items-center gap-1.5">
              <ArrowUpRight className="w-4 h-4 text-rose-500" />
              Latest Escalation Events
            </h4>
            <span className="text-[11px] text-stone-500 tabular-nums">
              {latestEscalations.length} recent
            </span>
          </div>
          {latestEscalations.length === 0 ? (
            <p className="text-xs text-stone-500 py-4 text-center">
              No automatic escalations triggered yet. Threshold transitions will appear here automatically.
            </p>
          ) : (
            <div className="space-y-2">
              {latestEscalations.map((evt) => (
                <div
                  key={evt.id}
                  className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-stone-900 dark:text-stone-100">
                      {evt.locationName}
                    </span>
                    <span className={`px-2 py-0.5 rounded border text-[10px] font-black uppercase ${riskBadgeClasses(evt.currentRisk)}`}>
                      {evt.previousRisk} &rarr; {evt.currentRisk}
                    </span>
                  </div>
                  <p className="text-[11px] text-stone-600 dark:text-stone-400">
                    {evt.safetyInstructions}
                  </p>
                  <div className="flex items-center justify-between text-[10px] text-stone-500 tabular-nums pt-0.5">
                    <span>
                      HI {evt.heatIndex.toFixed(1)}°C &middot; {evt.recipientCount} recipients
                    </span>
                    <span>{new Date(evt.timestamp).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* De-escalations */}
        <div className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-black text-stone-900 dark:text-stone-100 flex items-center gap-1.5">
              <ArrowDownRight className="w-4 h-4 text-emerald-500" />
              Latest De-Escalation & Recovery Events
            </h4>
            <span className="text-[11px] text-stone-500 tabular-nums">
              {latestDeescalations.length} recent
            </span>
          </div>
          {latestDeescalations.length === 0 ? (
            <p className="text-xs text-stone-500 py-4 text-center">
              No heat de-escalation or verified recovery events recorded yet.
            </p>
          ) : (
            <div className="space-y-2">
              {latestDeescalations.map((evt) => (
                <div
                  key={evt.id}
                  className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-stone-900 dark:text-stone-100">
                      {evt.locationName}
                    </span>
                    <span className={`px-2 py-0.5 rounded border text-[10px] font-black uppercase ${riskBadgeClasses(evt.currentRisk)}`}>
                      {evt.previousRisk} &rarr; {evt.currentRisk}
                    </span>
                  </div>
                  <p className="text-[11px] text-stone-600 dark:text-stone-400">
                    {evt.safetyInstructions}
                  </p>
                  <div className="flex items-center justify-between text-[10px] text-stone-500 tabular-nums pt-0.5">
                    <span>
                      HI {evt.heatIndex.toFixed(1)}°C &middot; {evt.recipientCount} notified
                    </span>
                    <span>{new Date(evt.timestamp).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 6. Searchable Alert History Table */}
      <section className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-stone-200 dark:border-stone-800 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h4 className="text-sm sm:text-base font-black text-stone-900 dark:text-stone-100">
                Alert Escalation History Log
              </h4>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                Complete audit trail of risk transitions, recipient counts, Push status, and SMS delivery tracking.
              </p>
            </div>
            <span className="text-xs font-bold text-stone-500 tabular-nums">
              Showing {filteredHistory.length} of {history.length} records
            </span>
          </div>

          {/* Search & Multi-Filter Bar */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search alerts or instructions..."
                className="w-full pl-8 pr-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs text-stone-900 dark:text-stone-100"
              />
            </div>

            <select
              value={filterLocation}
              onChange={(e) => setFilterLocation(e.target.value)}
              className="px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs font-semibold"
            >
              <option value="all">All Locations</option>
              {locations.map((l) => (
                <option key={l.locationId} value={l.locationId}>
                  {l.name}
                </option>
              ))}
            </select>

            <select
              value={filterRisk}
              onChange={(e) => setFilterRisk(e.target.value)}
              className="px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs font-semibold"
            >
              <option value="all">All Risk Levels</option>
              <option value="low">LOW</option>
              <option value="moderate">MODERATE</option>
              <option value="high">HIGH</option>
              <option value="extreme">EXTREME</option>
            </select>

            <input
              type="date"
              value={filterDate}
              onChange={(e) => setFilterDate(e.target.value)}
              className="px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs"
            />

            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs font-semibold"
            >
              <option value="all">All Delivery Statuses</option>
              <option value="sent">Sent</option>
              <option value="partial">Partial</option>
              <option value="failed">Failed</option>
              <option value="simulated">Simulated</option>
              <option value="skipped">Dashboard Only</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-stone-50 dark:bg-stone-950/70 border-b border-stone-200 dark:border-stone-800 text-[11px] font-extrabold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                <th className="py-3 px-4">Location</th>
                <th className="py-3 px-4">Previous Risk</th>
                <th className="py-3 px-4">Current Risk</th>
                <th className="py-3 px-4">Escalation Time</th>
                <th className="py-3 px-4 text-right">Recipients Notified</th>
                <th className="py-3 px-4">Push Status</th>
                <th className="py-3 px-4">SMS Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200/70 dark:divide-stone-800 text-xs">
              {filteredHistory.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-stone-500">
                    No alert transition records match your current filters.
                  </td>
                </tr>
              ) : (
                filteredHistory.map((evt) => (
                  <tr
                    key={evt.id}
                    className="hover:bg-stone-50/70 dark:hover:bg-stone-800/40 transition-colors"
                  >
                    <td className="py-3 px-4">
                      <div className="font-bold text-stone-900 dark:text-stone-100">
                        {evt.locationName}
                      </div>
                      <div className="text-[11px] text-stone-500 tabular-nums">
                        HI: {evt.heatIndex.toFixed(1)}°C &middot; {evt.direction}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold uppercase ${riskBadgeClasses(
                          evt.previousRisk
                        )}`}
                      >
                        {evt.previousRisk}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-block px-2 py-0.5 rounded border text-[10px] font-black uppercase ${riskBadgeClasses(
                          evt.currentRisk
                        )}`}
                      >
                        {evt.currentRisk}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-stone-600 dark:text-stone-300 tabular-nums whitespace-nowrap">
                      {new Date(evt.timestamp).toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right font-bold tabular-nums text-stone-900 dark:text-stone-100">
                      {evt.recipientCount}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold uppercase ${statusChipClasses(
                          evt.pushStatus
                        )}`}
                      >
                        {evt.pushStatus}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold uppercase ${statusChipClasses(
                          evt.smsStatus
                        )}`}
                      >
                        {evt.smsStatus}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 7. Firebase Scheduled Functions Billing & Backend Scheduler Architecture Note */}
      <section className="bg-stone-50 dark:bg-stone-900/80 rounded-2xl border border-stone-200 dark:border-stone-800 p-4 sm:p-5 space-y-2.5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-orange-600 dark:text-orange-400 shrink-0" />
            <h4 className="text-xs sm:text-sm font-black text-stone-900 dark:text-stone-100">
              15-Minute Autonomous Scheduling Architecture &amp; Firebase Plan Note
            </h4>
          </div>
          <button
            type="button"
            onClick={() => setShowBlazeGuide((v) => !v)}
            className="text-xs font-bold text-orange-600 dark:text-orange-400 hover:underline self-start sm:self-auto cursor-pointer"
          >
            {showBlazeGuide ? 'Hide Deployment Details' : 'View Spark vs Blaze Upgrade Details'}
          </button>
        </div>

        <p className="text-xs text-stone-600 dark:text-stone-400 leading-relaxed">
          HeatGuard runs its 15-minute heat monitor inside the Node.js backend process (
          <code className="text-[11px]">services/escalationEngine.ts</code>), so risk detection and alerts run continuously without requiring any open browser window or paid Firebase Blaze billing.
        </p>

        {showBlazeGuide && (
          <div className="pt-2 border-t border-stone-200 dark:border-stone-800 text-xs text-stone-600 dark:text-stone-300 space-y-1.5">
            <p>
              <strong>Why Firebase Scheduled Cloud Functions require Blaze:</strong> Google Cloud Scheduler + Cloud Functions v2 (
              <code className="text-[11px]">firebase-functions/v2/scheduler</code>) require the Firebase{' '}
              <strong>Blaze (Pay-as-you-go)</strong> billing plan and Cloud Build API activation. On the{' '}
              <strong>Spark (Free)</strong> plan, serverless cron functions cannot deploy.
            </p>
            <p>
              <strong>Included Compatible Alternative:</strong> This application&apos;s Express backend scheduler runs every{' '}
              {settings.monitoringInterval} minutes using <code className="text-[11px]">setInterval</code> independently of browsers, persists state in <code className="text-[11px]">.runtime/escalation-store.json</code>, and coordinates atomic Firestore updates via <code className="text-[11px]">runTransaction</code>. For serverless Firebase deployment after upgrading to Blaze, deploy a 15-minute <code className="text-[11px]">onSchedule(&quot;every 15 minutes&quot;)</code> Cloud Function calling <code className="text-[11px]">runScheduledHeatMonitor()</code>.
            </p>
          </div>
        )}
      </section>
    </div>
  );
};
