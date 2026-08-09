
(function () {
  'use strict';

  class WhipAudio {
    constructor(config) {
      this.config = config;
      this.ctx = null;
      this.master = null;
      this.reverb = null;
      this.reverbGain = null;
      this.noiseBuffer = null;
      this.samples = [];
      this.whoosh = null;
      this.enabled = true;
      this.idleTimer = null;
    }

    setConfig(config) {
      const before = JSON.stringify(soundFileList(this.config));
      this.config = config;
      if (this.master) this.master.gain.value = config.sound.volume ?? 0.8;
      if (this.reverbGain) this.reverbGain.gain.value = config.sound.reverb ?? 0.35;

      if (this.ctx && JSON.stringify(soundFileList(config)) !== before) this.loadFiles();
    }

    ensure() {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { this.enabled = false; return null; }

      const ctx = new Ctx();
      this.ctx = ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this.config.sound.volume ?? 0.8;
      this.master.connect(ctx.destination);

      this.reverb = ctx.createConvolver();
      this.reverb.buffer = makeImpulse(ctx, 0.45, 3.2);
      this.reverbGain = ctx.createGain();
      this.reverbGain.gain.value = this.config.sound.reverb ?? 0.35;
      this.reverb.connect(this.reverbGain);
      this.reverbGain.connect(this.master);

      this.noiseBuffer = makeNoise(ctx, 2);
      this.loadFiles();
      return ctx;
    }

    async loadFiles() {
      const files = soundFileList(this.config);
      if (!files.length) {
        this.samples = [];
        console.log('[whip] no files in assets/sounds - using the synthesised crack');
        return;
      }
      const ctx = this.ctx;
      this.samples = (await Promise.all(files.map(async (file) => {
        const url = /^(\.|\/|[a-z]+:)/i.test(file)
          ? file
          : `../../assets/sounds/${encodeURIComponent(file)}`;
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await ctx.decodeAudioData(await response.arrayBuffer());
        } catch (err) {
          console.warn(`[whip] sound "${file}" did not load: ${err.message}`);
          return null;
        }
      }))).filter(Boolean);

      console.log(`[whip] ${this.samples.length}/${files.length} sound file(s) ready: ${files.join(', ')}`);
    }

    crack(strength = 1, panX = null) {
      const s = this.config.sound;
      if (!s.enabled || !this.enabled) return;
      const ctx = this.ensure();
      if (!ctx) return;

      const now = ctx.currentTime;
      const power = 0.4 + strength * 0.6;
      const jitter = 1 + (Math.random() * 2 - 1) * (s.pitchJitter ?? 0.18);

      if (this.samples.length) {
        const source = ctx.createBufferSource();
        source.buffer = this.samples[(Math.random() * this.samples.length) | 0];
        if (s.pitchJitterFiles) source.playbackRate.value = jitter;

        const gain = ctx.createGain();
        gain.gain.value = s.scaleWithStrength === false ? 1 : power;
        source.connect(gain);

        let tail = gain;
        if (s.panning !== false && ctx.createStereoPanner) {
          const panner = ctx.createStereoPanner();
          panner.pan.value = panX == null ? 0 : clamp((panX / window.innerWidth) * 2 - 1, -0.85, 0.85);
          gain.connect(panner);
          tail = panner;
        }
        tail.connect(this.master);

        source.start(now);
        source.onended = () => { try { gain.disconnect(); tail.disconnect(); } catch {  } };
        return;
      }

      const bus = ctx.createGain();
      bus.gain.value = 1;
      const pan = ctx.createStereoPanner
        ? ctx.createStereoPanner()
        : null;
      if (pan) {
        pan.pan.value = panX == null ? 0 : clamp((panX / window.innerWidth) * 2 - 1, -0.85, 0.85);
        bus.connect(pan);
        pan.connect(this.master);
        pan.connect(this.reverb);
      } else {
        bus.connect(this.master);
        bus.connect(this.reverb);
      }

      this.noiseBurst(bus, {
        start: now,
        duration: 0.008,
        type: 'highpass',
        freqFrom: 5000 * jitter,
        freqTo: 11000 * jitter,
        peak: 1.15 * power,
        q: 0.6,
        clip: true
      });

      this.noiseBurst(bus, {
        start: now + 0.003,
        duration: 0.105 + Math.random() * 0.05,
        type: 'bandpass',
        freqFrom: 6800 * jitter,
        freqTo: 780,
        peak: 0.72 * power,
        q: 1.5
      });

      this.noiseBurst(bus, {
        start: now + 0.035 + Math.random() * 0.02,
        duration: 0.05,
        type: 'bandpass',
        freqFrom: 3400 * jitter,
        freqTo: 1100,
        peak: 0.3 * power,
        q: 1.1
      });

      if (s.impactThump !== false) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(210 * jitter, now);
        osc.frequency.exponentialRampToValueAtTime(38, now + 0.17);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.6 * power, now + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
        osc.connect(gain);
        gain.connect(bus);
        osc.start(now);
        osc.stop(now + 0.23);
      }

      setTimeout(() => { try { bus.disconnect(); pan?.disconnect(); } catch {  } }, 1600);
    }

    noiseBurst(destination, opts) {
      const ctx = this.ctx;
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = opts.type;
      filter.Q.value = opts.q ?? 1;
      filter.frequency.setValueAtTime(opts.freqFrom, opts.start);
      filter.frequency.exponentialRampToValueAtTime(Math.max(60, opts.freqTo), opts.start + opts.duration);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, opts.start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.peak), opts.start + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, opts.start + opts.duration);

      source.connect(filter);
      if (opts.clip) {

        const shaper = ctx.createWaveShaper();
        shaper.curve = CLIP_CURVE;
        shaper.oversample = '2x';
        filter.connect(shaper);
        shaper.connect(gain);
      } else {
        filter.connect(gain);
      }
      gain.connect(destination);
      source.start(opts.start, Math.random() * 1.5);
      source.stop(opts.start + opts.duration + 0.02);
    }

    updateWhoosh(speed, panX) {
      const cfg = this.config.sound;
      if (!cfg.enabled || !cfg.whoosh?.enabled || !this.enabled) return this.stopWhoosh();
      const ctx = this.ensure();
      if (!ctx) return;

      if (!this.whoosh) {
        const source = ctx.createBufferSource();
        source.buffer = this.noiseBuffer;
        source.loop = true;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 0.8;
        filter.frequency.value = 500;

        const gain = ctx.createGain();
        gain.gain.value = 0;

        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        source.connect(filter);
        filter.connect(gain);
        if (pan) { gain.connect(pan); pan.connect(this.master); } else { gain.connect(this.master); }
        source.start();

        this.whoosh = { source, filter, gain, pan };
      }

      const minSpeed = cfg.whoosh.minSpeed ?? 25;
      const t = clamp((speed - minSpeed) / (this.config.crack.tipSpeed - minSpeed), 0, 1);
      const target = t ** 1.6 * (cfg.whoosh.maxGain ?? 0.22);

      const now = ctx.currentTime;
      this.whoosh.gain.gain.setTargetAtTime(target, now, 0.04);
      this.whoosh.filter.frequency.setTargetAtTime(320 + t * 2400, now, 0.05);
      if (this.whoosh.pan && panX != null) {
        this.whoosh.pan.pan.setTargetAtTime(clamp((panX / window.innerWidth) * 2 - 1, -0.9, 0.9), now, 0.08);
      }
    }

    stopWhoosh() {
      if (!this.whoosh) return;
      const { source, filter, gain, pan } = this.whoosh;
      try {
        gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
        source.stop(this.ctx.currentTime + 0.3);

        source.onended = () => {
          for (const node of [source, filter, gain, pan]) {
            try { node?.disconnect(); } catch {  }
          }
        };
      } catch {  }
      this.whoosh = null;
    }

    idle() {
      this.stopWhoosh();
      if (!this.ctx || this.idleTimer) return;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.ctx?.state === 'running') this.ctx.suspend().catch(() => {});
      }, 2000);
    }
  }

  const CLIP_CURVE = (() => {
    const n = 1024;
    const curve = new Float32Array(n);
    const drive = 2.6;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
    }
    return curve;
  })();

  function makeNoise(ctx, seconds) {
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function makeImpulse(ctx, seconds, decay) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
      }
    }
    return buffer;
  }

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  function soundFileList(config) {
    const s = config?.sound || {};
    const explicit = (s.files || []).filter(Boolean);
    return explicit.length ? explicit : (s.available || []);
  }

  window.WhipAudio = WhipAudio;
})();
