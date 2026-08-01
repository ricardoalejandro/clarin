import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SurveyInstanceNameField from './SurveyInstanceNameField';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({ api: vi.fn() }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('SurveyInstanceNameField', () => {
  it('waits 500 ms, rejects stale work and offers the server suggestion', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ success: true, data: { available: true, suggested_name: 'Informe · 2' } })
      .mockResolvedValueOnce({ success: true, data: { available: false, suggested_name: 'Informe · 2' } });
    render(<SurveyInstanceNameField templateId="template-1" value="Informe" onChange={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(api).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(499); await Promise.resolve(); });
    expect(api).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); await Promise.resolve(); });
    expect(api).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /Usar “Informe · 2”/ })).toBeTruthy();
  });
});
