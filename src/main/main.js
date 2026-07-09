'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, session, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const scraper = require('./scraper');
const Storage = require('./storage');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Esquema privilegiado usado para servir imagens do Yupoo a partir do cache
// LOCAL (arquivadas em disco). Precisa ser registrado antes do app ficar pronto.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ycimg',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let storage = null;
let mainWindow = null;
// Referer usado nas imagens do Yupoo (anti-hotlink). Atualizado ao carregar loja.
let currentReferer = 'https://x.yupoo.com/';

/**
 * Deriva um Referer valido (dominio *.yupoo.com) para a URL de imagem.
 * Ex.: https://photo.yupoo.com/akdingji/xxxx/big.jpg -> https://akdingji.x.yupoo.com/
 */
function refererFor(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'photo.yupoo.com') {
      const owner = u.pathname.split('/').filter(Boolean)[0];
      if (owner) return `https://${owner}.x.yupoo.com/`;
    }
  } catch (_) {
    /* ignora */
  }
  return currentReferer;
}

/* --------------------- Cache LOCAL de imagens do Yupoo -------------------- */
// As imagens (capas/fotos) são baixadas uma vez e guardadas em disco, para não
// dependerem do CDN do Yupoo (que bloqueia rajadas) e ficarem arquivadas.
let imageCacheDir = null;
const imgStats = { hits: 0, stored: 0, failed: 0 };
/**
 * Chave ESTÁVEL de uma imagem do Yupoo: protocolo + host + caminho, SEM a
 * query string. O Yupoo anexa tokens voláteis (que mudam a cada carregamento)
 * na URL das fotos; se eles entrarem no hash, o mesmo arquivo gera um nome
 * novo toda vez, o cache nunca acerta e o disco só acumula (GBs) re-baixando.
 * Usando só o caminho, cada foto sempre vira o MESMO nome fixo.
 */
function canonicalImgKey(remoteUrl) {
  try {
    const u = new URL(remoteUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch (_) {
    return String(remoteUrl).split('#')[0].split('?')[0];
  }
}
function imgCachePath(remoteUrl) {
  const h = crypto.createHash('sha1').update(canonicalImgKey(remoteUrl)).digest('hex');
  let ext = '.jpg';
  const m = String(remoteUrl).match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i);
  if (m) ext = '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
  return path.join(imageCacheDir, h + ext);
}
function mimeForFile(file) {
  const e = path.extname(file).toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'image/jpeg';
}

/** Decodifica a URL remota embutida numa requisição ycimg://img/<base64url>. */
function decodeYcimg(reqUrl) {
  const u = new URL(reqUrl);
  let b64 = u.pathname.replace(/^\/+/, '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64').toString('utf8');
}

// Downloads separados em dois canais para garantir prioridade:
//  FG (foreground) — ycimg:// handler: imagens visíveis na tela (prioridade máxima)
//  BG (background) — prefetchImages: pré-cache em segundo plano
// Cada canal tem seu próprio contador/fila; assim o prefetch nunca bloqueia
// as imagens que o usuário já está vendo.
const MAX_FG = 4; // slots para downloads sob demanda (visíveis)
const MAX_BG = 2; // slots para prefetch em background
let activeFg = 0, activeBg = 0;
const fgQueue = [], bgQueue = [];
const inflight = new Map(); // file -> Promise<void>  (dedupe por arquivo)

function acquireFg() {
  if (activeFg < MAX_FG) { activeFg++; return Promise.resolve(); }
  return new Promise((r) => fgQueue.push(r));
}
function releaseFg() {
  const next = fgQueue.shift();
  if (next) next(); else activeFg = Math.max(0, activeFg - 1);
}
function acquireBg() {
  if (activeBg < MAX_BG) { activeBg++; return Promise.resolve(); }
  return new Promise((r) => bgQueue.push(r));
}
function releaseBg() {
  const next = bgQueue.shift();
  if (next) next(); else activeBg = Math.max(0, activeBg - 1);
}

// Mantém retrocompatibilidade (ensureCached usa FG por padrão)
const MAX_DL = MAX_FG;
function acquireSlot() { return acquireFg(); }
function releaseSlot() { releaseFg(); }

/** Garante que a imagem esteja em disco (baixa uma vez, com limite/ dedupe). */
function ensureCached(remote, file) {
  if (fs.existsSync(file)) return Promise.resolve();
  // Dedupe pelo ARQUIVO de destino (nome fixo), não pela URL remota: variantes
  // da mesma foto com tokens diferentes apontam para o mesmo arquivo.
  if (inflight.has(file)) return inflight.get(file);
  const p = (async () => {
    await acquireSlot();
    try {
      if (fs.existsSync(file)) return;
      const res = await axios.get(remote, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { Referer: refererFor(remote), 'User-Agent': USER_AGENT },
      });
      fs.writeFileSync(file, Buffer.from(res.data));
      imgStats.stored += 1;
      const total = fs.readdirSync(imageCacheDir).length;
      console.log(
        `[cache] ARMAZENOU imagem #${imgStats.stored} (${res.data.byteLength} bytes) | total no disco: ${total}`
      );
    } finally {
      releaseSlot();
      inflight.delete(file);
    }
  })();
  inflight.set(file, p);
  return p;
}

