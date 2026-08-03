import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import SurveyApplicationLifecycleActions from './SurveyApplicationLifecycleActions';

vi.mock('@/lib/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const target = {
  id: 'survey-1', name: 'Seguimiento', status: 'active' as const, can_delete: true,
  response_count: 0, recipient_count: 12,
};

describe('SurveyApplicationLifecycleActions', () => {
  it('archives once and returns the canonical closed summary', async () => {
    const onUpdated = vi.fn();
    vi.mocked(api).mockResolvedValue({ success: true, status: 200, data: { ...target, account_id: 'a', template_id: 't', template_revision: 1, origin_type: 'standalone', origin_label: 'Independiente', slug: 'seguimiento', audience_mode: 'public', legacy_instance: false, analytics_tracking_started_at: '', question_count: 1, created_at: '', updated_at: '', archived_at: '2026-08-01T00:00:00Z' } });
    render(<SurveyApplicationLifecycleActions target={target} onUpdated={onUpdated} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archivar aplicación' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/surveys/survey-1/archive', { method: 'POST' }));
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });

  it('keeps protected history impossible to delete and explains why', () => {
    render(<SurveyApplicationLifecycleActions target={{ ...target, can_delete: false, deletion_block_reason: 'has_responses' }} onUpdated={vi.fn()} onDeleted={vi.fn()} />);
    const button = screen.getByRole('button', { name: /Tiene respuestas/ });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(api).not.toHaveBeenCalled();
  });

  it('keeps a failed mutation open, retryable, and never reconciles a false success', async () => {
    const onUpdated = vi.fn();
    vi.mocked(api)
      .mockResolvedValueOnce({ success: false, status: 409, error: 'La aplicación cambió mientras confirmabas.' })
      .mockResolvedValueOnce({ success: true, status: 200, data: { ...target, account_id: 'a', template_id: 't', template_revision: 1, origin_type: 'standalone', origin_label: 'Independiente', slug: 'seguimiento', audience_mode: 'public', legacy_instance: false, analytics_tracking_started_at: '', question_count: 1, created_at: '', updated_at: '', status: 'closed', archived_at: '2026-08-01T00:00:00Z', can_restore: true } });
    render(<SurveyApplicationLifecycleActions target={target} onUpdated={onUpdated} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archivar aplicación' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('cambió mientras confirmabas'));
    expect(onUpdated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('reconciles a permanent deletion only after the 204 response', async () => {
    const onDeleted = vi.fn();
    vi.mocked(api).mockResolvedValue({ success: true, status: 204 });
    render(<SurveyApplicationLifecycleActions target={target} onUpdated={vi.fn()} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar aplicación' }));
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('survey-1'));
    expect(api).toHaveBeenCalledWith('/api/surveys/survey-1', { method: 'DELETE' });
  });
});
