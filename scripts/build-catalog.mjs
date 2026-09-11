#!/usr/bin/env node
/**
 * Конвертер YML-фида интернет-магазина (Яндекс.Маркет YML) в data/products.json
 * для посадочной страницы «Фейерверки по поводу».
 *
 * Без внешних зависимостей — только встроенные модули Node.
 *
 * Использование:
 *   node scripts/build-catalog.mjs <url-или-путь-к-фиду>
 *   node scripts/build-catalog.mjs ./feed.xml --limit 20
 *   node scripts/build-catalog.mjs https://www.feeriya.ru/yandex.yml
 *
 * Что делает:
 *   1. Загружает YML (по URL или с диска) и достаёт офферы <offer>.
 *   2. Оставляет доступные к продаже офферы (available != "false") с ценой,
 *      ссылкой и названием.
 *   3. Пытается достать залпы/калибр/высоту/время работы из <param>,
 *      а если их нет — угадывает по названию и описанию через regex.
 *   4. Раскладывает офферы по 9 поводам (см. RULES) по правилам: совпадение
 *      ключевых слов в названии + ограничение цены.
 *   5. Для каждого повода берёт до 10 товаров, равномерно распределённых по
 *      цене (не просто самые дешёвые), и дозаполняет оставшиеся слоты пустыми
 *      заготовками.
 *   6. Достаёт картинку (первый <picture>) и, если указана в параметрах,
 *      ссылку на видео.
 *   7. Пишет итоговый файл в data/products.json.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'data', 'products.json');
const SLOTS_PER_OCCASION = 10;

/** Правила раскладки офферов по поводам: ключевые слова + ограничение цены. */
const RULES = {
  'new-year': { any: ['батаре', 'салют', 'римск', 'бенгал', 'хлопуш', 'фонтан'], minPrice: 150 },
  wedding: { any: ['фонтан', 'пневмо', 'римск', 'холодн', 'батаре'], maxPrice: 40000 },
  birthday: { any: ['мал', 'фонтан', 'пневмо', 'бенгал', 'хлопуш', 'батаре'], maxPrice: 15000 },
  corporate: { any: ['супер', 'крупн', 'средн', 'батаре', 'фонтан'], minPrice: 8000 },
  party: { any: ['средн', 'мал', 'фонтан', 'хлопуш', 'бенгал'], maxPrice: 20000 },
  feb23: { any: ['крупн', 'средн', 'римск', 'батаре'], minPrice: 5000 },
  mar8: { any: ['фонтан', 'мал', 'бенгал', 'пневмо'], maxPrice: 15000 },
  may9: { any: ['крупн', 'супер', 'римск', 'фонтан'], minPrice: 8000 },
  anniversary: { any: ['крупн', 'супер', 'батаре', 'римск', 'фонтан'], minPrice: 8000 }
};

async function main() {
  const args = process.argv.slice(2);
  const source = args.find((a) => !a.startsWith('--'));
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag !== -1 ? Number(args[limitFlag + 1]) : null;

  if (!source) {
    console.error('Использование: node scripts/build-catalog.mjs <url-или-путь-к-фиду> [--limit N]');
    process.exit(1);
  }

  const xml = await loadFeed(source);
  let offers = parseOffers(xml);

  if (offers.length === 0) {
    console.error('В фиде не найдено ни одного подходящего оффера (нужны available!=false, price, url, name).');
    process.exit(1);
  }

  if (limit) offers = offers.slice(0, limit);

  const byOccasion = {};
  for (const id of Object.keys(RULES)) byOccasion[id] = [];

  for (const offer of offers) {
    for (const [occasionId, rule] of Object.entries(RULES)) {
      if (matchesRule(offer, rule)) byOccasion[occasionId].push(offer);
    }
  }

  const products = { meta: buildMeta(source, offers.length) };
  let filled = 0;

  for (const occasionId of Object.keys(RULES)) {
    const picked = pickEvenlyByPrice(byOccasion[occasionId], SLOTS_PER_OCCASION);
    filled += picked.length;
    const slots = picked.map(toSlot);
    while (slots.length < SLOTS_PER_OCCASION) slots.push(emptySlot());
    products[occasionId] = slots;
  }

  products.meta.filled = filled;
  products.meta.total = SLOTS_PER_OCCASION * Object.keys(RULES).length;

  await writeFile(OUT_FILE, JSON.stringify(products, null, 2) + '\n', 'utf8');
  console.log(`Готово: ${OUT_FILE} (заполнено ${filled} из ${products.meta.total} слотов).`);
}

