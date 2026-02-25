"use client";

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Users, Calendar, MessageSquare, Plus, Check, X, Clock,
  AlertCircle, Trash2, GraduationCap, MapPin, CalendarDays, Send,
  Repeat, ChevronRight, CheckCircle2, XCircle, Phone
} from 'lucide-react';
import { api } from '@/lib/api';
import { Program, ProgramParticipant, ProgramSession, ProgramAttendance } from '@/types/program';
import ContactSelector, { SelectedPerson } from '@/components/ContactSelector';
import CreateCampaignModal, { CampaignFormResult } from '@/components/CreateCampaignModal';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

const token = () => typeof window !== 'undefined' ? localStorage.getItem('token') || '' : '';

interface Device {
  id: string;
  name: string;
  phone: string | null;
  status: string;
}

const DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const DAY_NAMES_FULL = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export default function ProgramDetailPage() {
  const params = useParams();
  const router = useRouter();
  const programId = params.id as string;

  const [program, setProgram] = useState<Program | null>(null);
  const [participants, setParticipants] = useState<ProgramParticipant[]>([]);
  const [sessions, setSessions] = useState<ProgramSession[]>([]);
  const [activeTab, setActiveTab] = useState<'participants' | 'sessions'>('participants');
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState<Device[]>([]);

  // Modals state
  const [isAddParticipantOpen, setIsAddParticipantOpen] = useState(false);
  const [isCreateSessionOpen, setIsCreateSessionOpen] = useState(false);
  const [isAttendanceOpen, setIsAttendanceOpen] = useState(false);
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [isGenerateSessionsOpen, setIsGenerateSessionsOpen] = useState(false);

  // Form state
  const [newSession, setNewSession] = useState({ date: new Date().toISOString().split('T')[0], topic: '', start_time: '', end_time: '', location: '' });
  const [selectedSession, setSelectedSession] = useState<ProgramSession | null>(null);
  const [attendanceData, setAttendanceData] = useState<Record<string, { status: string, notes: string }>>({});

  // Campaign state
  const [creatingCampaign, setCreatingCampaign] = useState(false);

  // Generate sessions form
  const [genForm, setGenForm] = useState({
    start_date: new Date().toISOString().split('T')[0],
    end_date: '',
    days_of_week: [] as number[],
    start_time: '09:00',
    end_time: '10:00',
    topic_prefix: 'Sesión',
    location: '',
  });
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (programId) {
      fetchProgramData();
      fetchDevices();
    }
  }, [programId]);

  const fetchProgramData = async () => {
    try {
      setLoading(true);
      const [progRes, partsRes, sessRes] = await Promise.all([
        api<Program>(`/api/programs/${programId}`),
        api<ProgramParticipant[]>(`/api/programs/${programId}/participants`),
        api<ProgramSession[]>(`/api/programs/${programId}/sessions`)
      ]);

      if (progRes.success) setProgram(progRes.data || null);
      if (partsRes.success) setParticipants(partsRes.data || []);
      if (sessRes.success) setSessions(sessRes.data || []);
    } catch (error) {
      console.error('Error fetching program data:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchDevices = async () => {
    try {
      const res = await fetch('/api/devices', { headers: { Authorization: `Bearer ${token()}` } });
      const data = await res.json();
      if (data.success) setDevices((data.devices || []).filter((d: Device) => d.status === 'connected'));
    } catch (e) { console.error(e); }
  };

  const handleAddParticipants = async (selected: SelectedPerson[]) => {
    try {
      for (const person of selected) {
        await api(`/api/programs/${programId}/participants`, {
          method: 'POST',
          body: JSON.stringify({
            contact_id: person.source_type === 'contact' ? person.id : null,
            lead_id: person.source_type === 'lead' ? person.id : null,
            status: 'active'
          })
        });
      }
      setIsAddParticipantOpen(false);
      fetchProgramData();
    } catch (error) {
      console.error('Error adding participants:', error);
    }
  };

  const handleRemoveParticipant = async (participantId: string) => {
    if (!confirm('¿Estás seguro de eliminar a este participante?')) return;
    try {
      await api(`/api/programs/${programId}/participants/${participantId}`, { method: 'DELETE' });
      fetchProgramData();
    } catch (error) {
      console.error('Error removing participant:', error);
    }
  };

  const handleCreateSession = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/programs/${programId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          ...newSession,
          start_time: newSession.start_time || undefined,
          end_time: newSession.end_time || undefined,
          location: newSession.location || undefined,
        })
      });
      setIsCreateSessionOpen(false);
      setNewSession({ date: new Date().toISOString().split('T')[0], topic: '', start_time: '', end_time: '', location: '' });
      fetchProgramData();
    } catch (error) {
      console.error('Error creating session:', error);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!confirm('¿Estás seguro de eliminar esta sesión?')) return;
    try {
      await api(`/api/programs/${programId}/sessions/${sessionId}`, { method: 'DELETE' });
      fetchProgramData();
    } catch (error) {
      console.error('Error deleting session:', error);
    }
  };

  const openAttendance = async (session: ProgramSession) => {
    setSelectedSession(session);
    try {
      const response = await api<ProgramAttendance[]>(`/api/programs/${programId}/sessions/${session.id}/attendance`);
      const attMap: Record<string, { status: string, notes: string }> = {};

      if (response.success && response.data && Array.isArray(response.data)) {
        response.data.forEach((a: ProgramAttendance) => {
          attMap[a.participant_id] = { status: a.status, notes: a.notes || '' };
        });
      }

      setAttendanceData(attMap);
      setIsAttendanceOpen(true);
    } catch (error) {
      console.error('Error fetching attendance:', error);
    }
  };

  const saveAttendance = async () => {
    if (!selectedSession) return;
    try {
      for (const [participantId, data] of Object.entries(attendanceData)) {
        if (!data.status) continue;
        await api(`/api/programs/${programId}/sessions/${selectedSession.id}/attendance`, {
          method: 'POST',
          body: JSON.stringify({
            participant_id: participantId,
            status: data.status,
            notes: data.notes
          })
        });
      }
      setIsAttendanceOpen(false);
      fetchProgramData();
    } catch (error) {
      console.error('Error saving attendance:', error);
    }
  };

  // Generate Sessions
  const handleGenerateSessions = async () => {
    if (!genForm.start_date || !genForm.end_date || genForm.days_of_week.length === 0) {
      alert('Completa la fecha de inicio, fin y al menos un día de la semana.');
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch(`/api/programs/${programId}/sessions/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...genForm,
          location: genForm.location || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        alert(`Se generaron ${data.count} sesiones exitosamente.`);
        setIsGenerateSessionsOpen(false);
        fetchProgramData();
      } else {
        alert(data.error || 'Error al generar sesiones');
      }
    } catch (e) {
      console.error(e);
      alert('Error de conexión');
    } finally {
      setGenerating(false);
    }
  };

  const toggleGenDay = (day: number) => {
    setGenForm(prev => ({
      ...prev,
      days_of_week: prev.days_of_week.includes(day)
        ? prev.days_of_week.filter(d => d !== day)
        : [...prev.days_of_week, day].sort()
    }));
  };

  // Campaign
  const participantsWithPhone = useMemo(
    () => participants.filter(p => p.contact_phone && p.contact_phone.length > 5),
    [participants]
  );

  const handleCreateCampaign = async (formResult: CampaignFormResult) => {
    setCreatingCampaign(true);
    try {
      const res = await fetch(`/api/programs/${programId}/campaign`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formResult.name,
          device_id: formResult.device_id,
          message_template: formResult.message_template,
          attachments: formResult.attachments,
          scheduled_at: formResult.scheduled_at || undefined,
          settings: formResult.settings,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (formResult.scheduled_at && data.campaign) {
          await fetch(`/api/campaigns/${data.campaign.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'scheduled', scheduled_at: formResult.scheduled_at }),
          });
        }
        alert(`Campaña creada con ${data.recipients_count} destinatarios. Puedes verla e iniciarla en Envíos Masivos.`);
        setShowCampaignModal(false);
      } else {
        alert(data.error || 'Error al crear campaña');
      }
    } catch (e) {
      console.error(e);
      alert('Error de conexión');
    }
    setCreatingCampaign(false);
  };

  // Preview sessions count
  const previewSessionCount = useMemo(() => {
    if (!genForm.start_date || !genForm.end_date || genForm.days_of_week.length === 0) return 0;
    const start = new Date(genForm.start_date + 'T00:00:00');
    const end = new Date(genForm.end_date + 'T00:00:00');
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return 0;
    let count = 0;
    const current = new Date(start);
    while (current <= end) {
      if (genForm.days_of_week.includes(current.getDay())) count++;
      current.setDate(current.getDate() + 1);
    }
    return count;
  }, [genForm.start_date, genForm.end_date, genForm.days_of_week]);

  if (loading) {
    return (
      <div className="p-6 lg:p-8 max-w-7xl mx-auto">
        <div className="animate-pulse space-y-6">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-slate-200 rounded-full" />
            <div className="w-12 h-12 bg-slate-200 rounded-xl" />
            <div className="flex-1">
              <div className="h-6 bg-slate-200 rounded w-1/3 mb-2" />
              <div className="h-4 bg-slate-100 rounded w-1/2" />
            </div>
          </div>
          <div className="h-12 bg-slate-100 rounded-xl" />
          <div className="h-96 bg-slate-100 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!program) {
    return (
      <div className="p-6 text-center pt-20">
        <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
          <GraduationCap className="w-8 h-8 text-slate-400" />
        </div>
        <h2 className="text-xl font-bold text-slate-800 mb-2">Programa no encontrado</h2>
        <button onClick={() => router.push('/dashboard/programs')} className="mt-2 text-emerald-600 hover:underline font-medium">
          Volver a Programas
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => router.push('/dashboard/programs')}
          className="p-2 hover:bg-slate-100 rounded-xl transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-slate-600" />
        </button>
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-xl shadow-sm"
          style={{ backgroundColor: program.color || '#10b981' }}
        >
          {program.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-slate-800 truncate">{program.name}</h1>
          <p className="text-slate-500 text-sm truncate">{program.description || 'Sin descripción'}</p>
        </div>
        <button
          onClick={() => setShowCampaignModal(true)}
          disabled={participantsWithPhone.length === 0}
          className="hidden sm:flex items-center gap-2 px-4 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send className="w-4 h-4" />
          Envío Masivo
        </button>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-purple-50 flex items-center justify-center">
            <Users className="w-4 h-4 text-purple-600" />
          </div>
          <div>
            <p className="text-lg font-bold text-slate-800">{participants.length}</p>
            <p className="text-xs text-slate-500">Participantes</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center">
            <Calendar className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <p className="text-lg font-bold text-slate-800">{sessions.length}</p>
            <p className="text-xs text-slate-500">Sesiones</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center">
            <Phone className="w-4 h-4 text-emerald-600" />
          </div>
          <div>
            <p className="text-lg font-bold text-slate-800">{participantsWithPhone.length}</p>
            <p className="text-xs text-slate-500">Con teléfono</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center">
            <CheckCircle2 className="w-4 h-4 text-amber-600" />
          </div>
          <div>
            <p className="text-lg font-bold text-slate-800">
              {sessions.reduce((sum, s) => sum + (s.attendance_stats?.present || 0), 0)}
            </p>
            <p className="text-xs text-slate-500">Asistencias</p>
          </div>
        </div>
      </div>

      {/* Mobile campaign button */}
      <button
        onClick={() => setShowCampaignModal(true)}
        disabled={participantsWithPhone.length === 0}
        className="sm:hidden w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Send className="w-4 h-4" />
        Envío Masivo ({participantsWithPhone.length} destinatarios)
      </button>

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
        <button
          onClick={() => setActiveTab('participants')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all ${
            activeTab === 'participants'
              ? 'bg-white text-slate-800 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          <Users className="w-4 h-4" />
          Participantes ({participants.length})
        </button>
        <button
          onClick={() => setActiveTab('sessions')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all ${
            activeTab === 'sessions'
              ? 'bg-white text-slate-800 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          <Calendar className="w-4 h-4" />
          Sesiones ({sessions.length})
        </button>
      </div>

      {/* Content */}
      {activeTab === 'participants' ? (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold text-slate-800">Lista de Participantes</h2>
            <button
              onClick={() => setIsAddParticipantOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all text-sm font-medium shadow-sm"
            >
              <Plus className="w-4 h-4" />
              Agregar
            </button>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <div className="max-h-[calc(100vh-420px)] overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 sticky top-0 z-10">
                    <tr>
                      <th className="px-5 py-3 font-medium">Nombre</th>
                      <th className="px-5 py-3 font-medium">Teléfono</th>
                      <th className="px-5 py-3 font-medium">Estado</th>
                      <th className="px-5 py-3 font-medium">Inscripción</th>
                      <th className="px-5 py-3 font-medium text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {participants.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-5 py-12 text-center">
                          <Users className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                          <p className="text-slate-500 font-medium">Sin participantes</p>
                          <p className="text-slate-400 text-xs mt-1">Agrega participantes para comenzar</p>
                        </td>
                      </tr>
                    ) : (
                      participants.map((p) => (
                        <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 font-medium text-xs">
                                {(p.contact_name || '?').charAt(0).toUpperCase()}
                              </div>
                              <span className="font-medium text-slate-800">{p.contact_name || 'Sin nombre'}</span>
                            </div>
                          </td>
                          <td className="px-5 py-3 text-slate-600 font-mono text-xs">
                            {p.contact_phone || <span className="text-slate-400 italic">Sin teléfono</span>}
                          </td>
                          <td className="px-5 py-3">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                              p.status === 'active' ? 'bg-emerald-50 text-emerald-700' :
                              p.status === 'completed' ? 'bg-blue-50 text-blue-700' :
                              'bg-red-50 text-red-700'
                            }`}>
                              {p.status === 'active' ? 'Activo' : p.status === 'completed' ? 'Completado' : 'Retirado'}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-slate-500 text-xs">
                            {format(new Date(p.enrolled_at), 'dd MMM yyyy', { locale: es })}
                          </td>
                          <td className="px-5 py-3 text-right">
                            <button
                              onClick={() => handleRemoveParticipant(p.id)}
                              className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500 transition-all"
                              title="Eliminar participante"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-800">Sesiones y Asistencia</h2>
            <div className="flex gap-2">
              <button
                onClick={() => setIsGenerateSessionsOpen(true)}
                className="flex items-center gap-2 px-4 py-2 border border-emerald-200 text-emerald-700 bg-emerald-50 rounded-xl hover:bg-emerald-100 transition-all text-sm font-medium"
              >
                <Repeat className="w-4 h-4" />
                Generar Horario
              </button>
              <button
                onClick={() => setIsCreateSessionOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all text-sm font-medium shadow-sm"
              >
                <Plus className="w-4 h-4" />
                Nueva Sesión
              </button>
            </div>
          </div>

          {sessions.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-2xl border border-slate-200">
              <div className="w-16 h-16 rounded-2xl bg-blue-50 flex items-center justify-center mx-auto mb-4">
                <Calendar className="w-8 h-8 text-blue-400" />
              </div>
              <h3 className="text-lg font-semibold text-slate-800 mb-2">Sin sesiones programadas</h3>
              <p className="text-slate-500 mb-5 max-w-md mx-auto text-sm">
                Crea sesiones individuales o genera un horario recurrente estilo Google Calendar.
              </p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => setIsGenerateSessionsOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 border border-emerald-200 text-emerald-700 bg-emerald-50 rounded-xl hover:bg-emerald-100 transition-all text-sm font-medium"
                >
                  <Repeat className="w-4 h-4" />
                  Generar Horario
                </button>
                <button
                  onClick={() => setIsCreateSessionOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all text-sm font-medium shadow-sm"
                >
                  <Plus className="w-4 h-4" />
                  Sesión Individual
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {sessions.map((session, idx) => {
                const totalAtt = (session.attendance_stats?.present || 0) + (session.attendance_stats?.absent || 0) + (session.attendance_stats?.late || 0) + (session.attendance_stats?.excused || 0);
                const isPast = new Date(session.date) < new Date();
                return (
                  <div
                    key={session.id}
                    className={`bg-white rounded-xl border border-slate-200 p-4 hover:shadow-md transition-all group ${isPast ? 'opacity-80' : ''}`}
                  >
                    <div className="flex items-center gap-4">
                      {/* Session number & date */}
                      <div className="hidden sm:flex flex-col items-center justify-center w-14 h-14 rounded-xl bg-slate-50 border border-slate-100 shrink-0">
                        <span className="text-xs text-slate-400 font-medium uppercase">
                          {format(new Date(session.date), 'MMM', { locale: es })}
                        </span>
                        <span className="text-lg font-bold text-slate-800 -mt-0.5">
                          {format(new Date(session.date), 'dd')}
                        </span>
                      </div>

                      {/* Session info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <h3 className="font-semibold text-slate-800 truncate">
                            {session.topic || `Sesión ${idx + 1}`}
                          </h3>
                          {isPast && totalAtt === 0 && (
                            <span className="text-xs px-2 py-0.5 bg-amber-50 text-amber-600 rounded-full shrink-0">
                              Sin registrar
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                          <span className="flex items-center gap-1">
                            <CalendarDays className="w-3 h-3" />
                            {format(new Date(session.date), "EEEE, d 'de' MMMM", { locale: es })}
                          </span>
                          {session.start_time && (
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {session.start_time}{session.end_time ? ` - ${session.end_time}` : ''}
                            </span>
                          )}
                          {session.location && (
                            <span className="flex items-center gap-1">
                              <MapPin className="w-3 h-3" />
                              {session.location}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Attendance stats */}
                      <div className="hidden md:flex items-center gap-1.5 text-xs shrink-0">
                        {totalAtt > 0 ? (
                          <>
                            <div className="flex items-center gap-0.5 text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg" title="Presentes">
                              <Check className="w-3 h-3" /> {session.attendance_stats?.present || 0}
                            </div>
                            <div className="flex items-center gap-0.5 text-red-600 bg-red-50 px-2 py-1 rounded-lg" title="Ausentes">
                              <X className="w-3 h-3" /> {session.attendance_stats?.absent || 0}
                            </div>
                            <div className="flex items-center gap-0.5 text-amber-600 bg-amber-50 px-2 py-1 rounded-lg" title="Tardes">
                              <Clock className="w-3 h-3" /> {session.attendance_stats?.late || 0}
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-400 px-2 py-1 bg-slate-50 rounded-lg">Sin asistencia</span>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => openAttendance(session)}
                          className="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors text-xs font-medium"
                        >
                          Asistencia
                        </button>
                        <button
                          onClick={() => handleDeleteSession(session.id)}
                          className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all hover:bg-red-50 text-slate-400 hover:text-red-500"
                          title="Eliminar sesión"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* =================== MODALS =================== */}

      {/* Add Participant Modal */}
      {isAddParticipantOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-slate-800">Agregar Participantes</h2>
              <button onClick={() => setIsAddParticipantOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-[400px]">
              <ContactSelector
                open={isAddParticipantOpen}
                onClose={() => setIsAddParticipantOpen(false)}
                onConfirm={handleAddParticipants}
                title="Agregar Participantes"
                confirmLabel="Agregar Seleccionados"
              />
            </div>
          </div>
        </div>
      )}

      {/* Create Session Modal */}
      {isCreateSessionOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-xl font-bold text-slate-800">Nueva Sesión</h2>
              <button onClick={() => setIsCreateSessionOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreateSession}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Fecha</label>
                  <input
                    type="date"
                    required
                    value={newSession.date}
                    onChange={(e) => setNewSession({ ...newSession, date: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Tema / Título</label>
                  <input
                    type="text"
                    required
                    value={newSession.topic}
                    onChange={(e) => setNewSession({ ...newSession, topic: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    placeholder="Ej: Introducción al curso"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Hora inicio</label>
                    <input
                      type="time"
                      value={newSession.start_time}
                      onChange={(e) => setNewSession({ ...newSession, start_time: e.target.value })}
                      className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Hora fin</label>
                    <input
                      type="time"
                      value={newSession.end_time}
                      onChange={(e) => setNewSession({ ...newSession, end_time: e.target.value })}
                      className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Ubicación (opcional)</label>
                  <input
                    type="text"
                    value={newSession.location}
                    onChange={(e) => setNewSession({ ...newSession, location: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    placeholder="Ej: Sala A, Piso 2"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsCreateSessionOpen(false)}
                  className="px-4 py-2.5 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm font-medium"
                >
                  Crear Sesión
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Generate Sessions Modal - Google Calendar Style */}
      {isGenerateSessionsOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-2xl">
            <div className="flex justify-between items-center mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center">
                  <Repeat className="w-5 h-5 text-emerald-600" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-slate-800">Generar Horario Recurrente</h2>
                  <p className="text-xs text-slate-500">Configura la recurrencia y genera todas las sesiones</p>
                </div>
              </div>
              <button onClick={() => setIsGenerateSessionsOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-5">
              {/* Date range */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Fecha inicio</label>
                  <input
                    type="date"
                    value={genForm.start_date}
                    onChange={(e) => setGenForm({ ...genForm, start_date: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Fecha fin</label>
                  <input
                    type="date"
                    value={genForm.end_date}
                    onChange={(e) => setGenForm({ ...genForm, end_date: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  />
                </div>
              </div>

              {/* Days of week - Google Calendar style */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Días de la semana</label>
                <div className="flex gap-2">
                  {DAY_NAMES.map((name, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => toggleGenDay(idx)}
                      className={`w-10 h-10 rounded-full text-sm font-medium transition-all ${
                        genForm.days_of_week.includes(idx)
                          ? 'bg-emerald-600 text-white shadow-sm'
                          : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                      }`}
                    >
                      {name.charAt(0)}
                    </button>
                  ))}
                </div>
                {genForm.days_of_week.length > 0 && (
                  <p className="text-xs text-slate-500 mt-2">
                    {genForm.days_of_week.map(d => DAY_NAMES_FULL[d]).join(', ')}
                  </p>
                )}
              </div>

              {/* Time range */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Hora inicio</label>
                  <input
                    type="time"
                    value={genForm.start_time}
                    onChange={(e) => setGenForm({ ...genForm, start_time: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Hora fin</label>
                  <input
                    type="time"
                    value={genForm.end_time}
                    onChange={(e) => setGenForm({ ...genForm, end_time: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  />
                </div>
              </div>

              {/* Topic prefix */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Prefijo del tema</label>
                <input
                  type="text"
                  value={genForm.topic_prefix}
                  onChange={(e) => setGenForm({ ...genForm, topic_prefix: e.target.value })}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  placeholder="Ej: Sesión, Clase, Taller"
                />
                <p className="text-xs text-slate-400 mt-1">Se generará como &quot;{genForm.topic_prefix || 'Sesión'} 1&quot;, &quot;{genForm.topic_prefix || 'Sesión'} 2&quot;, etc.</p>
              </div>

              {/* Location */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Ubicación (opcional)</label>
                <input
                  type="text"
                  value={genForm.location}
                  onChange={(e) => setGenForm({ ...genForm, location: e.target.value })}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  placeholder="Ej: Auditorio Principal"
                />
              </div>

              {/* Preview */}
              {previewSessionCount > 0 && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                  <div className="flex items-center gap-2">
                    <CalendarDays className="w-5 h-5 text-emerald-600" />
                    <span className="font-semibold text-emerald-800 text-sm">
                      Se generarán {previewSessionCount} sesiones
                    </span>
                  </div>
                  <p className="text-xs text-emerald-600 mt-1">
                    Cada {genForm.days_of_week.map(d => DAY_NAMES_FULL[d]).join(', ')} de{' '}
                    {genForm.start_time || '—'} a {genForm.end_time || '—'}
                  </p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-100">
              <button
                onClick={() => setIsGenerateSessionsOpen(false)}
                className="px-4 py-2.5 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium"
              >
                Cancelar
              </button>
              <button
                onClick={handleGenerateSessions}
                disabled={generating || previewSessionCount === 0}
                className="px-5 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {generating ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Generando...
                  </>
                ) : (
                  <>
                    <CalendarDays className="w-4 h-4" />
                    Generar {previewSessionCount} Sesiones
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Attendance Modal */}
      {isAttendanceOpen && selectedSession && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-xl font-bold text-slate-800">Tomar Asistencia</h2>
                <p className="text-sm text-slate-500">
                  {selectedSession.topic} — {format(new Date(selectedSession.date), "EEEE, d 'de' MMMM", { locale: es })}
                  {selectedSession.start_time && ` · ${selectedSession.start_time}`}
                </p>
              </div>
              <button onClick={() => setIsAttendanceOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto pr-1">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-600 sticky top-0 z-10 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 font-medium">Participante</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium">Notas</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {participants.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 font-medium text-xs">
                            {(p.contact_name || '?').charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium text-slate-800 text-sm">{p.contact_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          {[
                            { key: 'present', label: 'P', color: 'emerald', title: 'Presente' },
                            { key: 'absent', label: 'A', color: 'red', title: 'Ausente' },
                            { key: 'late', label: 'T', color: 'amber', title: 'Tarde' },
                            { key: 'excused', label: 'J', color: 'blue', title: 'Justificado' },
                          ].map(opt => (
                            <button
                              key={opt.key}
                              type="button"
                              onClick={() => setAttendanceData({
                                ...attendanceData,
                                [p.id]: { ...attendanceData[p.id], status: opt.key }
                              })}
                              title={opt.title}
                              className={`w-8 h-8 rounded-lg text-xs font-bold transition-all ${
                                attendanceData[p.id]?.status === opt.key
                                  ? opt.color === 'emerald' ? 'bg-emerald-100 text-emerald-700 ring-2 ring-emerald-300'
                                  : opt.color === 'red' ? 'bg-red-100 text-red-700 ring-2 ring-red-300'
                                  : opt.color === 'amber' ? 'bg-amber-100 text-amber-700 ring-2 ring-amber-300'
                                  : 'bg-blue-100 text-blue-700 ring-2 ring-blue-300'
                                  : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="text"
                          value={attendanceData[p.id]?.notes || ''}
                          onChange={(e) => setAttendanceData({
                            ...attendanceData,
                            [p.id]: { ...attendanceData[p.id], notes: e.target.value }
                          })}
                          placeholder="Opcional..."
                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-slate-100">
              <button
                onClick={() => setIsAttendanceOpen(false)}
                className="px-4 py-2.5 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium"
              >
                Cancelar
              </button>
              <button
                onClick={saveAttendance}
                className="px-5 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm font-medium flex items-center gap-2"
              >
                <Check className="w-4 h-4" />
                Guardar Asistencia
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Campaign Modal */}
      <CreateCampaignModal
        open={showCampaignModal}
        onClose={() => setShowCampaignModal(false)}
        onSubmit={handleCreateCampaign}
        devices={devices}
        title="Envío Masivo desde Programa"
        subtitle="Crea una campaña con los participantes que tengan teléfono"
        accentColor="green"
        submitLabel={creatingCampaign ? 'Creando...' : `Crear campaña (${participantsWithPhone.length})`}
        submitting={creatingCampaign || participantsWithPhone.length === 0}
        initialName={`Envío - ${program?.name || ''}`}
        infoPanel={
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-emerald-600" />
              <span className="text-sm font-semibold text-emerald-800">
                {participantsWithPhone.length} destinatarios con teléfono
              </span>
            </div>
            <p className="text-xs text-emerald-600">
              Se enviará a todos los participantes del programa que tengan número de teléfono registrado.
            </p>
          </div>
        }
      />
    </div>
  );
}
