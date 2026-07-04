'use strict';

/* global window, document */
const api = window.electronAPI;

/* --------------------------- Estado da aplicacao -------------------------- */
const state = {
  store: '',
  view: 'albums',
  albumsPage: 1,
  albumsTotalPages: 1,
  currentAlbums: [], // albuns exibidos na grade atual
  currentCategory: null, // { id, name } quando navegando por categoria
  favKeys: new Set(), // "store::id" dos favoritos, para marcar estrela
  currentAlbumDetail: null, // album aberto no modal
  chosenFolder: null, // pasta de destino escolhida
  prices: {}, // cache de precos por url: { [url]: {price, currency, ok, engine, error} }
  verify: { running: false, results: [] }, // verificacao de precos em varias lojas
  profitPct: 0, // % de lucro do simulador de preco (global)
  profitByUrl: {}, // % de lucro por produto (url) — prioridade sobre o global
  tags: [], // catalogo de tags {name, kind}
  favList: [], // favoritos carregados (para filtrar sem refetch)
  tagFilter: new Set(), // tags selecionadas no filtro de favoritos
  selectedFavs: new Set(), // favoritos marcados para atribuicao em massa de tags
  titlePrices: {}, // precos detectados no nome do album, por id/favKey
  favQueue: [], // fila de favoritos a arquivar em segundo plano
  favQueueBusy: false, // indica se a fila esta sendo processada
  seen: new Set(), // IDs de albuns ja vistos na loja atual
  seenStore: null, // loja para a qual state.seen foi carregado
  seenAll: false, // true se a loja atual esta marcada como "Visto" por inteiro
  favSeen: new Set(), // chaves "store::id" ja vistas (para a aba Favoritos)
};

/* ------------------------------- Utilidades ------------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showLoading(on, label) {
  const el = $('#loading');
  const txt = $('#loadingText');
  if (txt) txt.textContent = label ? `${label}…` : 'Carregando…';
  el.classList.toggle('hidden', !on);
}

function setStatus(msg, isError) {
  const el = $('#statusMsg');
  el.textContent = msg || '';
  el.style.color = isError ? 'var(--danger)' : 'var(--accent-2)';
  if (msg) setTimeout(() => (el.textContent === msg ? (el.textContent = '') : null), 4000);
}

// Relatório FIXO do cache local de capas (não some sozinho), no topo da aba
// Favoritos. Mostra quantas capas já estão arquivadas em disco e o progresso.
function setCacheStatus(msg) {
  const el = $('#cacheStatus');
  if (el) el.textContent = msg;
}

// Monta o relatório completo dos favoritos (contagens de itens, preços em cache,
// preços a buscar e estado do cache de capas) na barra fixa.
function renderFavReport() {
  const r = state._favReport;
  if (!r) return;
  const parts = [`${r.favs} favoritos`];
  if (r.withLink != null) parts.push(`${r.withLink} com link`);
  if (r.pricesCache != null) parts.push(`${r.pricesCache} preços no cache`);
  if (r.toFetch) parts.push(`buscando ${r.toFetch} preço(s)…`);
  if (r.covers) {
    parts.push(
      `capas ${r.covers.cached}/${r.covers.total} no cache local` +
        (r.covers.missing ? ` (arquivando ${r.covers.missing})` : ' ✓')
    );
  }
  setCacheStatus(parts.join(' · '));
}

// Progresso visual de captura (fotos do cache + preços), ex.: "Capturando
// fotos 12/340 · preços 3/50". Atualiza a barra de status conforme carrega.
const progress = { photos: { done: 0, total: 0 }, prices: { done: 0, total: 0 } };
function renderProgress() {
  const parts = [];
  if (progress.photos.total)
    parts.push(`fotos ${progress.photos.done}/${progress.photos.total}`);
  if (progress.prices.total)
    parts.push(`preços ${progress.prices.done}/${progress.prices.total}`);
  if (parts.length) setStatus('Capturando ' + parts.join(' · '));
}

/**
 * Chamado ao renderizar uma grade nova: zera o progresso de preços da grade
 * anterior. O progresso de FOTOS não é mais medido pelo evento `load` das
 * imagens (com `loading="lazy"` as imagens fora da tela nunca disparam `load`,
 * o que deixava o contador travado). Ele agora reflete o pré-cache real
 * (arquivamento em segundo plano), enviado pelo processo principal.
 */
function trackImageProgress(container) {
  if (!container) return;
  progress.prices.total = 0; // novo grid: zera o progresso de preços antigo
  progress.prices.done = 0;
  renderProgress();
}

