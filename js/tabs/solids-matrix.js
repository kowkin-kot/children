// Матрица прикорма «Первые 100 продуктов и аллергены»

import { store, hooks, getCurrentCaregiverName } from '../state.js';
import {
  escapeHtml,
  getTodayIso,
  formatDateRu,
  openModal,
  showToast
} from '../utils.js';
import { saveAppState } from '../firebase.js';

export const MAJOR_ALLERGENS = [
  { id: 'milk', label: 'Молоко', short: 'Молоко' },
  { id: 'egg', label: 'Яйцо', short: 'Яйцо' },
  { id: 'gluten', label: 'Глютен (пшеница)', short: 'Глютен' },
  { id: 'fish', label: 'Рыба', short: 'Рыба' },
  { id: 'nuts', label: 'Арахис и орехи', short: 'Орехи' },
  { id: 'soy', label: 'Соя', short: 'Соя' },
  { id: 'sesame', label: 'Кунжут', short: 'Кунжут' },
  { id: 'shellfish', label: 'Морепродукты', short: 'Морепр.' }
];

export const ALLERGEN_LABEL_MAP = Object.fromEntries(
  MAJOR_ALLERGENS.map(a => [a.id, a.short])
);

export const SOLIDS_CATEGORIES = [
  { id: 'all', label: 'Все' },
  { id: 'Овощи', label: 'Овощи' },
  { id: 'Фрукты', label: 'Фрукты и ягоды' },
  { id: 'Каши', label: 'Каши и злаки' },
  { id: 'Мясо', label: 'Мясо и птица' },
  { id: 'Рыба', label: 'Рыба и морепр.' },
  { id: 'Молочное', label: 'Молочное' },
  { id: 'Белок', label: 'Яйца, бобовые, орехи' },
  { id: 'Прочее', label: 'Масла и прочее' }
];

