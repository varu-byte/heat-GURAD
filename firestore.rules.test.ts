/**
 * Firestore Security Rules Test Cases (Dirty Dozen Verification Specification)
 * Designed for verification against Firebase Rules Emulator or automated rule audit.
 */
export const DIRTY_DOZEN_PAYLOADS = [
  {
    name: '1. Unauthenticated write to notificationSettings/global',
    auth: null,
    path: 'notificationSettings/global',
    op: 'update',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '2. Non-admin verified user modifying notificationSettings/global',
    auth: { uid: 'worker-1', email: 'worker@example.com', email_verified: true },
    path: 'notificationSettings/global',
    op: 'update',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '3. Email spoofing with email_verified=false on monitoredLocations',
    auth: { uid: 'spoof-1', email: 'varunsaiprabhu14@gmail.com', email_verified: false },
    path: 'monitoredLocations/chennai',
    op: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '4. Shadow field injection (isAdmin: true) on recipients',
    auth: { uid: 'worker-1', email: 'worker@example.com', email_verified: true },
    path: 'recipients/rec-1',
    payload: { ownerUid: 'worker-1', name: 'Test', phone: '+919999999999', isAdmin: true },
    op: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '5. Self-privilege escalation writing /admins/{uid}',
    auth: { uid: 'worker-1', email: 'worker@example.com', email_verified: true },
    path: 'admins/worker-1',
    op: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '6. Cross-user PII read on recipients',
    auth: { uid: 'worker-2', email: 'other@example.com', email_verified: true },
    path: 'recipients/rec-owned-by-worker-1',
    op: 'get',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '7. Unbounded array poisoning (26+ locationIds) on deviceTokens',
    auth: { uid: 'worker-1', email: 'worker@example.com', email_verified: true },
    path: 'deviceTokens/tok-1',
    op: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '8. Type poisoning (monitoringInterval string) on notificationSettings',
    auth: { uid: 'admin-1', email: 'varunsaiprabhu14@gmail.com', email_verified: true },
    path: 'notificationSettings/global',
    op: 'update',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '9. Client timestamp forgery on recipients',
    auth: { uid: 'worker-1', email: 'worker@example.com', email_verified: true },
    path: 'recipients/rec-2',
    op: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '10. Invalid document ID poisoning',
    auth: { uid: 'admin-1', email: 'varunsaiprabhu14@gmail.com', email_verified: true },
    path: 'monitoredLocations/bad$id/..',
    op: 'create',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '11. Ownership hijacking modifying ownerUid on recipients',
    auth: { uid: 'worker-1', email: 'worker@example.com', email_verified: true },
    path: 'recipients/rec-1',
    op: 'update',
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '12. Cross-user deviceToken hijacking',
    auth: { uid: 'worker-1', email: 'worker@example.com', email_verified: true },
    path: 'deviceTokens/tok-2',
    op: 'create',
    expected: 'PERMISSION_DENIED',
  },
];
