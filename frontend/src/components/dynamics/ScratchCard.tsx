"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { DynamicConfig } from "@/types/dynamic";

interface ScratchCardProps {
  imageUrl: string;
  thoughtText: string;
  author: string;
  config: DynamicConfig;
  onReveal: () => void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  rotationSpeed: number;
  color: string;
  opacity: number;
  life: number;
  maxLife: number;
  shape: "rect" | "triangle" | "arc";
}

const GOLD_COLORS = [
  "#c9a84c", "#d4af57", "#b8963a", "#e0c068",
  "#a88632", "#dbb54a", "#f0d480",
];
const CONFETTI_COLORS = [
  "#10b981", "#f59e0b", "#ef4444", "#3b82f6",
  "#8b5cf6", "#ec4899", "#fbbf24", "#f472b6", "#34d399",
];

export default function ScratchCard({
  imageUrl, thoughtText, author, config, onReveal,
}: ScratchCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particleCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [cardSize, setCardSize] = useState({ width: 300, height: 400 });
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const moveCount = useRef(0);
  const scratchAudioRef = useRef<HTMLAudioElement | null>(null);
  const victoryAudioRef = useRef<HTMLAudioElement | null>(null);
  const hasRevealedRef = useRef(false);
  const particlesRef = useRef<Particle[]>([]);
  const animFrameRef = useRef<number>(0);
  const revealAnimRef = useRef<number>(0);

  // ─── Sizing ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const pad = 16;
      const maxW = window.innerWidth - pad * 2;
      const maxH = window.innerHeight - pad * 2;
      const scale = Math.min(maxW / img.width, maxH / img.height, 2);
      setCardSize({
        width: Math.round(img.width * scale),
        height: Math.round(img.height * scale),
      });
      setImageLoaded(true);
    };
    img.onerror = () => {
      setCardSize({ width: window.innerWidth - 32, height: window.innerHeight - 32 });
      setImageLoaded(true);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // ─── Draw golden metallic overlay ─────────────────────────────────────────

  useEffect(() => {
    if (!imageLoaded || isRevealed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = cardSize.width;
    canvas.height = cardSize.height;
    const W = canvas.width;
    const H = canvas.height;

    // Multi-stop golden gradient
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#c9a84c");
    grad.addColorStop(0.2, "#d4af57");
    grad.addColorStop(0.4, "#b8963a");
    grad.addColorStop(0.6, "#e0c068");
    grad.addColorStop(0.8, "#a88632");
    grad.addColorStop(1, "#c49f45");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Metallic texture
    for (let i = 0; i < 15000; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      ctx.fillStyle = `rgba(${Math.random() > 0.5 ? "255,255,255" : "0,0,0"},${Math.random() * 0.12})`;
      ctx.fillRect(x, y, Math.random() * 2, 1);
    }

    // Horizontal brushed-metal strokes
    for (let i = 0; i < 200; i++) {
      ctx.save();
      ctx.globalAlpha = Math.random() * 0.05;
      ctx.strokeStyle = Math.random() > 0.5 ? "#fff" : "#000";
      ctx.lineWidth = Math.random() * 1.5;
      ctx.beginPath();
      const y = Math.random() * H;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y + (Math.random() - 0.5) * 4);
      ctx.stroke();
      ctx.restore();
    }

    // Sparkle stars
    const drawStar = (cx: number, cy: number, size: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#fffbe6";
      ctx.translate(cx, cy);
      ctx.rotate(Math.random() * Math.PI);
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.quadraticCurveTo(size * 0.12, -size * 0.12, size, 0);
      ctx.quadraticCurveTo(size * 0.12, size * 0.12, 0, size);
      ctx.quadraticCurveTo(-size * 0.12, size * 0.12, -size, 0);
      ctx.quadraticCurveTo(-size * 0.12, -size * 0.12, 0, -size);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const starCount = Math.floor((W * H) / 6000);
    for (let i = 0; i < starCount; i++) {
      drawStar(Math.random() * W, Math.random() * H, 2 + Math.random() * 7, 0.15 + Math.random() * 0.45);
    }

    // Coin-style border
    ctx.save();
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = "#8b6914";
    ctx.lineWidth = 3;
    ctx.strokeRect(6, 6, W - 12, H - 12);
    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = "#fffbe6";
    ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, W - 20, H - 20);
    ctx.restore();

    // Center text
    ctx.save();
    ctx.globalAlpha = 0.9;
    const fontSize = Math.max(16, Math.min(28, W * 0.055));
    ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(80,50,0,0.5)";
    ctx.fillText("\uD83D\uDC46 Raspa aqu\u00ed", W / 2 + 1, H / 2 + 1);
    ctx.fillStyle = "#fff";
    ctx.fillText("\uD83D\uDC46 Raspa aqu\u00ed", W / 2, H / 2);
    ctx.restore();

    if (config.overlay_image_url) {
      const overlayImg = new Image();
      overlayImg.crossOrigin = "anonymous";
      overlayImg.onload = () => ctx.drawImage(overlayImg, 0, 0, W, H);
      overlayImg.src = config.overlay_image_url;
    }
  }, [imageLoaded, cardSize, config.overlay_image_url, isRevealed]);

  // ─── Particle canvas setup ────────────────────────────────────────────────

  useEffect(() => {
    if (!imageLoaded) return;
    const pCanvas = particleCanvasRef.current;
    if (!pCanvas) return;
    pCanvas.width = cardSize.width;
    pCanvas.height = cardSize.height;
  }, [imageLoaded, cardSize]);

  // ─── Particle animation loop (shimmer + curl) ─────────────────────────────

  useEffect(() => {
    if (!imageLoaded) return;
    const pCanvas = particleCanvasRef.current;
    if (!pCanvas) return;
    const pCtx = pCanvas.getContext("2d");
    if (!pCtx) return;

    const animate = () => {
      pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
      const parts = particlesRef.current;
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life++;
        if (p.life > p.maxLife) { parts.splice(i, 1); continue; }
        p.vy += 0.18;
        p.vx *= 0.985;
        // Curl: small lateral sinusoidal force
        p.vx += Math.sin(p.life * 0.15) * 0.08;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;
        // Shimmer: oscillate opacity for some particles
        const baseOpacity = 1 - p.life / p.maxLife;
        p.opacity = baseOpacity * (0.7 + 0.3 * Math.sin(p.life * 0.3));
        pCtx.save();
        pCtx.translate(p.x, p.y);
        pCtx.rotate(p.rotation);
        pCtx.globalAlpha = p.opacity;
        pCtx.fillStyle = p.color;
        if (p.shape === "rect") {
          pCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        } else if (p.shape === "triangle") {
          pCtx.beginPath();
          pCtx.moveTo(0, -p.size / 2);
          pCtx.lineTo(p.size / 2, p.size / 2);
          pCtx.lineTo(-p.size / 2, p.size / 2);
          pCtx.closePath();
          pCtx.fill();
        } else {
          pCtx.beginPath();
          pCtx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          pCtx.fill();
        }
        pCtx.restore();
      }
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [imageLoaded]);

  // ─── Emit golden flake particles ──────────────────────────────────────────

  const emitParticles = useCallback((x: number, y: number, speed: number) => {
    const count = Math.min(6, Math.max(2, Math.floor(speed / 4)));
    const shapes: Particle["shape"][] = ["rect", "triangle", "arc"];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const vel = 1.5 + Math.random() * 2.5 + speed * 0.2;
      particlesRef.current.push({
        x, y,
        vx: Math.cos(angle) * vel,
        vy: Math.sin(angle) * vel - 2 - Math.random() * 2,
        size: 2 + Math.random() * 8,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.3,
        color: GOLD_COLORS[Math.floor(Math.random() * GOLD_COLORS.length)],
        opacity: 1, life: 0,
        maxLife: 35 + Math.random() * 30,
        shape: shapes[Math.floor(Math.random() * shapes.length)],
      });
    }
  }, []);

  // ─── Scratch percentage ───────────────────────────────────────────────────

  const getScratched = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const ctx = canvas.getContext("2d");
    if (!ctx) return 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let transparent = 0;
    // Sample every 16th pixel for speed
    for (let i = 3; i < data.length; i += 64) {
      if (data[i] === 0) transparent++;
    }
    return (transparent / (data.length / 64)) * 100;
  }, []);

  // ─── Smooth reveal — fade remaining overlay fast ──────────────────────────

  const animateReveal = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let opacity = 1;
    const fade = () => {
      opacity -= 0.06;
      if (opacity <= 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        setIsRevealed(true);
        return;
      }
      // Redraw overlay at reduced opacity
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 0.06;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      revealAnimRef.current = requestAnimationFrame(fade);
    };
    revealAnimRef.current = requestAnimationFrame(fade);
  }, []);

  // ─── Trigger reveal ───────────────────────────────────────────────────────

  const triggerReveal = useCallback(() => {
    if (hasRevealedRef.current) return;
    hasRevealedRef.current = true;
    onReveal();
    stopScratchAudio();
    animateReveal();
    if (config.show_confetti) setTimeout(() => fireConfetti(), 200);
    if (config.victory_sound) setTimeout(() => playVictorySound(), 100);
    if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReveal, animateReveal, config.show_confetti, config.victory_sound]);

  // ─── Check threshold — called during scratching too ───────────────────────

  const checkReveal = useCallback(() => {
    if (hasRevealedRef.current) return;
    const pct = getScratched();
    if (pct >= config.scratch_threshold) {
      triggerReveal();
    }
  }, [getScratched, config.scratch_threshold, triggerReveal]);

  // ─── Brush: thick round line for clean single-pass scratching ─────────────

  const brushSize = Math.max(
    28,
    Math.min(50, typeof window !== "undefined" ? window.innerWidth * 0.09 : 32)
  );

  const scratchLine = useCallback(
    (x: number, y: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 1;

      const last = lastPos.current;
      if (last) {
        // Draw a thick round-capped line — perfect coverage, no gaps
        ctx.lineWidth = brushSize * 2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(x, y);
        ctx.stroke();

        const dx = x - last.x;
        const dy = y - last.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Smart particles: only emit if there's overlay (alpha > 0) at this position
        if (dist > 3) {
          const px = Math.round(x);
          const py = Math.round(y);
          if (px >= 0 && px < canvas.width && py >= 0 && py < canvas.height) {
            // We already cleared pixels, so check midpoint of last→current
            const mx = Math.round((last.x + x) / 2);
            const my = Math.round((last.y + y) / 2);
            // Read from a small area — if any pixel had overlay we emit
            try {
              const sample = ctx.getImageData(
                Math.max(0, mx - 2), Math.max(0, my - 2),
                Math.min(5, canvas.width - Math.max(0, mx - 2)),
                Math.min(5, canvas.height - Math.max(0, my - 2))
              ).data;
              let hasOverlay = false;
              for (let i = 3; i < sample.length; i += 4) {
                if (sample[i] > 10) { hasOverlay = true; break; }
              }
              if (hasOverlay) emitParticles(x, y, dist);
            } catch {
              emitParticles(x, y, dist);
            }
          }
        }
      } else {
        // First touch — single circle
        ctx.beginPath();
        ctx.arc(x, y, brushSize, 0, Math.PI * 2);
        ctx.fill();
        // Check if there's overlay at touch point
        try {
          const sample = ctx.getImageData(
            Math.max(0, Math.round(x) - 2), Math.max(0, Math.round(y) - 2),
            Math.min(5, canvas.width - Math.max(0, Math.round(x) - 2)),
            Math.min(5, canvas.height - Math.max(0, Math.round(y) - 2))
          ).data;
          let hasOverlay = false;
          for (let i = 3; i < sample.length; i += 4) {
            if (sample[i] > 10) { hasOverlay = true; break; }
          }
          if (hasOverlay) emitParticles(x, y, 5);
        } catch {
          emitParticles(x, y, 5);
        }
      }

      lastPos.current = { x, y };
    },
    [brushSize, emitParticles]
  );

  // ─── Pointer helpers ──────────────────────────────────────────────────────

  const getPos = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if ("touches" in e) {
      return {
        x: (e.touches[0].clientX - rect.left) * scaleX,
        y: (e.touches[0].clientY - rect.top) * scaleY,
      };
    }
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const handleStart = (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    if (hasRevealedRef.current) return;
    isDrawing.current = true;
    lastPos.current = null;
    moveCount.current = 0;
    const { x, y } = getPos(e);
    scratchLine(x, y);
    if (navigator.vibrate) navigator.vibrate(3);
  };

  const handleMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing.current || hasRevealedRef.current) return;
    e.preventDefault();
    const { x, y } = getPos(e);
    scratchLine(x, y);
    // Start scratch audio on first actual movement
    if (config.scratch_sound && moveCount.current === 0) startScratchAudio();
    // Check reveal every 12 moves while scratching
    moveCount.current++;
    if (moveCount.current % 12 === 0) checkReveal();
  };

  const handleEnd = () => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    lastPos.current = null;
    stopScratchAudio();
    checkReveal();
  };

  // ─── Scratch audio: real mp3 looped ─────────────────────────────────────

  const startScratchAudio = () => {
    if (scratchAudioRef.current) return;
    try {
      const audio = new Audio("/sounds/scratch.mp3");
      audio.loop = true;
      audio.volume = 0.7;
      audio.play().catch(() => {});
      scratchAudioRef.current = audio;
    } catch {
      // Audio not available
    }
  };

  const stopScratchAudio = () => {
    const audio = scratchAudioRef.current;
    if (!audio) return;
    // Quick fade out
    const fade = () => {
      if (audio.volume > 0.05) {
        audio.volume = Math.max(0, audio.volume - 0.15);
        requestAnimationFrame(fade);
      } else {
        audio.pause();
        audio.currentTime = 0;
        scratchAudioRef.current = null;
      }
    };
    fade();
  };

  // ─── Victory celebration: real mp3 fanfare ───────────────────────────────

  const playVictorySound = () => {
    try {
      const audio = new Audio("/sounds/victory.mp3");
      audio.volume = 0.8;
      audio.play().catch(() => {});
      victoryAudioRef.current = audio;
    } catch {
      // Audio not available
    }
  };

  // ─── Confetti bursts + flash + golden rain ────────────────────────────────

  const fireConfetti = () => {
    const shapes = ["circle", "square", "diamond", "ribbon"];
    const burst = (delay: number, count: number, durMin: number, durMax: number) => {
      setTimeout(() => {
        for (let i = 0; i < count; i++) {
          const el = document.createElement("div");
          const shape = shapes[Math.floor(Math.random() * shapes.length)];
          const size = 5 + Math.random() * 12;
          const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
          let br = "2px", w = `${size}px`, h = `${size * 0.6}px`, extra = "";
          if (shape === "circle") { br = "50%"; h = w; }
          else if (shape === "diamond") { w = h = `${size}px`; br = "2px"; extra = "transform:rotate(45deg);"; }
          else if (shape === "ribbon") { w = `${size * 0.3}px`; h = `${size * 1.5}px`; br = "1px"; }
          el.style.cssText = `position:fixed;width:${w};height:${h};background:${color};border-radius:${br};left:${50 + (Math.random() - 0.5) * 80}%;top:-15px;opacity:1;pointer-events:none;z-index:9999;${extra}`;
          document.body.appendChild(el);
          const sway = (Math.random() - 0.5) * 400;
          const destY = window.innerHeight + 80;
          const rot = Math.random() * 1080;
          const dur = durMin + Math.random() * (durMax - durMin);
          el.animate([
            { transform: "translate(0,0) rotate(0deg) scale(1)", opacity: 1 },
            { transform: `translate(${sway * 0.5}px,${destY * 0.3}px) rotate(${rot * 0.3}deg) scale(1)`, opacity: 1, offset: 0.3 },
            { transform: `translate(${sway}px,${destY}px) rotate(${rot}deg) scale(0.5)`, opacity: 0 },
          ], { duration: dur, easing: "cubic-bezier(.22,.61,.36,1)" });
          setTimeout(() => el.remove(), dur);
        }
      }, delay);
    };

    // Main bursts — more particles, longer duration
    burst(0, 80, 3000, 4500);
    burst(300, 60, 3000, 4500);
    burst(1200, 50, 3000, 5000);

    // Golden rain: slow-falling gold particles after main confetti
    setTimeout(() => {
      const GOLD_RAIN_COLORS = ["#c9a84c", "#d4af57", "#e0c068", "#f0d480", "#dbb54a"];
      for (let i = 0; i < 20; i++) {
        const el = document.createElement("div");
        const size = 3 + Math.random() * 6;
        const color = GOLD_RAIN_COLORS[Math.floor(Math.random() * GOLD_RAIN_COLORS.length)];
        el.style.cssText = `position:fixed;width:${size}px;height:${size * 0.5}px;background:${color};border-radius:1px;left:${10 + Math.random() * 80}%;top:-10px;opacity:1;pointer-events:none;z-index:9999;`;
        document.body.appendChild(el);
        const sway = (Math.random() - 0.5) * 150;
        const destY = window.innerHeight + 40;
        const rot = Math.random() * 720;
        const dur = 4000 + Math.random() * 2000;
        el.animate([
          { transform: "translate(0,0) rotate(0deg)", opacity: 0.9 },
          { transform: `translate(${sway * 0.3}px,${destY * 0.5}px) rotate(${rot * 0.5}deg)`, opacity: 0.7, offset: 0.5 },
          { transform: `translate(${sway}px,${destY}px) rotate(${rot}deg)`, opacity: 0 },
        ], { duration: dur, easing: "cubic-bezier(.25,.46,.45,.94)" });
        setTimeout(() => el.remove(), dur);
      }
    }, 800);

    // Flash 1 — initial burst
    const flash = document.createElement("div");
    flash.style.cssText = "position:fixed;inset:0;background:rgba(255,255,255,0.25);pointer-events:none;z-index:9998;";
    document.body.appendChild(flash);
    flash.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: "ease-out" });
    setTimeout(() => flash.remove(), 400);

    // Flash 2 — second pulse
    setTimeout(() => {
      const flash2 = document.createElement("div");
      flash2.style.cssText = "position:fixed;inset:0;background:rgba(255,255,255,0.15);pointer-events:none;z-index:9998;";
      document.body.appendChild(flash2);
      flash2.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: "ease-out" });
      setTimeout(() => flash2.remove(), 350);
    }, 500);
  };

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      try { scratchAudioRef.current?.pause(); } catch {}
      try { victoryAudioRef.current?.pause(); } catch {}
      scratchAudioRef.current = null;
      victoryAudioRef.current = null;
      cancelAnimationFrame(animFrameRef.current);
      cancelAnimationFrame(revealAnimRef.current);
    };
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────

  if (!imageLoaded) {
    return (
      <div className="flex items-center justify-center" style={{ width: "100vw", height: "100vh" }}>
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-white/20 border-t-white" />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative flex items-center justify-center">
      <div
        className="relative rounded-2xl overflow-hidden shadow-2xl"
        style={{ width: cardSize.width, height: cardSize.height }}
      >
        <img
          src={imageUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-contain"
          style={{ backgroundColor: "#fff" }}
          crossOrigin="anonymous"
        />



        {!isRevealed && (
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full cursor-pointer touch-none"
            onMouseDown={handleStart}
            onMouseMove={handleMove}
            onMouseUp={handleEnd}
            onMouseLeave={handleEnd}
            onTouchStart={handleStart}
            onTouchMove={handleMove}
            onTouchEnd={handleEnd}
          />
        )}

        <canvas
          ref={particleCanvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />
      </div>

      <style>{`
        @keyframes fadeInText {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