// Ровно 100 продуктов для первого прикорма с разметкой основных аллергенов
export const FIRST_100_FOODS = [
  // Овощи (18)
  { id: 'f_zucchini', name: 'Кабачок', category: 'Овощи' },
  { id: 'f_cauliflower', name: 'Цветная капуста', category: 'Овощи' },
  { id: 'f_broccoli', name: 'Брокколи', category: 'Овощи' },
  { id: 'f_pumpkin', name: 'Тыква', category: 'Овощи' },
  { id: 'f_carrot', name: 'Морковь', category: 'Овощи' },
  { id: 'f_potato', name: 'Картофель', category: 'Овощи' },
  { id: 'f_sweet_potato', name: 'Батат', category: 'Овощи' },
  { id: 'f_green_peas', name: 'Зелёный горошек', category: 'Овощи' },
  { id: 'f_green_beans', name: 'Стручковая фасоль', category: 'Овощи' },
  { id: 'f_beetroot', name: 'Свёкла', category: 'Овощи' },
  { id: 'f_cucumber', name: 'Огурец', category: 'Овощи' },
  { id: 'f_tomato', name: 'Помидор', category: 'Овощи' },
  { id: 'f_bell_pepper', name: 'Болгарский перец', category: 'Овощи' },
  { id: 'f_spinach', name: 'Шпинат', category: 'Овощи' },
  { id: 'f_cabbage', name: 'Капуста белокочанная', category: 'Овощи' },
  { id: 'f_eggplant', name: 'Баклажан', category: 'Овощи' },
  { id: 'f_corn', name: 'Кукуруза', category: 'Овощи' },
  { id: 'f_avocado', name: 'Авокадо', category: 'Овощи' },

  // Фрукты и ягоды (18)
  { id: 'f_apple', name: 'Яблоко', category: 'Фрукты' },
  { id: 'f_pear', name: 'Груша', category: 'Фрукты' },
  { id: 'f_banana', name: 'Банан', category: 'Фрукты' },
  { id: 'f_prune', name: 'Чернослив', category: 'Фрукты' },
  { id: 'f_peach', name: 'Персик', category: 'Фрукты' },
  { id: 'f_apricot', name: 'Абрикос', category: 'Фрукты' },
  { id: 'f_plum', name: 'Слива', category: 'Фрукты' },
  { id: 'f_blueberry', name: 'Голубика', category: 'Фрукты' },
  { id: 'f_bilberry', name: 'Черника', category: 'Фрукты' },
  { id: 'f_raspberry', name: 'Малина', category: 'Фрукты' },
  { id: 'f_strawberry', name: 'Клубника', category: 'Фрукты' },
  { id: 'f_currant', name: 'Смородина', category: 'Фрукты' },
  { id: 'f_cherry', name: 'Вишня', category: 'Фрукты' },
  { id: 'f_mango', name: 'Манго', category: 'Фрукты' },
  { id: 'f_kiwi', name: 'Киви', category: 'Фрукты' },
  { id: 'f_orange', name: 'Апельсин', category: 'Фрукты' },
  { id: 'f_melon', name: 'Дыня', category: 'Фрукты' },
  { id: 'f_watermelon', name: 'Арбуз', category: 'Фрукты' },

  // Каши и злаки (12)
  { id: 'f_buckwheat', name: 'Гречка', category: 'Каши' },
  { id: 'f_rice', name: 'Рис', category: 'Каши' },
  { id: 'f_cornmeal', name: 'Кукурузная каша', category: 'Каши' },
  { id: 'f_oats', name: 'Овсянка', category: 'Каши', allergen: 'gluten' },
  { id: 'f_wheat', name: 'Пшеница / манка', category: 'Каши', allergen: 'gluten' },
  { id: 'f_millet', name: 'Пшено', category: 'Каши' },
  { id: 'f_quinoa', name: 'Киноа', category: 'Каши' },
  { id: 'f_barley', name: 'Перловка / ячмень', category: 'Каши', allergen: 'gluten' },
  { id: 'f_rye', name: 'Рожь / хлеб', category: 'Каши', allergen: 'gluten' },
  { id: 'f_pasta', name: 'Макароны детские', category: 'Каши', allergen: 'gluten' },
  { id: 'f_bulgur', name: 'Булгур', category: 'Каши', allergen: 'gluten' },
  { id: 'f_biscuit', name: 'Детское печенье', category: 'Каши', allergen: 'gluten' },

  // Мясо и птица (10)
  { id: 'f_turkey', name: 'Индейка', category: 'Мясо' },
  { id: 'f_rabbit', name: 'Кролик', category: 'Мясо' },
  { id: 'f_chicken', name: 'Курица', category: 'Мясо' },
  { id: 'f_veal', name: 'Телятина', category: 'Мясо' },
  { id: 'f_beef', name: 'Говядина', category: 'Мясо' },
  { id: 'f_lamb', name: 'Ягнёнок', category: 'Мясо' },
  { id: 'f_pork', name: 'Свинина нежирная', category: 'Мясо' },
  { id: 'f_chicken_liver', name: 'Печень куриная', category: 'Мясо' },
  { id: 'f_beef_liver', name: 'Печень говяжья', category: 'Мясо' },
  { id: 'f_quail', name: 'Перепёлка', category: 'Мясо' },

  // Рыба и морепродукты (10)
  { id: 'f_cod', name: 'Треска', category: 'Рыба', allergen: 'fish' },
  { id: 'f_hake', name: 'Хек', category: 'Рыба', allergen: 'fish' },
  { id: 'f_pollock', name: 'Минтай', category: 'Рыба', allergen: 'fish' },
  { id: 'f_pikeperch', name: 'Судак', category: 'Рыба', allergen: 'fish' },
  { id: 'f_salmon', name: 'Лосось / сёмга', category: 'Рыба', allergen: 'fish' },
  { id: 'f_trout', name: 'Форель', category: 'Рыба', allergen: 'fish' },
  { id: 'f_mackerel', name: 'Скумбрия', category: 'Рыба', allergen: 'fish' },
  { id: 'f_flounder', name: 'Камбала', category: 'Рыба', allergen: 'fish' },
  { id: 'f_shrimp', name: 'Креветки', category: 'Рыба', allergen: 'shellfish' },
  { id: 'f_squid', name: 'Кальмар', category: 'Рыба', allergen: 'shellfish' },

  // Молочное (10)
  { id: 'f_cottage_cheese', name: 'Детский творог', category: 'Молочное', allergen: 'milk' },
  { id: 'f_kefir', name: 'Биолакт / кефир', category: 'Молочное', allergen: 'milk' },
  { id: 'f_yogurt', name: 'Натуральный йогурт', category: 'Молочное', allergen: 'milk' },
  { id: 'f_butter', name: 'Сливочное масло', category: 'Молочное', allergen: 'milk' },
  { id: 'f_cheese', name: 'Сыр несолёный', category: 'Молочное', allergen: 'milk' },
  { id: 'f_cows_milk', name: 'Коровье молоко', category: 'Молочное', allergen: 'milk' },
  { id: 'f_sour_cream', name: 'Сметана', category: 'Молочное', allergen: 'milk' },
  { id: 'f_ryazhenka', name: 'Ряженка', category: 'Молочное', allergen: 'milk' },
  { id: 'f_ricotta', name: 'Рикотта', category: 'Молочное', allergen: 'milk' },
  { id: 'f_goat_milk', name: 'Козий йогурт / молоко', category: 'Молочное', allergen: 'milk' },

  // Яйца, бобовые и орехи (14)
  { id: 'f_egg_yolk', name: 'Куриный желток', category: 'Белок', allergen: 'egg' },
  { id: 'f_egg_white', name: 'Куриный белок', category: 'Белок', allergen: 'egg' },
  { id: 'f_quail_egg', name: 'Перепелиное яйцо', category: 'Белок', allergen: 'egg' },
  { id: 'f_lentils', name: 'Чечевица', category: 'Белок' },
  { id: 'f_chickpeas', name: 'Нут / хумус', category: 'Белок' },
  { id: 'f_beans', name: 'Фасоль белая / красная', category: 'Белок' },
  { id: 'f_tofu', name: 'Тофу / соя', category: 'Белок', allergen: 'soy' },
  { id: 'f_edamame', name: 'Эдамаме', category: 'Белок', allergen: 'soy' },
  { id: 'f_peanut_butter', name: 'Арахисовая паста', category: 'Белок', allergen: 'nuts' },
  { id: 'f_almond_butter', name: 'Миндальная паста', category: 'Белок', allergen: 'nuts' },
  { id: 'f_walnut', name: 'Грецкий орех молотый', category: 'Белок', allergen: 'nuts' },
  { id: 'f_cashew', name: 'Кешью паста', category: 'Белок', allergen: 'nuts' },
  { id: 'f_hazelnut', name: 'Фундук молотый', category: 'Белок', allergen: 'nuts' },
  { id: 'f_sesame', name: 'Кунжут / тахини', category: 'Белок', allergen: 'sesame' },

  // Масла, зелень и прочее (8)
  { id: 'f_olive_oil', name: 'Оливковое масло', category: 'Прочее' },
  { id: 'f_sunflower_oil', name: 'Подсолнечное масло', category: 'Прочее' },
  { id: 'f_flax_oil', name: 'Льняное масло', category: 'Прочее' },
  { id: 'f_dill', name: 'Укроп', category: 'Прочее' },
  { id: 'f_parsley', name: 'Петрушка', category: 'Прочее' },
  { id: 'f_chia', name: 'Семена чиа', category: 'Прочее' },
  { id: 'f_pumpkin_seeds', name: 'Семена тыквы молотые', category: 'Прочее' },
  { id: 'f_compote', name: 'Компот из сухофруктов', category: 'Прочее' }
];

