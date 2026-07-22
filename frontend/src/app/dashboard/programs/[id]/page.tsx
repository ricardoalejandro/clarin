"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Users, Calendar, MessageSquare, Plus, Check, X, Clock,
  AlertCircle, Trash2, GraduationCap, MapPin, CalendarDays, Send,
  Repeat, ChevronRight, ChevronDown, CheckCircle2, XCircle, Phone, Edit2, MoreVertical, Archive, BarChart3, Columns3, LayoutGrid, HeartPulse, Target, NotebookPen, Maximize2, Minimize2, Search, FileSpreadsheet, Loader2, BookOpen, UserPlus, ClipboardList
} from 'lucide-react';
import { api, subscribeWebSocket } from '@/lib/api';
import { contactIdFromRealtimeEvent } from '@/lib/contactProfileEvents';
import { createWhatsAppChat, deviceDisplayPhone, relationClassName, relationLabel, resolveWhatsAppChat, type WhatsAppDeviceOption } from '@/lib/whatsappChatLauncher';
import { Program, ProgramParticipant, ProgramSession, ProgramSessionTopic, ProgramAttendance, ProgramAttendanceObservation, ProgramGoal, ProgramHealthSummary, ProgramAttendanceStatsResponse, ProgramAcademicConfig } from '@/types/program';
import { Chat } from '@/types/chat';
import ContactSelector, { SelectedPerson } from '@/components/ContactSelector';
import CreateCampaignModal, { CampaignFormResult } from '@/components/CreateCampaignModal';
import ChatPanel from '@/components/chat/ChatPanel';
import ObservationHistoryModal, { HistoryObservation } from '@/components/ObservationHistoryModal';
import ContactPhotoPreview from '@/components/ContactPhotoPreview';
import ContactDetailSurface from '@/components/contact-details/ContactDetailSurface';
import ProgramParticipantAttendanceSection from '@/components/programs/ProgramParticipantAttendanceSection';
import ProgramParticipantEnrollmentDate from '@/components/programs/ProgramParticipantEnrollmentDate';
import type { ContactProfileContact, ContactProfileResponse } from '@/types/contact-profile';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { calendarDateKey, formatCalendarDate, localDateInputValue } from '@/utils/calendarDate';
import { useContainerWidth } from '@/components/responsive/useContainerWidth';
import ProgramAcademicConfigPanel from '@/components/programs/ProgramAcademicConfigPanel';
import ProgramSurveyPanel from '@/components/programs/ProgramSurveyPanel';
import SessionTopicField, { normalizedSessionTopics, pendingActiveCourseTopics } from '@/components/programs/SessionTopicField';

const token = () => typeof window !== 'undefined' ? localStorage.getItem('token') || '' : '';

interface Device {
  id: string;
  name: string;
  phone: string | null;
  phone_number?: string;
  jid?: string | null;
  status: string;
  normalized_phone?: string;
  historical_relation?: WhatsAppDeviceOption['historical_relation'];
  matches_historical?: boolean;
}

interface SessionFormState {
  title: string;
  date: string;
  topics: ProgramSessionTopic[];
  session_type: string;
  start_time: string;
  end_time: string;
  location: string;
}

const DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const DAY_NAMES_FULL = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MAX_GENERATED_SESSIONS = 500;
const MAX_SCHEDULE_RANGE_DAYS = 732;
type ProgramDetailTab = 'health' | 'participants' | 'sessions' | 'stats' | 'kanban' | 'academic' | 'surveys';
type ParticipantLifecycleView = 'active' | 'history';

const normalizeParticipantSearch = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('es')
  .trim();

const suggestedSessionTitle = (topics: ProgramSessionTopic[]) => topics[0]?.title?.trim() || '';

const sessionDisplayTitle = (session: ProgramSession, fallback: string) =>
  session.title?.trim() || session.topic?.trim() || suggestedSessionTitle(normalizedSessionTopics(session)) || fallback;

const participantBelongsToSession = (participant: ProgramParticipant, session: ProgramSession) => {
  const sessionDate = calendarDateKey(session.date);
  const enrolledAt = calendarDateKey(participant.enrolled_at);
  if (!sessionDate || !enrolledAt || sessionDate < enrolledAt) return false;
  const endDates = [participant.dropped_at, participant.completed_at]
    .map(calendarDateKey)
    .filter(Boolean)
    .sort();
  return endDates.length === 0 || sessionDate <= endDates[0];
};

