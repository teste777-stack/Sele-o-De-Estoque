'use strict';

/**
 * scraper.js
 * Faz todo o scraping do Yupoo usando axios + cheerio.
 * Estrutura verificada a partir das paginas reais do Yupoo (v4.31.x):
 *  - Lista de albuns:   /albums?page=N            -> .showindex__children a.album__main
 *  - Detalhe do album:  /albums/<id>?uid=1        -> .showalbum__children.image__main
 *  - Categorias (nav):  .showheader__categoryList a[href^="/categories/"]
 *  - Albuns por cat.:   /categories/<id>?page=N   -> .categories__children a.album__main
 *  - Link externo:      a[href*="/external?url="] (url em dupla codificacao)
 */

const axios = require('axios');
const cheerio = require('cheerio');
const browser = require('./browser');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Configura qual motor usar para buscar o HTML.
 *  - 'http'  : apenas axios (rapido, padrao).
 *  - 'auto'  : tenta axios; se falhar/HTML suspeito, usa o navegador.
 *  - 'browser'/'chromium'/'brave-launch'/'brave-connect': sempre navegador.
 */
let fetchMode = 'auto';
function setFetchMode(mode) {
  fetchMode = mode || 'auto';
}

/** Heuristica: HTML parece bloqueado / sem conteudo de albuns? */
function looksBlocked(html) {
  if (!html || html.length < 800) return true;
  const lower = html.toLowerCase();
  if (lower.includes('captcha') || lower.includes('verifying you are human')) return true;
  // Nenhum indicio das estruturas esperadas do Yupoo.
  return !/album__main|showalbum__children|categories__children/.test(html);
}

/** Cria um cliente axios com cabecalhos que o Yupoo espera. */
function makeClient(baseUrl) {
  return axios.create({
    timeout: 25000,
    maxRedirects: 5,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      Referer: baseUrl ? baseUrl + '/' : undefined,
    },
    // Aceita respostas HTML normais.
    validateStatus: (s) => s >= 200 && s < 400,
  });
}

/**
 * Normaliza a URL de uma loja Yupoo em uma base do tipo
 * https://<sub>.x.yupoo.com  (sem barra final).
 */
function normalizeStore(input) {
  if (!input) throw new Error('URL da loja vazia.');
  let raw = String(input).trim();
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  const u = new URL(raw);
  // Mantem apenas protocolo + host (ex.: akdingji.x.yupoo.com)
  return `${u.protocol}//${u.host}`;
}

/** Transforma URLs protocol-relative (//...) em absolutas https. */
function absUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  if (s.startsWith('//')) return 'https:' + s;
  return s;
}

/**
 * Normaliza um link: decodifica entidades HTML (&amp; -> &) e afins,
 * evitando duplicatas como "...&amp;spider_token" vs "...&spider_token".
 */
function cleanUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (!s) return null;
  s = s
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  return s.replace(/[),.]+$/, ''); // remove pontuacao final acidental
}

/**
 * Decodifica o link externo do Yupoo.
 * Ex.: /external?url=https%253A%252F%252Fweidian.com... (dupla codificacao)
 */
function decodeExternal(href, fallbackText) {
  try {
    const u = new URL(href, 'https://x.yupoo.com');
    const raw = u.searchParams.get('url');
    if (raw) {
      // searchParams ja decodifica um nivel; decodifica o restante.
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch (_) {
        /* mantem raw */
      }
      return decoded;
    }
  } catch (_) {
    /* ignora */
  }
  return fallbackText || href;
}

/** Extrai o id numerico de uma href de album (/albums/244592844?...). */
function albumIdFromHref(href) {
  const m = String(href || '').match(/albums\/(\d+)/);
  return m ? m[1] : null;
}

/** Extrai o id de categoria (/categories/5267197). */
function categoryIdFromHref(href) {
  const m = String(href || '').match(/categories\/(\d+)/);
  return m ? m[1] : null;
}

/** Lê o total de paginas a partir do rodapé de paginacao. */
function readTotalPages($) {
  const txt = $('.pagination__jumpwrap').text() || $('body').text();
  const m = txt.match(/(\d+)\s*p[áa]ginas/i);
  if (m) return parseInt(m[1], 10);
  // Tenta o formato "1 / 181"
  const span = $('.categories__box-right-pagination-span').first().text();
  const m2 = span.match(/\/\s*(\d+)/);
  if (m2) return parseInt(m2[1], 10);
  return 1;
}

