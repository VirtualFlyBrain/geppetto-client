// Minimal harness to drive MessageSocket with a fake WebSocket and fake timers.
const path = require('path');
const SRC = process.env.MS_SRC || path.resolve(__dirname, '../../geppetto-client/js/communication/MessageSocket.js');
// --- fake timers ---
let now = 0; let timers = []; let tid = 0;
global.setTimeout = (fn, ms) => { timers.push({ id: ++tid, at: now + (ms || 0), fn }); return tid; };
global.clearTimeout = id => { timers = timers.filter(t => t.id !== id); };
function advance (ms) { const end = now + ms; while (true) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break; now = t.at; timers.shift(); t.fn(); } now = end; }
global.Date = class extends Date { static now () { return now; } };
// --- fake WebSocket ---
const sockets = [];
class FakeWS {
  constructor (url) { this.url = url; this.readyState = 0; this.sent = []; this.extensions = ''; sockets.push(this); }
  send (m) { this.sent.push(JSON.parse(m)); }
  close () { if (this.readyState === 3) return; this.readyState = 3; this.onclose && this.onclose({ code: 1006, reason: '' }); }
  open () { this.readyState = 1; this.onopen && this.onopen({}); }
  serverClose (code) { this.readyState = 3; this.onclose && this.onclose({ code, reason: '' }); }
  reply (type, requestID, data) { this.onmessage({ data: JSON.stringify({ type, requestID, data: JSON.stringify(data || {}) }) }); }
}
global.window = { WebSocket: FakeWS, location: { host: 'x', protocol: 'https:' }, addEventListener () {}, localStorage: { getItem () { return null; }, setItem () {}, removeItem () {} } };
global.document = { addEventListener () {}, hidden: false };
global.navigator = { onLine: true };
global.WebSocket = FakeWS;
global.GEPPETTO_CONFIGURATION = { contextPath: 'org.geppetto.frontend' };
// --- AMD shim ---
const mods = { pako: {}, 'file-saver': {}, './MessageReassembler': function () { return { processMessage: m => m }; } };
global.define = fn => { module._amd = fn(name => mods[name]); };
require(SRC);
const factory = module._amd;
const events = [];
const GEPPETTO = {
  Resources: { SocketStatus: { OPEN: 'open', CLOSE: 'close', RECONNECTING: 'reconnecting' }, WEBSOCKET_OPENED: 'o', WEBSOCKET_CLOSED: 'c', WEBSOCKET_CONNECTION_ERROR: 'e', WEBSOCKET_RECONNECTION: 'r', WEBSOCKET_NOT_SUPPORTED: 'n', SERVER_CONNECTION_ERROR: 's' },
  Events: { Websocket_disconnected: 'disconnected', Websocket_reconnecting: 'reconnecting', Websocket_session_lost: 'session_lost', Websocket_reconnected: 'reconnected' },
  CommandController: { log () {} }, ModalFactory: { infoDialog () {} }, ScriptRunner: { isScriptRunning: () => false },
  trigger (e, p) { events.push([e, p]); },
  MessageHandler: { onMessage (m) { if (m.type === 'project_loaded') GEPPETTO.MessageSocket.sessionReady(false); } },
  GlobalHandler: { onMessage (m) { if (m.type === 'reconnection_error') GEPPETTO.MessageSocket.resyncSession(); } }
};
factory(GEPPETTO);
const MS = GEPPETTO.MessageSocket;
console.log = () => {}; console.error = () => {};
module.exports = { GEPPETTO, MS, sockets, events, advance, FakeWS };
