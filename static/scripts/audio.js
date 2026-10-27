// Sound effects and ambience, synthesized with Web Audio (no audio files
// needed). The WAVs in /audio are played for the bosses' voice lines and as
// an ambient bed, so recordings dropped in there are picked up automatically.

const AUDIO_DIR = new URL('../../audio/', import.meta.url);

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = 0.8;
    this.geigerAcc = 0;
    this.chaseLevel = 0;
    this.clips = {};
  }

  // Must be called from a user gesture (browsers block audio until then).
  unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!this.ctx) {
      try {
        this.ctx = new AC();
      } catch {
        return;
      }
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(ctx.destination);
      const len = ctx.sampleRate;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.startAmbience();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    if (this.ambientClip) this.ambientClip.play().catch(() => {});
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
    for (const c of Object.values(this.clips)) c.muted = m;
    if (this.ambientClip) this.ambientClip.muted = m;
  }

  startAmbience() {
    const ctx = this.ctx;
    // Ventilation hum.
    const hum = ctx.createGain();
    hum.gain.value = 0.035;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;
    lp.connect(hum).connect(this.master);
    for (const f of [55, 55.6, 110.3]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start();
    }
    const air = ctx.createBufferSource();
    air.buffer = this.noiseBuf;
    air.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 600;
    bp.Q.value = 0.4;
    const ag = ctx.createGain();
    ag.gain.value = 0.012;
    air.connect(bp).connect(ag).connect(this.master);
    air.start();
    // Chase layer: a pulsing bass that fades in while a boss is after you.
    this.chaseGain = ctx.createGain();
    this.chaseGain.gain.value = 0;
    const cl = ctx.createBiquadFilter();
    cl.type = 'lowpass';
    cl.frequency.value = 500;
    for (const f of [73.4, 110]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(cl);
      o.start();
    }
    cl.connect(this.chaseGain).connect(this.master);

    try {
      this.ambientClip = new Audio(new URL('ambient.wav', AUDIO_DIR).href);
      this.ambientClip.loop = true;
      this.ambientClip.volume = 0.35;
      this.ambientClip.muted = this.muted;
      this.ambientClip.play().catch(() => {});
    } catch { /* optional */ }
  }

  tone({ freq, to = freq, dur = 0.1, type = 'square', gain = 0.08, delay = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to !== freq) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  noise({ dur = 0.1, freq = 1000, to = freq, q = 1, type = 'bandpass', gain = 0.08, delay = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (to !== freq) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  play(name, opts = {}) {
    if (!this.ctx || this.muted) return;
    switch (name) {
      case 'step': this.noise({ dur: 0.06, freq: opts.run ? 500 : 350, type: 'lowpass', gain: opts.run ? 0.14 : 0.07 }); break;
      case 'throw': this.noise({ dur: 0.2, freq: 700, to: 3200, q: 2, gain: 0.12 }); break;
      case 'land': this.noise({ dur: 0.07, freq: 1600, q: 1.5, gain: 0.07 }); break;
      case 'hit': this.tone({ freq: 620, to: 240, dur: 0.14 }); this.noise({ dur: 0.08, freq: 2000, gain: 0.08 }); break;
      case 'pickup': this.tone({ freq: 660, dur: 0.07, type: 'triangle', gain: 0.12 }); this.tone({ freq: 990, dur: 0.1, type: 'triangle', gain: 0.12, delay: 0.07 }); break;
      case 'sign':
        for (let i = 0; i < 5; i++) this.noise({ dur: 0.04, freq: 3000 + i * 300, type: 'highpass', gain: 0.06, delay: i * 0.05 });
        this.tone({ freq: 784, dur: 0.12, type: 'triangle', gain: 0.1, delay: 0.28 });
        this.tone({ freq: 1175, dur: 0.18, type: 'triangle', gain: 0.1, delay: 0.38 });
        break;
      case 'talk': for (let i = 0; i < 3; i++) this.tone({ freq: 260 + Math.random() * 200, dur: 0.05, gain: 0.04, delay: i * 0.07 }); break;
      case 'deny': this.tone({ freq: 160, dur: 0.16, gain: 0.07 }); break;
      case 'spotted': this.tone({ freq: 880, dur: 0.08, gain: 0.09 }); this.tone({ freq: 1320, dur: 0.16, gain: 0.09, delay: 0.08 }); break;
      case 'caught':
        this.tone({ freq: 440, to: 110, dur: 0.55, type: 'sawtooth', gain: 0.12 });
        this.noise({ dur: 0.4, freq: 900, gain: 0.08 });
        break;
      case 'alarm': for (let i = 0; i < 3; i++) this.tone({ freq: 620, to: 940, dur: 0.32, type: 'sawtooth', gain: 0.07, delay: i * 0.42 }); break;
      case 'flare':
        this.tone({ freq: 70, to: 28, dur: 1.4, type: 'sine', gain: 0.35 });
        this.noise({ dur: 1.6, freq: 400, to: 120, type: 'lowpass', gain: 0.25 });
        break;
      case 'drink': this.tone({ freq: 220, to: 130, dur: 0.12, type: 'sine', gain: 0.16 }); this.tone({ freq: 210, to: 120, dur: 0.12, type: 'sine', gain: 0.16, delay: 0.2 }); break;
      case 'win': [523, 659, 784, 1047].forEach((f, i) => this.tone({ freq: f, dur: 0.25, type: 'triangle', gain: 0.14, delay: i * 0.13 })); break;
      case 'lose': [392, 330, 262, 196].forEach((f, i) => this.tone({ freq: f, dur: 0.3, type: 'square', gain: 0.08, delay: i * 0.18 })); break;
      case 'click': this.noise({ dur: 0.006, freq: 3500, type: 'highpass', gain: 0.18 }); break;
      case 'stamp':
        this.noise({ dur: 0.16, freq: 260, type: 'lowpass', gain: 0.5 });
        this.tone({ freq: 110, to: 45, dur: 0.18, type: 'sine', gain: 0.4 });
        break;
      case 'review': [660, 880, 660].forEach((f, i) => this.tone({ freq: f, dur: 0.16, type: 'triangle', gain: 0.1, delay: i * 0.15 })); break;
      default: break;
    }
  }

  // Plays audio/<boss>_line.wav, if it exists and isn't silent.
  voice(id) {
    if (this.muted) return;
    try {
      if (!this.clips[id]) this.clips[id] = new Audio(new URL(`${id}_line.wav`, AUDIO_DIR).href);
      const c = this.clips[id];
      c.currentTime = 0;
      c.play().catch(() => {});
    } catch { /* optional */ }
  }

  // Per-frame: Geiger counter clicks and the chase layer.
  update(dt, game) {
    if (!this.ctx || !game) return;
    const playing = game.status === 'playing';
    // The console's radiation feed for the crew: ticks faster during flares.
    const rate = playing ? Math.min(30, 0.6 + (game.crewRate || 0) * 60) : 0;
    this.geigerAcc += dt * rate * (0.5 + Math.random());
    while (this.geigerAcc >= 1) {
      this.geigerAcc -= 1;
      this.play('click');
    }
    const target = playing ? game.chase : 0;
    this.chaseLevel += (target - this.chaseLevel) * Math.min(1, dt * 3);
    const pulse = 0.55 + 0.45 * Math.sin(this.ctx.currentTime * Math.PI * 4);
    this.chaseGain.gain.setTargetAtTime(this.muted ? 0 : this.chaseLevel * 0.05 * pulse, this.ctx.currentTime, 0.03);
  }
}
