import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Program } from '@/types/program';
import { api } from '@/lib/api';
import { ProgramSettingsDialog } from './ProgramSettingsDialog';

vi.mock('@/lib/api', () => ({ api: vi.fn() }));

const mockedAPI = vi.mocked(api);

const baseProgram: Program = {
  id: 'program-1',
  account_id: 'account-1',
  name: 'Programa central',
  description: 'Descripción',
  status: 'active',
  color: '#10b981',
  created_by: 'user-1',
  created_at: '2026-08-20T10:00:00Z',
  updated_at: '2026-08-23T10:00:00Z',
};

afterEach(cleanup);
beforeEach(() => mockedAPI.mockReset());

function renderDialog(program: Program = baseProgram) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const onCanonicalReload = vi.fn();
  render(
    <ProgramSettingsDialog
      open
      program={program}
      onClose={onClose}
      onSaved={onSaved}
      onCanonicalReload={onCanonicalReload}
    />,
  );
  return { onClose, onSaved, onCanonicalReload };
}

describe('ProgramSettingsDialog', () => {
  it('uses defaults and exposes fixed columns as checked disabled controls', () => {
    renderDialog();

    expect(screen.getByRole('checkbox', { name: 'Salud' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Asistencia' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Señales' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Fecha de incorporación' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Antigüedad' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Participante siempre visible' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Acciones siempre visible' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
  });

  it('keeps a draft and confirms Cancel, Escape, and backdrop dismissal', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Antigüedad' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(screen.getByRole('alertdialog', { name: '¿Descartar los cambios?' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Seguir editando' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: '¿Descartar los cambios?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('sends one complete optimistic payload and returns the canonical program', async () => {
    const savedProgram = {
      ...baseProgram,
      updated_at: '2026-08-23T11:00:00Z',
      health_view_columns: ['health', 'attendance', 'signals', 'enrolled_at'] as Program['health_view_columns'],
    };
    mockedAPI.mockResolvedValueOnce({ success: true, data: savedProgram, status: 200 });
    const { onSaved } = renderDialog();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Fecha de incorporación' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedProgram));
    expect(mockedAPI).toHaveBeenCalledOnce();
    expect(mockedAPI).toHaveBeenCalledWith('/api/programs/program-1', {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Programa central',
        description: 'Descripción',
        color: '#10b981',
        status: 'active',
        health_view_columns: ['health', 'attendance', 'signals', 'enrolled_at'],
        expected_updated_at: '2026-08-23T10:00:00Z',
      }),
    });
  });

  it('preserves the draft on a conflict and can reconcile the canonical version', async () => {
    const conflictProgram = {
      ...baseProgram,
      name: 'Nombre canónico',
      updated_at: '2026-08-23T12:00:00Z',
      health_view_columns: ['health'] as Program['health_view_columns'],
    };
    mockedAPI
      .mockResolvedValueOnce({
        success: false,
        status: 409,
        error: 'El programa cambió mientras lo editabas.',
        data: { code: 'PROGRAM_UPDATE_CONFLICT', error: 'El programa cambió mientras lo editabas.', program: conflictProgram },
      })
      .mockResolvedValueOnce({ success: true, status: 200, data: conflictProgram });
    const { onCanonicalReload, onSaved } = renderDialog();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Antigüedad' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    expect(await screen.findByText('Hay una versión más reciente')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Antigüedad' })).toBeChecked();
    expect(onSaved).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Recargar versión actual' }));
    await waitFor(() => expect(onCanonicalReload).toHaveBeenCalledWith(conflictProgram));
    expect(screen.getByRole('textbox', { name: 'Nombre' })).toHaveValue('Nombre canónico');
    expect(screen.getByRole('checkbox', { name: 'Salud' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Antigüedad' })).not.toBeChecked();
  });

  it('keeps the draft after a transient error and allows a direct retry', async () => {
    const savedProgram = {
      ...baseProgram,
      updated_at: '2026-08-23T11:00:00Z',
      health_view_columns: ['health', 'attendance', 'signals', 'tenure'] as Program['health_view_columns'],
    };
    mockedAPI
      .mockResolvedValueOnce({ success: false, status: 503, error: 'Servicio temporalmente no disponible' })
      .mockResolvedValueOnce({ success: true, status: 200, data: savedProgram });
    const { onSaved } = renderDialog();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Antigüedad' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText('Servicio temporalmente no disponible')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Antigüedad' })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedProgram));
    expect(mockedAPI).toHaveBeenCalledTimes(2);
  });
});
