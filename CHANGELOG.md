# Changelog

Registro do que funciona e das atualizações. Formato baseado em
[Keep a Changelog](https://keepachangelog.com/pt-BR/).

## [Não lançado]

### Adicionado
- Detecção de preço pelo **título** do álbum (exibido na grade).
- Campo **"Ir para página"** na paginação.
- Rastreamento **"já visto"** por loja (`seen-albums.json`) com badges
  **novo** / **✓ visto** na grade e nos favoritos.
- Flag de loja **"Visto"** que marca **todos** os álbuns da loja como vistos.
- Fila de **favoritos em segundo plano** (favoritar sem travar a UI).
- Botões manuais **Visto / Atualizado** por loja na aba Verificar.
- **Gravação serializada** (`_saveDebounced`) + `flushSaves()` ao sair,
  garantindo que preços/vistos/favoritos não se percam.
- **Cache LOCAL de imagens** (`image-cache/`, esquema `ycimg://`): cada foto/capa
  do Yupoo é baixada **uma vez** e servida do disco. Downloads em **fila
  limitada (5 por vez)** com dedupe, para o Yupoo não segurar as conexões.
- **Histórico de preços** (`price-history.json`): registra cada mudança do preço
  base por link (até 50 entradas por link).
- **Contador visual de captura** na barra de status: `Capturando fotos X/Y ·
  preços A/B`.
- **Logs de diagnóstico** do cache (`[cache]`) e dos favoritos (`[favoritos]`),
  ecoados também no terminal do Electron (canal `log:renderer`).
- Documentação: README ampliado e `docs/ARCHITECTURE.md`.

### Alterado
- Badge "visto/novo" movido para o **canto superior direito** dos cards.
- Remoção de favorito agora é **instantânea** (sem loading bloqueante).
- `fetchPricesCached` garante o armazenamento de **todos** os preços buscados.
- **Preços válidos nunca são re-buscados**: ficam salvos permanentemente e só as
  conversões **USD/BRL** são recalculadas com a cotação atual
  (`refreshConversions` + `updateConversions`). Só links que falharam são
  tentados de novo (após 24h).
- Overlay de carregamento agora mostra **texto** ("Carregando…", etc.).
- Favoritos: preços pelo nome calculados **incrementalmente** e sem travar a
  tela, evitando refazer o trabalho dos 2k+ itens a cada acesso.

### Corrigido
- Seen não persistia quando `recordSeen` rodava após `renderPager`.
- Corrida de gravação concorrente que podia descartar escritas no cache.
- **Preços sumindo / voltando a "pendente" após reiniciar**: o cache expirava em
  24h e a exibição dependia de rebuscar a cada carregamento. Agora os preços
  salvos são lidos do disco (`getStoredPrices` / `prices:getCached`) e exibidos
  na hora; só são buscados os links que nunca foram consultados.
- **Capas/fotos dos favoritos quebradas** ("carregadas pela metade"): o Yupoo
  bloqueava as centenas de requisições simultâneas. Resolvido com o cache local
  de imagens e a fila de downloads limitada.
- **Abrir favorito** usa as fotos já salvas (offline), sem depender da rede.

### Removido / Bloqueado
- **Taobao/Tmall** deixaram de ser acessados (retornam como "ignorado").
- Álbuns vazios (sem capa/fotos) deixaram de aparecer na grade.
