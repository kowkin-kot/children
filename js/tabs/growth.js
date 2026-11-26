// Вкладка 4: Рост и вес (график норм ВОЗ от 0 до 5 лет и история замеров)

import { WHO_STANDARDS } from '../data.js';
import { store, markDeletedId } from '../state.js';
import { escapeHtml, generateEntityId, getTodayIso, formatDateRu, showToast } from '../utils.js';
import { saveAppState } from '../firebase.js';

export function setGrowthMetric(metric) {
  store.appState.growthMetric = metric === 'height' ? 'height' : 'weight';
  store.appState.uiUpdatedAt = Date.now();
  saveAppState();
  renderGrowthTab();
}

export function addGrowthRecord(e) {
  if (e) e.preventDefault();
  const date = document.getElementById('growth-date-input')?.value || getTodayIso();
  const wRaw = document.getElementById('growth-weight-input')?.value;
  const hRaw = document.getElementById('growth-height-input')?.value;
  const weight = wRaw ? parseFloat(wRaw) : null;
  const height = hRaw ? parseFloat(hRaw) : null;

  if (!weight && !height) {
    showToast('Укажите вес или рост малыша');
    return;
  }

  store.appState.growthRecords.push({
    id: generateEntityId('gr'),
    date,
    weight,
    height,
    updatedAt: Date.now()
  });
  store.appState.growthRecords.sort((a, b) => a.date.localeCompare(b.date));

  const wInp = document.getElementById('growth-weight-input');
  const hInp = document.getElementById('growth-height-input');
  if (wInp) wInp.value = '';
  if (hInp) hInp.value = '';

  saveAppState();
  renderGrowthTab();
  showToast('Замер сохранён');
}

export function deleteGrowthRecord(recId) {
  markDeletedId('growth', recId, Date.now());
  store.appState.growthRecords = (store.appState.growthRecords || []).filter(r => r.id !== recId);
  saveAppState();
  renderGrowthTab();
  showToast('Замер удалён');
}

export function renderGrowthTab() {
  const appState = store.appState;
  const metric = appState.growthMetric === 'height' ? 'height' : 'weight';
  const btnW = document.getElementById('growth-metric-weight');
  const btnH = document.getElementById('growth-metric-height');
  if (btnW) btnW.className = metric === 'weight' ? 'px-3 py-1 rounded-lg text-xs font-bold bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs' : 'px-3 py-1 rounded-lg text-xs font-bold text-slate-500 dark:text-slate-400';
  if (btnH) btnH.className = metric === 'height' ? 'px-3 py-1 rounded-lg text-xs font-bold bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-2xs' : 'px-3 py-1 rounded-lg text-xs font-bold text-slate-500 dark:text-slate-400';

  const chartWrap = document.getElementById('who-chart-wrapper');
  const listWrap = document.getElementById('growth-records-list');
  if (!chartWrap) return;

  const isBoy = appState.babyGender === 'boy';
  const key = metric === 'weight' ? (isBoy ? 'wB' : 'wG') : (isBoy ? 'hB' : 'hG');
  const yMin = metric === 'weight' ? 2 : 45;
  const yMax = metric === 'weight' ? 23 : 120;

  const W = 540;
  const H = 220;
  const padL = 36;
  const padR = 16;
  const padT = 16;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xScale = (m) => padL + (Math.max(0, Math.min(60, m)) / 60) * plotW;
  const yScale = (val) => padT + plotH - ((val - yMin) / (yMax - yMin)) * plotH;

  const upperPts = WHO_STANDARDS.map(s => `${xScale(s.m).toFixed(1)},${yScale(s[key][2]).toFixed(1)}`);
  const lowerPts = [...WHO_STANDARDS].reverse().map(s => `${xScale(s.m).toFixed(1)},${yScale(s[key][0]).toFixed(1)}`);
  const medianPts = WHO_STANDARDS.map(s => `${xScale(s.m).toFixed(1)},${yScale(s[key][1]).toFixed(1)}`).join(' ');

  const dobMs = new Date(appState.babyDob || getTodayIso()).getTime();
  const userPoints = (appState.growthRecords || [])
    .filter(r => (metric === 'weight' ? r.weight : r.height) !== null && (metric === 'weight' ? r.weight : r.height) !== undefined)
    .map(r => {
      const m = Math.max(0, (new Date(r.date).getTime() - dobMs) / (86400000 * 30.4375));
      const val = metric === 'weight' ? Number(r.weight) : Number(r.height);
      return { x: xScale(m), y: yScale(val), val, date: formatDateRu(r.date) };
    });

  const userPolyline = userPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const xTicks = [0, 6, 12, 24, 36, 48, 60];
  const yTicks = metric === 'weight' ? [3, 6, 10, 14, 18, 22] : [50, 65, 80, 95, 110];

  chartWrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="w-full min-w-[320px] h-auto select-none">
      ${yTicks.map(v => `
        <line x1="${padL}" y1="${yScale(v).toFixed(1)}" x2="${W - padR}" y2="${yScale(v).toFixed(1)}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="3 3" />
        <text x="${padL - 6}" y="${(yScale(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="#94a3b8">${v}</text>
      `).join('')}
      ${xTicks.map(m => `
        <text x="${xScale(m).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#94a3b8">${m === 0 ? '0' : m < 12 ? m + 'м' : (m / 12) + 'г'}</text>
      `).join('')}

      <polygon points="${upperPts.concat(lowerPts).join(' ')}" fill="#f43f5e" fill-opacity="0.12" />
      <polyline fill="none" stroke="#f43f5e" stroke-opacity="0.45" stroke-width="1.5" stroke-dasharray="4 3" points="${medianPts}" />

      ${userPoints.length > 1 ? `<polyline fill="none" stroke="#0f172a" stroke-width="2.5" points="${userPolyline}" />` : ''}
      ${userPoints.map(p => `
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#f43f5e" stroke="#ffffff" stroke-width="1.5">
          <title>${p.date}: ${p.val} ${metric === 'weight' ? 'кг' : 'см'}</title>
        </circle>
      `).join('')}
    </svg>
  `;

  if (listWrap) {
    const recs = [...(appState.growthRecords || [])].reverse();
    if (recs.length === 0) {
      listWrap.innerHTML = `<div class="py-5 text-center text-xs text-slate-400">Добавьте первый замер веса или роста выше, чтобы увидеть точку на кривой ВОЗ.</div>`;
    } else {
      listWrap.innerHTML = recs.map(r => `
        <div class="py-2.5 flex items-center justify-between gap-2 text-xs">
          <div class="flex items-center gap-3">
            <span class="font-bold text-slate-700 dark:text-slate-200">${formatDateRu(r.date)}</span>
            ${r.weight ? `<span class="px-2 py-0.5 rounded-lg bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-300 font-semibold">${r.weight} кг</span>` : ''}
            ${r.height ? `<span class="px-2 py-0.5 rounded-lg bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-300 font-semibold">${r.height} см</span>` : ''}
          </div>
          <button type="button" onclick="deleteGrowthRecord('${escapeHtml(r.id)}')" class="text-slate-400 hover:text-rose-500 p-1">Удалить</button>
        </div>
      `).join('');
    }
  }
}
