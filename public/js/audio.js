// audio.js —— 纯 WebAudio 合成：音效 + 程序化背景音乐。需在用户手势内 init()。
let ctx = null, master = null, musicGain = null;
let music = { on: false, timer: null, next: 0, step: 0 };

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export const Sound = {
  init() {
    if (ctx) { ctx.resume && ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    ctx.resume && ctx.resume();
  },

  _noise(dur, pow = 1.5) {
    const len = Math.floor(ctx.sampleRate * dur);
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, pow);
    return b;
  },
  _crunch() {
    const n = 256, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * 3); }
    return c;
  },
  _blip({ freq = 440, type = "sine", dur = 0.15, vol = 0.3, sweep = 0, dest }) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || master);
    o.start(t); o.stop(t + dur);
  },

  jump()  { this._blip({ freq: 300, type: "square", dur: 0.26, vol: 0.22, sweep: 520 }); },
  squat() { this._blip({ freq: 220, type: "sine",   dur: 0.20, vol: 0.20, sweep: -130 }); },

  // 出拳：强打击感 = 低频 thud + 带通噪声爆裂(经软削波加 crunch) + 瞬态
  punch() {
    if (!ctx) return;
    const t = ctx.currentTime;
    // 低频冲击 thud
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.14);
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.18);
    // 噪声爆裂（带通下扫 + crunch）
    const s = ctx.createBufferSource(); s.buffer = this._noise(0.08, 2);
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(2000, t);
    bp.frequency.exponentialRampToValueAtTime(420, t + 0.08);
    const sh = ctx.createWaveShaper(); sh.curve = this._crunch();
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.55, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    s.connect(bp); bp.connect(sh); sh.connect(ng); ng.connect(master);
    s.start(t); s.stop(t + 0.1);
  },

  hit() {
    this._blip({ freq: 90,  type: "sawtooth", dur: 0.42, vol: 0.40, sweep: -45 });
    this._blip({ freq: 130, type: "square",   dur: 0.30, vol: 0.20, sweep: -60 });
  },
  go() { this._blip({ freq: 440, type: "triangle", dur: 0.18, vol: 0.30, sweep: 240 }); },
  gameover() {
    if (!ctx) return;
    const t = ctx.currentTime;
    [330, 247, 196, 130].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "triangle"; o.frequency.value = f;
      const st = t + i * 0.18;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.25, st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.22);
      o.connect(g); g.connect(master); o.start(st); o.stop(st + 0.24);
    });
  },

  // ---------- 背景音乐：pad + 琶音 + 轻鼓点（替代环境嗡鸣）----------
  _mNote(midi, time, dur, type, vol) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = mtof(midi);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(vol, time + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    o.connect(g); g.connect(musicGain); o.start(time); o.stop(time + dur + 0.05);
  },
  _mPad(midi, time, dur) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = mtof(midi);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.linearRampToValueAtTime(0.05, time + 0.4);
    g.gain.setValueAtTime(0.05, time + dur - 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    o.connect(g); g.connect(musicGain); o.start(time); o.stop(time + dur + 0.05);
  },
  _kick(time) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(150, time);
    o.frequency.exponentialRampToValueAtTime(45, time + 0.12);
    g.gain.setValueAtTime(0.45, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);
    o.connect(g); g.connect(musicGain); o.start(time); o.stop(time + 0.2);
  },
  _hat(time) {
    const s = ctx.createBufferSource(); s.buffer = this._noise(0.03, 1);
    const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.10, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
    s.connect(f); f.connect(g); g.connect(musicGain); s.start(time); s.stop(time + 0.05);
  },

  startMusic() {
    if (!ctx || music.on) return;
    music.on = true;
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.0001;
    musicGain.gain.linearRampToValueAtTime(0.6, ctx.currentTime + 2);
    musicGain.connect(master);

    const BPM = 96, sixteenth = 60 / BPM / 4;
    // 梦幻小调进行：Am - F - C - G（每小节一和弦）
    const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
    music.next = ctx.currentTime + 0.1;
    music.step = 0;

    const scheduleStep = (time, step) => {
      const bar = Math.floor(step / 16) % 4;
      const chord = prog[bar];
      const s = step % 16;
      if (s === 0 || s === 8) this._kick(time);          // 底鼓
      if (s % 4 === 2) this._hat(time);                  // 踩镲
      if (s === 0) {                                     // 每小节起：贝斯 + pad
        this._mNote(chord[0] - 12, time, sixteenth * 7, "triangle", 0.18);
        chord.forEach((m) => this._mPad(m, time, sixteenth * 16));
      }
      if (s % 2 === 0) {                                 // 8 分琶音
        const an = chord[(s / 2) % 3] + 12;
        this._mNote(an, time, sixteenth * 1.6, "triangle", 0.09);
      }
    };

    music.timer = setInterval(() => {
      if (!ctx) return;
      while (music.next < ctx.currentTime + 0.12) {
        scheduleStep(music.next, music.step);
        music.next += sixteenth;
        music.step++;
      }
    }, 25);
  },
  stopMusic() {
    if (music.timer) clearInterval(music.timer);
    music.timer = null; music.on = false;
    if (musicGain) { try { musicGain.gain.value = 0; } catch (e) {} }
  },

  toggleMute() {
    if (!master) return false;
    master.gain.value = master.gain.value > 0 ? 0 : 0.5;
    return master.gain.value === 0;
  },
};