async function fetchHtml(client, url) {
  // Modo navegador explicito.
  if (fetchMode !== 'http' && fetchMode !== 'auto' && browser.isBrowserMode()) {
    const html = await browser.getRenderedHtml(url);
    return cheerio.load(html);
  }

  // Tenta axios primeiro.
  try {
    const res = await client.get(url);
    const html = res.data;
    // Em modo 'auto', se o HTML parecer bloqueado e houver navegador ativo, refaz.
    if (fetchMode === 'auto' && browser.isBrowserMode() && looksBlocked(html)) {
      const rendered = await browser.getRenderedHtml(url);
      return cheerio.load(rendered);
    }
    return cheerio.load(html);
  } catch (err) {
    // Fallback para navegador quando disponivel.
    if (browser.isBrowserMode()) {
      const rendered = await browser.getRenderedHtml(url);
      return cheerio.load(rendered);
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  ALBUNS (pagina inicial /albums)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Considera um album "vazio" (sem fotos) quando nao tem capa OU quando a
 * contagem de fotos esta explicitamente em zero.
 */
function isEmptyAlbum(cover, photoCount) {
  if (!cover) return true;
  const m = String(photoCount || '').match(/\d+/);
  if (m && Number(m[0]) === 0) return true;
  return false;
}

async function fetchAlbums(store, page = 1) {
  const base = normalizeStore(store);
  const client = makeClient(base);
  const url = `${base}/albums?page=${page}`;
  const $ = await fetchHtml(client, url);

  const albums = [];
  $('.showindex__children a.album__main').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const id = albumIdFromHref(href);
    if (!id) return;
    const img = $el.find('img').first();
    const cover = absUrl(img.attr('src') || img.attr('data-src'));
    const photoCount = ($el.find('.album__photonumber').text() || '').trim();
    // Ignora albuns sem fotos (sem capa ou contagem zero).
    if (isEmptyAlbum(cover, photoCount)) return;
    albums.push({
      id,
      title: ($el.attr('title') || $el.find('.album__title').text() || '').trim(),
      url: `${base}/albums/${id}?uid=1`,
      cover,
      photoCount,
    });
  });

  return {
    store: base,
    page,
    totalPages: readTotalPages($),
    count: albums.length,
    albums,
  };
}

/* -------------------------------------------------------------------------- */
/*  DETALHE DO ALBUM                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Coleta os links externos/internos de um documento de album.
 * Retorna { externalLinks:[], rawLinks:[] } sem duplicatas.
 */
function extractLinks($) {
  const external = new Set();
  const raw = new Set();

  // Links de fonte (weidian, taobao, etc.) via /external?url=
  $('a[href*="/external?url="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = ($(el).text() || '').trim();
    const decoded = decodeExternal(href, text);
    if (decoded) external.add(decoded);
  });

  // Qualquer link direto na descricao do album.
  $('.showalbumheader__gallerysubtitle a, .htmlwrap__main a').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href) return;
    if (href.includes('/external?url=')) {
      external.add(decodeExternal(href, $(el).text().trim()));
    } else if (/^https?:\/\//i.test(href)) {
      raw.add(href);
      external.add(href);
    }
  });

  // Fallback: procura URLs no texto da descricao.
  const descText = $('.showalbumheader__gallerysubtitle').text() || '';
  const urlRe = /https?:\/\/[^\s"'<>]+/g;
  let mm;
  while ((mm = urlRe.exec(descText)) !== null) {
    raw.add(mm[0]);
    external.add(mm[0]);
  }

  // Normaliza (decodifica &amp; etc.) e deduplica.
  const normExternal = [...new Set([...external].map(cleanUrl).filter(Boolean))];
  const normRaw = [...new Set([...raw].map(cleanUrl).filter(Boolean))];
  return { externalLinks: normExternal, rawLinks: normRaw };
}

