# WebSocket recovery scenarios

Drives `MessageSocket.js` with a fake WebSocket and fake timers, no browser or
jest needed, and checks the recovery paths a user actually hits:

    node scripts/reconnect-scenarios/scenarios.js resume-silence
    node scripts/reconnect-scenarios/scenarios.js die-during-resync
    node scripts/reconnect-scenarios/scenarios.js budget-keeps-queue
    node scripts/reconnect-scenarios/scenarios.js unstable-reestablish

Each prints `ok:`/`FAIL:` lines and exits non-zero on a failure. `MS_SRC` points
it at another copy of MessageSocket.js to compare behaviour across versions.
