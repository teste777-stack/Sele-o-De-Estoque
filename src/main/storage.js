'use strict';

/**
 * storage.js
 * Persistencia de favoritos e download de fotos.
 * - Favoritos: gravados em favorites.json dentro de app.getPath('userData').
 * - Links da sessao: mantidos em memoria (Set) e opcionalmente exportados.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const axios = require('axios');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class Storage {
  /** @param {string} userDataDir diretorio retornado por app.getPath('userData') */
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.favFile = path.join(userDataDir, 'favorites.json');
    this.storeLinksFile = path.join(userDataDir, 'store-links.json');
    /**
     * Filas de gravação por arquivo, para serializar/coalescer escritas e
     * evitar corrida entre chamadas concorrentes (ex.: setCachedPrice).
     * @type {Object<string,{running:boolean,dirty:boolean,promise:Promise}>}
     */
    this._saveQueue = {};
    /**
     * Links de compra PERMANENTES por site (loja).
     * chave = url normalizada da loja (ex.: https://akdingji.x.yupoo.com)
     * @type {Object<string,{store:string,links:string[],updatedAt:string}>|null}
     */
    this._storeLinks = null;
    this._favorites = null;
    /**
     * Cache de precos por url de compra, valido por 24h.
     * @type {Object<string,{price:number,currency:string,usd:number,brl:number,ts:number}>|null}
     */
    this._prices = null;
    this.pricesFile = path.join(userDataDir, 'prices.json');
    /**
     * Cache do mapeamento album->links de compra, valido por 24h.
     * Chave: `${store}::${id}`.
     * @type {Object<string,{hasLink:boolean,externalLinks:string[],ts:number}>|null}
     */
    this._linksCache = null;
    this.linksCacheFile = path.join(userDataDir, 'album-links.json');
    /**
     * Lojas verificadas que possuem albuns com preco (salvas permanentemente).
     * Chave: url normalizada da loja.
     * @type {Object<string,{store:string,albums:number,links:number,priced:number,updatedAt:string}>|null}
     */
    this._pricedStores = null;
    this.pricedStoresFile = path.join(userDataDir, 'priced-stores.json');
    /**
     * Catalogo de tags para categorizar favoritos.
     * @type {Array<{name:string,kind:('categoria'|'marca')}>|null}
     */
    this._tags = null;
    this.tagsFile = path.join(userDataDir, 'tags.json');
    /**
     * Margem de lucro (%) personalizada por produto, indexada pela URL do link.
     * @type {{[url:string]:number}|null}
     */
    this._profits = null;
    this.profitsFile = path.join(userDataDir, 'profits.json');
    /**
     * Albuns "já vistos" por loja (indexados pelo ID do album, para velocidade).
     * Chave: url normalizada da loja -> { ids: {[id]: ISO}, updatedAt }.
     * @type {Object<string,{ids:Object<string,string>,updatedAt:string}>|null}
     */
    this._seen = null;
    this.seenFile = path.join(userDataDir, 'seen-albums.json');
  }

  _ensureDir() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Grava um arquivo JSON de forma SERIALIZADA por chave: várias chamadas
   * concorrentes são coalescidas em gravações sequenciais (a última reflete o
   * estado mais recente), evitando corrida e perda de dados.
   * @param {string} key identificador do arquivo (ex.: 'prices')
   * @param {string} file caminho absoluto
   * @param {() => any} getObj função que retorna o objeto atual a salvar
   * @returns {Promise<void>}
   */
  _saveDebounced(key, file, getObj) {
    const st =
      this._saveQueue[key] ||
      (this._saveQueue[key] = { running: false, dirty: false, promise: Promise.resolve() });
    st.dirty = true;
    if (st.running) return st.promise;
    st.running = true;
    st.promise = (async () => {
      this._ensureDir();
      while (st.dirty) {
        st.dirty = false;
        try {
          await fsp.writeFile(file, JSON.stringify(getObj()), 'utf8');
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('Falha ao salvar', file, e && e.message);
        }
      }
      st.running = false;
    })();
    return st.promise;
  }

  /**
   * Aguarda todas as gravações pendentes concluírem. Usar antes de encerrar o
   * app para não perder escritas ainda na fila.
   * @returns {Promise<void>}
   */
  async flushSaves() {
    const proms = Object.values(this._saveQueue).map((st) => st.promise);
    await Promise.allSettled(proms);
  }

  /* ---------------------------- FAVORITOS -------------------------------- */

  _load() {
    if (this._favorites) return this._favorites;
    try {
      const txt = fs.readFileSync(this.favFile, 'utf8');
      this._favorites = JSON.parse(txt);
      if (!Array.isArray(this._favorites)) this._favorites = [];
    } catch (_) {
      this._favorites = [];
    }
    return this._favorites;
  }

  async _save() {
    return this._saveDebounced('favorites', this.favFile, () => this._favorites);
  }

  listFavorites() {
    return this._load();
  }

  /** Chave unica de um favorito = loja + id do album. */
  _key(store, albumId) {
    return `${store}::${albumId}`;
  }

  isFavorite(store, albumId) {
    return this._load().some((f) => this._key(f.store, f.albumId) === this._key(store, albumId));
  }

  /**
   * Adiciona (ou atualiza) um favorito.
   * @param {object} fav objeto do album + categoria de origem.
   */
  async addFavorite(fav) {
    const list = this._load();
    const key = this._key(fav.store, fav.albumId);
    const idx = list.findIndex((f) => this._key(f.store, f.albumId) === key);
    // Preserva as tags ja atribuidas ao re-favoritar.
    const prevTags = idx >= 0 && Array.isArray(list[idx].tags) ? list[idx].tags : [];
    const record = {
      store: fav.store,
      albumId: String(fav.albumId),
      title: fav.title || '',
      url: fav.url || '',
      cover: fav.cover || null,
      photoCount: fav.photoCount || (fav.photos ? fav.photos.length : 0),
      category: fav.category || null, // { id, name } de onde foi arquivado
      externalLinks: fav.externalLinks || [],
      rawLinks: fav.rawLinks || [],
      photos: fav.photos || [],
      tags: Array.isArray(fav.tags) ? fav.tags : prevTags,
      savedAt: new Date().toISOString(),
    };
    if (idx >= 0) list[idx] = record;
    else list.push(record);
    await this._save();
    return record;
  }

  async removeFavorite(store, albumId) {
    const list = this._load();
    const key = this._key(store, albumId);
    this._favorites = list.filter((f) => this._key(f.store, f.albumId) !== key);
    await this._save();
    return this._favorites;
  }

  async exportFavorites(destFile) {
    this._ensureDir();
    await fsp.writeFile(destFile, JSON.stringify(this._load(), null, 2), 'utf8');
    return destFile;
  }

  /* ------------------------- TAGS / CATEGORIAS --------------------------- */

  _loadTags() {
    if (this._tags) return this._tags;
    try {
      const txt = fs.readFileSync(this.tagsFile, 'utf8');
      const arr = JSON.parse(txt);
      this._tags = Array.isArray(arr) ? arr : [];
    } catch (_) {
      // Seed inicial com as categorias sugeridas.
      this._tags = [
        'Camisa',
        'Boné',
        'Touca',
        'Gorro',
        'Short',
        'Calça',
        'Bermuda',
        'Casaco',
        'Jaqueta',
      ].map((name) => ({ name, kind: 'categoria' }));
    }
    return this._tags;
  }

  async _saveTags() {
    this._ensureDir();
    await fsp.writeFile(this.tagsFile, JSON.stringify(this._loadTags(), null, 2), 'utf8');
  }

  /** Lista o catalogo de tags. */
  listTags() {
    return this._loadTags();
  }

  /** Cria uma tag (categoria|marca). Ignora duplicadas do mesmo tipo (case-insensitive). */
  async addTag(name, kind) {
    const nm = String(name || '').trim();
    const k = kind === 'marca' ? 'marca' : 'categoria';
    if (!nm) return { tags: this.listTags(), added: false, reason: 'vazio' };
    const all = this._loadTags();
    const exists = all.some(
      (t) => t.name && t.name.toLowerCase() === nm.toLowerCase() && t.kind === k
    );
    if (exists) return { tags: this.listTags(), added: false, reason: 'duplicada' };
    all.push({ name: nm, kind: k });
    this._tags = all;
    await this._saveTags();
    return { tags: this.listTags(), added: true };
  }

  /** Remove uma tag do catalogo e de todos os favoritos. */
  async removeTag(name) {
    const all = this._loadTags();
    this._tags = all.filter((t) => t.name !== name);
    await this._saveTags();
    const favs = this._load();
    let changed = false;
    for (const f of favs) {
      if (Array.isArray(f.tags) && f.tags.includes(name)) {
        f.tags = f.tags.filter((x) => x !== name);
        changed = true;
      }
    }
    if (changed) await this._save();
    return this.listTags();
  }

  /** Define as tags de um favorito especifico. */
  async setFavoriteTags(store, albumId, tags) {
    const list = this._load();
    const key = this._key(store, albumId);
    const f = list.find((x) => this._key(x.store, x.albumId) === key);
    if (!f) return null;
    f.tags = Array.isArray(tags) ? [...new Set(tags.filter(Boolean))] : [];
    await this._save();
    return f;
  }

  /* ------------------- MARGEM DE LUCRO POR PRODUTO ----------------------- */

  _loadProfits() {
    if (this._profits) return this._profits;
    try {
      const txt = fs.readFileSync(this.profitsFile, 'utf8');
      const obj = JSON.parse(txt);
      this._profits = obj && typeof obj === 'object' ? obj : {};
    } catch (_) {
      this._profits = {};
    }
    return this._profits;
  }

  async _saveProfits() {
    this._ensureDir();
    await fsp.writeFile(this.profitsFile, JSON.stringify(this._loadProfits(), null, 2), 'utf8');
  }

  /** Retorna o mapa { url: pct } de margens salvas. */
  listProfits() {
    return this._loadProfits();
  }

  /**
   * Grava a margem de lucro (%) de um produto pela URL e, se existir um
   * favorito com esse link, tambem grava a margem no registro do favorito.
   * Passar pct null/undefined remove a margem.
   */
  async setProfit(url, pct) {
    if (!url) return this.listProfits();
    const profits = this._loadProfits();
    const clean = pct == null || pct === '' ? null : Math.max(0, Number(pct) || 0);
    if (clean == null) delete profits[url];
    else profits[url] = clean;
    this._profits = profits;
    await this._saveProfits();
    // Reflete a margem tambem no favorito cujo link principal seja essa URL.
    const favs = this._load();
    let changed = false;
    for (const f of favs) {
      const link = (f.externalLinks || [])[0];
      if (link === url) {
        if (clean == null) {
          if (f.profitPct != null) {
            delete f.profitPct;
            changed = true;
          }
        } else if (f.profitPct !== clean) {
          f.profitPct = clean;
          changed = true;
        }
      }
    }
    if (changed) await this._save();
    return this.listProfits();
  }

  /* ------------------- LINKS DE COMPRA POR SITE (permanente) ------------- */

  _loadStoreLinks() {
    if (this._storeLinks) return this._storeLinks;
    try {
      const txt = fs.readFileSync(this.storeLinksFile, 'utf8');
      const obj = JSON.parse(txt);
      this._storeLinks = obj && typeof obj === 'object' ? obj : {};
    } catch (_) {
      this._storeLinks = {};
    }
    return this._storeLinks;
  }

  async _saveStoreLinks() {
    return this._saveDebounced('storeLinks', this.storeLinksFile, () =>
      this._loadStoreLinks()
    );
  }

  /** Normaliza a loja para "https://sub.x.yupoo.com" (sem barra final). */
  static normalizeStore(store) {
    const s = String(store || '').trim().replace(/\/+$/, '');
    return s;
  }

  /**
   * Registra permanentemente os links de compra encontrados em um site.
   * So grava se houver ao menos um link. Deduplica.
   * @param {string} store url da loja
   * @param {string[]} links links de compra encontrados nos albuns
   */
  async recordStoreLinks(store, links) {
    const arr = (Array.isArray(links) ? links : [links]).filter(
      (l) => l && typeof l === 'string'
    );
    if (!arr.length) return this.listStoreLinks(); // sem link -> nao salva

    const key = Storage.normalizeStore(store);
    if (!key) return this.listStoreLinks();

    const all = this._loadStoreLinks();
    const entry = all[key] || { store: key, links: [], updatedAt: null };
    const set = new Set(entry.links);
    let changed = false;
    for (const l of arr) {
      if (!set.has(l)) {
        set.add(l);
        changed = true;
      }
    }
    if (changed) {
      entry.links = [...set];
      entry.updatedAt = new Date().toISOString();
      all[key] = entry;
      await this._saveStoreLinks();
    }
    return this.listStoreLinks();
  }

  /** Lista os sites salvos e seus links, ordenados por atualizacao recente. */
  listStoreLinks() {
    const all = this._loadStoreLinks();
    return Object.values(all).sort((a, b) =>
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    );
  }

  async removeStore(store) {
    const key = Storage.normalizeStore(store);
    const all = this._loadStoreLinks();
    if (all[key]) {
      delete all[key];
      await this._saveStoreLinks();
    }
    return this.listStoreLinks();
  }

  /** Exporta a lista permanente em texto, agrupada por site. */
  async exportStoreLinks(destFile) {
    this._ensureDir();
    const lines = [];
    for (const e of this.listStoreLinks()) {
      lines.push(e.store);
      for (const l of e.links) lines.push('  ' + l);
      lines.push('');
    }
    await fsp.writeFile(destFile, lines.join('\n'), 'utf8');
    return destFile;
  }

  /* --------------------- CACHE DE PRECOS (24 horas) ---------------------- */

  _loadPrices() {
    if (this._prices) return this._prices;
    try {
      const txt = fs.readFileSync(this.pricesFile, 'utf8');
      this._prices = JSON.parse(txt);
      if (!this._prices || typeof this._prices !== 'object') this._prices = {};
    } catch (_) {
      this._prices = {};
    }
    return this._prices;
  }

  async _savePrices() {
    return this._saveDebounced('prices', this.pricesFile, () => this._prices);
  }

  /**
   * Retorna o preco em cache se ainda for do mesmo dia (< 24h). Senao null.
   * @param {string} url
   */
  getCachedPrice(url) {
    if (!url) return null;
    const all = this._loadPrices();
    const e = all[url];
    if (!e || !e.ts) return null;
    const DAY = 24 * 60 * 60 * 1000;
    if (Date.now() - e.ts >= DAY) return null; // expirou -> atualizar hoje
    return e;
  }

  /** Grava/atualiza o preco de uma url no cache com timestamp. */
  async setCachedPrice(url, data) {
    if (!url || !data) return;
    const all = this._loadPrices();
    all[url] = { ...data, url, ts: Date.now() };
    this._prices = all;
    await this._savePrices();
  }

  /**
   * Retorna o preco ARMAZENADO de uma url, independente da idade (nunca expira
   * para exibicao). Use para mostrar o ultimo preco conhecido sem rebuscar.
   * @param {string} url
   */
  getStoredPrice(url) {
    if (!url) return null;
    const all = this._loadPrices();
    return all[url] || null;
  }

  /**
   * Retorna um mapa { url: precoArmazenado } para uma lista de urls, ignorando
   * a idade. Usado para exibir precos instantaneamente a partir do disco.
   * @param {string[]} urls
   */
  getStoredPrices(urls) {
    const all = this._loadPrices();
    const out = {};
    for (const url of urls || []) {
      if (url && all[url]) out[url] = all[url];
    }
    return out;
  }

  /* ------------- CACHE DE LINKS DOS ALBUNS (24 horas) -------------------- */

  _loadLinksCache() {
    if (this._linksCache) return this._linksCache;
    try {
      const txt = fs.readFileSync(this.linksCacheFile, 'utf8');
      this._linksCache = JSON.parse(txt);
      if (!this._linksCache || typeof this._linksCache !== 'object') this._linksCache = {};
    } catch (_) {
      this._linksCache = {};
    }
    return this._linksCache;
  }

  async _saveLinksCache() {
    return this._saveDebounced('linksCache', this.linksCacheFile, () => this._linksCache);
  }

  /** Retorna o mapeamento de links do album se ainda for do mesmo dia (< 24h). */
  getCachedAlbumLinks(store, id) {
    if (!store || !id) return null;
    const all = this._loadLinksCache();
    const e = all[`${store}::${id}`];
    if (!e || !e.ts) return null;
    const DAY = 24 * 60 * 60 * 1000;
    if (Date.now() - e.ts >= DAY) return null;
    return { hasLink: e.hasLink, externalLinks: e.externalLinks || [] };
  }

  /** Grava/atualiza o mapeamento de links de um album com timestamp. */
  async setCachedAlbumLinks(store, id, info) {
    if (!store || !id || !info) return;
    const all = this._loadLinksCache();
    all[`${store}::${id}`] = {
      hasLink: !!info.hasLink,
      externalLinks: info.externalLinks || [],
      ts: Date.now(),
    };
    this._linksCache = all;
    await this._saveLinksCache();
  }

  /* ------------- LOJAS COM PRECO VERIFICADO (permanente) ----------------- */

  _loadPricedStores() {
    if (this._pricedStores) return this._pricedStores;
    try {
      const txt = fs.readFileSync(this.pricedStoresFile, 'utf8');
      const obj = JSON.parse(txt);
      this._pricedStores = obj && typeof obj === 'object' ? obj : {};
    } catch (_) {
      this._pricedStores = {};
    }
    return this._pricedStores;
  }

  async _savePricedStores() {
    return this._saveDebounced('pricedStores', this.pricedStoresFile, () =>
      this._loadPricedStores()
    );
  }

  /** Lista as lojas salvas com preco, mais recentes primeiro. */
  listPricedStores() {
    const all = this._loadPricedStores();
    return Object.values(all).sort((a, b) =>
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    );
  }

  /** Salva/atualiza uma loja que possui albuns com preco. */
  async savePricedStore(store, info) {
    const key = Storage.normalizeStore(store);
    if (!key) return this.listPricedStores();
    const all = this._loadPricedStores();
    all[key] = {
      store: key,
      albums: (info && info.albums) || 0,
      links: (info && info.links) || 0,
      priced: (info && info.priced) || 0,
      seen: all[key] ? !!all[key].seen : false,
      reviewed: all[key] ? !!all[key].reviewed : false,
      updatedAt: new Date().toISOString(),
    };
    this._pricedStores = all;
    await this._savePricedStores();
    return this.listPricedStores();
  }

  /** Remove uma loja da lista de lojas com preco. */
  async removePricedStore(store) {
    const key = Storage.normalizeStore(store);
    const all = this._loadPricedStores();
    if (all[key]) {
      delete all[key];
      this._pricedStores = all;
      await this._savePricedStores();
    }
    return this.listPricedStores();
  }

  /** Marca/desmarca uma loja como "visto" ou "atualizado" (checagem manual). */
  async setPricedFlag(store, flag, value) {
    const key = Storage.normalizeStore(store);
    const all = this._loadPricedStores();
    if (!all[key]) return this.listPricedStores();
    if (flag === 'seen') all[key].seen = !!value;
    else if (flag === 'reviewed') all[key].reviewed = !!value;
    all[key].flagsAt = new Date().toISOString();
    this._pricedStores = all;
    await this._savePricedStores();
    return this.listPricedStores();
  }

  /* ------------------------- ALBUNS JA VISTOS ---------------------------- */

  _loadSeen() {
    if (this._seen) return this._seen;
    try {
      const txt = fs.readFileSync(this.seenFile, 'utf8');
      const obj = JSON.parse(txt);
      this._seen = obj && typeof obj === 'object' ? obj : {};
    } catch (_) {
      this._seen = {};
    }
    return this._seen;
  }

  async _saveSeen() {
    return this._saveDebounced('seen', this.seenFile, () => this._loadSeen());
  }

  /**
   * Retorna os IDs já vistos de uma loja: { ids, updatedAt, storeSeen }.
   * `storeSeen` = a loja inteira está marcada como "Visto" (nos priced-stores),
   * o que faz TODOS os álbuns dela contarem como vistos.
   */
  getSeen(store) {
    const key = Storage.normalizeStore(store);
    const all = this._loadSeen();
    const rec = all[key] || { ids: {}, updatedAt: null };
    const priced = this._loadPricedStores();
    const storeSeen = !!(priced[key] && priced[key].seen);
    return { ids: rec.ids || {}, updatedAt: rec.updatedAt || null, storeSeen };
  }

  /**
   * Marca uma lista de IDs de album como vistos para a loja.
   * Se a loja tiver links salvos, marca automaticamente como "visto".
   * @returns {Promise<{added:number,total:number}>}
   */
  async markSeen(store, ids) {
    const key = Storage.normalizeStore(store);
    if (!key) return { added: 0, total: 0 };
    const all = this._loadSeen();
    const rec = all[key] || { ids: {}, updatedAt: null };
    const now = new Date().toISOString();
    let added = 0;
    for (const raw of ids || []) {
      const id = String(raw == null ? '' : raw).trim();
      if (!id) continue;
      if (!rec.ids[id]) {
        rec.ids[id] = now;
        added += 1;
      }
    }
    rec.updatedAt = now;
    all[key] = rec;
    this._seen = all;
    await this._saveSeen();

    // Auto: se a loja tem links salvos, marca-a como "visto".
    const priced = this._loadPricedStores();
    if (priced[key] && !priced[key].seen) {
      priced[key].seen = true;
      priced[key].flagsAt = now;
      this._pricedStores = priced;
      await this._savePricedStores();
    }
    return { added, total: Object.keys(rec.ids).length };
  }


  /** Remove caracteres invalidos de nome de arquivo/pasta no Windows. */
  static sanitize(name) {
    return String(name || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'sem-nome';
  }

  /**
   * Baixa as fotos de um album para destRoot/<titulo>/.
   * @param {object} album resultado de scraper.fetchAlbum
   * @param {string} destRoot pasta escolhida pelo usuario
   * @param {(done:number,total:number)=>void} [onProgress]
   */
  async downloadAlbum(album, destRoot, onProgress) {
    const folder = path.join(destRoot, Storage.sanitize(album.title || album.id));
    await fsp.mkdir(folder, { recursive: true });

    const photos = album.photos || [];
    const referer = album.store ? album.store + '/' : undefined;
    let done = 0;
    const errors = [];

    // Grava tambem um manifest com os links da fonte.
    const manifest = {
      title: album.title,
      albumUrl: album.url,
      externalLinks: album.externalLinks || [],
      photoCount: photos.length,
      savedAt: new Date().toISOString(),
    };
    await fsp.writeFile(
      path.join(folder, '_info.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const src = p.origin || p.big || p.thumb;
      if (!src) continue;
      try {
        const res = await axios.get(src, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: { 'User-Agent': USER_AGENT, Referer: referer },
        });
        const ext = (path.extname(new URL(src).pathname) || '.jpg').split('?')[0];
        const fname = `${String(i + 1).padStart(3, '0')}${ext}`;
        await fsp.writeFile(path.join(folder, fname), res.data);
      } catch (err) {
        errors.push({ src, error: err.message });
      }
      done++;
      if (onProgress) onProgress(done, photos.length);
    }

    return { folder, total: photos.length, saved: photos.length - errors.length, errors };
  }
}

module.exports = Storage;