// Controla a exibicao do botao "Parar" durante buscas de links/precos.
let loadingOps = 0;
function beginCancelable() {
  loadingOps += 1;
  const btn = $('#cancelLoading');
  if (btn) btn.classList.remove('hidden');
}
function endCancelable() {
  loadingOps = Math.max(0, loadingOps - 1);
  if (loadingOps === 0) {
    const btn = $('#cancelLoading');
    if (btn) btn.classList.add('hidden');
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function favKey(store, id) {
  return `${store}::${id}`;
}

/**
 * Converte uma URL de imagem do Yupoo no esquema local `ycimg://` para que a
 * imagem seja baixada uma vez e servida do DISCO (arquivada, sem depender do
 * CDN do Yupoo que bloqueia rajadas). URLs não-Yupoo passam sem alteração.
 */
function cimg(url) {
  if (!url) return '';
  if (!/^https?:\/\/(photo\.yupoo\.com|[a-z0-9-]+\.x\.yupoo\.com)/i.test(url)) return url;
  const b64 = btoa(unescape(encodeURIComponent(url)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return 'ycimg://img/' + b64;
}

/** Formata um preco com a moeda original + conversao para US$ e R$. */
function fmtPrice(p) {
  if (!p || p.price == null) return '';
  const sym = { CNY: '¥', USD: 'US$', BRL: 'R$', EUR: '€' };
  const orig = (sym[p.currency] || (p.currency ? p.currency + ' ' : '')) + p.price;
  const extra = [];
  if (p.currency !== 'USD' && p.usd != null) extra.push('US$' + p.usd);
  if (p.currency !== 'BRL' && p.brl != null) extra.push('R$' + p.brl);
  let out = extra.length ? `${orig} ≈ ${extra.join(' / ')}` : orig;

  // Simulador de lucro: o % do PRODUTO tem prioridade sobre o % global.
  const indiv = p.url != null ? state.profitByUrl[p.url] : undefined;
  const pct = indiv != null ? indiv : state.profitPct;
  if (pct > 0) {
    const g = pct / 100; // fracao que representa o LUCRO (nao o preco final)
    const brl = p.brl != null ? p.brl : p.currency === 'BRL' ? p.price : null;
    const usd = p.usd != null ? p.usd : p.currency === 'USD' ? p.price : null;
    const profit = [];
    const final = [];
    if (brl != null) {
      profit.push('R$' + round2(brl * g));
      final.push('R$' + round2(brl * (1 + g)));
    }
    if (usd != null) {
      profit.push('US$' + round2(usd * g));
      final.push('US$' + round2(usd * (1 + g)));
    }
    if (!profit.length) {
      profit.push((sym[p.currency] || '') + round2(p.price * g));
      final.push((sym[p.currency] || '') + round2(p.price * (1 + g)));
    }
    out += ` · lucro +${pct}% = ${profit.join(' / ')} · final ${final.join(' / ')}`;
  }
  return out;
}

/** Arredonda para 2 casas decimais. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Reaplica o simulador de lucro em todos os badges de preco visiveis. */
function reRenderPrices() {
  document.querySelectorAll('[data-price-album]').forEach((el) => {
    if (el.dataset.link) updateAlbumPrice(el.dataset.link);
  });
  document.querySelectorAll('[data-price-for]').forEach((el) => {
    const u = el.getAttribute('data-price-for');
    if (u) updatePriceBadge(u);
  });
}

/** Envolve chamadas da API tratando o formato { ok, data, error }. */
async function call(promise, label) {
  showLoading(true, label);
  try {
    const res = await promise;
    if (!res || !res.ok) throw new Error((res && res.error) || 'Erro desconhecido');
    return res.data;
  } catch (err) {
    setStatus(`${label || 'Erro'}: ${err.message}`, true);
    throw err;
  } finally {
    showLoading(false);
  }
}

/**
 * Igual ao `call`, porém SEM a tela de carregamento — para tarefas que rodam
 * em segundo plano (ex.: fila de favoritos) e não devem travar a UI.
 */
async function callQuiet(promise, label) {
  const res = await promise;
  if (!res || !res.ok) {
    const msg = (res && res.error) || 'Erro desconhecido';
    setStatus(`${label || 'Erro'}: ${msg}`, true);
    throw new Error(msg);
  }
  return res.data;
}

/* ------------------------------- Navegacao -------------------------------- */
function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));

  if (view === 'favorites') renderFavorites();
  if (view === 'session') renderSession();
  if (view === 'categories') loadCategories();
  if (view === 'verify') renderVerify();
}

/* ------------------------------- Carregar loja ---------------------------- */
async function loadStore() {
  const input = $('#storeUrl').value.trim();
  if (!input) return setStatus('Informe a URL da loja.', true);
  const data = await call(api.validateStore(input), 'Loja invalida');
  state.store = data.store;
  $('#storeUrl').value = data.store;
  await refreshFavKeys();
  state.currentCategory = null;
  state.albumsPage = 1;
  switchView('albums');
  await loadAlbums(1);
}

async function refreshFavKeys() {
  try {
    const favs = await call(api.listFavorites(), 'Favoritos');
    state.favKeys = new Set(favs.map((f) => favKey(f.store, f.albumId)));
  } catch (_) {
    /* ignora */
  }
}

/* ------------------------------- Mega grade ------------------------------- */

/** Carrega (uma vez por loja) o conjunto de IDs de álbuns já vistos. */
async function ensureSeenLoaded() {
  if (state.seenStore === state.store) return;
  try {
    const rec = await callQuiet(api.getSeen(state.store), 'Vistos');
    state.seen = new Set(Object.keys((rec && rec.ids) || {}));
    state.seenAll = !!(rec && rec.storeSeen);
  } catch (_) {
    state.seen = new Set();
    state.seenAll = false;
  }
  state.seenStore = state.store;
}

/** Registra em segundo plano os álbuns exibidos como "já vistos". */
function recordSeen(albums) {
  const ids = (albums || []).map((a) => String(a.id)).filter(Boolean);
  if (!ids.length) return;
  const hasNew = ids.some((id) => !state.seen.has(id));
  ids.forEach((id) => state.seen.add(id)); // atualiza sessão para próximas páginas
  if (!hasNew) return;
  callQuiet(api.markSeen(state.store, ids), 'Marcar vistos').catch(() => {});
}

async function loadAlbums(page) {
  if (!state.store) return setStatus('Carregue uma loja primeiro.', true);
  const data = await call(api.listAlbums(state.store, page), 'Albuns');
  state.currentAlbums = data.albums;
  state.albumsPage = data.page;
  state.albumsTotalPages = data.totalPages;
  state.currentCategory = null;
  await ensureSeenLoaded();
  updateCrumbs();
  renderGrid(data.albums, '#albumGrid');
  recordSeen(data.albums);
  renderPager();
  maybeCheckLinks();
}

async function loadCategoryAlbums(catId, catName, page) {
  const data = await call(api.categoryAlbums(state.store, catId, page), 'Categoria');
  state.currentAlbums = data.albums;
  state.albumsPage = data.page;
  state.albumsTotalPages = data.totalPages;
  state.currentCategory = data.category || { id: catId, name: catName };
  switchView('albums');
  await ensureSeenLoaded();
  updateCrumbs();
  renderGrid(data.albums, '#albumGrid');
  recordSeen(data.albums);
  renderPager();
  maybeCheckLinks();
}

function updateCrumbs() {
  const c = $('#crumbs');
  if (!state.store) {
    c.textContent = 'Nenhuma loja carregada';
    return;
  }
  const host = state.store.replace(/^https?:\/\//, '');
  if (state.currentCategory) {
    c.innerHTML = `Loja: <b>${esc(host)}</b> &nbsp;/&nbsp; Categoria: <b>${esc(
      state.currentCategory.name || state.currentCategory.id
    )}</b>`;
  } else {
    c.innerHTML = `Loja: <b>${esc(host)}</b> &nbsp;/&nbsp; Todos os álbuns`;
  }
}

function albumCardHtml(a) {
  const isFav = state.favKeys.has(favKey(state.store, a.id));
  const cat = a.category ? `<div class="cat-tag">${esc(a.category.name)}</div>` : '';
  const cover = a.cover
    ? `<img loading="lazy" src="${esc(cimg(a.cover))}" alt="" />`
    : '';
  const seen = state.seenAll || (state.seen && state.seen.has(String(a.id)));
  const seenBadge = seen
    ? '<div class="seen-badge seen">✓ visto</div>'
    : '<div class="seen-badge new">novo</div>';
  return `
    <div class="card${seen ? '' : ' is-new'}" data-id="${esc(a.id)}">
      <div class="cover">
        ${cover}
        ${seenBadge}
        <div class="badge unknown" data-badge="${esc(a.id)}">? link</div>
        <div class="price-badge pending" data-price-album="${esc(a.id)}"></div>
        ${isFav ? '<div class="fav-star">★</div>' : ''}
      </div>
      <div class="meta">
        <div class="title" title="${esc(a.title)}">${esc(a.title || 'Sem título')}</div>
        <div class="count">${esc(a.photoCount || '')}</div>
        ${cat}
        <div class="actions">
          <button class="btn small primary" data-open="${esc(a.id)}">Abrir</button>
          <button class="btn small" data-fav="${esc(a.id)}">${isFav ? '★' : '☆'}</button>
          <input class="profit-inp hidden" type="number" min="0" step="1"
            placeholder="% deste" data-profit-input="${esc(a.id)}"
            title="Lucro só deste produto (prioridade sobre o global)" />
        </div>
      </div>
    </div>`;
}

function renderGrid(albums, target) {
  const grid = $(target);
  if (!albums || !albums.length) {
    grid.innerHTML = '<div class="empty">Nenhum álbum encontrado.</div>';
    return;
  }
  grid.innerHTML = albums.map(albumCardHtml).join('');
  trackImageProgress(grid);
  // Arquiva no disco TODAS as capas desta página (não só as visíveis por causa
  // do loading="lazy"), para tudo que foi visitado ficar salvo de uma vez e não
  // precisar rebaixar na próxima visita.
  const covers = [...new Set(albums.map((a) => a.cover).filter(Boolean))];
  if (covers.length) {
    Promise.resolve(api.prefetchImages(covers)).catch(() => {});
  }
}

function renderPager() {
  const pager = $('#albumPager');
  const { albumsPage: p, albumsTotalPages: total } = state;
  if (total <= 1) {
    pager.innerHTML = '';
    return;
  }
  const go = (n) => (state.currentCategory
    ? `data-cat-page="${n}"`
    : `data-page="${n}"`);
  pager.innerHTML = `
    <button class="btn small" ${p <= 1 ? 'disabled' : ''} ${go(p - 1)}>‹ Anterior</button>
    <span>Página <b>${p}</b> de ${total}</span>
    <button class="btn small" ${p >= total ? 'disabled' : ''} ${go(p + 1)}>Próxima ›</button>
    <span class="pager-goto">
      Ir para
      <input id="gotoPage" type="number" min="1" max="${total}" value="${p}" class="goto-input" />
      <button class="btn small" data-goto>Ir</button>
    </span>`;
}

/** Vai para a página digitada no campo, respeitando o intervalo válido. */
function goToPage() {
  const inp = $('#gotoPage');
  if (!inp) return;
  let n = parseInt(inp.value, 10);
  const total = state.albumsTotalPages;
  if (!Number.isFinite(n)) return;
  n = Math.min(Math.max(1, n), total);
  if (n === state.albumsPage) return;
  if (state.currentCategory) {
    loadCategoryAlbums(state.currentCategory.id, state.currentCategory.name, n);
  } else {
    loadAlbums(n);
  }
}

/* -------------------- Verificacao de links + precos (badges) -------------- */
async function maybeCheckLinks() {
  if (!$('#checkLinksToggle').checked) return;
  const ids = state.currentAlbums.map((a) => a.id);
  if (!ids.length) return;
  setStatus('Verificando links dos álbuns...');
  let map;
  beginCancelable();
  try {
    map = await call(api.checkLinks(state.store, ids, 5), 'Verificar links');
  } catch (_) {
    endCancelable();
    return; /* status ja setado */
  }
  endCancelable();

  // Detecta precos escritos no NOME dos albuns (fallback quando nao ha link).
  try {
    const tp = await call(
      api.pricesFromTitles(
        state.currentAlbums.map((a) => ({ id: a.id, title: a.title, url: a.url }))
      ),
      'Preços pelo nome'
    );
    state.titlePrices = tp || {};
  } catch (_) {
    state.titlePrices = {};
  }

  const priceLinks = [];
  // Carrega do disco (cache que nao expira p/ exibicao) os precos ja obtidos,
  // para mostrar na hora sem rebuscar.
  const allLinks = Object.keys(map)
    .map((id) => (map[id].externalLinks || [])[0])
    .filter(Boolean);
  if (allLinks.length) {
    try {
      const stored = await callQuiet(api.getCachedPrices([...new Set(allLinks)]), 'Cache preços');
      Object.assign(state.prices, stored || {});
    } catch (_) {
      /* segue sem cache */
    }
  }
  for (const id of Object.keys(map)) {
    const info = map[id];
    const badge = document.querySelector(`[data-badge="${CSS.escape(id)}"]`);
    if (badge) {
      if (info.hasLink === true) {
        badge.className = 'badge has';
        badge.textContent = '✓ tem link';
      } else if (info.hasLink === false) {
        badge.className = 'badge none';
        badge.textContent = '— sem link';
      } else {
        badge.className = 'badge unknown';
        badge.textContent = '? erro';
      }
    }
    // Preco: usa o primeiro link externo do album (se houver).
    const link = (info.externalLinks || [])[0];
    const tp = state.titlePrices[id];
    const priceEl = document.querySelector(`[data-price-album="${CSS.escape(id)}"]`);
    if (priceEl) {
      if (link) {
        priceEl.dataset.link = link;
        // Se ja temos armazenado (ok ou falha), mostra na hora e NAO rebusca.
        const cached = state.prices[link];
        if (cached) {
          updateAlbumPrice(link);
        } else {
          priceEl.className = 'price-badge loading';
          priceEl.textContent = '…';
          priceLinks.push(link);
        }
      } else if (tp) {
        // Sem link de loja: usa o preco detectado no nome do album.
        state.prices[tp.url] = tp;
        priceEl.dataset.link = tp.url;
        updateAlbumPrice(tp.url);
      } else {
        priceEl.className = 'price-badge pending';
        priceEl.textContent = '';
      }
    }
  }
  setStatus('Links verificados.');

  const unique = [...new Set(priceLinks)];
  if (!unique.length) return;
  setStatus(`Buscando preços de ${unique.length} item(ns)…`);
  beginCancelable();
  try {
    await call(api.fetchPrices(unique), 'Buscar preços');
    setStatus('Preços atualizados.');
  } catch (e) {
    setStatus('Erro ao buscar preços: ' + e.message, true);
  } finally {
    endCancelable();
  }
}

/** Mostra um preco "ok" no badge e revela o campo de lucro do produto. */
function showOkBadge(el, p, url, fromName) {
  el.className = 'price-badge ok';
  el.textContent = fmtPrice(p);
  el.title = fromName ? 'Preço obtido pelo nome do álbum' : '';
  const card = el.closest('.card');
  const inp = card && card.querySelector('[data-profit-input]');
  if (inp) {
    inp.dataset.profitUrl = url;
    inp.classList.remove('hidden');
    if (document.activeElement !== inp) {
      const v = state.profitByUrl[url];
      inp.value = v != null ? v : '';
    }
  }
}

/** Atualiza o badge de preco dos cards da grade cujo link == url. */
function updateAlbumPrice(url) {
  const p = state.prices[url];
  if (!p) return;
  document.querySelectorAll('[data-price-album]').forEach((el) => {
    if (el.dataset.link !== url) return;
    if (p.ok && p.price != null) {
      showOkBadge(el, p, url, p.source === 'title');
    } else {
      // Fallback: usa o preco detectado no NOME do album, se houver.
      const id = el.dataset.priceAlbum;
      const tp = id ? state.titlePrices[id] : null;
      if (tp) {
        state.prices[tp.url] = tp;
        el.dataset.link = tp.url;
        showOkBadge(el, tp, tp.url, true);
        return;
      }
      el.className = 'price-badge fail';
      el.textContent = '—';
      el.title = p.error || 'Não encontrado';
    }
  });
}

/* ------------------------------ Categorias -------------------------------- */
async function loadCategories() {
  if (!state.store) {
    $('#categoryList').innerHTML = '<div class="empty">Carregue uma loja primeiro.</div>';
    return;
  }
  const data = await call(api.listCategories(state.store), 'Categorias');
  const list = $('#categoryList');
  if (!data.categories.length) {
    list.innerHTML = '<div class="empty">Nenhuma categoria encontrada.</div>';
    return;
  }
  list.innerHTML = data.categories
    .map(
      (c) => `
      <div class="cat-item" data-cat="${esc(c.id)}" data-name="${esc(c.name)}">
        <span class="name">${esc(c.name || 'Categoria ' + c.id)}</span>
        <span class="btn small">Ver álbuns ›</span>
      </div>`
    )
    .join('');
}

/* --------------------------- Modal do album ------------------------------- */
async function openAlbum(id) {
  const meta = state.currentAlbums.find((a) => String(a.id) === String(id)) || {};
  let detail;
  try {
    detail = await call(api.getAlbum(state.store, id), 'Abrindo álbum');
  } catch (err) {
    // Rede falhou: se for um favorito, usa as fotos JA SALVAS.
    const f = (state.favList || []).find(
      (x) => x.store === state.store && String(x.albumId) === String(id)
    );
    if (f && Array.isArray(f.photos) && f.photos.length) {
      return openFavorite(state.store, id);
    }
    throw err;
  }
  // preserva a categoria de navegacao (origem do arquivamento)
  detail.category = meta.category || state.currentCategory || null;
  detail.cover = meta.cover || (detail.photos[0] && detail.photos[0].thumb) || null;
  state.currentAlbumDetail = detail;
  renderModal(detail);
  $('#modal').classList.remove('hidden');
}

/**
 * Abre um favorito usando os dados JA SALVOS (fotos, links) sem rebuscar da
 * rede. Assim as fotos aparecem mesmo se a loja estiver bloqueada/fora do ar.
 * Só busca da rede se o favorito não tiver fotos armazenadas.
 */
async function openFavorite(store, albumId) {
  state.store = store;
  const f = (state.favList || []).find(
    (x) => x.store === store && String(x.albumId) === String(albumId)
  );
  if (!f || !Array.isArray(f.photos) || !f.photos.length) {
    // Sem fotos salvas: tenta buscar da rede como fallback.
    return openAlbum(albumId);
  }
  const detail = {
    id: f.albumId,
    store: f.store,
    title: f.title || 'Sem título',
    url: f.url,
    cover: f.cover || (f.photos[0] && f.photos[0].thumb) || null,
    photoCount: f.photoCount != null ? f.photoCount : f.photos.length,
    photos: f.photos,
    externalLinks: f.externalLinks || [],
    rawLinks: f.rawLinks || [],
    category: f.category || null,
  };
  state.currentAlbumDetail = detail;
  renderModal(detail);
  $('#modal').classList.remove('hidden');
}

function renderModal(a) {
  const isFav = state.favKeys.has(favKey(state.store, a.id));
  const links = (a.externalLinks || []).length
    ? `<div class="links-box">
         <h4>Link(s) fonte (${a.externalLinks.length})</h4>
         <ul class="link-list">
           ${a.externalLinks
             .map(
               (l) =>
                 `<li><a href="#" data-ext="${esc(l)}">${esc(l)}</a>
                   <button class="btn small" data-copy="${esc(l)}">Copiar</button></li>`
             )
             .join('')}
         </ul>
       </div>`
    : '<div class="links-box"><h4>Nenhum link fonte encontrado neste álbum.</h4></div>';

  const catLine = a.category
    ? `Categoria: <b>${esc(a.category.name || a.category.id)}</b> · `
    : '';

  $('#modalContent').innerHTML = `
    <h2>${esc(a.title || 'Álbum ' + a.id)}</h2>
    <div class="sub">${catLine}${a.photoCount} fotos ·
      <a href="#" data-ext="${esc(a.url)}">${esc(a.url)}</a></div>
    ${links}
    <div class="modal-actions">
      <button class="btn ${isFav ? '' : 'success'}" id="modalFav">
        ${isFav ? '★ Remover dos favoritos' : '☆ Favoritar (arquivar)'}
      </button>
      <button class="btn primary" id="modalDownload">Salvar fotos...</button>
      <span id="dlProgress" class="status"></span>
    </div>
    <div class="photo-grid">
      ${a.photos
        .map(
          (p) =>
            `<img loading="lazy" src="${esc(cimg(p.thumb))}" data-ext="${esc(
              p.origin
            )}" title="Abrir original" />`
        )
        .join('')}
    </div>`;
}

async function toggleFavoriteFromModal() {
  const a = state.currentAlbumDetail;
  if (!a) return;
  const key = favKey(state.store, a.id);
  if (state.favKeys.has(key)) {
    // Remoção é rápida: aplica de imediato (UI otimista) e persiste em silêncio.
    state.favKeys.delete(key);
    setStatus('Removido dos favoritos.');
    renderModal(a);
    refreshGridStars();
    callQuiet(api.removeFavorite(state.store, a.id), 'Remover favorito').catch(() => {});
    return;
  }
  // O modal já tem o detalhe completo (fotos/links). Marca a estrela na hora
  // e grava em segundo plano, sem tela de carregamento.
  state.favKeys.add(key);
  setStatus('Álbum arquivado nos favoritos.');
  renderModal(a);
  refreshGridStars();
  callQuiet(
    api.addFavorite({
      store: state.store,
      albumId: a.id,
      title: a.title,
      url: a.url,
      cover: a.cover,
      photoCount: a.photoCount,
      category: a.category, // <- guarda a categoria de origem
      externalLinks: a.externalLinks,
      rawLinks: a.rawLinks,
      photos: a.photos,
    }),
    'Favoritar'
  ).catch(() => {
    // Falhou: desfaz a estrela.
    state.favKeys.delete(key);
    renderModal(a);
    refreshGridStars();
  });
}

async function quickFavorite(id) {
  const key = favKey(state.store, id);
  if (state.favKeys.has(key)) {
    // Remoção imediata (rápida), persistida em segundo plano.
    state.favKeys.delete(key);
    refreshGridStars();
    setStatus('Removido dos favoritos.');
    callQuiet(api.removeFavorite(state.store, id), 'Remover favorito').catch(() => {});
    return;
  }
  // UI otimista: marca a estrela já e enfileira o trabalho pesado (buscar
  // detalhe + fotos + links) para rodar em segundo plano, sem travar a tela.
  state.favKeys.add(key);
  refreshGridStars();
  enqueueFavorite(id);
}

/** Adiciona um álbum à fila de arquivamento em segundo plano. */
function enqueueFavorite(id) {
  const meta = state.currentAlbums.find((a) => String(a.id) === String(id)) || {};
  state.favQueue.push({
    store: state.store,
    id,
    meta,
    category: meta.category || state.currentCategory || null,
  });
  updateQueueStatus();
  processFavQueue();
}

/** Processa a fila de favoritos, um por vez, sem tela de carregamento. */
async function processFavQueue() {
  if (state.favQueueBusy) return;
  state.favQueueBusy = true;
  while (state.favQueue.length) {
    const task = state.favQueue.shift();
    updateQueueStatus();
    try {
      const detail = await callQuiet(api.getAlbum(task.store, task.id), 'Arquivar álbum');
      detail.category = task.category;
      detail.cover = task.meta.cover || (detail.photos[0] && detail.photos[0].thumb) || null;
      await callQuiet(
        api.addFavorite({
          store: task.store,
          albumId: detail.id,
          title: detail.title,
          url: detail.url,
          cover: detail.cover,
          photoCount: detail.photoCount,
          category: detail.category,
          externalLinks: detail.externalLinks,
          rawLinks: detail.rawLinks,
          photos: detail.photos,
        }),
        'Favoritar'
      );
    } catch (_) {
      // Falhou: desfaz a estrela desse álbum.
      state.favKeys.delete(favKey(task.store, task.id));
      refreshGridStars();
    }
  }
  state.favQueueBusy = false;
  updateQueueStatus();
}

/** Mostra o andamento da fila de favoritos na barra de status. */
function updateQueueStatus() {
  const n = state.favQueue.length + (state.favQueueBusy ? 1 : 0);
  if (n > 0) setStatus(`Arquivando favoritos em segundo plano… (${n} na fila)`);
  else setStatus('Favoritos atualizados.');
}

function refreshGridStars() {
  $$('.card').forEach((card) => {
    const id = card.dataset.id;
    const isFav = state.favKeys.has(favKey(state.store, id));
    let star = card.querySelector('.fav-star');
    if (isFav && !star) {
      star = document.createElement('div');
      star.className = 'fav-star';
      star.textContent = '★';
      card.querySelector('.cover').appendChild(star);
    } else if (!isFav && star) {
      star.remove();
    }
    const favBtn = card.querySelector('[data-fav]');
    if (favBtn) favBtn.textContent = isFav ? '★' : '☆';
  });
}

async function downloadCurrentAlbum() {
  const a = state.currentAlbumDetail;
  if (!a) return;
  const folderRes = await call(api.chooseFolder(), 'Escolher pasta');
  if (folderRes.canceled) return;
  state.chosenFolder = folderRes.folder;
  const prog = $('#dlProgress');
  prog.textContent = 'Iniciando download...';
  const off = api.onDownloadProgress((p) => {
    if (String(p.albumId) === String(a.id)) {
      prog.textContent = `Baixando ${p.done}/${p.total}`;
    }
  });
  try {
    const res = await call(api.downloadAlbum(a, state.chosenFolder), 'Download');
    prog.textContent = `Concluído: ${res.saved}/${res.total} salvas em "${res.folder}"`;
  } finally {
    off();
  }
}

/* ------------------------------ Favoritos --------------------------------- */
async function renderFavorites() {
  const [favs, tags] = await Promise.all([
    call(api.listFavorites(), 'Favoritos'),
    call(api.listTags(), 'Tags').catch(() => []),
  ]);
  state.favKeys = new Set(favs.map((f) => favKey(f.store, f.albumId)));
  state.favList = favs;
  state.tags = tags || [];
  // Carrega os "já vistos" de cada loja presente nos favoritos.
  await loadFavSeen(favs);
  // Remove do filtro tags que nao existem mais.
  const tagNames = new Set(state.tags.map((t) => t.name));
  state.tagFilter.forEach((t) => {
    if (!tagNames.has(t)) state.tagFilter.delete(t);
  });
  renderTagBar();
  renderFavGrid();
}

/** Monta o conjunto de chaves "store::id" já vistas para a lista de favoritos. */
async function loadFavSeen(favs) {
  const stores = [...new Set((favs || []).map((f) => f.store).filter(Boolean))];
  const favSeen = new Set();
  const seenStores = new Set(); // lojas marcadas como "Visto" por inteiro
  await Promise.all(
    stores.map(async (store) => {
      try {
        const rec = await callQuiet(api.getSeen(store), 'Vistos');
        if (rec && rec.storeSeen) seenStores.add(store);
        Object.keys((rec && rec.ids) || {}).forEach((id) => favSeen.add(favKey(store, id)));
      } catch (_) {
        /* ignora essa loja */
      }
    })
  );
  // Lojas marcadas como "Visto": todos os favoritos delas contam como vistos.
  (favs || []).forEach((f) => {
    if (f.store && seenStores.has(f.store)) favSeen.add(favKey(f.store, f.albumId));
  });
  state.favSeen = favSeen;
}

/** Barra de filtros: chips agrupados por Categoria e Marca. */
function renderTagBar() {
  const box = $('#tagFilters');
  if (!box) return;
  if (!state.tags.length) {
    box.innerHTML = '<span class="tag-empty">Nenhuma tag criada. Crie uma acima.</span>';
    return;
  }
  const group = (kind, label) => {
    const items = state.tags.filter((t) => t.kind === kind);
    if (!items.length) return '';
    const chips = items
      .map((t) => {
        const on = state.tagFilter.has(t.name) ? ' on' : '';
        return `<span class="tag-chip filter${on}" data-tag-filter="${esc(t.name)}">
          ${esc(t.name)}
          <button class="tag-del" data-tag-del="${esc(t.name)}" title="Excluir tag">✕</button>
        </span>`;
      })
      .join('');
    return `<div class="tag-group"><span class="tag-group-label">${label}:</span>${chips}</div>`;
  };
  let html = group('categoria', 'Categorias') + group('marca', 'Marcas');
  if (state.tagFilter.size) {
    html += `<button class="btn small" data-tag-clear>Limpar filtro</button>`;
  }
  box.innerHTML = html;
}

/** Monta o HTML de um card de favorito. */
function favCardHtml(f) {
  const host = f.store.replace(/^https?:\/\//, '');
  const cat = f.category ? `<div class="cat-tag">${esc(f.category.name)}</div>` : '';
  const nLinks = (f.externalLinks || []).length;
  const cover = f.cover ? `<img loading="lazy" src="${esc(cimg(f.cover))}" alt="" />` : '';
  const favTags = Array.isArray(f.tags) ? f.tags : [];
  const chips = favTags
    .map(
      (t) =>
        `<span class="tag-chip small" data-untag="${esc(t)}"
          data-untag-store="${esc(f.store)}" data-untag-id="${esc(f.albumId)}"
          title="Remover tag">${esc(t)} ✕</span>`
    )
    .join('');
  const options = state.tags
    .filter((t) => !favTags.includes(t.name))
    .map((t) => `<option value="${esc(t.name)}">${esc(t.name)} (${t.kind})</option>`)
    .join('');
  const addSel = state.tags.length
    ? `<select class="tag-add" data-tag-add-store="${esc(f.store)}" data-tag-add-id="${esc(
        f.albumId
      )}"><option value="">+ tag</option>${options}</select>`
    : '';
  const seen = state.favSeen && state.favSeen.has(favKey(f.store, f.albumId));
  const seenBadge = seen
    ? '<div class="seen-badge seen">✓ visto</div>'
    : '<div class="seen-badge new">novo</div>';
  return `
      <div class="card${seen ? '' : ' is-new'}" data-fav-store="${esc(f.store)}" data-fav-id="${esc(f.albumId)}">
        <div class="cover">
          ${cover}
          ${seenBadge}
          <label class="fav-select" title="Selecionar para atribuir tags">
            <input type="checkbox" class="fav-check" data-fav-check="${esc(
              favKey(f.store, f.albumId)
            )}" ${state.selectedFavs.has(favKey(f.store, f.albumId)) ? 'checked' : ''} />
          </label>
          <div class="badge ${nLinks ? 'has' : 'none'}">
            ${nLinks ? '✓ ' + nLinks + ' link' : '— sem link'}
          </div>
          <div class="price-badge pending" data-price-album="${esc(
            favKey(f.store, f.albumId)
          )}"></div>
          <div class="fav-star">★</div>
        </div>
        <div class="meta">
          <div class="title" title="${esc(f.title)}">${esc(f.title || 'Sem título')}</div>
          <div class="count">${esc(host)} · ${esc(f.photoCount || 0)} fotos</div>
          ${cat}
          <div class="fav-tags">${chips}${addSel}</div>
          <div class="actions">
            <button class="btn small primary" data-fav-open="${esc(f.albumId)}"
              data-fav-open-store="${esc(f.store)}">Abrir</button>
            <button class="btn small danger" data-fav-remove="${esc(f.albumId)}"
              data-fav-remove-store="${esc(f.store)}">Remover</button>
            <input class="profit-inp hidden" type="number" min="0" step="1"
              placeholder="% deste" data-profit-input="${esc(favKey(f.store, f.albumId))}"
              title="Lucro só deste produto (prioridade sobre o global)" />
          </div>
        </div>
      </div>`;
}

