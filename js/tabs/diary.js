// Вкладка 6: Дневник достижений и заметок

import { store, hooks } from '../state.js';
import { escapeHtml, getTodayIso, formatDateRu, showToast } from '../utils.js';
import { saveAppState } from '../firebase.js';

export function addDiaryEntry(e) {
  if (e) e.preventDefault();
  const date = document.getElementById('diary-date-input')?.value || getTodayIso();
  const tag = document.getElementById('diary-tag-input')?.value || 'Достижение';
  const title = (document.getElementById('diary-title-input')?.value || '').trim();
  const text = (document.getElementById('diary-text-input')?.value || '').trim();

  if (!title) return;
  store.appState.diaryEntries.unshift({
    id: 'diary_' + Date.now(),
    date,
    tag,
    title,
    text
  });

  const titleInp = document.getElementById('diary-title-input');
  const textInp = document.getElementById('diary-text-input');
  if (titleInp) titleInp.value = '';
  if (textInp) textInp.value = '';

  saveAppState();
  renderDiaryTab();
  showToast('Запись сохранена в дневник');
}

export function deleteDiaryEntry(entryId) {
  store.appState.diaryEntries = (store.appState.diaryEntries || []).filter(e => e.id !== entryId);
  saveAppState();
  renderDiaryTab();
  showToast('Запись удалена');
}

export function renderDiaryTab() {
  hooks.renderSolidsMatrixSummary();
  const list = document.getElementById('diary-entries-list');
  if (!list) return;

  const entries = store.appState.diaryEntries || [];
  if (entries.length === 0) {
    list.innerHTML = `<div class="py-8 text-center text-xs text-slate-400">В дневнике пока нет записей. Сохраните первое достижение или тёплую заметку о малыше!</div>`;
    return;
  }

  list.innerHTML = entries.map(item => `
    <div class="p-4 rounded-2xl bg-warmgray/60 dark:bg-slate-800/70 border border-stone-200/70 dark:border-slate-700 space-y-1.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="px-2.5 py-0.5 rounded-full bg-rose-100/80 dark:bg-rose-950 text-rose-700 dark:text-rose-300 text-[11px] font-bold">${escapeHtml(item.tag)}</span>
          <span class="text-xs font-semibold text-slate-400">${formatDateRu(item.date)}</span>
        </div>
        <button type="button" onclick="deleteDiaryEntry('${escapeHtml(item.id)}')" class="text-xs text-slate-400 hover:text-rose-500">Удалить</button>
      </div>
      <h4 class="font-display font-extrabold text-sm text-slate-900 dark:text-slate-100">${escapeHtml(item.title)}</h4>
      ${item.text ? `<p class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">${escapeHtml(item.text)}</p>` : ''}
    </div>
  `).join('');
}
