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
- **Diminuir Frames (ou Dirs) não apaga os pixels**: o que sai fica **guardado** e volta
  inteiro se você aumentar o número de novo (com o delay junto) — um aviso embaixo diz quantos
  frames estão guardados. O descarte só vira definitivo quando você **salva** o arquivo.
  Excluir um frame pelo botão (✕) é destrutivo de verdade: ele desloca os índices e descarta o
  que estava guardado (aí é o `Ctrl+Z` que salva você).
- **Gerar dir**: copia uma direção pra outra em todos os frames, com espelho opcional —
  ex.: `E → W espelhar` cria o lado esquerdo a partir do direito num clique.

## Icon states (painel esquerdo, embaixo)

- **Busca** por nome (thumbnails carregam sob demanda — aguenta DMI grande de SS13).
- Criar, duplicar, excluir, mover (botões ▲▼) ou **arrastar e soltar** pra reordenar.
- Dá pra **excluir todos** os states: um DMI sem state nenhum é válido, e é justamente aí que
  o **tamanho do ícone pode ser trocado à vontade** (não há frame pra converter). `Ctrl+Z`
  traz o state de volta.
- **⧉ state / ⇩ state**: copia o state inteiro e cola em **qualquer aba** — se o icon
  size for diferente, redimensiona (nearest) automaticamente.
- **Duplicatas**: encontra states 100% idênticos e frames repetidos dentro de um state;
  clicar no resultado navega até ele.
