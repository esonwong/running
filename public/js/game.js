// game.js —— 第一人称无限走廊 · 梦核风格 · 体感驱动
import * as THREE from "three";
import { PoseController } from "./pose.js";
import { Sound } from "./audio.js";

// ---------------- 常量 ----------------
const SEG = 8;        // 单段走廊长度
const NUM_SEG = 16;   // 同时存在的段数（配合雾气营造无限感）
const HALF_W = 3;     // 走廊半宽
const HEIGHT = 4;     // 走廊高
const BASE_Y = 1.6;   // 站立视线高度
const SQUAT_Y = 0.95; // 蹲下视线高度
const STRAFE_X = 2.2; // 最大左右位移
const JUMP_V0 = 5.6;  // 起跳初速度（越大跳越高）
const JUMP_G = 9;     // 重力（越小滞空越久）→ 跳跃作用时间更长
const JUMPCAL_MS = 3500; // 跳跃校准时长
const PUNCHCAL_MS = 3500; // 出拳校准时长

// ---------------- 全局 ----------------
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x1a1608, 0.045); // 暖黄雾，吞没走廊尽头

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, BASE_Y, 0);
camera.rotation.order = "YXZ";

// 灯光：低环境 + 跟随相机的点光（梦核惨白荧光感）
scene.add(new THREE.HemisphereLight(0xfff2c0, 0x1a160a, 0.55));
const followLight = new THREE.PointLight(0xfff4d0, 1.1, 26, 1.4);
scene.add(followLight);

// ---------------- 程序化贴图 ----------------
function tex(draw, rx = 1, ry = 1) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  draw(c.getContext("2d"));
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  return t;
}
const carpetTex = tex((g) => {
  g.fillStyle = "#3a1f24"; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1600; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * .25})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  g.strokeStyle = "rgba(120,70,80,.4)"; g.lineWidth = 2;
  for (let x = 0; x <= 256; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke(); }
}, 2, 4);
const wallTex = tex((g) => {
  g.fillStyle = "#b9a86a"; g.fillRect(0, 0, 256, 256);
  for (let x = 0; x < 256; x += 8) { g.fillStyle = `rgba(150,135,80,${.15 + Math.random() * .1})`; g.fillRect(x, 0, 4, 256); }
  const grime = g.createRadialGradient(128, 128, 30, 128, 128, 180);
  grime.addColorStop(0, "rgba(0,0,0,0)"); grime.addColorStop(1, "rgba(40,30,10,.45)");
  g.fillStyle = grime; g.fillRect(0, 0, 256, 256);
}, 2, 1);
const ceilTex = tex((g) => {
  g.fillStyle = "#c9c6ba"; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "rgba(90,90,80,.5)"; g.lineWidth = 3;
  for (let i = 0; i <= 256; i += 64) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
  }
}, 2, 2);

const floorMat = new THREE.MeshStandardMaterial({ map: carpetTex, roughness: 1 });
const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: .95 });
const ceilMat = new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 1 });
const panelMat = new THREE.MeshStandardMaterial({ color: 0xfffbe0, emissive: 0xfff6c0, emissiveIntensity: 1.4 });

const planeGeo = new THREE.PlaneGeometry(1, 1);
function plane(mat, w, h) { const m = new THREE.Mesh(planeGeo, mat); m.scale.set(w, h, 1); return m; }