/** Atualiza o contador de produtos selecionados. */
function updateSelCount() {
  const el = $('#selCount');
  if (el) el.textContent = `${state.selectedFavs.size} selecionados`;
}

/** Renderiza a grade de favoritos aplicando o filtro de tags. */
async function renderFavGrid() {
  const grid = $('#favGrid');
  const favs = state.favList;
  if (!favs.length) {
    grid.innerHTML = '<div class="empty">Nenhum favorito arquivado ainda.</div>';
    return;
  }
  // Filtro: mostra favoritos que tenham QUALQUER uma das tags selecionadas.
  const sel = state.tagFilter;
  const visible = sel.size
    ? favs.filter((f) => Array.isArray(f.tags) && f.tags.some((t) => sel.has(t)))
    : favs;
  if (!visible.length) {
    grid.innerHTML = '<div class="empty">Nenhum favorito com as tags selecionadas.</div>';
    return;
  }
  grid.innerHTML = visible.map(favCardHtml).join('');
  trackImageProgress(grid);
  // Guarda os favoritos visiveis para "Selecionar visiveis" e atualiza o contador.
  state._visibleFavKeys = visible.map((f) => favKey(f.store, f.albumId));
  updateSelCount();
  // Preços pelo NOME do álbum (fallback quando não há link de loja).
  // Só calcula os que ainda NÃO estão no cache em memória — evita refazer o
  // trabalho dos 2k+ favoritos toda vez que a aba é aberta. Roda sem travar a tela.
  if (!state.titlePrices) state.titlePrices = {};
  const needTitles = visible.filter((f) => !(favKey(f.store, f.albumId) in state.titlePrices));
  if (needTitles.length) {
    try {
      const tp = await callQuiet(
        api.pricesFromTitles(
          needTitles.map((f) => ({ id: favKey(f.store, f.albumId), title: f.title, url: f.url }))
        ),
        'Preços pelo nome'
      );
      Object.assign(state.titlePrices, tp || {});
    } catch (_) {
      /* segue sem preços por nome */
    }
  }

  // Preços automáticos nos favoritos (usa o primeiro link de cada favorito).
  const favLinks = [];
  // Carrega do disco os precos ja obtidos, para exibir na hora sem rebuscar.
  const allFavLinks = visible.map((f) => (f.externalLinks || [])[0]).filter(Boolean);
  let storedCount = 0;
  if (allFavLinks.length) {
    try {
      const stored = await callQuiet(
        api.getCachedPrices([...new Set(allFavLinks)]),
        'Cache preços'
      );
      Object.assign(state.prices, stored || {});
      storedCount = Object.keys(stored || {}).length;
    } catch (_) {
      /* segue sem cache */
    }
  }
  // Conta quantas imagens usam o cache local (ycimg://).
  const imgs = $('#favGrid').querySelectorAll('img[src^="ycimg://"]');
  const relatorio =
    `[favoritos] ${visible.length} favoritos | ${allFavLinks.length} com link | ` +
    `${storedCount} preços vindos do disco (cache) | ${imgs.length} imagens via cache local`;
  console.log(relatorio);
  api.log(relatorio); // também aparece no terminal do Electron

  // Relatório visível no app (barra fixa no topo dos Favoritos).
  state._favReport = {
    favs: visible.length,
    withLink: allFavLinks.length,
    pricesCache: storedCount,
    toFetch: 0,
    covers: null,
  };
  renderFavReport();

  // Pré-cache em segundo plano de TODAS as capas dos favoritos (não só as que
  // aparecem na tela), para tudo ficar arquivado sem precisar rolar a lista.
  // Chamado a cada render (é idempotente: o main só baixa o que falta e mostra
  // o relatório de quantas capas já estão no cache local, visível no app).
  const allCovers = [...new Set(favs.map((f) => f.cover).filter(Boolean))];
  if (allCovers.length) {
    Promise.resolve(api.prefetchImages(allCovers))
      .then((r) => {
        if (!r || !state._favReport) return;
        state._favReport.covers = { cached: r.cached, total: r.total, missing: r.missing };
        renderFavReport();
        api.log(`[cache] capas ${r.cached}/${r.total} no cache local (faltando ${r.missing})`);
      })
      .catch(() => {});
  }
  visible.forEach((f) => {
    const key = favKey(f.store, f.albumId);
    const link = (f.externalLinks || [])[0];
    const el = document.querySelector(`[data-price-album="${CSS.escape(key)}"]`);
    if (!el) return;
    if (link) {
      el.dataset.link = link;
      const cached = state.prices[link];
      if (cached) {
        updateAlbumPrice(link);
      } else {
        el.className = 'price-badge loading';
        el.textContent = '…';
        favLinks.push(link);
      }
    } else if (state.titlePrices[key]) {
      // Sem link: usa o preço detectado no nome do álbum.
      const tp = state.titlePrices[key];
      state.prices[tp.url] = tp;
      el.dataset.link = tp.url;
      updateAlbumPrice(tp.url);
    }
  });
  const unique = [...new Set(favLinks)];
  if (!unique.length) return;
  if (state._favReport) {
    state._favReport.toFetch = unique.length;
    renderFavReport();
  }
  console.log(`[favoritos] buscando preços de ${unique.length} link(s) ainda sem cache…`);
  api.log(`[favoritos] buscando preços de ${unique.length} link(s) ainda sem cache…`);
  setStatus(`Buscando preços de ${unique.length} item(ns)…`);
  beginCancelable();
  try {
    await call(api.fetchPrices(unique), 'Buscar preços');
    setStatus('Preços atualizados.');
  } catch (e) {
    setStatus('Erro ao buscar preços: ' + e.message, true);
  } finally {
    endCancelable();
    if (state._favReport) {
      state._favReport.toFetch = 0;
      state._favReport.pricesCache = (state._favReport.pricesCache || 0) + unique.length;
      renderFavReport();
    }
  }
}

