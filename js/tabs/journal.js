// Вкладка 2: Журнал событий, живые таймеры, прикорм, ручное добавление/редактирование и 24-часовая аналитика ритма

import { SOLIDS_PRESETS } from '../data.js';
import { store, hooks } from '../state.js';
import {
  escapeHtml,
  getTodayIso,
  formatDateRu,
  toDatetimeLocalValue,
  parseIsoToLocalDayBounds,
  formatMinutesHuman,
  formatClockHHMM,
  openModal,
  closeModal,
  showToast
} from '../utils.js';
import { saveAppState } from '../firebase.js';

export function setFeedingSubtype(sub) {
  store.appState.timers.feeding.subtype = sub;
  renderJournalTimersUI();
  saveAppState();
}

export function setSolidsCategory(cat) {
  const presetsWrap = document.getElementById('feeding-solids-presets');
  if (!presetsWrap) return;
  const items = SOLIDS_PRESETS[cat] || SOLIDS_PRESETS['Овощи'];
  presetsWrap.innerHTML = items.map(p => `
    <button type="button" onclick="pickSolidsQuickProduct('${p.replace(/'/g, "\\'")}')" class="px-2.5 py-1 rounded-lg bg-white dark:bg-slate-900 hover:bg-rose-50 dark:hover:bg-rose-950/50 border border-stone-200 dark:border-slate-700 text-[11px] font-semibold text-slate-700 dark:text-slate-200 shrink-0 transition">
      ${escapeHtml(p)}
    </button>
  `).join('');
}

export function pickSolidsQuickProduct(prodName) {
  const inp = document.getElementById('feeding-solids-product');
  if (inp) inp.value = prodName;
}

function buildSolidsSummary() {
  const cat = document.getElementById('feeding-solids-category')?.value || 'Овощи';
  const texture = document.getElementById('feeding-solids-texture')?.value || 'Пюре';
  const prod = (document.getElementById('feeding-solids-product')?.value || '').trim() || cat;
  const amount = document.getElementById('feeding-solids-amount')?.value || '';
  const unit = document.getElementById('feeding-solids-unit')?.value || 'г';
  const intro = document.getElementById('feeding-solids-intro')?.value || 'Знакомый';
  const appetite = document.getElementById('feeding-solids-appetite')?.value || 'С удовольствием';
  const reaction = document.getElementById('feeding-solids-reaction')?.value || 'Без реакции';
  const note = (document.getElementById('feeding-solids-note')?.value || '').trim();

  const parts = [`Прикорм: ${prod} (${cat}, ${texture.toLowerCase()})`];
  if (amount) parts.push(`${amount} ${unit}`);
  if (intro !== 'Знакомый') parts.push(intro);
  parts.push(`аппетит: ${appetite.toLowerCase()}`);
  if (reaction !== 'Без реакции') parts.push(`реакция: ${reaction.toLowerCase()}`);
  if (note) parts.push(note);
  return parts.join(' • ');
}

export function saveSolidsFeedingNow() {
  const now = Date.now();
  const title = buildSolidsSummary();
  store.appState.journalLogs.unshift({
    id: 'log_' + now,
    type: 'feeding_solids',
    subtype: 'solids',
    title,
    startTime: now,
    endTime: now,
    durationMin: 0
  });
  const prodInp = document.getElementById('feeding-solids-product');
  const amtInp = document.getElementById('feeding-solids-amount');
  const noteInp = document.getElementById('feeding-solids-note');
  if (prodInp) prodInp.value = '';
  if (amtInp) amtInp.value = '';
  if (noteInp) noteInp.value = '';

  store.selectedJournalDateIso = getTodayIso();
  saveAppState();
  renderJournalTab();
  hooks.renderHereAndNowWidget();
  showToast('Прикорм записан в журнал');
}

export function detectSleepTypeByHour(ts) {
  const h = new Date(ts || Date.now()).getHours();
  return (h >= 19 || h < 7) ? 'night' : 'day';
}

export function toggleActiveSleepType() {
  const cur = store.appState.timers.sleep.sleepType === 'night' ? 'day' : 'night';
  store.appState.timers.sleep.sleepType = cur;
  renderJournalTimersUI();
  saveAppState();
  showToast(cur === 'night' ? 'Установлен ночной сон' : 'Установлен дневной сон');
}

