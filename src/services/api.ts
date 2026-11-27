import { ZoneDetail, ReliefPoint, HeatAlert } from '../types';
import staticReliefPoints from '../../data/relief-points.json';

const STORAGE_KEY_ZONES = 'chennai_heat_guard_zones';
const STORAGE_KEY_BREAKS = 'chennai_heat_guard_breaks';
const STORAGE_KEY_ALERTS = 'chennai_heat_guard_alerts';

async function parseJsonResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Unexpected response content-type: ${contentType || 'unknown'}`);
  }
  return (await res.json()) as T;
}

export async function fetchAllZones(): Promise<ZoneDetail[]> {
  try {
    const res = await fetch('/api/zones', { headers: { Accept: 'application/json' } });
    const data = await parseJsonResponse<ZoneDetail[]>(res);
    try {
      localStorage.setItem(STORAGE_KEY_ZONES, JSON.stringify(data));
    } catch (e) {
      // quota or private mode
    }
    return data;
  } catch (err) {
    console.warn('Network fetch failed for zones, checking offline cache:', err);
    try {
      const cached = localStorage.getItem(STORAGE_KEY_ZONES);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {}
    throw err;
  }
}

export async function fetchZoneDetail(zoneId: string): Promise<ZoneDetail> {
  try {
    const res = await fetch(`/api/zones/${zoneId}`, { headers: { Accept: 'application/json' } });
    return await parseJsonResponse<ZoneDetail>(res);
  } catch (err) {
    console.warn(`Network fetch failed for zone ${zoneId}, falling back to all zones cache:`, err);
    try {
      const cached = localStorage.getItem(STORAGE_KEY_ZONES);
      if (cached) {
        const list: ZoneDetail[] = JSON.parse(cached);
        const found = list.find((z) => z.id === zoneId);
        if (found) return found;
      }
    } catch (e) {}
    throw err;
  }
}

export async function fetchReliefPoints(zoneId?: string, type?: string): Promise<ReliefPoint[]> {
  let list = staticReliefPoints as ReliefPoint[];
  try {
    const params = new URLSearchParams();
    if (zoneId) params.append('zone_id', zoneId);
    if (type) params.append('type', type);
    const res = await fetch(`/api/relief-points?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    return await parseJsonResponse<ReliefPoint[]>(res);
  } catch (err) {
    console.warn('Network fetch failed for relief points, using static relief-points.json:', err);
    if (zoneId) list = list.filter((r) => r.zone_id === zoneId);
    if (type) list = list.filter((r) => r.type === type);
    return list;
  }
}

export async function recordBreakLog(data: {
  zone_id: string;
  zone_name: string;
  worker_id?: string;
  duration_mins?: number;
  note?: string;
}) {
  const res = await fetch('/api/breaks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(data),
  });
  return parseJsonResponse(res);
}

export async function fetchBreaks(): Promise<{ total_today: number; recent_logs: any[] }> {
  try {
    const res = await fetch('/api/breaks', { headers: { Accept: 'application/json' } });
    const data = await parseJsonResponse<{ total_today: number; recent_logs: any[] }>(res);
    try {
      localStorage.setItem(STORAGE_KEY_BREAKS, JSON.stringify(data));
    } catch (e) {}
    return data;
  } catch (err) {
    console.warn('Network fetch failed for breaks, using cached breaks:', err);
    try {
      const cached = localStorage.getItem(STORAGE_KEY_BREAKS);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {}
    return { total_today: 0, recent_logs: [] };
  }
}

export async function fetchAlerts(): Promise<HeatAlert[]> {
  try {
    const res = await fetch('/api/alerts', { headers: { Accept: 'application/json' } });
    const data = await parseJsonResponse<HeatAlert[]>(res);
    try {
      localStorage.setItem(STORAGE_KEY_ALERTS, JSON.stringify(data));
    } catch (e) {}
    return data;
  } catch (err) {
    try {
      const cached = localStorage.getItem(STORAGE_KEY_ALERTS);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {}
    return [];
  }
}
