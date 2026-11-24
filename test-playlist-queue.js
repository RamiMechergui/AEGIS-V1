// test-playlist-queue.js — unit suite for the sequential playlist queue
// (playlist-queue.js). No Electron, no network, no yt-dlp: the runner is a
// fake whose completion the test controls, which is exactly what makes it
// able to prove the CRITICAL requirement —
//
//   "AEGIS MUST DOWNLOAD VIDEOS ONE BY ONE."
//
// What is being proven:
//   1  enqueue validates entries (bad URL / bad id), drops duplicates and
//      keeps the original playlist order (index = queue position)
//   2  only ONE video is ever actively downloading: the runner counts
//      concurrent starts and the suite asserts the maximum stays at 1
//   3  the next video starts only after the previous one reached a terminal
//      state (start order == playlist order, no overlap)
//   4  a FAILED video records its error and does not block the queue
//   5  pause stops the NEXT video from starting while the current one
//      finishes; resume continues with the next item — no restart, no gap
//   6  cancel kills the active job, cancels the rest and starts nothing new
//      (pause/cancel can never accidentally trigger another download)
//   7  skip kills the current video, marks it skipped and moves on
//   8  remove only works on videos that have not started
//   9  retry / retryAll put failed videos back at their original position
//  10  progress events are throttled, snapshots fire on every state change
//  11  a runner that throws is treated as a failure, never a stuck queue
//
// Run:  node test-playlist-queue.js

'use strict';

