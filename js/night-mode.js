// Ночной режим «для одной руки» — ультра-тёмный тёплый интерфейс с крупными кнопками кормления и сна

import { store, computeHereAndNowMetrics, getCurrentCaregiverName } from './state.js';
import { escapeHtml, formatMinutesHuman, formatClockHHMM, lockScrollForOverlay, unlockScrollForOverlay } from './utils.js';
import { setFeedingSubtype, toggleTimer, addQuickCareLog } from './tabs/journal.js';

let isNightModeOpen = false;
let nightDimLevel = 0; // 0 = стандартный тёплый, 1 = приглушённый, 2 = ультра-тёмный
let nightModeDismissedManually = false;

export function isAutoNightHours(date = new Date()) {
  const h = date.getHours();
  return h >= 23 || h < 6;
}

export function resetNightModeDismissal() {
  nightModeDismissedManually = false;
}

export function maybeAutoOpenNightMode({ forceOnLaunch = false, now = new Date() } = {}) {
  if (!store.currentAccountLogin) return false;
  const inNightWindow = isAutoNightHours(now);
  if (!inNightWindow) {
    // Сбрасываем ручной выход днём, чтобы следующей ночью в 23:00 авто-включение снова сработало
    nightModeDismissedManually = false;
    return false;
  }
  if (!store.appState?.autoNightAfter23) return false;
  if (forceOnLaunch) {
    nightModeDismissedManually = false;
  }
  if (isNightModeOpen || nightModeDismissedManually) return false;
  openNightMode();
  return true;
}

