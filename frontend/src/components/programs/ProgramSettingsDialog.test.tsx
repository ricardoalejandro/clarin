import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

it('restores the same settings field after mobile suspension', async () => {
  const props = { open: true, program: baseProgram, onClose: vi.fn(), onSaved: vi.fn() };
  const view = render(<ProgramSettingsDialog {...props} />);
  const description = screen.getByRole('textbox', { name: 'Descripción' });
  description.focus();
  view.rerender(<ProgramSettingsDialog {...props} suspended />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  view.rerender(<ProgramSettingsDialog {...props} />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Descripción' })).toHaveFocus());
});

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
  it('preserves a draft and discard confirmation while suspended and detects newer canonical data', () => {
    const props = { open: true, program: baseProgram, onClose: vi.fn(), onSaved: vi.fn(), onDirtyChange: vi.fn() };
    const view = render(<ProgramSettingsDialog {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'Mi borrador' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    view.rerender(<ProgramSettingsDialog {...props} suspended />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
    view.rerender(<ProgramSettingsDialog {...props} />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Seguir editando' }));
    view.rerender(<ProgramSettingsDialog {...props} program={{ ...baseProgram, name: 'Otra persona', updated_at: '2026-10-17T12:00:00Z' }} suspended />);
    view.rerender(<ProgramSettingsDialog {...props} program={{ ...baseProgram, name: 'Otra persona', updated_at: '2026-10-17T12:00:00Z' }} />);
    expect(screen.getByRole('textbox', { name: 'Nombre' })).toHaveValue('Mi borrador');
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(mockedAPI).not.toHaveBeenCalled();
  });

  it('reconciles one save already sent during suspension without a duplicate write', async () => {
    let finish!: (value: unknown) => void;
    mockedAPI.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never);
    const props = { open: true, program: baseProgram, onClose: vi.fn(), onSaved: vi.fn() };
    const view = render(<ProgramSettingsDialog {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'Programa guardado' } });
    const form = screen.getByRole('button', { name: 'Guardar cambios' }).closest('form')!;
    fireEvent.submit(form);
    view.rerender(<ProgramSettingsDialog {...props} suspended />);
    fireEvent.submit(form);
    await act(async () => { finish({ success: true, data: { ...baseProgram, name: 'Programa guardado' } }); });
    expect(mockedAPI).toHaveBeenCalledTimes(1);
    expect(props.onSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'Programa guardado' }));
  });
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

    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fecha de incorporación' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'Borrador aún pendiente' } });
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('textbox', { name: 'Nombre' }).closest('form')!);
    expect(mockedAPI).toHaveBeenCalledOnce();

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
