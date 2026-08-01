import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ArchiveSurveyTemplateDialog from './ArchiveSurveyTemplateDialog';
import type { SurveyTemplate } from '@/types/survey-template';

afterEach(cleanup);

const template = {
  id: 'template-1', account_id: 'account-1', name: 'Encuesta de cierre', description: '', status: 'active',
  welcome_title: '', welcome_description: '', thank_you_title: '', thank_you_message: '', thank_you_redirect_url: '',
  branding: {}, measurement_config: { dimensions: [] }, revision: 1, created_at: '', updated_at: '',
  question_count: 8, instance_count: 3, response_count: 42,
} satisfies SurveyTemplate;

describe('ArchiveSurveyTemplateDialog', () => {
  it('makes the reversible consequences and retained data explicit', () => {
    const confirm = vi.fn();
    render(<ArchiveSurveyTemplateDialog template={template} archiving={false} onClose={vi.fn()} onConfirm={confirm} />);
    expect(screen.getByText(/Se conservarán todos los datos y enlaces existentes/)).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }));
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
