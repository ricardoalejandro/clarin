#!/usr/bin/env python3
import os

page_content = '''"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { Dynamic, DynamicItem, DynamicConfig, DEFAULT_CONFIG } from "@/types/dynamic";
import ScratchCard from "@/components/dynamics/ScratchCard";

interface PublicData {
  dynamic: Dynamic;
  items: DynamicItem[];
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function PublicDynamicPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [data, setData] = useState<PublicData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentItem, setCurrentItem] = useState<DynamicItem | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [round, setRound] = useState(0);
  const triedFullscreen = useRef(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch(`/api/public/dynamics/${slug}`);
        if (!res.ok) {
          setError("Din\u00e1mica no encontrada");
          return;
        }
        const json: PublicData = await res.json();
        setData(json);
        if (json.items?.length > 0) {
          setCurrentItem(pickRandom(json.items));
        }
      } catch {
        setError("Error de conexi\u00f3n");
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [slug]);

  const tryFullscreen = useCallback(() => {
    const el = document.documentElement;
    const rfs =
      el.requestFullscreen ||
      (el as any).webkitRequestFullscreen ||
      (el as any).msRequestFullscreen;
    if (rfs) rfs.call(el).catch(() => {});
  }, []);

  useEffect(() => {
    if (!data || !currentItem) return;
    const handler = () => {
      if (!triedFullscreen.current) {
        triedFullscreen.current = true;
        tryFullscreen();
      }
    };
    window.addEventListener("touchstart", handler, { once: true });
    window.addEventListener("click", handler, { once: true });
    return () => {
      window.removeEventListener("touchstart", handler);
      window.removeEventListener("click", handler);
    };
  }, [data, currentItem, tryFullscreen]);

  const handleReveal = useCallback(() => {
    setRevealed(true);
  }, []);

  const handlePlayAgain = useCallback(() => {
    if (!data || data.items.length === 0) return;
    setRevealed(false);
    setCurrentItem(pickRandom(data.items));
    setRound((r) => r + 1);
    triedFullscreen.current = false;
    tryFullscreen();
  }, [data, tryFullscreen]);

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-slate-900">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-white/20 border-t-white" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-slate-900 text-white">
        <div className="text-center">
          <p className="text-xl font-medium">{error || "No encontrado"}</p>
          <p className="text-white/50 text-sm mt-2">Esta din\u00e1mica no est\u00e1 disponible</p>
        </div>
      </div>
    );
  }

  const config: DynamicConfig = { ...DEFAULT_CONFIG, ...data.dynamic.config };
  const items = data.items;

  if (items.length === 0 || !currentItem) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ backgroundColor: config.bg_color }}>
        <p className="text-white/60 text-sm">Esta din\u00e1mica no tiene contenido a\u00fan</p>
      </div>
    );
  }

  return (
    <>
      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .fade-in-up { animation: fadeInUp 0.6s ease-out forwards; }
      `}</style>

      <div
        className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden"
        style={{ backgroundColor: config.bg_color }}
      >
        <div className="flex-1 flex items-center justify-center w-full">
          <ScratchCard
            key={`${currentItem.id}-${round}`}
            imageUrl={currentItem.image_url}
            thoughtText={currentItem.thought_text}
            author={currentItem.author}
            config={config}
            onReveal={handleReveal}
          />
        </div>

        {revealed && (
          <div
            className="absolute bottom-0 left-0 right-0 pb-6 pt-16 flex flex-col items-center gap-3 fade-in-up"
            style={{ background: `linear-gradient(to top, ${config.bg_color} 40%, transparent)` }}
          >
            {config.title && (
              <p className="text-white/40 text-xs font-medium tracking-wider uppercase">
                {config.title}
              </p>
            )}
            <button
              onClick={handlePlayAgain}
              className="px-8 py-3 bg-white/15 hover:bg-white/25 active:scale-95 text-white text-sm font-semibold rounded-full backdrop-blur-sm transition-all border border-white/10"
            >
              \ud83c\udfb2 Jugar de nuevo
            </button>
          </div>
        )}
      </div>
    </>
  );
}
'''

