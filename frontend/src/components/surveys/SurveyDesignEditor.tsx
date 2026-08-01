"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { Image as ImageIcon, Loader2, Monitor, RotateCcw, Save, Smartphone, UploadCloud, X } from 'lucide-react';
import type { Survey, SurveyBranding } from '@/types/survey';
import { BUTTON_STYLE_OPTIONS, FONT_OPTIONS, TITLE_SIZE_OPTIONS } from '@/types/survey';

export type DesignMediaDraft = {
  logoFile: File | null;
  backgroundFile: File | null;
  logoAction: 'keep' | 'remove' | 'external' | 'upload';
  backgroundAction: 'keep' | 'remove' | 'external' | 'upload';
};

type PreviewScreen = 'welcome' | 'question' | 'thanks';
type EditorPane = 'config' | 'preview';

const THEMES: { name: string; description: string; values: SurveyBranding }[] = [
  { name: 'Clarin', description: 'Sereno y reconocible', values: { bg_color: '#FFFFFF', text_color: '#0F172A', accent_color: '#047857', font_family: 'Inter', button_style: 'rounded' } },
  { name: 'Editorial', description: 'Formal y cálido', values: { bg_color: '#FFFBEB', text_color: '#292524', accent_color: '#9A3412', font_family: 'Playfair Display', button_style: 'rounded' } },
  { name: 'Nocturno', description: 'Sobrio y contrastado', values: { bg_color: '#0F172A', text_color: '#F8FAFC', accent_color: '#2DD4BF', font_family: 'Space Grotesk', button_style: 'pill' } },
];

const ACCENTS = ['#047857', '#0369A1', '#6D28D9', '#BE185D', '#B45309', '#B91C1C', '#0E7490'];
const HEX = /^#[0-9A-Fa-f]{6}$/;

function luminance(hex: string) {
  const values = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

export function contrastRatio(foreground: string, background: string) {
  if (!HEX.test(foreground) || !HEX.test(background)) return 0;
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

export function automaticButtonForeground(background: string) {
  return contrastRatio('#FFFFFF', background) >= contrastRatio('#0F172A', background) ? '#FFFFFF' : '#0F172A';
}

async function validateImage(file: File, slot: 'logo' | 'background') {
  const max = slot === 'logo' ? 2 * 1024 * 1024 : 6 * 1024 * 1024;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Usa una imagen JPG, PNG o WebP.');
  if (file.size <= 0 || file.size > max) throw new Error(slot === 'logo' ? 'El logo debe pesar hasta 2 MiB.' : 'El fondo debe pesar hasta 6 MiB.');
  const url = URL.createObjectURL(file);
  try {
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new window.Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      image.src = url;
    });
    if (slot === 'logo' && (dimensions.width > 4096 || dimensions.height > 4096)) throw new Error('El logo no puede superar 4096 px por lado.');
    if (slot === 'background' && (dimensions.width > 6000 || dimensions.height > 6000 || (dimensions.width < 800 && dimensions.height < 800) || (dimensions.width < 450 && dimensions.height < 450))) throw new Error('El fondo debe medir al menos 800×450 y hasta 6000 px por lado.');
  } finally { URL.revokeObjectURL(url); }
}

