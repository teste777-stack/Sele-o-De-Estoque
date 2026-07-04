# Arquitetura

Documento técnico de referência do **Yupoo Scraper**.

## Visão geral

Aplicação Electron com três camadas:

- **Main** (`src/main/`) — processo Node.js. Faz scraping, cache e I/O.
- **Preload** (`src/main/preload.js`) — expõe `window.electronAPI` de forma
  segura (`contextIsolation: true`, `nodeIntegration: false`).
- **Renderer** (`src/renderer/`) — interface (SPA) que só fala com o main via IPC.

```
Renderer  ──(electronAPI.invoke)──►  Preload  ──(ipcRenderer)──►  Main (handlers)
   ▲                                                                   │
   └───────────────── resposta { ok, data } / eventos ◄───────────────┘
```

## Padrão de IPC

Todo handler é embrulhado por `wrap()`:

```js
function wrap(handler) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  };
}
```

O renderer usa `call()` (com overlay de loading) ou `callQuiet()` (sem overlay,
para tarefas em segundo plano).

## Módulos do main

### `scraper.js`
- `fetchAlbums(store, page)` / `fetchCategoryAlbums(...)` — lista álbuns
  (pula os vazios via `isEmptyAlbum`).
- `fetchAlbum(store, id)` — fotos + links fonte (decodifica `/external?url=`).
- `fetchPrices(urls, cb, concurrency, shouldCancel)` — busca preços em lote.
- `fetchPrice(url)` — 1 preço; **Taobao/Tmall são ignorados**; tenta HTTP e cai
  para render headless quando necessário.
- `parsePriceFromText` / `priceFromText` — detecta preço no título do álbum.
- `getRates` / `convertCurrency` — câmbio (cache de 6h).

### `storage.js`
Persistência JSON em `%APPDATA%/yupoo-scraper/`.

- **Gravação robusta**: `_saveDebounced(key, file, getObj)` serializa e coalesce
  as escritas por arquivo, evitando corrida entre chamadas concorrentes.
  `flushSaves()` aguarda tudo antes de sair do app.
- Favoritos: `listFavorites`, `addFavorite`, `removeFavorite`.
- Cache de preços (24h): `getCachedPrice`, `setCachedPrice`.
- Cache de links de álbum (24h): `getCachedAlbumLinks`, `setCachedAlbumLinks`.
- Lojas precificadas: `listPricedStores`, `savePricedStore`, `setPricedFlag`.
- Vistos: `getSeen(store)` (inclui `storeSeen`), `markSeen(store, ids)`.
- Tags/lucros: `listTags`, `setProfit`, etc.

### `main.js`
- Helpers: `recordLinks`, `checkAlbumLinksCached`, `fetchPricesCached`,
  `beginLoading` / `shouldCancelLoading`.
- `fetchPricesCached` serve do cache e, para os itens "stale", busca e
  **garante gravação de todos** (callback progressivo + varredura final).
- Handlers IPC: `albums:*`, `categories:*`, `favorites:*`, `tags:*`,
  `profits:*`, `links:fetchPrices`, `prices:fromTitles`, `seen:get`,
  `seen:mark`, `bulk:*`, etc.

## Fluxo de "já visto"

1. Ao abrir álbuns, `ensureSeenLoaded()` carrega `getSeen(store)` →
   `state.seen` (IDs) e `state.seenAll` (loja marcada como "Visto").
2. `recordSeen(albums)` marca os exibidos em segundo plano (`markSeen`).
3. Um álbum aparece como visto se estiver em `state.seen` **ou** `state.seenAll`.

## Fluxo de preços

1. `maybeCheckLinks()` verifica links da página e busca preços por título.
2. Álbuns com link fonte usam `links:fetchPrices` → `fetchPricesCached`.
3. Resultados vão para `prices.json` (cache 24h) e são reexibidos ao voltar.

## Notas de segurança

- Sem `nodeIntegration` no renderer; toda ação passa pelo preload.
- Requisições com `User-Agent`/`Referer` de navegador para evitar `403`.
- Dados pessoais (favoritos, caches) ficam fora do Git via `.gitignore`.
