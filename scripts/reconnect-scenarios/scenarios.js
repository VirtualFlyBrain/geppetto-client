const H = require('./harness.js');
const { MS, sockets, events, advance } = H;
const last = () => sockets[sockets.length - 1];
const names = () => events.map(e => e[0]);
const fails = () => events.filter(e => e[0] === 'disconnected').map(e => e[1] && e[1].reason);
function assert (c, m) { if (!c) { console.info('FAIL: ' + m); process.exitCode = 1; } else console.info('ok: ' + m); }

// initial connect + project load
MS.connect('wss://x/GeppettoServlet'); last().open();
MS.send('load_project_from_url', 'https://x/vfb.json'); last().reply('client_id', undefined, {}); MS.setClientID('c1');
MS.send('geppetto_version', null); last().reply('project_loaded', last().sent.find(m => m.type === 'load_project_from_url').requestID, {});
assert(last().sent.some(m => m.type === 'load_project_from_url'), 'project load sent on first socket');
const sc = process.argv[2];

if (sc === 'resume-silence') {
  last().serverClose(1006); advance(31000); last().open();
  assert(last().sent.some(m => m.type === 'reconnect'), 'resume requested');
  MS.send('fetch_variable', 'VFB_1');                        // user click while resuming
  advance(16000);                                             // server never answers
  assert(last().sent.some(m => m.type === 'load_project_from_url'), 'silent resume falls through to re-establish');
  last().reply('project_loaded', undefined, {});
  assert(last().sent.filter(m => m.type === 'fetch_variable').length === 1, 'queued click replayed after re-establish');
  assert(!fails().includes('resync-failed'), 'no reload requested');
}
if (sc === 'die-during-resync') {
  last().serverClose(1006); advance(31000); last().open();
  MS.send('fetch_variable', 'VFB_1');
  last().reply('reconnection_error', undefined, {});          // old session gone -> re-establish
  assert(last().sent.some(m => m.type === 'load_project_from_url'), 're-establish started');
  last().serverClose(1006);                                   // dies mid re-establish
  assert(!fails().includes('resync-failed'), 'socket death during re-establish does NOT request a reload');
  advance(31000); last().open();
  assert(last().sent.some(m => m.type === 'load_project_from_url') && !last().sent.some(m => m.type === 'reconnect'), 'next socket re-establishes directly, no doomed resume');
  last().reply('project_loaded', undefined, {});
  assert(last().sent.some(m => m.type === 'fetch_variable'), 'click still delivered');
}
if (sc === 'budget-keeps-queue') {
  last().serverClose(1006);
  MS.send('fetch_variable', 'VFB_1');                          // click while down
  for (let i = 0; i < 40; i++) { advance(31000); if (last().readyState === 0) last().serverClose(1006); }
  assert(fails().includes('budget-exhausted'), 'budget exhausted reported');
  assert(!names().includes('geppetto:request_failed'), 'queued click NOT failed on exhaustion');
  MS.send('fetch_variable', 'VFB_2');                          // click after exhaustion
  MS.attempts = 0; MS.reconnect(); advance(31000); last().open();
  last().reply('client_id'); last().reply('geppetto_version', last().sent.find(m => m.type === 'geppetto_version').requestID, {});
  const fv = last().sent.filter(m => m.type === 'fetch_variable').map(m => m.data);
  assert(fv.length === 2, 'both clicks replayed after retry: ' + JSON.stringify(fv));
}
if (sc === 'unstable-reestablish') {
  for (let i = 0; i < 2; i++) {
    last().serverClose(1006); advance(31000); last().open();
    last().reply('geppetto_version', last().sent.find(m => m.type === 'geppetto_version').requestID, {});
    advance(1000);                                             // resumed, then dies within 30s
  }
  last().serverClose(1006);                                    // third drop straight after a recovery
  assert(!fails().includes('resync-failed'), 'three unstable recoveries do NOT request a reload');
  advance(31000); last().open();
  assert(last().sent.some(m => m.type === 'load_project_from_url'), 'fresh session re-established in place instead');
}
if (sc === 'heartbeat') {
  const beats = () => last().sent.filter(m => m.type === 'geppetto_version' && m.requestID.startsWith('c1-'));
  const before = beats().length;
  advance(250000);                                            // idle under the 300 s server cut-off
  const sent = beats().length - before;
  assert(sent === 4, 'idle socket carries one heartbeat a minute (' + sent + ' in 250 s)');
  const handled = []; H.GEPPETTO.MessageHandler.onMessage = m => handled.push(m.type);
  last().reply('geppetto_version', beats()[beats().length - 1].requestID, { geppetto_version: 'x' });
  assert(!handled.includes('geppetto_version'), 'heartbeat reply is not routed to the handlers');
  last().serverClose(1006); advance(31000); last().open();
  MS.send('fetch_variable', 'VFB_1');                        // user click while resuming
  const beatsWhileResuming = last().sent.filter(m => m.type === 'geppetto_version').length;
  advance(120000);
  assert(last().sent.filter(m => m.type === 'geppetto_version').length === beatsWhileResuming, 'no heartbeat while the session is unsettled');
  last().reply('project_loaded', undefined, {});
  advance(61000);
  assert(last().sent.filter(m => m.type === 'geppetto_version').length === beatsWhileResuming + 1, 'heartbeat resumes once the session is back');
  assert(!last().sent.some(m => m.type === 'geppetto_version' && m.requestID === undefined), 'every heartbeat carries a request id');
}
