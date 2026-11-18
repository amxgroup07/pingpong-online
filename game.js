import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/* =====================================================================
   CONSTANTES (metros / segundos) — medidas oficiais da mesa
   ===================================================================== */
const TL = 2.74, TW = 1.62, TH = 0.76, NET_H = 0.1525, R = 0.022;  // mesa ~6% mais larga que a oficial (1,525 m); bola 10% maior que a de antes
const HL = TL / 2, HW = TW / 2;
const NET_HALF = HW + 0.1525;
const BALL_Y = TH + R;
const NET_TOP = TH + NET_H;
const G = 9.81;
const KD = 0.045;               // arrasto do ar
const KM = 0.0032;              // efeito Magnus (spin)
const SIDE_KICK = 0.0004;       // quanto o efeito lateral desvia a bola no quique
const DT = 1 / 240;             // passo fixo da física
const TIME_SCALE = 0.72;        // câmera lenta leve p/ ficar jogável
const POWER_DIV = 2.1;          // velocidade do gesto (alturas de tela/s) -> força
const POINT_TO_WIN = 11;
const PEER_PREFIX = 'ppol-v2-';      // v2: formatos MD3/MD5, replays e sigla na raquete

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const $ = id => document.getElementById(id);
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };
// configurações do jogador (salvas no aparelho)
const CFG_DEF = { sensMove: 1, sensSwing: 1, vMaster: 90, vCrowd: 80, vMusic: 40, vFx: 100, vUi: 70, shake: true, replays: true, showPing: true, lockMouse: true, ballGlow: false, musicInGame: false, asmr: true, assist: false };
const cfg = Object.assign({}, CFG_DEF, (() => { try { return JSON.parse(store.get('pp_cfg', '{}')) || {}; } catch (e) { return {}; } })());
const saveCfg = () => store.set('pp_cfg', JSON.stringify(cfg));
if (!cfg._v2) { if (cfg.vMusic === 45) cfg.vMusic = 40; cfg._v2 = 1; saveCfg(); }   // música padrão passou de 45% para 40%
const volGain = v => v <= 0 ? 0 : Math.pow(clamp(v, 0, 100) / 100, 1.4);

/* =====================================================================
   FÍSICA DA BOLA — determinística: os dois jogadores simulam igual
   ===================================================================== */
function stepBall(b, dt, events, collide) {
  const p = b.p, v = b.v, w = b.w;
  const sp = Math.hypot(v[0], v[1], v[2]);
  v[0] += (-KD * sp * v[0] + KM * (w[1] * v[2] - w[2] * v[1])) * dt;
  v[1] += (-G - KD * sp * v[1] + KM * (w[2] * v[0] - w[0] * v[2])) * dt;
  v[2] += (-KD * sp * v[2] + KM * (w[0] * v[1] - w[1] * v[0])) * dt;
  const px = p[0], py = p[1], pz = p[2];
  p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
  if (!collide) return;

  if ((pz > 0) !== (p[2] > 0)) {                       // rede
    const f = pz / (pz - p[2]);
    const yc = py + (p[1] - py) * f, xc = px + (p[0] - px) * f;
    if (Math.abs(xc) < NET_HALF && yc < NET_TOP + R && yc > TH - 0.02) {
      const vin = Math.abs(v[2]), dir = Math.sign(v[2]);
      if (yc > NET_TOP - R * 0.3) {
        // raspou na fita da rede: passa, mas perde velocidade e sobe (quanto mais baixo, mais "morre")
        const g = clamp((yc - (NET_TOP - R * 0.3)) / (R * 1.3), 0, 1);
        v[2] *= lerp(0.3, 0.92, g); v[0] *= lerp(0.8, 0.98, g);
        v[1] = lerp(Math.abs(v[1]) * 0.3 + 0.9, v[1], g);
        const k = lerp(0.4, 0.9, g); w[0] *= k; w[1] *= k; w[2] *= k;
        events && events.push({ t: 'net', x: xc, y: yc, s: vin, graze: 1, dir });
      } else {
        p[2] = Math.sign(pz || 1) * (R + 0.002);
        v[2] = -v[2] * 0.12; v[0] *= 0.5; v[1] *= 0.3;
        w[0] *= 0.3; w[1] *= 0.3; w[2] *= 0.3;
        events && events.push({ t: 'net', x: xc, y: yc, s: vin, graze: 0, dir });
      }
    }
  }
  if (v[1] < 0 && py >= BALL_Y && p[1] < BALL_Y && Math.abs(p[0]) <= HW + R * 0.5 && Math.abs(p[2]) <= HL + R * 0.5) {
    p[1] = BALL_Y + (BALL_Y - p[1]);                   // mesa
    const vin = -v[1];
    v[1] = -v[1] * 0.9;
    // efeito lateral "quebra" no quique (exagerado de leve, como nos jogos de celular)
    const kx = SIDE_KICK * w[1] * v[2], kz = -SIDE_KICK * w[1] * v[0];
    v[0] = v[0] * 0.98 + 0.18 * (-w[2] * R) + kx;
    v[2] = v[2] * 0.98 + 0.18 * (w[0] * R) + kz;
    w[0] *= 0.6; w[1] *= 0.6; w[2] *= 0.6;
    events && events.push({ t: 'table', x: p[0], z: p[2], s: vin });
  }
  if (p[1] < R) {                                      // chão
    p[1] = R;
    if (v[1] < 0) { v[1] = -v[1] * 0.55; v[0] *= 0.8; v[2] *= 0.8; events && events.push({ t: 'floor', x: p[0], z: p[2], s: -v[1] }); }
  }
}

function simFlight(p0, v0, w0) {
  const b = { p: [...p0], v: [...v0], w: [...w0] };
  let t = 0, netY = null;
  for (let i = 0; i < 1400; i++) {
    const px = b.p[0], py = b.p[1], pz = b.p[2];
    stepBall(b, DT, null, false); t += DT;
    if (netY === null && (pz > 0) !== (b.p[2] > 0)) { const f = pz / (pz - b.p[2]); netY = py + (b.p[1] - py) * f; }
    if (b.v[1] < 0 && py > BALL_Y && b.p[1] <= BALL_Y) {
      const f = (py - BALL_Y) / (py - b.p[1]);
      return { x: px + (b.p[0] - px) * f, z: pz + (b.p[2] - pz) * f, t, netY };
    }
  }
  return null;
}

/* Intenção do jogador (força, mira, efeito) -> velocidade inicial da bola.
   o.inW / o.inSpeed = efeito e velocidade da bola que chegou (reação ao efeito)
   o.chop = corte (backspin), puxando a raquete para trás */
function makeShot(side, B, power, tx, sideSpin, serve, o = {}) {
  const pw = Math.max(0, power);
  const chop = !!o.chop && !serve;
  const rk = o.rk || { speed: 3, spin: 3, ctrl: 3 };
  const speedK = 1 + 0.1 * (rk.speed - 3), spinK = rk.spin / 3, ctrl = rk.ctrl;
  let depth, sh, top;
  // Força acima de 1 deixa a bola mais rápida, mas ela continua na mesa (o topspin segura).
  // Só uma batida MUITO forte (bem acima do normal) manda a bola para fora.
  let outExtra = 0;
  if (serve) {
    depth = 0.55 + 0.7 * Math.min(pw, 1) + 0.05 * clamp(pw - 1, 0, 0.8);
    outExtra = 0.9 * Math.max(0, pw - (1.8 + 0.15 * (ctrl - 3)));
    sh = 2.6 + 3.0 * Math.min(pw, 1) + 1.0 * clamp(pw - 1, 0, 0.8);
    top = 25;
  } else if (chop) {
    depth = 0.4 + 0.8 * Math.min(pw, 1);
    sh = 2.3 + 3.0 * Math.min(pw, 1);
    top = -(50 + 90 * Math.min(pw, 1));
  } else {
    depth = 0.32 + 0.9 * Math.min(pw, 1) + 0.06 * clamp(pw - 1, 0, 0.9);
    outExtra = 1.0 * Math.max(0, pw - (1.9 + 0.15 * (ctrl - 3)));
    sh = 2.4 + 6.0 * Math.min(pw, 1) + 1.8 * clamp(pw - 1, 0, 0.9);   // devagar = bola lenta, rápido = bola rápida
    top = pw < 0.15 ? -20 : 40 + 100 * Math.min(pw, 1.2);
  }
  sh *= speedK;
  top *= spinK;                                    // Muralha (pino longo) não gera efeito próprio
  sideSpin *= spinK;
  // Reação ao efeito que veio na bola (física do contato bola-borracha):
  // topspin recebido faz a bola subir/espirrar, backspin faz cair, sidespin desvia de lado.
  let netFail = false;
  if (!serve && o.inW && rk.anti) {
    // pino longo: o efeito que chega não atrapalha e volta invertido (topspin vira corte, lateral troca de lado)
    top = clamp(-0.65 * o.inW[0] * side, -140, 140);
    sideSpin = clamp(-0.5 * o.inW[1], -160, 160);
    sh += (o.inSpeed || 0) * (1 - Math.min(pw, 1)) * 0.5;
  } else if (!serve && o.inW) {
    const rz = side * R;
    const lat = -o.inW[1] * rz;               // m/s de desvio lateral
    const vert = o.inW[0] * rz;               // >0 topspin recebido, <0 backspin recebido
    const absorb = chop ? 0.55 : clamp(0.3 + pw * 0.6, 0.3, 0.9);
    tx += lat * 0.35 * (1 - absorb);
    let dAdd = vert * 0.4 * (1 - absorb);
    if (chop && vert < 0) dAdd = 0;            // cortar um corte é natural
    if (dAdd < -0.2 && pw < 0.5) netFail = true;
    depth = Math.max(0.15, depth + dAdd);
    // bloqueio/toque devolve o ritmo da bola que chegou (mais rápida e mais funda)
    const pace = (o.inSpeed || 0) * (1 - Math.min(pw, 1));
    sh += pace * 0.5;
    if (!chop) depth += pace * 0.04;
  }
  // raquete com pouco controle espalha um pouco a bola; batida PERFEITA não espalha, na ponta espalha mais
  const q = o.q || 0;
  if (!serve && ctrl < 4 && q <= 0) { const e = 4 - ctrl; depth += (Math.random() - 0.5) * 0.07 * e; tx += (Math.random() - 0.5) * 0.08 * e; }
  if (!serve && q < 0) { depth += (Math.random() - 0.5) * 0.18; tx += (Math.random() - 0.5) * 0.3; sh *= 0.9; }
  if (q > 0) sh *= 1.06;
  // o topspin "segura" a bola: sem exagero de força ela cai antes do fim da mesa
  depth = clamp(depth, 0.15, HL - 0.07) + outExtra;
  // mira lateral com limite suave: só sai pela lateral num movimento muito exagerado
  { const lim = HW - 0.07, a = Math.abs(tx); if (a > lim) tx = Math.sign(tx) * (lim + (a - lim) * (0.25 - 0.04 * (ctrl - 3))); }
  const T = [tx, BALL_Y, -side * depth];
  const dx = T[0] - B[0], dz = T[2] - B[2];
  const dist = Math.hypot(dx, dz) || 1;
  const dirx = dx / dist, dirz = dz / dist;
  if (top > 0) top *= clamp((B[1] - TH + 0.3) / 0.4, 0.25, 1);
  const w = [top * dirz, sideSpin, -top * dirx];
  // o Magnus do topspin puxa a bola pra baixo (backspin segura): a gravidade "efetiva" entra na conta,
  // assim o tempo de voo depende da velocidade da raquete e não só do efeito
  const gEff = Math.max(3, G + KM * top * sh * 0.8);

  let tf = dist / sh, v = null;
  const netReq = NET_TOP + R + 0.035;
  for (let attempt = 0; attempt < 10; attempt++) {
    for (let i = 0; i < 50; i++) {
      const vy = (BALL_Y - B[1]) / tf + 0.5 * gEff * tf;
      const tn = -B[2] * tf / dz;
      const yn = B[1] + vy * tn - 0.5 * gEff * tn * tn;
      if (yn >= netReq) break;
      tf *= 1.05;
    }
    v = [dx / tf, (BALL_Y - B[1]) / tf + 0.5 * gEff * tf, dz / tf];
    let land = null;
    for (let it = 0; it < 8; it++) {
      land = simFlight(B, v, w);
      if (!land) break;
      const ex = T[0] - land.x, ez = T[2] - land.z;
      if (Math.abs(ex) < 0.004 && Math.abs(ez) < 0.004) break;
      v[0] += ex / land.t; v[2] += ez / land.t;
    }
    if (!land || (land.netY !== null && land.netY < NET_TOP + R + 0.012)) { tf *= 1.08; continue; }
    break;
  }
  if (netFail) {                                  // o backspin "puxou" a bola para a rede
    const base = v[1];
    for (let k = 0.95; k > 0.2; k -= 0.04) {
      v[1] = base * k;
      const l = simFlight(B, v, w);
      if (l && l.netY !== null && l.netY < NET_TOP - 0.02) break;
    }
  } else if (Math.random() < (serve ? 0.06 : 0.03 + 0.04 * clamp(pw - 0.8, 0, 1)) * (1.3 - 0.1 * ctrl) * (q > 0 ? 0 : q < 0 ? 2 : 1)) {
    // de vez em quando a bola passa baixinho e raspa na fita da rede (como no jogo real)
    const base = v[1];
    for (let k = 0.995; k > 0.6; k -= 0.005) {
      v[1] = base * k;
      const l = simFlight(B, v, w);
      if (!l || l.netY === null) { v[1] = base; break; }
      if (l.netY < NET_TOP + R * 0.55) { if (l.netY < NET_TOP - R * 0.15) v[1] = base; break; }
    }
  }
  let label = 'TOP-SPIN';
  if (serve) label = 'SAQUE';
  else if (rk.anti) label = pw < 0.15 ? 'BLOQUEIO' : 'PINO LONGO';
  else if (chop) label = 'CORTE';
  else if (pw < 0.15) label = 'BLOQUEIO';
  else if (pw >= 0.95) label = 'SMASH!';
  else if (Math.abs(sideSpin) > 30) label = 'SIDE-SPIN';
  else if (spinK < 0.5) label = 'BOLA RETA';
  return { v, w, label };
}

/* =====================================================================
   RENDERER + PÓS-PROCESSAMENTO
   ===================================================================== */
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.6;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const coarse = matchMedia('(pointer: coarse)').matches;
const Q = { level: store.get('pp_q', (coarse || (navigator.hardwareConcurrency || 8) <= 4) ? 'leve' : 'alto') };

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07020a);
scene.fog = new THREE.Fog(0x07020a, 11, 30);
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 80);
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  pmrem.dispose();
}

const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0.5 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float amount; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); float d = distance(vUv, vec2(0.5));
      c.rgb *= mix(1.0, smoothstep(0.85, 0.25, d), amount); gl_FragColor = c; }`
};

let composer = null, bloomPass = null;
function buildComposer() {
  if (composer) { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); }
  const w = window.innerWidth, h = window.innerHeight, pr = renderer.getPixelRatio();
  const rt = new THREE.WebGLRenderTarget(Math.floor(w * pr), Math.floor(h * pr), { type: THREE.HalfFloatType, samples: Q.level === 'alto' ? 4 : 0 });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.5, 1.0);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass(VignetteShader));
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const dotTex = canvasTex(64, 64, (g, w, h) => {
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
});

/* =====================================================================
   ILUMINAÇÃO (as mesmas luzes em todos os cenários; cada um ajusta cor e força)
   ===================================================================== */
const hemi = new THREE.HemisphereLight(0x8090ff, 0x40101e, 0.09); scene.add(hemi);
const mainSpot = new THREE.SpotLight(0xfff4ea, 46, 14, 0.6, 0.6, 2);
mainSpot.position.set(0, 6.2, 0.4);
mainSpot.target.position.set(0, TH, 0);
mainSpot.castShadow = true;
mainSpot.shadow.bias = -0.0004;
mainSpot.shadow.normalBias = 0.02;
mainSpot.shadow.camera.near = 2; mainSpot.shadow.camera.far = 10;
scene.add(mainSpot, mainSpot.target);
const RIM_POS = [[-4, -5], [4, 5], [4, -5], [-4, 5]];
const rimSpots = RIM_POS.map(([x, z]) => {
  const s = new THREE.SpotLight(0xffffff, 16, 16, 0.42, 0.8, 2);
  s.position.set(x, 5.5, z); s.target.position.set(0, TH, 0);
  scene.add(s, s.target); return s;
});
const fill = new THREE.DirectionalLight(0xffffff, 0.17);
fill.position.set(-2, 4, 3); scene.add(fill);
const hitLight = new THREE.PointLight(0xffffff, 0, 2.2, 2);
scene.add(hitLight);

// Feixes de luz "volumétricos" falsos
const beamMat = new THREE.ShaderMaterial({
  uniforms: { color: { value: new THREE.Color(0xffe8f2) }, strength: { value: 0.11 } },
  vertexShader: `varying float vH; varying vec3 vN; varying vec3 vV;
    void main(){ vH = position.y; vec4 mv = modelViewMatrix * vec4(position,1.0);
      vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform vec3 color; uniform float strength; varying float vH; varying vec3 vN; varying vec3 vV;
    void main(){ float h = clamp(vH + 0.5, 0.0, 1.0); float edge = pow(abs(dot(vN, vV)), 2.0);
      gl_FragColor = vec4(color * strength * pow(h, 1.3) * edge, 1.0); }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
});

/* =====================================================================
   CENÁRIOS — tudo que é do cenário fica em arenaRoot e é recriado na troca
   ===================================================================== */
const arenaRoot = new THREE.Group(); scene.add(arenaRoot);
const A = { id: null, def: null, led: null, ribbon: null, crowdView: null, beams: [], beamsOpt: [], upd: [], rimBase: 16, rimPulse: 3, rimFlash: 22, pyroAt: [], fireworks: false };
const crowd = { excite: 0.1, base: 0.1, react: null, olaT0: -99, clap: false, mySide: 1 };
const jumboCanvas = document.createElement('canvas'); jumboCanvas.width = 1024; jumboCanvas.height = 400;
const jumboTex = new THREE.CanvasTexture(jumboCanvas); jumboTex.colorSpace = THREE.SRGBColorSpace; jumboTex.userData.keep = true;
const jumboMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: jumboTex, emissiveIntensity: 1.0 }); jumboMat.userData.keep = true;
const trussMat = new THREE.MeshStandardMaterial({ color: 0x1b1b22, metalness: 0.8, roughness: 0.4 }); trussMat.userData.keep = true;

const _col = new THREE.Color(), _m4 = new THREE.Matrix4();
const add = (o, parent = arenaRoot) => { parent.add(o); return o; };
const M = o => new THREE.MeshStandardMaterial(o);
function box(w, h, d, mat, x, y, z, parent) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return add(m, parent); }
function flat(w, h, mat, x, y, z, ry = 0, parent) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.position.set(x, y, z); m.rotation.y = ry; return add(m, parent); }
function ground(w, d, mat, y = 0) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat); m.rotation.x = -Math.PI / 2; m.position.y = y; m.receiveShadow = true; return add(m); }
function addBeam(from, to, radius, color, strength, optional = false) {
  const len = from.distanceTo(to);
  const geo = new THREE.ConeGeometry(radius, len, 32, 1, true);
  const m = beamMat.clone(); m.uniforms.color.value = new THREE.Color(color); m.uniforms.strength.value = strength;
  geo.scale(1, 1 / len, 1);
  const mesh = new THREE.Mesh(geo, m);
  mesh.scale.y = len;
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.lookAt(to); mesh.rotateX(-Math.PI / 2);
  add(mesh); (optional ? A.beamsOpt : A.beams).push(mesh);
  return mesh;
}
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
function noiseFill(g, w, h, n, a, sz = 2) { for (let i = 0; i < n; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${Math.random() * a})`; g.fillRect(Math.random() * w, Math.random() * h, sz, sz); } }
function repeatTex(t, rx, ry) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); return t; }

// piso de quadra com texto (arena / final)
function courtTexture(c1, c2, line, t1, t2) {
  return canvasTex(1024, 1536, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 80, w / 2, h / 2, h * 0.65);
    gr.addColorStop(0, c1); gr.addColorStop(1, c2); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    noiseFill(g, w, h, 26000, 0.05);
    g.strokeStyle = line; g.lineWidth = 8; g.strokeRect(24, 24, w - 48, h - 48);
    g.fillStyle = line; g.textAlign = 'center';
    for (const sx of [-1, 1]) {
      g.save(); g.translate(w / 2 + sx * 300, h / 2); g.rotate(sx * Math.PI / 2);
      g.font = 'italic 900 52px system-ui, sans-serif'; g.fillText(t1, 0, 0);
      g.font = '700 26px system-ui, sans-serif'; g.fillText(t2, 0, 40);
      g.restore();
    }
  });
}
// placas em volta da área de jogo: LED que troca de anúncio, ou placas impressas
function boards(ads, o = {}) {
  const BX = o.bx || 3.6, BZ = o.bz || 5.5, led = o.led !== false;
  const tex = canvasTex(768 * ads.length, 256, (g, w, h) => {
    g.fillStyle = o.bg || '#04030a'; g.fillRect(0, 0, w, h);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    ads.forEach(([t, c], i) => {
      const cx = i * 768 + 384;
      let fs = 96; g.font = `italic 900 ${fs}px system-ui, sans-serif`;
      while (g.measureText(t).width > 680) { fs -= 4; g.font = `italic 900 ${fs}px system-ui, sans-serif`; }
      g.fillStyle = c; g.fillText(t, cx, h / 2 + 6);
      g.fillRect(i * 768 + 40, h - 34, 688, 6);
    });
    if (led) { g.fillStyle = 'rgba(0,0,0,.4)'; for (let y = 0; y < h; y += 5) g.fillRect(0, y, w, 1.5); for (let x = 0; x < w; x += 5) g.fillRect(x, 0, 1.5, h); }
  });
  tex.wrapS = THREE.RepeatWrapping; tex.repeat.set(1 / ads.length, 1);
  const face = led ? M({ color: 0x000000, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.8, roughness: 0.4 }) : M({ map: tex, roughness: 0.7 });
  const side = M({ color: o.side || 0x0c0c10, roughness: 0.5, metalness: 0.4 });
  const geo = new THREE.BoxGeometry(1.8, 0.6, 0.08), mats = [side, side, side, side, face, side];
  for (let x = -BX + 0.9; x <= BX - 0.9 + 0.01; x += 1.8) for (const s of [-1, 1]) { const m = add(new THREE.Mesh(geo, mats)); m.position.set(x, 0.3, s * BZ); m.rotation.y = s > 0 ? Math.PI : 0; }
  for (let z = -BZ + 0.9; z <= BZ - 0.9 + 0.01; z += 1.8) for (const s of [-1, 1]) { const m = add(new THREE.Mesh(geo, mats)); m.position.set(s * BX, 0.3, z); m.rotation.y = -s * Math.PI / 2; }
  if (led) A.led = { tex, mat: face, n: ads.length, idx: 0, t: 0, base: 0.8 };
  else { tex.offset.x = 0; A.led = { tex, mat: null, n: ads.length, idx: 0, t: 0 }; }
}
// arquibancada em degraus nos 4 lados (ou só alguns); devolve os assentos para a torcida
function stands(o) {
  const seats = [], mat = o.mat, rows = o.rows, rh = o.rowH || 0.45, rd = o.rowD || 0.72, b0 = o.base || 0.45, sp = o.spacing || 0.52, fillP = o.fill ?? 0.88;
  const sides = o.sides || ['x+', 'x-', 'z+', 'z-'];
  for (const sd of sides) {
    const ax = sd[0], s = sd[1] === '+' ? 1 : -1;
    const start = ax === 'x' ? o.sideStart : o.endStart, len = ax === 'x' ? o.sideLen : o.endLen;
    for (let r = 0; r < rows; r++) {
      const ytop = b0 + r * rh, d = s * (start + r * rd);
      if (ax === 'x') { const st = box(rd, ytop, len, mat, d, ytop / 2, 0); st.receiveShadow = true; }
      else { const st = box(len, ytop, rd, mat, 0, ytop / 2, d); st.receiveShadow = true; }
      for (let u = -len / 2 + 0.3; u <= len / 2 - 0.3; u += sp) if (Math.random() < fillP) {
        const j = (Math.random() - 0.5) * 0.1;
        if (ax === 'x') seats.push([d + j, ytop, u + (Math.random() - 0.5) * 0.12]); else seats.push([u + (Math.random() - 0.5) * 0.12, ytop, d + j]);
      }
    }
  }
  return seats;
}
// público em pé em volta de um retângulo (praia / terraço)
function standingRing(bx, bz, rows, sp, fillP, skip) {
  const seats = [];
  for (let r = 0; r < rows; r++) {
    const ex = bx + r * 0.55, ez = bz + r * 0.55;
    const per = 2 * (2 * ex + 2 * ez);
    for (let u = 0; u < per; u += sp) {
      let x, z, q = u;
      if (q < 2 * ex) { x = -ex + q; z = ez; } else if ((q -= 2 * ex) < 2 * ez) { x = ex; z = ez - q; }
      else if ((q -= 2 * ez) < 2 * ex) { x = ex - q; z = -ez; } else { q -= 2 * ex; x = -ex; z = -ez + q; }
      x += (Math.random() - 0.5) * 0.25; z += (Math.random() - 0.5) * 0.25;
      if (skip && skip(x, z)) continue;
      if (Math.random() < fillP) seats.push([x, 0, z]);
    }
  }
  return seats;
}
// treliça com luzes no teto (arena / final)
function trussRig(w, d, y, lampColor) {
  const lampMat = M({ color: 0x000000, emissive: lampColor, emissiveIntensity: 6 });
  for (const s of [-1, 1]) {
    box(w, 0.18, 0.18, trussMat, 0, y, s * d / 2); box(0.18, 0.18, d, trussMat, s * w / 2, y, 0);
    for (let x = -w / 2 + 0.6; x <= w / 2 - 0.6; x += 1.4) box(0.22, 0.08, 0.22, lampMat, x, y - 0.12, s * d / 2);
    for (let z = -d / 2 + 1; z <= d / 2 - 1; z += 1.4) box(0.22, 0.08, 0.22, lampMat, s * w / 2, y - 0.12, z);
  }
  const housing = add(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 0.3, 24), trussMat)); housing.position.set(0, 6.4, 0.4);
  const lens = add(new THREE.Mesh(new THREE.CircleGeometry(0.45, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3.8, 3.6) })));
  lens.rotation.x = Math.PI / 2; lens.position.set(0, 6.24, 0.4);
  for (const [x, z] of RIM_POS) { const h = add(new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.26, 0.3, 16), trussMat)); h.position.set(x, 5.5, z); h.lookAt(0, TH, 0); h.rotateX(Math.PI / 2); }
}
function jumbos(z, y = 4.1, w = 4.4, h = 1.72) {
  for (const s of [-1, 1]) {
    box(w + 0.2, h + 0.23, 0.2, trussMat, 0, y, s * z);
    flat(w, h, jumboMat, 0, y, s * (z - 0.11), s > 0 ? Math.PI : 0);
  }
}
function skyDome(top, mid, bot, sunDir, sunCol, sunPow = 1) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(top) }, mid: { value: new THREE.Color(mid) }, bot: { value: new THREE.Color(bot) }, sunDir: { value: sunDir.clone().normalize() }, sunCol: { value: new THREE.Color(sunCol) }, sunPow: { value: sunPow } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top, mid, bot, sunCol, sunDir; uniform float sunPow; varying vec3 vP;
      void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.6, h)) : mix(mid, bot, smoothstep(0.0, 0.2, -h));
        float s = max(dot(normalize(vP), sunDir), 0.0); c += sunCol * sunPow * (pow(s, 12.0) * 0.5 + pow(s, 90.0) * 0.8 + pow(s, 900.0) * 6.0);
        gl_FragColor = vec4(c, 1.0); }`
  });
  const m = add(new THREE.Mesh(new THREE.SphereGeometry(55, 40, 20), mat)); m.renderOrder = -2;
}
function stars(n, r = 52) {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const th = Math.random() * Math.PI * 2, y = 0.08 + Math.random() * 0.92, rr = Math.sqrt(1 - y * y); pos.set([Math.cos(th) * rr * r, y * r, Math.sin(th) * rr * r], i * 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.22, color: 0xdfe8ff, map: dotTex, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending })));
}
// varal de lâmpadas (catenária) entre pontos
function stringLights(spans, color, perSpan = 12, sag = 0.5) {
  const pts = [], wire = [];
  for (const [a, b] of spans) {
    for (let k = 0; k <= perSpan; k++) {
      const t = k / perSpan, p = a.clone().lerp(b, t); p.y -= sag * 4 * t * (1 - t);
      wire.push(p.clone()); if (k > 0 && k < perSpan) pts.push(p);
    }
  }
  const lg = new THREE.BufferGeometry().setFromPoints(wire.flatMap((p, i) => i && (i % (perSpan + 1)) ? [wire[i - 1], p] : []));
  add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x1a1410 })));
  const c = new THREE.Color(color).multiplyScalar(4);
  const bulbs = add(new THREE.InstancedMesh(new THREE.SphereGeometry(0.045, 8, 6), new THREE.MeshBasicMaterial({ color: c }), pts.length));
  pts.forEach((p, i) => { _m4.makeTranslation(p.x, p.y - 0.05, p.z); bulbs.setMatrixAt(i, _m4); });
  const gpos = new Float32Array(pts.length * 3); pts.forEach((p, i) => gpos.set([p.x, p.y - 0.05, p.z], i * 3));
  const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.BufferAttribute(gpos, 3));
  add(new THREE.Points(gg, new THREE.PointsMaterial({ size: 0.26, map: dotTex, color: new THREE.Color(color).multiplyScalar(0.4), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
}
function palm(x, z, h, lx, lz) {
  const pts = []; for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(V3(x + lx * t * t * h * 0.35, t * h, z + lz * t * t * h * 0.35)); }
  const trunk = add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.13, 8), M({ map: TEX.bark(), roughness: 0.9 }))); trunk.castShadow = true;
  const top = pts[6];
  for (let i = 0; i < 9; i++) {
    const lf = add(new THREE.Mesh(TEX.leafGeo(), M({ map: TEX.leaf(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.7 })));
    lf.position.copy(top); lf.rotation.set(0, i / 9 * Math.PI * 2 + Math.random() * 0.3, 0); lf.rotateX(-0.15 + Math.random() * 0.3); lf.castShadow = true;
  }
  for (let i = 0; i < 3; i++) { const c = add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), M({ color: 0x5a3a1c, roughness: 0.8 }))); c.position.set(top.x + Math.cos(i * 2.1) * 0.13, top.y - 0.12, top.z + Math.sin(i * 2.1) * 0.13); }
}
function umbrella(x, z, c1, c2) {
  box(0.04, 2.2, 0.04, M({ color: 0xdddddd, metalness: 0.6, roughness: 0.4 }), x, 1.1, z);
  const tex = canvasTex(256, 64, (g, w, h) => { for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? c1 : c2; g.fillRect(i * w / 8, 0, w / 8, h); } });
  const cone = add(new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.42, 16, 1, true), M({ map: tex, side: THREE.DoubleSide, roughness: 0.8 }))); cone.position.set(x, 2.25, z); cone.castShadow = true;
}
const TEX = {
  _c: {},
  get(k, f) { return this._c[k] || (this._c[k] = f()); },
  bark() { return canvasTex(64, 256, (g, w, h) => { g.fillStyle = '#7a5a3a'; g.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 10) { g.fillStyle = 'rgba(40,25,10,.55)'; g.fillRect(0, y, w, 3); } noiseFill(g, w, h, 600, 0.15); }); },
  leaf() {
    return canvasTex(128, 512, (g, w, h) => {
      g.strokeStyle = '#3f6e22'; g.lineWidth = 6; g.beginPath(); g.moveTo(w / 2, h); g.lineTo(w / 2, 0); g.stroke();
      for (let y = 10; y < h - 10; y += 9) {
        const L = (w / 2 - 6) * Math.sin(Math.PI * y / h) ** 0.6;
        g.strokeStyle = `hsl(${95 + Math.random() * 20},55%,${28 + Math.random() * 12}%)`; g.lineWidth = 5;
        g.beginPath(); g.moveTo(w / 2, y + 8); g.lineTo(w / 2 - L, y - 6); g.stroke();
        g.beginPath(); g.moveTo(w / 2, y + 8); g.lineTo(w / 2 + L, y - 6); g.stroke();
      }
    });
  },
  leafGeo() {
    const g = new THREE.PlaneGeometry(0.75, 2.3, 1, 10), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), L = p.getY(i) + 1.15; p.setXYZ(i, x, 0.42 * L - 0.24 * L * L, L); }
    g.computeVertexNormals(); return g;
  },
};
// placas/cartazes da torcida
const SIGN_TEXTS = [['VAI! 🏓', '#ffd34d', '#1a1a1a'], ['SMASH!', '#ff3d7f', '#ffffff'], ['TOP SPIN ♥', '#3dc8ff', '#0b1a2a'], ['ACE!', '#2fd16b', '#ffffff']];
const signTex = SIGN_TEXTS.map(([t, bg, fg]) => canvasTex(256, 160, (g, w, h) => {
  g.fillStyle = bg; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 8; g.strokeRect(4, 4, w - 8, h - 8);
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'italic 900 56px system-ui'; g.fillText(t, w / 2, h / 2 + 4);
}));
signTex.forEach(t => t.userData.keep = true);

/* ---------- Torcida: corpo, cabeça, cabelo, braços, cartazes, flash de celular ---------- */
const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0x6b4226];
const HAIR = [0x1a1210, 0x3b2414, 0x6b4423, 0xc9a26b, 0x2a2a2a, 0x8a3b1a, 0x101010];
const TEAM_ME = [0x9a5cff, 0x7b3fe4, 0xb98cff], TEAM_OP = [0xff3355, 0xd81b3c, 0xff6a7a];
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _e = new THREE.Euler(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1), _hairS = new THREE.Vector3(1.05, 0.72, 1.05);
function buildCrowd(seats, o = {}) {
  for (let i = seats.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [seats[i], seats[j]] = [seats[j], seats[i]]; }
  const N = seats.length, neutral = o.palette || [0xffffff, 0x222233, 0xffd34d, 0x3dc8ff, 0x2fd16b, 0x444455, 0xff7a3d, 0xe8e8e8];
  const mk = (geo, rough) => add(new THREE.InstancedMesh(geo, M({ roughness: rough }), N));
  const body = mk(new THREE.CapsuleGeometry(0.17, 0.36, 2, 8), 0.8), head = mk(new THREE.SphereGeometry(0.12, 10, 8), 0.7);
  const hair = mk(new THREE.SphereGeometry(0.125, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), 0.9);
  const armGeo = new THREE.CapsuleGeometry(0.045, 0.26, 2, 6), armL = mk(armGeo, 0.8), armR = mk(armGeo, 0.8);
  const P = seats.map(([x, y, z]) => ({
    x, y, z, yaw: Math.atan2(-x, -z), ph: Math.random() * 6.283, amp: 0.5 + Math.random() * 0.8,
    team: Math.abs(z) < 0.5 ? (Math.random() < 0.5 ? 1 : -1) : Math.sign(z), r: Math.random(), shirt: neutral[(Math.random() * neutral.length) | 0],
    sign: -1, phone: Math.random() < (o.phones || 0), ang: Math.atan2(x, z), tall: 0.92 + Math.random() * 0.16
  }));
  P.forEach((p, i) => {
    head.setColorAt(i, _col.setHex(SKIN[(Math.random() * SKIN.length) | 0]));
    armL.setColorAt(i, head.instanceColor ? _col : _col); armR.setColorAt(i, _col);
    hair.setColorAt(i, _col.setHex(HAIR[(Math.random() * HAIR.length) | 0]));
    if (o.signs && Math.random() < 0.06) p.sign = (Math.random() * SIGN_TEXTS.length) | 0;
  });
  // os braços usam a cor da pele (copiada da cabeça)
  for (let i = 0; i < N; i++) { head.getColorAt(i, _col); armL.setColorAt(i, _col); armR.setColorAt(i, _col); }
  const signMeshes = SIGN_TEXTS.map((_, d) => {
    const who = P.map((p, i) => p.sign === d ? i : -1).filter(i => i >= 0);
    const m = add(new THREE.InstancedMesh(new THREE.PlaneGeometry(0.62, 0.39), new THREE.MeshStandardMaterial({ map: signTex[d], side: THREE.DoubleSide, roughness: 0.7 }), Math.max(1, who.length)));
    m.count = who.length; return { m, who };
  });
  const phones = P.map((p, i) => p.phone ? i : -1).filter(i => i >= 0);
  const phPos = new Float32Array(Math.max(1, phones.length) * 3), phCol = new Float32Array(Math.max(1, phones.length) * 3);
  const phGeo = new THREE.BufferGeometry(); phGeo.setAttribute('position', new THREE.BufferAttribute(phPos, 3)); phGeo.setAttribute('color', new THREE.BufferAttribute(phCol, 3));
  const phPts = add(new THREE.Points(phGeo, new THREE.PointsMaterial({ size: 0.09, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })));
  phPts.frustumCulled = false;
  let count = N;
  const view = {
    N, P,
    setQuality(alto) { count = alto ? N : Math.floor(N * 0.55); for (const m of [body, head, hair, armL, armR]) m.count = count; for (const s of signMeshes) s.m.count = s.who.filter(i => i < count).length; phGeo.setDrawRange(0, phones.filter(i => i < count).length); },
    setTeams(mySide) {
      P.forEach((p, i) => {
        const mine = p.team === mySide;
        const c = p.r < 0.45 ? (mine ? TEAM_ME : TEAM_OP)[(p.r * 7 | 0) % 3] : p.shirt;
        body.setColorAt(i, _col.setHex(c));
      });
      body.instanceColor.needsUpdate = true;
    },
    update(t) {
      const ex = crowd.excite, R = crowd.react, rt = R ? t - R.t0 : 99, olaT = t - crowd.olaT0, ola = olaT >= 0 && olaT < 5.5;
      const clapPh = Math.sin(t * Math.PI * 2 / 0.52);
      let pk = 0;
      for (let i = 0; i < count; i++) {
        const p = P[i];
        let jump = Math.max(0, Math.sin(t * (6 + p.amp * 3) + p.ph)) * ex * 0.22 * p.amp;
        let up = Math.max(0, ex - 0.55) * 0.9 * (0.5 + 0.5 * Math.sin(t * 2 + p.ph)), head2 = 0, clap = 0;
        if (rt < 3.4) {
          if (p.team === R.side) { const k = (1 - rt / 3.4) * R.amount; jump += Math.max(0, Math.sin(t * 9 + p.ph)) * 0.3 * p.amp * k; up = Math.max(up, Math.min(1, k * 1.6)); }
          else if (rt < 2.2) { head2 = Math.min(1, (1 - rt / 2.2) * 1.5) * R.amount; jump *= 0.2; up = 0; }
        }
        if (ola) {
          let d = ((olaT * 1.7 - (p.ang + Math.PI)) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
          if (olaT * 1.7 < Math.PI * 2 + 1 && d < 0.7) { const rise = Math.sin(d / 0.7 * Math.PI); jump += 0.38 * rise; up = Math.max(up, rise); }
        }
        if (crowd.clap) { clap = 1; up *= 0.3; }
        if (p.sign >= 0) up = Math.max(up, 0.75);
        const by = p.y + 0.35 * p.tall + jump + Math.sin(t * 1.1 + p.ph) * 0.008;
        _q1.setFromAxisAngle(_v1.set(0, 1, 0), p.yaw + Math.sin(t * 0.7 + p.ph) * 0.08);
        _v2.set(p.x, by, p.z); _m4.compose(_v2, _q1, _one); body.setMatrixAt(i, _m4);
        _v2.set(p.x, by + 0.4, p.z); _m4.compose(_v2, _q1, _one); head.setMatrixAt(i, _m4);
        _v1.set(0, 0.035, -0.012).applyQuaternion(_q1); _v2.add(_v1); _m4.compose(_v2, _q1, _hairS); hair.setMatrixAt(i, _m4);
        for (const s of [1, -1]) {
          // ângulo do braço: abaixado -> levantado (comemoração) / mãos na cabeça (lamento) / palmas
          let zr = s * (0.12 + up * 2.55 + head2 * 2.2), xr = -head2 * 0.7;
          if (clap) { xr = -1.25; zr = -s * (0.1 + 0.18 * (1 + clapPh * (s > 0 ? 1 : 1))); }
          _e.set(xr, 0, zr, 'ZXY'); _q2.setFromEuler(_e); _q3.copy(_q1).multiply(_q2);
          _v1.set(s * 0.2, 0.19, 0).applyQuaternion(_q1).add(_v2.set(p.x, by, p.z));
          _v2.set(0, -0.175, 0).applyQuaternion(_q3).add(_v1);
          _m4.compose(_v2, _q3, _one); (s > 0 ? armL : armR).setMatrixAt(i, _m4);
        }
        if (p.sign >= 0) {
          const bob = Math.sin(t * 5 + p.ph) * 0.04 * (0.3 + ex);
          _v1.set(0, 0.9 + bob + up * 0.05, 0.06).applyQuaternion(_q1).add(_v2.set(p.x, by, p.z));
          _q2.setFromAxisAngle(_v2.set(0, 0, 1), Math.sin(t * 3 + p.ph) * 0.12); _q3.copy(_q1).multiply(_q2);
          const sm = signMeshes[p.sign]; _m4.compose(_v1, _q3, _one); sm.m.setMatrixAt(sm.who.indexOf(i), _m4);
        }
        if (p.phone) {
          _v1.set(0.12, 0.62 + up * 0.35, 0.16).applyQuaternion(_q1);
          phPos[pk * 3] = p.x + _v1.x; phPos[pk * 3 + 1] = by + _v1.y; phPos[pk * 3 + 2] = p.z + _v1.z;
          const fl = 0.35 + 0.65 * Math.max(0, Math.sin(t * (2 + p.amp) + p.ph * 3)) + up * 0.6;
          phCol[pk * 3] = phCol[pk * 3 + 1] = phCol[pk * 3 + 2] = fl * 1.4;
          pk++;
        }
      }
      for (const m of [body, head, hair, armL, armR]) m.instanceMatrix.needsUpdate = true;
      for (const s of signMeshes) if (s.who.length) s.m.instanceMatrix.needsUpdate = true;
      if (phones.length) { phGeo.attributes.position.needsUpdate = true; phGeo.attributes.color.needsUpdate = true; }
    }
  };
  view.setTeams(crowd.mySide);
  return view;
}
function crowdEvent(winnerSide, amount, ola) {
  const t = performance.now() / 1000;
  crowd.react = { side: winnerSide, amount: clamp(amount, 0.4, 1), t0: t };
  if (ola) crowd.olaT0 = t + 0.6;
}

/* ---------- Os cenários ---------- */
const ARENAS = [
  {
    id: 'neon', name: 'Arena Neon', emoji: '🌃', tag: 'Ginásio noturno com luzes neon',
    bg: 0x07020a, fog: [0x07020a, 11, 30], exposure: 1.6, dust: true,
    light: { hemi: [0x8090ff, 0x40101e, 0.09], main: [0xfff4ea, 46], rim: [0xff3d8b, 0x3dc8ff, 0x9a5cff, 0xff7a3d], rimI: 16, fill: [0xffffff, 0.17, -2, 4, 3] },
    audio: { rev: 0.28, crowd: 1, amb: null },
    build() {
      ground(60, 60, M({ color: 0x1a0610, roughness: 0.7, envMapIntensity: 0.2 }));
      ground(7.4, 11.2, M({ map: courtTexture('#c81a55', '#8a0f38', 'rgba(255,255,255,.5)', 'PING PONG', 'O N L I N E'), roughness: 0.42, envMapIntensity: 0.45 }), 0.003);
      boards([['PING PONG ONLINE', '#ff4f8b'], ['TOP-SPIN ARENA', '#3dc8ff'], ['🏓 SMASH!', '#ffd34d'], ['JOGUE COM OS AMIGOS', '#b98cff']]);
      const seats = stands({ mat: M({ color: 0x16111a, roughness: 0.85 }), rows: 6, sideStart: 5.0, endStart: 7.3, sideLen: 17.5, endLen: 9.2 });
      A.crowdView = buildCrowd(seats, { signs: true, phones: 0.12 });
      trussRig(9.6, 13.2, 6.6, 0xfff2e0);
      jumbos(9.9);
      addBeam(V3(0, 6.2, 0.4), V3(0, 0, 0), 2.2, 0xfff0f6, 0.07);
      addBeam(V3(-4, 5.5, -5), V3(-0.6, 0, -0.8), 1.3, 0xff3d8b, 0.09);
      addBeam(V3(4, 5.5, 5), V3(0.6, 0, 0.8), 1.3, 0x3dc8ff, 0.09);
      addBeam(V3(4, 5.5, -5), V3(0.6, 0, -0.8), 1.3, 0x9a5cff, 0.08, true);
      addBeam(V3(-4, 5.5, 5), V3(-0.6, 0, 0.8), 1.3, 0xff7a3d, 0.08, true);
    }
  },
  {
    id: 'ginasio', name: 'Ginásio do Bairro', emoji: '🏫', tag: 'Interclasses de dia, com sol entrando',
    bg: 0xcfd8e2, fog: [0xcfd8e2, 20, 45], exposure: 1.05, dust: true,
    light: { hemi: [0xfff6ea, 0x8a6a4a, 0.75], main: [0xffffff, 26], rim: [0xfff1dc, 0xfff1dc, 0xfff1dc, 0xfff1dc], rimI: 3, fill: [0xffe2b8, 0.9, -6, 5, -2] },
    audio: { rev: 0.5, crowd: 0.62, amb: null },
    build() {
      const W = 18, D = 24, H = 7.5;
      const parquet = canvasTex(1024, 1024, (g, w, h) => {
        for (let y = 0; y < h; y += 32) for (let x = -(y / 32 % 4) * 64; x < w; x += 256) { g.fillStyle = `hsl(${30 + Math.random() * 6},${45 + Math.random() * 10}%,${52 + Math.random() * 10}%)`; g.fillRect(x, y, 254, 31); }
        noiseFill(g, w, h, 9000, 0.06);
      });
      ground(W, D, M({ map: repeatTex(parquet, 4, 5), roughness: 0.35, envMapIntensity: 0.8 }));
      // linhas de quadra de basquete pintadas no piso
      const lines = canvasTex(1024, 1365, (g, w, h) => {
        g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 7; g.strokeRect(40, 40, w - 80, h - 80);
        g.beginPath(); g.moveTo(40, h / 2); g.lineTo(w - 40, h / 2); g.stroke();
        g.beginPath(); g.arc(w / 2, h / 2, 120, 0, 6.3); g.stroke();
        g.strokeStyle = 'rgba(200,40,40,.8)'; for (const s of [0, 1]) { const y0 = s ? h - 40 : 40, d = s ? -1 : 1; g.strokeRect(w / 2 - 160, Math.min(y0, y0 + d * 380), 320, 380); g.beginPath(); g.arc(w / 2, y0 + d * 380, 160, 0, 6.3); g.stroke(); }
      });
      ground(15, 20, new THREE.MeshStandardMaterial({ map: lines, transparent: true, depthWrite: false, roughness: 0.35 }), 0.004);
      // paredes: barrado azul, parte de cima clara com janelões
      const wallTex = canvasTex(1024, 512, (g, w, h) => {
        g.fillStyle = '#efe6d2'; g.fillRect(0, 0, w, h); g.fillStyle = '#2d5d9a'; g.fillRect(0, h * 0.72, w, h * 0.28);
        g.fillStyle = '#f6c945'; g.fillRect(0, h * 0.7, w, 8);
        for (let x = 40; x < w - 100; x += 165) { g.fillStyle = '#dff3ff'; g.fillRect(x, 50, 120, 170); g.strokeStyle = '#6e7f90'; g.lineWidth = 6; g.strokeRect(x, 50, 120, 170); g.beginPath(); g.moveTo(x + 60, 50); g.lineTo(x + 60, 220); g.moveTo(x, 135); g.lineTo(x + 120, 135); g.stroke(); }
        noiseFill(g, w, h, 4000, 0.03);
      });
      const wm = M({ map: wallTex, roughness: 0.9, emissive: 0x222018, emissiveIntensity: 0.3 });
      flat(D, H, wm, -W / 2, H / 2, 0, Math.PI / 2); flat(D, H, wm, W / 2, H / 2, 0, -Math.PI / 2);
      const endTex = canvasTex(1024, 512, (g, w, h) => {
        g.fillStyle = '#efe6d2'; g.fillRect(0, 0, w, h); g.fillStyle = '#2d5d9a'; g.fillRect(0, h * 0.72, w, h * 0.28); g.fillStyle = '#f6c945'; g.fillRect(0, h * 0.7, w, 8);
        g.fillStyle = '#c62a2a'; g.fillRect(w * 0.18, 40, w * 0.64, 70); g.fillStyle = '#fff'; g.font = '900 46px system-ui'; g.textAlign = 'center'; g.fillText('INTERCLASSES 2026', w / 2, 92);
      });
      const em = M({ map: endTex, roughness: 0.9 });
      flat(W, H, em, 0, H / 2, -D / 2, 0); flat(W, H, em, 0, H / 2, D / 2, Math.PI);
      ground(W, D, M({ color: 0x8a8f96, roughness: 0.9 }), H).rotation.x = Math.PI / 2;
      box(3.3, 1.45, 0.12, trussMat, 0, 5.0, -D / 2 + 0.08); flat(3.1, 1.25, jumboMat, 0, 5.0, -D / 2 + 0.15);   // placar eletrônico
      // luminárias tubulares
      const tube = M({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 3 });
      for (let x = -6; x <= 6; x += 3) for (let z = -9; z <= 9; z += 3) box(0.18, 0.06, 1.6, tube, x, H - 0.2, z);
      // tabelas de basquete nas pontas
      for (const s of [-1, 1]) {
        box(1.8, 1.05, 0.04, M({ color: 0xffffff, transparent: true, opacity: 0.85, roughness: 0.2 }), 0, 3.4, s * (D / 2 - 1.1));
        box(0.08, 0.08, 1.1, M({ color: 0x555555, metalness: 0.7 }), 0, 3.4, s * (D / 2 - 0.55));
        const hoop = add(new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.015, 8, 24), M({ color: 0xff5a1a, metalness: 0.5 }))); hoop.rotation.x = Math.PI / 2; hoop.position.set(0, 3.05, s * (D / 2 - 1.45));
      }
      // separadores azuis de competição (impressos, não LED)
      boards([['TÊNIS DE MESA', '#ffffff'], ['INTERCLASSES', '#f6c945'], ['ESCOLA DO BAIRRO', '#ffffff']], { led: false, bg: '#173d78', side: 0x173d78 });
      // arquibancada de madeira nos dois lados compridos
      const seats = stands({ mat: M({ color: 0x9a6a3c, roughness: 0.8 }), rows: 5, rowH: 0.4, rowD: 0.7, base: 0.4, sideStart: 5.2, sideLen: 16, sides: ['x+', 'x-'], fill: 0.62 });
      A.crowdView = buildCrowd(seats, { signs: true, phones: 0, palette: [0xffffff, 0xffffff, 0x2d5d9a, 0x1f3f70, 0xf6c945, 0xdddddd, 0x9a9a9a] });
      // raios de sol entrando pelas janelas
      for (const z of [-6, -1, 4]) addBeam(V3(-8.8, 6.2, z), V3(-2.5, 0, z + 1.2), 1.1, 0xfff0c8, 0.06, z !== -1);
    }
  },
  {
    id: 'praia', name: 'Praia ao Pôr do Sol', emoji: '🏖️', tag: 'Torneio na areia, de frente pro mar',
    bg: 0xf09060, fog: [0xe89070, 28, 70], exposure: 1.18, dust: false, fireworks: true,
    light: { hemi: [0xffc49a, 0x5a3a3a, 0.7], main: [0xffe2c0, 24], rim: [0xff8a4a, 0xffb070, 0xff6a5a, 0xffc080], rimI: 5, fill: [0xff9a50, 1.1, 0, 2.2, -12] },
    audio: { rev: 0.06, crowd: 0.6, amb: 'breeze' },
    build() {
      skyDome(0x2a1d5c, 0xff8a4a, 0xffb27a, V3(0, 0.06, -1), 0xffd28a, 1.2);
      const sand = canvasTex(512, 512, (g, w, h) => { g.fillStyle = '#e2c08d'; g.fillRect(0, 0, w, h); noiseFill(g, w, h, 30000, 0.12, 1.5); for (let i = 0; i < 60; i++) { g.fillStyle = 'rgba(150,110,60,.12)'; g.beginPath(); g.ellipse(Math.random() * w, Math.random() * h, 6, 10, Math.random() * 3, 0, 6.3); g.fill(); } });
      ground(90, 60, M({ map: repeatTex(sand, 18, 12), roughness: 1, envMapIntensity: 0.3 })).position.z = 14;
      // mar com reflexo do sol
      const sea = add(new THREE.Mesh(new THREE.PlaneGeometry(140, 46), new THREE.ShaderMaterial({
        fog: false, uniforms: { uT: { value: 0 }, deep: { value: new THREE.Color(0x2a3a7a) }, shallow: { value: new THREE.Color(0x3a8a9a) }, sun: { value: new THREE.Color(0xffc070) }, hor: { value: new THREE.Color(0xffa070) } },
        vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: `uniform float uT; uniform vec3 deep, shallow, sun, hor; varying vec3 vW;
          void main(){ vec2 p = vW.xz; float w = sin(p.x*1.3+uT*1.2)*0.5 + sin(p.y*2.1-uT*1.7+p.x*0.4)*0.5;
            vec3 c = mix(shallow, deep, smoothstep(-16.0, -40.0, p.y));
            float streak = exp(-abs(p.x)*0.22) * smoothstep(-14.0, -45.0, p.y);
            float gl = pow(max(0.0, 0.5 + 0.5*w + 0.3*sin(p.x*7.0+uT*3.0+p.y*3.0)), 6.0);
            c += sun * streak * (0.25 + gl*1.8);
            c = mix(c, hor, smoothstep(-38.0, -60.0, p.y));
            gl_FragColor = vec4(c, 1.0); }`
      })));
      sea.rotation.x = -Math.PI / 2; sea.position.set(0, 0.01, -14 - 23);
      sea.material.uniforms.uT.value = 2.0;              // mar parado: sem animação de onda
      // tablado de madeira embaixo da mesa
      const deck = canvasTex(512, 512, (g, w, h) => { for (let x = 0; x < w; x += 64) { g.fillStyle = `hsl(28,${35 + Math.random() * 10}%,${36 + Math.random() * 8}%)`; g.fillRect(x, 0, 62, h); } noiseFill(g, w, h, 5000, 0.08); });
      const dk = box(7.4, 0.08, 10.6, M({ map: repeatTex(deck, 3, 1), roughness: 0.8 }), 0, 0.04, 0); dk.receiveShadow = true;
      for (const sx of [-1, 1]) box(7.4, 0.02, 0.06, M({ color: 0xffffff }), 0, 0.09, sx * 5.2);
      // cerquinha de corda
      const post = M({ color: 0x8a6a44, roughness: 0.9 });
      for (const [bx, bz] of [[4.4, 6.4]]) {
        for (let x = -bx; x <= bx + 0.01; x += bx / 3) for (const s of [-1, 1]) box(0.08, 0.9, 0.08, post, x, 0.45, s * bz);
        for (let z = -bz; z <= bz + 0.01; z += bz / 4) for (const s of [-1, 1]) box(0.08, 0.9, 0.08, post, s * bx, 0.45, z);
        const rope = M({ color: 0xd8c39a, roughness: 1 });
        for (const s of [-1, 1]) { box(2 * bx, 0.03, 0.03, rope, 0, 0.8, s * bz); box(0.03, 0.03, 2 * bz, rope, s * bx, 0.8, 0); }
      }
      // coqueiros, guarda-sóis e pranchas
      palm(-7.5, -9, 5.2, 0.5, 0.3); palm(8, -10, 5.8, -0.6, 0.2); palm(-9.5, 3, 4.8, 0.7, -0.1); palm(10, 4, 5.4, -0.5, 0.4); palm(-6, 11, 5, 0.4, -0.4); palm(7, 12, 5.6, -0.3, -0.6);
      umbrella(-6.5, -4, '#ff5a5a', '#ffffff'); umbrella(6.8, -3, '#3dc8ff', '#ffffff'); umbrella(-6.8, 6, '#ffd34d', '#ff7a3d'); umbrella(7, 7.5, '#2fd16b', '#ffffff');
      const boardCols = [0xff7a3d, 0x3dc8ff, 0xffd34d, 0xff3d7f];
      [[-5.2, -7.2], [5.4, -7.5], [-5.8, 8.6]].forEach(([x, z], i) => { const b = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.5, 4, 12), M({ color: boardCols[i], roughness: 0.4 }))); b.scale.set(1, 1, 0.18); b.position.set(x, 0.9, z); b.rotation.z = 0.15 * (i - 1); });
      // varal de lâmpadas entre postes
      const H = 3.4, cx = 4.6, cz = 6.8;
      for (const [x, z] of [[-cx, -cz], [cx, -cz], [cx, cz], [-cx, cz]]) box(0.1, H, 0.1, post, x, H / 2, z);
      stringLights([[V3(-cx, H, -cz), V3(cx, H, -cz)], [V3(cx, H, -cz), V3(cx, H, cz)], [V3(cx, H, cz), V3(-cx, H, cz)], [V3(-cx, H, cz), V3(-cx, H, -cz)], [V3(-cx, H, -cz), V3(cx, H, cz)], [V3(cx, H, -cz), V3(-cx, H, cz)]], 0xffd9a0, 14, 0.45);
      // público em pé na areia, sem tampar a vista do mar
      const seats = standingRing(5.0, 7.3, 4, 0.55, 0.62, (x, z) => z < -7 && Math.abs(x) < 3.5);
      A.crowdView = buildCrowd(seats, { signs: true, phones: 0.05, palette: [0xffffff, 0xff7a3d, 0x3dc8ff, 0xffd34d, 0x2fd16b, 0xff5a8a, 0xf2e6cf] });
    }
  },
  {
    id: 'terraco', name: 'Terraço da Cidade', emoji: '🏙️', tag: 'Rooftop à noite no meio dos prédios',
    bg: 0x0a0f22, fog: [0x0e1430, 22, 70], exposure: 1.5, dust: false, fireworks: true,
    light: { hemi: [0x5070c0, 0x101018, 0.18], main: [0xfff0dc, 40], rim: [0x3dc8ff, 0xff3d8b, 0x3dc8ff, 0xff3d8b], rimI: 10, fill: [0x7090ff, 0.18, 3, 5, -4] },
    audio: { rev: 0.1, crowd: 0.58, amb: 'city' },
    build() {
      skyDome(0x050816, 0x1a2350, 0x2a2448, V3(-0.4, 0.35, -1), 0x9ab0ff, 0.25);
      stars(500);
      const moon = add(new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: new THREE.Color(2.2, 2.2, 2.4), fog: false, depthWrite: false })));
      moon.position.set(-20, 18, -44); moon.scale.set(3.2, 3.2, 1);
      // prédios da cidade com janelas acesas
      const win = canvasTex(128, 256, (g, w, h) => { g.fillStyle = '#05060c'; g.fillRect(0, 0, w, h); for (let y = 6; y < h - 6; y += 12) for (let x = 6; x < w - 6; x += 14) if (Math.random() < 0.42) { g.fillStyle = Math.random() < 0.7 ? '#ffd890' : '#cfe6ff'; g.fillRect(x, y, 8, 7); } });
      const city = [];
      for (let i = 0; i < 160; i++) {
        const a = Math.random() * Math.PI * 2, r = 18 + Math.random() * 26;
        const x = Math.cos(a) * r, z = Math.sin(a) * r, w = 2 + Math.random() * 4, d = 2 + Math.random() * 4, h = 6 + Math.random() * Math.random() * 30;
        city.push([x, z, w, d, h]);
      }
      const bm = add(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), M({ color: 0x141826, emissive: 0xffffff, emissiveMap: win, emissiveIntensity: 1.1, roughness: 0.8 }), city.length));
      city.forEach(([x, z, w, d, h], i) => { _m4.compose(_v1.set(x, h / 2 - 8, z), _q1.identity(), _v2.set(w, h, d)); bm.setMatrixAt(i, _m4); });
      const tall = city.filter(c => c[4] > 22).slice(0, 12);
      const blink = tall.map(([x, z, w, d, h]) => { const s = add(new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: new THREE.Color(3, 0.3, 0.3), depthWrite: false, fog: false }))); s.position.set(x, h - 8 + 0.6, z); s.scale.set(0.9, 0.9, 1); return s; });
      A.upd.push(t => blink.forEach((s, i) => { s.visible = Math.sin(t * 2.4 + i * 1.3) > 0.2; }));
      // laje de concreto e quadra pintada
      const conc = canvasTex(512, 512, (g, w, h) => { g.fillStyle = '#565a60'; g.fillRect(0, 0, w, h); noiseFill(g, w, h, 30000, 0.08, 1.5); for (let i = 0; i < 14; i++) { g.fillStyle = 'rgba(20,20,25,.12)'; g.beginPath(); g.ellipse(Math.random() * w, Math.random() * h, 20 + Math.random() * 50, 10 + Math.random() * 30, Math.random() * 3, 0, 6.3); g.fill(); } g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 2; for (let x = 0; x <= w; x += 128) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.beginPath(); g.moveTo(0, x); g.lineTo(w, x); g.stroke(); } });
      ground(17, 22, M({ map: repeatTex(conc, 4, 5), roughness: 0.85 }));
      ground(7.2, 10.8, M({ map: courtTexture('#1f7a8a', '#145060', 'rgba(255,255,255,.55)', 'ROOFTOP', 'P I N G   P O N G'), roughness: 0.6 }), 0.004);
      // parapeito de vidro e corrimão
      const glass = new THREE.MeshStandardMaterial({ color: 0x9ad0ff, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.2, depthWrite: false });
      const rail = M({ color: 0xb8bcc4, metalness: 0.85, roughness: 0.3 });
      for (const s of [-1, 1]) { box(17, 1.1, 0.03, glass, 0, 0.55, s * 11); box(17, 0.05, 0.08, rail, 0, 1.12, s * 11); box(0.03, 1.1, 22, glass, s * 8.5, 0.55, 0); box(0.08, 0.05, 22, rail, s * 8.5, 1.12, 0); }
      // caixa d'água, ar-condicionados, bancos
      const tank = add(new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 1.8, 20), M({ color: 0x7a7f88, metalness: 0.4, roughness: 0.6 }))); tank.position.set(6.5, 2.2, -8.8);
      for (const [x, z] of [[5.8, -9.5], [7.2, -9.5], [5.8, -8.1], [7.2, -8.1]]) box(0.1, 1.3, 0.1, rail, x, 0.65, z);
      const acm = M({ color: 0xd8dade, roughness: 0.6 });
      for (const [x, z] of [[-6.8, -9], [-5.4, -9], [-7, 8.8]]) { box(1.1, 0.8, 0.9, acm, x, 0.4, z); const f = add(new THREE.Mesh(new THREE.CircleGeometry(0.3, 18), M({ color: 0x222222 }))); f.rotation.x = -Math.PI / 2; f.position.set(x, 0.81, z); }
      // letreiro neon
      box(5.6, 1.6, 0.15, trussMat, 0, 3.6, -10.6); for (const x of [-2.4, 2.4]) box(0.12, 3, 0.12, trussMat, x, 1.5, -10.6);
      const neonTex = canvasTex(1024, 290, (g, w, h) => {
        g.fillStyle = '#05050a'; g.fillRect(0, 0, w, h); g.textAlign = 'center'; g.textBaseline = 'middle';
        g.shadowColor = '#ff3d8b'; g.shadowBlur = 30; g.fillStyle = '#ff77b0'; g.font = 'italic 900 120px system-ui'; g.fillText('PING PONG', w / 2, h * 0.4);
        g.shadowColor = '#3dc8ff'; g.fillStyle = '#9be8ff'; g.font = '800 64px system-ui'; g.fillText('★ C L U B ★', w / 2, h * 0.8);
      });
      const neon = flat(5.4, 1.5, M({ color: 0x000000, emissive: 0xffffff, emissiveMap: neonTex, emissiveIntensity: 1.6 }), 0, 3.6, -10.52);
      A.upd.push(t => { neon.material.emissiveIntensity = 1.6 + (Math.sin(t * 13) > 0.97 ? -0.9 : 0) + Math.sin(t * 2) * 0.1; });
      // varal de lâmpadas em zigue-zague e postes
      const H = 3.6;
      for (const [x, z] of [[-5, -7], [5, -7], [5, 7], [-5, 7], [-5, 0], [5, 0]]) box(0.1, H, 0.1, rail, x, H / 2, z);
      stringLights([[V3(-5, H, -7), V3(5, H, -3.5)], [V3(5, H, -3.5), V3(-5, H, 0)], [V3(-5, H, 0), V3(5, H, 3.5)], [V3(5, H, 3.5), V3(-5, H, 7)], [V3(-5, H, -7), V3(-5, H, 7)], [V3(5, H, -7), V3(5, H, 7)]], 0xfff0d0, 14, 0.4);
      const seats = standingRing(4.4, 6.6, 3, 0.6, 0.55, (x, z) => (z < -6.5 && Math.abs(x) < 3) || (x > 4.9 && z < -7.5));
      A.crowdView = buildCrowd(seats, { signs: true, phones: 0.2, palette: [0x222233, 0x111111, 0xffffff, 0x3dc8ff, 0xff3d8b, 0x444455, 0xffd34d] });
    }
  },
  {
    id: 'final', name: 'Final Mundial', emoji: '🏆', tag: 'Estádio lotado, telão e pirotecnia',
    bg: 0x05060f, fog: [0x05060f, 18, 48], exposure: 1.55, dust: true, fireworks: true,
    light: { hemi: [0x9ab0ff, 0x20102a, 0.12], main: [0xf4f8ff, 60], rim: [0xffffff, 0xffd34d, 0xffd34d, 0xffffff], rimI: 18, fill: [0xffffff, 0.2, -2, 4, 3] },
    audio: { rev: 0.36, crowd: 1.35, amb: null },
    build() {
      ground(80, 80, M({ color: 0x0a0c18, roughness: 0.6, envMapIntensity: 0.3 }));
      ground(7.6, 11.4, M({ map: courtTexture('#1a3f9a', '#0c2260', 'rgba(255,211,77,.8)', 'FINAL MUNDIAL', 'P I N G   P O N G'), roughness: 0.4, envMapIntensity: 0.5 }), 0.003);
      boards([['FINAL MUNDIAL', '#ffd34d'], ['🏆 CAMPEÃO 2026', '#ffffff'], ['PING PONG ONLINE', '#ffd34d'], ['AO VIVO', '#ff3d55']], { side: 0x15130a });
      const seats = stands({ mat: M({ color: 0x141826, roughness: 0.85 }), rows: 9, rowH: 0.5, rowD: 0.72, sideStart: 6.0, endStart: 8.2, sideLen: 21, endLen: 11.5, fill: 0.86, spacing: 0.55 });
      A.crowdView = buildCrowd(seats, { signs: true, phones: 0.16 });
      // faixa de LED na frente da arquibancada
      const rib = canvasTex(2048, 64, (g, w, h) => { g.fillStyle = '#060608'; g.fillRect(0, 0, w, h); g.font = 'italic 900 44px system-ui'; g.textBaseline = 'middle'; for (let x = 0; x < w; x += 512) { g.fillStyle = '#ffd34d'; g.fillText('FINAL MUNDIAL ★', x + 20, h / 2 + 2); g.fillStyle = '#ffffff'; g.fillText('2026', x + 410, h / 2 + 2); } });
      rib.wrapS = THREE.RepeatWrapping; rib.repeat.set(3, 1);
      const ribMat = M({ color: 0x000000, emissive: 0xffffff, emissiveMap: rib, emissiveIntensity: 1.2 });
      for (const s of [-1, 1]) { flat(21, 0.3, ribMat, s * 5.6, 0.24, 0, -s * Math.PI / 2); flat(11.5, 0.3, ribMat, 0, 0.24, s * 7.82, s > 0 ? Math.PI : 0); }
      A.ribbon = rib;
      // telão cúbico no centro + telões nas pontas
      const cube = new THREE.Group(); cube.position.set(0, 7.4, 0); add(cube);
      box(3.4, 1.7, 3.4, trussMat, 0, 0, 0, cube);
      for (let k = 0; k < 4; k++) { const sc = flat(3.2, 1.45, jumboMat, Math.sin(k * Math.PI / 2) * 1.71, 0, Math.cos(k * Math.PI / 2) * 1.71, k * Math.PI / 2, cube); }
      box(3.6, 0.12, 3.6, M({ color: 0x000000, emissive: 0xffd34d, emissiveIntensity: 2.5 }), 0, -0.9, 0, cube);
      jumbos(13.6, 7.0, 6, 2.4);
      trussRig(12, 16, 8.4, 0xffffff);
      // bandeiras penduradas
      const flagCols = [['#009c3b', '#ffdf00'], ['#ffffff', '#d52b1e'], ['#002395', '#ed2939'], ['#000000', '#dd0000'], ['#74acdf', '#ffffff'], ['#de2910', '#ffde00'], ['#012169', '#c8102e'], ['#ff9933', '#138808']];
      const flags = [];
      for (let i = 0; i < 16; i++) {
        const [c1, c2] = flagCols[i % flagCols.length];
        const ft = canvasTex(64, 128, (g, w, h) => { g.fillStyle = c1; g.fillRect(0, 0, w, h); g.fillStyle = c2; g.fillRect(0, h / 3, w, h / 3); });
        const a = i / 16 * Math.PI * 2, r = 9.5;
        const f = flat(1.1, 2.4, M({ map: ft, side: THREE.DoubleSide, roughness: 0.9 }), Math.cos(a) * r * 0.72, 8.2, Math.sin(a) * r, -a + Math.PI / 2);
        flags.push(f);
      }
      A.upd.push(t => flags.forEach((f, i) => { f.rotation.z = Math.sin(t * 0.9 + i) * 0.04; }));
      // holofotes de busca que varrem a arena
      const sweep = [];
      for (const [x, z, c] of [[-6, -9, 0xffffff], [6, 9, 0xffd34d], [6, -9, 0xffffff], [-6, 9, 0xffd34d]]) {
        const piv = new THREE.Group(); piv.position.set(x, 9, z); add(piv);
        const m = beamMat.clone(); m.uniforms.color.value = new THREE.Color(c); m.uniforms.strength.value = 0.05;
        const g = new THREE.ConeGeometry(1.2, 10, 24, 1, true); g.scale(1, 0.1, 1); g.translate(0, -0.5, 0);
        const cone = new THREE.Mesh(g, m); cone.scale.y = 10; piv.add(cone); sweep.push(piv); A.beamsOpt.push(cone);
      }
      A.upd.push(t => sweep.forEach((p, i) => { p.rotation.set(0.5 + Math.sin(t * 0.5 + i) * 0.35, 0, Math.sin(t * 0.37 + i * 1.7) * 0.6); p.children[0].material.uniforms.strength.value = 0.04 + crowd.excite * 0.06; }));
      addBeam(V3(0, 6.2, 0.4), V3(0, 0, 0), 2.4, 0xffffff, 0.07);
      // troféu no pedestal
      const gold = M({ color: 0xffc84a, metalness: 1, roughness: 0.22, envMapIntensity: 3 });
      box(0.55, 1.0, 0.55, M({ color: 0x0b0b10, roughness: 0.4, metalness: 0.5 }), 3.0, 0.5, 1.2);
      box(0.6, 0.04, 0.6, gold, 3.0, 1.01, 1.2);
      const cup = add(new THREE.Mesh(new THREE.LatheGeometry([[0.0, 0], [0.12, 0], [0.12, 0.04], [0.04, 0.08], [0.035, 0.22], [0.06, 0.26], [0.16, 0.34], [0.2, 0.5], [0.19, 0.56], [0.0, 0.5]].map(([r, y]) => new THREE.Vector2(r, y)), 28), gold));
      cup.position.set(3.0, 1.03, 1.2); cup.castShadow = true;
      for (const s of [-1, 1]) { const h = add(new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.015, 8, 16, Math.PI), gold)); h.position.set(3.0 + s * 0.2, 1.48, 1.2); h.rotation.z = -s * Math.PI / 2; }
      // colunas de pirotecnia nos cantos
      A.pyroAt = [[-3.9, -5.9], [3.9, -5.9], [3.9, 5.9], [-3.9, 5.9]];
      for (const [x, z] of A.pyroAt) box(0.35, 0.5, 0.35, M({ color: 0x111111, metalness: 0.6, roughness: 0.4 }), x, 0.25, z);
    }
  },
];
const arenaById = id => ARENAS.find(a => a.id === id) || ARENAS[0];

function disposeArena() {
  arenaRoot.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) {
      if (m.userData.keep) continue;
      for (const k of ['map', 'emissiveMap', 'alphaMap']) if (m[k] && !m[k].userData.keep && m[k] !== dotTex) m[k].dispose();
      m.dispose();
    }
  });
  arenaRoot.clear();
  TEX._c = {};
}
function buildArena(id) {
  const def = arenaById(id);
  disposeArena();
  Object.assign(A, { id: def.id, def, led: null, ribbon: null, crowdView: null, beams: [], beamsOpt: [], upd: [], pyroAt: [], fireworks: !!def.fireworks });
  def.build();
  // luzes e ambiente do cenário
  const L = def.light;
  hemi.color.setHex(L.hemi[0]); hemi.groundColor.setHex(L.hemi[1]); hemi.intensity = L.hemi[2];
  mainSpot.color.setHex(L.main[0]); mainSpot.intensity = L.main[1];
  rimSpots.forEach((s, i) => s.color.setHex(L.rim[i]));
  A.rimBase = L.rimI; A.rimPulse = L.rimI * 0.18; A.rimFlash = L.rimI * 1.3;
  fill.color.setHex(L.fill[0]); fill.intensity = L.fill[1]; fill.position.set(L.fill[2], L.fill[3], L.fill[4]);
  scene.background = new THREE.Color(def.bg);
  scene.fog = new THREE.Fog(def.fog[0], def.fog[1], def.fog[2]);
  renderer.toneMappingExposure = def.exposure;
  arenaRoot.traverse(o => { const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; for (const m of ms) if (m.envMapIntensity !== undefined && !m.userData.envDone) { m.envMapIntensity *= 0.18; m.userData.envDone = true; } });
  if (A.crowdView) A.crowdView.setQuality(Q.level === 'alto');
  for (const b of A.beamsOpt) b.visible = Q.level === 'alto';
  if (typeof applyArenaAudio === 'function') applyArenaAudio();
  if (typeof dust !== 'undefined') dust.visible = Q.level === 'alto' && def.dust;
  drawJumbo();
}
function updateArena(t, dt) {
  if (A.led) {
    const L = A.led;
    if (L.mat) {
      L.t += dt;
      if (L.t > 4.5) { L.t = 0; L.idx = (L.idx + 1) % L.n; }
      const k = ease(Math.min(1, L.t / 0.5)); L.tex.offset.x = ((L.idx - 1 + k) / L.n + 1) % 1;
      L.mat.emissiveIntensity = 0.8 + Math.sin(ledFlash * 18) * ledFlash * 0.9 + ledFlash * 0.9;
    }
  }
  if (A.ribbon) A.ribbon.offset.x = (t * 0.04) % 1;
  for (const f of A.upd) f(t, dt);
  if (A.crowdView) A.crowdView.update(t, dt);
}
// pirotecnia (final) e fogos de artifício (praia, terraço, final)
function pyroBurst(amount) {
  for (const [x, z] of A.pyroAt) pyro.emit(Math.round(26 * amount), x, 0.55, z, 0xffc040, 1.2, { upOnly: true, up: 4.2 + amount * 1.5, grav: 4.5, life: 1.1, intensity: 3, drag: 0.6 });
  if (A.pyroAt.length && typeof boom === 'function') boom(0.5 * amount);
}
function fireworks(n) {
  if (!A.fireworks) return;
  for (let i = 0; i < n; i++) setTimeout(() => {
    const x = (Math.random() - 0.5) * 16, y = 7 + Math.random() * 5, z = -9 - Math.random() * 10 * (A.id === 'final' ? 0 : 1);
    pyro.emit(70, x, y, z, 0xffffff, 3.4, { rainbow: true, life: 1.6, grav: 1.4, drag: 1.3, intensity: 3.2 });
    if (typeof boom === 'function') boom(0.7);
  }, i * 380 + Math.random() * 200);
}

/* =====================================================================
   MESA
   ===================================================================== */
const table = new THREE.Group(); scene.add(table);
const topTex = canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = '#123f78'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.025})`; g.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5); }
});
const topMat = new THREE.MeshPhysicalMaterial({ map: topTex, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4, envMapIntensity: 0.6 });
const top = new THREE.Mesh(new RoundedBoxGeometry(TW, 0.03, TL, 2, 0.006), topMat);
top.position.y = TH - 0.015; top.castShadow = true; top.receiveShadow = true; table.add(top);
const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6 });
const addLine = (w, l, x, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.0015, l), lineMat); m.position.set(x, TH + 0.0008, z); m.receiveShadow = true; table.add(m); };
addLine(0.02, TL, -HW + 0.01, 0); addLine(0.02, TL, HW - 0.01, 0);
addLine(TW, 0.02, 0, -HL + 0.01); addLine(TW, 0.02, 0, HL - 0.01);
addLine(0.003, TL, 0, 0);
const metal = new THREE.MeshStandardMaterial({ color: 0x2c3038, metalness: 0.9, roughness: 0.32 });
const apron = new THREE.Mesh(new THREE.BoxGeometry(TW - 0.08, 0.05, TL - 0.08), new THREE.MeshStandardMaterial({ color: 0x101318, roughness: 0.6 }));
apron.position.y = TH - 0.055; apron.castShadow = true; table.add(apron);
for (const sz of [-1, 1]) {
  const fz = sz * HL * 0.52;
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, TH - 0.08, 0.05), metal); leg.position.set(sx * HW * 0.72, (TH - 0.08) / 2, fz); leg.castShadow = true; table.add(leg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.035, 0.55), metal); foot.position.set(sx * HW * 0.72, 0.02, fz); foot.castShadow = true; table.add(foot);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(HW * 1.44, 0.04, 0.04), metal); bar.position.set(0, 0.28, fz); table.add(bar);
}
const netTex = canvasTex(1024, 128, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  g.strokeStyle = 'rgba(30,30,40,.9)'; g.lineWidth = 1.4;
  for (let x = 0; x < w; x += 7) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let y = 0; y < h; y += 7) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  g.fillStyle = 'rgba(255,255,255,.9)'; g.font = 'italic 900 34px system-ui'; g.textAlign = 'center'; g.fillText('PING PONG ONLINE', w / 2, h / 2 + 14);
});
// rede subdividida: os vértices se deslocam quando a bola bate (estufa) ou raspa (a fita vibra)
const net = new THREE.Mesh(new THREE.PlaneGeometry(NET_HALF * 2, NET_H, 64, 8), new THREE.MeshStandardMaterial({ map: netTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, roughness: 0.8 }));
net.position.set(0, TH + NET_H / 2, 0); table.add(net);
const netBand = new THREE.Mesh(new THREE.BoxGeometry(NET_HALF * 2, 0.015, 0.006, 64, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
netBand.position.set(0, NET_TOP - 0.0075, 0); table.add(netBand);
const netWaves = [];
const netParts = [net, netBand].map(m => ({ m, base: Float32Array.from(m.geometry.attributes.position.array), oy: m.position.y }));
// deslocamento (em z) de um ponto da rede em x, altura y (coordenadas do mundo)
function netDisp(x, y) {
  let d = 0;
  const post = Math.sin(Math.PI * clamp((x + NET_HALF) / (2 * NET_HALF), 0, 1));   // presa nos postes
  for (const w of netWaves) {
    const lx = (x - w.x) / w.sx;
    let vp;
    if (w.graze) vp = 0.25 + 0.75 * clamp((y - TH) / NET_H, 0, 1);                   // raspão: mexe mais a fita de cima
    else { const ly = (y - w.y) / 0.085; vp = 0.3 + 0.7 * Math.exp(-ly * ly); }   // batida: estufa onde bateu
    d += w.a * Math.exp(-w.t / w.tau) * Math.cos(w.om * w.t) * Math.exp(-lx * lx) * vp;
  }
  return d * post;
}
function netHit(e) {
  const graze = !!e.graze, s = clamp(e.s / 6, 0.3, 1.3);
  netWaves.push(graze
    ? { x: e.x, y: NET_TOP, a: e.dir * (0.006 + 0.008 * s), sx: 0.4, tau: 0.32, om: 2 * Math.PI * 11, t: 0, graze: 1 }
    : { x: e.x, y: e.y, a: e.dir * (0.022 + 0.028 * s), sx: 0.24, tau: 0.22, om: 2 * Math.PI * 6.5, t: 0, graze: 0 });
  if (netWaves.length > 4) netWaves.shift();
  if (graze && S.phase === 'rally') {
    showLabel('RASPOU NA REDE!');
    if (typeof crowdVoice === 'function') crowdVoice('ohh', 0.4);
  }
}
let netIdle = true;
function updateNet(dt) {
  for (const w of netWaves) w.t += dt;
  while (netWaves.length && netWaves[0].t > netWaves[0].tau * 6) netWaves.shift();
  if (!netWaves.length && netIdle) return;
  netIdle = !netWaves.length;
  for (const P of netParts) {
    const pos = P.m.geometry.attributes.position, arr = pos.array, base = P.base;
    for (let i = 0; i < arr.length; i += 3) arr[i + 2] = base[i + 2] + (netIdle ? 0 : netDisp(base[i], base[i + 1] + P.oy));
    pos.needsUpdate = true;
  }
}
for (const s of [-1, 1]) {
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, NET_H + 0.02, 12), metal);
  post.position.set(s * (NET_HALF + 0.005), TH + NET_H / 2, 0); table.add(post);
  const clamp_ = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.025, 0.05), metal);
  clamp_.position.set(s * (HW + 0.03), TH - 0.005, 0); table.add(clamp_);
}

/* =====================================================================
   BOLA, SOMBRA, BRILHO E RASTRO
   ===================================================================== */
// skins da bolinha (cada jogador vê a que escolheu)
const BALL_SKINS = [
  { id: 'branca', name: 'Branca', base: '#fffaf2', stripe: '#ff9a3c', ink: '#222' },
  { id: 'laranja', name: 'Laranja', base: '#ff8a1f', stripe: '#fff3e0', ink: '#3a1800' },
  { id: 'preta', name: 'Preta', base: '#1c1c20', stripe: '#ff3d7f', ink: '#ffffff', glow: 0.12 },
  { id: 'rosa', name: 'Rosa', base: '#ff6fb0', stripe: '#ffffff', ink: '#4a0025' },
  { id: 'amarela', name: 'Amarela', base: '#ffe14a', stripe: '#ff7a1a', ink: '#3a2a00' },
  { id: 'verde', name: 'Verde neon', base: '#5dff7a', stripe: '#0b8f3a', ink: '#053a12' },
  { id: 'azul', name: 'Azul', base: '#3a8bff', stripe: '#ffffff', ink: '#06204a' },
  { id: 'roxa', name: 'Roxa', base: '#9a5cff', stripe: '#ffd34d', ink: '#ffffff' },
  { id: 'dourada', name: 'Dourada', base: '#f2c14e', stripe: '#8a5a10', ink: '#3a2500', metal: 0.35 },
  { id: 'arcoiris', name: 'Arco-íris', rainbow: true, stripe: '#ffffff', ink: '#222' },
];
const ballSkinById = id => BALL_SKINS.find(b => b.id === id) || BALL_SKINS[0];
const ballTexFor = sk => rtxBall[sk.id] || (rtxBall[sk.id] = canvasTex(256, 128, (g, w, h) => {
  if (sk.rainbow) { const gr = g.createLinearGradient(0, 0, w, 0); ['#ff3d5a', '#ff9a3c', '#ffe14a', '#5dff7a', '#3a8bff', '#9a5cff', '#ff3d5a'].forEach((c, i, a) => gr.addColorStop(i / (a.length - 1), c)); g.fillStyle = gr; }
  else g.fillStyle = sk.base;
  g.fillRect(0, 0, w, h);
  g.fillStyle = sk.stripe; g.fillRect(0, h / 2 - 3, w, 6);
  g.fillStyle = sk.ink; g.font = 'bold 22px system-ui'; g.fillText('★★★', 30, h / 2 - 14);
}));
const rtxBall = {};
let ballSkin = ballSkinById(store.get('pp_ball', 'branca'));
const ballMat = new THREE.MeshPhysicalMaterial({ roughness: 0.42, clearcoat: 0.25, clearcoatRoughness: 0.4, envMapIntensity: 0.25 });
function applyBallSkin(sk) {
  ballSkin = sk; store.set('pp_ball', sk.id);
  ballMat.map = ballTexFor(sk); ballMat.metalness = sk.metal || 0;
  ballMat.emissive.set(sk.rainbow ? '#ffffff' : sk.base); ballMat.emissiveIntensity = sk.glow ?? 0.06;   // só um pouquinho, para não "estourar" na luz
  ballMat.needsUpdate = true;
}
applyBallSkin(ballSkin);
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(0.0264, 28, 18), ballMat);
scene.add(ballMesh);
// halo em volta da bola: desligado por padrão (dá para ligar nas configurações), bem mais fraco
const ballGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xffd9b0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.22 }));
ballGlow.scale.set(0.08, 0.08, 1); scene.add(ballGlow);
const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false, alphaMap: dotTex });
const blob = new THREE.Mesh(new THREE.CircleGeometry(0.035, 24), blobMat);
blob.rotation.x = -Math.PI / 2; scene.add(blob);

const TRAIL_N = 50;
const trailPts = [];
const trailGeo = new THREE.BufferGeometry();
const tPos = new Float32Array(TRAIL_N * 2 * 3), tCol = new Float32Array(TRAIL_N * 2 * 3);
trailGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
trailGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 3));
{
  const idx = [];
  for (let i = 0; i < TRAIL_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  trailGeo.setIndex(idx);
}
const trailMesh = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
trailMesh.frustumCulled = false; scene.add(trailMesh);
const trailColor = new THREE.Color(0x22ff88);
const TRAIL_COLORS = { 'RASPOU NA REDE!': 0xffd34d, 'PINO LONGO': 0xff6fae, 'BOLA RETA': 0xc8d0ff, 'TOP-SPIN': 0x22ff88, 'SMASH!': 0xff2844, 'BLOQUEIO': 0x44aaff, 'SIDE-SPIN': 0xffcc22, 'SAQUE': 0xffffff, 'CORTE': 0x40e0ff };
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
function updateTrail() {
  const n = trailPts.length;
  if (n < 2) { trailGeo.setDrawRange(0, 0); return; }
  for (let i = 0; i < n; i++) {
    const p = trailPts[i];
    const pa = trailPts[Math.max(0, i - 1)], pb = trailPts[Math.min(n - 1, i + 1)];
    _a.set(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
    _b.set(camera.position.x - p[0], camera.position.y - p[1], camera.position.z - p[2]);
    _c.crossVectors(_a, _b).normalize();
    const k = i / (n - 1), wdt = 0.015 * k;
    tPos.set([p[0] + _c.x * wdt, p[1] + _c.y * wdt, p[2] + _c.z * wdt, p[0] - _c.x * wdt, p[1] - _c.y * wdt, p[2] - _c.z * wdt], i * 6);
    const f = k * k * 1.6;
    tCol.set([trailColor.r * f, trailColor.g * f, trailColor.b * f, trailColor.r * f, trailColor.g * f, trailColor.b * f], i * 6);
  }
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.attributes.color.needsUpdate = true;
  trailGeo.setDrawRange(0, (n - 1) * 6);
}

/* =====================================================================
   RAQUETES
   ===================================================================== */
// Raquete modelada em medidas reais (lâmina 150×158 mm, cabo FL de ~10 cm) e ampliada 1,2× para o jogo:
// lâmina de madeira compensada (camadas visíveis na borda), borracha com esponja e logo, cabo anatômico com placa.
const PADDLE_SCALE = 1.2;
const BLADE_A = 0.075, BLADE_B = 0.079, BLADE_T = 0.0062, RUBBER_T = 0.0021;
const bladeShape = (() => {
  const sh = new THREE.Shape(), n = 2.12, N = 96;
  for (let i = 0; i <= N; i++) {
    const t = i / N * Math.PI * 2, c = Math.cos(t), si = Math.sin(t);
    const x = BLADE_A * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const y = BLADE_B * Math.sign(si) * Math.pow(Math.abs(si), 2 / n) * (si < 0 ? 0.97 : 1);
    i ? sh.lineTo(x, y) : sh.moveTo(x, y);
  }
  return sh;
})();
function extrudeUV(depth) {
  const minX = -BLADE_A, minY = -BLADE_B, w = 2 * BLADE_A, h = 2 * BLADE_B;
  return {
    generateTopUV(g, v, a, b, c) { return [a, b, c].map(i => new THREE.Vector2((v[i * 3] - minX) / w, (v[i * 3 + 1] - minY) / h)); },
    generateSideWallUV(g, v, a, b, c, d) { return [a, b, c, d].map(i => new THREE.Vector2((Math.atan2(v[i * 3 + 1], v[i * 3]) / 6.283 + 0.5) * 4, v[i * 3 + 2] / depth)); }
  };
}
/* ---------- Modelos de raquete: cada um muda velocidade, efeito e controle ---------- */
const RACKETS = [
  { id: 'classica', name: 'Clássica', tag: 'Equilibrada', desc: 'Madeira de 5 camadas e borracha lisa. Boa em tudo, ótima pra começar.', speed: 3, spin: 3, ctrl: 4,
    sound: { rate: 1, cut: 1, vol: 1 }, look: { color: 0xe0192f, rubber: 'smooth', ply: 'wood', handle: 'wood', logo: 'PPO', sub: 'CLASSIC 40°', scale: 1.2 } },
  { id: 'vibora', name: 'Víbora', tag: 'Efeito máximo', fx: { kind: 'venom', c1: 0x39ff7a, c2: 0x0b8f3a }, desc: 'Borracha grudenta: muito topspin e curva lateral forte. A bola mergulha na mesa e espirra no adversário.', speed: 3, spin: 5, ctrl: 3,
    sound: { rate: 0.95, cut: 0.8, vol: 0.95 }, look: { color: 0x17a34a, rubber: 'tacky', ply: 'wood', handle: 'black', logo: 'VÍBORA', sub: 'STICKY 39°', scale: 1.2 } },
  { id: 'foguete', name: 'Foguete', tag: 'Velocidade', fx: { kind: 'flame', c1: 0x3aa0ff, c2: 0xff7a1a }, desc: 'Lâmina de carbono: a bola sai muito rápida, mas exige controle. Errou o tempo, a bola sai torta.', speed: 5, spin: 2, ctrl: 2,
    sound: { rate: 1.08, cut: 1.25, vol: 1.12 }, look: { color: 0x1f6fff, rubber: 'smooth', ply: 'carbon', handle: 'carbon', logo: 'FOGUETE', sub: 'CARBON SPEED', scale: 1.24 } },
  { id: 'muralha', name: 'Muralha', tag: 'Anti-efeito', fx: { kind: 'shield', c1: 0xff9ad6, c2: 0xffffff }, desc: 'Pino longo: não gera efeito nenhum, mas devolve o efeito do adversário ao contrário (o topspin dele volta como corte).', speed: 2, spin: 0, ctrl: 5, anti: true,
    sound: { rate: 0.88, cut: 0.55, vol: 0.8 }, look: { color: 0xff6fae, rubber: 'pips', ply: 'wood', handle: 'light', logo: 'MURALHA', sub: 'LONG PIPS', scale: 1.2 } },
  { id: 'raiz', name: 'Raiz', tag: 'Bola reta', desc: 'Retrô, sem esponja: bola reta e veloz, quase sem efeito. Fácil de bater, difícil de enganar.', speed: 4, spin: 1, ctrl: 3,
    sound: { rate: 1.16, cut: 1.05, vol: 1.05 }, look: { color: 0xb3261e, rubber: 'hardbat', ply: 'old', handle: 'old', logo: 'RAIZ', sub: 'HARDBAT 1965', scale: 1.16 } },
  { id: 'dragao', name: 'Dragão Dourado', tag: 'Lendária', fx: { kind: 'gold', c1: 0xffc23a, c2: 0xfff2b0 }, desc: 'Rápida, com muito efeito e muito controle.', speed: 4, spin: 4, ctrl: 4, unlock: 3,
    sound: { rate: 1.03, cut: 1.12, vol: 1.05 }, look: { color: 0xd9a520, rubber: 'gold', ply: 'gold', handle: 'gold', logo: 'DRAGÃO', sub: '★ LENDÁRIA ★', scale: 1.22 } },
];
const racketById = id => RACKETS.find(r => r.id === id) || RACKETS[0];
const winCount = () => +store.get('pp_wins', '0') || 0;
// conta VIP: aberta pelo link secreto (?vip=código). Só o hash do código fica no jogo.
const VIP_HASH = '58ad5d6d6e4e1bac078a1a8dc4c2c63af41e6747573939db4d1186abe1d7e5ae';
const acct = { sb: null, user: null, profile: null, providers: { google: false }, ready: null };   // conta (preenchida no bloco CONTA)
const isVip = () => store.get('pp_vip', '0') === '1' || !!(acct.profile && acct.profile.admin);
// regras de cada raquete vindas do banco (o admin liga/desliga, libera para todos ou pede vitórias)
const RCFG = {};
const rcfg = r => RCFG[r.id] || { enabled: true, free: !r.unlock, unlock_wins: r.unlock || null };
const totalWins = () => Math.max(winCount(), (acct.profile && acct.profile.wins) || 0);
const grantedTo = r => !!(acct.profile && Array.isArray(acct.profile.rackets) && acct.profile.rackets.includes(r.id));
// por enquanto todas as raquetes estão liberadas para todo mundo (mude para false para voltar às regras do banco)
const ALL_RACKETS_FREE = true;
const isListed = r => ALL_RACKETS_FREE || isVip() || rcfg(r).enabled !== false || grantedTo(r);
const isUnlocked = r => {
  if (ALL_RACKETS_FREE || isVip() || grantedTo(r)) return true;
  const c = rcfg(r);
  if (c.enabled === false) return false;
  return !!c.free || (!!c.unlock_wins && totalWins() >= c.unlock_wins);
};
function lockText(r) {
  const c = rcfg(r);
  return c.unlock_wins ? `Vença ${c.unlock_wins} partidas para liberar (você tem ${totalWins()}).` : 'Exclusiva: só o admin libera esta raquete.';
}
// sigla do jogador gravada na raquete (até 6 letras/números)
const cleanTag = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
const myTag = () => cleanTag(acct.profile ? (acct.profile.tag || acct.profile.name) : store.get('pp_tag', ''));
let oppTag = '';
const RTX = {};                                     // texturas de raquete em cache
const rtx = (k, f) => RTX[k] || (RTX[k] = f());
function plyTexFor(kind) {
  return rtx('ply_' + kind, () => canvasTex(32, 64, (g, w) => {
    const L = {
      wood: [['#e8cf9e', 9], ['#6e4524', 3], ['#d6ad74', 9], ['#f1dcae', 22], ['#d6ad74', 9], ['#6e4524', 3], ['#e8cf9e', 9]],
      carbon: [['#e3c590', 8], ['#1b1b1f', 5], ['#3a3a40', 3], ['#f0d9a8', 20], ['#3a3a40', 3], ['#1b1b1f', 5], ['#e3c590', 8], ['#1b1b1f', 12]],
      old: [['#8a5a2e', 12], ['#4a2c14', 4], ['#9a6a3a', 32], ['#4a2c14', 4], ['#8a5a2e', 12]],
      gold: [['#ffd76a', 10], ['#7a5210', 3], ['#e9b23a', 38], ['#7a5210', 3], ['#ffd76a', 10]],
    }[kind];
    let y = 0; for (const [c, t] of L) { g.fillStyle = c; g.fillRect(0, y, w, t); y += t; }
  }));
}
function handleTexFor(kind) {
  return rtx('h_' + kind, () => canvasTex(256, 512, (g, w, h) => {
    const base = { wood: '#c8955a', black: '#18181b', carbon: '#202024', light: '#e6cfa2', old: '#7a4a24', gold: '#e8b43c' }[kind];
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    if (kind === 'carbon') {
      for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) { g.fillStyle = ((x + y) / 8) % 2 ? '#2e2e34' : '#141417'; g.fillRect(x, y, 8, 8); }
    } else {
      for (let i = 0; i < 140; i++) {
        const x = Math.random() * w; g.strokeStyle = kind === 'black' ? `rgba(255,255,255,${Math.random() * 0.05})` : `rgba(${Math.random() < 0.5 ? '90,52,20' : '255,230,180'},${0.08 + Math.random() * 0.14})`;
        g.lineWidth = 0.6 + Math.random() * 1.8; g.beginPath(); g.moveTo(x, 0);
        for (let y = 0; y <= h; y += 32) g.lineTo(x + Math.sin(y * 0.01 + i) * 3, y); g.stroke();
      }
    }
    const inlay = { wood: '#4a2a12', black: '#d81b3c', carbon: '#1f6fff', light: '#ff6fae', old: '#2a160a', gold: '#3a2508' }[kind];
    for (const u of [0, 0.5, 1]) { const cx = u * w; g.fillStyle = inlay; g.fillRect(cx - 14, 0, 28, h); g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(cx - 17, 0, 3, h); g.fillRect(cx + 14, 0, 3, h); }
  }));
}
function badgeTexFor(look) {
  return rtx('b_' + look.logo, () => canvasTex(128, 192, (g, w, h) => {
    g.fillStyle = '#1b1b1f'; g.beginPath(); g.ellipse(w / 2, h / 2, w / 2 - 4, h / 2 - 4, 0, 0, 6.3); g.fill();
    g.strokeStyle = '#d9b45a'; g.lineWidth = 6; g.stroke();
    g.fillStyle = '#e8c56a'; g.textAlign = 'center';
    let fs = 44; g.font = `italic 900 ${fs}px system-ui`; while (g.measureText(look.logo).width > w - 20) { fs -= 2; g.font = `italic 900 ${fs}px system-ui`; }
    g.fillText(look.logo, w / 2, h / 2 + 4); g.font = '700 13px system-ui'; g.fillText('PRO', w / 2, h / 2 + 30);
  }));
}
function rubberTexFor(hex, kind, logo, sub, ptag = '') {
  return rtx(`r_${hex}_${kind}_${logo}_${ptag}`, () => {
    const c = new THREE.Color(hex), dark = c.r + c.g + c.b < 0.4, css = '#' + c.getHexString();
    const top = canvasTex(512, 512, (g, w, h) => {
      g.fillStyle = css; g.fillRect(0, 0, w, h);
      if (kind === 'pips' || kind === 'hardbat') {             // pinos (bolinhas de borracha)
        const st = kind === 'pips' ? 15 : 11, r = kind === 'pips' ? 4.6 : 3.4;
        for (let y = st / 2; y < h; y += st) for (let x = (Math.round(y / st) % 2) * st / 2; x < w; x += st) {
          g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.arc(x + 1.2, y + 1.2, r, 0, 6.3); g.fill();
          g.fillStyle = 'rgba(255,255,255,.22)'; g.beginPath(); g.arc(x - 0.8, y - 0.8, r * 0.7, 0, 6.3); g.fill();
        }
      } else noiseFill(g, w, h, 22000, dark ? 0.05 : 0.07, 1.5);
      if (kind === 'gold') for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(255,255,220,${Math.random() * 0.6})`; g.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5); }
      const shine = kind === 'tacky' ? 0.22 : 0.1;
      const sh = g.createRadialGradient(w * 0.38, h * 0.3, 10, w * 0.38, h * 0.3, w * 0.7);
      sh.addColorStop(0, `rgba(255,255,255,${shine})`); sh.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = sh; g.fillRect(0, 0, w, h);
      g.textAlign = 'center'; g.fillStyle = dark ? '#e3c063' : kind === 'gold' ? '#5a3a06' : 'rgba(255,255,255,.92)';
      let fs = 60; g.font = `italic 900 ${fs}px system-ui`; while (g.measureText(logo).width > w * 0.6) { fs -= 3; g.font = `italic 900 ${fs}px system-ui`; }
      g.fillText(logo, w / 2, h * 0.76);
      g.font = '800 19px system-ui'; g.fillText(sub.split('').join(' '), w / 2, h * 0.815);
      g.fillRect(w * 0.32, h * 0.835, w * 0.36, 3);
      if (ptag) {                                              // sigla do jogador, grande, acima do nome da raquete
        let ts = 128; g.font = `900 ${ts}px system-ui`; while (g.measureText(ptag).width > w * 0.7) { ts -= 4; g.font = `900 ${ts}px system-ui`; }
        g.lineJoin = 'round'; g.lineWidth = Math.max(5, ts * 0.09);
        g.strokeStyle = kind === 'gold' ? 'rgba(255,240,190,.9)' : 'rgba(0,0,0,.55)';
        g.fillStyle = kind === 'gold' ? '#4a2c02' : dark ? '#f2d27a' : '#ffffff';
        g.strokeText(ptag, w / 2, h * 0.6); g.fillText(ptag, w / 2, h * 0.6);
        g.globalAlpha = 0.7; g.fillRect(w * 0.42, h * 0.635, w * 0.16, 2.5); g.globalAlpha = 1;
      }
    });
    const side = canvasTex(16, 64, (g, w, h) => {              // borda: lâmina da borracha + esponja (a Raiz não tem esponja)
      g.fillStyle = css; g.fillRect(0, 0, w, kind === 'hardbat' ? h : 18);
      if (kind !== 'hardbat') { g.fillStyle = kind === 'pips' ? '#f2d6a0' : '#efb43c'; g.fillRect(0, 18, w, h - 18); for (let i = 0; i < 60; i++) { g.fillStyle = 'rgba(150,90,10,.5)'; g.fillRect(Math.random() * w, 18 + Math.random() * (h - 18), 1.4, 1.4); } }
    });
    return { top, side };
  });
}
/* ---------- skins de raquete: 25 visuais para qualquer raquete (a força continua a da raquete) ---------- */
const SKIN_SHA = '6e782f5f8739cb5e2929562123a8a4f8422cd487';
const SKIN_BASES = [`https://cdn.jsdelivr.net/gh/amxgroup07/pingpong-online@${SKIN_SHA}/assets/skins/`, `https://raw.githubusercontent.com/amxgroup07/pingpong-online/${SKIN_SHA}/assets/skins/`];
const RSKINS = [
  ['Caçador Galáctico', '#c9542a', 'Épica'], ['Camisa 10', '#1f8a3a', 'Épica'], ['Artilheiro', '#c8202e', 'Épica'], ['Viking do Gol', '#3d8fe0', 'Épica'], ['Paredão', '#2f8a3a', 'Épica'],
  ['Kraken Abissal', '#1fa3b5', 'Rara'], ['Fênix', '#e0462a', 'Rara'], ['Lobo Lunar', '#3a5ab0', 'Rara'], ['Trovão', '#e0a93a', 'Rara'], ['Neve Eterna', '#9fb6d8', 'Rara'],
  ['Biohazard', '#a8d12a', 'Épica'], ['Neon Retrô', '#e0408a', 'Rara'], ['Pixel Arcade', '#2a2a4a', 'Rara'], ['Steampunk', '#a0602a', 'Épica'], ['Astronauta', '#6a4ab0', 'Épica'],
  ['Esports Pro', '#d02a2a', 'Rara'], ['Tropical', '#2ab0a0', 'Comum'], ['Geométrica', '#8a3ae0', 'Comum'], ['Camuflagem', '#5a6a3a', 'Comum'], ['Chamas Azuis', '#2a7ae0', 'Rara'],
  ['Doces & Sprinkles', '#f080b0', 'Comum'], ['Gato Ninja', '#e06a2a', 'Rara'], ['Robô V4', '#6a8aa8', 'Épica'], ['Dourada Luxo', '#d4a83a', 'Lendária'], ['Arco-íris Holográfica', '#b0a0e0', 'Lendária'],
].map(([name, c, rar], i) => ({ id: 's' + String(i + 1).padStart(2, '0'), n: String(i + 1).padStart(2, '0'), name, c, rar }));
const RAR_COL = { Comum: '#9aa3b5', Rara: '#3d9bff', 'Épica': '#b06bff', 'Lendária': '#ffc23a' };
const skinById = id => RSKINS.find(s => s.id === id) || null;
const skinUrl = (s, side, small, alt = 0) => `${SKIN_BASES[alt]}${s.n}${side}${small ? '_s' : ''}.jpg`;
let rskinSel = {}; try { rskinSel = JSON.parse(store.get('pp_rskins', '{}')) || {}; } catch (e) { rskinSel = {}; }
const mySkinFor = r => (r && skinById(rskinSel[r.id]) ? rskinSel[r.id] : '');
function setRacketSkin(r, id) { if (id) rskinSel[r.id] = id; else delete rskinSel[r.id]; store.set('pp_rskins', JSON.stringify(rskinSel)); }
// imagens (carregadas uma vez; as texturas se redesenham quando chegam)
const SKIN_IMG = {};
function skinImg(s, side) {
  const k = s.id + side; if (SKIN_IMG[k]) return SKIN_IMG[k];
  const o = { img: new Image(), ready: false, cbs: [] };
  o.p = new Promise(res => {
    o.img.crossOrigin = 'anonymous';
    o.img.onload = () => { o.ready = true; o.cbs.forEach(f => f()); res(true); };
    o.img.onerror = () => { if (!o.alt) { o.alt = 1; o.img.src = skinUrl(s, side, false, 1); } else res(false); };
    o.img.src = skinUrl(s, side, false, 0);
  });
  return (SKIN_IMG[k] = o);
}
const skinReady = id => { const s = skinById(id); return s ? Promise.all([skinImg(s, 'f').p, skinImg(s, 'b').p]) : Promise.resolve(); };
function skinTexFor(id, side, ptag = '') {
  const s = skinById(id);
  return rtx(`sk_${id}_${side}_${ptag}`, () => {
    const im = skinImg(s, side);
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    const draw = () => {
      g.fillStyle = s.c; g.fillRect(0, 0, 512, 512);
      if (im.ready) g.drawImage(im.img, 0, 0, 512, 512);
      const sh = g.createRadialGradient(190, 150, 10, 190, 150, 360);       // brilho leve de borracha
      sh.addColorStop(0, 'rgba(255,255,255,.08)'); sh.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = sh; g.fillRect(0, 0, 512, 512);
      if (ptag) {                                                          // sigla pequena embaixo, sem tapar a arte
        g.font = '900 40px system-ui'; const tw = g.measureText(ptag).width + 34;
        g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.roundRect ? g.roundRect(256 - tw / 2, 420, tw, 52, 26) : g.rect(256 - tw / 2, 420, tw, 52); g.fill();
        g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ptag, 256, 447);
      }
    };
    draw();
    const top = new THREE.CanvasTexture(c); top.colorSpace = THREE.SRGBColorSpace; top.anisotropy = 8;
    if (!im.ready) im.cbs.push(() => { draw(); top.needsUpdate = true; });
    const side_ = canvasTex(16, 64, (gg, w, h) => { gg.fillStyle = s.c; gg.fillRect(0, 0, w, 18); gg.fillStyle = '#efb43c'; gg.fillRect(0, 18, w, h - 18); });
    return { top, side: side_ };
  });
}
function loftGeometry(secs, N = 28, ex = 2.6) {        // cabo: seções ovais com largura/espessura variáveis
  const pos = [], uv = [], idx = [], rows = secs.length;
  for (let i = 0; i < rows; i++) {
    const [y, hw, ht] = secs[i];
    for (let j = 0; j <= N; j++) {
      const f = j / N * Math.PI * 2, c = Math.cos(f), si = Math.sin(f);
      pos.push(hw * Math.sign(c) * Math.pow(Math.abs(c), 2 / ex), y, ht * Math.sign(si) * Math.pow(Math.abs(si), 2 / ex));
      uv.push(j / N, 1 - i / (rows - 1));
    }
  }
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < N; j++) {
    const a = i * (N + 1) + j, b = a + N + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  for (const [r, flip] of [[0, true], [rows - 1, false]]) {   // tampas
    const ci = pos.length / 3; pos.push(0, secs[r][0], 0); uv.push(0.5, r ? 0 : 1);
    for (let j = 0; j < N; j++) { const a = r * (N + 1) + j; flip ? idx.push(ci, a + 1, a) : idx.push(ci, a, a + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
const HANDLE_SECS = [[-0.057, 0.007, 0.0054], [-0.064, 0.0185, 0.006], [-0.078, 0.0158, 0.0084], [-0.092, 0.0136, 0.0099], [-0.115, 0.0126, 0.0107],
  [-0.14, 0.014, 0.0112], [-0.162, 0.0164, 0.0116], [-0.173, 0.0178, 0.0112], [-0.178, 0.0163, 0.0088], [-0.1806, 0.0112, 0.0056], [-0.1814, 0.004, 0.002]];
const HANDLE_ST = [[-0.057, 0.007, 0.0054], [-0.064, 0.017, 0.006], [-0.078, 0.0142, 0.0086], [-0.1, 0.0136, 0.0104], [-0.168, 0.0136, 0.0108], [-0.176, 0.0124, 0.0086], [-0.1795, 0.008, 0.004], [-0.18, 0.003, 0.0015]];
const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, { depth: BLADE_T, bevelEnabled: false, curveSegments: 1, UVGenerator: extrudeUV(BLADE_T) });
bladeGeo.translate(0, 0, -BLADE_T / 2);
const rubberGeo = new THREE.ExtrudeGeometry(bladeShape, { depth: RUBBER_T, bevelEnabled: false, curveSegments: 1, UVGenerator: extrudeUV(RUBBER_T) });
const rubberGeoThin = new THREE.ExtrudeGeometry(bladeShape, { depth: 0.0011, bevelEnabled: false, curveSegments: 1, UVGenerator: extrudeUV(0.0011) });
const handleGeo = loftGeometry(HANDLE_SECS), handleGeoST = loftGeometry(HANDLE_ST);
const badgeGeo = new THREE.PlaneGeometry(0.013, 0.021);
// aro em volta da lâmina, usado pelas raquetes com efeito na borda
const RIM_PTS = bladeShape.getPoints(96);
const rimGeo = (() => {
  const outer = new THREE.Shape(RIM_PTS.map(p => p.clone().multiplyScalar(1.05)));
  outer.holes.push(new THREE.Path(RIM_PTS.map(p => p.clone().multiplyScalar(0.995)).reverse()));
  const d = BLADE_T + RUBBER_T * 2 + 0.0026;
  const g = new THREE.ExtrudeGeometry(outer, { depth: d, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -d / 2); return g;
})();
const RUBBER_MAT = {
  smooth: { roughness: 0.72, clearcoat: 0.08, clearcoatRoughness: 0.6 },
  tacky: { roughness: 0.55, clearcoat: 0.22, clearcoatRoughness: 0.45 },
  pips: { roughness: 0.9, clearcoat: 0 },
  hardbat: { roughness: 0.85, clearcoat: 0 },
  gold: { roughness: 0.5, metalness: 0.25, clearcoat: 0.15, clearcoatRoughness: 0.4 },
};
// monta a raquete; o lado colorido fica para a câmera de quem segura (sua raquete) ou para você (a do adversário)
function buildRacket(def, mine, opacity = 1, ptag = '', skin = '') {
  const L = def.look, root = new THREE.Group(), pivot = new THREE.Group(); root.add(pivot);
  const racket = new THREE.Group(); racket.scale.setScalar(L.scale || PADDLE_SCALE); pivot.add(racket);
  const base = opacity < 1 ? { transparent: true, opacity } : {};
  const ply = new THREE.MeshStandardMaterial({ map: plyTexFor(L.ply), roughness: L.ply === 'gold' ? 0.45 : 0.65, metalness: L.ply === 'gold' ? 0.4 : 0, ...base });
  const blade = new THREE.Mesh(bladeGeo, [ply, ply]); blade.castShadow = true; racket.add(blade);
  const colored = mine ? 1 : -1, thin = L.rubber === 'hardbat';
  for (const sideZ of [-1, 1]) {
    const isCol = sideZ === colored, kind = isCol ? L.rubber : (thin ? 'hardbat' : 'smooth');
    const sk = skinById(skin);
    const t = sk ? skinTexFor(sk.id, isCol ? 'f' : 'b', isCol ? ptag : '') : rubberTexFor(isCol ? L.color : 0x1a1a1c, kind, L.logo, L.sub, isCol ? ptag : '');
    const top = new THREE.MeshPhysicalMaterial({ map: t.top, ...RUBBER_MAT[sk ? 'smooth' : kind], ...base });
    const edge = new THREE.MeshStandardMaterial({ map: t.side, roughness: 0.9, ...base });
    const rb = new THREE.Mesh(thin ? rubberGeoThin : rubberGeo, [top, edge]);
    rb.position.z = sideZ * BLADE_T / 2;
    if (sideZ < 0) rb.rotation.y = Math.PI;          // a face de fora fica para fora (e o logo legível)
    rb.castShadow = true; racket.add(rb);
  }
  const hk = L.handle, metal = hk === 'gold';
  const wood = new THREE.MeshPhysicalMaterial({ map: handleTexFor(hk), roughness: metal ? 0.45 : hk === 'carbon' ? 0.5 : 0.55, metalness: metal ? 0.35 : 0, clearcoat: hk === 'old' ? 0.05 : 0.12, clearcoatRoughness: 0.5, ...base });
  const handle = new THREE.Mesh(hk === 'old' ? handleGeoST : handleGeo, wood); handle.castShadow = true; racket.add(handle);
  const bm = new THREE.MeshStandardMaterial({ map: badgeTexFor(L), roughness: 0.45, metalness: 0.3, transparent: true, opacity, alphaTest: 0.05 });
  for (const sz of [-1, 1]) { const b = new THREE.Mesh(badgeGeo, bm); b.position.set(0, -0.128, sz * 0.0112); if (sz < 0) b.rotation.y = Math.PI; racket.add(b); }
  let fx = null;
  if (def.fx) {                                    // borda brilhante (o bloom deixa com cara de neon)
    const mat = new THREE.MeshBasicMaterial({ color: def.fx.c1, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
    const rim = new THREE.Mesh(rimGeo, mat); racket.add(rim);
    fx = { ...def.fx, mat, rim, scale: L.scale || PADDLE_SCALE, acc: 0 };
  }
  // o ambiente refletido estava forte demais nas raquetes (elas são criadas depois do ajuste geral da cena)
  root.traverse(o => {
    const m = o.material; if (!m || m === (fx && fx.mat)) return;
    if (m.envMapIntensity !== undefined) m.envMapIntensity = 0.08;
    // borracha de verdade quase não espelha: sem isso o holofote de cima "estoura" a face virada para a câmera
    if (m.isMeshPhysicalMaterial) { m.specularIntensity = 0.18; m.clearcoat *= 0.4; m.roughness = Math.max(m.roughness, 0.7); }
    else if (m.isMeshStandardMaterial && !m.metalness) m.roughness = Math.max(m.roughness, 0.75);
  });
  return { root, pivot, fx };
}
function disposeRacket(root) { root.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); }); }
function makePaddle(def, mine, ptag = '', skin = '') {
  const { root, pivot, fx } = buildRacket(def, mine, mine ? 0.88 : 1, ptag, skin);
  scene.add(root);
  root.userData = { pivot, fx, swing: 0, vx: 0, vz: 0, lx: 0, lz: 0, tag: ptag };
  return root;
}
let myRacket = racketById(store.get('pp_racket', 'classica'));
if (!isUnlocked(myRacket)) myRacket = RACKETS[0];
let oppRacket = RACKETS[0];
let oppSkin = '';
let myPaddleMesh = makePaddle(myRacket, true, myTag(), mySkinFor(myRacket));
let oppPaddleMesh = makePaddle(oppRacket, false);
function setPaddle(which, def, ptag, skin) {
  const mine = which === 'me', old = mine ? myPaddleMesh : oppPaddleMesh;
  if (ptag === undefined) ptag = mine ? myTag() : oppTag;
  if (skin === undefined) skin = mine ? (S.mode === 'spec' ? '' : mySkinFor(def)) : oppSkin;
  skin = skinById(skin) ? skin : '';
  if (!mine) { oppTag = ptag; oppSkin = skin; }
  const m = makePaddle(def, mine, ptag, skin);
  m.visible = old.visible; m.position.copy(old.position); m.rotation.copy(old.rotation);
  Object.assign(m.userData, { lx: old.userData.lx, lz: old.userData.lz });
  scene.remove(old); disposeRacket(old);
  if (mine) { myPaddleMesh = m; myRacket = def; } else { oppPaddleMesh = m; oppRacket = def; }
}

/* =====================================================================
   PARTÍCULAS (faíscas, poeira, confete) e ondas de impacto
   ===================================================================== */
function makeParticles(max, size, additive) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(max * 3).fill(-999), col = new Float32Array(max * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, sizeAttenuation: true, toneMapped: !additive });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; scene.add(pts);
  const P = Array.from({ length: max }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1, grav: 3, drag: 1 }));
  let cursor = 0;
  return {
    emit(n, x, y, z, color, speed, o = {}) {
      const c = new THREE.Color(color);
      for (let k = 0; k < n; k++) {
        const p = P[cursor]; cursor = (cursor + 1) % max;
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), s = speed * (0.4 + Math.random() * 0.8);
        p.x = x + (o.spread ? (Math.random() - 0.5) * o.spread : 0); p.y = y; p.z = z + (o.spread ? (Math.random() - 0.5) * o.spread : 0);
        p.vx = Math.sin(ph) * Math.cos(th) * s + (o.dir ? o.dir[0] : 0);
        p.vy = Math.abs(Math.cos(ph)) * s * (o.upOnly ? 1 : Math.sign(Math.random() - 0.3)) + (o.up || 0);
        p.vz = Math.sin(ph) * Math.sin(th) * s + (o.dir ? o.dir[2] : 0);
        p.life = p.max = (o.life || 0.45) * (0.6 + Math.random() * 0.6);
        const cc = o.rainbow ? new THREE.Color().setHSL(Math.random(), 0.9, 0.6) : c;
        const it = o.intensity || 1;
        p.r = cc.r * it; p.g = cc.g * it; p.b = cc.b * it;
        p.grav = o.grav ?? 3; p.drag = o.drag ?? 1.5;
      }
    },
    update(dt) {
      for (let i = 0; i < max; i++) {
        const p = P[i];
        if (p.life <= 0) { if (pos[i * 3 + 1] !== -999) { pos[i * 3 + 1] = -999; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; } continue; }
        p.life -= dt;
        const d = Math.exp(-p.drag * dt);
        p.vx *= d; p.vy = p.vy * d - p.grav * dt; p.vz *= d;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.y < 0.01) { p.y = 0.01; p.vy *= -0.3; }
        const f = Math.max(0, p.life / p.max);
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
        col[i * 3] = p.r * f; col[i * 3 + 1] = p.g * f; col[i * 3 + 2] = p.b * f;
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
    }
  };
}
const sparks = makeParticles(260, 0.028, true);
const confetti = makeParticles(400, 0.06, false);
const pyro = makeParticles(1400, 0.055, true);
const aura = makeParticles(260, 0.018, true);
const fwSolid = makeParticles(900, 0.11, false);       // fogos com cor sólida: aparecem mesmo no céu claro
const _rimV = new THREE.Vector3();
function updateRacketFx(mesh, t, dt) {
  const fx = mesh.userData.fx; if (!fx || !mesh.visible) return;
  const near = mesh === myPaddleMesh ? 0.55 : 1;      // a minha fica perto da câmera e parece maior
  const k = 0.5 + 0.5 * Math.sin(t * 3.1), sp = Math.hypot(mesh.userData.vx || 0, mesh.userData.vz || 0);
  if (fx.kind === 'flame') { fx.mat.color.setHex(fx.c1).lerp(_fxC.setHex(fx.c2), 0.5 + 0.5 * Math.sin(t * 9) * Math.random()); fx.mat.opacity = 0.32 + Math.random() * 0.14; }
  else if (fx.kind === 'gold') { fx.mat.color.setHex(fx.c1).lerp(_fxC.setHex(fx.c2), k * 0.4); fx.mat.opacity = 0.3 + k * 0.12; }
  else if (fx.kind === 'venom') { fx.mat.color.setHex(fx.c2).lerp(_fxC.setHex(fx.c1), k); fx.mat.opacity = 0.25 + k * 0.2; }
  else { fx.mat.opacity = 0.18 + k * 0.15; }
  fx.mat.opacity *= near;
  const rate = { gold: 22, flame: 10 + Math.min(sp, 4) * 14, venom: 12, shield: 5 }[fx.kind] || 0;
  fx.acc += rate * dt;
  while (fx.acc >= 1) {
    fx.acc -= 1;
    const p = RIM_PTS[(Math.random() * RIM_PTS.length) | 0];
    _rimV.set(p.x * 1.05, p.y * 1.05, 0); fx.rim.localToWorld(_rimV);
    const o = { gold: [fx.c1, 0.25, { life: 0.6, grav: -0.25, drag: 2, intensity: 1.1 }], flame: [Math.random() < 0.5 ? fx.c1 : fx.c2, 0.35, { life: 0.3, grav: -0.9, drag: 3, intensity: 1.2 }],
      venom: [fx.c1, 0.12, { life: 0.5, grav: -0.15, drag: 2.5, intensity: 0.9 }], shield: [fx.c1, 0.1, { life: 0.45, grav: 0, drag: 3, intensity: 0.8 }] }[fx.kind];
    aura.emit(1, _rimV.x, _rimV.y, _rimV.z, o[0], o[1], o[2]);
  }
}
const _fxC = new THREE.Color();

// poeira flutuando na luz
const DUST = 320;
const dustGeo = new THREE.BufferGeometry();
const dustPos = new Float32Array(DUST * 3), dustSeed = new Float32Array(DUST);
for (let i = 0; i < DUST; i++) { dustPos[i * 3] = (Math.random() - 0.5) * 4.5; dustPos[i * 3 + 1] = 1 + Math.random() * 4.6; dustPos[i * 3 + 2] = (Math.random() - 0.5) * 5.5; dustSeed[i] = Math.random() * 100; }
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.014, map: dotTex, color: 0xffe9f2, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending }));
scene.add(dust);
function updateDust(t, dt) {
  if (!dust.visible) return;
  for (let i = 0; i < DUST; i++) {
    dustPos[i * 3] += Math.sin(t * 0.3 + dustSeed[i]) * 0.02 * dt;
    dustPos[i * 3 + 1] += (Math.cos(t * 0.2 + dustSeed[i]) * 0.02 - 0.01) * dt;
    if (dustPos[i * 3 + 1] < 0.9) dustPos[i * 3 + 1] = 5.6;
  }
  dustGeo.attributes.position.needsUpdate = true;
}

const rings = [];
for (let i = 0; i < 6; i++) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.018, 0.026, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  m.rotation.x = -Math.PI / 2; scene.add(m); rings.push({ m, t: 1 });
}
let ringIdx = 0;
function spawnRing(x, y, z, color) {
  const r = rings[ringIdx]; ringIdx = (ringIdx + 1) % rings.length;
  r.m.position.set(x, y, z); r.m.material.color.set(color).multiplyScalar(2); r.t = 0;
}
function updateRings(dt) {
  for (const r of rings) {
    if (r.t >= 1) { r.m.visible = false; continue; }
    r.t = Math.min(1, r.t + dt / 0.4); r.m.visible = true;
    const s = 1 + r.t * 4; r.m.scale.set(s, s, s); r.m.material.opacity = (1 - r.t) * 0.9;
  }
}

/* =====================================================================
   ESTADO DO JOGO
   ===================================================================== */
const S = {
  mode: null, mySide: 1,
  phase: 'lobby', phaseT: 0,
  server: 1, firstServer: 1,
  score: { '1': 0, '-1': 0 },
  ball: { p: [0, BALL_Y + 0.3, 0], v: [0, 0, 0], w: [0, 0, 0] },
  ballVisible: false,
  rally: { hitter: 0, rb: 0, canHit: false, net: false, serve: false, t: 0 },
  serveX: 0, serveBall: null, rtt: 0.08,
  streak: 0, lastLabel: 'SAQUE', ranked: null, oppName: null,
  format: 1, games: { '1': 0, '-1': 0 }, gameNo: 1, gameScores: [], matchFirst: 1,   // 1 game, MD3 ou MD5
};
const FORMATS = { 1: { short: '1 GAME', long: 'Duelo: 1 game de 11' }, 3: { short: 'MD3', long: 'Melhor de 3 games' }, 5: { short: 'MD5', long: 'Melhor de 5 games' } };
const gamesNeeded = () => Math.ceil(S.format / 2);
const me = { x: 0, y: TH + 0.2, z: HL + 0.4, prevDepth: HL + 0.4 };
const opp = { x: 0, y: TH + 0.2, z: -(HL + 0.4), tx: 0, ty: TH + 0.2, tz: -(HL + 0.4) };
const bot = { x: 0, y: TH + 0.2, z: -(HL + 0.35), predX: 0, react: 0, served: false, lunge: 0, serveAt: 1 };

const isAuth = side => S.mode === 'solo' || side === S.mySide;
const sideOfBot = () => -S.mySide;

/* =====================================================================
   ENTRADA (mouse / toque)
   ===================================================================== */
const pointer = { nx: 0, ny: 0.5, hist: [] };
const raycaster = new THREE.Raycaster();
const hitPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(TH + 0.12));
const _hit = new THREE.Vector3(), _ndc = new THREE.Vector2();

// px/py: onde a raquete fica na tela; hx/hy: posição usada para medir a velocidade do gesto
function feedPointer(px, py, hx, hy, touch) {
  const r = canvas.getBoundingClientRect();
  if (touch) { const off = Math.min(70, r.height * 0.08); py -= off; hy -= off; }
  const sm = cfg.sensMove || 1;                      // sensibilidade: a raquete anda mais (ou menos) por movimento
  pointer.nx = clamp((((px - r.left) / r.width) * 2 - 1) * sm, -1.7, 1.7);
  pointer.ny = clamp(0.25 + ((((py - r.top) / r.height) * 2 - 1) - 0.25) * sm, -1.6, 1.6);
  const t = performance.now() / 1000;
  pointer.hist.push({ t, hx: (hx - r.left) / r.height, hy: (hy - r.top) / r.height });
  while (pointer.hist.length > 40 || (pointer.hist.length > 2 && t - pointer.hist[0].t > 0.3)) pointer.hist.shift();
}
function onPointer(e) {
  if (lock.on) {                                     // mouse preso: soma o movimento, sem sair da tela
    const mx = clamp(e.movementX || 0, -300, 300), my = clamp(e.movementY || 0, -300, 300);
    lock.x = clamp(lock.x + mx, 0, window.innerWidth); lock.y = clamp(lock.y + my, 0, window.innerHeight);
    lock.rx += mx; lock.ry += my;                    // sem limite: o gesto forte para cima não "bate no teto"
    feedPointer(lock.x, lock.y, lock.rx, lock.ry, false);
  } else {
    lock.x = e.clientX; lock.y = e.clientY;
    feedPointer(e.clientX, e.clientY, e.clientX, e.clientY, e.pointerType === 'touch');
  }
  ensureAudio();
}
canvas.addEventListener('pointermove', onPointer);
canvas.addEventListener('pointerdown', e => {
  if (!lock.on) canvas.setPointerCapture?.(e.pointerId);
  else if (typeof RP !== 'undefined' && (RP.play || END.active)) { $('rpSkip').click(); return; }   // mouse preso: clique pula o replay
  onPointer(e);
});

/* ---------- tela cheia com o mouse preso (para quem tem dois monitores) ----------
   Na partida, o jogo pede tela cheia e prende o mouse (Pointer Lock): o cursor some e não
   escapa para o outro monitor num gesto forte. Esc solta; no treino, soltar pausa o jogo. */
const lock = { on: false, want: false, failed: false, skip: false, tries: 0, gestureT: 0, retryT: 0, err: '', toasted: false, x: window.innerWidth / 2, y: window.innerHeight * 0.75, rx: 0, ry: 0 };
// qualquer computador com mouse (inclusive notebook com tela de toque)
const lockSupported = () => !!canvas.requestPointerLock && (!window.matchMedia || matchMedia('(any-pointer: fine)').matches);
function enterPlayMode() {
  if (!cfg.lockMouse || !lockSupported()) return;
  Object.assign(lock, { want: true, failed: false, skip: false, tries: 0, gestureT: performance.now() });
  requestLock();                                   // primeiro prende o mouse, depois pede a tela cheia
  try {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => { });
  } catch (e) { }
}
function requestLock() {
  if (lock.on || !lock.want) return;
  try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(lockError); }
  catch (e) { lockError(e); }
}
// o Chrome recusa se o pedido vem logo depois do Esc (espera ~1 s): tenta de novo enquanto o clique ainda vale
function lockError(e) {
  if (lock.on) return;
  if (e && e.message) lock.err = e.message;
  if (performance.now() - lock.gestureT < 4500 && lock.tries < 3) {
    if (!lock.retryT) { lock.tries++; lock.retryT = setTimeout(() => { lock.retryT = 0; requestLock(); }, 1150); }
    return;
  }
  lock.failed = true; updateLockUI();
  console.warn('Pointer Lock recusado:', lock.err || '(sem detalhe)');
}
function releaseMouse() { lock.want = false; if (document.pointerLockElement) try { document.exitPointerLock(); } catch (e) { } }
function toggleFullscreen() {
  try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => { }); } catch (e) { }
}
const settingsOpen = () => { const el = $('cfgScreen'); return !!el && !el.classList.contains('hidden'); };
// mostra o aviso enquanto o mouse devia estar preso e não está (nunca segue o jogo com o mouse solto sem avisar)
function needLockPrompt() {
  return !!S.mode && S.mode !== 'spec' && S.phase !== 'lobby' && S.phase !== 'over' && cfg.lockMouse && lockSupported() && !lock.on && !lock.skip &&
    !settingsOpen() && !(typeof END !== 'undefined' && END.active) && !(typeof RP !== 'undefined' && RP.play);
}
function updateLockUI() {
  const el = $('lockOverlay'); if (!el) return;
  const show = needLockPrompt();
  el.classList.toggle('hidden', !show);
  if (show) {
    const solo = S.mode === 'solo', waiting = !!lock.retryT;
    if (lock.failed) {
      $('lkTitle').textContent = '⚠️ O mouse não ficou preso';
      $('lkSub').textContent = 'O navegador recusou. Clique em "Tentar de novo" (espere 1 segundo depois de apertar Esc). Se não der, jogue sem prender.';
      $('lkGo').textContent = 'Tentar de novo';
    } else {
      $('lkTitle').textContent = waiting ? '🔒 Prendendo o mouse…' : solo ? '⏸ Pausado' : '🖱️ Clique para jogar';
      $('lkSub').textContent = 'O mouse fica preso na tela cheia e não passa para o outro monitor. Esc solta.';
      $('lkGo').textContent = solo ? 'Continuar' : 'Jogar';
    }
    $('lkSkip').classList.toggle('hidden', !lock.failed);
  }
  S.paused = settingsOpen() || (S.mode === 'solo' && show);
}
document.addEventListener('pointerlockchange', () => {
  const was = lock.on;
  lock.on = document.pointerLockElement === canvas;
  if (lock.on && !was) {
    lock.rx = lock.x; lock.ry = lock.y; pointer.hist.length = 0; lock.failed = false; lock.tries = 0;
    if (lock.retryT) { clearTimeout(lock.retryT); lock.retryT = 0; }
    if (!lock.toasted && typeof toast === 'function') { lock.toasted = true; toast('🔒 Mouse preso na tela · Esc solta'); }
  }
  document.body.classList.toggle('locked', lock.on);
  updateLockUI();
});
document.addEventListener('pointerlockerror', () => { lock.on = false; lockError(); updateLockUI(); });
document.addEventListener('fullscreenchange', () => {
  const b = $('btnFull'); if (b) b.textContent = document.fullscreenElement ? '🗗' : '⛶';
  if (document.fullscreenElement && lock.want && !lock.on && !lock.retryT) setTimeout(requestLock, 60);   // a tela cheia terminou de abrir
});

function swipeVel() {
  const h = pointer.hist, now = performance.now() / 1000;
  if (h.length < 2) return { x: 0, up: 0 };
  const last = h[h.length - 1];
  if (now - last.t > 0.07) return { x: 0, up: 0 };
  let old = null;
  for (let i = h.length - 1; i >= 0; i--) { if (last.t - h[i].t <= 0.1) old = h[i]; else break; }
  if (!old || last.t - old.t < 0.012) return { x: 0, up: 0 };
  const dt = last.t - old.t, k = cfg.sensSwing || 1;   // sensibilidade da batida
  return { x: (last.hx - old.hx) / dt * k, up: -(last.hy - old.hy) / dt * k };
}

function updateMyPaddle(dt) {
  _ndc.set(pointer.nx, -pointer.ny);
  raycaster.setFromCamera(_ndc, camera);
  if (raycaster.ray.intersectPlane(hitPlane, _hit)) {
    const sd = S.mySide;
    me.x = clamp(_hit.x, -1.5, 1.5);
    me.z = sd * clamp(_hit.z * sd, HL - 0.45, HL + 1.15);
  }
  autoY(me, S.mySide, dt);
}

function autoY(pd, sd, dt) {
  let ty = TH + 0.22;
  const b = S.ball.p;
  const incoming = (S.phase === 'rally' && S.rally.hitter === -sd) || (S.phase === 'serve' && S.server === sd);
  if (incoming && Math.abs(b[2] * sd - pd.z * sd) < 1.5) ty = clamp(b[1], TH - 0.3, TH + 0.8);
  pd.y += (ty - pd.y) * Math.min(1, dt * 16);
}

/* =====================================================================
   REGRAS
   ===================================================================== */
function canSideHit(sd) { return S.phase === 'rally' && S.rally.hitter === -sd && S.rally.canHit; }

function inHitWindow(sd, pd) {
  const b = S.ball.p;
  const bd = b[2] * sd, pdep = pd.z * sd;
  return bd >= pdep - 0.15 && bd <= pdep + 0.2 && Math.abs(b[0] - pd.x) < 0.29 && b[1] > TH - 0.38 && b[1] < TH + 0.95;
}

function playerHit(serve) {
  const sv = swipeVel();
  const sd = S.mySide;
  const chop = !serve && sv.up < -0.55;                       // puxou a raquete para trás = corte
  const power = chop ? clamp(-sv.up / POWER_DIV * 0.7, 0.1, 0.8) : Math.max(0, sv.up) / POWER_DIV;
  const B = [...S.ball.p];
  const hq = hitQuality(sv, serve);
  const tx = B[0] * 0.3 + sd * sv.x * 0.24;                   // a bola sai para o lado do gesto
  // raquete raspando de lado gira a bola no eixo vertical (sidespin) -> curva no ar (Magnus)
  // e uma "quebra" no quique: bater da esquerda pra direita faz a bola fazer a curva
  const sideSpin = clamp(sv.x * 55 * (serve ? 1.2 : 1), -260, 260);
  const shot = makeShot(sd, B, power, tx, sideSpin, serve, serve ? { rk: myRacket } : { inW: [...S.ball.w], inSpeed: Math.hypot(...S.ball.v), chop, rk: myRacket, q: hq.q });
  shot.q = hq.q; S.lastQ = hq.tag;
  applyHit(sd, B, shot, serve);
  showQuality(hq.tag);
  if (hq.q > 0) progEvent('perfect');
  if (S.mode === 'online') send({ t: 'hit', side: sd, p: B, v: shot.v, w: shot.w, serve, label: shot.label, q: hq.tag });
}

function applyHit(side, B, shot, serve) {
  S.ball.p = [...B]; S.ball.v = [...shot.v]; S.ball.w = [...shot.w];
  S.rally = { hitter: side, rb: 0, canHit: false, net: false, serve, t: 0 };
  S.phase = 'rally'; S.phaseT = 0; S.ballVisible = true;
  S.streak = serve ? 0 : S.streak + 1;
  S.lastLabel = shot.label;
  trailPts.length = 0;
  trailColor.setHex(TRAIL_COLORS[shot.label] || 0x22ff88);
  showLabel(shot.label);
  sfx('hit', shot.label, B, clamp(Math.hypot(...shot.v) / 11, 0.12, 1), (side === S.mySide ? myRacket : oppRacket).sound);
  recEvent('hit', B, clamp(Math.hypot(...shot.v) / 11, 0.12, 1), { label: shot.label, side, speed: Math.hypot(...shot.v) });
  specEv('hit', B, clamp(Math.hypot(...shot.v) / 11, 0.12, 1), { label: shot.label, side, serve: !!serve, q: shot.q > 0 ? 'PERFEITO!' : '' });
  fxHit(side, B, shot.label);
  feelHit(side, shot.label, shot.q || 0);
  predictLanding();
  if (side === S.mySide && !serve) { if (shot.label === 'SMASH!') progEvent('smash'); else if (shot.label === 'CORTE') progEvent('chop'); }
  if (S.mode === 'solo' && side !== sideOfBot() && !S.tutorial) botPredict();
}

function evalEvent(e) {
  if (S.phase !== 'rally') return;
  const H = S.rally.hitter, Rv = -H;
  if (!isAuth(Rv)) return;               // quem recebe a bola é o "juiz" da jogada
  if (e.t === 'net') { S.rally.net = true; return; }
  if (e.t === 'table') {
    if (e.z * Rv > 0) {
      S.rally.rb++;
      if (S.rally.rb === 1) {
        if (S.rally.serve && S.rally.net) awardPoint(0, 'let');   // saque tocou na rede e entrou: repete
        else S.rally.canHit = true;
      }
      else awardPoint(H, 'miss');
    } else {
      awardPoint(S.rally.rb === 0 ? Rv : H, S.rally.rb === 0 ? 'net' : 'miss');
    }
  } else if (e.t === 'dead') {
    if (S.rally.rb === 0) awardPoint(Rv, S.rally.net ? 'net' : 'out');
    else awardPoint(H, 'miss');
  }
}

function awardPoint(winner, reason) {
  let hl = false;
  if (S.tutorial) { tutPoint(winner, reason); onPoint(winner, reason, false); return; }
  if (winner === S.mySide) {                           // missões
    if (S.streak >= 10) progEvent('rally10');
    if (S.rally.hitter === winner && S.lastLabel === 'SIDE-SPIN') progEvent('curvept');
    if (S.streak === 0 && reason === 'miss' && winner === S.server) progEvent('ace');
  }
  if (winner) {
    const info = hlInfo(winner, reason);
    S.score[winner]++;
    // ponto bonito ganha replay na hora (menos no ponto que fecha o game: esse fica para o fim)
    hl = info.score >= HL_INSTANT && !isGameOver() && totalPts() - RP.lastReplayPt >= 3;
  }
  if (S.mode === 'online') send({ t: 'point', winner, reason, score: S.score, hl });
  onPoint(winner, reason, hl);
}

function onPoint(winner, reason, hl = false) {
  specOut({ t: 'spoint', winner, reason, score: S.score, games: S.games, shot: S.rally.hitter === winner ? S.lastLabel : null });
  S.phase = 'point'; S.phaseT = 0;
  recPoint(winner, reason);
  if (winner && hl && (S.mode === 'online' || cfg.replays)) { RP.pending = true; RP.lastReplayPt = totalPts(); }
  if (!winner) {                                  // LET: o saque é repetido, ninguém pontua
    showMsg('LET', 'o saque tocou na rede, repete');
    crowdVoice('ohh', 0.35);
    S.streak = 0; updateHud();
    return;
  }
  const mine = winner === S.mySide;
  const who = S.mode === 'solo' ? 'do computador' : 'do seu amigo';
  let sub;
  if (reason === 'miss') sub = mine ? (S.mode === 'solo' ? 'o computador não devolveu' : 'seu amigo não devolveu') : 'você não devolveu';
  else sub = { out: 'bola fora', net: 'bola na rede' }[reason] || '';
  const rally = S.streak;
  if (rally >= 8) sub += ` · rally de ${rally}!`;
  showMsg(mine ? 'PONTO SEU!' : `Ponto ${who}`, sub);
  sfx(mine ? 'win' : 'lose');
  const winnerShot = S.rally.hitter === winner ? S.lastLabel : null;
  fxPoint(mine, rally, reason, winnerShot, winner);
  if (S.mode === 'solo') botOnPoint(mine, reason, rally, winnerShot);
  bumpScore(mine ? 'scoreL' : 'scoreR');
  S.streak = 0;
  updateHud();
}

function computeServer() {
  const a = S.score['1'], b = S.score['-1'], tot = a + b;
  const idx = (a >= POINT_TO_WIN - 1 && b >= POINT_TO_WIN - 1) ? tot % 2 : Math.floor(tot / 2) % 2;
  return idx === 0 ? S.firstServer : -S.firstServer;
}
function isGameOver() {
  const a = S.score['1'], b = S.score['-1'];
  return (a >= POINT_TO_WIN || b >= POINT_TO_WIN) && Math.abs(a - b) >= 2;
}
const gameWinner = () => S.score['1'] > S.score['-1'] ? 1 : -1;
// a partida acaba neste ponto? (o game acabou e quem ganhou chega ao número de games)
const isMatchOver = () => isGameOver() && S.games[String(gameWinner())] + 1 >= gamesNeeded();
function matchPointFor() {               // quem fecha o game no próximo ponto
  const a = S.score['1'], b = S.score['-1'];
  if (a >= POINT_TO_WIN - 1 && a - b >= 1) return 1;
  if (b >= POINT_TO_WIN - 1 && b - a >= 1) return -1;
  return 0;
}
const isMatchPoint = sd => sd !== 0 && S.games[String(sd)] + 1 >= gamesNeeded();

function nextPoint() {
  if (isGameOver()) {                     // fim do game: soma o game e vê se a partida acabou
    const w = gameWinner();
    S.games[String(w)]++; S.gameScores.push({ '1': S.score['1'], '-1': S.score['-1'] });
    if (S.games[String(w)] >= gamesNeeded()) { S.phase = 'over'; S.ballVisible = false; showOver(); return; }
    startGameBreak(w); return;
  }
  S.server = computeServer();
  if (S.tutorial) S.server = TUT[S.tutorial.i].serve ? S.mySide : -S.mySide;
  S.phase = 'serve'; S.phaseT = 0; S.serveBall = null;
  recStart();
  S.serveX = S.server === S.mySide ? clamp(me.x, -0.6, 0.6) : (Math.random() - 0.5) * 0.8;
  bot.served = false; bot.serveAt = 0.9 + Math.random() * 0.8;
  trailPts.length = 0;
  if (S.server === S.mySide && !S.tutorial) showMsg('Seu saque', 'raquete atrás da bola + movimento para cima');
  if (matchPointFor()) startRhythm();
  updateHud();
}

function serveBallPos() {
  const t = S.phaseT;
  return [S.serveX, TH + 0.2 + 0.2 * Math.abs(Math.sin(t * 2.4)), S.server * (HL + 0.12)];
}

function startGameBreak(w) {               // intervalo entre os games (MD3/MD5)
  S.phase = 'gamebreak'; S.phaseT = 0; S.ballVisible = false;
  const mine = w === S.mySide, g = S.gameScores[S.gameScores.length - 1];
  specOut({ t: 'sgame', w, gs: g, games: S.games, gameNo: S.gameNo, gameScores: S.gameScores });
  const gm = S.games[String(S.mySide)], go = S.games[String(-S.mySide)];
  showBanner(mine ? `GAME ${S.gameNo} É SEU!` : `GAME ${S.gameNo} DE ${oppLabel().toUpperCase()}`,
    `${g[String(S.mySide)]} × ${g[String(-S.mySide)]} · games ${gm} × ${go}${isMatchPoint(w) ? ' · falta 1 game!' : ''}`, mine ? 'win' : 'lose', 3200);
  crowdReact('point', 0.9); crowdEvent(w, 0.9, true);
  if (typeof celebrate === 'function') celebrate(0.5);
  stopRhythm(); updateHud();
}
function endGameBreak() {
  S.gameNo++; S.score = { '1': 0, '-1': 0 };
  S.firstServer = S.gameNo % 2 ? S.matchFirst : -S.matchFirst;   // o saque inicial alterna a cada game
  nextPoint();
  showMsg(`GAME ${S.gameNo}`, S.server === S.mySide ? 'seu saque' : 'saque do adversário');
}
function resetMatch(firstServer) {
  if (typeof stopEnd === 'function') { stopEnd(); endReplay(false); RP.clips = []; RP.rec = null; RP.pending = false; RP.lastReplayPt = -9; }
  S.score = { '1': 0, '-1': 0 };
  S.games = { '1': 0, '-1': 0 }; S.gameNo = 1; S.gameScores = []; S.matchFirst = firstServer;
  S.firstServer = firstServer;
  S.phase = 'point'; S.phaseT = -0.6;   // espera a câmera de entrada
  S.ballVisible = false; S.streak = 0;
  $('over').classList.add('hidden');
  updateHud();
}

/* =====================================================================
   COMPUTADOR (modo treino)
   ===================================================================== */
function botPredict() {
  const sd = sideOfBot(), L = botLv();
  const b = { p: [...S.ball.p], v: [...S.ball.v], w: [...S.ball.w] };
  let bounced = false, x = 0, found = false;
  for (let i = 0; i < 900; i++) {
    const ev = []; stepBall(b, DT, ev, true);
    for (const e of ev) if (e.t === 'table' && e.z * sd > 0) bounced = true;
    if (bounced && b.p[2] * sd >= HL + 0.3) { x = b.p[0]; found = true; break; }
    if (b.p[1] < TH - 0.35) break;
  }
  bot.predX = found ? x + (Math.random() - 0.5) * L.predErr : bot.x;
  bot.react = L.react[0] + Math.random() * L.react[1];
}

function botHit(serve) {
  const sd = sideOfBot(), L = botLv(), Y = BOT_STYLES[botStyle] || BOT_STYLES.equilibrado;
  let power = serve ? 0.3 + Math.random() * 0.6 : (L.pw[0] + Math.random() * L.pw[1]) * Y.pw;
  let tx = (Math.random() * 2 - 1) * (serve ? 0.45 : L.aim);
  const r = Math.random(), err = L.err * Y.err;
  if (!serve && r < err) power = 2.25 + Math.random() * 0.3;          // erro: bateu forte demais
  else if (!serve && r < err + L.wide * Y.err) tx = Math.sign(tx || 1) * (1.25 + Math.random() * 0.2);   // erro: abriu demais
  const B = [...S.ball.p];
  if (!serve && B[1] > TH + 0.33 && Math.random() < L.smash + Y.smash) power = 1.0 + Math.random() * 0.25;   // bola alta: smash
  const chop = !serve && power < 0.95 && Math.random() < L.chop * Y.chop;
  if (chop) power = 0.3 + Math.random() * 0.4;
  const shot = makeShot(sd, B, power, tx, (Math.random() * 2 - 1) * (Math.random() < L.side * Y.side ? 220 : 60), serve, serve ? { rk: oppRacket } : { inW: [...S.ball.w], inSpeed: Math.hypot(...S.ball.v), chop, rk: oppRacket });
  applyHit(sd, B, shot, serve);
  bot.lunge = 0.22;
}

function botStep(dt) {
  const sd = sideOfBot();
  let tx = bot.x * 0.98, depth = HL + 0.35, maxV = botLv().maxV;
  if (S.tutorial) {                                   // tutorial: a CPU só alimenta bolas
    if (S.phase === 'serve' && S.server === sd && TUT[S.tutorial.i].k !== 'move' && S.phaseT > 0.9 && !bot.served) { bot.served = true; tutFeed(); }
    bot.x += clamp(me.x * 0.5 - bot.x, -2 * dt, 2 * dt); bot.lunge = Math.max(0, bot.lunge - dt); bot.z = sd * (HL + 0.35 - bot.lunge * 1.2); autoY(bot, sd, dt);
    return;
  }
  if (S.phase === 'serve' && S.server === sd) {
    tx = S.serveX; depth = HL + 0.3; maxV = 4;
    if (S.phaseT > bot.serveAt && !bot.served && Math.abs(bot.x - S.serveX) < 0.05) { bot.served = true; S.ball.p = serveBallPos(); botHit(true); }
  } else if (S.phase === 'rally' && S.rally.hitter === -sd) {
    if (bot.react > 0) { bot.react -= dt; tx = bot.x; } else tx = bot.predX;
  } else {
    tx = bot.x + (0 - bot.x) * 0.02;
  }
  bot.x += clamp(tx - bot.x, -maxV * dt, maxV * dt);
  bot.lunge = Math.max(0, bot.lunge - dt);
  bot.z = sd * (depth - bot.lunge * 1.2);
  autoY(bot, sd, dt);
  if (canSideHit(sd) && inHitWindow(sd, bot)) botHit(false);
}

/* =====================================================================
   LOOP DA FÍSICA
   ===================================================================== */
function beginInstantReplay() {
  RP.pending = false;
  const c = RP.rec;
  if (!c || !c.done || c.frames.length < 20) { nextPoint(); return; }
  recFinish();
  S.phase = 'replay'; S.phaseT = 0; S.ballVisible = false;
  startReplay(c, { mode: 'instant', title: 'REPLAY', onEnd: () => { if (S.phase === 'replay') nextPoint(); } });
}
function physicsStep(dt) {
  if (S.mode === 'spec') return;                       // quem assiste só desenha o que o anfitrião manda
  if (S.phase === 'lobby' || S.phase === 'over' || S.phase === 'replay') return;
  S.phaseT += dt;

  if (S.phase === 'serve') {
    if (isAuth(S.server)) { S.ball.p = serveBallPos(); S.ballVisible = true; }
    else { S.ballVisible = !!S.serveBall; if (S.serveBall) S.ball.p = [...S.serveBall]; }
    if (S.server === S.mySide && S.phaseT > 0.45) {
      const bd = S.ball.p[2] * S.mySide, cd = me.z * S.mySide;
      if (me.prevDepth > bd && cd <= bd + 0.02 && Math.abs(me.x - S.ball.p[0]) < 0.29) playerHit(true);
    }
  } else if (S.phase === 'gamebreak') {
    if (S.phaseT > 3.6) endGameBreak();
  } else if (S.phase === 'rally' || S.phase === 'point') {
    const ev = [];
    stepBall(S.ball, dt, ev, true);
    for (const e of ev) {
      if (e.t === 'table') { sfx('table', null, [e.x, TH, e.z], e.s / 4.2); fxBounce(e.x, e.z); recEvent('table', [e.x, TH, e.z], e.s / 4.2); specEv('table', [e.x, TH, e.z], e.s / 4.2); }
      else if (e.t === 'net') { sfx('net', null, [e.x, e.y, 0], e.graze ? 0.3 + e.s / 30 : e.s / 6); netHit(e); recEvent('net', [e.x, e.y, 0], e.graze ? 0.3 + e.s / 30 : e.s / 6); specEv('net', [e.x, e.y, 0], e.graze ? 0.3 + e.s / 30 : e.s / 6, { graze: !!e.graze }); }
      else if (e.t === 'floor' && e.s > 0.25) sfx('floor', null, [e.x, 0, e.z], e.s / 3.5);
    }
    if (S.phase === 'rally') {
      S.rally.t += dt;
      for (const e of ev) evalEvent(e);
      if (S.phase === 'rally' && (S.ball.p[1] < TH - 0.4 || S.rally.t > 6 || Math.abs(S.ball.p[2]) > HL + 3.5)) evalEvent({ t: 'dead' });
      if (canSideHit(S.mySide) && inHitWindow(S.mySide, me)) playerHit(false);
    }
    if (S.phase === 'point' && S.phaseT > 1.0) S.ballVisible = false;
    if (S.phase === 'point' && S.phaseT > 1.35) { if (RP.pending) beginInstantReplay(); else nextPoint(); }
  }
  if (S.mode === 'solo') botStep(dt);
  me.prevDepth = me.z * S.mySide;
}

/* =====================================================================
   REDE (PeerJS / WebRTC — conexão direta entre os dois navegadores)
   ===================================================================== */
let peer = null, conn = null, isHost = false;
let lastPadSend = 0, lastPing = 0;

function send(m) { if (conn && conn.open) { try { conn.send(m); } catch (e) { } } }
let curRoom = '';
function genCode() {
  const ch = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 5; i++) s += ch[Math.floor(Math.random() * ch.length)];
  return s;
}
function cleanupNet() {
  try { conn && conn.close(); } catch (e) { }
  for (const c of specs.splice(0)) { try { c.close(); } catch (e) { } }
  try { specConn && specConn.close(); } catch (e) { }
  try { peer && peer.destroy(); } catch (e) { }
  conn = null; peer = null; specConn = null;
}
function netErrorText(e) {
  const t = e && e.type;
  if (t === 'peer-unavailable') return 'Sala não encontrada. Confira o código (ou peça um link novo).';
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Não consegui falar com o servidor de conexão. Verifique sua internet e tente de novo.';
  if (t === 'browser-incompatible') return 'Seu navegador não suporta WebRTC. Use Chrome, Edge, Safari ou Firefox atualizados.';
  return 'Erro de conexão: ' + (t || e);
}
function createRoom(fixed) {
  if (typeof Peer === 'undefined') { lobbyMsg('Não carregou a biblioteca de rede. Recarregue a página.'); return; }
  cleanupNet(); isHost = true; if (!S.ranked) S.oppName = null;
  const code = fixed || genCode(); curRoom = code;
  if (!fixed) { showPanel('wait'); $('codeTxt').textContent = '·····'; lobbyMsg(''); }
  peer = new Peer(PEER_PREFIX + code, { debug: 1 });
  const pr = peer;
  peer.on('open', () => {
    pr.__ok = true;
    const link = `${location.origin}${location.pathname}?sala=${code}`;
    $('codeTxt').textContent = code;
    $('linkTxt').value = link;
    $('btnWa').href = 'https://wa.me/?text=' + encodeURIComponent('Bora jogar ping pong? 🏓 ' + link);
  });
  peer.on('connection', c => {
    if (c.metadata && c.metadata.spec) { addSpectator(c); return; }   // 👀 espectador
    if (conn) { c.on('open', () => c.close()); return; }
    setupConn(c);
  });
  peer.on('error', e => {
    if (e.type === 'unavailable-id' && !fixed) { createRoom(); return; }
    if (fixed) { rankedFail('Não consegui abrir a partida ranqueada. Tente de novo.'); return; }
    lobbyMsg(netErrorText(e));
  });
  peer.on('disconnected', () => { if (!conn) { try { peer.reconnect(); } catch (e) { } } });
}
function joinRoom(code, tries = 0) {
  if (typeof Peer === 'undefined') { lobbyMsg('Não carregou a biblioteca de rede. Recarregue a página.'); return; }
  code = (code || '').trim().toUpperCase();
  if (code.length < 4) { lobbyMsg('Digite o código da sala.'); return; }
  cleanupNet(); isHost = false; if (!S.ranked) S.oppName = null; curRoom = code;
  if (!S.ranked) { showPanel('joining'); $('joinTxt').textContent = `Entrando na sala ${code}…`; lobbyMsg(''); }
  peer = new Peer({ debug: 1 });
  peer.on('open', () => {
    const c = peer.connect(PEER_PREFIX + code, { reliable: true });
    setupConn(c);
    setTimeout(() => { if (!c.open && S.phase === 'lobby' && conn === c) { lobbyMsg('Não consegui conectar. Pode ser a rede (Wi-Fi corporativo/4G bloqueando). Tente outra rede.'); showPanel('menu'); cleanupNet(); } }, 15000);
  });
  peer.on('error', e => {
    // na ranqueada o anfitrião pode demorar um pouco para abrir a sala: tenta de novo
    if (S.ranked && e.type === 'peer-unavailable' && tries < 7) { setTimeout(() => { if (S.ranked && S.phase === 'lobby') joinRoom(code, tries + 1); }, 1500); return; }
    if (S.ranked) { rankedFail('Não consegui conectar com o adversário. Tente de novo.'); return; }
    lobbyMsg(netErrorText(e)); showPanel('menu');
  });
}
function setupConn(c) {
  conn = c;
  c.on('open', () => { send({ t: 'hello', rk: myRacket.id, tag: myTag(), sk: mySkinFor(myRacket), av: validAv(myAvatar()), fd: isFounder(), name: acct.profile ? acct.profile.name : null }); if (isHost) { const f = S.ranked ? 1 : pickState.fmt; send({ t: 'start', arena: A.id, fmt: f }); startGame('online', 1, f); } });
  c.on('data', onMsg);
  c.on('close', () => onDisconnect());
  c.on('error', () => onDisconnect());
}
function onDisconnect() {
  if (S.mode !== 'online') return;
  const rk = S.ranked && !S.ranked.reported && S.phase !== 'over' ? S.ranked : null;
  if (rk) { rk.reported = true; rankedReport(rk, S.score[String(S.mySide)], S.score[String(-S.mySide)], false); }
  goMenu();
  lobbyMsg(rk ? 'Seu adversário saiu da ranqueada. Se ele não voltar em 3 minutos, a vitória conta para você.' : 'A conexão com seu amigo caiu.');
}
function onMsg(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'start': if (m.arena && arenaById(m.arena).id !== A.id) buildArena(m.arena); startGame('online', -1, S.ranked ? 1 : ([1, 3, 5].includes(m.fmt) ? m.fmt : 1)); break;
    case 'hello': if (RACKETS.some(r => r.id === m.rk)) setPaddle('op', racketById(m.rk), cleanTag(m.tag), typeof m.sk === 'string' ? m.sk : ''); if (typeof m.name === 'string' && !S.ranked) S.oppName = m.name.slice(0, 20); oppAvatar = validAv(m.av); oppFounder = m.fd === true; refreshNames(); updateHud(); specInitAll(); if (VS.on) renderVs(); break;
    case 'cheer': if (CHEERS.includes(m.e)) showCheer(m.e); break;
    case 'specs': showSpecCount(+m.n || 0); break;
    case 'pad':
      opp.tx = m.x; opp.ty = m.y; opp.tz = m.z;
      S.serveBall = m.b || null;
      break;
    case 'hit': {
      if (S.phase === 'lobby' || S.phase === 'over') return;
      if (RP.play && S.phase === 'replay') endReplay(true);     // o adversário já sacou: fecha o replay
      applyHit(m.side, m.p, { v: m.v, w: m.w, label: m.label, q: m.q === 'PERFEITO!' ? 1 : 0 }, m.serve);
      if (m.q === 'PERFEITO!') showQuality(m.q, false);
      const ff = Math.min(S.rtt / 2, 0.2) * TIME_SCALE;   // compensa atraso da rede
      for (let t = 0; t < ff; t += DT) {
        const ev = []; stepBall(S.ball, DT, ev, true);
        for (const e of ev) evalEvent(e);
        if (S.phase !== 'rally') break;
      }
      break;
    }
    case 'point':
      S.score = { '1': m.score['1'], '-1': m.score['-1'] };
      onPoint(m.winner, m.reason, !!m.hl);
      break;
    case 'rskip': if (RP.play && RP.play.mode === 'instant') { RP.play.skipOpp = true; if (RP.play.skipMe) endReplay(); } break;
    case 'ping': send({ t: 'pong', ts: m.ts }); break;
    case 'pong': {
      const rtt = (performance.now() - m.ts) / 1000;
      S.rtt = S.rtt * 0.7 + rtt * 0.3;
      $('ping').textContent = `ping ${Math.round(S.rtt * 1000)} ms`;
      break;
    }
    case 'rematch': resetMatch(-S.matchFirst); setTimeout(updateLockUI, 50); break;
    case 'chat': recvChat(m); break;
  }
}
function netTick(now) {
  specTick(now);
  if (S.mode !== 'online' || !conn) return;
  if (now - lastPadSend > 33) {
    lastPadSend = now;
    const serving = S.phase === 'serve' && S.server === S.mySide;
    send({ t: 'pad', x: +me.x.toFixed(3), y: +me.y.toFixed(3), z: +me.z.toFixed(3), b: serving ? S.ball.p.map(v => +v.toFixed(3)) : null });
  }
  if (now - lastPing > 1000) { lastPing = now; send({ t: 'ping', ts: now }); }
}

/* =====================================================================
   SOM — síntese modal (sem arquivos): cada impacto é a soma das frequências
   naturais da bola + mesa/raquete, com volume pela força do impacto,
   estéreo pela posição da bola e reverb de ginásio.
   ===================================================================== */
let actx = null, master = null, sfxBus = null, noiseBuf = null;
let crowdBus = null, murmurGain = null, applauseGain = null, clapGroupBuf = null, rhythmTimer = 0;
const IMP = {};
let muted = store.get('pp_mute', '0') === '1';
let sampleBus = null, sfxSend = null, crowdSendG = null, ambGain = null, ambNodes = [];
const VOL = { fx: [], crowd: null, music: null, ui: null, musicDuck: null };   // volumes por tipo de som
// som de cada cenário: quanto eco, tamanho da torcida e ambiente (ondas do mar, cidade)
function applyArenaAudio() {
  if (!actx || !A.def) return;
  const au = A.def.audio, t = actx.currentTime;
  sfxSend.gain.setTargetAtTime(au.rev, t, 0.2);
  crowdSendG.gain.setTargetAtTime(au.rev * 1.8, t, 0.2);
  crowdBus.gain.setTargetAtTime(au.crowd, t, 0.3);
  for (const n of ambNodes) { try { n.stop ? n.stop() : n.disconnect(); } catch (e) { } }
  ambNodes = []; clearTimeout(waveTimer);
  if (!au.amb) return;
  const src = actx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass';
  const g = actx.createGain();
  if (au.amb === 'breeze') {                          // brisa bem leve, que vai e volta devagar
    lp.frequency.value = 420; lp.Q.value = 0.2; g.gain.value = 0.006;
    const lfo = actx.createOscillator(), lg = actx.createGain(); lfo.frequency.value = 0.06; lg.gain.value = 0.0035;
    lfo.connect(lg).connect(g.gain); lfo.start(); ambNodes.push(lfo);
  } else {
    lp.frequency.value = 260; g.gain.value = 0.045;
  }
  src.connect(lp).connect(g).connect(ambGain); src.start(0, Math.random() * 2); ambNodes.push(src);
}
let waveTimer = 0;
function oneWave() {                            // uma onda: cresce, quebra e a espuma vai sumindo na areia
  if (!actx || !A.def || A.def.audio.amb !== 'waves') return;   // (sem uso: a praia agora tem brisa)
  const t = actx.currentTime + 0.05, rise = 1.4 + Math.random() * 1.4, dur = rise + 3 + Math.random() * 2.5;
  const peak = 0.018 + Math.random() * 0.014, pan = (Math.random() - 0.5) * 0.9;
  const out = actx.createStereoPanner ? actx.createStereoPanner() : actx.createGain();
  if (out.pan) out.pan.value = pan;
  out.connect(ambGain);
  const body = actx.createBufferSource(); body.buffer = noiseBuf; body.playbackRate.value = 0.55;
  const blp = actx.createBiquadFilter(); blp.type = 'lowpass'; blp.Q.value = 0.3;
  blp.frequency.setValueAtTime(220, t); blp.frequency.exponentialRampToValueAtTime(950, t + rise); blp.frequency.exponentialRampToValueAtTime(300, t + dur);
  const bg = actx.createGain(); bg.gain.setValueAtTime(0.0001, t); bg.gain.exponentialRampToValueAtTime(peak, t + rise);
  bg.gain.exponentialRampToValueAtTime(peak * 0.35, t + rise + 0.9); bg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  body.connect(blp).connect(bg).connect(out); body.start(t, Math.random() * 2); body.stop(t + dur + 0.1);
  const foam = actx.createBufferSource(); foam.buffer = noiseBuf; foam.playbackRate.value = 1.25;
  const fhp = actx.createBiquadFilter(); fhp.type = 'bandpass'; fhp.frequency.value = 3200; fhp.Q.value = 0.5;
  const fg = actx.createGain(); fg.gain.setValueAtTime(0.0001, t + rise * 0.85); fg.gain.exponentialRampToValueAtTime(peak * 0.45, t + rise + 0.25);
  fg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  foam.connect(fhp).connect(fg).connect(out); foam.start(t, Math.random() * 2); foam.stop(t + dur + 0.1);
  ambNodes.push(body, foam);
  if (ambNodes.length > 24) ambNodes.splice(1, ambNodes.length - 13);
  waveTimer = setTimeout(oneWave, (dur * 0.62 + Math.random() * 1.5) * 1000);
}
function boom(v = 0.6) {                       // estouro grave (fogos / pirotecnia)
  if (!actx) return;
  const t = actx.currentTime, src = actx.createBufferSource(); src.buffer = noiseBuf; src.playbackRate.value = 0.5;
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(120, t + 0.6);
  const g = actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35 * v, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  src.connect(lp).connect(g).connect(sfxBus); src.start(t, Math.random() * 2); src.stop(t + 1);
}
// Sons reais da bolinha (gravados): baixados do GitHub (CDN com reserva) e decodificados ao ativar o som.
// Se não carregarem, o jogo usa os sons sintetizados.
const SAMPLE_SHA = '3426a8b46e6d3cb5d791551e945fc3cf17d5a38c';
const SAMPLE_BASES = [`https://cdn.jsdelivr.net/gh/amxgroup07/pingpong-online@${SAMPLE_SHA}/sounds/`, `https://raw.githubusercontent.com/amxgroup07/pingpong-online/${SAMPLE_SHA}/sounds/`];
const SAMPLE_FILES = { paddle: ['paddle1', 'paddle2', 'paddle3', 'paddle4'], table: ['table1', 'table2', 'table3', 'table4'] };
const SAMPLES = {};
async function fetchSample(name) {
  for (const base of SAMPLE_BASES) {
    try { const r = await fetch(base + name + '.wav'); if (r.ok) return await r.arrayBuffer(); } catch (e) { }
  }
  return null;
}
const sampleData = Object.fromEntries(Object.entries(SAMPLE_FILES).map(([k, names]) => [k, Promise.all(names.map(fetchSample))]));
async function decodeSamples() {
  for (const [k, p] of Object.entries(sampleData)) {
    const raws = await p, bufs = [];
    for (const ab of raws) { if (!ab) continue; try { bufs.push(await actx.decodeAudioData(ab.slice(0))); } catch (e) { } }
    if (bufs.length) SAMPLES[k] = bufs;
  }
}
const _camR = new THREE.Vector3();

function synthImpact(modes, o = {}) {
  const sr = actx.sampleRate, dur = o.dur || 0.13, n = Math.floor(sr * dur);
  const buf = actx.createBuffer(1, n, sr), d = buf.getChannelData(0);
  const det = 1 + (Math.random() - 0.5) * 0.05;
  for (const [f, dec, a] of modes) {
    const ff = f * det * (1 + (Math.random() - 0.5) * 0.02), ph = Math.random() * 6.283, k = 2 * Math.PI * ff / sr;
    for (let i = 0; i < n; i++) d[i] += a * Math.exp(-i / sr / dec) * Math.sin(k * i + ph);
  }
  // estalo inicial (o "clique" do contato)
  let lp = 0; const cn = Math.floor(sr * 0.005);
  for (let i = 0; i < cn; i++) { lp += ((Math.random() * 2 - 1) - lp) * (o.clickLP || 0.5); d[i] += lp * (o.click || 0.6) * Math.exp(-i / sr / 0.0011); }
  const atk = Math.floor(sr * 0.0003);
  let peak = 0;
  for (let i = 0; i < n; i++) { if (i < atk) d[i] *= i / atk; peak = Math.max(peak, Math.abs(d[i])); }
  const g = 0.9 / (peak || 1);
  for (let i = 0; i < n; i++) d[i] *= g;
  return buf;
}
function makeIR(sec) {
  const sr = actx.sampleRate, n = Math.floor(sr * sec), ir = actx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.5) * Math.min(1, i / (sr * 0.008));
    for (const [ms, a] of [[19, 0.6], [31, 0.45], [47, 0.35], [68, 0.25]]) { const j = Math.floor(sr * (ms + c * 3) / 1000); if (j < n) d[j] += a; }
  }
  return ir;
}
function ensureAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 3; comp.attack.value = 0.002; comp.release.value = 0.15;
    master = actx.createGain(); master.gain.value = muted ? 0 : volGain(cfg.vMaster);
    master.connect(comp).connect(actx.destination);
    const mk = () => { const g = actx.createGain(); g.connect(master); return g; };
    VOL.fx = [mk(), mk()]; VOL.crowd = mk(); VOL.music = mk(); VOL.ui = mk();
    VOL.musicDuck = actx.createGain(); VOL.musicDuck.connect(VOL.music);
    // reverb de ginásio
    const rev = actx.createConvolver(); rev.buffer = makeIR(1.7);
    const send = actx.createGain(); send.gain.value = 0.28; sfxSend = send;
    const ret = actx.createGain(); ret.gain.value = 0.55;
    sfxBus = actx.createGain();
    rev.connect(ret).connect(master);
    sfxBus.connect(VOL.fx[0]); VOL.fx[0].connect(send).connect(rev);
    // sons gravados já têm o ambiente da sala: vão quase secos
    sampleBus = actx.createGain(); sampleBus.gain.value = 1.15;
    const sSend = actx.createGain(); sSend.gain.value = 0.1;
    sampleBus.connect(VOL.fx[1]); VOL.fx[1].connect(sSend).connect(rev);
    // barramento da torcida (com bastante eco de ginásio)
    crowdBus = actx.createGain(); crowdBus.gain.value = 1;
    const crowdSend = actx.createGain(); crowdSend.gain.value = 0.5; crowdSendG = crowdSend;
    ambGain = actx.createGain(); ambGain.gain.value = 1; ambGain.connect(VOL.crowd);
    VOL.crowdDuck = actx.createGain(); VOL.crowdDuck.connect(VOL.crowd);
    crowdBus.connect(VOL.crowdDuck); VOL.crowd.connect(crowdSend).connect(rev);
    // bancos de sons (4 variações cada para não soar repetitivo)
    const bank = (modes, o) => [0, 1, 2, 3].map(() => synthImpact(modes, o));
    IMP.table = bank([[2350, 0.011, 1], [3950, 0.007, 0.55], [5700, 0.004, 0.3], [1180, 0.018, 0.35], [430, 0.03, 0.3], [190, 0.045, 0.2]], { click: 0.8, clickLP: 0.6 });
    IMP.paddle = bank([[1550, 0.009, 1], [2650, 0.006, 0.5], [880, 0.016, 0.55], [480, 0.024, 0.35], [260, 0.032, 0.22]], { click: 0.5, clickLP: 0.35 });
    IMP.smash = bank([[1750, 0.008, 1], [3100, 0.006, 0.65], [4600, 0.004, 0.4], [900, 0.014, 0.5], [420, 0.022, 0.38]], { click: 1, clickLP: 0.75 });
    IMP.floor = bank([[2700, 0.01, 0.9], [4300, 0.006, 0.45], [1300, 0.014, 0.3], [650, 0.02, 0.2]], { click: 0.6, clickLP: 0.5 });
    IMP.net = bank([[320, 0.035, 0.6], [760, 0.02, 0.4], [1500, 0.01, 0.25]], { click: 0.4, clickLP: 0.15, dur: 0.16 });
    // ruído base (torcida, aplausos, "vush")
    noiseBuf = actx.createBuffer(1, actx.sampleRate * 3, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = last * 0.6 + w * 0.4; d[i] = last; }
    // murmúrio constante (duas "metades" da arquibancada em estéreo, com variação lenta)
    murmurGain = actx.createGain(); murmurGain.gain.value = 0.07; murmurGain.connect(crowdBus);
    for (const side of [-0.65, 0.65]) {
      const mur = actx.createBufferSource(); mur.buffer = noiseBuf; mur.loop = true;
      const pn = actx.createStereoPanner(); pn.pan.value = side; pn.connect(murmurGain);
      for (const [fr, q, lf] of [[380, 0.9, 0.13], [850, 1.1, 0.21], [1600, 1.4, 0.31]]) {
        const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = fr * (1 + side * 0.05); bp.Q.value = q;
        const g = actx.createGain(); g.gain.value = 0.55;
        const lfo = actx.createOscillator(); lfo.frequency.value = lf * (1 + Math.random() * 0.4);
        const lg = actx.createGain(); lg.gain.value = 0.35; lfo.connect(lg).connect(g.gain); lfo.start();
        mur.connect(bp).connect(g).connect(pn);
      }
      mur.start(0, Math.random() * 2);
    }
    // aplausos: centenas de palmas individuais com timbre e posição aleatórios
    const apl = actx.createBufferSource(); apl.buffer = makeClaps(3, 480, 3, true); apl.loop = true;
    const abp = actx.createBiquadFilter(); abp.type = 'bandpass'; abp.frequency.value = 1700; abp.Q.value = 0.45;
    applauseGain = actx.createGain(); applauseGain.gain.value = 0.0001;
    apl.connect(abp).connect(applauseGain).connect(crowdBus); apl.start();
    clapGroupBuf = makeClaps(0.25, 70, 0.045, false);
    decodeSamples();
    applyArenaAudio();
    applyVolumes();
    music.start();
  } catch (e) { console.warn('audio', e); actx = null; }
}
// gera palmas: cada palma é um estalo curto de ruído com timbre, força e lado aleatórios
function makeClaps(sec, count, spread, wrap) {
  const sr = actx.sampleRate, n = Math.floor(sr * sec), buf = actx.createBuffer(2, n, sr);
  const L = buf.getChannelData(0), Rr = buf.getChannelData(1);
  for (let k = 0; k < count; k++) {
    const t0 = Math.floor(Math.random() * spread * sr), amp = 0.25 + Math.random() * 0.75;
    const dec = (0.003 + Math.random() * 0.009) * sr, len = Math.floor(dec * 6), a = 0.25 + Math.random() * 0.6;
    const pan = Math.random(); let lp = 0;
    for (let j = 0; j < len; j++) {
      let idx = t0 + j; if (idx >= n) { if (!wrap) break; idx -= n; }
      const w = Math.random() * 2 - 1; lp += (w - lp) * a;
      const v = (w - lp * 0.7) * amp * Math.exp(-j / dec) * Math.min(1, j / 12);
      L[idx] += v * (1 - pan); Rr[idx] += v * pan;
    }
  }
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(Rr[i]));
  const g = 0.9 / (peak || 1); for (let i = 0; i < n; i++) { L[i] *= g; Rr[i] *= g; }
  return buf;
}
// vozes da torcida: dezenas de "pessoas" (osciladores com tom e vibrato próprios) passando
// por filtros de vogal — "aaah!" sobe na comemoração, "óóóh" cai quando a bola sai/vai na rede
function crowdVoice(kind, amount) {
  if (!actx) return;
  const t = actx.currentTime, ohh = kind === 'ohh';
  const dur = ohh ? 1.5 : 1.4 + amount * 1.2;
  const out = actx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(0.03 + 0.11 * amount, t + (ohh ? 0.14 : 0.2));
  out.gain.setTargetAtTime(0.0001, t + dur * 0.45, dur * 0.22);
  out.connect(crowdBus);
  const F = ohh ? [[430, 6, 1], [780, 7, 0.65], [2500, 10, 0.25]] : [[760, 5, 1], [1180, 6, 0.7], [2550, 9, 0.35]];
  const filters = F.map(([fr, q, a]) => {
    const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = fr; bp.Q.value = q;
    bp.frequency.setValueAtTime(fr * (ohh ? 1.05 : 0.95), t); bp.frequency.linearRampToValueAtTime(fr * (ohh ? 0.9 : 1.06), t + dur * 0.7);
    const g = actx.createGain(); g.gain.value = a; bp.connect(g).connect(out); return bp;
  });
  const N = 18;
  for (let i = 0; i < N; i++) {
    const o = actx.createOscillator(); o.type = 'sawtooth';
    const base = Math.random() < 0.55 ? 105 + Math.random() * 90 : 190 + Math.random() * 140;   // vozes graves e agudas
    const st = t + Math.random() * 0.15;
    o.frequency.setValueAtTime(base * (ohh ? 1.12 : 0.9), st);
    o.frequency.linearRampToValueAtTime(base * (ohh ? 0.76 : 1.15), st + dur * 0.55);
    o.frequency.linearRampToValueAtTime(base * (ohh ? 0.7 : 1.02), st + dur);
    const vib = actx.createOscillator(); vib.frequency.value = 4 + Math.random() * 3.5;
    const vg = actx.createGain(); vg.gain.value = base * 0.025; vib.connect(vg).connect(o.frequency);
    const og = actx.createGain(); og.gain.value = (0.6 + Math.random() * 0.8) / N;
    const pn = actx.createStereoPanner(); pn.pan.value = Math.random() * 2 - 1;
    o.connect(og).connect(pn); filters.forEach(fl => pn.connect(fl));
    o.start(st); vib.start(st); o.stop(t + dur + 0.3); vib.stop(t + dur + 0.3);
  }
  const ns = actx.createBufferSource(); ns.buffer = noiseBuf;
  const ng = actx.createGain(); ng.gain.value = 0.4; ns.connect(ng); filters.forEach(fl => ng.connect(fl));
  ns.start(t, Math.random() * 2); ns.stop(t + dur + 0.3);
}
function applause(amount, length, delay = 0) {
  if (!actx) return;
  const t = actx.currentTime + delay, g = applauseGain.gain;
  g.cancelScheduledValues(t); g.setTargetAtTime(0.32 * amount, t, 0.12); g.setTargetAtTime(0.0001, t + 0.35 + length, 0.35 + length * 0.3);
}
function whistle(delay = 0) {
  if (!actx) return;
  const t = actx.currentTime + delay, f = 2200 + Math.random() * 1000, len = 0.35 + Math.random() * 0.4;
  const o = actx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(f * 0.82, t); o.frequency.linearRampToValueAtTime(f, t + 0.1);
  o.frequency.setValueAtTime(f, t + len); o.frequency.linearRampToValueAtTime(f * 0.78, t + len + 0.15);
  const lfo = actx.createOscillator(); lfo.frequency.value = 5 + Math.random() * 3;
  const lg = actx.createGain(); lg.gain.value = 35; lfo.connect(lg).connect(o.frequency);
  const g = actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.03, t + 0.05);
  g.gain.setValueAtTime(0.03, t + len); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.18);
  const p = actx.createStereoPanner(); p.pan.value = Math.random() * 1.6 - 0.8;
  o.connect(g).connect(p).connect(crowdBus); o.start(t); lfo.start(t); o.stop(t + len + 0.25); lfo.stop(t + len + 0.25);
}
function clapGroup() {
  if (!actx) return;
  const src = actx.createBufferSource(); src.buffer = clapGroupBuf; src.playbackRate.value = 0.97 + Math.random() * 0.06;
  const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 0.5;
  const g = actx.createGain(); g.gain.value = 0.42;
  src.connect(bp).connect(g).connect(crowdBus); src.start();
}
function setTension(level) {           // torcida fica mais agitada em rally longo
  if (!actx) return;
  murmurGain.gain.setTargetAtTime(0.07 + clamp(level, 0, 1) * 0.11, actx.currentTime, 0.4);
}
function startRhythm() {               // palmas ritmadas no match point
  stopRhythm();
  if (!actx) return;
  let n = 0; crowd.clap = true;
  rhythmTimer = setInterval(() => { if (S.phase !== 'serve' || ++n > 14) { stopRhythm(); return; } clapGroup(); }, 520);
}
function stopRhythm() { clearInterval(rhythmTimer); rhythmTimer = 0; crowd.clap = false; }
// reação da torcida a cada lance
function crowdReact(type, amount = 0.6) {
  if (!actx) return;
  if (type === 'point') { crowdVoice('yeah', amount); applause(amount, 1.1 + amount * 1.6); if (amount > 0.85) { whistle(0.25); whistle(0.6); } }
  else if (type === 'ohh') { crowdVoice('ohh', 0.75); applause(0.35, 1.0, 0.7); }
  else if (type === 'wow') crowdVoice('yeah', 0.35);
  else if (type === 'start') applause(0.6, 1.6);
  else if (type === 'win') { crowdVoice('yeah', 1); applause(1, 5); for (let i = 0; i < 5; i++) whistle(0.2 + i * 0.35 + Math.random() * 0.2); setTimeout(() => crowdVoice('yeah', 0.8), 1600); }
  setTension(0);
}
function sfxChat(who) {
  if (!actx || who === 'sys') return;
  tone(who === 'op' ? 740 : 988, 0.08, 0.05, 'sine'); tone(who === 'op' ? 988 : 1318, 0.1, 0.04, 'sine', 0.06);
}
// toca um impacto: força 0..1 controla volume e brilho; posição controla estéreo e distância
function playImpact(kind, pos, strength, snd) {
  if (!actx || !IMP[kind]) return;
  // usa o som gravado quando disponível (raquete/smash -> raquete; mesa/chão -> mesa)
  const real = { paddle: 'paddle', smash: 'paddle', table: 'table', floor: 'table' }[kind];
  const rset = real && SAMPLES[real];
  const set = rset || IMP[kind], buf = set[(Math.random() * set.length) | 0];
  const st = clamp(strength, 0.03, 1);
  const src = actx.createBufferSource(); src.buffer = buf;
  src.playbackRate.value = rset ? (kind === 'floor' ? 1.12 : 0.97 + Math.random() * 0.06 + (kind === 'smash' ? 0.03 : 0)) : 0.96 + Math.random() * 0.08 + st * 0.05;
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.4;
  let cutoff = rset ? (kind === 'floor' ? 3500 : 2600 + st * 16000) : 1800 + st * st * 14000;
  let vol = rset ? (0.12 + st * 0.88) * (kind === 'smash' ? 1.25 : kind === 'floor' ? 0.5 : 1) : 0.08 + st * 0.92, pan = 0;
  if (pos) {
    const dx = pos[0] - camera.position.x, dy = pos[1] - camera.position.y, dz = pos[2] - camera.position.z;
    const dist = Math.hypot(dx, dy, dz);
    vol *= 1.7 / (1 + 0.5 * dist);
    cutoff *= clamp(1.35 - dist * 0.11, 0.4, 1);
    _camR.setFromMatrixColumn(camera.matrixWorld, 0);
    pan = clamp((dx * _camR.x + dz * _camR.z) / 1.8, -0.85, 0.85);
  }
  if (snd) { src.playbackRate.value *= snd.rate; cutoff *= snd.cut; vol *= snd.vol; }
  if (kind === 'paddle' && st < 0.35) { cutoff *= 0.45 + st * 1.4; vol *= 0.75 + st * 0.6; }   // toque leve: "tuc" macio
  lp.frequency.value = Math.min(cutoff, 18000);
  const g = actx.createGain(); g.gain.value = vol;
  src.connect(lp).connect(g);
  const bus = rset ? sampleBus : sfxBus;
  if (actx.createStereoPanner) { const p = actx.createStereoPanner(); p.pan.value = pan; g.connect(p).connect(bus); }
  else g.connect(bus);
  src.start();
}
/* ---------- sons de detalhe ("ASMR") ---------- */
const panFor = pos => {
  if (!pos) return 0;
  _camR.setFromMatrixColumn(camera.matrixWorld, 0);
  return clamp(((pos[0] - camera.position.x) * _camR.x + (pos[2] - camera.position.z) * _camR.z) / 1.8, -0.85, 0.85);
};
function outTo(bus, pan) {
  if (actx.createStereoPanner) { const p = actx.createStereoPanner(); p.pan.value = pan; p.connect(bus); return p; }
  return bus;
}
// vento da raquete cortando o ar: grave "fff" + agudo "sss", mais longo e mais agudo quanto mais rápido
function swingAir(pan, s, vol = 1) {
  if (!actx || !cfg.asmr) return;
  const t = actx.currentTime, d = 0.1 + s * 0.2, out = outTo(sfxBus, pan);
  const a = actx.createBufferSource(); a.buffer = noiseBuf; a.playbackRate.value = 0.9 + s * 0.6;
  const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(320 + s * 200, t); bp.frequency.exponentialRampToValueAtTime(900 + s * 1600, t + d * 0.6); bp.frequency.exponentialRampToValueAtTime(500, t + d);
  const g = actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime((0.04 + s * 0.16) * vol, t + d * 0.45); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  a.connect(bp).connect(g).connect(out); a.start(t, Math.random() * 2); a.stop(t + d + 0.05);
  const b = actx.createBufferSource(); b.buffer = noiseBuf; b.playbackRate.value = 1.4;
  const hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.setValueAtTime(2500 + s * 2500, t);
  const g2 = actx.createGain(); g2.gain.setValueAtTime(0.0001, t); g2.gain.exponentialRampToValueAtTime((0.004 + s * 0.03) * vol, t + d * 0.5); g2.gain.exponentialRampToValueAtTime(0.0001, t + d * 0.9);
  b.connect(hp).connect(g2).connect(out); b.start(t, Math.random() * 2); b.stop(t + d + 0.05);
}
// smash: estalo seco + "tum" grave por baixo do som da raquete
function smashCrack(pan, s) {
  if (!actx) return;
  const t = actx.currentTime, out = outTo(sfxBus, pan);
  const n = actx.createBufferSource(); n.buffer = noiseBuf;
  const hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
  const g = actx.createGain(); g.gain.setValueAtTime(0.09 * s, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
  n.connect(hp).connect(g).connect(out); n.start(t, Math.random() * 2); n.stop(t + 0.06);
  const o = actx.createOscillator(), og = actx.createGain();
  o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.09);
  og.gain.setValueAtTime(0.12 * s, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  o.connect(og).connect(out); o.start(t); o.stop(t + 0.14);
}
// tênis no chão do ginásio quando o jogador freia ou muda de lado rápido
function squeak(pan, s) {
  if (!actx || !cfg.asmr) return;
  const t = actx.currentTime, d = 0.07 + Math.random() * 0.06, f0 = 1700 + Math.random() * 700, out = outTo(sfxBus, pan);
  const o = actx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f0 * (1.15 + Math.random() * 0.2), t + d * 0.5); o.frequency.linearRampToValueAtTime(f0 * 0.95, t + d);
  const vib = actx.createOscillator(), vg = actx.createGain(); vib.frequency.value = 55 + Math.random() * 30; vg.gain.value = 60; vib.connect(vg).connect(o.frequency);
  const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f0; bp.Q.value = 3;
  const g = actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.012 + s * 0.012, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(bp).connect(g).connect(out); o.start(t); o.stop(t + d + 0.02); vib.start(t); vib.stop(t + d + 0.02);
}
// ar passando pela bola rápida/com muito efeito (bem baixinho, aparece de fone)
const asmr = { air: null, swingT: 0, lastSp: 0, duck: -1 };
function ensureBallAir() {
  if (asmr.air || !actx) return asmr.air;
  const src = actx.createBufferSource(); src.buffer = noiseBuf; src.loop = true; src.playbackRate.value = 1.1;
  const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2.2; bp.frequency.value = 2500;
  const g = actx.createGain(); g.gain.value = 0;
  const p = actx.createStereoPanner ? actx.createStereoPanner() : null;
  src.connect(bp).connect(g); if (p) g.connect(p).connect(sfxBus); else g.connect(sfxBus);
  src.start();
  return (asmr.air = { bp, g, p });
}
const INDOOR = { neon: 1, ginasio: 1, final: 1 };
function asmrTick(dt) {
  if (!actx) return;
  const t = actx.currentTime, live = !!S.mode && S.mode !== 'spec' && S.phase !== 'lobby' && S.phase !== 'over' && !RP.play && !S.paused;
  // torcida quieta no saque e no rally
  const dk = S.phase === 'serve' || S.phase === 'rally' ? 0.45 : 1;
  if (VOL.crowdDuck && dk !== asmr.duck) { asmr.duck = dk; VOL.crowdDuck.gain.setTargetAtTime(dk, t, dk < 1 ? 0.6 : 0.15); }
  // vento quando eu balanço a raquete rápido (mesmo sem acertar a bola)
  if (live && cfg.asmr) {
    const sv = swipeVel(), sp = Math.hypot(sv.x, sv.up);
    asmr.swingT -= dt;
    if (sp > 1.3 && asmr.lastSp <= 1.3 && asmr.swingT <= 0) {     // gesto rápido (mesma escala da força do golpe)
      asmr.swingT = 0.22;
      swingAir(clamp(me.x * 0.5, -0.6, 0.6), clamp((sp - 1.3) / 3.5, 0.05, 1), 0.8);
    }
    asmr.lastSp = sp;
    // tênis no chão (só nos cenários fechados)
    if (INDOOR[A.id]) for (const [m, sd] of [[myPaddleMesh, S.mySide], [oppPaddleMesh, -S.mySide]]) {
      const u = m.userData; u.sqT = (u.sqT || 0) - dt;
      const v = u.vx || 0, pv = u.pvx || 0;
      if (u.sqT <= 0 && Math.abs(pv) > 1.5 && (Math.sign(v) !== Math.sign(pv) || Math.abs(v) < Math.abs(pv) * 0.35) && Math.random() < 0.45) {
        u.sqT = 1.1; squeak(panFor([m.position.x, 0, m.position.z]), clamp(Math.abs(pv) / 4, 0, 1) * (sd === S.mySide ? 1 : 0.6));
      }
      u.pvx = v;
    }
  }
  // ar da bola
  const air = cfg.asmr ? ensureBallAir() : asmr.air;
  if (air) {
    let target = 0;
    if (live && S.phase === 'rally' && S.ballVisible && cfg.asmr) {
      const v = S.ball.v, w = S.ball.w, sp = Math.hypot(v[0], v[1], v[2]), spin = Math.hypot(w[0], w[1], w[2]);
      const dx = S.ball.p[0] - camera.position.x, dy = S.ball.p[1] - camera.position.y, dz = S.ball.p[2] - camera.position.z;
      target = (clamp((sp - 5) / 9, 0, 1) * 0.07 + clamp(spin / 160, 0, 1) * 0.03) / (1 + 0.6 * Math.hypot(dx, dy, dz));
      air.bp.frequency.setTargetAtTime(1600 + sp * 140 + spin * 4, t, 0.05);
      if (air.p) air.p.pan.setTargetAtTime(panFor(S.ball.p), t, 0.05);
    }
    air.g.gain.setTargetAtTime(target, t, 0.06);
  }
}
function whoosh(pos, strength) {
  if (!actx) return;
  const t = actx.currentTime;
  const src = actx.createBufferSource(); src.buffer = noiseBuf; src.playbackRate.value = 1.3;
  const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(2200, t + 0.12);
  const g = actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12 * strength, t + 0.06); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  src.connect(bp).connect(g).connect(sfxBus); src.start(t, Math.random() * 2); src.stop(t + 0.2);
}
function tone(freq, dur, vol, type = 'triangle', delay = 0) {
  if (!actx) return;
  const t0 = actx.currentTime + delay;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(VOL.ui || master); o.start(t0); o.stop(t0 + dur + 0.02);
}
function sfx(k, label, pos, s = 0.5, snd) {
  if (!actx) return;
  if (k === 'hit') {
    const smash = label === 'SMASH!';
    playImpact(smash ? 'smash' : 'paddle', pos, s, snd);
    const recent = snd === myRacket.sound && asmr.swingT > 0;      // o vento do meu gesto já tocou
    if (cfg.asmr) { if (s > 0.25 && !recent) swingAir(panFor(pos), s, 0.9); } else if (s > 0.55) whoosh(pos, s);
    if (smash || s > 0.85) smashCrack(panFor(pos), s);
  }
  else if (k === 'table') playImpact('table', pos, s);
  else if (k === 'net') playImpact('net', pos, Math.max(0.25, s));
  else if (k === 'floor') playImpact('floor', pos, s * 0.6);
  else if (k === 'win') { tone(660, 0.12, 0.04); tone(990, 0.2, 0.04, 'triangle', 0.1); }
  else if (k === 'lose') { tone(440, 0.14, 0.03); tone(330, 0.2, 0.03, 'triangle', 0.12); }
}
function setMuted(v) {
  muted = v; store.set('pp_mute', v ? '1' : '0');
  applyVolumes();
  $('btnSound').textContent = v ? '🔇' : '🔊';
}
function applyVolumes() {
  if (!actx) return;
  const t = actx.currentTime, set = (n, v) => n && n.gain.setTargetAtTime(v, t, 0.05);
  set(master, muted ? 0 : volGain(cfg.vMaster));
  for (const g of VOL.fx) set(g, volGain(cfg.vFx));
  set(VOL.crowd, volGain(cfg.vCrowd)); set(VOL.music, volGain(cfg.vMusic) * 0.55); set(VOL.ui, volGain(cfg.vUi));
  music.duck();
}
const ASSET_SHA = '2cd58a011ade886d5584df1ff3adabc0d416923c';
const ASSET_BASES = [`https://cdn.jsdelivr.net/gh/amxgroup07/pingpong-online@${ASSET_SHA}/assets/`, `https://raw.githubusercontent.com/amxgroup07/pingpong-online/${ASSET_SHA}/assets/`];
/* ---------- música do menu: a faixa do jogo, baixinha, só no menu (e no resultado) ---------- */
const menuMusic = { el: null, g: null, want: 0, tried: 0 };
function ensureMenuMusic() {
  if (!actx || menuMusic.el || !VOL.musicDuck) return;
  const a = new Audio(); a.crossOrigin = 'anonymous'; a.loop = true; a.preload = 'auto';
  a.src = ASSET_BASES[0] + 'menu-music.mp3';
  a.onerror = () => { if (menuMusic.tried++ < 1) { a.src = ASSET_BASES[1] + 'menu-music.mp3'; a.load(); updateMenuMusic(); } };
  try {
    const src = actx.createMediaElementSource(a), g = actx.createGain(); g.gain.value = 0;
    src.connect(g).connect(VOL.musicDuck);
    Object.assign(menuMusic, { el: a, g });
  } catch (e) { console.warn('música', e); }
}
function updateMenuMusic() {
  ensureMenuMusic(); const m = menuMusic; if (!m.el) return;
  const gated = (!acct.user && !(acct.failed && GATE.offline) && S.mode !== 'spec') || VIC.playing;   // na tela de login fica em silêncio
  const want = muted || cfg.vMusic <= 0 || gated ? 0 : S.phase === 'lobby' ? 0.8 : S.phase === 'over' ? 0.5 : cfg.musicInGame ? 0.3 : 0;
  m.want = want;
  m.g.gain.setTargetAtTime(want, actx.currentTime, want > 0 ? 0.8 : 0.5);   // entra e sai devagar
  if (want > 0 && m.el.paused) m.el.play().catch(() => { });
  if (want === 0) setTimeout(() => { if (m.want === 0 && !m.el.paused) m.el.pause(); }, 2500);
}
const music = {
  start() { this.duck(); },
  duck() { if (!actx || !VOL.musicDuck) return; VOL.musicDuck.gain.setTargetAtTime(1, actx.currentTime, 0.1); updateMenuMusic(); },
};
document.addEventListener('pointerdown', () => ensureAudio(), { capture: true });

/* =====================================================================
   EFEITOS
   ===================================================================== */
const cam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50, ox: 0, shake: 0, fovKick: 0, introT: 0, introDur: 1.8, from: new THREE.Vector3(), fromLook: new THREE.Vector3(0, TH, 0) };
let ledFlash = 0, hitFlash = 0;

function fxHit(side, B, label) {
  const c = TRAIL_COLORS[label] || 0x22ff88;
  const smash = label === 'SMASH!';
  sparks.emit(smash ? 42 : 18, B[0], B[1], B[2], c, smash ? 3.2 : 1.6, { life: smash ? 0.5 : 0.35, intensity: 2.5, grav: 2, drag: 3 });
  hitLight.position.set(B[0] * 0.8, B[1] + 0.35, B[2] * 0.72); hitLight.color.setHex(c); hitFlash = smash ? 1 : 0.5;   // clarão um pouco à frente: ilumina a mesa, não estoura a raquete
  const near = side === S.mySide;
  if (smash) { cam.shake = near ? 0.6 : 1; cam.fovKick = near ? -2 : 3; crowd.excite = Math.min(1, crowd.excite + 0.35); crowdReact('wow'); }
  else if (near) cam.shake = Math.max(cam.shake, 0.15);
  const pm = side === S.mySide ? myPaddleMesh : oppPaddleMesh; pm.userData.swing = 1;
  crowd.base = clamp(0.08 + S.streak * 0.04, 0.08, 0.6);
  if (S.streak >= 5) setTension((S.streak - 4) / 10);
  stopRhythm();
  updateStreak();
}
function fxBounce(x, z) {
  spawnRing(x, TH + 0.003, z, trailColor);
  sparks.emit(5, x, TH + 0.01, z, trailColor, 0.6, { life: 0.25, intensity: 1.6, grav: 1, upOnly: true });
}
function fxPoint(mine, rally, reason, winnerShot, winner) {
  let amount = clamp(0.45 + rally * 0.05, 0.45, 1);
  if (winnerShot === 'SMASH!') amount = Math.max(amount, 0.9);
  crowd.excite = Math.min(1, 0.55 + amount * 0.45); crowd.base = 0.08;
  if (reason === 'net' || reason === 'out') crowdReact('ohh'); else crowdReact('point', amount);
  // metade da torcida comemora, a outra lamenta; rally longo vira ola
  crowdEvent(winner, amount, rally >= 10);
  if (rally >= 10) setTimeout(() => crowdVoice('yeah', 0.55), 700);
  if (amount > 0.8 || rally >= 8) pyroBurst(amount);
  ledFlash = 1;
  const p = S.ball.p;
  sparks.emit(30, p[0], Math.max(p[1], TH), p[2], mine ? 0x9a5cff : 0xff3355, 2.2, { life: 0.7, intensity: 2, grav: 2 });
  updateStreak();
}
function fxWin(mine) {
  confetti.emit(260, 0, 4.2, 0, 0xffffff, 1.6, { rainbow: true, life: 4.5, grav: 0.9, drag: 1.4, spread: 6 });
  crowd.excite = 1; crowdReact('win');
  crowdEvent(mine ? S.mySide : -S.mySide, 1, true);
  pyroBurst(1.4); setTimeout(() => pyroBurst(1), 900);
  fireworks(9);
}

/* =====================================================================
   UI
   ===================================================================== */
let labelTimer = 0, toastTimer = 0, overTimer = 0;
function showLabel(txt) {
  const el = $('label'); el.textContent = txt; el.classList.add('show');
  el.style.setProperty('--c', '#' + new THREE.Color(TRAIL_COLORS[txt] || 0x22ff88).getHexString());
  clearTimeout(labelTimer); labelTimer = setTimeout(() => el.classList.remove('show'), 900);
}
function showMsg(big, small) {
  const el = $('msg'); el.innerHTML = `${big}${small ? `<small>${small}</small>` : ''}`;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}
function toast(t) {
  const el = $('toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function bumpScore(id) { const el = $(id); el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
function lobbyMsg(t) { $('lobbyMsg').textContent = t; }
function showPanel(id) { for (const p of ['menu', 'wait', 'joining', 'rankedPanel']) { const el = $(p); if (el) el.classList.toggle('hidden', p !== id); } }
function updateStreak() {
  const n = S.streak;
  $('streakN').textContent = n;
  $('streak').classList.toggle('show', n >= 3 && S.phase === 'rally');
  $('streak').querySelector('.fire').style.transform = `scale(${1 + Math.min(n, 20) * 0.03})`;
}

function drawJumbo() {
  const g = jumboCanvas.getContext('2d'), w = jumboCanvas.width, h = jumboCanvas.height;
  const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#120612'); gr.addColorStop(1, '#05030a');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.fillStyle = '#ff2a6a'; g.fillRect(0, 0, w, 54);
  g.fillStyle = '#fff'; g.font = 'italic 900 34px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('PING PONG ONLINE', w / 2, 28);
  const mine = S.score[String(S.mySide)], theirs = S.score[String(-S.mySide)];
  const oppName = oppLabel().toUpperCase();
  g.font = '800 40px system-ui'; g.fillStyle = '#c9a8ff'; g.fillText('VOCÊ', w * 0.25, 120);
  g.fillStyle = '#ff8a9c'; g.fillText(oppName, w * 0.75, 120);
  g.font = '700 24px system-ui'; g.fillStyle = 'rgba(255,255,255,.6)';
  g.fillText(myRacket.name.toUpperCase(), w * 0.25, 318); g.fillText(oppRacket.name.toUpperCase(), w * 0.75, 318);
  g.font = '900 170px system-ui'; g.fillStyle = '#fff';
  g.fillText(String(mine), w * 0.25, 245); g.fillText(String(theirs), w * 0.75, 245);
  g.font = '900 90px system-ui'; g.fillStyle = 'rgba(255,255,255,.4)'; g.fillText('×', w / 2, 240);
  const inGame = S.phase !== 'lobby' && S.phase !== 'over';
  if (inGame) {
    const srv = S.phase === 'serve' ? S.server : computeServer();
    g.fillStyle = '#ffd34d'; g.beginPath(); g.arc(srv === S.mySide ? w * 0.25 - 110 : w * 0.75 + 110, 120, 12, 0, 6.3); g.fill();
  }
  const mp = S.phase === 'gamebreak' ? 0 : matchPointFor();
  g.font = '800 34px system-ui';
  if (mp && inGame) { g.fillStyle = '#ff2a55'; g.fillText(isMatchPoint(mp) ? 'MATCH POINT' : 'GAME POINT', w / 2, 355); }
  else { g.fillStyle = 'rgba(255,255,255,.5)'; g.fillText(S.format > 1 ? `GAME ${S.gameNo} · ${FORMATS[S.format].long.toUpperCase()}` : `ATÉ ${POINT_TO_WIN} PONTOS`, w / 2, 355); }
  if (S.format > 1) { g.font = '800 30px system-ui'; g.fillStyle = '#ffd34d'; g.fillText(`GAMES  ${S.games[String(S.mySide)]} × ${S.games[String(-S.mySide)]}`, w / 2, 100); }
  for (let y = 0; y < h; y += 3) { g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, y, w, 1); }
  jumboTex.needsUpdate = true;
}

function updateHud() {
  const mine = S.score[String(S.mySide)], theirs = S.score[String(-S.mySide)];
  $('scoreL').textContent = mine; $('scoreR').textContent = theirs;
  const inGame = S.phase !== 'lobby' && S.phase !== 'over';
  const nextSrv = S.phase === 'serve' ? S.server : computeServer();
  $('srvL').classList.toggle('on', inGame && nextSrv === S.mySide);
  $('srvR').classList.toggle('on', inGame && nextSrv !== S.mySide);
  const mp = inGame && S.phase !== 'gamebreak' ? matchPointFor() : 0;
  $('tag').classList.toggle('show', mp !== 0);
  if (mp) $('tag').textContent = isMatchPoint(mp) ? 'MATCH POINT' : 'GAME POINT';
  const pips = sd => Array.from({ length: gamesNeeded() }, (_, i) => `<i class="${i < S.games[String(sd)] ? 'on' : ''}"></i>`).join('');
  if ($('gmsL')) {
    $('gmsL').innerHTML = S.format > 1 ? pips(S.mySide) : ''; $('gmsR').innerHTML = S.format > 1 ? pips(-S.mySide) : '';
    $('fmtTag').textContent = S.format > 1 ? `GAME ${S.gameNo} · ${FORMATS[S.format].short}` : '';
  }
  updateStreak();
  drawJumbo();
}

function showOver() {
  const mine = S.score[String(S.mySide)], theirs = S.score[String(-S.mySide)];
  const gm = S.games[String(S.mySide)], go = S.games[String(-S.mySide)];
  const won = gm > go;
  specOut({ t: 'sover', w: won ? S.mySide : -S.mySide, games: S.games, gameScores: S.gameScores });
  music.duck();
  $('overTitle').textContent = won ? 'Você venceu! 🏆' : (S.mode === 'solo' ? 'O computador venceu' : `${S.oppName || 'Seu amigo'} venceu`);
  $('overScore').textContent = S.format > 1
    ? `${FORMATS[S.format].short}: ${gm} × ${go} em games (${S.gameScores.map(g => `${g[String(S.mySide)]}-${g[String(-S.mySide)]}`).join(', ')})`
    : `${mine} × ${theirs}`;
  if (won) {                                      // vitórias liberam a raquete lendária
    const before = winCount(); store.set('pp_wins', String(before + 1));
    for (const r of RACKETS) { const u = rcfg(r).unlock_wins; if (u && before < u && before + 1 >= u && !rcfg(r).free) setTimeout(() => toast(`🐉 Você liberou a raquete ${r.name}!`), 2200); }
  }
  const lock = RACKETS.find(r => isListed(r) && !isUnlocked(r) && rcfg(r).unlock_wins);
  $('overScore').textContent += lock ? ` · vitórias: ${totalWins()}/${rcfg(lock).unlock_wins} para liberar a ${lock.name}` : '';
  overRanked(mine, theirs);
  overXp(won);
  endSequence(won);                                 // comemoração, fogos e melhores momentos; depois o resumo
  updateHud();
}

/* =====================================================================
   CHAT RÁPIDO (estilo Rocket League): 1º número = categoria, 2º = frase
   ===================================================================== */
const QC = [
  { n: 'Elogios', m: ['Essa foi boa!', 'Que defesa!', 'Belo saque!', 'Que smash! 🔥'] },
  { n: 'Reações', m: ['Uau!', 'Por pouco!', 'Nããão! 😱', 'Calculado. 😎'] },
  { n: 'Provocações', m: ['Tá fácil hein 😏', 'Cadê o efeito?', 'Vai chorar? 😭', 'Essa nem doeu'] },
  { n: 'Geral', m: ['Boa sorte!', 'Bom jogo! 🤝', 'Revanche?', 'Foi mal!'] },
];
const qc = { mode: 'closed', cat: 0, timer: 0, sent: [], mutedUntil: 0 };
function qcRender() {
  const el = $('qc');
  clearTimeout(qc.timer);
  if (qc.mode === 'closed') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const items = qc.mode === 'cats' ? QC.map(c => c.n) : QC[qc.cat].m;
  $('qcTitle').textContent = qc.mode === 'cats' ? 'CHAT RÁPIDO' : QC[qc.cat].n.toUpperCase();
  const list = $('qcList'); list.textContent = '';
  items.forEach((t, i) => {
    const b = document.createElement('button'); b.dataset.i = i;
    const k = document.createElement('kbd'); k.textContent = i + 1;
    b.append(k, document.createTextNode(t)); list.appendChild(b);
  });
  qc.timer = setTimeout(() => { qc.mode = 'closed'; qcRender(); }, 4500);
}
function qcPick(i) {
  if (qc.mode === 'msgs') { sendChat(qc.cat, i); qc.mode = 'closed'; }
  else { qc.mode = 'msgs'; qc.cat = i; }
  qcRender();
}
function addChat(who, text) {
  const feed = $('chatFeed'), d = document.createElement('div');
  d.className = 'cmsg ' + who;
  const name = who === 'me' ? 'VOCÊ' : who === 'op' ? oppLabel().toUpperCase() : '';
  if (name) { const w = document.createElement('span'); w.className = 'who'; w.textContent = name; d.appendChild(w); }
  d.appendChild(document.createTextNode(text));
  feed.appendChild(d);
  while (feed.children.length > 5) feed.firstChild.remove();
  setTimeout(() => d.classList.add('fade'), 5000); setTimeout(() => d.remove(), 5700);
  sfxChat(who);
}
function sendChat(c, i) {
  const now = performance.now();
  if (now < qc.mutedUntil) { addChat('sys', `Chat desativado por ${Math.ceil((qc.mutedUntil - now) / 1000)} s`); return; }
  qc.sent = qc.sent.filter(t => now - t < 4000); qc.sent.push(now);
  if (qc.sent.length > 4) { qc.mutedUntil = now + 3000; addChat('sys', 'Chat desativado por 3 s'); return; }
  addChat('me', QC[c].m[i]);
  if (S.mode === 'online') send({ t: 'chat', c, i });
  else botChatReply(c, i);
}
function recvChat(m) {
  const c = m.c | 0, i = m.i | 0;
  if (!QC[c] || !QC[c].m[i]) return;
  addChat('op', QC[c].m[i]);
}
// a CPU também "fala" no modo treino
const pick = a => a[(Math.random() * a.length) | 0];
function botSay(c, i, delay = 700 + Math.random() * 800) {
  setTimeout(() => { if (S.mode === 'solo' && S.phase !== 'lobby') addChat('op', QC[c].m[i]); }, delay);
}
function botChatReply(c, i) {
  if (c === 2) { if (Math.random() < 0.65) { const r = pick([[2, 0], [2, 2], [2, 3], [1, 3]]); botSay(r[0], r[1]); } }
  else if (c === 0) { if (Math.random() < 0.5) botSay(1, 3); }
  else if (c === 3) { if (i === 0) botSay(3, 0); else if (i === 1) botSay(3, 1); else if (i === 2) botSay(3, 2); else if (Math.random() < 0.5) botSay(1, 1); }
  else if (c === 1 && i === 3 && Math.random() < 0.5) botSay(2, 1);
}
function botOnPoint(mine, reason, rally, winnerShot) {
  if (isMatchOver()) { botSay(3, 1, 1600); if (mine) botSay(3, 2, 3200); return; }
  if (!mine) {                                   // CPU fez o ponto
    if (Math.random() < 0.3) { const r = pick([[1, 3], [2, 0], [2, 3], [1, 0]]); botSay(r[0], r[1]); }
  } else if (winnerShot === 'SMASH!' && Math.random() < 0.5) botSay(0, 3);
  else if (rally >= 8 && Math.random() < 0.5) botSay(pick([0, 1]), pick([0, 1]));
  else if ((reason === 'net' || reason === 'out') && Math.random() < 0.25) botSay(pick([1, 3]), pick([2, 3]));
}
$('qcList').addEventListener('click', e => { const b = e.target.closest('button'); if (b) qcPick(+b.dataset.i); });
$('btnChat').onclick = () => { qc.mode = qc.mode === 'closed' ? 'cats' : 'closed'; qcRender(); };
window.addEventListener('keydown', e => {
  if (S.phase === 'lobby' || e.repeat || S.mode === 'spec') return;
  if (e.target && e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') { qc.mode = 'closed'; qcRender(); return; }
  const n = ['1', '2', '3', '4'].indexOf(e.key);
  if (n >= 0) { e.preventDefault(); qcPick(n); }
});

/* =====================================================================
   CÂMERA
   ===================================================================== */
function camBase() {
  const sd = S.mySide;
  const aspect = window.innerWidth / window.innerHeight;
  const portrait = aspect < 0.9;
  cam.fov = portrait ? 66 : 50;
  const back = portrait ? 2.6 : 1.8, up = portrait ? 1.45 : 1.12;
  cam.pos.set(0, TH + up, sd * (HL + back));
  cam.look.set(0, TH - (portrait ? 0.4 : 0.32), -sd * 0.35);
}
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
function updateCamera(dt, now) {
  camBase();
  const tox = (S.ballVisible ? S.ball.p[0] * 0.1 : 0) + me.x * 0.05;
  cam.ox = lerp(cam.ox, tox, Math.min(1, dt * 2.2));
  const px = cam.pos.x + cam.ox, py = cam.pos.y + Math.sin(now * 0.0009) * 0.006, pz = cam.pos.z;
  const lx = cam.look.x + cam.ox * 0.6, ly = cam.look.y, lz = cam.look.z;
  if (cam.introT > 0) {
    cam.introT = Math.max(0, cam.introT - dt);
    const k = ease(1 - cam.introT / cam.introDur);
    camera.position.set(lerp(cam.from.x, px, k), lerp(cam.from.y, py, k), lerp(cam.from.z, pz, k));
    camera.lookAt(lerp(cam.fromLook.x, lx, k), lerp(cam.fromLook.y, ly, k), lerp(cam.fromLook.z, lz, k));
  } else {
    camera.position.set(px, py, pz);
    camera.lookAt(lx, ly, lz);
  }
  if (cam.shake > 0 && !cfg.shake) cam.shake = 0;
  if (cam.shake > 0) {
    const s = cam.shake * cam.shake * 0.02;
    camera.position.x += (Math.random() - 0.5) * s; camera.position.y += (Math.random() - 0.5) * s;
    cam.shake = Math.max(0, cam.shake - dt * 3);
  }
  cam.fovKick = lerp(cam.fovKick, 0, Math.min(1, dt * 4));
  camera.fov = cam.fov + cam.fovKick;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}

/* =====================================================================
   QUALIDADE GRÁFICA
   ===================================================================== */
function applyQuality(level, silent) {
  Q.level = level; store.set('pp_q', level);
  const alto = level === 'alto';
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, alto ? 2 : 1.25));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  const ms = alto ? 2048 : 1024;
  if (mainSpot.shadow.mapSize.x !== ms) { mainSpot.shadow.mapSize.set(ms, ms); if (mainSpot.shadow.map) { mainSpot.shadow.map.dispose(); mainSpot.shadow.map = null; } }
  if (A.crowdView) A.crowdView.setQuality(alto);
  dust.visible = alto && !!(A.def && A.def.dust);
  for (const b of A.beamsOpt) b.visible = alto;
  buildComposer();
  $('btnQuality').textContent = alto ? 'HD' : 'LEVE';
  if (!silent) toast(alto ? 'Gráficos: Alto (HD)' : 'Gráficos: Leve (mais rápido)');
}
const perf = { frames: 0, t: 0, low: 0, checked: false };
function perfMonitor(rawDt) {
  if (Q.level !== 'alto' || perf.checked || S.phase === 'lobby') return;
  perf.frames++; perf.t += rawDt;
  if (perf.t >= 2) {
    const fps = perf.frames / perf.t; perf.frames = 0; perf.t = 0;
    if (fps < 34) { if (++perf.low >= 2) { perf.checked = true; applyQuality('leve', true); toast('Gráficos ajustados para o modo leve (mais fluido)'); } }
    else perf.low = 0;
  }
}

/* =====================================================================
   FLUXO DE TELAS
   ===================================================================== */
function startGame(mode, side, format = 1) {
  S.mode = mode; S.mySide = side; S.format = [1, 3, 5].includes(format) ? format : 1;
  setTimeout(() => window.__gateSync && window.__gateSync(), 0);
  me.z = side * (HL + 0.4); me.prevDepth = HL + 0.4;
  opp.x = opp.tx = 0; opp.z = opp.tz = -side * (HL + 0.4);
  bot.x = 0; bot.z = -side * (HL + 0.35);
  $('nameL').textContent = 'VOCÊ';
  refreshNames();
  $('ping').textContent = mode === 'solo' ? '' : 'conectado';
  $('lobby').classList.add('hidden');
  $('hud').classList.remove('hidden');
  cam.from.copy(camera.position); cam.fromLook.set(0, TH, 0); cam.introT = cam.introDur;
  resetMatch(1);
  crowd.mySide = side; if (A.crowdView) A.crowdView.setTeams(side);
  crowd.excite = 0.7; crowdReact('start'); music.duck();
  lock.skip = false; lock.failed = false; lock.toasted = false;
  S.tutorial = null; document.body.classList.remove('tutorial'); renderTutorial(); landMark.visible = false;
  matchStats.perfect = 0; matchStats.xpMissions = 0;
  if (mode === 'solo') {
    botStyle = pick(Object.keys(BOT_STYLES));
    setTimeout(() => { if (S.mode === 'solo' && !S.tutorial) addChat('sys', `🤖 CPU ${botLv().name} · estilo ${BOT_STYLES[botStyle].name}`); }, 1300);
  }
  setTimeout(updateLockUI, 50);
  if (mode === 'online') setTimeout(specInitAll, 200);
  document.body.classList.toggle('online', mode === 'online');
  if (mode === 'solo') {                        // a CPU escolhe uma raquete diferente a cada partida
    const pool = RACKETS.filter(r => r.id !== myRacket.id);
    setPaddle('op', pool[(Math.random() * pool.length) | 0], 'CPU', '');
    botSay(3, 0, 2600);
  }
  updateHud();
  setTimeout(() => { if (S.mode) addChat('sys', `${A.def.emoji} ${A.def.name} · ${FORMATS[S.format].long} · você: ${myRacket.name} × ${oppLabel()}: ${oppRacket.name}`); }, 900);
  if (mode === 'online' && location.search.includes('sala=')) history.replaceState(null, '', location.pathname);
  if (INV.f) { INV.f = null; clearInterval(INV.poll); clearTimeout(INV.timer); $('wait').classList.remove('inv'); }
  if (mode === 'online' || VS.pending) showVs(); else VS.pending = false;
}
function goMenu() {
  const wasOnline = S.mode === 'online';
  const wasSpec = S.mode === 'spec';
  S.mode = null; S.phase = 'lobby'; S.ballVisible = false; S.ranked = null; S.oppName = null; oppAvatar = ''; oppFounder = false; if (VS.on) hideVs(); stopVictoryMusic();
  if (wasSpec) { document.body.classList.remove('spectating'); setPaddle('me', myRacket); setPaddle('op', RACKETS[0], '', ''); }
  document.body.classList.remove('online'); renderSpecUI(); showSpecCount(0);
  stopEnd(); endReplay(false); RP.pending = false; RP.rec = null; S.paused = false; music.duck();
  S.tutorial = null; document.body.classList.remove('tutorial'); renderTutorial(); landMark.visible = false; renderProgress();
  if ($('btnTut') && store.get('pp_tut', '0') === '1') { $('btnTut').classList.remove('new'); $('btnTut').textContent = '🎓 Tutorial (1 min)'; }
  releaseMouse(); updateLockUI();
  if (typeof stopQueue === 'function') stopQueue(false);
  stopRhythm(); qc.mode = 'closed'; qcRender(); $('chatFeed').innerHTML = '';
  if (wasOnline || wasSpec) cleanupNet();
  $('hud').classList.add('hidden'); $('over').classList.add('hidden');
  $('lobby').classList.remove('hidden'); showPanel('menu'); lobbyMsg(''); window.__gateSync && window.__gateSync();
  if (typeof renderPick === 'function') renderPick();
  updateHud();
}

$('btnCreate').onclick = () => { ensureAudio(); lockedNotice(); createRoom(); };
$('btnJoin').onclick = () => { ensureAudio(); lockedNotice(); joinRoom($('inCode').value); };
$('inCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('inCode').value); });
$('btnSolo').onclick = () => { ensureAudio(); lockedNotice(); cleanupNet(); startGame('solo', 1, pickState.fmt); enterPlayMode(); };
$('btnCancel').onclick = $('btnCancel2').onclick = () => { if (INV.f) { cancelInvite(); return; } cleanupNet(); showPanel('menu'); lobbyMsg(''); };
$('btnCopy').onclick = async () => {
  const v = $('linkTxt').value;
  try { await navigator.clipboard.writeText(v); } catch (e) { $('linkTxt').select(); document.execCommand('copy'); }
  $('btnCopy').textContent = 'Link copiado!'; setTimeout(() => $('btnCopy').textContent = 'Copiar link', 1500);
};
$('btnRematch').onclick = () => { if (S.ranked) { goMenu(); startRanked(); return; } if (S.mode === 'online') send({ t: 'rematch' }); resetMatch(-S.matchFirst); enterPlayMode(); setTimeout(updateLockUI, 50); };
$('btnMenu').onclick = () => goMenu();
$('quit').onclick = () => goMenu();
$('btnSound').onclick = () => { ensureAudio(); setMuted(!muted); };
$('btnQuality').onclick = () => { perf.checked = true; applyQuality(Q.level === 'alto' ? 'leve' : 'alto'); };
/* =====================================================================
   MENU: escolha da raquete e do cenário
   ===================================================================== */
const pickState = { rk: Math.max(0, RACKETS.indexOf(myRacket)), ar: Math.max(0, ARENAS.findIndex(a => a.id === store.get('pp_arena', 'neon'))), fmt: [1, 3, 5].includes(+store.get('pp_fmt', '1')) ? +store.get('pp_fmt', '1') : 1, diff: store.get('pp_diff', 'medio') };
const thumbs = {};
function makeThumbs(list = RACKETS.map(r => [r, mySkinFor(r)]), out = thumbs) {   // miniaturas 3D das raquetes
  try {
    const tr = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    tr.setPixelRatio(1); tr.setSize(150, 190, false);
    tr.outputColorSpace = THREE.SRGBColorSpace; tr.toneMapping = THREE.ACESFilmicToneMapping; tr.toneMappingExposure = 1.25;
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight(0xffffff, 0x3a3050, 1.5));
    const d1 = new THREE.DirectionalLight(0xffffff, 2.4); d1.position.set(1.5, 2, 3); sc.add(d1);
    const d2 = new THREE.DirectionalLight(0xff7ab0, 1.0); d2.position.set(-2, 0.5, -1); sc.add(d2);
    const c = new THREE.PerspectiveCamera(30, 150 / 190, 0.01, 10); c.position.set(0, -0.06, 0.8); c.lookAt(0, -0.06, 0);
    for (const [r, sk] of list) {
      const { root } = buildRacket(r, true, 1, myTag(), sk);
      root.rotation.set(0.12, -0.5, -0.3); sc.add(root);
      tr.render(sc, c); out[r.id] = tr.domElement.toDataURL('image/png');
      sc.remove(root); disposeRacket(root);
    }
    tr.dispose(); if (tr.forceContextLoss) tr.forceContextLoss();
  } catch (e) { }
}
const bars = n => Array.from({ length: 5 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
function renderPick() {
  const r = RACKETS[pickState.rk], a = ARENAS[pickState.ar];
  const img = $('rkImg'); if (thumbs[r.id]) { img.src = thumbs[r.id]; img.style.visibility = 'visible'; } else img.style.visibility = 'hidden';
  $('rkName').textContent = r.name; $('rkTag').textContent = r.tag;
  $('stV').innerHTML = bars(r.speed); $('stE').innerHTML = bars(r.spin); $('stC').innerHTML = bars(r.ctrl);
  $('rkDesc').textContent = r.desc;
  const locked = !isUnlocked(r), c = rcfg(r);
  $('rkCard').classList.toggle('locked', locked);
  $('rkLock').classList.toggle('hidden', !locked);
  if (locked) $('rkLock').textContent = c.unlock_wins ? `🔒 ${totalWins()}/${c.unlock_wins}` : '🔒 Exclusiva';
  if (locked) $('rkDesc').textContent = `🔒 ${lockText(r)} ` + r.desc;
  else if (grantedTo(r) && !c.free) $('rkDesc').textContent = '🎁 Liberada para você. ' + r.desc;
  $('vipTag').classList.toggle('hidden', !isVip());
  $('rkDots').innerHTML = RACKETS.map((x, i) => isListed(x) ? `<i class="${i === pickState.rk ? 'on' : ''}"></i>` : '').join('');
  $('arEmoji').textContent = a.emoji; $('arName').textContent = a.name; $('arTag').textContent = a.tag;
  $('arDots').innerHTML = ARENAS.map((_, i) => `<i class="${i === pickState.ar ? 'on' : ''}"></i>`).join('');
  document.querySelectorAll('#fmtSeg button').forEach(b => b.classList.toggle('on', +b.dataset.f === pickState.fmt));
  const bl = $('bsList');
  if (bl && !bl.children.length) for (const sk of BALL_SKINS) {
    const b = document.createElement('button'); b.className = 'bs'; b.dataset.b = sk.id; b.title = sk.name; b.setAttribute('aria-label', 'Bolinha ' + sk.name);
    b.style.background = sk.rainbow ? 'conic-gradient(#ff3d5a,#ff9a3c,#ffe14a,#5dff7a,#3a8bff,#9a5cff,#ff3d5a)' : `radial-gradient(circle at 32% 28%, rgba(255,255,255,.75) 0 5%, ${sk.base} 26%, ${sk.base} 100%)`;
    bl.appendChild(b);
  }
  document.querySelectorAll('#bsList .bs').forEach(b => {
    const sk = ballSkinById(b.dataset.b), lk = !!window.__feelReady && skinLocked(sk);
    b.classList.toggle('on', b.dataset.b === ballSkin.id); b.classList.toggle('lock', lk);
    b.title = lk ? `${sk.name} · libera no nível ${SKIN_LV[sk.id]}` : sk.name;
  });
  document.querySelectorAll('#diffSeg button').forEach(b => b.classList.toggle('on', b.dataset.d === pickState.diff));
  if ($('bsName')) $('bsName').textContent = ballSkin.name;
}
function pickMove(k, d) {
  if (k === 'rk') {
    for (let i = 0; i < RACKETS.length; i++) { pickState.rk = (pickState.rk + d + RACKETS.length) % RACKETS.length; if (isListed(RACKETS[pickState.rk])) break; }
    const r = RACKETS[pickState.rk];
    if (isUnlocked(r)) { store.set('pp_racket', r.id); setPaddle('me', r); }
  } else {
    pickState.ar = (pickState.ar + d + ARENAS.length) % ARENAS.length;
    const a = ARENAS[pickState.ar]; store.set('pp_arena', a.id); buildArena(a.id);
  }
  renderPick();
}
function lockedNotice() {
  const r = RACKETS[pickState.rk];
  if (!isUnlocked(r)) setTimeout(() => toast(`${r.name} ainda está bloqueada: jogando com a ${myRacket.name}`), 1200);
}
function initLobbyUI() {
  const st = document.createElement('style');
  st.textContent = `
  .loadout { display: flex; flex-direction: column; gap: 7px; text-align: left; margin-bottom: 6px; }
  .lo-t { font-size: 11px; letter-spacing: .2em; font-weight: 900; opacity: .6; margin-top: 2px; }
  .lo-t .vip { margin-left: 6px; padding: 2px 7px; border-radius: 999px; background: linear-gradient(90deg, #ffd34d, #ff9a3c); color: #1a1000; letter-spacing: .06em; opacity: 1; }
  .picker { display: flex; align-items: center; gap: 6px; }
  .pk-arrow { flex: none; width: 34px; height: 34px; border-radius: 50%; border: 0; background: rgba(255,255,255,.09); color: #fff; font-size: 22px; line-height: 1; font-weight: 900; cursor: pointer; }
  .pk-arrow:hover { background: rgba(255,79,139,.35); }
  .pk-card { flex: 1; display: flex; gap: 10px; align-items: center; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 8px 10px; min-width: 0; position: relative; min-height: 70px; }
  .pk-card img { width: 60px; height: 76px; object-fit: contain; flex: none; filter: drop-shadow(0 6px 10px rgba(0,0,0,.5)); }
  .pk-card.locked img { filter: grayscale(1) brightness(.6); }
  .pk-info { min-width: 0; flex: 1; }
  .pk-name { font-weight: 900; font-size: 16px; }
  .pk-tag { font-size: 11px; font-weight: 800; letter-spacing: .08em; color: #ffd34d; text-transform: uppercase; }
  .stat { display: flex; align-items: center; gap: 6px; font-size: 9.5px; font-weight: 800; letter-spacing: .08em; opacity: .85; margin-top: 3px; }
  .stat span { width: 70px; flex: none; }
  .bars { display: flex; gap: 2px; } .bars i { width: 13px; height: 6px; border-radius: 2px; background: rgba(255,255,255,.14); } .bars i.on { background: linear-gradient(90deg, #ff3d7f, #ffd34d); }
  .pk-desc { font-size: 12px; opacity: .72; line-height: 1.4; min-height: 34px; }
  .pk-note { font-size: 11px; opacity: .5; }
  .pk-lock { position: absolute; top: 6px; right: 8px; border-radius: 999px; background: rgba(0,0,0,.75); font-size: 10.5px; font-weight: 800; padding: 3px 8px; color: #ffd34d; }
  .dots { display: flex; gap: 4px; margin-top: 5px; } .dots i { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,.2); } .dots i.on { background: #ff4f8b; }
  .ar-emoji { font-size: 34px; width: 60px; text-align: center; flex: none; }
  .bskins { display: flex; gap: 7px; flex-wrap: wrap; }
  .bs { width: 30px; height: 30px; border-radius: 50%; border: 2px solid rgba(255,255,255,.18); cursor: pointer; padding: 0; box-shadow: inset 0 -4px 6px rgba(0,0,0,.3); }
  .bs.on { border-color: #ff4f8b; box-shadow: 0 0 0 3px rgba(255,79,139,.35), inset 0 -4px 6px rgba(0,0,0,.3); transform: scale(1.08); }
  .lo-t .bs-name { margin-left: 6px; color: #ffd34d; letter-spacing: .06em; opacity: 1; }
  .seg { display: flex; gap: 6px; }
  .seg button { flex: 1; border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.05); color: #fff; border-radius: 12px; padding: 8px 4px; font-weight: 900; font-size: 15px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 1px; }
  .seg button small { font-size: 10.5px; font-weight: 700; opacity: .6; }
  .seg button.on { background: linear-gradient(180deg, rgba(255,61,127,.45), rgba(255,61,127,.2)); border-color: #ff4f8b; }
  details.howto summary { cursor: pointer; font-weight: 800; color: #ffd34d; }
  details.howto[open] summary { margin-bottom: 6px; }`;
  document.head.appendChild(st);
  const wrap = document.createElement('div'); wrap.className = 'loadout';
  wrap.innerHTML = `
    <div class="lo-t">SUA RAQUETE <span class="vip hidden" id="vipTag">⭐ VIP · TUDO LIBERADO</span></div>
    <div class="picker"><button class="pk-arrow" data-k="rk" data-d="-1" aria-label="Raquete anterior">‹</button>
      <div class="pk-card" id="rkCard"><img id="rkImg" alt="">
        <div class="pk-info"><div class="pk-name" id="rkName"></div><div class="pk-tag" id="rkTag"></div>
          <div class="stat"><span>VELOCIDADE</span><div class="bars" id="stV"></div></div>
          <div class="stat"><span>EFEITO</span><div class="bars" id="stE"></div></div>
          <div class="stat"><span>CONTROLE</span><div class="bars" id="stC"></div></div>
          <div class="dots" id="rkDots"></div></div>
        <div class="pk-lock hidden" id="rkLock"></div></div>
      <button class="pk-arrow" data-k="rk" data-d="1" aria-label="Próxima raquete">›</button></div>
    <div class="pk-desc" id="rkDesc"></div>
    <div class="lo-t">CENÁRIO</div>
    <div class="picker"><button class="pk-arrow" data-k="ar" data-d="-1" aria-label="Cenário anterior">‹</button>
      <div class="pk-card"><div class="ar-emoji" id="arEmoji"></div>
        <div class="pk-info"><div class="pk-name" id="arName"></div><div class="pk-tag" id="arTag"></div><div class="dots" id="arDots"></div></div></div>
      <button class="pk-arrow" data-k="ar" data-d="1" aria-label="Próximo cenário">›</button></div>
    <div class="lo-t">BOLINHA <span class="bs-name" id="bsName"></span></div>
    <div class="bskins" id="bsList"></div>
    <div class="lo-t">PARTIDA</div>
    <div class="seg" id="fmtSeg"><button data-f="1">Duelo<small>1 game de 11</small></button><button data-f="3">MD3<small>melhor de 3</small></button><button data-f="5">MD5<small>melhor de 5</small></button></div>
    <div class="pk-note">No online, vale o cenário e o formato de quem cria a sala. Cada um usa a própria raquete. A ranqueada é sempre 1 game.</div>`;
  $('menu').prepend(wrap);
  wrap.addEventListener('click', e => {
    const b = e.target.closest('.pk-arrow'); if (b) pickMove(b.dataset.k, +b.dataset.d);
    const f = e.target.closest('#fmtSeg button'); if (f) { pickState.fmt = +f.dataset.f; store.set('pp_fmt', String(pickState.fmt)); renderPick(); }
    const bs = e.target.closest('#bsList .bs');
    if (bs) { const sk = ballSkinById(bs.dataset.b); if (skinLocked(sk)) toast(`🔒 A bolinha ${sk.name} libera no nível ${SKIN_LV[sk.id]}`); else { applyBallSkin(sk); renderPick(); } }
  });
  const how = document.querySelector('.howto');
  if (how) {
    const d = document.createElement('details'); d.className = 'howto';
    d.innerHTML = '<summary>Como jogar</summary>' + how.innerHTML.replace('<b>Como jogar:</b>', '') +
      '<br><b>Raquetes:</b> velocidade deixa a bola mais rápida, efeito aumenta topspin e curva, controle deixa a bola mais certeira. A Muralha não tem efeito, mas devolve o efeito do adversário invertido.';
    how.replaceWith(d);
  }
  renderPick();
  setTimeout(() => { makeThumbs(); renderPick(); }, 60);
  Promise.all(RACKETS.map(r => skinReady(mySkinFor(r)))).then(() => { makeThumbs(); renderPick(); if (window.__futReady) renderFut(); });
}
initLobbyUI();
/* =====================================================================
   CONTA, ELO E RANQUEADA (Supabase)
   Login com Steam (função steam-auth) ou Google. O elo só muda no servidor,
   depois que os dois jogadores mandam o mesmo placar.
   ===================================================================== */
const SB_URL = 'https://kvfbpmhovljdpqskuaub.supabase.co';
const SB_KEY = 'sb_publishable_cH3Oc1jYhKW_h6tYVEoNUQ_YvBy4VOp';
const DIVS = [[0, 'Bronze', '🥉', '#d08a52'], [1100, 'Prata', '🥈', '#c8d0dc'], [1300, 'Ouro', '🥇', '#ffd34d'], [1500, 'Platina', '💠', '#7fe3ff'], [1700, 'Diamante', '💎', '#a99bff'], [1900, 'Lenda', '👑', '#ff5aa0']];
function division(rating, games) {
  if (games < 10) return { name: `Colocação ${games}/10`, icon: '🎯', color: '#bbbbbb' };
  let d = DIVS[0]; for (const x of DIVS) if (rating >= x[0]) d = x;
  return { name: d[1], icon: d[2], color: d[3] };
}
function oppLabel() { return S.mode === 'solo' ? 'CPU' : (S.oppName || 'Amigo'); }
function refreshNames() {
  if (S.mode === 'spec') return;
  $('nameL').textContent = acct.profile ? acct.profile.name.toUpperCase().slice(0, 14) : 'VOCÊ';
  $('nameR').textContent = oppLabel().toUpperCase().slice(0, 14);
}
function sbLoad() {
  if (!acct.ready) acct.ready = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
    .then(m => (acct.sb = m.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } })))
    .catch(e => { console.warn('Supabase não carregou', e); return null; });
  return acct.ready;
}
async function rpc(fn, args) {
  const sb = await sbLoad(); if (!sb) throw new Error('sem conexão com o servidor');
  const { data, error } = await sb.rpc(fn, args || {});
  if (error) throw new Error(error.message);
  return data;
}
async function refreshProfile() {
  if (!acct.user) { acct.profile = null; renderAccount(); return; }
  try { acct.profile = await rpc('my_profile'); } catch (e) { console.warn(e); }
  if (acct.profile && typeof prog !== 'undefined') {
    if ((acct.profile.xp | 0) > prog.xp) { prog.xp = acct.profile.xp | 0; saveProg(); }
    else if (prog.xp > (acct.profile.xp | 0)) rpc('sync_xp', { p_xp: prog.xp }).catch(() => { });
    renderProgress();
  }
  renderAccount(); refreshNames(); afterProfile(); if (window.__futReady) { renderTopProfile(); setTimeout(founderWelcome, 800); }
  if (typeof FR !== 'undefined') FR.lastPoll = -1e9;         // presença e convites logo depois do login
}
async function initAccount() {
  initAccountUI();
  // quais logins estão ligados no Supabase (o Google precisa ser configurado no painel)
  fetch(SB_URL + '/auth/v1/settings', { headers: { apikey: SB_KEY } }).then(r => r.json()).then(j => { acct.providers.google = !!(j.external && j.external.google); renderAccount(); }).catch(() => { });
  const sb = await sbLoad(); if (!sb) { acct.failed = true; window.__gateSync && window.__gateSync(); renderAccount('Servidor de contas indisponível agora.'); return; }
  loadRacketCfg();
  // volta do login com Steam: o token de uso único vem depois do #
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('steam_token') || h.get('steam_error')) {
    history.replaceState(null, '', location.pathname + location.search);
    if (h.get('steam_token')) {
      let r = await sb.auth.verifyOtp({ token_hash: h.get('steam_token'), type: 'magiclink' });
      if (r.error) r = await sb.auth.verifyOtp({ token_hash: h.get('steam_token'), type: 'email' });
      if (r.error) lobbyMsg('Não deu para entrar com a Steam. Tente de novo.');
    } else if (h.get('steam_error') !== 'cancelado') lobbyMsg('A Steam não confirmou o login. Tente de novo.');
  }
  const qs = new URLSearchParams(location.search), hs = new URLSearchParams(location.hash.slice(1));
  const hadCode = qs.has('code'), wasReset = qs.get('reset') === '1';
  const linkErr = qs.get('error_description') || hs.get('error_description') || qs.get('error') || hs.get('error');
  if (hadCode || linkErr) setTimeout(() => history.replaceState(null, '', location.pathname + (wasReset && !linkErr ? '?reset=1' : '')), 1500);
  sb.auth.onAuthStateChange((ev, session) => {
    const u = session ? session.user : null;
    if ((u && u.id) !== (acct.user && acct.user.id)) { acct.user = u; refreshProfile(); window.__gateSync && window.__gateSync(); }
  });
  let data = { session: null };
  try { data = (await sb.auth.getSession()).data || data; } catch (e) { console.warn('sessão', e); }
  acct.user = data.session ? data.session.user : null; acct.checked = true;
  if (linkErr) GATE.notice = { bad: true, text: /expired|invalid/i.test(linkErr) ? 'Esse link expirou ou já foi usado. Entre com sua senha ou peça um link novo.' : 'O link do email não funcionou: ' + linkErr.replace(/\+/g, ' ').slice(0, 80) };
  else if (hadCode && !acct.user) GATE.notice = { text: wasReset ? 'Abra o link no mesmo navegador em que pediu a senha nova, ou peça outro link.' : '✔ Email confirmado! Agora entre com seu email e senha.' };
  window.__gateSync && window.__gateSync();
  refreshProfile();
}
function loginSteam() {
  location.href = `${SB_URL}/functions/v1/steam-auth?r=${encodeURIComponent(location.origin + location.pathname)}`;
}
async function loginGoogle() {
  const sb = await sbLoad(); if (!sb) return;
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
  if (error) lobbyMsg('Login com Google indisponível: ' + error.message);
}
async function logout() { const sb = await sbLoad(); if (sb) await sb.auth.signOut(); acct.user = null; acct.profile = null; FR.data = null; FR.incoming = 0; renderFrBadge(); renderAccount(); refreshNames(); afterProfile(); window.__gateSync && window.__gateSync(); }
async function editName() {
  const nm = prompt('Seu nome no jogo (3 a 20 caracteres):', acct.profile ? acct.profile.name : '');
  if (nm === null) return;
  try { await rpc('set_display_name', { p_name: nm }); await refreshProfile(); toast('Nome atualizado'); }
  catch (e) { toast(e.message.includes('3 a 20') ? 'O nome precisa ter de 3 a 20 caracteres' : 'Não deu para mudar o nome'); }
}

/* ---------- fila ranqueada ---------- */
const queue = { on: false, timer: 0, t0: 0, tick: 0 };
async function startRanked() {
  ensureAudio();
  if (!acct.user) { lobbyMsg('Entre com Steam ou Google para jogar ranqueada.'); $('acctCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (queue.on) return;
  if (acct.profile && acct.profile.banned) { lobbyMsg(`Sua conta está suspensa da ranqueada${acct.profile.ban_reason ? ': ' + acct.profile.ban_reason : '.'}`); return; }
  cleanupNet(); lockedNotice();
  queue.on = true; queue.t0 = performance.now();
  showPanel('rankedPanel'); setRankedText('Procurando adversário…', ''); $('rqCpu').classList.add('hidden');
  queueStep();
}
async function queueStep() {
  if (!queue.on) return;
  try {
    const r = await rpc('queue_tick');
    if (!queue.on) return;
    if (r && r.status === 'matched') { queueMatched(r); return; }
    const secs = Math.round((performance.now() - queue.t0) / 1000);
    setRankedText('Procurando adversário…', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · faixa de elo ±${Math.min(600, 100 + secs * 10)}`);
    if (secs >= 45) $('rqCpu').classList.remove('hidden');
  } catch (e) {
    if (/suspensa/.test(e.message)) { stopQueue(false); showPanel('menu'); lobbyMsg('Sua conta está suspensa da ranqueada.'); return; }
    console.warn('fila', e); setRankedText('Sem conexão com o servidor', 'tentando de novo…');
  }
  queue.timer = setTimeout(queueStep, 2000);
}
function stopQueue(leave = true) {
  if (!queue.on) return;
  queue.on = false; clearTimeout(queue.timer);
  if (leave) rpc('queue_leave').catch(() => { });
}
function setRankedText(a, b) { $('rqTitle').textContent = a; $('rqSub').textContent = b; }
function queueMatched(r) {
  queue.on = false; clearTimeout(queue.timer);
  const opp = r.opponent || {};
  const dv = division(opp.rating || 1000, opp.games || 0);
  S.ranked = { matchId: r.match_id, role: r.role, opp, reported: false };
  S.oppName = opp.name || 'Adversário';
  setRankedText(`Adversário: ${S.oppName}`, `${dv.icon} ${dv.name} · ${opp.rating} de elo · conectando…`);
  sfx('win');
  if (r.role === 'host') createRoom(r.room);
  else setTimeout(() => { if (S.ranked && S.phase === 'lobby') joinRoom(r.room); }, 1200);
  setTimeout(() => { if (S.ranked && S.phase === 'lobby' && S.ranked.matchId === r.match_id) rankedFail('O adversário não conectou. Procure de novo.'); }, 25000);
}
function rankedFail(msg) {
  stopQueue(false); cleanupNet(); S.ranked = null; S.oppName = null;
  showPanel('menu'); lobbyMsg(msg);
}
async function rankedReport(rk, mine, theirs, final) {
  try { return await rpc('report_result', { p_match: rk.matchId, p_my: mine, p_opp: theirs, p_final: final }); }
  catch (e) { console.warn('relato', e); return null; }
}
async function overRanked(mine, theirs) {
  const el = $('overElo'); el.textContent = ''; el.classList.add('hidden');
  $('btnRematch').textContent = S.ranked ? 'Jogar outra ranqueada' : 'Revanche';
  const rk = S.ranked; if (!rk || rk.reported) return;
  rk.reported = true;
  el.classList.remove('hidden'); el.textContent = 'Conferindo o placar com o servidor…';
  let r = await rankedReport(rk, mine, theirs, true);
  for (let i = 0; i < 16 && r && r.status === 'playing'; i++) {
    await new Promise(ok => setTimeout(ok, 1500));
    try { r = await rpc('get_match', { p_match: rk.matchId }); } catch (e) { }
  }
  if (!r) { el.textContent = 'Não consegui falar com o servidor. O resultado será conferido depois.'; return; }
  if (r.status === 'done' || r.status === 'abandoned') {
    const after = r.before + r.delta, d = r.delta >= 0 ? `+${r.delta}` : `${r.delta}`;
    await refreshProfile();
    const p = acct.profile, dv = p ? division(p.rating, p.games) : null;
    el.innerHTML = `Elo <b>${r.before}</b> → <b>${after}</b> <span style="color:${r.delta >= 0 ? '#2fd16b' : '#ff5a6a'}">(${d})</span>` + (dv ? `<br>${dv.icon} ${dv.name}` : '');
  } else if (r.status === 'disputed') el.textContent = 'Os placares enviados não bateram: partida anulada, elo não mudou.';
  else if (r.status === 'void') el.textContent = 'Partida anulada, elo não mudou.';
  else el.textContent = 'Esperando o adversário confirmar o placar…';
}

/* ---------- ranking ---------- */
async function openRanking() {
  const scr = $('rankScreen'); scr.classList.remove('hidden');
  const list = $('rankList'); list.innerHTML = '<p class="muted">Carregando…</p>';
  try {
    if (!acct.sb) await sbLoad();
    const { data, error } = await acct.sb.rpc('leaderboard', { p_limit: 50 });
    if (error) throw error;
    if (!data || !data.length) { list.innerHTML = '<p class="muted">Ninguém jogou ranqueada ainda. Seja o primeiro!</p>'; return; }
    list.textContent = '';
    data.forEach((r, i) => {
      const dv = division(r.rating, r.games), row = document.createElement('div');
      row.className = 'rk-row' + (r.me ? ' me' : '');
      const pos = document.createElement('span'); pos.className = 'rk-pos'; pos.textContent = i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}º`;
      const nm = document.createElement('span'); nm.className = 'rk-name'; nm.textContent = r.name;
      if (r.tag) { const tg = document.createElement('small'); tg.className = 'rk-tag'; tg.textContent = ' ' + r.tag; nm.appendChild(tg); }
      if (r.founder) { nm.append(' '); nm.append(founderBadge('xs')); }
      const dvs = document.createElement('span'); dvs.className = 'rk-div'; dvs.textContent = `${dv.icon} ${dv.name}`; dvs.style.color = dv.color;
      const el = document.createElement('span'); el.className = 'rk-elo'; el.textContent = r.rating;
      const wl = document.createElement('span'); wl.className = 'rk-wl'; wl.textContent = `${r.wins}V ${r.losses}D`;
      row.append(pos, avatarNode(r.avatar, r.name, 'rk-av'), nm, dvs, el, wl); list.appendChild(row);
    });
  } catch (e) { list.innerHTML = '<p class="muted">Não consegui carregar o ranking agora.</p>'; }
}

/* ---------- telas ---------- */
function renderAccount(err) {
  const card = $('acctCard'); if (!card) return;
  const p = acct.profile;
  $('acctOut').classList.toggle('hidden', !!acct.user);
  $('acctIn').classList.toggle('hidden', !acct.user);
  $('btnGoogle').classList.toggle('hidden', !acct.providers.google);
  if (err) $('acctHint').textContent = err;
  if (acct.user && p) {
    const dv = division(p.rating, p.games);
    $('acctName').textContent = p.name;
    const av = $('acctAv');
    if (p.avatar) { av.style.backgroundImage = `url("${encodeURI(p.avatar)}")`; av.textContent = ''; } else { av.style.backgroundImage = ''; av.textContent = p.name.slice(0, 1).toUpperCase(); }
    $('acctDiv').textContent = `${dv.icon} ${dv.name}`; $('acctDiv').style.color = dv.color;
    $('acctElo').textContent = `${p.rating} de elo · ${p.games ? `#${p.rank} · ` : ''}${p.wins}V ${p.losses}D`;
    $('acctAdmin').classList.toggle('hidden', !p.admin);
  } else if (acct.user) { $('acctName').textContent = 'Carregando…'; $('acctDiv').textContent = ''; $('acctElo').textContent = ''; }
  $('btnRanked').classList.toggle('dim', !acct.user);
  renderAccountExtras();
}
function initAccountUI() {
  const st = document.createElement('style');
  st.textContent = `
  .acct { text-align: left; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 10px 12px; }
  .acct .lo-t { margin-bottom: 6px; }
  .acct-hint { font-size: 12px; opacity: .75; margin-bottom: 8px; }
  .acct-btns { display: flex; gap: 8px; }
  .acct-btns button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 7px; border: 0; border-radius: 10px; padding: 10px; font-size: 14px; font-weight: 800; cursor: pointer; color: #fff; }
  .b-steam { background: linear-gradient(180deg, #2a475e, #171a21); border: 1px solid rgba(255,255,255,.15) !important; }
  .b-google { background: #fff; color: #222 !important; }
  .acct-row { display: flex; align-items: center; gap: 10px; }
  .acct-av { width: 42px; height: 42px; border-radius: 50%; flex: none; background: #3a2340 center/cover; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 18px; border: 2px solid rgba(255,255,255,.2); }
  .acct-info { flex: 1; min-width: 0; }
  .acct-name { font-weight: 900; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acct-name button { background: none; border: 0; color: #fff; opacity: .6; cursor: pointer; font-size: 13px; }
  .acct-div { font-size: 12px; font-weight: 900; letter-spacing: .04em; }
  .acct-elo { font-size: 11.5px; opacity: .7; }
  .acct-out { background: none; border: 0; color: #fff; opacity: .55; cursor: pointer; font-size: 12px; text-decoration: underline; }
  .acct-admin { font-size: 10px; font-weight: 900; padding: 1px 6px; border-radius: 999px; background: linear-gradient(90deg, #ffd34d, #ff9a3c); color: #1a1000; margin-left: 4px; }
  button.btn.gold { background: linear-gradient(180deg, #ffd34d, #e8a21c); color: #1a1000; box-shadow: 0 6px 20px rgba(255,190,40,.3); }
  button.btn.gold.dim { filter: saturate(.4) brightness(.8); }
  .rank-link { background: none; border: 0; color: #ffd34d; font-weight: 800; cursor: pointer; font-size: 13px; padding: 2px; }
  #rankedPanel .rq-title { font-size: 18px; font-weight: 900; }
  #rankScreen .card { max-width: 520px; }
  .rk-list { margin-top: 14px; max-height: 60vh; overflow-y: auto; text-align: left; }
  .rk-row { display: grid; grid-template-columns: 44px 1fr auto 56px 64px; gap: 8px; align-items: center; padding: 8px 10px; border-radius: 10px; font-size: 14px; }
  .rk-row:nth-child(odd) { background: rgba(255,255,255,.04); }
  .rk-row.me { background: rgba(154,92,255,.25); }
  .rk-pos { font-weight: 900; text-align: center; } .rk-name { font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rk-div { font-size: 12px; font-weight: 800; } .rk-tag { font-size: 10px; font-weight: 900; color: #ffd34d; letter-spacing: .08em; } .rk-elo { font-weight: 900; text-align: right; } .rk-wl { font-size: 12px; opacity: .7; text-align: right; }
  #overElo { margin-top: 10px; font-size: 15px; line-height: 1.5; }`;
  document.head.appendChild(st);
  const card = document.createElement('div'); card.className = 'acct'; card.id = 'acctCard';
  card.innerHTML = `
    <div class="lo-t">CONTA</div>
    <div id="acctOut">
      <div class="acct-hint" id="acctHint">Entre para jogar ranqueada, ganhar elo e aparecer no ranking.</div>
      <div class="acct-btns"><button class="b-steam" id="btnSteam">Entrar com Steam</button><button class="b-google hidden" id="btnGoogle">Entrar com Google</button></div>
    </div>
    <div id="acctIn" class="hidden"><div class="acct-row">
      <div class="acct-av" id="acctAv"></div>
      <div class="acct-info"><div class="acct-name"><span id="acctName"></span><button id="btnName" title="Mudar nome">✎</button><span class="acct-admin hidden" id="acctAdmin">ADMIN · TUDO LIBERADO</span></div>
        <div class="acct-div" id="acctDiv"></div><div class="acct-elo" id="acctElo"></div></div>
      <button class="acct-out" id="btnLogout">Sair</button></div></div>`;
  $('menu').prepend(card);
  const rb = document.createElement('button'); rb.className = 'btn gold'; rb.id = 'btnRanked'; rb.textContent = '⚔️ Jogar ranqueada';
  const rl = document.createElement('button'); rl.className = 'rank-link'; rl.id = 'btnRanking'; rl.textContent = '🏆 Ver ranking';
  $('btnCreate').before(rb, rl);
  const panel = document.createElement('div'); panel.id = 'rankedPanel'; panel.className = 'stack hidden';
  panel.innerHTML = `<p><span class="spinner"></span><span class="rq-title" id="rqTitle">Procurando adversário…</span></p><p class="muted" id="rqSub"></p>
    <button class="btn ghost hidden" id="rqCpu">Ninguém por aqui: treinar contra a CPU</button><button class="btn ghost" id="rqCancel">Cancelar</button>`;
  $('joining').after(panel);
  const scr = document.createElement('div'); scr.id = 'rankScreen'; scr.className = 'screen hidden'; scr.style.zIndex = 40;
  scr.innerHTML = `<div class="card"><h2>🏆 Ranking</h2><p class="muted">Temporada 1 · divisões pelo elo depois de 10 partidas</p><div class="rk-list" id="rankList"></div><div class="stack"><button class="btn ghost" id="rankClose">Fechar</button></div></div>`;
  document.body.appendChild(scr);
  const ov = document.createElement('p'); ov.id = 'overElo'; ov.className = 'hidden'; $('overScore').after(ov);
  $('btnSteam').onclick = loginSteam; $('btnGoogle').onclick = loginGoogle; $('btnLogout').onclick = logout; $('btnName').onclick = editName;
  rb.onclick = startRanked; rl.onclick = openRanking; $('rankClose').onclick = () => scr.classList.add('hidden');
  $('rqCancel').onclick = () => { stopQueue(true); showPanel('menu'); };
  $('rqCpu').onclick = () => { stopQueue(true); showPanel('menu'); cleanupNet(); startGame('solo', 1); };
  renderAccount();
}
initAccount();
/* ---------- regras das raquetes (banco) e perfil ---------- */
async function loadRacketCfg() {
  try {
    const sb = await sbLoad(); if (!sb) return;
    const { data, error } = await sb.from('racket_config').select('id,enabled,free,unlock_wins');
    if (error || !data) return;
    for (const k of Object.keys(RCFG)) delete RCFG[k];
    for (const c of data) RCFG[c.id] = c;
    afterProfile();
  } catch (e) { console.warn('raquetes', e); }
}
let lastTagShown = myTag();
function afterProfile() {
  if (!isUnlocked(myRacket)) {                         // raquete tirada ou desligada: volta para uma liberada
    const r = RACKETS.find(x => isUnlocked(x)) || RACKETS[0];
    store.set('pp_racket', r.id); setPaddle('me', r); pickState.rk = RACKETS.indexOf(r);
  }
  const tg = myTag();
  if (tg !== lastTagShown) { lastTagShown = tg; if (S.mode !== 'spec') setPaddle('me', myRacket, tg); makeThumbs(); }
  if (typeof renderPick === 'function') renderPick();
}

/* ---------- pequeno ajudante para montar telas sem innerHTML com dados de usuário ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el[k] = v; else if (v === true) el.setAttribute(k, ''); else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

/* =====================================================================
   CONFIGURAÇÕES (⚙️): controles, volumes, jogo e perfil
   ===================================================================== */
const pct = v => `${Math.round(v)}%`, times = v => `${(+v).toFixed(2)}×`;
const CFG_UI = [
  ['🎮 Controles', [
    ['range', 'sensMove', 'Sensibilidade do movimento', 0.5, 2, 0.05, times, 'Quanto a raquete anda a cada movimento do mouse ou do dedo'],
    ['range', 'sensSwing', 'Sensibilidade da batida', 0.6, 1.6, 0.05, times, 'Maior = a bola sai mais forte com o mesmo gesto'],
  ]],
  ['🔊 Som', [
    ['vol', 'vMaster', 'Volume geral'], ['vol', 'vFx', 'Bolinha e raquete'], ['vol', 'vCrowd', 'Torcida e ambiente'],
    ['vol', 'vMusic', 'Música'], ['vol', 'vUi', 'Avisos e chat'],
  ]],
  ['🏓 Jogo', [
    ['toggle', 'replays', 'Replays dos pontos bonitos e melhores momentos'],
    ['toggle', 'shake', 'Câmera treme no smash'],
    ['toggle', 'ballGlow', 'Brilho (halo) em volta da bola'],
    ['toggle', 'assist', 'Ajuda: mostrar onde a bola vai quicar do seu lado'],
    ['toggle', 'musicInGame', 'Música durante a partida (desligada = só bola, torcida e ambiente)'],
    ['toggle', 'asmr', 'Sons de detalhe: vento da raquete, ar da bola e tênis no chão'],
    ['toggle', 'showPing', 'Mostrar o ping no online'],
    ['toggle', 'lockMouse', 'Tela cheia com o mouse preso na partida (bom para dois monitores)'],
    ['quality'],
  ]],
];
function applyCfg() {
  saveCfg(); applyVolumes(); if (typeof updateLockUI === 'function') updateLockUI();
  const pg = $('ping'); if (pg) pg.style.display = cfg.showPing ? '' : 'none';
}
function openSettings(focus) {
  ensureAudio();
  const scr = $('cfgScreen'); scr.classList.remove('hidden');
  releaseMouse(); updateLockUI();                                   // no treino o jogo pausa
  renderSettings();
  if (focus === 'perfil') setTimeout(() => { const i = $('cfTag'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus(); } }, 50);
}
function closeSettings() { $('cfgScreen').classList.add('hidden'); S.paused = false; updateLockUI(); }
function renderSettings() {
  const body = $('cfgBody'); body.textContent = '';
  for (const [title, items] of CFG_UI) {
    const sec = h('div', { class: 'cf-sec' }, h('div', { class: 'cf-t', text: title }));
    for (const it of items) {
      const [kind, key, label] = it;
      if (kind === 'range' || kind === 'vol') {
        const [min, max, step, fmt, hint] = kind === 'vol' ? [0, 100, 1, pct, ''] : it.slice(3);
        const val = h('span', { class: 'cf-v', text: fmt(cfg[key]) });
        const inp = h('input', { type: 'range', min, max, step, value: cfg[key], 'aria-label': label });
        inp.oninput = () => { cfg[key] = +inp.value; val.textContent = fmt(cfg[key]); if (kind === 'vol') mute.textContent = cfg[key] > 0 ? '🔊' : '🔇'; applyCfg(); };
        const mute = h('button', { class: 'cf-mute', title: 'Ligar/desligar', text: cfg[key] > 0 ? '🔊' : '🔇' });
        mute.onclick = () => {
          if (cfg[key] > 0) { cfg['_' + key] = cfg[key]; cfg[key] = 0; } else cfg[key] = cfg['_' + key] || CFG_DEF[key];
          inp.value = cfg[key]; val.textContent = fmt(cfg[key]); mute.textContent = cfg[key] > 0 ? '🔊' : '🔇'; applyCfg();
        };
        sec.append(h('div', { class: 'cf-row' }, h('label', { class: 'cf-l' }, label, hint ? h('small', { text: hint }) : null),
          h('div', { class: 'cf-ctl' }, kind === 'vol' ? mute : null, inp, val)));
      } else if (kind === 'toggle') {
        const cb = h('input', { type: 'checkbox' }); cb.checked = !!cfg[key];
        cb.onchange = () => { cfg[key] = cb.checked; applyCfg(); };
        sec.append(h('label', { class: 'cf-row cf-tg' }, h('span', { class: 'cf-l', text: label }), cb, h('i', { class: 'sw' })));
      } else if (kind === 'quality') {
        const mk = (lv, txt) => { const b = h('button', { class: 'cf-q' + (Q.level === lv ? ' on' : ''), text: txt }); b.onclick = () => { perf.checked = true; applyQuality(lv); renderSettings(); }; return b; };
        sec.append(h('div', { class: 'cf-row' }, h('span', { class: 'cf-l', text: 'Gráficos' }), h('div', { class: 'cf-ctl' }, mk('alto', 'Alto (HD)'), mk('leve', 'Leve'))));
      }
    }
    body.append(sec);
  }
  // perfil: nome (com conta) e sigla gravada na raquete
  const p = acct.profile, sec = h('div', { class: 'cf-sec' }, h('div', { class: 'cf-t', text: '👤 Perfil' }));
  if (p) {
    const nm = h('input', { id: 'cfName', maxlength: 20, value: p.name, placeholder: 'Seu nome', autocomplete: 'off' });
    const bn = h('button', { class: 'cf-save', text: 'Salvar nome' });
    bn.onclick = async () => {
      try { await rpc('set_display_name', { p_name: nm.value }); await refreshProfile(); toast('Nome atualizado'); }
      catch (e) { toast(/3 a 20/.test(e.message) ? 'O nome precisa ter de 3 a 20 caracteres' : 'Não deu para mudar o nome'); }
    };
    sec.append(h('div', { class: 'cf-row' }, h('label', { class: 'cf-l', for: 'cfName', text: 'Nome no jogo' }), h('div', { class: 'cf-ctl' }, nm, bn)));
  }
  const tg = h('input', { id: 'cfTag', maxlength: 6, value: myTag(), placeholder: 'ANDREW', autocomplete: 'off', class: 'cf-tag' });
  const prev = h('div', { class: 'cf-prev' });
  const upd = () => { tg.value = cleanTag(tg.value); prev.textContent = tg.value ? `Na raquete: ${tg.value} · ${myRacket.name}` : `Sem sigla · ${myRacket.name}`; };
  tg.oninput = upd; upd();
  const bt = h('button', { class: 'cf-save', text: 'Gravar na raquete' });
  bt.onclick = async () => {
    const v = cleanTag(tg.value);
    if (p) {
      if (!v) { toast('A sigla precisa ter de 1 a 6 letras ou números'); return; }
      try { await rpc('set_tag', { p_tag: v }); await refreshProfile(); } catch (e) { toast('Não deu para salvar a sigla'); return; }
    } else store.set('pp_tag', v);
    afterProfile(); toast(v ? `Sigla ${v} gravada na raquete` : 'Sigla removida');
  };
  sec.append(h('div', { class: 'cf-row' }, h('label', { class: 'cf-l', for: 'cfTag' }, 'Sigla na raquete', h('small', { text: 'Até 6 letras ou números. O adversário vê na sua raquete.' })), h('div', { class: 'cf-ctl' }, tg, bt)), prev);
  if (!p) sec.append(h('div', { class: 'cf-note', text: 'Entre com Steam ou Google para guardar nome e sigla na sua conta (vale em qualquer aparelho).' }));
  body.append(sec);
}

/* =====================================================================
   PAINEL DO ADMIN: jogadores, raquetes e histórico
   ===================================================================== */
const ADM = { tab: 'users', list: [], sel: null };
function openAdmin(tab = 'users') {
  if (!acct.profile || !acct.profile.admin) return;
  ADM.tab = tab; ADM.sel = null;
  $('admScreen').classList.remove('hidden');
  renderAdmin();
}
function admTabs() {
  const t = (id, txt) => { const b = h('button', { class: 'adm-tab' + (ADM.tab === id ? ' on' : ''), text: txt }); b.onclick = () => { ADM.tab = id; ADM.sel = null; renderAdmin(); }; return b; };
  return h('div', { class: 'adm-tabs' }, t('users', '👥 Jogadores'), t('rackets', '🏓 Raquetes'), t('log', '📜 Histórico'));
}
function renderAdmin() {
  const box = $('admBody'); box.textContent = ''; box.append(admTabs());
  const main = h('div', { class: 'adm-main' }); box.append(main);
  if (ADM.tab === 'users') ADM.sel ? admUser(main) : admUsers(main);
  else if (ADM.tab === 'rackets') admRackets(main);
  else admLog(main);
}
async function admUsers(main) {
  const q = h('input', { class: 'adm-q', placeholder: 'Buscar por nome, sigla, e-mail ou Steam ID', value: ADM.q || '' });
  const go = h('button', { class: 'cf-save', text: 'Buscar' });
  const list = h('div', { class: 'adm-list' }, h('p', { class: 'muted', text: 'Carregando…' }));
  const load = async () => {
    ADM.q = q.value;
    try { ADM.list = await rpc('admin_list_users', { p_q: q.value, p_limit: 100 }) || []; }
    catch (e) { list.textContent = ''; list.append(h('p', { class: 'muted', text: 'Não consegui carregar: ' + e.message })); return; }
    list.textContent = '';
    if (!ADM.list.length) { list.append(h('p', { class: 'muted', text: 'Ninguém encontrado.' })); return; }
    list.append(h('div', { class: 'adm-count', text: `${ADM.list.length} jogador(es)` }));
    for (const u of ADM.list) {
      const row = h('button', { class: 'adm-row' + (u.banned ? ' ban' : '') },
        h('span', { class: 'adm-nm' }, h('b', { text: u.name }), h('span', { class: 'adm-chip', text: u.tag || '—' })),
        h('span', { class: 'adm-pv', text: u.provider === 'steam' ? 'Steam' : u.provider === 'google' ? 'Google' : u.provider }),
        h('span', { class: 'adm-elo', text: `${u.rating ?? '—'} elo` }),
        h('span', { class: 'adm-wl', text: `${u.wins || 0}V ${u.losses || 0}D` }),
        h('span', { class: 'adm-bd' }, u.admin ? h('i', { class: 'b-adm', text: 'ADMIN' }) : null, u.banned ? h('i', { class: 'b-ban', text: 'BANIDO' }) : null,
          (u.rackets || []).length ? h('i', { class: 'b-rk', text: `🎁 ${(u.rackets || []).length}` }) : null));
      row.onclick = () => { ADM.sel = u; renderAdmin(); };
      list.append(row);
    }
  };
  go.onclick = load; q.onkeydown = e => { if (e.key === 'Enter') load(); };
  main.append(h('div', { class: 'adm-search' }, q, go), list);
  load();
}
function admUser(main) {
  const u = ADM.sel, fmtD = d => d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const back = h('button', { class: 'adm-back', text: '← Voltar para a lista' }); back.onclick = () => { ADM.sel = null; renderAdmin(); };
  const info = h('div', { class: 'adm-info' },
    ...[['Entrou com', u.provider === 'steam' ? `Steam (${u.steam_id})` : (u.email || u.provider)], ['Criado em', fmtD(u.created_at)], ['Último login', fmtD(u.last_login)],
      ['Partidas ranqueadas', `${u.games || 0} (${u.wins || 0}V ${u.losses || 0}D, ${u.abandons || 0} abandonos)`], ['Maior elo', u.peak ?? '—'], ['ID', u.id]]
      .map(([k, v]) => h('div', {}, h('small', { text: k }), h('span', { text: String(v) }))));
  const f = {
    name: h('input', { maxlength: 20, value: u.name }), tag: h('input', { maxlength: 6, value: u.tag || '', class: 'cf-tag' }),
    rating: h('input', { type: 'number', min: 100, max: 4000, value: u.rating ?? 1000 }),
    admin: h('input', { type: 'checkbox' }), banned: h('input', { type: 'checkbox' }), reason: h('input', { maxlength: 200, value: u.ban_reason || '', placeholder: 'Motivo (aparece para o jogador)' }),
  };
  f.admin.checked = !!u.admin; f.banned.checked = !!u.banned;
  f.tag.oninput = () => { f.tag.value = cleanTag(f.tag.value); };
  const rks = RACKETS.map(r => {
    const cb = h('input', { type: 'checkbox' }); cb.checked = (u.rackets || []).includes(r.id); cb.dataset.id = r.id;
    const c = rcfg(r), note = c.enabled === false ? 'desligada no jogo' : c.free ? 'já é de todos' : c.unlock_wins ? `ou ${c.unlock_wins} vitórias` : 'exclusiva';
    return h('label', { class: 'adm-rk' }, cb, thumbs[r.id] ? h('img', { src: thumbs[r.id], alt: '' }) : null, h('span', {}, h('b', { text: r.name }), h('small', { text: note })));
  });
  const msg = h('p', { class: 'adm-msg' });
  const save = h('button', { class: 'btn', text: 'Salvar alterações' });
  save.onclick = async () => {
    const patch = {};
    if (f.name.value.trim() !== u.name) patch.name = f.name.value.trim();
    if (cleanTag(f.tag.value) && cleanTag(f.tag.value) !== u.tag) patch.tag = cleanTag(f.tag.value);
    if (+f.rating.value !== u.rating) patch.rating = +f.rating.value;
    if (f.admin.checked !== !!u.admin) patch.admin = f.admin.checked;
    if (f.banned.checked !== !!u.banned || (f.banned.checked && f.reason.value !== (u.ban_reason || ''))) { patch.banned = f.banned.checked; patch.ban_reason = f.reason.value; }
    const sel = rks.map(l => l.querySelector('input')).filter(c => c.checked).map(c => c.dataset.id);
    if (sel.sort().join() !== [...(u.rackets || [])].sort().join()) patch.rackets = sel;
    if (!Object.keys(patch).length) { msg.textContent = 'Nada mudou.'; return; }
    save.disabled = true; msg.textContent = 'Salvando…';
    try {
      const r = await rpc('admin_update_user', { p_id: u.id, p_patch: patch });
      Object.assign(u, r); msg.textContent = '✅ Salvo.';
      if (acct.profile && u.id === acct.profile.id) refreshProfile();
      setTimeout(() => renderAdmin(), 700);
    } catch (e) { msg.textContent = '⚠️ ' + e.message; }
    save.disabled = false;
  };
  const reset = h('button', { class: 'btn ghost', text: 'Zerar elo e estatísticas' });
  reset.onclick = async () => {
    if (!confirm(`Zerar elo, vitórias e derrotas de ${u.name}? Não dá para desfazer.`)) return;
    try { const r = await rpc('admin_update_user', { p_id: u.id, p_patch: { reset_stats: true } }); Object.assign(u, r, { abandons: 0, peak: 1000 }); toast('Estatísticas zeradas'); renderAdmin(); }
    catch (e) { msg.textContent = '⚠️ ' + e.message; }
  };
  const row = (label, el, hint) => h('div', { class: 'cf-row' }, h('label', { class: 'cf-l' }, label, hint ? h('small', { text: hint }) : null), h('div', { class: 'cf-ctl' }, el));
  main.append(back, h('h3', { class: 'adm-h' }, u.name, ' ', h('span', { class: 'adm-chip', text: u.tag || '—' })), info,
    h('div', { class: 'cf-sec' }, h('div', { class: 'cf-t', text: 'Dados' }), row('Nome', f.name), row('Sigla na raquete', f.tag), row('Elo', f.rating, 'Entre 100 e 4000')),
    h('div', { class: 'cf-sec' }, h('div', { class: 'cf-t', text: 'Raquetes liberadas para este jogador' }), h('div', { class: 'adm-rks' }, rks)),
    h('div', { class: 'cf-sec' }, h('div', { class: 'cf-t', text: 'Permissões' }),
      h('label', { class: 'cf-row cf-tg' }, h('span', { class: 'cf-l', text: 'Admin (libera tudo e abre este painel)' }), f.admin, h('i', { class: 'sw' })),
      h('label', { class: 'cf-row cf-tg' }, h('span', { class: 'cf-l', text: 'Banido (não entra na ranqueada nem no ranking)' }), f.banned, h('i', { class: 'sw' })), row('Motivo do banimento', f.reason)),
    msg, h('div', { class: 'stack' }, save, reset));
}
function admRackets(main) {
  main.append(h('p', { class: 'cf-note', text: 'Ativa: aparece no jogo. Para todos: qualquer um usa. Vitórias: libera sozinha depois de X vitórias (vazio = só o admin libera, pela ficha do jogador).' }));
  for (const r of RACKETS) {
    const c = rcfg(r);
    const en = h('input', { type: 'checkbox' }); en.checked = c.enabled !== false;
    const fr = h('input', { type: 'checkbox' }); fr.checked = !!c.free;
    const uw = h('input', { type: 'number', min: 1, max: 1000, value: c.unlock_wins || '', placeholder: '—', class: 'adm-num' });
    const msg = h('span', { class: 'adm-msg' });
    const save = h('button', { class: 'cf-save', text: 'Salvar' });
    save.onclick = async () => {
      try { await rpc('admin_set_racket', { p_id: r.id, p_enabled: en.checked, p_free: fr.checked, p_unlock_wins: uw.value ? +uw.value : null }); msg.textContent = '✅'; await loadRacketCfg(); }
      catch (e) { msg.textContent = '⚠️ ' + e.message; }
    };
    const all = (grant) => async () => {
      if (!confirm(`${grant ? 'Dar' : 'Tirar'} a ${r.name} ${grant ? 'para' : 'de'} todos os jogadores com conta?`)) return;
      try { const n = await rpc('admin_grant_racket_all', { p_racket: r.id, p_grant: grant }); msg.textContent = `✅ ${n} jogador(es)`; refreshProfile(); }
      catch (e) { msg.textContent = '⚠️ ' + e.message; }
    };
    const give = h('button', { class: 'adm-mini', text: 'Dar a todos' }); give.onclick = all(true);
    const take = h('button', { class: 'adm-mini', text: 'Tirar de todos' }); take.onclick = all(false);
    main.append(h('div', { class: 'adm-rrow' },
      thumbs[r.id] ? h('img', { src: thumbs[r.id], alt: '' }) : h('span'),
      h('div', { class: 'adm-rinfo' }, h('b', { text: r.name }), h('small', { text: `${r.tag} · vel ${r.speed} · efeito ${r.spin} · controle ${r.ctrl}` })),
      h('label', { class: 'adm-ck' }, en, 'Ativa'), h('label', { class: 'adm-ck' }, fr, 'Para todos'),
      h('label', { class: 'adm-ck' }, 'Vitórias', uw), save,
      h('div', { class: 'adm-rall' }, give, take, msg)));
  }
}
async function admLog(main) {
  const list = h('div', { class: 'adm-list' }, h('p', { class: 'muted', text: 'Carregando…' })); main.append(list);
  try {
    const rows = await rpc('admin_log_recent', { p_limit: 60 }) || [];
    list.textContent = '';
    if (!rows.length) { list.append(h('p', { class: 'muted', text: 'Nenhuma alteração ainda.' })); return; }
    const act = l => {
      const d = l.details || {};
      if (l.action === 'set_racket') return `raquete ${d.id}: ${d.enabled ? 'ativa' : 'desligada'}, ${d.free ? 'para todos' : d.unlock_wins ? `${d.unlock_wins} vitórias` : 'exclusiva'}`;
      if (l.action === 'grant_racket_all') return `${d.grant ? 'deu' : 'tirou'} ${d.racket} ${d.grant ? 'para' : 'de'} ${d.players} jogador(es)`;
      const parts = Object.entries(d).filter(([k]) => k !== 'ban_reason').map(([k, v]) => k === 'rackets' ? `raquetes: ${(v || []).join(', ') || 'nenhuma'}` : k === 'banned' ? (v ? 'baniu' : 'desbaniu') : k === 'admin' ? (v ? 'deu admin' : 'tirou admin') : k === 'reset_stats' ? 'zerou estatísticas' : `${k}: ${v}`);
      return `${l.target || 'jogador'} → ${parts.join(' · ')}`;
    };
    for (const l of rows) list.append(h('div', { class: 'adm-log' }, h('small', { text: new Date(l.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) }), h('b', { text: l.admin || 'admin' }), h('span', { text: act(l) })));
  } catch (e) { list.textContent = ''; list.append(h('p', { class: 'muted', text: 'Não consegui carregar: ' + e.message })); }
}

/* ---------- telas (CSS + HTML) ---------- */
function initMenusUI() {
  const st = document.createElement('style');
  st.textContent = `
  #lobby .card { position: relative; }
  #btnSpecHud { display: none; } body.online #btnSpecHud { display: inline-block; }
  #lockOverlay { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; background: rgba(5,3,10,.55); backdrop-filter: blur(3px); cursor: pointer; }
  #lockOverlay.hidden { display: none; }
  .lk-card { background: rgba(20,12,24,.92); border: 1px solid rgba(255,255,255,.12); border-radius: 18px; padding: 22px 24px; width: min(360px, 90vw); text-align: center; cursor: default; }
  .lk-t { font: italic 900 26px system-ui; margin-bottom: 6px; } .lk-s { font-size: 13px; opacity: .75; line-height: 1.45; margin-bottom: 14px; }
  body.locked #c { cursor: none; }
  .gear { position: absolute; top: 14px; right: 14px; width: 40px; height: 40px; border-radius: 50%; border: 1px solid rgba(255,255,255,.15); background: rgba(255,255,255,.08); color: #fff; font-size: 19px; cursor: pointer; z-index: 2; }
  .gear:hover { background: rgba(255,79,139,.35); }
  #cfgScreen .card, #admScreen .card { max-width: 560px; text-align: left; max-height: 92vh; overflow-y: auto; }
  #admScreen .card { max-width: 780px; }
  .cf-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
  .cf-head h2 { margin: 0; }
  .cf-x { border: 0; background: rgba(255,255,255,.1); color: #fff; width: 36px; height: 36px; border-radius: 50%; font-size: 18px; cursor: pointer; flex: none; }
  .cf-sec { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07); border-radius: 14px; padding: 10px 12px; margin-top: 12px; }
  .cf-t { font-size: 12px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; opacity: .75; margin-bottom: 6px; }
  .cf-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; }
  .cf-row + .cf-row { border-top: 1px solid rgba(255,255,255,.05); }
  .cf-l { font-size: 14px; font-weight: 700; display: flex; flex-direction: column; min-width: 0; }
  .cf-l small { font-size: 11.5px; font-weight: 500; opacity: .6; margin-top: 1px; }
  .cf-ctl { display: flex; align-items: center; gap: 8px; flex: none; }
  .cf-ctl input[type=range] { width: 150px; accent-color: #ff4f8b; }
  .cf-ctl input:not([type]), .cf-ctl input[type=number], .adm-q { background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.15); color: #fff; border-radius: 9px; padding: 8px 10px; font-size: 14px; width: 170px; }
  .cf-ctl input:not([type]), .cf-ctl input[type=number], .adm-q { text-transform: none; letter-spacing: normal; text-align: left; font-weight: 600; }
  .cf-tag { text-transform: uppercase !important; font-weight: 900 !important; letter-spacing: .12em !important; text-align: center !important; width: 110px !important; }
  .cf-v { width: 46px; text-align: right; font-weight: 800; font-size: 13px; opacity: .85; }
  .cf-mute { border: 0; background: none; font-size: 17px; cursor: pointer; padding: 0 2px; }
  .cf-tg { cursor: pointer; } .cf-tg input { display: none; }
  .cf-tg .sw { width: 42px; height: 24px; border-radius: 999px; background: rgba(255,255,255,.18); position: relative; flex: none; transition: background .2s; }
  .cf-tg .sw::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .2s; }
  .cf-tg input:checked + .sw { background: #ff4f8b; } .cf-tg input:checked + .sw::after { transform: translateX(18px); }
  .cf-q, .cf-save, .adm-mini { border: 1px solid rgba(255,255,255,.15); background: rgba(255,255,255,.08); color: #fff; border-radius: 9px; padding: 8px 12px; font-weight: 800; font-size: 13px; cursor: pointer; white-space: nowrap; }
  .cf-q.on, .cf-save { background: linear-gradient(180deg, #ff4f8b, #d81b60); border-color: transparent; }
  .cf-prev { font-size: 12.5px; font-weight: 800; color: #ffd34d; padding: 2px 0 4px; }
  .cf-note { font-size: 12px; opacity: .65; margin: 8px 0 0; line-height: 1.45; }
  .cf-foot { display: flex; gap: 8px; margin-top: 14px; } .cf-foot .btn { flex: 1; }
  .acct-extra { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .acct-extra button { border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: #fff; border-radius: 999px; padding: 5px 10px; font-size: 12px; font-weight: 800; cursor: pointer; }
  .acct-extra .adm { background: linear-gradient(90deg, #ffd34d, #ff9a3c); color: #1a1000; border: 0; }
  .acct-ban { margin-top: 8px; font-size: 12.5px; font-weight: 800; color: #ff7a8a; }
  .adm-tabs { display: flex; gap: 6px; margin: 10px 0 4px; flex-wrap: wrap; }
  .adm-tab { border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.05); color: #fff; border-radius: 999px; padding: 7px 14px; font-weight: 800; cursor: pointer; }
  .adm-tab.on { background: #ff4f8b; border-color: #ff4f8b; }
  .adm-search { display: flex; gap: 8px; margin: 10px 0; } .adm-q { flex: 1; width: auto; }
  .adm-list { display: flex; flex-direction: column; gap: 4px; max-height: 58vh; overflow-y: auto; }
  .adm-count { font-size: 12px; opacity: .6; margin-bottom: 2px; }
  .adm-row { display: grid; grid-template-columns: 1fr 70px 80px 70px auto; gap: 8px; align-items: center; text-align: left; border: 0; background: rgba(255,255,255,.045); color: #fff; padding: 9px 10px; border-radius: 10px; cursor: pointer; font-size: 13.5px; }
  .adm-row:hover { background: rgba(255,79,139,.2); } .adm-row.ban { opacity: .6; }
  .adm-nm { display: flex; gap: 6px; align-items: center; min-width: 0; } .adm-nm b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .adm-chip { font-size: 10.5px; font-weight: 900; letter-spacing: .1em; padding: 2px 6px; border-radius: 6px; background: rgba(255,211,77,.18); color: #ffd34d; }
  .adm-pv, .adm-wl { font-size: 12px; opacity: .7; } .adm-elo { font-weight: 800; }
  .adm-bd { display: flex; gap: 4px; } .adm-bd i { font-style: normal; font-size: 10px; font-weight: 900; padding: 2px 6px; border-radius: 999px; }
  .b-adm { background: #ffd34d; color: #1a1000; } .b-ban { background: #ff3355; } .b-rk { background: rgba(154,92,255,.4); }
  .adm-back { border: 0; background: none; color: #ffd34d; font-weight: 800; cursor: pointer; padding: 6px 0; }
  .adm-h { margin: 4px 0 8px; display: flex; align-items: center; gap: 8px; }
  .adm-info { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; font-size: 13px; }
  .adm-info small { display: block; font-size: 11px; opacity: .55; } .adm-info span { word-break: break-all; }
  .adm-rks { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .adm-rk { display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,.04); border-radius: 10px; padding: 6px 8px; cursor: pointer; font-size: 13px; }
  .adm-rk img { width: 26px; height: 33px; object-fit: contain; } .adm-rk small { display: block; font-size: 11px; opacity: .6; }
  .adm-rk input, .adm-ck input[type=checkbox] { width: 18px; height: 18px; accent-color: #ff4f8b; }
  .adm-msg { font-size: 13px; font-weight: 700; min-height: 18px; }
  .adm-rrow { display: grid; grid-template-columns: 36px 1fr auto auto auto auto; gap: 10px; align-items: center; background: rgba(255,255,255,.04); border-radius: 12px; padding: 8px 10px; margin-top: 8px; font-size: 13px; }
  .adm-rrow img { width: 32px; height: 40px; object-fit: contain; } .adm-rinfo small { display: block; font-size: 11px; opacity: .6; }
  .adm-ck { display: flex; align-items: center; gap: 5px; font-weight: 700; white-space: nowrap; }
  .adm-num { width: 64px !important; padding: 6px !important; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.15); color: #fff; border-radius: 8px; }
  .adm-rall { grid-column: 2 / -1; display: flex; gap: 6px; align-items: center; } .adm-mini { padding: 5px 9px; font-size: 12px; }
  .adm-log { display: grid; grid-template-columns: 112px 110px 1fr; gap: 8px; font-size: 13px; padding: 7px 8px; border-radius: 8px; background: rgba(255,255,255,.035); }
  .adm-log small { opacity: .6; }
  @media (max-width: 620px) {
    .adm-row { grid-template-columns: 1fr auto; } .adm-pv, .adm-wl { display: none; }
    .adm-rrow { grid-template-columns: 36px 1fr; } .adm-info, .adm-rks { grid-template-columns: 1fr; }
    .cf-row { flex-wrap: wrap; } .cf-ctl input[type=range] { width: 120px; } .adm-log { grid-template-columns: 1fr; }
  }`;
  document.head.appendChild(st);
  const gear = h('button', { class: 'gear', title: 'Configurações', 'aria-label': 'Configurações', text: '⚙️' });
  gear.onclick = () => openSettings();
  document.querySelector('#lobby .card').prepend(gear);
  const hg = h('button', { id: 'btnCfg', title: 'Configurações', text: '⚙️' }); hg.onclick = () => openSettings();
  $('btnSound').before(hg);
  const fb = h('button', { id: 'btnFull', title: 'Tela cheia', text: '⛶' }); fb.onclick = toggleFullscreen;
  hg.before(fb);
  const sl = h('button', { id: 'btnSpecHud', title: 'Copiar link para assistir', text: '👀' });
  sl.onclick = () => { if (!curRoom) return; const l = `${location.origin}${location.pathname}?ver=${curRoom}`; (navigator.clipboard ? navigator.clipboard.writeText(l) : Promise.reject()).then(() => toast('👀 Link para assistir copiado: mande para quem quiser ver'), () => toast(l)); };
  fb.before(sl);
  const lk = h('div', { id: 'lockOverlay', class: 'hidden' });
  const lkGo = h('button', { class: 'btn', id: 'lkGo', text: 'Jogar' });
  const lkCfg = h('button', { class: 'btn ghost', text: '⚙️ Configurações' });
  const lkSkip = h('button', { class: 'btn ghost hidden', id: 'lkSkip', text: 'Jogar sem prender o mouse' });
  lkSkip.onclick = e => { e.stopPropagation(); lock.skip = true; lock.want = false; updateLockUI(); };
  const lkQuit = h('button', { class: 'btn ghost', text: 'Sair para o menu' });
  lkGo.onclick = e => { e.stopPropagation(); enterPlayMode(); updateLockUI(); };
  lkCfg.onclick = e => { e.stopPropagation(); openSettings(); };
  lkQuit.onclick = e => { e.stopPropagation(); goMenu(); };
  lk.onclick = () => { enterPlayMode(); updateLockUI(); };
  lk.append(h('div', { class: 'lk-card' }, h('div', { class: 'lk-t', id: 'lkTitle' }), h('div', { class: 'lk-s', id: 'lkSub' }), h('div', { class: 'stack' }, lkGo, lkSkip, lkCfg, lkQuit)));
  document.body.append(lk);
  const cs = h('div', { id: 'cfgScreen', class: 'screen hidden' });
  cs.style.zIndex = 42;
  const x1 = h('button', { class: 'cf-x', 'aria-label': 'Fechar', text: '✕' }); x1.onclick = closeSettings;
  const rs = h('button', { class: 'btn ghost', text: 'Restaurar padrão' });
  rs.onclick = () => { Object.assign(cfg, CFG_DEF); applyCfg(); renderSettings(); toast('Configurações restauradas'); };
  const ok = h('button', { class: 'btn', text: 'Pronto' }); ok.onclick = closeSettings;
  cs.append(h('div', { class: 'card' }, h('div', { class: 'cf-head' }, h('h2', { text: '⚙️ Configurações' }), x1), h('div', { id: 'cfgBody' }), h('div', { class: 'cf-foot' }, rs, ok)));
  cs.onclick = e => { if (e.target === cs) closeSettings(); };
  document.body.append(cs);
  const as = h('div', { id: 'admScreen', class: 'screen hidden' });
  as.style.zIndex = 43;
  const x2 = h('button', { class: 'cf-x', 'aria-label': 'Fechar', text: '✕' }); x2.onclick = () => as.classList.add('hidden');
  as.append(h('div', { class: 'card' }, h('div', { class: 'cf-head' }, h('h2', { text: '🛠️ Painel do admin' }), x2), h('div', { id: 'admBody' })));
  document.body.append(as);
  // cartão da conta: sigla, configurações e painel do admin
  const ex = h('div', { class: 'acct-extra', id: 'acctExtra' });
  const bTag = h('button', { id: 'acctTagBtn', text: '🏓 Sigla' }); bTag.onclick = () => openSettings('perfil');
  const bAdm = h('button', { class: 'adm hidden', id: 'btnAdmin', text: '🛠️ Painel admin' }); bAdm.onclick = () => openAdmin();
  ex.append(bTag, bAdm);
  $('acctIn').append(ex, h('div', { class: 'acct-ban hidden', id: 'acctBan' }));
  $('btnName').onclick = () => openSettings('perfil');
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('cfgScreen').classList.contains('hidden')) closeSettings(); });
  applyCfg();
}
function renderAccountExtras() {
  const p = acct.profile; if (!$('acctExtra')) return;
  $('acctTagBtn').textContent = `🏓 Sigla: ${myTag() || '—'} ✎`;
  if ($('btnFriends')) $('btnFriends').classList.toggle('hidden', !p);
  $('btnAdmin').classList.toggle('hidden', !(p && p.admin));
  $('acctBan').classList.toggle('hidden', !(p && p.banned));
  if (p && p.banned) $('acctBan').textContent = `⛔ Conta suspensa da ranqueada${p.ban_reason ? ': ' + p.ban_reason : ''}`;
}
initMenusUI();

setMuted(muted);

/* =====================================================================
   REPLAYS (estilo Rocket League) E COMEMORAÇÃO
   Cada ponto é gravado (bola, raquetes e batidas). Ponto bonito ganha replay
   na hora: câmera de TV, câmera lenta com zoom na batida e câmera seguindo a
   bola. No fim da partida: fogos, volta da câmera e os 2 melhores momentos.
   ===================================================================== */
const RP = { rec: null, clips: [], play: null, pending: false, lastReplayPt: -9, cam: { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 40, snap: true } };
const HL_INSTANT = 6.5;                    // nota mínima para replay na hora
const totalPts = () => S.score['1'] + S.score['-1'] + S.gameScores.reduce((a, g) => a + g['1'] + g['-1'], 0);

function recStart() {
  recFinish();
  RP.rec = { t: 0, frames: [], events: [], maxV: { '1': 0, '-1': 0 }, lastHit: { '1': null, '-1': null }, lastAny: null, server: S.server, gameNo: S.gameNo, done: false };
}
function recEvent(k, p, s, ex) {
  const c = RP.rec; if (!c || c.done && c.t > c.tP + 1.2) return;
  const e = { t: c.t, k, p: [p[0], p[1], p[2]], s, ...ex };
  c.events.push(e);
  if (k === 'hit') {
    c.lastHit[String(ex.side)] = e; c.lastAny = e;
    c.maxV[String(ex.side)] = Math.max(c.maxV[String(ex.side)], ex.speed || 0);
  }
}
function recFrame(dt) {
  const c = RP.rec; if (!c || RP.play) return;
  if (S.phase !== 'serve' && S.phase !== 'rally' && S.phase !== 'point') return;
  c.t += dt * TIME_SCALE;
  if (c.done && c.t > c.tP + 1.2) return;            // depois do ponto grava só mais um pouquinho
  if (c.frames.length > 3600) c.frames.splice(0, 600);  // rally gigante: guarda o final
  const b = S.ball.p, m = myPaddleMesh, o = oppPaddleMesh;
  c.frames.push([c.t, b[0], b[1], b[2], S.ballVisible ? 1 : 0,
    m.position.x, m.position.y, m.position.z, m.userData.pivot.rotation.x, m.userData.pivot.rotation.z,
    o.position.x, o.position.y, o.position.z, o.userData.pivot.rotation.x, o.userData.pivot.rotation.z, trailColor.getHex()]);
}
// nota do ponto: rally longo, smash, curva, bola na fita, ace e velocidade valem mais
function hlInfo(winner, reason) {
  const c = RP.rec || { maxV: { '1': 0, '-1': 0 } };
  const label = S.rally.hitter === winner ? S.lastLabel : null, rally = S.streak;
  const ace = rally === 0 && reason === 'miss' && winner === S.server;
  let s = rally * 0.6 + (c.maxV[String(winner)] || 0) / 4;
  s += { 'SMASH!': 3.5, 'SIDE-SPIN': 2, 'RASPOU NA REDE!': 3, 'CORTE': 1, 'TOP-SPIN': 0.5 }[label] || 0;
  if (ace) s += 1.5;
  if (reason === 'out' || reason === 'net') s *= 0.35;     // erro do adversário vale menos
  return { score: s, label, rally, ace };
}
function recPoint(winner, reason) {
  const c = RP.rec; if (!c || !winner) return;
  const h = hlInfo(winner, reason);
  const hit = c.lastHit[String(winner)] || c.lastAny;
  Object.assign(c, { done: true, tP: c.t, winner, reason, ...h, tHit: hit ? hit.t : Math.max(0, c.t - 0.6), hitter: hit ? hit.side : winner,
    scoreTxt: `${S.score[String(S.mySide)]}-${S.score[String(-S.mySide)]}`, who: winner === S.mySide ? (acct.profile ? acct.profile.name : 'Você') : oppLabel() });
}
function recFinish() {
  const c = RP.rec; RP.rec = null;
  if (c && c.done && c.frames.length >= 20) RP.last = c;
  if (!c || !c.done || c.frames.length < 20 || c.score < 2) return;
  RP.clips.push(c); RP.clips.sort((a, b) => b.score - a.score);
  if (RP.clips.length > 6) RP.clips.length = 6;
}
function clipDesc(c) {
  const what = c.ace ? 'ACE' : c.label === 'SMASH!' ? 'SMASH' : c.label === 'SIDE-SPIN' ? 'CURVA' : c.label === 'RASPOU NA REDE!' ? 'NA FITA' : 'PONTO';
  return `${what} de ${c.who}${c.rally >= 4 ? ` · rally de ${c.rally}` : ''} · ${c.scoreTxt}${S.format > 1 ? ` · game ${c.gameNo}` : ''}`;
}

/* ---------- tocar um replay ---------- */
function frameAt(c, t) {
  const F = c.frames; let lo = 0, hi = F.length - 1;
  if (t <= F[0][0]) return F[0];
  if (t >= F[hi][0]) return F[hi];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (F[mid][0] <= t) lo = mid; else hi = mid; }
  const a = F[lo], b = F[hi], k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
  return a.map((v, i) => i === 4 || i === 15 ? (k < 0.5 ? v : b[i]) : v + (b[i] - v) * k);
}
function visFrame(c, t) {                              // último quadro com a bola visível (ela some quando o ponto acaba)
  let f = frameAt(c, t); if (f[4]) return f;
  for (let k = 1; k <= 60; k++) { const g = frameAt(c, t - k * 0.03); if (g[4]) return g; }
  return f;
}
function buildShots(c, short) {
  const t0 = c.frames[0][0], tLast = c.frames[c.frames.length - 1][0], tH = c.tHit;
  const tEnd = Math.min(tLast, c.tP + (short ? 0.35 : 0.7));
  const shots = [
    { a: Math.max(t0, tH - (short ? 1.3 : 2.8)), b: tH - 0.08, rate: 1, cam: 'broadcast' },
    { a: tH - 0.08, b: tH + 0.22, rate: 0.25, cam: 'hit', freezeAt: tH + 0.015, freeze: 0.45 },
    { a: tH + 0.04, b: tEnd, rate: short ? 0.7 : 0.5, cam: 'chase' },
  ].filter(s => s.b > s.a + 0.05);
  shots.push({ a: tEnd, b: Math.min(tLast, tEnd + 0.25), rate: 0.5, cam: 'celebrate', hold: 0.6 });
  return shots;
}
function startReplay(clip, o = {}) {
  const shots = buildShots(clip, o.mode === 'instant');
  RP.play = { clip, shots, i: 0, t: shots[0].a, freeze: 0, frozen: false, mode: o.mode, onEnd: o.onEnd, skipMe: false, skipOpp: false, el: 0, title: o.title || 'REPLAY' };
  RP.cam.snap = true;
  document.body.classList.add('replaying');
  $('rpTitle').textContent = RP.play.title; $('rpCap').textContent = clipDesc(clip);
  $('rpSkip').textContent = 'Pular ⏭'; $('rpUI').classList.remove('hidden');
  $('chatFeed').classList.add('hidden');
  flash(); updateLockUI();
  if (o.mode === 'instant' && !cfg.replays) skipReplay();   // quem desligou os replays já vota para pular
}
function endReplay(run = true) {
  const p = RP.play; if (!p) return;
  RP.play = null; trailPts.length = 0; slowAudio(false);
  document.body.classList.remove('replaying'); $('rpUI').classList.add('hidden'); $('chatFeed').classList.remove('hidden');
  if (run && p.onEnd) p.onEnd();
  updateLockUI();
}
function skipReplay() {
  const p = RP.play; if (!p) return;
  if (p.mode === 'instant' && S.mode === 'online') {     // online: os dois precisam pular (como no Rocket League)
    if (!p.skipMe) { p.skipMe = true; send({ t: 'rskip' }); }
    if (p.skipOpp) endReplay(); else $('rpSkip').textContent = 'Esperando o adversário…';
    return;
  }
  if (p.mode === 'highlight' && END.active) { END.skipAll = true; }
  endReplay();
}
function replayEvents(c, t0, t1) {
  for (const e of c.events) {
    if (e.t <= t0 || e.t > t1) continue;
    if (e.k === 'hit') { if (SLOW.on) boom(0.32); sfx('hit', e.label, e.p, e.s * 0.8, (e.side === S.mySide ? myRacket : oppRacket).sound); sparks.emit(22, e.p[0], e.p[1], e.p[2], TRAIL_COLORS[e.label] || 0x22ff88, 1.8, { life: 0.4, intensity: 2.5, grav: 2, drag: 3 }); }
    else if (e.k === 'table') { sfx('table', null, e.p, e.s); spawnRing(e.p[0], TH + 0.003, e.p[2], trailColor); }
    else if (e.k === 'net') sfx('net', null, e.p, e.s);
  }
}
function replayStep(dt) {
  const p = RP.play; if (!p) return;
  const c = p.clip, sh = p.shots[p.i];
  p.el += dt;
  if (p.freeze > 0) {                                   // congela na batida, com zoom
    p.freeze -= dt;
  } else {
    const prev = p.t;
    p.t = Math.min(sh.b, p.t + dt * TIME_SCALE * sh.rate);
    if (sh.freezeAt && !p.frozen && p.t >= sh.freezeAt) {
      p.t = sh.freezeAt; p.frozen = true; p.freeze = sh.freeze;
      if (c.label) showLabel(c.label);
      const f = frameAt(c, p.t); sparks.emit(36, f[1], f[2], f[3], TRAIL_COLORS[c.label] || 0xffffff, 2.2, { life: 0.6, intensity: 3, grav: 1, drag: 2.5 });
      cam.shake = 0.4;
    }
    replayEvents(c, prev, p.t);
  }
  slowAudio(p.mode !== 'bg' && (p.freeze > 0 || sh.rate < 1));
  $('rpSpeed').textContent = p.freeze > 0 ? '⏸ CONGELADO' : sh.rate < 1 ? `⏱ CÂMERA LENTA ${sh.rate}×` : '';
  if (sh.cam === 'celebrate' && !sh.started) { sh.started = true; crowdReact('point', 0.9); pyroBurst(0.9); confetti.emit(70, 0, 3.2, c.winner * (HL + 0.4), 0xffffff, 1.2, { rainbow: true, life: 2.5, grav: 0.9, drag: 1.4, spread: 3 }); }
  if (p.t >= sh.b && p.freeze <= 0) {
    if (sh.hold && (sh.holdT = (sh.holdT || 0) + dt) < sh.hold) { /* segura a comemoração um pouco */ }
    else if (p.i + 1 < p.shots.length) { p.i++; p.t = p.shots[p.i].a; RP.cam.snap = true; flash(); }
    else { endReplay(); return; }
  }
  if (p.el > 14) endReplay();                           // trava de segurança
}
// coloca bola e raquetes como estavam no momento t
function replayPose() {
  const p = RP.play; if (!p) return;
  const c = p.clip, f = frameAt(c, p.t);
  ballMesh.visible = blob.visible = !!f[4]; ballGlow.visible = !!f[4] && cfg.ballGlow;
  ballMesh.position.set(f[1], f[2], f[3]); ballGlow.position.copy(ballMesh.position); ballGlow.scale.set(0.09, 0.09, 1);
  trailColor.setHex(f[15]); ballGlow.material.color.copy(trailColor).lerp(_fxC.setHex(0xffffff), 0.55);
  const overTable = Math.abs(f[1]) < HW && Math.abs(f[3]) < HL && f[2] > TH - 0.01, sy = overTable ? TH + 0.002 : 0.005;
  blob.position.set(f[1], sy, f[3]); const s = 1 + Math.max(0, f[2] - sy) * 1.4; blob.scale.set(s, s, s);
  trailPts.length = 0;
  for (let i = 9; i >= 0; i--) { const q = frameAt(c, p.t - i * 0.012); if (q[4]) trailPts.push([q[1], q[2], q[3]]); }
  updateTrail();
  const pose = (mesh, o, sd) => { mesh.visible = true; mesh.position.set(f[o], f[o + 1], f[o + 2]); mesh.rotation.set(0, sd > 0 ? 0 : Math.PI, 0); mesh.userData.pivot.rotation.set(f[o + 3], 0, f[o + 4]); };
  pose(myPaddleMesh, 5, S.mySide); pose(oppPaddleMesh, 10, -S.mySide);
}
const _rp = new THREE.Vector3(), _rl = new THREE.Vector3(), _rd = new THREE.Vector3();
function replayCamera(dt) {
  const p = RP.play; if (!p) return;
  const c = p.clip, sh = p.shots[p.i], f = visFrame(c, p.t), ball = _rl.set(f[1], Math.max(f[2], TH - 0.2), f[3]);
  let fov = 40;
  if (sh.cam === 'broadcast') {
    _rp.set(3.4, TH + 1.35, clamp(f[3] * 0.4, -1.2, 1.2)); ball.set(f[1] * 0.4, TH + 0.05, f[3] * 0.6); fov = 36;
  } else if (sh.cam === 'hit') {
    if (!sh.base) {
      const h = frameAt(c, c.tHit), mine = c.hitter === S.mySide, o = mine ? 5 : 10, hz = h[o + 2], hs = Math.sign(hz) || 1, sx = Math.sign(h[o]) || 1;
      sh.base = new THREE.Vector3(h[o] + sx * 0.85, TH + 0.14, hz - hs * 0.8);
    }
    _rp.copy(sh.base); fov = p.freeze > 0 ? lerp(RP.cam.fov, 19, Math.min(1, dt * 5)) : 30;
  } else if (sh.cam === 'chase') {                       // câmera de TV na lateral, correndo junto com a bola
    if (!sh.side) { const h0 = frameAt(c, c.tHit); sh.side = Math.sign(h0[1]) || 1; }
    const bz = clamp(f[3], -HL - 0.8, HL + 0.8), bx = clamp(f[1], -HW - 0.6, HW + 0.6);
    _rp.set(sh.side * (HW + 1.35) + bx * 0.25, TH + 0.5 + Math.max(0, f[2] - TH) * 0.35, bz * 0.85);
    ball.set(bx, clamp(f[2], TH - 0.05, TH + 1.2), bz); fov = 36;
  } else {                                               // comemoração: câmera gira em volta de quem fez o ponto
    const o = c.winner === S.mySide ? 5 : 10, cz = f[o + 2], a = p.el * 0.7;
    ball.set(f[o], f[o + 1] + 0.05, cz);
    _rp.set(f[o] + Math.sin(a) * 1.5, TH + 0.55, cz - Math.sign(cz) * Math.cos(a) * 1.5); fov = 42;
  }
  const k = RP.cam.snap ? 1 : Math.min(1, dt * (sh.cam === 'hit' ? 10 : sh.cam === 'chase' ? 3.2 : 5));
  RP.cam.pos.lerp(_rp, k); RP.cam.look.lerp(ball, RP.cam.snap ? 1 : Math.min(1, dt * (sh.cam === 'chase' ? 6 : 9)));
  if (RP.cam.pos.y < TH + 0.18) RP.cam.pos.y = TH + 0.18; RP.cam.fov = RP.cam.snap ? fov : lerp(RP.cam.fov, fov, Math.min(1, dt * 4));
  RP.cam.snap = false;
  camera.position.copy(RP.cam.pos); camera.lookAt(RP.cam.look);
  if (cam.shake > 0 && cfg.shake) { const s = cam.shake * cam.shake * 0.02; camera.position.x += (Math.random() - 0.5) * s; camera.position.y += (Math.random() - 0.5) * s; cam.shake = Math.max(0, cam.shake - dt * 3); }
  camera.fov = RP.cam.fov; camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
}
function flash() { const el = $('rpFlash'); el.classList.remove('go'); void el.offsetWidth; el.classList.add('go'); }

/* ---------- fogos de artifício (em todos os cenários; dentro do ginásio sobem menos) ---------- */
const FW = { rockets: [], light: new THREE.PointLight(0xffffff, 0, 40, 1.6), lt: 0 };
scene.add(FW.light);
const FW_COLORS = [0xff3d7f, 0xffd34d, 0x40e0ff, 0x9a5cff, 0x2fd16b, 0xff7a1a, 0xffffff];
function launchRocket() {
  const indoor = !A.fireworks, g = 6, fz = -(S.mySide || 1);      // sobem na frente da câmera (lado do adversário)
  const x = (Math.random() - 0.5) * (indoor ? 8 : 18);
  const z = fz * (indoor ? HL + 2.2 + Math.random() * 3 : 7 + Math.random() * 6);
  const y0 = indoor ? 0.3 : 1, top = indoor ? 2.4 + Math.random() * 1.2 : 5.5 + Math.random() * 3, vy = Math.sqrt(2 * g * (top - y0));
  FW.rockets.push({ p: [x, y0, z], v: [(Math.random() - 0.5) * 0.7, vy, (Math.random() - 0.5) * 0.7], life: vy / g, indoor, c1: pick(FW_COLORS), c2: pick(FW_COLORS) });
  if (actx) {                                            // assobio do foguete subindo
    const t = actx.currentTime, o = actx.createOscillator(), gn = actx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(2600, t + vy / g);
    gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(indoor ? 0.012 : 0.008, t + 0.08); gn.gain.exponentialRampToValueAtTime(0.0001, t + vy / g);
    o.connect(gn).connect(sfxBus); o.start(t); o.stop(t + vy / g + 0.05);
  }
}
function celebrate(intensity = 1) {
  const n = Math.round(3 + 9 * intensity);
  for (let i = 0; i < n; i++) setTimeout(() => { if (S.phase !== 'lobby') launchRocket(); }, i * 280 + Math.random() * 220);
}
function updateFireworks(dt) {
  for (let i = FW.rockets.length - 1; i >= 0; i--) {
    const r = FW.rockets[i];
    r.life -= dt; r.v[1] -= 6 * dt;
    for (let k = 0; k < 3; k++) r.p[k] += r.v[k] * dt;
    pyro.emit(2, r.p[0], r.p[1], r.p[2], 0xffd9a0, 0.12, { life: 0.35, grav: 0.6, drag: 2, intensity: 2 });
    if (r.life <= 0) {
      const big = !r.indoor;
      pyro.emit(big ? 100 : 75, r.p[0], r.p[1], r.p[2], r.c1, big ? 3.6 : 2.8, { life: 1.6, grav: 1.1, drag: 1.3, intensity: 3.2, rainbow: Math.random() < 0.25 });
      pyro.emit(big ? 45 : 35, r.p[0], r.p[1], r.p[2], r.c2, big ? 2.1 : 1.6, { life: 1.2, grav: 1.4, drag: 1.6, intensity: 2.8 });
      if (big) fwSolid.emit(110, r.p[0], r.p[1], r.p[2], r.c1, 3.4, { life: 1.7, grav: 1.1, drag: 1.3, intensity: 1.25, rainbow: Math.random() < 0.25 });
      FW.light.position.set(r.p[0], r.p[1], r.p[2]); FW.light.color.setHex(r.c1); FW.lt = big ? 1 : 0.6;
      boom(big ? 0.75 : 0.5);
      FW.rockets.splice(i, 1);
    }
  }
  FW.lt = Math.max(0, FW.lt - dt * 2.5);
  FW.light.intensity = FW.lt * FW.lt * (A.fireworks ? 40 : 10);
}

/* ---------- fim da partida: comemoração, volta da câmera, melhores momentos e resumo ---------- */
const END = { active: false, t: 0, won: false, stage: '', list: [], idx: 0, skipAll: false };
function endSequence(won) {
  recFinish();
  Object.assign(END, { active: true, t: 0, won, stage: 'party', list: pickHighlights(), idx: 0, skipAll: false });
  if (won && !S.tutorial) {
    $('rpUI').classList.remove('hidden'); $('rpTitle').textContent = '🏆 VITÓRIA'; $('rpCap').textContent = ''; $('rpSpeed').textContent = ''; $('rpSkip').textContent = 'Continuar ⏭';
    document.body.classList.add('replaying'); startVictory(); return;
  }
  showBanner(won ? 'VITÓRIA!' : 'FIM DE JOGO', won ? 'mandou muito! 🏆' : `${oppLabel()} levou essa`, won ? 'win' : 'lose', 3300);
  fxWin(won); celebrate(1.3); setTimeout(() => { if (END.active) celebrate(0.8); }, 1700);
  $('rpUI').classList.remove('hidden'); $('rpTitle').textContent = won ? '🏆 VITÓRIA' : 'FIM DE JOGO'; $('rpCap').textContent = '';
  $('rpSpeed').textContent = ''; $('rpSkip').textContent = 'Ver resultado ⏭';
  document.body.classList.add('replaying');
}
function pickHighlights() {
  const mine = RP.clips.filter(c => c.winner === S.mySide && c.score >= 2.5);
  const rest = RP.clips.filter(c => !mine.includes(c) && c.score >= 4.5);
  return [...mine, ...rest].slice(0, 2);
}
function endStep(dt) {
  if (!END.active || RP.play) return;
  END.t += dt;
  if (END.stage === 'party' || END.stage === 'victory') {   // câmera dá uma volta lenta pela arena
    const sd = S.mySide || 1, a = Math.sin(END.t * 0.35) * 0.9, k = Math.min(1, END.t / 3.6);
    camera.position.set(Math.sin(a) * 2.6, TH + 1.25 - k * 0.35, sd * (HL + 2.9 - k * 0.6));   // câmera vem chegando e balança devagar
    camera.lookAt(0, A.fireworks ? TH + 2.0 : TH + 0.9, -sd * 2.5); camera.fov = 52; camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    if (END.stage === 'party' && (END.t > 3.6 || END.skipAll)) nextHighlight();
  }
}
function nextHighlight() {
  if (END.skipAll || !cfg.replays || END.idx >= END.list.length) { finishEnd(); return; }
  END.stage = 'hl';
  const c = END.list[END.idx++];
  startReplay(c, { mode: 'highlight', title: `⭐ MELHORES MOMENTOS ${END.idx}/${END.list.length}`, onEnd: () => { if (END.active) nextHighlight(); } });
}
function finishEnd() {
  END.active = false; END.stage = '';
  if (RP.play) endReplay(false);
  document.body.classList.remove('replaying'); $('rpUI').classList.add('hidden');
  if (S.phase === 'over') { $('over').classList.remove('hidden'); releaseMouse(); }
  updateLockUI();
}
function stopEnd() { if (typeof hideWin === 'function') { hideWin(); clearTimeout(VIC.timer); } END.active = false; END.stage = ''; if (RP.play) endReplay(false); document.body.classList.remove('replaying'); $('rpUI').classList.add('hidden'); }

/* ---------- telas do replay, faixa de anúncio e placar de games ---------- */
let bannerTimer = 0;
function showBanner(big, small, kind, ms = 3000) {
  const el = $('bigBanner'); el.className = 'show ' + (kind || '');
  el.innerHTML = ''; const b = document.createElement('b'); b.textContent = big; el.appendChild(b);
  if (small) { const s = document.createElement('span'); s.textContent = small; el.appendChild(s); }
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function initReplayUI() {
  const st = document.createElement('style');
  st.textContent = `
  #rpUI { position: fixed; inset: 0; pointer-events: none; z-index: 25; }
  #rpUI .bar { position: absolute; left: 0; right: 0; height: 9vh; background: #000; }
  #rpUI .bar.t { top: 0; } #rpUI .bar.b { bottom: 0; }
  #rpUI .badge { position: absolute; top: calc(9vh + 14px); left: 18px; display: flex; align-items: center; gap: 8px; font: italic 900 22px system-ui; letter-spacing: .06em; color: #fff; text-shadow: 0 2px 10px rgba(0,0,0,.6); }
  #rpUI .badge::before { content: ''; width: 12px; height: 12px; border-radius: 50%; background: #ff2a55; box-shadow: 0 0 12px #ff2a55; animation: rpBlink 1s infinite; }
  #rpUI .speed { position: absolute; top: calc(9vh + 18px); right: 18px; font: 800 14px system-ui; color: #ffd34d; letter-spacing: .08em; text-shadow: 0 2px 8px rgba(0,0,0,.7); }
  #rpUI .cap { position: absolute; bottom: calc(9vh + 16px); left: 50%; transform: translateX(-50%); font: 800 17px system-ui; color: #fff; background: rgba(0,0,0,.55); padding: 8px 16px; border-radius: 999px; white-space: nowrap; max-width: 92vw; overflow: hidden; text-overflow: ellipsis; }
  #rpUI .cap:empty { display: none; }
  #rpSkip { position: absolute; bottom: calc(9vh - 46px); right: 18px; pointer-events: auto; border: 1px solid rgba(255,255,255,.3); background: rgba(255,255,255,.12); color: #fff; font: 800 14px system-ui; padding: 8px 14px; border-radius: 999px; cursor: pointer; }
  #rpSkip:hover { background: rgba(255,79,139,.5); }
  #rpFlash { position: fixed; inset: 0; background: #fff; opacity: 0; pointer-events: none; z-index: 26; }
  #rpFlash.go { animation: rpFlash .35s ease-out; }
  @keyframes rpFlash { from { opacity: .75; } to { opacity: 0; } }
  @keyframes rpBlink { 50% { opacity: .25; } }
  body.replaying #board, body.replaying #tag, body.replaying #streak, body.replaying #qcHint, body.replaying #ping, body.replaying #fmtTag, body.replaying #msg { visibility: hidden; }
  #bigBanner { position: fixed; left: 50%; top: 38%; transform: translate(-50%, -50%) scale(.6); opacity: 0; z-index: 27; pointer-events: none; text-align: center; transition: opacity .25s, transform .35s cubic-bezier(.2,1.6,.4,1); }
  #bigBanner.show { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  #bigBanner b { display: block; font: italic 900 clamp(44px, 9vw, 110px) system-ui; letter-spacing: .02em; color: #fff; text-shadow: 0 0 30px rgba(255,61,127,.9), 0 6px 0 rgba(0,0,0,.35); white-space: nowrap; }
  #bigBanner.win b { background: linear-gradient(180deg, #fff6c2, #ffd34d 55%, #ff9a3c); -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; filter: drop-shadow(0 0 22px rgba(255,200,60,.8)) drop-shadow(0 5px 0 rgba(0,0,0,.35)); }
  #bigBanner.lose b { color: #e8e2ff; text-shadow: 0 0 24px rgba(120,100,255,.7), 0 5px 0 rgba(0,0,0,.35); }
  #bigBanner span { display: inline-block; margin-top: 8px; font: 800 18px system-ui; color: #fff; background: rgba(0,0,0,.5); padding: 6px 14px; border-radius: 999px; }
  .team .gms { display: inline-flex; gap: 3px; margin: 0 6px; vertical-align: middle; }
  .team .gms i { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid rgba(255,255,255,.6); }
  .team .gms i.on { background: #ffd34d; border-color: #ffd34d; box-shadow: 0 0 8px #ffd34d; }
  #fmtTag { position: absolute; top: 58px; left: 50%; transform: translateX(-50%); font: 900 11px system-ui; letter-spacing: .16em; color: rgba(255,255,255,.75); text-shadow: 0 1px 6px rgba(0,0,0,.7); }`;
  document.head.appendChild(st);
  const ui = document.createElement('div'); ui.id = 'rpUI'; ui.className = 'hidden';
  ui.innerHTML = '<div class="bar t"></div><div class="bar b"></div><div class="badge" id="rpTitle">REPLAY</div><div class="speed" id="rpSpeed"></div><div class="cap" id="rpCap"></div><button id="rpSkip">Pular ⏭</button>';
  document.body.appendChild(ui);
  const fl = document.createElement('div'); fl.id = 'rpFlash'; document.body.appendChild(fl);
  const bn = document.createElement('div'); bn.id = 'bigBanner'; document.body.appendChild(bn);
  const nmL = document.querySelector('#board .team.me .nm'), nmR = document.querySelector('#board .team.op .nm');
  if (nmL) { const g = document.createElement('span'); g.className = 'gms'; g.id = 'gmsL'; nmL.after(g); }
  if (nmR) { const g = document.createElement('span'); g.className = 'gms'; g.id = 'gmsR'; nmR.before(g); }
  const ft = document.createElement('div'); ft.id = 'fmtTag'; $('hud').appendChild(ft);
  $('rpSkip').onclick = () => { if (END.stage === 'victory') { finishVictory(); return; } if (RP.play) skipReplay(); else if (END.active) { END.skipAll = true; finishEnd(); } };
  window.addEventListener('keydown', e => {
    if (e.code !== 'Space' && e.key !== 'Escape') return;
    if (!RP.play && !END.active) return;
    e.preventDefault(); $('rpSkip').click();
  });
}
initReplayUI();

/* =====================================================================
   SENSAÇÃO DO GOLPE, CPU POR NÍVEL, AJUDA DE QUIQUE, PROGRESSO E TUTORIAL
   ===================================================================== */

/* ---------- acerto de tempo: PERFEITO / CEDO / NA PONTA ---------- */
// velocidade do gesto para cima agora e o pico nos últimos 0,3 s (janelas de 40 ms)
function swingPeakUp() {
  const h = pointer.hist, now = performance.now() / 1000, k = cfg.sensSwing || 1;
  let peak = 0, cur = null;
  for (let i = h.length - 1; i > 0; i--) {
    const a = h[i]; if (now - a.t > 0.3) break;
    let j = i - 1; while (j > 0 && a.t - h[j].t < 0.04) j--;
    const dt = a.t - h[j].t; if (dt <= 0.008) continue;
    const v = -(a.hy - h[j].hy) / dt * k;
    if (cur === null) cur = v;
    peak = Math.max(peak, v);
  }
  return { peak, cur: cur || 0 };
}
function hitQuality(sv, serve) {
  if (serve) return { q: 0, tag: '' };
  const off = Math.abs(S.ball.p[0] - me.x);
  if (off > 0.2) return { q: -1, tag: 'NA PONTA' };              // pegou na ponta da raquete: sai torta
  if (sv.up > 0.6) {                                             // um golpe de verdade (força ~0,3 ou mais)
    const { peak, cur } = swingPeakUp(), r = peak > 0 ? cur / peak : 1;
    if (r >= 0.85 && off < 0.11) return { q: 1, tag: 'PERFEITO!' }; // bola no meio e gesto no auge
    if (peak > 1.2 && r < 0.45) return { q: 0, tag: 'CEDO' };      // o gesto já tinha passado
  }
  return { q: 0, tag: '' };
}
let qTimer = 0;
function showQuality(tag, mine = true) {
  if (!tag) return;
  const el = $('qLabel'); if (!el) return;
  el.textContent = mine ? tag : `${tag} (${oppLabel()})`;
  el.className = 'show ' + (tag === 'PERFEITO!' ? 'perfect' : 'meh');
  clearTimeout(qTimer); qTimer = setTimeout(() => { el.className = ''; }, 800);
  if (tag === 'PERFEITO!' && actx) {                    // "plim" suave
    tone(1568, 0.22, 0.035, 'sine'); tone(2349, 0.3, 0.025, 'sine', 0.04);
  }
}
// trava a física por uma fração de segundo no impacto (peso do golpe)
let hitStop = 0;
function feelHit(side, label, q) {
  const mine = side === S.mySide;
  if (label === 'SMASH!' || q > 0) {
    hitStop = Math.max(hitStop, label === 'SMASH!' ? 0.07 : 0.045);
    if (mine) { cam.shake = Math.max(cam.shake, label === 'SMASH!' ? 0.45 : 0.22); try { navigator.vibrate && navigator.vibrate(label === 'SMASH!' ? 28 : 14); } catch (e) { } }
  }
}

/* ---------- CPU: 4 níveis e 3 estilos ---------- */
const BOT_LV = {
  facil: { name: 'Fácil', maxV: 1.6, react: [0.22, 0.14], aim: 0.42, pw: [0.3, 0.45], err: 0.12, wide: 0.06, chop: 0.08, side: 0.15, predErr: 0.22, smash: 0, xp: 0.6 },
  medio: { name: 'Médio', maxV: 2.3, react: [0.12, 0.1], aim: 0.58, pw: [0.4, 0.55], err: 0.05, wide: 0.04, chop: 0.12, side: 0.3, predErr: 0.1, smash: 0.08, xp: 1 },
  dificil: { name: 'Difícil', maxV: 3.0, react: [0.07, 0.06], aim: 0.68, pw: [0.55, 0.5], err: 0.03, wide: 0.025, chop: 0.14, side: 0.4, predErr: 0.05, smash: 0.25, xp: 1.3 },
  pro: { name: 'Pro', maxV: 3.8, react: [0.04, 0.04], aim: 0.74, pw: [0.7, 0.45], err: 0.015, wide: 0.012, chop: 0.16, side: 0.5, predErr: 0.03, smash: 0.4, xp: 1.6 },
};
const BOT_STYLES = {
  equilibrado: { name: 'Equilibrado', pw: 1, chop: 1, err: 1, smash: 0, side: 1 },
  defensor: { name: 'Defensor', pw: 0.75, chop: 2.5, err: 0.6, smash: -0.1, side: 0.8 },
  atacante: { name: 'Atacante', pw: 1.2, chop: 0.5, err: 1.5, smash: 0.15, side: 1.2 },
};
let botStyle = 'equilibrado';
const botLv = () => BOT_LV[pickState.diff] || BOT_LV.medio;

/* ---------- ajuda: mostra onde a bola vai quicar do seu lado ---------- */
const landMark = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.05, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
landMark.rotation.x = -Math.PI / 2; landMark.visible = false; scene.add(landMark);
function predictLanding() {
  landMark.visible = false;
  if (!(cfg.assist || S.tutorial) || S.rally.hitter !== -S.mySide) return;
  const b = { p: [...S.ball.p], v: [...S.ball.v], w: [...S.ball.w] };
  for (let i = 0; i < 700; i++) {
    const ev = []; stepBall(b, DT, ev, true);
    const t = ev.find(e => e.t === 'table');
    if (t) { if (t.z * S.mySide > 0) { landMark.position.set(t.x, TH + 0.004, t.z); landMark.visible = true; landMark.material.color.copy(trailColor); } return; }
    if (b.p[1] < TH - 0.3) return;
  }
}
function updateLandMark(t) {
  if (!landMark.visible) return;
  if (S.phase !== 'rally' || S.rally.rb > 0 || S.rally.hitter !== -S.mySide) { landMark.visible = false; return; }
  const k = 0.5 + 0.5 * Math.sin(t * 10);
  landMark.material.opacity = 0.35 + k * 0.35; landMark.scale.setScalar(1 + k * 0.25);
}

/* ---------- progresso: nível, XP, missões do dia e bolinhas por nível ---------- */
const MISSIONS = [
  { id: 'smash3', t: 'Faça 3 smashes', ev: 'smash', need: 3, xp: 120 },
  { id: 'perf5', t: 'Acerte 5 batidas PERFEITAS', ev: 'perfect', need: 5, xp: 150 },
  { id: 'win1', t: 'Vença 1 partida', ev: 'win', need: 1, xp: 150 },
  { id: 'rally10', t: 'Ganhe um ponto num rally de 10 batidas', ev: 'rally10', need: 1, xp: 120 },
  { id: 'curve3', t: 'Faça 3 pontos com curva', ev: 'curvept', need: 3, xp: 120 },
  { id: 'play3', t: 'Jogue 3 partidas', ev: 'match', need: 3, xp: 100 },
  { id: 'ace2', t: 'Faça 2 aces de saque', ev: 'ace', need: 2, xp: 130 },
  { id: 'chop5', t: 'Acerte 5 cortes', ev: 'chop', need: 5, xp: 100 },
  { id: 'hard1', t: 'Vença a CPU no Difícil ou no Pro', ev: 'winhard', need: 1, xp: 250 },
  { id: 'online1', t: 'Jogue 1 partida online', ev: 'online', need: 1, xp: 150 },
];
const SKIN_LV = { branca: 1, laranja: 1, preta: 2, rosa: 3, amarela: 4, verde: 5, azul: 6, roxa: 8, dourada: 10, arcoiris: 15 };
const lvNeed = l => 200 + 100 * (l - 1);
function levelOf(xp) { let l = 1, rest = xp; while (rest >= lvNeed(l) && l < 999) { rest -= lvNeed(l); l++; } return { lvl: l, cur: rest, need: lvNeed(l) }; }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const prog = (() => { try { return JSON.parse(store.get('pp_prog', '{}')) || {}; } catch (e) { return {}; } })();
prog.xp = prog.xp | 0; prog.m = prog.m || {};
function saveProg() { store.set('pp_prog', JSON.stringify(prog)); }
function dailyMissions() {
  const d = today();
  if (prog.day !== d) {                                  // sorteia 3 missões pelo dia (iguais o dia todo)
    let h = 0; for (const c of d) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const pool = MISSIONS.map(m => m.id), pickd = [];
    while (pickd.length < 3) { h = (h * 1103515245 + 12345) >>> 0; const i = h % pool.length; pickd.push(pool.splice(i, 1)[0]); }
    prog.day = d; prog.m = Object.fromEntries(pickd.map(id => [id, 0])); prog.paid = []; saveProg();
  }
  return Object.keys(prog.m).map(id => ({ ...MISSIONS.find(m => m.id === id), n: prog.m[id], paid: (prog.paid || []).includes(id) }));
}
const skinLocked = sk => !isVip() && levelOf(prog.xp).lvl < (SKIN_LV[sk.id] || 1);
window.__feelReady = true;
const matchStats = { perfect: 0, xpMissions: 0 };
function progEvent(ev, n = 1) {
  if (S.tutorial || !S.mode) return;
  if (ev === 'perfect') matchStats.perfect++;
  for (const m of dailyMissions()) {
    if (m.ev !== ev || m.paid) continue;
    prog.m[m.id] = Math.min(m.need, (prog.m[m.id] || 0) + n);
    if (prog.m[m.id] >= m.need) { prog.paid = [...(prog.paid || []), m.id]; matchStats.xpMissions += m.xp; toast(`✅ Missão: ${m.t} · +${m.xp} XP`); }
  }
  saveProg();
}
function addXp(n, why) {
  const before = levelOf(prog.xp).lvl;
  prog.xp += Math.max(0, Math.round(n)); saveProg();
  const after = levelOf(prog.xp).lvl;
  if (after > before) {
    const sk = BALL_SKINS.filter(s => (SKIN_LV[s.id] || 1) > before && (SKIN_LV[s.id] || 1) <= after).map(s => s.name);
    setTimeout(() => { toast(`⬆️ Nível ${after}!${sk.length ? ` Nova bolinha: ${sk.join(', ')}` : ''}`); crowdReact('point', 0.7); }, 1200);
  }
  if (acct.user) rpc('sync_xp', { p_xp: prog.xp }).catch(() => { });
  renderProgress();
  return { before, after };
}
function matchXp(won) {
  const pts = S.gameScores.reduce((a, g) => a + g[String(S.mySide)], 0);
  let mult = S.mode === 'solo' ? botLv().xp : S.ranked ? 1.4 : 1.2;
  const base = (won ? 100 : 40) + pts * 2 + matchStats.perfect * 3;
  return Math.round(base * mult) + matchStats.xpMissions;
}
function renderProgress() {
  const el = $('progCard'); if (!el) return;
  const L = levelOf(prog.xp), ms = dailyMissions();
  $('pgLvl').textContent = `Nível ${L.lvl}`;
  $('pgXp').textContent = `${L.cur} / ${L.need} XP`;
  $('pgBar').style.width = `${Math.round(L.cur / L.need * 100)}%`;
  const list = $('pgMis'); list.textContent = '';
  for (const m of ms) list.append(h('div', { class: 'pg-m' + (m.paid ? ' done' : '') },
    h('span', { text: (m.paid ? '✅ ' : '🎯 ') + m.t }), h('b', { text: m.paid ? `+${m.xp}` : `${m.n}/${m.need}` })));
  if (typeof renderPick === 'function') renderPick();
  if (window.__futReady) renderTopProfile();
}
// resultado no fim: XP ganho e barra de nível
function overXp(won) {
  if (S.tutorial) return;
  progEvent('match'); if (won) progEvent('win');
  if (won && S.mode === 'solo' && (pickState.diff === 'dificil' || pickState.diff === 'pro')) progEvent('winhard');
  if (S.mode === 'online') progEvent('online');
  const gain = matchXp(won), r = addXp(gain), L = levelOf(prog.xp);
  const el = $('overXp');
  if (el) {
    el.textContent = '';
    el.append(h('div', { class: 'ox-t' }, `+${gain} XP`, r.after > r.before ? h('b', { text: ` · subiu para o nível ${r.after}!` }) : null),
      h('div', { class: 'ox-bar' }, h('i', { style: `width:${Math.round(L.cur / L.need * 100)}%` })), h('small', { text: `Nível ${L.lvl} · ${L.cur}/${L.need} XP` }));
  }
  matchStats.perfect = 0; matchStats.xpMissions = 0;
}

/* ---------- tutorial guiado (1 minuto) ---------- */
const TUT = [
  { k: 'move', title: 'Mover', text: 'Mova o mouse (ou o dedo): a raquete acompanha. Leve a raquete de um lado ao outro da mesa.', need: 1 },
  { k: 'hit', title: 'Rebater', text: 'Quando a bola chegar, faça um movimento rápido PARA CIMA. Devolva 3 bolas na mesa.', need: 3 },
  { k: 'side', title: 'Curva', text: 'Puxe para cima E para o lado na hora da batida: a bola faz curva. Acerte 2 com curva.', need: 2, label: 'SIDE-SPIN' },
  { k: 'chop', title: 'Corte', text: 'Puxe a raquete PARA TRÁS (para baixo) na batida: é o corte. Acerte 2 cortes.', need: 2, label: 'CORTE' },
  { k: 'smash', title: 'Smash', text: 'Bola alta? Gesto bem rápido para cima. Acerte 1 smash.', need: 1, label: 'SMASH!', feed: 'high' },
  { k: 'perfect', title: 'Tempo certo', text: 'Bata com a bola no MEIO da raquete, com o gesto no auge: aparece PERFEITO. Consiga 1.', need: 1, q: 'PERFEITO!' },
  { k: 'serve', title: 'Saque', text: 'Agora é você: leve a raquete até a bola e puxe para cima. Acerte 2 saques na mesa.', need: 2, serve: true },
];
function startTutorial() {
  ensureAudio(); cleanupNet();
  startGame('solo', 1, 1); enterPlayMode();
  S.tutorial = { i: 0, n: 0, minX: 9, maxX: -9 };
  document.body.classList.add('tutorial');
  renderTutorial();
}
function renderTutorial() {
  const el = $('tutUI'); if (!el) return;
  if (!S.tutorial) { el.classList.add('hidden'); return; }
  const st = TUT[S.tutorial.i];
  el.classList.remove('hidden');
  $('tutStep').textContent = `PASSO ${S.tutorial.i + 1}/${TUT.length} · ${st.title.toUpperCase()}`;
  $('tutText').textContent = st.text;
  $('tutDots').innerHTML = Array.from({ length: st.need }, (_, i) => `<i class="${i < S.tutorial.n ? 'on' : ''}"></i>`).join('');
}
function tutProgress(ok, hint) {
  const T = S.tutorial; if (!T) return;
  if (!ok) { if (hint) showMsg('Quase!', hint); return; }
  T.n++;
  tone(1046, 0.12, 0.04, 'sine'); tone(1568, 0.16, 0.03, 'sine', 0.08);
  if (T.n >= TUT[T.i].need) {
    T.i++; T.n = 0;
    if (T.i >= TUT.length) { finishTutorial(); return; }
    showMsg('Boa!', `Próximo: ${TUT[T.i].title}`); crowdReact('point', 0.6);
  }
  renderTutorial();
}
function finishTutorial() {
  const first = store.get('pp_tut', '0') !== '1';
  store.set('pp_tut', '1');
  S.tutorial = null; document.body.classList.remove('tutorial'); renderTutorial();
  showBanner('TUTORIAL COMPLETO!', first ? '+200 XP · agora encare a CPU' : 'mandou bem!', 'win', 3500);
  celebrate(0.8); crowdReact('point', 1);
  if (first) addXp(200);
  setTimeout(() => { if (S.mode === 'solo' && !S.tutorial) goMenu(); }, 3800);
}
function tutTick() {                                    // passo "mover": precisa cruzar a mesa
  const T = S.tutorial; if (!T || TUT[T.i].k !== 'move') return;
  T.minX = Math.min(T.minX, me.x); T.maxX = Math.max(T.maxX, me.x);
  if (T.maxX - T.minX > 0.9) tutProgress(true);
}
// a CPU só alimenta bolas no tutorial (não devolve)
function tutFeed() {
  const sd = sideOfBot(), st = TUT[S.tutorial.i];
  const B = [bot.x, TH + 0.18, sd * (HL + 0.2)];
  const tx = clamp(me.x + (Math.random() - 0.5) * 0.25, -0.5, 0.5), tz = -sd * (HL - 0.45 - Math.random() * 0.25);
  const T = st.feed === 'high' ? 1.45 : 1.05, g = 9.81;
  const v = [(tx - B[0]) / T, ((BALL_Y - B[1]) + 0.5 * g * T * T) / T * (st.feed === 'high' ? 0.92 : 0.86), (tz - B[2]) / T];
  applyHit(sd, B, { v, w: [0, 0, 0], label: 'SAQUE' }, false);
  bot.lunge = 0.15;
}
function tutPoint(winner, reason) {
  const T = S.tutorial, st = TUT[T.i];
  S.score = { '1': 0, '-1': 0 };
  if (st.k === 'move') return;
  if (winner === S.mySide && reason === 'miss') {
    if (st.label && S.lastLabel !== st.label) return tutProgress(false, st.k === 'side' ? 'Puxe para cima e para o lado ao mesmo tempo' : st.k === 'chop' ? 'Puxe a raquete para baixo, para trás' : 'Gesto mais rápido na bola alta');
    if (st.q && S.lastQ !== st.q) return tutProgress(false, 'Bola no meio da raquete e gesto no auge');
    return tutProgress(true);
  }
  tutProgress(false, st.serve ? 'Raquete atrás da bola e puxe para cima' : 'Puxe para cima quando a bola chegar');
}

/* ---------- telas: rótulo de qualidade, tutorial, progresso, nível da CPU ---------- */
function initFeelUI() {
  const st = document.createElement('style');
  st.textContent = `
  #qLabel { position: fixed; left: 50%; top: 58%; transform: translate(-50%, -50%) scale(.7); opacity: 0; pointer-events: none; z-index: 12; font: italic 900 26px system-ui; letter-spacing: .06em; transition: opacity .15s, transform .25s cubic-bezier(.2,1.8,.4,1); }
  #qLabel.show { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  #qLabel.perfect { color: #ffe27a; text-shadow: 0 0 18px rgba(255,200,60,.9), 0 3px 0 rgba(0,0,0,.35); font-size: 32px; }
  #qLabel.meh { color: rgba(255,255,255,.75); text-shadow: 0 2px 8px rgba(0,0,0,.7); font-size: 18px; }
  #tutUI { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 14; width: min(560px, 94vw); background: rgba(16,10,22,.88); border: 1px solid rgba(255,211,77,.35); border-radius: 16px; padding: 10px 14px; text-align: center; }
  #tutUI.hidden { display: none; }
  #tutStep { font: 900 12px system-ui; letter-spacing: .14em; color: #ffd34d; }
  #tutText { font-size: 15px; font-weight: 700; margin: 4px 0 6px; line-height: 1.35; }
  #tutDots { display: inline-flex; gap: 6px; } #tutDots i { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(255,255,255,.5); }
  #tutDots i.on { background: #2fd16b; border-color: #2fd16b; box-shadow: 0 0 10px #2fd16b; }
  #tutSkip { position: absolute; right: 10px; top: 8px; border: 0; background: none; color: rgba(255,255,255,.6); font-size: 12px; font-weight: 800; cursor: pointer; }
  body.tutorial #board, body.tutorial #fmtTag, body.tutorial #tag, body.tutorial #streak { visibility: hidden; }
  .prog { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 10px 12px; margin-bottom: 10px; text-align: left; }
  .pg-top { display: flex; align-items: baseline; justify-content: space-between; } .pg-top b { font-size: 16px; } .pg-top small { opacity: .7; font-weight: 700; }
  .pg-bar { height: 7px; border-radius: 999px; background: rgba(255,255,255,.1); overflow: hidden; margin: 6px 0 8px; } .pg-bar i { display: block; height: 100%; background: linear-gradient(90deg, #ff4f8b, #ffd34d); border-radius: 999px; }
  .pg-m { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; padding: 3px 0; } .pg-m b { color: #ffd34d; } .pg-m.done { opacity: .55; }
  .tut-btn { margin-top: 0; } .tut-btn.new { box-shadow: 0 0 0 2px #ffd34d, 0 0 18px rgba(255,211,77,.45); }
  .bs.lock { opacity: .35; filter: grayscale(.6); position: relative; } .bs.lock::after { content: '🔒'; position: absolute; inset: 0; display: grid; place-items: center; font-size: 12px; filter: none; }
  #overXp { margin: 8px 0 4px; } #overXp:empty { display: none; }
  .ox-t { font-weight: 900; color: #ffd34d; } .ox-t b { color: #2fd16b; }
  .ox-bar { height: 8px; border-radius: 999px; background: rgba(255,255,255,.1); overflow: hidden; margin: 6px 0 3px; } .ox-bar i { display: block; height: 100%; background: linear-gradient(90deg, #ff4f8b, #ffd34d); transition: width 1.2s ease; }
  #overXp small { opacity: .7; font-size: 12px; }`;
  document.head.appendChild(st);
  document.body.append(h('div', { id: 'qLabel' }));
  const skip = h('button', { id: 'tutSkip', text: 'Pular tutorial ✕' }); skip.onclick = () => { S.tutorial = null; document.body.classList.remove('tutorial'); renderTutorial(); goMenu(); };
  document.body.append(h('div', { id: 'tutUI', class: 'hidden' }, skip, h('div', { id: 'tutStep' }), h('div', { id: 'tutText' }), h('div', { id: 'tutDots' })));
  // menu: botão do tutorial, cartão de progresso e nível da CPU
  const tb = h('button', { class: 'btn ghost tut-btn' + (store.get('pp_tut', '0') === '1' ? '' : ' new'), id: 'btnTut', text: store.get('pp_tut', '0') === '1' ? '🎓 Tutorial (1 min)' : '🎓 Novo aqui? Faça o tutorial (1 min)' });
  tb.onclick = startTutorial;
  $('btnSolo').after(tb);
  const pc = h('div', { class: 'prog', id: 'progCard' },
    h('div', { class: 'pg-top' }, h('b', { id: 'pgLvl' }), h('small', { id: 'pgXp' })),
    h('div', { class: 'pg-bar' }, h('i', { id: 'pgBar' })),
    h('div', { class: 'lo-t', text: 'MISSÕES DE HOJE' }), h('div', { id: 'pgMis' }));
  $('menu').prepend(pc);
  const seg = h('div', { class: 'seg', id: 'diffSeg' }, ...Object.entries(BOT_LV).map(([k, v]) => h('button', { 'data-d': k }, v.name, h('small', { text: `XP ×${v.xp}` }))));
  const fmt = $('fmtSeg');
  if (fmt) fmt.after(h('div', { class: 'lo-t', text: 'CPU (TREINO)' }), seg);
  seg.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; pickState.diff = b.dataset.d; store.set('pp_diff', pickState.diff); renderPick(); });
  const ov = $('overScore'); if (ov) ov.after(h('div', { id: 'overXp' }));
  renderProgress();
}

/* =====================================================================
   MODO TELESPECTADOR
   Quem cria a sala (anfitrião) transmite a partida para quem entrar pelo link
   "assistir" (?ver=CÓDIGO): posição da bola e das raquetes ~30 vezes por segundo,
   batidas, pontos e placar. O espectador só assiste (câmeras de TV) e pode mandar
   reações (👏 🔥 😮 😂) que aparecem para todo mundo.
   ===================================================================== */
const SPEC_MAX = 12;
const specs = [];                                    // anfitrião: conexões dos espectadores
let specConn = null, specLastSnap = 0, specLastState = 0;
const SPV = { buf: [], cam: 'tv', camT: 0, host: null, guest: null, over: false, pos: new THREE.Vector3(), look: new THREE.Vector3(), snapCam: true };
const SPEC_CAMS = [['tv', '📺 TV'], ['p1', '🎯 Atrás de'], ['p2', '🎯 Atrás de'], ['top', '🚁 Aérea']];
const specLink = code => `${location.origin}${location.pathname}?ver=${code}`;
const specOut = m => { for (const c of specs) if (c.open) { try { c.send(m); } catch (e) { } } };

/* ---------- lado do anfitrião ---------- */
function addSpectator(c) {
  if (!isHost || specs.length >= SPEC_MAX) { c.on('open', () => { try { c.send({ t: 'sfull' }); } catch (e) { } setTimeout(() => c.close(), 300); }); return; }
  c.on('open', () => { specs.push(c); try { c.send(specInit()); } catch (e) { } specCountChanged(); });
  c.on('data', m => { if (m && m.t === 'cheer' && CHEERS.includes(m.e)) { showCheer(m.e); send({ t: 'cheer', e: m.e }); specOut({ t: 'cheer', e: m.e }); } });
  const gone = () => { const i = specs.indexOf(c); if (i >= 0) { specs.splice(i, 1); specCountChanged(); } };
  c.on('close', gone); c.on('error', gone);
}
function specInit() {
  return {
    t: 'sinit', arena: A.id, fmt: S.format, phase: S.phase,
    host: { rk: myRacket.id, tag: myTag(), sk: mySkinFor(myRacket), name: acct.profile ? acct.profile.name : (myTag() || 'Jogador 1') },
    guest: conn ? { rk: oppRacket.id, tag: oppTag, sk: oppSkin, name: S.oppName || oppTag || 'Jogador 2' } : null,
    score: S.score, games: S.games, gameNo: S.gameNo, gameScores: S.gameScores, ranked: !!S.ranked,
  };
}
function specInitAll() { if (isHost && specs.length) { specOut(specInit()); send({ t: 'specs', n: specs.length }); } }
function specCountChanged() { send({ t: 'specs', n: specs.length }); showSpecCount(specs.length); }
function specTick(now) {
  if (!isHost || !specs.length) return;
  if (S.mode !== 'online') { if (now - specLastState > 2000) { specLastState = now; specOut({ t: 'sping' }); } return; }   // sala esperando: avisa que está viva
  if (now - specLastSnap > 33) {
    specLastSnap = now;
    const r3 = a => a.map(v => +v.toFixed(3));
    specOut({ t: 'snap', ph: S.phase, v: S.ballVisible ? 1 : 0, b: r3(S.ball.p), h: r3([me.x, me.y, me.z]), g: r3([opp.x, opp.y, opp.z]), c: trailColor.getHex() });
  }
  if (now - specLastState > 1000) { specLastState = now; specOut({ t: 'sstate', score: S.score, games: S.games, gameNo: S.gameNo, gameScores: S.gameScores, fmt: S.format }); }
}
function specEv(k, p, s, ex) { if (isHost && specs.length) specOut({ t: 'sev', k, p: p.map(v => +v.toFixed(3)), s: +(+s).toFixed(3), ...ex }); }

/* ---------- reações (👏 🔥 😮 😂) ---------- */
const CHEERS = ['👏', '🔥', '😮', '😂'];
function showCheer(e) {
  const el = document.createElement('div'); el.className = 'cheer'; el.textContent = e;
  el.style.left = (70 + Math.random() * 22) + '%';
  document.body.appendChild(el); setTimeout(() => el.remove(), 2200);
  crowd.excite = Math.min(1, crowd.excite + 0.05);
}
function showSpecCount(n) {
  const el = $('specCount'); if (!el) return;
  el.textContent = n > 0 ? `👀 ${n} assistindo` : ''; el.classList.toggle('hidden', !n);
}

/* ---------- lado do espectador ---------- */
function joinSpectate(code) {
  if (typeof Peer === 'undefined') { lobbyMsg('Não carregou a biblioteca de rede. Recarregue a página.'); return; }
  code = (code || '').trim().toUpperCase();
  if (code.length < 4) { lobbyMsg('Digite o código da sala que você quer assistir.'); return; }
  cleanupNet(); isHost = false;
  showPanel('joining'); $('joinTxt').textContent = `Entrando para assistir a sala ${code}…`; lobbyMsg('');
  peer = new Peer({ debug: 1 });
  peer.on('open', () => {
    const c = peer.connect(PEER_PREFIX + code, { metadata: { spec: true }, reliable: true });
    specConn = c;
    const to = setTimeout(() => { if (S.mode !== 'spec') { cleanupNet(); showPanel('menu'); lobbyMsg('Não achei essa partida. Confira o código ou peça um link novo.'); } }, 12000);
    c.on('data', m => { if (m && m.t === 'sinit') clearTimeout(to); onSpecMsg(m); });
    c.on('close', () => { if (S.mode === 'spec') { goMenu(); lobbyMsg('A transmissão terminou.'); } });
    c.on('error', () => { });
  });
  peer.on('error', e => { if (S.mode !== 'spec') { showPanel('menu'); lobbyMsg(e && e.type === 'peer-unavailable' ? 'Partida não encontrada. Confira o código (ou peça um link novo).' : netErrorText(e)); } });
}
function startSpectating(m) {
  if (m.arena && arenaById(m.arena).id !== A.id) buildArena(m.arena);
  S.mode = 'spec'; S.mySide = 1; S.ranked = null; S.format = [1, 3, 5].includes(m.fmt) ? m.fmt : 1;
  S.phase = m.phase === 'lobby' ? 'serve' : m.phase; S.ballVisible = false; S.streak = 0;
  SPV.buf.length = 0; SPV.over = false; SPV.snapCam = true;
  document.body.classList.add('spectating');
  $('lobby').classList.add('hidden'); $('hud').classList.remove('hidden'); $('over').classList.add('hidden');
  crowd.mySide = 1; if (A.crowdView) A.crowdView.setTeams(1);
  specApplyPlayers(m);
  if (m.score) Object.assign(S, { score: m.score, games: m.games || S.games, gameNo: m.gameNo || 1, gameScores: m.gameScores || [] });
  $('ping').textContent = '';
  music.duck(); updateHud(); renderSpecUI();
  if (history.replaceState && location.search.includes('ver=')) history.replaceState(null, '', location.pathname);
  addChat('sys', `👀 Você está assistindo${m.ranked ? ' uma ranqueada' : ''}. Reaja com os botões ou teclas 1 a 4.`);
}
function specApplyPlayers(m) {
  SPV.host = m.host; SPV.guest = m.guest;
  if (m.host && RACKETS.some(r => r.id === m.host.rk)) setPaddle('me', racketById(m.host.rk), cleanTag(m.host.tag), String(m.host.sk || ''));
  if (m.guest && RACKETS.some(r => r.id === m.guest.rk)) setPaddle('op', racketById(m.guest.rk), cleanTag(m.guest.tag), String(m.guest.sk || ''));
  oppPaddleMesh.visible = myPaddleMesh.visible = true;
  $('nameL').textContent = (m.host && m.host.name || 'JOGADOR 1').slice(0, 20).toUpperCase();
  $('nameR').textContent = m.guest ? (m.guest.name || 'JOGADOR 2').slice(0, 20).toUpperCase() : 'AGUARDANDO…';
  renderSpecUI();
}
const specName = sd => sd === 1 ? (SPV.host && SPV.host.name || 'Jogador 1') : (SPV.guest && SPV.guest.name || 'Jogador 2');
function onSpecMsg(m) {
  if (!m || typeof m !== 'object') return;
  SPV.lastMsg = performance.now();
  switch (m.t) {
    case 'sinit': if (S.mode !== 'spec') startSpectating(m); else { specApplyPlayers(m); if (m.fmt) S.format = m.fmt; if (m.score) Object.assign(S, { score: m.score, games: m.games, gameNo: m.gameNo, gameScores: m.gameScores }); updateHud(); } break;
    case 'sfull': cleanupNet(); showPanel('menu'); lobbyMsg('Essa partida já está com o máximo de espectadores.'); break;
    case 'snap':
      SPV.buf.push({ t: performance.now(), ...m });
      if (SPV.buf.length > 40) SPV.buf.splice(0, SPV.buf.length - 40);
      if (m.ph !== S.phase) {
        if (m.ph === 'serve' && SPV.over) { SPV.over = false; S.streak = 0; }
        S.phase = m.ph;
      }
      break;
    case 'sstate': Object.assign(S, { score: m.score, games: m.games, gameNo: m.gameNo, gameScores: m.gameScores }); if (m.fmt) S.format = m.fmt; updateHud(); break;
    case 'sev': {
      if (m.k === 'hit') {
        const rk = m.side === 1 ? myRacket : oppRacket;
        sfx('hit', m.label, m.p, m.s, rk.sound);
        S.lastLabel = m.label; S.streak = m.serve ? 0 : S.streak + 1;
        fxHit(m.side, m.p, m.label); if (m.label) showLabel(m.label);
        if (m.q === 'PERFEITO!') showQuality(`PERFEITO! (${specName(m.side)})`, true);
      } else if (m.k === 'table') { sfx('table', null, m.p, m.s); fxBounce(m.p[0], m.p[2]); }
      else if (m.k === 'net') { sfx('net', null, m.p, m.s); netHit({ x: m.p[0], y: m.p[1], s: m.s * 6, graze: !!m.graze }); }
      break;
    }
    case 'spoint': {
      Object.assign(S, { score: m.score, games: m.games || S.games });
      if (!m.winner) { showMsg('LET', 'o saque tocou na rede, repete'); S.streak = 0; updateHud(); break; }
      const rally = S.streak, sub = ({ out: 'bola fora', net: 'bola na rede', miss: 'não devolveu' }[m.reason] || '') + (rally >= 8 ? ` · rally de ${rally}!` : '');
      showMsg(`Ponto de ${specName(m.winner)}`, sub);
      fxPoint(m.winner === 1, rally, m.reason, m.shot || null, m.winner);
      bumpScore(m.winner === 1 ? 'scoreL' : 'scoreR');
      S.streak = 0; updateHud();
      break;
    }
    case 'sgame': {
      Object.assign(S, { games: m.games, gameScores: m.gameScores || S.gameScores });
      const g = m.gs || { '1': 0, '-1': 0 };
      showBanner(`GAME ${m.gameNo || S.gameNo} DE ${specName(m.w).toUpperCase()}`, `${g['1']} × ${g['-1']} · games ${m.games['1']} × ${m.games['-1']}`, 'win', 3200);
      crowdReact('point', 0.9); celebrate(0.5); updateHud();
      break;
    }
    case 'sover': {
      SPV.over = true; Object.assign(S, { games: m.games || S.games, gameScores: m.gameScores || S.gameScores });
      showBanner(`${specName(m.w).toUpperCase()} VENCEU!`, S.format > 1 ? `games ${S.games['1']} × ${S.games['-1']}` : `${S.score['1']} × ${S.score['-1']}`, 'win', 4500);
      celebrate(1.2); crowdReact('point', 1); crowdEvent(m.w, 1, true);
      setTimeout(() => { if (S.mode === 'spec' && SPV.over) addChat('sys', '👀 Fim de jogo. Se eles pedirem revanche, a transmissão continua aqui.'); }, 2500);
      updateHud();
      break;
    }
    case 'cheer': if (CHEERS.includes(m.e)) showCheer(m.e); break;
    case 'specs': showSpecCount(m.n); break;
  }
}
// desenha a partida ~100 ms atrás, interpolando entre as fotos recebidas (fica liso mesmo com a rede oscilando)
const _sv = new THREE.Vector3(), _sl = new THREE.Vector3();
function specFrame(dt, now) {
  if (SPV.lastMsg && performance.now() - SPV.lastMsg > 9000) { goMenu(); lobbyMsg('A transmissão caiu (o anfitrião saiu ou a internet dele oscilou).'); return; }
  const B = SPV.buf;
  if (B.length) {
    const tr = performance.now() - 110;
    let i = B.length - 1; while (i > 0 && B[i - 1].t > tr) i--;
    const a = B[Math.max(0, i - 1)], b = B[i], k = b.t > a.t ? clamp((tr - a.t) / (b.t - a.t), 0, 1) : 1;
    const L = (x, y) => x + (y - x) * k;
    const jump = Math.hypot(b.b[0] - a.b[0], b.b[1] - a.b[1], b.b[2] - a.b[2]) > 1.2;   // saque novo: não interpola
    const src = jump ? b : null;
    for (let j = 0; j < 3; j++) S.ball.p[j] = src ? src.b[j] : L(a.b[j], b.b[j]);
    S.ball.v = [(b.b[0] - a.b[0]) / Math.max(0.016, (b.t - a.t) / 1000), (b.b[1] - a.b[1]) / Math.max(0.016, (b.t - a.t) / 1000), (b.b[2] - a.b[2]) / Math.max(0.016, (b.t - a.t) / 1000)];
    S.ball.w = [0, 0, 0];
    S.ballVisible = !!(k < 0.5 ? a.v : b.v);
    me.x = L(a.h[0], b.h[0]); me.y = L(a.h[1], b.h[1]); me.z = L(a.h[2], b.h[2]);
    opp.x = L(a.g[0], b.g[0]); opp.y = L(a.g[1], b.g[1]); opp.z = L(a.g[2], b.g[2]);
    trailColor.setHex(b.c);
  }
  // câmeras de transmissão
  const p = S.ball.p, cm = SPV.cam;
  let fov = 44;
  if (cm === 'tv') { _sv.set(3.25, TH + 1.35, clamp(p[2] * 0.3, -0.9, 0.9)); _sl.set(p[0] * 0.3, TH, clamp(p[2] * 0.5, -1.2, 1.2)); fov = 40; }
  else if (cm === 'p1' || cm === 'p2') {
    const sd = cm === 'p1' ? 1 : -1, px = cm === 'p1' ? me.x : opp.x;
    _sv.set(px * 0.5, TH + 0.78, sd * (HL + 2.0)); _sl.set(p[0] * 0.25, TH + 0.05, -sd * 0.4); fov = 52;
  } else { _sv.set(1.8, TH + 3.6, 2.4); _sl.set(0, TH, 0); fov = 48; }
  const kk = SPV.snapCam ? 1 : Math.min(1, dt * 3.5);
  SPV.pos.lerp(_sv, kk); SPV.look.lerp(_sl, SPV.snapCam ? 1 : Math.min(1, dt * 6)); SPV.snapCam = false;
  camera.position.copy(SPV.pos); camera.lookAt(SPV.look);
  if (cam.shake > 0 && cfg.shake) { const s = cam.shake * cam.shake * 0.015; camera.position.x += (Math.random() - 0.5) * s; camera.position.y += (Math.random() - 0.5) * s; cam.shake = Math.max(0, cam.shake - dt * 3); }
  camera.fov = lerp(camera.fov, fov, Math.min(1, dt * 4)); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
}
function nextSpecCam() {
  const i = SPEC_CAMS.findIndex(c => c[0] === SPV.cam);
  SPV.cam = SPEC_CAMS[(i + 1) % SPEC_CAMS.length][0]; SPV.snapCam = true; renderSpecUI();
}
function sendCheer(e) {
  if (S.mode !== 'spec' || !specConn || !specConn.open) return;
  const now = performance.now(); SPV.cheerT = SPV.cheerT || [];
  SPV.cheerT = SPV.cheerT.filter(t => now - t < 3000);
  if (SPV.cheerT.length >= 4) return;                  // anti-spam
  SPV.cheerT.push(now);
  try { specConn.send({ t: 'cheer', e }); } catch (err) { }
  showCheer(e);
}
function renderSpecUI() {
  const el = $('specUI'); if (!el) return;
  el.classList.toggle('hidden', S.mode !== 'spec');
  if (S.mode !== 'spec') return;
  const c = SPEC_CAMS.find(x => x[0] === SPV.cam);
  $('spCam').textContent = `🎥 ${c[1]}${SPV.cam === 'p1' ? ' ' + specName(1) : SPV.cam === 'p2' ? ' ' + specName(-1) : ''} (C)`;
}
function initSpecUI() {
  const st = document.createElement('style');
  st.textContent = `
  #specUI { position: fixed; left: 50%; bottom: 64px; white-space: nowrap; max-width: 96vw; transform: translateX(-50%); z-index: 13; display: flex; gap: 6px; align-items: center; background: rgba(12,8,18,.75); border: 1px solid rgba(255,255,255,.12); border-radius: 999px; padding: 6px 8px; }
  #specUI.hidden { display: none; }
  #specUI .live { font: 900 11px system-ui; letter-spacing: .12em; color: #fff; background: #ff2a55; border-radius: 999px; padding: 4px 9px; }
  #specUI * { white-space: nowrap; }
  #specUI button { border: 0; background: rgba(255,255,255,.1); color: #fff; border-radius: 999px; padding: 6px 10px; font: 800 13px system-ui; cursor: pointer; }
  #specUI button.ch { font-size: 18px; padding: 3px 8px; }
  #specCount { position: fixed; top: 64px; right: 14px; z-index: 12; font: 800 12px system-ui; color: #fff; background: rgba(0,0,0,.45); padding: 4px 10px; border-radius: 999px; }
  #specCount.hidden { display: none; }
  .cheer { position: fixed; bottom: 70px; z-index: 12; font-size: 34px; pointer-events: none; animation: cheerUp 2.2s ease-out forwards; }
  @keyframes cheerUp { 0% { transform: translateY(0) scale(.6); opacity: 0; } 15% { opacity: 1; transform: translateY(-20px) scale(1.1); } 100% { transform: translateY(-260px) scale(1); opacity: 0; } }
  body.spectating #btnChat, body.spectating #qcHint { display: none !important; }
  .spec-row { display: flex; gap: 8px; margin-top: 8px; } .spec-row .btn { flex: 1; }`;
  document.head.appendChild(st);
  const live = h('span', { class: 'live', text: '● AO VIVO' });
  const camB = h('button', { id: 'spCam' }); camB.onclick = nextSpecCam;
  const chs = CHEERS.map(e => { const b = h('button', { class: 'ch', text: e, title: 'Reagir' }); b.onclick = () => sendCheer(e); return b; });
  const out = h('button', { text: 'Sair' }); out.onclick = () => goMenu();
  document.body.append(h('div', { id: 'specUI', class: 'hidden' }, live, camB, ...chs, out), h('div', { id: 'specCount', class: 'hidden' }));
  // menu: assistir pelo código
  const jb = $('btnJoin');
  if (jb) { const w = h('button', { class: 'btn ghost', id: 'btnWatch', text: '👀 Assistir' }); w.onclick = () => { ensureAudio(); joinSpectate($('inCode').value); }; jb.after(w); }
  // sala criada: link para quem só quer assistir
  const cp = $('btnCopy');
  if (cp) {
    const w = h('button', { class: 'btn ghost', id: 'btnSpecLink', text: '👀 Copiar link para assistir' });
    w.onclick = () => { const code = $('codeTxt').textContent.trim(); if (code.length < 4) return; navigator.clipboard && navigator.clipboard.writeText(specLink(code)).then(() => toast('Link para assistir copiado'), () => { }); };
    cp.after(w);
  }
  window.addEventListener('keydown', e => {
    if (S.mode !== 'spec' || e.repeat || /input|textarea/i.test((e.target && e.target.tagName) || '')) return;
    if (e.key === 'c' || e.key === 'C') nextSpecCam();
    const n = '1234'.indexOf(e.key); if (n >= 0) sendCheer(CHEERS[n]);
  });
}

/* =====================================================================
   AMIGOS: código de amigo, pedidos, quem está online, convite para jogar,
   assistir a partida de um amigo e sugestões dos amigos da Steam.
   Tudo passa por funções do servidor (o jogo nunca lê tabelas direto) e
   nenhum SteamID é mostrado para outros jogadores.
   ===================================================================== */
const FR = { data: null, err: '', open: false, pollT: 0, lastPoll: -1e9, incoming: 0, invites: [], steam: null, busy: false };
const presenceNow = () => S.mode === 'spec' ? 'assistindo' : queue.on ? 'fila' : S.mode ? 'jogando' : 'menu';
async function socialPoll() {
  if (!acct.user) return;
  FR.lastPoll = performance.now();
  try {
    const r = await rpc('social_poll', { p_presence: presenceNow(), p_room: S.mode === 'online' && curRoom ? curRoom : null });
    FR.err = '';
    FR.incoming = r.incoming | 0;
    for (const inv of r.invites || []) showInvite(inv);
    renderFrBadge();
  } catch (e) { FR.err = String(e.message || e); }
}
function socialTick() {                               // ~30 s normal, ~8 s com a tela de amigos aberta
  const gap = FR.open ? 8000 : 30000;
  if (acct.user && performance.now() - FR.lastPoll > gap) { socialPoll(); if (FR.open) loadFriends(); }
}
setInterval(socialTick, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) FR.lastPoll = -1e9; });

async function loadFriends() {
  if (!acct.user) { FR.data = null; renderFriends(); return; }
  try { FR.data = await rpc('friends_list'); FR.err = ''; FR.incoming = (FR.data.incoming || []).length; }
  catch (e) { FR.err = /friends_list|does not exist|schema cache/i.test(e.message) ? 'Amigos indisponível agora: o servidor está sendo atualizado.' : 'Não consegui carregar seus amigos: ' + e.message; }
  renderFriends(); renderFrBadge();
}
function openFriends() { ensureAudio(); FR.open = true; $('frScreen').classList.remove('hidden'); releaseMouse(); updateLockUI(); renderFriends(); loadFriends(); }
function closeFriends() { FR.open = false; $('frScreen').classList.add('hidden'); updateLockUI(); }
function renderFrBadge() {
  const n = FR.incoming | 0, b = $('frBadge');
  if (b) { b.textContent = n; b.classList.toggle('hidden', !n); }
  const b2 = $('fuFrBadge'); if (b2) { b2.textContent = n; b2.classList.toggle('hidden', !n); }
}
const agoTxt = d => {
  if (!d) return 'offline';
  const s = (Date.now() - Date.parse(d)) / 1000;
  return s < 3600 ? `visto há ${Math.max(1, Math.round(s / 60))} min` : s < 86400 ? `visto há ${Math.round(s / 3600)} h` : `visto há ${Math.round(s / 86400)} dia(s)`;
};
function avatarEl(f) { return avatarNode(f.avatar, f.name, 'fr-av'); }
async function frAction(fn, args, okMsg) {
  if (FR.busy) return; FR.busy = true;
  try { const r = await rpc(fn, args); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); await loadFriends(); return r ?? true; }
  catch (e) {
    const m = String(e.message || e);
    const MSG = { 'codigo nao encontrado': 'Não achei esse código', 'esse e o seu proprio codigo': 'Esse é o seu próprio código 😄', 'voces ja sao amigos': 'Vocês já são amigos',
      'muitos pedidos pendentes': 'Você tem pedidos demais esperando resposta', 'limite de amigos': 'Limite de amigos atingido', 'so da para convidar amigos': 'Só dá para convidar amigos',
      'espere um pouco para convidar de novo': 'Espere uns segundos para convidar de novo' };
    const k = Object.keys(MSG).find(x => m.includes(x));
    toast(k ? MSG[k] : 'Não deu certo: ' + m);
  } finally { FR.busy = false; }
}
async function inviteFriend(f) {
  if (S.mode && S.mode !== 'online') { toast('Saia da partida atual para convidar'); return; }
  if (S.mode === 'online') { toast('Você já está numa partida online'); return; }
  if (window.__futReady) { closeFriends(); Object.assign(MATCH, { rkPicked: false, type: 'friend', friend: f }); UI.stack = ['play', 'friend']; showPanel('menu'); showPage('arena'); return; }
  if (!(isHost && peer && curRoom)) { createRoom(); }               // abre uma sala e espera o amigo nela
  const room = curRoom;
  const ok = await frAction('invite_friend', { p_to: f.id, p_room: room }, `Convite enviado para ${f.name}. Esperando ele entrar…`);
  if (ok) closeFriends();
}
function watchFriend(f) { if (!f.room) return; closeFriends(); if (S.mode) goMenu(); joinSpectate(f.room); }

let invTimer = 0;
function showInvite(inv) {
  if (!inv || !inv.room || !/^[A-Z0-9]{4,8}$/.test(inv.room)) return;
  const el = $('invPop'); if (!el) return;
  el.textContent = '';
  const yes = h('button', { class: 'btn', text: 'Aceitar' }), no = h('button', { class: 'btn ghost', text: 'Agora não' });
  yes.onclick = () => { el.classList.add('hidden'); acceptInvite(inv); };
  no.onclick = () => el.classList.add('hidden');
  const ar = ARENAS.find(a => a.id === inv.arena), fm = FORMATS[inv.fmt];
  el.append(h('div', { class: 'ip' }, avatarNode(validAv(inv.avatar), inv.name, 'av'), h('div', {}, h('b', { text: inv.name || 'Um amigo' }), h('span', { text: 'te chamou para uma partida' }), (ar || fm) ? h('small', { text: [ar ? `${ar.emoji} ${ar.name}` : '', fm ? fm.short : ''].filter(Boolean).join(' · ') }) : null)), h('div', { class: 'inv-b' }, yes, no));
  el.classList.remove('hidden');
  tone(880, 0.12, 0.05, 'sine'); tone(1320, 0.18, 0.04, 'sine', 0.12);
  clearTimeout(invTimer); invTimer = setTimeout(() => el.classList.add('hidden'), 60000);
}
async function steamSuggestions() {
  FR.steam = { loading: true }; renderFriends();
  try {
    const sb = await sbLoad(); const { data } = await sb.auth.getSession();
    const r = await fetch(`${SB_URL}/functions/v1/steam-friends`, { method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: SB_KEY } });
    const j = await r.json().catch(() => ({}));
    FR.steam = j.error ? { error: { sem_chave: 'Essa função liga quando a chave da Steam Web API for cadastrada no servidor.', lista_privada: 'Sua lista de amigos da Steam está privada. Deixe-a pública nas configurações de privacidade da Steam para ver quem joga.', sem_steam: 'Entre com a Steam para ver seus amigos de lá.', login: 'Entre de novo na sua conta.' }[j.error] || 'Não consegui falar com a Steam agora.' } : { players: j.players || [] };
  } catch (e) { FR.steam = { error: 'Não consegui falar com a Steam agora.' }; }
  renderFriends();
}
function renderFriends() {
  const box = $('frBody'); if (!box) return;
  box.textContent = '';
  if (!acct.user) {
    box.append(h('p', { class: 'muted', text: 'Entre com a Steam (ou Google) para adicionar amigos, ver quem está online e chamar para jogar.' }));
    const b = h('button', { class: 'b-steam-img' }, steamBtnImg()); b.onclick = loginSteam; box.append(b);
    return;
  }
  if (FR.err && !FR.data) { box.append(h('p', { class: 'muted', text: FR.err })); return; }
  const d = FR.data;
  if (!d) { box.append(h('p', { class: 'muted', text: 'Carregando…' })); return; }
  // meu código
  const cp = h('button', { class: 'cf-save', text: 'Copiar' });
  cp.onclick = () => navigator.clipboard && navigator.clipboard.writeText(d.code).then(() => toast('Código copiado'), () => toast(d.code));
  box.append(h('div', { class: 'fr-code' }, h('span', {}, 'Seu código de amigo: ', h('b', { text: d.code || '—' })), cp));
  // adicionar
  const inp = h('input', { class: 'adm-q', placeholder: 'Código do amigo (ex.: K7P2QX)', maxlength: 30, autocomplete: 'off' });
  const add = h('button', { class: 'cf-save', text: 'Adicionar' });
  const go = () => { const c = inp.value.trim(); if (c.length < 4) return; frAction('friend_request', { p_code: c }, r => r.status === 'accepted' ? `Agora você e ${r.name} são amigos!` : `Pedido enviado para ${r.name}`); inp.value = ''; };
  add.onclick = go; inp.onkeydown = e => { if (e.key === 'Enter') go(); };
  box.append(h('div', { class: 'adm-search' }, inp, add));
  // pedidos recebidos
  if ((d.incoming || []).length) {
    box.append(h('div', { class: 'cf-t', text: `Pedidos recebidos (${d.incoming.length})` }));
    for (const f of d.incoming) {
      const ok = h('button', { class: 'cf-save', text: 'Aceitar' }); ok.onclick = () => frAction('friend_respond', { p_from: f.id, p_accept: true }, `Agora você e ${f.name} são amigos!`);
      const no = h('button', { class: 'adm-mini', text: 'Recusar' }); no.onclick = () => frAction('friend_respond', { p_from: f.id, p_accept: false });
      box.append(h('div', { class: 'fr-row' }, avatarEl(f), h('div', { class: 'fr-info' }, h('b', { text: f.name }), h('small', { text: f.tag || '' })), h('div', { class: 'fr-act' }, ok, no)));
    }
  }
  // amigos
  box.append(h('div', { class: 'cf-t', text: `Amigos (${(d.friends || []).length})` }));
  if (!(d.friends || []).length) box.append(h('p', { class: 'muted', text: 'Ninguém ainda. Mande seu código para os amigos ou adicione o código deles.' }));
  for (const f of d.friends || []) {
    const st = { menu: ['on', 'Online no menu'], jogando: ['play', 'Jogando'], assistindo: ['play', 'Assistindo'], fila: ['play', 'Na fila da ranqueada'], offline: ['off', agoTxt(f.last_seen)] }[f.presence] || ['off', 'offline'];
    const act = h('div', { class: 'fr-act' });
    if (f.presence === 'menu') { const b = h('button', { class: 'cf-save', text: 'Convidar' }); b.onclick = () => inviteFriend(f); act.append(b); }
    if (f.presence === 'jogando' && f.room) { const b = h('button', { class: 'adm-mini', text: '👀 Assistir' }); b.onclick = () => watchFriend(f); act.append(b); }
    const rm = h('button', { class: 'adm-mini fr-rm', title: 'Remover amigo', text: '✕' });
    rm.onclick = () => { if (confirm(`Remover ${f.name} dos amigos?`)) frAction('friend_remove', { p_id: f.id }, `${f.name} removido`); };
    act.append(rm);
    box.append(h('div', { class: 'fr-row' }, avatarEl(f),
      h('div', { class: 'fr-info' }, h('b', {}, f.name, ' ', h('span', { class: 'adm-chip', text: f.tag || '' })), h('small', { class: 'st-' + st[0], text: `● ${st[1]}${f.rating ? ` · ${f.rating} elo` : ''}` })), act));
  }
  // enviados
  if ((d.outgoing || []).length) {
    box.append(h('div', { class: 'cf-t', text: 'Pedidos enviados' }));
    for (const f of d.outgoing) {
      const c = h('button', { class: 'adm-mini', text: 'Cancelar' }); c.onclick = () => frAction('friend_remove', { p_id: f.id });
      box.append(h('div', { class: 'fr-row' }, avatarEl(f), h('div', { class: 'fr-info' }, h('b', { text: f.name }), h('small', { text: 'esperando resposta' })), h('div', { class: 'fr-act' }, c)));
    }
  }
  // amigos da Steam
  if (acct.profile && acct.profile.steam) {
    const sb = h('button', { class: 'btn ghost', text: '🎮 Amigos da Steam que jogam' }); sb.onclick = steamSuggestions;
    box.append(h('div', { class: 'stack' }, sb));
    if (FR.steam) {
      if (FR.steam.loading) box.append(h('p', { class: 'muted', text: 'Perguntando para a Steam…' }));
      else if (FR.steam.error) box.append(h('p', { class: 'muted', text: FR.steam.error }));
      else if (!FR.steam.players.length) box.append(h('p', { class: 'muted', text: 'Nenhum amigo da Steam joga ainda. Chame eles! 😉' }));
      else for (const p of FR.steam.players) {
        const act = h('div', { class: 'fr-act' });
        if (!p.rel) { const b = h('button', { class: 'cf-save', text: 'Adicionar' }); b.onclick = () => frAction('friend_request', { p_code: p.code }, `Pedido enviado para ${p.name}`).then(() => { p.rel = 'enviado'; renderFriends(); }); act.append(b); }
        else act.append(h('small', { class: 'muted', text: { amigo: 'já é amigo', enviado: 'pedido enviado', recebido: 'te mandou pedido' }[p.rel] }));
        box.append(h('div', { class: 'fr-row' }, avatarEl(p), h('div', { class: 'fr-info' }, h('b', { text: p.name }), h('small', { text: 'amigo na Steam' })), act));
      }
    }
  }
  box.append(h('p', { class: 'cf-note', text: 'Seus amigos veem seu nome, sigla, foto e se você está online ou jogando. Ninguém vê seu SteamID nem seu e-mail.' }));
}
// botão oficial "Sign in through Steam" (a Valve pede para usar a imagem dela no link de login)
function steamBtnImg() {
  const img = h('img', { src: 'https://community.fastly.steamstatic.com/public/images/signinthroughsteam/sits_01.png', alt: 'Sign in through Steam', referrerpolicy: 'no-referrer' });
  img.onerror = () => img.replaceWith(h('span', { class: 'steam-fallback', text: 'Entrar com Steam' }));
  return img;
}
function initFriendsUI() {
  const st = document.createElement('style');
  st.textContent = `
  #frScreen .card { max-width: 520px; text-align: left; max-height: 92vh; overflow-y: auto; }
  .fr-code { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: rgba(255,211,77,.1); border: 1px solid rgba(255,211,77,.3); border-radius: 12px; padding: 8px 12px; margin: 8px 0; }
  .fr-code b { font-size: 18px; letter-spacing: .14em; color: #ffd34d; }
  .fr-row { display: flex; align-items: center; gap: 10px; padding: 7px 4px; border-bottom: 1px solid rgba(255,255,255,.06); }
  .fr-av { width: 36px; height: 36px; border-radius: 50%; flex: none; object-fit: cover; display: grid; place-items: center; background: linear-gradient(135deg, #ff4f8b, #9a5cff); font-weight: 900; }
  .fr-info { flex: 1; min-width: 0; display: flex; flex-direction: column; } .fr-info b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fr-info small { font-size: 12px; opacity: .7; } .fr-info .st-on { color: #2fd16b; opacity: 1; } .fr-info .st-play { color: #ffd34d; opacity: 1; }
  .fr-act { display: flex; gap: 6px; align-items: center; } .fr-rm { opacity: .6; }
  #frScreen .cf-t { margin-top: 12px; }
  .fr-btn { position: relative; } #frBadge { position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; border-radius: 999px; background: #ff2a55; color: #fff; font-size: 11px; font-weight: 900; display: grid; place-items: center; padding: 0 4px; }
  #frBadge.hidden { display: none; }
  #invPop { position: fixed; top: 16px; right: 16px; z-index: 60; width: min(320px, 92vw); background: rgba(18,10,26,.95); border: 1px solid rgba(255,211,77,.45); border-radius: 16px; padding: 12px 14px; box-shadow: 0 10px 40px rgba(0,0,0,.5); animation: invIn .35s cubic-bezier(.2,1.5,.4,1); }
  #invPop.hidden { display: none; } @keyframes invIn { from { transform: translateY(-20px); opacity: 0; } }
  .inv-t { font-size: 15px; margin-bottom: 10px; } .inv-b { display: flex; gap: 8px; } .inv-b .btn { flex: 1; margin: 0; padding: 9px; }
  .b-steam-img { border: 0; background: none; padding: 0; cursor: pointer; display: inline-flex; align-items: center; }
  .b-steam-img img { height: 35px; display: block; } .steam-fallback { background: linear-gradient(180deg, #2a475e, #171a21); color: #fff; padding: 9px 14px; border-radius: 4px; font-weight: 800; }
  .acct-legal { font-size: 10.5px; opacity: .5; margin-top: 8px; line-height: 1.4; }`;
  document.head.appendChild(st);
  const scr = h('div', { id: 'frScreen', class: 'screen hidden' }); scr.style.zIndex = 44;
  const x = h('button', { class: 'cf-x', 'aria-label': 'Fechar', text: '✕' }); x.onclick = closeFriends;
  scr.append(h('div', { class: 'card' }, h('div', { class: 'cf-head' }, h('h2', { text: '👥 Amigos' }), x), h('div', { id: 'frBody' })));
  scr.onclick = e => { if (e.target === scr) closeFriends(); };
  document.body.append(scr, h('div', { id: 'invPop', class: 'hidden' }));
  // cartão da conta: botão de amigos com contador de pedidos
  const ex = $('acctExtra');
  if (ex) { const b = h('button', { class: 'fr-btn', id: 'btnFriends' }, '👥 Amigos', h('span', { id: 'frBadge', class: 'hidden' })); b.onclick = openFriends; ex.prepend(b); }
  // botão de login: imagem oficial da Steam + aviso de marca
  const bs = $('btnSteam');
  if (bs) { bs.className = 'b-steam-img'; bs.textContent = ''; bs.append(steamBtnImg()); bs.title = 'Entrar pela página oficial da Steam (nunca pedimos sua senha)'; }
  const out = $('acctOut');
  if (out) out.append(h('div', { class: 'acct-legal', text: 'O login abre a página oficial da Steam: nunca pedimos sua senha. Steam e o logotipo Steam são marcas da Valve Corporation. Ping Pong Online não é afiliado à Valve.' }));
}

/* =====================================================================
   AVATARES (desenhados em SVG, sem arquivos): jogadores e mascotes
   Guardados no perfil como "av:<id>". Alguns liberam por nível.
   ===================================================================== */
const AV_SKIN = ['#ffdcc2', '#f3c19d', '#d9a07a', '#b97a52', '#8d5634', '#5e3a22'];
const AV_PLAYERS = [
  // id, fundo, pele, cabelo, cor do cabelo, camisa, extra
  ['p1', ['#ff6b1a', '#b8340b'], 1, 'short', '#2a1a10', '#1f6fff', ''],
  ['p2', ['#2a7fff', '#123d99'], 3, 'afro', '#1a0f08', '#ff3d5a', 'band'],
  ['p3', ['#9a5cff', '#4b1fa8'], 0, 'long', '#e8b04a', '#ffffff', ''],
  ['p4', ['#1fc46b', '#0b6e3a'], 4, 'spiky', '#111111', '#ffd34d', ''],
  ['p5', ['#ff3d7f', '#9c0f45'], 2, 'bun', '#3a1f12', '#1f2a44', ''],
  ['p6', ['#ffd34d', '#c98a0f'], 1, 'cap', '#1f6fff', '#1f6fff', ''],
  ['p7', ['#14b8c4', '#0a5f6a'], 5, 'bald', '#000', '#ff6b1a', 'glasses'],
  ['p8', ['#ff8a3d', '#a8420c'], 0, 'pony', '#a23a1a', '#14b8c4', ''],
  ['p9', ['#3a4a6b', '#141a2a'], 3, 'short', '#0f0f0f', '#ffffff', 'band'],
  ['p10', ['#e83f3f', '#7a1010'], 2, 'spiky', '#f2d06b', '#111827', ''],
  ['p11', ['#6b7cff', '#2b3299'], 4, 'long', '#1a0f08', '#ff3d7f', ''],
  ['p12', ['#22c55e', '#166534'], 0, 'cap', '#e83f3f', '#ffffff', 'glasses'],
  ['p13', ['#f472b6', '#9d174d'], 5, 'afro', '#0f0f0f', '#ffd34d', ''],
  ['p14', ['#0ea5e9', '#075985'], 1, 'bun', '#c0c0c0', '#9a5cff', ''],
];
const AV_MASCOTS = [
  ['bola', ['#1f6fff', '#0b2f7a'], 'Bolinha'], ['raposa', ['#14b8c4', '#0a4f5a'], 'Raposa'], ['panda', ['#22c55e', '#0f5130'], 'Panda'],
  ['gato', ['#ff6b1a', '#9a3108'], 'Gato'], ['robo', ['#9a5cff', '#3b1782'], 'Robô'], ['tigre', ['#111827', '#000000'], 'Tigre'],
  ['coruja', ['#e83f3f', '#6e0f0f'], 'Coruja'], ['dragao', ['#ffd34d', '#a0640a'], 'Dragão'], ['rei', ['#7c3aed', '#2e1065'], 'Rei da mesa'], ['fogo', ['#0f172a', '#000000'], 'Chama'],
];
const AV_LV = { 'av:tigre': 5, 'av:coruja': 8, 'av:dragao': 10, 'av:rei': 15, 'av:fogo': 20 };
const AVATARS = [...AV_PLAYERS.map(a => ({ id: 'av:' + a[0], kind: 'p', a })), ...AV_MASCOTS.map(a => ({ id: 'av:' + a[0], kind: 'm', a, name: a[2] }))];
const avCache = {};
function avBg(c, id) { return `<defs><linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g${id})"/><path d="M-6 52 C18 40 40 62 70 38 L70 70 L-6 70Z" fill="rgba(0,0,0,.18)"/><circle cx="50" cy="12" r="18" fill="rgba(255,255,255,.08)"/>`; }
function avPlayer([id, bg, sk, hair, hc, shirt, extra]) {
  const s = AV_SKIN[sk], sd = 'rgba(0,0,0,.14)';
  const back = hair === 'long' ? `<path d="M17 28 C15 46 20 52 22 54 L42 54 C44 52 49 46 47 28Z" fill="${hc}"/>` : hair === 'afro' ? `<circle cx="32" cy="24" r="18" fill="${hc}"/>` : hair === 'pony' ? `<path d="M44 22 C54 26 54 40 47 46 C49 38 47 30 42 26Z" fill="${hc}"/>` : '';
  const top = {
    short: `<path d="M19 28 C17 13 47 11 45 28 C43 21 38 18 32 18 C26 18 21 21 19 28Z" fill="${hc}"/>`,
    spiky: `<path d="M18 28 L19 16 L24 19 L26 11 L31 17 L35 10 L38 17 L43 13 L43 20 L46 20 L45 28 C42 21 37 19 32 19 C27 19 22 21 18 28Z" fill="${hc}"/>`,
    long: `<path d="M18 30 C16 12 48 12 46 30 C44 22 39 18 32 18 C25 18 20 22 18 30Z" fill="${hc}"/>`,
    bun: `<circle cx="32" cy="11" r="6" fill="${hc}"/><path d="M19 28 C17 14 47 14 45 28 C43 21 38 18 32 18 C26 18 21 21 19 28Z" fill="${hc}"/>`,
    cap: `<path d="M18 25 C18 12 46 12 46 25Z" fill="${hc}"/><path d="M30 24 L54 25 C54 28 46 28 30 27Z" fill="${hc}"/><path d="M18 25 L46 25" stroke="rgba(0,0,0,.25)" stroke-width="1.5"/><circle cx="32" cy="14" r="1.6" fill="rgba(255,255,255,.6)"/>`,
    afro: `<path d="M18 26 C18 14 46 14 46 26 C42 21 38 20 32 20 C26 20 22 21 18 26Z" fill="${hc}"/>`,
    pony: `<path d="M19 28 C17 13 47 11 45 28 C43 21 38 18 32 18 C26 18 21 21 19 28Z" fill="${hc}"/>`,
    bald: `<path d="M22 19 C26 15 38 15 42 19" stroke="rgba(255,255,255,.25)" stroke-width="2" fill="none"/>`,
  }[hair] || '';
  const ex = extra === 'band' ? `<rect x="18" y="20" width="28" height="4.5" rx="2" fill="#ffffff"/><rect x="18" y="20" width="28" height="1.6" rx="1" fill="${shirt}"/>`
    : extra === 'glasses' ? `<g fill="none" stroke="#111" stroke-width="1.6"><circle cx="27" cy="29.5" r="3.6"/><circle cx="37" cy="29.5" r="3.6"/><path d="M30.6 29.5 L33.4 29.5"/></g>` : '';
  return `${back}<path d="M6 66 C8 50 19 45 32 45 C45 45 56 50 58 66Z" fill="${shirt}"/><path d="M26 45 L32 53 L38 45" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2"/><path d="M6 66 C8 54 14 50 20 48" stroke="rgba(0,0,0,.18)" stroke-width="3" fill="none"/>
  <rect x="27.5" y="37" width="9" height="9" rx="3" fill="${s}"/><rect x="27.5" y="40" width="9" height="3" fill="${sd}"/>
  <circle cx="19" cy="30" r="3.2" fill="${s}"/><circle cx="45" cy="30" r="3.2" fill="${s}"/>
  <ellipse cx="32" cy="28.5" rx="13" ry="14" fill="${s}"/>${top}
  <path d="M24.5 25.2 L29 24.6 M35 24.6 L39.5 25.2" stroke="${hair === 'bald' ? '#3a2a20' : hc}" stroke-width="1.6" stroke-linecap="round"/>
  <circle cx="27" cy="29.6" r="1.8" fill="#1a1a1a"/><circle cx="37" cy="29.6" r="1.8" fill="#1a1a1a"/><circle cx="27.6" cy="29" r=".6" fill="#fff"/><circle cx="37.6" cy="29" r=".6" fill="#fff"/>
  <circle cx="24" cy="34" r="2" fill="rgba(255,90,90,.18)"/><circle cx="40" cy="34" r="2" fill="rgba(255,90,90,.18)"/>
  <path d="M28.5 35.4 Q32 38.6 35.5 35.4" stroke="#7a2e1e" stroke-width="1.6" fill="none" stroke-linecap="round"/>${ex}`;
}
function avMascot(id) {
  const eyes = (y = 30, c = '#111', dx = 6) => `<circle cx="${32 - dx}" cy="${y}" r="2.4" fill="${c}"/><circle cx="${32 + dx}" cy="${y}" r="2.4" fill="${c}"/><circle cx="${32.8 - dx}" cy="${y - .8}" r=".8" fill="#fff"/><circle cx="${32.8 + dx}" cy="${y - .8}" r=".8" fill="#fff"/>`;
  switch (id) {
    case 'bola': return `<circle cx="32" cy="34" r="20" fill="#ff8a1f"/><path d="M14 30 C24 36 40 36 50 30" stroke="#fff3e0" stroke-width="2" fill="none"/><circle cx="25" cy="25" r="5" fill="rgba(255,255,255,.35)"/>${eyes(36)}<path d="M27 42 Q32 46 37 42" stroke="#3a1800" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    case 'raposa': return `<path d="M14 14 L24 30 L18 34Z M50 14 L40 30 L46 34Z" fill="#ff7a1a"/><path d="M17 18 L22 28 L19 30Z M47 18 L42 28 L45 30Z" fill="#3a1500"/><path d="M14 30 C16 18 48 18 50 30 C50 44 40 52 32 54 C24 52 14 44 14 30Z" fill="#ff7a1a"/><path d="M14 34 C20 36 26 42 32 54 C24 52 15 45 14 34Z M50 34 C44 36 38 42 32 54 C40 52 49 45 50 34Z" fill="#fff"/>${eyes(32)}<ellipse cx="32" cy="44" rx="3" ry="2.2" fill="#111"/>`;
    case 'panda': return `<circle cx="17" cy="18" r="7" fill="#111"/><circle cx="47" cy="18" r="7" fill="#111"/><circle cx="32" cy="34" r="20" fill="#fff"/><ellipse cx="24.5" cy="32" rx="5" ry="6.5" transform="rotate(25 24.5 32)" fill="#111"/><ellipse cx="39.5" cy="32" rx="5" ry="6.5" transform="rotate(-25 39.5 32)" fill="#111"/><circle cx="25" cy="31.5" r="1.8" fill="#fff"/><circle cx="39" cy="31.5" r="1.8" fill="#fff"/><ellipse cx="32" cy="41" rx="3" ry="2" fill="#111"/><path d="M29 45 Q32 47 35 45" stroke="#111" stroke-width="1.5" fill="none"/>`;
    case 'gato': return `<path d="M13 12 L26 22 L15 30Z M51 12 L38 22 L49 30Z" fill="#9aa3b5"/><path d="M16 17 L23 22 L17 26Z M48 17 L41 22 L47 26Z" fill="#ff9ab8"/><ellipse cx="32" cy="34" rx="19" ry="18" fill="#9aa3b5"/><path d="M26 18 L28 24 M32 17 L32 23 M38 18 L36 24" stroke="#6b7385" stroke-width="2"/>${eyes(32, '#1f6b2e')}<path d="M30 39 L34 39 L32 41.5Z" fill="#ff7aa2"/><path d="M32 41.5 Q29 45 27 43 M32 41.5 Q35 45 37 43" stroke="#333" stroke-width="1.2" fill="none"/><path d="M12 38 L24 39 M12 43 L24 41 M52 38 L40 39 M52 43 L40 41" stroke="rgba(255,255,255,.75)" stroke-width="1"/>`;
    case 'robo': return `<path d="M32 8 L32 15" stroke="#cbd5e1" stroke-width="2.5"/><circle cx="32" cy="7" r="3" fill="#ff3d5a"/><rect x="13" y="15" width="38" height="36" rx="10" fill="#cbd5e1"/><rect x="17" y="23" width="30" height="14" rx="6" fill="#0f172a"/><circle cx="25" cy="30" r="3" fill="#38e1ff"/><circle cx="39" cy="30" r="3" fill="#38e1ff"/><rect x="24" y="42" width="16" height="3" rx="1.5" fill="#64748b"/><rect x="9" y="27" width="4" height="10" rx="2" fill="#94a3b8"/><rect x="51" y="27" width="4" height="10" rx="2" fill="#94a3b8"/>`;
    case 'tigre': return `<circle cx="17" cy="17" r="6" fill="#ff8a1f"/><circle cx="47" cy="17" r="6" fill="#ff8a1f"/><circle cx="17" cy="17" r="3" fill="#ffd9b0"/><circle cx="47" cy="17" r="3" fill="#ffd9b0"/><ellipse cx="32" cy="34" rx="20" ry="19" fill="#ff8a1f"/><path d="M32 16 L30 24 M24 18 L26 24 M40 18 L38 24 M13 32 L20 33 M13 38 L19 37 M51 32 L44 33 M51 38 L45 37" stroke="#111" stroke-width="2.4" stroke-linecap="round"/><ellipse cx="32" cy="43" rx="10" ry="7" fill="#fff4e6"/>${eyes(31)}<path d="M29.5 40 L34.5 40 L32 43Z" fill="#111"/>`;
    case 'coruja': return `<path d="M14 16 L22 24 L16 28Z M50 16 L42 24 L48 28Z" fill="#7a4a2a"/><ellipse cx="32" cy="36" rx="19" ry="19" fill="#9a6235"/><ellipse cx="32" cy="44" rx="11" ry="9" fill="#e8c9a0"/><circle cx="24.5" cy="31" r="7.5" fill="#fff"/><circle cx="39.5" cy="31" r="7.5" fill="#fff"/><circle cx="24.5" cy="31" r="3.6" fill="#111"/><circle cx="39.5" cy="31" r="3.6" fill="#111"/><circle cx="25.6" cy="29.8" r="1.2" fill="#fff"/><circle cx="40.6" cy="29.8" r="1.2" fill="#fff"/><path d="M29.5 37 L34.5 37 L32 42Z" fill="#ffb02e"/>`;
    case 'dragao': return `<path d="M18 22 L10 6 L24 17Z M46 22 L54 6 L40 17Z" fill="#fff2b0"/><ellipse cx="32" cy="34" rx="19" ry="18" fill="#1fa463"/><path d="M14 30 L8 28 L14 36Z M50 30 L56 28 L50 36Z" fill="#147a49"/><ellipse cx="32" cy="44" rx="12" ry="7" fill="#7be0a8"/><circle cx="28" cy="43" r="1.4" fill="#0b4a2b"/><circle cx="36" cy="43" r="1.4" fill="#0b4a2b"/><path d="M22 29 L29 31 M42 29 L35 31" stroke="#0b4a2b" stroke-width="2"/>${eyes(33, '#ffd34d')}<path d="M24 20 L26 24 L28 19 L30 24 L32 18 L34 24 L36 19 L38 24 L40 20" stroke="#ffd34d" stroke-width="1.6" fill="none"/>`;
    case 'rei': return `${avPlayer(['k', ['#000', '#000'], 2, 'short', '#2a1a10', '#7c3aed', ''])}<path d="M19 17 L22 6 L27 13 L32 4 L37 13 L42 6 L45 17Z" fill="#ffd34d" stroke="#a0640a" stroke-width="1"/><circle cx="32" cy="10" r="1.6" fill="#ff3d5a"/><circle cx="23" cy="12" r="1.2" fill="#38e1ff"/><circle cx="41" cy="12" r="1.2" fill="#38e1ff"/>`;
    case 'fogo': return `<path d="M32 6 C40 18 52 22 50 38 C49 50 40 58 32 58 C24 58 15 50 14 38 C13 28 20 24 22 14 C26 22 30 22 32 6Z" fill="#ff5a1a"/><path d="M32 22 C37 30 44 33 43 42 C42 50 37 54 32 54 C27 54 22 50 21 42 C21 36 25 33 27 27 C29 31 31 30 32 22Z" fill="#ffb02e"/><path d="M32 36 C35 40 38 42 37 47 C36 51 34 52 32 52 C30 52 28 51 27 47 C27 44 29 42 32 36Z" fill="#fff2b0"/>${eyes(40, '#3a0f00', 5)}`;
  }
  return '';
}
function avatarURI(id) {
  if (avCache[id]) return avCache[id];
  const av = AVATARS.find(a => a.id === id); if (!av) return null;
  const k = id.slice(3).replace(/[^a-z0-9]/g, '');
  const inner = av.kind === 'p' ? avPlayer(av.a) : avMascot(av.a[0]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${avBg(av.a[1], k)}${inner}</svg>`;
  return (avCache[id] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
}
const avLocked = id => !isVip() && levelOf(prog.xp).lvl < (AV_LV[id] || 1);
function myAvatar() { const p = acct.profile; return (p && p.avatar) || store.get('pp_avatar', '') || ''; }
// elemento de avatar para qualquer lugar (perfil, amigos, ranking)
function avatarNode(value, name, cls = 'av') {
  const ini = ((name || '?').trim()[0] || '?').toUpperCase();
  if (value && value.startsWith('av:') && avatarURI(value)) return h('img', { class: cls, src: avatarURI(value), alt: '' });
  if (value && /^https:\/\//.test(value)) { const i = h('img', { class: cls, src: value, alt: '', referrerpolicy: 'no-referrer' }); i.onerror = () => i.replaceWith(h('span', { class: cls + ' ini', text: ini })); return i; }
  return h('span', { class: cls + ' ini', text: ini });
}
async function setAvatar(id) {
  if (id && avLocked(id)) { toast(`🔒 Libera no nível ${AV_LV[id]}`); return; }
  store.set('pp_avatar', id || '');
  if (acct.profile) acct.profile.avatar = id || acct.profile.avatar_steam || null;
  if (typeof renderFut === 'function') renderFut();
  if (!acct.user) return;
  try { await rpc('set_avatar', { p_pick: id || null }); toast('Avatar salvo ✔'); refreshProfile(); }
  catch (e) { toast('Avatar salvo neste aparelho'); console.warn('avatar', e); }
}

/* =====================================================================
   MENU PRINCIPAL (estilo FUT): barra do clube em cima, abas, título grande,
   cartões grandes com rodapé de números e dicas de teclas embaixo.
   Toda tela aberta pelo menu usa o mesmo visual. Os botões antigos
   continuam existindo (escondidos) e são acionados por aqui.
   ===================================================================== */
const ASSET_FONT = 'https://cdn.jsdelivr.net/npm/@fontsource/barlow-condensed@5.3.0/';
const UI = { page: 'home', stack: [], sel: 0 };
let uiHoverT = 0;
function uiTick(kind) {
  if (!actx || !VOL.ui) return;
  const now = performance.now(); if (kind === 'hover' && now - uiHoverT < 60) return; uiHoverT = now;
  const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(kind === 'hover' ? 2400 : 1200, t); o.frequency.exponentialRampToValueAtTime(kind === 'hover' ? 1800 : 600, t + 0.05);
  g.gain.setValueAtTime(kind === 'hover' ? 0.012 : 0.035, t); g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'hover' ? 0.04 : 0.09));
  o.connect(g).connect(VOL.ui); o.start(t); o.stop(t + 0.1);
}
// ---------- ilustrações dos cartões (SVG) ----------
const ART = {
  amigo: `<g transform="translate(150 118)"><circle r="70" fill="url(#gl)"/><g transform="rotate(-28)"><ellipse cx="-38" cy="-8" rx="34" ry="38" fill="#e8273f"/><ellipse cx="-38" cy="-8" rx="28" ry="32" fill="#ff4b5f"/><rect x="-46" y="26" width="16" height="44" rx="6" fill="#c8915a"/></g><g transform="rotate(28)"><ellipse cx="38" cy="-8" rx="34" ry="38" fill="#1f5fe0"/><ellipse cx="38" cy="-8" rx="28" ry="32" fill="#3d82ff"/><rect x="30" y="26" width="16" height="44" rx="6" fill="#c8915a"/></g><circle cx="0" cy="-52" r="11" fill="#fff"/><circle cx="-3" cy="-55" r="4" fill="#fff" opacity=".9"/></g>`,
  rank: `<g transform="translate(150 120)"><circle r="72" fill="url(#gl)"/><path d="M-36 -52 L36 -52 L32 -10 C28 14 12 24 0 26 C-12 24 -28 14 -32 -10Z" fill="#ffc23a"/><path d="M-36 -44 C-62 -44 -62 -6 -30 -2 M36 -44 C62 -44 62 -6 30 -2" stroke="#ffc23a" stroke-width="8" fill="none"/><rect x="-8" y="24" width="16" height="22" fill="#e0a21c"/><rect x="-30" y="46" width="60" height="14" rx="3" fill="#ffc23a"/><path d="M-18 -40 L-14 -14" stroke="#fff6cf" stroke-width="6" stroke-linecap="round" opacity=".7"/><text y="-16" text-anchor="middle" font-size="26" font-weight="900" fill="#8a5a00" font-family="Barlow Condensed,system-ui">1</text></g>`,
  treino: `<g transform="translate(150 118)"><circle r="72" fill="url(#gl)"/><path d="M0 -70 L0 -54" stroke="#cbd5e1" stroke-width="5"/><circle cy="-74" r="7" fill="#ff6b1a"/><rect x="-52" y="-54" width="104" height="92" rx="24" fill="#d6dde8"/><rect x="-40" y="-34" width="80" height="38" rx="14" fill="#0f172a"/><circle cx="-18" cy="-15" r="8" fill="#38e1ff"/><circle cx="18" cy="-15" r="8" fill="#38e1ff"/><rect x="-22" y="16" width="44" height="8" rx="4" fill="#64748b"/><rect x="-64" y="-20" width="12" height="30" rx="6" fill="#94a3b8"/><rect x="52" y="-20" width="12" height="30" rx="6" fill="#94a3b8"/></g>`,
  tutorial: `<g transform="translate(150 125)"><circle r="72" fill="url(#gl)"/><path d="M-80 30 C-40 -70 40 -70 80 30" stroke="#fff" stroke-width="4" stroke-dasharray="2 12" stroke-linecap="round" fill="none" opacity=".75"/><circle cx="0" cy="-45" r="12" fill="#fff"/><path d="M-60 -6 L0 -32 L60 -6 L0 20Z" fill="#1d2433"/><path d="M-36 6 L-36 34 C-20 46 20 46 36 34 L36 6 L0 20Z" fill="#2b3447"/><path d="M52 -2 L52 32" stroke="#ffc23a" stroke-width="4"/><circle cx="52" cy="36" r="6" fill="#ffc23a"/></g>`,
  criar: `<g transform="translate(150 118)"><circle r="72" fill="url(#gl)"/><rect x="-58" y="-50" width="116" height="84" rx="12" fill="#1d2433" stroke="#3d82ff" stroke-width="4"/><text y="-2" text-anchor="middle" font-size="34" font-weight="900" fill="#fff" font-family="Barlow Condensed,system-ui" letter-spacing="6">K7P2Q</text><rect x="-34" y="12" width="68" height="10" rx="5" fill="#3d82ff" opacity=".6"/><circle cx="46" cy="44" r="22" fill="#ff6b1a"/><path d="M46 32 L46 56 M34 44 L58 44" stroke="#fff" stroke-width="6" stroke-linecap="round"/></g>`,
  entrar: `<g transform="translate(150 118)"><circle r="72" fill="url(#gl)"/><path d="M-50 -50 L18 -50 L18 50 L-50 50Z" fill="#1d2433" stroke="#64748b" stroke-width="4"/><circle cx="6" cy="2" r="4" fill="#ffc23a"/><path d="M-6 0 L60 0 M40 -18 L60 0 L40 18" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"/></g>`,
  assistir: `<g transform="translate(150 118)"><circle r="72" fill="url(#gl)"/><path d="M-70 0 C-40 -46 40 -46 70 0 C40 46 -40 46 -70 0Z" fill="#f8fafc"/><circle r="26" fill="#1f5fe0"/><circle r="12" fill="#0f172a"/><circle cx="-7" cy="-8" r="6" fill="#fff"/></g>`,
  ranking: `<g transform="translate(150 128)"><circle cy="-10" r="72" fill="url(#gl)"/><rect x="-24" y="-40" width="48" height="80" fill="#ffc23a"/><rect x="-72" y="-10" width="48" height="50" fill="#cbd5e1"/><rect x="24" y="6" width="48" height="34" fill="#d08a4a"/><text y="-12" text-anchor="middle" font-size="30" font-weight="900" fill="#8a5a00" font-family="Barlow Condensed,system-ui">1</text><text x="-48" y="18" text-anchor="middle" font-size="24" font-weight="900" fill="#475569" font-family="Barlow Condensed,system-ui">2</text><text x="48" y="30" text-anchor="middle" font-size="22" font-weight="900" fill="#7a3f12" font-family="Barlow Condensed,system-ui">3</text></g>`,
  amigos: `<g transform="translate(150 122)"><circle r="72" fill="url(#gl)"/><circle cx="-26" cy="-22" r="22" fill="#f3c19d"/><path d="M-66 50 C-62 10 10 10 14 50Z" fill="#3d82ff"/><circle cx="30" cy="-14" r="20" fill="#b97a52"/><path d="M-6 54 C-2 18 62 18 66 54Z" fill="#ff6b1a"/></g>`,
  ajustes: `<g transform="translate(150 118)"><circle r="72" fill="url(#gl)"/><g fill="#cbd5e1">${[0, 45, 90, 135, 180, 225, 270, 315].map(a => `<rect x="-9" y="-62" width="18" height="24" rx="4" transform="rotate(${a})"/>`).join('')}<circle r="44"/></g><circle r="18" fill="#1d2433"/></g>`,
  missoes: `<g transform="translate(150 118)"><circle r="72" fill="url(#gl)"/><circle r="52" fill="none" stroke="#fff" stroke-width="10" opacity=".9"/><circle r="32" fill="none" stroke="#ff6b1a" stroke-width="10"/><circle r="12" fill="#fff"/><path d="M8 -8 L62 -62" stroke="#ffc23a" stroke-width="6"/><path d="M62 -62 L50 -60 L60 -50Z M62 -62 L70 -74 L74 -58Z" fill="#ffc23a"/></g>`,
};
let svgN = 0;
const uniq = str => { const n = ++svgN; return str.replace(/id="(gl|sw)"/g, (m, k) => `id="${k}${n}"`).replace(/url\(#(gl|sw)\)/g, (m, k) => `url(#${k}${n})`); };
function artSVG(key, accent = '#3d82ff') {
  return uniq(`<svg class="fu-svg" viewBox="0 0 300 240" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><radialGradient id="gl"><stop offset="0" stop-color="${accent}" stop-opacity=".55"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs>${ART[key] || ''}</svg>`);
}
const SWOOSH = `<svg class="fu-swoosh" viewBox="0 0 300 240" preserveAspectRatio="none" aria-hidden="true"><path d="M-20 200 C70 150 150 60 330 20 L330 46 C170 84 90 170 -20 232Z" fill="url(#sw)"/><defs><linearGradient id="sw" x1="0" x2="1"><stop offset="0" stop-color="#ff6b1a" stop-opacity=".0"/><stop offset=".35" stop-color="#ff6b1a" stop-opacity=".85"/><stop offset="1" stop-color="#ff9a3c" stop-opacity=".95"/></linearGradient></defs></svg>`;
// ---------- dados das páginas ----------
function missionsInfo() { const ms = dailyMissions(); return { ms, done: ms.filter(m => m.paid || m.n >= m.need).length }; }
function resetIn() { const n = new Date(), m = new Date(n); m.setHours(24, 0, 0, 0); const s = Math.max(0, (m - n) / 1000) | 0; return `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`; }
const DIFF_COL = { facil: '#22c55e', medio: '#ffc23a', dificil: '#ff6b1a', pro: '#e8273f' };
function tile(o) { return o; }
function futPage(id) {
  const mp = matchPages(id); if (mp) return mp;
  const p = acct.profile, L = levelOf(prog.xp), mi = missionsInfo();
  const elo = p ? p.rating : 1000, dv = p ? division(p.rating, p.games) : division(1000, 0);
  const fmtName = { 1: 'Duelo', 3: 'MD3', 5: 'MD5' }[pickState.fmt];
  const chips = [['star', `${mi.done}/3 MISSÕES`], ['time', resetIn()]];
  switch (id) {
    case 'home': return { title: 'Início', sub: `Bem-vindo de volta${p ? ', ' + p.name : ''}. Escolha onde quer jogar hoje.`, chips, tiles: [
      { title: 'Jogar', art: artSVG('amigo', '#ff6b1a'), wide: true, foot: [['Formato', fmtName], ['Cenário', ARENAS[pickState.ar].name], ['CPU', BOT_LV[pickState.diff].name]], go: () => futGo('play') },
      { title: 'Missões', art: artSVG('missoes', '#ff6b1a'), foot: [['Completas', `${mi.done}/3`], ['Nível', L.lvl], ['XP', `${L.cur}/${L.need}`, 1]], go: () => futGo('missions') },
      { title: 'Perfil', art: futAvatarArt(), foot: [['Elo', elo], ['Divisão', dv.name.replace('Colocação', 'Coloc.')], ['Vitórias', p ? p.wins : 0]], go: () => futGo('profile') },
      { title: 'Amigos', art: artSVG('amigos', '#3d82ff'), foot: [['Pedidos', FR.incoming | 0], ['Código', (p && p.friend_code) || '—'], ['Convites', (FR.invites || []).length]], go: () => openFriends(), badge: FR.incoming ? `${FR.incoming} NOVO${FR.incoming > 1 ? 'S' : ''}` : '' },
    ] };
    case 'play': return { title: 'Tipo de partida', sub: 'Escolha como quer jogar. Depois vêm o cenário, o modo de jogo e a raquete.', chips, tiles: [
      { title: 'Treino', art: artSVG('treino', '#38e1ff'), foot: [['Contra', 'CPU'], ['Níveis', 4], ['XP', `até ×${BOT_LV.pro.xp}`]], go: () => { Object.assign(MATCH, { rkPicked: false, type: 'solo', friend: null }); futGo('arena'); } },
      { title: 'Amigo', art: artSVG('amigo', '#3d82ff'), foot: [['Convite', 'No jogo'], ['Amigos', FR.data ? FR.data.friends.length : '—'], ['Online', FR.data ? FR.data.friends.filter(f => f.online).length : '—']], go: () => { FR.data = null; futGo('friend'); } },
      { title: 'Ranqueada', art: artSVG('rank', '#ffc23a'), foot: [['Elo', elo], ['Divisão', dv.name.replace('Colocação', 'Coloc.')], ['V / D', p ? `${p.wins}/${p.losses}` : '0/0']], go: () => { Object.assign(MATCH, { rkPicked: false, type: 'ranked', friend: null }); futGo('gear'); } },
      { title: 'Tutorial', art: artSVG('tutorial', '#ffc23a'), foot: [['Tempo', '1 min'], ['Bônus', store.get('pp_tut', '0') === '1' ? 'Feito' : '+200', 1], ['Passos', 7]], go: () => startTutorial() },
    ] };
    case 'friend': return { title: 'Com amigo', crumb: 'Jogar', sub: 'Crie uma sala e mande o link, entre com o código ou só assista.', chips, tiles: [
      { title: 'Criar sala', art: artSVG('criar', '#ff6b1a'), foot: [['Formato', fmtName], ['Cenário', ARENAS[pickState.ar].emoji], ['Link', 'WhatsApp']], go: () => $('btnCreate').click() },
      { title: 'Entrar', art: 'code', foot: [['Código', '5 letras'], ['Raquete', myRacket.name], ['Sigla', myTag() || '—']], go: () => { const i = $('inCode'); if (i.value.trim().length >= 4) $('btnJoin').click(); else i.focus(); }, code: 'join' },
      { title: 'Assistir', art: artSVG('assistir', '#3d82ff'), foot: [['Código', 'da sala'], ['Câmeras', 4], ['Torcida', '👏🔥']], go: () => { const i = $('inCode'); if (i.value.trim().length >= 4) $('btnWatch').click(); else { i.focus(); toast('Digite o código da sala no cartão "Entrar"'); } } },
    ], opts: true };
    case 'ranked': return { title: 'Ranqueada', crumb: 'Jogar', sub: 'Fila automática com gente do seu nível. 1 game de 11, vale elo e divisão.', chips, tiles: [
      { title: 'Procurar partida', art: artSVG('rank', '#ffc23a'), wide: true, foot: [['Elo', elo], ['Divisão', dv.name.replace('Colocação', 'Coloc.')], ['Posição', p && p.games ? `#${p.rank}` : '—']], go: () => $('btnRanked').click() },
      { title: 'Ranking', art: artSVG('ranking', '#ffc23a'), foot: [['Temporada', 1], ['Top', 50], ['Você', p && p.games ? `#${p.rank}` : '—']], go: () => openRanking() },
    ] };
    case 'train': return { title: 'Treino', crumb: 'Jogar', sub: 'Escolha o nível da CPU. Quanto mais difícil, mais XP por partida.', chips, tiles: Object.entries(BOT_LV).map(([k, v], i) => (
      { title: v.name, art: futCpuArt(k, i), foot: [['XP', `×${v.xp}`], ['Reflexo', '▮'.repeat(i + 1) + '▯'.repeat(3 - i)], ['Erros', ['Muitos', 'Alguns', 'Poucos', 'Raros'][i]]], sel: pickState.diff === k, go: () => { pickState.diff = k; store.set('pp_diff', k); renderPick(); $('btnSolo').click(); } })), opts: true };
    case 'garage': return { title: 'Coleção', sub: 'Suas raquetes e skins, a bolinha e a sigla gravada na borracha.', chips, tiles: RACKETS.filter(isListed).map(r => {
      const lk = !isUnlocked(r), i = RACKETS.indexOf(r);
      const sk = skinById(mySkinFor(r));
      return { title: r.name, art: futRacketArt(r), foot: [['Velocidade', { bar: r.speed }], ['Efeito', { bar: r.spin }], ['Controle', { bar: r.ctrl }]], small: true, sel: myRacket.id === r.id, badge: myRacket.id === r.id ? 'EQUIPADA' : '', skin: sk ? sk.name : 'Original',
        locked: lk ? lockText(r) : '', go: () => { pickState.rk = i; if (isUnlocked(r)) { store.set('pp_racket', r.id); setPaddle('me', r); } renderPick(); UI.skinRk = r.id; futGo('skins'); } };
    }), balls: true };
    case 'skins': {
      const r = racketById(UI.skinRk || myRacket.id), cur = mySkinFor(r);
      const pick = id => { setRacketSkin(r, id); skinReady(id).then(() => { if (myRacket.id === r.id) setPaddle('me', r); makeThumbs([[r, id]]); renderFut(); }); renderFut(); toast(id ? `Skin ${skinById(id).name} na ${r.name}` : `${r.name} com o visual original`); };
      return { title: r.name, crumb: 'Coleção', sub: 'Escolha a skin desta raquete. Muda só o visual: velocidade, efeito e controle continuam os mesmos. Seu adversário vê a skin.', chips: [['star', `${RSKINS.length} SKINS`], ['paint', cur ? skinById(cur).name : 'Original']], tiles: [
        { title: 'Original', art: futRacketArt(r, true), foot: [['Raridade', 'Padrão'], ['Nº', '00'], ['Status', cur ? 'Usar' : 'Em uso']], small: true, sel: !cur, badge: !cur ? 'EM USO' : '', go: () => pick('') },
        ...RSKINS.map(s => ({ title: s.name, art: futSkinArt(s), foot: [['Raridade', s.rar], ['Nº', s.n], ['Status', cur === s.id ? 'Em uso' : 'Usar']], small: true, sel: cur === s.id, rar: s.rar, badge: cur === s.id ? 'EM USO' : '', go: () => pick(s.id) })),
      ] };
    }
    case 'missions': return { title: 'Missões', sub: 'Três missões novas todo dia. Cada uma dá XP para subir de nível e liberar bolinhas e avatares.', chips, tiles: mi.ms.map(m => (
      { title: m.t, art: futMissionArt(m), foot: [['Progresso', `${Math.min(m.n, m.need)}/${m.need}`], ['Recompensa', `${m.xp} XP`, 1], ['Status', m.paid ? 'Feita ✔' : 'Aberta']], small: true, sel: m.paid, go: () => futGo('play') })) };
    case 'profile': return { title: 'Perfil', sub: 'Escolha seu avatar, nome e sigla. Seus amigos e o ranking veem o avatar.', chips, tiles: [], profile: true };
  }
  return { title: '', tiles: [] };
}
function futAvatarArt() { const v = myAvatar(), p = acct.profile; const n = avatarNode(v, p ? p.name : '?', 'fu-bigav'); return n; }
function futCpuArt(k, i) {
  return uniq(`<svg class="fu-svg" viewBox="0 0 300 240" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><radialGradient id="gl"><stop offset="0" stop-color="${DIFF_COL[k]}" stop-opacity=".6"/><stop offset="1" stop-color="${DIFF_COL[k]}" stop-opacity="0"/></radialGradient></defs>${ART.treino.replace(/#38e1ff/g, DIFF_COL[k])}<g transform="translate(232 40)">${[0, 1, 2, 3].map(j => `<rect x="${j * 13}" y="${30 - j * 9}" width="9" height="${12 + j * 9}" rx="2" fill="${j <= i ? DIFF_COL[k] : 'rgba(255,255,255,.18)'}"/>`).join('')}</g></svg>`);
}
const thumbsOrig = {};
function futRacketArt(r, orig) {
  const sk = !orig && skinById(mySkinFor(r)), c = sk ? sk.c : '#' + (r.look.color >>> 0).toString(16).padStart(6, '0');
  const d = h('div', { class: 'fu-rk', style: `--rc:${c}` });
  if (orig) {                                                   // miniatura sem skin (desenhada na hora, uma vez)
    if (!thumbsOrig[r.id]) makeThumbs([[r, '']], thumbsOrig);
    if (thumbsOrig[r.id]) d.append(h('img', { src: thumbsOrig[r.id], alt: '' }));
  } else if (thumbs[r.id]) d.append(h('img', { src: thumbs[r.id], alt: '' })); else setTimeout(() => { if (UI.page === 'garage') renderFut(); }, 400);
  return d;
}
function futSkinArt(s) {
  const d = h('div', { class: 'fu-sk', style: `--rc:${s.c}` });
  d.append(h('img', { class: 'b', src: skinUrl(s, 'b', true), alt: '', loading: 'lazy' }), h('img', { class: 'f', src: skinUrl(s, 'f', true), alt: '', loading: 'lazy' }));
  return d;
}
function futMissionArt(m) {
  const pct = Math.min(1, m.n / m.need), C = 2 * Math.PI * 46;
  return uniq(`<svg class="fu-svg" viewBox="0 0 300 240" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><radialGradient id="gl"><stop offset="0" stop-color="#ff6b1a" stop-opacity=".45"/><stop offset="1" stop-color="#ff6b1a" stop-opacity="0"/></radialGradient></defs><circle cx="150" cy="112" r="80" fill="url(#gl)"/><circle cx="150" cy="112" r="46" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="12"/><circle cx="150" cy="112" r="46" fill="none" stroke="${m.paid ? '#22c55e' : '#ff6b1a'}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${C * pct} ${C}" transform="rotate(-90 150 112)"/><text x="150" y="124" text-anchor="middle" font-size="34" font-weight="900" fill="#fff" font-family="Barlow Condensed,system-ui">${m.paid ? '✔' : `${Math.min(m.n, m.need)}/${m.need}`}</text></svg>`);
}
// ---------- navegação ----------
const TABS = [['home', 'Início'], ['play', 'Jogar'], ['garage', 'Coleção'], ['friends', 'Amigos'], ['ranking', 'Ranking'], ['settings', 'Ajustes']];
const TAB_OF = { friend: 'play', ranked: 'play', train: 'play', arena: 'play', mode: 'play', gear: 'play', missions: 'home', profile: 'home', skins: 'garage' };
function futTab(id) {
  if (id === 'friends') return openFriends();
  if (id === 'ranking') return openRanking();
  if (id === 'settings') return openSettings();
  UI.stack = []; showPage(id);
}
function futGo(id) { UI.stack.push(UI.page); showPage(id); }
function futBack() { if (UI.stack.length) showPage(UI.stack.pop()); else if (UI.page !== 'home') showPage('home'); }
function showPage(id) { const ch = UI.page !== id; UI.page = id; UI.sel = Math.max(0, futPage(id).tiles.findIndex(t => t.sel)); renderFut(ch); }
// ---------- desenho ----------
function renderTop() {
  const p = acct.profile, L = levelOf(prog.xp), mi = missionsInfo();
  const crest = $('fuCrest'); if (!crest) return;
  crest.textContent = ''; crest.append(avatarNode(myAvatar(), p ? p.name : '?', 'av'));
  $('fuName').textContent = p ? p.name : 'Visitante';
  const fd = $('fuFdr'); if (fd) { fd.textContent = ''; if (isFounder()) fd.append(founderBadge('xs')); }
  $('fuEst').textContent = p && p.games >= 10 ? division(p.rating, p.games).name.toUpperCase() : 'NÍV ' + L.lvl;
  $('fuElo').textContent = p ? p.rating : 1000;
  $('fuXp').textContent = prog.xp;
  $('fuStars').textContent = mi.done;
  $('fuTimer').textContent = resetIn();
  $('fuMisBar').style.width = `${mi.done / 3 * 100}%`; $('fuMisTxt').textContent = `${mi.done}/3`;
  $('fuLvl').textContent = L.lvl;
  const b = $('fuFrBadge'); if (b) { const n = FR.incoming | 0; b.textContent = n; b.classList.toggle('hidden', !n); }
  document.querySelectorAll('.fu-tabs button[data-t]').forEach(x => x.classList.toggle('on', x.dataset.t === (TAB_OF[UI.page] || UI.page)));
}
function renderFut(anim = false) {
  const main = $('fuMain'); if (!main) return;
  renderTop();
  const P = futPage(UI.page);
  const head = h('div', { class: 'fu-head' + (anim ? ' in' : '') },
    P.crumb ? h('div', { class: 'fu-crumb' }, h('button', { class: 'fu-back', text: '‹ ' + P.crumb, onclick: futBack })) : null,
    h('h1', { class: 'fu-title', text: P.title }), h('p', { class: 'fu-sub', text: P.sub || '' }),
    h('div', { class: 'fu-chips' }, ...(P.chips || []).map(([k, t]) => h('span', { class: 'fu-chip ' + (k === 'paint' ? 'time' : k) }, k === 'star' ? h('i', { class: 'fu-star' }) : h('i', { text: k === 'paint' ? '🎨' : '⏱' }), t))));
  const row = h('div', { class: 'fu-tiles' + (P.tiles.some(t => t.small) ? ' many' : '') + (anim ? ' in' : '') });
  P.tiles.forEach((t, i) => row.append(futTile(t, i)));
  const ic = $('inCode'); if (ic && main.contains(ic)) $('fuHold').append(ic);   // o campo do código não pode sumir da página
  main.textContent = '';
  main.append(head);
  if (P.profile) main.append(futProfile(anim));
  else main.append(row);
  if (P.pre) row.before(P.pre === 'cpu' ? futCpuSeg() : futRacketStrip());
  if (P.shade && !MATCH.rkPicked) { row.classList.add('shade'); row.append(h('div', { class: 'fu-shade' }, h('span', { text: '↑ Escolha a raquete para liberar as skins' }))); }
  if (P.cta) { const off = P.shade && !MATCH.rkPicked; const cb = h('button', { class: off ? 'off' : '', text: off ? 'Escolha a raquete' : P.cta + '  ▶' }); cb.onclick = () => { if (off) { toast('Escolha a raquete primeiro'); return; } launchMatch(); }; main.append(h('div', { class: 'fu-cta' }, cb)); }
  if (P.opts) main.append(futOptions());
  if (P.balls) main.append(futBalls());
  futSel(UI.sel, false);
}
const statBars = n => h('b', { class: 'fu-bars', title: `${n} de 5` }, ...[0, 1, 2, 3, 4].map(i => h('i', { class: i < n ? 'on' : '' })));
function futTile(t, i) {
  const art = h('div', { class: 'fu-art' });
  if (t.art === 'addfriend') art.append(addFriendArt());
  else if (t.art === 'code') {
    const inp = $('inCode'); inp.placeholder = 'CÓDIGO';
    const go = h('button', { class: 'fu-codego', text: 'ENTRAR ›' }); go.onclick = e => { e.stopPropagation(); $('btnJoin').click(); };
    inp.onclick = e => e.stopPropagation(); inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') $('btnJoin').click(); };
    art.append(h('div', { class: 'fu-code' }, h('small', { text: 'CÓDIGO DA SALA' }), inp, go));
  } else if (typeof t.art === 'string') art.innerHTML = t.art;
  else if (t.art) art.append(t.art);
  if (!t.noSwoosh) art.insertAdjacentHTML('afterbegin', uniq(SWOOSH));        // a faixa laranja fica atrás da ilustração
  if (t.art !== 'addfriend') art.append(h('div', { class: 'fu-tt', text: t.title }));
  if (t.badge) art.append(h('span', { class: 'fu-badge' + (t.badgeCls ? ' ' + t.badgeCls : ''), text: t.badge }));
  if (t.skin) art.append(h('span', { class: 'fu-skn', text: '🎨 ' + t.skin }));
  if (t.founder) art.append(founderBadge('xs'));
  if (t.rar) art.append(h('span', { class: 'fu-rar', style: `--rr:${RAR_COL[t.rar]}`, text: t.rar.toUpperCase() }));
  const foot = h('div', { class: 'fu-foot' }, ...(t.foot || []).map(([l, v, star]) => h('div', {}, h('small', { text: l }), v && typeof v === 'object' && 'bar' in v ? statBars(v.bar) : h('b', {}, String(v), star ? h('i', { class: 'fu-star' }) : null))));
  const b = h('button', { class: 'fu-tile' + (t.wide ? ' wide' : '') + (t.small ? ' small' : '') + (t.locked ? ' locked' : '') + (t.dim ? ' dim' : '') + (t.sel ? ' cur' : ''), 'data-i': i, 'aria-label': t.title }, art, foot);
  if (t.locked) b.append(h('div', { class: 'fu-lock' }, h('i', { text: '🔒' })), h('div', { class: 'fu-locktxt', text: t.locked }));
  b.onclick = () => { UI.sel = i; futSel(i); if (t.go) t.go(); };
  b.onmouseenter = () => futSel(i, false);
  return b;
}
function futSel(i, focus = true) {
  const tiles = [...document.querySelectorAll('#fuMain .fu-tile')]; if (!tiles.length) return;
  UI.sel = Math.max(0, Math.min(tiles.length - 1, i));
  tiles.forEach((t, j) => t.classList.toggle('sel', j === UI.sel));
  if (focus) tiles[UI.sel].focus({ preventScroll: false });
}
function futOptions() {
  const a = ARENAS[pickState.ar];
  const arrow = (d, fn) => { const b = h('button', { class: 'fu-arr', text: d < 0 ? '‹' : '›', 'aria-label': d < 0 ? 'Anterior' : 'Próximo' }); b.onclick = fn; return b; };
  const ar = h('div', { class: 'fu-opt' }, h('span', { class: 'fu-ol', text: 'Cenário' }),
    h('div', { class: 'fu-ov' }, arrow(-1, () => { pickMove('ar', -1); renderFut(); }), h('b', {}, `${a.emoji} ${a.name}`, h('small', { text: a.tag })), arrow(1, () => { pickMove('ar', 1); renderFut(); })),
    h('div', { class: 'fu-dots' }, ...ARENAS.map((_, i) => h('i', { class: i === pickState.ar ? 'on' : '' }))));
  const fm = h('div', { class: 'fu-opt' }, h('span', { class: 'fu-ol', text: 'Formato' }),
    h('div', { class: 'fu-seg' }, ...[[1, 'Duelo', '1 game de 11'], [3, 'MD3', 'melhor de 3'], [5, 'MD5', 'melhor de 5']].map(([f, n, s]) => {
      const b = h('button', { class: pickState.fmt === f ? 'on' : '' }, n, h('small', { text: s }));
      b.onclick = () => { pickState.fmt = f; store.set('pp_fmt', String(f)); renderPick(); renderFut(); }; return b;
    })));
  return h('div', { class: 'fu-opts' }, ar, fm, h('p', { class: 'fu-note', text: 'No online valem o cenário e o formato de quem cria a sala. A ranqueada é sempre 1 game.' }));
}
function futBalls() {
  const row = h('div', { class: 'fu-balls' });
  for (const sk of BALL_SKINS) {
    const lk = skinLocked(sk);
    const ball = h('i', { class: 'fu-ball', style: sk.rainbow ? 'background: conic-gradient(#ff3d5a,#ff9a3c,#ffe14a,#5dff7a,#3a8bff,#9a5cff,#ff3d5a)' : `background: radial-gradient(circle at 32% 28%, rgba(255,255,255,.8) 0 6%, ${sk.base} 30%, ${sk.base} 100%)` });
    const b = h('button', { class: 'fu-bt' + (ballSkin.id === sk.id ? ' cur' : '') + (lk ? ' locked' : ''), title: sk.name }, ball, h('b', { text: sk.name }), h('small', { text: lk ? `🔒 nível ${SKIN_LV[sk.id]}` : ballSkin.id === sk.id ? 'EM USO' : 'Usar' }));
    b.onclick = () => { if (lk) toast(`🔒 A bolinha ${sk.name} libera no nível ${SKIN_LV[sk.id]}`); else { applyBallSkin(sk); renderPick(); renderFut(); } };
    row.append(b);
  }
  const tg = h('button', { class: 'fu-btn', text: `🏓 Sigla na raquete: ${myTag() || '—'}` }); tg.onclick = () => openSettings('perfil');
  return h('div', { class: 'fu-sec' }, h('div', { class: 'fu-st' }, 'Bolinha', h('small', { text: ballSkin.name })), row, h('div', { class: 'fu-row' }, tg));
}
function futProfile(anim) {
  const p = acct.profile, cur = myAvatar(), L = levelOf(prog.xp), dv = p ? division(p.rating, p.games) : division(1000, 0);
  const card = h('div', { class: 'fu-pcard' },
    h('div', { class: 'fu-pav' }, avatarNode(cur, p ? p.name : '?', 'fu-bigav')),
    h('div', { class: 'fu-pinfo' }, h('b', { text: p ? p.name : 'Visitante' }), isFounder() ? h('div', { style: 'margin: 2px 0 6px' }, founderBadge('lg')) : null, h('span', { text: `${myTag() || '—'} · Nível ${L.lvl}` }),
      h('div', { class: 'fu-pstats' }, ...[['Elo', p ? p.rating : 1000], ['Divisão', dv.name], ['V / D', p ? `${p.wins}/${p.losses}` : '0/0'], ['Pico', p ? p.peak : 1000]].map(([l, v]) => h('div', {}, h('small', { text: l }), h('b', { text: String(v) }))))));
  const bn = h('button', { class: 'fu-btn', text: '✎ Mudar nome' }); bn.onclick = () => editName();
  const bt = h('button', { class: 'fu-btn', text: '🏓 Sigla e ajustes' }); bt.onclick = () => openSettings('perfil');
  const bo = h('button', { class: 'fu-btn ghost', text: 'Sair da conta' }); bo.onclick = () => logout();
  const btns = h('div', { class: 'fu-row' }, bn, bt);
  if (p && p.admin) { const ba = h('button', { class: 'fu-btn', text: '🛠️ Painel admin' }); ba.onclick = () => openAdmin(); btns.append(ba); }
  btns.append(bo);
  const grid = h('div', { class: 'fu-avgrid' });
  if (p && p.avatar_steam) {
    const b = h('button', { class: 'fu-avt' + (cur === p.avatar_steam ? ' cur' : ''), title: 'Foto da Steam' }, avatarNode(p.avatar_steam, p.name, 'av'), h('small', { text: 'Steam' }));
    b.onclick = () => setAvatar(null); grid.append(b);
  }
  for (const a of AVATARS) {
    const lk = avLocked(a.id);
    const b = h('button', { class: 'fu-avt' + (cur === a.id ? ' cur' : '') + (lk ? ' locked' : ''), title: a.name || 'Avatar' }, h('img', { class: 'av', src: avatarURI(a.id), alt: '' }), lk ? h('small', { text: `🔒 nív ${AV_LV[a.id]}` }) : a.name ? h('small', { text: a.name }) : null);
    b.onclick = () => setAvatar(a.id); grid.append(b);
  }
  return h('div', { class: 'fu-profile' + (anim ? ' in' : '') }, h('div', {}, card, btns), h('div', { class: 'fu-sec' }, h('div', { class: 'fu-st' }, 'Avatar', h('small', { text: 'clique para usar' })), grid));
}
function initMenuShell() {
  for (const w of ['500', '600', '700', '800-italic', '900-italic']) document.head.append(h('link', { rel: 'stylesheet', href: `${ASSET_FONT}latin-${w}.css` }));
  const st = document.createElement('style');
  st.textContent = `
  :root { --fu-font: 'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif; --fu-or: #ff6b1a; --fu-bl: #2a7fff; --fu-pan: rgba(22,26,36,.88); }
  #lobby.fut { padding: 0; background: #05070c; overflow: hidden; display: block; font-family: var(--fu-font); }
  #lobby.fut .rl-bg { position: absolute; inset: -4%; background: #05070c center / cover no-repeat; animation: rlKen 40s ease-in-out infinite alternate; filter: saturate(1.05) brightness(.8); }
  @keyframes rlKen { from { transform: scale(1.04); } to { transform: scale(1.12) translate(-1.5%, -1%); } }
  @keyframes rlSweep { 0%, 70% { left: -40%; } 100% { left: 120%; } }
  @keyframes rlIn { from { opacity: 0; transform: translateY(18px); } }
  #lobby.fut .rl-shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(5,7,12,.75) 0, rgba(5,7,12,.35) 30%, rgba(5,7,12,.55) 70%, rgba(5,7,12,.9) 100%); }
  #lobby.fut > .card { max-width: none; width: 100%; height: 100%; margin: 0; padding: 0; background: none; border: 0; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; border-radius: 0; text-align: left; position: relative; }
  #lobby.fut > .card > h1, #lobby.fut > .card > .ball-ico, #lobby.fut > .card > .howto, #lobby.fut .gear, #fuHold { display: none !important; }
  #lobby.fut #menu { margin: 0; gap: 0; height: 100%; display: block; }
  /* barra do clube */
  .fu-top { position: absolute; top: 0; left: 0; right: 0; height: 44px; display: flex; align-items: center; gap: 14px; padding: 0 22px; background: linear-gradient(90deg, rgba(10,12,18,.92), rgba(10,12,18,.7)); border-bottom: 1px solid rgba(255,255,255,.06); z-index: 4; font-weight: 600; font-size: 15px; }
  .fu-crest { width: 30px; height: 30px; flex: none; clip-path: polygon(50% 0, 100% 12%, 100% 62%, 50% 100%, 0 62%, 0 12%); background: #ffc23a; padding: 2px; cursor: pointer; }
  .fu-crest .av { width: 100%; height: 100%; display: grid; place-items: center; object-fit: cover; clip-path: inherit; background: #1d2433; font-weight: 800; font-size: 14px; }
  .fu-club { display: flex; align-items: center; gap: 10px; cursor: pointer; } .fu-club b { font-size: 16px; font-weight: 700; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fu-sep { width: 1px; height: 18px; background: rgba(255,255,255,.18); }
  .fu-cur { display: flex; align-items: center; gap: 6px; font-weight: 600; } .fu-cur i { font-style: normal; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; font-weight: 900; border: 1.5px solid currentColor; }
  .fu-cur.elo i { color: #ffc23a; } .fu-cur.xp i { color: #38e1ff; } .fu-cur.st i { color: #b38cff; border: 0; font-size: 15px; }
  .fu-sp { flex: 1; }
  .fu-timer { display: flex; align-items: center; gap: 6px; color: #ff9a3c; font-weight: 700; } .fu-mbar { width: 120px; height: 6px; background: rgba(255,255,255,.12); position: relative; } .fu-mbar i { position: absolute; inset: 0 auto 0 0; background: var(--fu-bl); }
  .fu-lvl { min-width: 26px; height: 26px; display: grid; place-items: center; background: #fff; color: #0b0e14; font-weight: 800; font-size: 15px; padding: 0 6px; }
  .fu-ib { position: relative; width: 34px; height: 30px; border: 0; background: rgba(255,255,255,.07); color: #fff; font-size: 16px; cursor: pointer; } .fu-ib:hover { background: rgba(255,255,255,.18); }
  .fu-ib.fu-frb { width: auto; height: 32px; display: inline-flex; align-items: center; gap: 7px; padding: 0 14px 0 10px; background: linear-gradient(180deg, #2fd16b, #16a34a); color: #fff; font: 800 15px var(--fu-font); letter-spacing: .06em; box-shadow: 0 0 0 1px rgba(255,255,255,.15) inset, 0 4px 16px rgba(34,197,94,.45); animation: frGlow 2.6s ease-in-out infinite; }
  .fu-ib.fu-frb i { font-style: normal; font-size: 16px; } .fu-ib.fu-frb:hover { background: linear-gradient(180deg, #4ade80, #22c55e); box-shadow: 0 0 0 1px rgba(255,255,255,.3) inset, 0 6px 22px rgba(34,197,94,.7); transform: translateY(-1px); }
  @keyframes frGlow { 50% { box-shadow: 0 0 0 1px rgba(255,255,255,.15) inset, 0 4px 24px rgba(34,197,94,.75); } }
  @media (max-width: 760px) { .fu-ib.fu-frb .lb { display: none; } .fu-ib.fu-frb { padding: 0 10px; } }
  .fu-ib .bd { position: absolute; top: -5px; right: -5px; min-width: 16px; height: 16px; border-radius: 8px; background: #e8273f; font: 800 11px var(--fu-font); display: grid; place-items: center; padding: 0 3px; } .fu-ib .bd.hidden { display: none; }
  /* abas */
  .fu-tabs { position: absolute; top: 44px; left: 0; right: 0; height: 46px; display: flex; align-items: center; gap: 4px; padding: 0 22px; z-index: 3; }
  .fu-tabs button { border: 0; background: none; color: rgba(255,255,255,.55); font: 700 19px var(--fu-font); text-transform: uppercase; letter-spacing: .04em; padding: 10px 14px; cursor: pointer; position: relative; transition: color .2s; }
  .fu-tabs button:hover { color: #fff; } .fu-tabs button.on { color: #fff; }
  .fu-tabs button.on::after { content: ''; position: absolute; left: 14px; right: 14px; bottom: 2px; height: 3px; background: var(--fu-or); animation: fuBar .3s ease; }
  @keyframes fuBar { from { transform: scaleX(0); } }
  .fu-key { min-width: 26px; height: 22px; display: inline-grid; place-items: center; padding: 0 6px; border-radius: 4px; background: rgba(255,255,255,.14); font: 800 12px var(--fu-font); color: #fff; }
  .fu-tabs .fu-key { margin: 0 6px; opacity: .7; }
  /* área principal */
  #fuMain { position: absolute; top: 96px; left: 0; right: 0; bottom: 46px; overflow-y: auto; padding: 14px 32px 20px; z-index: 2; scrollbar-width: thin; }
  .fu-head { margin-bottom: 18px; } .fu-head.in > * { animation: rlIn .45s cubic-bezier(.2,.9,.3,1) both; } .fu-head.in > *:nth-child(2) { animation-delay: .04s; } .fu-head.in > *:nth-child(3) { animation-delay: .08s; }
  .fu-crumb { margin-bottom: 2px; } .fu-back { border: 0; background: none; color: rgba(255,255,255,.6); font: 700 16px var(--fu-font); text-transform: uppercase; letter-spacing: .08em; cursor: pointer; padding: 0; } .fu-back:hover { color: #fff; }
  .fu-title { margin: 0; font: italic 900 clamp(40px, 5.6vw, 68px) / .95 var(--fu-font); text-transform: uppercase; letter-spacing: .005em; text-shadow: 0 4px 30px rgba(0,0,0,.5); }
  .fu-sub { margin: 6px 0 10px; font: 500 17px var(--fu-font); color: rgba(255,255,255,.75); max-width: 760px; }
  .fu-chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .fu-chip { display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 12px; font: 700 15px var(--fu-font); text-transform: uppercase; background: rgba(60,66,82,.75); clip-path: polygon(0 0, 100% 0, calc(100% - 8px) 100%, 0 100%); padding-right: 18px; }
  .fu-chip.time { background: var(--fu-bl); } .fu-chip i { font-style: normal; }
  .fu-star { display: inline-block; width: 14px; height: 14px; background: #b38cff; clip-path: polygon(50% 0, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%); margin-left: 4px; vertical-align: -1px; }
  .fu-chip .fu-star { margin: 0; }
  /* cartões */
  .fu-tiles { display: flex; gap: 6px; align-items: stretch; }
  .fu-tiles.many { display: grid; grid-template-columns: repeat(auto-fill, minmax(185px, 1fr)); }
  .fu-tile { position: relative; flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; border: 0; padding: 0; cursor: pointer; color: #fff; text-align: left; background: var(--fu-pan); outline: none; transition: transform .2s cubic-bezier(.2,.9,.3,1.2), filter .2s, box-shadow .2s; font-family: var(--fu-font); overflow: hidden; }
  .fu-tile.wide { flex: 1.45 1 0; }
  .fu-tiles.in .fu-tile { animation: rlIn .5s cubic-bezier(.2,.9,.3,1) both; } ${[1, 2, 3, 4, 5, 6, 7].map(i => `.fu-tiles.in .fu-tile:nth-child(${i + 1}) { animation-delay: ${i * 0.05}s; }`).join(' ')}
  .fu-art { position: relative; height: clamp(170px, 34vh, 300px); overflow: hidden; background: radial-gradient(ellipse at 50% 40%, rgba(255,255,255,.07), transparent 65%), linear-gradient(180deg, #1c2230, #10141d); }
  .fu-tile.small .fu-art { height: clamp(150px, 26vh, 220px); }
  .fu-svg { position: absolute; inset: 0; width: 100%; height: 100%; transition: transform .45s cubic-bezier(.2,.9,.3,1); }
  .fu-swoosh { position: absolute; inset: 0; width: 100%; height: 100%; opacity: .7; transition: opacity .3s, transform .5s; pointer-events: none; }
  .fu-tt { position: absolute; left: 14px; right: 12px; bottom: 10px; font: italic 900 clamp(24px, 2.6vw, 36px) / .95 var(--fu-font); text-transform: uppercase; text-shadow: 0 3px 14px rgba(0,0,0,.8); }
  .fu-tile.small .fu-tt { font-size: clamp(20px, 1.9vw, 27px); }
  .fu-badge { position: absolute; top: 10px; left: 10px; background: var(--fu-or); font: 800 13px var(--fu-font); letter-spacing: .06em; padding: 3px 8px; }
  .fu-foot { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 6px; padding: 9px 14px 11px; background: rgba(34,39,52,.95); border-bottom: 4px solid transparent; transition: border-color .2s; }
  .fu-foot small { display: block; font: 600 12.5px var(--fu-font); text-transform: uppercase; color: rgba(255,255,255,.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fu-foot b { display: block; font: 700 19px var(--fu-font); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fu-tile.sel, .fu-tile:focus-visible { transform: translateY(-4px); box-shadow: 0 18px 40px rgba(0,0,0,.55); z-index: 1; }
  .fu-tile.sel .fu-foot, .fu-tile:focus-visible .fu-foot { border-bottom-color: var(--fu-or); }
  .fu-tile.sel .fu-svg { transform: scale(1.06); } .fu-tile.sel .fu-swoosh { opacity: .85; transform: translateX(-3%); }
  .fu-tile.cur .fu-foot { background: linear-gradient(90deg, rgba(255,107,26,.35), rgba(34,39,52,.95)); }
  .fu-tile.locked .fu-art > *:not(.fu-tt) { filter: grayscale(1) brightness(.45); } .fu-tile.locked .fu-tt { opacity: .7; }
  .fu-lock { position: absolute; top: 0; right: 0; width: 46px; height: 46px; background: linear-gradient(45deg, transparent 50%, rgba(220,226,236,.9) 50%); } .fu-lock i { position: absolute; top: 4px; right: 5px; font-style: normal; font-size: 13px; filter: grayscale(1) brightness(.2); }
  .fu-locktxt { position: absolute; left: 12px; right: 12px; top: 34%; text-align: center; font: 600 15px var(--fu-font); color: rgba(255,255,255,.85); }
  .fu-sk { position: absolute; inset: 0; background: radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--rc) 50%, transparent), transparent 62%); }
  .fu-sk img { position: absolute; top: 12%; width: 50%; aspect-ratio: 1; border-radius: 47%; object-fit: cover; box-shadow: 0 10px 22px rgba(0,0,0,.55), 0 0 0 3px rgba(0,0,0,.35); transition: transform .4s cubic-bezier(.2,.9,.3,1); }
  .fu-sk img.f { left: 14%; transform: rotate(-10deg); z-index: 1; } .fu-sk img.b { right: 10%; top: 8%; transform: rotate(12deg) scale(.86); filter: brightness(.8); }
  .fu-tile.sel .fu-sk img.f { transform: rotate(-4deg) scale(1.06); } .fu-tile.sel .fu-sk img.b { transform: rotate(18deg) scale(.9) translateX(6%); }
  .fu-skn { position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,.55); font: 700 12.5px var(--fu-font); padding: 3px 8px; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fu-rar { position: absolute; top: 10px; right: 10px; font: 800 12px var(--fu-font); letter-spacing: .08em; padding: 3px 8px; color: #0b0e14; background: var(--rr); }
  .fu-rk { position: absolute; inset: 0; display: grid; place-items: center; background: radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--rc) 45%, transparent), transparent 62%); }
  .fu-rk img { width: 78%; max-height: 92%; object-fit: contain; transform: rotate(-18deg); filter: drop-shadow(0 18px 24px rgba(0,0,0,.55)); transition: transform .45s cubic-bezier(.2,.9,.3,1); }
  .fu-tile.sel .fu-rk img { transform: rotate(-10deg) scale(1.06); }
  .fu-bigav { position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%); width: 54%; aspect-ratio: 1; object-fit: cover; clip-path: polygon(50% 0, 100% 12%, 100% 62%, 50% 100%, 0 62%, 0 12%); background: #2a3142; display: grid; place-items: center; font: italic 900 72px var(--fu-font); }
  .fu-code { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 0 18px 40px; z-index: 1; }
  .fu-code small { font: 700 14px var(--fu-font); letter-spacing: .14em; color: rgba(255,255,255,.65); }
  .fu-code input { width: 100%; max-width: 230px; background: rgba(0,0,0,.45); border: 2px solid rgba(255,255,255,.25); border-radius: 0; font: 800 30px var(--fu-font); letter-spacing: .35em; text-align: center; padding: 8px; color: #fff; }
  .fu-code input:focus { border-color: var(--fu-or); }
  .fu-tile.small .fu-code { padding-bottom: 10px; } .fu-tile.small .fu-code input { font-size: 22px; letter-spacing: .2em; padding: 6px; }
  .fu-codego { border: 0; background: #fff; color: #0b0e14; font: 800 17px var(--fu-font); padding: 8px 18px; cursor: pointer; } .fu-codego:hover { background: var(--fu-or); color: #fff; }
  /* opções (cenário, formato) e seções */
  .fu-opts, .fu-sec { margin-top: 12px; background: var(--fu-pan); padding: 12px 16px; }
  .fu-opt { display: grid; grid-template-columns: 130px 1fr auto; align-items: center; gap: 14px; padding: 8px 0; } .fu-opt + .fu-opt { border-top: 1px solid rgba(255,255,255,.06); }
  .fu-ol, .fu-st { font: 700 17px var(--fu-font); text-transform: uppercase; letter-spacing: .06em; color: rgba(255,255,255,.7); }
  .fu-st { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; } .fu-st small { font-size: 14px; color: var(--fu-or); }
  .fu-ov { display: flex; align-items: center; gap: 12px; } .fu-ov b { flex: 1; text-align: center; font: 700 21px var(--fu-font); } .fu-ov b small { display: block; font: 500 14px var(--fu-font); color: rgba(255,255,255,.55); }
  .fu-arr { width: 34px; height: 34px; border: 0; background: rgba(255,255,255,.08); color: #fff; font: 800 22px var(--fu-font); cursor: pointer; } .fu-arr:hover { background: #fff; color: #0b0e14; }
  .fu-dots { display: flex; gap: 5px; } .fu-dots i { width: 18px; height: 4px; background: rgba(255,255,255,.2); } .fu-dots i.on { background: var(--fu-or); }
  .fu-seg { display: flex; gap: 6px; grid-column: span 2; } .fu-seg button { flex: 1; border: 0; background: rgba(255,255,255,.07); color: #fff; font: 700 19px var(--fu-font); text-transform: uppercase; padding: 7px 10px; cursor: pointer; border-bottom: 3px solid transparent; }
  .fu-seg button small { display: block; font: 500 13px var(--fu-font); text-transform: none; color: rgba(255,255,255,.6); }
  .fu-seg button:hover { background: rgba(255,255,255,.14); } .fu-seg button.on { background: #fff; color: #0b0e14; border-bottom-color: var(--fu-or); } .fu-seg button.on small { color: #475569; }
  .fu-note { margin: 6px 0 0; font: 500 14px var(--fu-font); color: rgba(255,255,255,.5); }
  .fu-balls { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; }
  .fu-bt { border: 0; background: rgba(255,255,255,.05); color: #fff; padding: 12px 6px 9px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; font-family: var(--fu-font); border-bottom: 3px solid transparent; transition: background .2s, transform .2s; }
  .fu-bt:hover { background: rgba(255,255,255,.12); transform: translateY(-2px); } .fu-bt.cur { border-bottom-color: var(--fu-or); background: rgba(255,107,26,.16); }
  .fu-bt b { font: 700 16px var(--fu-font); } .fu-bt small { font: 600 12px var(--fu-font); color: rgba(255,255,255,.55); text-transform: uppercase; }
  .fu-ball { width: 42px; height: 42px; border-radius: 50%; box-shadow: inset -6px -8px 14px rgba(0,0,0,.35), 0 6px 14px rgba(0,0,0,.4); }
  .fu-bt.locked .fu-ball { filter: grayscale(1) brightness(.5); }
  .fu-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .fu-btn { border: 0; background: rgba(255,255,255,.1); color: #fff; font: 700 17px var(--fu-font); text-transform: uppercase; letter-spacing: .03em; padding: 10px 16px; cursor: pointer; transition: background .15s, color .15s; }
  .fu-btn:hover { background: #fff; color: #0b0e14; } .fu-btn.ghost { background: none; box-shadow: inset 0 0 0 1px rgba(255,255,255,.2); }
  /* perfil */
  .fu-profile { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; gap: 12px; align-items: start; } .fu-profile.in > * { animation: rlIn .45s both; }
  .fu-pcard { background: var(--fu-pan); position: relative; overflow: hidden; }
  .fu-pav { position: relative; height: 260px; background: radial-gradient(circle at 50% 45%, rgba(255,107,26,.35), transparent 60%), linear-gradient(180deg, #1c2230, #10141d); }
  .fu-pinfo { padding: 12px 16px 14px; background: rgba(34,39,52,.95); border-bottom: 4px solid var(--fu-or); }
  .fu-pinfo > b { display: block; font: italic 900 32px var(--fu-font); text-transform: uppercase; } .fu-pinfo > span { font: 600 15px var(--fu-font); color: rgba(255,255,255,.65); }
  .fu-pstats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 10px; } .fu-pstats small { display: block; font: 600 12px var(--fu-font); color: rgba(255,255,255,.55); text-transform: uppercase; } .fu-pstats b { font: 700 18px var(--fu-font); }
  .fu-avgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; }
  .fu-avt { position: relative; border: 0; padding: 8px 8px 6px; background: rgba(255,255,255,.05); cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; border-bottom: 3px solid transparent; transition: background .2s, transform .2s; color: #fff; }
  .fu-avt .av { width: 100%; aspect-ratio: 1; object-fit: cover; display: grid; place-items: center; background: #2a3142; font: 800 30px var(--fu-font); }
  .fu-avt small { font: 600 12px var(--fu-font); text-transform: uppercase; color: rgba(255,255,255,.6); }
  .fu-avt:hover { background: rgba(255,255,255,.12); transform: translateY(-3px); } .fu-avt.cur { border-bottom-color: var(--fu-or); background: rgba(255,107,26,.18); } .fu-avt.locked .av { filter: grayscale(1) brightness(.45); }
  /* rodapé de teclas */
  .fu-hints { position: absolute; left: 0; right: 0; bottom: 0; height: 46px; display: flex; align-items: center; gap: 22px; padding: 0 32px; z-index: 3; font: 600 16px var(--fu-font); color: rgba(255,255,255,.85); background: linear-gradient(0deg, rgba(5,7,12,.85), transparent); }
  .fu-hints span { display: flex; align-items: center; gap: 8px; cursor: default; } .fu-hints .fu-key { border-radius: 50%; min-width: 24px; height: 24px; background: rgba(255,255,255,.9); color: #0b0e14; }
  .fu-hints .fu-sp { flex: 1; } .fu-hints small { font: 600 12px var(--fu-font); letter-spacing: .1em; color: rgba(255,255,255,.4); }
  /* janelas por cima do menu (sala, conectando, fila) */
  #lobby.fut #wait, #lobby.fut #joining, #lobby.fut #rankedPanel { position: absolute; z-index: 5; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(440px, 92vw); margin: 0; background: rgba(18,22,31,.97); border-bottom: 4px solid var(--fu-or); padding: 24px; text-align: center; box-shadow: 0 30px 90px rgba(0,0,0,.7); animation: fuPop .35s cubic-bezier(.2,1.2,.4,1); font-family: var(--fu-font); }
  #lobby.fut #wait .btn, #lobby.fut #joining .btn, #lobby.fut #rankedPanel .btn { border-radius: 0; font: 700 18px var(--fu-font); text-transform: uppercase; }
  #lobby.fut #wait .btn:not(.ghost):not(.green) { background: #fff; color: #0b0e14; box-shadow: none; }
  #lobby.fut .code { font-family: var(--fu-font); font-style: italic; font-weight: 900; }
  @keyframes fuPop { from { opacity: 0; transform: translate(-50%, -46%) scale(.96); } }
  #lobby.fut #lobbyMsg { position: absolute; left: 50%; bottom: 56px; transform: translateX(-50%); z-index: 6; margin: 0; background: rgba(60,10,24,.9); padding: 8px 16px; font: 600 16px var(--fu-font); }
  #lobby.fut #lobbyMsg:empty { display: none; }
  /* telas abertas pelo menu (ajustes, amigos, ranking, admin): mesmo visual */
  .screen.fuov { background: linear-gradient(180deg, rgba(5,7,12,.82), rgba(5,7,12,.95)), var(--fu-bgimg, none) center / cover; padding: 0; align-items: stretch; font-family: var(--fu-font); }
  .screen.fuov > .card { max-width: 1120px !important; width: 100%; margin: 0 auto; background: none; border: 0; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; border-radius: 0; padding: 30px 36px 70px; text-align: left; max-height: none; overflow: visible; animation: rlIn .4s both; }
  .screen.fuov .cf-head, .screen.fuov > .card > h2 { margin-bottom: 14px; }
  .screen.fuov h2 { font: italic 900 clamp(40px, 5.4vw, 64px) / .95 var(--fu-font); text-transform: uppercase; margin: 0; }
  .screen.fuov .cf-x { width: auto; height: 34px; border-radius: 0; padding: 0 14px; font: 700 16px var(--fu-font); text-transform: uppercase; background: rgba(255,255,255,.1); }
  .screen.fuov .cf-x::before { content: 'ESC  '; opacity: .55; } .screen.fuov .cf-x:hover { background: #fff; color: #0b0e14; }
  .screen.fuov .cf-sec, .screen.fuov .adm-box, .screen.fuov .fr-sec, .screen.fuov .rk-list { background: var(--fu-pan); border: 0; border-radius: 0; padding: 12px 16px; }
  .screen.fuov .cf-t, .screen.fuov .fr-t { font: 700 17px var(--fu-font); letter-spacing: .06em; color: rgba(255,255,255,.75); }
  .screen.fuov .cf-l { font: 600 17px var(--fu-font); } .screen.fuov .cf-l small { font: 500 13.5px var(--fu-font); }
  .screen.fuov .btn, .screen.fuov .cf-save, .screen.fuov .cf-q { border-radius: 0; font-family: var(--fu-font); font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
  .screen.fuov .btn:not(.ghost) { background: #fff; color: #0b0e14; box-shadow: none; } .screen.fuov .btn.ghost { background: rgba(255,255,255,.08); }
  .screen.fuov .cf-q.on { background: #fff; color: #0b0e14; }
  .screen.fuov .cf-foot { display: flex; gap: 8px; margin-top: 14px; } .screen.fuov .cf-foot .btn { width: auto; padding: 12px 24px; }
  .screen.fuov input[type=range] { accent-color: var(--fu-or); }
  .screen.fuov .muted, .screen.fuov p { font-family: var(--fu-font); font-size: 16px; }
  .screen.fuov .rk-row { font-family: var(--fu-font); font-size: 17px; border-radius: 0; grid-template-columns: 44px 34px 1fr auto 64px 70px; }
  .screen.fuov .rk-row.me { background: rgba(255,107,26,.22); box-shadow: inset 4px 0 0 var(--fu-or); }
  #authGate .ag-logo, #authGate .ag-h, #authGate .btn, #authGate .ag-tabs button, #authGate .ag-or { font-family: var(--fu-font); }
  #authGate .btn { font-size: 18px; text-transform: uppercase; }
  .rk-av { width: 30px; height: 30px; object-fit: cover; display: grid; place-items: center; background: #2a3142; font-weight: 800; }
  .fr-av { object-fit: cover; }
  .fu-tile .fxw { z-index: 2; }
  .screen.fuov .fr-row { border-radius: 0; }
  @media (max-width: 760px) {
    .fu-top { padding: 0 10px; gap: 8px; font-size: 13px; } .fu-cur.xp, .fu-timer, .fu-mbar, .fu-sep.s2, .fu-club b { display: none; }
    .fu-tabs { overflow-x: auto; padding: 0 6px; } .fu-tabs button { font-size: 16px; padding: 10px 10px; flex: none; } .fu-tabs .fu-key { display: none; }
    #fuMain { padding: 10px 12px 20px; } .fu-tiles { flex-direction: column; } .fu-tile, .fu-tile.wide { flex: none; } .fu-art { height: 150px; }
    .fu-tiles.many { grid-template-columns: 1fr 1fr; } .fu-hints { display: none; } #fuMain { bottom: 0; }
    .fu-profile { grid-template-columns: 1fr; } .fu-opt { grid-template-columns: 1fr; gap: 6px; } .fu-seg { grid-column: auto; }
    .screen.fuov > .card { padding: 20px 14px 40px; }
  }`;
  document.head.appendChild(st);

  const lobby = $('lobby'), card = lobby.querySelector('.card'), menu = $('menu');
  lobby.classList.add('fut', 'rl');
  // fundo (mesma arte), com zoom lento
  const bg = h('div', { class: 'rl-bg' }), small = window.innerWidth < 900, img = new Image();
  img.onload = () => { bg.style.backgroundImage = `url("${img.src}")`; document.documentElement.style.setProperty('--fu-bgimg', `url("${img.src}")`); };
  img.onerror = () => { if (!img.dataset.f) { img.dataset.f = 1; img.src = ASSET_BASES[1] + (small ? 'menu-bg-small.jpg' : 'menu-bg.jpg'); } };
  img.src = ASSET_BASES[0] + (small ? 'menu-bg-small.jpg' : 'menu-bg.jpg');
  lobby.prepend(bg, h('div', { class: 'rl-shade' }));
  // o que existia no menu vai para um depósito escondido (os ids e eventos continuam valendo)
  const hold = h('div', { id: 'fuHold' }); hold.append(...menu.children); card.append(hold);
  const ic = (txt, title, fn, id) => { const b = h('button', { class: 'fu-ib', title, 'aria-label': title, id }, txt); b.onclick = fn; return b; };
  const frB = ic('', 'Amigos', () => openFriends(), 'fuFr'); frB.classList.add('fu-frb'); frB.append(h('i', { text: '👥' }), h('span', { class: 'lb', text: 'AMIGOS' }), h('span', { class: 'bd hidden', id: 'fuFrBadge' }));
  const club = h('div', { class: 'fu-club', title: 'Perfil' }, h('div', { class: 'fu-crest', id: 'fuCrest' }), h('b', { id: 'fuName' }), h('span', { id: 'fuFdr' }), h('span', { class: 'fu-key', id: 'fuEst' }));
  club.onclick = () => { UI.stack = []; showPage('profile'); };
  const top = h('div', { class: 'fu-top' }, club, h('i', { class: 'fu-sep' }),
    h('span', { class: 'fu-cur elo', title: 'Elo' }, h('i', { text: 'E' }), h('span', { id: 'fuElo' })),
    h('span', { class: 'fu-cur xp', title: 'XP total' }, h('i', { text: 'XP' }), h('span', { id: 'fuXp' })),
    h('span', { class: 'fu-cur st', title: 'Missões de hoje' }, h('i', { text: '★' }), h('span', { id: 'fuStars' })),
    h('i', { class: 'fu-sp' }),
    h('span', { class: 'fu-timer', title: 'Novas missões em' }, '⏱ ', h('span', { id: 'fuTimer' })),
    h('span', { class: 'fu-mbar', title: 'Missões de hoje' }, h('i', { id: 'fuMisBar' })), h('span', { id: 'fuMisTxt' }), h('i', { class: 'fu-sep s2' }),
    h('span', { class: 'fu-lvl', id: 'fuLvl', title: 'Nível' }), frB, ic('🏆', 'Ranking', () => openRanking()), ic('⚙️', 'Ajustes', () => openSettings()));
  const tabs = h('div', { class: 'fu-tabs', role: 'tablist' }, h('span', { class: 'fu-key', text: 'Q' }),
    ...TABS.map(([id, label]) => { const b = h('button', { 'data-t': id, role: 'tab', text: label }); b.onclick = () => { ensureAudio(); futTab(id); }; return b; }), h('span', { class: 'fu-key', text: 'E' }));
  const hints = h('div', { class: 'fu-hints' }, h('span', {}, h('i', { class: 'fu-key', text: '⏎' }), 'Selecionar'), h('span', {}, h('i', { class: 'fu-key', text: 'Esc' }), 'Voltar'),
    h('span', {}, h('i', { class: 'fu-key', text: '↔' }), 'Mover'), h('span', {}, h('i', { class: 'fu-key', text: 'Q' }), h('i', { class: 'fu-key', text: 'E' }), 'Abas'),
    h('i', { class: 'fu-sp' }), h('small', { text: 'STEAM É MARCA DA VALVE · JOGO NÃO AFILIADO' }));
  menu.append(top, tabs, h('div', { id: 'fuMain' }), hints);
  for (const id of ['cfgScreen', 'frScreen', 'rankScreen', 'admScreen']) { const s = $(id); if (s) { s.classList.add('fuov'); s.querySelectorAll('h2').forEach(x => { x.textContent = x.textContent.replace(/^[^\p{L}]+/u, ''); }); } }
  // teclado: setas movem, Enter escolhe, Esc volta, Q/E trocam de aba
  window.addEventListener('keydown', e => {
    if ($('lobby').classList.contains('hidden') || S.phase !== 'lobby') return;
    const ov = document.querySelector('.screen.fuov:not(.hidden)');
    if (ov) { if (e.key === 'Escape' && ov.id !== 'cfgScreen') { if (ov.id === 'frScreen') closeFriends(); else ov.classList.add('hidden'); } return; }
    if ($('authGate') && !$('authGate').classList.contains('hidden')) return;
    if (!$('menu') || $('menu').classList.contains('hidden')) return;
    const typing = /INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape') { if (typing) document.activeElement.blur(); else futBack(); return; }
    if (typing) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); futSel(UI.sel + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); futSel(UI.sel - 1); }
    else if (e.key === 'Enter' && document.activeElement === document.body) { const t = document.querySelectorAll('#fuMain .fu-tile')[UI.sel]; if (t) t.click(); }
    else if (e.key === 'q' || e.key === 'e' || e.key === 'Q' || e.key === 'E') {
      const order = TABS.map(t => t[0]), cur = order.indexOf(TAB_OF[UI.page] || UI.page);
      const nx = order[(cur + (e.key.toLowerCase() === 'e' ? 1 : -1) + order.length) % order.length]; futTab(nx);
    }
  });
  window.__futReady = true;
  renderFut(true);
  setInterval(() => { if (!$('lobby').classList.contains('hidden')) renderTop(); }, 5000);
}
// quando o perfil, as missões ou a raquete mudam, o menu se atualiza
function renderTopProfile() { if (window.__futReady && $('fuMain')) { const a = document.activeElement; if (a && a.id === 'inCode') renderTop(); else renderFut(); } }


/* =====================================================================
   TELA DE ENTRADA (antes do menu): Steam ou email
   Aparece por cima de tudo enquanto não houver conta logada.
   ===================================================================== */
const GATE = { view: 'check', tab: 'login', busy: false, email: '', after: [], shown: false, passed: false };
function gateAfter(fn) { if (acct.user || acct.failed) fn(); else GATE.after.push(fn); }
const AUTH_ERR = [
  [/invalid login credentials/i, 'Email ou senha incorretos.'],
  [/email not confirmed/i, 'Falta confirmar o email. Abra o link que mandamos (veja também o spam).'],
  [/already registered|already been registered|user already exists/i, 'Esse email já tem conta. Entre com a senha.'],
  [/password should be at least|weak.?password|password is too weak/i, 'Senha fraca: use pelo menos 8 caracteres, misturando letras e números.'],
  [/email rate limit|over_email_send/i, 'O envio de emails de confirmação está no limite agora. Tente de novo mais tarde ou entre com a Steam.'],
  [/rate limit|too many|security purposes/i, 'Muitas tentativas agora. Espere um minuto e tente de novo.'],
  [/invalid.*email|unable to validate email/i, 'Esse email não parece válido.'],
  [/signups not allowed|signup.*disabled/i, 'Cadastro por email desligado no momento. Use a Steam.'],
  [/network|fetch|failed to/i, 'Sem conexão com o servidor. Confira a internet.'],
];
const authMsg = e => { const m = (e && e.message) || String(e || ''); const f = AUTH_ERR.find(([r]) => r.test(m)); return f ? f[1] : 'Não deu certo: ' + m.slice(0, 90); };

function gateSync() {
  const g = $('authGate'); if (!g) return;
  if (new URLSearchParams(location.search).get('reset') === '1' && acct.user && !GATE.passed) GATE.view = 'reset';
  const inGame = S.phase !== 'lobby';                    // partida começou (link de sala, testes): a tela sai da frente
  const need = !inGame && (GATE.view === 'reset' || (!acct.user && !acct.failed) || (acct.failed && !GATE.offline));
  if (acct.user && GATE.view !== 'reset') {
    GATE.view = 'in';
    if (GATE.after.length) setTimeout(() => GATE.after.splice(0).forEach(f => { try { f(); } catch (e) { console.warn(e); } }), 0);
  } else if (!acct.user && GATE.view === 'in') GATE.view = 'form';
  else if (acct.failed && GATE.view === 'check') GATE.view = 'error';
  else if (!acct.user && acct.checked && GATE.view === 'check') GATE.view = 'form';
  if (need && !GATE.shown) { g.classList.remove('hidden', 'leave'); GATE.shown = true; }
  else if (!need && GATE.shown) {
    GATE.shown = false; g.classList.add('leave');
    setTimeout(() => { if (!GATE.shown) g.classList.add('hidden'); }, 650);
    if (!inGame) menuEnterFx();
  }
  if (!acct.user) GATE.passed = false;
  if (actx) updateMenuMusic();
  if (acct.failed && GATE.offline && GATE.after.length) GATE.after.splice(0).forEach(f => f());
  renderGate();
}
function menuEnterFx() {                                   // os botões do menu entram de novo, em cascata
  document.querySelectorAll('.fu-top, .fu-tabs, .fu-head > *, #fuMain .fu-tile').forEach((el, i) => {
    el.style.animation = 'none'; void el.offsetWidth;
    el.style.animation = `rlIn .55s cubic-bezier(.2,.9,.3,1) ${0.25 + i * 0.045}s both`;
  });
}
function renderGate() {
  const body = $('agBody'); if (!body) return;
  const v = GATE.view; body.textContent = ''; GATE.busy = false;
  body.dataset.v = v;
  const field = (type, name, label, auto, extra = {}) => {
    const i = h('input', { type, name, id: 'ag_' + name, autocomplete: auto, required: true, spellcheck: 'false', ...extra });
    return h('label', { class: 'ag-f' }, h('span', { text: label }), i);
  };
  const err = h('div', { class: 'ag-err', id: 'agErr', role: 'alert' });
  const note = GATE.notice && (v === 'form') ? h('div', { class: 'ag-note' + (GATE.notice.bad ? ' bad' : ''), text: GATE.notice.text }) : null;
  const steamBtn = () => {
    const b = h('button', { type: 'button', class: 'ag-steam', id: 'agSteam', 'aria-label': 'Entrar com a Steam' });
    const im = h('img', { src: 'https://community.fastly.steamstatic.com/public/images/signinthroughsteam/sits_01.png', alt: 'Sign in through Steam', width: 180, height: 35 });
    im.onerror = () => { b.textContent = 'Entrar com a Steam'; };
    b.append(im, h('span', { text: 'Entrar com a Steam' }));
    b.onclick = () => { b.classList.add('go'); loginSteam(); };
    return b;
  };
  if (v === 'check' || v === 'in') {
    body.append(h('div', { class: 'ag-wait' }, h('span', { class: 'spinner' }), h('span', { text: v === 'in' ? 'Entrando…' : 'Conectando…' })));
    return;
  }
  if (v === 'error') {
    const r = h('button', { class: 'btn', type: 'button', text: 'Tentar de novo' }); r.onclick = () => location.reload();
    const o = h('button', { class: 'btn ghost', type: 'button', text: 'Treinar offline (sem conta)' }); o.onclick = () => { GATE.offline = true; gateSync(); };
    body.append(h('div', { class: 'ag-h', text: 'Servidor de contas fora do ar' }), h('p', { class: 'ag-p', text: 'Não conseguimos falar com o servidor agora. Você pode tentar de novo ou treinar contra a CPU enquanto isso (sem salvar progresso).' }), h('div', { class: 'ag-col' }, r, o));
    return;
  }
  if (v === 'sent') {
    const again = h('button', { class: 'btn ghost', type: 'button', text: 'Reenviar email' });
    again.onclick = async () => {
      again.disabled = true;
      try { const sb = await sbLoad(); const { error } = GATE.sentKind === 'reset' ? await sb.auth.resetPasswordForEmail(GATE.email, { redirectTo: location.origin + location.pathname + '?reset=1' }) : await sb.auth.resend({ type: 'signup', email: GATE.email, options: { emailRedirectTo: location.origin + location.pathname } }); if (error) throw error; toast('Email reenviado'); }
      catch (e) { $('agErr').textContent = authMsg(e); }
      setTimeout(() => { again.disabled = false; }, 30000);
    };
    const back = h('button', { class: 'ag-link', type: 'button', text: '← Voltar para o login' }); back.onclick = () => { GATE.view = 'form'; GATE.tab = 'login'; renderGate(); };
    body.append(h('div', { class: 'ag-mail', text: '✉️' }), h('div', { class: 'ag-h', text: 'Confira seu email' }),
      h('p', { class: 'ag-p' }, GATE.sentKind === 'reset' ? 'Mandamos um link para criar uma senha nova em ' : 'Mandamos um link de confirmação para ', h('b', { text: GATE.email }), '. Abra o link neste aparelho para entrar. Não chegou? Olhe o spam.'),
      err, h('div', { class: 'ag-col' }, again), back);
    return;
  }
  if (v === 'reset') {
    const f = h('form', { class: 'ag-form', novalidate: true });
    f.append(h('div', { class: 'ag-h', text: 'Crie uma senha nova' }), field('password', 'pw', 'Nova senha', 'new-password', { minlength: 8 }), err, h('button', { class: 'btn ag-go', type: 'submit', text: 'Salvar e entrar' }));
    f.onsubmit = async e => {
      e.preventDefault(); const pw = f.pw.value;
      if (pw.length < 8) { err.textContent = 'A senha precisa ter pelo menos 8 caracteres.'; return; }
      gateBusy(f, true);
      try { const sb = await sbLoad(); const { error } = await sb.auth.updateUser({ password: pw }); if (error) throw error;
        history.replaceState(null, '', location.pathname); GATE.view = 'in'; GATE.passed = true; toast('Senha nova salva ✔'); gateSync(); }
      catch (x) { err.textContent = authMsg(x); gateBusy(f, false); }
    };
    body.append(f); setTimeout(() => f.pw.focus(), 50);
    return;
  }
  // formulário principal: Steam em cima, email embaixo
  const tabs = h('div', { class: 'ag-tabs', role: 'tablist' });
  for (const [k, t] of [['login', 'Entrar'], ['signup', 'Criar conta']]) {
    const b = h('button', { type: 'button', role: 'tab', class: GATE.tab === k ? 'on' : '', 'aria-selected': String(GATE.tab === k), text: t });
    b.onclick = () => { if (GATE.tab !== k) { GATE.tab = k; renderGate(); } };
    tabs.append(b);
  }
  tabs.append(h('i', { class: 'ag-ind', style: `transform: translateX(${GATE.tab === 'login' ? 0 : 100}%)` }));
  const su = GATE.tab === 'signup', fg = GATE.tab === 'forgot';
  const f = h('form', { class: 'ag-form', novalidate: true });
  if (fg) {
    f.append(h('div', { class: 'ag-h', text: 'Esqueci a senha' }), h('p', { class: 'ag-p', text: 'Digite o email da conta. Vamos mandar um link para criar uma senha nova.' }),
      field('email', 'email', 'Email', 'email', { value: GATE.email }), err, h('button', { class: 'btn ag-go', type: 'submit', text: 'Mandar link' }));
    const back = h('button', { class: 'ag-link', type: 'button', text: '← Voltar' }); back.onclick = () => { GATE.tab = 'login'; renderGate(); };
    f.append(back);
  } else {
    if (su) f.append(field('text', 'name', 'Nome no jogo', 'nickname', { minlength: 3, maxlength: 20 }));
    f.append(field('email', 'email', 'Email', 'email', { value: GATE.email }));
    const pw = field('password', 'pw', su ? 'Senha (mín. 8 caracteres)' : 'Senha', su ? 'new-password' : 'current-password', { minlength: su ? 8 : 1 });
    const eye = h('button', { type: 'button', class: 'ag-eye', 'aria-label': 'Mostrar senha', text: '👁' });
    eye.onclick = () => { const i = pw.querySelector('input'); i.type = i.type === 'password' ? 'text' : 'password'; eye.classList.toggle('on'); };
    pw.append(eye); f.append(pw, err);
    if (su) f.append(h('p', { class: 'ag-terms', text: 'Ao criar a conta você aceita que guardemos seu nome, email e estatísticas do jogo para o ranking. Nada é vendido nem usado para propaganda.' }));
    f.append(h('button', { class: 'btn ag-go', type: 'submit', text: su ? 'Criar conta' : 'Entrar' }));
    if (!su) { const fl = h('button', { class: 'ag-link', type: 'button', text: 'Esqueci minha senha' }); fl.onclick = () => { GATE.email = f.email.value.trim(); GATE.tab = 'forgot'; renderGate(); }; f.append(fl); }
  }
  f.onsubmit = e => { e.preventDefault(); gateSubmit(f); };
  body.append(...[note, steamBtn(), h('div', { class: 'ag-or' }, h('span', { text: 'ou com email' })), fg ? null : tabs, f].filter(Boolean));   // append nativo escreve "null" se passar vazio
}
function gateBusy(f, on) { GATE.busy = on; f.querySelectorAll('input,button').forEach(x => { x.disabled = on; }); const g = f.querySelector('.ag-go'); if (g) g.classList.toggle('busy', on); }
async function gateSubmit(f) {
  if (GATE.busy) return;
  const err = $('agErr'); err.textContent = '';
  const email = (f.email.value || '').trim().toLowerCase(); GATE.email = email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = 'Digite um email válido.'; f.email.focus(); return; }
  const sb = await sbLoad(); if (!sb) { err.textContent = 'Sem conexão com o servidor.'; return; }
  const back = location.origin + location.pathname;
  gateBusy(f, true);
  try {
    if (GATE.tab === 'forgot') {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: back + '?reset=1' }); if (error) throw error;
      GATE.sentKind = 'reset'; GATE.view = 'sent'; renderGate(); return;
    }
    const pw = f.pw.value;
    if (GATE.tab === 'signup') {
      const nm = (f.name.value || '').trim();
      if (nm.length < 3 || nm.length > 20) throw new Error('O nome precisa ter de 3 a 20 caracteres.');
      if (pw.length < 8 || !/[a-z]/i.test(pw) || !/\d/.test(pw)) throw new Error('weak password');
      const { data, error } = await sb.auth.signUp({ email, password: pw, options: { data: { name: nm }, emailRedirectTo: back } });
      if (error) throw error;
      if (data && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw new Error('already registered');
      if (!data.session) { GATE.sentKind = 'signup'; GATE.view = 'sent'; renderGate(); return; }
    } else {
      if (!pw) throw new Error('Digite a senha.');
      const { error } = await sb.auth.signInWithPassword({ email, password: pw }); if (error) throw error;
    }
    GATE.view = 'in'; GATE.passed = true; renderGate();       // a mudança de sessão faz o resto
  } catch (e) {
    const m = e.message || '';
    err.textContent = /^(O nome|Digite)/.test(m) ? m : authMsg(e);
    gateBusy(f, false);
    if (/email not confirmed/i.test(m)) {
      const again = h('button', { class: 'ag-link', type: 'button', text: 'Reenviar email de confirmação' });
      again.onclick = async () => { again.disabled = true; try { const sb = await sbLoad(); const { error } = await sb.auth.resend({ type: 'signup', email, options: { emailRedirectTo: location.origin + location.pathname } }); if (error) throw error; GATE.sentKind = 'signup'; GATE.view = 'sent'; renderGate(); } catch (x) { err.textContent = authMsg(x); again.disabled = false; } };
      err.after(again);
    }
    const card = document.querySelector('.ag-card'); card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  }
}
function initGate() {
  const st = document.createElement('style');
  st.textContent = `
  #authGate { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; overflow-y: auto; background: #04060c; transition: opacity .6s, transform .6s, filter .6s; }
  #authGate.leave { opacity: 0; transform: scale(1.06); filter: blur(6px); pointer-events: none; }
  #authGate .rl-bg { position: fixed; inset: -4%; background: #04060c center / cover no-repeat; animation: rlKen 38s ease-in-out infinite alternate; }
  #authGate .rl-sweep { position: fixed; top: 0; bottom: 0; width: 30%; left: -40%; background: linear-gradient(100deg, transparent, rgba(120,200,255,.07), transparent); animation: rlSweep 9s ease-in-out infinite; pointer-events: none; }
  #authGate .rl-shade { position: fixed; inset: 0; background: radial-gradient(ellipse at 50% 45%, rgba(3,5,12,.45), rgba(3,5,12,.88) 80%); }
  .ag-wrap { position: relative; z-index: 2; width: min(420px, 92vw); padding: 28px 0; display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .ag-logo { font: italic 900 46px system-ui; line-height: .9; text-align: center; letter-spacing: .01em; text-shadow: 0 0 40px rgba(80,170,255,.45); animation: agDrop .8s cubic-bezier(.2,1.2,.4,1) both; }
  .ag-logo span { display: block; font: 800 13px system-ui; letter-spacing: .9em; color: #6fd3ff; margin: 8px 0 0 .9em; }
  @keyframes agDrop { from { opacity: 0; transform: translateY(-24px) scale(.96); } }
  .ag-card { width: 100%; background: linear-gradient(160deg, rgba(14,22,40,.88), rgba(8,12,24,.86)); border: 1px solid rgba(111,211,255,.2); border-radius: 22px; padding: 22px; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); box-shadow: 0 30px 90px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.03) inset; position: relative; overflow: hidden; animation: agUp .7s .1s cubic-bezier(.2,.9,.3,1) both; }
  .ag-card::before { content: ''; position: absolute; top: 0; left: -40%; width: 40%; height: 2px; background: linear-gradient(90deg, transparent, #6fd3ff, transparent); animation: agLine 3.5s ease-in-out infinite; }
  @keyframes agLine { to { left: 100%; } }
  @keyframes agUp { from { opacity: 0; transform: translateY(26px); } }
  .ag-card.shake { animation: agShake .4s; } @keyframes agShake { 20%, 60% { transform: translateX(-8px); } 40%, 80% { transform: translateX(8px); } }
  #agBody > * { animation: agFade .35s both; } @keyframes agFade { from { opacity: 0; transform: translateY(8px); } }
  .ag-steam { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 57px; color: #fff; font: 800 15px system-ui; padding: 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,.14); background: linear-gradient(180deg, #1b2838, #10171f); cursor: pointer; transition: transform .15s, box-shadow .25s, border-color .25s; position: relative; }
  .ag-steam img { display: block; height: 35px; width: auto; } .ag-steam span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .ag-steam:hover { transform: translateY(-2px); border-color: #66c0f4; box-shadow: 0 10px 30px rgba(102,192,244,.25); }
  .ag-steam.go { filter: brightness(1.2); }
  .ag-or { display: flex; align-items: center; gap: 12px; margin: 16px 0 14px; font: 800 11px system-ui; letter-spacing: .2em; color: rgba(255,255,255,.45); text-transform: uppercase; }
  .ag-or::before, .ag-or::after { content: ''; flex: 1; height: 1px; background: rgba(255,255,255,.12); }
  .ag-tabs { position: relative; display: grid; grid-template-columns: 1fr 1fr; background: rgba(255,255,255,.05); border-radius: 12px; padding: 4px; margin-bottom: 14px; }
  .ag-tabs button { position: relative; z-index: 1; border: 0; background: none; color: rgba(255,255,255,.6); font: 800 14px system-ui; padding: 9px; cursor: pointer; transition: color .2s; }
  .ag-tabs button.on { color: #fff; }
  .ag-ind { position: absolute; top: 4px; bottom: 4px; left: 4px; width: calc(50% - 4px); border-radius: 9px; background: linear-gradient(180deg, rgba(45,125,255,.7), rgba(26,86,214,.6)); box-shadow: 0 4px 16px rgba(31,111,255,.35); transition: transform .3s cubic-bezier(.2,.9,.3,1); }
  .ag-form { display: flex; flex-direction: column; gap: 10px; }
  .ag-f { display: flex; flex-direction: column; gap: 5px; position: relative; text-align: left; }
  .ag-f span { font: 800 11px system-ui; letter-spacing: .12em; text-transform: uppercase; color: rgba(255,255,255,.55); }
  #authGate input { text-transform: none; letter-spacing: normal; text-align: left; font-weight: 600; font-size: 15px; padding: 12px 14px; border-radius: 11px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); transition: border-color .2s, box-shadow .2s, background .2s; width: 100%; }
  #authGate input:focus { border-color: #6fd3ff; box-shadow: 0 0 0 3px rgba(111,211,255,.15); background: rgba(255,255,255,.09); }
  .ag-eye { position: absolute; right: 8px; bottom: 7px; width: 32px; height: 30px; border: 0; border-radius: 8px; background: none; cursor: pointer; opacity: .5; font-size: 15px; } .ag-eye.on, .ag-eye:hover { opacity: 1; }
  .ag-err { min-height: 0; color: #ff8fa6; font-size: 13px; font-weight: 600; text-align: left; } .ag-err:empty { display: none; }
  .ag-note { margin-bottom: 14px; padding: 10px 12px; border-radius: 11px; font-size: 13.5px; font-weight: 700; line-height: 1.4; background: rgba(47,209,107,.14); border: 1px solid rgba(47,209,107,.4); color: #9ff0bf; }
  .ag-note.bad { background: rgba(255,90,120,.12); border-color: rgba(255,90,120,.4); color: #ffb3c4; }
  .ag-terms { font-size: 11px; opacity: .5; line-height: 1.45; text-align: left; }
  #authGate .btn { margin: 0; border-radius: 11px; } #authGate .btn:not(.ghost) { background: linear-gradient(180deg, #2d7dff, #1a56d6); box-shadow: 0 8px 24px rgba(31,111,255,.35); }
  #authGate .btn.ghost { background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); }
  .ag-go.busy { color: transparent; position: relative; } .ag-go.busy::after { content: ''; position: absolute; left: 50%; top: 50%; width: 18px; height: 18px; margin: -9px; border-radius: 50%; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; animation: agSpin .7s linear infinite; }
  @keyframes agSpin { to { transform: rotate(360deg); } }
  .ag-link { background: none; border: 0; color: #6fd3ff; font: 700 13px system-ui; cursor: pointer; padding: 4px; align-self: center; } .ag-link:hover { text-decoration: underline; }
  .ag-h { font: italic 900 22px system-ui; margin-bottom: 6px; } .ag-p { font-size: 14px; opacity: .75; line-height: 1.5; margin-bottom: 12px; }
  .ag-col { display: flex; flex-direction: column; gap: 10px; margin-bottom: 8px; }
  .ag-wait { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 26px 0; font-weight: 700; opacity: .85; }
  .ag-mail { font-size: 44px; text-align: center; animation: agBob 2s ease-in-out infinite; } @keyframes agBob { 50% { transform: translateY(-6px); } }
  #agBody[data-v=sent], #agBody[data-v=error] { text-align: center; }
  .ag-legal { font-size: 11px; line-height: 1.5; color: rgba(255,255,255,.4); text-align: center; animation: agFade .6s .4s both; }
  @media (max-width: 480px) { .ag-logo { font-size: 36px; } .ag-card { padding: 18px; } }`;
  document.head.appendChild(st);
  const lobbyBg = document.querySelector('#lobby .rl-bg');
  const g = h('div', { id: 'authGate', class: 'hidden', role: 'dialog', 'aria-label': 'Entrar no Ping Pong Online' },
    lobbyBg ? lobbyBg.cloneNode(true) : h('div', { class: 'rl-bg' }), h('div', { class: 'rl-sweep' }), h('div', { class: 'rl-shade' }),
    h('div', { class: 'ag-wrap' },
      h('div', { class: 'ag-logo' }, 'PING PONG', h('span', { text: 'ONLINE' })),
      h('div', { class: 'ag-card' }, h('div', { id: 'agBody' })),
      h('div', { class: 'ag-legal', text: 'O login da Steam abre a página oficial da Steam: nunca pedimos sua senha da Steam. Steam e o logotipo Steam são marcas da Valve Corporation. Ping Pong Online não é afiliado à Valve.' })));
  document.body.append(g);
  // o fundo do menu carrega depois: copia a imagem quando chegar
  const sync = () => { const a = document.querySelector('#lobby .rl-bg'), b = g.querySelector('.rl-bg'); if (a && b && a.style.backgroundImage) b.style.backgroundImage = a.style.backgroundImage; else setTimeout(sync, 300); };
  sync();
  window.__gateSync = gateSync;
  gateSync();
}

/* =====================================================================
   EFEITOS DE INTERFACE: hover e clique em todos os botões
   Brilho que passa, leve subida no hover, "onda" de luz no clique e sons baixinhos.
   ===================================================================== */
const FX_SEL = 'button, a.btn, .bs, .rl-prof, .pk-card';
function initUiFx() {
  const st = document.createElement('style');
  st.textContent = `
  .fxw { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; pointer-events: none; z-index: 0; }
  .rl-nav .fxw { transform: skewX(-14deg); border-radius: 0; }
  .fxr { position: absolute; border-radius: 50%; transform: translate(-50%, -50%) scale(0); background: radial-gradient(circle, rgba(255,255,255,.55) 0%, rgba(160,220,255,.25) 40%, transparent 70%); animation: fxRip .6s cubic-bezier(.2,.8,.3,1) forwards; }
  @keyframes fxRip { to { transform: translate(-50%, -50%) scale(1); opacity: 0; } }
  button.btn, a.btn, .rl-ib, .seg button, .pk-arrow, .ag-steam, .rl-prof { position: relative; isolation: isolate; }
  button.btn, a.btn, .ag-steam { overflow: hidden; }
  button.btn::after, a.btn::after, .ag-steam::after { content: ''; position: absolute; top: 0; bottom: 0; left: -60%; width: 45%; background: linear-gradient(105deg, transparent, rgba(255,255,255,.28), transparent); transform: skewX(-18deg); pointer-events: none; transition: none; }
  button.btn:hover:not(:disabled)::after, a.btn:hover::after, .ag-steam:hover::after { left: 130%; transition: left .6s ease; }
  button.btn, a.btn, .seg button, .pk-arrow, .bs, .rl-ib, .cf-save, .ag-tabs button { transition: transform .16s cubic-bezier(.2,.9,.3,1.4), box-shadow .25s, filter .2s, background .2s, border-color .2s; }
  button.btn:hover:not(:disabled), a.btn:hover { transform: translateY(-2px); filter: brightness(1.12); }
  button.btn:active:not(:disabled), a.btn:active, .seg button:active, .pk-arrow:active, .rl-ib:active, .cf-save:active, .ag-steam:active { transform: scale(.96); transition-duration: .06s; }
  .seg button:hover { transform: translateY(-2px); border-color: rgba(111,211,255,.5); }
  .pk-arrow:hover { transform: scale(1.12); box-shadow: 0 0 18px rgba(111,211,255,.45); background: rgba(31,111,255,.45); }
  .bs { transition: transform .18s cubic-bezier(.2,.9,.3,1.4), box-shadow .2s; } .bs:hover { transform: translateY(-3px) scale(1.12); box-shadow: 0 6px 18px rgba(111,211,255,.35); }
  .rl-ib:hover { box-shadow: 0 0 22px rgba(111,211,255,.3); }
  .rl-nav button::after { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 30%; transform: skewX(-14deg) translateX(-120%); background: linear-gradient(90deg, transparent, rgba(255,255,255,.22), transparent); opacity: 0; pointer-events: none; }
  .rl-nav button:hover::after { animation: fxNavSweep .7s ease forwards; }
  @keyframes fxNavSweep { 0% { opacity: 1; transform: skewX(-14deg) translateX(-120%); } 100% { opacity: 0; transform: skewX(-14deg) translateX(380%); } }
  .rl-nav button.fx-hit::before { animation: fxNavHit .4s ease; } @keyframes fxNavHit { 0% { filter: brightness(1.9); } 100% { filter: none; } }
  .rl-nav button.fx-hit span { animation: fxNavTxt .35s cubic-bezier(.2,1.4,.4,1); } @keyframes fxNavTxt { 40% { letter-spacing: .1em; } }
  .rl-panel { transition: transform .25s, border-color .25s, box-shadow .25s; }
  .rl-page.in .rl-panel { animation: rlIn .5s cubic-bezier(.2,.9,.3,1) both; }
  .rl-page.in .rl-panel:nth-child(2) { animation-delay: .06s; } .rl-page.in .rl-panel:nth-child(3) { animation-delay: .12s; }
  .rl-modes .rl-panel:nth-child(2) { animation-delay: .06s; } .rl-modes .rl-panel:nth-child(3) { animation-delay: .12s; }
  @media (prefers-reduced-motion: reduce) { .fxr, .rl-nav button::after, button.btn::after { display: none; } }`;
  document.head.appendChild(st);
  let lastHover = null;
  document.addEventListener('pointerover', e => {
    const b = e.target.closest(FX_SEL); if (!b || b === lastHover || b.disabled) return;
    lastHover = b; if (e.pointerType === 'mouse') uiTick('hover');
  });
  document.addEventListener('pointerout', e => { if (lastHover && !lastHover.contains(e.relatedTarget)) lastHover = null; });
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest(FX_SEL); if (!b || b.disabled) return;
    ensureAudio(); uiTick('click');
    if (b.matches('.bs, .pk-card')) return;
    let w = b.querySelector(':scope > .fxw'); if (!w) { w = document.createElement('div'); w.className = 'fxw'; b.prepend(w); }
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2.4;
    const s = document.createElement('div'); s.className = 'fxr';
    s.style.width = s.style.height = d + 'px'; s.style.left = (e.clientX - r.left) + 'px'; s.style.top = (e.clientY - r.top) + 'px';
    w.append(s); setTimeout(() => s.remove(), 650);
    if (b.closest('.rl-nav')) { b.classList.remove('fx-hit'); void b.offsetWidth; b.classList.add('fx-hit'); }
  }, true);
}

/* =====================================================================
   PARTIDA EM ETAPAS (estilo FIFA): tipo → cenário → modo → raquete/skin → tela "VS"
   Convite só para amigos do jogo (sem link de sala).
   ===================================================================== */
const MATCH = { type: null, friend: null, room: null, from: null, arena: null, fmt: null };
const VS = { pending: false, on: false, timer: 0, thumbs: {}, dur: 5 };
let oppAvatar = '';
const validAv = v => typeof v === 'string' && (/^av:[a-z0-9-]{1,24}$/.test(v) || /^https:\/\/(avatars\.steamstatic\.com|steamcdn-a\.akamaihd\.net|avatars\.akamai\.steamstatic\.com)\//.test(v)) ? v : '';
const ARENA_INFO = { neon: ['Noite', 'Lotada', 'Ginásio'], ginasio: ['Dia', 'Escola', 'Eco'], praia: ['Pôr do sol', 'Areia', 'Brisa'], terraco: ['Noite', 'Amigos', 'Cidade'], final: ['Noite', 'Estádio', 'Pirotecnia'] };
const ARENA_ART = {
  neon: `<rect width="300" height="240" fill="#12051c"/><g opacity=".9">${[...Array(9)].map((_, i) => `<rect x="${i * 36 - 4}" y="${40 + (i * 37) % 50}" width="26" height="${120 - (i * 37) % 50}" fill="#1d0a2e"/>`).join('')}</g><g stroke="#ff3d8b" stroke-width="1.2" opacity=".7">${[...Array(8)].map((_, i) => `<path d="M150 150 L${-60 + i * 60} 240"/>`).join('')}${[0, 1, 2, 3].map(i => `<path d="M0 ${160 + i * i * 9} H300"/>`).join('')}</g><rect x="0" y="146" width="300" height="3" fill="#3dc8ff"/><circle cx="60" cy="40" r="30" fill="#ff3d8b" opacity=".25"/><circle cx="250" cy="55" r="36" fill="#3dc8ff" opacity=".2"/>`,
  ginasio: `<rect width="300" height="240" fill="#2a4a7a"/><rect y="150" width="300" height="90" fill="#c98a4a"/><g stroke="#fff" stroke-width="2" opacity=".55" fill="none"><path d="M20 238 L90 158 H210 L280 238"/><path d="M150 158 V238"/></g>${[0, 1, 2].map(i => `<rect x="${30 + i * 90}" y="30" width="60" height="70" fill="#bfe3ff" opacity=".8"/><path d="M${30 + i * 90} 100 L${i * 90 - 40} 240 L${i * 90 + 60} 240 L${90 + i * 90} 100Z" fill="#fff6d0" opacity=".14"/>`).join('')}`,
  praia: `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a1f6b"/><stop offset=".55" stop-color="#ff6b5a"/><stop offset="1" stop-color="#ffc06b"/></linearGradient></defs><rect width="300" height="150" fill="url(#sky)"/><circle cx="150" cy="138" r="34" fill="#ffd86b"/><rect y="138" width="300" height="40" fill="#1f5a8a"/>${[0, 1, 2, 3].map(i => `<rect x="${118 + i * 4}" y="${144 + i * 7}" width="${64 - i * 8}" height="2.5" fill="#ffd86b" opacity=".7"/>`).join('')}<rect y="176" width="300" height="64" fill="#e8c28a"/><path d="M262 178 C258 140 262 110 270 90" stroke="#2a1a10" stroke-width="5" fill="none"/><path d="M270 90 C250 80 236 88 228 98 M270 90 C286 78 298 84 304 94 M270 90 C262 72 268 62 278 58" stroke="#1f3a1a" stroke-width="8" fill="none" stroke-linecap="round"/>`,
  terraco: `<rect width="300" height="240" fill="#0b1430"/>${[...Array(40)].map((_, i) => `<circle cx="${(i * 73) % 300}" cy="${(i * 37) % 90}" r="${i % 3 ? .8 : 1.4}" fill="#fff" opacity=".6"/>`).join('')}${[[0, 70, 50], [52, 40, 40], [94, 90, 36], [134, 55, 48], [184, 100, 34], [220, 60, 44], [266, 82, 40]].map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="${200 - y}" fill="#141f45"/>${[...Array(12)].map((_, k) => `<rect x="${x + 5 + (k % 3) * (w / 3.4)}" y="${y + 8 + Math.floor(k / 3) * 16}" width="5" height="7" fill="${k % 4 ? '#ffd34d' : '#1d2a55'}" opacity=".85"/>`).join('')}`).join('')}<path d="M0 120 Q75 140 150 122 T300 120" stroke="#ffd34d" stroke-width="1" fill="none"/>${[...Array(12)].map((_, i) => `<circle cx="${i * 26 + 8}" cy="${128 + Math.sin(i) * 6}" r="2.6" fill="#ffe7a0"/>`).join('')}<rect y="196" width="300" height="44" fill="#232a3a"/>`,
  final: `<rect width="300" height="240" fill="#080b16"/>${[...Array(5)].map((_, i) => `<path d="M${30 + i * 60} 0 L${i * 60 - 10} 240 L${i * 60 + 70} 240Z" fill="#fff" opacity=".06"/>`).join('')}<path d="M0 150 Q150 90 300 150 V240 H0Z" fill="#141a2e"/>${[...Array(120)].map((_, i) => `<circle cx="${(i * 41) % 300}" cy="${118 + (i * 13) % 40 + Math.abs(150 - (i * 41) % 300) * .12}" r="1.6" fill="${['#ff3d5a', '#3d8bff', '#ffd34d', '#fff'][i % 4]}" opacity=".7"/>`).join('')}${[...Array(30)].map((_, i) => `<rect x="${(i * 53) % 300}" y="${(i * 29) % 110}" width="4" height="7" fill="${['#ffd34d', '#ff3d8b', '#3dc8ff'][i % 3]}" transform="rotate(${i * 37} ${(i * 53) % 300} ${(i * 29) % 110})"/>`).join('')}`,
};
const TABLE_SVG = `<g transform="translate(150 196)"><path d="M-70 -14 L70 -14 L84 10 L-84 10Z" fill="#1f4fd0" stroke="#fff" stroke-width="1.5"/><path d="M0 -14 V10" stroke="#fff" stroke-width="1"/><path d="M-74 -22 L74 -22" stroke="rgba(255,255,255,.75)" stroke-width="2"/><rect x="-70" y="10" width="4" height="22" fill="#111"/><rect x="66" y="10" width="4" height="22" fill="#111"/></g>`;
const ARENA_SHA = '7d5e2fe91cdeade930a2230a8024ca5263880bbf';
function arenaShot(id) {                                   // print de verdade da arena (renderizada no próprio jogo)
  const d = h('div', { class: 'fu-ashot' });
  const im = h('img', { src: `https://cdn.jsdelivr.net/gh/amxgroup07/pingpong-online@${ARENA_SHA}/assets/arenas/${id}.jpg`, alt: '', loading: 'lazy' });
  im.onerror = () => { if (!im.dataset.f) { im.dataset.f = 1; im.src = `https://raw.githubusercontent.com/amxgroup07/pingpong-online/${ARENA_SHA}/assets/arenas/${id}.jpg`; } else im.replaceWith(h('div', { class: 'fu-ashot-svg', html: '' })); };
  d.append(im); return d;
}
function arenaArt(id) { return uniq(`<svg class="fu-svg" viewBox="0 0 300 240" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${(ARENA_ART[id] || '').replace(/id="sky"/, 'id="gl"').replace(/url\(#sky\)/, 'url(#gl)')}${TABLE_SVG}</svg>`); }
function modeArt(n) {
  return uniq(`<svg class="fu-svg" viewBox="0 0 300 240" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><radialGradient id="gl"><stop offset="0" stop-color="#ff6b1a" stop-opacity=".45"/><stop offset="1" stop-color="#ff6b1a" stop-opacity="0"/></radialGradient></defs><circle cx="150" cy="105" r="95" fill="url(#gl)"/><text x="150" y="128" text-anchor="middle" font-size="130" font-style="italic" font-weight="900" fill="#fff" font-family="Barlow Condensed,system-ui">${n}</text><text x="150" y="154" text-anchor="middle" font-size="22" font-weight="800" fill="rgba(255,255,255,.7)" letter-spacing="4" font-family="Barlow Condensed,system-ui">${n === 1 ? 'GAME' : 'GAMES'}</text>${[...Array(n)].map((_, i) => `<circle cx="${150 - (n - 1) * 11 + i * 22}" cy="174" r="7" fill="${i < Math.ceil(n / 2) ? '#ff6b1a' : 'rgba(255,255,255,.25)'}"/>`).join('')}</svg>`);
}
const TYPE_NAME = { solo: 'Treino', friend: 'Amistoso', ranked: 'Ranqueada', join: 'Amistoso' };
function stepChips(n, of) { return [['star', `PASSO ${n} DE ${of}`], ['paint', TYPE_NAME[MATCH.type] || '']]; }
function matchPages(id) {
  const p = acct.profile;
  switch (id) {
    case 'friend': {
      if (!FR.data && !FR.loading && acct.user) { FR.loading = true; loadFriends().finally(() => { FR.loading = false; if (UI.page === 'friend') renderFut(); }); }
      const d = FR.data || { friends: [], incoming: [] }, inc = (d.incoming || []).length;
      const code = (d.code || (p && p.friend_code) || '—');
      const tiles = [{ title: 'Adicionar amigo', art: 'addfriend', foot: [['Seu código', code], ['Amigos', d.friends.length], ['Pedidos', inc]], small: true, go: () => { const i = $('fuAddCode'); if (i) i.focus(); } }];
      if (inc) tiles.push({ title: 'Pedidos', art: artSVG('amigos', '#ff6b1a'), foot: [['Novos', inc], ['De', d.incoming[0].name], ['Ação', 'Ver']], small: true, badge: `${inc} NOVO${inc > 1 ? 'S' : ''}`, go: () => openFriends() });
      for (const f of d.friends) {
        const st = f.presence === 'jogando' ? 'Jogando' : f.online ? 'Online' : 'Offline';
        tiles.push({ title: f.name, art: friendArt(f), small: true, dim: !f.online, founder: !!f.founder, badge: f.online ? (f.presence === 'jogando' ? 'JOGANDO' : 'ONLINE') : '', badgeCls: f.presence === 'jogando' ? 'play' : 'on',
          foot: [['Status', st], ['Elo', f.rating || 1000], ['Sigla', f.tag || '—']],
          go: () => {
            if (f.presence === 'jogando' && f.room) { if (confirm(`${f.name} está jogando agora. Quer assistir?`)) watchFriend(f); return; }
            if (!f.online) { toast(`${f.name} está offline agora. Convide quando ele estiver online.`); return; }
            Object.assign(MATCH, { rkPicked: false, type: 'friend', friend: f }); futGo('arena');
          } });
      }
      if (FR.err && !d.friends.length) tiles.push({ title: 'Tentar de novo', art: artSVG('ajustes', '#e8273f'), foot: [['Erro', 'servidor'], ['', ''], ['', '']], small: true, go: () => { FR.data = null; FR.err = ''; renderFut(); } });
      return { title: 'Jogar com amigo', crumb: 'Jogar', sub: d.friends.length ? 'Escolha um amigo online para convidar. Depois você escolhe o cenário, o modo e a raquete.' : 'Você ainda não tem amigos no jogo. Mande o seu código para um amigo ou digite o código dele no primeiro cartão.', chips: [['star', `${d.friends.filter(f => f.online).length} ONLINE`], ['paint', `CÓDIGO ${code}`]], tiles };
    }
    case 'arena': {
      const steps = MATCH.type === 'solo' ? 3 : 3;
      return { title: 'Cenário', crumb: MATCH.type === 'friend' ? 'Amigos' : 'Jogar', sub: MATCH.type === 'friend' ? `Onde vai ser a partida contra ${MATCH.friend.name}?` : 'Escolha onde vai ser a partida.', chips: stepChips(1, steps),
        tiles: ARENAS.map((a, i) => ({ title: a.name, art: arenaShot(a.id), noSwoosh: true, foot: [['Hora', ARENA_INFO[a.id][0]], ['Público', ARENA_INFO[a.id][1]], ['Som', ARENA_INFO[a.id][2]]], sel: pickState.ar === i,
          go: () => { pickState.ar = i; store.set('pp_arena', a.id); if (A.id !== a.id) buildArena(a.id); renderPick(); futGo('mode'); } })) };
    }
    case 'mode': return { title: 'Modo de jogo', crumb: 'Cenário', sub: `${ARENAS[pickState.ar].emoji} ${ARENAS[pickState.ar].name}. Quantos games vai ter a partida?`, chips: stepChips(2, 3), pre: MATCH.type === 'solo' ? 'cpu' : null,
      tiles: [[1, 'Duelo', '1 game', '~5 min'], [3, 'MD3', 'melhor de 3', '~12 min'], [5, 'MD5', 'melhor de 5', '~20 min']].map(([f, n, g, t]) => ({ title: n, art: modeArt(f), foot: [['Games', g], ['Pontos', 11], ['Duração', t]], sel: pickState.fmt === f,
        go: () => { pickState.fmt = f; store.set('pp_fmt', String(f)); renderPick(); futGo('gear'); } })) };
    case 'gear': {
      const r = myRacket, cur = mySkinFor(r), join = MATCH.type === 'join';
      const pick = id => { setRacketSkin(r, id); skinReady(id).then(() => { setPaddle('me', r); makeThumbs([[r, id]]); renderFut(); }); renderFut(); };
      const info = join ? `${MATCH.from} te convidou${MATCH.arena ? ` · ${arenaById(MATCH.arena).emoji} ${arenaById(MATCH.arena).name}` : ''}${MATCH.fmt ? ` · ${FORMATS[MATCH.fmt].short}` : ''}` : MATCH.type === 'ranked' ? 'Ranqueada: 1 game de 11, vale elo.' : `${ARENAS[pickState.ar].emoji} ${ARENAS[pickState.ar].name} · ${FORMATS[pickState.fmt].short}${MATCH.type === 'solo' ? ` · CPU ${BOT_LV[pickState.diff].name}` : MATCH.friend ? ` · contra ${MATCH.friend.name}` : ''}`;
      return { title: 'Raquete e skin', crumb: join ? 'Início' : MATCH.type === 'ranked' ? 'Jogar' : 'Modo de jogo', sub: info + '. Escolha a raquete e a skin e confirme.', chips: join || MATCH.type === 'ranked' ? [['star', 'ÚLTIMO PASSO'], ['paint', TYPE_NAME[MATCH.type]]] : stepChips(3, 3), pre: 'rackets', shade: true, cta: join ? 'Entrar na partida' : MATCH.type === 'friend' ? 'Convidar e jogar' : MATCH.type === 'ranked' ? 'Procurar partida' : 'Confirmar e jogar',
        tiles: [{ title: 'Original', art: futRacketArt(r, true), foot: [['Raridade', 'Padrão'], ['Nº', '00'], ['Status', cur ? 'Usar' : 'Em uso']], small: true, sel: !cur, badge: !cur ? 'EM USO' : '', go: () => pick('') },
          ...RSKINS.map(s => ({ title: s.name, art: futSkinArt(s), foot: [['Raridade', s.rar], ['Nº', s.n], ['Status', cur === s.id ? 'Em uso' : 'Usar']], small: true, sel: cur === s.id, rar: s.rar, badge: cur === s.id ? 'EM USO' : '', go: () => pick(s.id) }))] };
    }
  }
  return null;
}
function friendArt(f) {
  const d = h('div', { class: 'fu-fav' + (f.online ? ' on' : '') }); d.append(avatarNode(f.avatar, f.name, 'fu-bigav'));
  if (f.online) d.append(h('i', { class: 'fu-dot' + (f.presence === 'jogando' ? ' play' : '') }));
  return d;
}
function addFriendArt() {
  const inp = h('input', { id: 'fuAddCode', placeholder: 'CÓDIGO', maxlength: 8, autocomplete: 'off', spellcheck: 'false' });
  const go = h('button', { class: 'fu-codego', text: 'ADICIONAR ›' });
  const send = async () => { const c = inp.value.trim(); if (c.length < 6) { toast('O código de amigo tem 6 letras'); inp.focus(); return; } const r = await frAction('friend_request', { p_code: c }, x => x && x.status === 'accepted' ? `Agora vocês são amigos! 🎉` : `Pedido enviado para ${x && x.name || 'seu amigo'}`); if (r) { inp.value = ''; renderFut(); } };
  go.onclick = e => { e.stopPropagation(); send(); };
  inp.onclick = e => e.stopPropagation(); inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') send(); };
  return h('div', { class: 'fu-code' }, h('small', { text: 'CÓDIGO DO AMIGO' }), inp, go);
}
function futRacketStrip() {
  const row = h('div', { class: 'fu-rstrip' });
  for (const r of RACKETS.filter(isListed)) {
    const lk = !isUnlocked(r), b = h('button', { class: 'fu-rs' + (myRacket.id === r.id ? ' cur' : '') + (lk ? ' locked' : ''), title: lk ? lockText(r) : r.name });
    if (thumbs[r.id]) b.append(h('img', { src: thumbs[r.id], alt: '' }));
    b.append(h('b', { text: r.name }), lk ? h('small', { text: '🔒 ' + lockText(r) }) : h('div', { class: 'rsb' }, 'VEL', statBars(r.speed), 'EFE', statBars(r.spin), 'CTR', statBars(r.ctrl)));
    b.onclick = () => { if (lk) { toast(lockText(r)); return; } MATCH.rkPicked = true; pickState.rk = RACKETS.indexOf(r); store.set('pp_racket', r.id); setPaddle('me', r); renderPick(); renderFut(); };
    row.append(b);
  }
  const r = myRacket, srow = (l, n) => h('div', { class: 'row' }, h('span', { text: l }), statBars(n), h('b', { text: n }));
  const stats = h('div', { class: 'fu-stats' }, h('div', {}, srow('Velocidade', r.speed), srow('Efeito', r.spin), srow('Controle', r.ctrl)), h('p', {}, h('b', { text: r.name + ' · ' + r.tag }), r.desc));
  return h('div', { class: 'fu-sec' }, h('div', { class: 'fu-st' }, MATCH.rkPicked ? 'Raquete' : '1. Escolha a raquete', h('small', { text: MATCH.rkPicked ? myRacket.name : 'clique numa delas' })), row, stats,
    h('div', { class: 'fu-st', style: 'margin: 14px 0 0' }, '2. Skin', h('small', { text: MATCH.rkPicked ? (skinById(mySkinFor(myRacket)) || { name: 'Original' }).name : 'libera depois da raquete' })));
}
function futCpuSeg() {
  return h('div', { class: 'fu-opts' }, h('div', { class: 'fu-opt' }, h('span', { class: 'fu-ol', text: 'Nível da CPU' }),
    h('div', { class: 'fu-seg' }, ...Object.entries(BOT_LV).map(([k, v]) => { const b = h('button', { class: pickState.diff === k ? 'on' : '' }, v.name, h('small', { text: `XP ×${v.xp}` })); b.onclick = () => { pickState.diff = k; store.set('pp_diff', k); renderPick(); renderFut(); }; return b; }))));
}
// ---------- confirmar: começa a partida, manda o convite ou entra na fila ----------
function launchMatch() {
  ensureAudio();
  const t = MATCH.type;
  if (t === 'solo') { VS.pending = true; $('btnSolo').click(); return; }
  if (t === 'ranked') { $('btnRanked').click(); return; }
  if (t === 'join') { if (!MATCH.room) return; joinRoom(MATCH.room); return; }
  if (t === 'friend') startInvite(MATCH.friend);
}
const INV = { f: null, timer: 0, poll: 0 };
function startInvite(f) {
  if (!f) return;
  INV.f = f; createRoom(); $('wait').classList.add('inv');
  $('invWait').textContent = '';
  $('invWait').append(h('div', { class: 'iw-av' }, avatarNode(f.avatar, f.name, 'fu-bigav')), h('b', { text: f.name }),
    h('p', { id: 'iwTxt', text: 'Abrindo a sala…' }), h('small', { text: `${ARENAS[pickState.ar].emoji} ${ARENAS[pickState.ar].name} · ${FORMATS[pickState.fmt].short}` }));
  let tries = 0;
  clearInterval(INV.poll); INV.poll = setInterval(async () => {
    if (!INV.f) { clearInterval(INV.poll); return; }
    if (!(peer && (peer.open || peer.__ok) && curRoom)) { if (++tries > 40) { clearInterval(INV.poll); cancelInvite('Não consegui abrir a sala. Tente de novo.'); } return; }
    clearInterval(INV.poll);
    try { await rpc('invite_friend', { p_to: f.id, p_room: curRoom, p_arena: ARENAS[pickState.ar].id, p_fmt: pickState.fmt }); $('iwTxt').textContent = `Convite enviado! Esperando ${f.name} aceitar…`; }
    catch (e) { cancelInvite(/espere/.test(e.message) ? 'Espere alguns segundos para convidar de novo.' : 'Não consegui mandar o convite: ' + e.message); return; }
    clearTimeout(INV.timer); INV.timer = setTimeout(() => { if (INV.f && !conn) cancelInvite(`${f.name} não respondeu ao convite.`); }, 90000);
  }, 250);
}
function cancelInvite(msg) {
  const f = INV.f; INV.f = null; clearInterval(INV.poll); clearTimeout(INV.timer);
  $('wait').classList.remove('inv');
  if (f && !conn) { rpc('invite_cancel', { p_to: f.id }).catch(() => { }); cleanupNet(); showPanel('menu'); }
  if (msg) toast(msg);
}
// convite recebido: aceitar leva direto para a escolha de raquete/skin
function acceptInvite(inv) {
  if (S.mode && !confirm('Sair da partida atual para jogar com seu amigo?')) return;
  if (S.mode) goMenu();
  Object.assign(MATCH, { rkPicked: false, type: 'join', room: inv.room, from: inv.name || 'Seu amigo', arena: ARENAS.some(a => a.id === inv.arena) ? inv.arena : null, fmt: [1, 3, 5].includes(inv.fmt) ? inv.fmt : null });
  if ($('frScreen')) closeFriends();
  showPanel('menu'); UI.stack = ['home']; showPage('gear');
}
// ---------- tela VS (5 s antes da partida) ----------
function vsSide(cls, name, sub, av, r, sk, thumb, fdr) {
  const s = skinById(sk);
  return h('div', { class: 'vs-side ' + cls },
    h('div', { class: 'vs-av' }, avatarNode(av, name, 'fu-bigav')),
    h('div', { class: 'vs-nm', text: name }), fdr ? founderBadge('sm') : null, h('div', { class: 'vs-sub', text: sub }),
    h('div', { class: 'vs-rk' }, thumb ? h('img', { src: thumb, alt: '' }) : h('i'), h('div', {}, h('b', { text: r.name }), h('small', { text: s ? `🎨 ${s.name}` : 'Visual original' }))));
}
function renderVs() {
  const el = $('vsScreen'); if (!el || !VS.on) return;
  const p = acct.profile, solo = S.mode === 'solo';
  const oppName = solo ? `CPU ${botLv().name}` : (S.oppName || oppTag || 'Adversário');
  const oppAv = solo ? 'av:robo' : oppAvatar;
  const ok = `${oppRacket.id}_${oppSkin}`;
  if (!VS.thumbs[ok]) { VS.thumbs[ok] = 'loading'; skinReady(oppSkin).then(() => { const o = {}; makeThumbs([[oppRacket, oppSkin]], o); VS.thumbs[ok] = o[oppRacket.id]; renderVs(); }); }
  const t2 = VS.thumbs[ok] && VS.thumbs[ok] !== 'loading' ? VS.thumbs[ok] : null;
  el.querySelector('.vs-row').replaceChildren(
    vsSide('l', p ? p.name : 'Você', `${myTag() || ''} · Nível ${levelOf(prog.xp).lvl}`, myAvatar(), myRacket, mySkinFor(myRacket), thumbs[myRacket.id], isFounder()),
    h('div', { class: 'vs-mid' }, h('b', { text: 'VS' })),
    vsSide('r', oppName, solo ? `Estilo ${BOT_STYLES[botStyle] ? BOT_STYLES[botStyle].name : ''}` : (oppTag || ''), oppAv, oppRacket, oppSkin, t2, !solo && oppFounder));
  el.querySelector('.vs-top').textContent = `${A.def.emoji}  ${A.def.name.toUpperCase()}  ·  ${FORMATS[S.format].short}  ·  ${S.ranked ? 'RANQUEADA' : solo ? 'TREINO' : 'AMISTOSO'}`;
}
function showVs() {
  let el = $('vsScreen');
  if (!el) { el = h('div', { id: 'vsScreen' }, h('div', { class: 'vs-top' }), h('div', { class: 'vs-row' }), h('div', { class: 'vs-bot' }, h('div', { class: 'vs-bar' }, h('i')), h('span', { id: 'vsCount' }))); document.body.append(el); }
  VS.on = true; VS.pending = false;
  el.classList.remove('out'); el.classList.add('on'); void el.offsetWidth;
  document.body.classList.add('vsing');
  renderVs();
  // câmera: passeia pela arena até a posição de jogo enquanto a tela aparece
  const D = VS.dur + 0.4; S.phaseT = Math.min(S.phaseT, -D);
  cam.from.set(S.mySide * 3.2, TH + 1.7, -0.4); cam.fromLook.set(0, TH, 0); cam.introDur = D; cam.introT = D;
  const t0 = performance.now(), bar = el.querySelector('.vs-bar i');
  clearInterval(VS.timer);
  VS.timer = setInterval(() => {
    const left = Math.max(0, VS.dur - (performance.now() - t0) / 1000);
    bar.style.width = `${(1 - left / VS.dur) * 100}%`;
    $('vsCount').textContent = left > 0.05 ? `A partida começa em ${Math.ceil(left)}` : 'Valendo!';
    if (left <= 0) hideVs();
  }, 100);
  tone(660, 0.12, 0.05, 'triangle'); tone(990, 0.2, 0.04, 'triangle', 0.15);
}
function hideVs() {
  clearInterval(VS.timer); if (!VS.on) return; VS.on = false;
  const el = $('vsScreen'); if (el) { el.classList.add('out'); setTimeout(() => { if (!VS.on) el.classList.remove('on', 'out'); }, 500); }
  document.body.classList.remove('vsing');
  setTimeout(() => { cam.introDur = 1.8; }, 600);
}
function initMatchUI() {
  const st = document.createElement('style');
  st.textContent = `
  .fu-ashot { position: absolute; inset: 0; background: #10141d; } .fu-ashot img { width: 100%; height: 100%; object-fit: cover; transition: transform .5s cubic-bezier(.2,.9,.3,1), filter .3s; filter: saturate(1.05); }
  .fu-ashot::after { content: ''; position: absolute; inset: 0; background: linear-gradient(0deg, rgba(5,7,12,.85), transparent 45%); }
  .fu-tile.sel .fu-ashot img { transform: scale(1.07); filter: saturate(1.2) brightness(1.08); }
  .fu-fav { position: absolute; inset: 0; background: radial-gradient(circle at 50% 45%, rgba(61,130,255,.25), transparent 62%); }
  .fu-fav.on { background: radial-gradient(circle at 50% 45%, rgba(34,197,94,.3), transparent 62%); }
  .fu-tile.dim .fu-art > *:not(.fu-tt) { filter: grayscale(.85) brightness(.55); }
  .fu-dot { position: absolute; left: calc(50% + 18%); top: 16%; width: 18px; height: 18px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 4px rgba(10,14,20,.9), 0 0 14px #22c55e; } .fu-dot.play { background: #ffc23a; box-shadow: 0 0 0 4px rgba(10,14,20,.9), 0 0 14px #ffc23a; }
  .fu-badge.on { background: #16a34a; } .fu-badge.play { background: #d97706; }
  .fu-rstrip { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
  .fu-rs { border: 0; background: rgba(255,255,255,.05); color: #fff; padding: 6px 8px 8px; cursor: pointer; display: grid; grid-template-columns: 44px 1fr; grid-template-rows: auto auto; column-gap: 8px; align-items: center; text-align: left; font-family: var(--fu-font); border-bottom: 3px solid transparent; transition: background .2s; }
  .fu-rs img { grid-row: span 2; width: 44px; height: 56px; object-fit: contain; } .fu-rs b { font: 700 18px var(--fu-font); } .fu-rs small { font: 600 12px var(--fu-font); color: rgba(255,255,255,.55); }
  .fu-rs:hover { background: rgba(255,255,255,.12); } .fu-rs.cur { border-bottom-color: var(--fu-or); background: rgba(255,107,26,.18); } .fu-rs.locked { opacity: .5; }
  #fuMain:has(.fu-cta) .fu-tiles { padding-bottom: 20px; }
  .fu-cta { position: sticky; bottom: 0; display: flex; justify-content: flex-end; padding: 14px 0 4px; background: linear-gradient(0deg, rgba(5,7,12,.95), transparent); z-index: 3; }
  .fu-cta button { border: 0; background: var(--fu-or); color: #fff; font: italic 900 26px var(--fu-font); text-transform: uppercase; padding: 12px 34px; cursor: pointer; clip-path: polygon(0 0, 100% 0, calc(100% - 14px) 100%, 0 100%); padding-right: 46px; box-shadow: 0 10px 30px rgba(255,107,26,.35); transition: transform .15s, filter .15s; }
  .fu-cta button:hover { transform: translateY(-2px); filter: brightness(1.12); }
  /* espera do convite */
  #wait.inv > :not(#invWait):not(#btnCancel) { display: none !important; }
  #invWait { display: none; } #wait.inv #invWait { display: flex; flex-direction: column; align-items: center; gap: 4px; margin-bottom: 14px; }
  .iw-av { position: relative; width: 120px; height: 120px; } .iw-av .fu-bigav { width: 100%; top: 50%; }
  #invWait b { font: italic 900 32px var(--fu-font); text-transform: uppercase; } #invWait p { margin: 0; font: 600 17px var(--fu-font); color: rgba(255,255,255,.8); } #invWait small { font: 600 14px var(--fu-font); color: var(--fu-or); text-transform: uppercase; letter-spacing: .06em; }
  .iw-av::after { content: ''; position: absolute; inset: -10px; border-radius: 50%; border: 3px solid var(--fu-or); border-top-color: transparent; animation: agSpin 1.1s linear infinite; }
  /* convite recebido */
  #invPop { font-family: var(--fu-font); border-radius: 0 !important; border: 0 !important; border-bottom: 4px solid var(--fu-or) !important; background: rgba(18,22,31,.97) !important; }
  #invPop .ip { display: grid; grid-template-columns: 54px 1fr; gap: 10px; align-items: center; margin-bottom: 10px; } #invPop .ip .av { width: 54px; height: 54px; object-fit: cover; display: grid; place-items: center; background: #2a3142; font: 800 22px var(--fu-font); }
  #invPop .ip b { font: italic 900 20px var(--fu-font); text-transform: uppercase; display: block; } #invPop .ip span { font: 600 14px var(--fu-font); color: rgba(255,255,255,.75); } #invPop .ip small { display: block; font: 700 13px var(--fu-font); color: var(--fu-or); text-transform: uppercase; }
  #invPop .btn { border-radius: 0; font: 700 17px var(--fu-font); text-transform: uppercase; } #invPop .btn:not(.ghost) { background: #fff; color: #0b0e14; box-shadow: none; }
  /* tela VS */
  #vsScreen { position: fixed; inset: 0; z-index: 65; display: none; flex-direction: column; justify-content: space-between; pointer-events: auto; font-family: var(--fu-font); color: #fff;
    background: linear-gradient(90deg, rgba(20,60,160,.55), rgba(5,7,12,.2) 38%, rgba(5,7,12,.2) 62%, rgba(200,70,20,.5)), linear-gradient(0deg, rgba(5,7,12,.85), transparent 30%, transparent 75%, rgba(5,7,12,.7)); }
  #vsScreen.on { display: flex; animation: vsIn .5s ease both; } #vsScreen.out { animation: vsOut .5s ease both; }
  @keyframes vsIn { from { opacity: 0; } } @keyframes vsOut { to { opacity: 0; transform: scale(1.04); } }
  .vs-top { align-self: center; margin-top: 26px; background: rgba(10,12,18,.8); padding: 8px 22px; font: 800 18px var(--fu-font); letter-spacing: .12em; border-bottom: 3px solid var(--fu-or); animation: rlIn .5s .1s both; }
  .vs-row { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 20px; padding: 0 5vw; }
  .vs-side { display: flex; flex-direction: column; gap: 4px; } .vs-side.l { align-items: flex-start; animation: vsL .7s cubic-bezier(.2,.9,.3,1) both; } .vs-side.r { align-items: flex-end; text-align: right; animation: vsR .7s cubic-bezier(.2,.9,.3,1) both; }
  @keyframes vsL { from { opacity: 0; transform: translateX(-80px); } } @keyframes vsR { from { opacity: 0; transform: translateX(80px); } }
  .vs-av { position: relative; width: clamp(110px, 16vw, 210px); aspect-ratio: 1; filter: drop-shadow(0 16px 30px rgba(0,0,0,.6)); } .vs-av .fu-bigav { width: 100%; top: 50%; font-size: clamp(50px, 7vw, 90px); }
  .vs-nm { font: italic 900 clamp(34px, 5vw, 66px) / .95 var(--fu-font); text-transform: uppercase; text-shadow: 0 4px 24px rgba(0,0,0,.6); max-width: 38vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vs-sub { font: 700 17px var(--fu-font); color: rgba(255,255,255,.75); text-transform: uppercase; letter-spacing: .06em; }
  .vs-rk { display: flex; align-items: center; gap: 10px; margin-top: 10px; background: rgba(10,12,18,.75); padding: 6px 14px 6px 6px; border-bottom: 3px solid var(--fu-or); } .vs-side.r .vs-rk { flex-direction: row-reverse; padding: 6px 6px 6px 14px; }
  .vs-rk img, .vs-rk > i { width: 64px; height: 80px; object-fit: contain; } .vs-rk b { display: block; font: 800 22px var(--fu-font); text-transform: uppercase; } .vs-rk small { font: 600 14px var(--fu-font); color: rgba(255,255,255,.7); }
  .vs-mid b { font: italic 900 clamp(70px, 10vw, 140px) var(--fu-font); color: #fff; text-shadow: 0 0 40px rgba(255,107,26,.8), 0 6px 0 rgba(0,0,0,.4); animation: vsPop .6s .25s cubic-bezier(.2,1.6,.4,1) both; display: block; }
  @keyframes vsPop { from { opacity: 0; transform: scale(2.4) rotate(-8deg); } }
  .vs-bot { align-self: center; width: min(520px, 80vw); margin-bottom: 34px; text-align: center; font: 700 18px var(--fu-font); text-transform: uppercase; letter-spacing: .08em; }
  .vs-bar { height: 5px; background: rgba(255,255,255,.15); margin-bottom: 8px; } .vs-bar i { display: block; height: 100%; width: 0; background: var(--fu-or); transition: width .1s linear; }
  body.vsing #hud, body.vsing #lockOverlay { opacity: 0; pointer-events: none; }
  @media (max-width: 760px) { .vs-row { grid-template-columns: 1fr; gap: 6px; } .vs-side.r { align-items: flex-start; text-align: left; } .vs-side.r .vs-rk { flex-direction: row; } .vs-mid b { font-size: 60px; } .vs-nm { max-width: 90vw; } }`;
  document.head.appendChild(st);
  $('wait').prepend(h('div', { id: 'invWait' }));
}

/* =====================================================================
   VITÓRIA: música, título grande com o nome do jogador, efeitos na tela
   e o último ponto passando em replay no fundo. Também: selo de fundador
   e som da câmera lenta nos replays.
   ===================================================================== */
const VICTORY_SHA = 'a363b625c293d2675c79ba60945c9720d2de3235';
const VIC = { el: null, audio: null, g: null, playing: false, timer: 0 };
function playVictoryMusic() {
  ensureAudio(); if (!actx) return;
  if (!VIC.audio) {
    const a = new Audio(); a.crossOrigin = 'anonymous'; a.preload = 'auto';
    a.src = `https://cdn.jsdelivr.net/gh/amxgroup07/pingpong-online@${VICTORY_SHA}/assets/victory.mp3`;
    a.onerror = () => { if (!a.dataset.f) { a.dataset.f = 1; a.src = `https://raw.githubusercontent.com/amxgroup07/pingpong-online/${VICTORY_SHA}/assets/victory.mp3`; a.play().catch(() => { }); } };
    a.onended = () => { VIC.playing = false; updateMenuMusic(); };
    try { const src = actx.createMediaElementSource(a), g = actx.createGain(); g.gain.value = 1.8; src.connect(g).connect(VOL.music); VIC.g = g; } catch (e) { console.warn('vitória', e); }
    VIC.audio = a;
  }
  if (muted || cfg.vMusic <= 0) return;
  VIC.playing = true; updateMenuMusic();
  VIC.audio.currentTime = 0; VIC.audio.play().catch(() => { VIC.playing = false; });
}
function stopVictoryMusic() { if (VIC.audio && !VIC.audio.paused) { VIC.audio.pause(); } VIC.playing = false; }
// selo de usuário fundador (quem entrou até o fim de dezembro de 2026)
function founderBadge(size = 'sm') { return h('span', { class: 'fdr ' + size, title: 'Usuário fundador: entrou no jogo até dezembro de 2026' }, h('i', { text: '★' }), 'FUNDADOR'); }
const isFounder = () => !!(acct.profile && acct.profile.founder);
let oppFounder = false;
function founderWelcome() {
  if (!isFounder() || store.get('pp_fdr_seen', '') === '1') return;
  store.set('pp_fdr_seen', '1');
  const ok = h('button', { class: 'fu-btn', text: 'Valeu! ▶' });
  const el = h('div', { id: 'fdrPop' }, h('div', { class: 'fdr-card' },
    h('div', { class: 'fdr-medal' }, h('i', { text: '★' })), h('small', { text: 'SELO DESBLOQUEADO' }), h('b', { text: 'Usuário fundador' }),
    h('p', { text: 'Você está entre os primeiros jogadores do Ping Pong Online. O selo fica no seu perfil para sempre e aparece para seus amigos, no ranking e antes de cada partida.' }), ok));
  ok.onclick = () => { el.classList.add('out'); setTimeout(() => el.remove(), 400); };
  document.body.append(el);
  tone(660, 0.15, 0.05, 'triangle'); tone(880, 0.15, 0.05, 'triangle', 0.12); tone(1320, 0.3, 0.05, 'triangle', 0.24);
}
// ---------- tela de vitória ----------
function showWin() {
  let el = $('winScreen');
  if (!el) {
    el = h('div', { id: 'winScreen' }, h('div', { class: 'ws-rays' }), h('div', { class: 'ws-glow' }), h('div', { class: 'ws-conf' }),
      h('div', { class: 'ws-mid' }, h('div', { class: 'ws-title' }), h('div', { class: 'ws-who' }), h('div', { class: 'ws-score' })),
      h('button', { class: 'ws-skip', text: 'Continuar  ⏭' }));
    el.querySelector('.ws-skip').onclick = e => { e.stopPropagation(); finishVictory(); };
    document.body.append(el);
  }
  const p = acct.profile, name = p ? p.name : 'Você';
  const t = el.querySelector('.ws-title'); t.textContent = '';
  [...'VITÓRIA'].forEach((ch, i) => t.append(h('span', { style: `animation-delay:${0.15 + i * 0.07}s`, text: ch })));
  const who = el.querySelector('.ws-who'); who.textContent = '';
  who.append(h('div', { class: 'ws-av' }, avatarNode(myAvatar(), name, 'fu-bigav')), h('div', {}, h('b', { text: name }), isFounder() ? founderBadge('sm') : null));
  const g = S.gameScores || [];
  el.querySelector('.ws-score').textContent = S.format > 1
    ? `${FORMATS[S.format].short} · ${S.games[String(S.mySide)]} × ${S.games[String(-S.mySide)]} em games · contra ${oppLabel()}`
    : `${(g[0] || S.score)[String(S.mySide)]} × ${(g[0] || S.score)[String(-S.mySide)]} contra ${oppLabel()}`;
  const cf = el.querySelector('.ws-conf'); cf.textContent = '';
  const cols = ['#ffc23a', '#ff6b1a', '#ffffff', '#3d9bff', '#ff3d7f', '#22c55e'];
  for (let i = 0; i < 70; i++) cf.append(h('i', { style: `left:${Math.random() * 100}%;background:${cols[i % cols.length]};animation-duration:${2.6 + Math.random() * 2.6}s;animation-delay:${Math.random() * 2.5}s;transform:rotate(${Math.random() * 360}deg);width:${6 + Math.random() * 6}px;height:${10 + Math.random() * 8}px` }));
  el.classList.remove('out'); el.classList.add('on');
  document.body.classList.add('winning');
}
function hideWin() {
  const el = $('winScreen'); if (!el || !el.classList.contains('on')) return;
  el.classList.add('out'); setTimeout(() => el.classList.remove('on', 'out'), 600);
  document.body.classList.remove('winning');
}
function victoryLoop() {                                  // último ponto em replay, repetindo no fundo
  if (!(END.active && END.stage === 'victory') || !RP.last) return;
  startReplay(RP.last, { mode: 'bg', title: 'VITÓRIA', onEnd: () => setTimeout(victoryLoop, 50) });
}
function startVictory() {
  END.stage = 'victory'; END.t = 0;
  showWin(); playVictoryMusic(); fxWin(true);
  celebrate(1.3); setTimeout(() => { if (END.active) celebrate(1); }, 2200); setTimeout(() => { if (END.active) celebrate(0.8); }, 5200);
  victoryLoop();
  clearTimeout(VIC.timer); VIC.timer = setTimeout(() => { if (END.stage === 'victory') finishVictory(); }, VIC.hold || 11000);
}
function finishVictory() {
  clearTimeout(VIC.timer);
  if (END.stage !== 'victory') return;
  END.stage = 'hlwait'; hideWin();
  if (RP.play) endReplay(false);
  $('rpTitle').textContent = '🏆 VITÓRIA'; $('rpSkip').textContent = 'Ver resultado ⏭';
  nextHighlight();
}
// ---------- som da câmera lenta: grave contínuo, "ar" abafado, coração e varrida na entrada/saída ----------
const SLOW = { on: false, nodes: null, beat: 0 };
function slowAudio(on) {
  if (!actx || SLOW.on === on) return;
  SLOW.on = on;
  const t = actx.currentTime;
  if (!SLOW.nodes) {
    const g = actx.createGain(); g.gain.value = 0; g.connect(VOL.fx[0]);
    const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380; lp.connect(g);
    for (const [f, d] of [[55, 0], [82.4, 4], [110, -5]]) { const o = actx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.detune.value = d; const og = actx.createGain(); og.gain.value = f === 55 ? 0.6 : 0.25; o.connect(og).connect(lp); o.start(); }
    const n = actx.createBufferSource(); n.buffer = noiseBuf; n.loop = true; const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.6;
    const ng = actx.createGain(); ng.gain.value = 0.5; n.connect(bp).connect(ng).connect(g); n.start();
    SLOW.nodes = { g };
  }
  SLOW.nodes.g.gain.setTargetAtTime(on ? 0.09 : 0, t, on ? 0.12 : 0.25);
  if (VOL.crowdDuck) VOL.crowdDuck.gain.setTargetAtTime(on ? 0.3 : 1, t, 0.2);   // torcida fica abafada
  // varrida: desce ao entrar, sobe ao sair
  const s = actx.createBufferSource(); s.buffer = noiseBuf; const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 6;
  f.frequency.setValueAtTime(on ? 3200 : 220, t); f.frequency.exponentialRampToValueAtTime(on ? 180 : 3600, t + (on ? 0.7 : 0.45));
  const sg = actx.createGain(); sg.gain.setValueAtTime(0.0001, t); sg.gain.exponentialRampToValueAtTime(0.16, t + 0.08); sg.gain.exponentialRampToValueAtTime(0.0001, t + (on ? 0.8 : 0.5));
  s.connect(f).connect(sg).connect(sfxBus); s.start(t, Math.random() * 2); s.stop(t + 0.9);
  clearInterval(SLOW.beat);
  if (on) {
    const thump = (d, v) => { const tt = actx.currentTime + d, o = actx.createOscillator(), gg = actx.createGain(); o.frequency.setValueAtTime(70, tt); o.frequency.exponentialRampToValueAtTime(38, tt + 0.16); gg.gain.setValueAtTime(0.0001, tt); gg.gain.exponentialRampToValueAtTime(v, tt + 0.012); gg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.22); o.connect(gg).connect(VOL.fx[0]); o.start(tt); o.stop(tt + 0.25); };
    const beat = () => { if (!SLOW.on) return; thump(0, 0.22); thump(0.24, 0.14); };
    beat(); SLOW.beat = setInterval(beat, 900);
  }
}
function initVictoryUI() {
  const st = document.createElement('style');
  st.textContent = `
  .fdr { display: inline-flex; align-items: center; gap: 5px; font: 800 12px var(--fu-font, system-ui); letter-spacing: .1em; color: #2a1a00; background: linear-gradient(135deg, #fff1b0, #ffc23a 45%, #c98a0f); padding: 2px 9px 2px 6px; box-shadow: 0 0 14px rgba(255,194,58,.45); clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%); vertical-align: middle; white-space: nowrap; }
  .fdr i { font-style: normal; font-size: 12px; } .fdr.xs { font-size: 10px; padding: 1px 7px 1px 5px; } .fdr.lg { font-size: 16px; padding: 4px 14px 4px 10px; }
  .fu-tile .fdr.xs { position: absolute; top: 10px; right: 10px; }
  #fdrPop { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; background: rgba(5,7,12,.75); animation: vsIn .4s both; font-family: var(--fu-font); } #fdrPop.out { animation: vsOut .4s both; }
  .fdr-card { width: min(420px, 90vw); background: rgba(18,22,31,.98); border-bottom: 4px solid #ffc23a; padding: 28px 26px 22px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; animation: fuPop2 .6s cubic-bezier(.2,1.5,.4,1) both; }
  @keyframes fuPop2 { from { transform: scale(.8); opacity: 0; } }
  .fdr-medal { width: 110px; height: 120px; clip-path: polygon(50% 0, 100% 14%, 100% 62%, 50% 100%, 0 62%, 0 14%); background: linear-gradient(135deg, #fff1b0, #ffc23a 45%, #a0640a); display: grid; place-items: center; box-shadow: 0 0 40px rgba(255,194,58,.5); margin-bottom: 6px; animation: fdrShine 2.4s ease-in-out infinite; }
  .fdr-medal i { font-style: normal; font-size: 58px; color: #5a3500; } @keyframes fdrShine { 50% { filter: brightness(1.25); } }
  .fdr-card small { font: 800 13px var(--fu-font); letter-spacing: .2em; color: #ffc23a; } .fdr-card b { font: italic 900 38px var(--fu-font); text-transform: uppercase; } .fdr-card p { font: 500 16px var(--fu-font); color: rgba(255,255,255,.75); margin: 2px 0 12px; line-height: 1.35; }
  /* vitória */
  #winScreen { position: fixed; inset: 0; z-index: 64; display: none; pointer-events: none; overflow: hidden; font-family: var(--fu-font); color: #fff; background: radial-gradient(ellipse at 50% 46%, rgba(5,7,12,.55), rgba(5,7,12,.15) 55%, rgba(5,7,12,.6)); }
  #winScreen.on { display: block; animation: vsIn .6s both; } #winScreen.out { animation: vsOut .6s both; }
  .ws-rays { position: absolute; left: 50%; top: 42%; width: 180vmax; height: 180vmax; transform: translate(-50%, -50%); background: repeating-conic-gradient(from 0deg, rgba(255,194,58,.16) 0 6deg, transparent 6deg 18deg); mask: radial-gradient(circle, #000 0, transparent 55%); -webkit-mask: radial-gradient(circle, #000 0, transparent 55%); animation: wsSpin 22s linear infinite; }
  @keyframes wsSpin { to { transform: translate(-50%, -50%) rotate(360deg); } }
  .ws-glow { position: absolute; left: 50%; top: 40%; width: 70vmin; height: 40vmin; transform: translate(-50%, -50%); background: radial-gradient(ellipse, rgba(255,150,40,.45), transparent 70%); animation: wsPulse 1.6s ease-in-out infinite; }
  @keyframes wsPulse { 50% { opacity: .55; transform: translate(-50%, -50%) scale(1.08); } }
  .ws-conf i { position: absolute; top: -20px; display: block; animation: wsFall linear infinite; opacity: .9; }
  @keyframes wsFall { to { transform: translateY(115vh) rotate(720deg); } }
  .ws-mid { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-58%); display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .ws-title { font: italic 900 clamp(80px, 15vw, 220px) / .85 var(--fu-font); letter-spacing: .01em; display: flex; filter: drop-shadow(0 8px 0 rgba(0,0,0,.35)) drop-shadow(0 0 40px rgba(255,160,40,.55)); }
  .ws-title span { display: inline-block; background: linear-gradient(180deg, #fffbe6 0%, #ffd45a 45%, #ff8a1f 100%); -webkit-background-clip: text; background-clip: text; color: transparent; animation: wsLetter .7s cubic-bezier(.2,1.6,.4,1) both, wsShine 2.6s 1.2s ease-in-out infinite; }
  @keyframes wsLetter { from { opacity: 0; transform: translateY(-60px) scale(1.8) rotate(-8deg); } }
  @keyframes wsShine { 50% { filter: brightness(1.35); } }
  .ws-who { display: flex; align-items: center; gap: 14px; animation: rlIn .6s .8s both; background: rgba(10,12,18,.72); padding: 8px 22px 8px 10px; border-bottom: 4px solid var(--fu-or, #ff6b1a); }
  .ws-av { position: relative; width: 64px; height: 64px; } .ws-av .fu-bigav { width: 100%; top: 50%; font-size: 30px; }
  .ws-who b { display: block; font: italic 900 clamp(30px, 4vw, 46px) / 1 var(--fu-font); text-transform: uppercase; margin-bottom: 4px; }
  .ws-score { font: 700 19px var(--fu-font); letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.85); animation: rlIn .6s 1.1s both; text-shadow: 0 2px 10px rgba(0,0,0,.7); }
  .ws-skip { position: absolute; right: 26px; bottom: 26px; pointer-events: auto; border: 0; background: rgba(255,255,255,.12); color: #fff; font: 700 17px var(--fu-font); text-transform: uppercase; padding: 10px 18px; cursor: pointer; } .ws-skip:hover { background: #fff; color: #0b0e14; }
  body.winning #rpUI, body.winning #bigBanner { display: none !important; }
  body.winning #hud, body.winning #chatFeed, body.winning #lockOverlay { opacity: 0 !important; pointer-events: none; }
  /* barras de atributos das raquetes */
  .fu-bars { display: flex !important; gap: 3px; margin-top: 4px; height: 9px; } .fu-bars i { flex: 1; max-width: 16px; background: rgba(255,255,255,.14); transform: skewX(-14deg); } .fu-bars i.on { background: linear-gradient(90deg, #ff9a3c, #ff6b1a); box-shadow: 0 0 6px rgba(255,107,26,.5); }
  .fu-rs .rsb { grid-column: 2; display: grid; grid-template-columns: 26px 1fr; gap: 2px 6px; align-items: center; font: 700 11px var(--fu-font); color: rgba(255,255,255,.6); }
  .fu-rs .rsb .fu-bars { margin: 0; height: 7px; }
  .fu-stats { display: grid; grid-template-columns: minmax(160px, 260px) 1fr; gap: 16px; align-items: center; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.07); }
  .fu-stats .row { display: grid; grid-template-columns: 96px 1fr 26px; gap: 10px; align-items: center; font: 700 15px var(--fu-font); text-transform: uppercase; color: rgba(255,255,255,.75); margin: 4px 0; }
  .fu-stats .row .fu-bars { height: 14px; margin: 0; } .fu-stats .row .fu-bars i { max-width: none; } .fu-stats .row b { color: #fff; font-size: 18px; text-align: right; }
  .fu-stats p { margin: 0; font: 500 15px var(--fu-font); color: rgba(255,255,255,.7); line-height: 1.35; } .fu-stats p b { display: block; font: italic 900 24px var(--fu-font); text-transform: uppercase; color: #fff; margin-bottom: 2px; }
  /* skins escurecidas até escolher a raquete */
  .fu-tiles.shade { position: relative; } .fu-tiles.shade .fu-tile { filter: brightness(.28) grayscale(.7); pointer-events: none; }
  .fu-shade { position: absolute; inset: 0; z-index: 4; display: grid; place-items: center; background: linear-gradient(180deg, rgba(5,7,12,.75), rgba(5,7,12,.35) 50%, rgba(5,7,12,.75)); }
  .fu-shade span { font: italic 900 clamp(22px, 2.6vw, 32px) var(--fu-font); text-transform: uppercase; padding: 10px 22px; background: rgba(10,12,18,.85); border-bottom: 3px solid var(--fu-or); animation: wsPulse2 1.6s ease-in-out infinite; } @keyframes wsPulse2 { 50% { opacity: .7; } }
  .fu-cta button.off { background: #3a3f4d; box-shadow: none; cursor: default; }
  @media (max-width: 760px) { .fu-stats { grid-template-columns: 1fr; } }`;
  document.head.appendChild(st);
}

/* =====================================================================
   RENDER
   ===================================================================== */
const _q = new THREE.Quaternion(), _ax = new THREE.Vector3();
function placePaddle(mesh, pd, sd, dt) {
  const u = mesh.userData;
  const vx = dt > 0 ? (pd.x - u.lx) / dt : 0, vz = dt > 0 ? (pd.z - u.lz) / dt : 0;
  u.lx = pd.x; u.lz = pd.z;
  u.vx = lerp(u.vx, vx, Math.min(1, dt * 12)); u.vz = lerp(u.vz, vz, Math.min(1, dt * 12));
  u.swing = Math.max(0, u.swing - dt * 4.5);
  const fwd = -u.vz * sd;                           // velocidade em direção à rede
  const sw = Math.sin(u.swing * Math.PI) * u.swing;
  mesh.position.set(pd.x, pd.y, pd.z - sd * sw * 0.08);
  mesh.rotation.set(0, sd > 0 ? 0 : Math.PI, 0);
  u.pivot.rotation.set(-0.28 - clamp(fwd * 0.05, -0.25, 0.4) - sw * 0.7, 0, clamp(-u.vx * sd * 0.07 - pd.x * sd * 0.35, -0.8, 0.8));
}

function render(dt, now) {
  const t = now / 1000;
  if (RP.play) replayPose(); else renderLive(dt);
  recFrame(dt);
  renderWorld(dt, t);
}
function renderLive(dt) {
  ballMesh.visible = blob.visible = S.ballVisible; ballGlow.visible = S.ballVisible && cfg.ballGlow;
  if (S.ballVisible) {
    const p = S.ball.p, w = S.ball.w;
    ballMesh.position.set(p[0], p[1], p[2]);
    const wl = Math.hypot(w[0], w[1], w[2]);
    if (wl > 0.1 && S.phase !== 'serve') { _ax.set(w[0] / wl, w[1] / wl, w[2] / wl); _q.setFromAxisAngle(_ax, wl * dt * TIME_SCALE * 0.3); ballMesh.quaternion.premultiply(_q); }
    ballGlow.position.copy(ballMesh.position);
    const sp = Math.hypot(S.ball.v[0], S.ball.v[1], S.ball.v[2]);
    const gs = 0.06 + Math.min(sp, 14) * 0.003;
    ballGlow.scale.set(gs, gs, 1);
    ballGlow.material.color.copy(trailColor).lerp(new THREE.Color(0xffffff), 0.55);
    const overTable = Math.abs(p[0]) < HW && Math.abs(p[2]) < HL && p[1] > TH - 0.01;
    const sy = overTable ? TH + 0.002 : 0.005;
    blob.position.set(p[0], sy, p[2]);
    const hgt = Math.max(0, p[1] - sy);
    const s = 1 + hgt * 1.4; blob.scale.set(s, s, s);
    blobMat.opacity = clamp(0.6 - hgt * 0.4, 0.12, 0.6);
    if (S.phase === 'rally' || S.phase === 'point') {
      trailPts.push([p[0], p[1], p[2]]);
      if (trailPts.length > TRAIL_N) trailPts.shift();
    }
  }
  if (!S.ballVisible) trailPts.length = 0;
  updateTrail();

  const inGame = S.phase !== 'lobby';
  myPaddleMesh.visible = oppPaddleMesh.visible = inGame;
  if (inGame) {
    placePaddle(myPaddleMesh, me, S.mySide, dt);
    placePaddle(oppPaddleMesh, S.mode === 'solo' ? bot : opp, -S.mySide, dt);
  }
}
const lobbyEl = document.getElementById('lobby');
function renderWorld(dt, t) {
  // animações do ambiente
  ledFlash = Math.max(0, ledFlash - dt * 1.2);
  jumboMat.emissiveIntensity = 1.0 + ledFlash * 0.5;
  hitFlash = Math.max(0, hitFlash - dt * 5);
  hitLight.intensity = hitFlash * 1.6;
  rimSpots.forEach((s, i) => { s.intensity = A.rimBase + Math.sin(t * 0.8 + i * 1.7) * A.rimPulse + ledFlash * A.rimFlash; });
  updateArena(t, dt);
  updateDust(t, dt);
  sparks.update(dt); confetti.update(dt); pyro.update(dt);
  updateRacketFx(myPaddleMesh, t, dt); updateRacketFx(oppPaddleMesh, t, dt); aura.update(dt);
  updateFireworks(dt); fwSolid.update(dt); asmrTick(dt); updateLandMark(t); tutTick();
  updateRings(dt);
  updateNet(dt * TIME_SCALE);

  if (!window.__ppNoRender && !(S.phase === 'lobby' && lobbyEl && !lobbyEl.classList.contains('hidden'))) composer.render(dt);    // no menu o 3D fica escondido: não desenha (testes também podem pular)
}

function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);
scene.traverse(o => { const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []; for (const m of ms) if (m.envMapIntensity !== undefined && !m.userData.envDone) { m.envMapIntensity *= 0.18; m.userData.envDone = true; } });
buildArena(store.get('pp_arena', 'neon'));
applyQuality(Q.level, true);
drawJumbo();

let last = performance.now(), acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = (now - last) / 1000;
  const dt = Math.min(rawDt, 0.05); last = now;
  if (RP.play) {
    replayStep(dt);
    if (RP.play) replayCamera(dt); else updateCamera(dt, now);
  } else if (END.active && (END.stage === 'party' || END.stage === 'victory')) {
    endStep(dt);
  } else if (S.phase === 'lobby') {
    const a = now / 11000;
    camera.position.set(Math.sin(a) * 5.2, 2.6 + Math.sin(a * 2) * 0.4, Math.cos(a) * 5.2);
    camera.lookAt(0, TH, 0);
    camera.fov = 50; camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  } else if (S.mode === 'spec') {
    specFrame(dt, now);
    perfMonitor(rawDt);
  } else {
    updateCamera(dt, now);
    updateMyPaddle(dt);
    perfMonitor(rawDt);
  }
  if (hitStop > 0) hitStop -= dt;                      // peso do golpe: congela um instante
  else if (!S.paused) acc += dt * TIME_SCALE;
  let n = 0;
  while (acc >= DT && n++ < 60) { physicsStep(DT); acc -= DT; }
  if (S.mode === 'online') {
    const k = Math.min(1, dt * 18);
    opp.x = lerp(opp.x, opp.tx, k); opp.y = lerp(opp.y, opp.ty, k); opp.z = lerp(opp.z, opp.tz, k);
  }
  netTick(now);
  if (window.__ppCam) window.__ppCam(camera);
  render(dt, now);
}
requestAnimationFrame(frame);
$('loading').classList.add('hidden');
$('lobby').classList.remove('hidden');

function sha256hex(str) {                      // SHA-256 pequeno (funciona até sem HTTPS)
  const K = [], H = [], isP = n => { for (let f = 2; f * f <= n; f++) if (n % f === 0) return false; return true; };
  for (let n = 2, i = 0; i < 64; n++) if (isP(n)) { if (i < 8) H[i] = (Math.pow(n, 1 / 2) * 2 ** 32) | 0; K[i++] = (Math.pow(n, 1 / 3) * 2 ** 32) | 0; }
  const bytes = [...new TextEncoder().encode(str)], bl = bytes.length * 8;
  bytes.push(0x80); while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i > 3 ? 0 : (bl >>> (i * 8)) & 255);
  const rr = (x, n) => (x >>> n) | (x << (32 - n)), W = new Array(64);
  for (let o = 0; o < bytes.length; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = (bytes[o + i * 4] << 24) | (bytes[o + i * 4 + 1] << 16) | (bytes[o + i * 4 + 2] << 8) | bytes[o + i * 4 + 3];
    for (let i = 16; i < 64; i++) { const s0 = rr(W[i - 15], 7) ^ rr(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = rr(W[i - 2], 17) ^ rr(W[i - 2], 19) ^ (W[i - 2] >>> 10); W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0; }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0, t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
  }
  return H.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
}
async function checkVipLink() {
  const prm = new URLSearchParams(location.search), code = prm.get('vip');
  if (!code) return;
  prm.delete('vip');
  history.replaceState(null, '', location.pathname + (prm.toString() ? '?' + prm : ''));
  try {
    const hex = sha256hex(code.trim());
    if (hex === VIP_HASH) {
      store.set('pp_vip', '1'); renderPick();
      lobbyMsg('⭐ Conta VIP ativada neste aparelho: todas as raquetes liberadas!');
    } else lobbyMsg('Esse código VIP não é válido.');
  } catch (e) { lobbyMsg('Não deu para ativar o VIP neste navegador.'); }
}
checkVipLink();
const roomParam = new URLSearchParams(location.search).get('sala');
if (roomParam) { $('inCode').value = roomParam.toUpperCase(); }

initFeelUI();
initSpecUI();
initFriendsUI();
initMatchUI();
initVictoryUI();
initMenuShell();
initGate();
initUiFx();
const verParam = new URLSearchParams(location.search).get('ver');
if (roomParam) gateAfter(() => { if (S.phase === 'lobby') joinRoom(roomParam); });
if (verParam && !roomParam) { $('inCode').value = verParam.toUpperCase(); gateAfter(() => { if (S.phase === 'lobby') joinSpectate(verParam); }); }
window.__pp = { RPl: () => RP.last, startVictory, finishVictory, showWin, VIC, SLOW, slowAudio, founderBadge, MATCH, VS, INV, launchMatch, acceptInvite, showVs, hideVs, get oppAvatar() { return oppAvatar; }, get oppSkin() { return oppSkin; }, RSKINS, GATE, gateSync, UI, showPage, futGo, futTab, renderFut, AVATARS, avatarURI, setAvatar, menuMusic, updateMenuMusic, FR, loadFriends, openFriends, socialPoll, showInvite, SPV, specs, joinSpectate, onSpecMsg, specInit, swingPeakUp, applyHit, prog, levelOf, addXp, dailyMissions, progEvent, hitQuality, startTutorial, TUT, landMark, botLv, BOT_LV, get hitStop() { return hitStop; }, get botStyle() { return botStyle; }, asmr, VOL, applyBallSkin, BALL_SKINS, ballSkinById, lock, updateLockUI, swipeVel, pointer, RP, END, startReplay, celebrate, FWl: launchRocket, awardPoint, acct, queueMatched, division, overRanked, refreshProfile, renderAccount, thumbs, RACKETS, setPaddle, get myRacket() { return myRacket; }, get oppRacket() { return oppRacket; }, pickMove, S, me, bot, opp, camera, cam, get myPaddleMesh() { return myPaddleMesh; }, get oppPaddleMesh() { return oppPaddleMesh; }, netHit, net, buildArena, ARENAS, A, crowd, crowdEvent, pyroBurst, fireworks, scene, perf, sendChat, qc, crowdReact, makeShot, simFlight, stepBall, startGame, onMsg, THREE, applyQuality, audio: () => ({ ctx: !!actx, kinds: Object.keys(IMP), samples: Object.fromEntries(Object.entries(SAMPLES).map(([k, v]) => [k, v.length])), playImpact, ensureAudio }) };