// ---------------- 走廊段 ----------------
const segments = [];
function buildSegment(z) {
  const g = new THREE.Group();
  g.position.z = z;

  const floor = plane(floorMat, HALF_W * 2, SEG); floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0, -SEG / 2); g.add(floor);
  const ceil = plane(ceilMat, HALF_W * 2, SEG); ceil.rotation.x = Math.PI / 2; ceil.position.set(0, HEIGHT, -SEG / 2); g.add(ceil);
  const lw = plane(wallMat, SEG, HEIGHT); lw.rotation.y = Math.PI / 2; lw.position.set(-HALF_W, HEIGHT / 2, -SEG / 2); g.add(lw);
  const rw = plane(wallMat, SEG, HEIGHT); rw.rotation.y = -Math.PI / 2; rw.position.set(HALF_W, HEIGHT / 2, -SEG / 2); g.add(rw);

  // 两块荧光灯板
  for (const pz of [-SEG * 0.25, -SEG * 0.75]) {
    const p = plane(panelMat, 1.4, 2.6); p.rotation.x = Math.PI / 2;
    p.position.set(0, HEIGHT - 0.02, pz); g.add(p);
    p.userData.baseEmissive = 1.4;
  }

  g.userData.obstacle = null;
  scene.add(g);
  segments.push(g);
  return g;
}

// ---------------- 障碍 ----------------
const OB = {
  JUMP: "jump", DUCK: "duck", LEFT: "left", RIGHT: "right", PUNCH: "punch",
};
const obGeo = new THREE.BoxGeometry(1, 1, 1);
function mkBox(color, emissive) {
  return new THREE.Mesh(obGeo, new THREE.MeshStandardMaterial({
    color, emissive, emissiveIntensity: .9, roughness: .6,
  }));
}

function spawnObstacle(seg, type) {
  clearObstacle(seg);
  const localZ = -SEG / 2;
  let mesh, data;
  switch (type) {
    case OB.JUMP: {
      mesh = mkBox(0x2a2a2a, 0xc8ff64);
      mesh.scale.set(HALF_W * 2 - 0.2, 0.7, 0.4);
      mesh.position.set(0, 0.35, localZ);
      data = { type, passCheck: () => camera.position.y > BASE_Y + 0.35 };
      break;
    }
    case OB.DUCK: {
      mesh = mkBox(0x2a2a2a, 0xff5cc8);
      const topH = HEIGHT - 1.35;
      mesh.scale.set(HALF_W * 2 - 0.2, topH, 0.4);
      mesh.position.set(0, HEIGHT - topH / 2, localZ);
      data = { type, passCheck: () => camera.position.y < BASE_Y - 0.35 };
      break;
    }
    case OB.LEFT:
    case OB.RIGHT: {
      // 堵住一侧，要求侧移到另一侧
      const blockLeft = type === OB.LEFT;
      mesh = mkBox(0x2a2a2a, 0x64c8ff);
      mesh.scale.set(HALF_W - 0.2, HEIGHT - 0.2, 0.4);
      mesh.position.set(blockLeft ? -HALF_W / 2 : HALF_W / 2, HEIGHT / 2, localZ);
      data = { type, passCheck: () => blockLeft ? camera.position.x > 0.7 : camera.position.x < -0.7 };
      break;
    }
    case OB.PUNCH: {
      mesh = mkBox(0x5a2a3a, 0xff8855);
      mesh.scale.set(HALF_W * 2 - 0.2, 1.6, 0.25);
      mesh.position.set(0, 1.4, localZ);
      data = { type, passCheck: () => (performance.now() - lastPunch) < 450 };
      break;
    }
  }
  seg.add(mesh);
  seg.userData.obstacle = { mesh, evaluated: false, broken: false, ...data };
}
function clearObstacle(seg) {
  const o = seg.userData.obstacle;
  if (o) { seg.remove(o.mesh); o.mesh.geometry.dispose?.(); o.mesh.material.dispose?.(); }
  seg.userData.obstacle = null;
}

const OB_TYPES = [OB.JUMP, OB.DUCK, OB.LEFT, OB.RIGHT, OB.PUNCH];
let spawnTick = 0;
function maybeSpawn(seg) {
  // 间隔放置障碍，距离越远稍密
  spawnTick++;
  const density = Math.min(0.85, 0.45 + distance / 1500);
  if (Math.random() < density && spawnTick > 1) {
    spawnTick = 0;
    spawnObstacle(seg, OB_TYPES[(Math.random() * OB_TYPES.length) | 0]);
  } else {
    clearObstacle(seg);
  }
}

