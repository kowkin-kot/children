// Service Worker для «Малыш+»: системные уведомления на Android / iOS PWA / ПК и фоновые напоминания

const DEFAULT_ICON_URL = 'https://kowkin-kot.github.io/children/app_icon.png';
const scheduledTimers = new Map();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function buildNotificationOptions(payload = {}) {
  const key = typeof payload.key === 'string' ? payload.key : 'alert';
  const tag = typeof payload.tag === 'string' && payload.tag ? payload.tag : `malysh-${key}`;
  return {
    body: typeof payload.body === 'string' ? payload.body : '',
    tag,
    renotify: true,
    requireInteraction: Boolean(payload.requireInteraction),
    icon: payload.icon || DEFAULT_ICON_URL,
    badge: payload.badge || DEFAULT_ICON_URL,
    vibrate: [160, 80, 160],
    data: {
      key,
      tab: payload.tab || 'journal',
      url: payload.url || './'
    }
  };
}

async function dispatchSystemNotification(payload = {}) {
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Малыш+';
  const options = buildNotificationOptions(payload);
  await self.registration.showNotification(title, options);
}

function clearScheduledEntry(key) {
  const existing = scheduledTimers.get(key);
  if (existing && existing.timerId) {
    clearTimeout(existing.timerId);
  }
  scheduledTimers.delete(key);
}

function clearAllScheduled() {
  for (const key of Array.from(scheduledTimers.keys())) {
    clearScheduledEntry(key);
  }
}

async function syncScheduledItems(items) {
  clearAllScheduled();
  if (!Array.isArray(items) || items.length === 0) return;

  const now = Date.now();
  const supportsTriggers =
    typeof self.TimestampTrigger === 'function' &&
    typeof Notification !== 'undefined' &&
    Notification.prototype &&
    'showTrigger' in Notification.prototype;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key || item.tag || '');
    const triggerAt = Number(item.triggerAt);
    if (!key || !Number.isFinite(triggerAt)) continue;

    const delayMs = triggerAt - now;
    if (delayMs <= 0 || delayMs > 86400000) continue;

    if (supportsTriggers) {
      try {
        const opts = buildNotificationOptions(item);
        opts.showTrigger = new self.TimestampTrigger(triggerAt);
        await self.registration.showNotification(item.title || 'Малыш+', opts);
        continue;
      } catch (_) {
        // Fallback to in-worker timer if trigger scheduling is unavailable
      }
    }

    const timerId = setTimeout(() => {
      scheduledTimers.delete(key);
      dispatchSystemNotification(item).catch(() => {});
    }, delayMs);

    scheduledTimers.set(key, { timerId, triggerAt, item });
  }
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (msg.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(dispatchSystemNotification(msg.payload || msg).catch(() => {}));
    return;
  }

  if (msg.type === 'SCHEDULE_NOTIFICATIONS') {
    event.waitUntil(syncScheduledItems(msg.items || []).catch(() => {}));
    return;
  }

  if (msg.type === 'CLEAR_SCHEDULED') {
    if (msg.key) {
      clearScheduledEntry(String(msg.key));
    } else {
      clearAllScheduled();
    }
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = (event.notification && event.notification.data) || {};
  const targetTab = notifData.tab || 'journal';
  const targetKey = notifData.key || '';

  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of windowClients) {
      if ('focus' in client) {
        await client.focus();
      }
      client.postMessage({
        type: 'NOTIF_CLICK',
        tab: targetTab,
        key: targetKey
      });
      return;
    }

    if (self.clients.openWindow) {
      const url = new URL(notifData.url || './', self.registration.scope).href;
      await self.clients.openWindow(url);
    }
  })());
});
