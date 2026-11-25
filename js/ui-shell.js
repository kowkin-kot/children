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
import { updateNetworkStatusUI } from './pwa.js';

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

  const hasSleepDebt = m.sleepDebtMin >= 45;
  const debtBadgeHtml = hasSleepDebt
    ? `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 text-[11px] font-bold">Долг сна: −${formatMinutesHuman(m.sleepDebtMin)} за ${m.activeDaysCount} дн.</span>`
    : `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-[11px] font-bold">Баланс сна в норме</span>`;

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
      <div class="flex items-start gap-2 p-2.5 rounded-2xl bg-amber-50/90 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-800/50 text-[11px] text-amber-900 dark:text-amber-200">
        <svg class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
        <span>За последние ${m.activeDaysCount} дн. накопился недосып <strong>${formatMinutesHuman(m.sleepDebtMin)}</strong>${m.overfatigueCount > 0 ? ` (эпизодов перегула: ${m.overfatigueCount})` : ''}. Попробуйте сдвинуть ночное укладывание на <strong>30 минут раньше</strong>, чтобы восстановить баланс.</span>
      </div>
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

let lastChimedKey = '';

export function evaluateSmartNotifications() {
  const banner = document.getElementById('smart-notif-banner');
  const badge = document.getElementById('header-notif-badge');
  if (!banner || !store.currentAccountLogin) return;

  const appState = store.appState;
  const m = computeHereAndNowMetrics();
  const now = Date.now();
  const snoozed = appState.notifications?.snoozedUntil || {};
  const alerts = [];

  if (appState.notifications?.feeding && !appState.timers?.feeding?.active && m.sinceFeedMin !== null && m.sinceFeedMin >= m.norms.feedIntervalMin) {
    if (!snoozed.feeding || now > snoozed.feeding) {
      alerts.push({
        key: 'feeding',
        title: `Пора покормить малыша (прошло ${formatMinutesHuman(m.sinceFeedMin)})`,
        actionLabel: 'Начать кормление'
      });
    }
  }

  if (appState.notifications?.sleep && !m.sleepActive && m.countdownMin !== null && m.countdownMin <= 0) {
    if (!snoozed.sleep || now > snoozed.sleep) {
      alerts.push({
        key: 'sleep',
        title: `Время укладывать спать (бодрствует ${formatMinutesHuman(m.wakeMin)})`,
        actionLabel: 'Малыш уснул'
      });
    }
  }

  if (badge) {
    if (alerts.length > 0) {
      badge.textContent = String(alerts.length);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  if (alerts.length === 0) {
    banner.classList.add('hidden');
    return;
  }

  const top = alerts[0];
  const chimeSignature = `${top.key}_${Math.floor(now / 600000)}`;
  if (lastChimedKey !== chimeSignature) {
    lastChimedKey = chimeSignature;
    playGentleChime();
  }

  banner.classList.remove('hidden');
  banner.innerHTML = `
    <div class="bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/70 rounded-3xl p-3.5 sm:p-4 flex flex-wrap items-center justify-between gap-2.5 animate-fade-in">
      <div class="flex items-center gap-2.5 min-w-0">
        <span class="w-8 h-8 rounded-xl bg-rose-500 text-white flex items-center justify-center shrink-0">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
        </span>
        <span class="text-xs sm:text-sm font-bold text-rose-900 dark:text-rose-100">${top.title}</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" onclick="handleSmartNotifAction('${top.key}')" class="px-3 py-1.5 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold transition">${top.actionLabel}</button>
        <button type="button" onclick="snoozeSmartNotif('${top.key}')" class="px-2.5 py-1.5 rounded-xl bg-white/80 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-semibold transition">Через 20 мин</button>
      </div>
    </div>
  `;
}

export function handleSmartNotifAction(key) {
  hooks.switchTab('journal');
  if (key === 'feeding' && !store.appState.timers?.feeding?.active) hooks.toggleTimer('feeding');
  if (key === 'sleep' && !store.appState.timers?.sleep?.active) hooks.toggleTimer('sleep');
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
  if (sub) sub.textContent = `Возрастная норма: кормление ~${formatMinutesHuman(norms.feedIntervalMin)}, бодрствование ~${formatMinutesHuman(norms.wakeWindowMin)}`;
  if (fDesc) fDesc.textContent = `Интервал по возрасту: каждые ${formatMinutesHuman(norms.feedIntervalMin)}`;
  if (sDesc) sDesc.textContent = `Окно бодрствования: ${formatMinutesHuman(norms.wakeWindowMin)}`;

  document.getElementById('notif-opt-feeding').checked = Boolean(store.appState.notifications?.feeding);
  document.getElementById('notif-opt-sleep').checked = Boolean(store.appState.notifications?.sleep);
  document.getElementById('notif-opt-diaper').checked = Boolean(store.appState.notifications?.diaper);
  document.getElementById('notif-opt-sound').checked = Boolean(store.appState.notifications?.sound);

  openModal('modal-notifications');
}

export function toggleNotifSetting(key, checked) {
  store.appState.notifications[key] = Boolean(checked);
  saveAppState();
  evaluateSmartNotifications();
}

export async function requestBrowserPushPermission() {
  if (!('Notification' in window)) {
    showToast('Браузер не поддерживает системные уведомления');
    return;
  }
  const res = await Notification.requestPermission();
  const lbl = document.getElementById('push-status-label');
  if (lbl) lbl.textContent = res === 'granted' ? 'Системные уведомления включены' : 'Доступ к уведомлениям отклонен';
  showToast(res === 'granted' ? 'Уведомления включены' : 'Разрешение не выдано');
}

export function clearNotifHistory() {
  store.appState.notifications.history = [];
  saveAppState();
  const list = document.getElementById('notif-history-list');
  if (list) list.innerHTML = '<div class="py-3 text-center text-slate-400">История пуста</div>';
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