export function toggleTimer(kind) {
  const now = Date.now();
  const timer = store.appState.timers[kind];
  if (!timer) return;

  if (!timer.active) {
    timer.active = true;
    timer.startTime = now;
    if (kind === 'sleep') {
      timer.sleepType = detectSleepTypeByHour(now);
    }
    saveAppState();
    renderJournalTimersUI();
    hooks.renderHereAndNowWidget();
    hooks.evaluateSmartNotifications();
    showToast(kind === 'feeding' ? 'Таймер кормления запущен' : kind === 'sleep' ? 'Таймер сна запущен' : 'Таймер прогулки запущен');
  } else {
    const startTs = timer.startTime || now;
    const durationMin = Math.max(1, Math.round((now - startTs) / 60000));
    timer.active = false;
    timer.startTime = null;

    if (kind === 'feeding') {
      const sub = timer.subtype || 'left';
      let title = 'Кормление';
      let logType = 'feeding';
      if (sub === 'left') {
        title = `Левая грудь (${durationMin} мин)`;
        timer.subtype = 'right';
      } else if (sub === 'right') {
        title = `Правая грудь (${durationMin} мин)`;
        timer.subtype = 'left';
      } else if (sub === 'bottle') {
        const content = document.getElementById('feeding-bottle-content')?.value || 'Смесь';
        const ml = document.getElementById('feeding-amount-input')?.value || '';
        title = `Бутылочка: ${content}${ml ? `, ${ml} мл` : ''} (${durationMin} мин)`;
      } else if (sub === 'solids') {
        logType = 'feeding_solids';
        title = buildSolidsSummary();
      }
      store.appState.journalLogs.unshift({
        id: 'log_' + now,
        type: logType,
        subtype: sub,
        title,
        startTime: startTs,
        endTime: now,
        durationMin
      });
    } else if (kind === 'sleep') {
      const sType = timer.sleepType || detectSleepTypeByHour(startTs);
      const sLabel = sType === 'night' ? 'Ночной сон' : 'Дневной сон';
      store.appState.journalLogs.unshift({
        id: 'log_' + now,
        type: 'sleep',
        sleepType: sType,
        title: `${sLabel} (${formatMinutesHuman(durationMin)})`,
        startTime: startTs,
        endTime: now,
        durationMin
      });
    } else if (kind === 'walk') {
      store.appState.journalLogs.unshift({
        id: 'log_' + now,
        type: 'walk',
        title: `Прогулка (${formatMinutesHuman(durationMin)})`,
        startTime: startTs,
        endTime: now,
        durationMin
      });
    }

    store.selectedJournalDateIso = getTodayIso();
    saveAppState();
    renderJournalTab();
    hooks.renderHereAndNowWidget();
    hooks.evaluateSmartNotifications();
    showToast('Запись сохранена в журнал');
  }
}

export function addQuickCareLog(type, title) {
  const now = Date.now();
  store.appState.journalLogs.unshift({
    id: 'log_' + now,
    type,
    title,
    startTime: now,
    endTime: now,
    durationMin: 0
  });
  store.selectedJournalDateIso = getTodayIso();
  saveAppState();
  renderJournalTab();
  hooks.renderHereAndNowWidget();
  showToast(`Отмечено: ${title}`);
}

export function openManualLogModal() {
  const idInp = document.getElementById('manual-log-id');
  const titleEl = document.getElementById('modal-manual-log-title');
  const submitBtn = document.getElementById('manual-log-submit-btn');
  const typeSel = document.getElementById('manual-log-type');
  const subSel = document.getElementById('manual-log-subtype');
  const sleepSel = document.getElementById('manual-log-sleeptype');
  const startInp = document.getElementById('manual-log-start');
  const endInp = document.getElementById('manual-log-end');
  const durInp = document.getElementById('manual-log-duration');
  const noteInp = document.getElementById('manual-log-note');
  const liveChk = document.getElementById('manual-log-live-timer');
  const warnEl = document.getElementById('manual-log-time-warning');

  if (idInp) idInp.value = '';
  if (titleEl) titleEl.textContent = 'Добавить запись в журнал';
  if (submitBtn) submitBtn.textContent = 'Добавить в журнал';
  if (typeSel) typeSel.value = 'feeding';
  if (subSel) subSel.value = store.appState.timers?.feeding?.subtype === 'right' ? 'right' : 'left';
  if (sleepSel) sleepSel.value = 'auto';
  if (noteInp) noteInp.value = '';
  if (liveChk) liveChk.checked = false;
  if (warnEl) warnEl.classList.add('hidden');

  const now = Date.now();
  const startTs = now - 20 * 60000;
  if (startInp) startInp.value = toDatetimeLocalValue(startTs);
  if (endInp) endInp.value = toDatetimeLocalValue(now);
  if (durInp) durInp.value = '20';

  onManualLogTypeChange();
  openModal('modal-manual-log');
}

