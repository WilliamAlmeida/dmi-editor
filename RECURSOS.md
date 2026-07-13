# DMI Editor — Recursos

Referência completa de tudo que o editor faz. Para arquitetura e detalhes do formato,
veja o [README](./README.md).

## Como abrir

| Ação | Como |
|---|---|
| Iniciar | `start.cmd` → <http://localhost:5175> (raiz padrão: a pasta acima do editor) |
| Outra pasta raiz | `start.cmd "C:\caminho\do\projeto"` ou `node server.js "C:\caminho" --port 5175` |
| Link direto pra um arquivo | `http://localhost:5175/#Test/base.dmi` |
| Vários arquivos ao mesmo tempo | cada `.dmi` aberto vira uma **aba** no topo |

## Navegador de arquivos (painel esquerdo, topo)

- Navega pelas subpastas da raiz; lista só pastas e `.dmi`.
- Clique abre o arquivo (em nova aba, ou foca a aba se já estiver aberto).
- **Botão direito** num `.dmi` abre o menu: **Renomear**, **Duplicar**, **Excluir**.
- Com o mouse sobre a lista: **F2** renomeia, **Delete** exclui (com confirmação),
  **Ctrl+C** marca o arquivo e **Ctrl+V** cola uma cópia na pasta atual.
- **F2** em qualquer lugar renomeia o arquivo da aba ativa (se já estiver salvo).
- Renomear um arquivo aberto atualiza a aba automaticamente; excluir fecha a aba.

## Ferramentas de desenho (toolbar)

| Ferramenta | Tecla | Notas |
|---|---|---|
| Seleção | `M` | veja a seção Seleção |
| Lápis | `B` | respeita a espessura |
| Borracha | `E` | respeita a espessura |
| Balde | `G` | preenchimento por cor exata (RGBA) |
| Conta-gotas | `I` | ou `Alt`+clique com qualquer ferramenta |
| Linha | `L` | respeita a espessura |
| Retângulo | `R` | vazio, ou cheio com "preencher" marcado |

- **Espessura** (`esp.` na toolbar, ou teclas `[` e `]`): 1 a 16 px, vale pra lápis,
  borracha e linha.
- **Botão direito** ou `Shift` com qualquer ferramenta de desenho = apagar.
- **Espelho**: desenha simetricamente em relação ao eixo vertical central (a linha
  tracejada verde marca o eixo) — lápis, borracha, linha, retângulo e balde.
- **Onion skin**: mostra o frame anterior (30%) e o seguinte (15%) como fantasmas.
- **Grade**: linhas de pixel com marcação mais forte a cada 8px (some com zoom < 6x).
- Zoom: botões no topo, ou `Ctrl` + roda do mouse.

## Seleção (ferramenta `M`)

- Arraste para selecionar um retângulo (tracejado animado).
- **Arraste por dentro** da seleção para **mover os pixels** (recorta e flutua).
- **`Alt` + arrastar** por dentro move uma **cópia** (o original fica).
- **Setas** movem a seleção 1px (fazem o "lift" automaticamente).
- `Enter` ou clicar fora **confirma**; `Esc` **cancela** e devolve os pixels.
- `Ctrl+A` seleciona o frame inteiro. `Del` limpa o conteúdo selecionado.
- `Ctrl+C` / `Ctrl+X` / `Ctrl+V`: copiar / recortar / colar a região. A área de
  transferência é interna e funciona **entre frames, states e abas**; colar cria uma
  seleção flutuante centralizada que você arrasta pro lugar.
- Espelhar horizontal/vertical (botões ⇆ ⇅) atuam **só na seleção** quando há uma.
- Sem seleção, `Ctrl+C` copia o frame inteiro.

## Frames e direções (painel direito, embaixo)

- Grade **frames × direções** (S, N, E, W, SE, SW, NE, NW na ordem da BYOND).
- Clique numa célula edita aquele frame/direção.
- **Ctrl+clique seleciona várias células** — os efeitos passam a agir **só nelas**:
  - Matiz/Sat/Brilho e Substituir cor ganham o escopo "frames selecionados";
  - Espelhar H/V, `Del` (limpar) e `Shift`+setas (deslocar) atuam em todas as células
    selecionadas de uma vez.
  - Clique simples em qualquer célula desfaz a multi-seleção.
- Botões `+` / duplicar / `×` adicionam, duplicam (com delay) e removem frames.
- **Setas ←→** trocam de frame, **↑↓** trocam de direção (sem seleção ativa).
- **`Shift` + setas**: desloca o desenho do frame inteiro com wrap (os pixels que saem
  por um lado voltam pelo outro).

## Propriedades do state

- **Nome**, **Dirs** (1/4/8), **Frames**, **Delay** por frame (1 = 0,1s), **Loop**
  (0 = infinito), **rewind** (vai e volta), **movement** (animação de movimento da BYOND).
