// Вкладка 3: Здоровье (зубная карта, календарь прививок и планировщик визитов к врачам)

import {
  PRIMARY_TEETH,
  TOOTH_SYMPTOM_OPTIONS,
  VACCINE_SCHEDULE,
  DOCTOR_CHECKUPS_SCHEDULE
} from '../data.js';
import {
  store,
  hooks,
  getCurrentCaregiverName,
  markDeletedId
} from '../state.js';
import {
  escapeHtml,
  generateEntityId,
  getTodayIso,
  formatDateRu,
  syncRuDateDisplays,
  openModal,
  closeModal,
  showToast
} from '../utils.js';
import { saveAppState } from '../firebase.js';

export function renderTeethChart() {
  const container = document.getElementById('teeth-chart-container');
  const badge = document.getElementById('teeth-progress-badge');
  const forecastBox = document.getElementById('teeth-forecast-box');
  if (!container) return;

  const teethMap = store.appState.teethMap || {};
  const eruptedCount = PRIMARY_TEETH.filter(t => teethMap[t.id]?.erupted).length;
  if (badge) badge.textContent = `${eruptedCount} из 20 зубов`;

  const svgTeeth = PRIMARY_TEETH.map(t => {
    const rec = teethMap[t.id] || {};
    const isErupted = Boolean(rec.erupted);
    const hasSymptoms = Array.isArray(rec.symptoms) && rec.symptoms.length > 0;
    const w = t.kind === 'molar' ? 24 : t.kind === 'canine' ? 19 : 18;
    const h = t.kind === 'molar' ? 22 : t.kind === 'canine' ? 21 : 20;
    const rx = t.kind === 'molar' ? 7 : 6;
    const fill = isErupted ? '#10b981' : '#ffffff';
    const stroke = isErupted ? '#059669' : '#cbd5e1';
    const textFill = isErupted ? '#ffffff' : '#475569';

    return `
      <g onclick="openToothModal('${t.id}')" class="cursor-pointer group">
        <rect x="${t.x - w / 2}" y="${t.y - h / 2}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="2" />
        <text x="${t.x}" y="${t.y + 3.5}" text-anchor="middle" font-size="9" font-weight="700" fill="${textFill}">${t.id}</text>
        ${hasSymptoms ? `<circle cx="${t.x + w / 2 - 2}" cy="${t.y - h / 2 + 2}" r="3.5" fill="#f59e0b" stroke="#ffffff" stroke-width="1" />` : ''}
      </g>
    `;
  }).join('');

  container.innerHTML = `
    <div class="flex flex-col items-center">
      <svg viewBox="0 0 360 326" class="w-full max-w-[340px] select-none">
        <path d="M 42 146 C 42 54, 112 22, 180 22 C 248 22, 318 54, 318 146" fill="none" stroke="#fecdd3" stroke-width="26" stroke-linecap="round" opacity="0.55" />
        <text x="180" y="96" text-anchor="middle" font-size="11" font-weight="700" fill="#94a3b8">ВЕРХНЯЯ ЧЕЛЮСТЬ</text>
        <line x1="180" y1="22" x2="180" y2="54" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="2 2" />

        <path d="M 42 180 C 42 272, 112 304, 180 304 C 248 304, 318 272, 318 180" fill="none" stroke="#fecdd3" stroke-width="26" stroke-linecap="round" opacity="0.55" />
        <text x="180" y="236" text-anchor="middle" font-size="11" font-weight="700" fill="#94a3b8">НИЖНЯЯ ЧЕЛЮСТЬ</text>
        <line x1="180" y1="272" x2="180" y2="304" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="2 2" />

        <text x="26" y="167" text-anchor="middle" font-size="9" font-weight="700" fill="#94a3b8">ПРАВО</text>
        <text x="334" y="167" text-anchor="middle" font-size="9" font-weight="700" fill="#94a3b8">ЛЕВО</text>

        ${svgTeeth}
      </svg>

      <div class="flex flex-wrap items-center justify-center gap-4 text-[11px] text-slate-500 dark:text-slate-400 pt-1">
        <span class="inline-flex items-center gap-1.5"><span class="w-3 h-3 rounded-xs bg-white border border-slate-300"></span>Ожидается</span>
        <span class="inline-flex items-center gap-1.5"><span class="w-3 h-3 rounded-xs bg-emerald-500"></span>Прорезался</span>
        <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-amber-500"></span>Есть симптомы</span>
      </div>
    </div>
  `;

  if (forecastBox) {
    const nextTeeth = PRIMARY_TEETH.filter(t => !teethMap[t.id]?.erupted).slice(0, 2);
    if (eruptedCount === 20) {
      forecastBox.innerHTML = `<strong>Поздравляем!</strong> Все 20 молочных зубов прорезались. Продолжайте чистить зубки 2 раза в день детской щёткой и пастой с фтором по возрасту.`;
    } else {
      const nextStr = nextTeeth.map(t => `${t.name.toLowerCase()} (${t.id}) в ${t.norm}`).join(' и ');
      forecastBox.innerHTML = `<strong>Ориентир:</strong> обычно первыми появляются нижние центральные резцы (81 и 71) в 6–10 месяцев. Далее по графику ожидаются: ${nextStr}. ${eruptedCount > 0 ? 'Не забывайте ежедневно очищать уже появившиеся зубки!' : ''}`;
    }
  }
}