// ---------------- 状态 ----------------
let pose;
let running = false;
let awaitingRestart = false; // 结束界面，等待重开
let distance = 0;
let health = 3;
let speed = 7;
let jumpVel = 0;
let lastPunch = -9999;
let invuln = 0;
let poseOk = false;
let wasSquatting = false; // 下蹲边沿检测（触发音效）
let screenShake = 0;      // 震屏强度
const clock = new THREE.Clock();

// 键盘备选（体感不可用时仍能玩；也方便调试）
const keys = {};
let kbJump = false, kbPunch = false;
addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (e.code === "Space" || e.code === "ArrowUp") kbJump = true;
  if (e.code === "KeyF" || e.code === "Enter") kbPunch = true;
  if (awaitingRestart && (e.code === "Space" || e.code === "Enter")) restart();
});
addEventListener("keyup", (e) => { keys[e.code] = false; });

// 初始化走廊
for (let i = 0; i < NUM_SEG; i++) buildSegment(-i * SEG);

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const overlay = $("overlay"), cue = $("cue");
function setHUD() {
  $("distance").textContent = Math.floor(distance);
  $("health").textContent = "♥".repeat(health) + "♡".repeat(Math.max(0, 3 - health));
  $("action").textContent = pose ? pose.label : "—";
}
function flashCue(text, color = "#c8ff64") {
  cue.textContent = text; cue.style.color = color;
  cue.style.textShadow = `0 0 20px ${color}`;
  cue.classList.add("show");
  clearTimeout(flashCue._t);
  flashCue._t = setTimeout(() => cue.classList.remove("show"), 380);
}

// ---------------- 出拳 / 跳 处理 ----------------
function handleActions(dt) {
  // 跳：体感脉冲 或 键盘
  let jumpPulse = pose ? pose.consumeJump() : false;
  if (kbJump) { jumpPulse = true; kbJump = false; }
  if (jumpPulse && camera.position.y <= BASE_Y + 0.01) {
    jumpVel = JUMP_V0;
    flashCue("跳", "#c8ff64");
    Sound.jump();
  }
  // 出拳：体感脉冲 或 键盘
  let punchPulse = pose ? pose.consumePunch() : false;
  if (kbPunch) { punchPulse = true; kbPunch = false; }
  if (punchPulse) {
    lastPunch = performance.now();
    Sound.punch();
    if (!tryPunchBreak()) flashCue("击", "#ff8855"); // 击中前方障碍则由 breakObstacle 显示"碎!"
  }
  // 跳跃物理（重力更小 → 滞空更久）
  if (jumpVel !== 0 || camera.position.y > BASE_Y) {
    jumpVel -= JUMP_G * dt;
    camera.position.y += jumpVel * dt;
    if (camera.position.y <= BASE_Y) { camera.position.y = BASE_Y; jumpVel = 0; }
  }
  // 下蹲（体感 或 键盘，不在空中时）
  const squatting = (pose && pose.isSquatting) || keys["ArrowDown"] || keys["KeyS"];
  if (squatting && !wasSquatting) Sound.squat();
  wasSquatting = squatting;
  const squatTarget = squatting ? SQUAT_Y : BASE_Y;
  if (camera.position.y <= BASE_Y + 0.01 && jumpVel === 0) {
    camera.position.y += (squatTarget - camera.position.y) * Math.min(1, dt * 12);
  }
  // 左右：体感 或 键盘
  let lean = pose ? (pose.lean || 0) : 0;
  if (keys["ArrowLeft"] || keys["KeyA"]) lean = -1;
  if (keys["ArrowRight"] || keys["KeyD"]) lean = 1;
  const targetX = lean * STRAFE_X;
  camera.position.x += (targetX - camera.position.x) * Math.min(1, dt * 8);
  // 轻微头部摇晃，增加梦核眩晕感
  camera.rotation.z = Math.sin(distance * 0.5) * 0.012;
  camera.rotation.y = -camera.position.x * 0.04;
}