const matrixUiState = {
  category: 'all',
  statusFilter: 'all', // all | tried | untried | allergens | liked | reaction
  allergenFilter: '',
  search: '',
  editingFoodId: null,
  showAddCustom: false
};

export function getAllSolidsCatalog() {
  const custom = Array.isArray(store.appState.customSolidsFoods) ? store.appState.customSolidsFoods : [];
  return [...FIRST_100_FOODS, ...custom];
}

function getMatrixMap() {
  if (!store.appState.solidsMatrix || typeof store.appState.solidsMatrix !== 'object') {
    store.appState.solidsMatrix = {};
  }
  return store.appState.solidsMatrix;
}

export function computeSolidsMatrixStats() {
  const catalog = getAllSolidsCatalog();
  const map = getMatrixMap();

  let triedBase = 0;
  let triedTotal = 0;
  let likedCount = 0;
  let dislikedCount = 0;
  let reactionCount = 0;

  const baseIds = new Set(FIRST_100_FOODS.map(f => f.id));

  for (const food of catalog) {
    const rec = map[food.id];
    if (rec && rec.tried) {
      triedTotal++;
      if (baseIds.has(food.id)) triedBase++;
      if (rec.preference === 'like') likedCount++;
      if (rec.preference === 'dislike') dislikedCount++;
      if (rec.reaction && rec.reaction !== 'none') reactionCount++;
    }
  }

  const allergenStats = MAJOR_ALLERGENS.map(alg => {
    const related = catalog.filter(f => f.allergen === alg.id);
    const triedItems = related.filter(f => map[f.id]?.tried);
    const reactionItems = triedItems.filter(f => map[f.id]?.reaction && map[f.id].reaction !== 'none');
    const totalTries = triedItems.reduce((acc, f) => acc + Math.max(1, Number(map[f.id]?.tries) || 1), 0);
    const status = reactionItems.length > 0 ? 'reaction' : triedItems.length > 0 ? 'safe' : 'pending';
    return {
      ...alg,
      triedCount: triedItems.length,
      totalItems: related.length,
      totalTries,
      status
    };
  });

  const allergensIntroduced = allergenStats.filter(a => a.status !== 'pending').length;
  const allergensWithReaction = allergenStats.filter(a => a.status === 'reaction').length;

  return {
    triedBase,
    totalBase: FIRST_100_FOODS.length,
    triedTotal,
    totalCatalog: catalog.length,
    likedCount,
    dislikedCount,
    reactionCount,
    allergenStats,
    allergensIntroduced,
    allergensWithReaction
  };
}

