// Вкладка 1: Развитие по неделям (1–260 недель)

import { getWeekData, getInterpolatedWhoForMonth } from '../data.js';
import { MOM_SUPPORT_BY_WEEK } from '../data/mom-support.js';
import { store, calculateBabyAge } from '../state.js';
import { saveAppState } from '../firebase.js';
import { escapeHtml } from '../utils.js';

export function filterWeekRange(start, end) {
  store.appState.weekRangeStart = start;
  store.appState.weekRangeEnd = end;
  if (store.appState.selectedWeek < start || store.appState.selectedWeek > end) {
    store.appState.selectedWeek = start;
  }
  saveAppState();
  renderDevelopmentTab();
}

export function jumpToWeekNumber(val) {
  const w = Math.max(1, Math.min(260, parseInt(val, 10) || 1));
  selectWeek(w);
}

export function jumpToCurrentBabyWeek() {
  const cur = calculateBabyAge(store.appState.babyDob).weeks;
  selectWeek(cur);
}

export function selectWeek(weekNum) {
  const w = Math.max(1, Math.min(260, Number(weekNum) || 1));
  store.appState.selectedWeek = w;
  if (w <= 16) { store.appState.weekRangeStart = 1; store.appState.weekRangeEnd = 16; }
  else if (w <= 52) { store.appState.weekRangeStart = 17; store.appState.weekRangeEnd = 52; }
  else if (w <= 104) { store.appState.weekRangeStart = 53; store.appState.weekRangeEnd = 104; }
  else if (w <= 156) { store.appState.weekRangeStart = 105; store.appState.weekRangeEnd = 156; }
  else { store.appState.weekRangeStart = 157; store.appState.weekRangeEnd = 260; }
  saveAppState();
  renderDevelopmentTab();
}

export function toggleMilestone(weekNum, idx) {
  const key = `${weekNum}_${idx}`;
  store.appState.completedMilestones[key] = !store.appState.completedMilestones[key];
  saveAppState();
  renderDevelopmentTab();
}