function renderToothSymptomsGrid() {
  const grid = document.getElementById('tooth-symptoms-grid');
  if (!grid) return;
  grid.innerHTML = TOOTH_SYMPTOM_OPTIONS.map(sym => {
    const active = store.tempToothSymptoms.includes(sym);
    return `
      <button type="button" onclick="toggleTempToothSymptom('${sym}')" class="py-2 px-2.5 rounded-xl border text-left text-[11px] font-semibold transition ${
        active
          ? 'bg-amber-50 dark:bg-amber-950/60 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200'
          : 'bg-warmgray/60 dark:bg-slate-800 border-stone-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
      }">
        ${active ? '✓ ' : ''}${sym}
      </button>
    `;
  }).join('');
}

export function openToothModal(toothId) {
  const tooth = PRIMARY_TEETH.find(t => t.id === toothId);
  if (!tooth) return;
  const rec = (store.appState.teethMap || {})[toothId] || {};

  document.getElementById('tooth-id-input').value = toothId;
  document.getElementById('modal-tooth-title').textContent = `${tooth.name} (№${tooth.id})`;
  document.getElementById('modal-tooth-norm').textContent = `Ориентировочный срок прорезывания: ${tooth.norm}`;
  document.getElementById('tooth-erupted-checkbox').checked = Boolean(rec.erupted);
  document.getElementById('tooth-date-input').value = rec.date || getTodayIso();
  store.tempToothSymptoms = Array.isArray(rec.symptoms) ? [...rec.symptoms] : [];

  renderToothSymptomsGrid();
  syncRuDateDisplays();
  openModal('modal-tooth');
}

export function toggleTempToothSymptom(sym) {
  if (store.tempToothSymptoms.includes(sym)) {
    store.tempToothSymptoms = store.tempToothSymptoms.filter(s => s !== sym);
  } else {
    store.tempToothSymptoms.push(sym);
  }
  renderToothSymptomsGrid();
}

export function saveToothRecord(e) {
  if (e) e.preventDefault();
  const id = document.getElementById('tooth-id-input')?.value;
  if (!id) return;
  const erupted = Boolean(document.getElementById('tooth-erupted-checkbox')?.checked);
  const date = document.getElementById('tooth-date-input')?.value || getTodayIso();

  store.appState.teethMap[id] = {
    erupted,
    date: erupted ? date : '',
    symptoms: [...store.tempToothSymptoms],
    updatedAt: Date.now()
  };
  closeModal('modal-tooth');
  saveAppState();
  renderTeethChart();
  showToast('Данные зуба сохранены');
}

// =========================================================================
// КАЛЕНДАРЬ ПРИВИВОК
// =========================================================================
export function setVaccineFilter(filter) {
  store.appState.vaccineFilter = filter;
  store.appState.uiUpdatedAt = Date.now();
  saveAppState();
  renderVaccinesList();
}

export function renderVaccinesList() {
  const container = document.getElementById('vaccines-list-container');
  const progressBadge = document.getElementById('vaccines-progress-badge');
  if (!container) return;

  const appState = store.appState;
  const filter = appState.vaccineFilter || 'all';
  document.querySelectorAll('.vac-filter-btn').forEach(btn => {
    const active = btn.getAttribute('data-vac-filter') === filter;
    btn.className = active
      ? 'vac-filter-btn px-2.5 py-1 rounded-lg text-xs font-bold bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs'
      : 'vac-filter-btn px-2.5 py-1 rounded-lg text-xs font-bold text-slate-500 dark:text-slate-400';
  });

  const doneCount = VACCINE_SCHEDULE.filter(item => Boolean((appState.vaccinesMap || {})[item.id]?.done)).length;
  if (progressBadge) {
    progressBadge.textContent = `${doneCount} из ${VACCINE_SCHEDULE.length}`;
  }

  const dobMs = new Date(appState.babyDob || getTodayIso()).getTime();
  const items = VACCINE_SCHEDULE.filter(item => {
    const isDone = Boolean((appState.vaccinesMap || {})[item.id]?.done);
    if (filter === 'done') return isDone;
    if (filter === 'pending') return !isDone;
    return true;
  });

  if (items.length === 0) {
    container.innerHTML = `<div class="py-6 text-center text-xs text-slate-400">В выбранном фильтре прививок пока нет.</div>`;
    return;
  }

  container.innerHTML = items.map(item => {
    const rec = (appState.vaccinesMap || {})[item.id] || {};
    const isDone = Boolean(rec.done);
    const plannedDate = new Date(dobMs + item.daysOffset * 86400000);
    const plannedIso = `${plannedDate.getFullYear()}-${String(plannedDate.getMonth() + 1).padStart(2, '0')}-${String(plannedDate.getDate()).padStart(2, '0')}`;
    const displayDate = isDone && rec.date ? `Выполнено: ${formatDateRu(rec.date)}` : `План: ${formatDateRu(plannedIso)}`;

    return `
      <div onclick="openVaccineModal('${item.id}')" class="p-3.5 rounded-2xl border transition cursor-pointer flex items-start justify-between gap-3 ${
        isDone
          ? 'bg-emerald-50/50 dark:bg-emerald-950/25 border-emerald-200/70 dark:border-emerald-900/50'
          : 'bg-warmgray/60 dark:bg-slate-800/60 border-stone-200/70 dark:border-slate-700 hover:border-rose-300'
      }">
        <div class="flex items-start gap-3 min-w-0">
          <div class="mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
            isDone ? 'bg-emerald-500 text-white' : 'border-2 border-slate-300 dark:border-slate-600'
          }">
            ${isDone ? '<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
          </div>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5 mb-0.5">
              <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-rose-100/80 dark:bg-rose-950 text-rose-700 dark:text-rose-300">${item.ageLabel}</span>
              <span class="text-[11px] text-slate-500 dark:text-slate-400 font-medium">${displayDate}</span>
            </div>
            <div class="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100">${item.title}</div>
            ${rec.drug ? `<div class="text-[11px] text-slate-500 mt-0.5">Препарат: ${escapeHtml(rec.drug)}${rec.series ? ` (${escapeHtml(rec.series)})` : ''}</div>` : ''}
          </div>
        </div>
        <span class="text-xs font-semibold text-rose-500 shrink-0">Открыть</span>
      </div>
    `;
  }).join('');
}

