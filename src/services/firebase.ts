import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  setDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  runTransaction,
  serverTimestamp,
  onSnapshot,
  Unsubscribe,
} from 'firebase/firestore';
import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  AlertHistoryEvent,
  AlertStateRecord,
  DeviceTokenRecord,
  MonitoredLocation,
  NotificationSettings,
  RecipientSubscription,
} from '../types';

export const BOOTSTRAPPED_ADMIN_EMAIL = 'varunsaiprabhu14@gmail.com';

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration (client offline).');
    }
    return false;
  }
}

// Run startup connectivity probe
if (typeof window !== 'undefined') {
  testConnection();
}

export function subscribeAuth(callback: (user: User | null) => void): Unsubscribe {
  return onAuthStateChanged(auth, callback);
}

export async function signInWithGoogle(): Promise<User> {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

export async function signOutFirebase(): Promise<void> {
  await signOut(auth);
}

export async function checkIsAdmin(user: User | null): Promise<boolean> {
  if (!user || !user.emailVerified) return false;
  if (user.email?.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase()) {
    return true;
  }
  try {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    return snap.exists();
  } catch (err) {
    return false;
  }
}

export async function getAuthBearerToken(): Promise<string | null> {
  if (!auth.currentUser) return null;
  try {
    return await auth.currentUser.getIdToken();
  } catch {
    return null;
  }
}

function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
  return cleaned || `id-${Date.now()}`;
}

function clampStr(val: string | undefined, max: number): string {
  return (val || '').trim().slice(0, max);
}

// ==========================================
// FIRESTORE SYNC & ATOMIC TRANSACTION HELPERS
// ==========================================

