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

  if (msg.type === 'SCHEDULE_TEST_NOTIFICATION') {
    const rawDelay = Number(msg.delaySec);
    const delayMs = Number.isFinite(rawDelay) ? Math.max(0, Math.min(25, rawDelay)) * 1000 : 5000;
    const payload = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
    event.waitUntil(
      new Promise((resolve) => {
        setTimeout(() => {
          dispatchSystemNotification(payload).catch(() => {}).finally(resolve);
        }, delayMs);
      })
    );
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

self.addEventListener('push', (event) => {
  let payload = {
    title: 'Малыш+',
    body: 'Новое напоминание по режиму малыша',
    key: 'alert',
    tag: 'malysh-push-alert',
    tab: 'journal',
    url: './'
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        payload = {
          ...payload,
          ...parsed
        };
      }
    } catch (_) {
      try {
        const txt = event.data.text();
        if (txt) payload.body = txt;
      } catch (_) {}
    }
  }

  if (payload.key) {
    clearScheduledEntry(String(payload.key));
  }

  event.waitUntil(dispatchSystemNotification(payload).catch(() => {}));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const oldOpts = event.oldSubscription && event.oldSubscription.options;
      if (oldOpts && oldOpts.applicationServerKey && self.registration && self.registration.pushManager) {
        const newSub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: oldOpts.applicationServerKey
        });
        await fetch('./api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: newSub.toJSON ? newSub.toJSON() : newSub })
        }).catch(() => {});
      }
    } catch (_) {}
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = (event.notification && event.notification.data) || {};
  const targetTab = typeof notifData.tab === 'string' && notifData.tab ? notifData.tab : 'journal';
  const targetKey = typeof notifData.key === 'string' ? notifData.key : '';

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
      const candidate = new URL(typeof notifData.url === 'string' ? notifData.url : './', self.registration.scope);
      const safeUrl = candidate.origin === self.location.origin ? candidate.href : self.registration.scope;
      await self.clients.openWindow(safeUrl);
    }
  })());
});

