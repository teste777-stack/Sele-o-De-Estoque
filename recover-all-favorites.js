'use strict';
/**
 * recover-all-favorites.js
 * Reconstrói os favoritos perdidos usando:
 *   - seen-albums.json  → quais store+albumId foram vistos
 *   - album-links.json  → externalLinks de cada álbum
 *   - Yupoo (rede)      → título + capa via listagem da loja (fetchAlbums)
 *
 * NÃO abre páginas individuais de álbum (fotos são carregadas on-demand no app).
 * Isso reduz de ~16k requests para ~800 (páginas de listagem da grade).
 *
 * Uso:
 *   node recover-all-favorites.js
 *
 * Pode ser interrompido (Ctrl+C) e retomado: já salva progresso a cada loja.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('https');

// ── Dependências externas (já instaladas no projeto) ────────────────────────
const axios   = require('./node_modules/axios');
const cheerio = require('./node_modules/cheerio');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Caminhos ────────────────────────────────────────────────────────────────
const userData = path.join(os.homedir(), 'AppData', 'Roaming', 'yupoo-scraper');
const SEEN_FILE   = path.join(userData, 'seen-albums.json');
const LINKS_FILE  = path.join(userData, 'album-links.json');
const FAV_FILE    = path.join(userData, 'favorites.json');
const FAV_TMP     = FAV_FILE + '.tmp';

// ── Helpers ──────────────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function saveFavorites(list) {
  fs.writeFileSync(FAV_TMP, JSON.stringify(list), 'utf8');
  fs.renameSync(FAV_TMP, FAV_FILE);
}

function makeClient(base) {
  return axios.default ? axios.default.create({
    timeout: 20000,
    maxRedirects: 5,
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      Referer: base + '/' },
    validateStatus: s => s >= 200 && s < 400,
  }) : axios.create({
    timeout: 20000,
    maxRedirects: 5,
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      Referer: base + '/' },
    validateStatus: s => s >= 200 && s < 400,
  });
}

function loadCheerio(html) {
  return cheerio.load ? cheerio.load(html) : cheerio.default.load(html);
}

function absUrl(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  return s.startsWith('//') ? 'https:' + s : s;
}

function albumIdFromHref(href) {
  const m = href.match(/\/albums\/(\d+)/);
  return m ? m[1] : null;
}

function readTotalPages($) {
  // Selector principal do Yupoo: .pagination__jumpwrap contém "N páginas"
  const txt = $('.pagination__jumpwrap').text() || $('body').text();
  const m = txt.match(/(\d+)\s*p[áa]ginas/i);
  if (m) return parseInt(m[1], 10);
  // Formato alternativo: span "1 / 181"
  const span = $('.categories__box-right-pagination-span').first().text();
  const m2 = span.match(/\/\s*(\d+)/);
  if (m2) return parseInt(m2[1], 10);
  return 1;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Decodifica link externo do Yupoo (/external?url=...) ────────────────────
function decodeExternal(href) {
  const m = href.match(/\/external\?url=(.+)/);
  if (!m) return null;
  try { return decodeURIComponent(decodeURIComponent(m[1])); }
  catch (_) { try { return decodeURIComponent(m[1]); } catch (__) { return null; } }
}

function cleanUrl(u) {
  if (!u) return null;
  try { return u.replace(/&amp;/g, '&'); } catch (_) { return u; }
}

// ── Busca UMA página da grade da loja ────────────────────────────────────────
async function fetchAlbumsPage(client, base, page) {
  const url = `${base}/albums?page=${page}`;
  let html;
  try {
    const res = await client.get(url);
    html = res.data;
  } catch (err) {
    throw new Error(`GET ${url}: ${err.message}`);
  }
  const $ = loadCheerio(html);

  const albums = [];
  $('.showindex__children a.album__main').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') || '';
    const id   = albumIdFromHref(href);
    if (!id) return;
    const img   = $el.find('img').first();
    const cover = absUrl(img.attr('src') || img.attr('data-src'));
    const title = ($el.attr('title') || $el.find('.album__title').text() || '').trim();
    albums.push({ id, title, cover, url: `${base}/albums/${id}?uid=1` });
  });

  // Links externos presentes nesta página
  const external = new Set();
  $('a[href*="/external?url="]').each((_, el) => {
    const d = decodeExternal($(el).attr('href') || '');
    if (d) external.add(cleanUrl(d));
  });

  return {
    albums,
    externalLinks: [...external],
    totalPages: readTotalPages($),
  };
}

// ── Principal ────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Recuperação de Favoritos ===\n');

  const seen  = readJson(SEEN_FILE, {});
  const links = readJson(LINKS_FILE, {});

  const storeKeys = Object.keys(seen);
  if (!storeKeys.length) {
    console.error('seen-albums.json vazio ou não encontrado em', SEEN_FILE);
    process.exit(1);
  }

  // Conta total de álbuns a recuperar
  let totalSeen = 0;
  storeKeys.forEach(s => totalSeen += Object.keys(seen[s].ids || {}).length);
  console.log(`Lojas: ${storeKeys.length} | Álbuns vistos: ${totalSeen}`);

  // Carrega favoritos existentes; remove skeletons para re-buscar com dados reais
  let favs = readJson(FAV_FILE, []);
  if (!Array.isArray(favs)) favs = [];
  const skeletonsBefore = favs.filter(f => f._recovered && (!f.cover || f.title.startsWith('(álbum')));
  if (skeletonsBefore.length) {
    favs = favs.filter(f => !(f._recovered && (!f.cover || f.title.startsWith('(álbum'))));
    saveFavorites(favs);
    console.log(`Removidos ${skeletonsBefore.length} skeletons para re-buscar com dados reais.`);
  }
  const existingKeys = new Set(favs.map(f => `${f.store}::${f.albumId}`));
  console.log(`Favoritos já no arquivo: ${favs.length}`);
  console.log('');

  let totalAdded  = 0;
  let totalFailed = 0;

  for (let si = 0; si < storeKeys.length; si++) {
    const store      = storeKeys[si];
    const seenIds    = new Set(Object.keys(seen[store].ids || {}));
    const storeLabel = store.replace('https://', '');

    // Quantos já foram recuperados desta loja
    const alreadyDone = [...existingKeys].filter(k => k.startsWith(store + '::')).length;
    if (alreadyDone >= seenIds.size) {
      console.log(`[${si+1}/${storeKeys.length}] ${storeLabel} — já completo (${alreadyDone}/${seenIds.size}), pulando.`);
      continue;
    }

    console.log(`[${si+1}/${storeKeys.length}] ${storeLabel} — ${seenIds.size} álbuns vistos (${alreadyDone} já recuperados)`);

    const client       = makeClient(store);
    const foundInListing = new Map(); // id -> {title,cover,url,externalLinks}

    // Busca todas as páginas da grade até encontrar todos os álbuns vistos
    // ou esgotar as páginas
    let page = 1;
    let totalPages = 999; // alto por garantia; será atualizado na 1ª página
    let consecutiveEmpty = 0;

    while (page <= totalPages) {
      process.stdout.write(`  página ${page}/${totalPages === 999 ? '?' : totalPages}…`);
      try {
        const res = await fetchAlbumsPage(client, store, page);
        if (res.totalPages > 1) totalPages = res.totalPages;
        else if (page === 1 && res.albums.length === 0) { totalPages = 1; }

        if (res.albums.length === 0) {
          consecutiveEmpty++;
          process.stdout.write(` vazia (${consecutiveEmpty})\n`);
          if (consecutiveEmpty >= 2) break; // 2 páginas seguidas vazias = fim
        } else {
          consecutiveEmpty = 0;
          for (const a of res.albums) {
            if (seenIds.has(a.id)) {
              const linkKey  = `${store}::${a.id}`;
              const linkData = links[linkKey];
              foundInListing.set(a.id, {
                title: a.title,
                cover: a.cover,
                url:   a.url,
                externalLinks: (linkData && linkData.externalLinks) || [],
                rawLinks: [],
              });
            }
          }
          process.stdout.write(` ok (${res.albums.length} álbuns, ${foundInListing.size}/${seenIds.size} encontrados)\n`);
        }
      } catch (err) {
        process.stdout.write(` ERRO: ${err.message}\n`);
        totalFailed++;
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
      }

      // Se já encontrou todos os vistos, para de buscar mais páginas
      if (foundInListing.size >= seenIds.size) break;

      page++;
      await sleep(500);
    }

    // Para álbuns vistos que não apareceram na listagem (removidos da loja?),
    // cria um esqueleto sem título/capa usando os dados do album-links.json
    for (const id of seenIds) {
      if (!foundInListing.has(id)) {
        const linkKey  = `${store}::${id}`;
        const linkData = links[linkKey];
        foundInListing.set(id, {
          title:         `(álbum ${id})`,
          cover:         null,
          url:           `${store}/albums/${id}?uid=1`,
          externalLinks: (linkData && linkData.externalLinks) || [],
          rawLinks:      [],
        });
      }
    }

    // Adiciona à lista de favoritos (sem duplicar)
    let addedThisStore = 0;
    for (const [id, data] of foundInListing) {
      const key = `${store}::${id}`;
      if (existingKeys.has(key)) continue;
      favs.push({
        store:         store,
        albumId:       String(id),
        title:         data.title || '',
        url:           data.url,
        cover:         data.cover || null,
        photoCount:    0,
        category:      null,
        externalLinks: data.externalLinks,
        rawLinks:      data.rawLinks,
        photos:        [],
        tags:          [],
        savedAt:       new Date().toISOString(),
        _recovered:    true,
      });
      existingKeys.add(key);
      addedThisStore++;
      totalAdded++;
    }

    // Salva atomicamente após cada loja
    saveFavorites(favs);
    console.log(`  → ${addedThisStore} favoritos adicionados desta loja (total: ${favs.length})\n`);
  }

  console.log('=== Recuperação concluída ===');
  console.log(`Total adicionados: ${totalAdded}`);
  console.log(`Total no arquivo:  ${favs.length}`);
  if (totalFailed) console.log(`Erros (páginas que falharam): ${totalFailed}`);
  console.log('\nReinicie o app para ver todos os favoritos.');
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
