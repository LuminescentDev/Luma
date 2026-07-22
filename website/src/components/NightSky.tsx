import { useEffect, useRef } from 'react';

const ACCENT: readonly [number, number, number] = [240, 204, 251];
const WHITE: readonly [number, number, number] = [255, 255, 255];

const STAR_AREA_PER_STAR = 5200;
const MIN_STARS = 40;
const MAX_STARS = 240;

const MAX_SHOOTING = 3;

const TWO_PI = Math.PI * 2;

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

interface Star {
  x: number;
  y: number;
  r: number;
  baseAlpha: number;
  phase: number;
  speed: number; // twinkle rate, rad/sec
  amp: number; // twinkle opacity swing
  color: readonly [number, number, number];
  glow: boolean;
}

interface ShootingStar {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  age: number;
  life: number;
  bright: number;
  color: readonly [number, number, number];
  trail: Array<{ x: number; y: number }>;
  maxTrail: number;
  dead: boolean;
}

export function NightSky() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    let width = 0;
    let height = 0;
    let stars: Star[] = [];
    let shooting: ShootingStar[] = [];
    let rafId: number | null = null;
    let lastTime = 0;
    let nextSpawn = rand(0.6, 2.4); // seconds until first shooting star
    let running = false;
    let onScreen = true;
    let reduced = motionQuery.matches;

    const makeStars = (): Star[] => {
      const count = Math.max(
        MIN_STARS,
        Math.min(MAX_STARS, Math.round((width * height) / STAR_AREA_PER_STAR)),
      );
      const out: Star[] = [];
      for (let i = 0; i < count; i += 1) {
        const depth = Math.random();
        let r: number;
        let baseAlpha: number;
        let amp: number;
        let glow = false;
        if (depth < 0.1) {
          r = rand(0.4, 0.9);
          baseAlpha = rand(0.22, 0.5);
          amp = rand(0.08, 0.22);
        } else if (depth < 0.85) {
          r = rand(0.8, 1.5);
          baseAlpha = rand(0.4, 0.72);
          amp = rand(0.18, 0.38);
        } else {
          r = rand(1.4, 2.4);
          baseAlpha = rand(0.68, 1);
          amp = rand(0.24, 0.5);
          glow = Math.random() < 0.6;
        }
        out.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r,
          baseAlpha,
          phase: Math.random() * TWO_PI,
          speed: rand(0.4, 1.6),
          amp,
          color: Math.random() < 0.22 ? ACCENT : WHITE,
          glow,
        });
      }
      return out;
    };

    const spawnShooting = () => {
      if (shooting.length >= MAX_SHOOTING) return;
      const fromLeft = Math.random() < 0.5;
      const x = fromLeft ? rand(-0.1, 0.4) * width : rand(0.6, 1.1) * width;
      const y = rand(-0.05, 0.5) * height;
      const speed = rand(340, 620);
      const angle = fromLeft ? rand(0.18, 0.7) : Math.PI - rand(0.18, 0.7);
      let vx = Math.cos(angle) * speed;
      let vy = Math.sin(angle) * speed;
      const px = -vy / speed;
      const py = vx / speed;
      const curv = rand(90, 260) * (Math.random() < 0.5 ? -1 : 1);
      const gravity = rand(40, 130);
      const ax = px * curv;
      const ay = py * curv + gravity;
      const life = rand(1.0, 1.9);
      shooting.push({
        x,
        y,
        vx,
        vy,
        ax,
        ay,
        age: 0,
        life,
        bright: rand(0.7, 1),
        color: Math.random() < 0.4 ? ACCENT : WHITE,
        trail: [{ x, y }],
        maxTrail: Math.round(rand(16, 30)),
        dead: false,
      });
    };

    const drawStar = (s: Star, twinkle: boolean) => {
      const a = clamp01(
        s.baseAlpha + (twinkle ? Math.sin(s.phase) * s.amp : 0),
      );
      if (a <= 0) return;
      const [r, g, b] = s.color;
      if (s.glow) {
        const gr = s.r * 4;
        const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, gr);
        grad.addColorStop(0, `rgba(${r},${g},${b},${a * 0.5})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(s.x, s.y, gr, 0, TWO_PI);
        ctx.fill();
      }
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TWO_PI);
      ctx.fill();
    };

    const drawShooting = (s: ShootingStar) => {
      const fadeIn = Math.min(1, s.age / 0.18);
      const fadeOut = Math.min(1, (s.life - s.age) / 0.4);
      const env = Math.max(0, Math.min(fadeIn, fadeOut)) * s.bright;
      if (env <= 0 || s.trail.length < 2) return;
      const [r, g, b] = s.color;
      const n = s.trail.length;
      ctx.lineCap = 'round';
      for (let i = 1; i < n; i += 1) {
        const p0 = s.trail[i - 1];
        const p1 = s.trail[i];
        const frac = i / (n - 1); // 0 tail .. 1 head
        const a = env * frac * frac;
        ctx.strokeStyle = `rgba(${r},${g},${b},${a})`;
        ctx.lineWidth = 0.4 + frac * frac * 2.1;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
      const head = s.trail[n - 1];
      const halo = 9;
      const grad = ctx.createRadialGradient(
        head.x,
        head.y,
        0,
        head.x,
        head.y,
        halo,
      );
      grad.addColorStop(0, `rgba(255,255,255,${env})`);
      grad.addColorStop(0.4, `rgba(${r},${g},${b},${env * 0.55})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(head.x, head.y, halo, 0, TWO_PI);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${env})`;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 1.7, 0, TWO_PI);
      ctx.fill();
    };

    const renderStatic = () => {
      ctx.clearRect(0, 0, width, height);
      for (const s of stars) drawStar(s, false);
    };

    const frame = (now: number) => {
      if (!running) return;
      rafId = requestAnimationFrame(frame);
      const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0;
      lastTime = now;

      ctx.clearRect(0, 0, width, height);

      for (const s of stars) {
        s.phase += s.speed * dt;
        drawStar(s, true);
      }

      nextSpawn -= dt;
      if (nextSpawn <= 0) {
        spawnShooting();
        nextSpawn = rand(1.6, 5.5);
      }
      if (shooting.length > 0) {
        ctx.globalCompositeOperation = 'lighter';
        for (const s of shooting) {
          s.age += dt;
          s.vx += s.ax * dt;
          s.vy += s.ay * dt;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          s.trail.push({ x: s.x, y: s.y });
          if (s.trail.length > s.maxTrail) s.trail.shift();
          const m = 0.3;
          if (
            s.age >= s.life ||
            s.x < -m * width ||
            s.x > (1 + m) * width ||
            s.y > (1 + m) * height
          ) {
            s.dead = true;
          }
          drawShooting(s);
        }
        ctx.globalCompositeOperation = 'source-over';
        if (shooting.some((s) => s.dead)) {
          shooting = shooting.filter((s) => !s.dead);
        }
      }
    };

    const startLoop = () => {
      if (running) return;
      running = true;
      lastTime = 0;
      rafId = requestAnimationFrame(frame);
    };

    const stopLoop = () => {
      running = false;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const syncRunning = () => {
      if (reduced) {
        stopLoop();
        shooting = [];
        renderStatic();
        return;
      }
      if (onScreen && !document.hidden) startLoop();
      else stopLoop();
    };

    const fit = () => {
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW === 0 || cssH === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = cssW;
      height = cssH;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = makeStars();
      shooting = [];
      if (reduced || !running) renderStatic();
    };

    let resizeTimer: number | undefined;
    const resizeObserver = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        fit();
        syncRunning();
      }, 150);
    });
    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0]?.isIntersecting ?? true;
        syncRunning();
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(canvas);

    const onVisibility = () => syncRunning();
    document.addEventListener('visibilitychange', onVisibility);

    const onMotionChange = () => {
      reduced = motionQuery.matches;
      syncRunning();
    };
    motionQuery.addEventListener('change', onMotionChange);

    fit();
    syncRunning();

    return () => {
      stopLoop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery.removeEventListener('change', onMotionChange);
      window.clearTimeout(resizeTimer);
    };
  }, []);

  return (
    <div className='night-sky' aria-hidden='true'>
      <div className='nebula nebula-a' />
      <div className='nebula nebula-b' />
      <div className='nebula nebula-c' />
      <canvas ref={canvasRef} className='night-sky-canvas' />

      <div
        className='pointer-events-none absolute inset-x-0 bottom-0 h-1/3'
        style={{
          background: 'linear-gradient(180deg, transparent, rgba(6,4,16,0.6))',
        }}
      />
    </div>
  );
}
