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
const TL = 2.74, TW = 1.62, TH = 0.76, NET_H = 0.1525, R = 0.02;   // mesa ~6% mais larga que a oficial (1,525 m)
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
const PEER_PREFIX = 'ppol-v1-';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const $ = id => document.getElementById(id);
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };

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
  // raquete com pouco controle espalha um pouco a bola
  if (!serve && ctrl < 4) { const e = 4 - ctrl; depth += (Math.random() - 0.5) * 0.07 * e; tx += (Math.random() - 0.5) * 0.08 * e; }
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
  } else if (Math.random() < (serve ? 0.06 : 0.03 + 0.04 * clamp(pw - 0.8, 0, 1)) * (1.3 - 0.1 * ctrl)) {
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
    audio: { rev: 0.06, crowd: 0.6, amb: 'waves' },
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
            c += vec3(1.0) * smoothstep(-15.4, -14.6, p.y) * (0.5+0.5*sin(p.x*2.5+uT*1.6)) * 0.45;
            c = mix(c, hor, smoothstep(-38.0, -60.0, p.y));
            gl_FragColor = vec4(c, 1.0); }`
      })));
      sea.rotation.x = -Math.PI / 2; sea.position.set(0, 0.01, -14 - 23);
      A.upd.push(t => { sea.material.uniforms.uT.value = t; });
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
const ballTex = canvasTex(256, 128, (g, w, h) => {
  g.fillStyle = '#fffaf2'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#ff9a3c'; g.fillRect(0, h / 2 - 3, w, 6);
  g.fillStyle = '#222'; g.font = 'bold 22px system-ui'; g.fillText('★★★', 30, h / 2 - 14);
});
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(0.024, 28, 18), new THREE.MeshPhysicalMaterial({ map: ballTex, roughness: 0.3, clearcoat: 0.6, emissive: 0xffd0a0, emissiveIntensity: 0.25 }));
scene.add(ballMesh);
const ballGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xffd9b0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 }));
ballGlow.scale.set(0.13, 0.13, 1); scene.add(ballGlow);
const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false, alphaMap: dotTex });
const blob = new THREE.Mesh(new THREE.CircleGeometry(0.032, 24), blobMat);
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
  { id: 'vibora', name: 'Víbora', tag: 'Efeito máximo', desc: 'Borracha grudenta: muito topspin e curva lateral forte. A bola mergulha na mesa e espirra no adversário.', speed: 3, spin: 5, ctrl: 3,
    sound: { rate: 0.95, cut: 0.8, vol: 0.95 }, look: { color: 0x17a34a, rubber: 'tacky', ply: 'wood', handle: 'black', logo: 'VÍBORA', sub: 'STICKY 39°', scale: 1.2 } },
  { id: 'foguete', name: 'Foguete', tag: 'Velocidade', desc: 'Lâmina de carbono: a bola sai muito rápida, mas exige controle. Errou o tempo, a bola sai torta.', speed: 5, spin: 2, ctrl: 2,
    sound: { rate: 1.08, cut: 1.25, vol: 1.12 }, look: { color: 0x1f6fff, rubber: 'smooth', ply: 'carbon', handle: 'carbon', logo: 'FOGUETE', sub: 'CARBON SPEED', scale: 1.24 } },
  { id: 'muralha', name: 'Muralha', tag: 'Anti-efeito', desc: 'Pino longo: não gera efeito nenhum, mas devolve o efeito do adversário ao contrário (o topspin dele volta como corte).', speed: 2, spin: 0, ctrl: 5, anti: true,
    sound: { rate: 0.88, cut: 0.55, vol: 0.8 }, look: { color: 0xff6fae, rubber: 'pips', ply: 'wood', handle: 'light', logo: 'MURALHA', sub: 'LONG PIPS', scale: 1.2 } },
  { id: 'raiz', name: 'Raiz', tag: 'Bola reta', desc: 'Retrô, sem esponja: bola reta e veloz, quase sem efeito. Fácil de bater, difícil de enganar.', speed: 4, spin: 1, ctrl: 3,
    sound: { rate: 1.16, cut: 1.05, vol: 1.05 }, look: { color: 0xb3261e, rubber: 'hardbat', ply: 'old', handle: 'old', logo: 'RAIZ', sub: 'HARDBAT 1965', scale: 1.16 } },
  { id: 'dragao', name: 'Dragão Dourado', tag: 'Lendária', desc: 'Rápida, com muito efeito e muito controle.', speed: 4, spin: 4, ctrl: 4, unlock: 3,
    sound: { rate: 1.03, cut: 1.12, vol: 1.05 }, look: { color: 0xd9a520, rubber: 'gold', ply: 'gold', handle: 'gold', logo: 'DRAGÃO', sub: '★ LENDÁRIA ★', scale: 1.22 } },
];
const racketById = id => RACKETS.find(r => r.id === id) || RACKETS[0];
const winCount = () => +store.get('pp_wins', '0') || 0;
// conta VIP: aberta pelo link secreto (?vip=código). Só o hash do código fica no jogo.
const VIP_HASH = '58ad5d6d6e4e1bac078a1a8dc4c2c63af41e6747573939db4d1186abe1d7e5ae';
const isVip = () => store.get('pp_vip', '0') === '1';
const isUnlocked = r => !r.unlock || isVip() || winCount() >= r.unlock;
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
function rubberTexFor(hex, kind, logo, sub) {
  return rtx(`r_${hex}_${kind}_${logo}`, () => {
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
    });
    const side = canvasTex(16, 64, (g, w, h) => {              // borda: lâmina da borracha + esponja (a Raiz não tem esponja)
      g.fillStyle = css; g.fillRect(0, 0, w, kind === 'hardbat' ? h : 18);
      if (kind !== 'hardbat') { g.fillStyle = kind === 'pips' ? '#f2d6a0' : '#efb43c'; g.fillRect(0, 18, w, h - 18); for (let i = 0; i < 60; i++) { g.fillStyle = 'rgba(150,90,10,.5)'; g.fillRect(Math.random() * w, 18 + Math.random() * (h - 18), 1.4, 1.4); } }
    });
    return { top, side };
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
const RUBBER_MAT = {
  smooth: { roughness: 0.55, clearcoat: 0.28, clearcoatRoughness: 0.45 },
  tacky: { roughness: 0.3, clearcoat: 0.75, clearcoatRoughness: 0.18 },
  pips: { roughness: 0.85, clearcoat: 0 },
  hardbat: { roughness: 0.8, clearcoat: 0 },
  gold: { roughness: 0.32, metalness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.2 },
};
// monta a raquete; o lado colorido fica para a câmera de quem segura (sua raquete) ou para você (a do adversário)
function buildRacket(def, mine, opacity = 1) {
  const L = def.look, root = new THREE.Group(), pivot = new THREE.Group(); root.add(pivot);
  const racket = new THREE.Group(); racket.scale.setScalar(L.scale || PADDLE_SCALE); pivot.add(racket);
  const base = opacity < 1 ? { transparent: true, opacity } : {};
  const ply = new THREE.MeshStandardMaterial({ map: plyTexFor(L.ply), roughness: L.ply === 'gold' ? 0.3 : 0.6, metalness: L.ply === 'gold' ? 0.7 : 0, ...base });
  const blade = new THREE.Mesh(bladeGeo, [ply, ply]); blade.castShadow = true; racket.add(blade);
  const colored = mine ? 1 : -1, thin = L.rubber === 'hardbat';
  for (const sideZ of [-1, 1]) {
    const isCol = sideZ === colored, kind = isCol ? L.rubber : (thin ? 'hardbat' : 'smooth');
    const t = rubberTexFor(isCol ? L.color : 0x1a1a1c, kind, L.logo, L.sub);
    const top = new THREE.MeshPhysicalMaterial({ map: t.top, ...RUBBER_MAT[kind], ...base });
    const edge = new THREE.MeshStandardMaterial({ map: t.side, roughness: 0.9, ...base });
    const rb = new THREE.Mesh(thin ? rubberGeoThin : rubberGeo, [top, edge]);
    rb.position.z = sideZ * BLADE_T / 2;
    if (sideZ < 0) rb.rotation.y = Math.PI;          // a face de fora fica para fora (e o logo legível)
    rb.castShadow = true; racket.add(rb);
  }
  const hk = L.handle, metal = hk === 'gold';
  const wood = new THREE.MeshPhysicalMaterial({ map: handleTexFor(hk), roughness: metal ? 0.3 : hk === 'carbon' ? 0.35 : 0.42, metalness: metal ? 0.6 : 0, clearcoat: hk === 'old' ? 0.1 : 0.4, clearcoatRoughness: 0.3, ...base });
  const handle = new THREE.Mesh(hk === 'old' ? handleGeoST : handleGeo, wood); handle.castShadow = true; racket.add(handle);
  const bm = new THREE.MeshStandardMaterial({ map: badgeTexFor(L), roughness: 0.3, metalness: 0.5, transparent: true, opacity, alphaTest: 0.05 });
  for (const sz of [-1, 1]) { const b = new THREE.Mesh(badgeGeo, bm); b.position.set(0, -0.128, sz * 0.0112); if (sz < 0) b.rotation.y = Math.PI; racket.add(b); }
  return { root, pivot };
}
function disposeRacket(root) { root.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); }); }
function makePaddle(def, mine) {
  const { root, pivot } = buildRacket(def, mine, mine ? 0.88 : 1);
  scene.add(root);
  root.userData = { pivot, swing: 0, vx: 0, vz: 0, lx: 0, lz: 0 };
  return root;
}
let myRacket = racketById(store.get('pp_racket', 'classica'));
if (!isUnlocked(myRacket)) myRacket = RACKETS[0];
let oppRacket = RACKETS[0];
let myPaddleMesh = makePaddle(myRacket, true);
let oppPaddleMesh = makePaddle(oppRacket, false);
function setPaddle(which, def) {
  const mine = which === 'me', old = mine ? myPaddleMesh : oppPaddleMesh;
  const m = makePaddle(def, mine);
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
const pyro = makeParticles(700, 0.055, true);

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
  streak: 0, lastLabel: 'SAQUE',
};
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

function onPointer(e) {
  const r = canvas.getBoundingClientRect();
  let y = e.clientY;
  if (e.pointerType === 'touch') y -= Math.min(70, r.height * 0.08);
  pointer.nx = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.ny = ((y - r.top) / r.height) * 2 - 1;
  const t = performance.now() / 1000;
  pointer.hist.push({ t, hx: (e.clientX - r.left) / r.height, hy: (y - r.top) / r.height });
  while (pointer.hist.length > 40 || (pointer.hist.length > 2 && t - pointer.hist[0].t > 0.3)) pointer.hist.shift();
  ensureAudio();
}
canvas.addEventListener('pointermove', onPointer);
canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture?.(e.pointerId); onPointer(e); });

function swipeVel() {
  const h = pointer.hist, now = performance.now() / 1000;
  if (h.length < 2) return { x: 0, up: 0 };
  const last = h[h.length - 1];
  if (now - last.t > 0.07) return { x: 0, up: 0 };
  let old = null;
  for (let i = h.length - 1; i >= 0; i--) { if (last.t - h[i].t <= 0.1) old = h[i]; else break; }
  if (!old || last.t - old.t < 0.012) return { x: 0, up: 0 };
  const dt = last.t - old.t;
  return { x: (last.hx - old.hx) / dt, up: -(last.hy - old.hy) / dt };
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
  const tx = B[0] * 0.3 + sd * sv.x * 0.24;                   // a bola sai para o lado do gesto
  // raquete raspando de lado gira a bola no eixo vertical (sidespin) -> curva no ar (Magnus)
  // e uma "quebra" no quique: bater da esquerda pra direita faz a bola fazer a curva
  const sideSpin = clamp(sv.x * 55 * (serve ? 1.2 : 1), -260, 260);
  const shot = makeShot(sd, B, power, tx, sideSpin, serve, serve ? { rk: myRacket } : { inW: [...S.ball.w], inSpeed: Math.hypot(...S.ball.v), chop, rk: myRacket });
  applyHit(sd, B, shot, serve);
  if (S.mode === 'online') send({ t: 'hit', side: sd, p: B, v: shot.v, w: shot.w, serve, label: shot.label });
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
  fxHit(side, B, shot.label);
  if (S.mode === 'solo' && side !== sideOfBot()) botPredict();
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
  if (winner) S.score[winner]++;
  if (S.mode === 'online') send({ t: 'point', winner, reason, score: S.score });
  onPoint(winner, reason);
}

function onPoint(winner, reason) {
  S.phase = 'point'; S.phaseT = 0;
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
function matchPointFor() {
  const a = S.score['1'], b = S.score['-1'];
  if (a >= POINT_TO_WIN - 1 && a - b >= 1) return 1;
  if (b >= POINT_TO_WIN - 1 && b - a >= 1) return -1;
  return 0;
}

function nextPoint() {
  if (isGameOver()) { S.phase = 'over'; S.ballVisible = false; showOver(); return; }
  S.server = computeServer();
  S.phase = 'serve'; S.phaseT = 0; S.serveBall = null;
  S.serveX = S.server === S.mySide ? clamp(me.x, -0.6, 0.6) : (Math.random() - 0.5) * 0.8;
  bot.served = false; bot.serveAt = 0.9 + Math.random() * 0.8;
  trailPts.length = 0;
  if (S.server === S.mySide) showMsg('Seu saque', 'raquete atrás da bola + movimento para cima');
  if (matchPointFor()) startRhythm();
  updateHud();
}

function serveBallPos() {
  const t = S.phaseT;
  return [S.serveX, TH + 0.2 + 0.2 * Math.abs(Math.sin(t * 2.4)), S.server * (HL + 0.12)];
}

function resetMatch(firstServer) {
  S.score = { '1': 0, '-1': 0 };
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
  const sd = sideOfBot();
  const b = { p: [...S.ball.p], v: [...S.ball.v], w: [...S.ball.w] };
  let bounced = false, x = 0, found = false;
  for (let i = 0; i < 900; i++) {
    const ev = []; stepBall(b, DT, ev, true);
    for (const e of ev) if (e.t === 'table' && e.z * sd > 0) bounced = true;
    if (bounced && b.p[2] * sd >= HL + 0.3) { x = b.p[0]; found = true; break; }
    if (b.p[1] < TH - 0.35) break;
  }
  bot.predX = found ? x + (Math.random() - 0.5) * 0.1 : bot.x;
  bot.react = 0.12 + Math.random() * 0.1;
}

function botHit(serve) {
  const sd = sideOfBot();
  let power = serve ? 0.3 + Math.random() * 0.6 : 0.4 + Math.random() * 0.55;
  let tx = (Math.random() * 2 - 1) * (serve ? 0.45 : 0.58);
  const r = Math.random();
  if (!serve && r < 0.05) power = 2.25 + Math.random() * 0.3;          // erro: bateu forte demais
  else if (!serve && r < 0.09) tx = Math.sign(tx || 1) * (1.25 + Math.random() * 0.2);   // erro: abriu demais
  const B = [...S.ball.p];
  const chop = !serve && Math.random() < 0.12;
  if (chop) power = 0.3 + Math.random() * 0.4;
  const shot = makeShot(sd, B, power, tx, (Math.random() * 2 - 1) * (Math.random() < 0.3 ? 220 : 60), serve, serve ? { rk: oppRacket } : { inW: [...S.ball.w], inSpeed: Math.hypot(...S.ball.v), chop, rk: oppRacket });
  applyHit(sd, B, shot, serve);
  bot.lunge = 0.22;
}

function botStep(dt) {
  const sd = sideOfBot();
  let tx = bot.x * 0.98, depth = HL + 0.35, maxV = 2.3;
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
function physicsStep(dt) {
  if (S.phase === 'lobby' || S.phase === 'over') return;
  S.phaseT += dt;

  if (S.phase === 'serve') {
    if (isAuth(S.server)) { S.ball.p = serveBallPos(); S.ballVisible = true; }
    else { S.ballVisible = !!S.serveBall; if (S.serveBall) S.ball.p = [...S.serveBall]; }
    if (S.server === S.mySide && S.phaseT > 0.45) {
      const bd = S.ball.p[2] * S.mySide, cd = me.z * S.mySide;
      if (me.prevDepth > bd && cd <= bd + 0.02 && Math.abs(me.x - S.ball.p[0]) < 0.29) playerHit(true);
    }
  } else if (S.phase === 'rally' || S.phase === 'point') {
    const ev = [];
    stepBall(S.ball, dt, ev, true);
    for (const e of ev) {
      if (e.t === 'table') { sfx('table', null, [e.x, TH, e.z], e.s / 4.2); fxBounce(e.x, e.z); }
      else if (e.t === 'net') { sfx('net', null, [e.x, e.y, 0], e.graze ? 0.3 + e.s / 30 : e.s / 6); netHit(e); }
      else if (e.t === 'floor' && e.s > 0.25) sfx('floor', null, [e.x, 0, e.z], e.s / 3.5);
    }
    if (S.phase === 'rally') {
      S.rally.t += dt;
      for (const e of ev) evalEvent(e);
      if (S.phase === 'rally' && (S.ball.p[1] < TH - 0.4 || S.rally.t > 6 || Math.abs(S.ball.p[2]) > HL + 3.5)) evalEvent({ t: 'dead' });
      if (canSideHit(S.mySide) && inHitWindow(S.mySide, me)) playerHit(false);
    }
    if (S.phase === 'point' && S.phaseT > 1.0) S.ballVisible = false;
    if (S.phase === 'point' && S.phaseT > 1.35) nextPoint();
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
function genCode() {
  const ch = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 5; i++) s += ch[Math.floor(Math.random() * ch.length)];
  return s;
}
function cleanupNet() {
  try { conn && conn.close(); } catch (e) { }
  try { peer && peer.destroy(); } catch (e) { }
  conn = null; peer = null;
}
function netErrorText(e) {
  const t = e && e.type;
  if (t === 'peer-unavailable') return 'Sala não encontrada. Confira o código (ou peça um link novo).';
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Não consegui falar com o servidor de conexão. Verifique sua internet e tente de novo.';
  if (t === 'browser-incompatible') return 'Seu navegador não suporta WebRTC. Use Chrome, Edge, Safari ou Firefox atualizados.';
  return 'Erro de conexão: ' + (t || e);
}
function createRoom() {
  if (typeof Peer === 'undefined') { lobbyMsg('Não carregou a biblioteca de rede. Recarregue a página.'); return; }
  cleanupNet(); isHost = true;
  const code = genCode();
  showPanel('wait'); $('codeTxt').textContent = '·····'; lobbyMsg('');
  peer = new Peer(PEER_PREFIX + code, { debug: 1 });
  peer.on('open', () => {
    const link = `${location.origin}${location.pathname}?sala=${code}`;
    $('codeTxt').textContent = code;
    $('linkTxt').value = link;
    $('btnWa').href = 'https://wa.me/?text=' + encodeURIComponent('Bora jogar ping pong? 🏓 ' + link);
  });
  peer.on('connection', c => {
    if (conn) { c.on('open', () => c.close()); return; }
    setupConn(c);
  });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') { createRoom(); return; }
    lobbyMsg(netErrorText(e));
  });
  peer.on('disconnected', () => { if (!conn) { try { peer.reconnect(); } catch (e) { } } });
}
function joinRoom(code) {
  if (typeof Peer === 'undefined') { lobbyMsg('Não carregou a biblioteca de rede. Recarregue a página.'); return; }
  code = (code || '').trim().toUpperCase();
  if (code.length < 4) { lobbyMsg('Digite o código da sala.'); return; }
  cleanupNet(); isHost = false;
  showPanel('joining'); $('joinTxt').textContent = `Entrando na sala ${code}…`; lobbyMsg('');
  peer = new Peer({ debug: 1 });
  peer.on('open', () => {
    const c = peer.connect(PEER_PREFIX + code, { reliable: true });
    setupConn(c);
    setTimeout(() => { if (!c.open && S.phase === 'lobby' && conn === c) { lobbyMsg('Não consegui conectar. Pode ser a rede (Wi-Fi corporativo/4G bloqueando). Tente outra rede.'); showPanel('menu'); cleanupNet(); } }, 15000);
  });
  peer.on('error', e => { lobbyMsg(netErrorText(e)); showPanel('menu'); });
}
function setupConn(c) {
  conn = c;
  c.on('open', () => { send({ t: 'hello', rk: myRacket.id }); if (isHost) { send({ t: 'start', arena: A.id }); startGame('online', 1); } });
  c.on('data', onMsg);
  c.on('close', () => onDisconnect());
  c.on('error', () => onDisconnect());
}
function onDisconnect() {
  if (S.mode !== 'online') return;
  goMenu();
  lobbyMsg('A conexão com seu amigo caiu.');
}
function onMsg(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'start': if (m.arena && arenaById(m.arena).id !== A.id) buildArena(m.arena); startGame('online', -1); break;
    case 'hello': if (RACKETS.some(r => r.id === m.rk)) setPaddle('op', racketById(m.rk)); updateHud(); break;
    case 'pad':
      opp.tx = m.x; opp.ty = m.y; opp.tz = m.z;
      S.serveBall = m.b || null;
      break;
    case 'hit': {
      if (S.phase === 'lobby' || S.phase === 'over') return;
      applyHit(m.side, m.p, { v: m.v, w: m.w, label: m.label }, m.serve);
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
      onPoint(m.winner, m.reason);
      break;
    case 'ping': send({ t: 'pong', ts: m.ts }); break;
    case 'pong': {
      const rtt = (performance.now() - m.ts) / 1000;
      S.rtt = S.rtt * 0.7 + rtt * 0.3;
      $('ping').textContent = `ping ${Math.round(S.rtt * 1000)} ms`;
      break;
    }
    case 'rematch': resetMatch(-S.firstServer); break;
    case 'chat': recvChat(m); break;
  }
}
function netTick(now) {
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
// som de cada cenário: quanto eco, tamanho da torcida e ambiente (ondas do mar, cidade)
function applyArenaAudio() {
  if (!actx || !A.def) return;
  const au = A.def.audio, t = actx.currentTime;
  sfxSend.gain.setTargetAtTime(au.rev, t, 0.2);
  crowdSendG.gain.setTargetAtTime(au.rev * 1.8, t, 0.2);
  crowdBus.gain.setTargetAtTime(au.crowd, t, 0.3);
  for (const n of ambNodes) { try { n.stop ? n.stop() : n.disconnect(); } catch (e) { } }
  ambNodes = [];
  if (!au.amb) return;
  const src = actx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass';
  const g = actx.createGain();
  if (au.amb === 'waves') {
    lp.frequency.value = 700; g.gain.value = 0.05;
    const lfo = actx.createOscillator(); lfo.frequency.value = 0.11; const lg = actx.createGain(); lg.gain.value = 0.04;
    lfo.connect(lg).connect(g.gain); lfo.start(); ambNodes.push(lfo);
    const hiss = actx.createBufferSource(); hiss.buffer = noiseBuf; hiss.loop = true; hiss.playbackRate.value = 1.7;
    const hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500; const hg = actx.createGain(); hg.gain.value = 0.012;
    lfo.connect(hg.gain); hiss.connect(hp).connect(hg).connect(ambGain); hiss.start(0, Math.random() * 2); ambNodes.push(hiss);
  } else {
    lp.frequency.value = 260; g.gain.value = 0.06;
  }
  src.connect(lp).connect(g).connect(ambGain); src.start(0, Math.random() * 2); ambNodes.push(src);
}
function boom(v = 0.6) {                       // estouro grave (fogos / pirotecnia)
  if (!actx) return;
  const t = actx.currentTime, src = actx.createBufferSource(); src.buffer = noiseBuf; src.playbackRate.value = 0.5;
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(120, t + 0.6);
  const g = actx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35 * v, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  src.connect(lp).connect(g).connect(crowdBus); src.start(t, Math.random() * 2); src.stop(t + 1);
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
    master = actx.createGain(); master.gain.value = muted ? 0 : 0.9;
    master.connect(comp).connect(actx.destination);
    // reverb de ginásio
    const rev = actx.createConvolver(); rev.buffer = makeIR(1.7);
    const send = actx.createGain(); send.gain.value = 0.28; sfxSend = send;
    const ret = actx.createGain(); ret.gain.value = 0.55;
    sfxBus = actx.createGain();
    sfxBus.connect(master); sfxBus.connect(send).connect(rev).connect(ret).connect(master);
    // sons gravados já têm o ambiente da sala: vão quase secos
    sampleBus = actx.createGain(); sampleBus.gain.value = 1.15;
    const sSend = actx.createGain(); sSend.gain.value = 0.1;
    sampleBus.connect(master); sampleBus.connect(sSend).connect(rev);
    // barramento da torcida (com bastante eco de ginásio)
    crowdBus = actx.createGain(); crowdBus.gain.value = 1;
    const crowdSend = actx.createGain(); crowdSend.gain.value = 0.5; crowdSendG = crowdSend;
    ambGain = actx.createGain(); ambGain.gain.value = 1; ambGain.connect(master);
    crowdBus.connect(master); crowdBus.connect(crowdSend).connect(rev);
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
  } catch (e) { actx = null; }
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
function playImpact(kind, pos, strength, tone) {
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
  if (tone) { src.playbackRate.value *= tone.rate; cutoff *= tone.cut; vol *= tone.vol; }
  lp.frequency.value = Math.min(cutoff, 18000);
  const g = actx.createGain(); g.gain.value = vol;
  src.connect(lp).connect(g);
  const bus = rset ? sampleBus : sfxBus;
  if (actx.createStereoPanner) { const p = actx.createStereoPanner(); p.pan.value = pan; g.connect(p).connect(bus); }
  else g.connect(bus);
  src.start();
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
  o.connect(g).connect(master); o.start(t0); o.stop(t0 + dur + 0.02);
}
function sfx(k, label, pos, s = 0.5, tone) {
  if (!actx) return;
  if (k === 'hit') {
    const smash = label === 'SMASH!';
    playImpact(smash ? 'smash' : 'paddle', pos, s, tone);
    if (s > 0.55) whoosh(pos, s);
  }
  else if (k === 'table') playImpact('table', pos, s);
  else if (k === 'net') playImpact('net', pos, Math.max(0.25, s));
  else if (k === 'floor') playImpact('floor', pos, s * 0.6);
  else if (k === 'win') { tone(660, 0.12, 0.04); tone(990, 0.2, 0.04, 'triangle', 0.1); }
  else if (k === 'lose') { tone(440, 0.14, 0.03); tone(330, 0.2, 0.03, 'triangle', 0.12); }
}
function setMuted(v) {
  muted = v; store.set('pp_mute', v ? '1' : '0');
  if (master) master.gain.value = v ? 0 : 0.9;
  $('btnSound').textContent = v ? '🔇' : '🔊';
}

/* =====================================================================
   EFEITOS
   ===================================================================== */
const cam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50, ox: 0, shake: 0, fovKick: 0, introT: 0, introDur: 1.8, from: new THREE.Vector3(), fromLook: new THREE.Vector3(0, TH, 0) };
let ledFlash = 0, hitFlash = 0;

function fxHit(side, B, label) {
  const c = TRAIL_COLORS[label] || 0x22ff88;
  const smash = label === 'SMASH!';
  sparks.emit(smash ? 42 : 18, B[0], B[1], B[2], c, smash ? 3.2 : 1.6, { life: smash ? 0.5 : 0.35, intensity: 2.5, grav: 2, drag: 3 });
  hitLight.position.set(B[0], B[1] + 0.1, B[2]); hitLight.color.setHex(c); hitFlash = smash ? 1 : 0.55;
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
function showPanel(id) { for (const p of ['menu', 'wait', 'joining']) $(p).classList.toggle('hidden', p !== id); }
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
  const oppName = S.mode === 'solo' ? 'CPU' : 'AMIGO';
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
  const mp = matchPointFor();
  g.font = '800 34px system-ui';
  if (mp && inGame) { g.fillStyle = '#ff2a55'; g.fillText('MATCH POINT', w / 2, 355); }
  else { g.fillStyle = 'rgba(255,255,255,.5)'; g.fillText(`ATÉ ${POINT_TO_WIN} PONTOS`, w / 2, 355); }
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
  $('tag').classList.toggle('show', inGame && matchPointFor() !== 0);
  updateStreak();
  drawJumbo();
}

function showOver() {
  const mine = S.score[String(S.mySide)], theirs = S.score[String(-S.mySide)];
  const won = mine > theirs;
  $('overTitle').textContent = won ? 'Você venceu! 🏆' : (S.mode === 'solo' ? 'O computador venceu' : 'Seu amigo venceu');
  $('overScore').textContent = `${mine} × ${theirs}`;
  if (won) {                                      // vitórias liberam a raquete lendária
    const before = winCount(); store.set('pp_wins', String(before + 1));
    for (const r of RACKETS) if (r.unlock && before < r.unlock && before + 1 >= r.unlock) setTimeout(() => toast(`🐉 Você liberou a raquete ${r.name}!`), 2200);
  }
  const lock = RACKETS.find(r => r.unlock && !isUnlocked(r));
  $('overScore').textContent += lock ? ` · vitórias: ${winCount()}/${lock.unlock} para liberar a ${lock.name}` : '';
  clearTimeout(overTimer); overTimer = setTimeout(() => { if (S.phase === 'over') $('over').classList.remove('hidden'); }, 1400);
  fxWin(won);
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
  const name = who === 'me' ? 'VOCÊ' : who === 'op' ? (S.mode === 'solo' ? 'CPU' : 'AMIGO') : '';
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
  if (isGameOver()) { botSay(3, 1, 1600); if (mine) botSay(3, 2, 3200); return; }
  if (!mine) {                                   // CPU fez o ponto
    if (Math.random() < 0.3) { const r = pick([[1, 3], [2, 0], [2, 3], [1, 0]]); botSay(r[0], r[1]); }
  } else if (winnerShot === 'SMASH!' && Math.random() < 0.5) botSay(0, 3);
  else if (rally >= 8 && Math.random() < 0.5) botSay(pick([0, 1]), pick([0, 1]));
  else if ((reason === 'net' || reason === 'out') && Math.random() < 0.25) botSay(pick([1, 3]), pick([2, 3]));
}
$('qcList').addEventListener('click', e => { const b = e.target.closest('button'); if (b) qcPick(+b.dataset.i); });
$('btnChat').onclick = () => { qc.mode = qc.mode === 'closed' ? 'cats' : 'closed'; qcRender(); };
window.addEventListener('keydown', e => {
  if (S.phase === 'lobby' || e.repeat) return;
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
function startGame(mode, side) {
  S.mode = mode; S.mySide = side;
  me.z = side * (HL + 0.4); me.prevDepth = HL + 0.4;
  opp.x = opp.tx = 0; opp.z = opp.tz = -side * (HL + 0.4);
  bot.x = 0; bot.z = -side * (HL + 0.35);
  $('nameL').textContent = 'VOCÊ';
  $('nameR').textContent = mode === 'solo' ? 'CPU' : 'AMIGO';
  $('ping').textContent = mode === 'solo' ? '' : 'conectado';
  $('lobby').classList.add('hidden');
  $('hud').classList.remove('hidden');
  cam.from.copy(camera.position); cam.fromLook.set(0, TH, 0); cam.introT = cam.introDur;
  resetMatch(1);
  crowd.mySide = side; if (A.crowdView) A.crowdView.setTeams(side);
  crowd.excite = 0.7; crowdReact('start');
  if (mode === 'solo') {                        // a CPU escolhe uma raquete diferente a cada partida
    const pool = RACKETS.filter(r => r.id !== myRacket.id);
    setPaddle('op', pool[(Math.random() * pool.length) | 0]);
    botSay(3, 0, 2600);
  }
  updateHud();
  setTimeout(() => { if (S.mode) addChat('sys', `${A.def.emoji} ${A.def.name} · você: ${myRacket.name} × ${mode === 'solo' ? 'CPU' : 'amigo'}: ${oppRacket.name}`); }, 900);
  if (mode === 'online' && location.search.includes('sala=')) history.replaceState(null, '', location.pathname);
}
function goMenu() {
  const wasOnline = S.mode === 'online';
  S.mode = null; S.phase = 'lobby'; S.ballVisible = false;
  stopRhythm(); qc.mode = 'closed'; qcRender(); $('chatFeed').innerHTML = '';
  if (wasOnline) cleanupNet();
  $('hud').classList.add('hidden'); $('over').classList.add('hidden');
  $('lobby').classList.remove('hidden'); showPanel('menu'); lobbyMsg('');
  if (typeof renderPick === 'function') renderPick();
  updateHud();
}

$('btnCreate').onclick = () => { ensureAudio(); lockedNotice(); createRoom(); };
$('btnJoin').onclick = () => { ensureAudio(); lockedNotice(); joinRoom($('inCode').value); };
$('inCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('inCode').value); });
$('btnSolo').onclick = () => { ensureAudio(); lockedNotice(); cleanupNet(); startGame('solo', 1); };
$('btnCancel').onclick = $('btnCancel2').onclick = () => { cleanupNet(); showPanel('menu'); lobbyMsg(''); };
$('btnCopy').onclick = async () => {
  const v = $('linkTxt').value;
  try { await navigator.clipboard.writeText(v); } catch (e) { $('linkTxt').select(); document.execCommand('copy'); }
  $('btnCopy').textContent = 'Link copiado!'; setTimeout(() => $('btnCopy').textContent = 'Copiar link', 1500);
};
$('btnRematch').onclick = () => { if (S.mode === 'online') send({ t: 'rematch' }); resetMatch(-S.firstServer); };
$('btnMenu').onclick = () => goMenu();
$('quit').onclick = () => goMenu();
$('btnSound').onclick = () => { ensureAudio(); setMuted(!muted); };
$('btnQuality').onclick = () => { perf.checked = true; applyQuality(Q.level === 'alto' ? 'leve' : 'alto'); };
/* =====================================================================
   MENU: escolha da raquete e do cenário
   ===================================================================== */
const pickState = { rk: Math.max(0, RACKETS.indexOf(myRacket)), ar: Math.max(0, ARENAS.findIndex(a => a.id === store.get('pp_arena', 'neon'))) };
const thumbs = {};
function makeThumbs() {                           // miniaturas 3D das raquetes (renderizadas uma vez)
  try {
    const tr = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    tr.setPixelRatio(1); tr.setSize(150, 190, false);
    tr.outputColorSpace = THREE.SRGBColorSpace; tr.toneMapping = THREE.ACESFilmicToneMapping; tr.toneMappingExposure = 1.25;
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight(0xffffff, 0x3a3050, 1.5));
    const d1 = new THREE.DirectionalLight(0xffffff, 2.4); d1.position.set(1.5, 2, 3); sc.add(d1);
    const d2 = new THREE.DirectionalLight(0xff7ab0, 1.0); d2.position.set(-2, 0.5, -1); sc.add(d2);
    const c = new THREE.PerspectiveCamera(30, 150 / 190, 0.01, 10); c.position.set(0, -0.06, 0.8); c.lookAt(0, -0.06, 0);
    for (const r of RACKETS) {
      const { root } = buildRacket(r, true, 1);
      root.rotation.set(0.12, -0.5, -0.3); sc.add(root);
      tr.render(sc, c); thumbs[r.id] = tr.domElement.toDataURL('image/png');
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
  const locked = !isUnlocked(r);
  $('rkCard').classList.toggle('locked', locked);
  $('rkLock').classList.toggle('hidden', !locked);
  if (locked) $('rkLock').textContent = `🔒 ${winCount()}/${r.unlock}`;
  if (locked) $('rkDesc').textContent = `🔒 Vença ${r.unlock} partidas para liberar (você tem ${winCount()}). ` + r.desc;
  $('vipTag').classList.toggle('hidden', !isVip());
  $('rkDots').innerHTML = RACKETS.map((_, i) => `<i class="${i === pickState.rk ? 'on' : ''}"></i>`).join('');
  $('arEmoji').textContent = a.emoji; $('arName').textContent = a.name; $('arTag').textContent = a.tag;
  $('arDots').innerHTML = ARENAS.map((_, i) => `<i class="${i === pickState.ar ? 'on' : ''}"></i>`).join('');
}
function pickMove(k, d) {
  if (k === 'rk') {
    pickState.rk = (pickState.rk + d + RACKETS.length) % RACKETS.length;
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
    <div class="pk-note">No online, vale o cenário de quem cria a sala. Cada um usa a própria raquete.</div>`;
  $('menu').prepend(wrap);
  wrap.addEventListener('click', e => { const b = e.target.closest('.pk-arrow'); if (b) pickMove(b.dataset.k, +b.dataset.d); });
  const how = document.querySelector('.howto');
  if (how) {
    const d = document.createElement('details'); d.className = 'howto';
    d.innerHTML = '<summary>Como jogar</summary>' + how.innerHTML.replace('<b>Como jogar:</b>', '') +
      '<br><b>Raquetes:</b> velocidade deixa a bola mais rápida, efeito aumenta topspin e curva, controle deixa a bola mais certeira. A Muralha não tem efeito, mas devolve o efeito do adversário invertido.';
    how.replaceWith(d);
  }
  renderPick();
  setTimeout(() => { makeThumbs(); renderPick(); }, 60);
}
initLobbyUI();
setMuted(muted);

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
  ballMesh.visible = blob.visible = ballGlow.visible = S.ballVisible;
  if (S.ballVisible) {
    const p = S.ball.p, w = S.ball.w;
    ballMesh.position.set(p[0], p[1], p[2]);
    const wl = Math.hypot(w[0], w[1], w[2]);
    if (wl > 0.1 && S.phase !== 'serve') { _ax.set(w[0] / wl, w[1] / wl, w[2] / wl); _q.setFromAxisAngle(_ax, wl * dt * TIME_SCALE * 0.3); ballMesh.quaternion.premultiply(_q); }
    ballGlow.position.copy(ballMesh.position);
    const sp = Math.hypot(S.ball.v[0], S.ball.v[1], S.ball.v[2]);
    const gs = 0.1 + Math.min(sp, 14) * 0.006;
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

  // animações do ambiente
  ledFlash = Math.max(0, ledFlash - dt * 1.2);
  jumboMat.emissiveIntensity = 1.0 + ledFlash * 0.5;
  hitFlash = Math.max(0, hitFlash - dt * 5);
  hitLight.intensity = hitFlash * 3;
  rimSpots.forEach((s, i) => { s.intensity = A.rimBase + Math.sin(t * 0.8 + i * 1.7) * A.rimPulse + ledFlash * A.rimFlash; });
  updateArena(t, dt);
  updateDust(t, dt);
  sparks.update(dt); confetti.update(dt); pyro.update(dt);
  updateRings(dt);
  updateNet(dt * TIME_SCALE);

  composer.render(dt);
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
  if (S.phase === 'lobby') {
    const a = now / 11000;
    camera.position.set(Math.sin(a) * 5.2, 2.6 + Math.sin(a * 2) * 0.4, Math.cos(a) * 5.2);
    camera.lookAt(0, TH, 0);
    camera.fov = 50; camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  } else {
    updateCamera(dt, now);
    updateMyPaddle(dt);
    perfMonitor(rawDt);
  }
  acc += dt * TIME_SCALE;
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
if (roomParam) { $('inCode').value = roomParam.toUpperCase(); joinRoom(roomParam); }

window.__pp = { thumbs, RACKETS, setPaddle, get myRacket() { return myRacket; }, get oppRacket() { return oppRacket; }, pickMove, S, me, bot, opp, camera, cam, get myPaddleMesh() { return myPaddleMesh; }, get oppPaddleMesh() { return oppPaddleMesh; }, netHit, net, buildArena, ARENAS, A, crowd, crowdEvent, pyroBurst, fireworks, scene, perf, sendChat, qc, crowdReact, makeShot, simFlight, stepBall, startGame, onMsg, THREE, applyQuality, audio: () => ({ ctx: !!actx, kinds: Object.keys(IMP), samples: Object.fromEntries(Object.entries(SAMPLES).map(([k, v]) => [k, v.length])), playImpact, ensureAudio }) };
