// PWA-манифест, генерация PNG-иконок, офлайн-кэш, индикатор сети и установка на экран «Домой»

import { APP_ICON_URL, APP_ICON_PNG_URL } from './config.js';
import { store, hooks } from './state.js';
import { openModal, showToast } from './utils.js';

let deferredInstallPrompt = null;
let pwaBannerDismissed = false;
let lastManifestBlobUrl = '';
let cachedPng512DataUrl = '';
let swRegistrationPromise = null;
let cachedSwRegistration = null;
const pageFallbackTimers = new Map();

export async function registerAppServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  if (cachedSwRegistration) return cachedSwRegistration;
  if (swRegistrationPromise) return swRegistrationPromise;

  swRegistrationPromise = (async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      cachedSwRegistration = reg;
      if (reg && typeof reg.update === 'function') {
        reg.update().catch(() => {});
      }
      return reg;
    } catch (err) {
      console.warn('Service Worker registration skipped:', err);
      swRegistrationPromise = null;
      return null;
    }
  })();

  return swRegistrationPromise;
}

export async function getActiveServiceWorkerRegistration(timeoutMs = 1800) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    const reg = await registerAppServiceWorker();
    if (reg && reg.active) return reg;

    const readyReg = await Promise.race([
      navigator.serviceWorker.ready.catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(reg || null), timeoutMs))
    ]);
    if (readyReg) {
      cachedSwRegistration = readyReg;
      return readyReg;
    }
    return reg || null;
  } catch (_) {
    return null;
  }
}

export async function showSystemNotification({
  title,
  body = '',
  tag = 'malysh-plus-alert',
  key = '',
  tab = 'journal',
  requireInteraction = false
} = {}) {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return { ok: false, reason: 'unsupported' };
  }
  if (Notification.permission !== 'granted') {
    return { ok: false, reason: Notification.permission };
  }

  const notifTitle = title || 'Малыш+';
  const options = {
    body,
    tag,
    renotify: true,
    requireInteraction: Boolean(requireInteraction),
    icon: APP_ICON_PNG_URL,
    badge: APP_ICON_PNG_URL,
    vibrate: [160, 80, 160],
    data: {
      key: key || tag,
      tab,
      url: './'
    }
  };

  try {
    const reg = await getActiveServiceWorkerRegistration();
    if (reg && typeof reg.showNotification === 'function') {
      await reg.showNotification(notifTitle, options);
      return { ok: true, via: 'sw' };
    }
  } catch (swErr) {
    console.warn('SW showNotification error:', swErr);
  }

  // Fallback for desktop browsers if Service Worker is unavailable (Android Chrome forbids new Notification)
  try {
    const n = new Notification(notifTitle, {
      body,
      tag,
      icon: APP_ICON_PNG_URL
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch (_) {}
      n.close();
    };
    return { ok: true, via: 'window' };
  } catch (winErr) {
    return { ok: false, reason: winErr?.message || 'blocked' };
  }
}

function clearPageFallbackTimers() {
  for (const timerId of pageFallbackTimers.values()) {
    clearTimeout(timerId);
  }
  pageFallbackTimers.clear();
}

