# HeatGuard Security Specification

## 1. Data Invariants
1. Only verified administrators (`email_verified == true` matching the bootstrapped admin or registered in `/admins/{uid}`) may modify `/notificationSettings`, `/monitoredLocations`, `/alertState`, or `/alertHistory`.
2. `/recipients` contains PII (`phone`, `name`). Non-admins may only read, create, update, or list recipient documents whose `ownerUid` strictly equals `request.auth.uid`.
3. `/deviceTokens` contains user FCM tokens. Non-admins may only read, create, update, delete, or list documents whose `userId` strictly equals `request.auth.uid`.
4. All client mutations enforce strict schema allowlisting (`hasAll` + `hasOnly`), string `.size()` limits, bounded array sizes (`<= 25`), valid ID patterns (`^[a-zA-Z0-9_\-]+$`), and server-verified timestamps (`request.time`).
5. `/alertHistory` events are immutable audit records for non-admins; only verified admins can log or update retry statuses.

## 2. The "Dirty Dozen" Adversarial Payloads
1. Unauthenticated write to `/notificationSettings/global` -> `PERMISSION_DENIED`
2. Non-admin verified user modifying `/notificationSettings/global` thresholds -> `PERMISSION_DENIED`
3. Unverified email spoofing admin email on `/monitoredLocations/t-nagar` (`email_verified: false`) -> `PERMISSION_DENIED`
4. Shadow field injection (`isAdmin: true`, `ghostField: 1`) on `/recipients/{id}` -> `PERMISSION_DENIED`
5. Self-privilege escalation writing `/admins/{uid}` as non-admin -> `PERMISSION_DENIED`
6. Cross-user PII read (`get` or `list` on `/recipients` without matching `ownerUid`) -> `PERMISSION_DENIED`
7. Unbounded array poisoning (`locationIds` with 26+ items) on `/deviceTokens/{id}` -> `PERMISSION_DENIED`
8. Type poisoning (`monitoringInterval: "15"` string instead of number) on `/notificationSettings/global` -> `PERMISSION_DENIED`
9. Client timestamp forgery (`updatedAt` != `request.time`) on `/recipients/{id}` -> `PERMISSION_DENIED`
10. Document ID poisoning (`1.5KB` or invalid chars in `{locationId}`) -> `PERMISSION_DENIED`
11. Ownership hijacking (`update` changing `ownerUid` on `/recipients/{id}`) -> `PERMISSION_DENIED`
12. Cross-user token hijacking (`create` `/deviceTokens/{id}` with someone else's `userId`) -> `PERMISSION_DENIED`
