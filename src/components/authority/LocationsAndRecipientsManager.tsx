import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Eye,
  Lock,
  MapPin,
  Phone,
  Plus,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { MonitoredLocation, RecipientSubscription, RiskLevel } from '../../types';
import {
  deleteAdminRecipient,
  deleteMonitoredLocation,
  EscalationOverviewResponse,
  fetchAdminRecipients,
  fetchTargetingPreview,
  saveAdminRecipient,
  saveMonitoredLocation,
  TargetingPreviewResponse,
} from '../../services/escalationApi';
import {
  BOOTSTRAPPED_ADMIN_EMAIL,
  deleteRecipientFromFirestore,
  saveMonitoredLocationToFirestore,
  saveRecipientToFirestore,
} from '../../services/firebase';

interface Props {
  overview: EscalationOverviewResponse;
  isAdmin: boolean;
  onSignInAdmin: () => Promise<void>;
  onRefresh: () => Promise<void>;
}

export const LocationsAndRecipientsManager: React.FC<Props> = ({
  overview,
  isAdmin,
  onSignInAdmin,
  onRefresh,
}) => {
  const { locations, recipientsMasked } = overview;

  const [fullRecipients, setFullRecipients] = useState<RecipientSubscription[] | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  // Add Location form
  const [newLocName, setNewLocName] = useState('');
  const [newLocRegion, setNewLocRegion] = useState('');
  const [newLocLat, setNewLocLat] = useState('');
  const [newLocLng, setNewLocLng] = useState('');

  // Add Recipient form
  const [recName, setRecName] = useState('');
  const [recPhone, setRecPhone] = useState('');
  const [recLocationIds, setRecLocationIds] = useState<string[]>(['t-nagar']);
  const [recPush, setRecPush] = useState(true);
  const [recSms, setRecSms] = useState(true);
  const [recConsent, setRecConsent] = useState(true);
  const [recMinRisk, setRecMinRisk] = useState<'moderate' | 'high' | 'extreme'>('high');

  // Targeting Preview
  const [previewLocationId, setPreviewLocationId] = useState<string>('t-nagar');
  const [previewRisk, setPreviewRisk] = useState<RiskLevel>('extreme');
  const [previewResult, setPreviewResult] = useState<TargetingPreviewResponse | null>(null);

  useEffect(() => {
    let active = true;
    if (isAdmin) {
      fetchAdminRecipients()
        .then((list) => {
          if (active) setFullRecipients(list);
        })
        .catch(() => {
          if (active) setFullRecipients(null);
        });
    } else {
      setFullRecipients(null);
    }
    return () => {
      active = false;
    };
  }, [isAdmin, overview]);

  useEffect(() => {
    fetchTargetingPreview(previewLocationId, previewRisk)
      .then(setPreviewResult)
      .catch(() => {});
  }, [previewLocationId, previewRisk, overview]);

  const displayedRecipients = fullRecipients || recipientsMasked;

  const toggleLocationEnabled = async (loc: MonitoredLocation) => {
    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }
    setBusyId(loc.locationId);
    setFeedback(null);
    try {
      const updated = await saveMonitoredLocation({ ...loc, enabled: !loc.enabled });
      await saveMonitoredLocationToFirestore(updated).catch(() => {});
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || 'Could not update location.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleAddLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }
    const lat = parseFloat(newLocLat);
    const lng = parseFloat(newLocLng);
    if (!newLocName.trim() || Number.isNaN(lat) || Number.isNaN(lng)) {
      setFeedback({ type: 'error', text: 'Provide valid location name, latitude, and longitude.' });
      return;
    }

    setBusyId('add-loc');
    setFeedback(null);
    try {
      const locId = newLocName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const saved = await saveMonitoredLocation({
        locationId: locId || `loc-${Date.now()}`,
        name: newLocName.trim(),
        region: newLocRegion.trim() || newLocName.trim(),
        lat,
        lng,
        enabled: true,
      });
      await saveMonitoredLocationToFirestore(saved).catch(() => {});
      setNewLocName('');
      setNewLocRegion('');
      setNewLocLat('');
      setNewLocLng('');
      await onRefresh();
      setFeedback({ type: 'success', text: `Added monitored region: ${saved.name}` });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || 'Unable to add location.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteLocation = async (locationId: string) => {
    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }
    setBusyId(locationId);
    try {
      await deleteMonitoredLocation(locationId);
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || 'Unable to delete location.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleRecipientLoc = (locId: string) => {
    setRecLocationIds((prev) =>
      prev.includes(locId) ? prev.filter((id) => id !== locId) : [...prev, locId]
    );
  };

  const handleAddRecipient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }
    if (!recName.trim() || recLocationIds.length === 0) {
      setFeedback({ type: 'error', text: 'Recipient name and at least one location are required.' });
      return;
    }

    setBusyId('add-rec');
    setFeedback(null);
    try {
      const saved = await saveAdminRecipient({
        name: recName.trim(),
        phone: recPhone.trim(),
        locationIds: recLocationIds,
        pushEnabled: recPush,
        smsEnabled: recSms,
        consentGranted: recConsent,
        active: true,
        minRiskLevel: recMinRisk,
      });
      await saveRecipientToFirestore(saved).catch(() => {});
      setRecName('');
      setRecPhone('');
      await onRefresh();
      setFeedback({ type: 'success', text: `Saved alert subscriber: ${saved.name}` });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || 'Unable to save recipient.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleRecipientActive = async (rec: RecipientSubscription) => {
    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }
    setBusyId(rec.id);
    try {
      const saved = await saveAdminRecipient({ ...rec, active: !rec.active });
      await saveRecipientToFirestore(saved).catch(() => {});
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || 'Failed updating recipient status.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleRecipientConsent = async (rec: RecipientSubscription) => {
    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }
    setBusyId(rec.id);
    try {
      const saved = await saveAdminRecipient({ ...rec, consentGranted: !rec.consentGranted });
      await saveRecipientToFirestore(saved).catch(() => {});
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || 'Failed updating consent.' });
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteRecipient = async (recId: string) => {
    if (!isAdmin) {
      await onSignInAdmin();
      return;
    }
    setBusyId(recId);
    try {
      await deleteAdminRecipient(recId);
      await deleteRecipientFromFirestore(recId).catch(() => {});
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'error', text: err?.message || 'Unable to delete recipient.' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      {!isAdmin && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800/60 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs text-amber-900 dark:text-amber-200">
            <Lock className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Viewing masked recipient summaries. Sign in as authenticated administrator (
              <strong>{BOOTSTRAPPED_ADMIN_EMAIL}</strong>) to add locations, manage phone numbers, toggle opt-in status, or remove subscribers.
            </span>
          </div>
          <button
            type="button"
            onClick={onSignInAdmin}
            className="px-3.5 py-2 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-orange-600 text-white text-xs font-bold shrink-0 cursor-pointer"
          >
            Admin Google Sign-In
          </button>
        </div>
      )}

      {feedback && (
        <div
          className={`rounded-xl px-4 py-2.5 text-xs font-semibold border ${
            feedback.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-800 dark:text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-800 dark:text-rose-300'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* 1. Location-Based Notification Targeting Preview */}
      <section className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-4 sm:p-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-black text-stone-900 dark:text-stone-100 flex items-center gap-1.5">
              <Eye className="w-4 h-4 text-blue-500" />
              Location-Based Notification Targeting Check
            </h4>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Verifies only opted-in, active subscribers subscribed to the affected location are notified (e.g., Chennai alerts never notify Coimbatore subscribers).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={previewLocationId}
              onChange={(e) => setPreviewLocationId(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs font-bold"
            >
              {locations.map((l) => (
                <option key={l.locationId} value={l.locationId}>
                  {l.name}
                </option>
              ))}
            </select>
            <select
              value={previewRisk}
              onChange={(e) => setPreviewRisk(e.target.value as RiskLevel)}
              className="px-2.5 py-1.5 rounded-lg bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs font-bold uppercase"
            >
              <option value="low">LOW</option>
              <option value="moderate">MODERATE</option>
              <option value="high">HIGH</option>
              <option value="extreme">EXTREME</option>
            </select>
          </div>
        </div>

        {previewResult && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-1">
            <div className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800">
              <span className="text-[11px] font-bold uppercase text-stone-500 block mb-1">
                SMS Targets Matched ({previewResult.smsCount})
              </span>
              {previewResult.smsRecipients.length === 0 ? (
                <span className="text-stone-500">No opted-in SMS recipients for this location &amp; risk level.</span>
              ) : (
                <ul className="space-y-1">
                  {previewResult.smsRecipients.map((r) => (
                    <li key={r.id} className="font-semibold text-stone-800 dark:text-stone-200">
                      &bull; {r.name} <span className="text-stone-500">({r.locationIds.join(', ')})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800">
              <span className="text-[11px] font-bold uppercase text-stone-500 block mb-1">
                Push Targets Matched ({previewResult.pushCount} subscribers &middot; {previewResult.deviceTokenCount} devices)
              </span>
              {previewResult.pushRecipients.length === 0 ? (
                <span className="text-stone-500">No opted-in push recipients for this location &amp; risk level.</span>
              ) : (
                <ul className="space-y-1">
                  {previewResult.pushRecipients.map((r) => (
                    <li key={r.id} className="font-semibold text-stone-800 dark:text-stone-200">
                      &bull; {r.name} <span className="text-stone-500">({r.locationIds.join(', ')})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      {/* 2. Monitored Locations Panel */}
      <section className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm sm:text-base font-black text-stone-900 dark:text-stone-100 flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-orange-500" />
              Monitored Locations ({locations.length})
            </h4>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Only locations marked <strong>Enabled</strong> are evaluated by the 15-minute scheduler.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {locations.map((loc) => (
            <div
              key={loc.locationId}
              className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="font-bold text-xs text-stone-900 dark:text-stone-100 truncate">
                  {loc.name}
                </div>
                <div className="text-[11px] text-stone-500 tabular-nums">
                  {loc.lat.toFixed(3)}, {loc.lng.toFixed(3)} &middot; {loc.region || 'TN'}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled={busyId === loc.locationId}
                  onClick={() => toggleLocationEnabled(loc)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border cursor-pointer transition ${
                    loc.enabled
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40'
                      : 'bg-stone-200 dark:bg-stone-800 text-stone-600 dark:text-stone-400 border-stone-300 dark:border-stone-700'
                  }`}
                >
                  {loc.enabled ? 'Enabled' : 'Disabled'}
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => handleDeleteLocation(loc.locationId)}
                    title="Remove location"
                    className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 transition cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <form onSubmit={handleAddLocation} className="grid grid-cols-1 sm:grid-cols-5 gap-2 pt-2 border-t border-stone-200 dark:border-stone-800">
          <input
            type="text"
            placeholder="Location name (e.g. Ambattur)"
            value={newLocName}
            onChange={(e) => setNewLocName(e.target.value)}
            className="sm:col-span-2 px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs"
          />
          <input
            type="text"
            placeholder="Region (e.g. Chennai)"
            value={newLocRegion}
            onChange={(e) => setNewLocRegion(e.target.value)}
            className="px-3 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <input
              type="number"
              step="0.0001"
              placeholder="Lat"
              value={newLocLat}
              onChange={(e) => setNewLocLat(e.target.value)}
              className="px-2.5 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs"
            />
            <input
              type="number"
              step="0.0001"
              placeholder="Lng"
              value={newLocLng}
              onChange={(e) => setNewLocLng(e.target.value)}
              className="px-2.5 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 text-xs"
            />
          </div>
          <button
            type="submit"
            disabled={busyId === 'add-loc'}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-stone-900 hover:bg-stone-800 dark:bg-orange-600 dark:hover:bg-orange-700 text-white text-xs font-bold cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Location</span>
          </button>
        </form>
      </section>

      {/* 3. Subscribed Recipients & Consent Management */}
      <section className="bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm sm:text-base font-black text-stone-900 dark:text-stone-100 flex items-center gap-1.5">
              <Users className="w-4 h-4 text-emerald-500" />
              Recipients &amp; Consent Management ({displayedRecipients.length})
            </h4>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Supports multiple phone numbers per location, multi-location subscriptions, channel preferences, and opt-in consent enforcement.
            </p>
          </div>
        </div>

        {/* Add Recipient Form */}
        <form onSubmit={handleAddRecipient} className="p-3.5 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 space-y-3">
          <div className="text-xs font-extrabold uppercase tracking-wider text-stone-600 dark:text-stone-300 flex items-center gap-1.5">
            <UserPlus className="w-3.5 h-3.5 text-orange-500" />
            Add / Enroll Alert Recipient
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <input
              type="text"
              placeholder="Recipient Name or Crew Role"
              value={recName}
              onChange={(e) => setRecName(e.target.value)}
              className="px-3 py-2 rounded-xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 text-xs"
            />
            <input
              type="tel"
              placeholder="Phone (+9198400xxxxx)"
              value={recPhone}
              onChange={(e) => setRecPhone(e.target.value)}
              className="px-3 py-2 rounded-xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 text-xs"
            />
            <select
              value={recMinRisk}
              onChange={(e) => setRecMinRisk(e.target.value as 'moderate' | 'high' | 'extreme')}
              className="px-3 py-2 rounded-xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 text-xs font-semibold"
            >
              <option value="moderate">Notify at MODERATE+</option>
              <option value="high">Notify at HIGH+</option>
              <option value="extreme">Notify at EXTREME Only</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <span className="text-[11px] font-bold text-stone-500 block">
              Subscribed Locations (multi-location):
            </span>
            <div className="flex flex-wrap gap-1.5">
              {locations.map((loc) => {
                const selected = recLocationIds.includes(loc.locationId);
                return (
                  <button
                    key={loc.locationId}
                    type="button"
                    onClick={() => handleToggleRecipientLoc(loc.locationId)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border cursor-pointer transition ${
                      selected
                        ? 'bg-orange-600 text-white border-orange-500'
                        : 'bg-white dark:bg-stone-900 text-stone-600 dark:text-stone-400 border-stone-200 dark:border-stone-800'
                    }`}
                  >
                    {loc.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={recPush}
                  onChange={(e) => setRecPush(e.target.checked)}
                />
                <span>Push Alerts</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={recSms}
                  onChange={(e) => setRecSms(e.target.checked)}
                />
                <span>SMS Alerts</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer font-semibold text-emerald-700 dark:text-emerald-400">
                <input
                  type="checkbox"
                  checked={recConsent}
                  onChange={(e) => setRecConsent(e.target.checked)}
                />
                <span>Explicit Opt-in Consent Granted</span>
              </label>
            </div>

            <button
              type="submit"
              disabled={busyId === 'add-rec'}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold cursor-pointer transition"
            >
              Save Subscriber
            </button>
          </div>
        </form>

        {/* Recipients Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-stone-50 dark:bg-stone-950/70 border-b border-stone-200 dark:border-stone-800 text-[11px] font-extrabold uppercase tracking-wider text-stone-500">
                <th className="py-2.5 px-3">Recipient</th>
                <th className="py-2.5 px-3">Phone</th>
                <th className="py-2.5 px-3">Locations</th>
                <th className="py-2.5 px-3">Channels &amp; Min Risk</th>
                <th className="py-2.5 px-3">Consent</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200/70 dark:divide-stone-800">
              {displayedRecipients.map((rec) => (
                <tr key={rec.id} className="hover:bg-stone-50/70 dark:hover:bg-stone-800/40">
                  <td className="py-2.5 px-3 font-bold text-stone-900 dark:text-stone-100">
                    {rec.name}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-stone-600 dark:text-stone-300 tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <Phone className="w-3 h-3 text-stone-400" />
                      {rec.phone || 'Push-only'}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-stone-700 dark:text-stone-300">
                    {rec.locationIds.join(', ')}
                  </td>
                  <td className="py-2.5 px-3">
                    <span className="font-semibold">
                      {[rec.pushEnabled ? 'Push' : null, rec.smsEnabled ? 'SMS' : null]
                        .filter(Boolean)
                        .join(' + ') || 'None'}
                    </span>
                    <span className="text-stone-500"> &middot; {rec.minRiskLevel.toUpperCase()}+</span>
                  </td>
                  <td className="py-2.5 px-3">
                    <button
                      type="button"
                      disabled={busyId === rec.id}
                      onClick={() => handleToggleRecipientConsent(rec)}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border cursor-pointer ${
                        rec.consentGranted
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                          : 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30'
                      }`}
                    >
                      <ShieldCheck className="w-3 h-3" />
                      {rec.consentGranted ? 'Opted In' : 'Opted Out'}
                    </button>
                  </td>
                  <td className="py-2.5 px-3">
                    <button
                      type="button"
                      disabled={busyId === rec.id}
                      onClick={() => handleToggleRecipientActive(rec)}
                      className={`px-2 py-0.5 rounded text-[10px] font-bold border cursor-pointer ${
                        rec.active
                          ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30'
                          : 'bg-stone-200 dark:bg-stone-800 text-stone-500 border-stone-300 dark:border-stone-700'
                      }`}
                    >
                      {rec.active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => handleDeleteRecipient(rec.id)}
                        className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 cursor-pointer"
                        title="Delete subscriber"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
