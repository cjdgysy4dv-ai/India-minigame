// India City Rush - authoritative real-time server (Express + Socket.io)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const srv = http.createServer(app);
const io = new Server(srv, { pingInterval: 10000, pingTimeout: 20000 });
app.use(express.static('public'));
app.get('/health', (_, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
const DURATION = 300;   // game length, seconds
const TICK = 5;         // passive decay interval, seconds
const EVENT_TIME = 12;  // seconds to answer an emergency

const clamp = (v) => Math.max(0, Math.min(100, v));
const rnd = (a, b) => a + Math.random() * (b - a);

// Always-available purchases. fx.money is the cost (negative) or gain.
const ACTIONS = {
  solar:  { label: 'Solar Grid',          fx: { money: -300, air: 20 } },
  rain:   { label: 'Rainwater Harvesting', fx: { money: -200, water: 18 } },
  school: { label: 'Build Schools',        fx: { money: -250, edu: 15 } },
  metro:  { label: 'Metro Line',           fx: { money: -350, infra: 20, air: 6 } },
  fund:   { label: 'Equality Fund',        fx: { money: -200, eq: 15, edu: 3 } },
  tax:    { label: 'Tax Drive',            fx: { money: 250, eq: -8, infra: -3 } },
};

// Emergencies. "ignore" is applied if the timer runs out.
const EVENTS = [
  { id: 'smog', title: 'Severe Smog in New Delhi!', desc: 'AQI is off the charts. Schools and hospitals are filling up.',
    ignore: { air: -25, edu: -5 },
    options: [{ label: 'Deploy Solar Grid', fx: { money: -300, air: 20 } }, { label: 'Odd-even traffic ban', fx: { money: -100, air: 10, infra: -5 } }] },
  { id: 'water', title: 'Monsoon Water Crisis!', desc: 'Reservoirs are empty before the rains. Tankers queue for hours.',
    ignore: { water: -25, eq: -5 },
    options: [{ label: 'Tanker convoys', fx: { money: -200, water: 20 } }, { label: 'Harvesting mandate', fx: { money: -120, water: 12, infra: -3 } }] },
  { id: 'school', title: 'School Shortage Emergency!', desc: 'Classes of 80 children. Enrolment doubled in one year.',
    ignore: { edu: -20, eq: -8 },
    options: [{ label: 'Build new schools', fx: { money: -300, edu: 22 } }, { label: 'Double-shift classes', fx: { money: -80, edu: 10, eq: -4 } }] },
  { id: 'infra', title: 'Mumbai Infrastructure Overload!', desc: 'Trains packed, roads flooded, power cuts across the city.',
    ignore: { infra: -25, air: -5 },
    options: [{ label: 'Metro expansion', fx: { money: -350, infra: 25 } }, { label: 'Rush flyovers', fx: { money: -150, infra: 12, air: -6 } }, { label: 'Patch-up crews', fx: { money: -60, infra: 5 } }] },
  { id: 'drought', title: 'Rajasthan Drought!', desc: 'Farmers migrate to the city. Wells run dry.',
    ignore: { water: -20, eq: -10 },
    options: [{ label: 'Drip-irrigation subsidy', fx: { money: -250, water: 15, eq: 8 } }, { label: 'Deep borewells', fx: { money: -80, water: 10, infra: -4 } }] },
  { id: 'gender', title: 'Rural Girls Leave School!', desc: 'No toilets, long walks, fees. Dropout rate is rising.',
    ignore: { eq: -20, edu: -5 },
    options: [{ label: 'Scholarship programme', fx: { money: -250, eq: 20, edu: 5 } }, { label: 'Awareness campaign', fx: { money: -100, eq: 10 } }] },
  { id: 'factory', title: 'Gujarat Factory Boom!', desc: 'New plants bring jobs and tax revenue, and chimney smoke.',
    ignore: { air: -10, money: 100 },
    options: [{ label: 'Allow, collect taxes', fx: { money: 300, air: -15 } }, { label: 'Enforce green norms', fx: { money: -100, air: 5, eq: 3 } }] },
];

const rooms = {};

function makeCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => L[Math.floor(Math.random() * L.length)]).join(''); } while (rooms[c]);
  return c;
}

const newCity = (name) => ({ name, sock: null, money: 1000, pop: 10000, air: 80, water: 80, edu: 50, eq: 50, infra: 60, event: null, nextEvent: 0 });

function apply(c, fx) {
  for (const k in fx) c[k] = k === 'money' ? Math.max(0, c.money + fx[k]) : clamp(c[k] + fx[k]);
}

// Composite score (0-100). Money is normalised: $1000 or more counts as 100.
function score(c) {
  const money = Math.min(100, c.money / 10);
  return +(c.air * 0.2 + c.water * 0.2 + c.edu * 0.2 + c.eq * 0.15 + c.infra * 0.15 + money * 0.1).toFixed(1);
}

// Passive decay every TICK seconds. Load grows with sqrt of population ratio.
function tick(c) {
  c.pop = Math.round(c.pop * 1.05);
  const r = Math.sqrt(c.pop / 10000);
  c.water = clamp(c.water - 0.6 * r);
  c.infra = clamp(c.infra - 0.5 * r);
  c.air = clamp(c.air - 0.35 * r * (1 + (100 - c.infra) / 100));
  c.edu = clamp(c.edu - 0.2 * r);
  c.eq = clamp(c.eq - 0.1 * r);
  c.money += Math.round(c.pop / 1000); // tax income
}