function ProgramParticipantHistoryList({
  participants,
  searching,
  compact,
  onOpen,
}: {
  participants: ProgramParticipant[];
  searching: boolean;
  compact: boolean;
  onOpen: (participant: ProgramParticipant, trigger?: HTMLElement | null) => void;
}) {
  if (participants.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-5 py-14 text-center">
        <Archive className="mx-auto h-10 w-10 text-slate-300" />
        <p className="mt-3 font-semibold text-slate-600">{searching ? 'Sin coincidencias en el historial' : 'El historial está vacío'}</p>
        <p className="mt-1 text-xs leading-5 text-slate-400">{searching ? 'Prueba con otro nombre o teléfono.' : 'Los participantes retirados o que completaron el programa aparecerán aquí.'}</p>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {participants.map(participant => {
          const endedAt = participant.status === 'dropped' ? participant.dropped_at : participant.completed_at;
          return (
            <button key={participant.id} type="button" data-testid="mobile-program-participant-history-row" onClick={event => onOpen(participant, event.currentTarget)} className="flex min-h-[78px] w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500">
              <ContactPhotoPreview url={participant.avatar_url} name={participant.contact_name || 'Sin nombre'} sizeClassName="h-11 w-11" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-slate-800">{participant.contact_name || 'Sin nombre'}</span>
                <span className="block truncate text-xs text-slate-400">{participant.contact_phone || 'Sin teléfono'}</span>
                <span className="mt-1 flex min-w-0 items-center gap-2 text-[11px]">
                  <span className={`shrink-0 rounded-full px-2 py-0.5 font-semibold ${participant.status === 'completed' ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'}`}>{participant.status === 'completed' ? 'Completado' : 'Retirado'}</span>
                  {endedAt && <span className="truncate text-slate-400">{formatCalendarDate(endedAt, 'dd MMM yyyy', { locale: es })}</span>}
                </span>
                {participant.status === 'dropped' && participant.drop_reason && <span className="mt-1 block truncate text-xs text-slate-500">{participant.drop_reason}</span>}
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 py-3"><h3 className="text-sm font-semibold text-slate-800">Historial de participación</h3><p className="mt-0.5 text-xs text-slate-500">Conserva asistencia y observaciones sin afectar el padrón activo.</p></div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600"><tr><th className="px-4 py-3 font-medium">Participante</th><th className="px-4 py-3 font-medium">Resultado</th><th className="px-4 py-3 font-medium">Periodo</th><th className="px-4 py-3 font-medium">Motivo</th><th className="px-4 py-3" /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {participants.map(participant => {
              const endedAt = participant.status === 'dropped' ? participant.dropped_at : participant.completed_at;
              return (
                <tr key={participant.id} onClick={() => onOpen(participant)} className="cursor-pointer transition-colors hover:bg-slate-50">
                  <td className="px-4 py-3"><div className="flex items-center gap-3"><ContactPhotoPreview url={participant.avatar_url} name={participant.contact_name || 'Sin nombre'} /><div className="min-w-0"><p className="truncate font-medium text-slate-800">{participant.contact_name || 'Sin nombre'}</p><p className="truncate text-xs text-slate-400">{participant.contact_phone || 'Sin teléfono'}</p></div></div></td>
                  <td className="px-4 py-3"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${participant.status === 'completed' ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'}`}>{participant.status === 'completed' ? 'Completado' : 'Retirado'}</span></td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{formatCalendarDate(participant.enrolled_at, 'dd MMM yyyy', { locale: es })} — {endedAt ? formatCalendarDate(endedAt, 'dd MMM yyyy', { locale: es }) : '—'}</td>
                  <td className="max-w-64 truncate px-4 py-3 text-xs text-slate-500">{participant.drop_reason || '—'}</td>
                  <td className="px-4 py-3 text-right"><ChevronRight className="ml-auto h-4 w-4 text-slate-300" /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ProgramDetailPage() {
  const params = useParams();
  const router = useRouter();
  const programId = params.id as string;
  const { ref: workspaceRef, width: workspaceWidth } = useContainerWidth<HTMLDivElement>();
  const [coarsePointer, setCoarsePointer] = useState(false);
  const [visualViewportHeight, setVisualViewportHeight] = useState(900);
  const compactWorkspace = workspaceWidth === 0 || workspaceWidth < 820;
  const touchWorkspace = compactWorkspace || coarsePointer;
  const mobileWorkspace = workspaceWidth === 0 || workspaceWidth < 700 || (coarsePointer && visualViewportHeight < 600);

  const [program, setProgram] = useState<Program | null>(null);
  const [participants, setParticipants] = useState<ProgramParticipant[]>([]);
  const [sessions, setSessions] = useState<ProgramSession[]>([]);
  const [academicConfig, setAcademicConfig] = useState<ProgramAcademicConfig | null>(null);
  const [academicLoading, setAcademicLoading] = useState(false);
  const [academicError, setAcademicError] = useState('');
  const [academicDirty, setAcademicDirty] = useState(false);
  const academicRequestRef = useRef<AbortController | null>(null);
  const academicRequestSequence = useRef(0);
  const [stages, setStages] = useState<Array<{ id: string; name: string; color: string; position: number }>>([]);
  const [draggedParticipantID, setDraggedParticipantID] = useState<string | null>(null);
  const [dragOverStageID, setDragOverStageID] = useState<string | null>(null);
  const [movingStageParticipantIDs, setMovingStageParticipantIDs] = useState<Set<string>>(() => new Set());
  const [activeTab, setActiveTab] = useState<ProgramDetailTab>('health');
  const [canUseSurveys, setCanUseSurveys] = useState(false);
  const [healthSummaryExpanded, setHealthSummaryExpanded] = useState(false);
  const [showSectionPicker, setShowSectionPicker] = useState(false);
  const [participantSearch, setParticipantSearch] = useState('');
  const [debouncedParticipantSearch, setDebouncedParticipantSearch] = useState('');
  const [participantLifecycleView, setParticipantLifecycleView] = useState<ParticipantLifecycleView>('active');
  const [participantSearchFocused, setParticipantSearchFocused] = useState(false);
  const [exportingParticipants, setExportingParticipants] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailError, setDetailError] = useState('');
  const [programNotFound, setProgramNotFound] = useState(false);
  const programDataRequestRef = useRef<AbortController | null>(null);
  const programDataRequestSequence = useRef(0);
  const programSnapshotRef = useRef(false);
  const [devices, setDevices] = useState<Device[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    const loadPermissions = async () => {
      try {
        const response = await fetch('/api/me', { credentials: 'include', signal: controller.signal });
        if (!response.ok) return;
        const payload = await response.json();
        const user = payload?.user;
        const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
        const allowed = Boolean(user?.is_admin || user?.is_super_admin || permissions.includes('*') || permissions.includes('surveys'));
        setCanUseSurveys(allowed);
      } catch {
        if (!controller.signal.aborted) setCanUseSurveys(false);
      }
    };
    void loadPermissions();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!canUseSurveys && activeTab === 'surveys') setActiveTab('health');
  }, [activeTab, canUseSurveys]);

  // Modals state
  const [isAddParticipantOpen, setIsAddParticipantOpen] = useState(false);
  const [isCreateSessionOpen, setIsCreateSessionOpen] = useState(false);
  const [isAttendanceOpen, setIsAttendanceOpen] = useState(false);
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [isGenerateSessionsOpen, setIsGenerateSessionsOpen] = useState(false);
  const [addingParticipants, setAddingParticipants] = useState(false);
  const [addParticipantError, setAddParticipantError] = useState('');
  const [participantSelectorRevision, setParticipantSelectorRevision] = useState(0);

  // Form state
  const [newSession, setNewSession] = useState<SessionFormState>({ title: '', date: localDateInputValue(), topics: [], session_type: 'regular', start_time: '', end_time: '', location: '' });
  const [newSessionTitleEdited, setNewSessionTitleEdited] = useState(false);
  const [selectedSession, setSelectedSession] = useState<ProgramSession | null>(null);
  const [attendanceData, setAttendanceData] = useState<Record<string, { status: string; observation_count: number; observation_preview: ProgramAttendanceObservation[] }>>({});
  const [attendanceDirty, setAttendanceDirty] = useState<Record<string, boolean>>({});
  const [attendanceLoadState, setAttendanceLoadState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [attendanceLoadError, setAttendanceLoadError] = useState('');
  const attendanceRequestRef = useRef<AbortController | null>(null);
  const attendanceRequestSequence = useRef(0);
  const [savingAttendance, setSavingAttendance] = useState(false);
  const [attendanceObservationParticipant, setAttendanceObservationParticipant] = useState<ProgramParticipant | null>(null);
  const [attendanceObservationHistory, setAttendanceObservationHistory] = useState<HistoryObservation[]>([]);
  const [attendanceObservationLoading, setAttendanceObservationLoading] = useState(false);
  const [attendanceObservationError, setAttendanceObservationError] = useState('');
  const [attendanceObservationComposerOpen, setAttendanceObservationComposerOpen] = useState(false);
  const attendanceObservationRequestRef = useRef<AbortController | null>(null);
  const attendanceObservationRequestSequence = useRef(0);

  // Edit session state
  const [editingSession, setEditingSession] = useState<ProgramSession | null>(null);
  const [editSessionForm, setEditSessionForm] = useState<SessionFormState>({ title: '', date: '', topics: [], session_type: 'regular', start_time: '', end_time: '', location: '' });
  const [editSessionTitleEdited, setEditSessionTitleEdited] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [savingSession, setSavingSession] = useState(false);
  const [maximizedSessionDialog, setMaximizedSessionDialog] = useState<'create' | 'edit' | 'recurring' | null>(null);

  // Campaign state
  const [creatingCampaign, setCreatingCampaign] = useState(false);

  // Toast state
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastType, setToastType] = useState<'success' | 'error'>('success');

  // Confirmation dialog state
  const [confirmAction, setConfirmAction] = useState<{ message: string; onConfirm: () => void } | null>(null);

  // Edit program state
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', description: '', color: '#10b981', status: 'active' });
  const [saving, setSaving] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);

  // Participant detail panel
  const [loadingLead, setLoadingLead] = useState(false);
  const [selectedContact, setSelectedContact] = useState<ContactProfileContact | null>(null);
  const [selectedParticipantID, setSelectedParticipantID] = useState<string | null>(null);
  const [participantDetailOpen, setParticipantDetailOpen] = useState(false);
  const [participantDetailError, setParticipantDetailError] = useState('');
  const participantDetailRequestRef = useRef<AbortController | null>(null);
  const participantDetailSequence = useRef(0);
  const participantDetailDialogRef = useRef<HTMLDivElement>(null);
  const participantDetailReturnFocusRef = useRef<HTMLElement | null>(null);
  const participantContextByContactRef = useRef(new Map<string, string>());
  const contactRefreshSequenceRef = useRef(new Map<string, number>());

  // Column visibility (persisted in localStorage)
  const PARTICIPANT_COLUMNS: { id: string; label: string; always?: boolean }[] = [
    { id: 'name', label: 'Nombre', always: true },
    { id: 'phone', label: 'Teléfono' },
    { id: 'status', label: 'Estado' },
    { id: 'enrolled_at', label: 'Inscripción' },
    { id: 'actions', label: 'Acciones' },
  ];
  const DEFAULT_VISIBLE_COLUMNS = ['name', 'phone', 'status', 'enrolled_at', 'actions'];
  const COLUMN_STORAGE_KEY = 'programParticipantColumns:v1';
  const [visibleColumns, setVisibleColumns] = useState<string[]>(DEFAULT_VISIBLE_COLUMNS);
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  const excludedParticipantIds = useMemo(
    () => new Set(participants.map(participant => participant.contact_id)),
    [participants]
  );
  const excludedParticipantLabels = useMemo(
    () => new Map(participants.map(participant => [
      participant.contact_id,
      participant.status === 'completed'
        ? 'Participante completado'
        : participant.status === 'dropped'
          ? 'Participante retirado'
          : 'Ya participa',
    ])),
    [participants]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Ensure 'name' always present, filter unknown ids
          const valid = parsed.filter((c: any) => typeof c === 'string' && PARTICIPANT_COLUMNS.some(pc => pc.id === c));
          if (!valid.includes('name')) valid.unshift('name');
          setVisibleColumns(valid);
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  const toggleColumn = (id: string) => {
    const col = PARTICIPANT_COLUMNS.find(c => c.id === id);
    if (col?.always) return;
    setVisibleColumns(prev => {
      const next = prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id];
      // Persist in catalog order
      const ordered = PARTICIPANT_COLUMNS.filter(c => next.includes(c.id)).map(c => c.id);
      try { localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(ordered)); } catch { /* ignore */ }
      return ordered;
    });
  };

  // WhatsApp inline chat
  const [showInlineChat, setShowInlineChat] = useState(false);
  const [inlineChatId, setInlineChatId] = useState('');
  const [inlineChat, setInlineChat] = useState<Chat | null>(null);
  const [inlineChatDeviceId, setInlineChatDeviceId] = useState('');
  const [inlineChatReadOnly, setInlineChatReadOnly] = useState(false);
  const [showDeviceSelector, setShowDeviceSelector] = useState(false);
  const [whatsappPhone, setWhatsappPhone] = useState('');
  const [existingChatForWA, setExistingChatForWA] = useState<Chat | null>(null);
  const [whatsappHistoricalPhone, setWhatsappHistoricalPhone] = useState('');
  const [whatsappLaunching, setWhatsappLaunching] = useState(false);
  const [whatsappCreating, setWhatsappCreating] = useState(false);

  // Generate sessions form
  const [genForm, setGenForm] = useState({
    start_date: localDateInputValue(),
    end_date: '',
    days_of_week: [] as number[],
    start_time: '09:00',
    end_time: '10:00',
    title_prefix: 'Sesión',
    location: '',
    assign_course_topics: false,
  });
  const [generating, setGenerating] = useState(false);

  // Stats
  const [statsData, setStatsData] = useState<ProgramAttendanceStatsResponse | null>(null);
  const [statsStatus, setStatsStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [statsError, setStatsError] = useState('');
  const loadingStats = statsStatus === 'loading';
  const statsRequestRef = useRef<AbortController | null>(null);
  const statsRequestSequence = useRef(0);
  const [selectedMonths, setSelectedMonths] = useState<string[]>([]);
  const [health, setHealth] = useState<ProgramHealthSummary | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(false);
  const [programGoals, setProgramGoals] = useState<ProgramGoal>({ attendance_goal_percent: 80, transfer_goal_percent: 70 });
  const [savingGoals, setSavingGoals] = useState(false);
  const [observationParticipant, setObservationParticipant] = useState<ProgramParticipant | null>(null);
  const [observationHistory, setObservationHistory] = useState<HistoryObservation[]>([]);
  const [observationHistoryLoading, setObservationHistoryLoading] = useState(false);
  const [observationHistoryError, setObservationHistoryError] = useState('');
  const [observationComposerInitiallyOpen, setObservationComposerInitiallyOpen] = useState(false);
  const observationHistoryRequestRef = useRef<AbortController | null>(null);
  const observationHistoryRequestSequence = useRef(0);
  const [outcomeParticipant, setOutcomeParticipant] = useState<ProgramParticipant | null>(null);
  const [outcomeForm, setOutcomeForm] = useState({ status: 'completed', transferred_to_level: '', drop_reason: '', drop_notes: '' });
  const [savingOutcome, setSavingOutcome] = useState(false);

  const normalizedParticipantQuery = useMemo(
    () => normalizeParticipantSearch(debouncedParticipantSearch),
    [debouncedParticipantSearch],
  );
  const participantSearchPending = participantSearch !== debouncedParticipantSearch;
  const participantExportCollapsed = mobileWorkspace && !exportingParticipants && (participantSearchFocused || participantSearchPending);
  const activeParticipants = useMemo(() => participants.filter(participant => participant.status === 'active'), [participants]);
  const historicalParticipants = useMemo(() => participants.filter(participant => participant.status !== 'active'), [participants]);
  const lifecycleParticipants = participantLifecycleView === 'active' ? activeParticipants : historicalParticipants;
  const filteredHealthParticipants = useMemo(() => {
    const source = health?.participants || [];
    if (!normalizedParticipantQuery) return source;
    return source.filter(participant => normalizeParticipantSearch(`${participant.name || ''} ${participant.phone || ''}`).includes(normalizedParticipantQuery));
  }, [health?.participants, normalizedParticipantQuery]);
  const filteredProgramParticipants = useMemo(() => {
    if (!normalizedParticipantQuery) return lifecycleParticipants;
    return lifecycleParticipants.filter(participant => normalizeParticipantSearch(`${participant.contact_name || ''} ${participant.contact_phone || ''}`).includes(normalizedParticipantQuery));
  }, [lifecycleParticipants, normalizedParticipantQuery]);
  const eligibleAttendanceParticipants = useMemo(
    () => selectedSession ? participants.filter(participant => participantBelongsToSession(participant, selectedSession)) : [],
    [participants, selectedSession],
  );
  const pendingCourseTopics = useMemo(
    () => pendingActiveCourseTopics(academicConfig?.courses || [], sessions),
    [academicConfig?.courses, sessions],
  );

  const handleExportParticipants = async () => {
    if (!program || exportingParticipants) return;
    setExportingParticipants(true);
    try {
      const { exportProgramParticipants } = await import('@/utils/programParticipantsExport');
      exportProgramParticipants(program, filteredProgramParticipants);
      showToast(`Excel exportado con ${filteredProgramParticipants.length} participante${filteredProgramParticipants.length === 1 ? '' : 's'}`, 'success');
    } catch (error) {
      console.error('Error exporting program participants:', error);
      showToast('No se pudo generar el archivo Excel.', 'error');
    } finally {
      setExportingParticipants(false);
    }
  };

  const closeAttendanceModal = useCallback(() => {
    attendanceRequestRef.current?.abort();
    attendanceRequestRef.current = null;
    attendanceRequestSequence.current += 1;
    attendanceObservationRequestRef.current?.abort();
    attendanceObservationRequestRef.current = null;
    attendanceObservationRequestSequence.current += 1;
    setIsAttendanceOpen(false);
    setSelectedSession(null);
    setAttendanceDirty({});
    setAttendanceLoadState('idle');
    setAttendanceLoadError('');
    setAttendanceObservationParticipant(null);
    setAttendanceObservationHistory([]);
    setAttendanceObservationLoading(false);
    setAttendanceObservationError('');
    setAttendanceObservationComposerOpen(false);
  }, []);

  const closeAttendanceObservationHistory = useCallback(() => {
    attendanceObservationRequestRef.current?.abort();
    attendanceObservationRequestRef.current = null;
    attendanceObservationRequestSequence.current += 1;
    setAttendanceObservationParticipant(null);
    setAttendanceObservationHistory([]);
    setAttendanceObservationLoading(false);
    setAttendanceObservationError('');
    setAttendanceObservationComposerOpen(false);
  }, []);

  const closeObservationHistory = useCallback(() => {
    observationHistoryRequestRef.current?.abort();
    observationHistoryRequestRef.current = null;
    observationHistoryRequestSequence.current += 1;
    setObservationParticipant(null);
    setObservationHistory([]);
    setObservationHistoryLoading(false);
    setObservationHistoryError('');
    setObservationComposerInitiallyOpen(false);
  }, []);

  const closeParticipantDetail = useCallback(() => {
    participantDetailRequestRef.current?.abort();
    participantDetailSequence.current += 1;
    setParticipantDetailOpen(false);
    setParticipantDetailError('');
    setSelectedContact(null);
    setShowInlineChat(false);
    setSelectedParticipantID(null);
    const returnTarget = participantDetailReturnFocusRef.current;
    participantDetailReturnFocusRef.current = null;
    window.setTimeout(() => returnTarget?.focus(), 0);
  }, []);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toastMessage) return;
    const t = setTimeout(() => setToastMessage(null), 3000);
    return () => clearTimeout(t);
  }, [toastMessage]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedParticipantSearch(participantSearch), 500);
    return () => window.clearTimeout(timer);
  }, [participantSearch]);

  useEffect(() => {
    const media = window.matchMedia('(hover: none), (pointer: coarse)');
    const update = () => {
      setCoarsePointer(media.matches);
      setVisualViewportHeight(window.visualViewport?.height || window.innerHeight);
    };
    update();
    media.addEventListener('change', update);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    if (!mobileWorkspace) {
      setShowSectionPicker(false);
      return;
    }
    setShowHeaderMenu(false);
    setHealthSummaryExpanded(false);
    setConfirmAction(null);
    setOutcomeParticipant(null);
    setIsEditModalOpen(false);
    setShowCampaignModal(false);
    setShowColumnPicker(false);
    setShowInlineChat(false);
    setShowDeviceSelector(false);
    setMaximizedSessionDialog(null);
  }, [mobileWorkspace]);

  useEffect(() => {
    if (!participantDetailOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => participantDetailDialogRef.current?.focus(), 0);
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(participantDetailDialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || []);
      if (focusable.length === 0) {
        event.preventDefault();
        participantDetailDialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trapFocus, true);
    return () => {
      document.removeEventListener('keydown', trapFocus, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [participantDetailOpen]);

  const showToast = (message: string, type: 'success' | 'error') => {
    setToastMessage(message);
    setToastType(type);
  };

  const requestTabChange = useCallback((nextTab: ProgramDetailTab) => {
    setShowSectionPicker(false);
    if (nextTab === activeTab) return;
    if (!academicDirty) {
      setActiveTab(nextTab);
      return;
    }
    setConfirmAction({
      message: 'Hay cambios sin guardar en el plan o los instructores. Si cambias de sección, se perderán.',
      onConfirm: () => {
        setConfirmAction(null);
        setAcademicDirty(false);
        setActiveTab(nextTab);
      },
    });
  }, [academicDirty, activeTab]);

  const requestProgramNavigation = useCallback((destination: string) => {
    if (!academicDirty) {
      router.push(destination);
      return;
    }
    setShowSectionPicker(false);
    setConfirmAction({
      message: 'Hay cambios sin guardar en el plan o los instructores. Si sales de esta página, se perderán.',
      onConfirm: () => {
        setConfirmAction(null);
        setAcademicDirty(false);
        router.push(destination);
      },
    });
  }, [academicDirty, router]);

  useEffect(() => {
    if (!academicDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [academicDirty]);

  useEffect(() => {
    if (!academicDirty) return;
    const handleInternalNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.hasAttribute('download')) return;
      const anchorTarget = anchor.getAttribute('target');
      if (anchorTarget && anchorTarget !== '_self') return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      requestProgramNavigation(`${url.pathname}${url.search}${url.hash}`);
    };
    document.addEventListener('click', handleInternalNavigation, true);
    return () => document.removeEventListener('click', handleInternalNavigation, true);
  }, [academicDirty, requestProgramNavigation]);

  const fetchAcademicData = useCallback(async () => {
    if (!programId) return;
    academicRequestRef.current?.abort();
    const controller = new AbortController();
    academicRequestRef.current = controller;
    const requestID = ++academicRequestSequence.current;
    setAcademicLoading(true);
    setAcademicError('');
    try {
      const configResponse = await api<ProgramAcademicConfig>(`/api/programs/${programId}/academic-config`, { signal: controller.signal });
      if (controller.signal.aborted || requestID !== academicRequestSequence.current) return;
      if (configResponse.success && configResponse.data) setAcademicConfig(configResponse.data);
      else setAcademicError(configResponse.error || 'No se pudo cargar el plan y los instructores.');
    } catch (error) {
      if (!controller.signal.aborted && requestID === academicRequestSequence.current) {
        console.error('Error loading academic configuration:', error);
        setAcademicError('No se pudo cargar el plan y los instructores.');
      }
    } finally {
      if (!controller.signal.aborted && requestID === academicRequestSequence.current) setAcademicLoading(false);
    }
  }, [programId]);

  useEffect(() => {
    if (programId) {
      programDataRequestRef.current?.abort();
      attendanceRequestRef.current?.abort();
      attendanceRequestSequence.current += 1;
      programSnapshotRef.current = false;
      setProgram(null);
      setParticipants([]);
      setSessions([]);
      setAcademicConfig(null);
      setAcademicError('');
      setAcademicDirty(false);
      academicRequestRef.current?.abort();
      setStages([]);
      setParticipantSearch('');
      setDebouncedParticipantSearch('');
      setParticipantSearchFocused(false);
      setIsAttendanceOpen(false);
      setSelectedSession(null);
      setAttendanceLoadState('idle');
      setAttendanceLoadError('');
      setDetailError('');
      setProgramNotFound(false);
      setLoading(true);
      void fetchProgramData();
      void fetchDevices();
    }
    return () => {
      programDataRequestRef.current?.abort();
      academicRequestRef.current?.abort();
      attendanceRequestRef.current?.abort();
      attendanceObservationRequestRef.current?.abort();
      observationHistoryRequestRef.current?.abort();
    };
  }, [programId]);

  useEffect(() => {
    if (!program || program.type === 'event') {
      academicRequestRef.current?.abort();
      if (program?.type === 'event') {
        setAcademicConfig(null);
        setAcademicError('');
      }
      return;
    }
    void fetchAcademicData();
    return () => academicRequestRef.current?.abort();
  }, [fetchAcademicData, program?.id, program?.type]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showSectionPicker) { setShowSectionPicker(false); return; }
      if (showDeviceSelector) { setShowDeviceSelector(false); return; }
      if (showInlineChat) { setShowInlineChat(false); return; }
      if (attendanceObservationParticipant) { closeAttendanceObservationHistory(); return; }
      if (observationParticipant) { closeObservationHistory(); return; }
      if (outcomeParticipant) { setOutcomeParticipant(null); return; }
      if (isAttendanceOpen) {
        if (Object.keys(attendanceDirty).length > 0) {
          setConfirmAction({ message: 'Hay cambios de asistencia sin guardar. ¿Deseas descartarlos?', onConfirm: () => { setConfirmAction(null); closeAttendanceModal(); } });
        } else closeAttendanceModal();
        return;
      }
      if (isGenerateSessionsOpen) { setIsGenerateSessionsOpen(false); setMaximizedSessionDialog(null); return; }
      if (isCreateSessionOpen) { setIsCreateSessionOpen(false); setMaximizedSessionDialog(null); return; }
      if (editingSession) { setEditingSession(null); setMaximizedSessionDialog(null); return; }
      if (isAddParticipantOpen) { setIsAddParticipantOpen(false); return; }
      if (isEditModalOpen) { setIsEditModalOpen(false); return; }
      if (showCampaignModal) { setShowCampaignModal(false); return; }
      if (participantDetailOpen) { closeParticipantDetail(); return; }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [showSectionPicker, showDeviceSelector, showInlineChat, attendanceObservationParticipant, observationParticipant, outcomeParticipant, isAttendanceOpen, attendanceDirty, isGenerateSessionsOpen, isCreateSessionOpen, editingSession, isAddParticipantOpen, isEditModalOpen, showCampaignModal, participantDetailOpen, closeParticipantDetail, closeAttendanceModal, closeAttendanceObservationHistory, closeObservationHistory]);

  const fetchProgramData = async () => {
    programDataRequestRef.current?.abort();
    const controller = new AbortController();
    programDataRequestRef.current = controller;
    const requestID = ++programDataRequestSequence.current;
    if (!programSnapshotRef.current) setLoading(true);
    setDetailError('');

    const [progRes, partsRes, sessRes, healthRes, goalsRes] = await Promise.all([
      api<Program>(`/api/programs/${programId}`, { signal: controller.signal }),
      api<ProgramParticipant[]>(`/api/programs/${programId}/participants`, { signal: controller.signal }),
      api<ProgramSession[]>(`/api/programs/${programId}/sessions`, { signal: controller.signal }),
      api<{ success: boolean; health: ProgramHealthSummary; error?: string }>(`/api/programs/${programId}/health`, { signal: controller.signal }),
      api<{ success: boolean; goals: ProgramGoal; error?: string }>(`/api/programs/${programId}/goals`, { signal: controller.signal })
    ]);

    if (controller.signal.aborted || requestID !== programDataRequestSequence.current) return;

    const confirmedMissing = !progRes.success && progRes.error === 'Program not found';
    if (confirmedMissing) {
      setProgram(null);
      setProgramNotFound(true);
      setDetailError('');
      programSnapshotRef.current = false;
      setLoading(false);
      return;
    }

    const nextProgram = progRes.data;
    if (!progRes.success || !nextProgram) {
      setDetailError(progRes.error || 'No se pudo cargar el programa.');
      setProgramNotFound(false);
      setLoading(false);
      return;
    }

    // Legacy event-shaped Programs are preserved as an auditable source, but
    // their operational home is now the complete Events module. Redirect only
    // after the lossless migration has produced a verified destination.
    if (nextProgram.event_retirement_status === 'migrated' && nextProgram.migrated_event_id) {
      programSnapshotRef.current = false;
      setLoading(true);
      router.replace(`/dashboard/events/${nextProgram.migrated_event_id}`);
      return;
    }

    // Older backends serialize nil Go slices as JSON null for empty programs.
    // Treat successful null responses as empty arrays at the UI boundary.
    const participantsAvailable = partsRes.success && (partsRes.data == null || Array.isArray(partsRes.data));
    const sessionsAvailable = sessRes.success && (sessRes.data == null || Array.isArray(sessRes.data));
    const healthAvailable = healthRes.success && healthRes.data?.success && !!healthRes.data.health;
    const goalsAvailable = goalsRes.success && goalsRes.data?.success && !!goalsRes.data.goals;
    const failures = [
      !participantsAvailable ? (partsRes.error || 'No se pudieron cargar los participantes.') : '',
      !sessionsAvailable ? (sessRes.error || 'No se pudieron cargar las sesiones.') : '',
      !healthAvailable ? (healthRes.error || healthRes.data?.error || 'No se pudo cargar la salud del programa.') : '',
      !goalsAvailable ? (goalsRes.error || goalsRes.data?.error || 'No se pudieron cargar las metas del programa.') : '',
    ].filter(Boolean);

    let nextStages: Array<{ id: string; name: string; color: string; position: number }> = [];
    let stagesAvailable = nextProgram.type !== 'event' || !nextProgram.pipeline_id;
    if (nextProgram.type === 'event' && nextProgram.pipeline_id) {
      const pipelineResponse = await api<{ success: boolean; pipeline?: { stages?: Array<{ id: string; name: string; color: string; position: number }> }; error?: string }>(`/api/events/pipelines/${nextProgram.pipeline_id}`, { signal: controller.signal });
      if (controller.signal.aborted || requestID !== programDataRequestSequence.current) return;
      if (!pipelineResponse.success || !pipelineResponse.data?.success || !Array.isArray(pipelineResponse.data.pipeline?.stages)) {
        failures.push(pipelineResponse.error || pipelineResponse.data?.error || 'No se pudieron cargar las etapas del evento.');
      } else {
        stagesAvailable = true;
        nextStages = pipelineResponse.data.pipeline.stages.map(stage => ({
          id: stage.id,
          name: stage.name,
          color: stage.color,
          position: stage.position,
        }));
      }
    }

    setProgram(nextProgram);
    if (participantsAvailable) setParticipants(Array.isArray(partsRes.data) ? partsRes.data : []);
    if (sessionsAvailable) setSessions(Array.isArray(sessRes.data) ? sessRes.data : []);
    if (healthAvailable) setHealth(healthRes.data!.health);
    if (goalsAvailable) setProgramGoals(goalsRes.data!.goals);
    if (stagesAvailable) setStages(nextStages);
    setDetailError(Array.from(new Set(failures)).join(' '));
    setProgramNotFound(false);
    programSnapshotRef.current = true;
    if (nextProgram.type === 'event') {
      setActiveTab(prev => (prev === 'sessions' || prev === 'stats' || prev === 'health' || prev === 'academic' || prev === 'surveys') ? 'kanban' : prev);
    } else {
      setActiveTab(prev => (prev === 'kanban' || prev === 'participants') ? 'health' : prev);
    }
    setLoading(false);
  };

  const fetchHealth = useCallback(async () => {
    setLoadingHealth(true);
    try {
      const res = await api<{ success: boolean; health: ProgramHealthSummary }>(`/api/programs/${programId}/health`);
      if (res.success && res.data?.success) setHealth(res.data.health);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingHealth(false);
    }
  }, [programId]);

  const saveProgramGoals = async () => {
    setSavingGoals(true);
    try {
      const res = await api<{ success: boolean; goals: ProgramGoal }>(`/api/programs/${programId}/goals`, {
        method: 'PUT',
        body: JSON.stringify({
          attendance_goal_percent: Number(programGoals.attendance_goal_percent) || 80,
          transfer_goal_percent: Number(programGoals.transfer_goal_percent) || 70,
        })
      });
      if (res.success) {
        showToast('Metas del grupo actualizadas', 'success');
        fetchHealth();
      } else {
        showToast(res.error || 'Error al guardar metas', 'error');
      }
    } catch (e) {
      console.error(e);
      showToast('Error al guardar metas', 'error');
    } finally {
      setSavingGoals(false);
    }
  };

  const openObservationHistory = async (participantId: string, openComposer = false) => {
    const participant = participants.find(p => p.id === participantId);
    if (!participant) return;
    observationHistoryRequestRef.current?.abort();
    const controller = new AbortController();
    observationHistoryRequestRef.current = controller;
    const requestID = ++observationHistoryRequestSequence.current;
    setObservationParticipant(participant);
    setObservationComposerInitiallyOpen(openComposer);
    setObservationHistory([]);
    setObservationHistoryError('');
    setObservationHistoryLoading(true);
    try {
      const res = await api<{ success: boolean; interactions: HistoryObservation[] }>(`/api/contacts/${participant.contact_id}/interactions?limit=200`, { signal: controller.signal });
      if (controller.signal.aborted || requestID !== observationHistoryRequestSequence.current) return;
      if (res.success && res.data?.success) setObservationHistory(res.data.interactions || []);
      else throw new Error(res.error || 'No se pudo cargar el historial.');
    } catch {
      if (controller.signal.aborted || requestID !== observationHistoryRequestSequence.current) return;
      setObservationHistory([]);
      setObservationHistoryError('No se pudo cargar el historial de observaciones.');
    } finally {
      if (requestID === observationHistoryRequestSequence.current) {
        observationHistoryRequestRef.current = null;
        setObservationHistoryLoading(false);
      }
    }
  };

  const openOutcomeModal = (participantId: string, status: 'completed' | 'dropped') => {
    const participant = participants.find(p => p.id === participantId);
    if (!participant) return;
    setOutcomeParticipant(participant);
    setOutcomeForm({
      status,
      transferred_to_level: participant.transferred_to_level || '',
      drop_reason: participant.drop_reason || '',
      drop_notes: participant.drop_notes || '',
    });
  };

  const saveParticipantOutcome = async () => {
    if (!outcomeParticipant || savingOutcome) return;
    setSavingOutcome(true);
    try {
      const payload = outcomeForm.status === 'completed'
        ? {
            status: 'completed',
            completed_at: new Date().toISOString(),
            transferred_to_level: outcomeForm.transferred_to_level,
            transferred_at: outcomeForm.transferred_to_level ? new Date().toISOString() : '',
          }
        : {
            status: 'dropped',
            dropped_at: new Date().toISOString(),
            drop_reason: outcomeForm.drop_reason,
            drop_notes: outcomeForm.drop_notes,
          };
      const res = await api(`/api/programs/${programId}/participants/${outcomeParticipant.id}/outcome`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      if (res.success) {
        showToast(outcomeForm.status === 'completed' ? 'Participación completada y movida al historial' : 'Participante retirado; su historial se conserva', 'success');
        setOutcomeParticipant(null);
        setParticipantLifecycleView('active');
        fetchProgramData();
      } else {
        showToast(res.error || 'Error al actualizar participante', 'error');
      }
    } catch (e) {
      console.error(e);
      showToast('Error al actualizar participante', 'error');
    } finally {
      setSavingOutcome(false);
    }
  };

  const fetchDevices = async () => {
    try {
      const res = await fetch('/api/devices', { headers: { Authorization: `Bearer ${token()}` } });
      const data = await res.json();
      if (data.success) setDevices((data.devices || []).filter((d: Device) => d.status === 'connected'));
    } catch (e) { console.error(e); }
  };

  const fetchStats = useCallback(async (months: string[]) => {
    statsRequestRef.current?.abort();
    const controller = new AbortController();
    statsRequestRef.current = controller;
    const requestID = ++statsRequestSequence.current;
    setStatsStatus('loading');
    setStatsError('');
    try {
      const params = new URLSearchParams();
      if (months.length > 0) params.set('months', [...months].sort().join(','));
      const qs = params.toString();
      const res = await fetch(`/api/programs/${programId}/attendance-stats${qs ? '?' + qs : ''}`, {
        headers: { Authorization: `Bearer ${token()}` },
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({})) as Partial<ProgramAttendanceStatsResponse>;
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'No se pudieron cargar las estadísticas.');
      }
      if (requestID !== statsRequestSequence.current) return;
      setStatsData({
        success: true,
        session_stats: data.session_stats || [],
        participant_stats: data.participant_stats || [],
      });
      setStatsStatus('success');
    } catch (error) {
      if (controller.signal.aborted || requestID !== statsRequestSequence.current) return;
      setStatsError(error instanceof Error ? error.message : 'No se pudieron cargar las estadísticas.');
      setStatsStatus('error');
    }
  }, [programId]);

  const selectedMonthsKey = useMemo(() => [...selectedMonths].sort().join(','), [selectedMonths]);

  useEffect(() => {
    if (activeTab !== 'stats') return;
    void fetchStats(selectedMonthsKey ? selectedMonthsKey.split(',') : []);
    return () => statsRequestRef.current?.abort();
  }, [activeTab, fetchStats, selectedMonthsKey]);

  const handleAddParticipants = async (selected: SelectedPerson[]) => {
    if (selected.length === 0 || addingParticipants) return;
    if (!program || program.status !== 'active') {
      setAddParticipantError('Solo puedes agregar participantes a un programa activo.');
      return;
    }
    setAddingParticipants(true);
    setAddParticipantError('');
    try {
      const response = await api<{
        success: boolean;
        summary: { requested: number; created: number; already_present: number; rejected: number };
      }>(`/api/programs/${programId}/participants/bulk`, {
        method: 'POST',
        body: JSON.stringify({ contact_ids: selected.map(person => person.id) }),
      });
      if (!response.success || !response.data?.success) {
        setAddParticipantError(response.error || 'No pudimos agregar los contactos. Inténtalo nuevamente.');
        return;
      }

      const summary = response.data.summary;
      setParticipantLifecycleView('active');
      setParticipantSelectorRevision(current => current + 1);
      fetchProgramData();
      if (summary.rejected > 0 || summary.created === 0) {
        const parts = [];
        if (summary.created > 0) parts.push(`${summary.created} agregado${summary.created === 1 ? '' : 's'}`);
        if (summary.already_present > 0) parts.push(`${summary.already_present} ya pertenecía${summary.already_present === 1 ? '' : 'n'} al programa`);
        if (summary.rejected > 0) parts.push(`${summary.rejected} no pudo${summary.rejected === 1 ? '' : 'ieron'} agregarse`);
        setAddParticipantError(parts.join('. ') + '.');
        return;
      }
      setIsAddParticipantOpen(false);
      showToast(`${summary.created} participante${summary.created === 1 ? '' : 's'} agregado${summary.created === 1 ? '' : 's'}`, 'success');
    } catch (error) {
      console.error('Error adding participants:', error);
      setAddParticipantError('No pudimos conectar con el servidor. Inténtalo nuevamente.');
    } finally {
      setAddingParticipants(false);
    }
  };

  const closeAddParticipantSelector = () => {
    if (addingParticipants) return;
    setIsAddParticipantOpen(false);
    setAddParticipantError('');
  };

  // Edit program
  const openEditModal = () => {
    if (program) {
      setEditForm({
        name: program.name,
        description: program.description || '',
        color: program.color || '#10b981',
        status: program.status,
      });
      setIsEditModalOpen(true);
      setShowHeaderMenu(false);
    }
  };

  const handleUpdateProgram = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!program) return;
    setSaving(true);
    try {
      const res = await api(`/api/programs/${programId}`, {
        method: 'PUT',
        body: JSON.stringify(editForm)
      });
      if (res.success) {
        setIsEditModalOpen(false);
        showToast('Programa actualizado', 'success');
        fetchProgramData();
      } else {
        showToast('Error al actualizar programa', 'error');
      }
    } catch (error) {
      console.error('Error updating program:', error);
      showToast('Error al actualizar programa', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProgram = async () => {
    setShowHeaderMenu(false);
    setConfirmAction({
      message: '¿Estás seguro de eliminar este programa? Se eliminarán también todos sus participantes, sesiones y asistencia.',
      onConfirm: async () => {
        setConfirmAction(null);
        try {
          const res = await api(`/api/programs/${programId}`, { method: 'DELETE' });
          if (res.success) {
            showToast('Programa eliminado', 'success');
            router.push('/dashboard/programs');
          } else {
            showToast('Error al eliminar programa', 'error');
          }
        } catch (error) {
          console.error('Error deleting program:', error);
          showToast('Error al eliminar programa', 'error');
        }
      },
    });
  };

  const handleArchiveProgram = async () => {
    if (!program) return;
    const newStatus = program.status === 'archived' ? 'active' : 'archived';
    try {
      const res = await api(`/api/programs/${programId}`, {
        method: 'PUT',
        body: JSON.stringify({ ...program, status: newStatus, description: program.description || '' })
      });
      if (res.success) {
        showToast(newStatus === 'archived' ? 'Programa archivado' : 'Programa desarchivado', 'success');
        fetchProgramData();
      } else {
        showToast('Error al cambiar estado del programa', 'error');
      }
      setShowHeaderMenu(false);
    } catch (error) {
      console.error('Error archiving program:', error);
      showToast('Error al cambiar estado del programa', 'error');
    }
  };

  // Participant detail — programs are contact-only by spec (001-program-contacts-only)
  const openParticipantDetail = async (participantID: string, contactID: string, returnFocus?: HTMLElement | null) => {
    participantDetailRequestRef.current?.abort();
    const controller = new AbortController();
    participantDetailRequestRef.current = controller;
    const requestID = ++participantDetailSequence.current;
    if (returnFocus !== undefined) participantDetailReturnFocusRef.current = returnFocus;
    setSelectedParticipantID(participantID);
    setSelectedContact(null);
    setParticipantDetailOpen(true);
    setParticipantDetailError('');
    setLoadingLead(true);
    try {
      const params = new URLSearchParams({ context_type: 'program_participant', context_id: participantID });
      const res = await fetch(`/api/contact-profiles/${contactID}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token()}` },
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok || !data.success || !data.contact) throw new Error(data.error || 'No se pudo cargar el contacto.');
      if (controller.signal.aborted || requestID !== participantDetailSequence.current) return;
      setSelectedContact(data.contact);
    } catch (error) {
      if (controller.signal.aborted || requestID !== participantDetailSequence.current) return;
      setParticipantDetailError(error instanceof Error ? error.message : 'No se pudo cargar el participante.');
    } finally {
      if (!controller.signal.aborted && requestID === participantDetailSequence.current) setLoadingLead(false);
    }
  };

  const handleParticipantClick = (participant: ProgramParticipant, returnFocus?: HTMLElement | null) => {
    if (!participant.contact_id) return;
    void openParticipantDetail(participant.id, participant.contact_id, returnFocus);
  };

  const retryParticipantDetail = () => {
    if (!selectedParticipantID) return;
    const participant = participants.find(item => item.id === selectedParticipantID);
    const healthParticipant = health?.participants.find(item => item.participant_id === selectedParticipantID);
    const contactID = participant?.contact_id || healthParticipant?.contact_id;
    if (contactID) void openParticipantDetail(selectedParticipantID, contactID);
  };

  const reconcileProgramContact = useCallback((updated: ContactProfileContact) => {
    const nextName = updated.custom_name || updated.name || updated.push_name || updated.phone || 'Sin nombre';
    setSelectedContact(current => current?.id === updated.id ? updated : current);
    setParticipants(current => current.map(participant => participant.contact_id === updated.id ? {
      ...participant,
      contact_name: nextName,
      contact_phone: updated.phone || undefined,
      avatar_url: updated.avatar_url || null,
      avatar_revision: updated.avatar_revision || 0,
    } : participant));
    setHealth(current => current ? {
      ...current,
      participants: current.participants.map(participant => participant.contact_id === updated.id ? {
        ...participant,
        name: nextName,
        phone: updated.phone || undefined,
        avatar_url: updated.avatar_url || null,
        avatar_revision: updated.avatar_revision || 0,
      } : participant),
    } : current);
  }, []);

  const handleParticipantContactChange = reconcileProgramContact;

  const handleParticipantEnrollmentChange = useCallback((participantID: string, enrolledAt: string) => {
    setParticipants(current => current.map(participant => participant.id === participantID
      ? { ...participant, enrolled_at: enrolledAt }
      : participant));
    setToastType('success');
    setToastMessage('Fecha de incorporación actualizada.');
    void fetchHealth();
    if (activeTab === 'stats') {
      void fetchStats(selectedMonthsKey ? selectedMonthsKey.split(',') : []);
    }
  }, [activeTab, fetchHealth, fetchStats, selectedMonthsKey]);

  useEffect(() => {
    const contexts = new Map<string, string>();
    participants.forEach(participant => {
      if (participant.contact_id && !contexts.has(participant.contact_id)) contexts.set(participant.contact_id, participant.id);
    });
    (health?.participants || []).forEach(participant => {
      if (participant.contact_id && !contexts.has(participant.contact_id)) contexts.set(participant.contact_id, participant.participant_id);
    });
    participantContextByContactRef.current = contexts;
  }, [health?.participants, participants]);

  const refreshLoadedParticipantContact = useCallback(async (contactID: string) => {
    const participantID = participantContextByContactRef.current.get(contactID);
    if (!participantID) return;
    const sequence = (contactRefreshSequenceRef.current.get(contactID) || 0) + 1;
    contactRefreshSequenceRef.current.set(contactID, sequence);
    const result = await api<ContactProfileResponse>(`/api/contact-profiles/${contactID}?context_type=program_participant&context_id=${participantID}`);
    if (contactRefreshSequenceRef.current.get(contactID) !== sequence) return;
    if (result.success && result.data?.success && result.data.contact) reconcileProgramContact(result.data.contact);
  }, [reconcileProgramContact]);

  useEffect(() => subscribeWebSocket(message => {
    if (!message || typeof message !== 'object' || (message as { event?: string }).event !== 'contact_update') return;
    const contactID = contactIdFromRealtimeEvent(message);
    if (contactID) void refreshLoadedParticipantContact(contactID);
  }), [refreshLoadedParticipantContact]);

  // WhatsApp chat
  const handleSendWhatsApp = async (phone: string) => {
    if (!phone || whatsappLaunching) return;
    setWhatsappLaunching(true);
    setWhatsappPhone(phone);
    try {
      const resolution = await resolveWhatsAppChat(phone);
      if (!resolution.success) {
        showToast(resolution.error || 'No se pudo resolver la conversación', 'error');
        return;
      }
      setExistingChatForWA(resolution.chat || null);
      setWhatsappHistoricalPhone(resolution.historical_phone || '');
      if (resolution.mode === 'read_only' && resolution.chat) {
        setInlineChatId(resolution.chat.id);
        setInlineChat(resolution.chat);
        setInlineChatDeviceId(resolution.chat.device_id || '');
        setInlineChatReadOnly(true);
        setShowInlineChat(true);
        return;
      }
      if (resolution.mode === 'open_direct' && resolution.devices[0]) {
        await handleDeviceSelectedForChat(resolution.devices[0] as Device, phone);
        return;
      }
      if (resolution.mode === 'choose_device') {
        setDevices(resolution.devices as Device[]);
        setShowDeviceSelector(true);
        return;
      }
      showToast('No hay dispositivos conectados para enviar', 'error');
    } catch {
      showToast('No se pudo conectar con WhatsApp', 'error');
    } finally {
      setWhatsappLaunching(false);
    }
  };

  const handleDeviceSelectedForChat = async (device: Device, phone?: string) => {
    if (whatsappCreating) return;
    setWhatsappCreating(true);
    setShowDeviceSelector(false);
    setInlineChatReadOnly(false);
    try {
      const data = await createWhatsAppChat(device.id, phone || whatsappPhone);
      if (data.success && data.chat) {
        setInlineChatId(data.chat.id);
        setInlineChat(data.chat);
        setInlineChatDeviceId(device.id);
        setShowInlineChat(true);
      } else {
        showToast(data.error || 'No se pudo abrir la conversación', 'error');
      }
    } catch {
      showToast('No se pudo conectar con WhatsApp', 'error');
    } finally {
      setWhatsappCreating(false);
    }
  };

  const openCreateSession = (sessionType: 'regular' | 'recovery' = 'regular') => {
    const topics: ProgramSessionTopic[] = sessionType === 'recovery' ? [{ kind: 'free', title: 'Clase de recuperación' }] : [];
    const fallbackTitle = `Sesión ${sessions.length + 1}`;
    setNewSession({
      title: suggestedSessionTitle(topics) || fallbackTitle,
      date: localDateInputValue(),
      topics,
      session_type: sessionType,
      start_time: '',
      end_time: '',
      location: '',
    });
    setNewSessionTitleEdited(false);
    setIsCreateSessionOpen(true);
  };

  const handleCreateSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingSession) return;
    if (!newSession.title.trim()) {
      showToast('Escribe un título para la sesión.', 'error');
      return;
    }
    if (newSession.topics.length === 0 || newSession.topics.some(topic => !topic.title.trim())) {
      showToast('Escribe o selecciona al menos un tema para la sesión.', 'error');
      return;
    }
    if (newSession.start_time && newSession.end_time && newSession.end_time <= newSession.start_time) {
      showToast('La hora de fin debe ser posterior a la hora de inicio.', 'error');
      return;
    }
    setCreatingSession(true);
    try {
      const res = await api(`/api/programs/${programId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          ...newSession,
          title: newSession.title.trim(),
          topics: newSession.topics.map(topic => ({ kind: topic.kind, course_topic_id: topic.course_topic_id || undefined, title: topic.title.trim() })),
          start_time: newSession.start_time || undefined,
          end_time: newSession.end_time || undefined,
          location: newSession.location || undefined,
        })
      });
      if (res.success) {
        setIsCreateSessionOpen(false);
        setMaximizedSessionDialog(null);
        setNewSession({ title: '', date: localDateInputValue(), topics: [], session_type: 'regular', start_time: '', end_time: '', location: '' });
        setNewSessionTitleEdited(false);
        showToast('Sesión creada', 'success');
        fetchProgramData();
      } else {
        showToast(res.error || 'Error al crear sesión', 'error');
      }
    } catch (error) {
      console.error('Error creating session:', error);
      showToast('Error al crear sesión', 'error');
    } finally {
      setCreatingSession(false);
    }
  };

  const openEditSession = (session: ProgramSession) => {
    const topics = normalizedSessionTopics(session);
    const sessionIndex = sessions.findIndex(candidate => candidate.id === session.id);
    const title = sessionDisplayTitle(session, `Sesión ${sessionIndex >= 0 ? sessionIndex + 1 : 1}`);
    setEditSessionForm({
      title,
      date: session.date ? session.date.split('T')[0] : '',
      topics,
      session_type: session.session_type || 'regular',
      start_time: session.start_time || '',
      end_time: session.end_time || '',
      location: session.location || '',
    });
    // An existing title is always treated as an explicit decision: changing its
    // plan topics must never rename the session behind the user's back.
    setEditSessionTitleEdited(true);
    setEditingSession(session);
  };

  const handleUpdateSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSession) return;
    if (!editSessionForm.title.trim()) {
      showToast('Escribe un título para la sesión.', 'error');
      return;
    }
    if (editSessionForm.topics.length === 0 || editSessionForm.topics.some(topic => !topic.title.trim())) {
      showToast('Escribe o selecciona al menos un tema para la sesión.', 'error');
      return;
    }
    if (editSessionForm.start_time && editSessionForm.end_time && editSessionForm.end_time <= editSessionForm.start_time) {
      showToast('La hora de fin debe ser posterior a la hora de inicio.', 'error');
      return;
    }
    setSavingSession(true);
    try {
      const res = await api(`/api/programs/${programId}/sessions/${editingSession.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...editSessionForm,
          title: editSessionForm.title.trim(),
          topics: editSessionForm.topics.map(topic => ({ kind: topic.kind, course_topic_id: topic.course_topic_id || undefined, title: topic.title.trim() })),
          start_time: editSessionForm.start_time || undefined,
          end_time: editSessionForm.end_time || undefined,
          location: editSessionForm.location || undefined,
        })
      });
      if (res.success) {
        setEditingSession(null);
        setMaximizedSessionDialog(null);
        showToast('Sesión actualizada', 'success');
        fetchProgramData();
      } else {
        showToast(res.error || 'Error al actualizar sesión', 'error');
      }
    } catch (error) {
      console.error('Error updating session:', error);
      showToast('Error al actualizar sesión', 'error');
    } finally {
      setSavingSession(false);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    setConfirmAction({
      message: '¿Estás seguro de eliminar esta sesión?',
      onConfirm: async () => {
        setConfirmAction(null);
        try {
          const res = await api(`/api/programs/${programId}/sessions/${sessionId}`, { method: 'DELETE' });
          if (res.success) {
            showToast('Sesión eliminada', 'success');
            fetchProgramData();
          } else {
            showToast('Error al eliminar sesión', 'error');
          }
        } catch (error) {
          console.error('Error deleting session:', error);
          showToast('Error al eliminar sesión', 'error');
        }
      },
    });
  };

  const openAttendance = async (session: ProgramSession) => {
    attendanceRequestRef.current?.abort();
    const controller = new AbortController();
    attendanceRequestRef.current = controller;
    const requestID = ++attendanceRequestSequence.current;
    setSelectedSession(session);
    setAttendanceData({});
    setAttendanceDirty({});
    setAttendanceLoadError('');
    setAttendanceLoadState('loading');
    setIsAttendanceOpen(true);
    try {
      const response = await api<ProgramAttendance[]>(`/api/programs/${programId}/sessions/${session.id}/attendance`, { signal: controller.signal });
      if (controller.signal.aborted || requestID !== attendanceRequestSequence.current) return;
      const attMap: Record<string, { status: string; observation_count: number; observation_preview: ProgramAttendanceObservation[] }> = {};

      if (response.success && (response.data == null || Array.isArray(response.data))) {
        (response.data || []).forEach((a: ProgramAttendance) => {
          attMap[a.participant_id] = {
            status: a.status || '',
            observation_count: a.observation_count || 0,
            observation_preview: Array.isArray(a.observation_preview) ? a.observation_preview : [],
          };
        });
      } else {
        throw new Error(response.error || 'No se pudo cargar la asistencia');
      }

      setAttendanceData(attMap);
      setAttendanceLoadState('success');
    } catch (error) {
      if (controller.signal.aborted || requestID !== attendanceRequestSequence.current) return;
      console.error('Error fetching attendance:', error);
      setAttendanceLoadError(error instanceof Error ? error.message : 'No se pudo cargar la asistencia.');
      setAttendanceLoadState('error');
    } finally {
      if (requestID === attendanceRequestSequence.current) attendanceRequestRef.current = null;
    }
  };

  const requestCloseAttendance = () => {
    if (Object.keys(attendanceDirty).length === 0) {
      closeAttendanceModal();
      return;
    }
    setConfirmAction({
      message: 'Hay cambios de asistencia sin guardar. ¿Deseas descartarlos?',
      onConfirm: () => { setConfirmAction(null); closeAttendanceModal(); },
    });
  };

  const loadAttendanceObservationHistory = async (participant: ProgramParticipant) => {
    if (!selectedSession) return;
    attendanceObservationRequestRef.current?.abort();
    const controller = new AbortController();
    attendanceObservationRequestRef.current = controller;
    const requestID = ++attendanceObservationRequestSequence.current;
    const sessionID = selectedSession.id;
    setAttendanceObservationParticipant(participant);
    setAttendanceObservationComposerOpen(false);
    setAttendanceObservationLoading(true);
    setAttendanceObservationError('');
    try {
      const response = await api<{ success: boolean; observations: ProgramAttendanceObservation[] }>(`/api/programs/${programId}/sessions/${sessionID}/participants/${participant.id}/attendance-observations`, { signal: controller.signal });
      if (controller.signal.aborted || requestID !== attendanceObservationRequestSequence.current) return;
      if (!response.success || !response.data?.success) throw new Error(response.error || 'No se pudo cargar el historial.');
      const observations = Array.isArray(response.data.observations) ? response.data.observations : [];
      setAttendanceObservationHistory(observations.map(observation => ({
        id: observation.id,
        contact_id: participant.contact_id || null,
        lead_id: null,
        type: 'attendance',
        direction: null,
        outcome: null,
        notes: observation.notes,
        created_by_name: observation.created_by_name || null,
        created_at: observation.created_at,
        program_id: programId,
        program_session_id: sessionID,
        program_participant_id: participant.id,
        source_label: observation.source_label || null,
      })));
      setAttendanceData(current => ({
        ...current,
        [participant.id]: {
          status: current[participant.id]?.status || '',
          observation_count: observations.length,
          observation_preview: observations.slice(0, 1),
        },
      }));
    } catch (error) {
      if (controller.signal.aborted || requestID !== attendanceObservationRequestSequence.current) return;
      console.error('Error fetching attendance observations:', error);
      setAttendanceObservationHistory([]);
      setAttendanceObservationError('No se pudieron cargar las observaciones de esta asistencia.');
    } finally {
      if (requestID === attendanceObservationRequestSequence.current) {
        attendanceObservationRequestRef.current = null;
        setAttendanceObservationLoading(false);
      }
    }
  };

  const saveAttendance = async () => {
    if (!selectedSession) return;
    try {
      setSavingAttendance(true);
      const records = Object.entries(attendanceData)
        .filter(([participantId]) => attendanceDirty[participantId])
        .map(([participantId, data]) => ({
          participant_id: participantId,
          status: data.status || '',
        }));
      if (records.length > 0) {
        const result = await api<{ success: boolean; count: number }>(`/api/programs/${programId}/sessions/${selectedSession.id}/attendance/batch`, {
          method: 'POST',
          body: JSON.stringify({ records })
        });
        if (!result.success) throw new Error(result.error || 'No se pudo guardar la asistencia');
      }
      closeAttendanceModal();
      fetchProgramData();
      fetchHealth();
    } catch (error) {
      console.error('Error saving attendance:', error);
      showToast('No se pudo guardar la asistencia. No se aplicaron cambios parciales.', 'error');
    } finally {
      setSavingAttendance(false);
    }
  };

  // Kanban drag/drop handlers
  const handleStageDragStart = (e: React.DragEvent, participantID: string) => {
    setDraggedParticipantID(participantID);
    try { e.dataTransfer.effectAllowed = 'move'; } catch {}
  };
  const handleStageDragOver = (e: React.DragEvent, stageID: string) => {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    if (dragOverStageID !== stageID) setDragOverStageID(stageID);
  };
  const handleStageDragLeave = () => setDragOverStageID(null);
  const moveParticipantToStage = async (pid: string, stageID: string | null) => {
    if (!pid) return;
    if (movingStageParticipantIDs.has(pid)) return;
    const participant = participants.find(p => p.id === pid);
    if (!participant) return;
    if ((participant.stage_id || null) === (stageID || null)) return;
    const previousStage = {
      stage_id: participant.stage_id,
      stage_name: participant.stage_name,
      stage_color: participant.stage_color,
    };
    const rollback = () => setParticipants(current => current.map(item => item.id === pid ? { ...item, ...previousStage } : item));
    // Optimistic update
    setParticipants(prev => prev.map(p =>
      p.id === pid ? { ...p, stage_id: stageID || undefined, stage_name: stages.find(s => s.id === stageID)?.name, stage_color: stages.find(s => s.id === stageID)?.color } : p
    ));
    setMovingStageParticipantIDs(current => new Set(current).add(pid));
    try {
      const res = await api(`/api/programs/${programId}/participants/${pid}/stage`, {
        method: 'PATCH',
        body: JSON.stringify({ stage_id: stageID }),
      });
      if (!res.success) {
        rollback();
        showToast((res as any).error || 'Error al mover participante', 'error');
        void fetchProgramData();
      } else {
        showToast('Participante movido', 'success');
      }
    } catch (err) {
      console.error(err);
      rollback();
      showToast('Error al mover participante', 'error');
      void fetchProgramData();
    } finally {
      setMovingStageParticipantIDs(current => {
        const next = new Set(current);
        next.delete(pid);
        return next;
      });
    }
  };
  const handleStageDrop = async (e: React.DragEvent, stageID: string | null) => {
    e.preventDefault();
    const pid = draggedParticipantID;
    setDraggedParticipantID(null);
    setDragOverStageID(null);
    if (!pid) return;
    await moveParticipantToStage(pid, stageID);
  };

  // Generate Sessions
  const handleGenerateSessions = async () => {
    if (!genForm.start_date || !genForm.end_date || genForm.days_of_week.length === 0) {
      showToast('Completa la fecha de inicio, fin y al menos un día de la semana.', 'error');
      return;
    }
    if (genForm.end_date < genForm.start_date) {
      showToast('La fecha de fin debe ser igual o posterior a la fecha de inicio.', 'error');
      return;
    }
    if (schedulePreview.error) {
      showToast(schedulePreview.error, 'error');
      return;
    }
    if (genForm.start_time && genForm.end_time && genForm.end_time <= genForm.start_time) {
      showToast('La hora de fin debe ser posterior a la hora de inicio.', 'error');
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
      const data = await res.json() as {
        success?: boolean;
        count?: number;
        sessions?: ProgramSession[];
        assigned_topic_count?: number;
        fallback_count?: number;
        warning?: string;
        error?: string;
      };
      if (data.success) {
        const generatedCount = data.count || data.sessions?.length || 0;
        const assignmentSummary = genForm.assign_course_topics
          ? ` ${data.assigned_topic_count || 0} recibieron un tema del plan${data.fallback_count ? ` y ${data.fallback_count} usaron un tema libre de respaldo` : ''}.`
          : '';
        showToast(`Se generaron ${generatedCount} sesiones.${assignmentSummary}${data.warning ? ` ${data.warning}` : ''}`, 'success');
        setIsGenerateSessionsOpen(false);
        setMaximizedSessionDialog(null);
        fetchProgramData();
      } else {
        showToast(data.error || 'Error al generar sesiones', 'error');
      }
    } catch (e) {
      console.error(e);
      showToast('Error de conexión', 'error');
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
    () => activeParticipants.filter(p => p.contact_phone && p.contact_phone.length > 5),
    [activeParticipants]
  );

  const handleCreateCampaign = async (formResult: CampaignFormResult) => {
    setCreatingCampaign(true);
    let createdCampaignId: string | null = null;
    try {
      const res = await fetch(`/api/programs/${programId}/campaign`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formResult.name,
          device_id: formResult.device_id,
          message_template: formResult.message_template,
          attachments: formResult.attachments,
          settings: formResult.settings,
        }),
      });
      const data = await res.json().catch(() => null) as {
        success?: boolean;
        campaign?: { id?: string };
        error?: string;
      } | null;
      if (!res.ok || !data?.success || !data.campaign?.id) {
        throw new Error(data?.error || 'No se pudo crear la campaña');
      }

      createdCampaignId = data.campaign.id;

      // Persistir primero los teléfonos pegados evita que una campaña
      // programada comience sin este lote de destinatarios.
      if (formResult.recipients && formResult.recipients.length > 0) {
        const sheetRecipients = formResult.recipients.map(r => ({
          jid: r.phone + '@s.whatsapp.net',
          name: r.name || '',
          phone: r.phone,
          metadata: r.metadata || {},
        }));
        const recipientsResponse = await fetch(`/api/campaigns/${createdCampaignId}/recipients`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipients: sheetRecipients, save_as_contacts: true }),
        });
        const recipientsData = await recipientsResponse.json().catch(() => null) as {
          success?: boolean;
          count?: number;
          error?: string;
        } | null;
        if (!recipientsResponse.ok || !recipientsData?.success || typeof recipientsData.count !== 'number') {
          throw new Error(recipientsData?.error || 'No se pudieron confirmar los destinatarios pegados');
        }
      }

      if (formResult.scheduled_at) {
        const scheduleResponse = await fetch(`/api/campaigns/${createdCampaignId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'scheduled', scheduled_at: formResult.scheduled_at }),
        });
        const scheduleData = await scheduleResponse.json().catch(() => null) as {
          success?: boolean;
          error?: string;
        } | null;
        if (!scheduleResponse.ok || !scheduleData?.success) {
          throw new Error(scheduleData?.error || 'Los destinatarios se guardaron, pero no se pudo programar la campaña');
        }
      }

      let canonicalRecipientCount: number | null = null;
      try {
        const campaignResponse = await fetch(`/api/campaigns/${createdCampaignId}`, {
          headers: { Authorization: `Bearer ${token()}` },
        });
        const campaignData = await campaignResponse.json().catch(() => null) as {
          success?: boolean;
          campaign?: { total_recipients?: number };
        } | null;
        const reportedTotal = campaignData?.campaign?.total_recipients;
        if (campaignResponse.ok && campaignData?.success && typeof reportedTotal === 'number' && Number.isFinite(reportedTotal)) {
          canonicalRecipientCount = reportedTotal;
        }
      } catch (error) {
        console.warn('No se pudo confirmar el total de destinatarios de la campaña', error);
      }

      alert(canonicalRecipientCount === null
        ? 'Campaña creada correctamente. Puedes verla en Envíos Masivos.'
        : `Campaña creada con ${canonicalRecipientCount} destinatarios. Puedes verla en Envíos Masivos.`);
      setShowCampaignModal(false);
    } catch (e) {
      console.error(e);
      const message = e instanceof Error ? e.message : 'Error de conexión';
      if (createdCampaignId) {
        alert(`La campaña quedó creada, pero no se pudo completar: ${message}. Revísala en Envíos Masivos antes de iniciarla.`);
        setShowCampaignModal(false);
      } else {
        alert(message);
      }
    } finally {
      setCreatingCampaign(false);
    }
  };

  // Preview sessions count
  const schedulePreview = useMemo(() => {
    if (!genForm.start_date || !genForm.end_date || genForm.days_of_week.length === 0) return { count: 0, error: '' };
    const start = new Date(`${genForm.start_date}T00:00:00Z`);
    const end = new Date(`${genForm.end_date}T00:00:00Z`);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return { count: 0, error: '' };
    const totalDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (totalDays > MAX_SCHEDULE_RANGE_DAYS) {
      return { count: 0, error: 'El horario no puede abarcar más de dos años.' };
    }
    const selectedDays = new Set(genForm.days_of_week);
    const fullWeeks = Math.floor(totalDays / 7);
    let count = fullWeeks * selectedDays.size;
    const remainingDays = totalDays % 7;
    for (let offset = 0; offset < remainingDays; offset += 1) {
      if (selectedDays.has((start.getUTCDay() + offset) % 7)) count += 1;
    }
    if (count > MAX_GENERATED_SESSIONS) {
      return { count, error: `Un horario puede generar como máximo ${MAX_GENERATED_SESSIONS} sesiones.` };
    }
    return { count, error: '' };
  }, [genForm.start_date, genForm.end_date, genForm.days_of_week]);
  const previewSessionCount = schedulePreview.count;

  if (loading) {
    return (
      <div ref={workspaceRef} className="mx-auto h-full max-w-7xl p-6 lg:p-8">
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

  if (detailError && !program) {
    return (
      <div ref={workspaceRef} role="alert" className="h-full px-4 pt-16 text-center sm:p-6 sm:pt-20">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50">
          <AlertCircle className="h-8 w-8 text-red-400" />
        </div>
        <h2 className="text-xl font-bold text-slate-800">No se pudo cargar el programa</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-slate-500">{detailError}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={() => { void fetchProgramData(); }} className="min-h-11 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700">Reintentar</button>
          <button onClick={() => router.push('/dashboard/programs')} className="min-h-11 rounded-xl border border-slate-200 bg-white px-5 text-sm font-medium text-slate-600 hover:bg-slate-50">
            Volver a Programas
          </button>
        </div>
      </div>
    );
  }

  if (programNotFound || !program) {
    return (
      <div ref={workspaceRef} className="h-full p-6 pt-20 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100">
          <GraduationCap className="h-8 w-8 text-slate-400" />
        </div>
        <h2 className="mb-2 text-xl font-bold text-slate-800">Programa no encontrado</h2>
        <button onClick={() => router.push('/dashboard/programs')} className="mt-2 min-h-11 font-medium text-emerald-600 hover:underline">
          Volver a Programas
        </button>
      </div>
    );
  }

  const selectedProgramParticipant = selectedParticipantID
    ? participants.find(participant => participant.id === selectedParticipantID) || null
    : null;

  const formatPct = (value?: number) => `${Math.round(value || 0)}%`;
  const healthClass = (value?: string) => {
    if (value === 'critical') return 'bg-red-50 text-red-700 border-red-100';
    if (value === 'watch') return 'bg-amber-50 text-amber-700 border-amber-100';
    return 'bg-emerald-50 text-emerald-700 border-emerald-100';
  };
  const healthLabel = (value?: string) => {
    if (value === 'critical') return 'Crítico';
    if (value === 'watch') return 'Observar';
    return 'Saludable';
  };
  const renderStageSelect = (participant: ProgramParticipant) => touchWorkspace && !mobileWorkspace ? (
    <label className="mt-3 block">
      <span className="mb-1 block text-[11px] font-medium text-slate-500">Mover a etapa</span>
      <select
        value={participant.stage_id || ''}
        disabled={movingStageParticipantIDs.has(participant.id)}
        onChange={(event) => { void moveParticipantToStage(participant.id, event.target.value || null); }}
        onClick={event => event.stopPropagation()}
        className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 disabled:cursor-wait disabled:opacity-60"
        aria-label={`Mover a etapa a ${participant.contact_name || 'participante'}`}
      >
        <option value="">Sin etapa</option>
        {[...stages].sort((a, b) => a.position - b.position).map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
      </select>
    </label>
  ) : null;

  return (
    <div ref={workspaceRef} className="h-full min-h-0 overflow-hidden flex flex-col gap-3">
      {detailError && (
        <div role="alert" className="flex shrink-0 flex-col gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between">
          <span className="flex min-w-0 items-start gap-2"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{detailError}</span>
          <button type="button" onClick={() => { void fetchProgramData(); }} className="min-h-11 shrink-0 rounded-xl border border-red-200 bg-white px-4 font-semibold hover:bg-red-100">Reintentar</button>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          onClick={() => requestProgramNavigation('/dashboard/programs')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-slate-100"
          aria-label="Volver a Programas"
        >
          <ArrowLeft className="w-5 h-5 text-slate-600" />
        </button>
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-base shadow-sm shrink-0"
          style={{ backgroundColor: program.color || '#10b981' }}
        >
          {program.name.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 truncate text-lg font-bold leading-tight text-slate-800">{program.name}</h1>
            {mobileWorkspace && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700" aria-label={`${activeParticipants.length} participantes`}><Users className="h-3 w-3" />{activeParticipants.length}</span>}
          </div>
          <p className="text-slate-500 text-xs truncate">{program.description || 'Sin descripción'}</p>
        </div>
        {mobileWorkspace && <button type="button" onClick={() => setShowSectionPicker(true)} className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={`Cambiar sección. Actual: ${activeTab === 'sessions' ? 'Sesiones' : activeTab === 'stats' ? 'Estadísticas' : activeTab === 'academic' ? 'Plan e instructores' : activeTab === 'surveys' ? 'Encuestas' : activeTab === 'kanban' ? 'Tablero' : 'Participantes'}`} aria-haspopup="dialog" aria-expanded={showSectionPicker}>
          {activeTab === 'sessions' ? <Calendar className="h-5 w-5" /> : activeTab === 'stats' ? <BarChart3 className="h-5 w-5" /> : activeTab === 'academic' ? <GraduationCap className="h-5 w-5" /> : activeTab === 'surveys' ? <ClipboardList className="h-5 w-5" /> : activeTab === 'kanban' ? <LayoutGrid className="h-5 w-5" /> : <Users className="h-5 w-5" />}
          <ChevronDown className="absolute bottom-1 right-1 h-2.5 w-2.5 text-slate-400" />
        </button>}
        {!mobileWorkspace && <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCampaignModal(true)}
            disabled={participantsWithPhone.length === 0}
            className="hidden sm:flex items-center gap-2 px-4 py-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition-all shadow-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" />
            Envío Masivo
          </button>
          <button
            onClick={openEditModal}
            className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            title="Editar programa"
          >
            <Edit2 className="w-4 h-4" />
          </button>
          <div className="relative">
            <button
              onClick={() => setShowHeaderMenu(!showHeaderMenu)}
              className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
              title="Más opciones"
            >
              <MoreVertical className="w-4 h-4" />
            </button>
            {showHeaderMenu && (
              <div className="absolute right-0 top-full mt-1 bg-white rounded-xl border border-slate-200 shadow-lg py-1 w-48 z-50">
                <button
                  onClick={() => { setShowHeaderMenu(false); setShowCampaignModal(true); }}
                  disabled={participantsWithPhone.length === 0}
                  className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-sm text-emerald-700 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 sm:hidden"
                >
                  <Send className="h-4 w-4" />
                  Envío Masivo
                </button>
                <button
                  onClick={handleArchiveProgram}
                  className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 transition-colors hover:bg-slate-50"
                >
                  <Archive className="w-4 h-4" />
                  {program.status === 'archived' ? 'Desarchivar' : 'Archivar'}
                </button>
                <button
                  onClick={handleDeleteProgram}
                  className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 transition-colors hover:bg-red-50"
                >
                  <Trash2 className="w-4 h-4" />
                  Eliminar Programa
                </button>
              </div>
            )}
          </div>
        </div>}
      </div>

      {/* Tabs */}
      {mobileWorkspace ? null : <div className="flex shrink-0 gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {program?.type === 'event' ? (
          <button
            onClick={() => requestTabChange('kanban')}
            className={`flex min-h-11 min-w-max flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-medium transition-all sm:min-w-0 ${
              activeTab === 'kanban'
                ? 'bg-white text-slate-800 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
            Kanban ({stages.length})
          </button>
        ) : (
          <>
            <button
              onClick={() => requestTabChange('health')}
              className={`flex min-h-11 min-w-max flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-medium transition-all sm:min-w-0 ${
                activeTab === 'health'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Users className="w-4 h-4" />
              Participantes ({activeParticipants.length})
            </button>
            <button
              onClick={() => requestTabChange('academic')}
              className={`flex min-h-11 min-w-max flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-medium transition-all sm:min-w-0 ${
                activeTab === 'academic'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <GraduationCap className="w-4 h-4" />
              Plan e instructores
            </button>
            <button
              onClick={() => requestTabChange('sessions')}
              className={`flex min-h-11 min-w-max flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-medium transition-all sm:min-w-0 ${
                activeTab === 'sessions'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Calendar className="w-4 h-4" />
              Sesiones ({sessions.length})
            </button>
            <button
              onClick={() => requestTabChange('stats')}
              className={`flex min-h-11 min-w-max flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-medium transition-all sm:min-w-0 ${
                activeTab === 'stats'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <BarChart3 className="w-4 h-4" />
              Estadísticas
            </button>
            {canUseSurveys && <button
              onClick={() => requestTabChange('surveys')}
              className={`flex min-h-11 min-w-max flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-medium transition-all sm:min-w-0 ${
                activeTab === 'surveys'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <ClipboardList className="w-4 h-4" />
              Encuestas
            </button>}
          </>
        )}
        {program?.type === 'event' && (
          <button
            onClick={() => requestTabChange('participants')}
            className={`flex min-h-11 min-w-max flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-medium transition-all sm:min-w-0 ${
              activeTab === 'participants'
                ? 'bg-white text-slate-800 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Users className="w-4 h-4" />
            Participantes ({activeParticipants.length})
          </button>
        )}
      </div>}

      {(activeTab === 'health' || activeTab === 'participants') && <div className="flex shrink-0 items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={participantSearch}
            onChange={event => setParticipantSearch(event.target.value)}
            onFocus={() => setParticipantSearchFocused(true)}
            onBlur={() => setParticipantSearchFocused(false)}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            enterKeyHint="search"
            placeholder="Buscar participante por nombre o teléfono"
            aria-label="Buscar participante por nombre o teléfono"
            className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-24 text-sm text-slate-800 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20"
          />
          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
            {participantSearchPending
              ? <span className="flex items-center gap-1 px-2 text-[11px] font-semibold text-slate-400" aria-live="polite"><Loader2 className="h-3.5 w-3.5 animate-spin" /><span className="sr-only">Buscando participantes</span><span className="hidden min-[380px]:inline" aria-hidden="true">Buscando</span></span>
              : <span className="px-2 text-[11px] font-semibold text-slate-400" aria-live="polite">{filteredProgramParticipants.length}/{lifecycleParticipants.length}</span>}
            {participantSearch && <button type="button" onClick={() => { setParticipantSearch(''); setDebouncedParticipantSearch(''); }} className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Limpiar búsqueda"><X className="h-4 w-4" /></button>}
          </div>
        </div>
        <div aria-hidden={participantExportCollapsed} className={`shrink-0 overflow-hidden transition-[max-width,opacity] duration-150 ease-out motion-reduce:transition-none ${participantExportCollapsed ? 'pointer-events-none max-w-0 opacity-0' : 'max-w-[10rem] opacity-100'}`}>
          <button type="button" tabIndex={participantExportCollapsed ? -1 : 0} onClick={() => { void handleExportParticipants(); }} disabled={participantSearchPending || exportingParticipants || filteredProgramParticipants.length === 0} className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-white px-3 text-sm font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40" title="Exportar exactamente la lista filtrada a Excel" aria-label="Exportar participantes filtrados a Excel">{exportingParticipants ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}<span className="hidden sm:inline">Exportar Excel</span></button>
        </div>
        {mobileWorkspace && <button type="button" onClick={() => setIsAddParticipantOpen(true)} disabled={program?.status !== 'active'} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40" aria-label="Agregar participantes" title={program?.status !== 'active' ? 'Solo disponible para programas activos' : 'Agregar participantes'}><UserPlus className="h-4 w-4" /></button>}
      </div>}

      {(activeTab === 'health' || activeTab === 'participants') && <div className="grid shrink-0 grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Estado de participantes">
        <button type="button" role="tab" aria-selected={participantLifecycleView === 'active'} onClick={() => setParticipantLifecycleView('active')} className={`min-h-11 rounded-lg px-3 text-sm font-semibold transition-colors ${participantLifecycleView === 'active' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Activos <span className="ml-1 tabular-nums text-xs">{activeParticipants.length}</span></button>
        <button type="button" role="tab" aria-selected={participantLifecycleView === 'history'} onClick={() => setParticipantLifecycleView('history')} className={`min-h-11 rounded-lg px-3 text-sm font-semibold transition-colors ${participantLifecycleView === 'history' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Historial <span className="ml-1 tabular-nums text-xs">{historicalParticipants.length}</span></button>
      </div>}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
      {activeTab === 'health' ? (
        <div className="h-full overflow-y-auto space-y-4 pb-3">
          {loadingHealth ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {!mobileWorkspace && <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <button type="button" onClick={() => setHealthSummaryExpanded(value => !value)} aria-expanded={healthSummaryExpanded} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors">
                  <HeartPulse className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span className="text-sm font-semibold text-slate-800">Resumen de salud</span>
                  <span className={`inline-flex px-2 py-0.5 rounded-full border text-xs font-medium ${healthClass(health?.health)}`}>{healthLabel(health?.health)}</span>
                  <span className="text-xs text-slate-500 truncate">{health?.reasons?.join(' · ') || 'Sin datos suficientes todavía'}</span>
                  <ChevronDown className={`ml-auto w-4 h-4 text-slate-400 transition-transform ${healthSummaryExpanded ? 'rotate-180' : ''}`} />
                </button>
                {healthSummaryExpanded && (
                  <div className="border-t border-slate-100 px-4 py-3">
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="text-xs text-slate-500">Meta asistencia<input type="number" min={1} max={100} value={programGoals.attendance_goal_percent} onChange={(e) => setProgramGoals(prev => ({ ...prev, attendance_goal_percent: Number(e.target.value) }))} className="mt-1 w-28 px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm" /></label>
                      <label className="text-xs text-slate-500">Meta traspaso<input type="number" min={1} max={100} value={programGoals.transfer_goal_percent} onChange={(e) => setProgramGoals(prev => ({ ...prev, transfer_goal_percent: Number(e.target.value) }))} className="mt-1 w-28 px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm" /></label>
                      <button onClick={saveProgramGoals} disabled={savingGoals} className="min-h-11 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">{savingGoals ? 'Guardando...' : 'Guardar metas'}</button>
                      <button onClick={() => openCreateSession('recovery')} className="min-h-11 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100">Recuperación</button>
                    </div>
                  </div>
                )}
              </div>}

              {!mobileWorkspace && healthSummaryExpanded && <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Asistencia</p>
                  <p className={`text-2xl font-bold mt-1 ${(health?.attendance_rate || 0) >= (health?.attendance_goal_percent || 80) ? 'text-emerald-600' : 'text-amber-600'}`}>{formatPct(health?.attendance_rate)}</p>
                  <p className="text-[11px] text-slate-400">meta {health?.attendance_goal_percent || 80}%</p>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Traspaso</p>
                  <p className={`text-2xl font-bold mt-1 ${(health?.transfer_rate || 0) >= (health?.transfer_goal_percent || 70) ? 'text-emerald-600' : 'text-amber-600'}`}>{formatPct(health?.transfer_rate)}</p>
                  <p className="text-[11px] text-slate-400">meta {health?.transfer_goal_percent || 70}%</p>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Activos</p>
                  <p className="text-2xl font-bold text-slate-800 mt-1">{health?.active_count || 0}</p>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Completaron</p>
                  <p className="text-2xl font-bold text-blue-600 mt-1">{health?.completed_count || 0}</p>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Traspasados</p>
                  <p className="text-2xl font-bold text-emerald-600 mt-1">{health?.transferred_count || 0}</p>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <p className="text-xs text-slate-500">Recuperación</p>
                  <p className="text-2xl font-bold text-indigo-600 mt-1">{health?.recovery_session_count || 0}</p>
                </div>
              </div>}

              {participantLifecycleView === 'history' ? (
                <ProgramParticipantHistoryList
                  participants={filteredProgramParticipants}
                  searching={Boolean(normalizedParticipantQuery)}
                  compact={compactWorkspace}
                  onOpen={(participant, trigger) => handleParticipantClick(participant, trigger)}
                />
              ) : <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                {!mobileWorkspace && <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-800">Participantes</h3>
                  <div className="flex items-center gap-2">
                    <button onClick={fetchHealth} className="min-h-11 rounded-lg px-2 text-xs text-emerald-600 hover:bg-emerald-50 hover:underline">Actualizar</button>
                    <button onClick={() => setIsAddParticipantOpen(true)} disabled={program?.status !== 'active'} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"><Plus className="w-3.5 h-3.5" /> Agregar</button>
                  </div>
                </div>}
                <div>
                  {compactWorkspace ? (
                    <div className="divide-y divide-slate-100">
                      {filteredHealthParticipants.length === 0 ? (
                        <div className="px-4 py-10 text-center text-sm text-slate-400"><p>{normalizedParticipantQuery ? 'No hay participantes que coincidan con la búsqueda.' : 'Sin inscritos para evaluar'}</p>{mobileWorkspace && !normalizedParticipantQuery && <button type="button" onClick={() => setIsAddParticipantOpen(true)} disabled={program?.status !== 'active'} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 font-semibold text-white disabled:opacity-40"><UserPlus className="h-4 w-4" />Agregar participantes</button>}</div>
                      ) : filteredHealthParticipants.map(p => mobileWorkspace ? (
                        <div key={p.participant_id} data-testid="mobile-program-participant-row" className="flex min-h-[78px] items-center gap-2 px-3 py-2 transition-colors hover:bg-slate-50">
                          <button type="button" onClick={event => { void openParticipantDetail(p.participant_id, p.contact_id, event.currentTarget); }} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                            <ContactPhotoPreview url={p.avatar_url} name={p.name || 'Sin nombre'} sizeClassName="h-11 w-11" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold text-slate-800">{p.name || 'Sin nombre'}</span>
                              <span className="block truncate text-xs text-slate-400">{p.phone || 'Sin teléfono'}</span>
                              <span className={`mt-0.5 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${p.status === 'active' ? 'bg-emerald-50 text-emerald-700' : p.status === 'completed' ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'}`}>{p.status === 'active' ? 'Activo' : p.status === 'completed' ? 'Completado' : 'Retirado'}</span>
                            </span>
                          </button>
                          <button type="button" onClick={() => openObservationHistory(p.participant_id)} className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={`Abrir observaciones de ${p.name || 'participante'}`}>
                            <NotebookPen className="h-4 w-4" />
                            {p.notes_count > 0 && <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-emerald-600 px-1 text-center text-[9px] font-bold leading-4 text-white">{p.notes_count > 99 ? '99+' : p.notes_count}</span>}
                          </button>
                          <button type="button" onClick={() => openOutcomeModal(p.participant_id, 'dropped')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400" aria-label={`Retirar del programa a ${p.name || 'participante'}`}><XCircle className="h-4 w-4" /></button>
                        </div>
                      ) : (
                        <div key={p.participant_id} onClick={() => { void openParticipantDetail(p.participant_id, p.contact_id) }} className="cursor-pointer space-y-3 p-4 transition-colors hover:bg-slate-50">
                          <div className="flex items-start gap-3">
                            <ContactPhotoPreview url={p.avatar_url} name={p.name || 'Sin nombre'} sizeClassName="h-12 w-12" />
                            <button type="button" onClick={event => { event.stopPropagation(); void openParticipantDetail(p.participant_id, p.contact_id, event.currentTarget); }} className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                              <span className="block truncate font-semibold text-slate-800">{p.name || 'Sin nombre'}</span>
                              <span className="block truncate text-xs text-slate-400">{p.phone || 'Sin teléfono'}</span>
                              <span className={`mt-1 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${p.status === 'active' ? 'bg-emerald-50 text-emerald-700' : p.status === 'completed' ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'}`}>{p.status === 'active' ? 'Activo' : p.status === 'completed' ? 'Completado' : 'Retirado'}</span>
                            </button>
                            <div onClick={event => event.stopPropagation()} className="flex shrink-0 items-center gap-0.5">
                              <button onClick={() => openObservationHistory(p.participant_id)} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-emerald-50 hover:text-emerald-600" title="Abrir observaciones"><NotebookPen className="h-4 w-4" /></button>
                              <><button onClick={() => openOutcomeModal(p.participant_id, 'completed')} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-blue-50 hover:text-blue-600" title="Completar y traspasar"><Target className="h-4 w-4" /></button>
                              <button onClick={() => openOutcomeModal(p.participant_id, 'dropped')} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-600" title="Retirar del programa"><XCircle className="h-4 w-4" /></button></>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3">
                            <div><span className="block text-[10px] uppercase tracking-wide text-slate-400">Salud</span><span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${healthClass(p.health)}`}>{healthLabel(p.health)}</span></div>
                            <div><span className="block text-[10px] uppercase tracking-wide text-slate-400">Asistencia</span><span className="mt-1 block font-semibold text-slate-700">{formatPct(p.attendance_rate)}</span><span className="text-[10px] text-slate-400">{p.present} P · {p.absent} F · {p.late} T</span></div>
                          </div>
                          {(p.reasons || []).length > 0 && <div className="flex flex-wrap gap-1">{p.reasons.slice(0, 3).map(reason => <span key={reason} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{reason}</span>)}</div>}
                        </div>
                      ))}
                    </div>
                  ) : <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-4 py-3 font-medium">Participante</th>
                        <th className="px-4 py-3 font-medium">Salud</th>
                        <th className="px-4 py-3 font-medium">Asistencia</th>
                        <th className="px-4 py-3 font-medium">Señales</th>
                        <th className="px-4 py-3 font-medium text-right">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredHealthParticipants.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-400">{normalizedParticipantQuery ? 'No hay participantes que coincidan con la búsqueda.' : 'Sin inscritos para evaluar'}</td>
                        </tr>
                      ) : (
                        filteredHealthParticipants.map(p => (
                          <tr key={p.participant_id} onClick={() => void openParticipantDetail(p.participant_id, p.contact_id)} className="cursor-pointer hover:bg-slate-50">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-3">
                                <ContactPhotoPreview url={p.avatar_url} name={p.name || 'Sin nombre'} />
                                <button type="button" onClick={event => { event.stopPropagation(); void openParticipantDetail(p.participant_id, p.contact_id, event.currentTarget); }} className="min-w-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                                  <span className="block truncate font-medium text-slate-800">{p.name || 'Sin nombre'}</span>
                                  <span className="block text-xs text-slate-400">{p.phone || 'Sin teléfono'}</span>
                                  <span className={`inline-flex mt-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${p.status === 'active' ? 'bg-emerald-50 text-emerald-700' : p.status === 'completed' ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'}`}>{p.status === 'active' ? 'Activo' : p.status === 'completed' ? 'Completado' : 'Retirado'}</span>
                                </button>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex px-2 py-0.5 rounded-full border text-xs font-medium ${healthClass(p.health)}`}>
                                {healthLabel(p.health)}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="font-semibold text-slate-700">{formatPct(p.attendance_rate)}</div>
                              <div className="text-[11px] text-slate-400">{p.present} P · {p.absent} F · {p.late} T</div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-1">
                                {(p.reasons || []).slice(0, 3).map(reason => (
                                  <span key={reason} className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full text-[11px]">{reason}</span>
                                ))}
                              </div>
                              {p.transferred_to_level && <div className="text-[11px] text-emerald-600 mt-1">Traspaso: {p.transferred_to_level}</div>}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div onClick={event => event.stopPropagation()} className="flex items-center justify-end gap-1">
                                <button onClick={() => openObservationHistory(p.participant_id)} className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600" title="Abrir observaciones">
                                  <NotebookPen className="w-4 h-4" />
                                </button>
                                <button onClick={() => openOutcomeModal(p.participant_id, 'completed')} className="p-1.5 rounded-lg hover:bg-blue-50 text-slate-400 hover:text-blue-600" title="Completar y traspasar">
                                  <Target className="w-4 h-4" />
                                </button>
                                <button onClick={() => openOutcomeModal(p.participant_id, 'dropped')} className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600" title="Retirar del programa">
                                  <XCircle className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                  </div>}
                </div>
              </div>}
            </>
          )}
        </div>
      ) : activeTab === 'participants' ? (
        <div className="h-full flex flex-col gap-3">
          {!mobileWorkspace && <div className="flex shrink-0 items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-800">Lista de Participantes</h2>
            <div className="flex items-center gap-2">
              {!compactWorkspace && <div className="relative">
                <button
                  onClick={() => setShowColumnPicker(v => !v)}
                  className="flex items-center gap-2 px-3 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 transition-all text-sm font-medium"
                  title="Personalizar columnas"
                >
                  <Columns3 className="w-4 h-4" />
                  <span className="hidden sm:inline">Columnas</span>
                </button>
                {showColumnPicker && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowColumnPicker(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[200px]" onMouseDown={e => e.stopPropagation()}>
                      <p className="px-3 py-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Columnas visibles</p>
                      {PARTICIPANT_COLUMNS.map(col => {
                        const isVisible = visibleColumns.includes(col.id);
                        return (
                          <label
                            key={col.id}
                            className={`flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${col.always ? 'text-slate-400 cursor-not-allowed' : 'text-slate-700 hover:bg-slate-50 cursor-pointer'}`}
                          >
                            <input
                              type="checkbox"
                              checked={isVisible}
                              disabled={col.always}
                              onChange={() => toggleColumn(col.id)}
                              className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 focus:ring-offset-0"
                            />
                            <span className="flex-1">{col.label}</span>
                            {col.always && <span className="text-[10px] text-slate-400">fijo</span>}
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>}
              {!mobileWorkspace && <button
                onClick={() => setIsAddParticipantOpen(true)}
                disabled={program?.status !== 'active'}
                title={program?.status !== 'active' ? 'Solo disponible para programas activos' : 'Agregar participantes'}
                className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
                Agregar
              </button>}
            </div>
          </div>}

          {participantLifecycleView === 'history' ? (
            <ProgramParticipantHistoryList participants={filteredProgramParticipants} searching={Boolean(normalizedParticipantQuery)} compact={compactWorkspace} onOpen={(participant, trigger) => handleParticipantClick(participant, trigger)} />
          ) : <div className="flex-1 min-h-0 bg-white rounded-xl border border-slate-200 overflow-hidden">
            {compactWorkspace && <div className="h-full overflow-y-auto divide-y divide-slate-100">
              {mobileWorkspace ? (filteredProgramParticipants.length === 0 ? (
                <div className="px-5 py-12 text-center">
                  <Users className="mx-auto mb-3 h-10 w-10 text-slate-300" />
                  <p className="font-medium text-slate-500">{normalizedParticipantQuery ? 'Sin coincidencias' : 'Sin participantes'}</p>
                  <p className="mt-1 text-xs text-slate-400">{normalizedParticipantQuery ? 'Prueba con otro nombre o teléfono.' : 'Todavía no hay participantes para consultar.'}</p>
                  {!normalizedParticipantQuery && <button type="button" onClick={() => setIsAddParticipantOpen(true)} disabled={program?.status !== 'active'} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-40"><UserPlus className="h-4 w-4" />Agregar participantes</button>}
                </div>
              ) : filteredProgramParticipants.map(p => (
                <div key={p.id} data-testid="mobile-program-participant-row" className={`flex min-h-[78px] items-center gap-2 px-3 py-2 transition-colors ${selectedParticipantID === p.id ? 'bg-emerald-50' : 'bg-white'}`}>
                  <button type="button" onClick={(event) => handleParticipantClick(p, event.currentTarget)} className="min-w-0 flex-1 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">{(p.contact_name || '?').charAt(0).toUpperCase()}</div>
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-slate-800">{p.contact_name || 'Sin nombre'}</span>
                        <span className="block truncate text-xs text-slate-400">{p.contact_phone || 'Sin teléfono'}</span>
                        <span className={`mt-0.5 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${p.status === 'active' ? 'bg-emerald-50 text-emerald-700' : p.status === 'completed' ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'}`}>{p.status === 'active' ? 'Activo' : p.status === 'completed' ? 'Completado' : 'Retirado'}</span>
                      </div>
                    </div>
                  </button>
                  <button type="button" onClick={() => openObservationHistory(p.id)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={`Abrir observaciones de ${p.contact_name || 'participante'}`}><NotebookPen className="h-4 w-4" /></button>
                  <button type="button" onClick={() => openOutcomeModal(p.id, 'dropped')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400" aria-label={`Retirar del programa a ${p.contact_name || 'participante'}`}><XCircle className="h-4 w-4" /></button>
                </div>
              ))) : (filteredProgramParticipants.length === 0 ? (
                <div className="px-5 py-12 text-center">
                  <Users className="mx-auto mb-3 h-10 w-10 text-slate-300" />
                  <p className="font-medium text-slate-500">{normalizedParticipantQuery ? 'Sin coincidencias' : 'Sin participantes'}</p>
                  <p className="mt-1 text-xs text-slate-400">{normalizedParticipantQuery ? 'Prueba con otro nombre o teléfono.' : 'Agrega participantes para comenzar'}</p>
                </div>
              ) : filteredProgramParticipants.map(p => (
                <div key={p.id} className={`p-4 transition-colors ${selectedParticipantID === p.id ? 'bg-emerald-50' : 'bg-white'}`}>
                  <button type="button" onClick={(event) => handleParticipantClick(p, event.currentTarget)} className="w-full text-left">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600">{(p.contact_name || '?').charAt(0).toUpperCase()}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <span className="truncate font-semibold text-slate-800">{p.contact_name || 'Sin nombre'}</span>
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${p.status === 'active' ? 'bg-emerald-50 text-emerald-700' : p.status === 'completed' ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'}`}>{p.status === 'active' ? 'Activo' : p.status === 'completed' ? 'Completado' : 'Retirado'}</span>
                        </div>
                        <p className="mt-1 break-all text-xs text-slate-500">{p.contact_phone || 'Sin teléfono'}</p>
                        <p className="mt-1 text-xs text-slate-400">Inscripción: {formatCalendarDate(p.enrolled_at, 'dd MMM yyyy', { locale: es })}</p>
                      </div>
                    </div>
                  </button>
                  <div className="mt-3 flex justify-end gap-2 border-t border-slate-100 pt-2"><button type="button" onClick={() => openOutcomeModal(p.id, 'completed')} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-blue-700 hover:bg-blue-50"><Target className="h-4 w-4" /> Completar</button><button type="button" onClick={() => openOutcomeModal(p.id, 'dropped')} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-red-600 hover:bg-red-50"><XCircle className="h-4 w-4" /> Retirar</button></div>
                </div>
              )))}
            </div>}
            {!compactWorkspace && <div className="h-full overflow-x-auto">
              <div className="h-full overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 sticky top-0 z-10">
                    <tr>
                      {PARTICIPANT_COLUMNS.filter(c => visibleColumns.includes(c.id)).map(col => (
                        <th key={col.id} className={`px-5 py-3 font-medium ${col.id === 'actions' ? 'text-right' : ''}`}>{col.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredProgramParticipants.length === 0 ? (
                      <tr>
                        <td colSpan={visibleColumns.length} className="px-5 py-12 text-center">
                          <Users className="w-10 h-10 text-slate-300 mx-auto mb-3" />
                          <p className="text-slate-500 font-medium">{normalizedParticipantQuery ? 'Sin coincidencias' : 'Sin participantes'}</p>
                          <p className="text-slate-400 text-xs mt-1">{normalizedParticipantQuery ? 'Prueba con otro nombre o teléfono.' : 'Agrega participantes para comenzar'}</p>
                        </td>
                      </tr>
                    ) : (
                      filteredProgramParticipants.map((p) => {
                        const isSelected = selectedParticipantID === p.id;
                        return (
                        <tr
                          key={p.id}
                          className={`transition-colors cursor-pointer ${isSelected ? 'bg-emerald-50 hover:bg-emerald-50' : 'hover:bg-slate-50'}`}
                          onClick={() => handleParticipantClick(p)}
                        >
                          {PARTICIPANT_COLUMNS.filter(c => visibleColumns.includes(c.id)).map(col => {
                            if (col.id === 'name') {
                              return (
                                <td key={col.id} className={`px-5 py-3 ${isSelected ? 'border-l-4 border-emerald-500 pl-4' : ''}`}>
                                  <div className="flex items-center gap-2.5">
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-medium text-xs ${isSelected ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                                      {(p.contact_name || '?').charAt(0).toUpperCase()}
                                    </div>
                                    <span className={`font-medium ${isSelected ? 'text-emerald-800' : 'text-slate-800'}`}>{p.contact_name || 'Sin nombre'}</span>
                                    {isSelected && loadingLead && <span className="text-xs text-emerald-500">...</span>}
                                  </div>
                                </td>
                              );
                            }
                            if (col.id === 'phone') {
                              return (
                                <td key={col.id} className="px-5 py-3 text-slate-600 font-mono text-xs">
                                  {p.contact_phone || <span className="text-slate-400 italic">Sin teléfono</span>}
                                </td>
                              );
                            }
                            if (col.id === 'status') {
                              return (
                                <td key={col.id} className="px-5 py-3">
                                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                                    p.status === 'active' ? 'bg-emerald-50 text-emerald-700' :
                                    p.status === 'completed' ? 'bg-blue-50 text-blue-700' :
                                    'bg-red-50 text-red-700'
                                  }`}>
                                    {p.status === 'active' ? 'Activo' : p.status === 'completed' ? 'Completado' : 'Retirado'}
                                  </span>
                                </td>
                              );
                            }
                            if (col.id === 'enrolled_at') {
                              return (
                                <td key={col.id} className="px-5 py-3 text-slate-500 text-xs">
                                  {formatCalendarDate(p.enrolled_at, 'dd MMM yyyy', { locale: es })}
                                </td>
                              );
                            }
                            if (col.id === 'actions') {
                              return (
                                <td key={col.id} className="px-5 py-3 text-right">
                                  <button onClick={(e) => { e.stopPropagation(); openOutcomeModal(p.id, 'completed'); }} className="rounded-lg p-1.5 text-slate-400 transition-all hover:bg-blue-50 hover:text-blue-600" title="Completar participación"><Target className="h-4 w-4" /></button>
                                  <button onClick={(e) => { e.stopPropagation(); openOutcomeModal(p.id, 'dropped'); }} className="rounded-lg p-1.5 text-slate-400 transition-all hover:bg-red-50 hover:text-red-600" title="Retirar del programa"><XCircle className="h-4 w-4" /></button>
                                </td>
                              );
                            }
                            return <td key={col.id} className="px-5 py-3" />;
                          })}
                        </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>}
          </div>}
        </div>
      ) : activeTab === 'kanban' ? (
        <div className="h-full flex flex-col gap-3">
          <div className="flex shrink-0 items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-800">Kanban de Participantes</h2>
            {!mobileWorkspace && <button
              onClick={() => setIsAddParticipantOpen(true)}
              disabled={program?.status !== 'active'}
              title={program?.status !== 'active' ? 'Solo disponible para programas activos' : 'Agregar participantes'}
              className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="w-4 h-4" /> Agregar
            </button>}
          </div>
          {stages.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
              <div className="text-center">
                <AlertCircle className="w-8 h-8 mx-auto mb-2 text-amber-500" />
                <p>Este evento no tiene etapas configuradas.</p>
                <p className="text-xs mt-1">Edita el pipeline en Eventos → Pipelines.</p>
              </div>
            </div>
          ) : compactWorkspace ? (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-white">
              {participants.length === 0 ? (
                <div className="px-5 py-14 text-center">
                  <Users className="mx-auto h-10 w-10 text-slate-300" />
                  <p className="mt-3 font-medium text-slate-500">Sin participantes</p>
                  <p className="mt-1 text-xs text-slate-400">Agrega participantes para comenzar</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {participants.map(participant => {
                    const currentStage = stages.find(stage => stage.id === participant.stage_id);
                    return (
                      <div key={participant.id} className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-slate-800">{participant.contact_name || 'Sin nombre'}</p>
                            <p className="mt-1 flex items-center gap-1 break-all text-xs text-slate-500"><Phone className="h-3 w-3 shrink-0" />{participant.contact_phone || 'Sin teléfono'}</p>
                          </div>
                          <span className="inline-flex max-w-[45%] shrink-0 items-center gap-1.5 rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: currentStage?.color || '#94a3b8' }} />
                            <span className="truncate">{currentStage?.name || 'Sin etapa'}</span>
                          </span>
                        </div>
                        {renderStageSelect(participant)}
                        {mobileWorkspace && <div className="mt-3 flex justify-end border-t border-slate-100 pt-2"><button type="button" onClick={() => openObservationHistory(participant.id)} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-50"><NotebookPen className="h-4 w-4" /> Observaciones</button></div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
              <div className="flex gap-3 h-full pb-2" style={{ minWidth: 'max-content' }}>
                {/* Stage: sin etapa */}
                {(() => {
                  const unstaged = participants.filter(p => !p.stage_id);
                  return (
                    <div
                      onDragOver={e => handleStageDragOver(e, '__unassigned__')}
                      onDragLeave={handleStageDragLeave}
                      onDrop={e => handleStageDrop(e, null)}
                      className={`flex flex-col w-72 shrink-0 bg-slate-50 border-2 rounded-xl transition-colors ${
                        dragOverStageID === '__unassigned__' ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200'
                      }`}
                    >
                      <div className="p-3 border-b border-slate-200 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-2.5 h-2.5 rounded-full bg-slate-400" />
                          <span className="font-semibold text-slate-700 text-sm">Sin etapa</span>
                        </div>
                        <span className="text-xs text-slate-500 font-medium bg-white px-2 py-0.5 rounded-full">{unstaged.length}</span>
                      </div>
                      <div className="flex-1 overflow-y-auto p-2 space-y-2">
                        {unstaged.map(p => (
                          <div
                            key={p.id}
                            draggable={!touchWorkspace}
                            onDragStart={e => handleStageDragStart(e, p.id)}
                            className={`bg-white border border-slate-200 rounded-lg p-2.5 shadow-sm hover:shadow-md hover:border-emerald-300 transition-all ${touchWorkspace ? 'cursor-default' : 'cursor-move'} ${
                              draggedParticipantID === p.id ? 'opacity-40' : ''
                            }`}
                          >
                            <div className="font-medium text-slate-800 text-sm truncate">{p.contact_name || 'Sin nombre'}</div>
                            {p.contact_phone && (
                              <div className="text-xs text-slate-500 flex items-center gap-1 mt-1">
                                <Phone className="w-3 h-3" /> {p.contact_phone}
                              </div>
                            )}
                            {renderStageSelect(p)}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {/* Stages */}
                {[...stages].sort((a, b) => a.position - b.position).map(stage => {
                  const stageParts = participants.filter(p => p.stage_id === stage.id);
                  return (
                    <div
                      key={stage.id}
                      onDragOver={e => handleStageDragOver(e, stage.id)}
                      onDragLeave={handleStageDragLeave}
                      onDrop={e => handleStageDrop(e, stage.id)}
                      className={`flex flex-col w-72 shrink-0 bg-slate-50 border-2 rounded-xl transition-colors ${
                        dragOverStageID === stage.id ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200'
                      }`}
                    >
                      <div className="p-3 border-b border-slate-200 flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: stage.color || '#64748b' }} />
                          <span className="font-semibold text-slate-700 text-sm truncate">{stage.name}</span>
                        </div>
                        <span className="text-xs text-slate-500 font-medium bg-white px-2 py-0.5 rounded-full shrink-0 ml-2">{stageParts.length}</span>
                      </div>
                      <div className="flex-1 overflow-y-auto p-2 space-y-2">
                        {stageParts.map(p => (
                          <div
                            key={p.id}
                            draggable={!touchWorkspace}
                            onDragStart={e => handleStageDragStart(e, p.id)}
                            className={`bg-white border border-slate-200 rounded-lg p-2.5 shadow-sm hover:shadow-md hover:border-emerald-300 transition-all ${touchWorkspace ? 'cursor-default' : 'cursor-move'} ${
                              draggedParticipantID === p.id ? 'opacity-40' : ''
                            }`}
                          >
                            <div className="font-medium text-slate-800 text-sm truncate">{p.contact_name || 'Sin nombre'}</div>
                            {p.contact_phone && (
                              <div className="text-xs text-slate-500 flex items-center gap-1 mt-1">
                                <Phone className="w-3 h-3" /> {p.contact_phone}
                              </div>
                            )}
                            {renderStageSelect(p)}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : activeTab === 'academic' ? (
        <ProgramAcademicConfigPanel
          programId={programId}
          config={academicConfig}
          loading={academicLoading}
          error={academicError}
          onRetry={() => { void fetchAcademicData(); }}
          onChange={setAcademicConfig}
          onToast={showToast}
          onDirtyChange={setAcademicDirty}
          onNavigateToCatalog={() => requestProgramNavigation('/dashboard/programs/courses')}
        />
      ) : activeTab === 'surveys' && canUseSurveys ? (
        <div className="h-full overflow-y-auto pb-3">
          <ProgramSurveyPanel programId={programId} programName={program.name} canManageSurveys />
        </div>
      ) : activeTab === 'sessions' ? (
        <div className="h-full flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 shrink-0">
            <h2 className="text-base font-semibold text-slate-800">Sesiones y Asistencia</h2>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:flex-nowrap">
              <button
                onClick={() => setIsGenerateSessionsOpen(true)}
                className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 transition-all hover:bg-emerald-100 sm:flex-none"
              >
                <Repeat className="w-4 h-4" />
                Generar Horario
              </button>
              <button
                onClick={() => openCreateSession()}
                className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-emerald-700 sm:flex-none"
              >
                <Plus className="w-4 h-4" />
                Nueva Sesión
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
          {sessions.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-2xl border border-slate-200">
              <div className="w-16 h-16 rounded-2xl bg-blue-50 flex items-center justify-center mx-auto mb-4">
                <Calendar className="w-8 h-8 text-blue-400" />
              </div>
              <h3 className="text-lg font-semibold text-slate-800 mb-2">Sin sesiones programadas</h3>
              <p className="text-slate-500 mb-5 max-w-md mx-auto text-sm">
                Crea sesiones individuales o genera un horario recurrente. El plan de clases siempre será una sugerencia editable.
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                <button
                  onClick={() => setIsGenerateSessionsOpen(true)}
                  className="flex min-h-11 items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 transition-all hover:bg-emerald-100"
                >
                  <Repeat className="w-4 h-4" />
                  Generar Horario
                </button>
                <button
                  onClick={() => openCreateSession()}
                  className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-emerald-700"
                >
                  <Plus className="w-4 h-4" />
                  Sesión Individual
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 pb-2">
              {sessions.map((session, idx) => {
                const totalAtt = (session.attendance_stats?.present || 0) + (session.attendance_stats?.absent || 0) + (session.attendance_stats?.late || 0);
                const isPast = calendarDateKey(session.date) < localDateInputValue();
                const sessionTopics = normalizedSessionTopics(session);
                return (
                  <div
                    key={session.id}
                    className={`bg-white rounded-xl border border-slate-200 p-4 hover:shadow-md transition-all group ${isPast ? 'opacity-80' : ''}`}
                  >
                    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4">
                      {/* Session number & date */}
                      <div className="hidden sm:flex flex-col items-center justify-center w-14 h-14 rounded-xl bg-slate-50 border border-slate-100 shrink-0">
                        <span className="text-xs text-slate-400 font-medium uppercase">
                          {formatCalendarDate(session.date, 'MMM', { locale: es })}
                        </span>
                        <span className="text-lg font-bold text-slate-800 -mt-0.5">
                          {formatCalendarDate(session.date, 'dd')}
                        </span>
                      </div>

                      {/* Session info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <h3 className="font-semibold text-slate-800 truncate">
                            {sessionDisplayTitle(session, `Sesión ${idx + 1}`)}
                          </h3>
                          {session.session_type === 'recovery' && (
                            <span className="text-xs px-2 py-0.5 bg-blue-50 text-blue-600 rounded-full shrink-0">
                              Recuperación
                            </span>
                          )}
                          {isPast && totalAtt === 0 && (
                            <span className="text-xs px-2 py-0.5 bg-amber-50 text-amber-600 rounded-full shrink-0">
                              Sin registrar
                            </span>
                          )}
                        </div>
                        {sessionTopics.some(topic => topic.kind === 'course') && <div className="mb-1.5 flex flex-wrap gap-1.5">{sessionTopics.filter(topic => topic.kind === 'course').slice(0, 2).map(topic => <span key={topic.id || topic.course_topic_id || topic.title} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700"><BookOpen className="h-3 w-3 shrink-0" /><span className="truncate">{topic.course_name || 'Curso histórico'} · {topic.title}</span></span>)}{sessionTopics.filter(topic => topic.kind === 'course').length > 2 && <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">+{sessionTopics.filter(topic => topic.kind === 'course').length - 2}</span>}</div>}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                          <span className="flex items-center gap-1">
                            <CalendarDays className="w-3 h-3" />
                            {formatCalendarDate(session.date, "EEEE, d 'de' MMMM", { locale: es })}
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
                            <div className="flex items-center gap-0.5 text-red-600 bg-red-50 px-2 py-1 rounded-lg" title="Faltas">
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
                      <div className="flex w-full shrink-0 items-center justify-end gap-1 border-t border-slate-100 pt-2 sm:w-auto sm:border-0 sm:pt-0">
                        <button
                          onClick={() => openAttendance(session)}
                          className="min-h-11 flex-1 rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-200 md:min-h-0 md:flex-none md:rounded-lg"
                        >
                          Asistencia
                        </button>
                        <button
                          onClick={() => openEditSession(session)}
                          className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 opacity-100 transition-all hover:bg-slate-100 hover:text-slate-700 md:h-8 md:w-8 md:rounded-lg md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                          title="Editar sesión"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteSession(session.id)}
                          className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 opacity-100 transition-all hover:bg-red-50 hover:text-red-500 md:h-8 md:w-8 md:rounded-lg md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
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
        </div>
      ) : (
        /* Stats Tab */
        <div className="h-full overflow-y-auto">
          {loadingStats && !statsData ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin" />
            </div>
          ) : statsStatus === 'error' && !statsData ? (
            <div className="flex min-h-[320px] items-center justify-center p-4">
              <div className="w-full max-w-md rounded-2xl border border-red-200 bg-white p-6 text-center shadow-sm">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
                  <AlertCircle className="h-6 w-6 text-red-500" />
                </div>
                <h3 className="font-semibold text-slate-800">No se pudieron cargar las estadísticas</h3>
                <p className="mt-1 text-sm text-slate-500">{statsError || 'Ocurrió un problema al consultar la asistencia.'}</p>
                <button type="button" onClick={() => void fetchStats(selectedMonths)} className="mt-4 inline-flex min-h-10 items-center justify-center rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700">
                  Reintentar
                </button>
              </div>
            </div>
          ) : !statsData || (statsData.session_stats.length === 0 && statsData.participant_stats.length === 0) ? (
            <div className="text-center py-20">
              <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
                <BarChart3 className="w-8 h-8 text-slate-400" />
              </div>
              <h3 className="font-semibold text-slate-700 mb-1">Sin datos de asistencia</h3>
              <p className="text-sm text-slate-500">Registra asistencia en las sesiones para ver estadísticas.</p>
            </div>
          ) : (
            <div className="space-y-6 pb-4">
              {(loadingStats || statsStatus === 'error') && (
                <div className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${statsStatus === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-100 bg-emerald-50 text-emerald-700'}`}>
                  <span>{statsStatus === 'error' ? (statsError || 'No se pudo actualizar la información.') : 'Actualizando estadísticas…'}</span>
                  {statsStatus === 'error' && <button type="button" onClick={() => void fetchStats(selectedMonths)} className="shrink-0 font-semibold underline underline-offset-2">Reintentar</button>}
                </div>
              )}
              {/* Month filter */}
              {(() => {
                // Extract available months from ALL sessions (not just filtered stats)
                const allMonths: string[] = [];
                for (const s of sessions) {
                  if (s.date) {
                    const m = s.date.substring(0, 7); // YYYY-MM
                    if (!allMonths.includes(m)) allMonths.push(m);
                  }
                }
                allMonths.sort();
                if (allMonths.length <= 1) return null;
                const monthNames: Record<string, string> = {
                  '01': 'Ene', '02': 'Feb', '03': 'Mar', '04': 'Abr', '05': 'May', '06': 'Jun',
                  '07': 'Jul', '08': 'Ago', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dic'
                };
                const toggleMonth = (m: string) => {
                  setSelectedMonths(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]);
                };
                return (
                  <div className="bg-white rounded-xl border border-slate-200 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-semibold text-slate-800 text-sm flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-emerald-500" />
                        Filtrar por mes
                      </h3>
                      {selectedMonths.length > 0 && (
                        <button
                          onClick={() => setSelectedMonths([])}
                          className="text-xs text-emerald-600 hover:text-emerald-700 font-medium hover:underline transition-colors"
                        >
                          Limpiar filtros
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {allMonths.map(m => {
                        const [year, month] = m.split('-');
                        const label = `${monthNames[month] || month} ${year}`;
                        const isSelected = selectedMonths.includes(m);
                        return (
                          <button
                            key={m}
                            onClick={() => toggleMonth(m)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                              isSelected
                                ? 'bg-emerald-500 text-white border-emerald-500 shadow-sm shadow-emerald-200'
                                : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-300 hover:text-emerald-600'
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    {selectedMonths.length === 0 && (
                      <p className="text-[11px] text-slate-400 mt-2">Sin filtro = sesiones hasta hoy</p>
                    )}
                  </div>
                );
              })()}

              {/* Summary cards */}
              {(() => {
                const totalPresent = statsData.session_stats.reduce((s, ss) => s + (ss.present || 0), 0);
                const totalAbsent = statsData.session_stats.reduce((s, ss) => s + (ss.absent || 0), 0);
                const totalLate = statsData.session_stats.reduce((s, ss) => s + (ss.late || 0), 0);
                const totalAll = totalPresent + totalAbsent + totalLate;
                const avgRate = totalAll > 0 ? Math.round(((totalPresent + totalLate) / totalAll) * 100) : 0;
                return (
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="bg-white rounded-xl border border-slate-200 p-4">
                      <p className="text-xs text-slate-500 mb-1">Tasa promedio</p>
                      <p className="text-2xl font-bold text-emerald-600">{avgRate}%</p>
                    </div>
                    <div className="bg-white rounded-xl border border-slate-200 p-4">
                      <p className="text-xs text-slate-500 mb-1">Presentes</p>
                      <p className="text-2xl font-bold text-emerald-600">{totalPresent}</p>
                    </div>
                    <div className="bg-white rounded-xl border border-slate-200 p-4">
                      <p className="text-xs text-slate-500 mb-1">Faltas</p>
                      <p className="text-2xl font-bold text-red-500">{totalAbsent}</p>
                    </div>
                    <div className="bg-white rounded-xl border border-slate-200 p-4">
                      <p className="text-xs text-slate-500 mb-1">Tardanzas</p>
                      <p className="text-2xl font-bold text-amber-500">{totalLate}</p>
                    </div>
                  </div>
                );
              })()}

              {/* Bar chart — Attendance per session */}
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="font-semibold text-slate-800 mb-4 text-sm">Asistencia por sesión</h3>
                <div className="space-y-3">
                  {statsData.session_stats.map((ss, i) => {
                    const total = (ss.present || 0) + (ss.absent || 0) + (ss.late || 0);
                    const pPct = total > 0 ? ((ss.present || 0) / total) * 100 : 0;
                    const lPct = total > 0 ? ((ss.late || 0) / total) * 100 : 0;
                    const aPct = total > 0 ? ((ss.absent || 0) / total) * 100 : 0;
                    const label = ss.title || ss.topic || (ss.date ? formatCalendarDate(ss.date, 'dd MMM', { locale: es }) : `Sesión ${i + 1}`);
                    return (
                      <div key={ss.session_id || i}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-slate-600 font-medium truncate max-w-[200px]">{label}</span>
                          <span className="text-xs text-slate-400">{Math.round(pPct + lPct)}% asistencia</span>
                        </div>
                        <div className="flex h-5 rounded-lg overflow-hidden bg-slate-100">
                          {pPct > 0 && <div className="bg-emerald-500 transition-all" style={{ width: `${pPct}%` }} title={`Presentes: ${ss.present}`} />}
                          {lPct > 0 && <div className="bg-amber-400 transition-all" style={{ width: `${lPct}%` }} title={`Tardanzas: ${ss.late}`} />}
                          {aPct > 0 && <div className="bg-red-400 transition-all" style={{ width: `${aPct}%` }} title={`Faltas: ${ss.absent}`} />}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Legend */}
                <div className="flex gap-4 mt-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-500 inline-block" />Presente</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-amber-400 inline-block" />Tardanza</span>
                  <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-400 inline-block" />Falta</span>
                </div>
              </div>

              {/* Trend line */}
              {statsData.session_stats.length > 1 && (
                <div className="bg-white rounded-xl border border-slate-200 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-slate-800 text-sm">Tendencia de asistencia</h3>
                    <span className="text-[11px] text-slate-400">{statsData.session_stats.length} sesiones · desliza →</span>
                  </div>
                  <div className="overflow-x-auto pb-2" style={{ scrollbarWidth: 'thin', scrollbarColor: '#cbd5e1 transparent' }}>
                    <div className="h-48 flex items-end gap-2" style={{ minWidth: `${Math.max(statsData.session_stats.length * 52, 300)}px` }}>
                      {statsData.session_stats.map((ss, i) => {
                        const total = (ss.present || 0) + (ss.absent || 0) + (ss.late || 0);
                        const rate = total > 0 ? Math.round(((ss.present || 0) + (ss.late || 0)) / total * 100) : 0;
                        const label = ss.title || ss.topic || (ss.date ? formatCalendarDate(ss.date, 'dd/MM', { locale: es }) : `S${i + 1}`);
                        return (
                          <div key={ss.session_id || i} className="flex flex-col items-center gap-1 w-[44px] shrink-0">
                            <span className="text-[10px] font-semibold text-slate-700">{rate}%</span>
                            <div className="w-8 rounded-t-lg transition-all" style={{
                              height: `${Math.max(rate * 1.6, 4)}px`,
                              backgroundColor: rate >= 80 ? '#10b981' : rate >= 50 ? '#f59e0b' : '#ef4444'
                            }} />
                            <span className="text-[9px] text-slate-400 truncate w-[44px] text-center">{label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Participant ranking (thermometer) */}
              {statsData.participant_stats.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 p-5">
                  <h3 className="font-semibold text-slate-800 mb-1 text-sm">Asistencia de participantes activos</h3>
                  <p className="mb-4 text-xs text-slate-500">Las sesiones pendientes se informan, pero no reducen el porcentaje.</p>
                  <div className="space-y-2">
                    {[...statsData.participant_stats]
                      .sort((a, b) => (b.rate || 0) - (a.rate || 0))
                      .map((ps, i) => {
                        const rate = ps.rate || 0;
                        const hasMarkedAttendance = (ps.marked_sessions || 0) > 0;
                        const color = !hasMarkedAttendance ? 'bg-slate-300' : rate >= 80 ? 'bg-emerald-500' : rate >= 50 ? 'bg-amber-400' : 'bg-red-400';
                        const textColor = !hasMarkedAttendance ? 'text-slate-400' : rate >= 80 ? 'text-emerald-700' : rate >= 50 ? 'text-amber-700' : 'text-red-600';
                        return (
                          <div key={ps.participant_id || i} className="flex items-center gap-3">
                            <span className="w-6 text-xs text-slate-400 text-right font-medium">{i + 1}</span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between mb-0.5">
                                <span className="text-sm font-medium text-slate-700 truncate">{ps.name || 'Sin nombre'}</span>
                                <span className={`text-xs font-bold ${textColor}`}>{hasMarkedAttendance ? `${Math.round(rate)}%` : 'Sin registros'}</span>
                              </div>
                              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                                <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${hasMarkedAttendance ? rate : 0}%` }} />
                              </div>
                              <div className="flex gap-3 mt-0.5 text-[10px] text-slate-400">
                                <span>{ps.present || 0} presentes</span>
                                <span>{ps.late || 0} tardanzas</span>
                                <span>{ps.absent || 0} ausentes</span>
                                <span>{ps.marked_sessions || 0} registradas</span>
                                {(ps.pending || 0) > 0 && <span>{ps.pending} pendientes</span>}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      </div>

      {/* =================== MODALS =================== */}

      {/* Add Participant Selector */}
      <ContactSelector
        open={isAddParticipantOpen}
        onClose={closeAddParticipantSelector}
        onConfirm={handleAddParticipants}
        title="Agregar participantes"
        subtitle="Busca entre tus contactos por nombre, teléfono o correo."
        confirmLabel="Agregar seleccionados"
        excludeIds={excludedParticipantIds}
        excludeLabels={excludedParticipantLabels}
        sourceFilter="contact"
        submitting={addingParticipants}
        errorMessage={addParticipantError}
        refreshKey={participantSelectorRevision}
      />

      {/* Create Session Modal */}
      {showSectionPicker && mobileWorkspace && typeof document !== 'undefined' && createPortal(
        <div className="app-viewport fixed inset-0 z-[90] flex flex-col bg-white" role="dialog" aria-modal="true" aria-labelledby="program-mobile-sections-title">
          <div className="safe-area-top flex min-h-16 shrink-0 items-center justify-between border-b border-slate-200 px-4">
            <div><h2 id="program-mobile-sections-title" className="font-bold text-slate-900">Secciones del programa</h2><p className="text-xs text-slate-500">Elige qué quieres ver o administrar</p></div>
            <button type="button" onClick={() => setShowSectionPicker(false)} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar selector"><X className="h-5 w-5" /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
            {(program.type === 'event'
              ? [
                  { id: 'kanban' as const, label: 'Tablero', detail: `${stages.length} etapas`, icon: LayoutGrid },
                  { id: 'participants' as const, label: 'Participantes', detail: `${activeParticipants.length} activos`, icon: Users },
                ]
              : [
                  { id: 'health' as const, label: 'Participantes', detail: `${activeParticipants.length} activos`, icon: Users },
                  { id: 'academic' as const, label: 'Plan e instructores', detail: `${academicConfig?.courses.length || 0} cursos · ${academicConfig?.instructors.length || 0} instructores`, icon: GraduationCap },
                  { id: 'sessions' as const, label: 'Sesiones', detail: `${sessions.length} registradas`, icon: Calendar },
                  { id: 'stats' as const, label: 'Estadísticas', detail: 'Asistencia y evolución', icon: BarChart3 },
                  ...(canUseSurveys ? [{ id: 'surveys' as const, label: 'Encuestas', detail: 'Aplicaciones y resultados', icon: ClipboardList }] : []),
                ]
            ).map(section => {
              const Icon = section.icon
              const selected = activeTab === section.id
              return <button key={section.id} type="button" onClick={() => requestTabChange(section.id)} className={`mb-2 flex min-h-16 w-full items-center gap-3 rounded-2xl border px-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${selected ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`} aria-current={selected ? 'page' : undefined}><span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${selected ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'}`}><Icon className="h-5 w-5" /></span><span className="min-w-0 flex-1"><span className={`block font-semibold ${selected ? 'text-emerald-800' : 'text-slate-800'}`}>{section.label}</span><span className="block text-xs text-slate-500">{section.detail}</span></span>{selected && <Check className="h-5 w-5 text-emerald-600" />}</button>
            })}
          </div>
          <div className="safe-area-bottom shrink-0 border-t border-slate-200 p-4"><button type="button" onClick={() => setShowSectionPicker(false)} className="min-h-12 w-full rounded-xl border border-slate-200 text-sm font-semibold text-slate-600">Cerrar</button></div>
        </div>,
        document.body,
      )}

      {isCreateSessionOpen && (
        <div className="app-viewport fixed inset-0 z-[70] flex items-stretch justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="create-session-title" className={`flex w-full flex-col overflow-hidden bg-white shadow-2xl ${maximizedSessionDialog === 'create' ? 'h-full max-w-none rounded-none sm:rounded-xl' : 'h-[var(--app-height)] max-w-2xl rounded-none sm:h-auto sm:max-h-[90vh] sm:rounded-2xl'}`}>
            <div className="flex justify-between items-center px-5 py-4 border-b border-slate-100 shrink-0">
              <h2 id="create-session-title" className="text-xl font-bold text-slate-800">Nueva Sesión</h2>
              <div className="flex items-center gap-1"><button type="button" onClick={() => setMaximizedSessionDialog(value => value === 'create' ? null : 'create')} className="hidden sm:inline-flex p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" title={maximizedSessionDialog === 'create' ? 'Restaurar' : 'Maximizar'}>{maximizedSessionDialog === 'create' ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}</button><button type="button" onClick={() => { setIsCreateSessionOpen(false); setMaximizedSessionDialog(null); }} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600" aria-label="Cerrar nueva sesión"><X className="w-5 h-5" /></button></div>
            </div>
            <form onSubmit={handleCreateSession} className="flex flex-1 min-h-0 flex-col">
              <div className="overflow-y-auto p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Fecha</label>
                  <input
                    type="date"
                    required
                    value={newSession.date}
                    onChange={(e) => setNewSession({ ...newSession, date: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1.5" htmlFor="new-session-title-input">Nombre de la sesión</label>
                  <input
                    id="new-session-title-input"
                    type="text"
                    required
                    maxLength={255}
                    value={newSession.title}
                    onChange={(event) => {
                      setNewSession(current => ({ ...current, title: event.target.value }));
                      setNewSessionTitleEdited(true);
                    }}
                    className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                    placeholder={`Sesión ${sessions.length + 1}`}
                  />
                  <p className="mt-1 text-xs leading-5 text-slate-400">{newSessionTitleEdited ? 'Título personalizado. Los temas pueden cambiar sin modificarlo.' : 'Se sugiere desde el primer tema, pero puedes escribir cualquier título.'}</p>
                </div>
                <SessionTopicField
                  courses={academicConfig?.courses || []}
                  sessions={sessions}
                  selectedTopics={newSession.topics}
                  targetDate={newSession.date}
                  targetStartTime={newSession.start_time}
                  onChange={(topics) => setNewSession(current => ({
                    ...current,
                    topics,
                    title: newSessionTitleEdited ? current.title : (suggestedSessionTitle(topics) || `Sesión ${sessions.length + 1}`),
                  }))}
                />
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Tipo de sesión</label>
                  <select
                    value={newSession.session_type}
                    onChange={(e) => setNewSession({ ...newSession, session_type: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  >
                    <option value="regular">Clase regular</option>
                    <option value="recovery">Clase de recuperación</option>
                  </select>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              <div className="flex shrink-0 gap-3 border-t border-slate-100 px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:justify-end sm:px-5 sm:pb-4">
                <button
                  type="button"
                  onClick={() => { setIsCreateSessionOpen(false); setMaximizedSessionDialog(null); }}
                  className="min-h-11 flex-1 rounded-xl px-4 py-2.5 font-medium text-slate-600 transition-colors hover:bg-slate-100 sm:flex-none"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={creatingSession}
                  className="min-h-11 flex-1 rounded-xl bg-emerald-600 px-5 py-2.5 font-medium text-white shadow-sm transition-all hover:bg-emerald-700 disabled:cursor-wait disabled:opacity-60 sm:flex-none"
                >
                  {creatingSession ? 'Creando…' : 'Crear Sesión'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Session Modal */}
      {editingSession && (
        <div className="app-viewport fixed inset-0 z-[70] flex items-stretch justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="edit-session-title" className={`flex w-full flex-col overflow-hidden bg-white shadow-2xl ${maximizedSessionDialog === 'edit' ? 'h-full max-w-none rounded-none sm:rounded-xl' : 'h-[var(--app-height)] max-w-2xl rounded-none sm:h-auto sm:max-h-[90vh] sm:rounded-2xl'}`}>
            <div className="flex justify-between items-center px-5 py-4 border-b border-slate-100 shrink-0">
              <h2 id="edit-session-title" className="text-xl font-bold text-slate-800">Editar Sesión</h2>
              <div className="flex items-center gap-1"><button type="button" onClick={() => setMaximizedSessionDialog(value => value === 'edit' ? null : 'edit')} className="hidden sm:inline-flex p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" title={maximizedSessionDialog === 'edit' ? 'Restaurar' : 'Maximizar'}>{maximizedSessionDialog === 'edit' ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}</button><button onClick={() => { setEditingSession(null); setMaximizedSessionDialog(null); }} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"><X className="w-5 h-5" /></button></div>
            </div>
            <form onSubmit={handleUpdateSession} className="flex flex-1 min-h-0 flex-col">
              <div className="overflow-y-auto p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Fecha</label>
                  <input
                    type="date"
                    required
                    value={editSessionForm.date}
                    onChange={(e) => setEditSessionForm({ ...editSessionForm, date: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-1.5" htmlFor="edit-session-title-input">Nombre de la sesión</label>
                  <input
                    id="edit-session-title-input"
                    type="text"
                    required
                    maxLength={255}
                    value={editSessionForm.title}
                    onChange={(event) => {
                      setEditSessionForm(current => ({ ...current, title: event.target.value }));
                      setEditSessionTitleEdited(true);
                    }}
                    className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                    placeholder="Título de la sesión"
                  />
                  <p className="mt-1 text-xs leading-5 text-slate-400">El título es independiente de los temas seleccionados.</p>
                </div>
                <SessionTopicField
                  courses={academicConfig?.courses || []}
                  sessions={sessions}
                  currentSessionId={editingSession.id}
                  selectedTopics={editSessionForm.topics}
                  targetDate={editSessionForm.date}
                  targetStartTime={editSessionForm.start_time}
                  onChange={(topics) => setEditSessionForm(current => ({
                    ...current,
                    topics,
                    title: editSessionTitleEdited ? current.title : (suggestedSessionTitle(topics) || current.title),
                  }))}
                />
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Tipo de sesión</label>
                  <select
                    value={editSessionForm.session_type}
                    onChange={(e) => setEditSessionForm({ ...editSessionForm, session_type: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  >
                    <option value="regular">Clase regular</option>
                    <option value="recovery">Clase de recuperación</option>
                  </select>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Hora inicio</label>
                    <input
                      type="time"
                      value={editSessionForm.start_time}
                      onChange={(e) => setEditSessionForm({ ...editSessionForm, start_time: e.target.value })}
                      className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Hora fin</label>
                    <input
                      type="time"
                      value={editSessionForm.end_time}
                      onChange={(e) => setEditSessionForm({ ...editSessionForm, end_time: e.target.value })}
                      className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Ubicación (opcional)</label>
                  <input
                    type="text"
                    value={editSessionForm.location}
                    onChange={(e) => setEditSessionForm({ ...editSessionForm, location: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    placeholder="Ej: Sala A, Piso 2"
                  />
                </div>
              </div>
              <div className="flex shrink-0 gap-3 border-t border-slate-100 px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:justify-end sm:px-5 sm:pb-4">
                <button
                  type="button"
                  onClick={() => { setEditingSession(null); setMaximizedSessionDialog(null); }}
                  className="min-h-11 flex-1 rounded-xl px-4 py-2.5 font-medium text-slate-600 transition-colors hover:bg-slate-100 sm:flex-none"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={savingSession}
                  className="min-h-11 flex-1 rounded-xl bg-emerald-600 px-5 py-2.5 font-medium text-white shadow-sm transition-all hover:bg-emerald-700 disabled:opacity-50 sm:flex-none"
                >
                  {savingSession ? 'Guardando...' : 'Guardar Cambios'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Generate Sessions Modal - Google Calendar Style */}
      {isGenerateSessionsOpen && (
        <div className="app-viewport fixed inset-0 z-[70] flex items-stretch justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="recurring-session-title" className={`flex w-full flex-col overflow-hidden bg-white shadow-2xl ${maximizedSessionDialog === 'recurring' ? 'h-full max-w-none rounded-none sm:rounded-xl' : 'h-[var(--app-height)] max-w-3xl rounded-none sm:h-auto sm:max-h-[90vh] sm:rounded-2xl'}`}>
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-4 sm:px-5 shrink-0">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center">
                  <Repeat className="w-5 h-5 text-emerald-600" />
                </div>
                <div className="min-w-0">
                  <h2 id="recurring-session-title" className="text-lg font-bold leading-tight text-slate-800 sm:text-xl">Generar horario recurrente</h2>
                  <p className="truncate text-xs text-slate-500">Configura la recurrencia y genera todas las sesiones</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1"><button type="button" onClick={() => setMaximizedSessionDialog(value => value === 'recurring' ? null : 'recurring')} className="hidden sm:inline-flex p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" title={maximizedSessionDialog === 'recurring' ? 'Restaurar' : 'Maximizar'}>{maximizedSessionDialog === 'recurring' ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}</button><button onClick={() => { setIsGenerateSessionsOpen(false); setMaximizedSessionDialog(null); }} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"><X className="w-5 h-5" /></button></div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Date range */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

              {schedulePreview.error && (
                <div role="alert" className="sm:col-span-2 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{schedulePreview.error}</span>
                </div>
              )}

              {/* Days of week - Google Calendar style */}
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-2">Días de la semana</label>
                <div className="grid grid-cols-4 gap-2 sm:flex">
                  {DAY_NAMES.map((name, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => toggleGenDay(idx)}
                      className={`h-11 w-11 rounded-full text-sm font-medium transition-all ${
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

              <div className="sm:col-span-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
                <div className="flex items-start gap-3">
                  <button type="button" role="switch" aria-checked={genForm.assign_course_topics} onClick={() => setGenForm(current => ({ ...current, assign_course_topics: !current.assign_course_topics }))} className={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition ${genForm.assign_course_topics ? 'bg-emerald-600' : 'bg-slate-300'}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${genForm.assign_course_topics ? 'translate-x-6' : 'translate-x-1'}`} /></button>
                  <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-slate-800">Asignar temas del plan</p><p className="mt-0.5 text-xs leading-5 text-slate-600">Usará en orden los {pendingCourseTopics.length} temas activos aún no utilizados. Los temas siempre podrán cambiarse después.</p></div>
                </div>
                {genForm.assign_course_topics && previewSessionCount > pendingCourseTopics.length && <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>Faltan {previewSessionCount - pendingCourseTopics.length} temas del plan: esas sesiones usarán un tema libre de respaldo, pero conservarán su título correlativo.</span></div>}
              </div>

              {/* Session title prefix */}
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Prefijo del título</label>
                <input
                  type="text"
                  value={genForm.title_prefix}
                  onChange={(e) => setGenForm({ ...genForm, title_prefix: e.target.value })}
                  maxLength={251}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  placeholder="Ej: Sesión, Clase, Taller"
                />
                <p className="text-xs text-slate-400 mt-1">Se generarán títulos como &quot;{genForm.title_prefix || 'Sesión'} 1&quot;, &quot;{genForm.title_prefix || 'Sesión'} 2&quot;…</p>
              </div>

              {/* Location */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Ubicación (opcional)</label>
                <input
                  type="text"
                  value={genForm.location}
                  onChange={(e) => setGenForm({ ...genForm, location: e.target.value })}
                  maxLength={500}
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  placeholder="Ej: Auditorio Principal"
                />
              </div>

              {/* Preview */}
              {previewSessionCount > 0 && !schedulePreview.error && (
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

            <div className="flex shrink-0 gap-3 border-t border-slate-100 px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:justify-end sm:px-5 sm:pb-4">
              <button
                onClick={() => { setIsGenerateSessionsOpen(false); setMaximizedSessionDialog(null); }}
                className="min-h-11 flex-1 rounded-xl px-4 py-2.5 font-medium text-slate-600 transition-colors hover:bg-slate-100 sm:flex-none"
              >
                Cancelar
              </button>
              <button
                onClick={handleGenerateSessions}
                disabled={generating || previewSessionCount === 0 || Boolean(schedulePreview.error)}
                className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 font-medium text-white shadow-sm transition-all hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
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
        <div className="app-viewport fixed inset-0 z-[70] flex items-stretch justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="attendance-title" className="flex h-[var(--app-height)] w-full max-w-5xl flex-col rounded-none bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:h-auto sm:max-h-[92vh] sm:rounded-2xl sm:p-6">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 id="attendance-title" className="text-xl font-bold text-slate-800">Tomar asistencia</h2>
                <p className="mt-1 text-sm leading-snug text-slate-500">
                  {sessionDisplayTitle(selectedSession, `Sesión ${Math.max(1, sessions.findIndex(session => session.id === selectedSession.id) + 1)}`)} — {formatCalendarDate(selectedSession.date, "EEEE, d 'de' MMMM", { locale: es })}
                  {selectedSession.start_time && ` · ${selectedSession.start_time}`}
                </p>
              </div>
              <button onClick={requestCloseAttendance} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600" aria-label="Cerrar asistencia">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto pr-1">
              {attendanceLoadState === 'loading' ? (
                <div className="flex min-h-64 items-center justify-center px-4 py-10 text-center" role="status">
                  <div><Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-600" /><p className="mt-3 text-sm font-semibold text-slate-700">Cargando asistencia…</p><p className="mt-1 text-xs text-slate-500">Puedes permanecer aquí mientras preparamos la lista.</p></div>
                </div>
              ) : attendanceLoadState === 'error' ? (
                <div className="flex min-h-64 items-center justify-center px-4 py-10 text-center" role="alert">
                  <div><AlertCircle className="mx-auto h-9 w-9 text-red-400" /><p className="mt-3 text-sm font-semibold text-slate-800">No se pudo cargar la asistencia</p><p className="mt-1 text-xs leading-5 text-slate-500">{attendanceLoadError || 'Inténtalo nuevamente.'}</p><button type="button" onClick={() => { void openAttendance(selectedSession); }} className="mt-4 min-h-11 rounded-xl border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 transition hover:bg-red-50">Reintentar</button></div>
                </div>
              ) : (
                <>
              {eligibleAttendanceParticipants.length === 0 && <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 text-center text-sm leading-6 text-slate-500">No hay participantes cuyo periodo de incorporación incluya esta sesión.</div>}
              <div className="space-y-3 md:hidden">
                {eligibleAttendanceParticipants.map(p => (
                  <div key={p.id} className="rounded-xl border border-slate-200 p-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{(p.contact_name || '?').charAt(0).toUpperCase()}</div>
                      <span className="min-w-0 truncate text-sm font-semibold text-slate-800">{p.contact_name || 'Sin nombre'}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      {[
                        { key: 'present', label: 'P', color: 'emerald', title: 'Presente' },
                        { key: 'absent', label: 'F', color: 'red', title: 'Falta' },
                        { key: 'late', label: 'T', color: 'amber', title: 'Tarde' },
                      ].map(opt => (
                        <button key={opt.key} type="button" onClick={() => { setAttendanceData(current => ({ ...current, [p.id]: { status: current[p.id]?.status === opt.key ? '' : opt.key, observation_count: current[p.id]?.observation_count || 0, observation_preview: current[p.id]?.observation_preview || [] } })); setAttendanceDirty(prev => ({ ...prev, [p.id]: true })); }} aria-label={`${opt.title}: ${p.contact_name || 'participante'}`} aria-pressed={attendanceData[p.id]?.status === opt.key} title={`${opt.title}. Pulsa otra vez para dejar sin marcar.`} className={`min-h-11 rounded-xl text-xs font-bold transition-all ${attendanceData[p.id]?.status === opt.key ? opt.color === 'emerald' ? 'bg-emerald-100 text-emerald-700 ring-2 ring-emerald-300' : opt.color === 'red' ? 'bg-red-100 text-red-700 ring-2 ring-red-300' : 'bg-amber-100 text-amber-700 ring-2 ring-amber-300' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>{opt.label}<span className="sr-only"> {opt.title}</span></button>
                      ))}
                    </div>
                    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                      {attendanceData[p.id]?.observation_preview?.[0] ? <><p className="line-clamp-2 text-sm leading-5 text-slate-700">{attendanceData[p.id].observation_preview[0].notes}</p><p className="mt-1 text-[10px] text-slate-400">{attendanceData[p.id].observation_preview[0].created_by_name || 'Autor no registrado'} · {format(new Date(attendanceData[p.id].observation_preview[0].created_at), 'dd MMM, HH:mm', { locale: es })}</p></> : <p className="text-xs text-slate-400">Sin observaciones</p>}
                      <div className="mt-2 flex justify-end"><button type="button" onClick={() => void loadAttendanceObservationHistory(p)} aria-label={`Abrir observaciones de asistencia de ${p.contact_name || 'participante'}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-white px-3 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200 transition hover:bg-emerald-50"><NotebookPen className="h-3.5 w-3.5" />Observaciones{(attendanceData[p.id]?.observation_count || 0) > 1 && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px]">+{(attendanceData[p.id]?.observation_count || 0) - 1} más</span>}</button></div>
                    </div>
                  </div>
                ))}
              </div>
              <table className="hidden w-full min-w-[720px] text-left text-sm md:table">
                <thead className="bg-slate-50 text-slate-600 sticky top-0 z-10 border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 font-medium">Participante</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium">Observaciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {eligibleAttendanceParticipants.map((p) => (
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
                            { key: 'absent', label: 'F', color: 'red', title: 'Falta' },
                            { key: 'late', label: 'T', color: 'amber', title: 'Tarde' },
                          ].map(opt => (
                            <button
                              key={opt.key}
                              type="button"
                              onClick={() => {
                                setAttendanceData(current => ({ ...current, [p.id]: { status: current[p.id]?.status === opt.key ? '' : opt.key, observation_count: current[p.id]?.observation_count || 0, observation_preview: current[p.id]?.observation_preview || [] } }));
                                setAttendanceDirty(prev => ({ ...prev, [p.id]: true }));
                              }}
                              title={`${opt.title}. Pulsa otra vez para dejar sin marcar.`}
                              aria-pressed={attendanceData[p.id]?.status === opt.key}
                              className={`w-8 h-8 rounded-lg text-xs font-bold transition-all ${
                                attendanceData[p.id]?.status === opt.key
                                  ? opt.color === 'emerald' ? 'bg-emerald-100 text-emerald-700 ring-2 ring-emerald-300'
                                  : opt.color === 'red' ? 'bg-red-100 text-red-700 ring-2 ring-red-300'
                                  : 'bg-amber-100 text-amber-700 ring-2 ring-amber-300'
                                  : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="min-w-[260px]">
                          {attendanceData[p.id]?.observation_preview?.[0] ? <><p className="line-clamp-2 text-xs leading-5 text-slate-700">{attendanceData[p.id].observation_preview[0].notes}</p><p className="text-[10px] text-slate-400">{attendanceData[p.id].observation_preview[0].created_by_name || 'Autor no registrado'} · {format(new Date(attendanceData[p.id].observation_preview[0].created_at), 'dd MMM, HH:mm', { locale: es })}</p></> : <span className="text-xs text-slate-400">Sin observaciones</span>}
                          <div className="mt-1"><button type="button" onClick={() => void loadAttendanceObservationHistory(p)} aria-label={`Abrir observaciones de asistencia de ${p.contact_name || 'participante'}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-50"><NotebookPen className="h-3.5 w-3.5" />Observaciones{(attendanceData[p.id]?.observation_count || 0) > 1 && ` · +${(attendanceData[p.id]?.observation_count || 0) - 1} más`}</button></div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
                </>
              )}
            </div>

            <div className="flex gap-3 mt-4 pt-4 border-t border-slate-100 sm:justify-end">
              <button
                onClick={requestCloseAttendance}
                className="min-h-11 flex-1 rounded-xl px-4 py-2.5 font-medium text-slate-600 transition-colors hover:bg-slate-100 sm:flex-none"
              >
                Cancelar
              </button>
              <button onClick={saveAttendance} disabled={attendanceLoadState !== 'success' || savingAttendance || Object.keys(attendanceDirty).length === 0} className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 font-medium text-white shadow-sm transition-all hover:bg-emerald-700 disabled:opacity-50 sm:flex-none">
                <Check className="w-4 h-4" />
                {savingAttendance ? 'Guardando...' : 'Guardar Asistencia'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ObservationHistoryModal
        isOpen={!!attendanceObservationParticipant && !!selectedSession}
        onClose={closeAttendanceObservationHistory}
        attendanceContext={attendanceObservationParticipant && selectedSession ? { programId, sessionId: selectedSession.id, participantId: attendanceObservationParticipant.id } : null}
        name={attendanceObservationParticipant?.contact_name || 'Participante sin nombre'}
        observations={attendanceObservationHistory}
        loading={attendanceObservationLoading}
        errorMessage={attendanceObservationError}
        onRetry={() => { if (attendanceObservationParticipant) void loadAttendanceObservationHistory(attendanceObservationParticipant); }}
        onObservationChange={() => { if (attendanceObservationParticipant) void loadAttendanceObservationHistory(attendanceObservationParticipant); }}
        mutationMode="manage"
        initialComposerOpen={attendanceObservationComposerOpen}
      />

      <ObservationHistoryModal
        isOpen={!!observationParticipant}
        onClose={closeObservationHistory}
        leadId={undefined}
        contactId={observationParticipant?.contact_id || null}
        programId={programId}
        programParticipantId={observationParticipant?.id || null}
        defaultNewType="note"
        name={observationParticipant?.contact_name || 'Participante sin nombre'}
        observations={observationHistory}
        loading={observationHistoryLoading}
        errorMessage={observationHistoryError}
        onRetry={() => { if (observationParticipant) void openObservationHistory(observationParticipant.id, observationComposerInitiallyOpen) }}
        onObservationChange={() => { void fetchHealth(); if (observationParticipant) void openObservationHistory(observationParticipant.id, false) }}
        mutationMode={mobileWorkspace ? 'append-only' : 'manage'}
        allowedNewTypes={mobileWorkspace ? ['note'] : ['note', 'call']}
        initialComposerOpen={observationComposerInitiallyOpen}
      />

      {/* Participant Outcome Modal */}
      {outcomeParticipant && (
        <div className="app-viewport fixed inset-0 z-[70] flex items-stretch justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="participant-outcome-title" className="h-[var(--app-height)] w-full max-w-md overflow-y-auto rounded-none bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:h-auto sm:max-h-[92vh] sm:rounded-2xl sm:p-6">
            <div className="flex justify-between items-start mb-5">
              <div>
                <h2 id="participant-outcome-title" className="text-xl font-bold text-slate-800">
                  {outcomeForm.status === 'completed' ? 'Completar participación' : 'Retirar del programa'}
                </h2>
                <p className="text-sm text-slate-500">{outcomeParticipant.contact_name || 'Participante sin nombre'}</p>
              </div>
              <button onClick={() => setOutcomeParticipant(null)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            {outcomeForm.status === 'completed' ? (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Siguiente nivel</label>
                <input
                  value={outcomeForm.transferred_to_level}
                  onChange={(e) => setOutcomeForm(prev => ({ ...prev, transferred_to_level: e.target.value }))}
                  placeholder="Ej: Nivel 2, grupo avanzado..."
                  className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-800">Saldrá del padrón activo y de sus cálculos actuales. Su asistencia, observaciones y periodo permanecerán disponibles en Historial.</div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Motivo</label>
                  <input
                    value={outcomeForm.drop_reason}
                    onChange={(e) => setOutcomeForm(prev => ({ ...prev, drop_reason: e.target.value }))}
                    placeholder="Ej: horarios, salud, sin contacto..."
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Observación</label>
                  <textarea
                    value={outcomeForm.drop_notes}
                    onChange={(e) => setOutcomeForm(prev => ({ ...prev, drop_notes: e.target.value }))}
                    rows={3}
                    className="w-full px-3.5 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                  />
                </div>
              </div>
            )}
            <div className="sticky bottom-0 -mx-4 mt-6 flex gap-3 border-t border-slate-100 bg-white px-4 pb-[env(safe-area-inset-bottom)] pt-4 sm:static sm:mx-0 sm:justify-end sm:px-0 sm:pb-0">
              <button onClick={() => setOutcomeParticipant(null)} disabled={savingOutcome} className="min-h-11 flex-1 rounded-xl px-4 py-2.5 font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50 sm:flex-none">
                Cancelar
              </button>
              <button onClick={saveParticipantOutcome} disabled={savingOutcome} className={`min-h-11 flex-1 rounded-xl px-5 py-2.5 font-medium text-white shadow-sm transition-all disabled:cursor-wait disabled:opacity-60 sm:flex-none ${outcomeForm.status === 'dropped' ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
                {savingOutcome ? 'Guardando…' : outcomeForm.status === 'dropped' ? 'Retirar y conservar historial' : 'Completar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Campaign Modal */}
      <CreateCampaignModal
        open={showCampaignModal && !mobileWorkspace}
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

      {/* Edit Program Modal */}
      {isEditModalOpen && !mobileWorkspace && (
        <div className="app-viewport fixed inset-0 z-[70] flex items-stretch justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => setIsEditModalOpen(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="edit-program-detail-title" className="flex h-[var(--app-height)] w-full max-w-md flex-col overflow-hidden rounded-none bg-white shadow-2xl sm:h-auto sm:max-h-[92vh] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <h3 id="edit-program-detail-title" className="text-lg font-bold text-slate-800">Editar Programa</h3>
              <button onClick={() => setIsEditModalOpen(false)} className="flex h-11 w-11 items-center justify-center rounded-xl transition-colors hover:bg-slate-100">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <form onSubmit={handleUpdateProgram} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-5">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nombre</label>
                <input
                  type="text"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  required
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Descripción</label>
                <textarea
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Color</label>
                <div className="flex gap-2 flex-wrap">
                  {['#10b981', '#3b82f6', '#8b5cf6', '#6366f1', '#ec4899', '#f43f5e', '#f97316', '#f59e0b'].map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setEditForm({ ...editForm, color: c })}
                      className={`w-8 h-8 rounded-full transition-all ${editForm.color === c ? 'ring-2 ring-offset-2 ring-slate-400 scale-110' : 'hover:scale-110'}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Estado</label>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                >
                  <option value="active">Activo</option>
                  <option value="archived">Archivado</option>
                  <option value="completed">Completado</option>
                </select>
              </div>
              <div className="sticky bottom-0 -mx-4 flex gap-3 border-t border-slate-100 bg-white px-4 pb-[env(safe-area-inset-bottom)] pt-4 sm:static sm:mx-0 sm:justify-end sm:border-0 sm:px-0 sm:pb-0">
                <button type="button" onClick={() => setIsEditModalOpen(false)} className="min-h-11 flex-1 rounded-xl px-4 py-2.5 font-medium text-slate-600 transition-colors hover:bg-slate-100 sm:flex-none">
                  Cancelar
                </button>
                <button type="submit" disabled={saving || !editForm.name.trim()} className="min-h-11 flex-1 rounded-xl bg-emerald-600 px-5 py-2.5 font-medium text-white shadow-sm transition-all hover:bg-emerald-700 disabled:opacity-50 sm:flex-none">
                  {saving ? 'Guardando...' : 'Guardar Cambios'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Lead/Contact Detail Side Panel with Inline Chat */}
      {participantDetailOpen && (
        <div className="app-viewport fixed inset-0 z-[70] flex justify-end overflow-hidden">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={closeParticipantDetail}
          />
          <div ref={participantDetailDialogRef} role="dialog" aria-modal="true" aria-label="Detalle del participante" tabIndex={-1} className={`relative flex h-[var(--app-height,100dvh)] border-l border-slate-200 bg-white pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] shadow-2xl outline-none transition-all duration-200 motion-reduce:transition-none lg:pl-0 lg:pr-0 ${showInlineChat ? 'w-full pt-[env(safe-area-inset-top)] lg:w-[85vw] lg:max-w-6xl lg:pt-0' : 'w-full max-w-md'}`}>
            {/* Chat Panel - Left Side */}
            {showInlineChat && inlineChatId && (
              <div className="flex h-full min-w-0 flex-1 flex-col bg-slate-50/50 lg:border-r lg:border-slate-200">
                <ChatPanel
                  chatId={inlineChatId}
                  deviceId={inlineChatDeviceId}
                  initialChat={inlineChat || undefined}
                  readOnly={inlineChatReadOnly}
                  onClose={() => setShowInlineChat(false)}
                  className="h-full"
                />
              </div>
            )}
            {/* Detail Panel - Right Side (programs are contact-only by spec) */}
            <div className={`${showInlineChat ? 'hidden lg:flex lg:w-[360px] lg:shrink-0' : 'flex w-full'} h-full flex-col bg-white`}>
              {loadingLead && !selectedContact ? (
                <div className="flex h-full flex-col">
                  <div className="flex h-16 items-center justify-between border-b border-slate-100 px-4"><div className="h-4 w-40 animate-pulse rounded bg-slate-200" /><button type="button" onClick={closeParticipantDetail} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100" aria-label="Cerrar"><X className="h-4 w-4" /></button></div>
                  <div className="space-y-5 p-6"><div className="mx-auto h-16 w-16 animate-pulse rounded-full bg-slate-200" /><div className="mx-auto h-5 w-44 animate-pulse rounded bg-slate-200" /><div className="h-28 animate-pulse rounded-xl bg-slate-100" /><div className="h-40 animate-pulse rounded-xl bg-slate-100" /></div>
                </div>
              ) : participantDetailError ? (
                <div className="flex h-full flex-col">
                  <div className="flex h-16 items-center justify-between border-b border-slate-100 px-4"><h2 className="text-sm font-semibold text-slate-900">Detalle del participante</h2><button type="button" onClick={closeParticipantDetail} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100" aria-label="Cerrar"><X className="h-4 w-4" /></button></div>
                  <div className="flex flex-1 items-center justify-center p-6"><div className="text-center"><AlertCircle className="mx-auto h-9 w-9 text-red-400" /><p className="mt-3 font-medium text-slate-800">No se pudo cargar el participante</p><p className="mt-1 text-sm text-slate-500">{participantDetailError}</p><button type="button" onClick={retryParticipantDetail} className="mt-4 min-h-11 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700">Reintentar</button></div></div>
                </div>
              ) : selectedContact && selectedParticipantID ? (
                <ContactDetailSurface
                  contactId={selectedContact.id}
                  context={{ type: 'program_participant', id: selectedParticipantID }}
                  initialContact={selectedContact}
                  title="Detalle del participante"
                  subtitle={program.name}
                  onClose={closeParticipantDetail}
                  onContactChange={handleParticipantContactChange}
                  onSendMessage={showInlineChat ? undefined : handleSendWhatsApp}
                  sendingMessage={whatsappLaunching || whatsappCreating}
                  contextContent={(
                    <div className="pb-[calc(1rem+env(safe-area-inset-bottom))]">
                      <section className="border-b border-slate-200 px-4 py-4" aria-labelledby="program-participation-title">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h4 id="program-participation-title" className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Participación en el programa</h4>
                            <p className="mt-1 truncate text-sm font-semibold text-slate-800">{program.name}</p>
                          </div>
                          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${
                            selectedProgramParticipant?.status === 'completed'
                              ? 'bg-blue-50 text-blue-700'
                              : selectedProgramParticipant?.status === 'dropped'
                                ? 'bg-red-50 text-red-700'
                                : 'bg-emerald-50 text-emerald-700'
                          }`}>
                            {selectedProgramParticipant?.status === 'completed'
                              ? 'Completado'
                              : selectedProgramParticipant?.status === 'dropped'
                                ? 'Retirado'
                                : 'Activo'}
                          </span>
                        </div>
                        {selectedProgramParticipant && (
                          <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-slate-600 sm:grid-cols-2">
                            <ProgramParticipantEnrollmentDate programId={programId} participant={selectedProgramParticipant} onChange={enrolledAt => handleParticipantEnrollmentChange(selectedProgramParticipant.id, enrolledAt)} />
                            {selectedProgramParticipant.completed_at && (
                              <div className="rounded-xl bg-slate-50 px-3 py-2">
                                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Finalización</p>
                                <p className="mt-0.5 font-semibold text-slate-700">{formatCalendarDate(selectedProgramParticipant.completed_at, 'dd MMM yyyy', { locale: es })}</p>
                              </div>
                            )}
                            {selectedProgramParticipant.dropped_at && (
                              <div className="rounded-xl bg-slate-50 px-3 py-2">
                                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Retiro</p>
                                <p className="mt-0.5 font-semibold text-slate-700">{formatCalendarDate(selectedProgramParticipant.dropped_at, 'dd MMM yyyy', { locale: es })}</p>
                              </div>
                            )}
                          </div>
                        )}
                        {selectedProgramParticipant?.status === 'active' ? (
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <button type="button" onClick={() => openOutcomeModal(selectedProgramParticipant.id, 'completed')} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 transition hover:bg-blue-100"><Target className="h-4 w-4" />Completar</button>
                            <button type="button" onClick={() => openOutcomeModal(selectedProgramParticipant.id, 'dropped')} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 text-xs font-semibold text-red-700 transition hover:bg-red-100"><XCircle className="h-4 w-4" />Retirar</button>
                          </div>
                        ) : (
                          <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">Esta participación está en el historial y no afecta el padrón ni la salud actual del programa.</p>
                        )}
                      </section>
                      <div className="px-4">
                        <ProgramParticipantAttendanceSection
                          programId={programId}
                          participantId={selectedParticipantID}
                          participantName={selectedProgramParticipant?.contact_name || selectedContact.custom_name || selectedContact.name || selectedContact.phone || 'Participante'}
                          enrolledAt={selectedProgramParticipant?.enrolled_at || ''}
                        />
                      </div>
                    </div>
                  )}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Device Selector Modal for WhatsApp */}
      {showDeviceSelector && (
        <div className="app-viewport fixed inset-0 z-[80] flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) setShowDeviceSelector(false); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="program-device-selector-title" className="flex max-h-[min(86dvh,var(--app-height,100dvh))] w-full max-w-sm flex-col overflow-hidden rounded-t-3xl border border-slate-100 bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-2xl sm:p-6">
            <h2 id="program-device-selector-title" className="mb-3 text-sm font-semibold text-slate-900">Seleccionar dispositivo</h2>
            <p className="text-xs text-slate-500 mb-4">Elige el dispositivo para el chat con {whatsappPhone}</p>
            {existingChatForWA && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3">
                Ya existe historial{whatsappHistoricalPhone ? ` con el numero ${whatsappHistoricalPhone}` : ' con numero historico desconocido'}.
              </p>
            )}
            {devices.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">No hay dispositivos conectados</p>
            ) : (
              <div className="min-h-0 space-y-2 overflow-y-auto">
                {devices.map(device => (
                  <button key={device.id} type="button" onClick={() => void handleDeviceSelectedForChat(device)} disabled={whatsappCreating}
                    className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-slate-100 p-3 text-left transition hover:border-emerald-200 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-wait disabled:opacity-50"
                  >
                    <div className="w-9 h-9 bg-emerald-50 rounded-full flex items-center justify-center"><Phone className="w-4 h-4 text-emerald-600" /></div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-slate-900">{device.name || 'Dispositivo'}</p>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${relationClassName(device)}`}>{relationLabel(device)}</span>
                      </div>
                      <p className="text-xs text-slate-500">{deviceDisplayPhone(device)}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            <button type="button" onClick={() => setShowDeviceSelector(false)} className="mt-4 min-h-11 w-full rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">Cancelar</button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toastMessage && (
        <div className={`fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] left-4 right-4 z-[100] flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm font-medium shadow-lg transition-all animate-in slide-in-from-bottom-4 sm:left-auto sm:right-6 sm:max-w-lg sm:px-5 ${
          toastType === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toastType === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span className="min-w-0 flex-1 break-words">{toastMessage}</span>
          <button onClick={() => setToastMessage(null)} className="ml-1 shrink-0 rounded p-0.5 hover:bg-white/20">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmAction && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
          <div role="alertdialog" aria-modal="true" aria-label="Confirmar acción" className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                <AlertCircle className="w-5 h-5 text-red-500" />
              </div>
              <p className="text-sm text-slate-700 leading-relaxed">{confirmAction.message}</p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2.5 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={confirmAction.onConfirm}
                className="px-5 py-2.5 bg-red-600 text-white rounded-xl hover:bg-red-700 transition-all shadow-sm font-medium text-sm"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
