// Трекер сцеживания (левая / правая грудь) и «Банк молока» с мягкой подсветкой сроков хранения

import { store, hooks, getCurrentCaregiverName, markDeletedId } from '../state.js';
import {
  escapeHtml,
  getTodayIso,
  formatDateTimeRu,
  formatClockHHMM,
  formatMinutesHuman,
  toDatetimeLocalValue,
  parseIsoToLocalDayBounds,
  openModal,
  showToast
} from '../utils.js';
import { saveAppState } from '../firebase.js';

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

export const MILK_STORAGE_META = {
  room: {
    id: 'room',
    label: 'На столе',
    shortLabel: 'Стол',
    ruleLabel: 'до 4 ч (+18…+22 °C)',
    maxMs: 4 * HOUR_MS
  },
  fridge: {
    id: 'fridge',
    label: 'Холодильник',
    shortLabel: 'Холод.',
    ruleLabel: 'до 4 дн. (+2…+4 °C)',
    maxMs: 96 * HOUR_MS,
    thawedMaxMs: 24 * HOUR_MS
  },
  freezer: {
    id: 'freezer',
    label: 'Морозилка',
    shortLabel: 'Мороз.',
    ruleLabel: 'до 6 мес. (-18 °C)',
    maxMs: 180 * DAY_MS
  }
};

const milkBankUi = {
  filter: 'all', // all | fridge | freezer | room | used
  selectedStorage: 'fridge', // fridge | freezer | room | none
  showForm: true
};

function ensureMilkBankArray() {
  if (!Array.isArray(store.appState.milkBank)) {
    store.appState.milkBank = [];
  }
  return store.appState.milkBank;
}

function formatDurationRemain(ms) {
  const absMs = Math.max(0, ms);
  const totalMin = Math.round(absMs / 60000);
  if (totalMin < 60) return `${Math.max(1, totalMin)} мин`;
  const totalHours = Math.floor(absMs / HOUR_MS);
  if (totalHours < 48) {
    const remMin = Math.floor((absMs % HOUR_MS) / 60000);
    return totalHours < 6 && remMin >= 10 ? `${totalHours} ч ${remMin} мин` : `${totalHours} ч`;
  }
  const days = Math.floor(absMs / DAY_MS);
  const remHours = Math.floor((absMs % DAY_MS) / HOUR_MS);
  if (days < 14 && remHours > 0) return `${days} дн. ${remHours} ч`;
  if (days < 45) return `${days} дн.`;
  const months = (days / 30.4).toFixed(1).replace('.0', '');
  return `${months} мес.`;
}

export function getMilkBatchExpiryInfo(batch, now = Date.now()) {
  const storage = MILK_STORAGE_META[batch?.storage] ? batch.storage : 'fridge';
  const meta = MILK_STORAGE_META[storage];
  const isThawedInFridge = storage === 'fridge' && Boolean(batch?.thawedAt);
  const refStart = isThawedInFridge ? Number(batch.thawedAt) : (Number(batch?.pumpedAt) || now);
  const maxMs = isThawedInFridge ? meta.thawedMaxMs : meta.maxMs;
  const elapsedMs = Math.max(0, now - refStart);
  const remainMs = maxMs - elapsedMs;
  const ratio = maxMs > 0 ? elapsedMs / maxMs : 0;

  let level = 'fresh';
  let statusText = '';

  if (remainMs <= 0) {
    level = 'expired';
    statusText = isThawedInFridge
      ? `Разморожено >24 ч назад (${formatDurationRemain(Math.abs(remainMs))})`
      : storage === 'freezer'
        ? `Более 6 мес. (+${formatDurationRemain(Math.abs(remainMs))})`
        : storage === 'room'
          ? `Более 4 ч на столе (+${formatDurationRemain(Math.abs(remainMs))})`
          : `Срок >4 дн. (+${formatDurationRemain(Math.abs(remainMs))})`;
  } else if (ratio >= 0.85 || (storage === 'fridge' && remainMs <= 12 * HOUR_MS) || (storage === 'room' && remainMs <= 45 * 60000)) {
    level = 'urgent';
    statusText = `Скоро истекает • осталось ${formatDurationRemain(remainMs)}`;
  } else if (ratio >= 0.55) {
    level = 'soon';
    statusText = `Использовать скоро • осталось ${formatDurationRemain(remainMs)}`;
  } else {
    level = 'fresh';
    statusText = isThawedInFridge
      ? `Разморожено • ещё ${formatDurationRemain(remainMs)}`
      : `Свежее • ещё ${formatDurationRemain(remainMs)}`;
  }

  const paletteMap = {
    fresh: storage === 'freezer'
      ? {
          cardCls: 'bg-sky-50/55 dark:bg-sky-950/25 border-sky-200/80 dark:border-sky-800/50',
          badgeCls: 'bg-sky-100/90 dark:bg-sky-950/70 text-sky-700 dark:text-sky-300',
          dotCls: 'bg-sky-500'
        }
      : {
          cardCls: 'bg-emerald-50/55 dark:bg-emerald-950/25 border-emerald-200/80 dark:border-emerald-800/50',
          badgeCls: 'bg-emerald-100/90 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300',
          dotCls: 'bg-emerald-500'
        },
    soon: {
      cardCls: 'bg-amber-50/65 dark:bg-amber-950/25 border-amber-200/90 dark:border-amber-800/60',
      badgeCls: 'bg-amber-100/90 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300',
      dotCls: 'bg-amber-500'
    },
    urgent: {
      cardCls: 'bg-orange-50/75 dark:bg-orange-950/30 border-orange-300/80 dark:border-orange-700/70',
      badgeCls: 'bg-orange-100/95 dark:bg-orange-950/80 text-orange-800 dark:text-orange-300',
      dotCls: 'bg-orange-500'
    },
    expired: {
      cardCls: 'bg-rose-50/75 dark:bg-rose-950/30 border-rose-300/80 dark:border-rose-800/70',
      badgeCls: 'bg-rose-100/95 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300',
      dotCls: 'bg-rose-500'
    }
  };

  const levelRank = level === 'expired' ? 0 : level === 'urgent' ? 1 : level === 'soon' ? 2 : 3;

  return {
    storage,
    storageLabel: isThawedInFridge ? 'Холод. (размор.)' : meta.label,
    storageShort: meta.shortLabel,
    level,
    levelRank,
    statusText,
    remainMs,
    elapsedMs,
    isThawedInFridge,
    ...paletteMap[level]
  };
}