export function openEditJournalLogModal(logId) {
  const log = (store.appState.journalLogs || []).find(l => l.id === logId);
  if (!log) return;

  const idInp = document.getElementById('manual-log-id');
  const titleEl = document.getElementById('modal-manual-log-title');
  const submitBtn = document.getElementById('manual-log-submit-btn');
  const typeSel = document.getElementById('manual-log-type');
  const subSel = document.getElementById('manual-log-subtype');
  const sleepSel = document.getElementById('manual-log-sleeptype');
  const startInp = document.getElementById('manual-log-start');
  const endInp = document.getElementById('manual-log-end');
  const durInp = document.getElementById('manual-log-duration');
  const noteInp = document.getElementById('manual-log-note');
  const liveChk = document.getElementById('manual-log-live-timer');
  const warnEl = document.getElementById('manual-log-time-warning');

  if (idInp) idInp.value = log.id;
  if (titleEl) titleEl.textContent = 'Редактировать запись';
  if (submitBtn) submitBtn.textContent = 'Сохранить изменения';
  if (typeSel) typeSel.value = log.type || 'feeding';
  if (subSel) subSel.value = log.subtype || 'general';
  if (sleepSel) sleepSel.value = log.sleepType || 'auto';
  if (liveChk) liveChk.checked = false;
  if (warnEl) warnEl.classList.add('hidden');

  const sTs = log.startTime || Date.now();
  const dur = Number(log.durationMin) || 0;
  const eTs = log.endTime || (sTs + dur * 60000);
  if (startInp) startInp.value = toDatetimeLocalValue(sTs);
  if (endInp) endInp.value = toDatetimeLocalValue(eTs);
  if (durInp) durInp.value = String(dur);
  if (noteInp) noteInp.value = log.title || '';

  onManualLogTypeChange();
  openModal('modal-manual-log');
}

export function onManualLogTypeChange() {
  const typeVal = document.getElementById('manual-log-type')?.value || 'feeding';
  const isEditing = Boolean(document.getElementById('manual-log-id')?.value);
  const isTimerSupported = ['feeding', 'feeding_solids', 'sleep', 'walk'].includes(typeVal);
  const subWrap = document.getElementById('manual-log-subtype-wrap');
  const sleepWrap = document.getElementById('manual-log-sleeptype-wrap');
  const liveWrap = document.getElementById('manual-log-live-wrap');
  const liveChk = document.getElementById('manual-log-live-timer');

  if (subWrap) subWrap.classList.toggle('hidden', typeVal !== 'feeding');
  if (sleepWrap) sleepWrap.classList.toggle('hidden', typeVal !== 'sleep');
  if (liveWrap) liveWrap.classList.toggle('hidden', isEditing || !isTimerSupported);
  if ((isEditing || !isTimerSupported) && liveChk) liveChk.checked = false;

  onManualLogLiveToggle();
}

export function onManualLogLiveToggle() {
  const isEditing = Boolean(document.getElementById('manual-log-id')?.value);
  const isLive = !isEditing && Boolean(document.getElementById('manual-log-live-timer')?.checked);
  const endDurWrap = document.getElementById('manual-log-end-duration-wrap');
  const noteWrap = document.getElementById('manual-log-note-wrap');
  const previewEl = document.getElementById('manual-log-live-preview');
  const warnEl = document.getElementById('manual-log-time-warning');
  const submitBtn = document.getElementById('manual-log-submit-btn');

  if (endDurWrap) endDurWrap.classList.toggle('hidden', isLive);
  if (noteWrap) noteWrap.classList.toggle('hidden', isLive);

  if (submitBtn) {
    if (isLive) {
      submitBtn.textContent = 'Запустить таймер с этого времени';
      submitBtn.className = 'w-full min-h-[44px] py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-xs sm:text-sm font-bold transition';
    } else {
      submitBtn.textContent = isEditing ? 'Сохранить изменения' : 'Добавить в журнал';
      submitBtn.className = 'w-full min-h-[44px] py-2.5 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs sm:text-sm font-bold transition';
    }
  }

  if (!isLive) {
    if (previewEl) previewEl.classList.add('hidden');
    if (warnEl) warnEl.classList.add('hidden');
    return;
  }

  const startVal = document.getElementById('manual-log-start')?.value;
  const sTs = startVal ? new Date(startVal).getTime() : Date.now();
  const now = Date.now();

  if (Number.isNaN(sTs)) return;
  if (sTs > now + 60000) {
    if (previewEl) previewEl.classList.add('hidden');
    if (warnEl) {
      warnEl.textContent = 'Время начала для таймера не может быть в будущем';
      warnEl.classList.remove('hidden');
    }
  } else {
    if (warnEl) warnEl.classList.add('hidden');
    if (previewEl) {
      const elapsedMin = Math.max(0, Math.round((now - sTs) / 60000));
      previewEl.textContent = elapsedMin > 0
        ? `Отсчёт пойдёт с ${formatClockHHMM(sTs)} (уже прошло ${formatMinutesHuman(elapsedMin)})`
        : `Отсчёт начнётся с ${formatClockHHMM(sTs)}`;
      previewEl.classList.remove('hidden');
    }
  }
}

