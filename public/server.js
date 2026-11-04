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
const DURATION = 300; // game length, seconds
const TICK = 5;       // population / passive pressure interval, seconds

// ==== GAME CORE START (pure rules - tweak the numbers in BD to rebalance) ====
const clamp = (v) => Math.max(0, Math.min(100, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, f) => a + (b - a) * f;
const MAXLV = 4;

// Every building: period = seconds between automatic effects, fx[level-1] = effects applied each period,
// cost[level-1] = price to go from that level to the next, cap[level-1] = people served (housing, schools, jobs).
const BD = {
  apt: { name: 'Apartments', period: 12, cost: [160, 390, 910], cap: [14000, 35000, 80000, 200000],
            fx: [{ money: 25, air: -0.6, water: -1.5, eq: 0.5 }, { money: 60, air: -0.9, water: -2.5, eq: 1 }, { money: 130, air: -1.2, water: -4, eq: 1.5 }, { money: 260, air: -1.8, water: -6, eq: 2 }] },
  office: { name: 'Business Park', period: 12, cost: [200, 460, 1040], cap: [10000, 28000, 65000, 200000],
            fx: [{ money: 60, air: -1.2, infra: -0.9 }, { money: 140, air: -1.8, infra: -1.5 }, { money: 300, air: -2.4, infra: -2.1 }, { money: 550, air: -3.6, infra: -3 }] },
  school: { name: 'School', period: 8, cost: [130, 330, 780], cap: [12000, 30000, 70000, 200000],
            fx: [{ money: -12, edu: 2, eq: 1 }, { money: -20, edu: 3.5, eq: 1.5 }, { money: -32, edu: 5, eq: 2 }, { money: -50, edu: 7, eq: 3 }] },
  tax: { name: 'Tax Office', period: 25, cost: [160, 390, 910],
            fx: [{ money: 150, infra: -3.6, air: -6 }, { money: 300, infra: -4.8, air: -7.8 }, { money: 520, infra: -6, air: -9.6 }, { money: 850, infra: -7.8, air: -12 }] },
  solar: { name: 'Solar Farm', period: 10, cost: [130, 290, 650],
            fx: [{ money: -8, air: 2.5 }, { money: -12, air: 4.5 }, { money: -18, air: 7 }, { money: -26, air: 10 }] },
  water: { name: 'Water Plant', period: 10, cost: [100, 260, 590],
            fx: [{ money: -8, water: 3 }, { money: -12, water: 5.5 }, { money: -18, water: 8.5 }, { money: -26, water: 12 }] },
  metro: { name: 'Metro', period: 15, cost: [160, 390, 850],
            fx: [{ money: -15, infra: 4, air: 0.5 }, { money: -25, infra: 7, air: 1 }, { money: -40, infra: 11, air: 1.5 }, { money: -60, infra: 16, air: 2 }] },
};
const KEYS = Object.keys(BD);

const newCity = (name) => ({ name, sock: null, money: 1000, pop: 10000, air: 80, water: 80, edu: 50, eq: 50, infra: 60,
  lv: Object.fromEntries(KEYS.map((k) => [k, 1])), next: {}, event: null, nextEvent: 0 });

function apply(c, fx) {
  for (const k in fx) {
    if (k === 'money') c.money = Math.max(0, c.money + fx[k]);
    else if (k === 'pop') c.pop = Math.max(1000, Math.round(c.pop * (1 + fx[k] / 100)));
    else c[k] = clamp(c[k] + fx[k]);
  }
}
const cap = (c, k) => BD[k].cap[c.lv[k] - 1];
// overcrowding (0 = fine, 2 = people are 3x the capacity) for housing, schools and jobs
function over(c) { const o = {}; for (const k of KEYS) if (BD[k].cap) o[k] = Math.min(2, Math.max(0, c.pop / cap(c, k) - 1)); return o; }

// Composite score (0-100). Money is normalised: $1000 or more counts as 100.
function score(c) {
  const money = Math.min(100, c.money / 10);
  return +(c.air * 0.2 + c.water * 0.2 + c.edu * 0.2 + c.eq * 0.15 + c.infra * 0.15 + money * 0.1).toFixed(1);
}

// Passive pressure every TICK seconds: +5% population, load grows with sqrt of the population ratio,
// and overcrowded housing / schools / jobs make things worse. f = 0 (start) -> 1 (end) ramps difficulty.
function tick(c, f) {
  const dm = 0.7 + 0.6 * f;
  c.pop = Math.round(c.pop * 1.05);
  const r = Math.sqrt(c.pop / 10000), o = over(c);
  c.water = clamp(c.water - 0.5 * r * dm);
  c.infra = clamp(c.infra - (0.4 * r + 1.2 * o.apt) * dm);
  c.air = clamp(c.air - 0.3 * r * (1 + (100 - c.infra) / 100) * dm);
  c.edu = clamp(c.edu - (0.1 * r + 2.5 * o.school) * dm);
  c.eq = clamp(c.eq - (0.05 * r + 1.5 * o.apt + 1 * o.office) * dm);
  c.money += Math.round((c.pop / 1000) * (1 - 0.5 * Math.min(1, o.office))); // unemployment cuts tax income
}

function upgrade(c, k) {
  const lv = c.lv[k];
  if (!BD[k] || lv >= MAXLV) return null;
  const cost = BD[k].cost[lv - 1];
  if (c.money < cost) return null;
  c.money -= cost; c.lv[k]++;
  return cost;
}
// ==== GAME CORE END ====

const scaled = (fx, k) => { const o = {}; for (const key in fx) o[key] = key === 'money' ? fx[key] : Math.round(fx[key] * k); return o; };
const frac = (r, t) => (r.phase === 'lobby' ? 0 : Math.max(0, Math.min(1, (t - r.start) / (DURATION * 1000))));

// Emergencies are rarer now (and natural disasters are low-weight): demographics are the main pressure.
const EVENTS = [
  { id: 'migration', w: 2, title: 'Migration Wave Hits the City!', desc: 'Thousands arrive every day looking for work and a roof.',
    ignore: { pop: 12, eq: -8, infra: -4 },
    options: [{ label: 'Open job fairs', fx: { money: -150, eq: 6, pop: 8 } }, { label: 'Set entry quotas', fx: { money: -80, eq: -6, pop: 3 } }] },
  { id: 'fire', w: 1.5, title: 'Slum Fire!', desc: 'Dense, overcrowded housing goes up in flames.',
    ignore: { eq: -15, infra: -8, pop: -3 },
    options: [{ label: 'Fire brigades and shelters', fx: { money: -250, eq: 6, infra: -2 } }, { label: 'Clear and rebuild', fx: { money: -120, eq: -3, infra: 4 } }] },
  { id: 'school', w: 1.5, title: 'School Shortage Emergency!', desc: 'Classes of 80 children. Enrolment doubled in one year.',
    ignore: { edu: -20, eq: -8 },
    options: [{ label: 'Build new schools', fx: { money: -300, edu: 22 } }, { label: 'Double-shift classes', fx: { money: -80, edu: 10, eq: -4 } }] },
  { id: 'infra', w: 1.5, title: 'Mumbai Infrastructure Overload!', desc: 'Trains packed, roads flooded, power cuts across the city.',
    ignore: { infra: -25, air: -5 },
    options: [{ label: 'Metro expansion', fx: { money: -350, infra: 25 } }, { label: 'Rush flyovers', fx: { money: -150, infra: 12, air: -6 } }, { label: 'Patch-up crews', fx: { money: -60, infra: 5 } }] },
  { id: 'gender', w: 1, title: 'Rural Girls Leave School!', desc: 'No toilets, long walks, fees. Dropout rate is rising.',
    ignore: { eq: -20, edu: -5 },
    options: [{ label: 'Scholarship programme', fx: { money: -250, eq: 20, edu: 5 } }, { label: 'Awareness campaign', fx: { money: -100, eq: 10 } }] },
  { id: 'factory', w: 1, title: 'Gujarat Factory Boom!', desc: 'New plants bring jobs and tax revenue, and chimney smoke.',
    ignore: { air: -10, money: 100 },
    options: [{ label: 'Allow, collect taxes', fx: { money: 300, air: -15 } }, { label: 'Enforce green norms', fx: { money: -100, air: 5, eq: 3 } }] },
  { id: 'smog', w: 0.5, title: 'Severe Smog in New Delhi!', desc: 'AQI is off the charts. Schools and hospitals are filling up.',
    ignore: { air: -25, edu: -5 },
    options: [{ label: 'Deploy Solar Grid', fx: { money: -300, air: 20 } }, { label: 'Odd-even traffic ban', fx: { money: -100, air: 10, infra: -5 } }] },
  { id: 'water', w: 0.5, title: 'Monsoon Water Crisis!', desc: 'Reservoirs are empty before the rains. Tankers queue for hours.',
    ignore: { water: -25, eq: -5 },
    options: [{ label: 'Tanker convoys', fx: { money: -200, water: 20 } }, { label: 'Harvesting mandate', fx: { money: -120, water: 12, infra: -3 } }] },
];
const pickEvent = () => { let x = Math.random() * EVENTS.reduce((s, e) => s + e.w, 0); for (const e of EVENTS) if ((x -= e.w) <= 0) return e; return EVENTS[0]; };

const rooms = {};
function makeCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => L[Math.floor(Math.random() * L.length)]).join(''); } while (rooms[c]);
  return c;
}