export function openVaccineModal(vacId) {
  const item = VACCINE_SCHEDULE.find(v => v.id === vacId);
  if (!item) return;
  const rec = (store.appState.vaccinesMap || {})[vacId] || {};

  document.getElementById('vac-id-input').value = vacId;
  document.getElementById('modal-vac-title').textContent = item.title;
  document.getElementById('modal-vac-age').textContent = `Рекомендуемый возраст: ${item.ageLabel}`;
  document.getElementById('vac-done-checkbox').checked = Boolean(rec.done);
  document.getElementById('vac-date-input').value = rec.date || getTodayIso();
  document.getElementById('vac-series-input').value = rec.series || '';
  document.getElementById('vac-drug-input').value = rec.drug || '';
  document.getElementById('vac-note-input').value = rec.note || '';

  syncRuDateDisplays();
  openModal('modal-vaccine');
}

export function saveVaccineRecord(e) {
  if (e) e.preventDefault();
  const id = document.getElementById('vac-id-input')?.value;
  if (!id) return;
  store.appState.vaccinesMap[id] = {
    done: Boolean(document.getElementById('vac-done-checkbox')?.checked),
    date: document.getElementById('vac-date-input')?.value || getTodayIso(),
    series: (document.getElementById('vac-series-input')?.value || '').trim(),
    drug: (document.getElementById('vac-drug-input')?.value || '').trim(),
    note: (document.getElementById('vac-note-input')?.value || '').trim(),
    updatedAt: Date.now()
  };
  closeModal('modal-vaccine');
  saveAppState();
  renderVaccinesList();
  showToast('Отметка о прививке сохранена');
}

// =========================================================================
// ПЛАНИРОВЩИК ВИЗИТОВ К ВРАЧАМ И ДИСПАНСЕРИЗАЦИЙ
// =========================================================================
let tempCheckupSpecialists = {};