export function syncManualLogEndFromStartOrDuration() {
  const isLive = Boolean(document.getElementById('manual-log-live-timer')?.checked);
  if (isLive) {
    onManualLogLiveToggle();
    return;
  }
  const startVal = document.getElementById('manual-log-start')?.value;
  const durVal = Math.max(0, parseInt(document.getElementById('manual-log-duration')?.value || '0', 10) || 0);
  const endInp = document.getElementById('manual-log-end');
  const warnEl = document.getElementById('manual-log-time-warning');
  if (!startVal || !endInp) return;

  const sTs = new Date(startVal).getTime();
  if (!Number.isNaN(sTs)) {
    endInp.value = toDatetimeLocalValue(sTs + durVal * 60000);
    if (warnEl) warnEl.classList.add('hidden');
  }
}

export function syncManualLogDurationFromEnd() {
  const startVal = document.getElementById('manual-log-start')?.value;
  const endVal = document.getElementById('manual-log-end')?.value;
  const durInp = document.getElementById('manual-log-duration');
  const warnEl = document.getElementById('manual-log-time-warning');
  if (!startVal || !endVal || !durInp) return;

  const sTs = new Date(startVal).getTime();
  const eTs = new Date(endVal).getTime();
  if (Number.isNaN(sTs) || Number.isNaN(eTs)) return;

  if (eTs < sTs) {
    if (warnEl) {
      warnEl.textContent = 'Время окончания не может быть раньше времени начала';
      warnEl.classList.remove('hidden');
    }
  } else {
    if (warnEl) warnEl.classList.add('hidden');
    durInp.value = String(Math.round((eTs - sTs) / 60000));
  }
}

export function saveManualLog(e) {
  if (e) e.preventDefault();
  const editId = document.getElementById('manual-log-id')?.value || '';
  const type = document.getElementById('manual-log-type')?.value || 'feeding';
  const subtype = document.getElementById('manual-log-subtype')?.value || 'general';
  const sleepTypeChoice = document.getElementById('manual-log-sleeptype')?.value || 'auto';
  const startVal = document.getElementById('manual-log-start')?.value;
  const endVal = document.getElementById('manual-log-end')?.value;
  const rawDur = Math.max(0, parseInt(document.getElementById('manual-log-duration')?.value || '0', 10) || 0);
  const rawNote = (document.getElementById('manual-log-note')?.value || '').trim();
  const isLiveTimer = !editId && Boolean(document.getElementById('manual-log-live-timer')?.checked) && ['feeding', 'feeding_solids', 'sleep', 'walk'].includes(type);

  const parsedStart = startVal ? new Date(startVal).getTime() : Date.now();
  const startTime = Number.isNaN(parsedStart) ? Date.now() : parsedStart;
  const warnEl = document.getElementById('manual-log-time-warning');

  if (isLiveTimer) {
    if (startTime > Date.now() + 60000) {
      if (warnEl) {
        warnEl.textContent = 'Время начала для таймера не может быть в будущем';
        warnEl.classList.remove('hidden');
      }
      return;
    }
    const timerKey = type === 'feeding_solids' ? 'feeding' : type;
    const timer = store.appState.timers[timerKey];
    if (timer) {
      timer.active = true;
      timer.startTime = startTime;
      if (timerKey === 'feeding') {
        timer.subtype = type === 'feeding_solids'
          ? 'solids'
          : (subtype === 'left' || subtype === 'right' || subtype === 'bottle' ? subtype : 'left');
      } else if (timerKey === 'sleep') {
        timer.sleepType = sleepTypeChoice === 'auto' ? detectSleepTypeByHour(startTime) : sleepTypeChoice;
      }
    }
    closeModal('modal-manual-log');
    saveAppState();
    renderJournalTab();
    hooks.renderHereAndNowWidget();
    hooks.evaluateSmartNotifications();
    const timerLabels = { feeding: 'кормления', sleep: 'сна', walk: 'прогулки' };
    showToast(`Таймер ${timerLabels[timerKey] || ''} запущен с ${formatClockHHMM(startTime)}`);
    return;
  }

  let endTime = endVal ? new Date(endVal).getTime() : (startTime + rawDur * 60000);
  if (Number.isNaN(endTime)) endTime = startTime + rawDur * 60000;
  if (endTime < startTime) {
    if (warnEl) {
      warnEl.textContent = 'Время окончания не может быть раньше времени начала';
      warnEl.classList.remove('hidden');
    }
    return;
  }

  const durationMin = endVal ? Math.max(0, Math.round((endTime - startTime) / 60000)) : rawDur;
  const resolvedSleepType = type === 'sleep'
    ? (sleepTypeChoice === 'auto' ? detectSleepTypeByHour(startTime) : sleepTypeChoice)
    : undefined;

  const defaultLabels = {
    feeding: subtype === 'left' ? 'Левая грудь' : subtype === 'right' ? 'Правая грудь' : subtype === 'bottle' ? 'Бутылочка' : 'Кормление',
    feeding_solids: 'Прикорм',
    sleep: resolvedSleepType === 'night' ? 'Ночной сон' : 'Дневной сон',
    walk: 'Прогулка',
    diaper_wet: 'Мокрый подгузник',
    diaper_dirty: 'Грязный подгузник',
    bath: 'Купание',
    vitamin: 'Витамин D3',
    pumping: 'Сцеживание'
  };

  const title = rawNote || `${defaultLabels[type] || 'Событие'}${durationMin > 0 ? ` (${formatMinutesHuman(durationMin)})` : ''}`;

  if (editId) {
    const idx = store.appState.journalLogs.findIndex(l => l.id === editId);
    if (idx !== -1) {
      store.appState.journalLogs[idx] = {
        ...store.appState.journalLogs[idx],
        type,
        subtype: type === 'feeding' ? subtype : (type === 'feeding_solids' ? 'solids' : undefined),
        sleepType: resolvedSleepType,
        title,
        startTime,
        endTime,
        durationMin
      };
    }
  } else {
    store.appState.journalLogs.unshift({
      id: 'log_' + Date.now(),
      type,
      subtype: type === 'feeding' ? subtype : (type === 'feeding_solids' ? 'solids' : undefined),
      sleepType: resolvedSleepType,
      title,
      startTime,
      endTime,
      durationMin
    });
  }

  const dStart = new Date(startTime);
  store.selectedJournalDateIso = `${dStart.getFullYear()}-${String(dStart.getMonth() + 1).padStart(2, '0')}-${String(dStart.getDate()).padStart(2, '0')}`;

  store.appState.journalLogs.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  closeModal('modal-manual-log');
  saveAppState();
  renderJournalTab();
  hooks.renderHereAndNowWidget();
  hooks.evaluateSmartNotifications();
  showToast(editId ? 'Запись обновлена' : 'Запись добавлена в журнал');
}