const pub = (c, id) => ({
  id, name: c.name, connected: !!c.sock, score: score(c), lv: c.lv,
  money: Math.round(c.money), pop: c.pop,
  air: +c.air.toFixed(1), water: +c.water.toFixed(1), edu: +c.edu.toFixed(1),
  eq: +c.eq.toFixed(1), infra: +c.infra.toFixed(1),
  ev: c.event ? c.event.def.title : null, evId: c.event ? c.event.def.id : null,
});
const emit = (c, ev, data) => c.sock && io.to(c.sock).emit(ev, data);
const toast = (c, msg) => emit(c, 'toast', msg);
const arm = (c, now) => KEYS.forEach((k) => { c.next[k] = now + rnd(0.4, 1) * BD[k].period * 1000; });

function trigger(c, now, f) {
  const total = lerp(14, 10, f) * 1000;
  c.event = { def: pickEvent(), deadline: now + total, total };
}

function resolve(c, idx, now, f) {
  const ev = c.event;
  if (!ev) return false;
  let fx;
  if (idx === null) {
    fx = scaled(ev.def.ignore, 0.7 + 0.8 * f);
    toast(c, 'Too slow! ' + ev.def.title.replace('!', '') + ' hit your city.');
  } else {
    const o = ev.def.options[idx];
    if (!o) return false;
    fx = o.fx;
    if (c.money + (fx.money || 0) < 0) return false;
    toast(c, o.label + ' done.');
  }
  apply(c, fx);
  emit(c, 'impact', fx);
  c.event = null;
  c.nextEvent = now + rnd(lerp(18000, 9000, f), lerp(30000, 15000, f)); // rarer than before
  return true;
}