- Ao aumentar dirs (ex.: 4→8), as direções novas nascem copiando a dir S.
- **Gerar dir**: copia uma direção pra outra em todos os frames, com espelho opcional —
  ex.: `E → W espelhar` cria o lado esquerdo a partir do direito num clique.

## Icon states (painel esquerdo, embaixo)

- **Busca** por nome (thumbnails carregam sob demanda — aguenta DMI grande de SS13).
- Criar, duplicar, excluir, mover (botões ▲▼) ou **arrastar e soltar** pra reordenar.
- **⧉ state / ⇩ state**: copia o state inteiro e cola em **qualquer aba** — se o icon
  size for diferente, redimensiona (nearest) automaticamente.
- **Duplicatas**: encontra states 100% idênticos e frames repetidos dentro de um state;
  clicar no resultado navega até ele.
- **Importar PNG**: botão ou **arrastar o arquivo pra janela**. Se a imagem for múltiplo
  do icon size, fatia a grade (você escolhe as direções); senão, oferece redimensionar,
  centralizar ou alinhar no canto.

## Cores

- Seletor de cor + **alfa** (0–255).
- **★** salva a cor atual na paleta persistente (fica no navegador entre sessões).
- Grupos da paleta: **salvas**, **recentes** (alimentada a cada traço) e **arquivo**
  (extraídas do DMI aberto). Nas salvas e recentes, **botão direito remove** a cor.
- **Matiz/Saturação/Brilho** (`Ajustes de cor`): sliders com **preview ao vivo** no
  canvas (o diálogo fica na lateral e o fundo quase não escurece, justamente pra você
  ver a cor real). Escopos: frame atual / frames selecionados / state / DMI inteiro.
  Pixels 100% transparentes nunca são alterados.
- **Substituir cor**: troca um RGB exato por outro preservando o alfa, nos mesmos
  escopos. Informa quantos pixels trocou.

## Preview e exportação

- Preview animado na velocidade real da BYOND (delay em décimos de segundo, com rewind).
- **Scrub**: arrasta a timeline pra inspecionar frame a frame (pausa a animação).
- **GIF**: exporta a animação da direção atual (delays, loop e rewind respeitados;
  transparência preservada; paleta reduzida a 256 cores se precisar).
- **PNG folha**: abre um **lightbox** com a lista de states (escolha quais entram) e o
  **preview da folha** antes de baixar. Layout: uma linha por state, células na ordem
  frame×direção — o mesmo layout que o Importar PNG entende, então exportar → editar
  fora → importar fecha o ciclo.
- **PNG frame**: baixa só o frame atual.

## Arquivo e segurança

- **Salvar** (`Ctrl+S`) / **Salvar como** / **Novo** (dimensões livres até 512×512).
- **`.bak` automático**: toda gravação em cima de um arquivo existente deixa `nome.dmi.bak` do conteúdo anterior.
- **Detecção de mudança externa**: o editor vigia o mtime do arquivo aberto (5s).
  Se o Dream Maker (ou outro programa) regravar o arquivo: sem edições pendentes ele
  **recarrega sozinho**; com edições pendentes ele avisa, e o salvar pede confirmação
  antes de sobrescrever.
- **Redimensionar** (no topo): o DMI inteiro — escalar (nearest) ou cortar/expandir com
  âncora em 9 posições.
- Undo/redo por aba (`Ctrl+Z` / `Ctrl+Y`), com limite de memória — edições de pixel,
  metadata e operações estruturais, tudo reversível.
- O servidor só enxerga a pasta raiz — nada fora dela pode ser lido ou gravado.

## Atalhos — resumo

| Tecla | Ação |
|---|---|
| `M` `B` `E` `G` `I` `L` `R` | ferramentas |
| `[` / `]` | espessura do traço |
| Botão direito / `Shift` | apagar (desenhando) |
| `Alt` + clique | conta-gotas temporário |
| `Ctrl+Z` / `Ctrl+Y` | desfazer / refazer |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | copiar / recortar / colar (região ou frame) |
| `Ctrl+A` | selecionar tudo |
| `Enter` / `Esc` | confirmar / cancelar seleção flutuante |
| `Ctrl+S` | salvar |
| `Del` | limpar seleção / frames selecionados / frame |
| Setas | mover seleção · trocar frame (←→) / direção (↑↓) |
| `Shift` + setas | deslocar o desenho com wrap |
| `Ctrl` + roda | zoom |
| `F2` | renomear arquivo |
| Ctrl+clique (grade de frames) | multi-selecionar frames p/ efeitos |
| Botão direito (arquivo) | menu renomear/duplicar/excluir |
| Botão direito (cor salva/recente) | remove a cor da paleta |

## Verificação

- `http://localhost:5175/smoke.html` roda o smoke test da interface (título vira
  `SMOKE:PASS`); os codecs têm testes de round-trip byte a byte, e os arquivos gerados
  compilam no Dream Maker sem warnings.
