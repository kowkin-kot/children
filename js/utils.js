// Вспомогательные функции: форматирование дат/времени, безопасность HTML, хэширование, модальные окна и уведомления

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getTodayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatDateRu(isoStr) {
  if (!isoStr || typeof isoStr !== 'string') return '';
  const m = isoStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  return isoStr;
}

export function formatDateTimeRu(tsOrIso) {
  if (!tsOrIso) return '';
  const d = new Date(tsOrIso);
  if (Number.isNaN(d.getTime())) return String(tsOrIso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
}

export function toDatetimeLocalValue(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

export function parseIsoToLocalDayBounds(isoStr) {
  const parts = String(isoStr || getTodayIso()).split('-').map(Number);
  const dateObj = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1, 0, 0, 0, 0);
  return { startMs: dateObj.getTime(), endMs: dateObj.getTime() + 86400000, dateObj };
}

export function formatMinutesHuman(totalMin) {
  const m = Math.max(0, Math.round(totalMin));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem} мин`;
  if (rem === 0) return `${h} ч`;
  return `${h} ч ${rem} мин`;
}

export function formatClockHHMM(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function syncRuDateDisplays() {
  document.querySelectorAll('[data-ru-date-text]').forEach(span => {
    const inputId = span.getAttribute('data-ru-date-text');
    const inp = document.getElementById(inputId);
    if (!inp) return;
    const val = inp.value;
    if (val) {
      span.textContent = formatDateRu(val);
      span.classList.remove('text-slate-400');
    } else {
      span.textContent = 'ДД.ММ.ГГГГ';
      span.classList.add('text-slate-400');
    }
  });
}

export function bindRuDateInputs() {
  document.querySelectorAll('input[type="date"]').forEach(inp => {
    inp.addEventListener('change', syncRuDateDisplays);
    inp.addEventListener('input', syncRuDateDisplays);
  });
  syncRuDateDisplays();
}

export async function hashPassword(str) {
  const normalized = String(str || '');
  try {
    if (window.crypto && window.crypto.subtle) {
      const buf = new TextEncoder().encode(normalized);
      const digest = await window.crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (_) {}
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return 'fnv_' + (h >>> 0).toString(16);
}

export function normalizeLogin(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9а-яё._-]/gi, '_');
}

export function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('flex');
}

export function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('hidden');
  el.classList.remove('flex');
}

let toastTimer = null;

export function showToast(msg) {
  const box = document.getElementById('toast-box');
  const txt = document.getElementById('toast-text');
  if (!box || !txt) return;
  txt.textContent = msg;
  box.classList.remove('opacity-0');
  box.classList.add('opacity-100');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.classList.remove('opacity-100');
    box.classList.add('opacity-0');
  }, 2800);
}