function parseAppointmentLocalMs(dateIso, timeStr = '10:00') {
  if (!dateIso || typeof dateIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return null;
  const [y, m, d] = dateIso.split('-').map(Number);
  const safeTime = /^\d{2}:\d{2}$/.test(timeStr || '') ? timeStr : '10:00';
  const [hh, mm] = safeTime.split(':').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
  return Number.isFinite(dt.getTime()) ? dt.getTime() : null;
}

function formatAppointmentBadgeText(dateIso, timeStr = '10:00') {
  const apptMs = parseAppointmentLocalMs(dateIso, timeStr);
  if (!apptMs) return formatDateRu(dateIso);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const apptDayStart = new Date(new Date(apptMs).getFullYear(), new Date(apptMs).getMonth(), new Date(apptMs).getDate()).getTime();
  const diffDays = Math.round((apptDayStart - todayStart) / 86400000);
  const timePart = /^\d{2}:\d{2}$/.test(timeStr || '') ? ` в ${timeStr}` : '';
  if (diffDays === 0) return `Сегодня${timePart}`;
  if (diffDays === 1) return `Завтра${timePart}`;
  if (diffDays === -1) return `Вчера${timePart}`;
  if (diffDays > 1 && diffDays <= 7) return `Через ${diffDays} дн. (${formatDateRu(dateIso)}${timePart})`;
  return `${formatDateRu(dateIso)}${timePart}`;
}

function getAgePlannedIso(dobIso, daysOffset) {
  const dobMs = new Date(dobIso || getTodayIso()).getTime();
  const d = new Date(dobMs + daysOffset * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function setDoctorFilter(filter) {
  store.appState.doctorFilter = ['all', 'planned', 'pending', 'done', 'custom'].includes(filter) ? filter : 'all';
  store.appState.uiUpdatedAt = Date.now();
  saveAppState();
  renderDoctorsSection();
}

export function renderDoctorsSection() {
  const container = document.getElementById('doctors-visits-container');
  const badge = document.getElementById('doctors-progress-badge');
  const nextBanner = document.getElementById('doctors-next-banner');
  if (!container) return;

  const appState = store.appState;
  const filter = appState.doctorFilter || 'all';
  document.querySelectorAll('.doctor-filter-btn').forEach(btn => {
    const active = btn.getAttribute('data-doc-filter') === filter;
    btn.className = active
      ? 'doctor-filter-btn px-2.5 py-1 rounded-lg text-xs font-bold bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs shrink-0'
      : 'doctor-filter-btn px-2.5 py-1 rounded-lg text-xs font-bold text-slate-500 dark:text-slate-400 shrink-0';
  });

  const checkupsMap = appState.checkupsMap || {};
  const customVisits = Array.isArray(appState.customVisits) ? appState.customVisits : [];
  const dobIso = appState.babyDob || getTodayIso();
  const now = Date.now();

  const doneCheckupsCount = DOCTOR_CHECKUPS_SCHEDULE.filter(item => Boolean(checkupsMap[item.id]?.done)).length;
  if (badge) {
    badge.textContent = `${doneCheckupsCount} из ${DOCTOR_CHECKUPS_SCHEDULE.length} чек-апов`;
  }

  // Собираем ближайшие назначенные приёмы для баннера сверху
  const scheduledUpcoming = [];
  for (const item of DOCTOR_CHECKUPS_SCHEDULE) {
    const rec = checkupsMap[item.id];
    if (!rec || rec.done || !rec.scheduledDate) continue;
    const ts = parseAppointmentLocalMs(rec.scheduledDate, rec.scheduledTime || '10:00');
    if (ts && ts >= now - 3600000) {
      scheduledUpcoming.push({
        kind: 'checkup',
        id: item.id,
        title: item.title,
        subtitle: item.ageLabel,
        date: rec.scheduledDate,
        time: rec.scheduledTime || '10:00',
        clinic: rec.clinic || '',
        doctorName: rec.doctorName || '',
        questions: rec.questions || '',
        ts
      });
    }
  }
  for (const v of customVisits) {
    if (v.status === 'done' || !v.date) continue;
    const ts = parseAppointmentLocalMs(v.date, v.time || '10:00');
    if (ts && ts >= now - 3600000) {
      scheduledUpcoming.push({
        kind: 'custom',
        id: v.id,
        title: v.title,
        subtitle: v.specialist || 'Врач',
        date: v.date,
        time: v.time || '10:00',
        clinic: v.clinic || '',
        doctorName: v.doctorName || '',
        questions: v.questions || '',
        ts
      });
    }
  }
  scheduledUpcoming.sort((a, b) => a.ts - b.ts);

  if (nextBanner) {
    if (scheduledUpcoming.length > 0) {
      const next = scheduledUpcoming[0];
      const openFn = next.kind === 'custom'
        ? `openCustomVisitModal('${escapeHtml(next.id)}')`
        : `openCheckupModal('${escapeHtml(next.id)}')`;
      const metaParts = [next.clinic, next.doctorName].filter(Boolean).map(escapeHtml);
      nextBanner.innerHTML = `
        <div onclick="${openFn}" class="p-3.5 rounded-2xl bg-sky-50/85 dark:bg-sky-950/40 border border-sky-200/80 dark:border-sky-800/60 flex items-start justify-between gap-3 cursor-pointer hover:border-sky-400 transition">
          <div class="flex items-start gap-2.5 min-w-0">
            <div class="w-8 h-8 rounded-xl bg-sky-600 text-white flex items-center justify-center shrink-0 mt-0.5">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            </div>
            <div class="min-w-0">
              <div class="text-[11px] font-bold text-sky-700 dark:text-sky-300">
                Ближайший приём: ${escapeHtml(formatAppointmentBadgeText(next.date, next.time))}
              </div>
              <div class="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-slate-100 truncate">${escapeHtml(next.title)}</div>
              ${metaParts.length > 0 ? `<div class="text-[11px] text-slate-600 dark:text-slate-300 truncate">${metaParts.join(' • ')}</div>` : ''}
              ${next.questions ? `<div class="text-[11px] text-sky-700/90 dark:text-sky-300/90 mt-0.5 truncate">Есть вопросы врачу</div>` : ''}
            </div>
          </div>
          <span class="text-xs font-bold text-sky-600 dark:text-sky-300 shrink-0">Открыть</span>
        </div>
      `;
    } else {
      const nextAgeCheckup = DOCTOR_CHECKUPS_SCHEDULE.find(item => !checkupsMap[item.id]?.done);
      if (nextAgeCheckup) {
        const plannedIso = getAgePlannedIso(dobIso, nextAgeCheckup.daysOffset);
        nextBanner.innerHTML = `
          <div onclick="openCheckupModal('${nextAgeCheckup.id}')" class="p-3 rounded-2xl bg-warmgray/80 dark:bg-slate-800/70 border border-stone-200/80 dark:border-slate-700 flex items-center justify-between gap-2.5 cursor-pointer hover:border-sky-300 transition">
            <div class="min-w-0">
              <div class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">Следующий плановый осмотр по возрасту • ориентир ${formatDateRu(plannedIso)}</div>
              <div class="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100 truncate">${escapeHtml(nextAgeCheckup.title)} (${escapeHtml(nextAgeCheckup.ageLabel)})</div>
            </div>
            <span class="text-xs font-bold text-sky-600 dark:text-sky-400 shrink-0">Записаться</span>
          </div>
        `;
      } else {
        nextBanner.innerHTML = '';
      }
    }
  }

  // Формируем единый список карточек с учётом фильтра
  const cards = [];

  // 1. Личные (внеплановые) визиты
  customVisits.forEach(v => {
    const isDone = v.status === 'done';
    const isPlanned = !isDone && Boolean(v.date);
    if (filter === 'done' && !isDone) return;
    if (filter === 'pending' && isDone) return;
    if (filter === 'planned' && !isPlanned) return;

    const apptMs = parseAppointmentLocalMs(v.date, v.time || '10:00') || 0;
    const priority = isPlanned ? 1 : isDone ? 4 : 2;

    cards.push({
      priority,
      sortKey: apptMs,
      html: renderCustomVisitCard(v)
    });
  });

  // 2. Возрастные чек-апы (если не фильтр 'custom')
  if (filter !== 'custom') {
    DOCTOR_CHECKUPS_SCHEDULE.forEach(item => {
      const rec = checkupsMap[item.id] || {};
      const isDone = Boolean(rec.done);
      const hasScheduled = !isDone && Boolean(rec.scheduledDate);

      if (filter === 'planned' && !hasScheduled) return;
      if (filter === 'pending' && isDone) return;
      if (filter === 'done' && !isDone) return;

      const apptMs = hasScheduled
        ? (parseAppointmentLocalMs(rec.scheduledDate, rec.scheduledTime || '10:00') || 0)
        : (new Date(dobIso).getTime() + item.daysOffset * 86400000);
      const priority = hasScheduled ? 1 : isDone ? 4 : 3;

      cards.push({
        priority,
        sortKey: apptMs,
        html: renderCheckupCard(item, rec, dobIso)
      });
    });
  }

  cards.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.priority === 4) return b.sortKey - a.sortKey;
    return a.sortKey - b.sortKey;
  });

  if (cards.length === 0) {
    const emptyMsg = filter === 'planned'
      ? 'Пока нет назначенных дат приёма. Нажмите на любой чек-ап или «Добавить визит», чтобы записаться и включить напоминание.'
      : filter === 'custom'
        ? 'Личных записей к врачам пока нет. Нажмите «+ Добавить визит», чтобы запланировать консультацию, УЗИ или анализы.'
        : 'В выбранном фильтре визитов пока нет.';
    container.innerHTML = `<div class="py-6 text-center text-xs text-slate-400 leading-relaxed">${emptyMsg}</div>`;
    return;
  }

  container.innerHTML = cards.map(c => c.html).join('');
}

