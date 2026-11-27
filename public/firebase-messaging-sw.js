importScripts('https://www.gstatic.com/firebasejs/11.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.0.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCnFlCJ-E1-VsYvwP6Wgju1jWwalaDqH2g',
  authDomain: 'arcane-empire-h4cnq.firebaseapp.com',
  projectId: 'arcane-empire-h4cnq',
  storageBucket: 'arcane-empire-h4cnq.firebasestorage.app',
  messagingSenderId: '10174977370',
  appId: '1:10174977370:web:76862989e7bb91dc028f63',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || 'Chennai Heat Guard Alert';
  const body =
    payload?.notification?.body ||
    'Elevated heat index detected in your subscribed location. Move to shade and hydrate.';

  self.registration.showNotification(title, {
    body,
    icon: '/icon.svg',
    badge: '/pwa-192x192.png',
    tag: payload?.data?.locationId || 'heatguard-alert',
    data: payload?.data || {},
  });
});
