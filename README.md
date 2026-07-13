# DMI Editor

Editor de sprites `.dmi` (BYOND) que roda local no navegador. Feito porque o editor de
ícones do Dream Maker demora demais pra abrir.

> 📖 A referência completa de recursos e atalhos está em [RECURSOS.md](./RECURSOS.md).

- **Zero dependências** — nada de `npm install`. PNG e GIF são codificados na mão sobre o
  `zlib` nativo do Node, então sobe instantâneo.
- **Sem perda** — os pixels nunca passam por `canvas` no caminho de leitura/gravação;
  o round-trip (abrir → salvar) devolve o arquivo byte a byte idêntico.
- Os arquivos gerados compilam no Dream Maker sem erros nem warnings.

## Rodar

```
start.cmd
```

Abre em <http://localhost:5175>. A pasta raiz padrão é a pasta **acima** do editor
(ex.: `Downloads\Byond`). Para apontar pra outro lugar: `start.cmd "C:\caminho"`.
Link direto pra um arquivo: `http://localhost:5175/#Test/base.dmi`

## Funcionalidades

**Desenho** — lápis, borracha, balde, conta-gotas, linha, retângulo (vazio/cheio);
botão direito ou `Shift` apaga; `Alt`+clique pega a cor; modo **espelho** (simetria
vertical, ótimo pra sprites de frente); grade com marcação a cada 8px.

**Seleção** (`M`) — arraste pra selecionar; arraste por dentro pra **mover** os pixels;
`Alt`+arrastar move uma **cópia**; setas dão nudge de 1px; `Ctrl+C/X/V` copiam/recortam/colam
a região (a colagem fica flutuante até `Enter`/clicar fora; `Esc` cancela); `Ctrl+A` seleciona
tudo; `Del` limpa; espelhar horizontal/vertical respeita a seleção.

**Animação** — preview em velocidade real da BYOND (delay 1 = 0,1s, com `rewind`);
**scrub** de timeline; **onion skin** (frame anterior/seguinte como fantasma);
`Shift`+setas deslocam o frame inteiro com wrap; grade frames×direções clicável.

**States** — criar, duplicar, excluir, reordenar (setas ou **arrastar e soltar**);
**busca por nome** (essencial em DMIs grandes); copiar/colar **state entre arquivos**
(redimensiona se o icon size for outro); detector de **duplicatas** (states idênticos e
frames repetidos dentro de um state); **gerar direções** (ex.: W = E espelhado) em um clique.

**Cores** — paleta com três grupos: **salvas** (★ salva a cor atual; persiste no navegador;
botão direito remove), **recentes** e **do arquivo**; **Matiz/Saturação/Brilho** com preview
ao vivo e escopo *frame / state / DMI inteiro* — perfeito pra criar variações de cor de um
item; **Substituir cor** exata (preserva alfa) nos mesmos escopos.

**Arquivos** — **abas** (vários DMIs abertos ao mesmo tempo); **`.bak` automático** antes de
sobrescrever; **detecção de mudança externa** (se o Dream Maker regravar o arquivo, o editor
recarrega — ou avisa, se você tiver edição pendente); **Redimensionar DMI** inteiro
(escalar nearest, ou cortar/expandir com âncora).

**Importar/Exportar** — arraste um **PNG** pra dentro (ou botão Importar): vira um state
novo, fatiando a grade automaticamente se o tamanho for múltiplo do icon size;
exportar **GIF animado** da direção atual, **spritesheet PNG** do state
(colunas = direções, linhas = frames — o mesmo layout que o import entende) ou o
**frame atual** como PNG.

## Atalhos

| Tecla | Ação |
|---|---|
| `M` `B` `E` `G` `I` `L` `R` | seleção, lápis, borracha, balde, conta-gotas, linha, retângulo |
| Botão direito / `Shift` | apaga (com qualquer ferramenta de desenho) |
| `Alt` + clique | conta-gotas temporário |
| `Ctrl+Z` / `Ctrl+Y` | desfazer / refazer |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | copiar / recortar / colar (seleção ou frame) |
| `Ctrl+A` | selecionar tudo |
| `Enter` / `Esc` | confirmar / cancelar seleção flutuante |
| `Ctrl+S` | salvar |
| `Del` | limpar seleção (ou o frame) |
| Setas | mover seleção · sem seleção: trocar frame (←→) / direção (↑↓) |
| `Shift` + setas | deslocar o frame inteiro (com wrap) |
| `Ctrl` + roda do mouse | zoom |

## O formato DMI

Um `.dmi` é um PNG normal com um chunk `zTXt` de keyword `Description` contendo a
metadata em texto:

```
# BEGIN DMI
version = 4.0
	width = 32
	height = 32
state = "walk"
	dirs = 4
	frames = 2
	delay = 1,1
	movement = 1
# END DMI
```

Os frames ficam numa grade (esquerda→direita, cima→baixo), na ordem
`state → frame → direção`, ou seja índice `frame * dirs + dir`. As direções seguem a
ordem da BYOND: `S N E W SE SW NE NW`. `delay` é em décimos de segundo (`1` = 0,1s).
Ao salvar, a grade é montada com `ceil(sqrt(total_de_frames))` colunas — igual ao
plugin oficial do Aseprite.

## Arquitetura

| Arquivo | O que faz |
|---|---|
| `lib/png.js` | codec PNG (decodifica color type 0/2/3/4/6, bit depth 1–16, filtros 0–4, tRNS; grava RGBA8) |
| `lib/dmi.js` | metadata DMI + fatiar/montar a spritesheet |
| `lib/gif.js` | encoder GIF89a (paleta por frequência, LZW, transparência, loop) |
| `server.js` | servidor local: lista pastas, abre/grava `.dmi`, import/export, stat |
| `public/pixels.js` | operações de pixel puras (desenho, região, HSL, transformações) |
| `public/binio.js` | protocolo binário client (frames nunca viram base64/JSON) |
| `public/app.js` | a interface (sem framework) |
| `public/smoke.html` | smoke test que dirige a UI real com eventos sintéticos |

Frames trafegam entre client e servidor num envelope binário
(`"DMIB" + u32 tamanho-do-JSON + JSON + RGBA cru`) — em arquivos grandes do SS13 isso
evita o inchaço de ~33% e o parse de JSON gigante que base64 causaria.

Para rodar o smoke test: abra `http://localhost:5175/smoke.html` (o título vira
`SMOKE:PASS`/`SMOKE:FAIL` e a página lista cada verificação).

## Limitações conhecidas

- PNG entrelaçado (Adam7) não é lido — a BYOND não gera esses arquivos.
- `hotspot` é preservado no arquivo, mas não há UI pra editar.
- GIF exportado reduz pra 256 cores (limitação do formato; em pixel art não muda nada).