/**
 * Reúne as URLs de imagem que precisam existir em disco para o favorito ficar
 * disponível offline. Arquiva APENAS a thumbnail (capa) do produto — NÃO todas
 * as fotos do álbum — pois só a miniatura é exibida na grade de favoritos.
 * @param {object} fav registro do favorito.
 * @returns {string[]} URLs remotas (yupoo) únicas.
 */
function favImageUrls(fav) {
  const urls = new Set();
  const add = (u) => {
    if (u && typeof u === 'string' && /^https?:\/\//i.test(u)) urls.add(u);
  };
  if (fav) {
    // Somente a thumbnail do produto: capa do favorito ou, na falta dela,
    // a miniatura da primeira foto do álbum.
    if (fav.cover) add(fav.cover);
    else {
      const first = (fav.photos || [])[0];
      if (first) add(first.thumb || first.big || first.origin);
    }
  }
  return [...urls];
}

/**
 * Baixa e arquiva em disco (image-cache) todas as imagens de um favorito,
 * respeitando a fila de downloads (5 por vez). Roda em segundo plano.
 * @param {object} fav registro do favorito.
 * @returns {Promise<{total:number,cached:number,failed:number}>}
 */
async function archiveFavoriteImages(fav) {
  const list = favImageUrls(fav);
  if (!list.length || !imageCacheDir) return { total: 0, cached: 0, failed: 0 };
  let cached = 0;
  let failed = 0;
  async function worker(queue) {
    while (queue.length) {
      const remote = queue.shift();
      try {
        await ensureCached(remote, imgCachePath(remote));
        cached += 1;
      } catch (_) {
        failed += 1;
      }
    }
  }
  const queue = [...list];
  await Promise.all(Array.from({ length: MAX_DL }, () => worker(queue)));
  console.log(
    `[cache] favorito arquivado: ${cached}/${list.length} imagem(ns) em disco (${failed} falha(s)).`
  );
  return { total: list.length, cached, failed };
}

/** Handler do esquema ycimg: serve do disco ou baixa (com Referer) e arquiva. */
async function handleYcimg(request) {
  try {
    const remote = decodeYcimg(request.url);
    if (!/^https?:\/\//i.test(remote)) return new Response('', { status: 400 });
    const file = imgCachePath(remote);
    const hadFile = fs.existsSync(file);
    // Se já está no disco, serve na hora. Só baixa (e aguarda) quando falta.
    if (!hadFile) {
      try {
        await ensureCached(remote, file);
      } catch (e) {
        imgStats.failed += 1;
        if (imgStats.failed % 10 === 0) {
          console.log(`[cache] FALHAS ao baixar: ${imgStats.failed} | último erro: ${e.message}`);
        }
      }
    }
    if (fs.existsSync(file)) {
      if (hadFile) {
        imgStats.hits += 1;
        if (imgStats.hits % 200 === 0) {
          console.log(`[cache] HITS do disco: ${imgStats.hits} (servidas sem baixar)`);
        }
      }
      // Lê os bytes direto do disco e devolve na resposta. Não passa pelo
      // net.fetch/cache de rede do Electron (que era lento e podia falhar com
      // "Unable to create cache" quando havia lock). Imagens são pequenas.
      const data = await fs.promises.readFile(file);
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': mimeForFile(file),
          'cache-control': 'no-store',
        },
      });
    }
    return new Response('', { status: 404 });
  } catch (e) {
    console.log(`[cache] FALHA: ${e.message}`);
    return new Response('', { status: 404 });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#111318',
    title: 'Yupoo Scraper',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Abra o DevTools iniciando com OPEN_DEVTOOLS=1 (diagnostico).
  if (process.env.OPEN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Abre links externos no navegador padrao, nao dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Impede múltiplas instâncias na MESMA pasta de dados. Duas instâncias juntas
// não conseguem travar o cache de rede (erro "Acesso negado / Unable to create
// cache") e o protocolo ycimg:// passa a falhar com "Failed to fetch", deixando
// as capas em branco. Se já houver uma aberta, foca nela e encerra esta.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  storage = new Storage(app.getPath('userData'));
  // Corrige lojas já marcadas como "Visto" para também contarem como
  // "Atualizado" (regra: tudo visto = atualizado). Roda uma vez no arranque.
  Promise.resolve(storage.syncReviewedWithSeen()).catch(() => {});
  // Pasta do cache local de imagens (arquivo permanente das fotos), agora
  // DENTRO da pasta do projeto (ao lado do package.json) em vez do AppData.
  imageCacheDir = path.join(app.getAppPath(), 'image-cache');
  try {
    fs.mkdirSync(imageCacheDir, { recursive: true });
  } catch (_) {
    /* ignora */
  }
  // Migração única: move as imagens já arquivadas no AppData para a nova pasta
  // do projeto, para não precisar baixar tudo de novo.
  try {
    const oldDir = path.join(app.getPath('userData'), 'image-cache');
    if (oldDir !== imageCacheDir && fs.existsSync(oldDir)) {
      const files = fs.readdirSync(oldDir);
      let moved = 0;
      for (const name of files) {
        const from = path.join(oldDir, name);
        const to = path.join(imageCacheDir, name);
        if (fs.existsSync(to)) continue;
        try {
          fs.renameSync(from, to);
          moved += 1;
        } catch (_) {
          try {
            fs.copyFileSync(from, to);
            fs.unlinkSync(from);
            moved += 1;
          } catch (_) {
            /* ignora arquivo individual */
          }
        }
      }
      if (moved) console.log(`[cache] migração: ${moved} imagem(ns) movida(s) do AppData para ${imageCacheDir}`);
    }
  } catch (_) {
    /* ignora */
  }
  protocol.handle('ycimg', handleYcimg);
  try {
    const n = fs.readdirSync(imageCacheDir).length;
    console.log(`[cache] pronto. Imagens já arquivadas no disco: ${n} | pasta: ${imageCacheDir}`);
  } catch (_) {
    /* ignora */
  }

  // Injeta Referer/User-Agent nas imagens do Yupoo para driblar o anti-hotlink.
  const filter = { urls: ['*://*.yupoo.com/*'] };
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = details.requestHeaders;
    headers['Referer'] = refererFor(details.url);
    headers['User-Agent'] = USER_AGENT;
    callback({ requestHeaders: headers });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Grava (permanente) os links de compra de um site, se houver algum. */
function recordLinks(store, links) {
  try {
    if (links && links.length) storage.recordStoreLinks(store, links);
  } catch (_) {
    /* ignora */
  }
}

/**
 * Marketplaces/lojas aceitos na verificacao (basta 1 link destes p/ validar).
 * 1688 / Taobao / Tmall / XianYu / Amazon / Dangdang / JD / VIP / Weidian / Youzan.
 * Testa a URL inteira, entao tambem pega links de agente que embutem a origem
 * (ex.: mulebuy/cnfans/hoobuy?url=https://weidian.com/...).
 */
const SHOP_LINK_RE = new RegExp(
  [
    '1688\\.com',
    'taobao\\.com',
    'tmall\\.com',
    'goofish\\.com', // XianYu
    'xianyu',
    'amazon\\.',
    'dangdang\\.com',
    'jd\\.com',
    'jd\\.hk',
    'vip\\.com', // Vipshop
    'weidian\\.com',
    'youzan\\.com',
    'kdt\\.im', // Youzan
  ].join('|'),
  'i'
);

function isShopLink(url) {
  return SHOP_LINK_RE.test(String(url || ''));
}

/**
 * Cancelamento do carregamento de links/precos.
 * O renderer chama 'loading:cancel' para interromper as buscas em andamento.
 */
let cancelLoading = false;
function beginLoading() {
  cancelLoading = false;
}
function shouldCancelLoading() {
  return cancelLoading;
}

/** Rejeita se a promessa nao resolver dentro de `ms` (fast-fail). */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label || 'tempo esgotado')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function wrap(handler) {
  return async (_event, ...args) => {
    try {
      const data = await handler(...args);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  };
}

/**
 * Verifica os links de compra de varios albuns, usando o cache de 24h.
 * So escaneia (rede) os albuns ainda nao verificados hoje.
 */
async function checkAlbumLinksCached(store, ids, concurrency) {
  const nStore = scraper.normalizeStore(store);
  const list = ids || [];
  const map = {};
  const toScan = [];
  for (const id of list) {
    const cached = storage.getCachedAlbumLinks(nStore, id);
    if (cached) map[id] = cached;
    else toScan.push(id);
  }
  if (toScan.length && !shouldCancelLoading()) {
    const fresh = await scraper.checkAlbumLinks(store, toScan, concurrency || 5, shouldCancelLoading);
    for (const id of Object.keys(fresh)) {
      map[id] = fresh[id];
      storage.setCachedAlbumLinks(nStore, id, fresh[id]).catch(() => {});
    }
  }
  const found = [];
  for (const id of Object.keys(map)) {
    const info = map[id];
    // Salva apenas o link PRINCIPAL (o 1o) de cada album.
    if (info && info.externalLinks && info.externalLinks[0]) {
      found.push(info.externalLinks[0]);
    }
  }
  recordLinks(nStore, found);
  return map;
}

/**
 * Busca precos de varias urls usando o cache de 24h (ok e falhas).
 * onItem(item) e chamado para cada url resolvida (cache ou nova).
 */
async function fetchPricesCached(urls, onItem) {
  const list = [...new Set((urls || []).filter(Boolean))];
  const results = [];
  const stale = [];
  for (const url of list) {
    const cached = storage.getCachedPrice(url);
    if (cached) {
      const item = { ...cached, cached: true };
      // Preço válido em cache: mantém o preço base e só atualiza USD/BRL com a
      // cotação atual (sem nova raspagem).
      if (cached.ok && cached.price != null) {
        try {
          const conv = await scraper.refreshConversions(cached);
          if (conv) {
            item.usd = conv.usd;
            item.brl = conv.brl;
            storage.updateConversions(url, conv).catch(() => {});
          }
        } catch (_) {
          /* mantém conversão antiga se a cotação falhar */
        }
      }
      results.push(item);
      if (onItem) onItem(item);
    } else {
      stale.push(url);
    }
  }
  if (stale.length && !shouldCancelLoading()) {
    const fetched = await scraper.fetchPrices(
      stale,
      (_d, _t, item) => {
        if (item && item.url) storage.setCachedPrice(item.url, item).catch(() => {});
        if (onItem) onItem(item);
      },
      3,
      shouldCancelLoading
    );
    // Garante que TODO preco buscado fique armazenado, mesmo os que nao
    // passaram pelo callback de progresso.
    for (const item of fetched || []) {
      if (item && item.url) storage.setCachedPrice(item.url, item).catch(() => {});
    }
    results.push(...fetched);
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/*  IPC: Albuns / Categorias                                                   */
/* -------------------------------------------------------------------------- */

ipcMain.handle(
  'albums:list',
  wrap(async (store, page) => {
    const res = await scraper.fetchAlbums(store, page || 1);
    currentReferer = res.store + '/';
    return res;
  })
);

ipcMain.handle(
  'albums:get',
  wrap(async (store, albumId) => {
    const res = await scraper.fetchAlbum(store, albumId);
    // Se o album tem link de compra, salva apenas o PRINCIPAL sob o site.
    recordLinks(res.store, (res.externalLinks || []).slice(0, 1));
    return res;
  })
);

ipcMain.handle(
  'albums:checkLinks',
  wrap(async (store, ids, concurrency) => {
    beginLoading();
    return checkAlbumLinksCached(store, ids || [], concurrency || 5);
  })
);

ipcMain.handle(
  'categories:list',
  wrap(async (store) => {
    return scraper.fetchCategories(store);
  })
);

ipcMain.handle(
  'categories:albums',
  wrap(async (store, categoryId, page) => {
    return scraper.fetchCategoryAlbums(store, categoryId, page || 1);
  })
);

ipcMain.handle(
  'store:validate',
  wrap(async (store) => {
    return { store: scraper.normalizeStore(store) };
  })
);

/* -------------------------------------------------------------------------- */
/*  IPC: Favoritos                                                             */
/* -------------------------------------------------------------------------- */

ipcMain.handle('favorites:list', wrap(async () => storage.listFavorites()));

ipcMain.handle(
  'favorites:add',
  wrap(async (fav) => {
    const rec = await storage.addFavorite(fav);
    // Arquiva em disco APENAS a thumbnail (capa) do produto, em segundo plano,
    // para o favorito ficar disponível offline sem baixar todas as fotos.
    archiveFavoriteImages(rec).catch((e) =>
      console.log(`[cache] falha ao arquivar favorito: ${e && e.message}`)
    );
    return { favorite: rec, all: storage.listFavorites() };
  })
);

ipcMain.handle(
  'favorites:remove',
  wrap(async (store, albumId) => storage.removeFavorite(store, albumId))
);

ipcMain.handle(
  'favorites:isFavorite',
  wrap(async (store, albumId) => storage.isFavorite(store, albumId))
);

/* ---- Tags / Categorias dos favoritos ---- */
ipcMain.handle('tags:list', wrap(async () => storage.listTags()));
ipcMain.handle('tags:add', wrap(async (name, kind) => storage.addTag(name, kind)));
ipcMain.handle('tags:remove', wrap(async (name) => storage.removeTag(name)));
ipcMain.handle(
  'favorites:setTags',
  wrap(async (store, albumId, tags) => storage.setFavoriteTags(store, albumId, tags))
);

/* ---- Margem de lucro por produto ---- */
ipcMain.handle('profits:list', wrap(async () => storage.listProfits()));
ipcMain.handle('profits:set', wrap(async (url, pct) => storage.setProfit(url, pct)));

ipcMain.handle(
  'favorites:export',
  wrap(async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar favoritos',
      defaultPath: 'favoritos-yupoo.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await storage.exportFavorites(filePath);
    return { canceled: false, filePath };
  })
);

/* -------------------------------------------------------------------------- */
/*  IPC: Links de compra por site (permanente)                                 */
/* -------------------------------------------------------------------------- */

ipcMain.handle('session:links', wrap(async () => storage.listStoreLinks()));

ipcMain.handle(
  'session:removeStore',
  wrap(async (store) => storage.removeStore(store))
);

ipcMain.handle(
  'session:export',
  wrap(async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar links de compra por site',
      defaultPath: 'links-de-compra.txt',
      filters: [{ name: 'Texto', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await storage.exportStoreLinks(filePath);
    return { canceled: false, filePath };
  })
);

/* -------------------------------------------------------------------------- */
/*  IPC: Precos dos links de compra                                            */
/* -------------------------------------------------------------------------- */

ipcMain.handle(
  'links:fetchPrices',
  wrap(async (urls) => {
    beginLoading();
    const list = Array.isArray(urls) ? [...new Set(urls.filter(Boolean))] : [];
    const total = list.length;
    let done = 0;
    const results = await fetchPricesCached(list, (item) => {
      done += 1;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('prices:progress', { done, total, item });
      }
    });
    return { count: results.length, results, cancelled: shouldCancelLoading() };
  })
);

ipcMain.handle(
  'loading:cancel',
  wrap(async () => {
    cancelLoading = true;
    return true;
  })
);

/**
 * Retorna os precos JA ARMAZENADOS (independente da idade) para uma lista de
 * urls, para exibicao instantanea sem rebuscar.
 */
ipcMain.handle(
  'prices:getCached',
  wrap(async (urls) => {
    const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
    return storage.getStoredPrices(list);
  })
);

/**
 * Detecta precos escritos no NOME do album (ex.: ￥98, ¥239).
 * Recebe [{id, title, url}] e retorna { [id]: {price,currency,usd,brl,ok,source,url} }.
 */
ipcMain.handle(
  'prices:fromTitles',
  wrap(async (items) => {
    const list = Array.isArray(items) ? items : [];
    const map = {};
    for (const it of list) {
      if (!it || it.title == null) continue;
      // Verifica se já temos este preço salvo em disco (chave = url do álbum).
      const key = it.url || `title:${it.id}`;
      const cached = storage.getCachedPrice(key);
      if (cached && cached.ok) {
        map[it.id] = cached;
        continue;
      }
      const r = await scraper.priceFromText(it.title);
      if (r) {
        r.url = key;
        map[it.id] = r;
        // Persiste em prices.json para sobreviver ao restart.
        storage.setCachedPrice(key, r).catch(() => {});
      }
    }
    return map;
  })
);

/**
 * Força re-busca dos preços para uma lista de URLs, ignorando o cache de falhas.
 * Usado pelo sweep de Superbuy nos favoritos e pelo botão "Atualizar preço".
 */
ipcMain.handle(
  'prices:forceRefetch',
  wrap(async (urls) => {
    const list = Array.isArray(urls) ? [...new Set(urls.filter(Boolean))] : [];
    // Remove entradas com ok=false ou sem preço do cache, para forçar re-busca.
    for (const url of list) {
      const cached = storage.getCachedPrice(url);
      if (!cached || !cached.ok || cached.price == null) {
        await storage.deleteCachedPrice(url).catch(() => {});
      }
    }
    const results = [];
    await scraper.fetchPrices(
      list,
      (done, total, item) => {
        if (item && item.url) storage.setCachedPrice(item.url, item).catch(() => {});
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('prices:progress', { done, total, item });
        }
        results.push(item);
      },
      3,
      shouldCancelLoading
    );
    return { count: results.length, results };
  })
);

/* -------------------------------------------------------------------------- */
/*  IPC: Verificacao de precos em varias lojas                                 */
/* -------------------------------------------------------------------------- */

ipcMain.handle(
  'bulk:checkStores',
  wrap(async (urls) => {
    beginLoading();
    const stores = [
      ...new Set(
        (Array.isArray(urls) ? urls : [])
          .map((u) => {
            try {
              return scraper.normalizeStore(String(u || '').trim());
            } catch (_) {
              return '';
            }
          })
          .filter(Boolean)
          // SOMENTE lojas Yupoo; ignora taobao/weidian/outros sites.
          .filter((s) => {
            try {
              return /\.yupoo\.com$/i.test(new URL(s).hostname);
            } catch (_) {
              return false;
            }
          })
      ),
    ];
    const total = stores.length;
    let done = 0;
    const results = [];
    const emit = (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bulk:progress', payload);
      }
    };

    for (const store of stores) {
      const entry = { store, ok: false, albums: 0, links: 0, priced: 0, samples: [] };
      try {
        const MAX_ALBUMS = 100; // desiste se nao achar link em ate 100 albuns
        let page = 1;
        let totalPages = 1;
        let scanned = 0;
        let foundLink = null;

        while (scanned < MAX_ALBUMS && !foundLink) {
          // Fast-fail: site sem acesso/bloqueado nao pode travar a fila.
          let res;
          try {
            res = await withTimeout(scraper.fetchAlbums(store, page), 9000, 'sem acesso');
          } catch (err) {
            if (page === 1) throw err; // loja inacessivel -> marca erro e pula
            break; // paginas seguintes falharam: para por aqui
          }
          if (page === 1) totalPages = res.totalPages || 1;

          const ids = res.albums.map((a) => a.id);
          if (!ids.length) break;

          const budget = MAX_ALBUMS - scanned;
          const batch = ids.slice(0, budget);
          const map = await withTimeout(
            checkAlbumLinksCached(store, batch, 8),
            30000,
            'demorou demais'
          );
          for (const id of batch) {
            scanned += 1;
            const info = map[id];
            const link = info && info.externalLinks && info.externalLinks[0];
            if (link && isShopLink(link)) {
              foundLink = link;
              break;
            }
          }
          if (page >= totalPages) break;
          page += 1;
        }

        entry.albums = scanned;
        entry.priced = foundLink ? 1 : 0; // reaproveitado: tem link de loja?
        entry.links = foundLink ? 1 : 0;
        entry.samples = foundLink ? [{ url: foundLink }] : [];
        entry.ok = true;

        // Mantem salvo qualquer loja que tenha ao menos 1 link de loja.
        if (foundLink) {
          await storage.savePricedStore(store, {
            albums: entry.albums,
            links: entry.links,
            priced: entry.priced,
          });
        }
      } catch (err) {
        entry.error = err.message || String(err);
      }
      done += 1;
      results.push(entry);
      emit({ done, total, store, entry });
    }

    return { count: results.length, results };
  })
);

ipcMain.handle(
  'bulk:listPriced',
  wrap(async () => storage.listPricedStores())
);

ipcMain.handle(
  'bulk:removePriced',
  wrap(async (store) => storage.removePricedStore(store))
);

ipcMain.handle(
  'bulk:setPricedFlag',
  wrap(async (store, flag, value) => storage.setPricedFlag(store, flag, value))
);

/**
 * Varre a grade principal (todas as páginas) de cada loja salva procurando
 * álbuns NOVOS (ids ainda não vistos). Se achar novos, desmarca "Atualizado"
 * daquela loja e registra a contagem; se não achar nenhum, marca "Atualizado".
 * Emite progresso em 'checknew:progress'.
 */
ipcMain.handle(
  'stores:checkNew',
  wrap(async () => {
    beginLoading();
    const stores = storage.listPricedStores();
    const total = stores.length;
    let done = 0;
    const results = [];
    const emit = (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('checknew:progress', payload);
      }
    };

    for (const s of stores) {
      if (shouldCancelLoading()) break;
      const store = s.store;
      const entry = { store, ok: false, newCount: 0, total: 0 };
      try {
        const seenRec = storage.getSeen(store);
        const seenIds = new Set(Object.keys(seenRec.ids || {}));
        const allIds = new Set();
        let page = 1;
        let totalPages = 1;
        const MAX_PAGES = 60; // trava de segurança contra lojas enormes/erro
        while (page <= totalPages && page <= MAX_PAGES) {
          if (shouldCancelLoading()) break;
          let res;
          try {
            res = await withTimeout(scraper.fetchAlbums(store, page), 9000, 'sem acesso');
          } catch (err) {
            if (page === 1) throw err; // loja inacessível -> erro e pula
            break; // páginas seguintes falharam: para por aqui
          }
          if (page === 1) totalPages = res.totalPages || 1;
          for (const a of res.albums) allIds.add(String(a.id));
          if (page >= totalPages) break;
          page += 1;
        }
        const newIds = [...allIds].filter((id) => !seenIds.has(id));
        entry.total = allIds.size;
        entry.newCount = newIds.length;
        entry.ok = true;
        await storage.setPricedNewCount(store, newIds.length);
      } catch (err) {
        entry.error = err.message || String(err);
      }
      done += 1;
      results.push(entry);
      emit({ done, total, store, entry });
    }

    return { count: results.length, results };
  })
);