const pub = (c, id) => ({
  id, name: c.name, connected: !!c.sock, score: score(c),
  money: Math.round(c.money), pop: c.pop,
  air: +c.air.toFixed(1), water: +c.water.toFixed(1), edu: +c.edu.toFixed(1),
  eq: +c.eq.toFixed(1), infra: +c.infra.toFixed(1),
  ev: c.event ? c.event.def.title : null,
  evId: c.event ? c.event.def.id : null,
});

const toast = (c, msg) => c.sock && io.to(c.sock).emit('toast', msg);

function trigger(c, now) {
  const def = EVENTS[Math.floor(Math.random() * EVENTS.length)];
  c.event = { def, deadline: now + EVENT_TIME * 1000 };
}

function resolve(c, idx, now) {
  const ev = c.event;
  if (!ev) return false;
  if (idx === null) {
    apply(c, ev.def.ignore);
    toast(c, 'Too slow! ' + ev.def.title.replace('!', '') + ' hit your city.');
  } else {
    const o = ev.def.options[idx];
    if (!o || c.money + (o.fx.money || 0) < 0) return false;
    apply(c, o.fx);
    toast(c, o.label + ' done.');
  }
  c.event = null;
  c.nextEvent = now + rnd(7000, 15000);
  return true;
}

function evPayload(c, now) {
  if (!c.event) return null;
  const d = c.event.def;
  return { id: d.id, title: d.title, desc: d.desc, ms: Math.max(0, c.event.deadline - now),
    options: d.options.map((o) => ({ label: o.label, cost: -(o.fx.money || 0), fx: o.fx })) };
}

function broadcast(r, now) {
  const board = [...r.players].map(([id, c]) => pub(c, id)).sort((a, b) => b.score - a.score);
  const left = r.phase === 'running' ? Math.max(0, Math.round((r.end - now) / 1000)) : r.phase === 'ended' ? 0 : DURATION;
  io.to('h' + r.code).emit('board', { code: r.code, phase: r.phase, left, board });
  board.forEach((b, i) => {
    const c = r.players.get(b.id);
    if (c.sock) io.to(c.sock).emit('me', { phase: r.phase, left, me: b, rank: i + 1, n: board.length, event: evPayload(c, now) });
  });
}

// One global 1-second loop drives every room (no per-player timers).
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(rooms)) {
    const r = rooms[k];
    if (now - r.created > 4 * 3600e3) { delete rooms[k]; continue; }
    if (r.phase === 'running') {
      while (now - r.lastTick >= TICK * 1000) {
        r.lastTick += TICK * 1000;
        r.players.forEach(tick);
      }
      r.players.forEach((c) => {
        if (c.event && now >= c.event.deadline) resolve(c, null, now);
        else if (!c.event && now >= c.nextEvent) trigger(c, now);
      });
      if (now >= r.end) r.phase = 'ended';
    }
    broadcast(r, now);
  }
}, 1000);

io.on('connection', (socket) => {
  socket.on('host:create', ({ code } = {}, cb) => {
    let r = code && rooms[code];
    if (!r) { const c = makeCode(); r = rooms[c] = { code: c, phase: 'lobby', players: new Map(), created: Date.now(), lastTick: 0, end: 0 }; }
    socket.join('h' + r.code);
    socket.data.host = r.code;
    cb && cb({ code: r.code });
    broadcast(r, Date.now());
  });

  socket.on('host:start', () => {
    const r = rooms[socket.data.host];
    if (!r || r.phase !== 'lobby') return;
    const now = Date.now();
    r.phase = 'running'; r.end = now + DURATION * 1000; r.lastTick = now;
    r.players.forEach((c) => { c.nextEvent = now + rnd(4000, 10000); });
    broadcast(r, now);
  });

  socket.on('player:join', ({ code, name } = {}, cb) => {
    code = String(code || '').toUpperCase().trim();
    name = String(name || '').trim().slice(0, 16);
    const r = rooms[code];
    if (!r) return cb({ error: 'Room not found. Check the 4-letter code.' });
    if (!name) return cb({ error: 'Enter a city name.' });
    const id = name.toLowerCase();
    let c = r.players.get(id);
    if (c && c.sock && c.sock !== socket.id && io.sockets.sockets.has(c.sock)) return cb({ error: 'That name is taken. Pick another.' });
    if (!c) { c = newCity(name); if (r.phase === 'running') c.nextEvent = Date.now() + rnd(4000, 10000); r.players.set(id, c); }
    c.sock = socket.id;
    socket.data.code = code; socket.data.pid = id;
    cb({ ok: true, actions: Object.entries(ACTIONS).map(([key, a]) => ({ key, label: a.label, cost: -(a.fx.money || 0), fx: a.fx })) });
    broadcast(r, Date.now());
  });

  const ctx = () => {
    const r = rooms[socket.data.code];
    const c = r && r.players.get(socket.data.pid);
    return r && c && r.phase === 'running' ? { r, c } : null;
  };

  socket.on('player:action', (key) => {
    const x = ctx(); const a = ACTIONS[key];
    if (!x || !a || x.c.money + a.fx.money < 0) return;
    apply(x.c, a.fx);
    toast(x.c, a.label + ' done.');
    broadcast(x.r, Date.now());
  });

  socket.on('player:choose', (idx) => {
    const x = ctx();
    if (!x) return;
    resolve(x.c, Number(idx), Date.now());
    broadcast(x.r, Date.now());
  });

  socket.on('disconnect', () => {
    const r = rooms[socket.data.code];
    const c = r && r.players.get(socket.data.pid);
    if (c && c.sock === socket.id) c.sock = null;
  });
});

srv.listen(PORT, () => console.log('India City Rush running on port ' + PORT));
