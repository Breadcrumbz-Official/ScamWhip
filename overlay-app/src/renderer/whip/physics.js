
(function () {
  'use strict';

  const TAU = Math.PI * 2;

  class WhipRope {
    constructor(config) {
      this.setConfig(config);
      this.points = [];
      this.lengths = [];
      this.totalLength = 0;

      this.active = false;
      this.dropping = false;
      this.spawnedAt = 0;
      this.lastCrackAt = 0;

      this.pointer = { x: 0, y: 0, px: 0, py: 0 };

      this.handleAngle = 0;
      this.handleAngVel = 0;
      this.tipSpeed = 0;
      this.peakTipSpeed = 0;
      this.tipHistory = [];
      this.tipSpeedAvg = 0;

      this.accumulator = 0;
      this.lastStepAt = 0;
    }

    setConfig(config) {
      this.config = config;
      this.p = config.physics;
      this.crackCfg = config.crack;
    }

    get tip() { return this.points[this.points.length - 1]; }
    get handle() { return this.points[0]; }

    spawn(x, y, now = performance.now()) {
      const p = this.p;
      const count = Math.max(4, p.segments | 0);

      this.lengths = [];
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0 : i / (count - 1);
        this.lengths.push(p.segmentLength * (1 - (1 - p.tipTaper) * t));
      }
      this.totalLength = this.lengths.reduce((a, b) => a + b, 0);

      const tipMass = Math.max(0.01, p.tipMassRatio ?? 0.06);

      this.points = [];
      let angle = p.handle.baseAngle;
      let cx = x;
      let cy = y;
      for (let i = 0; i <= count; i++) {
        const t = count === 0 ? 0 : i / count;
        const mass = 1 * (1 - t) + tipMass * t;
        this.points.push({ x: cx, y: cy, px: cx, py: cy, inv: i === 0 ? 0 : 1 / mass, rest: 1 / mass });
        if (i < count) {
          cx += Math.cos(angle) * this.lengths[i];
          cy += Math.sin(angle) * this.lengths[i];
          angle += p.spawnCurl;
        }
      }

      this.pointer = { x, y, px: x, py: y };

      this.handleAngle = p.handle.baseAngle;
      this.handleAngVel = 0;
      this.dropping = false;
      this.active = true;
      this.spawnedAt = now;
      this.lastCrackAt = 0;
      this.tipSpeed = 0;
      this.peakTipSpeed = 0;
      this.tipHistory = [];
      this.tipSpeedAvg = 0;
      this.accumulator = 0;
      this.lastStepAt = now;

      const presettle = this.p.presettleSteps ?? 110;
      this.iterationOverride = Math.min(20, this.p.iterations | 0);
      for (let i = 0; i < presettle; i++) this.step(now, null);
      this.iterationOverride = 0;

      this.tipSpeed = 0;
      this.tipSpeedAvg = 0;
      this.tipHistory = [];
      this.lastCrackAt = 0;
    }

    setPointer(x, y) {
      this.pointer.x = x;
      this.pointer.y = y;
    }

    drop() {
      if (!this.active || this.dropping) return false;
      this.dropping = true;
      this.points[0].inv = this.points[0].rest;
      return true;
    }

    despawn() {
      this.active = false;
      this.dropping = false;
      this.points = [];
    }

    update(now, bounds) {
      const events = { cracked: false, strength: 0, tipSpeed: 0, tipX: 0, tipY: 0, gone: false };
      if (!this.active) return events;

      const frame = 1000 / 60;
      this.accumulator += Math.min(now - this.lastStepAt, frame * 4);
      this.lastStepAt = now;

      let steps = 0;
      while (this.accumulator >= frame && steps < 4) {
        this.accumulator -= frame;
        steps += 1;
        const stepEvents = this.step(now, bounds);
        if (stepEvents.cracked && !events.cracked) Object.assign(events, stepEvents, { gone: events.gone });
        if (stepEvents.gone) events.gone = true;
      }
      if (steps === 0) return events;

      if (steps > 0 && !events.cracked) events.tipSpeed = this.tipSpeed;
      return events;
    }

    step(now, bounds) {
      const p = this.p;
      const events = { cracked: false, strength: 0, tipSpeed: 0, tipX: 0, tipY: 0, gone: false };
      const held = !this.dropping;

      if (held) this.updateHandleAngle();

      const gravity = held ? p.gravity : p.gravityDropping;
      const damping = p.damping;

      for (let i = held ? 1 : 0; i < this.points.length; i++) {
        const point = this.points[i];
        const vx = (point.x - point.px) * damping;
        const vy = (point.y - point.py) * damping;
        point.px = point.x;
        point.py = point.y;
        point.x += vx;
        point.y += vy + gravity;
      }

      if (held) {

        const handle = this.points[0];
        const maxMove = p.maxHandleStepPx ?? 130;

        let dx = this.pointer.x - handle.x;
        let dy = this.pointer.y - handle.y;
        const travel = Math.hypot(dx, dy);
        if (travel > maxMove) {
          const scale = maxMove / travel;
          dx *= scale;
          dy *= scale;
        }

        handle.px = handle.x;
        handle.py = handle.y;
        handle.x += dx;
        handle.y += dy;
        handle.inv = 0;
      }

      if (held) this.applyBasePose();

      const iterations = Math.max(1, this.iterationOverride || (p.iterations | 0));
      for (let k = 0; k < iterations; k++) {

        this.applyDistanceConstraints(k % 2 === 1);
        this.applyBendLimits();
      }
      this.clampStretch();
      this.dampOscillation();

      this.pointer.px = this.pointer.x;
      this.pointer.py = this.pointer.y;

      const tip = this.tip;
      const window = Math.max(1, this.crackCfg.speedWindow ?? 3);
      this.tipHistory.push({ x: tip.x, y: tip.y });
      while (this.tipHistory.length > window + 1) this.tipHistory.shift();

      const oldest = this.tipHistory[0];
      const span = this.tipHistory.length - 1;
      this.tipSpeed = span > 0 ? Math.hypot(tip.x - oldest.x, tip.y - oldest.y) / span : 0;
      this.peakTipSpeed = Math.max(this.peakTipSpeed, this.tipSpeed);

      const c = this.crackCfg;
      const extension = Math.hypot(tip.x - this.points[0].x, tip.y - this.points[0].y) / this.totalLength;

      const spikeTrigger = this.tipSpeedAvg * (c.spikeRatio ?? 1.8);
      const trigger = Math.max(c.tipSpeed, spikeTrigger);

      if (this.tipSpeed > trigger &&
          now - this.spawnedAt > c.graceMs &&
          now - this.lastCrackAt > c.cooldownMs &&
          extension > c.minExtension) {
        this.lastCrackAt = now;
        events.cracked = true;
        events.tipSpeed = this.tipSpeed;
        events.tipX = tip.x;
        events.tipY = tip.y;
        const ceiling = Math.max(c.strengthCeiling, trigger + 1);
        events.strength = clamp((this.tipSpeed - trigger) / (ceiling - trigger), 0, 1);
      }

      const alpha = c.baselineAlpha ?? 0.04;
      this.tipSpeedAvg = this.tipSpeedAvg === 0
        ? this.tipSpeed
        : this.tipSpeedAvg * (1 - alpha) + this.tipSpeed * alpha;

      if (this.dropping && bounds) {
        const floor = bounds.height + (p.despawnBelowPx || 60);
        if (this.points.every((point) => point.y > floor)) events.gone = true;
      }

      return events;
    }

    updateHandleAngle() {
      const h = this.p.handle;
      const mvx = this.pointer.x - this.pointer.px;
      const mvy = this.pointer.y - this.pointer.py;

      const aim = clamp(
        -(mvx * h.aimByMouseX + mvy * h.aimByMouseY) * h.aimScale,
        -h.maxAim,
        h.maxAim
      );
      const target = h.baseAngle + aim;

      this.handleAngVel += (target - this.handleAngle) * h.spring;
      this.handleAngVel *= h.angularDamping;
      this.handleAngle += this.handleAngVel;
    }

    applyBasePose() {
      const count = Math.min(this.p.basePoseSegments | 0, this.points.length - 1);
      if (count <= 0) return;

      const handle = this.points[0];
      const dirX = Math.cos(this.handleAngle);
      const dirY = Math.sin(this.handleAngle);
      let travelled = 0;

      for (let i = 1; i <= count; i++) {
        travelled += this.lengths[i - 1];
        const strength = this.p.basePoseStrength * (1 - (i - 1) / count);
        const point = this.points[i];
        const targetX = handle.x + dirX * travelled;
        const targetY = handle.y + dirY * travelled;
        point.x += (targetX - point.x) * strength;
        point.y += (targetY - point.y) * strength;
      }
    }

    applyDistanceConstraints(reverse = false) {
      const points = this.points;
      const links = points.length - 1;
      for (let step = 0; step < links; step++) {
        const i = reverse ? links - 1 - step : step;
        const a = points[i];
        const b = points[i + 1];
        const target = this.lengths[i];

        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-6) { dx = 1e-6; dist = 1e-6; }

        const weight = a.inv + b.inv;
        if (weight === 0) continue;

        const correction = (dist - target) / dist;
        const shareA = a.inv / weight;
        const shareB = b.inv / weight;

        a.x += dx * correction * shareA;
        a.y += dy * correction * shareA;
        b.x -= dx * correction * shareB;
        b.y -= dy * correction * shareB;
      }
    }

    applyBendLimits() {
      const points = this.points;
      const stiff = this.p.bendLimitHandle;
      const loose = this.p.bendLimitTip;

      const strength = clamp(this.p.bendStiffness ?? 0.35, 0, 1);
      const joints = points.length - 2;

      for (let i = 1; i <= joints; i++) {
        const a = points[i - 1];
        const b = points[i];
        const c = points[i + 1];

        const angleIn = Math.atan2(b.y - a.y, b.x - a.x);
        const angleOut = Math.atan2(c.y - b.y, c.x - b.x);
        const diff = normaliseAngle(angleOut - angleIn);

        const t = i / joints;
        const limit = stiff + (loose - stiff) * t;
        const excess = Math.abs(diff) - limit;
        if (excess <= 0) continue;

        const corrected = angleOut - Math.sign(diff) * excess * strength;
        const segment = Math.hypot(c.x - b.x, c.y - b.y);
        c.x = b.x + Math.cos(corrected) * segment;
        c.y = b.y + Math.sin(corrected) * segment;
      }
    }

    dampOscillation() {
      const points = this.points;
      const smooth = clamp(this.p.velocitySmoothing ?? 0.18, 0, 0.5);
      if (smooth <= 0) return;

      const start = this.dropping ? 0 : 1;
      const vx = this.scratchVx || (this.scratchVx = new Float64Array(points.length));
      const vy = this.scratchVy || (this.scratchVy = new Float64Array(points.length));

      for (let i = 0; i < points.length; i++) {
        vx[i] = points[i].x - points[i].px;
        vy[i] = points[i].y - points[i].py;
      }

      for (let i = start; i < points.length; i++) {
        const prevX = vx[i - 1] ?? vx[i];
        const prevY = vy[i - 1] ?? vy[i];
        const nextX = vx[i + 1] ?? vx[i];
        const nextY = vy[i + 1] ?? vy[i];
        const point = points[i];
        point.px = point.x - (vx[i] + ((prevX + nextX) / 2 - vx[i]) * smooth);
        point.py = point.y - (vy[i] + ((prevY + nextY) / 2 - vy[i]) * smooth);
      }
    }

    clampStretch() {
      const max = this.p.maxStretch || 1.2;
      for (let i = 0; i < this.points.length - 1; i++) {
        const a = this.points[i];
        const b = this.points[i + 1];
        const limit = this.lengths[i] * max;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= limit || dist < 1e-6) continue;
        const scale = limit / dist;
        b.x = a.x + dx * scale;
        b.y = a.y + dy * scale;
      }
    }
  }

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  function normaliseAngle(a) {
    while (a > Math.PI) a -= TAU;
    while (a < -Math.PI) a += TAU;
    return a;
  }

  window.WhipPhysics = { WhipRope, clamp, normaliseAngle };
})();
