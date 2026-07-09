# Yupoo Scraper

Aplicativo desktop (**Electron + Node.js**) para navegar, arquivar, precificar e
baixar álbuns de lojas **Yupoo** de forma **manual e visual**.

> Uso privado. Utilize de forma responsável e respeite os termos de uso dos sites acessados.

---

## Recursos

### Navegação
- **Mega Grade** — todos os álbuns da loja com paginação e campo **"Ir para página"**.
- **Categorias** — lista as categorias e os álbuns de cada uma.
- **Múltiplas lojas** — cole qualquer URL Yupoo no topo e clique em _Carregar_.
- **Álbuns vazios ocultados** — álbuns sem capa/fotos não aparecem na grade.

### Links e preços
- **Badge de link antes de abrir** — ative _"Verificar links da página"_ para
  descobrir, sem abrir o álbum, quais têm link fonte (`✓ tem link` / `— sem link`).
- **Detecção de preço pelo título** — quando o nome do álbum contém um valor
  (ex.: `CNY 128`, `¥99`), o preço é exibido direto na grade e **salvo em disco**.
- **Busca de preço no link fonte** — abre o link (weidian/mulebuy/1688 etc.) e
  extrai o preço, convertendo para BRL/USD. **Todo preço é salvo em `prices.json`
  e persiste entre sessões.**
- **Weidian via Superbuy** — Weidian usa HTTP/2 e rejeita raspagem direta com
  Puppeteer; o app usa o Superbuy como proxy para obter o preço sem erros.
- **Taobao/Tmall via Superbuy** — idem; o Superbuy resolve o produto e expõe o preço.
- **Cache permanente** — preços válidos ficam salvos para sempre (sem re-raspagem).
  Falhas expiram em 24h. Gravação atômica (nunca corrompe o arquivo ao fechar).
- **Botão ↻ Preço** — em cada card de favorito, força re-busca imediata do preço
  (apaga a falha do cache e tenta novamente, inclusive via Superbuy).
- **Sweep automático Superbuy** — ao abrir a aba Favoritos, itens sem preço válido
  são enviados em segundo plano para o fluxo Superbuy automaticamente.

### Favoritos (armazenamento principal)
- Arquive álbuns; guarda título, capa, contagem, **categoria de origem**, links
  fonte e a lista de fotos. Persistido em `favorites.json` (gravação atômica).
- **16 000+ favoritos suportados** — paginação de 120 cards por vez evita congelamento.
- **Fila em segundo plano** — favoritar/desfavoritar é otimista e não trava a UI.
- **Tags** — organize favoritos por categoria/marca e filtre por elas.
- **Remoção instantânea** — ao excluir, o card some na hora (sem loading).

### "Já visto" (novo/visto)
- Cada álbum recebe badge **novo** ou **✓ visto** (canto superior direito).
- Os IDs vistos são registrados por loja em `seen-albums.json`.
- Marcar uma **loja inteira como "Visto"** faz todos os álbuns dela contarem como
  vistos, inclusive os de categoria e favoritos.

### Fotos e sessão
- **Salvar fotos** — baixa todas as imagens em resolução original para uma pasta
  escolhida, com um `_info.json` de manifesto.
- **Links da sessão** — todos os links acessados ficam registrados e exportáveis.

---

## Como rodar

```powershell
npm install
npm start
```

Modo com logs:

```powershell
npm run dev
```
```

---

## Estrutura

```
src/
  main/
    main.js       # processo principal Electron + handlers IPC
    preload.js    # ponte segura (window.electronAPI)
    scraper.js    # scraping (axios + cheerio) e render de preço (puppeteer)
    browser.js    # controle do navegador headless (puppeteer)
    storage.js    # persistência JSON (favoritos, caches, vistos, tags…)
  renderer/
    index.html    # interface (SPA)
    styles.css    # estilos
    renderer.js   # lógica da UI
```

Veja detalhes técnicos em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Onde ficam os dados

Todos em `%APPDATA%/yupoo-scraper/` (Windows):

| Arquivo | Conteúdo |
| --- | --- |
| `favorites.json` | Favoritos arquivados (armazenamento principal). |
| `store-links.json` | Links fonte por loja. |
| `prices.json` | Cache de preços (validade 24h). |
| `album-links.json` | Cache de "tem link?" por álbum (24h). |
| `priced-stores.json` | Lojas precificadas + flags "Visto"/"Atualizado". |
| `seen-albums.json` | IDs de álbuns já vistos por loja. |
| `tags.json` | Tags (categoria/marca). |
| `profits.json` | Percentuais de lucro. |

> Esses arquivos **não** vão para o Git (dados pessoais). Ver `.gitignore`.

---

## Confiabilidade das gravações

- As escritas em disco são **serializadas e coalescidas** por arquivo
  (`_saveDebounced`), evitando corrida entre gravações concorrentes.
- Ao fechar o app, `flushSaves()` garante que gravações pendentes terminem.
- Resultado: preços, vistos e favoritos **não se perdem** durante ou após o uso.

---

## Observações técnicas

- Requisições usam `User-Agent` de navegador e `Referer` da loja para evitar `403`.
- O link externo do Yupoo vem em dupla codificação (`/external?url=...`) e é
  decodificado automaticamente.
- Verificação de links sob demanda com concorrência limitada (5 por vez).
- Preços são convertidos usando cotações em cache (6h).

---

## Licença

MIT. Uso privado.
