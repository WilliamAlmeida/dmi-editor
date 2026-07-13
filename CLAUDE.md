# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Editor de sprites `.dmi` (BYOND) que roda local no navegador. Node puro, **zero dependências** — nada de `npm install`, nada de build step, nada de framework. Respostas em português.

## Comandos

```
start.cmd                                  # sobe o servidor e abre o navegador
node server.js                             # idem, sem abrir o navegador
node server.js "C:\caminho" --port 5175    # outra pasta raiz / outra porta
```

A raiz padrão é a pasta **acima** do editor (`Downloads\Byond`), e é a coleira do servidor: nada fora dela é lido ou gravado (`safePath()` em [server.js](server.js)).

**Testes** — não há runner nem `npm test`. O único teste é o smoke test: abra <http://localhost:5175/smoke.html>. Ele carrega o editor real num iframe, dirige a UI com eventos sintéticos e verifica efeitos observáveis (status bar, toast, abas, grade). O veredito vai para o `<title>` (`SMOKE:PASS` / `SMOKE:FAIL`) e cada verificação é listada na página. Ele depende de `Test/base.dmi` existir sob a raiz padrão — rodar com outra raiz quebra o teste. Não dá para rodar sem browser; peça ao usuário para abrir e reportar, ou use uma ferramenta de browser.

## Arquitetura

Três invariantes explicam quase todas as decisões do código:

**1. Os pixels nunca passam por `<canvas>` no caminho de leitura/gravação.** Canvas faz premultiplicação de alfa e perde bytes. Por isso o PNG é decodificado/codificado à mão em [lib/png.js](lib/png.js) (sobre o `zlib` nativo), inclusive no import de PNG — o arquivo é enviado cru pro servidor (`/api/import/png`) em vez de ir por `drawImage`. O canvas só é usado para **exibir**. Round-trip abrir → salvar devolve o arquivo byte a byte idêntico; qualquer mudança que introduza canvas no meio quebra isso.

**2. Frames trafegam num envelope binário, nunca em base64/JSON.** Formato: `"DMIB" | u32LE tamanho-do-JSON | JSON (header) | pixels RGBA crus concatenados`. Implementado nos dois lados — `packEnvelope`/`unpackEnvelope` em [server.js](server.js) e [public/binio.js](public/binio.js). Usado em `/api/open`, `/api/save`, `/api/import/png`, `/api/export/gif`, `/api/export/png`. DMIs grandes de SS13 têm milhares de frames; base64 inflaria ~33% e o parse de JSON gigante travaria a aba. Ao mudar um endpoint, mude os dois lados do envelope juntos.

**3. Ordem dos frames.** Um `.dmi` é um PNG com chunk `zTXt` de keyword `Description` contendo a metadata em texto. Os frames ficam numa grade linear (esquerda→direita, cima→baixo), na ordem `state → frame → direção`, ou seja **índice = `frame * dirs + dir`** (helper `fidx` em [public/app.js](public/app.js)). Direções na ordem da BYOND: `S N E W SE SW NE NW`. `delay` em décimos de segundo. Ao gravar, a grade é montada com `ceil(sqrt(total_de_frames))` colunas (igual ao plugin do Aseprite). Todo esse fatiar/montar vive em [lib/dmi.js](lib/dmi.js).

### Mapa dos arquivos

| Arquivo | Papel |
|---|---|
| [lib/png.js](lib/png.js) | codec PNG (lê color type 0/2/3/4/6, bit depth 1–16, filtros 0–4, tRNS; grava RGBA8) |
| [lib/dmi.js](lib/dmi.js) | parse/build da metadata + fatiar/montar a spritesheet |
| [lib/gif.js](lib/gif.js) | encoder GIF89a (paleta por frequência, LZW, transparência, loop) |
| [server.js](server.js) | HTTP local: lista pastas, abre/grava, import/export, stat, renomear/duplicar/excluir |
| [public/pixels.js](public/pixels.js) | operações de pixel **puras** (sem DOM, sem estado global): desenho, região, HSL, transformações |
| [public/app.js](public/app.js) | toda a UI, num arquivo só, sem framework |
| [public/smoke.html](public/smoke.html) | smoke test |

### Estado da UI ([public/app.js](public/app.js))

Sem framework: DOM direto, um `doc` global (o DMI aberto) mais `sel` (`{s, f, d}` = state/frame/direção). Múltiplos DMIs abertos = **abas**; `snapshotTab()`/`activateTab()` trocam o `doc` ativo, e cada aba tem seu próprio undo/redo.

Mutações devem passar pelos wrappers que empilham undo e disparam o refresh certo — `editFrame()` (pixels), `metaEdit()` (metadata do state), `structural()` (add/remove/reordenar state ou frame). Escrever em `doc` fora deles deixa o undo inconsistente. `targetFrames()` resolve o escopo das operações (frame atual vs. multi-seleção de células na grade), então efeitos novos (cor, espelho, deslocar) devem consumi-lo em vez de assumir o frame atual.

Segurança do arquivo do usuário: gravação sempre deixa `.bak`, e o editor vigia o `mtime` (5s) para detectar o Dream Maker regravando o arquivo por baixo (`/api/stat`; `/api/save` responde **409** se o mtime divergiu, e o client pede confirmação com `force`).

## Convenções

- ES modules (`"type": "module"`), Node ≥ 18. Sem transpilação: o que está em `public/` é servido como está.
- Código, comentários e mensagens de UI em **português**; comentários explicam o *porquê* (as decisões acima), não o óbvio.
- Sem dependências. Se algo parece pedir uma lib (codec, encoder), a resposta deste projeto tem sido escrever à mão — mantenha assim.

## Limitações conhecidas (não são bugs)

PNG entrelaçado (Adam7) não é lido — a BYOND não gera. `hotspot` é preservado no arquivo mas não tem UI. GIF exportado reduz para 256 cores.

## `assets/`

Contém `.dmi` de teste para os agentes de IA usarem. **Não commitar** — não está no `.gitignore` de propósito (senão os agentes não conseguiriam enxergar os arquivos). Veja [assets/AGENTS.md](assets/AGENTS.md).