export function renderSolidsMatrixSummary() {
  const wrap = document.getElementById('solids-matrix-summary-card');
  const quickBtnCount = document.getElementById('solids-matrix-quick-count');
  const stats = computeSolidsMatrixStats();

  if (quickBtnCount) {
    quickBtnCount.textContent = `${stats.triedBase}/${stats.totalBase}`;
  }
  if (!wrap) return;

  const pct = Math.min(100, Math.round((stats.triedBase / stats.totalBase) * 100));
  const allergenBadges = stats.allergenStats.map(alg => {
    const cls = alg.status === 'reaction'
      ? 'bg-rose-100 dark:bg-rose-950/70 text-rose-700 dark:text-rose-300 border-rose-300/80 dark:border-rose-800/70'
      : alg.status === 'safe'
        ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200/80 dark:border-emerald-800/60'
        : 'bg-warmgray/80 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-stone-200/70 dark:border-slate-700';
    const dot = alg.status === 'reaction' ? 'bg-rose-500' : alg.status === 'safe' ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-slate-600';
    return `
      <button type="button" onclick="openSolidsMatrixModal('allergen:${alg.id}')" class="inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-bold transition hover:opacity-85 ${cls}">
        <span class="w-1.5 h-1.5 rounded-full ${dot} shrink-0"></span>
        <span>${escapeHtml(alg.short)}</span>
      </button>
    `;
  }).join('');

  wrap.innerHTML = `
    <div class="bg-white dark:bg-slate-900 rounded-3xl border border-stone-200/70 dark:border-slate-800 p-4 sm:p-5 space-y-3 shadow-2xs">
      <div class="flex flex-wrap items-center justify-between gap-2.5">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h3 class="font-display font-bold text-sm sm:text-base text-slate-900 dark:text-slate-100">Прикорм: Первые 100 продуктов</h3>
            <span class="px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-[11px] font-extrabold tabular-nums">${stats.triedBase} / ${stats.totalBase}</span>
          </div>
          <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Таблица вкусов, реакций и контроль 8 основных аллергенов</p>
        </div>
        <button type="button" onclick="openSolidsMatrixModal()" class="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-2xs transition shrink-0">
          Открыть таблицу
        </button>
      </div>

      <div class="space-y-1.5">
        <div class="w-full h-2 rounded-full bg-warmgray dark:bg-slate-800 overflow-hidden">
          <div class="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-300" style="width:${pct}%"></div>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
          <span>Аллергены: <strong class="text-slate-800 dark:text-slate-100">${stats.allergensIntroduced} / 8</strong></span>
          <span>Любит: <strong class="text-emerald-600 dark:text-emerald-400">${stats.likedCount}</strong></span>
          ${stats.dislikedCount > 0 ? `<span>Не понравилось: <strong class="text-amber-600 dark:text-amber-400">${stats.dislikedCount}</strong></span>` : ''}
          ${stats.reactionCount > 0 ? `<button type="button" onclick="openSolidsMatrixModal('reaction')" class="font-bold text-rose-600 dark:text-rose-400 underline">Реакции: ${stats.reactionCount}</button>` : ''}
        </div>
      </div>

      <div class="space-y-1.5">
        <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Основные аллергены (нажмите для проверки)</div>
        <div class="flex flex-wrap gap-1.5">${allergenBadges}</div>
      </div>
    </div>
  `;
}

export function openSolidsMatrixModal(presetFilter = '') {
  matrixUiState.editingFoodId = null;
  matrixUiState.showAddCustom = false;
  if (presetFilter && presetFilter.startsWith('allergen:')) {
    matrixUiState.statusFilter = 'allergens';
    matrixUiState.allergenFilter = presetFilter.replace('allergen:', '');
    matrixUiState.category = 'all';
  } else if (presetFilter === 'reaction') {
    matrixUiState.statusFilter = 'reaction';
    matrixUiState.allergenFilter = '';
    matrixUiState.category = 'all';
  } else {
    matrixUiState.allergenFilter = '';
  }
  renderSolidsMatrixModal();
  openModal('modal-solids-matrix');
}

export function setSolidsMatrixCategory(cat) {
  matrixUiState.category = cat || 'all';
  matrixUiState.allergenFilter = '';
  renderSolidsMatrixModal();
}

export function setSolidsMatrixStatusFilter(status) {
  matrixUiState.statusFilter = status || 'all';
  if (status !== 'allergens') matrixUiState.allergenFilter = '';
  renderSolidsMatrixModal();
}

export function setSolidsMatrixAllergenFilter(algId) {
  if (matrixUiState.allergenFilter === algId) {
    matrixUiState.allergenFilter = '';
  } else {
    matrixUiState.allergenFilter = algId;
    matrixUiState.statusFilter = 'allergens';
    matrixUiState.category = 'all';
  }
  renderSolidsMatrixModal();
}

export function setSolidsMatrixSearch(query) {
  matrixUiState.search = String(query || '');
  renderSolidsMatrixGridOnly();
}

export function toggleSolidsMatrixCustomForm() {
  matrixUiState.showAddCustom = !matrixUiState.showAddCustom;
  renderSolidsMatrixModal();
}