export function computeMilkBankStats(now = Date.now()) {
  const allBatches = ensureMilkBankArray();
  const stored = [];
  const used = [];

  let fridgeMl = 0;
  let fridgeCount = 0;
  let freezerMl = 0;
  let freezerCount = 0;
  let roomMl = 0;
  let roomCount = 0;
  let soonOrUrgentCount = 0;
  let expiredCount = 0;

  for (const b of allBatches) {
    if (!b) continue;
    if (b.status === 'used') {
      used.push(b);
      continue;
    }
    const exp = getMilkBatchExpiryInfo(b, now);
    const enriched = { batch: b, exp };
    stored.push(enriched);

    const ml = Math.max(0, Number(b.totalMl) || 0);
    if (exp.storage === 'fridge') {
      fridgeMl += ml;
      fridgeCount++;
    } else if (exp.storage === 'freezer') {
      freezerMl += ml;
      freezerCount++;
    } else {
      roomMl += ml;
      roomCount++;
    }

    if (exp.level === 'expired') expiredCount++;
    else if (exp.level === 'urgent' || exp.level === 'soon') soonOrUrgentCount++;
  }

  // FIFO-сортировка: сначала порции, которым осталось меньше всего времени (или самые старые)
  stored.sort((a, b) => a.exp.remainMs - b.exp.remainMs || (a.batch.pumpedAt || 0) - (b.batch.pumpedAt || 0));
  used.sort((a, b) => (b.usedAt || b.pumpedAt || 0) - (a.usedAt || a.pumpedAt || 0));

  // Статистика сцеживаний за сегодня и за 7 дней (по журналу и банку молока без двойного учёта)
  const { startMs: todayStart, endMs: todayEnd } = parseIsoToLocalDayBounds(getTodayIso());
  const weekStart = todayStart - 6 * DAY_MS;

  const pumpEvents = [];
  const seenBatchIds = new Set();

  for (const log of store.appState.journalLogs || []) {
    if (!log || log.type !== 'pumping') continue;
    const ts = Number(log.startTime) || 0;
    if (!ts) continue;
    if (log.milkBatchId) seenBatchIds.add(log.milkBatchId);
    pumpEvents.push({
      ts,
      leftMl: Math.max(0, Number(log.leftMl) || 0),
      rightMl: Math.max(0, Number(log.rightMl) || 0),
      totalMl: Math.max(0, Number(log.totalMl) || ((Number(log.leftMl) || 0) + (Number(log.rightMl) || 0)))
    });
  }

  for (const b of allBatches) {
    if (!b || seenBatchIds.has(b.id)) continue;
    pumpEvents.push({
      ts: Number(b.pumpedAt) || 0,
      leftMl: Math.max(0, Number(b.leftMl) || 0),
      rightMl: Math.max(0, Number(b.rightMl) || 0),
      totalMl: Math.max(0, Number(b.initialMl || b.totalMl) || 0)
    });
  }

  let todayTotalMl = 0;
  let todayLeftMl = 0;
  let todayRightMl = 0;
  let todaySessions = 0;

  let weekTotalMl = 0;
  let weekLeftMl = 0;
  let weekRightMl = 0;
  let weekSessions = 0;

  for (const ev of pumpEvents) {
    if (ev.ts >= todayStart && ev.ts < todayEnd) {
      todaySessions++;
      todayLeftMl += ev.leftMl;
      todayRightMl += ev.rightMl;
      todayTotalMl += ev.totalMl;
    }
    if (ev.ts >= weekStart && ev.ts <= now + 60000) {
      weekSessions++;
      weekLeftMl += ev.leftMl;
      weekRightMl += ev.rightMl;
      weekTotalMl += ev.totalMl;
    }
  }

  return {
    stored,
    used,
    totalStoredMl: fridgeMl + freezerMl + roomMl,
    totalStoredCount: stored.length,
    fridgeMl,
    fridgeCount,
    freezerMl,
    freezerCount,
    roomMl,
    roomCount,
    soonOrUrgentCount,
    expiredCount,
    todayTotalMl,
    todayLeftMl,
    todayRightMl,
    todaySessions,
    weekTotalMl,
    weekLeftMl,
    weekRightMl,
    weekSessions
  };
}