/* ------------------ Links de compra por site (permanente) ----------------- */
async function renderSession() {
  const sites = await call(api.sessionLinks(), 'Links de compra');
  const ul = $('#sessionList');
  if (!sites.length) {
    ul.innerHTML =
      '<div class="empty">Nenhum site com link de compra salvo ainda. ' +
      'Carregue uma loja e ative "Verificar links da página" ou abra álbuns.</div>';
    return;
  }
  ul.innerHTML = sites
    .map((s) => {
      const host = s.store.replace(/^https?:\/\//, '');
      const links = (s.links || [])
        .map(
          (l) =>
            `<li><a href="#" data-ext="${esc(l)}">${esc(l)}</a>
              ${priceBadge(l)}
              <input class="profit-inp" type="number" min="0" step="1"
                placeholder="% deste" data-profit-url="${esc(l)}"
                value="${state.profitByUrl[l] != null ? esc(state.profitByUrl[l]) : ''}"
                title="Lucro só deste link (prioridade sobre o global)" />
              <button class="btn small" data-copy="${esc(l)}">Copiar</button></li>`
        )
        .join('');
      return `
      <li class="store-block">
        <div class="store-head">
          <button class="store-toggle" data-store-toggle title="Recolher/expandir">▾</button>
          <a href="#" data-open-store="${esc(s.store)}" class="store-url">${esc(host)}</a>
          <span class="store-count">${(s.links || []).length} link(s)</span>
          <button class="btn small" data-copy="${esc(
            (s.links || []).join('\n')
          )}">Copiar todos</button>
          <button class="btn small danger" data-store-remove="${esc(
            s.store
          )}">Remover</button>
        </div>
        <ul class="link-list">${links}</ul>
      </li>`;
    })
    .join('');
}

/** Formata o preco em cache de um link como um badge HTML. */
function priceBadge(url) {
  const p = state.prices[url];
  if (!p) return '<span class="price-badge pending" data-price-for="' + esc(url) + '"></span>';
  if (p.loading) {
    return `<span class="price-badge loading" data-price-for="${esc(url)}">…</span>`;
  }
  if (p.ok && p.price != null) {
    return `<span class="price-badge ok" data-price-for="${esc(url)}">${esc(
      fmtPrice(p)
    )}</span>`;
  }
  return `<span class="price-badge fail" data-price-for="${esc(url)}" title="${esc(
    p.error || 'Não encontrado'
  )}">—</span>`;
}

/** Atualiza apenas o badge de um link (sem re-renderizar tudo). */
function updatePriceBadge(url) {
  const el = document.querySelector(`[data-price-for="${cssEscape(url)}"]`);
  if (!el) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = priceBadge(url);
  el.replaceWith(tmp.firstElementChild);
}

/** Escapa uma string para uso seguro em querySelector. */
function cssEscape(s) {
  if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
  return String(s).replace(/["\\\]]/g, '\\$&');
}

/** Coleta todos os links de compra e busca os precos. */
async function fetchAllPrices() {
  const sites = await call(api.sessionLinks(), 'Links de compra');
  const urls = [];
  sites.forEach((s) => (s.links || []).forEach((l) => urls.push(l)));
  const unique = [...new Set(urls)];
  if (!unique.length) {
    setStatus('Nenhum link de compra para buscar.');
    return;
  }
  unique.forEach((u) => {
    state.prices[u] = { loading: true };
    updatePriceBadge(u);
  });
  const btn = $('#fetchPrices');
  if (btn) btn.disabled = true;
  setStatus(`Buscando preços de ${unique.length} link(s)…`);
  beginCancelable();
  try {
    await call(api.fetchPrices(unique), 'Buscar preços');
    const okCount = unique.filter((u) => state.prices[u] && state.prices[u].ok).length;
    setStatus(`Preços concluídos: ${okCount}/${unique.length} encontrados.`);
  } catch (err) {
    setStatus('Erro ao buscar preços: ' + err.message, true);
  } finally {
    if (btn) btn.disabled = false;
    endCancelable();
  }
}


/* -------------------- Verificar precos em varias lojas -------------------- */

/** Renderiza a aba: resultados da ultima verificacao + lojas salvas com preco. */
async function renderVerify() {
  renderVerifyResults();
  await renderPricedStores();
}

/** Desenha os resultados em memoria da verificacao atual. */
function renderVerifyResults() {
  const box = $('#verifyResults');
  if (!box) return;
  const rows = state.verify.results;
  if (!rows.length) {
    box.innerHTML = state.verify.running
      ? '<div class="empty">Verificando…</div>'
      : '<div class="empty">Cole lojas acima e clique em “Verificar”.</div>';
    return;
  }
  box.innerHTML = rows
    .map((r) => {
      const host = r.store.replace(/^https?:\/\//, '');
      let cls = 'verify-row';
      let info;
      if (r.pending) {
        cls += ' pending';
        info = '<span class="vr-status">na fila…</span>';
      } else if (r.running) {
        cls += ' running';
        info = '<span class="vr-status">verificando…</span>';
      } else if (r.error) {
        cls += ' fail';
        info = `<span class="vr-status" title="${esc(r.error)}">${esc(r.error)}</span>`;
      } else if (r.priced > 0) {
        cls += ' ok';
        info = `<span class="vr-status">✓ tem links (${r.priced})</span>`;
      } else {
        cls += ' none';
        info = `<span class="vr-status">sem links (${r.albums} álbuns vistos)</span>`;
      }
      return `<div class="${cls}">
        <a href="#" data-open-store="${esc(r.store)}" class="store-url">${esc(host)}</a>
        ${info}
      </div>`;
    })
    .join('');
}

/** Lista as lojas salvas (persistente) que possuem preco. */
async function renderPricedStores() {
  const ul = $('#pricedList');
  if (!ul) return;
  let list;
  try {
    list = await call(api.listPricedStores(), 'Lojas com links');
  } catch (_) {
    return;
  }
  if (!list.length) {
    ul.innerHTML = '<div class="empty">Nenhuma loja com links salva ainda.</div>';
    return;
  }
  ul.innerHTML = list
    .map((s) => {
      const host = s.store.replace(/^https?:\/\//, '');
      return `<li class="store-block">
        <div class="store-head">
          <a href="#" data-open-store="${esc(s.store)}" class="store-url">${esc(host)}</a>
          <span class="store-count">✓ ${s.priced} link(s) de loja</span>
          <button class="btn small chk ${s.seen ? 'on' : ''}" data-priced-flag="seen"
            data-priced-store="${esc(s.store)}">${s.seen ? '✓ ' : ''}Visto</button>
          <button class="btn small chk ${s.reviewed ? 'on' : ''}" data-priced-flag="reviewed"
            data-priced-store="${esc(s.store)}">${s.reviewed ? '✓ ' : ''}Atualizado</button>
          <button class="btn small danger" data-priced-remove="${esc(s.store)}">Remover</button>
        </div>
      </li>`;
    })
    .join('');
}

/** Le o textarea, dispara a verificacao em massa e acompanha o progresso. */
async function runVerify() {
  const raw = $('#verifyInput').value || '';
  // Considera SOMENTE links Yupoo (*.yupoo.com). Ignora todo o resto
  // (taobao, weidian, vlink, youshop10, linktr.ee, sites diversos...).
  // Normaliza para a base da loja: https://sub.x.yupoo.com (sem caminho/query).
  const seen = new Set();
  const stores = [];
  raw
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((line) => {
      let s = line;
      if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
      let norm;
      try {
        const u = new URL(s);
        if (!/\.yupoo\.com$/i.test(u.hostname)) return; // ignora nao-yupoo
        norm = `${u.protocol}//${u.host}`;
      } catch (_) {
        return;
      }
      if (!seen.has(norm)) {
        seen.add(norm);
        stores.push(norm);
      }
    });
  if (!stores.length) {
    setStatus('Nenhum link Yupoo válido para verificar.', true);
    return;
  }
  state.verify.running = true;
  state.verify.results = stores.map((store) => ({
    store,
    pending: true,
    albums: 0,
    links: 0,
    priced: 0,
  }));
  renderVerifyResults();

  const btn = $('#verifyRun');
  if (btn) btn.disabled = true;
  setStatus(`Verificando ${stores.length} loja(s)…`);
  try {
    await call(api.bulkCheckStores(stores), 'Verificar lojas');
    const withLinks = state.verify.results.filter((r) => r.priced > 0).length;
    setStatus(`Verificação concluída: ${withLinks} loja(s) com links de loja.`);
  } catch (err) {
    setStatus('Erro ao verificar: ' + err.message, true);
  } finally {
    state.verify.running = false;
    if (btn) btn.disabled = false;
    renderVerifyResults();
    renderPricedStores();
  }
}


function bindEvents() {
  $('#loadStore').addEventListener('click', loadStore);
  $('#storeUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadStore();
  });

  // Enter no campo "Ir para" navega para a página digitada.
  document.body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.id === 'gotoPage') {
      e.preventDefault();
      goToPage();
    }
  });

  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view))
  );

  $('#checkLinksToggle').addEventListener('change', maybeCheckLinks);

  // Botao "Parar": cancela a busca de links/precos em andamento.
  const cancelBtn = $('#cancelLoading');
  if (cancelBtn)
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.classList.add('hidden');
      loadingOps = 0;
      setStatus('Cancelando…');
      try {
        await api.cancelLoading();
      } catch (_) {
        /* ignora */
      }
      // Reseta os badges que ficaram em estado "carregando".
      document.querySelectorAll('.price-badge.loading').forEach((el) => {
        el.className = 'price-badge pending';
        el.textContent = '';
      });
      Object.keys(state.prices).forEach((u) => {
        if (state.prices[u] && state.prices[u].loading) delete state.prices[u];
      });
      setStatus('Carregamento cancelado.');
    });

  const profitEl = $('#profitPct');
  if (profitEl)
    profitEl.addEventListener('input', () => {
      state.profitPct = Math.max(0, parseFloat(profitEl.value) || 0);
      reRenderPrices();
    });

  // Campo de lucro individual por produto (prioridade sobre o global).
  document.body.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.matches || !t.matches('[data-profit-url]')) return;
    const url = t.dataset.profitUrl;
    if (!url) return;
    const v = String(t.value).trim();
    if (v === '') delete state.profitByUrl[url];
    else state.profitByUrl[url] = Math.max(0, parseFloat(v) || 0);
    reRenderPrices();
    // Grava a margem no favorito/produto (persistente).
    const pct = v === '' ? null : state.profitByUrl[url];
    call(api.setProfit(url, pct), 'Salvar margem').catch(() => {});
  });

  $('#exportFav').addEventListener('click', async () => {
    const r = await call(api.exportFavorites(), 'Exportar');
    if (!r.canceled) setStatus('Favoritos exportados: ' + r.filePath);
  });

  // Criar nova tag (categoria|marca)
  const addTagBtn = $('#addTagBtn');
  if (addTagBtn) {
    const doAddTag = async () => {
      const nameEl = $('#newTagName');
      const kindEl = $('#newTagKind');
      const name = String(nameEl.value || '').trim();
      if (!name) return;
      const res = await call(api.addTag(name, kindEl.value), 'Criar tag');
      state.tags = res.tags || [];
      renderTagBar();
      renderFavGrid();
      if (res.added) {
        nameEl.value = '';
        setStatus(`Tag "${name}" criada.`);
      } else if (res.reason === 'duplicada') {
        setStatus(`A tag "${name}" já existe nesse tipo.`, true);
      }
    };
    addTagBtn.addEventListener('click', doAddTag);
    $('#newTagName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doAddTag();
    });
  }

  // Atribuir tag a um favorito pelo dropdown "+ tag"
  document.body.addEventListener('change', async (e) => {
    const sel = e.target;
    if (sel && sel.matches && sel.matches('.fav-check')) {
      const key = sel.dataset.favCheck;
      if (sel.checked) state.selectedFavs.add(key);
      else state.selectedFavs.delete(key);
      updateSelCount();
      return;
    }
    if (!sel || !sel.matches || !sel.matches('.tag-add')) return;
    const tag = sel.value;
    if (!tag) return;
    const store = sel.dataset.tagAddStore;
    const id = sel.dataset.tagAddId;
    const fav = state.favList.find((f) => f.store === store && String(f.albumId) === String(id));
    if (!fav) return;
    const tags = [...new Set([...(fav.tags || []), tag])];
    await call(api.setFavoriteTags(store, id, tags), 'Atribuir tag');
    fav.tags = tags;
    renderFavGrid();
  });

  // Selecionar todos os produtos visiveis / limpar selecao
  const selAllBtn = $('#selectAllFavs');
  if (selAllBtn)
    selAllBtn.addEventListener('click', () => {
      (state._visibleFavKeys || []).forEach((k) => state.selectedFavs.add(k));
      document.querySelectorAll('.fav-check').forEach((c) => (c.checked = true));
      updateSelCount();
    });
  const clearSelBtn = $('#clearSelFavs');
  if (clearSelBtn)
    clearSelBtn.addEventListener('click', () => {
      state.selectedFavs.clear();
      document.querySelectorAll('.fav-check').forEach((c) => (c.checked = false));
      updateSelCount();
    });

  // Atribuir as tags selecionadas (filtro) aos produtos marcados
  const assignBtn = $('#assignTagsBtn');
  if (assignBtn)
    assignBtn.addEventListener('click', async () => {
      const tags = [...state.tagFilter];
      if (!tags.length) {
        setStatus('Selecione ao menos uma tag no filtro acima.', true);
        return;
      }
      if (!state.selectedFavs.size) {
        setStatus('Marque ao menos um produto para atribuir as tags.', true);
        return;
      }
      const keys = new Set(state.selectedFavs);
      let n = 0;
      for (const f of state.favList) {
        const key = favKey(f.store, f.albumId);
        if (!keys.has(key)) continue;
        const merged = [...new Set([...(f.tags || []), ...tags])];
        await call(api.setFavoriteTags(f.store, f.albumId, merged), 'Atribuir tags');
        f.tags = merged;
        n++;
      }
      state.selectedFavs.clear();
      renderFavGrid();
      setStatus(`${tags.length} tag(s) atribuída(s) a ${n} produto(s).`);
    });

  $('#exportSession').addEventListener('click', async () => {
    const r = await call(api.exportSessionLinks(), 'Exportar');
    if (!r.canceled) setStatus('Links exportados: ' + r.filePath);
  });
  const fetchBtn = $('#fetchPrices');
  if (fetchBtn) fetchBtn.addEventListener('click', fetchAllPrices);

  const verifyBtn = $('#verifyRun');
  if (verifyBtn) verifyBtn.addEventListener('click', runVerify);
  const verifyClear = $('#verifyClear');
  if (verifyClear)
    verifyClear.addEventListener('click', () => {
      $('#verifyInput').value = '';
      state.verify.results = [];
      renderVerifyResults();
    });

  // Progresso da busca de precos: atualiza o cache e os badges (sessao + grade).
  api.onPriceProgress(({ done, total, item }) => {
    if (item && item.url) {
      state.prices[item.url] = item;
      updatePriceBadge(item.url);
      updateAlbumPrice(item.url);
    }
    progress.prices.done = done;
    progress.prices.total = total;
    renderProgress();
  });

  // Progresso do pré-cache de fotos (arquivamento em segundo plano). Só aparece
  // quando há imagens novas para baixar; some ao terminar.
  api.onCacheProgress(({ done, total, finished }) => {
    if (finished) {
      progress.photos.done = 0;
      progress.photos.total = 0;
      setCacheStatus(`Cache local de capas: completo ✓ (${done} nova(s) arquivada(s) agora)`);
      setStatus(`Fotos arquivadas: ${done} nova(s). Tudo no cache local.`);
    } else {
      progress.photos.done = done;
      progress.photos.total = total;
      setCacheStatus(`Arquivando capas no cache local: ${done}/${total}…`);
    }
    renderProgress();
  });
  api.onBulkProgress(({ done, total, entry }) => {
    if (entry && entry.store) {
      const idx = state.verify.results.findIndex(
        (r) => r.store === entry.store.replace(/\/+$/, '')
      );
      const row = { ...entry, pending: false, running: false };
      if (idx >= 0) state.verify.results[idx] = row;
      else state.verify.results.push(row);
      renderVerifyResults();
    }
    setStatus(`Verificando lojas… ${done}/${total}`);
  });

  // Delegacao de cliques no corpo principal
  document.body.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-open],[data-fav],[data-page],[data-cat-page],[data-goto],[data-cat],[data-ext],[data-copy],[data-fav-open],[data-fav-remove],[data-store-remove],[data-store-toggle],[data-open-store],[data-priced-remove],[data-priced-flag],[data-close],[data-tag-filter],[data-tag-del],[data-tag-clear],[data-untag]');
    if (!t) return;

    if (t.dataset.close !== undefined) {
      $('#modal').classList.add('hidden');
      return;
    }
    if (t.dataset.open) {
      e.preventDefault();
      openAlbum(t.dataset.open);
    } else if (t.dataset.fav) {
      e.preventDefault();
      quickFavorite(t.dataset.fav);
    } else if (t.dataset.page) {
      loadAlbums(parseInt(t.dataset.page, 10));
    } else if (t.dataset.catPage) {
      loadCategoryAlbums(
        state.currentCategory.id,
        state.currentCategory.name,
        parseInt(t.dataset.catPage, 10)
      );
    } else if (t.dataset.goto !== undefined) {
      // Ir para a página digitada (limitada ao intervalo válido).
      e.preventDefault();
      goToPage();
    } else if (t.dataset.cat) {
      loadCategoryAlbums(t.dataset.cat, t.dataset.name, 1);
    } else if (t.dataset.ext) {
      e.preventDefault();
      api.openExternal(t.dataset.ext);
    } else if (t.dataset.copy) {
      e.preventDefault();
      navigator.clipboard.writeText(t.dataset.copy);
      setStatus('Copiado.');
    } else if (t.dataset.favOpen) {
      e.preventDefault();
      $('#storeUrl').value = t.dataset.favOpenStore;
      switchView('albums');
      openFavorite(t.dataset.favOpenStore, t.dataset.favOpen);
    } else if (t.dataset.favRemove) {
      e.preventDefault();
      const store = t.dataset.favRemoveStore;
      const id = t.dataset.favRemove;
      const card = t.closest('.card');
      if (card) card.remove(); // remove da tela imediatamente (sem loading)
      state.favKeys.delete(favKey(store, id));
      if (Array.isArray(state.favList)) {
        state.favList = state.favList.filter(
          (f) => favKey(f.store, f.albumId) !== favKey(store, id)
        );
      }
      callQuiet(api.removeFavorite(store, id), 'Remover favorito').catch(() => {
        setStatus('Falha ao remover favorito.', true);
        renderFavorites(); // recarrega para restaurar em caso de erro
      });
    } else if (t.dataset.storeRemove) {
      e.preventDefault();
      await call(api.removeStoreLinks(t.dataset.storeRemove), 'Remover site');
      renderSession();
    } else if (t.dataset.pricedRemove) {
      e.preventDefault();
      await call(api.removePricedStore(t.dataset.pricedRemove), 'Remover loja');
      renderPricedStores();
    } else if (t.dataset.pricedFlag) {
      // Alterna manualmente "Visto"/"Atualizado" de uma loja com links.
      e.preventDefault();
      const store = t.dataset.pricedStore;
      const flag = t.dataset.pricedFlag;
      const value = !t.classList.contains('on');
      try {
        await callQuiet(api.setPricedFlag(store, flag, value), 'Marcar loja');
      } catch (_) {
        return;
      }
      renderPricedStores();
    } else if (t.dataset.tagFilter !== undefined) {
      // Alterna a tag no filtro de favoritos.
      e.preventDefault();
      const name = t.dataset.tagFilter;
      if (state.tagFilter.has(name)) state.tagFilter.delete(name);
      else state.tagFilter.add(name);
      renderTagBar();
      renderFavGrid();
    } else if (t.dataset.tagDel !== undefined) {
      // Exclui a tag do catalogo (e de todos os favoritos).
      e.preventDefault();
      const name = t.dataset.tagDel;
      state.tags = await call(api.removeTag(name), 'Excluir tag');
      state.tagFilter.delete(name);
      state.favList.forEach((f) => {
        if (Array.isArray(f.tags)) f.tags = f.tags.filter((x) => x !== name);
      });
      renderTagBar();
      renderFavGrid();
      setStatus(`Tag "${name}" excluída.`);
    } else if (t.dataset.tagClear !== undefined) {
      e.preventDefault();
      state.tagFilter.clear();
      renderTagBar();
      renderFavGrid();
    } else if (t.dataset.untag !== undefined) {
      // Remove uma tag de um favorito especifico.
      e.preventDefault();
      const store = t.dataset.untagStore;
      const id = t.dataset.untagId;
      const name = t.dataset.untag;
      const fav = state.favList.find(
        (f) => f.store === store && String(f.albumId) === String(id)
      );
      if (fav) {
        const tags = (fav.tags || []).filter((x) => x !== name);
        await call(api.setFavoriteTags(store, id, tags), 'Remover tag');
        fav.tags = tags;
        renderFavGrid();
      }
    } else if (t.dataset.storeToggle !== undefined) {
      e.preventDefault();
      const block = t.closest('.store-block');
      if (block) {
        const collapsed = block.classList.toggle('collapsed');
        t.textContent = collapsed ? '▸' : '▾';
      }
    } else if (t.dataset.openStore) {
      // Abre a loja Yupoo DENTRO do app (nao no navegador externo).
      e.preventDefault();
      state.store = t.dataset.openStore;
      $('#storeUrl').value = state.store;
      state.currentCategory = null;
      state.albumsPage = 1;
      switchView('albums');
      await refreshFavKeys();
      loadAlbums(1);
    }
  });

  // Botoes internos do modal (fav / download)
  $('#modalContent').addEventListener('click', (e) => {
    if (e.target.id === 'modalFav') toggleFavoriteFromModal();
    if (e.target.id === 'modalDownload') downloadCurrentAlbum();
  });

  // Motor de navegador (Puppeteer / Brave)
  $('#engineMode').addEventListener('change', applyEngine);
  $('#braveURL').addEventListener('change', applyEngine);
}

