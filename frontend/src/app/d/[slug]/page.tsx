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

function storageKey(linkId: string) {
  return `dynamic_reg:${linkId}`;
}

function phoneKey(linkId: string) {
  return `dynamic_phone:${linkId}`;
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

  // Registration gate state
  const [regRequired, setRegRequired] = useState(false);
  const [regCompleted, setRegCompleted] = useState(false);
  const [regName, setRegName] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [registering, setRegistering] = useState(false);
  const [regError, setRegError] = useState("");

  // Share state
  const [shareOpen, setShareOpen] = useState(false);
  const [shareName, setShareName] = useState("");
  const [sharePhone, setSharePhone] = useState("");
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState("");
  const [shareSuccess, setShareSuccess] = useState<{ name: string; phone: string } | null>(null);

  // Schedule state
  const [scheduleStatus, setScheduleStatus] = useState<'ok' | 'not_started' | 'ended'>('ok');
  const triedFullscreen = useRef(false);

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

        if (json.link) {
          const now = new Date();
          if (json.link.starts_at && now < new Date(json.link.starts_at)) setScheduleStatus('not_started');
          else if (json.link.ends_at && now > new Date(json.link.ends_at)) setScheduleStatus('ended');
        }

        if (!json.options || json.options.length <= 1) {
          const pool = json.items?.filter(i => i.is_active) || [];
          if (pool.length > 0) setCurrentItem(pickRandom(pool, null));
        }

        if (json.link?.whatsapp_enabled) {
          // Priority 1: ?t=<token> in URL (used for shared invitations) →
          // validate against backend, persist locally, and clean the URL.
          const urlToken = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('t') : null;
          if (urlToken) {
            try {
              const check = await fetch(`/api/public/dynamics/check-registration?link_id=${json.link.id}&session_token=${encodeURIComponent(urlToken)}`);
              const cj = await check.json();
              if (cj.registered) {
                localStorage.setItem(storageKey(json.link.id), urlToken);
                if (cj.registration?.phone) {
                  // strip leading 51 country code for storage compat with form
                  const p = String(cj.registration.phone).replace(/^51/, '');
                  localStorage.setItem(phoneKey(json.link.id), p);
                }
                setRegCompleted(true);
                // Clean the URL to remove the token from history
                try { window.history.replaceState({}, '', window.location.pathname); } catch {}
                return; // skip the rest of the registration check
              }
            } catch { /* fall through to normal flow */ }
          }

          const token = typeof window !== 'undefined' ? localStorage.getItem(storageKey(json.link.id)) : null;
          const storedPhone = typeof window !== 'undefined' ? localStorage.getItem(phoneKey(json.link.id)) : null;
          if (token) {
            try {
              const check = await fetch(`/api/public/dynamics/check-registration?link_id=${json.link.id}&session_token=${encodeURIComponent(token)}`);
              const cj = await check.json();
              if (cj.registered) {
                setRegCompleted(true);
              } else if (storedPhone) {
                // Token was invalidated but we know the phone → try phone fallback
                const check2 = await fetch(`/api/public/dynamics/check-registration?link_id=${json.link.id}&phone=${encodeURIComponent(storedPhone)}`);
                const cj2 = await check2.json();
                if (cj2.registered && cj2.session_token) {
                  localStorage.setItem(storageKey(json.link.id), cj2.session_token);
                  setRegCompleted(true);
                } else {
                  localStorage.removeItem(storageKey(json.link.id));
                  setRegRequired(true);
                }
              } else {
                localStorage.removeItem(storageKey(json.link.id));
                setRegRequired(true);
              }
            } catch {
              setRegCompleted(true);
            }
          } else if (storedPhone) {
            // No token but phone was stored previously — recover session via phone
            try {
              const check = await fetch(`/api/public/dynamics/check-registration?link_id=${json.link.id}&phone=${encodeURIComponent(storedPhone)}`);
              const cj = await check.json();
              if (cj.registered && cj.session_token) {
                localStorage.setItem(storageKey(json.link.id), cj.session_token);
                setRegCompleted(true);
              } else {
                setRegRequired(true);
              }
            } catch {
              setRegRequired(true);
            }
          } else {
            setRegRequired(true);
          }
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
    const rfs = el.requestFullscreen || (el as any).webkitRequestFullscreen || (el as any).msRequestFullscreen;
    if (rfs) rfs.call(el).catch(() => {});
  }, []);

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
    if (pool.length > 0) setCurrentItem(pickRandom(pool, currentItem));
  }, [data, currentItem]);

  const handleReveal = useCallback(() => { setRevealed(true); }, []);

  const handlePlayAgain = useCallback(() => {
    if (!data || data.items.length === 0) return;
    setRevealed(false);
    const opts = data.options || [];
    if (opts.length >= 2) {
      setSelectedOption(null);
      setCurrentItem(null);
    } else {
      const pool = data.items.filter(i => i.is_active);
      if (pool.length > 0) setCurrentItem(pickRandom(pool, currentItem));
    }
    setRound(r => r + 1);
    triedFullscreen.current = false;
    tryFullscreen();
  }, [data, currentItem, tryFullscreen]);

  const handleRegister = useCallback(async () => {
    if (!data?.link) return;
    // When the dynamic has multiple options, the user may register before
    // choosing. In that case pick any active item so the backend receives a
    // valid item_id for the WhatsApp preview.
    const itemForReg = currentItem || (data.items || []).find(i => i.is_active) || null;
    if (!itemForReg) { setRegError("Esta dinámica no tiene contenido"); return; }
    const name = regName.trim();
    const phone = regPhone.trim();
    if (!name) { setRegError("Ingresa tu nombre"); return; }
    if (phone.length !== 9 || !phone.startsWith("9")) { setRegError("Ingresa un celular válido (9 dígitos)"); return; }

    setRegistering(true);
    setRegError("");
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 35000);
      const res = await fetch("/api/public/dynamics/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          link_id: data.link.id,
          full_name: name,
          phone,
          item_id: itemForReg.id,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const json = await res.json();
      if (res.ok && json.success && json.session_token) {
        localStorage.setItem(storageKey(data.link.id), json.session_token);
        localStorage.setItem(phoneKey(data.link.id), phone);
        setRegCompleted(true);
        setRegRequired(false);
      } else if (res.status === 409 && json.session_token) {
        localStorage.setItem(storageKey(data.link.id), json.session_token);
        localStorage.setItem(phoneKey(data.link.id), phone);
        setRegCompleted(true);
        setRegRequired(false);
      } else {
        setRegError(json.error || "No pudimos completar el registro");
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') setRegError("El envío demoró demasiado. Verifica tu número e intenta de nuevo.");
      else setRegError("Error de conexión");
    } finally {
      setRegistering(false);
    }
  }, [data, currentItem, regName, regPhone]);

  const openShare = useCallback(() => {
    setShareName("");
    setSharePhone("");
    setShareError("");
    setShareSuccess(null);
    setShareOpen(true);
  }, []);

  const handleShare = useCallback(async () => {
    if (!data?.link || !currentItem) return;
    const name = shareName.trim();
    const phone = sharePhone.trim();
    if (!name) { setShareError("Ingresa el nombre"); return; }
    if (phone.length !== 9 || !phone.startsWith("9")) { setShareError("Ingresa un celular válido (9 dígitos)"); return; }

    const token = typeof window !== 'undefined' ? localStorage.getItem(storageKey(data.link.id)) : null;
    if (!token) {
      setShareError("Tu sesión expiró. Recarga la página.");
      return;
    }

    setSharing(true);
    setShareError("");
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 35000);
      const res = await fetch("/api/public/dynamics/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          link_id: data.link.id,
          item_id: currentItem.id,
          full_name: name,
          phone,
          session_token: token,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const json = await res.json();
      if (res.ok && json.success) {
        setShareSuccess({ name, phone });
      } else {
        setShareError(json.error || "No pudimos compartir el mensaje");
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') setShareError("El envío demoró demasiado. Intenta de nuevo.");
      else setShareError("Error de conexión");
    } finally {
      setSharing(false);
    }
  }, [data, currentItem, shareName, sharePhone]);

  const resetShareForm = useCallback(() => {
    setShareName("");
    setSharePhone("");
    setShareError("");
    setShareSuccess(null);
  }, []);

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

  // Registration gate — blocks ANY scratch-card, option selection or content
  // until the user registers and the WhatsApp message is successfully delivered.
  // IMPORTANT: this must come BEFORE showOptions / !currentItem checks, otherwise
  // multi-option dynamics would hide the form behind the option picker / loading.
  if (regRequired && !regCompleted) {
    return (
      <>
        <style>{`
          @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
          .fade-in-up { animation: fadeInUp 0.5s ease-out forwards; }
        `}</style>
        <div className="fixed inset-0 flex flex-col items-center justify-center p-6" style={{ backgroundColor: config.bg_color }}>
          <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl border border-slate-200 fade-in-up space-y-4">
            <div className="text-center space-y-1">
              <p className="text-3xl">💌</p>
              <h2 className="text-slate-800 text-lg font-bold">Registra tus datos</h2>
              <p className="text-slate-500 text-xs">Recibirás tu imagen por WhatsApp y podrás jugar</p>
            </div>
            <input
              type="text"
              value={regName}
              onChange={e => setRegName(e.target.value)}
              placeholder="Nombre completo"
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-400"
              autoFocus
              disabled={registering}
            />
            <div className="flex gap-2">
              <div className="flex items-center gap-1 px-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500 text-sm">🇵🇪 +51</span>
              </div>
              <input
                type="tel"
                value={regPhone}
                onChange={e => setRegPhone(e.target.value.replace(/\D/g, '').slice(0, 9))}
                placeholder="9XXXXXXXX"
                className="flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-400"
                maxLength={9}
                disabled={registering}
              />
            </div>
            <button
              onClick={handleRegister}
              disabled={registering}
              className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-sm font-semibold rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {registering ? (
                <>
                  <span className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                  Enviando WhatsApp…
                </>
              ) : (
                <>📲 Recibir por WhatsApp</>
              )}
            </button>
            {regError && <p className="text-red-500 text-xs text-center">{regError}</p>}
            {registering && (
              <p className="text-slate-400 text-[11px] text-center">Esto puede tardar hasta 30 segundos</p>
            )}
          </div>
        </div>
      </>
    );
  }

  if (showOptions) {
    return (
      <>
        <style>{`
          @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
          .fade-in-up { animation: fadeInUp 0.6s ease-out forwards; }
        `}</style>
        <div className="fixed inset-0 flex flex-col items-center justify-center gap-8 overflow-hidden p-6" style={{ backgroundColor: config.bg_color }}>
          {config.title && (
            <h1 className="text-white text-xl font-bold text-center fade-in-up">{config.title}</h1>
          )}
          <p className="text-white/60 text-sm font-medium fade-in-up" style={{ animationDelay: '0.1s' }}>Elige una opción</p>
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
            <button onClick={() => setSelectedOption(null)} className="px-6 py-2 bg-white/10 hover:bg-white/20 text-white rounded-xl text-sm transition-colors">
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
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .fade-in-up { animation: fadeInUp 0.6s ease-out forwards; }
      `}</style>

      <div className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden" style={{ backgroundColor: config.bg_color }}>
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
            {regCompleted && link?.whatsapp_enabled && (
              <div className="bg-emerald-600/20 backdrop-blur-md rounded-2xl px-4 py-2 mx-4 border border-emerald-500/20">
                <p className="text-emerald-300 text-xs font-medium text-center">✅ Tu imagen fue enviada por WhatsApp</p>
              </div>
            )}
            {config.title && (
              <p className="text-white/40 text-xs font-medium tracking-wider uppercase">{config.title}</p>
            )}
            <div className="flex items-center gap-2 flex-wrap justify-center px-4">
              <button
                onClick={handlePlayAgain}
                className="px-7 py-3 bg-white/15 hover:bg-white/25 active:scale-95 text-white text-sm font-semibold rounded-full backdrop-blur-sm transition-all border border-white/10"
              >
                🎲 Jugar de nuevo
              </button>
              {regCompleted && link?.whatsapp_enabled && (
                <button
                  onClick={openShare}
                  className="px-7 py-3 bg-emerald-500/90 hover:bg-emerald-500 active:scale-95 text-white text-sm font-semibold rounded-full backdrop-blur-sm transition-all border border-emerald-400/30 shadow-lg shadow-emerald-500/20"
                >
                  📤 Compartir
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Share modal */}
      {shareOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm fade-in-up" onClick={() => !sharing && setShareOpen(false)}>
          <div
            className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl border border-slate-200 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            {!shareSuccess ? (
              <>
                <div className="text-center space-y-1">
                  <p className="text-3xl">📤</p>
                  <h2 className="text-slate-800 text-lg font-bold">Comparte con alguien</h2>
                  <p className="text-slate-500 text-xs">Enviaremos este mismo mensaje por WhatsApp</p>
                </div>
                <input
                  type="text"
                  value={shareName}
                  onChange={e => setShareName(e.target.value)}
                  placeholder="Nombre de la persona"
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-400"
                  autoFocus
                  disabled={sharing}
                />
                <div className="flex gap-2">
                  <div className="flex items-center gap-1 px-3 bg-slate-50 rounded-xl border border-slate-200">
                    <span className="text-slate-500 text-sm">🇵🇪 +51</span>
                  </div>
                  <input
                    type="tel"
                    value={sharePhone}
                    onChange={e => setSharePhone(e.target.value.replace(/\D/g, '').slice(0, 9))}
                    placeholder="9XXXXXXXX"
                    className="flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-400"
                    maxLength={9}
                    disabled={sharing}
                  />
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => setShareOpen(false)}
                    disabled={sharing}
                    className="px-4 py-3 text-slate-500 hover:text-slate-700 text-sm font-medium rounded-xl disabled:opacity-50"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleShare}
                    disabled={sharing}
                    className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-sm font-semibold rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {sharing ? (
                      <>
                        <span className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                        Enviando…
                      </>
                    ) : (
                      <>📲 Enviar por WhatsApp</>
                    )}
                  </button>
                </div>
                {shareError && <p className="text-red-500 text-xs text-center">{shareError}</p>}
                {sharing && (
                  <p className="text-slate-400 text-[11px] text-center">Esto puede tardar hasta 30 segundos</p>
                )}
              </>
            ) : (
              <>
                <div className="text-center space-y-2">
                  <p className="text-4xl">✅</p>
                  <h2 className="text-slate-800 text-lg font-bold">¡Enviado!</h2>
                  <p className="text-slate-500 text-xs">
                    {shareSuccess.name} recibió el mensaje en<br />
                    <span className="font-mono text-slate-700">+51 {shareSuccess.phone}</span>
                  </p>
                </div>
                <div className="flex flex-col gap-2 pt-2">
                  <button
                    onClick={resetShareForm}
                    className="py-3 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-sm font-semibold rounded-xl transition-all"
                  >
                    Compartir con otra persona
                  </button>
                  <button
                    onClick={() => setShareOpen(false)}
                    className="py-3 text-slate-500 hover:text-slate-700 text-sm font-medium rounded-xl"
                  >
                    Cerrar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