ipcMain.handle(
  'seen:get',
  wrap(async (store) => storage.getSeen(store))
);

ipcMain.handle(
  'seen:mark',
  wrap(async (store, ids) => storage.markSeen(store, ids))
);

/* -------------------------------------------------------------------------- */
/*  IPC: Download de fotos                                                     */
/* -------------------------------------------------------------------------- */

ipcMain.handle(
  'dialog:chooseFolder',
  wrap(async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Escolha a pasta de destino',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    return { canceled: false, folder: filePaths[0] };
  })
);

ipcMain.handle(
  'album:download',
  wrap(async (album, destRoot) => {
    if (!destRoot) throw new Error('Pasta de destino nao informada.');
    const result = await storage.downloadAlbum(album, destRoot, (done, total) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download:progress', {
          albumId: album.id,
          done,
          total,
        });
      }
    });
    return result;
  })
);

ipcMain.handle(
  'shell:openExternal',
  wrap(async (url) => {
    await shell.openExternal(url);
    return true;
  })
);

// Log vindo do renderer: ecoa no terminal do Electron (processo main).
ipcMain.on('log:renderer', (_e, msg) => {
  console.log(typeof msg === 'string' ? msg : JSON.stringify(msg));
});

// Pré-cache em segundo plano: baixa TODAS as imagens que ainda faltam no disco,
// respeitando a fila (5 por vez), sem depender do usuário rolar a página.
let prefetchRunning = false;
ipcMain.handle('cache:prefetchImages', async (_e, urls) => {
  const list = Array.isArray(urls) ? urls.filter((u) => /^https?:\/\//i.test(u)) : [];
  const missing = list.filter((u) => {
    try {
      return !fs.existsSync(imgCachePath(u));
    } catch (_) {
      return false;
    }
  });
  if (prefetchRunning) {
    console.log(`[cache] pré-cache já em andamento; ignorando novo pedido.`);
    return { started: false, total: list.length, cached: list.length - missing.length, missing: missing.length };
  }
  if (!missing.length) {
    console.log(`[cache] pré-cache: todas as ${list.length} imagens já estão no disco.`);
    return { started: false, total: list.length, cached: list.length, missing: 0 };
  }
  prefetchRunning = true;
  console.log(
    `[cache] pré-cache INICIADO: ${missing.length} imagem(ns) faltando de ${list.length} (5 por vez, em segundo plano)...`
  );
  const total = missing.length;
  const sendProgress = (done, finished) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cache:progress', { done, total, finished: !!finished });
      }
    } catch (_) {
      /* janela pode ter fechado */
    }
  };
  sendProgress(0, false);
  (async () => {
    let done = 0;
    let idx = 0;
    async function worker() {
      while (idx < missing.length) {
        const remote = missing[idx++];
        try {
          await ensureCached(remote, imgCachePath(remote));
        } catch (_) {
          /* falhas já são contabilizadas em imgStats */
        }
        done += 1;
        sendProgress(done, false);
        if (done % 100 === 0 || done === missing.length) {
          console.log(`[cache] pré-cache: ${done}/${missing.length} concluído`);
        }
      }
    }
    // Workers de background usam canal BG (2 slots), deixando FG livre para
    // o ycimg:// handler servir as imagens visíveis sem esperar o prefetch.
    async function bgWorker() {
      while (idx < missing.length) {
        const remote = missing[idx++];
        const file = imgCachePath(remote);
        if (fs.existsSync(file)) { done++; sendProgress(done, false); continue; }
        if (inflight.has(file)) {
          try { await inflight.get(file); } catch (_) {}
          done++; sendProgress(done, false); continue;
        }
        const p = (async () => {
          await acquireBg();
          try {
            if (!fs.existsSync(file)) {
              const res = await axios.get(remote, {
                responseType: 'arraybuffer', timeout: 15000,
                headers: { Referer: refererFor(remote), 'User-Agent': USER_AGENT },
              });
              fs.writeFileSync(file, Buffer.from(res.data));
              imgStats.stored++;
            }
          } finally { releaseBg(); inflight.delete(file); }
        })();
        inflight.set(file, p);
        try { await p; } catch (_) {}
        done++; sendProgress(done, false);
        if (done % 200 === 0 || done === missing.length)
          console.log(`[cache] pré-cache: ${done}/${missing.length} concluído`);
      }
    }
    await Promise.all(Array.from({ length: MAX_BG }, () => bgWorker()));
    prefetchRunning = false;
    sendProgress(done, true);
    const totalDisco = fs.existsSync(imageCacheDir) ? fs.readdirSync(imageCacheDir).length : 0;
    console.log(`[cache] pré-cache FINALIZADO. Total arquivado no disco: ${totalDisco}`);
  })();
  return { started: true, total: list.length, cached: list.length - missing.length, missing: missing.length };
});

