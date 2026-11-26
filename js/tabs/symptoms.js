// Вкладка 5: Советы по воспитанию, развитию и здоровью (0–5 лет)

import { SYMPTOMS_DATA } from '../data.js';

let activeAdviceCategory = 'all';
let activeAdviceAge = 'all';

const ADVICE_AGE_RANGES = {
  all: null,
  '0-3m': [0, 3],
  '3-12m': [3, 12],
  '1-3y': [12, 36],
  '3-5y': [36, 60]
};

export function setAdviceCategory(category) {
  activeAdviceCategory = category || 'all';
  renderSymptoms();
}

export function setAdviceAgeFilter(ageGroup) {
  activeAdviceAge = Object.prototype.hasOwnProperty.call(ADVICE_AGE_RANGES, ageGroup) ? ageGroup : 'all';
  renderSymptoms();
}

export function renderSymptoms() {
  const grid = document.getElementById('symptoms-grid');
  if (!grid) return;

  const query = (document.getElementById('sos-search-input')?.value || '').trim().toLowerCase();

  document.querySelectorAll('.advice-cat-btn').forEach(btn => {
    const isSel = btn.getAttribute('data-advice-cat') === activeAdviceCategory;
    btn.className = isSel
      ? 'advice-cat-btn px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-500 text-white shadow-2xs transition shrink-0'
      : 'advice-cat-btn px-3 py-1.5 rounded-xl text-xs font-bold bg-warmgray dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition shrink-0';
  });

  document.querySelectorAll('.advice-age-btn').forEach(btn => {
    const isSel = btn.getAttribute('data-advice-age') === activeAdviceAge;
    btn.className = isSel
      ? 'advice-age-btn px-2.5 py-1 rounded-lg text-[11px] font-bold bg-slate-800 dark:bg-slate-100 text-white dark:text-slate-900 shadow-2xs transition shrink-0'
      : 'advice-age-btn px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-warmgray/80 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition shrink-0';
  });

  const ageBounds = ADVICE_AGE_RANGES[activeAdviceAge];

  const filtered = SYMPTOMS_DATA.filter(item => {
    if (activeAdviceCategory !== 'all' && item.category !== activeAdviceCategory) {
      return false;
    }
    if (ageBounds) {
      const minM = Number.isFinite(item.ageMinMonths) ? item.ageMinMonths : 0;
      const maxM = Number.isFinite(item.ageMaxMonths) ? item.ageMaxMonths : 60;
      if (maxM < ageBounds[0] || minM > ageBounds[1]) {
        return false;
      }
    }
    if (!query) return true;
    return (
      item.title.toLowerCase().includes(query) ||
      item.summary.toLowerCase().includes(query) ||
      (item.age || '').toLowerCase().includes(query) ||
      (item.tags || '').toLowerCase().includes(query) ||
      (item.categoryLabel || '').toLowerCase().includes(query) ||
      (item.importantNote || '').toLowerCase().includes(query) ||
      (item.specialistNote || '').toLowerCase().includes(query) ||
      (item.redFlags || '').toLowerCase().includes(query) ||
      item.steps.some(s => s.toLowerCase().includes(query))
    );
  });

  if (ageBounds) {
    filtered.sort((a, b) => {
      const spanA = (Number.isFinite(a.ageMaxMonths) ? a.ageMaxMonths : 60) - (Number.isFinite(a.ageMinMonths) ? a.ageMinMonths : 0);
      const spanB = (Number.isFinite(b.ageMaxMonths) ? b.ageMaxMonths : 60) - (Number.isFinite(b.ageMinMonths) ? b.ageMinMonths : 0);
      return spanA - spanB;
    });
  }

  const countBadge = document.getElementById('advice-count-badge');
  if (countBadge) {
    countBadge.textContent = `${filtered.length} из ${SYMPTOMS_DATA.length}`;
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full bg-white dark:bg-slate-900 rounded-3xl border border-stone-200/70 dark:border-slate-800 p-8 text-center text-xs text-slate-400">
        По вашему запросу советов не найдено. Попробуйте изменить запрос или сбросить фильтры категории и возраста.
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map(item => {
    const catBadgeClass = item.category === 'parenting'
      ? 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300'
      : item.category === 'habits'
        ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300'
        : 'bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300';

    let calloutHtml = '';
    if (item.redFlags) {
      calloutHtml = `
        <div class="p-2.5 rounded-2xl bg-rose-50/80 dark:bg-rose-950/40 border border-rose-200/60 dark:border-rose-900/50 text-[11px] text-rose-800 dark:text-rose-200 leading-relaxed">
          <strong>Когда срочно к врачу:</strong> ${item.redFlags}
        </div>
      `;
    } else if (item.specialistNote) {
      calloutHtml = `
        <div class="p-2.5 rounded-2xl bg-amber-50/80 dark:bg-amber-950/40 border border-amber-200/60 dark:border-amber-900/50 text-[11px] text-amber-900 dark:text-amber-200 leading-relaxed">
          <strong>Когда обратиться к специалисту:</strong> ${item.specialistNote}
        </div>
      `;
    } else if (item.importantNote) {
      calloutHtml = `
        <div class="p-2.5 rounded-2xl bg-emerald-50/80 dark:bg-emerald-950/40 border border-emerald-200/60 dark:border-emerald-900/50 text-[11px] text-emerald-900 dark:text-emerald-200 leading-relaxed">
          <strong>Важно помнить:</strong> ${item.importantNote}
        </div>
      `;
    }

    return `
      <article class="bg-white dark:bg-slate-900 rounded-3xl border border-stone-200/70 dark:border-slate-800 p-4 sm:p-5 space-y-3 shadow-2xs flex flex-col justify-between">
        <div class="space-y-3">
          <div class="flex items-start justify-between gap-2">
            <div class="space-y-1 min-w-0">
              <span class="inline-block px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wider ${catBadgeClass}">${item.categoryLabel || 'Совет'}</span>
              <h3 class="font-display font-extrabold text-sm sm:text-base text-slate-900 dark:text-slate-100 leading-snug">${item.title}</h3>
            </div>
            <span class="px-2.5 py-0.5 rounded-full bg-warmgray dark:bg-slate-800 text-[11px] font-bold text-slate-600 dark:text-slate-300 shrink-0">${item.age}</span>
          </div>
          <p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">${item.summary}</p>
          <ul class="space-y-1.5 text-xs text-slate-700 dark:text-slate-200">
            ${item.steps.map(st => `<li class="flex items-start gap-2"><span class="text-emerald-500 font-bold">•</span><span>${st}</span></li>`).join('')}
          </ul>
        </div>
        ${calloutHtml}
      </article>
    `;
  }).join('');
}