function formatElapsedTimer(startTs) {
  const sec = Math.max(0, Math.floor((Date.now() - startTs) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function openNightMode() {
  isNightModeOpen = true;
  const overlay = document.getElementById('night-mode-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
  }
  lockScrollForOverlay('night-mode-overlay');
  const metaTheme = document.getElementById('meta-theme-color');
  if (metaTheme) metaTheme.setAttribute('content', '#070302');
  renderNightMode();
}

export function closeNightMode() {
  isNightModeOpen = false;
  nightModeDismissedManually = true;
  const overlay = document.getElementById('night-mode-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
  }
  unlockScrollForOverlay('night-mode-overlay');
  const isDark = document.documentElement.classList.contains('dark');
  const metaTheme = document.getElementById('meta-theme-color');
  if (metaTheme) metaTheme.setAttribute('content', isDark ? '#020617' : '#FDFBF7');
}

export function cycleNightDimLevel() {
  nightDimLevel = (nightDimLevel + 1) % 3;
  renderNightMode();
}

export function nightSelectFeedingSubtype(sub) {
  setFeedingSubtype(sub);
  renderNightMode();
}

export function nightToggleTimer(kind) {
  toggleTimer(kind);
  renderNightMode();
}

export function nightQuickCare(type, title) {
  addQuickCareLog(type, title);
  renderNightMode();
}

export function updateNightModeClock() {
  if (!isNightModeOpen) return;
  const now = Date.now();
  const clockEl = document.getElementById('night-mode-clock');
  if (clockEl) clockEl.textContent = formatClockHHMM(now);

  const feedTimer = store.appState.timers?.feeding;
  const sleepTimer = store.appState.timers?.sleep;

  const feedClock = document.getElementById('night-feed-timer-text');
  if (feedClock) {
    feedClock.textContent = feedTimer?.active && feedTimer.startTime
      ? formatElapsedTimer(feedTimer.startTime)
      : '';
  }
  const sleepClock = document.getElementById('night-sleep-timer-text');
  if (sleepClock) {
    sleepClock.textContent = sleepTimer?.active && sleepTimer.startTime
      ? formatElapsedTimer(sleepTimer.startTime)
      : '';
  }
}

export function renderNightMode() {
  if (!isNightModeOpen) return;
  const overlay = document.getElementById('night-mode-overlay');
  if (!overlay) return;

  const appState = store.appState;
  const feedTimer = appState.timers?.feeding || { active: false, subtype: 'left' };
  const sleepTimer = appState.timers?.sleep || { active: false, sleepType: 'night' };
  const feedSub = feedTimer.subtype === 'right' || feedTimer.subtype === 'bottle' ? feedTimer.subtype : 'left';
  const metrics = computeHereAndNowMetrics();
  const caregiver = getCurrentCaregiverName();

  // Определяем прошлую и рекомендуемую грудь
  const lastBreast = (appState.journalLogs || []).find(l => l.type === 'feeding' && (l.subtype === 'left' || l.subtype === 'right'));
  const recommendedBreast = lastBreast ? (lastBreast.subtype === 'left' ? 'right' : 'left') : 'left';
  const lastBreastText = lastBreast
    ? `Прошлая: ${lastBreast.subtype === 'left' ? 'левая' : 'правая'} (${formatClockHHMM(lastBreast.startTime)})`
    : 'Начните с любой груди';

  const dimOpacityCls = nightDimLevel === 2 ? 'opacity-45' : nightDimLevel === 1 ? 'opacity-70' : 'opacity-100';
  const dimLabel = nightDimLevel === 2 ? 'Ультра-тёмный' : nightDimLevel === 1 ? 'Приглушённый' : 'Тёплый';

  const feedLabelMap = { left: 'Левая грудь', right: 'Правая грудь', bottle: 'Бутылочка' };
  const sinceFeedText = feedTimer.active
    ? 'Кормление идёт сейчас'
    : metrics.sinceFeedMin !== null
      ? `С кормления: ${formatMinutesHuman(metrics.sinceFeedMin)}`
      : 'Кормлений ещё нет';

  const sleepStatusText = sleepTimer.active
    ? `Спит: ${formatMinutesHuman(metrics.activeSleepMin)}`
    : metrics.wakeMin !== null
      ? `Бодрствует: ${formatMinutesHuman(metrics.wakeMin)}`
      : 'Сон не отмечен';

  const subBtn = (key, title) => {
    const isSel = feedSub === key;
    const isRec = (key === 'left' || key === 'right') && recommendedBreast === key;
    return `
      <button type="button" onclick="nightSelectFeedingSubtype('${key}')" class="relative flex-1 min-h-[56px] px-2 py-2.5 rounded-2xl border text-center transition active:scale-[0.98] ${isSel ? 'bg-[#361c11] border-[#b06b3d] text-[#f0ba8a]' : 'bg-[#120806] border-[#29150d] text-[#8f6343]'}">
        <div class="text-xs sm:text-sm font-extrabold leading-tight">${title}</div>
        ${isRec ? '<div class="text-[10px] font-semibold text-[#c97e46] mt-0.5">следующая</div>' : ''}
      </button>
    `;
  };

  overlay.innerHTML = `
    <div class="w-full max-w-md mx-auto flex-1 flex flex-col justify-between px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(1.25rem+env(safe-area-inset-bottom))] transition-opacity duration-200 ${dimOpacityCls}">
      <!-- Верхняя панель: часы, роль, яркость и выход -->
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span id="night-mode-clock" class="font-mono font-bold text-2xl tracking-wider text-[#d89d6b] tabular-nums">${formatClockHHMM(Date.now())}</span>
          <span class="px-2 py-0.5 rounded-lg bg-[#1a0d08] border border-[#2f180f] text-[11px] font-semibold text-[#9e6e4a] truncate">${escapeHtml(caregiver)}</span>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" onclick="cycleNightDimLevel()" class="px-3 py-2 rounded-xl bg-[#1a0d08] border border-[#301910] text-[11px] font-bold text-[#bd8253] active:scale-95 transition">
            ${dimLabel}
          </button>
          <button type="button" onclick="closeNightMode()" class="px-3 py-2 rounded-xl bg-[#1f0f09] border border-[#3b1f14] text-xs font-bold text-[#d89d6b] active:scale-95 transition">
            Выйти
          </button>
        </div>
      </div>

      <!-- Сводка текущего состояния -->
      <div class="my-4 rounded-3xl bg-[#110705] border border-[#26130b] p-4 space-y-2.5 text-center">
        <div class="text-[11px] uppercase tracking-widest font-bold text-[#7d5234]">Ночной режим • ${escapeHtml(appState.babyName || 'Малыш')}</div>
        <div class="grid grid-cols-2 gap-2 pt-1">
          <div class="rounded-2xl bg-[#170b07] border border-[#28150d] px-3 py-2.5">
            <div class="text-[10px] text-[#8a5d3d]">Кормление</div>
            <div class="text-xs sm:text-sm font-bold text-[#d89d6b] mt-0.5">${sinceFeedText}</div>
          </div>
          <div class="rounded-2xl bg-[#170b07] border border-[#28150d] px-3 py-2.5">
            <div class="text-[10px] text-[#8a5d3d]">Состояние</div>
            <div class="text-xs sm:text-sm font-bold text-[#d89d6b] mt-0.5">${sleepStatusText}</div>
          </div>
        </div>
        <div class="text-[11px] text-[#8f6343]">${escapeHtml(lastBreastText)}</div>
      </div>

      <!-- Нижняя зона под один большой палец -->
      <div class="space-y-3 mt-auto">
        <!-- Выбор груди / бутылочки -->
        <div class="flex items-center gap-2">
          ${subBtn('left', 'Левая грудь')}
          ${subBtn('right', 'Правая грудь')}
          ${subBtn('bottle', 'Бутылочка')}
        </div>

        <!-- Крупная кнопка Кормления -->
        <button type="button" onclick="nightToggleTimer('feeding')" class="w-full min-h-[76px] px-5 py-4 rounded-3xl border flex items-center justify-between gap-3 transition active:scale-[0.98] ${feedTimer.active ? 'bg-[#4a2011] border-[#d47a46] text-[#ffd4ad]' : 'bg-[#21100a] border-[#422215] text-[#e3a878]'}">
          <div class="text-left min-w-0">
            <div class="text-base sm:text-lg font-extrabold leading-tight">
              ${feedTimer.active ? 'Завершить кормление' : 'Начать кормление'}
            </div>
            <div class="text-xs text-[#b87f54] mt-0.5 truncate">
              ${feedLabelMap[feedSub] || 'Грудное кормление'}
            </div>
          </div>
          <span id="night-feed-timer-text" class="font-mono font-extrabold text-xl sm:text-2xl tabular-nums shrink-0 text-[#f2b885]">
            ${feedTimer.active && feedTimer.startTime ? formatElapsedTimer(feedTimer.startTime) : ''}
          </span>
        </button>

        <!-- Крупная кнопка Сна -->
        <button type="button" onclick="nightToggleTimer('sleep')" class="w-full min-h-[76px] px-5 py-4 rounded-3xl border flex items-center justify-between gap-3 transition active:scale-[0.98] ${sleepTimer.active ? 'bg-[#2a1912] border-[#b0764a] text-[#ffd4ad]' : 'bg-[#170b07] border-[#331a10] text-[#cfa078]'}">
          <div class="text-left min-w-0">
            <div class="text-base sm:text-lg font-extrabold leading-tight">
              ${sleepTimer.active ? 'Малыш проснулся' : 'Малыш уснул'}
            </div>
            <div class="text-xs text-[#9e6e4a] mt-0.5">
              ${sleepTimer.active ? 'Нажмите, чтобы остановить сон' : 'Ночной сон • авто-запись бодрствования'}
            </div>
          </div>
          <span id="night-sleep-timer-text" class="font-mono font-extrabold text-xl sm:text-2xl tabular-nums shrink-0 text-[#e8ae7d]">
            ${sleepTimer.active && sleepTimer.startTime ? formatElapsedTimer(sleepTimer.startTime) : ''}
          </span>
        </button>

        <!-- Быстрые ночные отметки подгузника -->
        <div class="grid grid-cols-2 gap-2 pt-1">
          <button type="button" onclick="nightQuickCare('diaper_wet', 'Мокрый подгузник')" class="min-h-[52px] px-3 py-3 rounded-2xl bg-[#130906] border border-[#2b160e] text-xs sm:text-sm font-bold text-[#b88156] active:scale-[0.98] transition">
            Мокрый подгузник
          </button>
          <button type="button" onclick="nightQuickCare('diaper_dirty', 'Грязный подгузник')" class="min-h-[52px] px-3 py-3 rounded-2xl bg-[#130906] border border-[#2b160e] text-xs sm:text-sm font-bold text-[#b88156] active:scale-[0.98] transition">
            Стул
          </button>
        </div>
      </div>
    </div>
  `;
}
