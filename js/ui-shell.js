// Шапка приложения, виджет «Здесь и сейчас», умные напоминания, темы оформления и настройки профиля

import {
  store,
  hooks,
  calculateBabyAge,
  getAgeSleepAndFeedNorms,
  computeHereAndNowMetrics,
  getCurrentCaregiverName,
  writeCaregiverName
} from './state.js';
import {
  escapeHtml,
  getTodayIso,
  formatMinutesHuman,
  formatClockHHMM,
  syncRuDateDisplays,
  openModal,
  closeModal,
  showToast
} from './utils.js';
import { saveAppState, createFamilyInviteCode } from './firebase.js';
import {
  updateNetworkStatusUI,
  isStandalonePwa,
  registerAppServiceWorker,
  showSystemNotification,
  syncScheduledSystemNotifications
} from './pwa.js';

export function renderHeaderBabyInfo() {
  const nameEl = document.getElementById('header-baby-name');
  const ageEl = document.getElementById('header-baby-age');
  const age = calculateBabyAge(store.appState.babyDob);
  if (nameEl) nameEl.textContent = store.appState.babyName || 'Малыш';
  if (ageEl) ageEl.textContent = age.humanText;
}

export function toggleSleepDebtDetails() {
  store.sleepDebtExpanded = !store.sleepDebtExpanded;
  renderHereAndNowWidget();
}