export function shiftJournalDate(deltaDays) {
  const { dateObj } = parseIsoToLocalDayBounds(store.selectedJournalDateIso);
  dateObj.setDate(dateObj.getDate() + deltaDays);
  const todayIso = getTodayIso();
  const nextIso = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
  if (nextIso > todayIso) return;
  store.selectedJournalDateIso = nextIso;
  renderJournalTab();
}

export function resetJournalDateToToday() {
  store.selectedJournalDateIso = getTodayIso();
  renderJournalTab();
}

export function jumpToLatestJournalDate() {
  const logs = store.appState.journalLogs || [];
  if (logs.length === 0) return;
  let latestTs = 0;
  for (const l of logs) {
    const t = Number(l?.startTime || l?.endTime || 0);
    if (t > latestTs) latestTs = t;
  }
  if (!latestTs) return;
  const d = new Date(latestTs);
  store.selectedJournalDateIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  renderJournalTab();
}

export function deleteJournalLog(logId) {
  store.appState.journalLogs = (store.appState.journalLogs || []).filter(l => l.id !== logId);
  saveAppState();
  renderJournalTab();
  hooks.renderHereAndNowWidget();
  showToast('Запись удалена');
}

export function setRhythmDays(days) {
  store.appState.rhythmDays = days === 14 ? 14 : 7;
  saveAppState();
  renderRhythmAnalytics();
}