- **Importar imagem** (**PNG, JPEG, WEBP, BMP, GIF**): botão ou **arrastar o arquivo pra
  janela**. **GIF/WEBP animado vira um state animado**: cada quadro do arquivo é um frame,
  com os **delays** convertidos pra escala da BYOND (inclusive fracionários — um GIF de
  25fps vira `delay = 0.4`, não é esmagado pra 0,1s) e o **loop** preservado. Numa fonte
  animada, a grade e o seletor de direções somem: cada quadro é um frame, ponto.

  O diálogo ocupa a tela e mostra, lado a lado: a **imagem original com a grade desenhada por
  cima** (ao vivo), as **miniaturas de todos os frames** que vão entrar, e um **zoom** com o
  recorte original e o frame resultante grandes, sobre xadrez — passe o mouse numa miniatura
  (ou na imagem) e ele acompanha. É a única forma de julgar a remoção do fundo: o que virou
  transparente aparece como xadrez, grande. **Clique numa célula** (na imagem ou na miniatura)
  pra excluí-la do import; **Alt+clique pega a cor do fundo** (no zoom, pega o pixel exato do
  frame **já convertido** — a cor que a remoção vai realmente comparar).

  **A grade**: digite **colunas/linhas** *ou* o **tamanho da célula** — um recalcula o outro —
  e ajuste o **offset X/Y**, ou simplesmente **arraste a grade** com o mouse em cima da
  imagem. O offset não muda o tamanho da célula (nudge é nudge): a grade pode passar da borda,
  e o que fica de fora entra como **transparente** (a área que a grade não cobre aparece
  escurecida). Serve pra spritesheet com margem, com o sprite fora do centro da célula, ou pra
  recortar só um pedaço da imagem.

  Escolha como converter:
  - **fatiar (corte exato)** — cada célula vira um frame, byte a byte. Só existe quando a
    célula tem exatamente o tamanho do ícone; senão o modo aparece desabilitado, dizendo
    por quê. Quando a imagem é múltiplo do icon size, a grade real já vem preenchida (ex.:
    4×2, não 1×1) e este é o modo pré-selecionado.
  - **reduzir por cor dominante** — recupera pixel art de verdade a partir de sprite
    gerado por IA ou screenshot em alta resolução (veja o [README](./README.md#reduzir-sprite-de-ia)).
    Funciona com qualquer grade: fatia a fonte em colunas × linhas e reduz cada célula.
  - **redimensionar (nearest)**, **centralizar** ou **alinhar no canto** — os modos secos,
    bons pra pixel art que já está limpa, só fora de escala.
- **Usar a célula como tamanho do ícone**: se a imagem se encaixa numa grade cujas células
  não são do tamanho do ícone (ex.: 137×180 num DMI 32×32), dá pra adotar o tamanho da
  célula como o novo tamanho do ícone do DMI. Num **DMI sem states** a troca é direta; com
  states, ele avisa quantos frames existentes serão convertidos e deixa escolher entre
  **escalar (nearest)** ou **manter os pixels (centralizado)**. Ctrl+Z desfaz tudo de uma vez.
- **Cores** (0 = todas) no import: reduz a paleta (median cut) usando **todos os frames de
  uma vez**, pra animação não trocar de cor a cada frame. O preview mostra quantas cores
  o resultado tem.
- **Fundo** no import: *manter*; *remover só o que encosta na borda* (flood — preserva
  pixels da cor do fundo cercados pelo sprite); ou *remover a cor inteira, onde estiver*.
  A cor vem detectada da borda da **imagem original** (e é decidida **uma vez** pra todos
  os frames), mas você pode **escolhê-la no seletor de cor** ou pegá-la com **Alt+clique**
  na imagem, numa miniatura ou no **zoom** — nem todo fundo é branco.
  A remoção acontece **na imagem original, antes da redução**: em alta resolução o **halo**
  de anti-aliasing (a mistura entre o fundo e o contorno) é uma rampa fina de 1–2 pixels, e
  a redução dominante descarta sozinha o que sobra dela — a célula na borda do sprite pega
  a cor do *sprite*, não um cinza misturado. É isso que faz a borda sair *pixel perfect* em
  vez de borrada. A **tolerância** (0–200) cobre o ruído do fundo (JPEG e imagem de IA
  nunca têm fundo chapado); com valores altos use *só o que encosta na borda* (flood) —
  *a cor inteira* com tolerância alta come o miolo do sprite.
  Quando a imagem não tem alfa nenhum (JPEG e BMP nunca têm) e a borda é de uma cor só,
  o *flood* já vem marcado — mas só nesse caso: numa **foto**, onde o fundo não é chapado,
  ele fica desmarcado pra não mutilar a imagem.
- **Tolerância por frame**: além da global, cada frame pode ter a sua — o slider
  "tolerância deste frame" fica no painel de zoom e segue o frame que está lá (passe o
  mouse numa miniatura pra mirar). Serve pra folha onde uma célula tem fundo mais sujo que
  as outras. Frames com tolerância própria ficam com a **borda destacada na miniatura**, e
  "usar a global" desfaz o override. A *cor* do fundo continua uma só pra todos (senão
  animação cintila) — e numa fonte animada o diálogo avisa que tolerância por quadro
  também pode cintilar. Mudar a grade (contagem de células) descarta os overrides.
- **Autotile** (botão no painel de states): gera **16 states** a partir do state atual,
  nomeados pelo número da junção na convenção de dirs da BYOND (**N=1, S=2, E=4, W=8**;
  bit ligado = tem vizinho; 15 = cercado = o tile intacto). Cada variante ganha, nos lados
  **expostos**: sombreamento (topo/esquerda clareiam, baixo/direita escurecem), **contorno**
  escurecido e **canto arredondado** onde dois lados expostos se encontram. Sombra, contorno,
  canto e o prefixo do nome são ajustáveis, com preview 4×4 ao vivo; o state original não é
  tocado e `Ctrl+Z` desfaz os 16 de uma vez. Herda frames e direções do state base.

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
- **Textura** (`Ajustes de cor`): preenche com **ruído** (grãos, com tamanho de grão
  ajustável) ou **voronoi** (células tipo pedra/cobblestone), usando até 4 cores — o
  diálogo já abre com variações da cor atual (base, sombra, luz). **Determinística por
  semente**: o preview ao vivo é exatamente o resultado, e a mesma semente reproduz sempre
  o mesmo padrão ("sortear" troca a semente). Com uma **seleção** ativa preenche só o
  retângulo; "só onde já tem pixel" preserva o alfa (textura por cima do sprite), desmarcado
  preenche tudo (bom pra turf). Escopo: este frame ou os frames selecionados na grade.

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
- **Escala** (1× a 8×): amplia qualquer export por nearest (pixel perfect, sem borrão) —
  bom pra postar em fórum/Discord, onde 32×32 vira um selo ilegível. Vale pro GIF, pra
  folha e pro frame; o nome do arquivo ganha o sufixo (`_4x`).

## Arquivo e segurança

- **Salvar** (`Ctrl+S`) / **Salvar como** / **Novo** (dimensões livres até 512×512).
- **`.bak` automático**: toda gravação em cima de um arquivo existente deixa `nome.dmi.bak` do conteúdo anterior.
- **Detecção de mudança externa**: o editor vigia o mtime do arquivo aberto (5s).
  Se o Dream Maker (ou outro programa) regravar o arquivo: sem edições pendentes ele
  **recarrega sozinho**; com edições pendentes ele avisa, e o salvar pede confirmação
  antes de sobrescrever.
- **Redimensionar** (no topo): o DMI inteiro — escalar (nearest) ou cortar/expandir com
  âncora em 9 posições. Num DMI **sem states** a troca é livre (não há frame pra converter).
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
