/**
 * Ticket 036 — the ONE microphone-denial remediation copy.
 *
 * A denied microphone has two independent causes and the operator cannot tell
 * them apart from the failure alone: the browser's per-site permission, and the
 * operating system's microphone privacy setting. Naming only one sends half the
 * operators in a circle — and browsers do not re-prompt after a denial, so a
 * bare "retry" looks broken until the site permission is reset first.
 *
 * These strings were written for the Live view's blocking card and are shared
 * verbatim with Replay's record flow. There is exactly one copy of this text in
 * the product: a second, weaker variant is a regression, and
 * ReplayView.record.test.tsx fails if either consumer restates it inline.
 */

export const MIC_DENIED_HEADING = 'Microphone blocked';

/** Layer 1 — the browser's per-site permission. */
export const MIC_DENIED_SITE_PERMISSION =
  'Check the browser site permission: allow microphone access for this site ' +
  '(look for the mic icon in the address bar).';

/** Layer 2 — the operating system's privacy setting. */
export const MIC_DENIED_OS_SETTING =
  'Check the OS microphone setting: your system privacy settings must allow ' +
  'this browser to use the microphone.';

/** Why a bare retry appears to do nothing. */
export const MIC_DENIED_NO_REPROMPT =
  'Browsers do not re-prompt after a denial — reset the site permission first, then retry.';
