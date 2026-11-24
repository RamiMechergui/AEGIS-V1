// playlist-queue.js — the sequential download queue behind "Download Full
// Playlist". Electron-free on purpose (same discipline as shield.js): main.js
// injects the real yt-dlp runner, the unit suite (test-playlist-queue.js)
// drives it with a fake one. Everything about ORDER and CONCURRENCY lives
// here, in one small state machine:
//
//   * ONE single worker (the pump loop) ever exists. pump() refuses to start
//     a second one, so two videos of the same playlist can NEVER download at
//     the same time — concurrency limit is 1, by construction.
//   * The worker AWAITS the current video's terminal state (completed,
//     failed, skipped or canceled) before it looks at the next waiting item.
//     The next download starts only after the previous one finished.
//   * pause() only stops the loop from picking the NEXT item — the video
//     that is already downloading finishes normally (its bytes are never
//     thrown away), and resume() continues exactly where the queue stopped.
//   * cancel() marks every not-started item, kills the active job through
//     the injected cancelCurrent() and the loop exits on its next phase
//     check. Nothing can restart afterwards until a new queue is built.
//   * A failed video never blocks the queue: the error is recorded on the
//     item for the UI and the loop simply moves on to the next one.
//   * Duplicate video ids are dropped at enqueue time (first occurrence
//     keeps its position) and the array order IS the playlist order.
//
// All mutations happen synchronously (JS single thread); the only awaits are
// inside the one worker loop, so there are no races to lose.
'use strict';

const STATUS = {
  WAITING: 'waiting',
  DOWNLOADING: 'downloading',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  CANCELED: 'canceled',
  REMOVED: 'removed',
};

const VID_RE = /^[A-Za-z0-9_-]{11}$/;

