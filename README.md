# Ping Pong Online 🏓

Tênis de mesa 3D no navegador para jogar 1x1 com um amigo pela internet (ou treinar contra o computador).
É um site estático (`index.html` + `game.js`), então roda de graça na Vercel. Na Vercel, o `vercel.json` serve o `game.js` pelo jsDelivr direto do GitHub (num commit fixo).

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

**Mesa e raquetes:** a mesa é ~6% mais larga que a oficial (1,62 m). As raquetes seguem medidas reais
ampliadas 1,2×: lâmina de madeira compensada, borracha com esponja e logo, cabo anatômico com placa.
Borrachas nas cores permitidas pela ITTF (um lado sempre preto).

**Som:** as batidas na raquete e na mesa usam sons reais gravados (pasta `sounds/`, carregados pelo
jsDelivr com reserva no GitHub), com volume pela força do impacto, estéreo pela posição da bola e um
pouco de eco de ginásio. Se os arquivos não carregarem, o jogo usa sons sintetizados no navegador.

## Chat rápido (estilo Rocket League)
Durante o jogo, aperte **1 a 4** para escolher a categoria e de novo **1 a 4** para a frase
(no celular, use o botão 💬). Categorias: Elogios, Reações, Provocações e Geral.
A mensagem aparece para o seu amigo na hora; no treino, a CPU também responde. Mandar mais de
4 mensagens em 4 segundos desativa o chat por 3 segundos (anti-spam).

## Torcida
A torcida é sintetizada: murmúrio constante em estéreo, vozes que comemoram ("aaah!") ou lamentam
("óóóh" quando a bola vai na rede ou sai), aplausos com palmas individuais, assobios nos pontos
grandes, palmas ritmadas no match point e mais agitação nos rallies longos.

## Testar localmente
Precisa abrir por um servidor (não abra o arquivo direto com duplo clique):
```bash
npx serve .
# ou
python3 -m http.server 8080
```

## Ajustes fáceis (topo do script em `index.html`)
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
