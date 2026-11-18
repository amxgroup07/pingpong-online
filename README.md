# Ping Pong Online 🏓

Tênis de mesa 3D no navegador para jogar 1x1 com um amigo pela internet (ou treinar contra o computador).
É um site estático (`index.html` + `game.js`), então roda de graça na Vercel. Na Vercel, o `index.html` lê o `version.txt` (sem cache) e carrega o `game.js` daquele commit pelo jsDelivr (`/v/<commit>/game.js`), então cada atualização chega na hora, sem cache velho.

## Como funciona

- **Gráficos:** Three.js (carregado por CDN) com pós-processamento (bloom, tone mapping ACES, vinheta),
  arena com torcida animada, holofotes com feixes de luz, placas de LED, telões com placar, partículas,
  câmera dinâmica (entrada cinematográfica, tremida no smash) e som sintetizado de torcida e batidas.
- **Qualidade:** botão **HD / LEVE** no canto. Celular começa no modo leve; se o FPS cair no modo HD,
  o jogo troca sozinho para o leve.
- **Online:** WebRTC via PeerJS. Os dois navegadores se conectam **direto um no outro**; o servidor público
  gratuito do PeerJS só serve para fazer a "apresentação" inicial. Por isso não precisa de backend.
  A Vercel só hospeda os arquivos (as funções serverless dela não mantêm conexões em tempo real abertas).
- **Sem lag na hora de bater:** quem está recebendo a bola é quem decide se rebateu ou errou, na própria
  máquina. Depois manda a nova trajetória para o outro. Assim a raquete responde na hora para os dois.

## Publicar na Vercel

### Opção A: pelo site (sem instalar nada)
1. Crie um repositório no GitHub (ex.: `pingpong-online`) e envie o `index.html` e o `game.js` (botão *Add file → Upload files*).
2. Entre em https://vercel.com → **Add New… → Project** → importe esse repositório.
3. Framework Preset: **Other**. Não precisa de build command. Clique em **Deploy**.
4. Pronto: vai sair uma URL tipo `https://pingpong-online.vercel.app`.

### Opção B: pelo terminal
```bash
cd pingpong
npx vercel        # primeira vez: faz login e cria o projeto
npx vercel --prod # publica em produção
```

## Tela de entrada (login)

Antes do menu aparece a tela de entrada, com o mesmo fundo do menu:
- **Entrar com a Steam** (botão oficial; abre a página da própria Steam, o jogo nunca vê a senha).
- **Email e senha:** abas *Entrar* / *Criar conta* (nome no jogo, email e senha de 8+ caracteres com letras e números), "Esqueci minha senha" (manda um link; ao voltar com `?reset=1` o jogo pede a senha nova) e reenvio do email de confirmação.
- Mensagens de erro em português (senha errada, email já cadastrado, email não confirmado, muitas tentativas).
- Quem já está logado passa direto (só aparece "Conectando…" por um instante). "Sair" volta para a tela de entrada.
- Ao voltar pelo link de confirmação, mesmo em outro aparelho, aparece "Email confirmado! Agora entre com seu email e senha"; link vencido ou já usado mostra aviso.
- A música do menu só começa depois do login.
- Links de sala (`?sala=`) e de assistir (`?ver=`) esperam o login e entram sozinhos depois.
- Se o servidor de contas estiver fora do ar: "Tentar de novo" ou "Treinar offline".
- **Supabase (painel):** em *Authentication → URL Configuration*, o *Site URL* deve ser `https://pingpong-online.vercel.app` (e ela na lista de *Redirect URLs*). O envio de email padrão do Supabase só manda para membros da equipe e tem limite baixo por hora: para jogadores reais, configure um SMTP próprio (*Authentication → Emails → SMTP*, ex.: Resend) ou desligue *Confirm email* em *Sign In / Providers → Email*.

## Efeitos de botão
Todos os botões e cartões reagem ao hover e ao clique (subida leve, brilho, "onda" de luz no ponto clicado) com sons baixinhos que seguem o volume de **Avisos**. Quem usa "reduzir movimento" no sistema fica sem as animações de brilho.

## Menu principal (visual estilo FUT)

