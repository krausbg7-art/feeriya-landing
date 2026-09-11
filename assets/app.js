/* Посадочная «Фейерверки по поводу» — Феерия.ру
   Данные: data/catalog.json (поводы, разделы) + data/products.json (товары).
   Все ссылки на магазин собираются через buildUrl(): переносим UTM и город. */

const SITE = 'https://www.feeriya.ru';
const METRIKA_ID = 20920177;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

/* ---------- город ---------- */
const CITIES = {
  msk: 'Москва', spb: 'Санкт-Петербург', ekb: 'Екатеринбург',
  nsk: 'Новосибирск', kzn: 'Казань', nn: 'Нижний Новгород'
};
const cityKey = (params.get('city') || localStorage.getItem('feeriya_city') || 'msk').toLowerCase();
const city = CITIES[cityKey] ? cityKey : 'msk';
if (CITIES[city]) localStorage.setItem('feeriya_city', city);

/* ---------- ссылки: переносим метки и город ---------- */
const KEEP = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','yclid','gclid','_ym_uid'];

function buildUrl(path, extra = {}) {
  const url = new URL(path.startsWith('http') ? path : SITE + path);
  KEEP.forEach((k) => { const v = params.get(k); if (v) url.searchParams.set(k, v); });
  url.searchParams.set('city', city);
  Object.entries(extra).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}

/* ---------- Яндекс Метрика ---------- */
function initMetrika() {
  if (window.ym) return;
  (function (m, e, t, r, i, k, a) {
    m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
    m[i].l = 1 * new Date();
    k = e.createElement(t); a = e.getElementsByTagName(t)[0];
    k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
  })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
  window.ym(METRIKA_ID, 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: true });
}

function goal(name, payload) {
  if (window.ym) window.ym(METRIKA_ID, 'reachGoal', name, payload);
}

/* ---------- состояние ---------- */
let catalog = null;
let products = {};   // { 'new-year': [15 слотов], ... }
let slots = 15;
let current = params.get('occasion') || 'new-year';
let budget = 'all';

/* ---------- загрузка ---------- */
async function load() {
  const [c, p] = await Promise.all([
    fetch('data/catalog.json').then((r) => r.json()),
    fetch('data/products.json').then((r) => r.json())
  ]);
  catalog = c;
  products = p;
  slots = (p.meta && p.meta.slotsPerOccasion) || 15;
  const filled = countFilled();
  if (filled < slots * catalog.occasions.length) showProgress(filled);
  if (!catalog.occasions.some((o) => o.id === current)) current = catalog.occasions[0].id;
}

/* ---------- рендер ---------- */
function renderPicker() {
  $('picker').innerHTML = catalog.occasions.map((o) => {
    const n = filledOf(o.id).length;
    return `<button class="picker__item" type="button" role="tab"
              aria-selected="${o.id === current}" data-occasion="${o.id}">
              ${o.icon ? `<span class="picker__icon" aria-hidden="true">${o.icon}</span>` : ''}
              <span class="picker__name">${o.name}</span>
              ${o.short ? `<span class="picker__short">${o.short}</span>` : ''}
              <span class="picker__meta">${n} ${plural(n, 'товар', 'товара', 'товаров')} из ${slots}</span>
            </button>`;
  }).join('');
}

function renderOccasion() {
  const o = catalog.occasions.find((x) => x.id === current);
  $('occTitle').textContent = `Фейерверки на ${caseName(o.name)}`;
  $('occLead').textContent = o.lead;
  $('occAdvice').textContent = o.advice;

  $('shortcuts').innerHTML = o.categories.map((c) =>
    `<li><a href="${buildUrl(c.path)}" data-track="shortcut" data-label="${c.title}">
       ${c.title} <b>${c.count}</b></a></li>`).join('');

  $('budget').innerHTML = [{ id: 'all', label: 'Любой бюджет' }, ...catalog.budgets]
    .map((b) => `<button type="button" data-budget="${b.id}" aria-pressed="${b.id === budget}">${b.label}</button>`)
    .join('');

  $('moreLink').href = buildUrl(o.categories[0].path);
  renderCards();
}

function renderCards() {
  const b = catalog.budgets.find((x) => x.id === budget);
  const all = products[current] || [];
  const filtered = all.map((p, i) => ({ ...p, slot: i + 1 }))
    .filter((p) => !p.name || !b || (p.price >= b.min && p.price < b.max));

  // при активном фильтре пустые слоты не показываем
  const list = b ? filtered.filter((p) => p.name) : filtered;

  $('cardsEmpty').hidden = list.length > 0;
  const durations = list.filter((p) => p.name).map((p) => p.duration || 0);
  const maxDur = Math.max(...durations, 1);

  $('cards').innerHTML = list.map((p) => p.name ? card(p, maxDur) : blank(p.slot)).join('');
}

