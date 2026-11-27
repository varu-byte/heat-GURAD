import fs from 'fs';
import path from 'path';
import {
  AlertDirection,
  AlertHistoryEvent,
  AlertStateRecord,
  DeliveryStatus,
  DeviceTokenRecord,
  EscalationDashboardStats,
  HeatTrend,
  MonitoredLocation,
  NotificationChannel,
  NotificationSettings,
  RecipientSubscription,
  RiskLevel,
  SmsDeliveryRecord,
} from '../src/types';
import {
  calculateRothfusz,
  fetchOpenMeteoJson,
  getChennaiCurrentHour,
  getRiskLevel,
} from './weather';
import { buildDeterministicSafetyProtocol, generateAiEscalationAnalysis } from './aiAdvisor';
import { dispatchSmsWithRetry, getSmsGatewayConfigStatus, maskPhoneNumber } from './smsService';

const RUNTIME_DIR = path.join(process.cwd(), '.runtime');
const STORE_PATH = path.join(RUNTIME_DIR, 'escalation-store.json');

interface StoreShape {
  settings: NotificationSettings;
  locations: MonitoredLocation[];
  alertState: Record<string, AlertStateRecord>;
  alertHistory: AlertHistoryEvent[];
  recipients: RecipientSubscription[];
  deviceTokens: DeviceTokenRecord[];
  smsDeliveries: SmsDeliveryRecord[];
  scheduler: {
    lastRunAt: string | null;
    nextRunAt: string | null;
    runsCompleted: number;
  };
}

const DEFAULT_SETTINGS: NotificationSettings = {
  monitoringInterval: 15,
  cooldownMinutes: 30,
  reminderIntervalMinutes: 60,
  smsEnabled: true,
  pushEnabled: true,
  escalationEnabled: true,
  notifyOnModerate: true,
  notifyOnDeescalation: true,
  moderateThreshold: 32,
  highThreshold: 36,
  extremeThreshold: 41,
  maxRetries: 3,
  updatedBy: 'system-default',
  updatedAt: new Date().toISOString(),
};

const DEFAULT_LOCATIONS: MonitoredLocation[] = [
  {
    locationId: 't-nagar',
    name: 'Chennai - T. Nagar',
    name_ta: 'சென்னை - தி. நகர்',
    region: 'Chennai',
    ward_no: 141,
    lat: 13.0418,
    lng: 80.2341,
    enabled: true,
  },
  {
    locationId: 'koyambedu',
    name: 'Chennai - Koyambedu',
    name_ta: 'சென்னை - கோயம்பேடு',
    region: 'Chennai',
    ward_no: 127,
    lat: 13.0694,
    lng: 80.1948,
    enabled: true,
  },
  {
    locationId: 'guindy',
    name: 'Chennai - Guindy',
    name_ta: 'சென்னை - கிண்டி',
    region: 'Chennai',
    ward_no: 168,
    lat: 13.0067,
    lng: 80.2025,
    enabled: true,
  },
  {
    locationId: 'marina',
    name: 'Chennai - Marina',
    name_ta: 'சென்னை - மெரினா',
    region: 'Chennai',
    ward_no: 111,
    lat: 13.05,
    lng: 80.2824,
    enabled: true,
  },
  {
    locationId: 'ennore',
    name: 'Chennai - Ennore',
    name_ta: 'சென்னை - எண்ணூர்',
    region: 'Chennai',
    ward_no: 1,
    lat: 13.203,
    lng: 80.323,
    enabled: true,
  },
  {
    locationId: 'coimbatore',
    name: 'Coimbatore',
    name_ta: 'கோயம்புத்தூர்',
    region: 'Coimbatore',
    ward_no: 42,
    lat: 11.0168,
    lng: 76.9558,
    enabled: true,
  },
  {
    locationId: 'madurai',
    name: 'Madurai',
    name_ta: 'மதுரை',
    region: 'Madurai',
    ward_no: 18,
    lat: 9.9252,
    lng: 78.1198,
    enabled: false,
  },
];

const DEFAULT_RECIPIENTS: RecipientSubscription[] = [
  {
    id: 'rec-chennai-ops',
    ownerUid: 'system-admin',
    name: 'Chennai Field Supervisor (T. Nagar & Koyambedu)',
    phone: '+919840011223',
    locationIds: ['t-nagar', 'koyambedu', 'guindy'],
    pushEnabled: true,
    smsEnabled: true,
    consentGranted: true,
    consentTimestamp: new Date().toISOString(),
    active: true,
    minRiskLevel: 'high',
  },
  {
    id: 'rec-chennai-coast',
    ownerUid: 'system-admin',
    name: 'Chennai Coastal Crew Lead (Marina & Ennore)',
    phone: '+919840044556',
    locationIds: ['marina', 'ennore'],
    pushEnabled: true,
    smsEnabled: true,
    consentGranted: true,
    consentTimestamp: new Date().toISOString(),
    active: true,
    minRiskLevel: 'moderate',
  },
  {
    id: 'rec-coimbatore-ops',
    ownerUid: 'system-admin',
    name: 'Coimbatore Municipal Team',
    phone: '+919442177889',
    locationIds: ['coimbatore'],
    pushEnabled: true,
    smsEnabled: true,
    consentGranted: true,
    consentTimestamp: new Date().toISOString(),
    active: true,
    minRiskLevel: 'high',
  },
];