export function openSleepDebtInfoModal() {
  const body = document.getElementById('sleep-debt-info-body');
  const subtitleEl = document.getElementById('sleep-debt-info-subtitle');
  if (!body) return;

  const m = computeHereAndNowMetrics();
  const age = calculateBabyAge(store.appState.babyDob);
  const hasSleepDebt = m.sleepDebtMin >= 45;

  if (subtitleEl) {
    subtitleEl.textContent = `Возраст: ${age.humanText} • Ориентир сна: ${m.norms.dailySleepLabel} в сутки`;
  }

  const summaryBannerCls = hasSleepDebt
    ? 'bg-amber-50/80 dark:bg-amber-950/35 border-amber-200/80 dark:border-amber-800/60 text-amber-900 dark:text-amber-100'
    : 'bg-emerald-50/80 dark:bg-emerald-950/35 border-emerald-200/80 dark:border-emerald-800/60 text-emerald-900 dark:text-emerald-100';

  const summaryTitle = hasSleepDebt
    ? `Накопленный недосып: ${formatMinutesHuman(m.sleepDebtMin)}`
    : m.activeDaysCount < 2
      ? 'Пока мало данных для оценки долга сна'
      : m.sleepDebtMin > 0
        ? `Небольшой дефицит: ${formatMinutesHuman(m.sleepDebtMin)} (в пределах нормы)`
        : 'Баланс сна в норме';

  const formulaHtml = m.activeDaysCount >= 2
    ? `Норма за ${m.activeDaysCount} учт. дн. (${formatMinutesHuman(m.totalTargetSleepMin)}) − фактический сон (${formatMinutesHuman(m.totalActualSleepMin)}) = <strong>${m.sleepDebtMin > 0 ? formatMinutesHuman(m.sleepDebtMin) : '0 мин'}</strong>`
    : `Сейчас учтён только ${m.activeDaysCount} завершённый день с записями — расчёт включается минимум от 2 завершённых дней.`;

  const daysHtml = [...m.daysBreakdown].reverse().map(d => {
    const diffMin = d.sleepMin - d.targetMin;
    const diffStr = diffMin === 0
      ? '0 мин'
      : diffMin > 0
        ? `+${formatMinutesHuman(diffMin)}`
        : `−${formatMinutesHuman(Math.abs(diffMin))}`;

    let statusText = 'нет записей (не учтён)';
    let rowCls = 'bg-warmgray/40 dark:bg-slate-800/40 text-slate-400';
    let diffCls = 'text-slate-400';

    if (d.isToday) {
      statusText = 'сегодня (ещё идёт, не в долге)';
      rowCls = 'bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-200/50 dark:border-indigo-800/50 text-slate-700 dark:text-slate-200';
      diffCls = 'text-indigo-500 dark:text-indigo-300';
    } else if (d.includedInDebt) {
      statusText = d.sleepMin === 0 ? 'были записи, но без сна' : 'учтён в расчёте';
      rowCls = 'bg-warmgray/75 dark:bg-slate-800/80 text-slate-800 dark:text-slate-100';
      diffCls = diffMin >= 0
        ? 'text-emerald-600 dark:text-emerald-400'
        : Math.abs(diffMin) >= 45
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-slate-500 dark:text-slate-300';
    }

    return `
      <div class="flex items-center justify-between gap-2 py-2 px-2.5 rounded-xl ${rowCls} text-xs">
        <div class="min-w-0">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="font-bold">${escapeHtml(d.dateLabel)}</span>
            <span class="text-[10px] opacity-80">${statusText}</span>
          </div>
          ${d.dayOverfatigueCount > 0 ? `<div class="text-[10px] text-rose-500 dark:text-rose-400 font-semibold mt-0.5">Перегул: ${d.dayOverfatigueCount} эп.</div>` : ''}
        </div>
        <div class="text-right shrink-0 tabular-nums">
          <div class="font-bold">${d.sleepMin > 0 ? formatMinutesHuman(d.sleepMin) : '0 мин'} <span class="text-[10px] font-normal opacity-70">/ ${formatMinutesHuman(d.targetMin)}</span></div>
          ${d.includedInDebt ? `<div class="text-[10px] font-bold ${diffCls}">${diffStr}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  body.innerHTML = `
    <div class="p-3.5 rounded-2xl border ${summaryBannerCls} space-y-1">
      <div class="font-display font-extrabold text-sm sm:text-base">${summaryTitle}</div>
      <div class="text-[11px] opacity-90">
        Учтено завершённых дней: <strong>${m.activeDaysCount}</strong> из 6 • Эпизодов перегула за неделю: <strong>${m.overfatigueCount}</strong>
      </div>
    </div>

    <div class="space-y-1.5">
      <h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-400">Что это значит</h4>
      <p class="text-xs sm:text-[13px] text-slate-700 dark:text-slate-200 leading-relaxed">
        <strong>Долг сна (недосып)</strong> показывает, сколько часов или минут сна малыш недополучил по сравнению с возрастной нормой за последние дни. Плашка предупреждения появляется, если суммарный дефицит достигает <strong>45 минут и больше</strong> — в таком случае помогает уложить ребёнка на ночь на 20–30 минут раньше.
      </p>
    </div>

    <div class="space-y-2">
      <h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-400">Откуда складываются эти данные</h4>
      <div class="p-3 rounded-2xl bg-warmgray/60 dark:bg-slate-800/60 border border-stone-200/70 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 space-y-1.5 leading-relaxed">
        <div>• Берётся окно из <strong>6 последних завершённых дней</strong> (сегодняшний день не учитывается, пока не закончился).</div>
        <div>• В расчёт попадает каждый завершённый день, в котором была хотя бы одна запись в «Журнале» (сон, кормление, подгузник и т.д.).</div>
        <div>• Суточная норма для расчёта (${formatMinutesHuman(m.norms.dailySleepTargetMin)} из ориентира ${escapeHtml(m.norms.dailySleepLabel)}) сравнивается с суммой всех снов за эти сутки.</div>
        <div>• <strong>Эпизод перегула</strong> фиксируется, когда перерыв между двумя снами в один день превышает возрастное окно бодрствования (${formatMinutesHuman(m.norms.wakeWindowMin)}) больше чем на 25 минут (от ${formatMinutesHuman(m.norms.wakeWindowMin + 26)} до 10 ч).</div>
        <div class="pt-1 font-semibold text-slate-800 dark:text-slate-100">${formulaHtml}</div>
      </div>

      <div class="space-y-1.5">
        <div class="text-[11px] font-bold text-slate-500 dark:text-slate-400">Разбивка по дням (последние 7 суток):</div>
        ${daysHtml}
      </div>
    </div>
  `;

  openModal('modal-sleep-debt-info');
}

export function renderHereAndNowWidget() {
  const container = document.getElementById('here-and-now-widget');
  if (!container || !store.currentAccountLogin) return;

  const appState = store.appState;
  const m = computeHereAndNowMetrics();
  container.classList.remove('hidden');

  const feedText = appState.timers?.feeding?.active
    ? 'Идёт сейчас'
    : m.sinceFeedMin !== null
      ? formatMinutesHuman(m.sinceFeedMin)
      : 'Нет записей';

  const feedSub = m.sinceFeedMin !== null && !appState.timers?.feeding?.active
    ? (m.sinceFeedMin >= m.norms.feedIntervalMin ? 'Пора кормить' : `Норма: ~${formatMinutesHuman(m.norms.feedIntervalMin)}`)
    : 'Отметьте в журнале';

  const wakeText = m.sleepActive
    ? `Спит ${formatMinutesHuman(m.activeSleepMin)}`
    : m.wakeMin !== null
      ? formatMinutesHuman(m.wakeMin)
      : 'Нет записей';

  const wakeSub = m.sleepActive
    ? (appState.timers.sleep.sleepType === 'night' ? 'Ночной сон' : 'Дневной сон')
    : m.shortNapAdjusted
      ? `Сокращено до ${formatMinutesHuman(m.adjustedWakeWindowMin)}`
      : `Норма окна: ${formatMinutesHuman(m.norms.wakeWindowMin)}`;

  let countdownText = '—';
  let countdownSub = 'Запустите сон в журнале';
  let progressPct = 0;
  let countdownBadgeClass = 'text-slate-900 dark:text-slate-100';

  if (m.sleepActive) {
    countdownText = 'Малыш спит';
    countdownSub = 'Таймер сна активен';
    progressPct = 100;
    countdownBadgeClass = 'text-indigo-600 dark:text-indigo-400';
  } else if (m.countdownMin !== null) {
    progressPct = Math.min(100, Math.max(5, Math.round((m.wakeMin / m.adjustedWakeWindowMin) * 100)));
    if (m.countdownMin > 0) {
      countdownText = `Через ${formatMinutesHuman(m.countdownMin)}`;
      countdownSub = `Ориентир в ${formatClockHHMM(m.recommendedBedtimeTs)}`;
      countdownBadgeClass = m.countdownMin <= 15 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400';
    } else {
      countdownText = `Перегул +${formatMinutesHuman(Math.abs(m.countdownMin))}`;
      countdownSub = 'Пора мягко укладывать';
      countdownBadgeClass = 'text-rose-600 dark:text-rose-400';
    }
  }

  const infoDotSvg = `<svg class="w-3 h-3 opacity-75 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
  const hasSleepDebt = m.sleepDebtMin >= 45;
  const debtBadgeHtml = hasSleepDebt
    ? `<button type="button" onclick="openSleepDebtInfoModal()" class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/60 hover:bg-amber-100 dark:hover:bg-amber-900/60 text-amber-700 dark:text-amber-300 text-[11px] font-bold transition cursor-pointer"><span>Долг сна: −${formatMinutesHuman(m.sleepDebtMin)} за ${m.activeDaysCount} дн.</span>${infoDotSvg}</button>`
    : `<button type="button" onclick="openSleepDebtInfoModal()" class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 text-[11px] font-bold transition cursor-pointer"><span>Баланс сна в норме</span>${infoDotSvg}</button>`;

  let noticesHtml = '';
  if (m.shortNapAdjusted && !m.sleepActive) {
    noticesHtml += `
      <div class="flex items-start gap-2 p-2.5 rounded-2xl bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200/70 dark:border-indigo-800/50 text-[11px] text-indigo-900 dark:text-indigo-200">
        <svg class="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        <span>Предыдущий дневной сон был коротким (<strong>${m.lastShortNapMin} мин</strong>) — следующее окно бодрствования сокращено на <strong>${m.norms.napShortenMin} мин</strong>, малыш устанет быстрее обычного.</span>
      </div>
    `;
  }
  if (hasSleepDebt) {
    noticesHtml += `
      <button type="button" onclick="openSleepDebtInfoModal()" class="w-full text-left flex items-start justify-between gap-2 p-2.5 rounded-2xl bg-amber-50/90 dark:bg-amber-950/40 hover:bg-amber-100/80 dark:hover:bg-amber-950/60 border border-amber-200/70 dark:border-amber-800/50 text-[11px] text-amber-900 dark:text-amber-200 active:scale-[0.99] transition cursor-pointer">
        <div class="flex items-start gap-2 min-w-0">
          <svg class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
          <span>За последние ${m.activeDaysCount} дн. накопился недосып <strong>${formatMinutesHuman(m.sleepDebtMin)}</strong>${m.overfatigueCount > 0 ? ` (эпизодов перегула: ${m.overfatigueCount})` : ''}. Попробуйте сдвинуть ночное укладывание на <strong>30 минут раньше</strong>, чтобы восстановить баланс.</span>
        </div>
        <svg class="w-3.5 h-3.5 text-amber-600/80 dark:text-amber-300/80 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
      </button>
    `;
  }

  const breakdownHtml = store.sleepDebtExpanded ? `
    <div class="pt-2 border-t border-stone-100 dark:border-slate-800 space-y-2">
      <div class="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
        <span>Сон по дням за последние 7 суток</span>
        <span>Норма: ${m.norms.dailySleepLabel}</span>
      </div>
      <div class="grid grid-cols-7 gap-1.5">
        ${m.daysBreakdown.map(d => {
          const pct = Math.min(100, Math.round((d.sleepMin / (d.targetMin || 1)) * 100));
          const hrs = (d.sleepMin / 60).toFixed(1);
          return `
            <div class="p-1.5 rounded-xl bg-warmgray/70 dark:bg-slate-800 text-center space-y-1">
              <div class="text-[10px] font-semibold text-slate-400">${d.dateLabel}</div>
              <div class="h-12 w-full bg-stone-200/70 dark:bg-slate-700 rounded-lg flex items-end overflow-hidden p-0.5">
                <div class="w-full rounded-md ${pct >= 85 ? 'bg-emerald-500' : d.sleepMin > 0 ? 'bg-indigo-500' : 'bg-transparent'}" style="height: ${Math.max(pct, d.sleepMin > 0 ? 12 : 0)}%"></div>
              </div>
              <div class="text-[10px] font-bold text-slate-700 dark:text-slate-200">${d.sleepMin > 0 ? hrs + 'ч' : '—'}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  ` : '';

  container.innerHTML = `
    <div class="bg-white dark:bg-slate-900 rounded-3xl border border-stone-200/80 dark:border-slate-800 p-4 sm:p-5 space-y-3 shadow-2xs">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>
          <span class="font-display font-extrabold text-xs sm:text-sm uppercase tracking-wider text-slate-700 dark:text-slate-200">Здесь и сейчас</span>
        </div>
        <div class="flex items-center gap-1.5">
          ${debtBadgeHtml}
          <button type="button" onclick="toggleSleepDebtDetails()" class="px-2.5 py-1 rounded-xl bg-warmgray dark:bg-slate-800 hover:bg-stone-200/80 dark:hover:bg-slate-700 text-[11px] font-bold text-slate-600 dark:text-slate-300 transition">
            ${store.sleepDebtExpanded ? 'Скрыть 7 дн.' : 'Сон 7 дн.'}
          </button>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-2 sm:gap-3">
        <div class="p-2.5 sm:p-3 rounded-2xl bg-rose-50/70 dark:bg-rose-950/30 border border-rose-100/80 dark:border-rose-900/40">
          <div class="text-[10px] sm:text-[11px] font-semibold text-rose-600/80 dark:text-rose-300/80">С кормления</div>
          <div class="font-display font-extrabold text-sm sm:text-base text-slate-900 dark:text-slate-100 mt-0.5 truncate">${feedText}</div>
          <div class="text-[10px] text-slate-500 dark:text-slate-400 truncate mt-0.5">${feedSub}</div>
        </div>

        <div class="p-2.5 sm:p-3 rounded-2xl bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-100/80 dark:border-indigo-900/40">
          <div class="text-[10px] sm:text-[11px] font-semibold text-indigo-600/80 dark:text-indigo-300/80">${m.sleepActive ? 'Текущий сон' : 'Бодрствует'}</div>
          <div class="font-display font-extrabold text-sm sm:text-base text-slate-900 dark:text-slate-100 mt-0.5 truncate">${wakeText}</div>
          <div class="text-[10px] text-slate-500 dark:text-slate-400 truncate mt-0.5">${wakeSub}</div>
        </div>

        <div class="p-2.5 sm:p-3 rounded-2xl bg-warmgray/80 dark:bg-slate-800/80 border border-stone-200/70 dark:border-slate-700">
          <div class="text-[10px] sm:text-[11px] font-semibold text-slate-500 dark:text-slate-400">До след. сна</div>
          <div class="font-display font-extrabold text-sm sm:text-base ${countdownBadgeClass} mt-0.5 truncate">${countdownText}</div>
          <div class="text-[10px] text-slate-500 dark:text-slate-400 truncate mt-0.5">${countdownSub}</div>
        </div>
      </div>

      ${m.countdownMin !== null && !m.sleepActive ? `
        <div class="w-full h-1.5 rounded-full bg-stone-100 dark:bg-slate-800 overflow-hidden">
          <div class="h-full rounded-full transition-all duration-500 ${m.countdownMin <= 0 ? 'bg-rose-500' : m.countdownMin <= 15 ? 'bg-amber-500' : 'bg-indigo-500'}" style="width: ${progressPct}%"></div>
        </div>
      ` : ''}

      ${noticesHtml}
      ${breakdownHtml}
    </div>
  `;
}

// =========================================================================
// УМНЫЕ УВЕДОМЛЕНИЯ
// =========================================================================
function playGentleChime() {
  if (!store.appState.notifications?.sound) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(659.25, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
  } catch (_) {}
}

const PUSH_DEDUP_STORAGE_KEY = 'malysh_plus_push_dedup_v1';
const memoryPushDedup = new Map();
let lastChimedKey = '';

function readPushDedupMap() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(PUSH_DEDUP_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    }
  } catch (_) {}
  const fallback = {};
  for (const [k, v] of memoryPushDedup.entries()) {
    fallback[k] = v;
  }
  return fallback;
}

function writePushDedupEntry(key, signature, now) {
  memoryPushDedup.set(key, { signature, sentAt: now });
  try {
    if (typeof localStorage !== 'undefined') {
      const map = readPushDedupMap();
      map[key] = { signature, sentAt: now };
      localStorage.setItem(PUSH_DEDUP_STORAGE_KEY, JSON.stringify(map));
    }
  } catch (_) {}
}

function shouldDispatchSystemPush(key, signature, now = Date.now(), cooldownMs = 30 * 60000) {
  const map = readPushDedupMap();
  const prev = map[key] || memoryPushDedup.get(key);
  if (!prev) return true;
  if (prev.signature !== signature) return true;
  return (now - Number(prev.sentAt || 0)) >= cooldownMs;
}

export function getNotificationPlatformInfo() {
  const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
  const isIos = /iphone|ipad|ipod/i.test(ua) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(ua);
  const standalone = typeof window !== 'undefined' ? isStandalonePwa() : false;
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const permission = supported ? Notification.permission : 'unsupported';
  let inIframe = false;
  try {
    inIframe = typeof window !== 'undefined' && window.self !== window.top;
  } catch (_) {
    inIframe = true;
  }
  return { isIos, isAndroid, standalone, supported, permission, inIframe };
}

export function buildUpcomingNotificationSchedule(appState, metrics, now = Date.now()) {
  const items = [];
  if (!appState || !metrics) return items;
  const notifs = appState.notifications || {};
  const snoozed = notifs.snoozedUntil || {};
  const babyName = (appState.babyName || 'Малыш').trim();

  if (notifs.feeding && !appState.timers?.feeding?.active && metrics.lastFeedTs) {
    const dueTs = metrics.lastFeedTs + metrics.norms.feedIntervalMin * 60000;
    const snoozeTs = Number(snoozed.feeding || 0);
    const triggerAt = Math.max(dueTs, snoozeTs);
    if (triggerAt > now) {
      items.push({
        key: 'feeding',
        tag: `malysh-feeding-${metrics.lastFeedTs}`,
        triggerAt,
        title: `${babyName}: пора покормить`,
        body: `Прошло ~${formatMinutesHuman(Math.round((triggerAt - metrics.lastFeedTs) / 60000))} с прошлого кормления`,
        tab: 'journal'
      });
    }
  }

  if (notifs.sleep && !metrics.sleepActive && metrics.lastWakeStartTs) {
    const dueTs = metrics.lastWakeStartTs + metrics.adjustedWakeWindowMin * 60000;
    const snoozeTs = Number(snoozed.sleep || 0);
    const triggerAt = Math.max(dueTs, snoozeTs);
    if (triggerAt > now) {
      items.push({
        key: 'sleep',
        tag: `malysh-sleep-${metrics.lastWakeStartTs}`,
        triggerAt,
        title: `${babyName}: окно бодрствования заканчивается`,
        body: `Рекомендуется уложить спать около ${formatClockHHMM(dueTs)}`,
        tab: 'journal'
      });
    }
  }

  if (notifs.diaper && metrics.lastDiaperTs && metrics.norms.diaperIntervalMin) {
    const dueTs = metrics.lastDiaperTs + metrics.norms.diaperIntervalMin * 60000;
    const snoozeTs = Number(snoozed.diaper || 0);
    const triggerAt = Math.max(dueTs, snoozeTs);
    if (triggerAt > now) {
      items.push({
        key: 'diaper',
        tag: `malysh-diaper-${metrics.lastDiaperTs}`,
        triggerAt,
        title: `${babyName}: пора проверить подгузник`,
        body: `Прошло ~${formatMinutesHuman(Math.round((triggerAt - metrics.lastDiaperTs) / 60000))} с прошлой отметки`,
        tab: 'journal'
      });
    }
  }

  return items;
}

export function evaluateActiveNotificationAlerts(appState, metrics, now = Date.now()) {
  const alerts = [];
  if (!appState || !metrics) return alerts;
  const notifs = appState.notifications || {};
  const snoozed = notifs.snoozedUntil || {};
  const babyName = (appState.babyName || 'Малыш').trim();

  if (notifs.feeding && !appState.timers?.feeding?.active && metrics.sinceFeedMin !== null && metrics.sinceFeedMin >= metrics.norms.feedIntervalMin) {
    if (!snoozed.feeding || now > snoozed.feeding) {
      alerts.push({
        key: 'feeding',
        signature: `feeding_${metrics.lastFeedTs || 0}_${snoozed.feeding || 0}`,
        title: `Пора покормить малыша (прошло ${formatMinutesHuman(metrics.sinceFeedMin)})`,
        pushTitle: `${babyName}: пора покормить`,
        pushBody: `С прошлого кормления прошло ${formatMinutesHuman(metrics.sinceFeedMin)} (норма ~${formatMinutesHuman(metrics.norms.feedIntervalMin)}).`,
        actionLabel: 'Начать кормление'
      });
    }
  }

  if (notifs.sleep && !metrics.sleepActive && metrics.countdownMin !== null && metrics.countdownMin <= 0) {
    if (!snoozed.sleep || now > snoozed.sleep) {
      alerts.push({
        key: 'sleep',
        signature: `sleep_${metrics.lastWakeStartTs || 0}_${snoozed.sleep || 0}`,
        title: `Время укладывать спать (бодрствует ${formatMinutesHuman(metrics.wakeMin)})`,
        pushTitle: `${babyName}: пора укладывать спать`,
        pushBody: `Малыш бодрствует уже ${formatMinutesHuman(metrics.wakeMin)} при норме окна ${formatMinutesHuman(metrics.adjustedWakeWindowMin)}.`,
        actionLabel: 'Малыш уснул'
      });
    }
  }

  if (notifs.diaper && metrics.sinceDiaperMin !== null && metrics.norms.diaperIntervalMin && metrics.sinceDiaperMin >= metrics.norms.diaperIntervalMin) {
    if (!snoozed.diaper || now > snoozed.diaper) {
      alerts.push({
        key: 'diaper',
        signature: `diaper_${metrics.lastDiaperTs || 0}_${snoozed.diaper || 0}`,
        title: `Пора проверить подгузник (прошло ${formatMinutesHuman(metrics.sinceDiaperMin)})`,
        pushTitle: `${babyName}: проверьте подгузник`,
        pushBody: `С последней смены подгузника прошло ${formatMinutesHuman(metrics.sinceDiaperMin)}.`,
        actionLabel: 'Открыть журнал'
      });
    }
  }

  return alerts;
}

function recordNotificationHistoryEntries(alerts, now = Date.now()) {
  if (!store.appState.notifications) store.appState.notifications = {};
  if (!Array.isArray(store.appState.notifications.history)) {
    store.appState.notifications.history = [];
  }
  const history = store.appState.notifications.history;
  let added = false;

  for (const alert of alerts) {
    const alreadyLoggedRecently = history.some(
      (h) => h && h.type === alert.key && h.signature === alert.signature && (now - Number(h.ts || 0)) < 30 * 60000
    );
    if (!alreadyLoggedRecently) {
      history.unshift({
        ts: now,
        type: alert.key,
        signature: alert.signature,
        title: alert.title
      });
      added = true;
    }
  }

  if (added) {
    store.appState.notifications.history = history.slice(0, 30);
    if (store.initialCloudSyncDone) {
      saveAppState();
    }
    renderNotifHistoryList();
  }
}

export function renderNotifHistoryList() {
  const list = document.getElementById('notif-history-list');
  if (!list) return;
  const history = Array.isArray(store.appState.notifications?.history)
    ? store.appState.notifications.history
    : [];

  if (history.length === 0) {
    list.innerHTML = '<div class="py-3 text-center text-slate-400 text-xs">История пуста</div>';
    return;
  }

  list.innerHTML = history.slice(0, 20).map((item) => {
    const d = new Date(item.ts || Date.now());
    const dayStr = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    const timeStr = formatClockHHMM(d.getTime());
    return `
      <div class="py-2 flex items-start justify-between gap-2 text-xs">
        <span class="text-slate-700 dark:text-slate-200 font-medium">${escapeHtml(item.title || 'Напоминание')}</span>
        <span class="text-[11px] text-slate-400 shrink-0 tabular-nums">${dayStr} ${timeStr}</span>
      </div>
    `;
  }).join('');
}

export function updatePushPermissionUI() {
  const lbl = document.getElementById('push-status-label');
  const hintEl = document.getElementById('push-platform-hint');
  const btn = document.getElementById('push-perm-btn');
  const info = getNotificationPlatformInfo();

  if (hintEl) {
    if (info.isIos && !info.standalone) {
      hintEl.textContent = 'На iPhone системные уведомления работают только после добавления на экран «Домой»: нажмите «Поделиться» в Safari → «На экран „Домой“» и откройте иконку.';
      hintEl.classList.remove('hidden');
    } else if (info.inIframe) {
      hintEl.textContent = 'В окне предпросмотра браузер может ограничивать Push-уведомления — откройте приложение на телефоне в отдельной вкладке или как PWA.';
      hintEl.classList.remove('hidden');
    } else if (info.permission === 'denied') {
      hintEl.textContent = 'Уведомления запрещены в настройках сайта/телефона. Нажмите на значок настроек слева от адреса сайта и разрешите «Уведомления».';
      hintEl.classList.remove('hidden');
    } else {
      hintEl.textContent = '';
      hintEl.classList.add('hidden');
    }
  }

  if (!info.supported) {
    if (lbl) {
      lbl.textContent = info.isIos && !info.standalone
        ? 'На iPhone установите приложение на экран «Домой»'
        : 'Браузер не поддерживает системные уведомления';
      lbl.className = 'text-[11px] text-amber-600 dark:text-amber-400 font-medium';
    }
    if (btn) {
      btn.textContent = info.isIos && !info.standalone ? 'Как на iPhone' : 'Недоступно';
      btn.disabled = !(info.isIos && !info.standalone);
    }
    return;
  }

  if (info.permission === 'granted') {
    if (lbl) {
      lbl.textContent = 'Системные уведомления включены';
      lbl.className = 'text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold';
    }
    if (btn) {
      btn.textContent = 'Включено';
      btn.className = 'px-3 py-1.5 rounded-xl bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-[11px] font-bold transition shrink-0';
    }
  } else if (info.permission === 'denied') {
    if (lbl) {
      lbl.textContent = 'Заблокировано в настройках браузера';
      lbl.className = 'text-[11px] text-rose-500 font-semibold';
    }
    if (btn) {
      btn.textContent = 'Как включить';
      btn.className = 'px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-bold transition shrink-0';
    }
  } else {
    if (lbl) {
      lbl.textContent = 'Уведомления на экран телефона / ПК (пока не разрешены)';
      lbl.className = 'text-[11px] text-slate-500';
    }
    if (btn) {
      btn.textContent = 'Включить';
      btn.className = 'px-3 py-1.5 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-[11px] font-bold transition shrink-0';
    }
  }
}

export function evaluateSmartNotifications() {
  const banner = document.getElementById('smart-notif-banner');
  const badge = document.getElementById('header-notif-badge');
  if (!store.currentAccountLogin) return;

  const appState = store.appState;
  const m = computeHereAndNowMetrics();
  const now = Date.now();
  const alerts = evaluateActiveNotificationAlerts(appState, m, now);
  const upcoming = buildUpcomingNotificationSchedule(appState, m, now);

  // Синхронизируем будущие напоминания с Service Worker (чтобы сработали в фоне/при закрытой вкладке)
  syncScheduledSystemNotifications(upcoming).catch(() => {});

  if (badge) {
    if (alerts.length > 0) {
      badge.textContent = String(alerts.length);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  if (alerts.length === 0) {
    if (banner) banner.classList.add('hidden');
    return;
  }

  recordNotificationHistoryEntries(alerts, now);

  // Отправляем системные Push-уведомления на телефон / ПК (с защитой от повторов чаще 1 раза в 30 мин)
  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
    for (const alert of alerts) {
      if (shouldDispatchSystemPush(alert.key, alert.signature, now)) {
        writePushDedupEntry(alert.key, alert.signature, now);
        showSystemNotification({
          title: alert.pushTitle || 'Малыш+',
          body: alert.pushBody || alert.title,
          tag: `malysh-${alert.key}`,
          key: alert.key,
          tab: 'journal',
          requireInteraction: alert.key === 'sleep' || alert.key === 'feeding'
        }).catch(() => {});
      }
    }
  }

  const top = alerts[0];
  const chimeSignature = `${top.key}_${Math.floor(now / 600000)}`;
  if (lastChimedKey !== chimeSignature) {
    lastChimedKey = chimeSignature;
    playGentleChime();
  }

  if (banner) {
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <div class="bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/70 rounded-3xl p-3.5 sm:p-4 flex flex-wrap items-center justify-between gap-2.5 animate-fade-in">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="w-8 h-8 rounded-xl bg-rose-500 text-white flex items-center justify-center shrink-0">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
          </span>
          <span class="text-xs sm:text-sm font-bold text-rose-900 dark:text-rose-100">${escapeHtml(top.title)}</span>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" onclick="handleSmartNotifAction('${top.key}')" class="px-3 py-1.5 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold transition">${escapeHtml(top.actionLabel)}</button>
          <button type="button" onclick="snoozeSmartNotif('${top.key}')" class="px-2.5 py-1.5 rounded-xl bg-white/80 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-semibold transition">Через 20 мин</button>
        </div>
      </div>
    `;
  }
}

export function handleSmartNotifAction(key) {
  hooks.switchTab('journal');
  if (key === 'feeding' && !store.appState.timers?.feeding?.active) hooks.toggleTimer('feeding');
  if (key === 'sleep' && !store.appState.timers?.sleep?.active) hooks.toggleTimer('sleep');
  if (key === 'diaper') showToast('Отметьте смену подгузника в быстром уходе журнала');
}

export function snoozeSmartNotif(key) {
  if (!store.appState.notifications.snoozedUntil) store.appState.notifications.snoozedUntil = {};
  store.appState.notifications.snoozedUntil[key] = Date.now() + 20 * 60000;
  saveAppState();
  evaluateSmartNotifications();
  showToast('Напоминание отложено на 20 минут');
}

export function openNotificationsModal() {
  const norms = getAgeSleepAndFeedNorms();
  const sub = document.getElementById('notif-norms-subtitle');
  const fDesc = document.getElementById('notif-feed-desc');
  const sDesc = document.getElementById('notif-sleep-desc');
  const dDesc = document.getElementById('notif-diaper-desc');
  if (sub) sub.textContent = `Возрастная норма: кормление ~${formatMinutesHuman(norms.feedIntervalMin)}, бодрствование ~${formatMinutesHuman(norms.wakeWindowMin)}`;
  if (fDesc) fDesc.textContent = `Интервал по возрасту: каждые ${formatMinutesHuman(norms.feedIntervalMin)}`;
  if (sDesc) sDesc.textContent = `Окно бодрствования: ${formatMinutesHuman(norms.wakeWindowMin)}`;
  if (dDesc) dDesc.textContent = `Напомнит проверить каждые ${formatMinutesHuman(norms.diaperIntervalMin || 180)}`;

  document.getElementById('notif-opt-feeding').checked = Boolean(store.appState.notifications?.feeding);
  document.getElementById('notif-opt-sleep').checked = Boolean(store.appState.notifications?.sleep);
  document.getElementById('notif-opt-diaper').checked = Boolean(store.appState.notifications?.diaper);
  document.getElementById('notif-opt-sound').checked = Boolean(store.appState.notifications?.sound);

  registerAppServiceWorker().catch(() => {});
  updatePushPermissionUI();
  renderNotifHistoryList();
  openModal('modal-notifications');
}

export function toggleNotifSetting(key, checked) {
  store.appState.notifications[key] = Boolean(checked);
  saveAppState();
  evaluateSmartNotifications();
}

export async function requestBrowserPushPermission() {
  const info = getNotificationPlatformInfo();
  if (!info.supported) {
    updatePushPermissionUI();
    showToast(info.isIos && !info.standalone
      ? 'На iPhone нажмите «Поделиться» в Safari → «На экран „Домой“», затем включите уведомления'
      : 'Браузер не поддерживает системные уведомления');
    return;
  }

  if (Notification.permission === 'denied') {
    updatePushPermissionUI();
    showToast('Уведомления заблокированы — разрешите их в настройках сайта в браузере');
    return;
  }

  if (Notification.permission === 'granted') {
    await registerAppServiceWorker();
    updatePushPermissionUI();
    showToast('Системные уведомления уже включены');
    evaluateSmartNotifications();
    return;
  }

  try {
    // Сначала запрашиваем разрешение строго внутри клика (важно для iOS Safari), параллельно регистрируем Service Worker
    registerAppServiceWorker().catch(() => {});
    const res = await Notification.requestPermission();
    updatePushPermissionUI();
    if (res === 'granted') {
      showToast('Системные уведомления включены');
      evaluateSmartNotifications();
    } else if (res === 'denied') {
      showToast('Доступ к уведомлениям отклонён в браузере');
    } else {
      showToast('Разрешение не выдано');
    }
  } catch (err) {
    console.warn('Notification permission error:', err);
    updatePushPermissionUI();
    showToast('Браузер отклонил запрос — откройте приложение в основном окне или как PWA');
  }
}

export function clearNotifHistory() {
  store.appState.notifications.history = [];
  saveAppState();
  renderNotifHistoryList();
}

// =========================================================================
// ТЕМА ОФОРМЛЕНИЯ И ПРОФИЛЬ МАЛЫША
// =========================================================================
export function applyThemeMode(mode) {
  const m = mode || 'auto';
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = m === 'dark' || (m === 'auto' && prefersDark);
  document.documentElement.classList.toggle('dark', isDark);

  const metaTheme = document.getElementById('meta-theme-color');
  if (metaTheme) metaTheme.setAttribute('content', isDark ? '#020617' : '#FDFBF7');

  const iconWrap = document.getElementById('header-theme-icon');
  if (iconWrap) {
    iconWrap.innerHTML = isDark
      ? '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>'
      : '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
  }

  document.querySelectorAll('.theme-opt-btn').forEach(btn => {
    const active = btn.getAttribute('data-theme-opt') === m;
    btn.className = active
      ? 'theme-opt-btn py-1.5 rounded-lg text-xs font-bold bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs transition'
      : 'theme-opt-btn py-1.5 rounded-lg text-xs font-bold text-slate-500 dark:text-slate-400 transition';
  });
}

export function setThemeMode(mode) {
  store.appState.themeMode = mode;
  store.appState.uiUpdatedAt = Date.now();
  applyThemeMode(mode);
  saveAppState();
}

export function cycleThemeMode() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(store.appState.themeMode || 'auto') + 1) % order.length];
  setThemeMode(next);
  showToast(`Тема: ${next === 'auto' ? 'Авто' : next === 'light' ? 'Светлая' : 'Тёмная'}`);
}