export function addCustomSolidsFood(e) {
  if (e) e.preventDefault();
  const nameInp = document.getElementById('custom-solids-name');
  const catSel = document.getElementById('custom-solids-category');
  const algSel = document.getElementById('custom-solids-allergen');
  const name = (nameInp?.value || '').trim();
  if (!name) {
    showToast('Введите название продукта');
    return;
  }
  const category = catSel?.value || 'Прочее';
  const allergen = algSel?.value || '';
  const newFood = {
    id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    name: name.slice(0, 48),
    category,
    custom: true
  };
  if (allergen) newFood.allergen = allergen;

  if (!Array.isArray(store.appState.customSolidsFoods)) {
    store.appState.customSolidsFoods = [];
  }
  store.appState.customSolidsFoods.push(newFood);
  const map = getMatrixMap();
  map[newFood.id] = {
    tried: true,
    tries: 1,
    firstDate: getTodayIso(),
    preference: 'neutral',
    reaction: 'none',
    note: ''
  };
  matrixUiState.showAddCustom = false;
  matrixUiState.editingFoodId = newFood.id;
  saveAppState();
  renderSolidsMatrixSummary();
  renderSolidsMatrixModal();
  showToast(`Продукт «${newFood.name}» добавлен`);
}

export function selectSolidsMatrixFood(foodId) {
  if (matrixUiState.editingFoodId === foodId) {
    matrixUiState.editingFoodId = null;
  } else {
    matrixUiState.editingFoodId = foodId;
  }
  renderSolidsMatrixEditor();
  renderSolidsMatrixGridOnly();
}

export function quickToggleSolidsFoodTried(foodId, ev) {
  if (ev) ev.stopPropagation();
  const map = getMatrixMap();
  const cur = map[foodId];
  if (cur && cur.tried) {
    map[foodId] = { ...cur, tried: false };
  } else {
    map[foodId] = {
      tried: true,
      tries: Math.max(1, Number(cur?.tries) || 1),
      firstDate: cur?.firstDate || getTodayIso(),
      preference: cur?.preference || 'neutral',
      reaction: cur?.reaction || 'none',
      note: cur?.note || ''
    };
  }
  saveAppState();
  renderSolidsMatrixSummary();
  renderSolidsMatrixModal();
}

export function updateSolidsFoodField(foodId, field, value) {
  const map = getMatrixMap();
  const cur = map[foodId] || {
    tried: true,
    tries: 1,
    firstDate: getTodayIso(),
    preference: 'neutral',
    reaction: 'none',
    note: ''
  };
  const next = { ...cur };
  if (field === 'tried') {
    next.tried = Boolean(value);
    if (next.tried) {
      if (!next.firstDate) next.firstDate = getTodayIso();
      if (!next.tries || next.tries < 1) next.tries = 1;
    }
  } else if (field === 'triesDelta') {
    next.tried = true;
    if (!next.firstDate) next.firstDate = getTodayIso();
    next.tries = Math.max(1, Math.min(99, (Number(next.tries) || 1) + Number(value)));
  } else if (field === 'preference') {
    next.tried = true;
    if (!next.firstDate) next.firstDate = getTodayIso();
    next.preference = value;
  } else if (field === 'reaction') {
    next.tried = true;
    if (!next.firstDate) next.firstDate = getTodayIso();
    next.reaction = value;
  } else if (field === 'note') {
    next.note = String(value || '').trim().slice(0, 140);
  }
  map[foodId] = next;
  saveAppState();
  renderSolidsMatrixSummary();
  renderSolidsMatrixModal();
}

export function logSolidsFoodToJournalFromMatrix(foodId) {
  const catalog = getAllSolidsCatalog();
  const food = catalog.find(f => f.id === foodId);
  if (!food) return;
  const map = getMatrixMap();
  const rec = map[foodId] || { tried: true, tries: 1, firstDate: getTodayIso(), preference: 'neutral', reaction: 'none', note: '' };
  rec.tried = true;
  rec.tries = Math.max(1, Number(rec.tries) || 0) + (map[foodId]?.tried ? 1 : 0);
  if (!rec.firstDate) rec.firstDate = getTodayIso();
  map[foodId] = rec;

  const prefText = rec.preference === 'like' ? 'с удовольствием' : rec.preference === 'dislike' ? 'не понравилось' : 'нейтрально';
  const reactMap = {
    none: '',
    rash: ' • реакция: покраснение / сыпь',
    tummy: ' • реакция: стул / газики',
    spitup: ' • реакция: срыгивание'
  };
  const now = Date.now();
  store.appState.journalLogs.unshift({
    id: 'log_' + now,
    type: 'feeding_solids',
    subtype: 'solids',
    title: `Прикорм: ${food.name} (${food.category}) • ${prefText}${reactMap[rec.reaction] || ''}${rec.note ? ` • ${rec.note}` : ''}`,
    startTime: now,
    endTime: now,
    durationMin: 0,
    author: getCurrentCaregiverName()
  });

  saveAppState();
  renderSolidsMatrixSummary();
  renderSolidsMatrixModal();
  hooks.renderAll();
  showToast(`«${food.name}» добавлен в журнал`);
}