export function renderJournalTimersUI() {
  const appState = store.appState;
  const feedSub = appState.timers?.feeding?.subtype || 'left';
  document.querySelectorAll('.feed-sub-btn').forEach(btn => {
    const isSel = btn.getAttribute('data-feed-sub') === feedSub;
    btn.className = isSel
      ? 'feed-sub-btn py-1.5 rounded-lg text-[11px] font-bold bg-rose-500 text-white transition'
      : 'feed-sub-btn py-1.5 rounded-lg text-[11px] font-bold bg-warmgray dark:bg-slate-800 text-slate-600 dark:text-slate-300 transition';
  });

  const bottleWrap = document.getElementById('feeding-bottle-wrap');
  const solidsWrap = document.getElementById('feeding-solids-wrap');
  if (bottleWrap) bottleWrap.classList.toggle('hidden', feedSub !== 'bottle');
  if (solidsWrap) solidsWrap.classList.toggle('hidden', feedSub !== 'solids');
  if (feedSub === 'solids') {
    const cat = document.getElementById('feeding-solids-category')?.value || 'Овощи';
    setSolidsCategory(cat);
  }

  const hintEl = document.getElementById('feeding-breast-hint');
  if (hintEl) {
    const lastBreast = (appState.journalLogs || []).find(l => l.type === 'feeding' && (l.subtype === 'left' || l.subtype === 'right'));
    if (lastBreast) {
      const prevSide = lastBreast.subtype === 'left' ? 'левая' : 'правая';
      const nextSub = lastBreast.subtype === 'left' ? 'right' : 'left';
      const nextSide = nextSub === 'left' ? 'левая' : 'правая';
      hintEl.innerHTML = `
        <span class="truncate">Прошлая: <strong>${prevSide}</strong> • Следующая: <strong>${nextSide} грудь</strong></span>
        ${feedSub !== nextSub ? `<button type="button" onclick="setFeedingSubtype('${nextSub}')" class="px-2 py-0.5 rounded-lg bg-rose-500 text-white text-[10px] font-bold shrink-0">Выбрать</button>` : ''}
      `;
    } else {
      hintEl.innerHTML = `<span>Подсказка: чередуйте <strong>левую</strong> и <strong>правую</strong> грудь</span>`;
    }
  }

  const sleepBadge = document.getElementById('sleep-type-badge');
  const autoSleepType = appState.timers?.sleep?.active
    ? (appState.timers.sleep.sleepType || 'day')
    : detectSleepTypeByHour(Date.now());
  if (sleepBadge) {
    sleepBadge.textContent = autoSleepType === 'night' ? 'Ночной сон' : 'Дневной сон';
  }

  const btnFeed = document.getElementById('btn-toggle-feeding');
  const btnSleep = document.getElementById('btn-toggle-sleep');
  const btnWalk = document.getElementById('btn-toggle-walk');

  if (btnFeed) {
    btnFeed.textContent = appState.timers.feeding.active ? 'Завершить кормление' : 'Начать кормление';
    btnFeed.className = appState.timers.feeding.active
      ? 'w-full min-h-[40px] py-2 rounded-xl bg-slate-900 dark:bg-rose-600 text-white text-xs font-bold transition animate-pulse'
      : 'w-full min-h-[40px] py-2 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold transition';
  }
  if (btnSleep) {
    btnSleep.textContent = appState.timers.sleep.active ? 'Малыш проснулся' : 'Малыш уснул';
    btnSleep.className = appState.timers.sleep.active
      ? 'w-full min-h-[40px] py-2 rounded-xl bg-slate-900 dark:bg-indigo-600 text-white text-xs font-bold transition animate-pulse'
      : 'w-full min-h-[40px] py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-xs font-bold transition';
  }
  if (btnWalk) {
    btnWalk.textContent = appState.timers.walk.active ? 'Завершить прогулку' : 'Начать прогулку';
    btnWalk.className = appState.timers.walk.active
      ? 'w-full min-h-[40px] py-2 rounded-xl bg-slate-900 dark:bg-emerald-600 text-white text-xs font-bold transition animate-pulse'
      : 'w-full min-h-[40px] py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition';
  }

  updateLiveTimersClock();
}