let store: StoreShape = loadStore();
const processingLocks = new Set<string>();
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

function riskRank(risk: RiskLevel): number {
  switch (risk) {
    case 'low':
      return 0;
    case 'moderate':
      return 1;
    case 'high':
      return 2;
    case 'extreme':
      return 3;
  }
}

function loadStore(): StoreShape {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as StoreShape;
      return {
        settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
        locations: parsed.locations?.length ? parsed.locations : DEFAULT_LOCATIONS,
        alertState: parsed.alertState || {},
        alertHistory: parsed.alertHistory || [],
        recipients: parsed.recipients?.length ? parsed.recipients : DEFAULT_RECIPIENTS,
        deviceTokens: parsed.deviceTokens || [],
        smsDeliveries: parsed.smsDeliveries || [],
        scheduler: parsed.scheduler || {
          lastRunAt: null,
          nextRunAt: null,
          runsCompleted: 0,
        },
      };
    }
  } catch (err) {
    console.warn('Could not load escalation store, initializing defaults:', err);
  }

  return {
    settings: { ...DEFAULT_SETTINGS },
    locations: [...DEFAULT_LOCATIONS],
    alertState: {},
    alertHistory: [],
    recipients: [...DEFAULT_RECIPIENTS],
    deviceTokens: [],
    smsDeliveries: [],
    scheduler: {
      lastRunAt: null,
      nextRunAt: null,
      runsCompleted: 0,
    },
  };
}

function persistStore(): void {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Failed to persist escalation store:', err);
  }
}

export function getNotificationSettings(): NotificationSettings {
  return store.settings;
}

export function updateNotificationSettings(
  patch: Partial<NotificationSettings>,
  updatedBy: string
): NotificationSettings {
  const next: NotificationSettings = {
    ...store.settings,
    ...patch,
    monitoringInterval: Math.max(1, Math.min(120, Number(patch.monitoringInterval ?? store.settings.monitoringInterval))),
    cooldownMinutes: Math.max(0, Math.min(1440, Number(patch.cooldownMinutes ?? store.settings.cooldownMinutes))),
    reminderIntervalMinutes: Math.max(
      0,
      Math.min(1440, Number(patch.reminderIntervalMinutes ?? store.settings.reminderIntervalMinutes))
    ),
    moderateThreshold: Number(patch.moderateThreshold ?? store.settings.moderateThreshold),
    highThreshold: Number(patch.highThreshold ?? store.settings.highThreshold),
    extremeThreshold: Number(patch.extremeThreshold ?? store.settings.extremeThreshold),
    maxRetries: Math.max(0, Math.min(5, Number(patch.maxRetries ?? store.settings.maxRetries))),
    updatedBy,
    updatedAt: new Date().toISOString(),
  };

  if (next.highThreshold <= next.moderateThreshold) {
    next.highThreshold = next.moderateThreshold + 2;
  }
  if (next.extremeThreshold <= next.highThreshold) {
    next.extremeThreshold = next.highThreshold + 2;
  }

  const intervalChanged = next.monitoringInterval !== store.settings.monitoringInterval;
  store.settings = next;
  persistStore();

  if (intervalChanged) {
    restartScheduler();
  }
  return next;
}

export function getMonitoredLocations(): MonitoredLocation[] {
  return store.locations;
}

export function upsertMonitoredLocation(loc: MonitoredLocation): MonitoredLocation {
  const cleanId = loc.locationId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64);
  const now = new Date().toISOString();
  const idx = store.locations.findIndex((l) => l.locationId === cleanId);
  const next: MonitoredLocation = {
    ...loc,
    locationId: cleanId,
    name: loc.name.trim().slice(0, 100),
    lat: Number(loc.lat),
    lng: Number(loc.lng),
    enabled: Boolean(loc.enabled),
    updatedAt: now,
    createdAt: idx >= 0 ? store.locations[idx].createdAt : now,
  };

  if (idx >= 0) {
    store.locations[idx] = next;
  } else {
    store.locations.push(next);
  }
  persistStore();
  return next;
}

export function deleteMonitoredLocation(locationId: string): boolean {
  const before = store.locations.length;
  store.locations = store.locations.filter((l) => l.locationId !== locationId);
  delete store.alertState[locationId];
  if (store.locations.length !== before) {
    persistStore();
    return true;
  }
  return false;
}

export function getRecipients(redactForPublic = false): RecipientSubscription[] {
  if (!redactForPublic) return store.recipients;
  return store.recipients.map((r) => ({
    ...r,
    phone: maskPhoneNumber(r.phone),
  }));
}