const { createPlaylistQueue, STATUS } = require('./playlist-queue');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  [ OK ] ' + name);
  else { failures++; console.log('  [FAIL] ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(n) { for (let i = 0; i < (n || 10); i++) await sleep(0); }

// ── Fake runner ─────────────────────────────────────────────────────────────
// startVideo() returns promises the TEST resolves, so every interleaving can
// be driven by hand. It also counts concurrency to prove the limit of 1.
function makeRunner(opts) {
  opts = opts || {};
  const pending = [];
  const log = [];
  let active = 0;
  let maxActive = 0;
  const runner = {
    pending, log,
    get active() { return active; },
    get maxActive() { return maxActive; },
    startVideo(item) {
      active++;
      if (active > maxActive) maxActive = active;
      log.push('start:' + item.vid);
      return new Promise((resolve, reject) => {
        pending.push({
          item,
          finish(result) {
            active--;
            log.push('end:' + item.vid + (result && result.ok ? ':ok' : ':fail'));
            resolve(result);
          },
          fail(msg) {
            active--;
            log.push('end:' + item.vid + ':fail');
            resolve({ ok: false, error: msg || 'boom' });
          },
          throw(err) {
            active--;
            log.push('end:' + item.vid + ':throw');
            reject(err || new Error('runner exploded'));
          },
        });
        if (opts.auto) {
          // resolve on next tick (immediate success)
          setTimeout(() => {
            const p = pending[pending.length - 1];
            if (p && p.item === item && active > 0) p.finish({ ok: true, size: 1000 });
          }, 0);
        }
      });
    },
    cancelCount: 0,
    cancelCurrent() { runner.cancelCount++; },
  };
  return runner;
}

// Video ids must be exactly 11 chars — build them explicitly.
function vidOf(n) { return ('v' + String(n).padStart(10, '0')).slice(0, 11); }
function vidUrl(n) { return 'https://www.youtube.com/watch?v=' + vidOf(n); }
const item = (n) => ({ vid: vidOf(n), url: vidUrl(n), title: 'Video ' + n, thumb: '', duration: 60 });

(async () => {
  console.log('\n== playlist-queue: sequential download semantics ==');

  // ── 1. Validation, dedupe, order ─────────────────────────────────────────
  {
    const r = makeRunner();
    const q = createPlaylistQueue({ startVideo: r.startVideo, cancelCurrent: r.cancelCurrent });
    const enq = q.enqueue([
      item(1),
      item(2),
      item(1),                                    // duplicate vid -> dropped
      { vid: 'bad', url: 'https://x', title: 'x' },   // bad id
      { vid: vidOf(3), url: 'not-a-url', title: 'x' },// bad url
      item(4),
    ]);
    check('enqueue counts added/duplicates/invalid', enq.added === 3 && enq.duplicates === 1 && enq.invalid === 2, JSON.stringify(enq));
    const s = q.snapshot();
    check('playlist order is preserved (indices 0..2)', s.items.map((i) => i.index).join(',') === '0,1,2'
      && s.items.map((i) => i.vid).join(',') === [vidOf(1), vidOf(2), vidOf(4)].join(','));
    check('all items start as waiting', s.items.every((i) => i.status === STATUS.WAITING));
    check('totals: 3 waiting', s.totals.waiting === 3 && s.totals.total === 3);
    check('start refuses an empty queue', createPlaylistQueue({ startVideo: makeRunner().startVideo }).start() === false);
    q.start();
    await settle();
    check('enqueue refused once the queue started', q.enqueue([item(9)]).ok === false);
    r.pending[0].finish({ ok: true });
    await settle(20);
  }

  // ── 2 + 3. ONE download at a time, strict order ──────────────────────────
  {
    const r = makeRunner();
    const events = [];
    const q = createPlaylistQueue({ startVideo: r.startVideo, cancelCurrent: r.cancelCurrent,
      emit: (e) => events.push(e) });
    q.enqueue([item(1), item(2), item(3), item(4), item(5)]);
    q.start();
    await settle();

    check('exactly one video downloading after start', r.pending.length === 1 && r.active === 1,
      'pending=' + r.pending.length + ' active=' + r.active);
    check('first video is #1 (playlist order)', r.pending[0] && r.pending[0].item.vid === vidOf(1));
    check('snapshot shows downloading + waiting', q.snapshot().totals.downloading === 1 && q.snapshot().totals.waiting === 4);
    check('current is video 1', q.current() && q.current().vid === vidOf(1));

    // finish them one by one; after each finish, exactly the NEXT one starts
    for (let n = 1; n <= 5; n++) {
      const before = r.active;
      r.pending[n - 1].finish({ ok: true, size: 1234 });
      await settle();
      if (n < 5) {
        check('video ' + n + ' finished -> video ' + (n + 1) + ' started',
          r.pending.length === n + 1 && r.active === 1 && before === 1,
          'pending=' + r.pending.length + ' active=' + r.active);
        check('video ' + (n + 1) + ' is the next in playlist order', r.pending[n].item.vid === vidOf(n + 1));
      }
    }
    check('NEVER more than one concurrent download (max=1)', r.maxActive === 1, 'maxActive=' + r.maxActive);
    check('queue reaches done after the last video', q.phase() === 'done', q.phase());
    const fin = q.snapshot();
    check('all 5 completed', fin.totals.completed === 5 && fin.totals.remaining === 0);
    check('completed items carry pct 100', fin.items.every((i) => i.pct === 100));
    check('start order was strictly sequential', r.log.filter((l) => l.startsWith('start:'))
      .join(',') === [1, 2, 3, 4, 5].map((n) => 'start:' + vidOf(n)).join(','));

    // snapshots fired for each status transition (start + terminal per item)
    const snaps = events.filter((e) => e.type === 'snapshot');
    check('snapshot emitted on every state change', snaps.length >= 10, 'snapshots=' + snaps.length);
    check('terminal snapshot has totals done', snaps[snaps.length - 1].state.totals.completed === 5);
    // THE regression guard: the LAST snapshot must already say phase 'done' —
    // if the loop only emits while phase is still 'running', the queue window
    // would keep showing "Downloading playlist" after everything finished
    // (found by test-playlist-e2e.js).
    check('the final snapshot reports phase done (UI can finish)',
      snaps[snaps.length - 1].state.phase === 'done', snaps[snaps.length - 1].state.phase);
    check('a phase-done snapshot was emitted exactly once for this run',
      snaps.filter((s) => s.state.phase === 'done').length === 1,
      'done snapshots=' + snaps.filter((s) => s.state.phase === 'done').length);
  }

  // ── 4. A failure does not block the queue ────────────────────────────────
  {
    const r = makeRunner();
    const q = createPlaylistQueue({ startVideo: r.startVideo, cancelCurrent: r.cancelCurrent });
    q.enqueue([item(1), item(2), item(3)]);
    q.start();
    await settle();
    r.pending[0].fail('Video unavailable');
    await settle();
    check('failed video recorded its error', q.snapshot().items[0].status === STATUS.FAILED
      && q.snapshot().items[0].error === 'Video unavailable');
    check('queue continued with video 2', r.pending.length === 2 && r.pending[1].item.vid === vidOf(2));
    r.pending[1].finish({ ok: true });
    await settle();
    r.pending[2].finish({ ok: true });
    await settle();
    check('queue completes despite the failure', q.phase() === 'done');
    check('totals: 2 completed, 1 failed', q.snapshot().totals.completed === 2 && q.snapshot().totals.failed === 1);
    check('max concurrency still 1', r.maxActive === 1);
  }

  // ── 4b. A runner that throws is a failure, not a stuck queue ─────────────
  {
    const r = makeRunner();
    const q = createPlaylistQueue({ startVideo: r.startVideo, cancelCurrent: r.cancelCurrent });
    q.enqueue([item(1), item(2)]);
    q.start();
    await settle();
    r.pending[0].throw(new Error('ipc exploded'));
    await settle();
    check('throwing runner marks the item failed', q.snapshot().items[0].status === STATUS.FAILED);
    check('queue moved on to video 2', r.pending.length === 2);
    r.pending[1].finish({ ok: true });
    await settle();
    check('queue still finishes', q.phase() === 'done');
  }

  // ── 5. Pause: current finishes, nothing new starts; resume continues ─────
  {
    const r = makeRunner();
    const q = createPlaylistQueue({ startVideo: r.startVideo, cancelCurrent: r.cancelCurrent });
    q.enqueue([item(1), item(2), item(3)]);
    q.start();
    await settle();
    check('pause while downloading is accepted', q.pause() === true);
    check('phase is paused', q.phase() === 'paused');
    check('current video keeps downloading after pause', r.active === 1);
    r.pending[0].finish({ ok: true });
    await settle();
    check('after pause NO next video started', r.pending.length === 1, 'pending=' + r.pending.length);
    check('paused queue stays paused (no auto-resume)', q.phase() === 'paused');
    check('nothing is downloading while paused', q.snapshot().totals.downloading === 0);
    check('remaining videos are still waiting', q.snapshot().totals.waiting === 2);

    check('resume is accepted', q.resume() === true);
    await settle();
    check('resume starts exactly the next video', r.pending.length === 2 && r.active === 1
      && r.pending[1].item.vid === vidOf(2));
    check('resumed queue is running', q.phase() === 'running');
    check('max concurrency still 1 across pause/resume', r.maxActive === 1);

    // double resume must not create a second worker
    q.resume(); q.resume();
    await settle();
    check('repeated resume never starts a second download', r.active === 1 && r.pending.length === 2,
      'active=' + r.active + ' pending=' + r.pending.length);

    r.pending[1].finish({ ok: true });
    await settle();
    r.pending[2].finish({ ok: true });
    await settle();
    check('queue completes after resume', q.phase() === 'done' && q.snapshot().totals.completed === 3);
    check('max concurrency 1 for the whole run', r.maxActive === 1);
  }

  // ── 6. Cancel: kills active, cancels the rest, starts nothing new ────────
  {
    const r = makeRunner();
    const q = createPlaylistQueue({ startVideo: r.startVideo, cancelCurrent: r.cancelCurrent });
    q.enqueue([item(1), item(2), item(3), item(4)]);
    q.start();
    await settle();
    check('cancel is accepted', q.cancel() === true);
    check('cancelCurrent was invoked (active job killed)', r.cancelCount === 1);
    check('phase is canceled', q.phase() === 'canceled');
    const s = q.snapshot();
    check('waiting videos are marked canceled', s.totals.canceled === 3 && s.totals.downloading === 1);

    // the killed job reports back as canceled
    r.pending[0].finish({ ok: false, canceled: true });
    await settle();
    check('active video ends as canceled', q.snapshot().items[0].status === STATUS.CANCELED);
    check('queue stays canceled — nothing started after cancel', r.pending.length === 1,
      'pending=' + r.pending.length);
    check('queue is not busy anymore', q.isBusy() === false);
    check('cancel again is a no-op', q.cancel() === false);

    // even a rogue resume must not resurrect a canceled queue
    check('resume on canceled queue refused', q.resume() === false);
    await settle();
    check('still nothing running after refused resume', r.pending.length === 1);
  }

  // ── 7. Skip: kills the current video, marks it skipped, moves on ─────────
  {
    const r = makeRunner();
    const q = createPlaylistQueue({ startVideo: r.startVideo, cancelCurrent: r.cancelCurrent });
    q.enqueue([item(1), item(2), item(3)]);
    q.start();
    await settle();
    check('skip is accepted while downloading', q.skip() === true);
    check('skip invoked cancelCurrent', r.cancelCount === 1);
    r.pending[0].finish({ ok: false, canceled: true });
    await settle();
    check('skipped video has status skipped', q.snapshot().items[0].status === STATUS.SKIPPED,
      q.snapshot().items[0].status);
    check('queue continued with the next video', r.pending.length === 2 && r.active === 1);
    check('queue still running after skip', q.phase() === 'running');
    r.pending[1].finish({ ok: true });
    await settle();
    r.pending[2].finish({ ok: true });
    await settle();
    check('queue completes after a skip', q.phase() === 'done');
    check('totals: 2 completed, 1 skipped', q.snapshot().totals.completed === 2 && q.snapshot().totals.skipped === 1);
    check('max concurrency 1 across skip', r.maxActive === 1);
  }

  // ── 8. Remove only affects videos that have not started ──────────────────
  {
    const r = makeRunner();
    const q = createPlaylistQueue({ startVideo: r.startVideo, cancelCurrent: r.cancelCurrent });
    const enq = q.enqueue([item(1), item(2), item(3)]);
    const ids = q.snapshot().items.map((i) => i.id);
    q.start();
    await settle();
    check('cannot remove the downloading video', q.remove(ids[0]) === false);
    check('can remove a waiting video', q.remove(ids[2]) === true);
    check('removed video shows as removed', q.snapshot().items[2].status === STATUS.REMOVED);
    check('removed video never downloads', true); // proven below
    r.pending[0].finish({ ok: true });
    await settle();
    r.pending[1].finish({ ok: true });
    await settle();
    check('queue finishes without the removed video', q.phase() === 'done');
    check('removed video was never started', !r.log.some((l) => l === 'start:' + vidOf(3)));
    check('totals: 2 completed, 1 removed', q.snapshot().totals.completed === 2 && q.snapshot().totals.removed === 1);
    check('remove of an unknown id refused', q.remove(999999) === false);
    check('remove after finish refused', q.remove(ids[1]) === false);
  }

  // ── 9. Retry failed videos at their original position ────────────────────
  {
    const r = makeRunner();
    const q = createPlaylistQueue({ startVideo: r.startVideo, cancelCurrent: r.cancelCurrent });
    q.enqueue([item(1), item(2), item(3)]);
    q.start();
    await settle();
    r.pending[0].fail('network error');
    await settle();
    r.pending[1].finish({ ok: true });
    await settle();
    r.pending[2].finish({ ok: true });
    await settle();
    check('queue done with 1 failed', q.phase() === 'done' && q.snapshot().totals.failed === 1);

    check('retry of the failed video accepted', q.retry(q.snapshot().items[0].id) === true);
    await settle();
    check('retry re-opens the queue', q.phase() === 'running');
    check('retried video is downloading again', r.pending.length === 4 && r.pending[3].item.vid === vidOf(1),
      r.log.join('|'));
    r.pending[3].finish({ ok: true });
    await settle();
    check('queue completes after retry', q.phase() === 'done');
    check('totals: 3 completed, 0 failed', q.snapshot().totals.completed === 3 && q.snapshot().totals.failed === 0);
    check('retry kept the original position (video 1 first)', q.snapshot().items[0].index === 0);
    check('retry of a completed video refused', q.retry(q.snapshot().items[1].id) === false);
    check('max concurrency 1 across retry', r.maxActive === 1);

    // retryAll after a multi-failure run
    const r2 = makeRunner();
    const q2 = createPlaylistQueue({ startVideo: r2.startVideo, cancelCurrent: r2.cancelCurrent });
    q2.enqueue([item(1), item(2), item(3)]);
    q2.start();
    await settle();
    r2.pending[0].fail('a');
    await settle();
    r2.pending[1].fail('b');
    await settle();
    r2.pending[2].finish({ ok: true });
    await settle();
    check('retryAll accepted with 2 failures', q2.retryAll() === true);
    await settle();
    check('retryAll restarts the queue', q2.phase() === 'running');
    check('first failed video re-queued first', r2.pending[3].item.vid === vidOf(1));
    r2.pending[3].finish({ ok: true });
    await settle();
    r2.pending[4].finish({ ok: true });
    await settle();
    check('queue done after retryAll', q2.phase() === 'done' && q2.snapshot().totals.completed === 3);
    check('retryAll with no failures refused', q2.retryAll() === false);
  }

  // ── 10. Progress events: throttled snapshots on change ───────────────────
  {
    const r = makeRunner();
    const events = [];
    const q = createPlaylistQueue({ startVideo: r.startVideo, cancelCurrent: r.cancelCurrent,
      emit: (e) => events.push(e), progressMs: 10000 }); // huge window: only the FIRST progress goes out
    q.enqueue([item(1)]);
    q.start();
    await settle();
    const dl = q.snapshot().items[0];
    q.onItemProgress(dl, { pct: 10, speed: 1000, received: 100, total: 1000 });
    q.onItemProgress(dl, { pct: 50, speed: 2000, received: 500, total: 1000 });
    q.onItemProgress(dl, { pct: 90, speed: 3000, received: 900, total: 1000 });
    const progs = events.filter((e) => e.type === 'progress');
    check('progress throttled to one event in the window', progs.length === 1, 'progress=' + progs.length);
    check('progress carries pct/speed/received', progs[0] && progs[0].item.pct === 10 && progs[0].item.speed === 1000);
    check('item state still updated between events', dl.pct === 90 && dl.received === 900);
    check('progress ignored for non-downloading items', (q.onItemProgress({ status: 'completed' }, { pct: 5 }), true));
    r.pending[0].finish({ ok: true, size: 4242 });
    await settle();
    const done = q.snapshot();
    check('terminal snapshot reflects final size', done.items[0].total === 4242 && done.items[0].pct === 100);
  }

  // ── 11. Pause while idle / cancel-while-paused / start guards ────────────
  {
    const r = makeRunner();
    const q = createPlaylistQueue({ startVideo: r.startVideo, cancelCurrent: r.cancelCurrent });
    q.enqueue([item(1), item(2)]);
    check('pause before start refused', q.pause() === false);
    check('skip before start refused', q.skip() === false);
    check('start twice is harmless', q.start() === true);
    await settle();
    check('second start refused (already running)', q.start() === false);
    q.pause();
    check('cancel while paused accepted', q.cancel() === true);
    r.pending[0].finish({ ok: false, canceled: true });
    await settle();
    check('cancel-while-paused ends the queue', q.phase() === 'canceled' && r.pending.length === 1);
    check('isBusy false when canceled', q.isBusy() === false);

    // busy flag while running
    const r2 = makeRunner();
    const q2 = createPlaylistQueue({ startVideo: r2.startVideo, cancelCurrent: r2.cancelCurrent });
    q2.enqueue([item(1)]);
    check('isBusy false before start', q2.isBusy() === false);
    q2.start();
    await settle();
    check('isBusy true while running', q2.isBusy() === true);
    q2.pause();
    check('isBusy true while paused', q2.isBusy() === true);
    r2.pending[0].finish({ ok: true });
    await settle();
    check('isBusy false when done', q2.isBusy() === false && q2.phase() === 'done');
  }

  // ── 12. Big queue: still strictly sequential ─────────────────────────────
  {
    const r = makeRunner();
    const q = createPlaylistQueue({ startVideo: r.startVideo, cancelCurrent: r.cancelCurrent });
    const N = 50;
    q.enqueue(Array.from({ length: N }, (_, i) => item(i + 1)));
    q.start();
    for (let i = 0; i < N; i++) {
      await settle(2);
      if (r.pending.length !== i + 1) { check('big queue step ' + (i + 1) + ' sequential', false, 'pending=' + r.pending.length); break; }
      r.pending[i].finish({ ok: true });
    }
    await settle();
    check('50 videos downloaded strictly one-by-one', r.maxActive === 1 && q.phase() === 'done',
      'maxActive=' + r.maxActive + ' phase=' + q.phase());
    check('all 50 completed', q.snapshot().totals.completed === 50);
    check('50 start events, never overlapping', r.log.filter((l) => l.startsWith('start:')).length === 50);
  }

  console.log('\n== RESULT: ' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED') + ' ==');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
