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

**Testes** — não há runner nem `npm test`. O único teste é o smoke test: abra <http://localhost:5175/smoke.html>. Ele roda checks puros de `pixels.js` e depois carrega o editor real num iframe, dirige a UI com eventos sintéticos e verifica efeitos observáveis (status bar, toast, abas, grade). O veredito vai para o `<title>` (`SMOKE:PASS` / `SMOKE:FAIL`) e cada verificação é listada na página. Ele depende de `Test/icons/base.dmi` e `Test/icons/map.dmi` existirem sob a raiz padrão — mexer nesses arquivos quebra o teste.

Dá para rodar sem abrir o browser na mão:

```
node server.js &
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu \
  --virtual-time-budget=600000 --user-data-dir=<tmp> --dump-dom http://localhost:5175/smoke.html
```

e procurar `SMOKE:PASS` na saída. Três armadilhas do `--virtual-time-budget` (que adianta o relógio de uma vez), todas já resolvidas — não "simplifique" nenhuma:

- O `waitFor` conta **tentativas**, não `Date.now()` (o relógio salta e o timeout estouraria antes da condição virar).
- O evento `close` do `<dialog>` é assíncrono e chega tarde (às vezes muito). Por isso os diálogos de **Novo**, **Redimensionar** e **Importar** aplicam o efeito no **clique do botão OK** (síncrono), e não no `close` — que só faz limpeza. E a limpeza do import só roda **se não houver import aberto nem abrindo** (`impOpening`): um `close` atrasado do import anterior chega com o próximo diálogo já aberto e apagava o estado dele — o import novo simplesmente parava de responder. Foi um bug real, e **carimbar a sessão no listener não resolve**: o evento atrasado é entregue a *todos* os listeners registrados até ali, inclusive o do import novo. A pergunta certa não é "de quem é esse evento?", é "tem import aberto agora?".
- O orçamento é **tempo virtual**, e o teste consome bastante. Se ele terminar em `SMOKE:RODANDO` (em vez de PASS/FAIL), o orçamento acabou no meio: aumente. O log é renderizado a cada check, então o dump mostra onde parou.

## Arquitetura

Três invariantes explicam quase todas as decisões do código:

**1. Os pixels do DMI e do PNG nunca passam por `<canvas>`.** Canvas faz premultiplicação de alfa e perde bytes. Por isso o PNG é decodificado/codificado à mão em [lib/png.js](lib/png.js) (sobre o `zlib` nativo), inclusive no import — o arquivo é enviado cru pro servidor (`/api/import/png`) em vez de ir por `drawImage`. O canvas só é usado para **exibir**. Round-trip abrir → salvar devolve o arquivo byte a byte idêntico; qualquer mudança que introduza canvas nesse caminho quebra isso.

*Emenda (import de JPEG/WEBP/BMP/GIF).* Esses formatos o nosso codec não lê, e escrever um decoder JPEG à mão seria desproporcional. Eles são decodificados **no browser** pela API `ImageDecoder` (WebCodecs): `VideoFrame.copyTo({format:'RGBA'})` devolve RGBA **não premultiplicado**, também **sem tocar em canvas**. Isso não é fé — o smoke test *prova* (um PNG com `a=128, r=255` gerado pelo nosso encoder tem que voltar do `ImageDecoder` com `r=255`; se voltar `128`, o teste quebra). **Fallback:** navegador sem `ImageDecoder` cai em `createImageBitmap` + `OffscreenCanvas.getImageData`, que **passa por canvas** — exato para JPEG/BMP (sem alfa) e para alfa binário, mas pode variar 1/255 em pixels semitransparentes, e não lê animação. Quando esse caminho é usado, o diálogo de import avisa.

**2. Frames trafegam num envelope binário, nunca em base64/JSON.** Formato: `"DMIB" | u32LE tamanho-do-JSON | JSON (header) | pixels RGBA crus concatenados`. Implementado nos dois lados — `packEnvelope`/`unpackEnvelope` em [server.js](server.js) e [public/binio.js](public/binio.js). Usado em `/api/open`, `/api/save`, `/api/import/png`, `/api/export/gif`, `/api/export/png`. DMIs grandes de SS13 têm milhares de frames; base64 inflaria ~33% e o parse de JSON gigante travaria a aba. Ao mudar um endpoint, mude os dois lados do envelope juntos.