export function upsertRecipient(rec: RecipientSubscription): RecipientSubscription {
  const now = new Date().toISOString();
  const id = (rec.id || `rec-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  const idx = store.recipients.findIndex((r) => r.id === id);

  const next: RecipientSubscription = {
    id,
    ownerUid: rec.ownerUid || 'system-admin',
    name: rec.name.trim().slice(0, 100),
    phone: rec.phone.trim().slice(0, 24),
    locationIds: Array.from(new Set(rec.locationIds || [])).slice(0, 25),
    pushEnabled: Boolean(rec.pushEnabled),
    smsEnabled: Boolean(rec.smsEnabled),
    consentGranted: Boolean(rec.consentGranted),
    consentTimestamp: rec.consentGranted ? rec.consentTimestamp || now : undefined,
    active: Boolean(rec.active),
    minRiskLevel: rec.minRiskLevel || 'high',
    createdAt: idx >= 0 ? store.recipients[idx].createdAt : now,
    updatedAt: now,
  };

  if (idx >= 0) {
    store.recipients[idx] = next;
  } else {
    store.recipients.unshift(next);
  }
  persistStore();
  return next;
}

export function deleteRecipient(id: string): boolean {
  const before = store.recipients.length;
  store.recipients = store.recipients.filter((r) => r.id !== id);
  if (store.recipients.length !== before) {
    persistStore();
    return true;
  }
  return false;
}

export function registerDeviceToken(input: {
  userId: string;
  locationIds: string[];
  fcmToken: string;
  notificationEnabled: boolean;
}): DeviceTokenRecord {
  const now = new Date().toISOString();
  const id = `tok-${input.userId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48)}`;
  const idx = store.deviceTokens.findIndex((d) => d.id === id || d.fcmToken === input.fcmToken);

  const record: DeviceTokenRecord = {
    id,
    userId: input.userId.slice(0, 128),
    locationIds: Array.from(new Set(input.locationIds || [])).slice(0, 25),
    fcmToken: input.fcmToken.slice(0, 512),
    notificationEnabled: Boolean(input.notificationEnabled),
    updatedAt: now,
  };

  if (idx >= 0) {
    store.deviceTokens[idx] = record;
  } else {
    store.deviceTokens.unshift(record);
  }
  persistStore();
  return record;
}

export function getAlertStates(): AlertStateRecord[] {
  return Object.values(store.alertState);
}

export function getAlertHistory(includeSimulated = true): AlertHistoryEvent[] {
  if (includeSimulated) return store.alertHistory;
  return store.alertHistory.filter((e) => !e.simulationMode);
}

export function getSmsDeliveries(): SmsDeliveryRecord[] {
  return store.smsDeliveries.slice(0, 100);
}

export function getEscalationDashboardStats(): EscalationDashboardStats {
  const states = Object.values(store.alertState);
  const riskCounts: Record<RiskLevel, number> = {
    low: 0,
    moderate: 0,
    high: 0,
    extreme: 0,
  };

  let totalActiveAlerts = 0;
  for (const s of states) {
    riskCounts[s.currentRisk] = (riskCounts[s.currentRisk] || 0) + 1;
    if (s.activeAlert) totalActiveAlerts += 1;
  }

  let smsSent = 0;
  let smsFailed = 0;
  let smsRetrying = 0;
  let smsSimulated = 0;
  for (const rec of store.smsDeliveries) {
    if (rec.status === 'sent') smsSent += 1;
    else if (rec.status === 'failed') smsFailed += 1;
    else if (rec.status === 'retrying') smsRetrying += 1;
    else if (rec.status === 'simulated') smsSimulated += 1;
  }

  let pushSent = 0;
  let pushFailed = 0;
  let pushSimulated = 0;
  for (const evt of store.alertHistory) {
    if (evt.pushStatus === 'sent' || evt.pushStatus === 'partial') {
      pushSent += evt.pushCount || 1;
    } else if (evt.pushStatus === 'failed') {
      pushFailed += 1;
    } else if (evt.pushStatus === 'simulated') {
      pushSimulated += evt.pushCount || 1;
    }
  }

  const failedEvents = store.alertHistory.filter(
    (e) => e.deliveryStatus === 'failed' || e.deliveryStatus === 'partial'
  ).length;

  return {
    totalActiveAlerts,
    riskCounts,
    smsStats: {
      sent: smsSent,
      failed: smsFailed,
      retrying: smsRetrying,
      simulated: smsSimulated,
    },
    pushStats: {
      sent: pushSent,
      failed: pushFailed,
      simulated: pushSimulated,
      registeredTokens: store.deviceTokens.filter((d) => d.notificationEnabled).length,
    },
    failedNotificationsCount: smsFailed + pushFailed + failedEvents,
    schedulerStatus: {
      running: schedulerTimer !== null,
      intervalMinutes: store.settings.monitoringInterval,
      lastRunAt: store.scheduler.lastRunAt,
      nextRunAt: store.scheduler.nextRunAt,
      runsCompleted: store.scheduler.runsCompleted,
    },
  };
}

/**
 * Location-based targeting filter:
 * Matches ONLY active, consent-granted recipients subscribed to `locationId`
 * whose minimum risk threshold is met by `risk`.
 */
export function getTargetedRecipients(
  locationId: string,
  risk: RiskLevel
): {
  smsRecipients: RecipientSubscription[];
  pushRecipients: RecipientSubscription[];
  deviceTokens: DeviceTokenRecord[];
} {
  const rank = riskRank(risk);
  const eligible = store.recipients.filter(
    (r) =>
      r.active &&
      r.consentGranted &&
      r.locationIds.includes(locationId) &&
      rank >= riskRank(r.minRiskLevel)
  );

  const smsRecipients = eligible.filter((r) => r.smsEnabled && Boolean(r.phone?.trim()));
  const pushRecipients = eligible.filter((r) => r.pushEnabled);
  const deviceTokens = store.deviceTokens.filter(
    (t) => t.notificationEnabled && t.locationIds.includes(locationId)
  );

  return { smsRecipients, pushRecipients, deviceTokens };
}

/**
 * Dispatches FCM push notifications via FCM legacy/HTTP endpoint when FCM_SERVER_KEY is configured,
 * or records simulated/local browser delivery status cleanly.
 */
async function dispatchPushNotifications(params: {
  location: MonitoredLocation;
  risk: RiskLevel;
  heatIndex: number;
  title: string;
  body: string;
  tokens: DeviceTokenRecord[];
  subscriberCount: number;
  simulationMode: boolean;
  simulatePushFailure?: boolean;
}): Promise<{ status: DeliveryStatus; deliveredCount: number }> {
  const totalTargets = Math.max(params.tokens.length, params.subscriberCount);
  if (totalTargets === 0) {
    return { status: 'skipped', deliveredCount: 0 };
  }

  if (params.simulationMode) {
    return { status: 'simulated', deliveredCount: totalTargets };
  }

  if (params.simulatePushFailure) {
    return { status: 'failed', deliveredCount: 0 };
  }

  const fcmServerKey = process.env.FCM_SERVER_KEY?.trim();
  if (fcmServerKey && params.tokens.length > 0) {
    let successCount = 0;
    for (const tokenRec of params.tokens) {
      if (!tokenRec.fcmToken || tokenRec.fcmToken.startsWith('webpush-')) {
        successCount += 1;
        continue;
      }
      try {
        const res = await fetch('https://fcm.googleapis.com/fcm/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `key=${fcmServerKey}`,
          },
          body: JSON.stringify({
            to: tokenRec.fcmToken,
            notification: {
              title: params.title,
              body: params.body,
            },
            data: {
              locationId: params.location.locationId,
              locationName: params.location.name,
              risk: params.risk,
              heatIndex: String(params.heatIndex),
            },
          }),
        });
        if (res.ok) successCount += 1;
      } catch {
        // Count failed token
      }
    }
    if (successCount === 0) return { status: 'failed', deliveredCount: 0 };
    if (successCount < params.tokens.length) return { status: 'partial', deliveredCount: successCount };
    return { status: 'sent', deliveredCount: successCount };
  }

  // Recorded for registered browser clients / foreground listener polling
  return { status: 'sent', deliveredCount: totalTargets };
}

/**
 * Evaluates a single location's telemetry atomically with smart duplicate prevention,
 * cooldown, reminder intervals, escalation/de-escalation rules, AI guidance, and channel delivery.
 */
export async function evaluateLocationHeatTransition(input: {
  location: MonitoredLocation;
  airTemp: number;
  humidity: number;
  heatIndex: number;
  forecastPeakHeatIndex: number;
  trend: HeatTrend;
  simulationMode?: boolean;
  forcePreviousRisk?: RiskLevel;
  simulateSmsFailure?: boolean;
  simulatePushFailure?: boolean;
  forceChannels?: { push?: boolean; sms?: boolean };
  useAiAdvisor?: boolean;
}): Promise<{
  state: AlertStateRecord;
  event: AlertHistoryEvent | null;
  suppressedReason?: string;
}> {
  const { location } = input;
  const simulationMode = Boolean(input.simulationMode);
  const lockKey = `${simulationMode ? 'sim-' : ''}${location.locationId}`;

  if (processingLocks.has(lockKey)) {
    const existing = store.alertState[location.locationId];
    return {
      state:
        existing || {
          locationId: location.locationId,
          locationName: location.name,
          currentRisk: 'low',
          previousRisk: 'low',
          currentHeatIndex: input.heatIndex,
          currentTemp: input.airTemp,
          currentHumidity: input.humidity,
          trend: input.trend,
          lastEscalationTime: null,
          lastNotificationTime: null,
          lastEvaluatedAt: new Date().toISOString(),
          activeAlert: false,
        },
      event: null,
      suppressedReason: 'concurrent-lock-prevented-duplicate',
    };
  }

  processingLocks.add(lockKey);

  try {
    const settings = store.settings;
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    const newRisk = getRiskLevel(input.heatIndex, {
      moderate: settings.moderateThreshold,
      high: settings.highThreshold,
      extreme: settings.extremeThreshold,
    });

    const existingState = store.alertState[location.locationId];
    const previousRisk: RiskLevel =
      input.forcePreviousRisk ?? (existingState ? existingState.currentRisk : 'low');

    const prevRank = riskRank(previousRisk);
    const newRank = riskRank(newRisk);

    const lastNotifMs = existingState?.lastNotificationTime
      ? new Date(existingState.lastNotificationTime).getTime()
      : 0;
    const minsSinceLastNotif = lastNotifMs ? (nowMs - lastNotifMs) / 60_000 : Infinity;

    let direction: AlertDirection | null = null;
    let suppressedReason: string | undefined;

    if (!settings.escalationEnabled && !simulationMode) {
      suppressedReason = 'escalation-disabled-by-admin';
    } else if (newRank > prevRank) {
      // Escalation
      if (!simulationMode && existingState && minsSinceLastNotif < settings.cooldownMinutes && newRisk !== 'extreme') {
        suppressedReason = `cooldown-active (${Math.round(minsSinceLastNotif)}m < ${settings.cooldownMinutes}m)`;
      } else {
        direction = 'escalation';
      }
    } else if (newRank < prevRank) {
      // De-escalation / Recovery
      direction = newRisk === 'low' ? 'recovery' : 'de-escalation';
    } else {
      // Unchanged risk level -> smart duplicate prevention
      if (
        !simulationMode &&
        (newRisk === 'high' || newRisk === 'extreme') &&
        settings.reminderIntervalMinutes > 0 &&
        minsSinceLastNotif >= settings.reminderIntervalMinutes
      ) {
        direction = 'reminder';
      } else {
        suppressedReason = 'unchanged-risk-duplicate-prevented';
      }
    }

    let aiAnalysisSummary = existingState?.aiSummary;
    let safetyInstructions = buildDeterministicSafetyProtocol({
      locationName: location.name,
      previousRisk,
      currentRisk: newRisk,
      direction: direction || 'escalation',
      airTemp: input.airTemp,
      humidity: input.humidity,
      heatIndex: input.heatIndex,
      forecastPeakHeatIndex: input.forecastPeakHeatIndex,
      trend: input.trend,
    });

    if (direction && (input.useAiAdvisor ?? true)) {
      const aiRes = await generateAiEscalationAnalysis({
        locationName: location.name,
        previousRisk,
        currentRisk: newRisk,
        direction,
        airTemp: input.airTemp,
        humidity: input.humidity,
        heatIndex: input.heatIndex,
        forecastPeakHeatIndex: input.forecastPeakHeatIndex,
        trend: input.trend,
      });
      aiAnalysisSummary = aiRes.riskRationale;
      if (aiRes.aiAvailable && aiRes.safetyInstructions) {
        safetyInstructions = aiRes.safetyInstructions;
      }
    }

    let createdEvent: AlertHistoryEvent | null = null;

    if (direction) {
      const channels: NotificationChannel[] = ['dashboard'];
      const targeting = getTargetedRecipients(location.locationId, newRisk);

      const shouldPush =
        (input.forceChannels?.push ?? true) &&
        settings.pushEnabled &&
        ((direction === 'escalation' &&
          ((newRisk === 'moderate' && settings.notifyOnModerate) ||
            newRisk === 'high' ||
            newRisk === 'extreme')) ||
          (direction === 'reminder' && (newRisk === 'high' || newRisk === 'extreme')) ||
          ((direction === 'de-escalation' || direction === 'recovery') &&
            settings.notifyOnDeescalation));

      const shouldSms =
        (input.forceChannels?.sms ?? true) &&
        settings.smsEnabled &&
        ((direction === 'escalation' && (newRisk === 'high' || newRisk === 'extreme')) ||
          (direction === 'reminder' && (newRisk === 'high' || newRisk === 'extreme')) ||
          (direction === 'de-escalation' && settings.notifyOnDeescalation && previousRisk === 'extreme'));

      if (shouldPush) channels.push('push');
      if (shouldSms) channels.push('sms');
      if (newRisk === 'extreme') channels.push('admin');

      const eventId = `${simulationMode ? 'sim' : 'evt'}-${location.locationId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      const pushTitle =
        direction === 'recovery'
          ? `HeatGuard Recovery · ${location.name}`
          : direction === 'de-escalation'
            ? `HeatGuard De-Escalation (${newRisk.toUpperCase()}) · ${location.name}`
            : `HeatGuard ${newRisk.toUpperCase()} Risk Alert · ${location.name}`;

      let pushStatus: DeliveryStatus = 'skipped';
      let pushDelivered = 0;
      if (shouldPush) {
        const pushResult = await dispatchPushNotifications({
          location,
          risk: newRisk,
          heatIndex: input.heatIndex,
          title: pushTitle,
          body: safetyInstructions,
          tokens: targeting.deviceTokens,
          subscriberCount: targeting.pushRecipients.length,
          simulationMode,
          simulatePushFailure: input.simulatePushFailure,
        });
        pushStatus = pushResult.status;
        pushDelivered = pushResult.deliveredCount;
      }

      let smsStatus: DeliveryStatus = 'skipped';
      let smsDelivered = 0;
      let smsFailed = 0;
      const smsPhonesMasked: string[] = [];

      if (shouldSms && targeting.smsRecipients.length > 0) {
        const smsRecords = await Promise.all(
          targeting.smsRecipients.map((recipient) =>
            dispatchSmsWithRetry({
              eventId,
              recipientId: recipient.id,
              recipientName: recipient.name,
              phone: recipient.phone,
              locationId: location.locationId,
              message: `[HeatGuard ${newRisk.toUpperCase()}] ${location.name}: Feels like ${input.heatIndex.toFixed(1)}°C. ${safetyInstructions.slice(0, 110)}`,
              maxRetries: settings.maxRetries,
              simulationMode,
              simulateFailure: input.simulateSmsFailure,
            })
          )
        );

        smsRecords.forEach((r) => {
          smsPhonesMasked.push(r.phoneMasked);
          if (r.status === 'sent' || r.status === 'simulated') smsDelivered += 1;
          else if (r.status === 'failed') smsFailed += 1;
          if (!simulationMode) {
            store.smsDeliveries.unshift(r);
          }
        });

        if (smsFailed === smsRecords.length) {
          smsStatus = 'failed';
        } else if (smsFailed > 0) {
          smsStatus = 'partial';
        } else if (simulationMode) {
          smsStatus = 'simulated';
        } else {
          smsStatus = 'sent';
        }
      }

      const overallStatus: DeliveryStatus =
        pushStatus === 'failed' && smsStatus === 'failed'
          ? 'failed'
          : pushStatus === 'failed' || smsStatus === 'failed' || smsStatus === 'partial'
            ? 'partial'
            : simulationMode
              ? 'simulated'
              : pushStatus === 'sent' || smsStatus === 'sent'
                ? 'sent'
                : 'skipped';

      const recipientCount = Math.max(
        targeting.smsRecipients.length,
        targeting.pushRecipients.length,
        targeting.deviceTokens.length
      );

      createdEvent = {
        id: eventId,
        locationId: location.locationId,
        locationName: location.name,
        previousRisk,
        currentRisk: newRisk,
        direction,
        timestamp: nowIso,
        notificationChannels: channels,
        recipientCount,
        pushCount: pushDelivered,
        smsCount: smsDelivered,
        failedCount: smsFailed + (pushStatus === 'failed' ? 1 : 0),
        deliveryStatus: overallStatus,
        pushStatus,
        smsStatus,
        simulationMode,
        heatIndex: input.heatIndex,
        airTemp: input.airTemp,
        humidity: input.humidity,
        safetyInstructions,
        aiSummary: aiAnalysisSummary,
        reason: suppressedReason || `${previousRisk.toUpperCase()} -> ${newRisk.toUpperCase()}`,
        pushPreview: {
          title: pushTitle,
          body: safetyInstructions,
          locationName: location.name,
          riskLevel: newRisk,
          precautions: [
            newRisk === 'extreme'
              ? 'Stop strenuous outdoor labor (12:00-16:00)'
              : 'Take shaded rest breaks & drink ORS/water',
            `Feels like ${input.heatIndex.toFixed(1)}°C (Air ${input.airTemp}°C, RH ${input.humidity}%)`,
          ],
        },
        smsPreview: {
          recipientPhonesMasked: smsPhonesMasked,
          message: `[HeatGuard ${newRisk.toUpperCase()}] ${location.name}: Feels like ${input.heatIndex.toFixed(1)}°C. ${safetyInstructions}`,
        },
      };

      if (!simulationMode) {
        store.alertHistory.unshift(createdEvent);
        if (store.alertHistory.length > 250) store.alertHistory.length = 250;
        if (store.smsDeliveries.length > 250) store.smsDeliveries.length = 250;
      }
    }

    const nextState: AlertStateRecord = {
      locationId: location.locationId,
      locationName: location.name,
      currentRisk: newRisk,
      previousRisk,
      currentHeatIndex: input.heatIndex,
      forecastPeakHeatIndex: input.forecastPeakHeatIndex,
      currentTemp: input.airTemp,
      currentHumidity: input.humidity,
      trend: input.trend,
      lastEscalationTime:
        direction === 'escalation'
          ? nowIso
          : existingState?.lastEscalationTime || null,
      lastNotificationTime: createdEvent
        ? nowIso
        : existingState?.lastNotificationTime || null,
      lastEvaluatedAt: nowIso,
      activeAlert: newRisk !== 'low',
      aiSummary: aiAnalysisSummary,
      updatedAt: nowIso,
    };

    if (!simulationMode) {
      store.alertState[location.locationId] = nextState;
      persistStore();
    }

    return {
      state: nextState,
      event: createdEvent,
      suppressedReason,
    };
  } finally {
    processingLocks.delete(lockKey);
  }
}

