
(function () {
  'use strict';

  const DEFAULT_MAX_DPR = 1.5;
  const DEFAULT_BANDS = 10;
  const DEFAULT_BUDGET_MS = 10;
  const TARGET_QUADS = 40;
  const MAX_FLASHES = 4;
  const MAX_SPARKS = 200;

  class WhipRenderer {
    constructor(canvas, config) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.config = config;
      this.skin = null;

      this.trail = [];
      this.sparks = [];
      this.flashes = [];
      this.shockwaves = [];
      this.verdict = null;
      this.verdictUntil = 0;

      this.quality = { glow: true, trail: true, samples: null };
      this.frameCost = 0;
      this.slowFrames = 0;
      this.wasEmpty = true;

      this.dpr = 1;
      this.resize();
    }

    setConfig(config) {
      this.config = config;
      this.resize();
    }

    setSkin(skin) {
      this.skin = skin;
      if (!skin?.images) return;
      const baked = {};
      for (const [slot, image] of Object.entries(skin.images)) {
        baked[slot] = bake(image);
      }
      this.skin = { ...skin, images: baked };
    }

    setVerdict(verdict, ms = 5000) {
      this.verdict = verdict;
      this.verdictUntil = performance.now() + ms;
    }

    resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;

      if (w < 2 || h < 2) return false;

      const cap = this.config?.appearance?.maxPixelRatio ?? DEFAULT_MAX_DPR;
      this.dpr = Math.min(window.devicePixelRatio || 1, Math.max(1, cap));
      this.canvas.width = Math.max(1, Math.floor(w * this.dpr));
      this.canvas.height = Math.max(1, Math.floor(h * this.dpr));
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.width = w;
      this.height = h;
      this.wasEmpty = true;
      return true;
    }

    clear() {
      this.ctx.clearRect(0, 0, this.width, this.height);
    }

    draw(rope, now) {
      const active = rope.active && rope.points.length > 1;
      const hasFx = this.sparks.length || this.flashes.length || this.shockwaves.length;

      if (!active && !hasFx) {
        if (this.wasEmpty) return;
        this.clear();
        this.trail.length = 0;
        this.wasEmpty = true;
        return;
      }
      this.wasEmpty = false;

      const started = performance.now();
      const ctx = this.ctx;
      const a = this.config.appearance;
      const glowColor = this.currentGlow(now);

      this.clear();
      this.drawShockwaves(now);
      this.drawFlashes(now);

      if (active) {
        const samples = this.quality.samples ?? Math.max(1, a.splineSamples | 0);
        const spline = catmullRom(rope.points, samples);
        this.updateTrail(rope, a);
        this.drawTrail(glowColor, a);

        if (a.useImages && this.skin?.images?.segment) {
          this.drawTextured(spline, a);
        } else {
          this.drawVector(spline, a, glowColor);
        }
        this.drawFittings(rope, spline, a);
      }

      this.drawSparks(now, a);
      ctx.globalAlpha = 1;

      this.trackCost(performance.now() - started, a);
    }

    trackCost(ms, a) {
      if (a.adaptiveQuality === false) return;
      const budget = a.frameBudgetMs ?? DEFAULT_BUDGET_MS;
      this.frameCost = this.frameCost * 0.9 + ms * 0.1;

      if (this.frameCost > budget) {
        this.slowFrames += 1;
        if (this.slowFrames < 30) return;
        this.slowFrames = 0;
        if (this.quality.glow) {
          this.quality.glow = false;
          console.warn(`[whip] frames costing ~${this.frameCost.toFixed(1)}ms - turning the glow off`);
        } else if (this.quality.trail) {
          this.quality.trail = false;
          console.warn('[whip] still slow - turning the motion trail off');
        } else if ((this.quality.samples ?? 99) > 2) {
          this.quality.samples = 2;
          console.warn('[whip] still slow - reducing curve smoothness');
        }
      } else if (this.frameCost < budget * 0.5) {
        this.slowFrames = 0;
      }
    }

    drawVector(spline, a, glowColor) {
      const ctx = this.ctx;
      const colors = { ...a.colors, ...(this.skin?.colors || {}) };
      const bands = Math.max(2, a.widthBands || DEFAULT_BANDS);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (this.quality.glow && a.glow > 0) {
        ctx.save();
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = a.glow;
        ctx.strokeStyle = colors.outline;
        ctx.lineWidth = Math.max(1, (a.lineWidthHandle + a.lineWidthTip) / 2 + a.outlineWidth);
        tracePath(ctx, spline, 0, spline.length - 1);
        ctx.stroke();
        ctx.restore();
      }

      ctx.shadowBlur = 0;

      for (const pass of ['outline', 'core']) {
        ctx.strokeStyle = pass === 'outline' ? colors.outline : colors.core;
        for (let b = 0; b < bands; b++) {
          const start = Math.floor((b * (spline.length - 1)) / bands);
          const end = Math.floor(((b + 1) * (spline.length - 1)) / bands);
          if (end <= start) continue;

          const t = (b + 0.5) / bands;
          let width = a.lineWidthHandle + (a.lineWidthTip - a.lineWidthHandle) * t;
          if (t < 0.08) width += a.handleBoost * (1 - t / 0.08);
          if (pass === 'outline') width += a.outlineWidth;

          ctx.lineWidth = Math.max(0.5, width);
          tracePath(ctx, spline, start, end);
          ctx.stroke();
        }
      }
    }

    drawTextured(spline, a) {
      const ctx = this.ctx;
      const image = this.skin.images.segment;
      const widthScale = this.skin.segment?.widthScale ?? 1;

      const step = Math.max(1, Math.round((spline.length - 1) / TARGET_QUADS));

      for (let i = 0; i < spline.length - 1; i += step) {
        const p0 = spline[i];
        const p1 = spline[Math.min(i + step, spline.length - 1)];
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const length = Math.hypot(dx, dy);
        if (length < 0.01) continue;

        const t = i / (spline.length - 2 || 1);
        let width = (a.lineWidthHandle + (a.lineWidthTip - a.lineWidthHandle) * t) * widthScale;
        if (t < 0.08) width += a.handleBoost * (1 - t / 0.08);

        ctx.save();
        ctx.translate(p0.x, p0.y);
        ctx.rotate(Math.atan2(dy, dx));

        ctx.drawImage(image, 0, -width / 2, length + 1, width);
        ctx.restore();
      }
    }

    drawFittings(rope, spline, a) {
      if (!a.useImages || !this.skin?.images) return;
      const ctx = this.ctx;
      const images = this.skin.images;

      if (images.handle && spline.length > 1) {
        const p0 = rope.points[0];
        const p1 = rope.points[1] || spline[1];
        const meta = this.skin.handle || {};
        const scale = meta.scale ?? 1;
        const w = images.handle.width * scale;
        const h = images.handle.height * scale;
        const [ax, ay] = meta.anchor || [0.12, 0.5];

        ctx.save();
        ctx.translate(p0.x, p0.y);
        ctx.rotate(Math.atan2(p1.y - p0.y, p1.x - p0.x));
        ctx.drawImage(images.handle, -w * ax, -h * ay, w, h);
        ctx.restore();
      }

      if (images.tip && rope.points.length > 2) {
        const last = rope.points[rope.points.length - 1];
        const prev = rope.points[rope.points.length - 2];
        const meta = this.skin.tip || {};
        const scale = meta.scale ?? 1;
        const w = images.tip.width * scale;
        const h = images.tip.height * scale;
        const [ax, ay] = meta.anchor || [0, 0.5];

        ctx.save();
        ctx.translate(last.x, last.y);
        ctx.rotate(Math.atan2(last.y - prev.y, last.x - prev.x));
        ctx.drawImage(images.tip, -w * ax, -h * ay, w, h);
        ctx.restore();
      }
    }

    updateTrail(rope, a) {
      if (!a.trail?.enabled || !this.quality.trail) { this.trail.length = 0; return; }
      const tip = rope.points[rope.points.length - 1];
      this.trail.push({ x: tip.x, y: tip.y, speed: rope.tipSpeed });
      while (this.trail.length > a.trail.length) this.trail.shift();
    }

    drawTrail(glowColor, a) {
      if (!a.trail?.enabled || !this.quality.trail || this.trail.length < 3) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = glowColor;
      ctx.shadowBlur = 0;

      for (let i = 1; i < this.trail.length; i++) {
        const t = i / this.trail.length;

        const speedFade = Math.min(1, (this.trail[i].speed || 0) / 120);
        const alpha = a.trail.alpha * t * speedFade;
        if (alpha < 0.02) continue;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = a.trail.width * t;
        ctx.beginPath();
        ctx.moveTo(this.trail[i - 1].x, this.trail[i - 1].y);
        ctx.lineTo(this.trail[i].x, this.trail[i].y);
        ctx.stroke();
      }
      ctx.restore();
    }

    crackFx(x, y, strength, now = performance.now()) {
      const a = this.config.appearance;
      const power = 0.45 + strength * 0.55;

      if (a.flash?.enabled && this.flashes.length < MAX_FLASHES) {
        this.flashes.push({ x, y, born: now, life: a.flash.durationMs, radius: a.flash.radius * power, alpha: a.flash.alpha * power });
      }
      if (a.shockwave?.enabled) {
        this.shockwaves.push({ x, y, born: now, life: a.shockwave.durationMs, radius: a.shockwave.maxRadius * power });
      }
      if (a.sparks?.enabled) {
        const room = MAX_SPARKS - this.sparks.length;
        const count = Math.min(room, Math.round(a.sparks.count * power));
        for (let i = 0; i < count; i++) {
          const angle = Math.random() * Math.PI * 2;
          const speed = a.sparks.speed * (0.35 + Math.random()) * power;
          this.sparks.push({
            x, y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            born: now,
            life: a.sparks.life * (0.6 + Math.random() * 0.7),
            size: a.sparks.size * (0.5 + Math.random())
          });
        }
      }
    }

    drawFlashes(now) {
      const ctx = this.ctx;
      this.flashes = this.flashes.filter((f) => now - f.born < f.life);
      for (const flash of this.flashes) {
        const t = life(now, flash);
        const radius = Math.max(0, flash.radius * (0.35 + t * 0.65));
        const alpha = flash.alpha * (1 - t) ** 2;
        if (alpha < 0.01 || radius <= 0) continue;
        const gradient = ctx.createRadialGradient(flash.x, flash.y, 0, flash.x, flash.y, radius);
        gradient.addColorStop(0, `rgba(255,248,225,${alpha})`);
        gradient.addColorStop(0.35, `rgba(255,207,107,${alpha * 0.45})`);
        gradient.addColorStop(1, 'rgba(255,207,107,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(flash.x, flash.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawShockwaves(now) {
      const ctx = this.ctx;
      const width = this.config.appearance.shockwave?.width ?? 3;
      this.shockwaves = this.shockwaves.filter((s) => now - s.born < s.life);
      for (const wave of this.shockwaves) {
        const t = life(now, wave);
        const eased = 1 - (1 - t) ** 3;
        const radius = Math.max(0, wave.radius * eased);
        if (radius <= 0) continue;
        ctx.save();
        ctx.globalAlpha = (1 - t) * 0.55;
        ctx.strokeStyle = '#fff3d0';
        ctx.lineWidth = Math.max(0.1, width * (1 - t));
        ctx.beginPath();
        ctx.arc(wave.x, wave.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    drawSparks(now, a) {
      const ctx = this.ctx;
      const gravity = a.sparks?.gravity ?? 0.25;
      const image = a.useImages ? this.skin?.images?.spark : null;

      this.sparks = this.sparks.filter((s) => now - s.born < s.life);
      for (const spark of this.sparks) {
        const t = life(now, spark);
        spark.x += spark.vx;
        spark.y += spark.vy;
        spark.vy += gravity;
        spark.vx *= 0.97;
        spark.vy *= 0.97;

        ctx.globalAlpha = (1 - t) ** 1.5;
        if (image) {
          const size = spark.size * 6 * (this.skin.spark?.scale ?? 1);
          ctx.drawImage(image, spark.x - size / 2, spark.y - size / 2, size, size);
        } else {
          ctx.fillStyle = t < 0.4 ? '#fff8e1' : '#ffcf6b';
          ctx.beginPath();
          ctx.arc(spark.x, spark.y, spark.size * (1 - t * 0.6), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    currentGlow(now) {
      const base = this.skin?.colors?.glow || this.config.appearance.colors.glow;
      if (!this.config.appearance.verdictTint || !this.verdict || now > this.verdictUntil) return base;
      return { scam: '#ff5c62', suspicious: '#f5b942', clean: '#3fbf6f' }[this.verdict] || base;
    }
  }

  function life(now, fx) {
    return Math.min(1, Math.max(0, (now - fx.born) / fx.life));
  }

  function tracePath(ctx, points, start, end) {
    ctx.beginPath();
    ctx.moveTo(points[start].x, points[start].y);
    for (let i = start + 1; i <= end; i++) ctx.lineTo(points[i].x, points[i].y);
  }

  function bake(image) {
    if (!image || !image.width || !image.height) return image;
    try {
      const off = document.createElement('canvas');
      off.width = image.width;
      off.height = image.height;
      off.getContext('2d').drawImage(image, 0, 0);
      return off;
    } catch {
      return image;
    }
  }

  function catmullRom(points, samplesPerSegment) {
    if (points.length < 3) return points.map((p) => ({ x: p.x, y: p.y }));
    const out = [];
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || points[i + 1];

      for (let s = 0; s < samplesPerSegment; s++) {
        const t = s / samplesPerSegment;
        const t2 = t * t;
        const t3 = t2 * t;
        out.push({
          x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
        });
      }
    }
    out.push({ x: points[points.length - 1].x, y: points[points.length - 1].y });
    return out;
  }

  window.WhipRenderer = WhipRenderer;
  window.WhipSpline = { catmullRom };
})();