async function fetchAlbum(store, albumId) {
  const base = normalizeStore(store);
  const client = makeClient(base);
  const url = `${base}/albums/${albumId}?uid=1`;
  const $ = await fetchHtml(client, url);

  const title = (
    $('.showalbumheader__gallerytitle').first().text() ||
    $('title').text() ||
    ''
  ).trim();

  const { externalLinks, rawLinks } = extractLinks($);

  const photos = [];
  $('.showalbum__children.image__main').each((_, el) => {
    const img = $(el).find('img').first();
    const origin = absUrl(img.attr('data-origin-src'));
    const big = absUrl(img.attr('data-src'));
    const small = absUrl(img.attr('src'));
    const path = img.attr('data-path') || '';
    const best = origin || big || small;
    if (!best) return;
    photos.push({
      id: $(el).attr('data-id') || '',
      title: (img.attr('alt') || '').trim(),
      origin: origin || big || small,
      big: big || origin || small,
      thumb: small || big || origin,
      path,
    });
  });

  return {
    store: base,
    id: String(albumId),
    title,
    url,
    hasLink: externalLinks.length > 0,
    externalLinks,
    rawLinks,
    photoCount: photos.length,
    photos,
    // Todos os links "fonte" desse album (album + externos + originais das fotos).
    archivedLinks: [url, ...externalLinks, ...photos.map((p) => p.origin)],
  };
}

/* -------------------------------------------------------------------------- */
/*  VERIFICACAO RAPIDA DE LINKS (badge na grade)                              */
/* -------------------------------------------------------------------------- */

/** Executa fn sobre items com limite de concorrencia. */
async function mapLimit(items, limit, fn, shouldCancel) {
  const results = [];
  let i = 0;
  const n = Math.min(limit, items.length);
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      if (typeof shouldCancel === 'function' && shouldCancel()) break;
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Verifica, para uma lista de ids, se o album possui link externo.
 * Retorna um mapa { id: { hasLink, externalLinks } }.
 */
async function checkAlbumLinks(store, albumIds, concurrency = 5, shouldCancel) {
  const base = normalizeStore(store);
  const client = makeClient(base);
  const map = {};
  await mapLimit(
    albumIds,
    concurrency,
    async (id) => {
      try {
        const $ = await fetchHtml(client, `${base}/albums/${id}?uid=1`);
        const { externalLinks } = extractLinks($);
        map[id] = { hasLink: externalLinks.length > 0, externalLinks };
      } catch (err) {
        map[id] = { hasLink: null, externalLinks: [], error: err.message };
      }
    },
    shouldCancel
  );
  return map;
}

/* -------------------------------------------------------------------------- */
/*  CATEGORIAS                                                                */
/* -------------------------------------------------------------------------- */

/** Lê a lista de categorias a partir da navegacao (presente em toda pagina). */
async function fetchCategories(store) {
  const base = normalizeStore(store);
  const client = makeClient(base);
  const $ = await fetchHtml(client, `${base}/categories`);

  const seen = new Set();
  const categories = [];

  const pushCat = (href, name) => {
    const id = categoryIdFromHref(href);
    if (id === null || seen.has(id)) return;
    seen.add(id);
    categories.push({
      id,
      name: (name || '').trim(),
      url: `${base}/categories/${id}`,
    });
  };

  // Barra lateral completa da pagina /categories
  $('.yupoo-collapse-item .yupoo-collapse-header a[href*="/categories/"]').each(
    (_, el) => pushCat($(el).attr('href'), $(el).attr('title') || $(el).text())
  );
  // Navegacao do topo (fallback / complemento)
  $('.showheader__categoryList a[href*="/categories/"]').each((_, el) =>
    pushCat($(el).attr('href'), $(el).find('li').text() || $(el).text())
  );

  let total = null;
  const m = ($('.categories__box-right-total').text() || '').match(/(\d+)/);
  if (m) total = parseInt(m[1], 10);

  return { store: base, totalAlbums: total, count: categories.length, categories };
}

/** Lê os albuns de uma categoria especifica. */
async function fetchCategoryAlbums(store, categoryId, page = 1) {
  const base = normalizeStore(store);
  const client = makeClient(base);
  const idPart = categoryId === 'all' || categoryId == null ? '' : `/${categoryId}`;
  const url = `${base}/categories${idPart}?page=${page}`;
  const $ = await fetchHtml(client, url);

  const catName =
    ($('.yupoo-crumbs-span').last().text() || '').trim() || String(categoryId);

  const albums = [];
  $('.categories__children').each((_, el) => {
    const $a = $(el).find('a.album__main').first();
    const href = $a.attr('href') || '';
    const id = albumIdFromHref(href);
    if (!id) return;
    const img = $a.find('img').first();
    const cover = absUrl(img.attr('src') || img.attr('data-src'));
    const photoCount = ($(el).find('.album__photonumber').text() || '').trim();
    // Ignora albuns sem fotos (sem capa ou contagem zero).
    if (isEmptyAlbum(cover, photoCount)) return;
    albums.push({
      id,
      title: ($a.attr('title') || $(el).find('.album__title').text() || '').trim(),
      url: `${base}/albums/${id}?uid=1`,
      cover,
      photoCount,
      category: { id: String(categoryId), name: catName },
    });
  });

  return {
    store: base,
    category: { id: String(categoryId), name: catName },
    page,
    totalPages: readTotalPages($),
    count: albums.length,
    albums,
  };
}

/* -------------------------------------------------------------------------- */
/*  PRECOS (paginas de produto: taobao / weidian / mulebuy / agentes)         */
/* -------------------------------------------------------------------------- */

/** Descobre o "dominio de produto" a partir da URL. */
function priceDomain(url) {
  const h = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  })();
  if (/taobao\.|tmall\./.test(h)) return 'taobao';
  if (/weidian\./.test(h)) return 'weidian';
  if (/mulebuy\./.test(h)) return 'mulebuy';
  if (/1688\./.test(h)) return 'x1688';
  return 'other';
}

