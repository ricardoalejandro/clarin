"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { Dynamic, DynamicItem, DynamicConfig, DynamicOption, DynamicLink, DEFAULT_CONFIG } from "@/types/dynamic";
import ScratchCard from "@/components/dynamics/ScratchCard";

interface PublicData {
  dynamic: Dynamic;
  items: DynamicItem[];
  options: DynamicOption[];
  link?: DynamicLink;
}

function pickRandom<T>(arr: T[], exclude?: T | null): T {
  if (arr.length <= 1) return arr[0];
  if (exclude == null) return arr[Math.floor(Math.random() * arr.length)];
  const filtered = arr.filter(item => item !== exclude);
  return filtered[Math.floor(Math.random() * filtered.length)];
}

export default function PublicDynamicPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [data, setData] = useState<PublicData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [currentItem, setCurrentItem] = useState<DynamicItem | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [round, setRound] = useState(0);
  // Registration form
  const [showRegForm, setShowRegForm] = useState(false);
  const [regName, setRegName] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [regAge, setRegAge] = useState("");
  const [registering, setRegistering] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [justRegistered, setJustRegistered] = useState(false);
  const [regError, setRegError] = useState("");
  // Schedule state
  const [scheduleStatus, setScheduleStatus] = useState<'ok' | 'not_started' | 'ended'>('ok');
  const triedFullscreen = useRef(false);

  // Check localStorage on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Will be checked after data loads
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch(`/api/public/dynamics/${slug}`);
        if (!res.ok) {
          setError("Dinámica no encontrada");
          return;
        }
        const json: PublicData = await res.json();
        setData(json);

        // Check schedule
        if (json.link) {
          const now = new Date();
          if (json.link.starts_at && now < new Date(json.link.starts_at)) {
            setScheduleStatus('not_started');
          } else if (json.link.ends_at && now > new Date(json.link.ends_at)) {
            setScheduleStatus('ended');
          }
          // Check localStorage for prior registration
          const regKey = `dynamic_reg_${json.link.id}`;
          if (localStorage.getItem(regKey)) {
            setRegistered(true);
          }
        }

        // If no options or 1 option, auto-pick item immediately
        if (!json.options || json.options.length <= 1) {
          const pool = json.items?.filter(i => i.is_active) || [];
          if (pool.length > 0) setCurrentItem(pickRandom(pool, null));
        }
      } catch {
        setError("Error de conexión");
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

  // Force body/html background to match config
  useEffect(() => {
    if (!data) return;
    const cfg: DynamicConfig = { ...DEFAULT_CONFIG, ...data.dynamic.config };
    const bg = cfg.bg_color || "#0f172a";
    document.body.style.backgroundColor = bg;
    document.documentElement.style.backgroundColor = bg;
    return () => {
      document.body.style.backgroundColor = "";
      document.documentElement.style.backgroundColor = "";
    };
  }, [data]);

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

  const handleSelectOption = useCallback((optionId: string) => {
    if (!data) return;
    setSelectedOption(optionId);
    const pool = data.items.filter(i => i.is_active && i.option_ids?.includes(optionId));
    if (pool.length > 0) {
      setCurrentItem(pickRandom(pool, currentItem));
    }
  }, [data, currentItem]);

  const handleReveal = useCallback(() => {
    setRevealed(true);
  }, []);

  const handlePlayAgain = useCallback(() => {
    if (!data || data.items.length === 0) return;
    setRevealed(false);
    setShowRegForm(false);
    setRegError("");
    setRegName("");
    setRegPhone("");
    setRegAge("");
    const opts = data.options || [];
    if (opts.length >= 2) {
      setSelectedOption(null);
      setCurrentItem(null);
    } else {
      const pool = data.items.filter(i => i.is_active);
      if (pool.length > 0) setCurrentItem(pickRandom(pool, currentItem));
    }
    setRound((r) => r + 1);
    triedFullscreen.current = false;
    tryFullscreen();
  }, [data, tryFullscreen]);

  const handleRegister = useCallback(async () => {
    if (!data?.link || !currentItem) return;
    const name = regName.trim();
    const phone = regPhone.trim();
    const age = parseInt(regAge);
    if (!name) { setRegError("Ingresa tu nombre"); return; }
    if (phone.length !== 9 || !phone.startsWith("9")) { setRegError("Ingresa un celular válido (9 dígitos)"); return; }
    if (isNaN(age) || age < 5 || age > 120) { setRegError("Ingresa una edad válida"); return; }

    setRegistering(true);
    setRegError("");
    try {
      const res = await fetch("/api/public/dynamics/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          link_id: data.link.id,
          full_name: name,
          phone: phone,
          age: age,
          item_id: currentItem.id,
        }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setRegistered(true);
        setJustRegistered(true);
        localStorage.setItem(`dynamic_reg_${data.link.id}`, "1");
      } else {
        setRegError(json.error || "Error al registrar");
      }
    } catch {
      setRegError("Error de conexión");
    } finally {
      setRegistering(false);
    }
  }, [data, currentItem, regName, regPhone, regAge]);

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
          <p className="text-white/50 text-sm mt-2">Esta dinámica no está disponible</p>
        </div>
      </div>
    );
  }

  const config: DynamicConfig = { ...DEFAULT_CONFIG, ...data.dynamic.config };
  const items = data.items.filter(i => i.is_active);
  const options = data.options || [];
  const link = data.link;
  const showOptions = options.length >= 2 && !currentItem && !selectedOption;

  // Schedule checks
  if (scheduleStatus === 'not_started' && link?.starts_at) {
    const startDate = new Date(link.starts_at);
    return (
      <div className="fixed inset-0 flex items-center justify-center p-6" style={{ backgroundColor: config.bg_color }}>
        <div className="text-center max-w-sm">
          <p className="text-5xl mb-4">🕐</p>
          <p className="text-white text-lg font-semibold mb-2">¡Pronto!</p>
          <p className="text-white/70 text-sm">
            Este evento comenzará el {startDate.toLocaleDateString('es-PE', { timeZone: 'America/Lima', day: 'numeric', month: 'long', year: 'numeric' })} a las {startDate.toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' })}.
          </p>
          <p className="text-white/50 text-xs mt-3">¡Vuelve pronto!</p>
        </div>
      </div>
    );
  }

  if (scheduleStatus === 'ended') {
    return (
      <div className="fixed inset-0 flex items-center justify-center p-6" style={{ backgroundColor: config.bg_color }}>
        <div className="text-center max-w-sm">
          <p className="text-5xl mb-4">✨</p>
          <p className="text-white text-lg font-semibold mb-2">¡Gracias por tu interés!</p>
          <p className="text-white/70 text-sm">Este evento ya finalizó. ¡Nos vemos en el próximo!</p>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ backgroundColor: config.bg_color }}>
        <p className="text-white/60 text-sm">Esta dinámica no tiene contenido aún</p>
      </div>
    );
  }

  // Option selection screen
  if (showOptions) {
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
          className="fixed inset-0 flex flex-col items-center justify-center gap-8 overflow-hidden p-6"
          style={{ backgroundColor: config.bg_color }}
        >
          {config.title && (
            <h1 className="text-white text-xl font-bold text-center fade-in-up">
              {config.title}
            </h1>
          )}
          <p className="text-white/60 text-sm font-medium fade-in-up" style={{ animationDelay: '0.1s' }}>
            Elige una opción
          </p>
          <div className="flex flex-wrap justify-center gap-4 max-w-md">
            {options.map((opt, idx) => (
              <button
                key={opt.id}
                onClick={() => handleSelectOption(opt.id)}
                className="px-8 py-4 bg-white/10 hover:bg-white/20 active:scale-95 text-white rounded-2xl backdrop-blur-sm transition-all border border-white/10 hover:border-white/30 fade-in-up"
                style={{ animationDelay: `${0.2 + idx * 0.1}s` }}
              >
                <span className="text-2xl block mb-1">{opt.emoji}</span>
                <span className="text-sm font-semibold">{opt.name}</span>
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }

  if (!currentItem) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4" style={{ backgroundColor: config.bg_color }}>
        {selectedOption ? (
          <>
            <p className="text-white/60 text-sm">Esta categoría no tiene pensamientos asignados</p>
            <button
              onClick={() => { setSelectedOption(null); }}
              className="px-6 py-2 bg-white/10 hover:bg-white/20 text-white rounded-xl text-sm transition-colors"
            >
              ← Elegir otra opción
            </button>
          </>
        ) : (
          <p className="text-white/60 text-sm">Cargando...</p>
        )}
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
            {/* Registration section */}
            {link && !showRegForm && !registered && (
              <button
                onClick={() => setShowRegForm(true)}
                className="px-6 py-2.5 bg-emerald-600/80 hover:bg-emerald-600 active:scale-95 text-white text-sm font-semibold rounded-full backdrop-blur-sm transition-all border border-emerald-500/30 flex items-center gap-2 fade-in-up"
              >
                📋 Registrar mis datos
              </button>
            )}

            {showRegForm && !registered && (
              <div className="bg-white rounded-2xl p-4 mx-4 w-full max-w-sm shadow-xl border border-slate-200 fade-in-up space-y-3">
                <p className="text-slate-600 text-xs text-center font-medium">Registra tus datos{link?.whatsapp_enabled ? ' y recibe tu imagen por WhatsApp' : ''}</p>
                <input
                  type="text"
                  value={regName}
                  onChange={e => setRegName(e.target.value)}
                  placeholder="Nombre completo"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-400"
                  autoFocus
                />
                <div className="flex gap-2">
                  <div className="flex items-center gap-1 px-3 py-2 bg-slate-50 rounded-xl border border-slate-200">
                    <span className="text-slate-500 text-sm">🇵🇪 +51</span>
                  </div>
                  <input
                    type="tel"
                    value={regPhone}
                    onChange={e => setRegPhone(e.target.value.replace(/\D/g, '').slice(0, 9))}
                    placeholder="9XXXXXXXX"
                    className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-400"
                    maxLength={9}
                  />
                </div>
                <input
                  type="number"
                  value={regAge}
                  onChange={e => setRegAge(e.target.value.slice(0, 3))}
                  placeholder="Edad"
                  min={5}
                  max={120}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-400"
                />
                <button
                  onClick={handleRegister}
                  disabled={registering}
                  className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-sm font-semibold rounded-xl transition-all disabled:opacity-40"
                >
                  {registering ? "Registrando..." : "📋 Registrarme"}
                </button>
                {regError && <p className="text-red-500 text-xs text-center">{regError}</p>}
              </div>
            )}

            {registered && (
              <div className="bg-emerald-600/20 backdrop-blur-md rounded-2xl p-4 mx-4 border border-emerald-500/20 fade-in-up">
                <p className="text-emerald-300 text-sm font-medium text-center">
                  {justRegistered && link?.whatsapp_enabled
                    ? '✅ ¡Datos registrados! En breve recibirás tu imagen por WhatsApp.'
                    : '✅ ¡Ya estás registrado!'}
                </p>
              </div>
            )}

            {config.title && (
              <p className="text-white/40 text-xs font-medium tracking-wider uppercase">
                {config.title}
              </p>
            )}
            <button
              onClick={handlePlayAgain}
              className="px-8 py-3 bg-white/15 hover:bg-white/25 active:scale-95 text-white text-sm font-semibold rounded-full backdrop-blur-sm transition-all border border-white/10"
            >
              🎲 Jugar de nuevo
            </button>
          </div>
        )}
      </div>
    </>
  );
}