function card(p, maxDur) {
  const w = Math.max(8, Math.round(((p.duration || 0) / maxDur) * 100));
  const ticks = Math.min(p.shots || 1, 120);
  return `<li class="card">
      <div class="card__top"><span class="card__name">${p.name}</span></div>
      <div class="card__price">${p.price ? fmt(p.price) + ' ₽' : 'цена не указана'}</div>

      <div class="bar">
        <div class="bar__track">
          <div class="bar__ticks" style="--w:${w}%">${'<i></i>'.repeat(ticks)}</div>
          <div class="bar__fill" style="--w:${w}%"></div>
        </div>
        <div class="bar__legend"><span>работает ${dur(p.duration || 0)}</span><span>${p.shots || 0} залп.</span></div>
      </div>

      <ul class="specs">
        <li>калибр <b>${p.caliber || '—'}</b></li>
        <li>высота <b>${p.height || 0} м</b></li>
      </ul>

      <a class="card__cta" href="${buildUrl(p.path || '/')}" data-track="product" data-label="${p.name}">Открыть в каталоге</a>
    </li>`;
}

function blank(slot) {
  return `<li class="card card--blank" aria-hidden="true">
      <span class="card__slot">Слот ${slot}</span>
      <p class="card__hint">Место под товар. Заполните <code>data/products.json</code> → <code>${current}[${slot - 1}]</code></p>
      <span class="card__ghost"></span>
    </li>`;
}

function filledOf(occId) {
  return (products[occId] || []).filter((p) => p && p.name);
}

function countFilled() {
  return catalog.occasions.reduce((a, o) => a + filledOf(o.id).length, 0);
}

function showProgress(filled) {
  const total = slots * catalog.occasions.length;
  const el = $('demoFlag');
  el.hidden = false;
  el.innerHTML = `Заполнено ${filled} из ${total} карточек. ` +
    `Добавьте товары в <code>data/products.json</code> или соберите файл из фида: <code>npm run build:catalog</code>`;
}

function renderTrust() {
  $('trust').innerHTML = catalog.trust
    .map((t) => `<li><b>${t.value}</b><span>${t.label}</span></li>`).join('');
  $('phoneLink').href = `tel:${catalog.links.phone}`;
  $('phoneLink').firstChild.textContent = catalog.links.phoneLabel + ' ';
  $('phoneHours').textContent = catalog.links.hours;
  $('cityName').textContent = CITIES[city];
}

function renderDeadline() {
  const iso = catalog.meta.deliveryDeadlines[city === 'msk' ? 'msk' : 'regions'];
  if (!iso) return;
  const left = Math.ceil((new Date(iso) - new Date()) / 86400000);
  if (left <= 0 || left > 75) return;
  $('deadline').hidden = false;
  $('deadlineDays').textContent = `${left} ${plural(left, 'день', 'дня', 'дней')}`;
  $('deadlineNote').textContent = city === 'msk'
    ? 'осталось, чтобы заказать крупный салют с доставкой по Москве к 31 декабря.'
    : 'осталось, чтобы крупный салют успел доехать в регион к 31 декабря.';
}

/* ---------- утилиты ---------- */
const fmt = (n) => n.toLocaleString('ru-RU');
const dur = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} сек`);

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const CASES = {
  'Новый год': 'Новый год', 'Свадьба': 'свадьбу', 'День рождения': 'день рождения', 'Юбилей': 'юбилей',
  'Корпоратив': 'корпоратив', 'Вечеринка': 'вечеринку'
};
const caseName = (n) => CASES[n] || n.toLowerCase();

/* ---------- события ---------- */
function bind() {
  $('picker').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-occasion]');
    if (!btn) return;
    current = btn.dataset.occasion;
    budget = 'all';
    renderPicker();
    renderOccasion();
    goal('occasion_select', { occasion: current });
    history.replaceState(null, '', `?occasion=${current}`);
    $('occasion').scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth', block: 'start' });
  });

  $('budget').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-budget]');
    if (!btn) return;
    budget = btn.dataset.budget;
    [...$('budget').children].forEach((b) => b.setAttribute('aria-pressed', b.dataset.budget === budget));
    renderCards();
    goal('budget_filter', { occasion: current, budget });
  });

  $('cityBtn').addEventListener('click', () => {
    location.href = buildUrl('/', {});
  });

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-track]');
    if (!a) return;
    goal('landing_click', { block: a.dataset.track, label: a.dataset.label || '', occasion: current });
  });
}

const prefersReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- старт ---------- */
load().then(() => {
  initMetrika();
  renderPicker();
  renderTrust();
  renderDeadline();
  renderOccasion();
  bind();
}).catch((err) => {
  console.error(err);
  document.querySelector('.occasion').innerHTML =
    '<p style="color:#b79bc0">Не удалось загрузить каталог. Обновите страницу или перейдите в <a style="color:#f2b441" href="' +
    SITE + '">основной каталог</a>.</p>';
});