/**
 * Fetches live Open-Meteo telemetry for all ENABLED locations in ONE batch request
 * and evaluates escalations/de-escalations for each.
 */
export async function runScheduledHeatMonitor(
  triggerSource: 'scheduler' | 'manual' = 'scheduler'
): Promise<{
  evaluatedCount: number;
  eventsTriggered: AlertHistoryEvent[];
  states: AlertStateRecord[];
}> {
  const enabledLocations = store.locations.filter((l) => l.enabled);
  const eventsTriggered: AlertHistoryEvent[] = [];
  const states: AlertStateRecord[] = [];

  if (enabledLocations.length === 0) {
    return { evaluatedCount: 0, eventsTriggered: [], states: [] };
  }

  const lats = enabledLocations.map((l) => l.lat.toFixed(2)).join(',');
  const lngs = enabledLocations.map((l) => l.lng.toFixed(2)).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}&current=temperature_2m,relative_humidity_2m&hourly=temperature_2m,relative_humidity_2m&timezone=Asia/Kolkata&forecast_days=1`;
  const cacheKey = `monitor:${lats}|${lngs}`;

  let apiResults: any[] = [];
  try {
    const { data: json } = await fetchOpenMeteoJson<any>(url, cacheKey, {
      ttlMs: 10 * 60 * 1000,
      timeoutMs: 9500,
      maxRetries: 2,
      forceRefresh: triggerSource === 'manual',
      allowStaleOnError: true,
    });
    apiResults = Array.isArray(json) ? json : [json];
  } catch (err: any) {
    console.warn(`[Monitor:${triggerSource}] Live Open-Meteo fetch unavailable: ${err?.message || err}`);
    return {
      evaluatedCount: 0,
      eventsTriggered: [],
      states: Object.values(store.alertState),
    };
  }

  const curHour = getChennaiCurrentHour();

  for (let i = 0; i < enabledLocations.length; i++) {
    const loc = enabledLocations[i];
    const data = apiResults[i];
    if (!data) continue;

    const airTemp =
      typeof data.current?.temperature_2m === 'number'
        ? Math.round(data.current.temperature_2m * 10) / 10
        : Math.round((data.hourly?.temperature_2m?.[curHour] ?? 30) * 10) / 10;

    const humidity =
      typeof data.current?.relative_humidity_2m === 'number'
        ? Math.round(data.current.relative_humidity_2m)
        : Math.round(data.hourly?.relative_humidity_2m?.[curHour] ?? 65);

    const hiNow = calculateRothfusz(airTemp, humidity);

    let peakNext3h = hiNow;
    for (let h = 1; h <= 3; h++) {
      const idx = Math.min(23, curHour + h);
      const tFuture = data.hourly?.temperature_2m?.[idx];
      const hFuture = data.hourly?.relative_humidity_2m?.[idx];
      if (typeof tFuture === 'number' && typeof hFuture === 'number') {
        const hiFuture = calculateRothfusz(tFuture, hFuture);
        if (hiFuture > peakNext3h) peakNext3h = hiFuture;
      }
    }

    const diff = peakNext3h - hiNow;
    const trend: HeatTrend = diff >= 1.0 ? 'rising' : diff <= -1.0 ? 'falling' : 'stable';

    const outcome = await evaluateLocationHeatTransition({
      location: loc,
      airTemp,
      humidity,
      heatIndex: hiNow,
      forecastPeakHeatIndex: peakNext3h,
      trend,
      simulationMode: false,
      useAiAdvisor: true,
    });

    states.push(outcome.state);
    if (outcome.event) {
      eventsTriggered.push(outcome.event);
    }
  }

  const now = new Date();
  const next = new Date(now.getTime() + store.settings.monitoringInterval * 60_000);
  store.scheduler = {
    lastRunAt: now.toISOString(),
    nextRunAt: next.toISOString(),
    runsCompleted: store.scheduler.runsCompleted + 1,
  };
  persistStore();

  return {
    evaluatedCount: states.length,
    eventsTriggered,
    states,
  };
}

export async function retryFailedSmsDeliveries(): Promise<{
  retried: number;
  recovered: number;
}> {
  const failedRecords = store.smsDeliveries.filter((r) => r.status === 'failed');
  let retried = 0;
  let recovered = 0;

  for (const record of failedRecords) {
    const recipient = store.recipients.find((r) => r.id === record.recipientId);
    if (!recipient) continue;
    retried += 1;

    const retryResult = await dispatchSmsWithRetry({
      eventId: record.eventId,
      recipientId: recipient.id,
      recipientName: recipient.name,
      phone: recipient.phone,
      locationId: record.locationId,
      message: record.messagePreview,
      maxRetries: store.settings.maxRetries,
      simulationMode: false,
    });

    const idx = store.smsDeliveries.findIndex((s) => s.id === record.id);
    if (idx >= 0) {
      store.smsDeliveries[idx] = {
        ...retryResult,
        attempts: [...record.attempts, ...retryResult.attempts],
      };
    }

    if (retryResult.status === 'sent') {
      recovered += 1;
      const evt = store.alertHistory.find((e) => e.id === record.eventId);
      if (evt) {
        evt.smsStatus = 'sent';
        evt.deliveryStatus = evt.pushStatus === 'failed' ? 'partial' : 'sent';
        evt.failedCount = Math.max(0, (evt.failedCount || 1) - 1);
      }
    }
  }

  persistStore();
  return { retried, recovered };
}

export function startBackgroundScheduler(): void {
  if (schedulerTimer) return;
  const intervalMs = Math.max(1, store.settings.monitoringInterval) * 60 * 1000;

  // Initial check shortly after startup (without blocking server bind)
  setTimeout(() => {
    runScheduledHeatMonitor('scheduler').catch((e) =>
      console.warn('Initial scheduled monitor tick error:', e)
    );
  }, 4000);

  schedulerTimer = setInterval(() => {
    runScheduledHeatMonitor('scheduler').catch((e) =>
      console.warn('Periodic 15-min monitor tick error:', e)
    );
  }, intervalMs);

  const next = new Date(Date.now() + intervalMs).toISOString();
  store.scheduler.nextRunAt = next;
  persistStore();
}

export function restartScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  startBackgroundScheduler();
}

export function getGatewayDiagnostics() {
  return {
    sms: getSmsGatewayConfigStatus(),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    fcmConfigured: Boolean(process.env.FCM_SERVER_KEY?.trim()),
  };
}

export function normalizeDemoPhoneNumber(rawPhone: string): string | null {
  const cleaned = rawPhone.replace(/[\s\-()]/g, '').trim();
  if (/^\+[1-9]\d{8,14}$/.test(cleaned)) {
    return cleaned;
  }
  if (/^[6-9]\d{9}$/.test(cleaned)) {
    return `+91${cleaned}`;
  }
  return null;
}

export async function sendLiveDemoSms(params: {
  phone: string;
  locationId?: string;
  riskLevel?: 'high' | 'extreme';
}): Promise<{
  sentViaCarrier: boolean;
  provider: 'webhook' | 'relay-sandbox';
  status: 'sent' | 'failed' | 'not-configured';
  responseText: string;
  maskedPhone: string;
  messagePreview: string;
  record?: SmsDeliveryRecord;
}> {
  const normalizedPhone = normalizeDemoPhoneNumber(params.phone);
  if (!normalizedPhone) {
    throw new Error('Enter a valid mobile number with country code (e.g. +916374799286).');
  }

  const location =
    store.locations.find((l) => l.locationId === params.locationId) || store.locations[0];
  const locName = location?.name || 'Chennai - T. Nagar';
  const locId = location?.locationId || 't-nagar';
  const risk = params.riskLevel === 'high' ? 'high' : 'extreme';
  const sampleHi = risk === 'extreme' ? 43.2 : 38.4;

  const message =
    risk === 'extreme'
      ? `[HeatGuard LIVE DEMO] EXTREME HEAT ALERT (${locName}): Feels like ${sampleHi}C. Pause heavy outdoor work 12:00-16:00, move to shade, drink ORS/water every 20 min.`
      : `[HeatGuard LIVE DEMO] HIGH HEAT WARNING (${locName}): Feels like ${sampleHi}C. Take 15 min shade breaks hourly and hydrate regularly.`;

  const gateway = getSmsGatewayConfigStatus();
  const maskedPhone = maskPhoneNumber(normalizedPhone);

  if (!gateway.smsReady) {
    return {
      sentViaCarrier: false,
      provider: 'relay-sandbox',
      status: 'not-configured',
      responseText:
        'Custom SMS gateway is not configured yet. Set SMS_API_URL and SMS_API_KEY in server .env, or use the direct WhatsApp / SMS fallback buttons below.',
      maskedPhone,
      messagePreview: message,
    };
  }

  const eventId = `live-demo-sms-${Date.now()}`;
  const record = await dispatchSmsWithRetry({
    eventId,
    recipientId: 'admin-live-demo',
    recipientName: 'Admin Live SMS Demo',
    phone: normalizedPhone,
    locationId: locId,
    message,
    maxRetries: 1,
    simulationMode: false,
  });

  store.smsDeliveries.unshift(record);
  if (store.smsDeliveries.length > 200) {
    store.smsDeliveries = store.smsDeliveries.slice(0, 200);
  }
  persistStore();

  const lastAttempt = record.attempts[record.attempts.length - 1];
  return {
    sentViaCarrier: record.status === 'sent',
    provider: 'webhook',
    status: record.status === 'sent' ? 'sent' : 'failed',
    responseText:
      lastAttempt?.providerResponse ||
      (record.status === 'sent' ? 'Delivered via SMS Gateway' : 'SMS Gateway rejected message'),
    maskedPhone,
    messagePreview: message,
    record,
  };
}

