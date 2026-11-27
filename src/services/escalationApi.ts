import {
  AlertHistoryEvent,
  AlertStateRecord,
  EscalationDashboardStats,
  MonitoredLocation,
  NotificationSettings,
  RecipientSubscription,
  RiskLevel,
  SmsDeliveryRecord,
} from '../types';
import { getAuthBearerToken } from './firebase';

export interface EscalationOverviewResponse {
  stats: EscalationDashboardStats;
  settings: NotificationSettings;
  locations: MonitoredLocation[];
  states: AlertStateRecord[];
  history: AlertHistoryEvent[];
  smsDeliveries: SmsDeliveryRecord[];
  recipientsMasked: RecipientSubscription[];
  diagnostics: {
    sms: {
      configuredProvider: 'webhook' | 'relay-sandbox';
      smsReady?: boolean;
    };
    geminiConfigured: boolean;
    fcmConfigured: boolean;
  };
}

export interface TargetingPreviewResponse {
  locationId: string;
  risk: RiskLevel;
  smsCount: number;
  pushCount: number;
  deviceTokenCount: number;
  smsRecipients: Array<{
    id: string;
    name: string;
    locationIds: string[];
    minRiskLevel: string;
  }>;
  pushRecipients: Array<{
    id: string;
    name: string;
    locationIds: string[];
    minRiskLevel: string;
  }>;
}

export interface SimulationOutcome {
  state: AlertStateRecord;
  event: AlertHistoryEvent | null;
  suppressedReason?: string;
}

export interface AiBriefResponse {
  aiAvailable: boolean;
  riskRationale: string;
  safetyInstructions: string;
  precautions: string[];
}

async function requestJson<T>(
  url: string,
  options: RequestInit = {},
  withAuth = false
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...((options.headers as Record<string, string>) || {}),
  };

  if (withAuth) {
    const token = await getAuthBearerToken();
    if (!token) {
      throw new Error('Admin or verified user sign-in required for this action.');
    }
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, { ...options, headers });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  }

  return data as T;
}

export async function fetchEscalationOverview(): Promise<EscalationOverviewResponse> {
  return requestJson<EscalationOverviewResponse>('/api/escalation/overview');
}

export async function fetchAdminRecipients(): Promise<RecipientSubscription[]> {
  return requestJson<RecipientSubscription[]>('/api/escalation/recipients', {}, true);
}

export async function saveAdminRecipient(
  payload: Partial<RecipientSubscription>
): Promise<RecipientSubscription> {
  return requestJson<RecipientSubscription>(
    '/api/escalation/recipients',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    true
  );
}

export async function deleteAdminRecipient(id: string): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(
    `/api/escalation/recipients/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    true
  );
}

export async function submitWorkerSubscription(payload: {
  name: string;
  phone: string;
  locationIds: string[];
  pushEnabled: boolean;
  smsEnabled: boolean;
  consentGranted: boolean;
  active: boolean;
  minRiskLevel: 'moderate' | 'high' | 'extreme';
}): Promise<RecipientSubscription> {
  return requestJson<RecipientSubscription>(
    '/api/escalation/subscribe',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    true
  );
}

export async function saveEscalationSettings(
  patch: Partial<NotificationSettings>
): Promise<NotificationSettings> {
  return requestJson<NotificationSettings>(
    '/api/escalation/settings',
    {
      method: 'POST',
      body: JSON.stringify(patch),
    },
    true
  );
}

export async function saveMonitoredLocation(
  loc: MonitoredLocation
): Promise<MonitoredLocation> {
  return requestJson<MonitoredLocation>(
    '/api/escalation/locations',
    {
      method: 'POST',
      body: JSON.stringify(loc),
    },
    true
  );
}

export async function deleteMonitoredLocation(
  locationId: string
): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(
    `/api/escalation/locations/${encodeURIComponent(locationId)}`,
    { method: 'DELETE' },
    true
  );
}

export async function fetchTargetingPreview(
  locationId: string,
  risk: RiskLevel
): Promise<TargetingPreviewResponse> {
  const params = new URLSearchParams({ locationId, risk });
  return requestJson<TargetingPreviewResponse>(
    `/api/escalation/targeting-preview?${params.toString()}`
  );
}

export async function runMonitoringSweepNow(): Promise<{
  evaluatedCount: number;
  eventsTriggered: AlertHistoryEvent[];
  states: AlertStateRecord[];
  stats: EscalationDashboardStats;
  history: AlertHistoryEvent[];
}> {
  return requestJson('/api/escalation/run-now', { method: 'POST' }, true);
}

export async function simulateHeatStep(payload: {
  locationId: string;
  airTemp: number;
  humidity: number;
  forcePreviousRisk?: RiskLevel;
  simulateSmsFailure?: boolean;
  simulatePushFailure?: boolean;
  forceChannels?: { push?: boolean; sms?: boolean };
}): Promise<SimulationOutcome> {
  return requestJson<SimulationOutcome>(
    '/api/escalation/simulate',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    true
  );
}

export async function retryFailedNotifications(): Promise<{
  retried: number;
  recovered: number;
  stats: EscalationDashboardStats;
  smsDeliveries: SmsDeliveryRecord[];
  history: AlertHistoryEvent[];
}> {
  return requestJson('/api/escalation/retry-failed', { method: 'POST' }, true);
}

export async function fetchAiSituationBrief(
  locationId: string
): Promise<AiBriefResponse> {
  return requestJson<AiBriefResponse>(
    '/api/escalation/ai-brief',
    {
      method: 'POST',
      body: JSON.stringify({ locationId }),
    },
    true
  );
}

export interface LiveDemoSmsResponse {
  sentViaCarrier: boolean;
  provider: 'webhook' | 'relay-sandbox';
  status: 'sent' | 'failed' | 'not-configured';
  responseText: string;
  maskedPhone: string;
  messagePreview: string;
}

export async function sendLiveDemoSms(payload: {
  phone: string;
  locationId: string;
  riskLevel: 'high' | 'extreme';
  consentConfirmed: boolean;
}): Promise<LiveDemoSmsResponse> {
  return requestJson<LiveDemoSmsResponse>(
    '/api/escalation/send-demo-sms',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    true
  );
}