function clampPct(n) {
  n = Number(n);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function createPlaylistQueue(o) {
  o = o || {};
  const startVideo = o.startVideo;                       // async (item) => {ok, error?, canceled?, size?, savePath?}
  const cancelCurrent = o.cancelCurrent || function () {}; // kills the active yt-dlp job (if any)
  const emit = o.emit || function () {};                  // ({type:'snapshot'|'progress', ...})
  const progressMs = o.progressMs == null ? 250 : o.progressMs; // min gap between progress events
  const now = o.now || Date;

  if (typeof startVideo !== 'function') throw new Error('createPlaylistQueue: startVideo is required');

  let items = [];
  let phase = 'idle';   // idle | running | paused | done | canceled
  let current = null;   // the item being downloaded right now (or null)
  let worker = null;    // THE single worker promise (null when no loop is in flight)
  let lastProgressAt = 0;
  let nextId = 1;

  function totals() {
    const t = { total: items.length, waiting: 0, downloading: 0, completed: 0, failed: 0,
                skipped: 0, canceled: 0, removed: 0, remaining: 0 };
    for (const it of items) {
      if (t[it.status] != null) t[it.status]++;
    }
    t.remaining = t.waiting + t.downloading;
    return t;
  }

  function itemView(it) {
    return { id: it.id, index: it.index, vid: it.vid, url: it.url, title: it.title,
             thumb: it.thumb, duration: it.duration, status: it.status, pct: it.pct,
             speed: it.speed, received: it.received, total: it.total, error: it.error,
             savePath: it.savePath || '' };
  }

  function snapshot() {
    return {
      phase: phase,
      current: current ? { id: current.id, index: current.index, title: current.title, url: current.url } : null,
      totals: totals(),
      items: items.map(itemView),
    };
  }

  function emitSnapshot() {
    try { emit({ type: 'snapshot', state: snapshot() }); } catch (e) {}
  }

  function emitProgress(it) {
    const t = now.now();
    if (t - lastProgressAt < progressMs) return; // throttled; the terminal snapshot is never throttled
    lastProgressAt = t;
    try {
      emit({ type: 'progress', phase: phase, totals: totals(),
             item: { id: it.id, status: it.status, pct: it.pct, speed: it.speed,
                     received: it.received, total: it.total } });
    } catch (e) {}
  }

  function nextWaiting() {
    for (const it of items) if (it.status === STATUS.WAITING) return it;
    return null;
  }

  // ── The one and only worker ────────────────────────────────────────────
  // Returns the worker promise (or null when the queue is not running).
  // The `worker` slot is claimed BEFORE the loop body can await anything, so
  // a re-entrant pump() call always sees a non-null worker and bails out —
  // two loops can never run, even if an emit callback calls back into us.
  function pump() {
    if (worker) return worker;          // ← single-worker invariant
    if (phase !== 'running') return null;
    let settle;
    const done = new Promise((res) => { settle = res; });
    worker = done;
    (async () => {
      try {
        while (phase === 'running') {
          const item = nextWaiting();
          // Terminal snapshot: the UI must learn that the queue FINISHED
          // (phase 'done' → "Finished" chip, buttons disabled, New selection
          // offered). Without this emit the last event still says "running"
          // and the window waits forever on a queue that is already over.
          if (!item) { phase = 'done'; emitSnapshot(); break; }
          current = item;
          item.status = STATUS.DOWNLOADING;
          item.pct = 0;
          item.speed = 0;
          item.received = 0;
          item.error = '';
          emitSnapshot();
          let res = null;
          try {
            res = (await startVideo(item)) || {};
          } catch (err) {
            res = { ok: false, error: (err && err.message) || 'Download failed' };
          }
          current = null;
          // Terminal classification. A download that succeeded despite a
          // skip racing with completion stays completed — the file exists.
          if (res.ok) {
            item.status = STATUS.COMPLETED;
            item.pct = 100;
            if (res.size) item.total = res.size;
            if (res.savePath) item.savePath = res.savePath;
          } else if (phase === 'canceled') {
            item.status = STATUS.CANCELED;
          } else if (item.skipRequested) {
            item.status = STATUS.SKIPPED;
          } else {
            item.status = STATUS.FAILED;
            item.error = res.error || 'Download failed';
          }
          item.speed = 0;
          emitSnapshot();
        }
      } finally {
        // Paused while the LAST video was in flight: when it finished there
        // was nothing left to pick up, so the queue is done — not "paused
        // forever" with 0 remaining. (A pause with videos still waiting keeps
        // its phase; resume() picks them up.)
        if (phase === 'paused' && !nextWaiting()) { phase = 'done'; emitSnapshot(); }
        worker = null;
        settle();
      }
    })();
    return done;
  }

  function resumeLoopIfPossible() {
    if (phase === 'running') pump();
  }

  return {
    STATUS: STATUS,

    // Validates + appends the selected videos, keeping playlist order.
    // Called once, before start(). Returns {ok, added, duplicates, invalid}.
    enqueue(list) {
      if (phase !== 'idle') return { ok: false, error: 'This playlist queue has already started' };
      const seen = new Set();
      let added = 0, duplicates = 0, invalid = 0;
      for (const raw of (Array.isArray(list) ? list : [])) {
        const vid = String((raw && (raw.vid || raw.id)) || '').trim();
        const url = String((raw && raw.url) || '').trim();
        if (!VID_RE.test(vid) || !/^https?:\/\/\S+$/i.test(url)) { invalid++; continue; }
        if (seen.has(vid)) { duplicates++; continue; }  // duplicate URLs are dropped, never double-downloaded
        seen.add(vid);
        items.push({
          id: nextId++,
          index: items.length,               // position in the queue = playlist order
          vid: vid,
          url: url,
          title: String((raw && raw.title) || vid),
          thumb: String((raw && (raw.thumb || raw.thumbnail)) || ''),
          duration: Number(raw && raw.duration) || 0,
          status: STATUS.WAITING,
          pct: 0, speed: 0, received: 0, total: 0,
          error: '', savePath: '', skipRequested: false,
        });
        added++;
      }
      return { ok: true, added: added, duplicates: duplicates, invalid: invalid };
    },

    // Kicks the single worker off. Only valid once, from 'idle'.
    start() {
      if (phase !== 'idle') return false;
      if (!nextWaiting()) return false;
      phase = 'running';
      emitSnapshot();
      pump();
      return true;
    },

    // The video that is already downloading keeps going; nothing NEW starts.
    pause() {
      if (phase !== 'running') return false;
      phase = 'paused';
      emitSnapshot();
      return true;
    },

    resume() {
      if (phase !== 'paused') return false;
      phase = 'running';
      emitSnapshot();
      pump(); // no-op when the worker is still finishing the previous item
      return true;
    },

    // Kills the active job (through cancelCurrent) and marks everything that
    // has not started as canceled. The loop exits on its next phase check —
    // no further download can be triggered by anything below.
    cancel() {
      if (phase !== 'running' && phase !== 'paused') return false;
      phase = 'canceled';
      for (const it of items) {
        if (it.status === STATUS.WAITING) { it.status = STATUS.CANCELED; it.error = ''; }
      }
      if (current) { try { cancelCurrent(); } catch (e) {} }
      emitSnapshot();
      return true;
    },

    // Skips the video that is downloading right now (where supported): the
    // active job is killed and the queue moves on to the next item.
    skip() {
      if (!current || current.status !== STATUS.DOWNLOADING || phase === 'canceled') return false;
      current.skipRequested = true;
      try { cancelCurrent(); } catch (e) {}
      return true;
    },

    // Removes a video that has NOT started downloading yet.
    remove(id) {
      id = Number(id);
      const it = items.find((x) => x.id === id);
      if (!it || it.status !== STATUS.WAITING) return false;
      it.status = STATUS.REMOVED;
      emitSnapshot();
      return true;
    },

    // Puts a FAILED video back into the queue, at its original position.
    retry(id) {
      id = Number(id);
      const it = items.find((x) => x.id === id);
      if (!it || it.status !== STATUS.FAILED) return false;
      it.status = STATUS.WAITING;
      it.pct = 0; it.speed = 0; it.received = 0; it.error = '';
      if (phase === 'done') phase = 'running';
      emitSnapshot();
      resumeLoopIfPossible();
      return true;
    },

    // Retry every failed video at once (original playlist order preserved).
    retryAll() {
      let n = 0;
      for (const it of items) {
        if (it.status === STATUS.FAILED) {
          it.status = STATUS.WAITING;
          it.pct = 0; it.speed = 0; it.received = 0; it.error = '';
          n++;
        }
      }
      if (!n) return false;
      if (phase === 'done') phase = 'running';
      emitSnapshot();
      resumeLoopIfPossible();
      return true;
    },

    // Per-video progress from the download engine (already throttled).
    onItemProgress(it, p) {
      if (!it || !p || it.status !== STATUS.DOWNLOADING) return;
      if (p.pct != null) it.pct = clampPct(p.pct);
      if (p.speed) it.speed = Number(p.speed) || 0;
      if (p.received != null) it.received = Number(p.received) || 0;
      if (p.total) it.total = Number(p.total) || it.total;
      emitProgress(it);
    },

    snapshot: snapshot,
    phase: function () { return phase; },
    current: function () { return current; },
    // True while a queue exists that still owns the "one download at a time"
    // slot (running or paused) — main uses it to refuse a second queue.
    isBusy: function () { return phase === 'running' || phase === 'paused'; },
    itemCount: function () { return items.length; },
  };
}

module.exports = { createPlaylistQueue, STATUS, VID_RE };