// Авто-синхронизация матрицы, когда родитель записывает прикорм через форму журнала
export function syncSolidsMatrixFromLog(prodName, appetite, reactionLabel, note) {
  const cleanName = String(prodName || '').trim().toLowerCase();
  if (!cleanName || cleanName.length < 2) return;

  const catalog = getAllSolidsCatalog();
  const matched = catalog.find(item => {
    const itemLower = item.name.toLowerCase();
    const parts = itemLower.split('/').map(s => s.trim()).filter(Boolean);
    return parts.some(p => cleanName.includes(p) || p.includes(cleanName));
  });
  if (!matched) return;

  const map = getMatrixMap();
  const prev = map[matched.id] || {};
  let preference = prev.preference || 'neutral';
  if (appetite === 'С удовольствием') preference = 'like';
  else if (appetite === 'Отказался') preference = 'dislike';

  let reaction = prev.reaction || 'none';
  if (reactionLabel === 'Покраснение / сыпь') reaction = 'rash';
  else if (reactionLabel === 'Стул / газики') reaction = 'tummy';
  else if (reactionLabel === 'Срыгивание') reaction = 'spitup';
  else if (reactionLabel === 'Без реакции' && !prev.reaction) reaction = 'none';

  map[matched.id] = {
    tried: true,
    tries: (Number(prev.tries) || 0) + 1,
    firstDate: prev.firstDate || getTodayIso(),
    preference,
    reaction,
    note: note || prev.note || ''
  };
}

function getFilteredFoods() {
  const catalog = getAllSolidsCatalog();
  const map = getMatrixMap();
  const q = matrixUiState.search.trim().toLowerCase();

  return catalog.filter(food => {
    const rec = map[food.id];
    const isTried = Boolean(rec && rec.tried);

    if (matrixUiState.category !== 'all' && food.category !== matrixUiState.category) return false;
    if (matrixUiState.allergenFilter && food.allergen !== matrixUiState.allergenFilter) return false;
    if (matrixUiState.statusFilter === 'tried' && !isTried) return false;
    if (matrixUiState.statusFilter === 'untried' && isTried) return false;
    if (matrixUiState.statusFilter === 'allergens' && !food.allergen) return false;
    if (matrixUiState.statusFilter === 'liked' && !(isTried && rec.preference === 'like')) return false;
    if (matrixUiState.statusFilter === 'reaction' && !(isTried && rec.reaction && rec.reaction !== 'none')) return false;

    if (q) {
      const algLabel = food.allergen ? (ALLERGEN_LABEL_MAP[food.allergen] || '').toLowerCase() : '';
      return food.name.toLowerCase().includes(q)
        || food.category.toLowerCase().includes(q)
        || algLabel.includes(q);
    }
    return true;
  });
}