/* -------------------------------------------------------------------------- */
/*  IPC: Motor de navegador (Puppeteer / Brave)                                */
/* -------------------------------------------------------------------------- */

ipcMain.handle(
  'engine:configure',
  wrap(async (cfg) => {
    // cfg: { mode, bravePath, browserURL, headless }
    scraper.setFetchMode(cfg && cfg.mode ? cfg.mode : 'auto');
    const st = await scraper.browser.configure(cfg || {});
    return st;
  })
);

ipcMain.handle('engine:status', wrap(async () => scraper.browser.status()));

ipcMain.handle(
  'engine:detectBrave',
  wrap(async () => ({ bravePath: scraper.browser.detectBravePath() }))
);

ipcMain.handle(
  'engine:close',
  wrap(async () => {
    await scraper.browser.closeBrowser();
    return scraper.browser.status();
  })
);

// Garante gravações pendentes e fecha o navegador antes de sair.
// IMPORTANTE: before-quit não aguarda Promises; usamos event.preventDefault()
// para cancelar o quit, fazemos o trabalho assíncrono e depois app.exit().
let _quitting = false;
app.on('before-quit', (event) => {
  if (_quitting) return; // segunda chamada (após app.exit) — deixa passar
  event.preventDefault();
  _quitting = true;
  Promise.allSettled([
    storage ? storage.flushSaves() : Promise.resolve(),
    scraper.browser.closeBrowser().catch(() => {}),
    scraper.browser.closePriceBrowser().catch(() => {}),
  ]).finally(() => app.exit(0));
});
