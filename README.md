# DMI Editor

Editor de sprites `.dmi` (BYOND) que roda local no navegador. Feito porque o editor de
ícones do Dream Maker demora demais pra abrir.

- **Zero dependências** — nada de `npm install`. Usa só o `zlib` nativo do Node (o PNG é
  lido e escrito na mão), então sobe instantâneo.
- **Sem perda** — os pixels nunca passam por `canvas` no caminho de leitura/gravação;
  o round-trip (abrir → salvar) devolve o arquivo byte a byte idêntico.
- Os arquivos gerados compilam no Dream Maker sem erros nem warnings.

## Rodar

```
start.cmd
```

Abre em <http://localhost:5175>. A pasta raiz padrão é a pasta **acima** do editor
(ex.: `Downloads\Byond`), então seus projetos aparecem na lista de Arquivos.

Para apontar pra outro lugar:

```
start.cmd "C:\caminho\do\projeto"
node server.js "C:\caminho" --port 5175
```

Link direto pra um arquivo: `http://localhost:5175/#Test/base.dmi`

## Atalhos

| Tecla | Ação |
|---|---|
| `B` `E` `G` `I` `L` `R` | lápis, borracha, balde, conta-gotas, linha, retângulo |
| Botão direito / `Shift` | apaga (com qualquer ferramenta de desenho) |
| `Alt` + clique | conta-gotas temporário |
| `Ctrl+Z` / `Ctrl+Y` | desfazer / refazer |
| `Ctrl+C` / `Ctrl+V` | copiar / colar o frame |
| `Ctrl+S` | salvar |
| `Del` | limpar o frame |
| Setas ←→ / ↑↓ | trocar de frame / de direção |
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

## Arquivos

| Arquivo | O que faz |
|---|---|
| `lib/png.js` | codec PNG (decodifica color type 0/2/3/4/6, bit depth 1–16, filtros 0–4, tRNS; grava RGBA8) |
| `lib/dmi.js` | metadata DMI + fatiar/montar a spritesheet |
| `server.js` | servidor local: lista pastas, abre e grava `.dmi` |
| `public/` | a interface (sem framework) |

## Limitações conhecidas

- PNG entrelaçado (Adam7) não é lido — a BYOND não gera esses arquivos.
- `hotspot` é preservado no arquivo, mas não há UI pra editar.
- Sem seleção retangular / mover região (só frame inteiro: espelhar, limpar, copiar/colar).
