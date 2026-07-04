'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expoe uma API segura ao renderer via window.api.
 * Todas as chamadas retornam { ok, data } ou { ok:false, error }.
 */
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('electronAPI', {
  // Loja
  validateStore: (store) => invoke('store:validate', store),

  // Albuns
  listAlbums: (store, page) => invoke('albums:list', store, page),
  getAlbum: (store, albumId) => invoke('albums:get', store, albumId),
  checkLinks: (store, ids, concurrency) => invoke('albums:checkLinks', store, ids, concurrency),

  // Categorias
  listCategories: (store) => invoke('categories:list', store),
  categoryAlbums: (store, categoryId, page) => invoke('categories:albums', store, categoryId, page),

  // Favoritos
  listFavorites: () => invoke('favorites:list'),
  addFavorite: (fav) => invoke('favorites:add', fav),
  removeFavorite: (store, albumId) => invoke('favorites:remove', store, albumId),
  isFavorite: (store, albumId) => invoke('favorites:isFavorite', store, albumId),
  exportFavorites: () => invoke('favorites:export'),

  // Tags / categorias dos favoritos
  listTags: () => invoke('tags:list'),
  addTag: (name, kind) => invoke('tags:add', name, kind),
  removeTag: (name) => invoke('tags:remove', name),
  setFavoriteTags: (store, albumId, tags) => invoke('favorites:setTags', store, albumId, tags),

  // Margem de lucro por produto (persistente)
  listProfits: () => invoke('profits:list'),
  setProfit: (url, pct) => invoke('profits:set', url, pct),

  // Links de compra por site (permanente)
  sessionLinks: () => invoke('session:links'),
  exportSessionLinks: () => invoke('session:export'),
  removeStoreLinks: (store) => invoke('session:removeStore', store),

  // Precos dos links de compra
  fetchPrices: (urls) => invoke('links:fetchPrices', urls),
  cancelLoading: () => invoke('loading:cancel'),
  getCachedPrices: (urls) => invoke('prices:getCached', urls),
  pricesFromTitles: (items) => invoke('prices:fromTitles', items),
  onPriceProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('prices:progress', listener);
    return () => ipcRenderer.removeListener('prices:progress', listener);
  },

  // Verificacao de precos em varias lojas
  bulkCheckStores: (urls) => invoke('bulk:checkStores', urls),
  listPricedStores: () => invoke('bulk:listPriced'),
  removePricedStore: (store) => invoke('bulk:removePriced', store),
  setPricedFlag: (store, flag, value) => invoke('bulk:setPricedFlag', store, flag, value),
  getSeen: (store) => invoke('seen:get', store),
  markSeen: (store, ids) => invoke('seen:mark', store, ids),
  onBulkProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('bulk:progress', listener);
    return () => ipcRenderer.removeListener('bulk:progress', listener);
  },

  // Download
  chooseFolder: () => invoke('dialog:chooseFolder'),
  downloadAlbum: (album, destRoot) => invoke('album:download', album, destRoot),
  onDownloadProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('download:progress', listener);
    return () => ipcRenderer.removeListener('download:progress', listener);
  },

  // Utilidades
  openExternal: (url) => invoke('shell:openExternal', url),

  // Log do renderer que também aparece no terminal do Electron (processo main).
  log: (msg) => ipcRenderer.send('log:renderer', msg),

  // Pré-cache de imagens em segundo plano (baixa todas as que faltam no disco).
  prefetchImages: (urls) => invoke('cache:prefetchImages', urls),
  onCacheProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('cache:progress', listener);
    return () => ipcRenderer.removeListener('cache:progress', listener);
  },

  // Motor de navegador (Puppeteer / Brave)
  configureEngine: (cfg) => invoke('engine:configure', cfg),
  engineStatus: () => invoke('engine:status'),
  detectBrave: () => invoke('engine:detectBrave'),
  closeEngine: () => invoke('engine:close'),
});