export async function syncScheduledSystemNotifications(items = []) {
  clearPageFallbackTimers();
  const validItems = Array.isArray(items)
    ? items.filter(it => it && it.key && Number.isFinite(Number(it.triggerAt)) && Number(it.triggerAt) > Date.now())
    : [];

  if (typeof window === 'undefined' || !('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  let postedToSw = false;
  try {
    const reg = await getActiveServiceWorkerRegistration(1200);
    const worker = navigator.serviceWorker?.controller || reg?.active;
    if (worker && typeof worker.postMessage === 'function') {
      worker.postMessage({
        type: 'SCHEDULE_NOTIFICATIONS',
        items: validItems
      });
      postedToSw = true;
    }
  } catch (_) {}

  // In-page timer backup (triggers while tab is open even if SW worker goes idle or before SW controls initial page)
  if (!postedToSw) {
    const now = Date.now();
    for (const item of validItems) {
      const delayMs = Number(item.triggerAt) - now;
      if (delayMs > 0 && delayMs <= 86400000) {
        const id = setTimeout(() => {
          pageFallbackTimers.delete(item.key);
          showSystemNotification(item).catch(() => {});
        }, delayMs);
        pageFallbackTimers.set(item.key, id);
      }
    }
  }
}

export async function clearScheduledSystemNotifications(key = '') {
  if (key && pageFallbackTimers.has(key)) {
    clearTimeout(pageFallbackTimers.get(key));
    pageFallbackTimers.delete(key);
  } else if (!key) {
    clearPageFallbackTimers();
  }

  try {
    const reg = await getActiveServiceWorkerRegistration(800);
    const worker = navigator.serviceWorker?.controller || reg?.active;
    if (worker && typeof worker.postMessage === 'function') {
      worker.postMessage({ type: 'CLEAR_SCHEDULED', key });
    }
  } catch (_) {}
}

function checkImageLoads(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

function renderSvgTextToPngDataUrl(svgText, size) {
  return new Promise((resolve, reject) => {
    try {
      const normalizedSvg = svgText.replace(/<svg\b([^>]*)>/i, (match, attrs) => {
        const cleaned = attrs
          .replace(/\swidth\s*=\s*["'][^"']*["']/gi, '')
          .replace(/\sheight\s*=\s*["'][^"']*["']/gi, '');
        return `<svg${cleaned} width="${size}" height="${size}">`;
      });

      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, 0, 0, size, size);
          resolve(canvas.toDataURL('image/png'));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = (err) => reject(err);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(normalizedSvg);
    } catch (err) {
      reject(err);
    }
  });
}

function applyAppleTouchIconHref(href) {
  try {
    const existing = document.getElementById('pwa-apple-icon');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    const link = document.createElement('link');
    link.id = 'pwa-apple-icon';
    link.rel = 'apple-touch-icon';
    link.sizes = '180x180';
    link.href = href;
    document.head.appendChild(link);
  } catch (_) {}
}

export async function setupPwaManifestAndIcons() {
  try {
    const favicon = document.getElementById('pwa-favicon');
    const modalPreview = document.getElementById('pwa-modal-icon-preview');
    if (favicon) favicon.href = APP_ICON_URL;
    if (modalPreview) modalPreview.src = APP_ICON_URL;

    const baseUrl = new URL('./', window.location.href).href;
    const manifestIcons = [];

    const hasStaticPng = await checkImageLoads(APP_ICON_PNG_URL, 2500);
    if (hasStaticPng) {
      applyAppleTouchIconHref(APP_ICON_PNG_URL);
      // Статичный ./manifest.json уже содержит рабочие PNG-иконки — сохраняем его для iOS/Android PWA
      if (window.location.protocol.startsWith('http')) {
        return;
      }
      manifestIcons.push(
        { src: APP_ICON_PNG_URL, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: APP_ICON_PNG_URL, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
      );
    } else {
      try {
        const resp = await fetch(APP_ICON_URL, { mode: 'cors', cache: 'force-cache' });
        if (resp.ok) {
          const svgText = await resp.text();
          const [png180, png192, png512] = await Promise.all([
            renderSvgTextToPngDataUrl(svgText, 180),
            renderSvgTextToPngDataUrl(svgText, 192),
            renderSvgTextToPngDataUrl(svgText, 512)
          ]);
          cachedPng512DataUrl = png512;
          applyAppleTouchIconHref(png180);
          if (modalPreview) modalPreview.src = png180;
          manifestIcons.push(
            { src: png192, sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: png512, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
          );
        }
      } catch (convErr) {
        console.warn('SVG to PNG conversion fallback:', convErr);
      }
    }

    manifestIcons.push({ src: APP_ICON_URL, sizes: 'any', type: 'image/svg+xml', purpose: 'any' });

    const manifestObj = {
      name: 'Малыш+ — Календарь развития 0–5 лет',
      short_name: 'Малыш+',
      description: 'Календарь развития ребёнка от 0 до 5 лет, журнал кормлений, сна и здоровья',
      start_url: baseUrl,
      scope: baseUrl,
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#FDFBF7',
      theme_color: '#FDFBF7',
      icons: manifestIcons
    };

    const blob = new Blob([JSON.stringify(manifestObj)], { type: 'application/manifest+json' });
    if (lastManifestBlobUrl) URL.revokeObjectURL(lastManifestBlobUrl);
    lastManifestBlobUrl = URL.createObjectURL(blob);
    const manifestLink = document.getElementById('pwa-manifest-link');
    if (manifestLink) manifestLink.href = lastManifestBlobUrl;
  } catch (e) {
    console.warn('PWA manifest setup warning:', e);
  }
}

export async function downloadAppIconPng() {
  try {
    let dataUrl = cachedPng512DataUrl;
    if (!dataUrl) {
      const resp = await fetch(APP_ICON_URL, { mode: 'cors' });
      if (!resp.ok) throw new Error('Не удалось загрузить SVG');
      const svgText = await resp.text();
      dataUrl = await renderSvgTextToPngDataUrl(svgText, 512);
      cachedPng512DataUrl = dataUrl;
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'app_icon.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Файл app_icon.png скачан — загрузите его в репозиторий рядом с app_icon.svg');
  } catch (_) {
    showToast('Не удалось сформировать PNG. Проверьте доступность app_icon.svg');
  }
}

export function warmOfflineCache() {
  try {
    if ('caches' in window) {
      caches.open('malysh-plus-offline-v1').then((cache) => {
        cache.add(window.location.href).catch(() => {});
      }).catch(() => {});
    }
  } catch (_) {}
}

export function updateNetworkStatusUI() {
  const online = navigator.onLine;
  const pill = document.getElementById('header-net-pill');
  const dot = document.getElementById('header-net-dot');
  const label = document.getElementById('header-net-label');
  const profileStatus = document.getElementById('profile-offline-status');

  if (!online) {
    if (pill && dot && label) {
      pill.className = 'inline-flex items-center justify-center gap-1.5 min-w-[34px] min-h-[38px] px-2 sm:px-2.5 py-2 rounded-xl bg-amber-50/90 dark:bg-amber-950/50 border border-amber-200/70 dark:border-amber-800/60 text-amber-700 dark:text-amber-300 text-xs font-semibold transition';
      dot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0';
      label.textContent = 'Офлайн';
    }
    if (profileStatus) {
      profileStatus.textContent = 'Офлайн • Сохраняется локально';
      profileStatus.className = 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300';
    }
  } else if (store.pendingSyncState) {
    if (pill && dot && label) {
      pill.className = 'inline-flex items-center justify-center gap-1.5 min-w-[34px] min-h-[38px] px-2 sm:px-2.5 py-2 rounded-xl bg-sky-50/90 dark:bg-sky-950/50 border border-sky-200/70 dark:border-sky-800/60 text-sky-700 dark:text-sky-300 text-xs font-semibold transition';
      dot.className = 'w-2 h-2 rounded-full bg-sky-500 animate-ping shrink-0';
      label.textContent = 'Синхр...';
    }
    if (profileStatus) {
      profileStatus.textContent = 'Синхронизация с облаком...';
      profileStatus.className = 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-sky-100 dark:bg-sky-950/70 text-sky-700 dark:text-sky-300';
    }
  } else {
    if (pill && dot && label) {
      pill.className = 'inline-flex items-center justify-center gap-1.5 min-w-[34px] min-h-[38px] px-2 sm:px-2.5 py-2 rounded-xl bg-emerald-50/90 dark:bg-emerald-950/50 border border-emerald-200/70 dark:border-emerald-800/60 text-emerald-700 dark:text-emerald-300 text-xs font-semibold transition';
      dot.className = 'w-2 h-2 rounded-full bg-emerald-500 shrink-0';
      label.textContent = 'Онлайн';
    }
    if (profileStatus) {
      profileStatus.textContent = 'Онлайн • Синхронизировано';
      profileStatus.className = 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300';
    }
  }
}

export function showNetworkStatusToast() {
  if (!navigator.onLine) {
    showToast('Офлайн-режим: все записи сохраняются на устройстве и отправятся в облако при появлении сети');
  } else if (store.pendingSyncState) {
    hooks.flushPendingSync();
    showToast('Выполняется синхронизация данных с облаком...');
  } else {
    showToast('Онлайн • Данные синхронизированы и доступны без интернета');
  }
}

export function isStandalonePwa() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function renderPwaInstallUI() {
  const banner = document.getElementById('pwa-install-banner');
  const profileBtn = document.getElementById('profile-pwa-install-btn');
  const profileLbl = document.getElementById('profile-pwa-install-label');

  if (isStandalonePwa()) {
    if (banner) banner.classList.add('hidden');
    if (profileLbl) profileLbl.textContent = 'Приложение установлено на экран «Домой»';
    if (profileBtn) profileBtn.disabled = true;
    return;
  }

  if (!banner) return;
  if (pwaBannerDismissed || !store.currentAccountLogin) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden');
  banner.innerHTML = `
    <div class="bg-white dark:bg-slate-900 rounded-3xl border border-stone-200/80 dark:border-slate-800 p-3.5 sm:p-4 shadow-2xs flex items-center justify-between gap-3 animate-fade-in">
      <div class="flex items-center gap-3 min-w-0">
        <img src="${APP_ICON_URL}" alt="Малыш+" class="w-11 h-11 rounded-2xl shadow-xs shrink-0 object-cover bg-sky-100" />
        <div class="min-w-0">
          <div class="font-display font-extrabold text-xs sm:text-sm text-slate-900 dark:text-slate-100 truncate">Установите «Малыш+» на экран «Домой»</div>
          <div class="text-[11px] text-slate-500 dark:text-slate-400 truncate">Быстрый запуск в один тап и работа без интернета</div>
        </div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" onclick="triggerPwaInstall()" class="px-3 py-2 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold transition">
          Установить
        </button>
        <button type="button" onclick="dismissPwaBanner()" aria-label="Скрыть" class="p-2 rounded-xl hover:bg-stone-100 dark:hover:bg-slate-800 text-slate-400 transition">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
  `;
}

export async function triggerPwaInstall() {
  if (deferredInstallPrompt) {
    try {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice && choice.outcome === 'accepted') {
        deferredInstallPrompt = null;
        pwaBannerDismissed = true;
        renderPwaInstallUI();
        showToast('Приложение «Малыш+» добавлено на экран «Домой»');
        return;
      }
    } catch (_) {}
  }

  const stepsEl = document.getElementById('pwa-manual-steps');
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (stepsEl) {
    if (isIos) {
      stepsEl.innerHTML = `
        <div class="p-3 rounded-2xl bg-warmgray/70 dark:bg-slate-800 flex items-start gap-2.5">
          <span class="w-5 h-5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0">1</span>
          <span>Откройте сайт в браузере <strong>Safari</strong> и нажмите кнопку <strong>«Поделиться»</strong> (квадрат со стрелкой вверх внизу экрана).</span>
        </div>
        <div class="p-3 rounded-2xl bg-warmgray/70 dark:bg-slate-800 flex items-start gap-2.5">
          <span class="w-5 h-5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0">2</span>
          <span>Пролистайте меню вниз и выберите пункт <strong>«На экран „Домой“»</strong>.</span>
        </div>
        <div class="p-3 rounded-2xl bg-warmgray/70 dark:bg-slate-800 flex items-start gap-2.5">
          <span class="w-5 h-5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0">3</span>
          <span>Нажмите <strong>«Добавить»</strong> в правом верхнем углу — иконка появится на рабочем столе iPhone.</span>
        </div>
      `;
    } else {
      stepsEl.innerHTML = `
        <div class="p-3 rounded-2xl bg-warmgray/70 dark:bg-slate-800 flex items-start gap-2.5">
          <span class="w-5 h-5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0">1</span>
          <span>Нажмите на меню браузера (<strong>⋮</strong> в правом верхнем углу Chrome / Edge или значок установки в адресной строке на ПК).</span>
        </div>
        <div class="p-3 rounded-2xl bg-warmgray/70 dark:bg-slate-800 flex items-start gap-2.5">
          <span class="w-5 h-5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0">2</span>
          <span>Выберите <strong>«Установить приложение»</strong> или <strong>«Добавить на главный экран»</strong>.</span>
        </div>
      `;
    }
  }
  openModal('modal-pwa-install');
}

export function dismissPwaBanner() {
  pwaBannerDismissed = true;
  renderPwaInstallUI();
}

export function initPwaListeners() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    renderPwaInstallUI();
  });

  window.addEventListener('online', () => {
    updateNetworkStatusUI();
    hooks.flushPendingSync();
  });

  window.addEventListener('offline', () => {
    updateNetworkStatusUI();
  });
}