**3. Ordem dos frames.** Um `.dmi` é um PNG com chunk `zTXt` de keyword `Description` contendo a metadata em texto. Os frames ficam numa grade linear (esquerda→direita, cima→baixo), na ordem `state → frame → direção`, ou seja **índice = `frame * dirs + dir`** (helper `fidx` em [public/app.js](public/app.js)). Direções na ordem da BYOND: `S N E W SE SW NE NW`. `delay` em décimos de segundo. Ao gravar, a grade é montada com `ceil(sqrt(total_de_frames))` colunas (igual ao plugin do Aseprite). Todo esse fatiar/montar vive em [lib/dmi.js](lib/dmi.js).

### Mapa dos arquivos

| Arquivo | Papel |
|---|---|
| [lib/png.js](lib/png.js) | codec PNG (lê color type 0/2/3/4/6, bit depth 1–16, filtros 0–4, tRNS; grava RGBA8) |
| [lib/dmi.js](lib/dmi.js) | parse/build da metadata + fatiar/montar a spritesheet |
| [lib/gif.js](lib/gif.js) | encoder GIF89a (paleta por frequência, LZW, transparência, loop) |
| [server.js](server.js) | HTTP local: lista pastas, abre/grava, import/export, stat, renomear/duplicar/excluir |
| [public/pixels.js](public/pixels.js) | operações de pixel **puras** (sem DOM, sem estado global): desenho, região, HSL, transformações, redução dominante, paleta |
| [public/app.js](public/app.js) | toda a UI, num arquivo só, sem framework |
| [public/smoke.html](public/smoke.html) | smoke test |

### Import inteligente ([public/pixels.js](public/pixels.js))