- **Barra do clube** em cima: escudo com o avatar, nome, divisão/nível, elo, XP total, estrelas das missões do dia, tempo até as missões novas com barra de progresso, nível, 👥, 🏆 e ⚙️.
- **Abas:** Início, Jogar, Garagem, Amigos, Ranking e Ajustes (**Q**/**E** trocam de aba).
- **Título grande** em itálico condensado, subtítulo e etiquetas (missões e tempo).
- **Cartões grandes** com ilustração, faixa laranja, nome embaixo e rodapé com 3 números; o cartão escolhido sobe e ganha a barra laranja. Bloqueado = cinza com cadeado no canto.
- **Telas:** Início (Jogar, Missões, Perfil, Amigos) · Jogar (Com amigo, Ranqueada, Treino, Tutorial + cenário e formato) · Com amigo (Criar sala, Entrar com código, Assistir) · Ranqueada (Procurar partida, Ranking) · Treino (um cartão por nível da CPU: clicou, começa) · Garagem (raquetes em cartões com velocidade/efeito/controle, bolinhas e sigla) · Missões · Perfil.
- Ajustes, Amigos, Ranking e Painel admin abrem no mesmo visual, em tela cheia (**Esc** fecha).
- Teclado: setas movem, **Enter** escolhe, **Esc** volta.
- Fonte: Barlow Condensed (licença OFL), carregada do jsDelivr.
- Fundo: a arte do jogo (`assets/menu-bg.jpg`; no celular, a versão menor) com zoom lento. Enquanto o menu está na tela, o 3D não é desenhado.
- **Música do menu:** `assets/menu-music.mp3`, em loop e baixa, só depois do login; mais baixa na tela de resultado e some na partida (a menos que "música durante a partida" esteja ligada). Segue o volume de **Música** e o 🔇. Os arquivos vêm do jsDelivr fixados no commit (`ASSET_SHA` no `game.js`).

## Skins de raquete (25)
Cada raquete (Clássica, Víbora, Foguete, Muralha, Raiz e Dragão Dourado) pode usar qualquer uma das 25 skins; a skin muda só o visual (frente e verso da borracha), não a velocidade, o efeito nem o controle. Na **Garagem**, clique numa raquete para equipá-la e abrir as skins dela; "Original" volta ao visual padrão. A escolha fica salva por raquete (`pp_rskins`) e vai para o adversário e para quem assiste (campo `sk` no `hello` e no `sinit`). A sigla aparece pequena embaixo da arte.

Skins: Caçador Galáctico, Camisa 10, Artilheiro, Viking do Gol, Paredão, Kraken Abissal, Fênix, Lobo Lunar, Trovão, Neve Eterna, Biohazard, Neon Retrô, Pixel Arcade, Steampunk, Astronauta, Esports Pro, Tropical, Geométrica, Camuflagem, Chamas Azuis, Doces & Sprinkles, Gato Ninja, Robô V4, Dourada Luxo e Arco-íris Holográfica (raridades Comum, Rara, Épica e Lendária, só de enfeite por enquanto; todas liberadas).

As artes ficam em `assets/skins/NN{f,b}.jpg` (512 px) e `NN{f,b}_s.jpg` (miniatura), servidas pelo jsDelivr fixadas no commit (`SKIN_SHA`). As 4 skins de futebol não usam nome, rosto nem marca de jogadores reais. Para trocar uma arte, substitua os dois arquivos, faça o commit e atualize `SKIN_SHA`.

## Avatares
24 avatares desenhados no próprio jogo (SVG, sem arquivos): 14 jogadores e 10 mascotes (bolinha, raposa, panda, gato, robô, tigre, coruja, dragão, rei da mesa e chama). Tigre (nível 5), Coruja (8), Dragão (10), Rei da mesa (15) e Chama (20) liberam por nível. Escolha em **Perfil** (clique no escudo ou no cartão Perfil); quem entrou pela Steam pode voltar para a foto da Steam. O avatar fica salvo na conta (`profiles.avatar_pick`, função `set_avatar`) e aparece na barra do clube, nos amigos e no ranking.

## Como jogar com o amigo
1. Abra o site → **Criar sala e chamar um amigo**.
2. Mande o link (botão **WhatsApp** ou **Copiar link**). Seu amigo abre e entra direto.
3. Partida até 11, com 2 de vantagem; o saque troca a cada 2 pontos (a cada 1 a partir de 10×10).

**Controles:** mova o mouse/dedo para posicionar a raquete. Na hora que a bola chega, faça um movimento
rápido **para cima**. Mais rápido = bola mais rápida; o topspin segura a bola na mesa, e ela só sai num
gesto exageradamente forte. Arrastar de lado (ex.: da esquerda pra direita) ao bater direciona a bola e
dá **efeito lateral**: ela faz curva no ar e "quebra" para o lado no quique. Puxar a raquete **para trás** =
**corte** (backspin). Raquete parada = bloqueio, que devolve o ritmo da bola que veio.

**Física de efeito:** o efeito que vem na bola muda a sua devolução, como no jogo real. Bloquear um topspin
forte faz a bola espirrar mais longa, bloquear um corte joga a bola na rede (é preciso bater forte para cima
ou cortar de volta) e o efeito lateral desvia a bola para o lado.

**Rede:** a rede estufa quando a bola bate nela e a fita vibra quando a bola raspa. Bola que raspa na fita
perde velocidade e pode cair logo depois da rede. Saque que toca na rede e entra = **LET** (repete o saque).

**Mesa:** ~6% mais larga que a oficial (1,62 m).

## Amigos e login Steam
- **Amigos (👥 no cartão da conta):** cada conta tem um código de amigo de 6 letras. Adicione pelo código, aceite
  ou recuse pedidos, veja quem está online, no menu, jogando ou assistindo, **convide para jogar** (abre uma sala e
  o amigo recebe o convite na tela) e **assista** a partida de um amigo com um clique. Com a chave da Steam Web
  API cadastrada, o botão "Amigos da Steam que jogam" mostra quem da sua lista da Steam já joga.
- **Privacidade:** amigos veem só nome, sigla, foto e status. SteamID e e-mail nunca aparecem para outros jogadores.
- **Login Steam (OpenID 2.0), como a Valve pede:** botão oficial "Sign in through Steam"; a senha é digitada só
  na página da Steam; a resposta é conferida com a própria Steam (`check_authentication`); conferimos também o
  endereço de retorno exato, a origem oficial, os campos assinados, o formato do SteamID e o nonce (cada resposta
  só vale uma vez e por 5 minutos, tabela `openid_nonces`). Aviso de marca: Steam é marca da Valve; o jogo não é
  afiliado à Valve. Chamadas à Steam Web API ficam bem abaixo do limite de 100 mil por dia.

## Modo telespectador 👀
Qualquer pessoa pode assistir uma partida online ao vivo, sem jogar:
- **Link:** quem cria a sala tem o botão "👀 Copiar link para assistir" (e, durante o jogo, o botão 👀 no canto
  para os dois jogadores). O link é `?ver=CÓDIGO`. Também dá para digitar o código no menu e clicar em "👀 Assistir".
- **O que o espectador vê:** a partida ao vivo (bola e raquetes ~30 vezes por segundo, desenhadas 0,1 s atrás
  para ficar liso), placar, games, sons das batidas, rótulos (SMASH, PERFEITO…), fim de game e de partida.
- **Câmeras:** TV (lateral), atrás de cada jogador e aérea, trocando com o botão ou a tecla **C**.
- **Reações:** 👏 🔥 😮 😂 (botões ou teclas 1 a 4) aparecem para os jogadores e para os outros espectadores.
- Os jogadores veem "👀 N assistindo". Até 12 espectadores por partida (quem transmite é o computador de quem
  criou a sala). Se o anfitrião sair, a transmissão acaba.

## Raquetes
Escolha no menu (setas ‹ ›). Cada uma tem **velocidade**, **efeito** e **controle**, que mudam a física de verdade:
velocidade encurta o tempo de voo da bola, efeito aumenta topspin, corte e curva lateral, e controle deixa a bola
mais certeira (com pouco controle a bola espalha e sai mais fácil numa batida exagerada).

| Raquete | Vel. | Efeito | Controle | Estilo |
|---|---|---|---|---|
| Clássica | 3 | 3 | 4 | Equilibrada, madeira e borracha lisa |
| Víbora | 3 | 5 | 3 | Borracha grudenta: muito topspin e curva |
| Foguete | 5 | 2 | 2 | Carbono: muito rápida, pouco controle |
| Muralha | 2 | 0 | 5 | Pino longo: sem efeito próprio, devolve o efeito do adversário invertido |
| Raiz | 4 | 1 | 3 | Retrô sem esponja: bola reta e veloz |
| Dragão Dourado | 4 | 4 | 4 | Lendária (por enquanto liberada para todos: `ALL_RACKETS_FREE` no game.js) |

No online cada um usa a própria raquete (o adversário vê a sua). No treino, a CPU sorteia uma raquete por partida.
Cada raquete tem visual próprio (lâmina, borracha, cabo) e um som de batida diferente.

## Cenários
Arena Neon, Ginásio do Bairro, Praia ao Pôr do Sol, Terraço da Cidade e Final Mundial. Cada um tem luz,
decoração, torcida e som próprios (eco de ginásio, ondas do mar, barulho da cidade). No online vale o cenário
de quem cria a sala. Todos têm fogos no fim da partida; a Final tem pirotecnia nos pontos.

**Som:** as batidas na raquete e na mesa usam sons reais gravados (pasta `sounds/`, carregados pelo
jsDelivr com reserva no GitHub), com volume pela força do impacto, estéreo pela posição da bola e um
pouco de eco de ginásio. Se os arquivos não carregarem, o jogo usa sons sintetizados no navegador.

## Bolinha
No menu dá para escolher a cor da bolinha: branca, laranja, preta, rosa, amarela, verde neon, azul, roxa,
dourada ou arco-íris. É visual e pessoal: cada jogador vê a bolinha que escolheu. O halo de luz em volta
da bola vem desligado (liga em ⚙️ → "Brilho (halo) em volta da bola").

## Acerto de tempo e peso do golpe
Bola no meio da raquete com o gesto no auge = **PERFEITO!** (bola um pouco mais rápida, sem espalhar, com um
"plim"). Gesto que já tinha passado = **CEDO**; bola na ponta da raquete = **NA PONTA** (sai torta). No smash
e no PERFEITO o jogo congela uma fração de segundo, a câmera dá um tranco e o celular vibra.

## CPU, tutorial e progresso
- **CPU:** Fácil, Médio, Difícil ou Pro (escolha no menu), cada partida com um estilo: Equilibrado,
  Defensor (corta muito, erra pouco) ou Atacante (bate forte e dá smash, erra mais).
- **Tutorial (1 minuto):** mover, rebater, curva, corte, smash, tempo certo e saque. A CPU só alimenta bolas.
  Primeira vez: +200 XP.
- **Nível e XP:** cada partida dá XP (vitória, pontos, batidas PERFEITAS; vale mais contra CPU difícil, online
  e ranqueada). **Missões do dia:** 3 por dia (ex.: 3 smashes, 5 PERFEITOS, vencer 1 partida). As bolinhas
  liberam por nível (preta no 2 até arco-íris no 15). Com conta, o XP fica salvo no servidor (`profiles.xp`).
- **Ajuda opcional:** em ⚙️, uma marquinha mostra onde a bola vai quicar do seu lado.

## Sons de detalhe
Vento da raquete cortando o ar (mais longo e agudo quanto mais rápido o gesto, mesmo sem acertar a bola),
toque leve com som abafado, smash com estalo e "tum" grave, ar passando pela bola rápida ou com muito efeito,
tênis rangendo no chão nos cenários fechados e a torcida fazendo silêncio no saque e no rally. Na praia, uma brisa leve
(o mar fica parado). A música toca no menu e some na partida (dá para manter em ⚙️).

## Chat rápido (estilo Rocket League)
Durante o jogo, aperte **1 a 4** para escolher a categoria e de novo **1 a 4** para a frase
(no celular, use o botão 💬). Categorias: Elogios, Reações, Provocações e Geral.
A mensagem aparece para o seu amigo na hora; no treino, a CPU também responde. Mandar mais de
4 mensagens em 4 segundos desativa o chat por 3 segundos (anti-spam).

## Torcida
Metade da torcida veste a sua cor (violeta) e torce por você; a outra metade (vermelho) torce pelo adversário.
No ponto, quem torce pelo vencedor pula com os braços pra cima e o outro lado põe a mão na cabeça. Rally longo
vira **ola** pela arquibancada, no match point todo mundo bate palma junto, e tem cartazes e flashes de celular.
O som também é sintetizado: murmúrio em estéreo, "aaah!" e "óóóh", aplausos, assobios e palmas ritmadas.

## Contas e ranqueada
- **Login:** "Entrar com Steam" (OpenID da Steam, pela função `steam-auth` do Supabase) ou Google
  (o botão só aparece depois que o provedor Google estiver ligado no Supabase).
- **Banco:** projeto Supabase `pingpong-online` (São Paulo). Tabelas `profiles`, `ratings`, `matches`
  e `ranked_queue`, todas só leitura para o jogo; elo e partidas só mudam por funções do servidor.
- **Fila:** "⚔️ Jogar ranqueada" procura alguém com elo parecido (a faixa abre com o tempo). Depois de
  45 s sem adversário, aparece a opção de treinar contra a CPU (não vale elo).
- **Placar:** cada jogador envia o resultado; o servidor só aplica o elo quando os dois batem. Placares
  diferentes ficam "em análise" e não contam. Se alguém sair e não voltar em 3 minutos, quem ficou ganha
  com metade do elo e o outro leva um abandono.
- **Elo:** começa em 1000, K = 40 nas 10 primeiras partidas (colocação), 24 até 30 e 16 depois.
  Divisões: Bronze, Prata (1100), Ouro (1300), Platina (1500), Diamante (1700) e Lenda (1900).
- **Admin:** `profiles.is_admin = true` libera todas as raquetes na conta, em qualquer aparelho, e abre o painel do admin.

## Formatos de partida
No menu: **Duelo** (1 game de 11), **MD3** (melhor de 3) ou **MD5** (melhor de 5). No online vale o formato de
quem cria a sala; a ranqueada é sempre 1 game. Entre os games aparece o placar do game, a torcida comemora e o
saque inicial alterna. O placar mostra bolinhas com os games ganhos e avisa GAME POINT / MATCH POINT.

## Replays e comemoração
Cada ponto é gravado. Ponto bonito (rally longo, smash, curva, bola na fita, ace) ganha **replay na hora**:
câmera de TV, câmera lenta congelando na batida com zoom, câmera seguindo a bola e comemoração. Dá para pular
(botão ou espaço); no online os dois precisam pular. No fim da partida: faixa de VITÓRIA, fogos de artifício
em todos os cenários (dentro do ginásio sobem menos), câmera passeando e os **2 melhores momentos** do jogador.

## Configurações (⚙️)
No menu e durante a partida (no treino o jogo pausa): sensibilidade do movimento e da batida, volume geral,
bolinha/raquete, torcida/ambiente, música e avisos (cada um com botão de mudo), replays, tremor da câmera,
ping, gráficos e tela cheia com mouse preso. Tudo fica salvo no aparelho. A música é gerada no navegador e fica baixinha durante o jogo.

## Tela cheia com o mouse preso
No computador, a partida abre em tela cheia e prende o mouse (Pointer Lock): o cursor some e não escapa para
o outro monitor num gesto forte. O jogo lê o movimento do mouse, então dá para bater forte mesmo com a raquete
encostada na borda. **Esc** solta o mouse; no treino, isso pausa o jogo (Continuar / Configurações / Sair). No
online, depois de conectar, um clique na tela prende o mouse. Dá para desligar em ⚙️ e o botão ⛶ liga/desliga
a tela cheia. Se o navegador não deixar prender o mouse, o jogo segue normal sem travar.

## Sigla na raquete e efeitos de borda
Cada jogador escolhe uma sigla de até 6 letras/números (com conta, fica salva na conta; sem conta, no aparelho).
Ela aparece grande na borracha, acima do nome da raquete, e o adversário vê. Víbora (verde), Foguete (chama
azul e laranja), Muralha (rosa) e Dragão Dourado (ouro com faíscas) têm borda brilhante e partículas.

## Painel do admin
Quem tem `is_admin` vê o botão **🛠️ Painel admin** no cartão da conta:
- **Jogadores:** busca por nome, sigla, e-mail ou Steam ID; muda nome, sigla e elo; libera ou tira raquetes
  daquele jogador; dá/tira admin; bane (com motivo) e zera estatísticas.
- **Raquetes:** liga/desliga cada raquete no jogo, deixa "para todos", define vitórias para liberar e dá ou tira
  uma raquete de todos os jogadores de uma vez.
- **Histórico:** tudo que os admins mudaram (tabela `admin_log`).
Tudo passa por funções do servidor que conferem se quem chamou é admin.

## Testar localmente
Precisa abrir por um servidor (não abra o arquivo direto com duplo clique):
```bash
npx serve .
# ou
python3 -m http.server 8080
```

## Ajustes fáceis (topo do `game.js`)
| Constante | O que faz |
|---|---|
| `TIME_SCALE` | velocidade geral do jogo (0.72 = câmera lenta leve; 1 = tempo real) |
| `POWER_DIV` | sensibilidade do gesto (maior = precisa de um gesto mais rápido para bater forte) |
| `POINT_TO_WIN` | pontos por partida |
| cores em `makePaddle(...)` | cor das raquetes |

## Se a conexão não fechar
WebRTC funciona na grande maioria das redes. Algumas redes corporativas ou 4G com NAT restrito podem
bloquear a conexão direta. Nesse caso, tente outra rede (ex.: um dos dois no Wi-Fi de casa). Se virar
problema frequente, dá para trocar a camada de rede por um relay em tempo real (Supabase Realtime, Ably,
PartyKit), sem mudar o resto do jogo.