export function updateLiveTimersClock() {
  const now = Date.now();
  const appState = store.appState;
  const formatTimer = (startTs) => {
    const sec = Math.max(0, Math.floor((now - startTs) / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const feedEl = document.getElementById('timer-feeding-display');
  const sleepEl = document.getElementById('timer-sleep-display');
  const walkEl = document.getElementById('timer-walk-display');

  if (feedEl) feedEl.textContent = appState.timers?.feeding?.active ? formatTimer(appState.timers.feeding.startTime) : '00:00';
  if (sleepEl) sleepEl.textContent = appState.timers?.sleep?.active ? formatTimer(appState.timers.sleep.startTime) : '00:00';
  if (walkEl) walkEl.textContent = appState.timers?.walk?.active ? formatTimer(appState.timers.walk.startTime) : '00:00';
}

export function renderRhythmAnalytics() {
  const wrap = document.getElementById('rhythm-analytics-container');
  if (!wrap) return;

  const appState = store.appState;
  const daysCount = appState.rhythmDays === 14 ? 14 : 7;
  const btn7 = document.getElementById('rhythm-btn-7');
  const btn14 = document.getElementById('rhythm-btn-14');
  if (btn7) btn7.className = daysCount === 7 ? 'px-2.5 py-1 rounded-lg text-xs font-bold bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs transition' : 'px-2.5 py-1 rounded-lg text-xs font-bold text-slate-500 dark:text-slate-400 transition';
  if (btn14) btn14.className = daysCount === 14 ? 'px-2.5 py-1 rounded-lg text-xs font-bold bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs transition' : 'px-2.5 py-1 rounded-lg text-xs font-bold text-slate-500 dark:text-slate-400 transition';

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const rows = [];
  for (let i = 0; i < daysCount; i++) {
    const dayStart = todayStart.getTime() - i * 86400000;
    const dayEnd = dayStart + 86400000;
    const d = new Date(dayStart);
    const label = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;

    const segments = [];
    (appState.journalLogs || []).forEach(log => {
      const s = log.startTime || 0;
      const e = log.endTime || (s + (Number(log.durationMin) || 5) * 60000);
      const ovS = Math.max(s, dayStart);
      const ovE = Math.min(e, dayEnd);
      if (ovE >= ovS && ovE > dayStart && ovS < dayEnd) {
        const leftPct = ((ovS - dayStart) / 86400000) * 100;
        const widthPct = Math.max(1.2, ((ovE - ovS) / 86400000) * 100);
        const color = log.type === 'sleep'
          ? 'bg-indigo-500/85'
          : (log.type === 'feeding' || log.type === 'feeding_solids')
            ? 'bg-rose-500'
            : log.type === 'walk'
              ? 'bg-emerald-500'
              : 'bg-sky-400';
        segments.push(`<div title="${escapeHtml(log.title)}" class="absolute top-0 bottom-0 rounded-xs ${color}" style="left:${leftPct.toFixed(2)}%; width:${Math.min(100 - leftPct, widthPct).toFixed(2)}%"></div>`);
      }
    });

    rows.push(`
      <div class="flex items-center gap-2">
        <span class="w-11 text-[11px] font-semibold text-slate-500 dark:text-slate-400 shrink-0">${label}</span>
        <div class="relative flex-1 h-4 rounded-lg bg-warmgray dark:bg-slate-800 overflow-hidden">
          ${segments.join('')}
        </div>
      </div>
    `);
  }

  wrap.innerHTML = `
    <div class="space-y-1.5">
      <div class="flex items-center justify-between pl-13 text-[10px] font-semibold text-slate-400">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </div>
      ${rows.join('')}
      <div class="flex flex-wrap items-center gap-3 pt-2 text-[11px] text-slate-500 dark:text-slate-400">
        <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-xs bg-indigo-500"></span>Сон</span>
        <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-xs bg-rose-500"></span>Кормление / прикорм</span>
        <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-xs bg-emerald-500"></span>Прогулка</span>
        <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-xs bg-sky-400"></span>Уход</span>
      </div>
    </div>
  `;
}

export function renderJournalTab() {
  renderJournalTimersUI();
  renderRhythmAnalytics();

  const appState = store.appState;
  const listEl = document.getElementById('journal-logs-list');
  const statsEl = document.getElementById('journal-today-stats');
  const titleEl = document.getElementById('journal-day-title');
  const subtitleEl = document.getElementById('journal-day-subtitle');
  const nextBtn = document.getElementById('journal-next-day-btn');
  const todayBtn = document.getElementById('journal-today-btn');
  if (!listEl) return;

  const todayIso = getTodayIso();
  if (!store.selectedJournalDateIso || store.selectedJournalDateIso > todayIso) {
    store.selectedJournalDateIso = todayIso;
  }

  const { startMs, endMs, dateObj } = parseIsoToLocalDayBounds(store.selectedJournalDateIso);
  const yestDate = new Date();
  yestDate.setDate(yestDate.getDate() - 1);
  const yesterdayIso = `${yestDate.getFullYear()}-${String(yestDate.getMonth() + 1).padStart(2, '0')}-${String(yestDate.getDate()).padStart(2, '0')}`;
  const weekdays = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const isToday = store.selectedJournalDateIso === todayIso;
  const isYesterday = store.selectedJournalDateIso === yesterdayIso;

  if (titleEl) {
    titleEl.textContent = isToday
      ? 'Записи за сегодня'
      : isYesterday
        ? 'Записи за вчера'
        : `Записи за ${formatDateRu(store.selectedJournalDateIso)}`;
  }
  if (subtitleEl) {
    subtitleEl.textContent = `${formatDateRu(store.selectedJournalDateIso)} • ${weekdays[dateObj.getDay()]}`;
  }
  if (nextBtn) {
    nextBtn.disabled = isToday;
  }
  if (todayBtn) {
    todayBtn.classList.toggle('hidden', isToday);
  }

  const dayLogs = (appState.journalLogs || []).filter(l => {
    const s = l.startTime || 0;
    return s >= startMs && s < endMs;
  });

  const feedCount = dayLogs.filter(l => l.type === 'feeding' || l.type === 'feeding_solids').length;
  const diaperCount = dayLogs.filter(l => l.type === 'diaper_wet' || l.type === 'diaper_dirty').length;
  const sleepMin = (appState.journalLogs || []).reduce((acc, l) => {
    if (l.type !== 'sleep') return acc;
    const s = l.startTime || 0;
    const e = l.endTime || (s + (Number(l.durationMin) || 0) * 60000);
    const ovS = Math.max(s, startMs);
    const ovE = Math.min(e, endMs);
    return ovE > ovS ? acc + Math.round((ovE - ovS) / 60000) : acc;
  }, 0);

  if (statsEl) {
    statsEl.innerHTML = `
      <span class="px-2 py-0.5 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 font-semibold">Кормлений: ${feedCount}</span>
      <span class="px-2 py-0.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-300 font-semibold">Сон: ${formatMinutesHuman(sleepMin)}</span>
      <span class="px-2 py-0.5 rounded-lg bg-sky-50 dark:bg-sky-950/50 text-sky-600 dark:text-sky-300 font-semibold">Подгузники: ${diaperCount}</span>
    `;
  }

  if (dayLogs.length === 0) {
    const allLogs = appState.journalLogs || [];
    let latestJumpHtml = '';
    if (allLogs.length > 0) {
      let latestTs = 0;
      for (const l of allLogs) {
        const t = Number(l?.startTime || l?.endTime || 0);
        if (t > latestTs) latestTs = t;
      }
      if (latestTs) {
        const ld = new Date(latestTs);
        const latestIso = `${ld.getFullYear()}-${String(ld.getMonth() + 1).padStart(2, '0')}-${String(ld.getDate()).padStart(2, '0')}`;
        if (latestIso !== store.selectedJournalDateIso) {
          latestJumpHtml = `<button type="button" onclick="jumpToLatestJournalDate()" class="px-3 py-1.5 rounded-xl bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-300 font-semibold hover:bg-rose-100 dark:hover:bg-rose-900/60 transition">Открыть записи за ${escapeHtml(formatDateRu(latestIso))} (всего: ${allLogs.length})</button>`;
        }
      }
    }

    listEl.innerHTML = isToday
      ? `<div class="py-8 text-center text-xs text-slate-400 space-y-2.5">
           <div>Записей за сегодня пока нет. Запустите таймер или нажмите «Добавить вручную».</div>
           ${latestJumpHtml ? `<div>${latestJumpHtml}</div>` : ''}
         </div>`
      : `<div class="py-8 text-center text-xs text-slate-400 space-y-2">
           <div>Записей за ${escapeHtml(formatDateRu(store.selectedJournalDateIso))} нет.</div>
           <div class="flex flex-wrap items-center justify-center gap-2">
             <button type="button" onclick="resetJournalDateToToday()" class="px-3 py-1.5 rounded-xl bg-warmgray dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-semibold hover:bg-rose-50 dark:hover:bg-rose-950/50 transition">Вернуться к сегодняшнему дню</button>
             ${latestJumpHtml}
           </div>
         </div>`;
    return;
  }

  listEl.innerHTML = dayLogs.map(log => {
    const dotColor = log.type === 'sleep'
      ? 'bg-indigo-500'
      : (log.type === 'feeding' || log.type === 'feeding_solids')
        ? 'bg-rose-500'
        : log.type === 'walk'
          ? 'bg-emerald-500'
          : 'bg-sky-500';
    const timeStr = formatClockHHMM(log.startTime);
    const endStr = log.endTime && log.endTime !== log.startTime ? ` – ${formatClockHHMM(log.endTime)}` : '';
    const safeId = escapeHtml(log.id);
    return `
      <div onclick="openEditJournalLogModal('${safeId}')" class="py-3 flex items-center justify-between gap-2.5 cursor-pointer hover:bg-warmgray/40 dark:hover:bg-slate-800/40 px-2 rounded-xl transition">
        <div class="flex items-start gap-2.5 min-w-0">
          <span class="w-2.5 h-2.5 rounded-full ${dotColor} mt-1.5 shrink-0"></span>
          <div class="min-w-0">
            <div class="text-xs sm:text-sm font-semibold text-slate-800 dark:text-slate-100 break-words">${escapeHtml(log.title)}</div>
            <div class="text-[11px] text-slate-400">${timeStr}${endStr}</div>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0" onclick="event.stopPropagation()">
          <button type="button" onclick="openEditJournalLogModal('${safeId}')" aria-label="Редактировать" class="p-1.5 rounded-lg text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 transition">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          </button>
          <button type="button" onclick="deleteJournalLog('${safeId}')" aria-label="Удалить" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
}
