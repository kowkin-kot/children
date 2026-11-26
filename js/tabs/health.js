// Вкладка 3: Здоровье (интерактивная зубная карта и календарь прививок/осмотров)

import { PRIMARY_TEETH, TOOTH_SYMPTOM_OPTIONS, VACCINE_SCHEDULE } from '../data.js';
import { store } from '../state.js';
import {
  escapeHtml,
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

export function setVaccineFilter(filter) {
  store.appState.vaccineFilter = filter;
  store.appState.uiUpdatedAt = Date.now();
  saveAppState();
  renderVaccinesList();
}

export function renderVaccinesList() {
  const container = document.getElementById('vaccines-list-container');
  if (!container) return;

  const appState = store.appState;
  const filter = appState.vaccineFilter || 'all';
  document.querySelectorAll('.vac-filter-btn').forEach(btn => {
    const active = btn.getAttribute('data-vac-filter') === filter;
    btn.className = active
      ? 'vac-filter-btn px-2.5 py-1 rounded-lg text-xs font-bold bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs'
      : 'vac-filter-btn px-2.5 py-1 rounded-lg text-xs font-bold text-slate-500 dark:text-slate-400';
  });

  const dobMs = new Date(appState.babyDob || getTodayIso()).getTime();
  const items = VACCINE_SCHEDULE.filter(item => {
    const isDone = Boolean((appState.vaccinesMap || {})[item.id]?.done);
    if (filter === 'done') return isDone;
    if (filter === 'pending') return !isDone;
    return true;
  });

  if (items.length === 0) {
    container.innerHTML = `<div class="py-6 text-center text-xs text-slate-400">В выбранном фильтре пунктов пока нет.</div>`;
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
              <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${
                item.type === 'vaccine' ? 'bg-rose-100/80 dark:bg-rose-950 text-rose-700 dark:text-rose-300' : 'bg-sky-100/80 dark:bg-sky-950 text-sky-700 dark:text-sky-300'
              }">${item.ageLabel}</span>
              <span class="text-[11px] text-slate-500 dark:text-slate-400 font-medium">${displayDate}</span>
            </div>
            <div class="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-100">${item.title}</div>
            ${rec.drug ? `<div class="text-[11px] text-slate-500 mt-0.5">Препарат / врач: ${escapeHtml(rec.drug)}${rec.series ? ` (${escapeHtml(rec.series)})` : ''}</div>` : ''}
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
  showToast('Отметка сохранена');
}