const CURRENCY_MAP = [
  { re: /(?:R\$)/, code: 'BRL' },
  { re: /(?:US\$|USD|\$)/, code: 'USD' },
  { re: /(?:CN¥|RMB|CNY|¥|￥|元)/, code: 'CNY' },
];

/** Deduz o codigo da moeda a partir de um trecho de texto. */
function guessCurrency(text) {
  if (!text) return null;
  for (const c of CURRENCY_MAP) {
    if (c.re.test(text)) return c.code;
  }
  return null;
}

/** Extrai o primeiro numero "de preco" de um texto. */
function parseAmount(text) {
  if (!text) return null;
  // Captura 1.234,56 / 1,234.56 / 123.45 / 123
  const m = String(text).match(/\d[\d.,]*\d|\d/);
  if (!m) return null;
  let s = m[0];
  // Normaliza separadores: se tem ',' e '.', o ultimo e o decimal.
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (s.includes(',')) {
    // Só vírgula: trata como decimal se tiver 1-2 casas ao final.
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Tenta extrair {price, currency, raw} de um documento cheerio.
 * Combina JSON-LD, meta-tags, seletores por dominio e regex de fallback.
 */
function extractPrice($, domain) {
  const attempt = (raw, curHint) => {
    const amount = parseAmount(raw);
    if (amount == null) return null;
    const currency = guessCurrency(raw) || guessCurrency(curHint) || null;
    return { price: amount, currency, raw: String(raw).trim().slice(0, 60) };
  };

  // 0) Weidian: JSON server-side injetado (fonte mais confiavel).
  if (domain === 'weidian') {
    const obj = $('#__rocker-render-inject__').attr('data-obj');
    if (obj) {
      try {
        const data = JSON.parse(obj);
        const info =
          data &&
          data.result &&
          data.result.default_model &&
          data.result.default_model.item_info;
        if (info) {
          let val = info.origin_price;
          if (val == null && info.itemLowPrice != null) val = info.itemLowPrice / 100;
          if (val != null) {
            const r = attempt(String(val), '¥');
            if (r) {
              r.currency = r.currency || 'CNY';
              return r;
            }
          }
        }
      } catch (_) {
        /* json invalido -> segue */
      }
    }
  }

  // 1) JSON-LD (schema.org Product/Offer).
  let found = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return;
    try {
      const data = JSON.parse($(el).contents().text());
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const offers =
          node && (node.offers || (node['@graph'] || []).map((g) => g.offers).find(Boolean));
        const off = Array.isArray(offers) ? offers[0] : offers;
        if (off && (off.price || off.lowPrice)) {
          found = attempt(String(off.price || off.lowPrice), off.priceCurrency);
          if (found && off.priceCurrency) found.currency = off.priceCurrency;
          return;
        }
      }
    } catch (_) {
      /* ignora json invalido */
    }
  });
  if (found) return found;

  // 2) Meta-tags padrao de e-commerce.
  const metaSels = [
    'meta[property="product:price:amount"]',
    'meta[property="og:price:amount"]',
    'meta[itemprop="price"]',
    'meta[name="price"]',
  ];
  for (const sel of metaSels) {
    const c = $(sel).attr('content');
    if (c) {
      const curr =
        $('meta[property="product:price:currency"]').attr('content') ||
        $('meta[property="og:price:currency"]').attr('content') ||
        $('meta[itemprop="priceCurrency"]').attr('content');
      const r = attempt(c, curr);
      if (r) {
        if (curr && !r.currency) r.currency = curr;
        return r;
      }
    }
  }

  // 3) Seletores especificos por dominio.
  const domainSels = {
    taobao: [
      '.tm-price',
      '.tb-rmb-num',
      '#J_StrPrice .tb-rmb-num',
      '.tm-promo-price .tm-price',
      '.price .tb-rmb-num',
      '[class*="Price--priceText"]',
      '[class*="priceText"]',
    ],
    weidian: [
      '.cur-price-wrap .cur-price',
      '.cur-price',
      '.cur-price-wrap',
      '.item-price',
      '.price-wrap',
      '.price',
      '[class*="cur-price"]',
      '[class*="price"]',
      '.goods-price',
    ],
    mulebuy: ['[class*="price"]', '[class*="Price"]', '.product-price', '.goods-price'],
    x1688: ['.price', '[class*="price"]'],
    other: ['[class*="price"]', '[class*="Price"]'],
  };
  for (const sel of domainSels[domain] || domainSels.other) {
    const nodes = $(sel);
    for (let i = 0; i < nodes.length; i++) {
      const txt = $(nodes[i]).text().trim();
      const r = attempt(txt, txt);
      if (r && r.price > 0) return r;
    }
  }

  // 4) Regex de fallback: procura padrao "moeda + numero" no corpo.
  const bodyTxt = $('body').text().replace(/\s+/g, ' ');
  const m = bodyTxt.match(/(?:R\$|US\$|CN¥|RMB|USD|CNY|¥|￥|\$)\s?\d[\d.,]*/);
  if (m) {
    const r = attempt(m[0], m[0]);
    if (r) return r;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  COTACOES / CONVERSAO DE MOEDA                                             */
/* -------------------------------------------------------------------------- */

let ratesCache = null; // { ts, rates } com base em USD

/** Busca (e cacheia por 6h) as cotacoes com base em USD. */
async function getRates() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (ratesCache && Date.now() - ratesCache.ts < SIX_HOURS) return ratesCache.rates;
  try {
    const res = await axios.get('https://open.er-api.com/v6/latest/USD', {
      timeout: 12000,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (res.data && res.data.rates) {
      ratesCache = { ts: Date.now(), rates: res.data.rates };
    }
  } catch (_) {
    /* mantem cache antigo se houver */
  }
  return ratesCache ? ratesCache.rates : null;
}

/** Converte um valor de uma moeda para outra usando cotacoes base-USD. */
function convertCurrency(amount, from, to, rates) {
  if (amount == null || !rates) return null;
  if (from === to) return amount;
  const rFrom = rates[from];
  const rTo = rates[to];
  if (!rFrom || !rTo) return null;
  return (amount / rFrom) * rTo; // amount(from) -> USD -> to
}

/** Arredonda para 2 casas decimais (retorna number ou null). */
function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Detecta um preco "obvio" escrito no texto (ex.: nome do album).
 * Padroes: ￥98, ¥239, ￥~98, CN¥98, RMB 98, US$ 30, R$ 50, 98元 ...
 * Retorna { price, currency, raw } ou null.
 */
function parsePriceFromText(text) {
  if (!text) return null;
  const s = String(text);
  let m = s.match(/(cn¥|rmb|cny|us\$|r\$|[￥¥$])\s*[~≈约]?\s*(\d[\d.,]*\d|\d)/i);
  let curText = null;
  let numText = null;
  if (m) {
    curText = m[1];
    numText = m[2];
  } else {
    m = s.match(/(\d[\d.,]*\d|\d)\s*(元|rmb|cny)/i);
    if (m) {
      numText = m[1];
      curText = m[2];
    }
  }
  if (!numText) return null;
  const price = parseAmount(numText);
  if (price == null || price <= 0) return null;
  const currency = guessCurrency(curText) || 'CNY';
  return { price, currency, raw: (m[0] || '').trim() };
}

/**
 * Extrai o preco do texto e converte para USD/BRL usando as cotacoes.
 * Retorna um objeto no mesmo formato de fetchPrice (com source:'title').
 */
async function priceFromText(text) {
  const p = parsePriceFromText(text);
  if (!p) return null;
  const rates = await getRates();
  return {
    price: p.price,
    currency: p.currency,
    usd: round2(convertCurrency(p.price, p.currency, 'USD', rates)),
    brl: round2(convertCurrency(p.price, p.currency, 'BRL', rates)),
    raw: p.raw,
    ok: true,
    source: 'title',
  };
}

/** Busca o preco de UMA url. Estrategia: HTTP rapido -> navegador realista. */
async function fetchPrice(url) {
  const domain = priceDomain(url);
  const result = {
    url,
    domain,
    price: null,
    currency: null,
    usd: null,
    brl: null,
    ok: false,
    engine: null,
    error: null,
  };

  // Finaliza o resultado: define moeda e calcula conversao para USD/BRL.
  const finalize = async (extra) => {
    Object.assign(result, extra);
    if (result.price != null) {
      // Sites chineses sem moeda explicita -> assume CNY (¥).
      result.currency = result.currency || 'CNY';
      const rates = await getRates();
      result.usd = round2(convertCurrency(result.price, result.currency, 'USD', rates));
      result.brl = round2(convertCurrency(result.price, result.currency, 'BRL', rates));
    }
    return result;
  };

  // Taobao bloqueia raspagem e sempre falha: nao tentamos acessa-lo.
  if (domain === 'taobao') {
    return { ...result, engine: 'skip', error: 'Taobao não é acessado (ignorado).' };
  }

  // 1) Tentativa HTTP (rapida). Pulada no Taobao (quase sempre bloqueia).
  if (domain !== 'taobao') {
    try {
      const client = makeClient();
      const res = await client.get(url, { timeout: 15000 });
      const $ = cheerio.load(res.data);
      const p = extractPrice($, domain);
      if (p && p.price != null) {
        return finalize({ ...p, ok: true, engine: 'http' });
      }
    } catch (_) {
      /* segue para o navegador */
    }
  }

  // 2) Navegador "realista" (Brave conectado -> Brave do sistema -> Chromium).
  try {
    const { html, engine } = await browser.renderPricePage(url);
    const $ = cheerio.load(html);
    const p = extractPrice($, domain);
    if (p && p.price != null) {
      return finalize({ ...p, ok: true, engine });
    }
    return { ...result, engine, error: 'Preço não encontrado na página.' };
  } catch (err) {
    return { ...result, error: err.message };
  }
}

/**
 * Busca precos de varias urls com limite de concorrencia.
 * @param {string[]} urls
 * @param {(done:number,total:number,item:object)=>void} [onProgress]
 */
async function fetchPrices(urls, onProgress, concurrency = 3, shouldCancel) {
  const list = [...new Set((urls || []).filter(Boolean))];
  let done = 0;
  const results = await mapLimit(
    list,
    concurrency,
    async (url) => {
      const r = await fetchPrice(url);
      done += 1;
      if (typeof onProgress === 'function') onProgress(done, list.length, r);
      return r;
    },
    shouldCancel
  );
  return results;
}

module.exports = {
  normalizeStore,
  absUrl,
  decodeExternal,
  fetchAlbums,
  fetchAlbum,
  checkAlbumLinks,
  fetchCategories,
  fetchCategoryAlbums,
  fetchPrice,
  fetchPrices,
  parsePriceFromText,
  priceFromText,
  setFetchMode,
  browser,
};