scratch_content = '''"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { DynamicConfig } from "@/types/dynamic";

interface ScratchCardProps {
  imageUrl: string;
  thoughtText: string;
  author: string;
  config: DynamicConfig;
  onReveal: () => void;
}

export default function ScratchCard({
  imageUrl,
  thoughtText,
  author,
  config,
  onReveal,
}: ScratchCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [cardSize, setCardSize] = useState({ width: 300, height: 400 });
  const isDrawing = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const noiseSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const crackleSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const hasRevealedRef = useRef(false);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const pad = 16;
      const maxW = window.innerWidth - pad * 2;
      const maxH = window.innerHeight - pad * 2;
      const scale = Math.min(maxW / img.width, maxH / img.height, 2);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      setCardSize({ width: w, height: h });
      setImageLoaded(true);
    };
    img.onerror = () => {
      setCardSize({ width: window.innerWidth - 32, height: window.innerHeight - 32 });
      setImageLoaded(true);
    };
    img.src = imageUrl;
  }, [imageUrl]);

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

    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#c9a84c");
    grad.addColorStop(0.3, "#b8963a");
    grad.addColorStop(0.5, "#d4af57");
    grad.addColorStop(0.7, "#a88632");
    grad.addColorStop(1, "#c49f45");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < 8000; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const alpha = Math.random() * 0.15;
      ctx.fillStyle = `rgba(0,0,0,${alpha})`;
      ctx.fillRect(x, y, 1, 1);
    }

    const drawStar = (cx: number, cy: number, size: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#fff";
      ctx.translate(cx, cy);
      ctx.rotate(Math.random() * Math.PI);
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.quadraticCurveTo(size * 0.15, -size * 0.15, size, 0);
      ctx.quadraticCurveTo(size * 0.15, size * 0.15, 0, size);
      ctx.quadraticCurveTo(-size * 0.15, size * 0.15, -size, 0);
      ctx.quadraticCurveTo(-size * 0.15, -size * 0.15, 0, -size);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const starCount = Math.floor((W * H) / 8000);
    for (let i = 0; i < starCount; i++) {
      drawStar(Math.random() * W, Math.random() * H, 3 + Math.random() * 8, 0.2 + Math.random() * 0.5);
    }

    for (let i = 0; i < starCount / 2; i++) {
      ctx.save();
      ctx.globalAlpha = 0.3 + Math.random() * 0.3;
      ctx.fillStyle = "#fffbe6";
      ctx.beginPath();
      ctx.arc(Math.random() * W, Math.random() * H, 1 + Math.random() * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = 0.85;
    const fontSize = Math.max(18, Math.min(32, W * 0.06));
    ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillText("\ud83d\udc46 Raspa aqu\u00ed", W / 2 + 2, H / 2 + 2);
    ctx.fillStyle = "#fff";
    ctx.fillText("\ud83d\udc46 Raspa aqu\u00ed", W / 2, H / 2);
    ctx.restore();

    if (config.overlay_image_url) {
      const overlayImg = new Image();
      overlayImg.crossOrigin = "anonymous";
      overlayImg.onload = () => {
        ctx.drawImage(overlayImg, 0, 0, W, H);
      };
      overlayImg.src = config.overlay_image_url;
    }
  }, [imageLoaded, cardSize, config.overlay_image_url, isRevealed]);

  const getScratched = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const ctx = canvas.getContext("2d");
    if (!ctx) return 0;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let transparent = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] === 0) transparent++;
    }
    return (transparent / (pixels.length / 4)) * 100;
  }, []);

  const checkReveal = useCallback(() => {
    if (hasRevealedRef.current) return;
    const pct = getScratched();
    if (pct >= config.scratch_threshold) {
      hasRevealedRef.current = true;
      setIsRevealed(true);
      onReveal();
      stopScratchAudio();
      if (config.show_confetti) fireConfetti();
      if (config.victory_sound) playVictorySound();
    }
  }, [getScratched, config.scratch_threshold, config.show_confetti, config.victory_sound, onReveal]);

  const brushSize = Math.max(20, Math.min(35, typeof window !== "undefined" ? window.innerWidth * 0.07 : 25));

  const scratch = useCallback(
    (x: number, y: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(x, y, brushSize, 0, Math.PI * 2);
      ctx.fill();
    },
    [brushSize]
  );

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
    isDrawing.current = true;
    const { x, y } = getPos(e);
    scratch(x, y);
    if (config.scratch_sound) startScratchAudio();
  };

  const handleMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing.current) return;
    e.preventDefault();
    const { x, y } = getPos(e);
    scratch(x, y);
  };

  const handleEnd = () => {
    isDrawing.current = false;
    stopScratchAudio();
    checkReveal();
  };

  const startScratchAudio = () => {
    if (audioCtxRef.current) return;
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const sr = ctx.sampleRate;

      const noiseBuf = ctx.createBuffer(1, sr * 2, sr);
      const noiseData = noiseBuf.getChannelData(0);
      for (let i = 0; i < noiseData.length; i++) {
        noiseData[i] = Math.random() * 2 - 1;
      }
      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = noiseBuf;
      noiseSource.loop = true;

      const bp1 = ctx.createBiquadFilter();
      bp1.type = "bandpass";
      bp1.frequency.value = 3000;
      bp1.Q.value = 0.8;

      const hiShelf = ctx.createBiquadFilter();
      hiShelf.type = "highshelf";
      hiShelf.frequency.value = 4500;
      hiShelf.gain.value = 6;

      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.12;

      noiseSource.connect(bp1);
      bp1.connect(hiShelf);
      hiShelf.connect(noiseGain);

      const crackleBuf = ctx.createBuffer(1, sr * 2, sr);
      const crackleData = crackleBuf.getChannelData(0);
      for (let i = 0; i < crackleData.length; i++) {
        if (Math.random() < 0.03) {
          const burst = (Math.random() * 2 - 1) * 0.8;
          crackleData[i] = burst;
          for (let j = 1; j < 8 && i + j < crackleData.length; j++) {
            crackleData[i + j] = burst * (1 - j / 8) * (0.5 + Math.random() * 0.5);
          }
        }
      }
      const crackleSource = ctx.createBufferSource();
      crackleSource.buffer = crackleBuf;
      crackleSource.loop = true;

      const crackleBP = ctx.createBiquadFilter();
      crackleBP.type = "bandpass";
      crackleBP.frequency.value = 4000;
      crackleBP.Q.value = 1.5;

      const crackleGain = ctx.createGain();
      crackleGain.gain.value = 0.18;

      crackleSource.connect(crackleBP);
      crackleBP.connect(crackleGain);

      const master = ctx.createGain();
      master.gain.value = 0.7;

      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.type = "sine";
      lfo.frequency.value = 6 + Math.random() * 4;
      lfoGain.gain.value = 0.15;
      lfo.connect(lfoGain);
      lfoGain.connect(master.gain);
      lfo.start();

      noiseGain.connect(master);
      crackleGain.connect(master);
      master.connect(ctx.destination);

      noiseSource.start();
      crackleSource.start();

      noiseSourceRef.current = noiseSource;
      crackleSourceRef.current = crackleSource;
      masterGainRef.current = master;
    } catch {}
  };

  const stopScratchAudio = () => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (masterGainRef.current) {
      masterGainRef.current.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    }
    setTimeout(() => {
      try { noiseSourceRef.current?.stop(); } catch {}
      try { crackleSourceRef.current?.stop(); } catch {}
      try { ctx.close(); } catch {}
      noiseSourceRef.current = null;
      crackleSourceRef.current = null;
      masterGainRef.current = null;
      audioCtxRef.current = null;
    }, 150);
  };

  const playVictorySound = () => {
    try {
      const ctx = new AudioContext();
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.12);
        osc.stop(ctx.currentTime + i * 0.12 + 0.5);
      });
      setTimeout(() => ctx.close(), 2000);
    } catch {}
  };

  const fireConfetti = () => {
    const colors = ["#10b981", "#f59e0b", "#ef4444", "#3b82f6", "#8b5cf6", "#ec4899"];
    for (let i = 0; i < 80; i++) {
      const el = document.createElement("div");
      const size = Math.random() * 10 + 4;
      el.style.cssText = `
        position:fixed;width:${size}px;height:${size}px;
        background:${colors[Math.floor(Math.random() * colors.length)]};
        border-radius:${Math.random() > 0.5 ? "50%" : "2px"};
        left:${50 + (Math.random() - 0.5) * 70}%;
        top:-10px;opacity:1;pointer-events:none;z-index:9999;
      `;
      document.body.appendChild(el);

      const destX = (Math.random() - 0.5) * 500;
      const destY = window.innerHeight + 60;
      const rot = Math.random() * 720;
      const dur = 1500 + Math.random() * 1200;

      el.animate(
        [
          { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
          { transform: `translate(${destX}px,${destY}px) rotate(${rot}deg)`, opacity: 0 },
        ],
        { duration: dur, easing: "cubic-bezier(.25,.46,.45,.94)" }
      );
      setTimeout(() => el.remove(), dur);
    }
  };

  useEffect(() => {
    return () => {
      try { noiseSourceRef.current?.stop(); } catch {}
      try { crackleSourceRef.current?.stop(); } catch {}
      try { audioCtxRef.current?.close(); } catch {}
    };
  }, []);

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

        {isRevealed && (thoughtText || author) && (
          <div
            className="absolute bottom-0 left-0 right-0 p-4 flex flex-col items-center text-center"
            style={{
              background: "linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.4) 60%, transparent 100%)",
              animation: "fadeInText 0.6s ease-out forwards",
            }}
          >
            {thoughtText && (
              <p className="text-white text-sm sm:text-base font-medium leading-snug drop-shadow-lg max-w-md">
                {thoughtText}
              </p>
            )}
            {author && (
              <p className="text-white/70 text-xs sm:text-sm italic mt-1 drop-shadow">
                \u2014 {author}
              </p>
            )}
          </div>
        )}

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
      </div>

      <style>{`
        @keyframes fadeInText {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
'''

page_path = "/root/proyect/clarin/frontend/src/app/d/[slug]/page.tsx"
scratch_path = "/root/proyect/clarin/frontend/src/components/dynamics/ScratchCard.tsx"

with open(page_path, "w", encoding="utf-8") as f:
    f.write(page_content)
print(f"Written: {page_path} ({len(page_content)} bytes)")

with open(scratch_path, "w", encoding="utf-8") as f:
    f.write(scratch_content)
print(f"Written: {scratch_path} ({len(scratch_content)} bytes)")

os.remove("/root/proyect/clarin/write_dynamics.py")
print("Done")
