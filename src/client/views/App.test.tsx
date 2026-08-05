/**
 * Ticket 012 — App shell: TopBar tabs switch between SessionView and
 * ResultsView; run provenance renders only on Results.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { COPY, renderApp } from './sessionTestKit';

afterEach(cleanup);

// deps.now pinned to 2026-08-05 UTC so the provenance date is deterministic.
const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);
const PROVENANCE = 'run 2026-08-05 · corpus v1';

function renderPinnedApp() {
  return renderApp({ now: () => NOW });
}

describe('App — top bar and view switching', () => {
  it('renders the workbench title and defaults to the Session view', () => {
    renderPinnedApp();
    expect(screen.getByText('Interpreter workbench')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Session' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Results' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText(COPY.idleTitle)).toBeInTheDocument();
  });

  it('Results tab mounts ResultsView (empty state) and unmounts the Session view', () => {
    renderPinnedApp();
    fireEvent.click(screen.getByRole('button', { name: 'Results' }));

    expect(screen.getByText('No runs recorded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Results' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByText(COPY.idleTitle)).not.toBeInTheDocument();

    // And back again.
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    expect(screen.getByText(COPY.idleTitle)).toBeInTheDocument();
    expect(screen.queryByText('No runs recorded')).not.toBeInTheDocument();
  });

  it('run-provenance mono text renders only on Results — never over a session', () => {
    renderPinnedApp();
    expect(screen.queryByText(PROVENANCE)).not.toBeInTheDocument();
    expect(document.querySelector('[data-provenance-run]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Results' }));
    const provenance = document.querySelector('[data-provenance-run]');
    expect(provenance).not.toBeNull();
    expect(provenance).toHaveTextContent(PROVENANCE);

    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    expect(screen.queryByText(PROVENANCE)).not.toBeInTheDocument();
  });
});