export function renderDevelopmentTab() {
  const ribbon = document.getElementById('weeks-ribbon');
  const card = document.getElementById('stage-detail-card');
  if (!ribbon || !card) return;

  const appState = store.appState;
  const curBabyWeek = calculateBabyAge(appState.babyDob).weeks;
  const start = appState.weekRangeStart || 1;
  const end = appState.weekRangeEnd || 16;
  const sel = appState.selectedWeek || 1;

  document.querySelectorAll('.week-range-btn').forEach(btn => {
    const isCurrentRange = btn.getAttribute('onclick')?.includes(`(${start}, ${end})`);
    btn.className = isCurrentRange
      ? 'week-range-btn px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-500 text-white shadow-2xs transition shrink-0'
      : 'week-range-btn px-3 py-1.5 rounded-xl text-xs font-bold bg-warmgray dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition shrink-0';
  });

  const ribbonItems = [];
  for (let w = start; w <= end; w++) {
    const isSelected = w === sel;
    const isTodayWeek = w === curBabyWeek;
    ribbonItems.push(`
      <button type="button" onclick="selectWeek(${w})" class="min-w-[54px] py-2 px-2.5 rounded-2xl flex flex-col items-center justify-center shrink-0 transition ${
        isSelected
          ? 'bg-rose-500 text-white shadow-sm font-extrabold'
          : isTodayWeek
            ? 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-300 border border-rose-200 dark:border-rose-800 font-bold'
            : 'bg-warmgray/70 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-stone-200/70 dark:hover:bg-slate-700 font-semibold'
      }">
        <span class="text-[10px] opacity-80">нед.</span>
        <span class="text-sm">${w}</span>
      </button>
    `);
  }
  ribbon.innerHTML = ribbonItems.join('');

  const info = getWeekData(sel);
  const who = getInterpolatedWhoForMonth(info.approxMonths, appState.babyGender);
  const prevWeek = Math.max(1, sel - 1);
  const nextWeek = Math.min(260, sel + 1);

  const items = Array.isArray(info.checklistItems) && info.checklistItems.length > 0
    ? info.checklistItems
    : info.checklist.map(text => ({ category: '', text }));
  const doneCount = items.reduce((acc, _it, idx) => acc + (appState.completedMilestones[`${sel}_${idx}`] ? 1 : 0), 0);

  const categoryColorMap = {
    'Моторика': 'text-emerald-600 dark:text-emerald-400',
    'Речь и контакт': 'text-indigo-600 dark:text-indigo-400',
    'Игра и сенсорика': 'text-amber-600 dark:text-amber-400',
    'Режим и быт': 'text-sky-600 dark:text-sky-400',
    'Память и забота': 'text-rose-600 dark:text-rose-400'
  };

  const supportIdx = Math.max(0, Math.min(MOM_SUPPORT_BY_WEEK.length - 1, sel - 1));
  const supportCard = MOM_SUPPORT_BY_WEEK[supportIdx];

  card.innerHTML = `
    <div class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-rose-500 via-rose-500 to-amber-500 text-white p-5 sm:p-7 shadow-md space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <span class="px-3 py-1 rounded-full bg-white/20 backdrop-blur-xs text-xs font-extrabold tracking-wide">
            Неделя ${info.week} из 260
          </span>
          <span class="px-3 py-1 rounded-full bg-black/15 text-xs font-semibold">
            ${escapeHtml(info.ageContext)}
          </span>
          ${info.isLeap ? `<span class="px-2.5 py-1 rounded-full bg-amber-300 text-slate-900 text-[11px] font-extrabold">Скачок роста</span>` : ''}
        </div>
        <div class="flex items-center gap-1.5">
          <button type="button" onclick="selectWeek(${prevWeek})" aria-label="Предыдущая неделя" class="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center transition">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <button type="button" onclick="selectWeek(${nextWeek})" aria-label="Следующая неделя" class="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center transition">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        </div>
      </div>

      <div class="space-y-2">
        <h2 class="font-display font-extrabold text-xl sm:text-2xl leading-snug">${escapeHtml(info.title)}</h2>
        <p class="text-xs sm:text-sm text-white/90 leading-relaxed">${escapeHtml(info.summary)}</p>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
        <div class="p-3 rounded-2xl bg-white/15 backdrop-blur-xs border border-white/15">
          <div class="text-[10px] uppercase tracking-wider text-white/80 font-semibold">Сон по ВОЗ</div>
          <div class="font-display font-extrabold text-xs sm:text-sm mt-0.5">${escapeHtml(info.sleepNorm)}</div>
        </div>
        <div class="p-3 rounded-2xl bg-white/15 backdrop-blur-xs border border-white/15">
          <div class="text-[10px] uppercase tracking-wider text-white/80 font-semibold">Бодрствование</div>
          <div class="font-display font-extrabold text-xs sm:text-sm mt-0.5">${escapeHtml(info.wakeWindow)}</div>
        </div>
        <div class="p-3 rounded-2xl bg-white/15 backdrop-blur-xs border border-white/15">
          <div class="text-[10px] uppercase tracking-wider text-white/80 font-semibold">Вес (ВОЗ)</div>
          <div class="font-display font-extrabold text-xs sm:text-sm mt-0.5">${escapeHtml(who.weightRange)}</div>
        </div>
        <div class="p-3 rounded-2xl bg-white/15 backdrop-blur-xs border border-white/15">
          <div class="text-[10px] uppercase tracking-wider text-white/80 font-semibold">Рост (ВОЗ)</div>
          <div class="font-display font-extrabold text-xs sm:text-sm mt-0.5">${escapeHtml(who.heightRange)}</div>
        </div>
      </div>
    </div>

    <div class="bg-white dark:bg-slate-900 rounded-3xl border border-stone-200/70 dark:border-slate-800 p-4 sm:p-6 space-y-3 shadow-2xs">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <h3 class="font-display font-extrabold text-sm sm:text-base text-slate-900 dark:text-slate-100">Чек-лист недели: навыки и игры</h3>
          <span class="text-[11px] font-bold text-slate-500 dark:text-slate-400">${doneCount} / ${items.length}</span>
        </div>
        <span class="text-xs text-slate-400">Кормления: ${escapeHtml(info.feedInterval)}</span>
      </div>
      <div class="space-y-2">
        ${items.map((item, idx) => {
          const checked = Boolean(appState.completedMilestones[`${sel}_${idx}`]);
          const catColor = categoryColorMap[item.category] || 'text-slate-400';
          return `
            <button type="button" role="checkbox" aria-checked="${checked ? 'true' : 'false'}" onclick="toggleMilestone(${sel}, ${idx})" class="w-full text-left flex items-start gap-3 p-3 rounded-2xl bg-warmgray/60 dark:bg-slate-800/70 hover:bg-rose-50/60 dark:hover:bg-slate-800 active:scale-[0.99] cursor-pointer select-none transition">
              <span aria-hidden="true" class="mt-0.5 w-[18px] h-[18px] rounded-md border flex items-center justify-center shrink-0 transition ${
                checked
                  ? 'bg-rose-500 border-rose-500 text-white'
                  : 'bg-white dark:bg-slate-900 border-stone-300 dark:border-slate-600'
              }">
                ${checked ? '<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
              </span>
              <span class="min-w-0 flex-1 block space-y-0.5">
                ${item.category ? `<span class="block text-[10px] font-extrabold uppercase tracking-wider ${checked ? 'text-slate-400' : catColor}">${escapeHtml(item.category)}</span>` : ''}
                <span class="block text-xs sm:text-sm leading-snug ${checked ? 'line-through text-slate-400' : 'text-slate-700 dark:text-slate-200'}">${escapeHtml(item.text)}</span>
              </span>
            </button>
          `;
        }).join('')}
      </div>
    </div>

    <div class="bg-gradient-to-br from-rose-50/90 via-amber-50/50 to-warmgray/70 dark:from-rose-950/35 dark:via-slate-900 dark:to-slate-900 rounded-3xl border border-rose-200/70 dark:border-rose-900/40 p-4 sm:p-6 space-y-3 shadow-2xs">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-7 h-7 rounded-xl bg-rose-100 dark:bg-rose-950/80 text-rose-500 flex items-center justify-center shrink-0">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>
          </span>
          <h3 class="font-display font-extrabold text-sm sm:text-base text-slate-900 dark:text-slate-100 truncate">Поддержка для мамы</h3>
        </div>
        <span class="text-[11px] font-bold text-rose-500/80 dark:text-rose-300/80 shrink-0">Неделя ${sel}</span>
      </div>

      <p class="font-display font-bold text-sm sm:text-base text-slate-800 dark:text-slate-100 leading-relaxed">
        «${escapeHtml(supportCard.quote)}»
      </p>

      <div class="p-3 rounded-2xl bg-white/75 dark:bg-slate-800/75 border border-rose-100/80 dark:border-slate-700/80 text-xs text-slate-700 dark:text-slate-200 leading-relaxed">
        <span class="font-bold text-rose-600 dark:text-rose-300">Маленький шаг сегодня:</span>
        ${escapeHtml(supportCard.tip)}
      </div>

      <p class="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
        Если подавленность, сильная тревога или бессилие держатся дольше двух недель — не оставайтесь с этим наедине: расскажите близким и обратитесь за поддержкой к врачу или перинатальному психологу.
      </p>
    </div>
  `;
}
