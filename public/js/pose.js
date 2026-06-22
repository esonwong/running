// pose.js —— 摄像头体感识别：跳跃 / 下蹲 / 左右 / 出拳
// 基于 MediaPipe Tasks Vision PoseLandmarker（浏览器端实时骨骼追踪）

import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12";

// 关键点索引（MediaPipe Pose 33 点）
const NOSE = 0;
const L_SHOULDER = 11, R_SHOULDER = 12;
const L_ELBOW = 13, R_ELBOW = 14;
const L_WRIST = 15, R_WRIST = 16;
const L_HIP = 23, R_HIP = 24;

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// 可调阈值（不同身高/摄像头可微调）
const TH = {
  jump:   0.050,  // 身体重心上移（归一化）超过该值 → 跳
  squat:  0.040,  // 身体重心下移超过该值 → 进入蹲
  squatExit: 0.025, // 回升到该值以下 → 退出蹲（滞回防抖）
  punchZ: 0.060,  // 手腕向摄像头方向（世界坐标 z）单帧位移 → 出拳
  leanScale: 2.4, // 侧移灵敏度
  smooth: 0.4,    // 关键点平滑
};

export class PoseController {
  constructor(video, skeletonCanvas) {
    this.video = video;
    this.skCanvas = skeletonCanvas;
    this.skCtx = skeletonCanvas.getContext("2d");
    this.landmarker = null;

    // 调试信息
    this.delegate = "?";       // 实际使用的委派 GPU / CPU
    this.lastInferMs = 0;      // 单次推理耗时
    this.detectCount = 0;      // 推理次数
    this.skippedSameFrame = 0; // 因视频帧未更新而跳过的次数
    this.lastError = "";       // detectForVideo 抛出的错误
    this.errorCount = 0;

    // 校准基线
    this.baseY = null;
    this.baseShoulderSpan = null;
    this._calBuf = [];   // 校准滚动样本
    this.still = false;  // 当前是否站稳不动
    this.calMove = 0;    // 当前抖动量

    // 实时状态（游戏读取）
    this.lean = 0;          // -1 左 ~ +1 右
    this.isSquatting = false;
    this.handsUp = false; // 双手举过头顶（用于结束后体感重开）
    this.jumpThresh = TH.jump; // 跳跃阈值，可被跳跃校准覆盖
    this.dUp = 0;             // 当前重心上移量（正=向上）
    // 出拳：基于手臂伸展度（肩-肘-腕 2D），比深度 z 稳
    this.punchExtHigh = 0.85; // 伸展度超过此值=手臂基本伸直（可被校准覆盖）
    this.punchExtLow = 0.72;  // 低于此值=手臂收回（可再次出拳）
    this.dPunch = 0;          // 当前最大手臂伸展度（0.5 弯 ~ 1.0 直），用于校准/调试
    this._armState = { L: "bent", R: "bent" };
    this._lastBent = { L: 0, R: 0 };
    this._lastPunchTs = 0;
    this.punchCooldown = 450; // ms，两拳最小间隔，防连发误触
    this.tracked = false;
    this.label = "—";

    // 一次性脉冲（用 consume 读取）
    this._jumpQueued = false;
    this._punchQueued = false;
    this._airborne = false; // 防止一次跳重复触发

    // 出拳速度追踪
    this._prevWristZ = { L: null, R: null };

    this._lastVideoTime = -1;
    this._smoothLm = null;
    this._lastInferTs = 0;
    this._lastTs = 0; // VIDEO 模式单调时间戳
    this.inferInterval = 45; // ms，约 22Hz 推理；渲染仍 60fps
    this.notReady = true;
  }

  // 带进度地下载模型（onProgress(pct0to1, receivedBytes, totalBytes)；pct 为 null 表示拿不到总大小）
  async _fetchModel(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("模型下载失败 HTTP " + res.status);
    const total = Number(res.headers.get("content-length")) || 0;
    if (!res.body || !res.body.getReader) {
      // 不支持流式：直接整块下载
      const buf = new Uint8Array(await res.arrayBuffer());
      onProgress && onProgress(1, buf.length, buf.length);
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress && onProgress(total ? received / total : null, received, total);
    }
    const buf = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    onProgress && onProgress(1, received, total || received);
    return buf;
  }

