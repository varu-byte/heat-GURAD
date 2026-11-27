import { SmsDeliveryAttempt, SmsDeliveryRecord } from '../src/types';

export function maskPhoneNumber(phone: string): string {
  const cleaned = phone.trim();
  if (cleaned.length <= 4) return '****';
  return `${cleaned.slice(0, 3)}****${cleaned.slice(-4)}`;
}

function isAllowedSmsGatewayUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.startsWith('169.254.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function sendViaSmsGateway(
  toPhone: string,
  body: string,
  simulateFailure?: boolean
): Promise<{ ok: boolean; responseText: string }> {
  if (simulateFailure) {
    return { ok: false, responseText: 'Simulated SMS gateway timeout / carrier 503 failure' };
  }

  const smsApiUrl = process.env.SMS_API_URL?.trim();
  const smsApiKey = process.env.SMS_API_KEY?.trim();

  if (smsApiUrl && smsApiKey) {
    if (!isAllowedSmsGatewayUrl(smsApiUrl)) {
      return { ok: false, responseText: 'Blocked SMS_API_URL by SSRF policy' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(smsApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${smsApiKey}`,
        },
        body: JSON.stringify({ to: toPhone, message: body }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const snippet = (await res.text().catch(() => '')).trim().slice(0, 140);
      return {
        ok: res.ok,
        responseText: res.ok
          ? `SMS Gateway HTTP ${res.status}`
          : `SMS Gateway HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`,
      };
    } catch (err: any) {
      clearTimeout(timer);
      return { ok: false, responseText: err?.message || 'SMS gateway network failure' };
    }
  }

  // Clean local fallback when custom HTTP SMS gateway env vars are not configured
  return {
    ok: true,
    responseText: 'Local Fallback Queued (set SMS_API_URL and SMS_API_KEY in server .env for live SMS gateway delivery)',
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function dispatchSmsWithRetry(params: {
  eventId: string;
  recipientId: string;
  recipientName: string;
  phone: string;
  locationId: string;
  message: string;
  maxRetries: number;
  simulationMode: boolean;
  simulateFailure?: boolean;
}): Promise<SmsDeliveryRecord> {
  const {
    eventId,
    recipientId,
    recipientName,
    phone,
    locationId,
    message,
    maxRetries,
    simulationMode,
    simulateFailure,
  } = params;

  const phoneMasked = maskPhoneNumber(phone);
  const id = `sms-${eventId}-${recipientId}`;
  const createdAt = new Date().toISOString();

  // STRICT RULE: Simulation mode NEVER sends real SMS messages
  if (simulationMode) {
    return {
      id,
      eventId,
      recipientId,
      recipientName,
      phoneMasked,
      locationId,
      status: simulateFailure ? 'failed' : 'simulated',
      attempts: [
        {
          attempt: 1,
          timestamp: createdAt,
          status: simulateFailure ? 'failed' : 'sent',
          providerResponse: simulateFailure
            ? 'SIMULATION MODE — simulated carrier delivery failure'
            : 'SIMULATION MODE — carrier API bypassed cleanly',
        },
      ],
      lastError: simulateFailure ? 'Simulated carrier delivery failure' : undefined,
      messagePreview: message.slice(0, 160),
      createdAt,
    };
  }

  const attempts: SmsDeliveryAttempt[] = [];
  const totalAllowed = Math.max(1, Math.min(4, maxRetries + 1));

  for (let attempt = 1; attempt <= totalAllowed; attempt++) {
    const outcome = await sendViaSmsGateway(phone, message, simulateFailure);
    attempts.push({
      attempt,
      timestamp: new Date().toISOString(),
      status: outcome.ok ? 'sent' : 'failed',
      providerResponse: outcome.responseText,
    });

    if (outcome.ok) {
      return {
        id,
        eventId,
        recipientId,
        recipientName,
        phoneMasked,
        locationId,
        status: 'sent',
        attempts,
        messagePreview: message.slice(0, 160),
        createdAt,
      };
    }

    if (attempt < totalAllowed) {
      await sleep(150 * attempt);
    }
  }

  return {
    id,
    eventId,
    recipientId,
    recipientName,
    phoneMasked,
    locationId,
    status: 'failed',
    attempts,
    lastError: attempts[attempts.length - 1]?.providerResponse || 'SMS delivery failed',
    messagePreview: message.slice(0, 160),
    createdAt,
  };
}

export function getSmsGatewayConfigStatus(): {
  configuredProvider: 'webhook' | 'relay-sandbox';
  smsReady: boolean;
} {
  const smsReady = Boolean(process.env.SMS_API_URL?.trim() && process.env.SMS_API_KEY?.trim());
  if (smsReady) {
    return { configuredProvider: 'webhook', smsReady: true };
  }
  return { configuredProvider: 'relay-sandbox', smsReady: false };
}