function renderSolidsMatrixEditor() {
  const editorWrap = document.getElementById('solids-matrix-editor');
  if (!editorWrap) return;

  if (!matrixUiState.editingFoodId) {
    editorWrap.classList.add('hidden');
    editorWrap.innerHTML = '';
    return;
  }

  const catalog = getAllSolidsCatalog();
  const food = catalog.find(f => f.id === matrixUiState.editingFoodId);
  if (!food) {
    editorWrap.classList.add('hidden');
    return;
  }

  const rec = getMatrixMap()[food.id] || {
    tried: false,
    tries: 1,
    firstDate: '',
    preference: 'neutral',
    reaction: 'none',
    note: ''
  };
  const safeId = escapeHtml(food.id);
  const algBadge = food.allergen
    ? `<span class="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 text-[10px] font-bold">Аллерген: ${escapeHtml(ALLERGEN_LABEL_MAP[food.allergen] || food.allergen)}</span>`
    : '';

  const prefBtn = (val, label, activeCls) => {
    const active = rec.tried && rec.preference === val;
    return `<button type="button" onclick="updateSolidsFoodField('${safeId}', 'preference', '${val}')" class="flex-1 py-2 px-2 rounded-xl border text-xs font-bold transition ${active ? activeCls : 'bg-white dark:bg-slate-900 border-stone-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}">${label}</button>`;
  };

  const reactBtn = (val, label, activeCls) => {
    const active = rec.tried && (rec.reaction || 'none') === val;
    return `<button type="button" onclick="updateSolidsFoodField('${safeId}', 'reaction', '${val}')" class="py-1.5 px-2.5 rounded-xl border text-[11px] font-bold transition ${active ? activeCls : 'bg-white dark:bg-slate-900 border-stone-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}">${label}</button>`;
  };

  editorWrap.classList.remove('hidden');
  editorWrap.innerHTML = `
    <div class="rounded-2xl bg-warmgray/90 dark:bg-slate-800/90 border border-emerald-300/70 dark:border-emerald-800/70 p-3.5 space-y-3 animate-fade-in">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-1.5">
            <h4 class="font-display font-extrabold text-sm sm:text-base text-slate-900 dark:text-slate-100">${escapeHtml(food.name)}</h4>
            <span class="text-[11px] text-slate-500 dark:text-slate-400">• ${escapeHtml(food.category)}</span>
            ${algBadge}
          </div>
          ${rec.tried && rec.firstDate ? `<div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Первая проба: ${escapeHtml(formatDateRu(rec.firstDate))}</div>` : ''}
        </div>
        <button type="button" onclick="selectSolidsMatrixFood('${safeId}')" aria-label="Свернуть" class="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onclick="updateSolidsFoodField('${safeId}', 'tried', ${rec.tried ? 'false' : 'true'})" class="px-3 py-1.5 rounded-xl text-xs font-bold transition ${rec.tried ? 'bg-emerald-600 text-white' : 'bg-white dark:bg-slate-900 border border-stone-300 dark:border-slate-700 text-slate-700 dark:text-slate-200'}">
          ${rec.tried ? '✓ Уже попробовали' : 'Отметить: попробовали'}
        </button>
        <div class="flex items-center gap-1.5">
          <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">Проб:</span>
          <button type="button" onclick="updateSolidsFoodField('${safeId}', 'triesDelta', -1)" class="w-7 h-7 rounded-lg bg-white dark:bg-slate-900 border border-stone-200 dark:border-slate-700 text-xs font-bold">−</button>
          <span class="min-w-[24px] text-center text-xs font-extrabold text-slate-800 dark:text-slate-100 tabular-nums">${rec.tried ? Math.max(1, Number(rec.tries) || 1) : 0}</span>
          <button type="button" onclick="updateSolidsFoodField('${safeId}', 'triesDelta', 1)" class="w-7 h-7 rounded-lg bg-white dark:bg-slate-900 border border-stone-200 dark:border-slate-700 text-xs font-bold">+</button>
        </div>
      </div>

      <div class="space-y-1.5">
        <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Отношение малыша</div>
        <div class="flex gap-1.5">
          ${prefBtn('like', 'Любит', 'bg-emerald-600 border-emerald-600 text-white')}
          ${prefBtn('neutral', 'Нейтрально', 'bg-slate-800 dark:bg-slate-200 border-slate-800 dark:border-slate-200 text-white dark:text-slate-900')}
          ${prefBtn('dislike', 'Не понравилось', 'bg-amber-500 border-amber-500 text-white')}
        </div>
      </div>

      <div class="space-y-1.5">
        <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Реакция организма</div>
        <div class="flex flex-wrap gap-1.5">
          ${reactBtn('none', 'Без реакции', 'bg-emerald-600 border-emerald-600 text-white')}
          ${reactBtn('rash', 'Покраснение / сыпь', 'bg-rose-600 border-rose-600 text-white')}
          ${reactBtn('tummy', 'Стул / газики', 'bg-amber-600 border-amber-600 text-white')}
          ${reactBtn('spitup', 'Срыгивание', 'bg-orange-600 border-orange-600 text-white')}
        </div>
      </div>

      <div class="flex flex-col sm:flex-row gap-2">
        <input type="text" value="${escapeHtml(rec.note || '')}" onchange="updateSolidsFoodField('${safeId}', 'note', this.value)" placeholder="Заметка (например: ел в виде пюре с оливковым маслом)" class="flex-1 px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-stone-200 dark:border-slate-700 text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-400" />
        <button type="button" onclick="logSolidsFoodToJournalFromMatrix('${safeId}')" class="px-3.5 py-2 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold shrink-0 transition">
          + В журнал сегодня
        </button>
      </div>
    </div>
  `;
}

