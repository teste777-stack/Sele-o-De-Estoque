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
- Documentação: README ampliado e `docs/ARCHITECTURE.md`.

### Alterado
- Badge "visto/novo" movido para o **canto superior direito** dos cards.
- Remoção de favorito agora é **instantânea** (sem loading bloqueante).
- `fetchPricesCached` garante o armazenamento de **todos** os preços buscados.

### Corrigido
- Seen não persistia quando `recordSeen` rodava após `renderPager`.
- Corrida de gravação concorrente que podia descartar escritas no cache.

### Removido / Bloqueado
- **Taobao/Tmall** deixaram de ser acessados (retornam como "ignorado").
- Álbuns vazios (sem capa/fotos) deixaram de aparecer na grade.
