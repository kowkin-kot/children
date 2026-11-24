// Вкладка 5: Советы SOS (шпаргалка для родителей с поиском)

import { SYMPTOMS_DATA } from '../data.js';

export function renderSymptoms() {
  const grid = document.getElementById('symptoms-grid');
  if (!grid) return;
  const query = (document.getElementById('sos-search-input')?.value || '').trim().toLowerCase();

  const filtered = SYMPTOMS_DATA.filter(item => {
    if (!query) return true;
    return (
      item.title.toLowerCase().includes(query) ||
      item.summary.toLowerCase().includes(query) ||
      item.steps.some(s => s.toLowerCase().includes(query))
    );
  });

  grid.innerHTML = filtered.map(item => `
    <article class="bg-white dark:bg-slate-900 rounded-3xl border border-stone-200/70 dark:border-slate-800 p-4 sm:p-5 space-y-3 shadow-2xs">
      <div class="flex items-start justify-between gap-2">
        <h3 class="font-display font-extrabold text-sm sm:text-base text-slate-900 dark:text-slate-100">${item.title}</h3>
        <span class="px-2.5 py-0.5 rounded-full bg-warmgray dark:bg-slate-800 text-[11px] font-bold text-slate-600 dark:text-slate-300 shrink-0">${item.age}</span>
      </div>
      <p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">${item.summary}</p>
      <ul class="space-y-1.5 text-xs text-slate-700 dark:text-slate-200">
        ${item.steps.map(st => `<li class="flex items-start gap-2"><span class="text-emerald-500 font-bold">•</span><span>${st}</span></li>`).join('')}
      </ul>
      <div class="p-2.5 rounded-2xl bg-rose-50/80 dark:bg-rose-950/40 border border-rose-200/60 dark:border-rose-900/50 text-[11px] text-rose-800 dark:text-rose-200">
        <strong>Когда срочно к врачу:</strong> ${item.redFlags}
      </div>
    </article>
  `).join('');
}