`downsampleDominant` / `buildPalette` / `clearColorFlood` são um port do
[proper-pixel-art](https://github.com/KennethJAllen/proper-pixel-art) (MIT), usado pelo
diálogo de import. A regra que não pode ser quebrada: **nada de média/blur** — cada célula
vira a cor *dominante* dos seus pixels (binning com offset + mediana), o que descarta ruído
sem inventar cor que não existia. Decisões globais (paleta, cor do fundo) são tomadas
**uma vez sobre todos os frames**, nunca por frame — senão a animação cintila. A detecção
de malha Canny/Hough do original não foi portada de propósito: o icon size do DMI é
conhecido, a malha é uniforme.

### Import de imagem ([public/app.js](public/app.js), bloco "import de imagem")

O formato é decidido por **magic byte** (`sniffImageType`), nunca por `file.type` (vem vazio em muitos drops) nem por extensão (mente em arquivo renomeado). PNG estático → servidor (exato); APNG (chunk `acTL`) e os demais formatos → `ImageDecoder`.

Armadilhas do `ImageDecoder` que já custaram caro e estão resolvidas no código — não "simplifique" nenhuma:

- `copyTo` **não garante** stride `w*4` (pode vir com padding). Alocar `w*h*4` cego dá exceção ou imagem enviesada: usar `image.visibleRect` (não `codedWidth`, que tem padding, nem `displayWidth`, que carrega aspect ratio) e forçar o layout, com `destride` manual de reserva.
- `await dec.completed` **antes** de ler `frameCount`, senão vem `1` e `decode()` rejeita com `RangeError`.
- `preferAnimation: true`, senão um WEBP com track estática + animada importa 1 quadro.
- Delays: `image.duration` é em **microssegundos**, e o delay da BYOND é fracionário. Arredondar para décimo inteiro transformaria todo GIF de 20–25fps em 10fps — o editor suporta fração de ponta a ponta (`pDelay` tem `step=.5`, `dmi.js` grava verbatim).
- Decisões **globais** (paleta, cor do fundo) são tomadas sobre **todos** os frames de uma vez. Por frame, a animação cintila.

### A grade do import é explícita

A grade **não** é derivada de colunas/linhas: ela é seis números (`impGrid()`) — origem (`offX`,`offY`), tamanho da célula (`cw`,`ch`) e contagem (`cols`,`rows`). A célula `(cx,cy)` é o retângulo `[offX + cx*cw, offY + cy*ch, cw, ch]`, e é **o mesmo retângulo** que o overlay desenha e que a conversão recorta — a versão anterior calculava as bordas com `Math.round(cx*w/cols)` nos dois lugares, e qualquer diferença fazia o overlay mentir. Colunas/linhas e tamanho da célula são a mesma grade vista de dois jeitos e se recalculam (`impLink`); o **offset não mexe em nenhum dos dois** (nudge é nudge).

Consequência: a grade **pode sair da imagem**. `P.copyRegion` **não clampa** (`subarray` além do fim devolve linha curta, em silêncio) — todo recorte passa por `cutCell()`, que intersecta com a imagem e coloca o pedaço num buffer transparente do tamanho da célula.

### Um DMI pode não ter state nenhum

`doc.states` **pode ser um array vazio** (é válido, a BYOND aceita, e é justamente com ele vazio que o tamanho do ícone pode ser trocado à vontade — não há frame pra converter). Ou seja, **`curState()` pode ser `undefined` em qualquer lugar**. Cuidado com dois detalhes que já custaram um crash:

- `Math.min(sel.s, doc.states.length - 1)` vira **-1** com 0 states. Precisa de piso 0.
- `curState()?.frames[fidx(curState(), ...)]` **não** protege: o `fidx` é avaliado como argumento *antes* do `?.` curto-circuitar.

A UI tem três estados, não dois: sem doc (`#empty`), doc sem state (`#noStates`), e doc com state.

### Estado da UI ([public/app.js](public/app.js))

Sem framework: DOM direto, um `doc` global (o DMI aberto) mais `sel` (`{s, f, d}` = state/frame/direção). Múltiplos DMIs abertos = **abas**; `snapshotTab()`/`activateTab()` trocam o `doc` ativo, e cada aba tem seu próprio undo/redo.

Mutações devem passar pelos wrappers que empilham undo e disparam o refresh certo — `editFrame()` (pixels), `metaEdit()` (metadata do state), `structural()` (add/remove/reordenar state ou frame). Escrever em `doc` fora deles deixa o undo inconsistente. `targetFrames()` resolve o escopo das operações (frame atual vs. multi-seleção de células na grade), então efeitos novos (cor, espelho, deslocar) devem consumi-lo em vez de assumir o frame atual.

**A lixeira do state (`st.trim`).** Diminuir *Frames* ou *Direções* não destrói pixel: `resizeFrames()` guarda o que sai (buffer por `"frame:direção"` + o delay) e devolve se o número voltar — um campo numérico não pode ser destrutivo. O descarte só vira definitivo no **save** (`dropTrim` em todos os states). A lixeira é indexada por **índice de frame** e vale só pro **icon size atual**, então tudo que desloca índices (`splice` em `btnFrameDup`/`btnFrameDel`) ou troca o tamanho dos buffers (`resizeDocIcons`, state copiado/colado de outro DMI) **precisa descartá-la** — senão ela devolve o pixel errado, calado. `cloneDoc()` copia a lixeira **funda**: o `{...s}` compartilharia o objeto entre o snapshot de undo e o state vivo.

Segurança do arquivo do usuário: gravação sempre deixa `.bak`, e o editor vigia o `mtime` (5s) para detectar o Dream Maker regravando o arquivo por baixo (`/api/stat`; `/api/save` responde **409** se o mtime divergiu, e o client pede confirmação com `force`).

## Convenções

- ES modules (`"type": "module"`), Node ≥ 18. Sem transpilação: o que está em `public/` é servido como está.
- Código, comentários e mensagens de UI em **português**; comentários explicam o *porquê* (as decisões acima), não o óbvio.
- Sem dependências. Se algo parece pedir uma lib (codec, encoder), a resposta deste projeto tem sido escrever à mão — mantenha assim.

## Limitações conhecidas (não são bugs)

PNG entrelaçado (Adam7) não é lido — a BYOND não gera. `hotspot` é preservado no arquivo mas não tem UI. GIF exportado reduz para 256 cores.

## `assets/`

Contém `.dmi` de teste para os agentes de IA usarem. **Não commitar** — não está no `.gitignore` de propósito (senão os agentes não conseguiriam enxergar os arquivos). Veja [assets/AGENTS.md](assets/AGENTS.md).