export async function saveSettingsToFirestore(
  settings: NotificationSettings,
  updatedByEmail: string
): Promise<void> {
  const path = 'notificationSettings/global';
  try {
    await setDoc(doc(db, 'notificationSettings', 'global'), {
      monitoringInterval: Math.max(1, Math.min(120, Number(settings.monitoringInterval) || 15)),
      cooldownMinutes: Math.max(0, Math.min(1440, Number(settings.cooldownMinutes) || 30)),
      reminderIntervalMinutes: Math.max(
        0,
        Math.min(1440, Number(settings.reminderIntervalMinutes) || 60)
      ),
      smsEnabled: Boolean(settings.smsEnabled),
      pushEnabled: Boolean(settings.pushEnabled),
      escalationEnabled: Boolean(settings.escalationEnabled),
      notifyOnModerate: Boolean(settings.notifyOnModerate),
      notifyOnDeescalation: Boolean(settings.notifyOnDeescalation),
      moderateThreshold: Number(settings.moderateThreshold) || 32,
      highThreshold: Number(settings.highThreshold) || 36,
      extremeThreshold: Number(settings.extremeThreshold) || 41,
      maxRetries: Math.max(0, Math.min(5, Number(settings.maxRetries) || 3)),
      updatedBy: clampStr(updatedByEmail, 128),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function saveMonitoredLocationToFirestore(loc: MonitoredLocation): Promise<void> {
  const locId = sanitizeId(loc.locationId);
  const path = `monitoredLocations/${locId}`;
  try {
    const ref = doc(db, 'monitoredLocations', locId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await setDoc(
        ref,
        {
          locationId: locId,
          name: clampStr(loc.name, 100),
          name_ta: clampStr(loc.name_ta || loc.name, 120),
          region: clampStr(loc.region || 'Tamil Nadu', 80),
          ward_no: Number(loc.ward_no || 0),
          lat: Number(loc.lat),
          lng: Number(loc.lng),
          enabled: Boolean(loc.enabled),
          createdAt: snap.data().createdAt || serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: false }
      );
    } else {
      await setDoc(ref, {
        locationId: locId,
        name: clampStr(loc.name, 100),
        name_ta: clampStr(loc.name_ta || loc.name, 120),
        region: clampStr(loc.region || 'Tamil Nadu', 80),
        ward_no: Number(loc.ward_no || 0),
        lat: Number(loc.lat),
        lng: Number(loc.lng),
        enabled: Boolean(loc.enabled),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function fetchEnabledMonitoredLocationsFromFirestore(): Promise<MonitoredLocation[]> {
  const path = 'monitoredLocations';
  try {
    const q = query(collection(db, path), where('enabled', '==', true), limit(40));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({
      ...(d.data() as MonitoredLocation),
      locationId: d.id,
    }));
  } catch (error) {
    console.warn(`Firestore ${path} lookup fallback:`, error);
    return [];
  }
}

/**
 * Atomically transitions alertState/{locationId} using Firestore runTransaction
 * and writes a corresponding alertHistory/{eventId} record if risk truly changed.
 * Prevents duplicate concurrent escalation processing.
 */
export async function commitAlertTransitionTransaction(
  state: AlertStateRecord,
  event: AlertHistoryEvent | null
): Promise<{ committed: boolean; skippedDuplicate: boolean }> {
  const locId = sanitizeId(state.locationId);
  const statePath = `alertState/${locId}`;

  try {
    return await runTransaction(db, async (tx) => {
      const stateRef = doc(db, 'alertState', locId);
      const snap = await tx.get(stateRef);
      const existingData = snap.exists() ? snap.data() : null;

      if (
        existingData &&
        event &&
        !event.simulationMode &&
        existingData.currentRisk === state.currentRisk &&
        event.direction !== 'reminder'
      ) {
        return { committed: false, skippedDuplicate: true };
      }

      tx.set(stateRef, {
        locationId: locId,
        locationName: clampStr(state.locationName, 100),
        currentRisk: state.currentRisk,
        previousRisk: state.previousRisk,
        currentHeatIndex: Number(state.currentHeatIndex),
        currentTemp: Number(state.currentTemp),
        currentHumidity: Number(state.currentHumidity),
        trend: state.trend,
        lastEscalationTime: clampStr(state.lastEscalationTime || '', 64),
        lastNotificationTime: clampStr(state.lastNotificationTime || '', 64),
        activeAlert: Boolean(state.activeAlert),
        aiSummary: clampStr(state.aiSummary || '', 1000),
        updatedAt: serverTimestamp(),
      });

      if (event) {
        const evtId = sanitizeId(event.id);
        const evtRef = doc(db, 'alertHistory', evtId);
        tx.set(evtRef, {
          locationId: locId,
          locationName: clampStr(event.locationName, 100),
          previousRisk: event.previousRisk,
          currentRisk: event.currentRisk,
          direction: event.direction,
          timestamp: clampStr(event.timestamp, 64),
          notificationChannels: (event.notificationChannels || ['dashboard']).slice(0, 4),
          recipientCount: Number(event.recipientCount || 0),
          deliveryStatus: event.deliveryStatus,
          pushStatus: event.pushStatus,
          smsStatus: event.smsStatus,
          simulationMode: Boolean(event.simulationMode),
          heatIndex: Number(event.heatIndex),
          safetyInstructions: clampStr(event.safetyInstructions || '', 1200),
          createdAt: serverTimestamp(),
        });
      }

      return { committed: true, skippedDuplicate: false };
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, statePath);
  }
}

export async function saveRecipientToFirestore(
  recipient: RecipientSubscription
): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Must be signed in to manage subscriptions');

  const recId = sanitizeId(recipient.id);
  const path = `recipients/${recId}`;
  try {
    const ref = doc(db, 'recipients', recId);
    const snap = await getDoc(ref);
    const existing = snap.exists() ? snap.data() : null;

    await setDoc(ref, {
      ownerUid: existing?.ownerUid || sanitizeId(recipient.ownerUid || uid),
      name: clampStr(recipient.name, 100),
      phone: clampStr(recipient.phone, 24),
      locationIds: (recipient.locationIds || []).slice(0, 25).map((id) => sanitizeId(id)),
      pushEnabled: Boolean(recipient.pushEnabled),
      smsEnabled: Boolean(recipient.smsEnabled),
      consentGranted: Boolean(recipient.consentGranted),
      consentTimestamp: clampStr(
        recipient.consentTimestamp || new Date().toISOString(),
        64
      ),
      active: Boolean(recipient.active),
      minRiskLevel: recipient.minRiskLevel || 'high',
      createdAt: existing?.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteRecipientFromFirestore(recipientId: string): Promise<void> {
  const recId = sanitizeId(recipientId);
  const path = `recipients/${recId}`;
  try {
    await deleteDoc(doc(db, 'recipients', recId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function fetchUserRecipientsFromFirestore(): Promise<RecipientSubscription[]> {
  const uid = auth.currentUser?.uid;
  if (!uid) return [];
  const path = 'recipients';
  try {
    const q = query(collection(db, 'recipients'), where('ownerUid', '==', uid), limit(25));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<RecipientSubscription, 'id'>),
    }));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export function subscribeAlertHistoryFirestore(
  callback: (events: AlertHistoryEvent[]) => void
): Unsubscribe {
  const path = 'alertHistory';
  const q = query(
    collection(db, 'alertHistory'),
    where('currentRisk', 'in', ['low', 'moderate', 'high', 'extreme']),
    orderBy('createdAt', 'desc'),
    limit(50)
  );
  return onSnapshot(
    q,
    (snap) => {
      const items = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<AlertHistoryEvent, 'id'>),
      }));
      callback(items);
    },
    (error) => {
      // Quietly log read errors if index/initial empty
      console.warn('AlertHistory snapshot listener notice:', error.message, path);
    }
  );
}

// ==========================================
// FIREBASE CLOUD MESSAGING (FCM) BROWSER PUSH
// ==========================================

export async function registerFcmDeviceToken(
  locationIds: string[],
  enabled: boolean
): Promise<{ fcmToken: string; method: 'fcm' | 'browser-push' }> {
  if (typeof Notification === 'undefined') {
    throw new Error('Browser notifications are not supported on this device.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission denied by browser.');
  }

  let tokenStr = `webpush-${sanitizeId(auth.currentUser?.uid || 'guest')}-${Date.now()}`;
  let method: 'fcm' | 'browser-push' = 'browser-push';

  try {
    const supported = await isSupported();
    if (supported && 'serviceWorker' in navigator) {
      const swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      const messaging = getMessaging(app);
      const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined;
      if (vapidKey) {
        const realToken = await getToken(messaging, {
          vapidKey,
          serviceWorkerRegistration: swReg,
        });
        if (realToken) {
          tokenStr = realToken;
          method = 'fcm';
        }
      }
    }
  } catch (err) {
    console.warn('FCM VAPID registration unavailable, falling back to native browser push token:', err);
  }

  // Save to backend device registry
  const bearer = await getAuthBearerToken();
  await fetch('/api/escalation/device-tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({
      userId: auth.currentUser?.uid || 'worker-browser',
      locationIds,
      fcmToken: tokenStr,
      notificationEnabled: enabled,
    }),
  });

  // Also save directly to Firestore when signed in with verified user
  if (auth.currentUser?.uid && auth.currentUser.emailVerified) {
    const tokenId = sanitizeId(`tok-${auth.currentUser.uid}`);
    const path = `deviceTokens/${tokenId}`;
    try {
      const payload: Omit<DeviceTokenRecord, 'id'> = {
        userId: sanitizeId(auth.currentUser.uid),
        locationIds: locationIds.slice(0, 25).map((id) => sanitizeId(id)),
        fcmToken: clampStr(tokenStr, 512),
        notificationEnabled: Boolean(enabled),
      };
      await setDoc(doc(db, 'deviceTokens', tokenId), {
        ...payload,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  }

  return { fcmToken: tokenStr, method };
}

export async function listenForegroundFcmMessages(
  onReceive: (payload: { title: string; body: string; data?: Record<string, string> }) => void
): Promise<() => void> {
  try {
    const supported = await isSupported();
    if (!supported) return () => {};
    const messaging = getMessaging(app);
    return onMessage(messaging, (payload) => {
      onReceive({
        title: payload.notification?.title || 'HeatGuard Alert',
        body: payload.notification?.body || '',
        data: (payload.data as Record<string, string>) || {},
      });
    });
  } catch {
    return () => {};
  }
}