  async init(onProgress) {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm"
    );
    // 自己下载模型 → 拿到真实进度，再用 modelAssetBuffer 交给 MediaPipe
    const modelBuf = await this._fetchModel(
      "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      onProgress
    );
    // VIDEO 模式：利用帧间跟踪，更快更稳（实时游戏首选）。
    // 之前的崩溃根因是"摄像头未就绪时喂了 0×0 帧"永久毒化计算图，
    // 已由 update() 里的就绪保护解决，与运行模式/委派无关。
    // 每次尝试用一份独立拷贝（buffer 创建后会被 wasm 接管/转移）。
    const make = (delegate) =>
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetBuffer: modelBuf.slice(), delegate },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    // 优先 GPU（更快），失败再回退 CPU。
    try {
      this.landmarker = await make("GPU");
      this.delegate = "GPU";
    } catch (e) {
      console.warn("GPU 委派失败，回退 CPU", e);
      this.landmarker = await make("CPU");
      this.delegate = "CPU";
    }

    // 打开摄像头
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();
    this.skCanvas.width = this.video.videoWidth || 640;
    this.skCanvas.height = this.video.videoHeight || 480;
  }

  // 开始校准：重置基线，等待"站稳保持"
  startCalibration() {
    this.baseY = null;
    this._calBuf = [];
    this.still = false;
  }

  // 由游戏在"站稳保持满 N 秒"后调用，用滚动样本定稿基线
  finalizeCalibration() {
    if (!this._calBuf.length) return false;
    const n = this._calBuf.length;
    this.baseY = this._calBuf.reduce((s, v) => s + v.cy, 0) / n;
    this.baseShoulderSpan = this._calBuf.reduce((s, v) => s + v.shoulderSpan, 0) / n;
    return true;
  }

  consumeJump() { const j = this._jumpQueued; this._jumpQueued = false; return j; }
  consumePunch() { const p = this._punchQueued; this._punchQueued = false; return p; }

  // 每帧调用，传入 performance.now()
  update(nowMs) {
    if (!this.landmarker) return;
    // 关键：摄像头未就绪（0×0 帧）会永久毒化 MediaPipe 计算图，绝不能 detect
    if (this.video.readyState < 2 || !this.video.videoWidth || !this.video.videoHeight) {
      this.notReady = true; this.label = "摄像头未就绪"; return;
    }
    this.notReady = false;
    // 降频：两次推理至少间隔 inferInterval，避免 CPU 推理拖慢渲染
    if (nowMs - this._lastInferTs < this.inferInterval) return;
    if (this.video.currentTime === this._lastVideoTime) { this.skippedSameFrame++; return; }
    this._lastVideoTime = this.video.currentTime;
    this._lastInferTs = nowMs;

    const t0 = performance.now();
    let res;
    try {
      // VIDEO 模式需要单调递增的整数时间戳
      let ts = Math.round(nowMs);
      if (ts <= this._lastTs) ts = this._lastTs + 1;
      this._lastTs = ts;
      res = this.landmarker.detectForVideo(this.video, ts);
    } catch (err) {
      this.errorCount++;
      this.lastErrorFull = (err && err.message ? err.message : String(err));
      this.lastError = this.lastErrorFull.slice(0, 120);
      if (this.errorCount === 1) console.error("[pose] detect 首次报错:", this.lastErrorFull);
      this.label = "推理出错";
      return;
    }
    this.lastInferMs = performance.now() - t0;
    this.detectCount++;
    if (!res.landmarks || res.landmarks.length === 0) {
      this.tracked = false;
      this.label = "未检测到人";
      this._drawSkeleton(null);
      return;
    }
    this.tracked = true;
    const lm = this._smooth(res.landmarks[0]);
    const world = res.worldLandmarks ? res.worldLandmarks[0] : null;

    // 重心（肩+髋平均）
    const cx = (lm[L_SHOULDER].x + lm[R_SHOULDER].x + lm[L_HIP].x + lm[R_HIP].x) / 4;
    const cy = (lm[L_SHOULDER].y + lm[R_SHOULDER].y + lm[L_HIP].y + lm[R_HIP].y) / 4;
    const shoulderSpan = Math.hypot(
      lm[L_SHOULDER].x - lm[R_SHOULDER].x,
      lm[L_SHOULDER].y - lm[R_SHOULDER].y
    );

    // ---- 校准：滚动采样 + 稳定度判定（是否站稳不动）----
    if (this.baseY === null) {
      this._calBuf.push({ cx, cy, shoulderSpan });
      if (this._calBuf.length > 18) this._calBuf.shift();
      // 当前中心相对最近窗口均值的位移 = 抖动量
      let ax = 0, ay = 0;
      for (const s of this._calBuf) { ax += s.cx; ay += s.cy; }
      ax /= this._calBuf.length; ay /= this._calBuf.length;
      this.calMove = Math.hypot(cx - ax, cy - ay);
      this.still = this.tracked && this._calBuf.length >= 5 && this.calMove < 0.022;
      this.label = "校准中…";
      this._drawSkeleton(lm);
      return;
    }

    // ---- 侧移：镜像后 (1-cx)，居中 0 ----
    const mx = 1 - cx;
    this.lean = clamp((mx - 0.5) * TH.leanScale, -1, 1);

    // ---- 跳 / 蹲：重心垂直位移 ----
    const dY = this.baseY - cy; // 正 = 上移（跳）
    this.dUp = dY;
    if (dY > this.jumpThresh && !this._airborne) {
      this._jumpQueued = true;
      this._airborne = true;
    }
    if (dY < this.jumpThresh * 0.4) this._airborne = false; // 回落复位

    // 下蹲：重心下移量（正=下蹲）+ 滞回防抖
    this.dVert = cy - this.baseY;
    if (this.dVert > TH.squat) this.isSquatting = true;
    else if (this.dVert < TH.squatExit) this.isSquatting = false;

    // ---- 出拳：手腕世界坐标 z 朝摄像头快速位移 ----
    // 出拳：手臂"快速伸展"检测（肩-肘-腕 2D）。
    // 一拳 = 手臂从弯(ext<低阈)在 350ms 内伸直(ext>高阈)，且手腕落在"前方出拳带"内
    // （肩线以下到腹部之间，排除起跳/跑动时手臂上扬误触）；并有冷却防连发。
    // 伸出后置 armed，必须收回到弯曲才能再次触发，避免举着手刷拳。
    const chestY = (lm[L_SHOULDER].y + lm[L_HIP].y) / 2;
    const shoulderY = (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2;
    let maxExt = 0;
    for (const [key, sh, el, wr] of [
      ["L", L_SHOULDER, L_ELBOW, L_WRIST],
      ["R", R_SHOULDER, R_ELBOW, R_WRIST],
    ]) {
      const armLen = dist2(lm[sh], lm[el]) + dist2(lm[el], lm[wr]) + 1e-6;
      const ext = dist2(lm[sh], lm[wr]) / armLen; // 0.5 弯 ~ 1.0 直
      if (ext > maxExt) maxExt = ext;
      if (ext < this.punchExtLow) {
        this._armState[key] = "bent";
        this._lastBent[key] = nowMs;
      } else if (
        this._armState[key] === "bent" &&
        ext > this.punchExtHigh &&
        nowMs - this._lastBent[key] < 350 &&
        lm[wr].y > shoulderY - 0.05 &&          // 手腕不高于肩太多（排除举手/起跳上扬）
        lm[wr].y < chestY + 0.18 &&             // 也不低于腹部太多
        nowMs - this._lastPunchTs > this.punchCooldown
      ) {
        this._punchQueued = true;
        this._armState[key] = "armed";
        this._lastPunchTs = nowMs;
      }
    }
    this.dPunch = maxExt;

    // 双手举过头顶（两手腕都高于鼻子）
    this.handsUp = lm[L_WRIST].y < lm[NOSE].y && lm[R_WRIST].y < lm[NOSE].y;

    // 标签
    this.label = this.isSquatting ? "蹲"
      : this._airborne ? "跳"
      : this.lean < -0.35 ? "左"
      : this.lean > 0.35 ? "右"
      : "站立";

    this._drawSkeleton(lm);
  }

  _smooth(lm) {
    if (!this._smoothLm) { this._smoothLm = lm.map((p) => ({ ...p })); return this._smoothLm; }
    const a = TH.smooth;
    for (let i = 0; i < lm.length; i++) {
      this._smoothLm[i].x = this._smoothLm[i].x * a + lm[i].x * (1 - a);
      this._smoothLm[i].y = this._smoothLm[i].y * a + lm[i].y * (1 - a);
      this._smoothLm[i].z = lm[i].z;
      this._smoothLm[i].visibility = lm[i].visibility;
    }
    return this._smoothLm;
  }

  _drawSkeleton(lm) {
    const ctx = this.skCtx, w = this.skCanvas.width, h = this.skCanvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!lm) return;
    const bones = [
      [L_SHOULDER, R_SHOULDER], [L_SHOULDER, L_HIP], [R_SHOULDER, R_HIP],
      [L_HIP, R_HIP], [L_SHOULDER, L_WRIST], [R_SHOULDER, R_WRIST],
    ];
    ctx.strokeStyle = "rgba(200,255,100,.85)";
    ctx.lineWidth = 3;
    for (const [a, b] of bones) {
      ctx.beginPath();
      ctx.moveTo(lm[a].x * w, lm[a].y * h);
      ctx.lineTo(lm[b].x * w, lm[b].y * h);
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    for (const i of [NOSE, L_SHOULDER, R_SHOULDER, L_WRIST, R_WRIST, L_HIP, R_HIP]) {
      ctx.beginPath();
      ctx.arc(lm[i].x * w, lm[i].y * h, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