export default function SurveyDesignEditor({ survey, saving, onSave, onDirtyChange }: {
  survey: Survey;
  saving: boolean;
  onSave: (branding: SurveyBranding, media: DesignMediaDraft) => Promise<boolean>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const objectURLs = useRef<string[]>([]);
  const [width, setWidth] = useState(0);
  const [pane, setPane] = useState<EditorPane>('config');
  const [screen, setScreen] = useState<PreviewScreen>('welcome');
  const [mobilePreview, setMobilePreview] = useState(false);
  const [branding, setBranding] = useState<SurveyBranding>(survey.branding || {});
  const [dirty, setDirty] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [backgroundFile, setBackgroundFile] = useState<File | null>(null);
  const [logoRemoved, setLogoRemoved] = useState(false);
  const [backgroundRemoved, setBackgroundRemoved] = useState(false);
  const [logoPreview, setLogoPreview] = useState(survey.branding?.logo_url || '');
  const [backgroundPreview, setBackgroundPreview] = useState(survey.branding?.bg_image_url || '');
  const [mediaError, setMediaError] = useState('');

  const compact = width > 0 && width < 920;
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width || 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (dirty) return;
    setBranding(survey.branding || {});
    setLogoPreview(survey.branding?.logo_url || '');
    setBackgroundPreview(survey.branding?.bg_image_url || '');
  }, [dirty, survey.branding]);
  useEffect(() => () => { onDirtyChange?.(false); objectURLs.current.forEach(URL.revokeObjectURL); }, [onDirtyChange]);

  const update = (key: keyof SurveyBranding, value: string) => { setBranding(current => ({ ...current, [key]: value })); setDirty(true); };
  const pickImage = async (slot: 'logo' | 'background', file?: File) => {
    if (!file) return;
    setMediaError('');
    try {
      await validateImage(file, slot);
      const preview = URL.createObjectURL(file);
      objectURLs.current.push(preview);
      if (slot === 'logo') { setLogoFile(file); setLogoRemoved(false); setLogoPreview(preview); }
      else { setBackgroundFile(file); setBackgroundRemoved(false); setBackgroundPreview(preview); }
      setDirty(true);
    } catch (error) { setMediaError(error instanceof Error ? error.message : 'No se pudo validar la imagen.'); }
  };
  const removeImage = (slot: 'logo' | 'background') => {
    if (slot === 'logo') { setLogoFile(null); setLogoRemoved(true); setLogoPreview(''); setBranding(current => ({ ...current, logo_url: '', logo_media_asset_id: undefined })); }
    else { setBackgroundFile(null); setBackgroundRemoved(true); setBackgroundPreview(''); setBranding(current => ({ ...current, bg_image_url: '', bg_image_media_asset_id: undefined })); }
    setDirty(true);
  };
  const reset = () => {
    setBranding(survey.branding || {}); setLogoFile(null); setBackgroundFile(null); setLogoRemoved(false); setBackgroundRemoved(false);
    setLogoPreview(survey.branding?.logo_url || ''); setBackgroundPreview(survey.branding?.bg_image_url || ''); setMediaError(''); setDirty(false);
  };
  const save = async () => {
    const original = survey.branding || {};
    const logoAction = logoFile ? 'upload' : logoRemoved ? 'remove' : branding.logo_url !== original.logo_url ? 'external' : 'keep';
    const backgroundAction = backgroundFile ? 'upload' : backgroundRemoved ? 'remove' : branding.bg_image_url !== original.bg_image_url ? 'external' : 'keep';
    const saved = await onSave(branding, { logoFile, backgroundFile, logoAction, backgroundAction });
    if (saved) { setDirty(false); setLogoFile(null); setBackgroundFile(null); setLogoRemoved(false); setBackgroundRemoved(false); }
  };

  const fontFamily = branding.font_family || 'Inter';
  const titleSize = branding.title_size || 'lg';
  const accent = HEX.test(branding.accent_color || '') ? branding.accent_color! : '#047857';
  const background = HEX.test(branding.bg_color || '') ? branding.bg_color! : '#FFFFFF';
  const text = HEX.test(branding.text_color || '') ? branding.text_color! : '#0F172A';
  const foreground = automaticButtonForeground(accent);
  const titlePx = TITLE_SIZE_OPTIONS.find(option => option.value === titleSize)?.px || '2.25rem';
  const buttonClass = BUTTON_STYLE_OPTIONS.find(option => option.value === (branding.button_style || 'rounded'))?.className || 'rounded-lg';
  const alignment = branding.question_align === 'center' ? 'text-center' : 'text-left';
  const logoHeight = branding.logo_size === 'sm' ? 'h-7' : branding.logo_size === 'lg' ? 'h-14' : 'h-10';
  const fontUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}:wght@400;500;600;700&display=swap`;
  const contrast = contrastRatio(foreground, accent);
  const invalidColor = [branding.accent_color, branding.bg_color, branding.text_color].some(value => value && !HEX.test(value));

  const preview = useMemo(() => (
    <div className={`relative flex min-h-[32rem] w-full flex-col overflow-hidden rounded-[1.25rem] border border-black/10 shadow-2xl ${mobilePreview ? 'max-w-[23.5rem]' : 'max-w-[43rem]'}`} style={{ backgroundColor: background, color: text, fontFamily: `'${fontFamily}', sans-serif` }}>
      {backgroundPreview && <><img src={backgroundPreview} alt="" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: branding.bg_position || 'center' }} /><div className="absolute inset-0 bg-black" style={{ opacity: Number(branding.bg_overlay || 0) }} /></>}
      <div className={`relative z-10 flex min-h-[32rem] flex-1 flex-col px-7 py-8 sm:px-10 sm:py-10 ${alignment}`}>
        {logoPreview && <img src={logoPreview} alt="Vista previa del logo" className={`${logoHeight} mb-8 max-w-[65%] object-contain ${alignment === 'text-center' ? 'mx-auto' : ''}`} />}
        {screen === 'welcome' && <div className="my-auto"><p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] opacity-45">Bienvenida</p><h2 className="font-bold leading-[1.08]" style={{ fontSize: titlePx }}>{survey.welcome_title || survey.name || 'Título de la encuesta'}</h2><p className="mt-4 max-w-xl text-base leading-7 opacity-65">{survey.welcome_description || 'Una introducción breve prepara a las personas antes de comenzar.'}</p><button type="button" className={`mt-8 min-h-12 px-6 font-semibold shadow-sm ${buttonClass}`} style={{ backgroundColor: accent, color: foreground }}>Comenzar →</button></div>}
        {screen === 'question' && <div className="my-auto"><div className="mb-9 h-1 overflow-hidden rounded-full bg-black/10"><div className="h-full w-1/3 transition-[width] duration-200 motion-reduce:transition-none" style={{ backgroundColor: accent }} /></div><p className="mb-3 text-xs font-semibold opacity-45">1 / 3</p><h2 className="font-bold leading-tight" style={{ fontSize: `clamp(1.55rem, ${titlePx}, 2.4rem)` }}>¿Cuál es tu nombre?</h2><div className="mt-8 border-b-2 pb-3 text-sm opacity-45" style={{ borderColor: `${accent}66` }}>Escribe tu respuesta…</div><button type="button" className={`mt-8 min-h-12 px-5 font-semibold shadow-sm ${buttonClass}`} style={{ backgroundColor: accent, color: foreground }}>Siguiente →</button></div>}
        {screen === 'thanks' && <div className="my-auto"><span className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full text-2xl font-bold" style={{ backgroundColor: `${accent}1F`, color: accent }}>✓</span><h2 className="font-bold leading-tight" style={{ fontSize: titlePx }}>{survey.thank_you_title || '¡Gracias por responder!'}</h2><p className="mt-4 text-base leading-7 opacity-65">{survey.thank_you_message || 'Tu respuesta se envió correctamente.'}</p><button type="button" className={`mt-8 min-h-12 px-6 font-semibold shadow-sm ${buttonClass}`} style={{ backgroundColor: accent, color: foreground }}>{survey.thank_you_redirect_url ? 'Continuar →' : 'Cerrar'}</button></div>}
      </div>
    </div>
  ), [accent, alignment, background, backgroundPreview, branding.bg_overlay, branding.bg_position, buttonClass, fontFamily, foreground, logoHeight, logoPreview, mobilePreview, screen, survey.name, survey.thank_you_message, survey.thank_you_redirect_url, survey.thank_you_title, survey.welcome_description, survey.welcome_title, text, titlePx]);

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col bg-slate-100/70">
      <link href={fontUrl} rel="stylesheet" />
      {compact && <div className="grid shrink-0 grid-cols-2 border-b border-slate-200 bg-white p-2"><button type="button" onClick={() => setPane('config')} className={`min-h-10 rounded-lg text-sm font-semibold ${pane === 'config' ? 'bg-slate-100 text-slate-900' : 'text-slate-500'}`}>Configurar</button><button type="button" onClick={() => setPane('preview')} className={`min-h-10 rounded-lg text-sm font-semibold ${pane === 'preview' ? 'bg-slate-100 text-slate-900' : 'text-slate-500'}`}>Vista previa</button></div>}
      <div className="flex min-h-0 flex-1">
        <aside className={`${compact ? pane === 'config' ? 'flex flex-1' : 'hidden' : 'flex w-[23rem] shrink-0 border-r'} min-h-0 flex-col bg-white`}>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 pb-5 sm:p-5">
            <div><h2 className="text-lg font-semibold text-slate-900">Diseño</h2><p className="mt-1 text-sm leading-5 text-slate-500">Configura una experiencia accesible y coherente. La vista previa refleja el formulario real.</p></div>
            <Section title="Temas"><div className="grid gap-2">{THEMES.map(theme => <button key={theme.name} type="button" onClick={() => { setBranding(current => ({ ...current, ...theme.values })); setDirty(true); }} className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-200 p-3 text-left hover:border-emerald-300"><span className="flex h-8 w-8 overflow-hidden rounded-lg border border-black/10"><i className="h-full w-1/2" style={{ background: theme.values.bg_color }} /><i className="h-full w-1/2" style={{ background: theme.values.accent_color }} /></span><span><span className="block text-sm font-semibold text-slate-800">{theme.name}</span><span className="block text-xs text-slate-500">{theme.description}</span></span></button>)}</div></Section>
            <Section title="Tipografía"><div className="grid grid-cols-2 gap-2">{FONT_OPTIONS.map(option => <button key={option.value} type="button" onClick={() => update('font_family', option.value)} className={`min-h-10 truncate rounded-lg border px-2 text-left text-xs ${fontFamily === option.value ? 'border-emerald-500 bg-emerald-50 font-semibold text-emerald-800' : 'border-slate-200 text-slate-600'}`} style={{ fontFamily: option.value }}>{option.label}</button>)}</div><Segmented label="Tamaño del título" value={titleSize} options={TITLE_SIZE_OPTIONS.map(option => [option.value, option.label])} onChange={value => update('title_size', value)} /></Section>
            <Section title="Colores y contraste"><ColorField label="Acento" value={branding.accent_color || '#047857'} onChange={value => update('accent_color', value)} presets={ACCENTS} /><ColorField label="Fondo" value={branding.bg_color || '#FFFFFF'} onChange={value => update('bg_color', value)} /><ColorField label="Texto" value={branding.text_color || '#0F172A'} onChange={value => update('text_color', value)} /><div className={`rounded-xl p-3 text-xs ${contrast >= 4.5 ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}><p className="font-semibold">Contraste automático del botón: {contrast.toFixed(1)}:1</p><p className="mt-1 opacity-80">Texto {foreground === '#FFFFFF' ? 'blanco' : 'oscuro'} · {contrast >= 4.5 ? 'Cumple AA' : 'Conviene elegir otro acento'}</p></div></Section>
            <Section title="Botones"><Segmented value={branding.button_style || 'rounded'} options={BUTTON_STYLE_OPTIONS.map(option => [option.value, option.label])} onChange={value => update('button_style', value)} /></Section>
            <Section title="Alineación"><Segmented value={branding.question_align || 'left'} options={[['left', 'Izquierda'], ['center', 'Centrada']]} onChange={value => update('question_align', value)} /></Section>
            <Section title="Marca e imágenes"><ImageDropZone label="Logo" hint="JPG, PNG o WebP · máx. 2 MiB y 4096 px" preview={logoPreview} onFile={file => void pickImage('logo', file)} onRemove={() => removeImage('logo')} /><Segmented label="Tamaño del logo" value={branding.logo_size || 'md'} options={[['sm', 'Pequeño'], ['md', 'Mediano'], ['lg', 'Grande']]} onChange={value => update('logo_size', value)} /><ImageDropZone label="Fondo" hint="JPG, PNG o WebP · 800×450 a 6000 px · máx. 6 MiB" preview={backgroundPreview} onFile={file => void pickImage('background', file)} onRemove={() => removeImage('background')} /><Segmented label="Posición focal" value={branding.bg_position || 'center'} options={[['top', 'Arriba'], ['center', 'Centro'], ['bottom', 'Abajo']]} onChange={value => update('bg_position', value)} />{backgroundPreview && <Segmented label="Oscurecer fondo" value={branding.bg_overlay || '0'} options={[['0', '0%'], ['0.2', '20%'], ['0.4', '40%'], ['0.6', '60%']]} onChange={value => update('bg_overlay', value)} />}
              <details className="rounded-xl border border-slate-200"><summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-semibold text-slate-700">Opciones avanzadas: URL externa</summary><div className="space-y-3 border-t border-slate-100 p-3"><label className="block text-xs font-medium text-slate-600">URL del logo<input value={branding.logo_url || ''} onChange={event => { update('logo_url', event.target.value); setLogoFile(null); setLogoRemoved(false); setLogoPreview(event.target.value); }} placeholder="https://" className="mt-1 min-h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" /></label><label className="block text-xs font-medium text-slate-600">URL del fondo<input value={branding.bg_image_url || ''} onChange={event => { update('bg_image_url', event.target.value); setBackgroundFile(null); setBackgroundRemoved(false); setBackgroundPreview(event.target.value); }} placeholder="https://" className="mt-1 min-h-10 w-full rounded-lg border border-slate-200 px-3 text-sm" /></label></div></details>
            </Section>
            {mediaError && <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700" role="alert">{mediaError}</p>}
          </div>
          <footer className="sticky bottom-0 z-10 shrink-0 border-t border-slate-200 bg-white/95 p-3 pb-[max(.75rem,env(safe-area-inset-bottom))] backdrop-blur"><div className="mb-2 flex items-center justify-between text-xs"><span className={dirty ? 'font-medium text-amber-700' : 'text-slate-400'}>{dirty ? 'Cambios sin guardar' : 'Diseño guardado'}</span>{invalidColor && <span className="text-rose-600">Revisa los colores</span>}</div><div className="flex gap-2"><button type="button" onClick={reset} disabled={!dirty || saving} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 disabled:opacity-40"><RotateCcw className="h-4 w-4" />Restablecer</button><button type="button" onClick={() => void save()} disabled={!dirty || saving || invalidColor} className="inline-flex min-h-11 flex-[1.3] items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 text-sm font-semibold text-white disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Guardar diseño</button></div></footer>
        </aside>
        <section className={`${compact ? pane === 'preview' ? 'flex' : 'hidden' : 'flex'} min-h-0 flex-1 flex-col`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2"><div className="flex rounded-xl bg-slate-100 p-1">{([['welcome', 'Bienvenida'], ['question', 'Pregunta'], ['thanks', 'Gracias']] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setScreen(value)} className={`min-h-9 rounded-lg px-3 text-xs font-semibold ${screen === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>{label}</button>)}</div><div className="flex rounded-xl border border-slate-200 bg-white p-1"><button type="button" onClick={() => setMobilePreview(false)} className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg ${!mobilePreview ? 'bg-slate-100 text-slate-900' : 'text-slate-400'}`} aria-label="Vista de escritorio"><Monitor className="h-4 w-4" /></button><button type="button" onClick={() => setMobilePreview(true)} className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg ${mobilePreview ? 'bg-slate-100 text-slate-900' : 'text-slate-400'}`} aria-label="Vista móvil"><Smartphone className="h-4 w-4" /></button></div></div>
          <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-4 sm:p-8">{preview}</div>
        </section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4"><h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">{title}</h3>{children}</section>; }
function Segmented({ label, value, options, onChange }: { label?: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void }) { return <div>{label && <p className="mb-2 text-xs font-medium text-slate-600">{label}</p>}<div className="flex flex-wrap gap-1.5">{options.map(([option, text]) => <button key={option} type="button" onClick={() => onChange(option)} className={`min-h-9 flex-1 rounded-lg border px-2 text-xs font-semibold ${value === option ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-600'}`}>{text}</button>)}</div></div>; }
function ColorField({ label, value, onChange, presets = [] }: { label: string; value: string; onChange: (value: string) => void; presets?: string[] }) { const valid = HEX.test(value); return <div><label className="text-xs font-medium text-slate-600">{label}</label>{presets.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{presets.map(color => <button key={color} type="button" onClick={() => onChange(color)} className={`h-7 w-7 rounded-full border-2 ${value.toUpperCase() === color ? 'border-slate-900 ring-2 ring-slate-200' : 'border-white ring-1 ring-slate-200'}`} style={{ background: color }} aria-label={`Usar ${color}`} />)}</div>}<div className="mt-2 flex items-center gap-2"><input type="color" value={valid ? value : '#000000'} onChange={event => onChange(event.target.value.toUpperCase())} className="h-10 w-10 rounded-lg border border-slate-200 bg-white p-1" /><input value={value} onChange={event => onChange(event.target.value.toUpperCase())} maxLength={7} className={`min-h-10 min-w-0 flex-1 rounded-lg border px-3 font-mono text-xs ${valid ? 'border-slate-200' : 'border-rose-300 text-rose-700'}`} /></div></div>; }
function ImageDropZone({ label, hint, preview, onFile, onRemove }: { label: string; hint: string; preview: string; onFile: (file?: File) => void; onRemove: () => void }) { return <div><div className="mb-2 flex items-center justify-between"><div><p className="text-xs font-semibold text-slate-700">{label}</p><p className="mt-0.5 text-[11px] leading-4 text-slate-400">{hint}</p></div>{preview && <button type="button" onClick={onRemove} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-rose-600"><X className="h-3.5 w-3.5" />Quitar</button>}</div><label onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); onFile(event.dataTransfer.files[0]); }} className="flex min-h-28 cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-slate-50 text-center hover:border-emerald-400 hover:bg-emerald-50/40">{preview ? <img src={preview} alt={`Vista previa de ${label.toLowerCase()}`} className="max-h-32 max-w-full object-contain p-3" /> : <span className="p-4"><UploadCloud className="mx-auto h-6 w-6 text-slate-400" /><span className="mt-2 block text-xs font-semibold text-slate-600">Arrastra o selecciona</span></span>}<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={event => onFile(event.target.files?.[0])} /></label>{!preview && <p className="mt-2 flex items-center gap-1 text-[11px] text-slate-400"><ImageIcon className="h-3.5 w-3.5" />La validación del servidor comprueba el contenido real.</p>}</div>; }