function evPayload(c, now) {
  if (!c.event) return null;
  const d = c.event.def;
  return { id: d.id, title: d.title, desc: d.desc, ms: Math.max(0, c.event.deadline - now), total: c.event.total,
    options: d.options.map((o) => ({ label: o.label, cost: -(o.fx.money || 0), fx: o.fx })) };
}

function broadcast(r, now) {
  const board = [...r.players].map(([id, c]) => pub(c, id)).sort((a, b) => b.score - a.score);
  const left = r.phase === 'running' ? Math.max(0, Math.round((r.end - now) / 1000)) : r.phase === 'ended' ? 0 : DURATION;
  io.to('h' + r.code).emit('board', { code: r.code, phase: r.phase, left, board });
  const f = frac(r, now);
  board.forEach((b, i) => {
    const c = r.players.get(b.id);
    if (!c.sock) return;
    const nx = {};
    KEYS.forEach((k) => { nx[k] = c.next[k] ? Math.max(0, c.next[k] - now) : BD[k].period * 1000; });
    io.to(c.sock).emit('me', { phase: r.phase, left, me: b, rank: i + 1, n: board.length, event: evPayload(c, now), nx, lvl: Math.min(3, Math.floor(f * 3) + 1) });
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
        r.players.forEach((c) => tick(c, frac(r, r.lastTick)));
      }
      const f = frac(r, now);
      r.players.forEach((c) => {
        for (const b of KEYS) { // automatic building clocks
          while (now >= c.next[b]) {
            const fx = BD[b].fx[c.lv[b] - 1];
            apply(c, fx); emit(c, 'bt', { k: b, fx });
            c.next[b] += BD[b].period * 1000;
          }
        }
        if (c.event && now >= c.event.deadline) resolve(c, null, now, f);
        else if (!c.event && now >= c.nextEvent) trigger(c, now, f);
      });
      if (now >= r.end) r.phase = 'ended';
    }
    broadcast(r, now);
  }
}, 1000);

io.on('connection', (socket) => {
  socket.on('host:create', ({ code } = {}, cb) => {
    let r = code && rooms[code];
    if (!r) { const c = makeCode(); r = rooms[c] = { code: c, phase: 'lobby', players: new Map(), created: Date.now(), lastTick: 0, start: 0, end: 0 }; }
    socket.join('h' + r.code);
    socket.data.host = r.code;
    cb && cb({ code: r.code, bd: BD });
    broadcast(r, Date.now());
  });

  socket.on('host:start', () => {
    const r = rooms[socket.data.host];
    if (!r || r.phase !== 'lobby') return;
    const now = Date.now();
    r.phase = 'running'; r.start = now; r.end = now + DURATION * 1000; r.lastTick = now;
    r.players.forEach((c) => { arm(c, now); c.nextEvent = now + rnd(15000, 25000); });
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
    if (!c) { c = newCity(name); if (r.phase === 'running') { arm(c, Date.now()); c.nextEvent = Date.now() + rnd(15000, 25000); } r.players.set(id, c); }
    c.sock = socket.id;
    socket.data.code = code; socket.data.pid = id;
    cb({ ok: true, bd: BD });
    broadcast(r, Date.now());
  });

  const ctx = () => {
    const r = rooms[socket.data.code];
    const c = r && r.players.get(socket.data.pid);
    return r && c && r.phase === 'running' ? { r, c } : null;
  };

  socket.on('player:upgrade', (key) => {
    const x = ctx();
    if (!x) return;
    const cost = upgrade(x.c, key);
    if (cost === null) return;
    socket.emit('impact', { money: -cost });
    toast(x.c, BD[key].name + ' upgraded to level ' + x.c.lv[key]);
    broadcast(x.r, Date.now());
  });

  socket.on('player:choose', (idx) => {
    const x = ctx();
    if (!x) return;
    resolve(x.c, Number(idx), Date.now(), frac(x.r, Date.now()));
    broadcast(x.r, Date.now());
  });

  socket.on('disconnect', () => {
    const r = rooms[socket.data.code];
    const c = r && r.players.get(socket.data.pid);
    if (c && c.sock === socket.id) c.sock = null;
  });
});

srv.listen(PORT, () => console.log('India City Rush running on port ' + PORT));
