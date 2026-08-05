---
id: 008
title: Session lifecycle state machine + four-value mic permission model
status: pending
depends_on: []
touches: [src/client/state/sessionMachine.ts, src/client/state/permission.ts]
test_files: []
iterations: 0
---

## Scope
Pure-TS (no React) reducer/machine in `src/client/state/`:
- States exactly PRD §6: idle, requesting-permission, permission-denied, listening, processing,
  ready, playing, switch-queued(overlay flag alongside an active state), reconnecting,
  disconnected, stopping, stopped. Events: START, PERMISSION_GRANTED, PERMISSION_DENIED,
  SPEECH_DETECTED, ARMS_SETTLED, PLAY(arm), PLAYBACK_ENDED, REQUEST_SWITCH(kind: mode|language|
  direction, payload), UTTERANCE_BOUNDARY, CONNECTION_LOST, RECONNECT_ATTEMPT(n),
  RECONNECTED, RECONNECT_EXHAUSTED, RECONNECT_CLICKED, STOP, FLUSH_DONE, NEW_SESSION.
- Mic permission is a SEPARATE four-value property: not-requested | requesting | granted |
  denied — its own field, updated by events, never derived as boolean; denied blocks START.
- Switch queueing: REQUEST_SWITCH while a session is active sets `pending` (label + patch);
  applied only on UTTERANCE_BOUNDARY; instant-applied when no session is active (idle/stopped).
  One mechanism for mode, language pair, AND direction (PRD decision 14b).
- Arm config in context: mode, langIdx, reversed, arms[], autoplay. Rules: autoplay may be true
  only when arms.length===1; adding a 2nd arm forces autoplay=false; removing back to one arm
  RESTORES autoplay=true (handoff §Arms strip). Max 3 arms.
- Reconnecting: preserves transcript context, counts attempts (max 5), exhausted → disconnected.
- stopping: waits for FLUSH_DONE → stopped with summary {elapsed, utterances, dropped, cost}.
- Elapsed timer support (start timestamp in context; stopped freezes it).

## Acceptance criteria
1. Full happy path walk: idle→(START)→requesting-permission→(GRANTED)→listening→(SPEECH)→
   processing→(SETTLED)→ready→(PLAY)→playing→(ENDED)→ready; permission field tracks
   not-requested→requesting→granted.
2. PERMISSION_DENIED → permission-denied state, permission='denied'; START from
   permission-denied is a no-op while denied (blocking, PRD §6 req 2).
3. REQUEST_SWITCH(mode) while listening → pending set, state unchanged; UTTERANCE_BOUNDARY →
   patch applied, pending cleared. Same event flow works for language and direction. When idle:
   applied immediately, no pending.
4. Autoplay invariants: addArm→autoplay false; removeArm to 1→autoplay true; setAutoplay(true)
   rejected/ignored when arms>1.
5. CONNECTION_LOST→reconnecting (attempts increment; transcript untouched);
   5×RECONNECT_EXHAUSTED→disconnected; RECONNECT_CLICKED→reconnecting→RECONNECTED restores
   prior live state.
6. STOP→stopping; FLUSH_DONE→stopped with summary; NEW_SESSION→(permission already granted)
   skips requesting-permission → listening directly.
7. Language support labelling helper: pair support per DIRECTION (EN→YUE warns target-canto on
   realtime; YUE→EN warns input-side differently) per PRD §6; pill label 'both modes'/'cascade
   only' derived from most constrained direction.
