import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SurveyInstanceNameField from './SurveyInstanceNameField';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({ api: vi.fn() }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('SurveyInstanceNameField', () => {
  it('ignores a malformed automatic suggestion instead of writing undefined into the draft', async () => {
    vi.mocked(api).mockResolvedValueOnce({ success: true, data: { available: true } } as never);
    const onChange = vi.fn();
    render(<SurveyInstanceNameField templateId="template-1" value="" onChange={onChange} />);

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

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

  it('preserves the custom draft while paused and only revalidates on resume', async () => {
    vi.mocked(api).mockResolvedValue({ success: true, data: { available: true, suggested_name: 'Automatic name' } });
    const onChange = vi.fn();
    const props = { templateId: 'template-1', programId: 'program-1', value: 'Mi nombre elegido', onChange };
    const view = render(<SurveyInstanceNameField {...props} />);
    await act(async () => {});
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(<SurveyInstanceNameField {...props} suspended />);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(api).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox')).toBeDisabled();
    view.rerender(<SurveyInstanceNameField {...props} />);
    await act(async () => { vi.advanceTimersByTime(499); });
    expect(api).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(api).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api).mock.calls[1][0]).toContain('name=Mi%20nombre%20elegido');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('Mi nombre elegido');
  });

  it('aborts pending validation on pause and rejects its late response', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api)
      .mockResolvedValueOnce({ success: true, data: { available: true, suggested_name: 'Suggested' } })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never);
    const onAvailabilityChange = vi.fn();
    const props = { templateId: 'template-1', value: 'My draft', onChange: vi.fn(), onAvailabilityChange };
    const view = render(<SurveyInstanceNameField {...props} />);
    await act(async () => { vi.advanceTimersByTime(500); });
    const signal = vi.mocked(api).mock.calls[1][1]?.signal;
    view.rerender(<SurveyInstanceNameField {...props} suspended />);
    expect(signal?.aborted).toBe(true);
    await act(async () => finish({ success: true, data: { available: false, suggested_name: 'Late suggestion' } }));
    expect(screen.queryByRole('button', { name: /Late suggestion/ })).not.toBeInTheDocument();
    expect(onAvailabilityChange).not.toHaveBeenCalledWith(false);
  });

  it('rejects an automatic suggestion from the previous template identity', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api)
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never)
      .mockResolvedValueOnce({ success: true, data: { available: true, suggested_name: 'New template name' } });
    const onChange = vi.fn();
    const view = render(<SurveyInstanceNameField templateId="template-old" value="" onChange={onChange} />);
    view.rerender(<SurveyInstanceNameField templateId="template-new" value="" onChange={onChange} />);
    await act(async () => finish({ success: true, data: { available: true, suggested_name: 'Old template name' } }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('New template name');
    expect(vi.mocked(api).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