// ---------------- 碰撞 / 障碍判定 ----------------
function checkObstacles() {
  for (const seg of segments) {
    const o = seg.userData.obstacle;
    if (!o || o.evaluated) continue;
    const worldZ = seg.position.z + o.mesh.position.z;
    // 玩家在 z=0，向 -z 前进；障碍 worldZ 从负向 0 靠近
    if (worldZ >= camera.position.z - 0.3) {
      o.evaluated = true;
      if (o.passCheck()) {
        if (o.type === OB.PUNCH) breakObstacle(o);
      } else {
        hit();
      }
    }
  }
}
// 出拳：立即击碎前方一定范围内最近的可击障碍（不必卡在经过的瞬间）
const PUNCH_RANGE = 26; // 出拳可击碎的前方距离
function tryPunchBreak() {
  let best = null, bestAhead = Infinity;
  for (const seg of segments) {
    const o = seg.userData.obstacle;
    if (!o || o.type !== OB.PUNCH || o.evaluated || o.broken) continue;
    const wz = seg.position.z + o.mesh.position.z;
    const ahead = camera.position.z - wz; // >0 = 在前方
    if (ahead > -1.5 && ahead < PUNCH_RANGE && ahead < bestAhead) {
      bestAhead = ahead; best = o;
    }
  }
  if (best) { best.evaluated = true; breakObstacle(best); return true; }
  return false;
}

// 碎片 + 震屏，强化打击感
const fragGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
const fragments = [];
const _wp = new THREE.Vector3();
function breakObstacle(o) {
  o.broken = true;
  o.mesh.getWorldPosition(_wp);
  o.mesh.visible = false;
  const baseColor = o.mesh.material.color.getHex();
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Mesh(
      fragGeo,
      new THREE.MeshStandardMaterial({ color: baseColor, emissive: 0xff8855, emissiveIntensity: 1.3, transparent: true })
    );
    m.position.set(_wp.x + (Math.random() - 0.5) * 2, _wp.y + (Math.random() - 0.5) * 1.6, _wp.z);
    m.scale.setScalar(0.5 + Math.random());
    scene.add(m);
    fragments.push({
      mesh: m, life: 0.75, max: 0.75,
      v: new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() * 5) + 2, (Math.random()) * 6 + 1),
      rot: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12),
    });
  }
  screenShake = Math.max(screenShake, 0.45);
  Sound.shatter();
  flashCue("碎!", "#ff8855");
}
function updateFragments(dt) {
  for (let i = fragments.length - 1; i >= 0; i--) {
    const f = fragments[i];
    f.life -= dt;
    if (f.life <= 0) { scene.remove(f.mesh); f.mesh.material.dispose(); fragments.splice(i, 1); continue; }
    f.v.y -= 20 * dt;
    f.mesh.position.addScaledVector(f.v, dt);
    f.mesh.rotation.x += f.rot.x * dt;
    f.mesh.rotation.y += f.rot.y * dt;
    f.mesh.material.opacity = Math.max(0, f.life / f.max);
  }
}
function hit() {
  if (invuln > 0) return;
  invuln = 1.0;
  health--;
  speed = Math.max(5, speed - 1.5);
  canvas.classList.remove("hurt"); void canvas.offsetWidth; canvas.classList.add("hurt");
  flashCue("✕", "#ff3b3b");
  screenShake = Math.max(screenShake, 0.6);
  Sound.hit();
  if (health <= 0) gameOver();
}

// ---------------- 段回收 ----------------
function recycleSegments() {
  for (const seg of segments) {
    // 玩家越过该段（段整体在相机身后）→ 移到最远端
    if (seg.position.z > camera.position.z + SEG) {
      const minZ = Math.min(...segments.map((s) => s.position.z));
      seg.position.z = minZ - SEG;
      maybeSpawn(seg);
    }
  }
}

