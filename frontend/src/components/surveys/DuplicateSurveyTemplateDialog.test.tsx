// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DuplicateSurveyTemplateDialog from './DuplicateSurveyTemplateDialog';

afterEach(cleanup);

describe('DuplicateSurveyTemplateDialog', () => {
  it('explains the isolated scope and submits one trimmed name', async () => {
    const duplicate = vi.fn().mockResolvedValue(undefined);
    render(<DuplicateSurveyTemplateDialog sourceName=" Seguimiento " questionCount={4} measurementDimensionCount={2} onClose={vi.fn()} onDuplicate={duplicate} />);
    expect(screen.getByText(/No se copiarán aplicaciones, enlaces, destinatarios, respuestas ni resultados/)).toBeTruthy();
    expect(screen.getByDisplayValue('Copia de Seguimiento')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nombre de la copia'), { target: { value: '  Nueva medición  ' } });
    fireEvent.click(screen.getByRole('button', { name: /Duplicar y editar/ }));
    await waitFor(() => expect(duplicate).toHaveBeenCalledTimes(1));
    expect(duplicate).toHaveBeenCalledWith('Nueva medición');
  });

  it('keeps the dialog open and reports API failures', async () => {
    render(<DuplicateSurveyTemplateDialog sourceName="Base" questionCount={1} measurementDimensionCount={0} onClose={vi.fn()} onDuplicate={vi.fn().mockRejectedValue(new Error('Conflicto de copia'))} />);
    fireEvent.click(screen.getByRole('button', { name: /Duplicar y editar/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Conflicto de copia');
  });
});
