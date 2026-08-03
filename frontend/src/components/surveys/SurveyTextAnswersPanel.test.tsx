import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import SurveyTextAnswersPanel from './SurveyTextAnswersPanel';

vi.mock('@/lib/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SurveyTextAnswersPanel', () => {
  it('loads lazily, preserves multiline text and keeps public answers anonymous', async () => {
    vi.mocked(api).mockResolvedValue({ success: true, status: 200, data: { items: [{ id: 'a1', response_id: 'r1', value: 'Primera línea\nSegunda línea', completed_at: '2026-08-01T12:00:00Z', contact_name: 'No debe mostrarse' }], total: 1 } });
    render(<SurveyTextAnswersPanel surveyId="s1" questionId="q1" answerCount={1} programAudience={false} />);
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /1 respuesta de texto/ }));
    await waitFor(() => expect(screen.getByText('Respuesta anónima')).toBeTruthy());
    expect(screen.queryByText('No debe mostrarse')).toBeNull();
    expect(screen.getByText(/Primera línea/).className).toContain('whitespace-pre-wrap');
  });

  it('keeps a failed load visible and retryable', async () => {
    vi.mocked(api).mockResolvedValueOnce({ success: false, status: 500, error: 'Fallo temporal' }).mockResolvedValueOnce({ success: true, status: 200, data: { items: [], total: 0 } });
    render(<SurveyTextAnswersPanel surveyId="s1" questionId="q1" answerCount={2} programAudience />);
    fireEvent.click(screen.getByRole('button', { name: /2 respuestas de texto/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Fallo temporal'));
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(screen.getByText('No hay respuestas de texto completadas.')).toBeTruthy());
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('uses the opaque cursor returned by the server when loading more', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ success: true, status: 200, data: { items: [{ id: 'a1', response_id: 'r1', value: 'Uno', completed_at: '2026-08-01T12:00:00Z' }], total: 2, next_cursor: 'opaque-cursor' } })
      .mockResolvedValueOnce({ success: true, status: 200, data: { items: [{ id: 'a2', response_id: 'r2', value: 'Dos', completed_at: '2026-08-01T11:00:00Z' }], total: 2 } });
    render(<SurveyTextAnswersPanel surveyId="s1" questionId="q1" answerCount={2} programAudience={false} />);
    fireEvent.click(screen.getByRole('button', { name: /2 respuestas de texto/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Cargar más/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Cargar más/ }));
    await waitFor(() => expect(screen.getByText('Dos')).toBeTruthy());
    expect(String(vi.mocked(api).mock.calls[1][0])).toContain('cursor=opaque-cursor');
  });

  it('shows the exact program identity and expands long Unicode observations without losing line breaks', async () => {
    const longValue = `Inicio ágil — 你好 — 🙂\n${'detalle '.repeat(60)}cierre verificable`;
    vi.mocked(api).mockResolvedValue({ success: true, status: 200, data: { items: [{ id: 'a1', response_id: 'r1', value: longValue, completed_at: '2026-08-01T12:00:00Z', contact_name: 'Ana Participante', program_participant_id: 'pp-1' }], total: 1 } });
    render(<SurveyTextAnswersPanel surveyId="s1" questionId="q1" answerCount={1} programAudience />);
    fireEvent.click(screen.getByRole('button', { name: /1 respuesta de texto/ }));
    await waitFor(() => expect(screen.getByText('Ana Participante')).toBeTruthy());
    expect(screen.queryByText(/cierre verificable/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver completo' }));
    expect(screen.getByText(/cierre verificable/).className).toContain('whitespace-pre-wrap');
  });

  it('keeps already loaded observations visible while a failed next page is retried', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ success: true, status: 200, data: { items: [{ id: 'a1', response_id: 'r1', value: 'Observación conservada', completed_at: '2026-08-01T12:00:00Z' }], total: 2, next_cursor: 'next-page' } })
      .mockResolvedValueOnce({ success: false, status: 500, error: 'No se pudo cargar la página siguiente' })
      .mockResolvedValueOnce({ success: true, status: 200, data: { items: [{ id: 'a2', response_id: 'r2', value: 'Observación recuperada', completed_at: '2026-08-01T11:00:00Z' }], total: 2 } });
    render(<SurveyTextAnswersPanel surveyId="s1" questionId="q1" answerCount={2} programAudience={false} />);
    fireEvent.click(screen.getByRole('button', { name: /2 respuestas de texto/ }));
    await waitFor(() => expect(screen.getByText('Observación conservada')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Cargar más/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('página siguiente'));
    expect(screen.getByText('Observación conservada')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(screen.getByText('Observación recuperada')).toBeTruthy());
    expect(screen.getByText('Observación conservada')).toBeTruthy();
  });
});
