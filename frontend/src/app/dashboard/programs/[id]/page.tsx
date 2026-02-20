"use client";

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Users, Calendar, MessageSquare, Plus, Check, X, Clock, AlertCircle, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Program, ProgramParticipant, ProgramSession, ProgramAttendance } from '@/types/program';
import ContactSelector, { SelectedPerson } from '@/components/ContactSelector';

export default function ProgramDetailPage() {
  const params = useParams();
  const router = useRouter();
  const programId = params.id as string;

  const [program, setProgram] = useState<Program | null>(null);
  const [participants, setParticipants] = useState<ProgramParticipant[]>([]);
  const [sessions, setSessions] = useState<ProgramSession[]>([]);
  const [activeTab, setActiveTab] = useState<'participants' | 'sessions'>('participants');
  const [loading, setLoading] = useState(true);

  // Modals state
  const [isAddParticipantOpen, setIsAddParticipantOpen] = useState(false);
  const [isCreateSessionOpen, setIsCreateSessionOpen] = useState(false);
  const [isAttendanceOpen, setIsAttendanceOpen] = useState(false);
  const [isMessageModalOpen, setIsMessageModalOpen] = useState(false);

  // Form state
  const [newSession, setNewSession] = useState({ date: new Date().toISOString().split('T')[0], topic: '' });
  const [selectedSession, setSelectedSession] = useState<ProgramSession | null>(null);
  const [attendanceData, setAttendanceData] = useState<Record<string, { status: string, notes: string }>>({});
  
  // Messaging state
  const [messageFilter, setMessageFilter] = useState('all'); // all, present, absent, late, excused, unmarked
  const [messageText, setMessageText] = useState('');

  useEffect(() => {
    if (programId) {
      fetchProgramData();
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
      await api(`/api/programs/${programId}/participants/${participantId}`, {
        method: 'DELETE'
      });
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
        body: JSON.stringify(newSession)
      });
      setIsCreateSessionOpen(false);
      setNewSession({ date: new Date().toISOString().split('T')[0], topic: '' });
      fetchProgramData();
    } catch (error) {
      console.error('Error creating session:', error);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!confirm('¿Estás seguro de eliminar esta sesión?')) return;
    try {
      await api(`/api/programs/${programId}/sessions/${sessionId}`, {
        method: 'DELETE'
      });
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
      
      // Initialize with existing data
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
      fetchProgramData(); // Refresh to update stats
    } catch (error) {
      console.error('Error saving attendance:', error);
    }
  };

  const handleSendMessage = async () => {
    if (!selectedSession || !messageText.trim()) return;
    
    try {
      // 1. Get participants based on filter
      let targetParticipants: ProgramParticipant[] = [];
      
      if (messageFilter === 'all') {
        targetParticipants = participants;
      } else {
        const response = await api<ProgramParticipant[]>(`/api/programs/${programId}/sessions/${selectedSession.id}/attendance/filter?status=${messageFilter}`);
        if (response.success && response.data) {
          targetParticipants = response.data;
        }
      }
      
      if (!targetParticipants || targetParticipants.length === 0) {
        alert('No hay participantes que coincidan con el filtro seleccionado.');
        return;
      }

      // 2. Send messages (using the campaign endpoint logic or direct send)
      // For now, we'll just alert since we need to integrate with the campaign system
      alert(`Se enviarían ${targetParticipants.length} mensajes. (Integración con campañas pendiente)`);
      setIsMessageModalOpen(false);
      setMessageText('');
      
    } catch (error) {
      console.error('Error sending messages:', error);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  if (!program) {
    return (
      <div className="p-6 text-center">
        <h2 className="text-xl font-bold text-slate-800">Programa no encontrado</h2>
        <button onClick={() => router.push('/dashboard/programs')} className="mt-4 text-emerald-600 hover:underline">
          Volver a Programas
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <button 
          onClick={() => router.push('/dashboard/programs')}
          className="p-2 hover:bg-slate-100 rounded-full transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-slate-600" />
        </button>
        <div 
          className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-xl"
          style={{ backgroundColor: program.color || '#10b981' }}
        >
          {program.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-800">{program.name}</h1>
          <p className="text-slate-500">{program.description}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 mb-6">
        <button
          onClick={() => setActiveTab('participants')}
          className={`px-6 py-3 font-medium text-sm border-b-2 transition-colors ${
            activeTab === 'participants' 
              ? 'border-emerald-500 text-emerald-600' 
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4" />
            Participantes ({participants.length})
          </div>
        </button>
        <button
          onClick={() => setActiveTab('sessions')}
          className={`px-6 py-3 font-medium text-sm border-b-2 transition-colors ${
            activeTab === 'sessions' 
              ? 'border-emerald-500 text-emerald-600' 
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4" />
            Sesiones ({sessions.length})
          </div>
        </button>
      </div>

      {/* Content */}
      {activeTab === 'participants' ? (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-slate-800">Lista de Participantes</h2>
            <button
              onClick={() => setIsAddParticipantOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm"
            >
              <Plus className="w-4 h-4" />
              Agregar Participantes
            </button>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3 font-medium">Nombre</th>
                  <th className="px-6 py-3 font-medium">Teléfono</th>
                  <th className="px-6 py-3 font-medium">Estado</th>
                  <th className="px-6 py-3 font-medium">Fecha Inscripción</th>
                  <th className="px-6 py-3 font-medium text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {participants.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                      No hay participantes inscritos en este programa.
                    </td>
                  </tr>
                ) : (
                  participants.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="px-6 py-3 font-medium text-slate-800">{p.contact_name}</td>
                      <td className="px-6 py-3 text-slate-600">{p.contact_phone}</td>
                      <td className="px-6 py-3">
                        <span className="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs">
                          {p.status === 'active' ? 'Activo' : p.status}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-slate-500">
                        {new Date(p.enrolled_at).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-3 text-right">
                        <button 
                          onClick={() => handleRemoveParticipant(p.id)}
                          className="text-red-500 hover:text-red-700 p-1"
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
      ) : (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-slate-800">Sesiones y Asistencia</h2>
            <button
              onClick={() => setIsCreateSessionOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm"
            >
              <Plus className="w-4 h-4" />
              Nueva Sesión
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sessions.length === 0 ? (
              <div className="col-span-full text-center py-12 bg-white rounded-xl border border-slate-200">
                <Calendar className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                <p className="text-slate-500">No hay sesiones programadas.</p>
              </div>
            ) : (
              sessions.map((session) => (
                <div key={session.id} className="bg-white rounded-xl border border-slate-200 p-5 hover:shadow-md transition-shadow">
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex items-center gap-2 text-emerald-600 font-medium">
                      <Calendar className="w-4 h-4" />
                      {new Date(session.date).toLocaleDateString()}
                    </div>
                    <button 
                      onClick={() => handleDeleteSession(session.id)}
                      className="text-slate-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  
                  <h3 className="font-semibold text-slate-800 mb-4 line-clamp-2 h-12">{session.topic}</h3>
                  
                  <div className="flex gap-2 mb-4 text-xs">
                    <div className="flex items-center gap-1 text-emerald-600 bg-emerald-50 px-2 py-1 rounded">
                      <Check className="w-3 h-3" /> {session.attendance_stats?.present || 0}
                    </div>
                    <div className="flex items-center gap-1 text-red-600 bg-red-50 px-2 py-1 rounded">
                      <X className="w-3 h-3" /> {session.attendance_stats?.absent || 0}
                    </div>
                    <div className="flex items-center gap-1 text-amber-600 bg-amber-50 px-2 py-1 rounded">
                      <Clock className="w-3 h-3" /> {session.attendance_stats?.late || 0}
                    </div>
                    <div className="flex items-center gap-1 text-blue-600 bg-blue-50 px-2 py-1 rounded">
                      <AlertCircle className="w-3 h-3" /> {session.attendance_stats?.excused || 0}
                    </div>
                  </div>
                  
                  <div className="flex gap-2 mt-auto pt-4 border-t border-slate-100">
                    <button
                      onClick={() => openAttendance(session)}
                      className="flex-1 py-2 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors text-sm font-medium"
                    >
                      Tomar Asistencia
                    </button>
                    <button
                      onClick={() => {
                        setSelectedSession(session);
                        setIsMessageModalOpen(true);
                      }}
                      className="p-2 bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100 transition-colors"
                      title="Enviar mensaje masivo"
                    >
                      <MessageSquare className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      
      {/* Add Participant Modal */}
      {isAddParticipantOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-slate-800">Agregar Participantes</h2>
              <button onClick={() => setIsAddParticipantOpen(false)} className="text-slate-400 hover:text-slate-600">
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-slate-800 mb-4">Nueva Sesión</h2>
            <form onSubmit={handleCreateSession}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Fecha</label>
                  <input
                    type="date"
                    required
                    value={newSession.date}
                    onChange={(e) => setNewSession({ ...newSession, date: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Tema / Título</label>
                  <input
                    type="text"
                    required
                    value={newSession.topic}
                    onChange={(e) => setNewSession({ ...newSession, topic: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    placeholder="Ej: Introducción al curso"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setIsCreateSessionOpen(false)}
                  className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
                >
                  Crear Sesión
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Attendance Modal */}
      {isAttendanceOpen && selectedSession && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-xl font-bold text-slate-800">Asistencia</h2>
                <p className="text-sm text-slate-500">{selectedSession.topic} - {new Date(selectedSession.date).toLocaleDateString()}</p>
              </div>
              <button onClick={() => setIsAttendanceOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto pr-2">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-600 sticky top-0 z-10">
                  <tr>
                    <th className="px-4 py-3 font-medium">Participante</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium">Notas (Opcional)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {participants.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-800">{p.contact_name}</td>
                      <td className="px-4 py-3">
                        <select
                          value={attendanceData[p.id]?.status || ''}
                          onChange={(e) => setAttendanceData({
                            ...attendanceData,
                            [p.id]: { ...attendanceData[p.id], status: e.target.value }
                          })}
                          className={`px-3 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                            attendanceData[p.id]?.status === 'present' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                            attendanceData[p.id]?.status === 'absent' ? 'bg-red-50 border-red-200 text-red-700' :
                            attendanceData[p.id]?.status === 'late' ? 'bg-amber-50 border-amber-200 text-amber-700' :
                            attendanceData[p.id]?.status === 'excused' ? 'bg-blue-50 border-blue-200 text-blue-700' :
                            'bg-white border-slate-200 text-slate-700'
                          }`}
                        >
                          <option value="" disabled>Seleccionar...</option>
                          <option value="present">Presente</option>
                          <option value="absent">Ausente</option>
                          <option value="late">Tarde</option>
                          <option value="excused">Justificado</option>
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="text"
                          value={attendanceData[p.id]?.notes || ''}
                          onChange={(e) => setAttendanceData({
                            ...attendanceData,
                            [p.id]: { ...attendanceData[p.id], notes: e.target.value }
                          })}
                          placeholder="Motivo de tardanza/falta..."
                          className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-100">
              <button
                onClick={() => setIsAttendanceOpen(false)}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={saveAttendance}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
              >
                Guardar Asistencia
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Message Modal */}
      {isMessageModalOpen && selectedSession && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-slate-800">Mensaje Masivo</h2>
              <button onClick={() => setIsMessageModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Filtrar destinatarios por asistencia:</label>
                <select
                  value={messageFilter}
                  onChange={(e) => setMessageFilter(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="all">Todos los participantes ({participants.length})</option>
                  <option value="present">Solo Presentes ({selectedSession.attendance_stats?.present || 0})</option>
                  <option value="absent">Solo Ausentes ({selectedSession.attendance_stats?.absent || 0})</option>
                  <option value="late">Solo Tardanzas ({selectedSession.attendance_stats?.late || 0})</option>
                  <option value="excused">Solo Justificados ({selectedSession.attendance_stats?.excused || 0})</option>
                  <option value="unmarked">Sin marcar asistencia</option>
                </select>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Mensaje</label>
                <textarea
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[120px]"
                  placeholder="Escribe el mensaje que se enviará a los participantes seleccionados..."
                />
                <p className="text-xs text-slate-500 mt-1">
                  Nota: Este mensaje se enviará usando el número de prueba 51993738489.
                </p>
              </div>
            </div>
            
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setIsMessageModalOpen(false)}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleSendMessage}
                disabled={!messageText.trim()}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <MessageSquare className="w-4 h-4" />
                Enviar Mensaje
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