/** Загружает фид по URL или с диска. */
async function loadFeed(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Не удалось загрузить фид: HTTP ${res.status}`);
    return await res.text();
  }
  return await readFile(path.resolve(source), 'utf8');
}

/** Достаёт офферы из YML и приводит их к внутреннему формату. */
function parseOffers(xml) {
  const blocks = xml.match(/<offer\b[\s\S]*?<\/offer>/g) || [];
  const offers = [];

  for (const block of blocks) {
    const available = /available="([^"]*)"/.exec(block)?.[1];
    if (available === 'false') continue;

    const name = decode(str(tag(block, 'name') || tag(block, 'model') || tag(block, 'typePrefix')));
    const price = num(tag(block, 'price'));
    const url = str(tag(block, 'url'));
    if (!name || !price || !url) continue;

    const description = decode(str(tag(block, 'description')));
    const p = params(block);

    offers.push({
      id: str(/<offer\b[^>]*\bid="([^"]*)"/.exec(block)?.[1]),
      name,
      price,
      url,
      shots: num(p['Количество залпов'] || p['Количество зарядов']) || guessShots(name, description),
      caliber: str(p['Калибр']) || guessCaliber(name, description),
      height: num(p['Высота подъема'] || p['Высота, м']) || guessHeight(description),
      duration: seconds(p['Время работы'] || p['Продолжительность']) || guessDuration(description),
      image: str(tag(block, 'picture')),
      video: str(p['Видео'] || p['Video'] || p['Ссылка на видео'] || p['Видеообзор'])
    });
  }

  return offers;
}

/** Оффер подходит под правило, если есть совпадение по ключевым словам и цена в диапазоне. */
function matchesRule(offer, rule) {
  const haystack = offer.name.toLowerCase();
  const hasWord = rule.any.some((w) => haystack.includes(w));
  if (!hasWord) return false;
  if (rule.minPrice && offer.price < rule.minPrice) return false;
  if (rule.maxPrice && offer.price > rule.maxPrice) return false;
  return true;
}

/**
 * Берёт до `count` офферов, распределённых равномерно по цене (не только
 * самые дешёвые): сортирует по цене и берёт с равным шагом по индексу.
 */
function pickEvenlyByPrice(offers, count) {
  if (offers.length <= count) {
    return [...offers].sort((a, b) => a.price - b.price);
  }
  const sorted = [...offers].sort((a, b) => a.price - b.price);
  const step = sorted.length / count;
  const picked = [];
  for (let i = 0; i < count; i++) {
    picked.push(sorted[Math.floor(i * step)]);
  }
  return picked;
}

function toSlot(offer) {
  return {
    id: offer.id,
    name: offer.name,
    price: offer.price,
    shots: offer.shots,
    caliber: offer.caliber,
    height: offer.height,
    duration: offer.duration,
    path: pathFromUrl(offer.url),
    image: offer.image,
    video: offer.video
  };
}

function emptySlot() {
  return {
    id: '', name: '', price: 0, shots: 0, caliber: '', height: 0, duration: 0, path: '',
    image: '', video: ''
  };
}

function buildMeta(source, totalOffers) {
  return {
    slotsPerOccasion: SLOTS_PER_OCCASION,
    generated: new Date().toISOString(),
    source,
    offersParsed: totalOffers,
    note: 'Слоты заполняются сверху вниз в каждом поводе. Пустые слоты — заготовки, дозаполните фид или впишите товары вручную. Поля image/video берутся из <picture> и параметра "Видео" в офферах, если есть.'
  };
}

/* ---------- парсинг тегов и параметров ---------- */

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  return re.exec(block)?.[1];
}

function params(block) {
  const result = {};
  const re = /<param\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/param>/gi;
  let m;
  while ((m = re.exec(block))) {
    result[decode(m[1].trim())] = decode(m[2].trim());
  }
  return result;
}

function str(v) {
  return (v ?? '').toString().trim();
}

function num(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[^\d.,]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Переводит строку времени работы ("1 мин 30 сек", "90 сек", "1:30") в секунды. */
function seconds(v) {
  if (!v) return 0;
  const s = String(v).toLowerCase();

  const mmss = /^(\d+):(\d+)$/.exec(s.trim());
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);

  let total = 0;
  const min = /(\d+)\s*мин/.exec(s);
  const sec = /(\d+)\s*сек/.exec(s);
  if (min) total += Number(min[1]) * 60;
  if (sec) total += Number(sec[1]);
  if (total) return total;

  const bare = /^\d+$/.exec(s.trim());
  return bare ? Number(bare[0]) : 0;
}

/* ---------- угадывание характеристик по тексту ---------- */

function guessShots(name, description) {
  const text = `${name} ${description}`;
  const m = /(\d+)\s*(?:залп|заряд)/i.exec(text);
  return m ? Number(m[1]) : 0;
}

function guessCaliber(name, description) {
  const text = `${name} ${description}`;
  const m = /(\d+([.,]\d+)?)\s*("|дюйм|mm|мм)/i.exec(text);
  if (!m) return '';
  return /мм|mm/i.test(m[3]) ? `${m[1]} мм` : `${m[1]}"`;
}

function guessHeight(description) {
  const m = /(\d+)\s*(?:м|метр)/i.exec(description || '');
  return m ? Number(m[1]) : 0;
}

function guessDuration(description) {
  return seconds(description || '');
}

function pathFromUrl(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith('/') ? url : `/${url}`;
  }
}

/** Раскодирует основные HTML-сущности, которые встречаются в YML-фидах. */
function decode(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