// ---------------- 灯光闪烁（梦核） ----------------
function flickerLights() {
  for (const seg of segments) {
    seg.children.forEach((ch) => {
      if (ch.userData.baseEmissive !== undefined && Math.random() < 0.012) {
        ch.material.emissiveIntensity = ch.material.emissiveIntensity > 0.3
          ? 0.15 : ch.userData.baseEmissive;
      }
    });
  }
}

// ---------------- 主循环 ----------------
let fpsT = 0, fpsN = 0, fpsShown = 0;
let poseMs = 0, renderMs = 0, lastFrameTs = 0, frameMs = 0;
let debugOn = false; // 默认隐藏调试面板（按 D 开关）
addEventListener("keydown", (e) => {
  if (e.code === "KeyD") debugOn = !debugOn;
  if (e.code === "KeyM") { const m = Sound.toggleMute(); flashCue(m ? "🔇" : "🔊", "#e8d27a"); }
});

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  frameMs = lastFrameTs ? now - lastFrameTs : 16;
  lastFrameTs = now;
  const dt = Math.min(0.05, clock.getDelta());

  if (pose) {
    const t0 = performance.now();
    pose.update(now);
    poseMs = performance.now() - t0;
  }

  // 结束界面：举起双手 体感重开
  if (awaitingRestart && pose && pose.tracked && pose.handsUp) restart();

  if (running) {
    speed = Math.min(15, speed + dt * 0.25);
    distance += speed * dt;
    camera.position.z -= speed * dt;
    if (invuln > 0) invuln -= dt;

    handleActions(dt);
    recycleSegments();
    checkObstacles();
    flickerLights();
  }

  updateFragments(dt);
  followLight.position.set(camera.position.x, HEIGHT - 0.5, camera.position.z - 2);

  // 震屏：仅在渲染这一帧叠加偏移，渲染后立刻还原，避免位移漂移
  let sx = 0, sy = 0, sz = 0;
  if (screenShake > 0.001) {
    sx = (Math.random() - 0.5) * screenShake;
    sy = (Math.random() - 0.5) * screenShake;
    sz = (Math.random() - 0.5) * screenShake * 0.08;
    camera.position.x += sx; camera.position.y += sy; camera.rotation.z += sz;
    screenShake = Math.max(0, screenShake - dt * 2.2);
  }
  const tr = performance.now();
  renderer.render(scene, camera);
  renderMs = performance.now() - tr;
  camera.position.x -= sx; camera.position.y -= sy; camera.rotation.z -= sz;

  // FPS / HUD
  fpsN++; fpsT += dt;
  if (fpsT >= 0.5) { fpsShown = Math.round(fpsN / fpsT); $("fps").textContent = fpsShown; fpsN = 0; fpsT = 0; }
  setHUD();
  updateDebug();
}

function updateDebug() {
  const el = $("debug");
  if (!debugOn) { el.style.display = "none"; return; }
  el.style.display = "block";
  const v = pose ? pose.video : null;
  const slow = (poseMs > 40 || frameMs > 50);
  const lines = [
    `FPS ${fpsShown}   帧间隔 ${frameMs.toFixed(1)}ms` + (frameMs > 50 ? "  ⚠卡顿" : ""),
    `渲染 ${renderMs.toFixed(1)}ms   推理 ${poseMs.toFixed(1)}ms` + (poseMs > 40 ? "  ⚠慢" : ""),
    `running=${running}  poseOk=${poseOk}`,
    pose ? `委派=${pose.delegate}  推理次数=${pose.detectCount}  跳帧=${pose.skippedSameFrame}` : `体感=未启用(键盘)`,
    pose && pose.errorCount ? `❌推理报错x${pose.errorCount}: ${pose.lastError}` : "",
    v ? `视频 ${v.videoWidth}x${v.videoHeight} ready=${v.readyState} paused=${v.paused} t=${v.currentTime.toFixed(2)}` : "",
    pose ? `追踪=${pose.tracked}  动作=${pose.label}  基线Y=${pose.baseY === null ? "未校准" : pose.baseY.toFixed(3)}` : "",
    pose ? `lean=${(pose.lean || 0).toFixed(2)}  蹲=${pose.isSquatting}  垂直Δ=${(pose.dVert || 0).toFixed(3)} (跳阈${(pose.jumpThresh || 0.05).toFixed(2)} 蹲阈0.04)` : "",
    pose ? `出拳速Δ=${(pose.dPunch || 0).toFixed(3)}  拳阈=${(pose.punchThresh || 0.06).toFixed(2)}` : "",
    `相机 x=${camera.position.x.toFixed(2)} y=${camera.position.y.toFixed(2)} z=${camera.position.z.toFixed(1)}`,
    `[D]隐藏面板  键盘:←→ 空格跳 ↓蹲 F拳`,
  ].filter(Boolean);
  el.innerHTML = lines.map((l, i) =>
    (l.startsWith("❌") || (i <= 1 && slow)) ? `<span class="warn">${l}</span>` : l
  ).join("\n");
}