function renderSolidsMatrixGridOnly() {
  const grid = document.getElementById('solids-matrix-grid');
  const emptyEl = document.getElementById('solids-matrix-empty');
  if (!grid) return;

  const foods = getFilteredFoods();
  const map = getMatrixMap();

  if (foods.length === 0) {
    grid.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  grid.innerHTML = foods.map(food => {
    const rec = map[food.id];
    const tried = Boolean(rec && rec.tried);
    const hasReaction = tried && rec.reaction && rec.reaction !== 'none';
    const isSelected = matrixUiState.editingFoodId === food.id;
    const safeId = escapeHtml(food.id);

    const cardCls = hasReaction
      ? 'bg-rose-50/80 dark:bg-rose-950/35 border-rose-300 dark:border-rose-800'
      : tried
        ? 'bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/70'
        : 'bg-white dark:bg-slate-900 border-stone-200/80 dark:border-slate-800 hover:border-stone-300 dark:hover:border-slate-700';

    const prefTag = tried && rec.preference === 'like'
      ? '<span class="px-1.5 py-0.5 rounded-md bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold">Любит</span>'
      : tried && rec.preference === 'dislike'
        ? '<span class="px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 text-[10px] font-bold">Не понр.</span>'
        : '';

    const reactTag = hasReaction
      ? '<span class="px-1.5 py-0.5 rounded-md bg-rose-500 text-white text-[10px] font-bold">Реакция</span>'
      : '';

    const algTag = food.allergen
      ? `<span class="px-1.5 py-0.5 rounded-md bg-amber-100/90 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 text-[10px] font-bold">${escapeHtml(ALLERGEN_LABEL_MAP[food.allergen] || 'Аллерген')}</span>`
      : '';

    return `
      <div onclick="selectSolidsMatrixFood('${safeId}')" class="p-2.5 rounded-2xl border cursor-pointer transition flex flex-col justify-between gap-2 ${cardCls} ${isSelected ? 'ring-2 ring-emerald-500' : ''}">
        <div class="flex items-start justify-between gap-1.5">
          <span class="text-xs font-bold text-slate-800 dark:text-slate-100 leading-snug break-words">${escapeHtml(food.name)}</span>
          <button type="button" onclick="quickToggleSolidsFoodTried('${safeId}', event)" title="${tried ? 'Снять отметку' : 'Отметить как попробованный'}" class="w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition ${tried ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white dark:bg-slate-800 border-stone-300 dark:border-slate-600 text-transparent'}">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-1">
          ${algTag}
          ${prefTag}
          ${reactTag}
          ${tried && Number(rec.tries) > 1 ? `<span class="text-[10px] font-bold text-slate-400 tabular-nums">${rec.tries}×</span>` : ''}
          ${!tried && !food.allergen ? `<span class="text-[10px] text-slate-400">${escapeHtml(food.category)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

export function renderSolidsMatrixModal() {
  const stats = computeSolidsMatrixStats();
  const countEl = document.getElementById('solids-modal-progress-label');
  const barEl = document.getElementById('solids-modal-progress-bar');
  const algWrap = document.getElementById('solids-modal-allergens');
  const statusWrap = document.getElementById('solids-modal-status-filters');
  const catWrap = document.getElementById('solids-modal-categories');
  const customWrap = document.getElementById('solids-modal-custom-form');

  const pct = Math.min(100, Math.round((stats.triedBase / stats.totalBase) * 100));
  if (countEl) {
    countEl.textContent = `${stats.triedBase} из ${stats.totalBase} продуктов (${pct}%) • Аллергены: ${stats.allergensIntroduced}/8`;
  }
  if (barEl) {
    barEl.style.width = `${pct}%`;
  }

  if (algWrap) {
    algWrap.innerHTML = stats.allergenStats.map(alg => {
      const active = matrixUiState.allergenFilter === alg.id;
      const statusText = alg.status === 'reaction' ? 'Реакция' : alg.status === 'safe' ? `Ок (${alg.totalTries}×)` : 'Не введён';
      const tone = alg.status === 'reaction'
        ? 'border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300'
        : alg.status === 'safe'
          ? 'border-emerald-200 dark:border-emerald-800/70 bg-emerald-50/70 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
          : 'border-stone-200 dark:border-slate-700 bg-warmgray/60 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300';
      return `
        <button type="button" onclick="setSolidsMatrixAllergenFilter('${alg.id}')" class="p-2 rounded-xl border text-left transition ${tone} ${active ? 'ring-2 ring-rose-500' : ''}">
          <div class="text-[11px] font-extrabold truncate">${escapeHtml(alg.short)}</div>
          <div class="text-[10px] opacity-80 truncate">${statusText}</div>
        </button>
      `;
    }).join('');
  }

  if (statusWrap) {
    const statuses = [
      { id: 'all', label: `Все (${stats.totalCatalog})` },
      { id: 'tried', label: `Попробовали (${stats.triedTotal})` },
      { id: 'untried', label: `Новые (${stats.totalCatalog - stats.triedTotal})` },
      { id: 'allergens', label: 'Аллергены' },
      { id: 'liked', label: `Любит (${stats.likedCount})` },
      { id: 'reaction', label: `Реакции (${stats.reactionCount})` }
    ];
    statusWrap.innerHTML = statuses.map(st => {
      const active = matrixUiState.statusFilter === st.id;
      return `
        <button type="button" onclick="setSolidsMatrixStatusFilter('${st.id}')" class="px-2.5 py-1.5 rounded-xl text-[11px] font-bold shrink-0 transition ${active ? 'bg-slate-900 dark:bg-rose-500 text-white' : 'bg-warmgray dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-stone-200/70 dark:hover:bg-slate-700'}">
          ${st.label}
        </button>
      `;
    }).join('');
  }

  if (catWrap) {
    catWrap.innerHTML = SOLIDS_CATEGORIES.map(c => {
      const active = matrixUiState.category === c.id;
      return `
        <button type="button" onclick="setSolidsMatrixCategory('${c.id}')" class="px-2.5 py-1 rounded-lg text-[11px] font-semibold shrink-0 transition ${active ? 'bg-emerald-600 text-white' : 'bg-white dark:bg-slate-800 border border-stone-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}">
          ${c.label}
        </button>
      `;
    }).join('');
  }

  if (customWrap) {
    customWrap.classList.toggle('hidden', !matrixUiState.showAddCustom);
  }

  renderSolidsMatrixEditor();
  renderSolidsMatrixGridOnly();
}
