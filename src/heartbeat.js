export function startHeartbeat(ws, { intervalMs = 20000, maxMissed = 2, status, onMissed } = {}) {
  let awaiting = 0;
  const onMessage = (data, isBinary) => {
    if (isBinary) return;
    try { if (JSON.parse(String(data)).type === 'pong') awaiting = 0; }
    catch { /* Ignore malformed frames. */ }
  };
  const timer = setInterval(() => {
    if (ws.readyState !== 1) return;
    if (awaiting === 1) onMissed?.();
    if (awaiting >= maxMissed) { ws.terminate(); return; }
    awaiting += 1;
    let extra = {};
    try { extra = status?.() ?? {}; } catch { extra = {}; }
    ws.send(JSON.stringify({ ...extra, type: 'ping' }));
  }, intervalMs);
  timer.unref?.();
  const stop = () => { clearInterval(timer); ws.off('message', onMessage); };
  ws.on('message', onMessage);
  ws.once('close', stop);
  ws.once('error', stop);
  return stop;
}

export function parseStreamDrainMs(value, warn = console.warn) {
  if (value === undefined || value === '') return 600000;
  const n = Number(value);
  if (/^\d+$/.test(String(value)) && Number.isSafeInteger(n) && n >= 1000 && n <= 3600000) return n;
  warn('invalid AGENT_MBB_STREAM_DRAIN_MS; using default');
  return 600000;
}

// One replacement attempt per active connection; a failed active socket returns to the outer backoff loop.
export function createHandoff({ register, open, drainMs = 30000, streamDrainMs = parseStreamDrainMs(process.env.AGENT_MBB_STREAM_DRAIN_MS), pendingMs = 15000 }) {
  let active, pending, stopped = false;
  const sockets = new Set();
  const timers = new Set();
  const registrations = new Set();
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  function later(fn, ms) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    timer.unref?.();
    return timer;
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    for (const controller of registrations) controller.abort();
    for (const socket of sockets) socket.close(1000, 'reconnect');
    complete();
  }
  function connect(id, replacement) {
    let welcomed = false;
    const socket = open(id, {
      ready() {
        if (welcomed || stopped || (replacement && pending !== socket)) return;
        welcomed = true;
        const old = active;
        active = socket;
        pending = undefined;
        if (old) {
          let expired = false, streamsExpired = false;
          const check = () => {
            if (stopped || !sockets.has(old)) return;
            if (streamsExpired) old.expireStreams?.();
            if (!old.busy()) old.close(1000, 'replaced');
          };
          const ordinaryTimer = later(() => {
            expired = true;
            old.expireOrdinary?.();
            if (!old.longBusy?.()) old.close(1000, 'replaced');
            else check();
          }, drainMs);
          const streamTimer = later(() => {
            streamsExpired = true;
            old.expireStreams?.();
            check();
          }, streamDrainMs);
          const cleanup = () => {
            clearTimeout(ordinaryTimer); clearTimeout(streamTimer);
            timers.delete(ordinaryTimer); timers.delete(streamTimer);
          };
          old.onDrainChange?.(() => {
            if (expired) old.expireOrdinary?.();
            check();
          });
          old.onDrainClose?.(cleanup);
          // Adapters without notifications use a cheap, unref'd fallback.
          if (!old.onDrainChange) {
            const poll = () => {
              if (stopped || !sockets.has(old) || old.readyState === 3) return;
              check();
              if (old.readyState !== 3) later(poll, 250);
            };
            later(poll, 250);
          }
          check();
        }
      },
      missed() { if (active === socket) replace(); },
      closed() {
        sockets.delete(socket);
        if (active === socket || (!replacement && !active)) stop();
        if (pending === socket) pending = undefined;
      },
    });
    sockets.add(socket);
    if (replacement) pending = socket;
    later(() => { if (!welcomed && sockets.has(socket)) socket.close(1000, 'welcome timeout'); }, pendingMs);
    return socket;
  }
  async function replace() {
    if (stopped || pending) return;
    const marker = {};
    pending = marker;
    const controller = new AbortController();
    registrations.add(controller);
    const timeout = later(() => { controller.abort(); if (pending === marker) pending = undefined; }, pendingMs);
    try {
      const reg = await register({ signal: controller.signal });
      if (!stopped && pending === marker) connect(reg.id, true);
    } catch { if (pending === marker) pending = undefined; }
    finally { clearTimeout(timeout); timers.delete(timeout); registrations.delete(controller); }
  }
  return { start(id) { connect(id, false); return done; }, replace, stop };
}