function renderCheckupCard(item, rec, dobIso) {
  const isDone = Boolean(rec.done);
  const hasScheduled = !isDone && Boolean(rec.scheduledDate);
  const specsTotal = Array.isArray(item.specialists) ? item.specialists.length : 0;
  const specsDone = Array.isArray(item.specialists)
    ? item.specialists.filter(s => Boolean(rec.specialists?.[s.id])).length
    : 0;
  const plannedIso = getAgePlannedIso(dobIso, item.daysOffset);
  const dateLabel = isDone && rec.completedAtDate
    ? `Пройдено: ${formatDateRu(rec.completedAtDate)}`
    : hasScheduled
      ? `Запись: ${formatAppointmentBadgeText(rec.scheduledDate, rec.scheduledTime || '10:00')}`
      : `Ориентир: ${formatDateRu(plannedIso)}`;

  const cardStyle = isDone
    ? 'bg-emerald-50/50 dark:bg-emerald-950/25 border-emerald-200/70 dark:border-emerald-900/50'
    : hasScheduled
      ? 'bg-sky-50/60 dark:bg-sky-950/25 border-sky-200/80 dark:border-sky-800/60 hover:border-sky-400'
      : 'bg-warmgray/60 dark:bg-slate-800/60 border-stone-200/70 dark:border-slate-700 hover:border-sky-300';

  const hasQuestions = Boolean(rec.questions && rec.questions.trim());
  const detailsParts = [rec.clinic, rec.doctorName].filter(Boolean).map(escapeHtml);

  return `
    <div onclick="openCheckupModal('${item.id}')" class="p-3.5 rounded-2xl border transition cursor-pointer flex items-start justify-between gap-3 ${cardStyle}">
      <div class="flex items-start gap-3 min-w-0">
        <div class="mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
          isDone
            ? 'bg-emerald-500 text-white'
            : hasScheduled
              ? 'bg-sky-600 text-white'
              : 'border-2 border-slate-300 dark:border-slate-600'
        }">
          ${isDone
            ? '<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
            : hasScheduled
              ? '<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>'
              : ''}
        </div>
        <div class="min-w-0 space-y-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-sky-100/80 dark:bg-sky-950 text-sky-700 dark:text-sky-300">${escapeHtml(item.ageLabel)}</span>
            <span class="text-[11px] font-semibold ${hasScheduled ? 'text-sky-700 dark:text-sky-300' : 'text-slate-500 dark:text-slate-400'}">${escapeHtml(dateLabel)}</span>
            ${hasScheduled && rec.notifyEnabled !== false ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-white/80 dark:bg-slate-800 text-sky-600 dark:text-sky-300">Напомнит</span>` : ''}
          </div>
          <div class="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100">${escapeHtml(item.title)}</div>
          <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
            ${specsTotal > 0 ? `<span class="font-semibold ${specsDone === specsTotal ? 'text-emerald-600 dark:text-emerald-400' : ''}">Специалисты: ${specsDone}/${specsTotal}</span>` : ''}
            ${detailsParts.length > 0 ? `<span class="truncate">${detailsParts.join(' • ')}</span>` : ''}
            ${hasQuestions ? `<span class="text-amber-600 dark:text-amber-400 font-semibold">Есть вопросы</span>` : ''}
          </div>
        </div>
      </div>
      <span class="text-xs font-semibold text-sky-600 dark:text-sky-400 shrink-0">Открыть</span>
    </div>
  `;
}

function renderCustomVisitCard(v) {
  const isDone = v.status === 'done';
  const dateLabel = formatAppointmentBadgeText(v.date, v.time || '10:00');
  const detailsParts = [v.clinic, v.doctorName].filter(Boolean).map(escapeHtml);
  const hasQuestions = Boolean(v.questions && v.questions.trim());

  const cardStyle = isDone
    ? 'bg-emerald-50/50 dark:bg-emerald-950/25 border-emerald-200/70 dark:border-emerald-900/50'
    : 'bg-indigo-50/50 dark:bg-indigo-950/25 border-indigo-200/70 dark:border-indigo-800/60 hover:border-sky-400';

  return `
    <div onclick="openCustomVisitModal('${escapeHtml(v.id)}')" class="p-3.5 rounded-2xl border transition cursor-pointer flex items-start justify-between gap-3 ${cardStyle}">
      <div class="flex items-start gap-3 min-w-0">
        <button type="button" onclick="toggleCustomVisitDone('${escapeHtml(v.id)}', event)" title="${isDone ? 'Вернуть в план' : 'Отметить как пройденный'}" class="mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition ${
          isDone ? 'bg-emerald-500 text-white' : 'border-2 border-indigo-400 dark:border-indigo-500 hover:bg-indigo-100 dark:hover:bg-indigo-900/50'
        }">
          ${isDone ? '<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
        </button>
        <div class="min-w-0 space-y-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-indigo-100/90 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300">${escapeHtml(v.specialist || 'Личный визит')}</span>
            <span class="text-[11px] font-semibold ${isDone ? 'text-slate-500 dark:text-slate-400' : 'text-indigo-700 dark:text-indigo-300'}">${escapeHtml(dateLabel)}</span>
            ${!isDone && v.notifyEnabled !== false ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-white/80 dark:bg-slate-800 text-sky-600 dark:text-sky-300">Напомнит</span>` : ''}
          </div>
          <div class="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100">${escapeHtml(v.title)}</div>
          ${detailsParts.length > 0 || hasQuestions ? `
            <div class="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-slate-500 dark:text-slate-400">
              ${detailsParts.length > 0 ? `<span class="truncate">${detailsParts.join(' • ')}</span>` : ''}
              ${hasQuestions ? `<span class="text-amber-600 dark:text-amber-400 font-semibold">Есть вопросы</span>` : ''}
            </div>
          ` : ''}
        </div>
      </div>
      <span class="text-xs font-semibold text-indigo-600 dark:text-indigo-300 shrink-0">Изменить</span>
    </div>
  `;
}

function renderCheckupSpecialistsList(item) {
  const wrap = document.getElementById('checkup-specialists-list');
  if (!wrap || !item) return;
  const list = Array.isArray(item.specialists) ? item.specialists : [];
  if (list.length === 0) {
    wrap.innerHTML = '<div class="text-xs text-slate-400 col-span-2">Осмотр педиатра по плану</div>';
    return;
  }
  wrap.innerHTML = list.map(spec => {
    const checked = Boolean(tempCheckupSpecialists[spec.id]);
    return `
      <button type="button" onclick="toggleCheckupSpecialist('${spec.id}')" class="py-2 px-2.5 rounded-xl border text-left text-[11px] font-semibold transition flex items-center gap-2 ${
        checked
          ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200'
          : 'bg-warmgray/60 dark:bg-slate-800 border-stone-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
      }">
        <span class="w-4 h-4 rounded-md flex items-center justify-center shrink-0 ${checked ? 'bg-emerald-500 text-white' : 'border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900'}">
          ${checked ? '<svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
        </span>
        <span class="leading-snug">${escapeHtml(spec.label)}</span>
      </button>
    `;
  }).join('');
}

export function openCheckupModal(checkupId) {
  const item = DOCTOR_CHECKUPS_SCHEDULE.find(c => c.id === checkupId);
  if (!item) return;
  const rec = (store.appState.checkupsMap || {})[checkupId] || {};
  const plannedIso = getAgePlannedIso(store.appState.babyDob, item.daysOffset);

  document.getElementById('checkup-id-input').value = checkupId;
  document.getElementById('modal-checkup-title').textContent = item.title;
  document.getElementById('modal-checkup-subtitle').textContent = `Возраст: ${item.ageLabel} • ориентир по дате рождения: ${formatDateRu(plannedIso)}`;
  document.getElementById('modal-checkup-summary').textContent = item.summary || '';

  tempCheckupSpecialists = { ...(rec.specialists || {}) };
  renderCheckupSpecialistsList(item);

  document.getElementById('checkup-scheduled-date-input').value = rec.scheduledDate || '';
  document.getElementById('checkup-scheduled-time-input').value = rec.scheduledTime || '10:00';
  document.getElementById('checkup-notify-checkbox').checked = rec.notifyEnabled !== false;
  document.getElementById('checkup-done-checkbox').checked = Boolean(rec.done);
  document.getElementById('checkup-completed-date-input').value = rec.completedAtDate || getTodayIso();
  document.getElementById('checkup-clinic-input').value = rec.clinic || '';
  document.getElementById('checkup-doctor-input').value = rec.doctorName || '';
  document.getElementById('checkup-questions-input').value = rec.questions || '';
  document.getElementById('checkup-notes-input').value = rec.notes || '';

  syncRuDateDisplays();
  openModal('modal-checkup');
}

export function toggleCheckupSpecialist(specId) {
  const checkupId = document.getElementById('checkup-id-input')?.value;
  const item = DOCTOR_CHECKUPS_SCHEDULE.find(c => c.id === checkupId);
  if (!item) return;
  tempCheckupSpecialists[specId] = !tempCheckupSpecialists[specId];
  renderCheckupSpecialistsList(item);
}

export function markAllCheckupSpecialists() {
  const checkupId = document.getElementById('checkup-id-input')?.value;
  const item = DOCTOR_CHECKUPS_SCHEDULE.find(c => c.id === checkupId);
  if (!item) return;
  const allChecked = (item.specialists || []).every(s => Boolean(tempCheckupSpecialists[s.id]));
  (item.specialists || []).forEach(s => {
    tempCheckupSpecialists[s.id] = !allChecked;
  });
  renderCheckupSpecialistsList(item);
}

export function clearCheckupScheduledDate() {
  const inp = document.getElementById('checkup-scheduled-date-input');
  if (inp) inp.value = '';
  syncRuDateDisplays();
}

export function saveCheckupRecord(e) {
  if (e) e.preventDefault();
  const id = document.getElementById('checkup-id-input')?.value;
  if (!id) return;

  const done = Boolean(document.getElementById('checkup-done-checkbox')?.checked);
  const completedAtDate = done ? (document.getElementById('checkup-completed-date-input')?.value || getTodayIso()) : '';
  const scheduledDate = document.getElementById('checkup-scheduled-date-input')?.value || '';
  const scheduledTime = document.getElementById('checkup-scheduled-time-input')?.value || '10:00';
  const notifyEnabled = Boolean(document.getElementById('checkup-notify-checkbox')?.checked);

  if (!store.appState.checkupsMap || typeof store.appState.checkupsMap !== 'object') {
    store.appState.checkupsMap = {};
  }
  store.appState.checkupsMap[id] = {
    done,
    completedAtDate,
    scheduledDate,
    scheduledTime,
    clinic: (document.getElementById('checkup-clinic-input')?.value || '').trim().slice(0, 120),
    doctorName: (document.getElementById('checkup-doctor-input')?.value || '').trim().slice(0, 120),
    specialists: { ...tempCheckupSpecialists },
    questions: (document.getElementById('checkup-questions-input')?.value || '').trim().slice(0, 500),
    notes: (document.getElementById('checkup-notes-input')?.value || '').trim().slice(0, 800),
    notifyEnabled,
    updatedAt: Date.now()
  };

  closeModal('modal-checkup');
  saveAppState();
  renderDoctorsSection();
  hooks.evaluateSmartNotifications();
  showToast('Данные диспансеризации сохранены');
}

export function openCustomVisitModal(visitId = null) {
  const list = Array.isArray(store.appState.customVisits) ? store.appState.customVisits : [];
  const existing = visitId ? list.find(v => v.id === visitId) : null;

  document.getElementById('custom-visit-id-input').value = existing ? existing.id : '';
  document.getElementById('modal-custom-visit-title').textContent = existing ? 'Редактировать визит' : 'Новый визит к врачу';
  document.getElementById('custom-visit-specialist-input').value = existing ? (existing.specialist || '') : '';
  document.getElementById('custom-visit-title-input').value = existing ? (existing.title || '') : '';
  document.getElementById('custom-visit-date-input').value = existing ? (existing.date || getTodayIso()) : getTodayIso();
  document.getElementById('custom-visit-time-input').value = existing ? (existing.time || '10:00') : '10:00';
  document.getElementById('custom-visit-notify-checkbox').checked = existing ? (existing.notifyEnabled !== false) : true;
  document.getElementById('custom-visit-done-checkbox').checked = existing ? (existing.status === 'done') : false;
  document.getElementById('custom-visit-clinic-input').value = existing ? (existing.clinic || '') : '';
  document.getElementById('custom-visit-doctor-input').value = existing ? (existing.doctorName || '') : '';
  document.getElementById('custom-visit-questions-input').value = existing ? (existing.questions || '') : '';
  document.getElementById('custom-visit-notes-input').value = existing ? (existing.notes || '') : '';

  const delBtn = document.getElementById('custom-visit-delete-btn');
  if (delBtn) delBtn.classList.toggle('hidden', !existing);

  syncRuDateDisplays();
  openModal('modal-custom-visit');
}

export function pickCustomVisitSpecialist(spec) {
  const specInp = document.getElementById('custom-visit-specialist-input');
  const titleInp = document.getElementById('custom-visit-title-input');
  if (specInp) specInp.value = spec;
  if (titleInp && !titleInp.value.trim()) {
    titleInp.value = spec === 'УЗИ / Анализы' ? 'Плановое обследование' : `Консультация (${spec.toLowerCase()})`;
  }
}

export function saveCustomVisit(e) {
  if (e) e.preventDefault();
  const idInp = document.getElementById('custom-visit-id-input')?.value;
  const specialist = (document.getElementById('custom-visit-specialist-input')?.value || '').trim().slice(0, 80);
  const title = (document.getElementById('custom-visit-title-input')?.value || '').trim().slice(0, 120);
  if (!title && !specialist) return;

  const isEdit = Boolean(idInp);
  const id = idInp || generateEntityId('visit');
  const now = Date.now();
  const visitObj = {
    id,
    title: title || specialist,
    specialist: specialist || title,
    status: document.getElementById('custom-visit-done-checkbox')?.checked ? 'done' : 'planned',
    date: document.getElementById('custom-visit-date-input')?.value || getTodayIso(),
    time: document.getElementById('custom-visit-time-input')?.value || '10:00',
    clinic: (document.getElementById('custom-visit-clinic-input')?.value || '').trim().slice(0, 120),
    doctorName: (document.getElementById('custom-visit-doctor-input')?.value || '').trim().slice(0, 120),
    questions: (document.getElementById('custom-visit-questions-input')?.value || '').trim().slice(0, 500),
    notes: (document.getElementById('custom-visit-notes-input')?.value || '').trim().slice(0, 800),
    notifyEnabled: Boolean(document.getElementById('custom-visit-notify-checkbox')?.checked),
    author: getCurrentCaregiverName(),
    updatedAt: now
  };

  if (!Array.isArray(store.appState.customVisits)) store.appState.customVisits = [];
  if (isEdit) {
    store.appState.customVisits = store.appState.customVisits.map(v => (v.id === id ? visitObj : v));
  } else {
    store.appState.customVisits.push(visitObj);
  }

  closeModal('modal-custom-visit');
  saveAppState();
  renderDoctorsSection();
  hooks.evaluateSmartNotifications();
  showToast(isEdit ? 'Визит обновлён' : 'Визит к врачу добавлен');
}

export function toggleCustomVisitDone(visitId, event) {
  if (event) event.stopPropagation();
  const list = Array.isArray(store.appState.customVisits) ? store.appState.customVisits : [];
  const target = list.find(v => v.id === visitId);
  if (!target) return;
  target.status = target.status === 'done' ? 'planned' : 'done';
  target.updatedAt = Date.now();
  saveAppState();
  renderDoctorsSection();
  hooks.evaluateSmartNotifications();
  showToast(target.status === 'done' ? 'Визит отмечен как пройденный' : 'Визит возвращён в план');
}

export function deleteCustomVisitFromModal() {
  const id = document.getElementById('custom-visit-id-input')?.value;
  if (!id) return;
  markDeletedId('visits', id, Date.now());
  store.appState.customVisits = (store.appState.customVisits || []).filter(v => v.id !== id);
  closeModal('modal-custom-visit');
  saveAppState();
  renderDoctorsSection();
  hooks.evaluateSmartNotifications();
  showToast('Запись о визите удалена');
}

