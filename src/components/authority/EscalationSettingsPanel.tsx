import React, { useEffect, useState } from 'react';
import { CheckCircle2, Lock, Save, Sliders } from 'lucide-react';
import { NotificationSettings } from '../../types';
import { saveEscalationSettings } from '../../services/escalationApi';
import { BOOTSTRAPPED_ADMIN_EMAIL, saveSettingsToFirestore } from '../../services/firebase';

interface Props {
  settings: NotificationSettings;
  isAdmin: boolean;
  adminEmail: string | null;
  onSignInAdmin: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

export const EscalationSettingsPanel: React.FC<Props> = ({
  settings,
  isAdmin,
  adminEmail,
  onSignInAdmin,
  onRefresh,
}) => {
  const [form, setForm] = useState<NotificationSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }

    if (
      form.moderateThreshold >= form.highThreshold ||
      form.highThreshold >= form.extremeThreshold
    ) {
      setStatusMsg({
        type: 'error',
        text: 'Thresholds must follow strict ascending order: Moderate < High < Extreme.',
      });
      return;
    }

    setSaving(true);
    setStatusMsg(null);
    try {
      const updated = await saveEscalationSettings(form);
      await saveSettingsToFirestore(updated, adminEmail || BOOTSTRAPPED_ADMIN_EMAIL).catch(
        (err) => console.warn('Firestore settings sync warning:', err)
      );
      await onRefresh();
      setStatusMsg({
        type: 'success',
        text: 'Escalation thresholds, scheduling intervals, and notification preferences saved.',
      });
    } catch (err: any) {
      setStatusMsg({
        type: 'error',
        text: err?.message || 'Unable to save escalation settings.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-5 sm:p-6 space-y-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-stone-200 dark:border-stone-800">
        <div>
          <h4 className="text-base font-black text-stone-900 dark:text-stone-100 flex items-center gap-2">
            <Sliders className="w-4 h-4 text-orange-500" />
            Admin Escalation Engine Controls
          </h4>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Configure autonomous monitoring cadence, Heat Index thresholds, duplicate suppression cooldowns, and delivery channels.
          </p>
        </div>

        {!isAdmin && (
          <button
            type="button"
            onClick={onSignInAdmin}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-orange-600 text-white text-xs font-bold cursor-pointer self-start sm:self-auto"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>Sign in as Admin to Edit</span>
          </button>
        )}
      </div>

      {statusMsg && (
        <div
          className={`rounded-xl px-4 py-3 text-xs font-semibold border flex items-center gap-2 ${
            statusMsg.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-800 dark:text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-800 dark:text-rose-300'
          }`}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{statusMsg.text}</span>
        </div>
      )}

      {/* Numeric Intervals & Thresholds */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
        <label className="space-y-1.5">
          <span className="font-bold text-stone-700 dark:text-stone-300 block">
            Monitoring Frequency (minutes)
          </span>
          <input
            type="number"
            min={1}
            max={120}
            disabled={!isAdmin}
            value={form.monitoringInterval}
            onChange={(e) =>
              setForm({ ...form, monitoringInterval: Number(e.target.value) || 15 })
            }
            className="w-full px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 font-bold tabular-nums"
          />
        </label>

        <label className="space-y-1.5">
          <span className="font-bold text-stone-700 dark:text-stone-300 block">
            Alert Cooldown Duration (minutes)
          </span>
          <input
            type="number"
            min={0}
            max={1440}
            disabled={!isAdmin}
            value={form.cooldownMinutes}
            onChange={(e) =>
              setForm({ ...form, cooldownMinutes: Number(e.target.value) || 0 })
            }
            className="w-full px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 font-bold tabular-nums"
          />
        </label>

        <label className="space-y-1.5">
          <span className="font-bold text-stone-700 dark:text-stone-300 block">
            Reminder Interval (minutes, 0 = off)
          </span>
          <input
            type="number"
            min={0}
            max={1440}
            disabled={!isAdmin}
            value={form.reminderIntervalMinutes}
            onChange={(e) =>
              setForm({ ...form, reminderIntervalMinutes: Number(e.target.value) || 0 })
            }
            className="w-full px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 font-bold tabular-nums"
          />
        </label>

        <label className="space-y-1.5">
          <span className="font-bold text-yellow-700 dark:text-yellow-400 block">
            MODERATE Threshold (°C Heat Index)
          </span>
          <input
            type="number"
            step="0.5"
            disabled={!isAdmin}
            value={form.moderateThreshold}
            onChange={(e) =>
              setForm({ ...form, moderateThreshold: Number(e.target.value) || 32 })
            }
            className="w-full px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 font-bold tabular-nums"
          />
        </label>

        <label className="space-y-1.5">
          <span className="font-bold text-orange-700 dark:text-orange-400 block">
            HIGH Threshold (°C Heat Index)
          </span>
          <input
            type="number"
            step="0.5"
            disabled={!isAdmin}
            value={form.highThreshold}
            onChange={(e) =>
              setForm({ ...form, highThreshold: Number(e.target.value) || 36 })
            }
            className="w-full px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 font-bold tabular-nums"
          />
        </label>

        <label className="space-y-1.5">
          <span className="font-bold text-rose-700 dark:text-rose-400 block">
            EXTREME Threshold (°C Heat Index)
          </span>
          <input
            type="number"
            step="0.5"
            disabled={!isAdmin}
            value={form.extremeThreshold}
            onChange={(e) =>
              setForm({ ...form, extremeThreshold: Number(e.target.value) || 41 })
            }
            className="w-full px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 font-bold tabular-nums"
          />
        </label>

        <label className="space-y-1.5">
          <span className="font-bold text-stone-700 dark:text-stone-300 block">
            SMS Delivery Max Retries
          </span>
          <input
            type="number"
            min={0}
            max={5}
            disabled={!isAdmin}
            value={form.maxRetries}
            onChange={(e) =>
              setForm({ ...form, maxRetries: Math.min(5, Math.max(0, Number(e.target.value) || 0)) })
            }
            className="w-full px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 font-bold tabular-nums"
          />
        </label>
      </div>

      {/* Feature Toggles */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-2 border-t border-stone-200 dark:border-stone-800 text-xs">
        {[
          {
            key: 'escalationEnabled' as const,
            label: 'Auto-Escalation Engine Enabled',
            desc: 'Triggers notifications automatically on threshold increases',
          },
          {
            key: 'pushEnabled' as const,
            label: 'Push Notifications (FCM)',
            desc: 'Send browser push notifications on Moderate/High/Extreme',
          },
          {
            key: 'smsEnabled' as const,
            label: 'Backend SMS Delivery',
            desc: 'Send secure server-side SMS on High & Extreme to opted-in phones',
          },
          {
            key: 'notifyOnModerate' as const,
            label: 'Notify on MODERATE Escalation',
            desc: 'Send optional push notification when entering Moderate risk',
          },
          {
            key: 'notifyOnDeescalation' as const,
            label: 'De-Escalation & Recovery Alerts',
            desc: 'Notify when Heat Index drops across tiers with verified evidence',
          },
        ].map((item) => (
          <label
            key={item.key}
            className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 flex items-start gap-2.5 cursor-pointer"
          >
            <input
              type="checkbox"
              disabled={!isAdmin}
              checked={Boolean(form[item.key])}
              onChange={(e) => setForm({ ...form, [item.key]: e.target.checked })}
              className="mt-0.5"
            />
            <div>
              <span className="font-bold text-stone-900 dark:text-stone-100 block">
                {item.label}
              </span>
              <span className="text-[11px] text-stone-500">{item.desc}</span>
            </div>
          </label>
        ))}
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-stone-200 dark:border-stone-800">
        <span className="text-[11px] text-stone-500">
          Last updated: {settings.updatedAt ? new Date(settings.updatedAt).toLocaleString() : 'Default'}{' '}
          {settings.updatedBy ? `by ${settings.updatedBy}` : ''}
        </span>

        <button
          type="submit"
          disabled={!isAdmin || saving}
          className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-extrabold transition cursor-pointer disabled:opacity-40"
        >
          <Save className="w-3.5 h-3.5" />
          <span>{saving ? 'Saving Settings...' : 'Save Escalation Controls'}</span>
        </button>
      </div>
    </form>
  );
};