/* --------------------------- Motor de navegador --------------------------- */
async function applyEngine() {
  const mode = $('#engineMode').value;
  const browserURL = $('#braveURL').value.trim() || 'http://127.0.0.1:9222';
  // Mostra o campo de URL apenas no modo "conectar".
  $('#braveURL').classList.toggle('hidden', mode !== 'brave-connect');

  setStatus('Configurando motor...');
  try {
    const r = await call(api.configureEngine({ mode, browserURL }), 'Motor');
    if (!r) return;
    renderEngineStatus(r);
    const nomes = {
      http: 'HTTP',
      auto: 'Auto',
      chromium: 'Chromium',
      'brave-launch': 'Brave',
      'brave-connect': 'Brave (conectado)',
    };
    setStatus('Motor: ' + (nomes[r.mode] || r.mode));
  } catch (_) {
    /* erro ja exibido por call() */
  }
}
function renderEngineStatus(st) {
  if (!st) return;
  const el = $('#engineStatus');
  if (st.mode === 'brave-connect') {
    el.textContent = st.active ? '● conectado' : '○ aguardando Brave';
    el.className = 'engine-status ' + (st.active ? 'on' : 'off');
  } else if (st.mode === 'brave-launch') {
    el.textContent = st.bravePath ? '● Brave pronto' : '⚠ Brave não encontrado';
    el.className = 'engine-status ' + (st.bravePath ? 'on' : 'warn');
  } else {
    el.textContent = '';
    el.className = 'engine-status';
  }
}

bindEvents();
refreshFavKeys();
// Carrega as margens de lucro salvas por produto.
call(api.listProfits(), 'Margens')
  .then((m) => {
    if (m && typeof m === 'object') state.profitByUrl = { ...m, ...state.profitByUrl };
    reRenderPrices();
  })
  .catch(() => {});
// Aplica o motor padrao (auto) ao iniciar.
applyEngine();