function formatTimerClock(startTs) {
  const sec = Math.max(0, Math.floor((Date.now() - startTs) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function updatePumpingTimerClock() {
  const timer = store.appState.timers?.pumping;
  const active = Boolean(timer?.active && timer.startTime);
  const text = active ? formatTimerClock(timer.startTime) : '00:00';

  const modalClock = document.getElementById('milk-pump-timer-display');
  if (modalClock) modalClock.textContent = text;

  const cardClock = document.getElementById('milk-bank-card-timer');
  if (cardClock) {
    cardClock.textContent = active ? `Идёт: ${text}` : '';
    cardClock.classList.toggle('hidden', !active);
  }
}

export function togglePumpingTimer() {
  if (!store.appState.timers.pumping) {
    store.appState.timers.pumping = { active: false, startTime: null, updatedAt: 0 };
  }
  const timer = store.appState.timers.pumping;
  const now = Date.now();

  if (!timer.active) {
    timer.active = true;
    timer.startTime = now;
    timer.updatedAt = Math.max(now, (Number(timer.updatedAt) || 0) + 1);
    const startInp = document.getElementById('milk-pump-datetime');
    if (startInp) startInp.value = toDatetimeLocalValue(now);
    saveAppState();
    renderMilkBankSummary();
    renderMilkBankModal();
    updatePumpingTimerClock();
    showToast('Таймер сцеживания запущен');
  } else {
    const startTs = timer.startTime || now;
    const durMin = Math.max(1, Math.round((now - startTs) / 60000));
    timer.active = false;
    timer.startTime = null;
    timer.updatedAt = Math.max(now, (Number(timer.updatedAt) || 0) + 1);
    saveAppState();
    renderMilkBankSummary();
    renderMilkBankModal();

    const startInp = document.getElementById('milk-pump-datetime');
    const durInp = document.getElementById('milk-pump-duration');
    if (startInp) startInp.value = toDatetimeLocalValue(startTs);
    if (durInp) durInp.value = String(durMin);
    updatePumpingTimerClock();
    showToast(`Сцеживание длилось ${formatMinutesHuman(durMin)} — укажите объём мл и сохраните`);
  }
}

export function openMilkBankModal(mode = 'all') {
  if (mode === 'pump') {
    milkBankUi.showForm = true;
    milkBankUi.filter = 'all';
  } else if (['all', 'fridge', 'freezer', 'room', 'used'].includes(mode)) {
    milkBankUi.filter = mode;
  }

  openModal('modal-milk-bank');
  renderMilkBankModal();

  const dtInp = document.getElementById('milk-pump-datetime');
  if (dtInp) {
    const activeStart = store.appState.timers?.pumping?.active ? store.appState.timers.pumping.startTime : null;
    dtInp.value = toDatetimeLocalValue(activeStart || Date.now());
  }
  updatePumpTotalPreview();
  updatePumpingTimerClock();
}

export function toggleMilkPumpForm() {
  milkBankUi.showForm = !milkBankUi.showForm;
  renderMilkBankModal();
}

export function setMilkBankFilter(filter) {
  milkBankUi.filter = ['fridge', 'freezer', 'room', 'used'].includes(filter) ? filter : 'all';
  renderMilkBankModal();
}

export function selectMilkPumpStorage(storage) {
  milkBankUi.selectedStorage = ['fridge', 'freezer', 'room', 'none'].includes(storage) ? storage : 'fridge';
  document.querySelectorAll('.milk-storage-choice-btn').forEach(btn => {
    const val = btn.getAttribute('data-storage');
    const active = val === milkBankUi.selectedStorage;
    btn.className = active
      ? 'milk-storage-choice-btn py-2 px-2 rounded-xl border border-rose-400 bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-200 text-center transition'
      : 'milk-storage-choice-btn py-2 px-2 rounded-xl border border-stone-200 dark:border-slate-700 bg-warmgray/70 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-center hover:border-rose-300 transition';
  });
}

export function adjustPumpMl(side, value, isReset = false) {
  const id = side === 'right' ? 'milk-pump-right' : 'milk-pump-left';
  const inp = document.getElementById(id);
  if (!inp) return;
  const cur = Math.max(0, parseInt(inp.value || '0', 10) || 0);
  const next = isReset ? 0 : Math.max(0, Math.min(600, cur + Number(value || 0)));
  inp.value = next > 0 ? String(next) : '';
  updatePumpTotalPreview();
}

export function updatePumpTotalPreview() {
  const left = Math.max(0, parseInt(document.getElementById('milk-pump-left')?.value || '0', 10) || 0);
  const right = Math.max(0, parseInt(document.getElementById('milk-pump-right')?.value || '0', 10) || 0);
  const total = left + right;
  const badge = document.getElementById('milk-pump-total-badge');
  if (badge) {
    badge.textContent = `Итого: ${total} мл`;
  }
}

export function savePumpingSession(e) {
  if (e) e.preventDefault();
  const leftMl = Math.max(0, Math.min(600, parseInt(document.getElementById('milk-pump-left')?.value || '0', 10) || 0));
  const rightMl = Math.max(0, Math.min(600, parseInt(document.getElementById('milk-pump-right')?.value || '0', 10) || 0));
  const totalMl = leftMl + rightMl;
  const dtVal = document.getElementById('milk-pump-datetime')?.value;
  const durMin = Math.max(0, Math.min(240, parseInt(document.getElementById('milk-pump-duration')?.value || '0', 10) || 0));
  const note = (document.getElementById('milk-pump-note')?.value || '').trim().slice(0, 120);
  const storage = milkBankUi.selectedStorage || 'fridge';

  const timer = store.appState.timers?.pumping;
  let effectiveDurMin = durMin;
  let parsedTs = dtVal ? new Date(dtVal).getTime() : Date.now();
  if (Number.isNaN(parsedTs)) parsedTs = Date.now();

  if (timer?.active && timer.startTime) {
    if (!effectiveDurMin) {
      effectiveDurMin = Math.max(1, Math.round((Date.now() - timer.startTime) / 60000));
    }
    if (!dtVal) parsedTs = timer.startTime;
    timer.active = false;
    timer.startTime = null;
    timer.updatedAt = Math.max(Date.now(), (Number(timer.updatedAt) || 0) + 1);
  }

  if (totalMl <= 0 && effectiveDurMin <= 0) {
    showToast('Укажите объём (мл) для левой или правой груди');
    return;
  }

  const now = Date.now();
  const author = getCurrentCaregiverName();
  const batchId = (storage !== 'none' && totalMl > 0)
    ? `milk_${now}_${Math.random().toString(36).slice(2, 6)}`
    : '';
  const logId = `log_${now}_${Math.random().toString(36).slice(2, 6)}`;

  const parts = [];
  if (totalMl > 0) {
    const lr = [];
    if (leftMl > 0) lr.push(`Л: ${leftMl}`);
    if (rightMl > 0) lr.push(`П: ${rightMl}`);
    parts.push(`${totalMl} мл${lr.length ? ` (${lr.join(' • ')})` : ''}`);
  }
  if (storage !== 'none' && totalMl > 0 && MILK_STORAGE_META[storage]) {
    parts.push(MILK_STORAGE_META[storage].label.toLowerCase());
  }
  if (note) parts.push(note);

  let logTitle = parts.length > 0 ? `Сцеживание: ${parts.join(' • ')}` : 'Сцеживание';
  if (effectiveDurMin > 0) {
    logTitle = `${logTitle} (${formatMinutesHuman(effectiveDurMin)})`;
  }

  const endTs = effectiveDurMin > 0 ? parsedTs + effectiveDurMin * 60000 : parsedTs;
  store.appState.journalLogs.unshift({
    id: logId,
    type: 'pumping',
    title: logTitle,
    startTime: parsedTs,
    endTime: endTs,
    durationMin: effectiveDurMin,
    leftMl,
    rightMl,
    totalMl,
    storage: storage !== 'none' ? storage : '',
    milkBatchId: batchId,
    note,
    author,
    updatedAt: now
  });
  store.appState.journalLogs.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));

  if (batchId) {
    const bank = ensureMilkBankArray();
    bank.unshift({
      id: batchId,
      pumpedAt: parsedTs,
      leftMl,
      rightMl,
      totalMl,
      initialMl: totalMl,
      storage,
      status: 'stored',
      usedAt: null,
      thawedAt: null,
      durationMin: effectiveDurMin,
      note,
      author,
      journalLogId: logId,
      updatedAt: now
    });
    bank.sort((a, b) => (b.pumpedAt || 0) - (a.pumpedAt || 0));
  }

  // Сбрасываем поля формы
  const leftInp = document.getElementById('milk-pump-left');
  const rightInp = document.getElementById('milk-pump-right');
  const durInp = document.getElementById('milk-pump-duration');
  const noteInp = document.getElementById('milk-pump-note');
  const dtInp = document.getElementById('milk-pump-datetime');
  if (leftInp) leftInp.value = '';
  if (rightInp) rightInp.value = '';
  if (durInp) durInp.value = '';
  if (noteInp) noteInp.value = '';
  if (dtInp) dtInp.value = toDatetimeLocalValue(Date.now());
  updatePumpTotalPreview();

  const dStart = new Date(parsedTs);
  store.selectedJournalDateIso = `${dStart.getFullYear()}-${String(dStart.getMonth() + 1).padStart(2, '0')}-${String(dStart.getDate()).padStart(2, '0')}`;

  saveAppState();
  if (store.activeTab === 'journal') {
    hooks.renderAll();
  } else {
    renderMilkBankSummary();
  }
  renderMilkBankModal();

  showToast(batchId
    ? `Сохранено: ${totalMl} мл → ${MILK_STORAGE_META[storage].label}`
    : 'Сцеживание записано в журнал');
}

export function useMilkBatchForFeeding(batchId) {
  const bank = ensureMilkBankArray();
  const batch = bank.find(b => b.id === batchId);
  if (!batch) return;

  const now = Date.now();
  batch.status = 'used';
  batch.usedAt = now;
  batch.updatedAt = now;

  const ml = Math.max(0, Number(batch.totalMl) || 0);
  store.appState.journalLogs.unshift({
    id: `log_${now}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'feeding',
    subtype: 'bottle',
    title: `Бутылочка: Сцеженное молоко${ml > 0 ? `, ${ml} мл` : ''}`,
    startTime: now,
    endTime: now,
    durationMin: 0,
    author: getCurrentCaregiverName(),
    updatedAt: now
  });
  store.appState.journalLogs.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  store.selectedJournalDateIso = getTodayIso();

  saveAppState();
  renderMilkBankSummary();
  renderMilkBankModal();
  hooks.renderHereAndNowWidget();
  hooks.evaluateSmartNotifications();
  hooks.renderNightMode();
  if (store.activeTab === 'journal') {
    hooks.switchTab('journal');
  }
  showToast(`Порция ${ml} мл отмечена как кормление из бутылочки`);
}

export function markMilkBatchUsed(batchId) {
  const bank = ensureMilkBankArray();
  const batch = bank.find(b => b.id === batchId);
  if (!batch) return;

  const now = Date.now();
  batch.status = 'used';
  batch.usedAt = now;
  batch.updatedAt = now;

  saveAppState();
  renderMilkBankSummary();
  renderMilkBankModal();
  showToast('Порция перемещена в использованные');
}

export function moveMilkBatchStorage(batchId, targetStorage) {
  if (!MILK_STORAGE_META[targetStorage]) return;
  const bank = ensureMilkBankArray();
  const batch = bank.find(b => b.id === batchId);
  if (!batch || batch.storage === targetStorage) return;

  const now = Date.now();
  const prevStorage = batch.storage;
  batch.storage = targetStorage;
  batch.updatedAt = now;
  if (prevStorage === 'freezer' && targetStorage === 'fridge') {
    batch.thawedAt = now;
  } else if (targetStorage === 'freezer') {
    batch.thawedAt = null;
  }

  saveAppState();
  renderMilkBankSummary();
  renderMilkBankModal();
  showToast(`Перенесено в: ${MILK_STORAGE_META[targetStorage].label}`);
}

export function restoreMilkBatch(batchId) {
  const bank = ensureMilkBankArray();
  const batch = bank.find(b => b.id === batchId);
  if (!batch) return;

  batch.status = 'stored';
  batch.usedAt = null;
  batch.updatedAt = Date.now();

  saveAppState();
  renderMilkBankSummary();
  renderMilkBankModal();
  showToast('Порция возвращена в банк молока');
}

export function deleteMilkBatch(batchId) {
  markDeletedId('milkBank', batchId, Date.now());
  store.appState.milkBank = ensureMilkBankArray().filter(b => b.id !== batchId);
  saveAppState();
  renderMilkBankSummary();
  renderMilkBankModal();
  showToast('Порция удалена из банка молока');
}

function renderBatchItemHtml(batch, exp, isCompact = false) {
  const safeId = escapeHtml(batch.id);
  const lrParts = [];
  if (batch.leftMl > 0) lrParts.push(`Л: ${batch.leftMl}`);
  if (batch.rightMl > 0) lrParts.push(`П: ${batch.rightMl}`);
  const lrText = lrParts.length ? lrParts.join(' • ') : 'Общий объём';
  const isUsed = batch.status === 'used';

  const cardCls = isUsed
    ? 'bg-warmgray/45 dark:bg-slate-800/45 border-stone-200/70 dark:border-slate-700/60 opacity-85'
    : exp.cardCls;

  const storagePillCls = batch.storage === 'freezer'
    ? 'bg-sky-100/80 dark:bg-sky-950/70 text-sky-700 dark:text-sky-300'
    : batch.storage === 'room'
      ? 'bg-amber-100/80 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300'
      : 'bg-white/90 dark:bg-slate-900/90 text-slate-700 dark:text-slate-200 border border-stone-200/70 dark:border-slate-700';

  if (isCompact) {
    return `
      <div class="p-2.5 rounded-2xl border ${cardCls} flex items-center justify-between gap-2.5">
        <div class="min-w-0 space-y-0.5">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="font-display font-extrabold text-sm text-slate-900 dark:text-slate-100 tabular-nums">${batch.totalMl} мл</span>
            <span class="px-1.5 py-0.5 rounded-md text-[10px] font-bold ${storagePillCls}">${escapeHtml(exp.storageLabel)}</span>
            <span class="text-[11px] font-medium text-slate-500 dark:text-slate-400 tabular-nums">${escapeHtml(lrText)}</span>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span class="text-slate-500 dark:text-slate-400 tabular-nums">${escapeHtml(formatDateTimeRu(batch.pumpedAt))}</span>
            <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-bold ${exp.badgeCls}">
              <span class="w-1.5 h-1.5 rounded-full ${exp.dotCls}"></span>
              ${escapeHtml(exp.statusText)}
            </span>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          ${batch.storage !== 'freezer' ? `
            <button type="button" onclick="moveMilkBatchStorage('${safeId}', 'freezer')" title="Переложить в морозилку" class="px-2 py-1.5 rounded-xl bg-white/85 dark:bg-slate-900/85 hover:bg-sky-50 dark:hover:bg-sky-950/60 border border-stone-200/80 dark:border-slate-700 text-[11px] font-bold text-sky-700 dark:text-sky-300 transition">
              В мороз.
            </button>
          ` : ''}
          <button type="button" onclick="useMilkBatchForFeeding('${safeId}')" class="px-2.5 py-1.5 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-[11px] font-bold shadow-2xs transition">
            Покормить
          </button>
        </div>
      </div>
    `;
  }

  return `
    <div class="p-3 sm:p-3.5 rounded-2xl border ${cardCls} space-y-2 transition">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0 space-y-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="font-display font-extrabold text-base text-slate-900 dark:text-slate-100 tabular-nums">${batch.totalMl} мл</span>
            <span class="px-2 py-0.5 rounded-lg text-[11px] font-bold ${storagePillCls}">${escapeHtml(exp.storageLabel)}</span>
            <span class="text-xs font-semibold text-slate-600 dark:text-slate-300 tabular-nums">${escapeHtml(lrText)}</span>
            ${batch.durationMin > 0 ? `<span class="text-[11px] text-slate-400">• ${formatMinutesHuman(batch.durationMin)}</span>` : ''}
          </div>
          <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            <span class="tabular-nums">${escapeHtml(formatDateTimeRu(batch.pumpedAt))}</span>
            ${batch.author ? `<span class="px-1.5 py-0.5 rounded-md bg-white/75 dark:bg-slate-900/75 text-slate-500 dark:text-slate-300 font-semibold">${escapeHtml(batch.author)}</span>` : ''}
            ${batch.note ? `<span class="italic text-slate-500 dark:text-slate-400 break-words">• ${escapeHtml(batch.note)}</span>` : ''}
          </div>
        </div>
        ${isUsed ? `
          <span class="px-2 py-0.5 rounded-lg bg-stone-200/80 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-bold shrink-0">
            Использовано ${batch.usedAt ? formatClockHHMM(batch.usedAt) : ''}
          </span>
        ` : `
          <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[11px] font-bold shrink-0 ${exp.badgeCls}">
            <span class="w-1.5 h-1.5 rounded-full ${exp.dotCls}"></span>
            ${escapeHtml(exp.statusText)}
          </span>
        `}
      </div>

      <div class="flex flex-wrap items-center justify-between gap-1.5 pt-1 border-t border-black/5 dark:border-white/5">
        ${isUsed ? `
          <div class="flex items-center gap-1.5">
            <button type="button" onclick="restoreMilkBatch('${safeId}')" class="px-2.5 py-1 rounded-xl bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 border border-stone-200 dark:border-slate-700 text-[11px] font-bold text-slate-700 dark:text-slate-200 transition">
              Вернуть в запас
            </button>
          </div>
          <button type="button" onclick="deleteMilkBatch('${safeId}')" class="px-2.5 py-1 rounded-xl text-[11px] font-bold text-rose-500 hover:bg-rose-100/70 dark:hover:bg-rose-950/60 transition">
            Удалить
          </button>
        ` : `
          <div class="flex flex-wrap items-center gap-1.5">
            <button type="button" onclick="useMilkBatchForFeeding('${safeId}')" class="px-3 py-1.5 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-[11px] font-bold shadow-2xs transition">
              Покормить (${batch.totalMl} мл)
            </button>
            <button type="button" onclick="markMilkBatchUsed('${safeId}')" class="px-2.5 py-1.5 rounded-xl bg-white/85 dark:bg-slate-900/85 hover:bg-stone-100 dark:hover:bg-slate-800 border border-stone-200/80 dark:border-slate-700 text-[11px] font-semibold text-slate-600 dark:text-slate-300 transition">
              Списать
            </button>
            ${batch.storage !== 'fridge' ? `
              <button type="button" onclick="moveMilkBatchStorage('${safeId}', 'fridge')" class="px-2.5 py-1.5 rounded-xl bg-white/85 dark:bg-slate-900/85 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 border border-stone-200/80 dark:border-slate-700 text-[11px] font-bold text-emerald-700 dark:text-emerald-300 transition">
                ${batch.storage === 'freezer' ? 'Разморозить в холод.' : 'В холодильник'}
              </button>
            ` : ''}
            ${batch.storage !== 'freezer' ? `
              <button type="button" onclick="moveMilkBatchStorage('${safeId}', 'freezer')" class="px-2.5 py-1.5 rounded-xl bg-white/85 dark:bg-slate-900/85 hover:bg-sky-50 dark:hover:bg-sky-950/40 border border-stone-200/80 dark:border-slate-700 text-[11px] font-bold text-sky-700 dark:text-sky-300 transition">
                В морозилку
              </button>
            ` : ''}
          </div>
          <button type="button" onclick="deleteMilkBatch('${safeId}')" aria-label="Удалить порцию" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-100/60 dark:hover:bg-rose-950/50 transition">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        `}
      </div>
    </div>
  `;
}

export function toggleMilkFeedingEnded(ended) {
  store.appState.milkFeedingEnded = Boolean(ended);
  store.appState.profileUpdatedAt = Date.now();
  saveAppState();
  renderMilkBankSummary();
  renderMilkBankModal();
  showToast(store.appState.milkFeedingEnded
    ? 'Блок свёрнут, все данные сцеживаний и банка молока сохранены'
    : 'Трекер сцеживания и Банк молока развёрнут');
}

export function renderMilkBankSummary() {
  const wrap = document.getElementById('milk-bank-summary-card');
  if (!wrap) return;

  const stats = computeMilkBankStats(Date.now());
  const isEnded = Boolean(store.appState.milkFeedingEnded);
  const totalSavedCount = ensureMilkBankArray().length;

  if (isEnded) {
    wrap.innerHTML = `
      <div class="rounded-2xl bg-white/60 dark:bg-slate-900/50 border border-stone-200/60 dark:border-slate-800/70 px-3.5 py-2 flex items-center justify-between gap-2 text-slate-400 dark:text-slate-500">
        <label class="inline-flex items-center gap-2 cursor-pointer select-none min-w-0">
          <input type="checkbox" checked onchange="toggleMilkFeedingEnded(this.checked)" class="w-3.5 h-3.5 accent-rose-500 rounded shrink-0" />
          <span class="text-[11px] font-medium truncate">Закончено кормление молоком</span>
        </label>
        <div class="flex items-center gap-2 shrink-0">
          ${(totalSavedCount > 0 || stats.weekSessions > 0) ? `
            <button type="button" onclick="openMilkBankModal('all')" class="text-[11px] font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 underline decoration-dotted underline-offset-2 transition">
              Сохранённые данные${stats.totalStoredCount > 0 ? ` (${stats.totalStoredCount})` : ''}
            </button>
          ` : ''}
        </div>
      </div>
    `;
    return;
  }

  const pumpTimerActive = Boolean(store.appState.timers?.pumping?.active && store.appState.timers.pumping.startTime);
  const previewItems = stats.stored.slice(0, 3);

  let statusPillHtml = '';
  if (stats.expiredCount > 0) {
    statusPillHtml = `<span class="px-2 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/70 text-rose-700 dark:text-rose-300 text-[10px] font-bold">Проверить срок: ${stats.expiredCount}</span>`;
  } else if (stats.soonOrUrgentCount > 0) {
    statusPillHtml = `<span class="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 text-[10px] font-bold">Скоро использовать: ${stats.soonOrUrgentCount}</span>`;
  } else if (stats.totalStoredMl > 0) {
    statusPillHtml = `<span class="px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold">В запасе: ${stats.totalStoredMl} мл</span>`;
  }

  wrap.innerHTML = `
    <div class="bg-white dark:bg-slate-900 rounded-3xl border border-stone-200/70 dark:border-slate-800 p-4 sm:p-5 space-y-3 shadow-2xs">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="w-9 h-9 rounded-2xl bg-rose-50 dark:bg-rose-950/60 text-rose-500 flex items-center justify-center shrink-0">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M10 3v2.5a2 2 0 0 1-.6 1.4L8 8.3A2 2 0 0 0 7.4 9.7V19a2 2 0 0 0 2 2h5.2a2 2 0 0 0 2-2V9.7a2 2 0 0 0-.6-1.4l-1.4-1.4a2 2 0 0 1-.6-1.4V3"/><path d="M7.5 14h9"/></svg>
          </span>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5">
              <h3 class="font-display font-bold text-sm sm:text-base text-slate-900 dark:text-slate-100">Трекер сцеживания и Банк молока</h3>
              ${statusPillHtml}
              <span id="milk-bank-card-timer" class="${pumpTimerActive ? '' : 'hidden'} px-2 py-0.5 rounded-full bg-rose-500 text-white font-mono text-[10px] font-bold animate-pulse">
                ${pumpTimerActive ? `Идёт: ${formatTimerClock(store.appState.timers.pumping.startTime)}` : ''}
              </span>
            </div>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">Учёт левой/правой груди и контроль сроков хранения порций</p>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" onclick="openMilkBankModal('pump')" class="px-3 py-1.5 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold shadow-2xs transition">
            + Сцеживание
          </button>
          <button type="button" onclick="openMilkBankModal('all')" class="px-3 py-1.5 rounded-xl bg-warmgray dark:bg-slate-800 hover:bg-stone-200/80 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-bold transition">
            Банк (${stats.totalStoredCount})
          </button>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-2">
        <div class="p-2.5 sm:p-3 rounded-2xl bg-warmgray/70 dark:bg-slate-800/70 border border-stone-200/60 dark:border-slate-700/70 space-y-0.5">
          <div class="text-[10px] sm:text-[11px] font-semibold text-slate-500 dark:text-slate-400 truncate">Сегодня сцежено</div>
          <div class="font-display font-extrabold text-sm sm:text-base text-slate-900 dark:text-slate-100 tabular-nums">${stats.todayTotalMl} мл</div>
          <div class="text-[10px] text-slate-400 tabular-nums truncate">Л: ${stats.todayLeftMl} • П: ${stats.todayRightMl}</div>
        </div>

        <button type="button" onclick="openMilkBankModal('fridge')" class="text-left p-2.5 sm:p-3 rounded-2xl bg-emerald-50/55 dark:bg-emerald-950/25 border border-emerald-200/70 dark:border-emerald-800/50 hover:border-emerald-300 space-y-0.5 transition">
          <div class="text-[10px] sm:text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 truncate">Холодильник</div>
          <div class="font-display font-extrabold text-sm sm:text-base text-slate-900 dark:text-slate-100 tabular-nums">${stats.fridgeMl + stats.roomMl} мл</div>
          <div class="text-[10px] text-emerald-700/80 dark:text-emerald-300/80 tabular-nums truncate">${stats.fridgeCount + stats.roomCount} порц. • до 4 дн.</div>
        </button>

        <button type="button" onclick="openMilkBankModal('freezer')" class="text-left p-2.5 sm:p-3 rounded-2xl bg-sky-50/55 dark:bg-sky-950/25 border border-sky-200/70 dark:border-sky-800/50 hover:border-sky-300 space-y-0.5 transition">
          <div class="text-[10px] sm:text-[11px] font-semibold text-sky-700 dark:text-sky-300 truncate">Морозилка</div>
          <div class="font-display font-extrabold text-sm sm:text-base text-slate-900 dark:text-slate-100 tabular-nums">${stats.freezerMl} мл</div>
          <div class="text-[10px] text-sky-700/80 dark:text-sky-300/80 tabular-nums truncate">${stats.freezerCount} порц. • до 6 мес.</div>
        </button>
      </div>

      ${previewItems.length > 0 ? `
        <div class="space-y-1.5 pt-0.5">
          <div class="flex items-center justify-between text-[11px]">
            <span class="font-bold text-slate-500 dark:text-slate-400">Ближайшие по сроку (использовать первыми)</span>
            ${stats.stored.length > 3 ? `<button type="button" onclick="openMilkBankModal('all')" class="font-bold text-rose-500 hover:text-rose-600">Все (${stats.stored.length}) →</button>` : ''}
          </div>
          <div class="space-y-1.5">
            ${previewItems.map(item => renderBatchItemHtml(item.batch, item.exp, true)).join('')}
          </div>
        </div>
      ` : `
        <div class="p-3 rounded-2xl bg-warmgray/45 dark:bg-slate-800/45 border border-dashed border-stone-300/70 dark:border-slate-700 text-center text-xs text-slate-500 dark:text-slate-400">
          В банке молока пока нет порций — нажмите <strong>«+ Сцеживание»</strong>, чтобы зафиксировать объём для левой и правой груди.
        </div>
      `}

      <div class="pt-1 border-t border-stone-100 dark:border-slate-800/80 flex items-center justify-between gap-2">
        <label class="inline-flex items-center gap-2 cursor-pointer select-none text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition">
          <input type="checkbox" onchange="toggleMilkFeedingEnded(this.checked)" class="w-3.5 h-3.5 accent-rose-500 rounded shrink-0" />
          <span>Закончено кормление молоком (свернуть блок, данные сохранятся)</span>
        </label>
      </div>
    </div>
  `;
}

export function renderMilkBankModal() {
  const modalEl = document.getElementById('modal-milk-bank');
  if (!modalEl || modalEl.classList.contains('hidden')) return;

  const stats = computeMilkBankStats(Date.now());
  const timer = store.appState.timers?.pumping;
  const timerActive = Boolean(timer?.active && timer.startTime);

  const subHeader = document.getElementById('milk-modal-subtitle');
  if (subHeader) {
    subHeader.textContent = `В запасе: ${stats.totalStoredMl} мл (${stats.totalStoredCount} порц.) • Сегодня сцежено: ${stats.todayTotalMl} мл`;
  }

  const formWrap = document.getElementById('milk-pump-form-wrap');
  const formToggleLbl = document.getElementById('milk-pump-form-toggle-label');
  if (formWrap) formWrap.classList.toggle('hidden', !milkBankUi.showForm);
  if (formToggleLbl) formToggleLbl.textContent = milkBankUi.showForm ? 'Скрыть форму' : '+ Новое сцеживание';

  const timerBtn = document.getElementById('milk-pump-timer-btn');
  if (timerBtn) {
    timerBtn.textContent = timerActive ? 'Стоп таймер' : 'Старт таймер';
    timerBtn.className = timerActive
      ? 'px-3 py-1.5 rounded-xl bg-slate-900 dark:bg-rose-600 text-white text-xs font-bold animate-pulse transition shrink-0'
      : 'px-3 py-1.5 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold transition shrink-0';
  }
  updatePumpingTimerClock();
  selectMilkPumpStorage(milkBankUi.selectedStorage);

  // Статистика за 7 дней (баланс Л / П)
  const statsBox = document.getElementById('milk-bank-week-stats');
  if (statsBox) {
    const lrSum = stats.weekLeftMl + stats.weekRightMl;
    const leftPct = lrSum > 0 ? Math.round((stats.weekLeftMl / lrSum) * 100) : 50;
    const rightPct = lrSum > 0 ? 100 - leftPct : 50;
    statsBox.innerHTML = `
      <div class="p-3 rounded-2xl bg-warmgray/70 dark:bg-slate-800/70 border border-stone-200/70 dark:border-slate-700 space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span class="font-bold text-slate-700 dark:text-slate-200">За 7 дней: ${stats.weekTotalMl} мл (${stats.weekSessions} сцеж.)</span>
          <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 tabular-nums">Л: ${stats.weekLeftMl} мл (${leftPct}%) • П: ${stats.weekRightMl} мл (${rightPct}%)</span>
        </div>
        <div class="w-full h-2 rounded-full bg-stone-200 dark:bg-slate-700 overflow-hidden flex">
          <div class="h-full bg-rose-400 transition-all" style="width:${leftPct}%"></div>
          <div class="h-full bg-indigo-400 transition-all" style="width:${rightPct}%"></div>
        </div>
      </div>
    `;
  }

  // Фильтры списка
  const filtersEl = document.getElementById('milk-bank-filters');
  if (filtersEl) {
    const filterDefs = [
      { id: 'all', label: `Все в наличии (${stats.totalStoredCount})` },
      { id: 'fridge', label: `Холодильник (${stats.fridgeCount})` },
      { id: 'freezer', label: `Морозилка (${stats.freezerCount})` },
      ...(stats.roomCount > 0 ? [{ id: 'room', label: `На столе (${stats.roomCount})` }] : []),
      { id: 'used', label: `Использовано (${stats.used.length})` }
    ];
    filtersEl.innerHTML = filterDefs.map(f => {
      const active = milkBankUi.filter === f.id;
      return `
        <button type="button" onclick="setMilkBankFilter('${f.id}')" class="px-3 py-1.5 rounded-xl text-xs font-bold shrink-0 transition ${active ? 'bg-slate-900 dark:bg-rose-500 text-white shadow-2xs' : 'bg-warmgray dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-stone-200/70 dark:hover:bg-slate-700'}">
          ${escapeHtml(f.label)}
        </button>
      `;
    }).join('');
  }

  // Список порций
  const listEl = document.getElementById('milk-bank-list');
  if (listEl) {
    if (milkBankUi.filter === 'used') {
      if (stats.used.length === 0) {
        listEl.innerHTML = `<div class="py-8 text-center text-xs text-slate-400">Использованных порций пока нет.</div>`;
      } else {
        listEl.innerHTML = stats.used.map(b => renderBatchItemHtml(b, getMilkBatchExpiryInfo(b), false)).join('');
      }
      return;
    }

    const filtered = milkBankUi.filter === 'all'
      ? stats.stored
      : stats.stored.filter(item => item.exp.storage === milkBankUi.filter);

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="py-8 text-center text-xs text-slate-400 space-y-1">
          <div>В этой категории порций пока нет.</div>
          <div>Добавьте новое сцеживание выше, чтобы отслеживать объём и сроки хранения.</div>
        </div>
      `;
    } else {
      listEl.innerHTML = filtered.map(item => renderBatchItemHtml(item.batch, item.exp, false)).join('');
    }
  }
}