// ---------------- 流程控制 ----------------
function loadIndeterminate(text) {
  $("load-text").textContent = text;
  $("load-hint").style.display = "block";
  $("load-pct").style.display = "none";
  const b = $("progress-bar");
  b.classList.add("indet"); b.style.width = "";
  $("loading").classList.remove("hidden");
}
function loadProgress(pct) {
  const b = $("progress-bar");
  b.classList.remove("indet");
  b.style.width = pct + "%";
  $("load-pct").textContent = Math.round(pct) + "%";
}

const HOLD_SEC = 3; // 必须站稳保持的秒数
async function start() {
  $("start-btn").disabled = true;
  Sound.init(); // 在用户点击手势内解锁音频
  overlay.classList.add("hidden"); // 立刻收起开始界面，进度条独占屏幕
  loadIndeterminate("正在加载体感运行时…");
  // 模型下载进度回调：有总大小就显示真实百分比，下完才进入下一步
  const onModelProgress = (pct, recv, total) => {
    if (pct == null) { loadIndeterminate("正在下载体感模型…"); return; }
    $("load-text").textContent = pct >= 1 ? "模型下载完成，正在初始化…" : "正在下载体感模型…";
    $("load-pct").style.display = "block";
    $("load-hint").style.display = "block";
    loadProgress(pct * 100);
    $("load-hint").textContent =
      `${(recv / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
  };
  try {
    pose = new PoseController($("cam"), $("skeleton"));
    window.__pose = pose; // 便于调试
    // 超时保护：60 秒（含模型下载+摄像头授权）未就绪就退回键盘
    await Promise.race([
      pose.init(onModelProgress),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 60000)),
    ]);
    poseOk = true;
  } catch (e) {
    // 体感失败不阻断游戏：退回键盘控制
    window.__initErr = (e && e.message ? e.message : String(e));
    console.warn("体感初始化失败/超时，改用键盘控制：", e);
    pose = null;
    $("cam-label").textContent = "体感不可用·键盘控制";
    flashCue("体感不可用，用方向键 ← →，空格跳，↓蹲，F拳", "#ff8855");
  }

  // 校准阶段：必须站稳保持 HOLD_SEC 秒，进度才会涨满；一动就回退
  if (poseOk) {
    pose.startCalibration();
    $("load-hint").style.display = "block";
    $("load-pct").style.display = "block";
    let held = 0, last = performance.now();
    await new Promise((resolve) => {
      (function tick() {
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000); last = now;
        // 站稳才累积；没站稳/丢追踪则较快回退
        if (pose.tracked && pose.still) held += dt;
        else held = Math.max(0, held - dt * 1.5);
        loadProgress(Math.min(100, (held / HOLD_SEC) * 100));

        if (!pose.tracked) {
          $("load-text").textContent = "请站到摄像头画面中";
          $("load-hint").textContent = "需要拍到上半身和手臂";
        } else if (!pose.still) {
          $("load-text").textContent = "请站稳，别动";
          $("load-hint").textContent = "保持自然站姿不动";
        } else {
          $("load-text").textContent = `保持住… ${Math.max(0, HOLD_SEC - held).toFixed(1)}s`;
          $("load-hint").textContent = "正在记录站立基准";
        }

        if (held >= HOLD_SEC) { pose.finalizeCalibration(); resolve(); }
        else requestAnimationFrame(tick);
      })();
    });

    // 跳跃校准：原地跳，按你的实际起跳幅度设定个性化阈值
    $("load-text").textContent = "原地跳一下！";
    $("load-hint").textContent = "用你平时的力度起跳";
    $("load-pct").style.display = "none";
    let jpeak = 0; const jt0 = performance.now();
    await new Promise((resolve) => {
      (function tick() {
        const el = performance.now() - jt0;
        if (pose.tracked) jpeak = Math.max(jpeak, pose.dUp || 0);
        loadProgress(Math.min(100, (el / JUMPCAL_MS) * 100));
        $("load-hint").textContent = jpeak > 0.05 ? `已记录起跳 ${jpeak.toFixed(2)} ✓` : "用你平时的力度起跳";
        if (el >= JUMPCAL_MS) resolve();
        else requestAnimationFrame(tick);
      })();
    });
    if (jpeak > 0.05) pose.jumpThresh = Math.min(0.12, Math.max(0.04, jpeak * 0.5));
    pose._jumpQueued = false; // 清除校准期间的误触发

    // 出拳校准：向前打拳，按你的实际前冲速度设定个性化阈值
    $("load-text").textContent = "向前出拳！";
    $("load-hint").textContent = "用力向前打几拳";
    let ppeak = 0; const pt0 = performance.now();
    await new Promise((resolve) => {
      (function tick() {
        const el = performance.now() - pt0;
        if (pose.tracked) ppeak = Math.max(ppeak, pose.dPunch || 0);
        loadProgress(Math.min(100, (el / PUNCHCAL_MS) * 100));
        $("load-hint").textContent = ppeak > 0.05 ? `已记录出拳 ${ppeak.toFixed(2)} ✓` : "用力向前打几拳";
        if (el >= PUNCHCAL_MS) resolve();
        else requestAnimationFrame(tick);
      })();
    });
    if (ppeak > 0.05) pose.punchThresh = Math.min(0.2, Math.max(0.04, ppeak * 0.5));
    pose._punchQueued = false; // 清除校准期间的误触发
  }
  $("loading").classList.add("hidden");

  Sound.go();
  Sound.startMusic();
  running = true;
  flashCue("出发！", "#c8ff64");
}

function gameOver() {
  running = false;
  awaitingRestart = true;
  Sound.gameover();
  overlay.classList.remove("hidden");
  $("ov-title").textContent = "终 点 不 存 在";
  $("ov-sub").textContent = `你跑了 ${Math.floor(distance)} 米`
    + (pose ? "　·　举起双手 重新开始" : "");
  $("ov-howto").classList.add("hidden");
  $("ov-note").classList.add("hidden");
  const btn = $("start-btn");
  btn.textContent = "再 来 一 次"; btn.disabled = false;
  btn.onclick = restart;
}

// 原地重开：复用已开启的摄像头与体感，不刷新、不再申请权限
function restart() {
  if (!awaitingRestart) return;
  awaitingRestart = false;
  distance = 0; health = 3; speed = 7; jumpVel = 0; invuln = 0; lastPunch = -9999;
  camera.position.set(0, BASE_Y, 0);
  resetSegments();
  overlay.classList.add("hidden");
  running = true;
  flashCue("出发！", "#c8ff64");
}
function resetSegments() {
  for (let i = 0; i < segments.length; i++) {
    segments[i].position.z = -i * SEG;
    clearObstacle(segments[i]);
  }
  spawnTick = 0;
}

$("start-btn").onclick = start;
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

loop();