let activeInviteState = null;

function renderFamilyMembersList() {
  const membersWrap = document.getElementById('profile-family-members');
  if (!membersWrap) return;
  const current = getCurrentCaregiverName();
  const list = Array.isArray(store.appState.familyMembers) && store.appState.familyMembers.length > 0
    ? [...store.appState.familyMembers]
    : [current];
  if (!list.includes(current)) list.push(current);

  membersWrap.innerHTML = list.map(member => {
    const isMe = member === current;
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-bold ${isMe ? 'bg-rose-100 dark:bg-rose-950/70 text-rose-700 dark:text-rose-300' : 'bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-200 border border-stone-200/70 dark:border-slate-600'}">${escapeHtml(member)}${isMe ? ' (вы)' : ''}</span>`;
  }).join('');
}

function renderActiveInviteBox() {
  const box = document.getElementById('profile-invite-result');
  if (!box) return;
  if (!activeInviteState || Date.now() > activeInviteState.expiresAt) {
    activeInviteState = null;
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const safeCode = escapeHtml(activeInviteState.code);
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="p-3 rounded-2xl bg-emerald-50/80 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/70 space-y-2 animate-fade-in">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] font-bold text-emerald-800 dark:text-emerald-200">Одноразовый код-приглашение</span>
        <span class="text-[10px] font-semibold text-emerald-700/80 dark:text-emerald-300/80">до ${formatClockHHMM(activeInviteState.expiresAt)}</span>
      </div>
      <div class="flex items-center justify-between gap-2">
        <span class="font-mono font-extrabold text-xl tracking-[0.22em] text-slate-900 dark:text-white select-all">${safeCode}</span>
        <button type="button" onclick="copyFamilyInviteCode('${safeCode}')" class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold transition shrink-0">
          Скопировать
        </button>
      </div>
      <p class="text-[10px] text-emerald-800/80 dark:text-emerald-300/80 leading-snug">
        Второй родитель или няня нажимает на экране входа «По коду», вводит эти 6 символов и выбирает свою роль. Код сработает один раз.
      </p>
    </div>
  `;
}

export function selectProfileCaregiverRole(role) {
  const inp = document.getElementById('profile-caregiver-input');
  if (inp) inp.value = role;
  document.querySelectorAll('.profile-caregiver-btn').forEach(btn => {
    const active = btn.getAttribute('data-role') === role;
    btn.className = active
      ? 'profile-caregiver-btn py-1.5 px-2.5 rounded-xl border border-rose-400 bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-300 text-[11px] font-bold transition'
      : 'profile-caregiver-btn py-1.5 px-2.5 rounded-xl border border-stone-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[11px] font-semibold transition';
  });
}

export async function generateFamilyInviteUI() {
  const btn = document.getElementById('profile-create-invite-btn');
  const prevText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Создаём код...';
  }
  try {
    const result = await createFamilyInviteCode();
    activeInviteState = result;
    renderActiveInviteBox();
    showToast(`Код приглашения создан: ${result.code}`);
  } catch (err) {
    showToast(err?.message || 'Не удалось создать код');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  }
}

export async function copyFamilyInviteCode(code) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(code);
    } else {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showToast(`Код ${code} скопирован`);
  } catch (_) {
    showToast(`Ваш код: ${code}`);
  }
}

export function openProfileModal() {
  document.getElementById('profile-account-login').textContent = `@${store.currentAccountLogin || 'user'}`;
  document.getElementById('profile-name-input').value = store.appState.babyName || '';
  document.getElementById('profile-dob-input').value = store.appState.babyDob || getTodayIso();
  selectProfileGender(store.appState.babyGender || 'girl');
  applyThemeMode(store.appState.themeMode || 'auto');

  const autoNightChk = document.getElementById('profile-auto-night-checkbox');
  if (autoNightChk) autoNightChk.checked = Boolean(store.appState.autoNightAfter23);

  const currentRole = getCurrentCaregiverName();
  const roleInp = document.getElementById('profile-caregiver-input');
  if (roleInp) roleInp.value = currentRole;
  selectProfileCaregiverRole(currentRole);
  renderFamilyMembersList();
  renderActiveInviteBox();

  updateNetworkStatusUI();
  syncRuDateDisplays();
  openModal('modal-profile');
}

export function selectProfileGender(g) {
  store.tempGenderSelection = g === 'boy' ? 'boy' : 'girl';
  const btnG = document.getElementById('gender-btn-girl');
  const btnB = document.getElementById('gender-btn-boy');
  if (btnG) {
    btnG.className = store.tempGenderSelection === 'girl'
      ? 'py-2.5 px-3 rounded-xl border border-rose-400 bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-300 text-xs font-bold flex items-center justify-center gap-1.5 transition'
      : 'py-2.5 px-3 rounded-xl border border-stone-200 dark:border-slate-700 bg-warmgray/60 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-bold flex items-center justify-center gap-1.5 transition';
  }
  if (btnB) {
    btnB.className = store.tempGenderSelection === 'boy'
      ? 'py-2.5 px-3 rounded-xl border border-sky-400 bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-300 text-xs font-bold flex items-center justify-center gap-1.5 transition'
      : 'py-2.5 px-3 rounded-xl border border-stone-200 dark:border-slate-700 bg-warmgray/60 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-bold flex items-center justify-center gap-1.5 transition';
  }
}

export function saveProfileSettings(e) {
  if (e) e.preventDefault();
  const name = (document.getElementById('profile-name-input')?.value || '').trim();
  const dob = document.getElementById('profile-dob-input')?.value || getTodayIso();
  const roleVal = (document.getElementById('profile-caregiver-input')?.value || '').trim();
  const autoNightChk = document.getElementById('profile-auto-night-checkbox');
  const prevAutoNight = Boolean(store.appState.autoNightAfter23);
  const nextAutoNight = autoNightChk ? Boolean(autoNightChk.checked) : prevAutoNight;

  if (name) store.appState.babyName = name;
  store.appState.babyDob = dob;
  store.appState.babyGender = store.tempGenderSelection;
  store.appState.autoNightAfter23 = nextAutoNight;
  store.appState.profileUpdatedAt = Date.now();

  if (roleVal) {
    const savedRole = writeCaregiverName(store.currentAccountLogin, roleVal);
    if (!Array.isArray(store.appState.familyMembers)) store.appState.familyMembers = [];
    if (!store.appState.familyMembers.includes(savedRole)) {
      store.appState.familyMembers.push(savedRole);
    }
  }

  closeModal('modal-profile');
  saveAppState();
  hooks.renderAll();
  if (nextAutoNight && !prevAutoNight && typeof hooks.maybeAutoOpenNightMode === 'function') {
    hooks.maybeAutoOpenNightMode({ forceOnLaunch: true });
  }
  showToast('Данные профиля сохранены');
}
