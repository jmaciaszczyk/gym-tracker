import { html, render, useState, useEffect, useRef } from './htm-preact.js';
import * as db from './db.js';
import { SEED, MUSCLES } from './exercises.js';
import {
  STORES, LIMITS, MEASURES, num, inRange, cleanName, norm, today, parseDate, dayNumber, fmtNum, fmtSet, exName,
  newCustomExercise, normalizePlan, previousSets, draftFromDay, workoutToDraft, isDraft, draftToWorkout,
  parseMeasurement, exerciseSeries, bodySeries, buildBackup, validateBackup, REST, clampRest, fmtClock,
} from './logic.js';

// ---------- state ----------
// `data` mirrors IndexedDB. It is updated only after a transaction completes.
const data = { exercises: [], plans: [], workouts: [], measurements: [] };
let draft = null, draftSaved = true;
let banner = null;     // { msg, reload }
let picker = null;     // { resolve } while the exercise picker is open
let rerender = () => {};

const uuid = () => crypto.randomUUID();
const go = hash => { location.hash = hash; };
const s = n => (n === 1 ? '' : 's');

const LS = {
  get: k => { try { return localStorage.getItem('gym-tracker.' + k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem('gym-tracker.' + k, v); return true; } catch { return false; } },
  del: k => { try { localStorage.removeItem('gym-tracker.' + k); } catch {} },
};

// The in-progress workout lives in localStorage, written synchronously on every keystroke, so a reload loses nothing.
function loadDraft() { try { const d = JSON.parse(LS.get('draft')); return isDraft(d) ? d : null; } catch { return null; } }
function setDraft(d) { draft = d; draftSaved = LS.set('draft', JSON.stringify(d)); rerender(); }
function clearDraft() { draft = null; draftSaved = true; LS.del('draft'); rerender(); }

// Rest timer: one countdown at a time. Its end time is stored, so it survives reloads, app switches and a locked screen.
let restSec = clampRest(Number(LS.get('rest')));
let restEnd = Number(LS.get('restEnd')) || 0;
let audio, wakeLock = null, firedFor = 0;
const unlockAudio = () => { try { audio ??= new AudioContext(); audio.resume(); } catch {} };   // works only inside a tap/keystroke on iOS

function startRest() {
  restEnd = Date.now() + restSec * 1000;
  LS.set('restEnd', String(restEnd));
  unlockAudio();
  keepAwake(true);
  rerender();
}
// Runs on every screen, so the alert also fires when the user went to look at History mid-rest.
function restTick() {
  if (!restEnd) return;
  const late = Date.now() - restEnd;
  if (late >= 0 && firedFor !== restEnd) { firedFor = restEnd; if (late < 5000) beep(); keepAwake(false); }   // no stale beep after a long absence
  if (late >= 10000) stopRest();   // "Rest over" stays up for 10 s
}
function stopRest() { restEnd = 0; LS.del('restEnd'); keepAwake(false); rerender(); }
function adjustRest(d) {
  if (restEnd > Date.now()) { restEnd = Math.max(Date.now() + 1000, restEnd + d * 1000); LS.set('restEnd', String(restEnd)); }
  else {   // idle: ±15 edits the default (and dismisses "Rest over" so the new value shows)
    restSec = clampRest(restSec + d); LS.set('rest', String(restSec));
    restEnd = 0; LS.del('restEnd');
  }
  rerender();
}
async function keepAwake(on) {   // screen stays on while resting, so the countdown and the beep aren't lost
  try {
    if (!on) { const w = wakeLock; wakeLock = null; await w?.release(); }
    else if (!wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { wakeLock = null; }
}
function beep() {
  navigator.vibrate?.([200, 100, 200]);
  try {
    for (const [t, f] of [[0, 880], [0.25, 880], [0.5, 1320]]) {
      const o = audio.createOscillator(), g = audio.createGain(), at = audio.currentTime + t;
      o.frequency.value = f;
      o.connect(g).connect(audio.destination);
      g.gain.setValueAtTime(0.3, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.2);
      o.start(at);
      o.stop(at + 0.2);
    }
  } catch {}   // no AudioContext yet (e.g. after a reload): vibration and the on-screen message still work
}

function showBanner(msg, reload = false) { banner = { msg, reload }; rerender(); }
const failed = e => showBanner(`Save failed (${e?.message || e}). Export your data now.`);

async function save(store, rec) {
  try { await db.put(store, rec); } catch (e) { failed(e); throw e; }
  const list = data[store], i = list.findIndex(r => r.id === rec.id);
  if (i >= 0) list[i] = rec; else list.push(rec);
  rerender();
}
async function remove(store, id) {
  try { await db.del(store, id); } catch (e) { failed(e); throw e; }
  data[store] = data[store].filter(r => r.id !== id);
  rerender();
}

function fmtDate(str, weekday = true) {
  const d = parseDate(str);
  return d.toLocaleDateString('en-GB', {
    weekday: weekday ? 'short' : undefined, day: 'numeric', month: 'short',
    year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}
const plate = i => `var(--plate-${i % 5})`;
function plateOf(planId, dayId) {
  const i = data.plans.find(p => p.id === planId)?.days.findIndex(d => d.id === dayId) ?? -1;
  return i >= 0 ? plate(i) : 'var(--line)';
}
const confirmDiscard = () => confirm(`Discard unfinished workout "${draft.dayName}" from ${fmtDate(draft.date)}?`) && (stopRest(), true);

// ---------- exercise picker ----------
const pickExercise = () => new Promise(resolve => { picker = { resolve }; rerender(); });

function Picker() {
  const ref = useRef(), chosen = useRef(null);
  const [q, setQ] = useState(''), [muscle, setMuscle] = useState('Other'), [error, setError] = useState('');
  useEffect(() => { ref.current.showModal(); }, []);
  const pick = id => { chosen.current = id; ref.current.close(); };
  const onClose = () => { const p = picker; picker = null; rerender(); p?.resolve(chosen.current); };

  const all = [...SEED, ...data.exercises];
  const tokens = norm(q).split(' ').filter(Boolean);
  const hits = all.filter(e => { const h = norm(e.name + ' ' + e.muscle); return tokens.every(t => h.includes(t)); });
  const name = cleanName(q);
  const exact = all.some(e => norm(e.name) === norm(name));
  async function create() {
    const r = newCustomExercise(q, muscle, data.exercises);
    if (r.error) return setError(r.error);
    try { await save('exercises', r.exercise); pick(r.exercise.id); } catch {}
  }
  return html`<dialog ref=${ref} class="picker" aria-label="Choose exercise" onClose=${onClose}
      onClick=${e => e.target === ref.current && ref.current.close()}>
    <div class="picker-head">
      <input type="search" autofocus aria-label="Search exercises" placeholder="Search or type a new name" maxlength="60"
        autocomplete="off" value=${q} onInput=${e => { setQ(e.target.value); setError(''); }} />
      <button type="button" onClick=${() => ref.current.close()}>Cancel</button>
    </div>
    <div class="picker-list">
      ${name && !exact && html`<div class="create">
        <button type="button" class="primary" onClick=${create}>+ Create "${name}"</button>
        <select aria-label="Muscle group" value=${muscle} onChange=${e => setMuscle(e.target.value)}>
          ${MUSCLES.map(m => html`<option value=${m}>${m}</option>`)}
        </select>
      </div>`}
      ${error && html`<p class="err" role="alert">${error}</p>`}
      ${MUSCLES.map(m => {
        const list = hits.filter(e => e.muscle === m).sort((a, b) => a.name.localeCompare(b.name));
        return list.length > 0 && html`<h3>${m}</h3>${list.map(e =>
          html`<button type="button" class="opt" onClick=${() => pick(e.id)}>${e.name}</button>`)}`;
      })}
    </div>
  </dialog>`;
}

// ---------- Train ----------
function startDay(plan, day) {
  if (draft) {
    if (!draft.workoutId && draft.planId === plan.id && draft.dayId === day.id) return go('#/log');
    if (!confirmDiscard()) return go('#/log');
  }
  setDraft(draftFromDay(plan, day, data.exercises, today(), Date.now()));
  go('#/log');
}

function Train() {
  const last = Number(LS.get('lastExport')) || 0;
  const days = last ? Math.floor((Date.now() - last) / 864e5) : null;
  const remind = data.workouts.length > 0 && (days === null || days > 14);
  const plans = [...data.plans].sort((a, b) => a.createdAt - b.createdAt);
  return html`<h1>Train</h1>
    ${draft && html`<div class="notice warn">
      <span>${draft.workoutId ? 'Editing workout' : 'Unfinished workout'}: ${draft.dayName}, ${fmtDate(draft.date)}</span>
      <a class="btn" href="#/log">Resume</a></div>`}
    ${remind && html`<div class="notice">
      <span>Last backup: ${days === null ? 'never' : `${days} days ago`}</span><a class="btn" href="#/more">Back up</a></div>`}
    ${!plans.length && html`<p class="empty">Create your first plan: name it, add training days, then pick exercises and the number of sets for each day.</p>`}
    ${plans.map(p => html`<section class="plan" key=${p.id}>
      <div class="plan-head"><h2>${p.name}</h2><a class="btn" href=${'#/plan/' + p.id} aria-label=${'Edit ' + p.name}>Edit</a></div>
      ${p.days.map((d, i) => html`<button class="tile" style=${{ '--plate': plate(i) }} disabled=${!d.exercises.length}
          onClick=${() => startDay(p, d)}>
        <span class="tile-name">${d.name}</span>
        <small>${d.exercises.length ? `${d.exercises.length} exercise${s(d.exercises.length)}` : 'No exercises yet'}</small>
      </button>`)}
    </section>`)}
    <a class="btn primary" href="#/plan/new">+ New plan</a>`;
}

// ---------- plan editor (saves on every change) ----------
function PlanEditor({ stored }) {
  const isNew = useRef(!stored), nameRef = useRef();
  const [plan, setPlan] = useState(() => stored ? structuredClone(stored)
    : { id: uuid(), name: '', createdAt: Date.now(), days: [{ id: uuid(), name: 'Day 1', exercises: [] }] });
  const latest = useRef(plan);
  latest.current = plan;
  useEffect(() => { if (!stored) nameRef.current.focus(); }, []);

  function update(fn) {
    const next = structuredClone(latest.current);
    fn(next);
    latest.current = next;
    setPlan(next);
    // Nothing is stored until the first change, so abandoned blank plans don't pile up.
    save('plans', normalizePlan(next)).then(() => {
      if (isNew.current) { isNew.current = false; history.replaceState(null, '', '#/plan/' + next.id); }
    }, () => {});
  }
  const move = (arr, i, d) => arr.splice(i + d, 0, ...arr.splice(i, 1));
  // Moves, swaps and removals re-render rows; put keyboard focus back where the user was (after Preact's microtask render).
  const refocus = (dayIndex, ...selectors) => setTimeout(() => {
    const root = document.querySelectorAll('.day')[dayIndex] ?? document;
    selectors.map(sel => root.querySelector(sel)).find(Boolean)?.focus();
  });
  const lab = l => `button[aria-label="${CSS.escape(l)}"]:not(:disabled)`;
  function moveExercise(di, xi, dir, n) {
    update(p => move(p.days[di].exercises, xi, dir));
    refocus(di, lab(`Move ${n} ${dir < 0 ? 'up' : 'down'}`), lab(`Move ${n} ${dir < 0 ? 'down' : 'up'}`));
  }
  function moveDay(di, dir, dn) {
    update(p => move(p.days, di, dir));
    refocus(di + dir, lab(`Move day ${dn} ${dir < 0 ? 'up' : 'down'}`), lab(`Move day ${dn} ${dir < 0 ? 'down' : 'up'}`));
  }
  async function addExercise(di) {
    const id = await pickExercise();
    if (id) update(p => { p.days[di].exercises.push({ exerciseId: id, sets: 3 }); });
  }
  async function swap(di, xi) {
    const id = await pickExercise();
    if (id) { update(p => { p.days[di].exercises[xi].exerciseId = id; }); refocus(di, lab('Swap ' + exName(id, '', data.exercises))); }
  }
  function removeDay(di, dn) {
    const n = plan.days[di].exercises.length;
    if (n && !confirm(`Remove day "${dn}" and its ${n} exercise${s(n)}?`)) return;
    update(p => { p.days.splice(di, 1); });
    refocus(-1, '.add-day');
  }
  async function deletePlan() {
    if (!confirm(`Delete "${normalizePlan(plan).name}"? Workout history is kept.`)) return;
    if (data.plans.some(p => p.id === plan.id)) { try { await remove('plans', plan.id); } catch { return; } }
    go('#/');
  }

  return html`<div class="bar"><a href="#/">‹ Done</a></div>
    <input ref=${nameRef} class="title-input" aria-label="Plan name" placeholder="Plan name" maxlength="60" value=${plan.name}
      onInput=${e => { const v = e.target.value; update(p => { p.name = v; }); }} />
    ${plan.days.map((d, di) => {
      const dn = cleanName(d.name) || `Day ${di + 1}`;
      return html`<section class="day" key=${d.id} style=${{ '--plate': plate(di) }}>
        <div class="day-head">
          <input aria-label=${`Day ${di + 1} name`} placeholder=${`Day ${di + 1}`} maxlength="60" value=${d.name}
            onInput=${e => { const v = e.target.value; update(p => { p.days[di].name = v; }); }} />
          <button class="icon" aria-label=${`Move day ${dn} up`} disabled=${di === 0} onClick=${() => moveDay(di, -1, dn)}>↑</button>
          <button class="icon" aria-label=${`Move day ${dn} down`} disabled=${di === plan.days.length - 1} onClick=${() => moveDay(di, 1, dn)}>↓</button>
          ${plan.days.length > 1 && html`<button class="icon" aria-label=${`Remove day ${dn}`} onClick=${() => removeDay(di, dn)}>✕</button>`}
        </div>
        ${d.exercises.map((x, xi) => {
          const n = exName(x.exerciseId, '', data.exercises);
          const setSets = v => update(p => { p.days[di].exercises[xi].sets = v; });
          return html`<div class="exrow" key=${xi + x.exerciseId}>
            <button class="exname" aria-label=${`Swap ${n}`} onClick=${() => swap(di, xi)}>${n} <span aria-hidden="true">▸</span></button>
            <div class="l2">
              <div class="stepper">
                <button class="icon" aria-label=${`Fewer sets for ${n}`} disabled=${x.sets <= LIMITS.sets[0]} onClick=${() => setSets(x.sets - 1)}>−</button>
                <output aria-live="polite">${x.sets} set${s(x.sets)}</output>
                <button class="icon" aria-label=${`More sets for ${n}`} disabled=${x.sets >= LIMITS.sets[1]} onClick=${() => setSets(x.sets + 1)}>+</button>
              </div>
              <span class="moves">
                <button class="icon" aria-label=${`Move ${n} up`} disabled=${xi === 0} onClick=${() => moveExercise(di, xi, -1, n)}>↑</button>
                <button class="icon" aria-label=${`Move ${n} down`} disabled=${xi === d.exercises.length - 1} onClick=${() => moveExercise(di, xi, 1, n)}>↓</button>
                <button class="icon" aria-label=${`Remove ${n}`} onClick=${() => { update(p => { p.days[di].exercises.splice(xi, 1); }); refocus(di, '.add'); }}>✕</button>
              </span>
            </div>
          </div>`;
        })}
        <button class="add" onClick=${() => addExercise(di)}>+ Add exercise</button>
      </section>`;
    })}
    <div class="actions">
      <button class="add-day" onClick=${() => update(p => { p.days.push({ id: uuid(), name: `Day ${p.days.length + 1}`, exercises: [] }); })}>+ Add day</button>
    </div>
    <button class="link danger" onClick=${deletePlan}>Delete plan</button>`;
}

// ---------- logger, workout view, history ----------
function ExerciseCard({ entry, ei, prev, onSet, onCopy, onAddSet }) {
  const n = exName(entry.exerciseId, entry.name, data.exercises);
  return html`<section class="exercise">
    <h2>${n}</h2>
    <p class="last">${prev ? `Last time ${fmtDate(prev.date, false)}: ${prev.sets.map(fmtSet).join(', ')}` : 'No previous data'}</p>
    <table class="sets">
      <colgroup><col class="c-set" /><col class="c-prev" /><col /><col /></colgroup>
      <thead><tr><th scope="col">Set</th><th scope="col">Previous</th><th scope="col">kg</th><th scope="col">Reps</th></tr></thead>
      <tbody>${entry.sets.map((st, si) => {
        const p = prev?.sets[si];
        const badW = !!st.w.trim() && !inRange(num(st.w), LIMITS.weight);
        const badR = !!st.r.trim() && !inRange(num(st.r, { int: true }), LIMITS.reps, true);
        return html`<tr>
          <td class="num">${si + 1}</td>
          <td>${p ? html`<button type="button" class="prev" onClick=${() => onCopy?.(si, p)}
              aria-label=${`Copy previous set ${si + 1}: ${p.weight == null ? 'bodyweight' : fmtNum(p.weight) + ' kg'} × ${p.reps} reps`}>${fmtSet(p)}</button>`
            : html`<span class="dash" aria-label="No previous set">—</span>`}</td>
          <td><input id=${`in-${ei}-${si}-w`} type="text" inputmode="decimal" autocomplete="off" enterkeyhint="next" class=${st.w ? 'filled' : ''}
            placeholder=${!onSet ? 'BW' : p ? (p.weight == null ? 'BW' : fmtNum(p.weight)) : ''} aria-label=${`${n} set ${si + 1} weight, kg`}
            aria-invalid=${badW ? 'true' : undefined} value=${st.w} onInput=${e => onSet(si, 'w', e.target.value)} /></td>
          <td><input id=${`in-${ei}-${si}-r`} type="text" inputmode="numeric" autocomplete="off" enterkeyhint="next" class=${st.r ? 'filled' : ''}
            placeholder=${onSet && p ? String(p.reps) : ''} aria-label=${`${n} set ${si + 1} reps`}
            aria-invalid=${badR ? 'true' : undefined} value=${st.r} onInput=${e => onSet(si, 'r', e.target.value)} /></td>
        </tr>`;
      })}</tbody>
    </table>
    ${onAddSet && html`<button type="button" class="link" onClick=${onAddSet}>+ Set</button>`}
  </section>`;
}

function RestTimer() {
  const [, tick] = useState(0);
  const now = Date.now(), running = restEnd > now, left = Math.ceil((restEnd - now) / 1000);
  const done = !running && restEnd > 0;   // restTick clears restEnd 10 s after the end
  useEffect(() => {   // display only; completion is handled by restTick
    if (!restEnd) return;
    const id = setInterval(() => tick(t => t + 1), 250);
    return () => clearInterval(id);
  }, [restEnd]);
  return html`<div class=${'rest' + (running ? ' running' : done ? ' done' : '')} role="group" aria-label="Rest timer">
    <button class="step" aria-label="−15 seconds" disabled=${!running && restSec <= REST.range[0]} onClick=${() => adjustRest(-REST.step)}>−15</button>
    <button class="rest-main" onClick=${running ? stopRest : startRest}
      aria-label=${running ? `Stop rest, ${fmtClock(left)} left` : done ? `Rest over, start again, ${fmtClock(restSec)}` : `Start rest, ${fmtClock(restSec)}`}>
      ${running
        ? html`<span class="clock" role="timer">${fmtClock(left)}</span><small>Stop</small>`
        : html`<span class="clock">${done ? 'Rest over' : fmtClock(restSec)}</span><small>${done ? 'Start again' : 'Start rest'}</small>`}
    </button>
    <button class="step" aria-label="+15 seconds" disabled=${!running && restSec >= REST.range[1]} onClick=${() => adjustRest(REST.step)}>+15</button>
    <span class="sr" aria-live="polite">${done ? 'Rest over' : running ? '' : `Rest ${fmtClock(restSec)}`}</span>
  </div>`;
}

function Logger() {
  const [msg, setMsg] = useState('');
  const d = draft, editing = !!d.workoutId;
  const change = fn => { const next = structuredClone(draft); fn(next); setDraft(next); setMsg(''); };

  async function finish() {
    const { workout, errors, warnings } = draftToWorkout(draft, data.exercises);
    if (errors.length) {
      const fields = errors.filter(e => e.entry != null), parts = errors.filter(e => e.msg).map(e => e.msg);
      if (fields.length) parts.push(`Fix ${fields.length} highlighted field${s(fields.length)}: kg 0–1000, reps a whole number 1–999.`);
      setMsg(parts.join(' '));
      const f = fields[0];
      document.getElementById(f ? `in-${f.entry}-${f.set}-${f.field}` : errors[0].field === 'date' ? 'in-date' : '')?.focus();
      return;
    }
    if (warnings.length && !confirm(`${warnings.join(' ')} ${editing ? 'Save' : 'Finish'} anyway?`)) return;
    try { await save('workouts', workout); } catch { return; }   // draft is kept when the write fails
    go(editing ? '#/workout/' + workout.id : '#/history');
    clearDraft();
    if (!editing) stopRest();
  }
  function discard() {
    if (!confirm(editing ? 'Discard your changes to this workout?' : 'Discard this workout? Nothing will be saved.')) return;
    go(editing ? '#/workout/' + draft.workoutId : '#/');
    clearDraft();
    if (!editing) stopRest();
  }
  function setValue(ei, si, k, v) {
    const was = draft.entries[ei].sets[si][k];
    change(x => { x.entries[ei].sets[si][k] = v; });
    if (!editing && k === 'r' && !was.trim() && v.trim()) startRest();   // reps entered = set done
  }

  return html`<div class="bar"><a href="#/">‹ Train</a>${editing && html`<span class="muted">Editing workout</span>`}</div>
    <div class="log-head" style=${{ '--plate': plateOf(d.planId, d.dayId) }}>
      <h1>${d.dayName}</h1><p class="muted">${d.planName}</p>
    </div>
    <label>Date <input id="in-date" type="date" value=${d.date} max=${today()} onInput=${e => { const v = e.target.value; change(x => { x.date = v; }); }} /></label>
    ${!draftSaved && html`<p class="notice warn" role="alert">Draft not autosaving. Don't close the app before finishing.</p>`}
    ${d.entries.map((e, ei) => html`<${ExerciseCard} entry=${e} ei=${ei}
      prev=${previousSets(data.workouts, e.exerciseId, { id: d.workoutId, date: d.date, createdAt: d.createdAt })}
      onSet=${(si, k, v) => setValue(ei, si, k, v)}
      onCopy=${(si, p) => change(x => { x.entries[ei].sets[si] = { w: p.weight == null ? '' : String(p.weight), r: String(p.reps) }; })}
      onAddSet=${() => change(x => { x.entries[ei].sets.push({ w: '', r: '' }); })} />`)}
    <div class="finish">
      ${!editing && html`<${RestTimer} />`}
      ${msg && html`<p class="err" role="alert">${msg}</p>`}
      <button class="primary" onClick=${finish}>${editing ? 'Save changes' : 'Finish workout'}</button>
    </div>
    <button class="link danger" onClick=${discard}>${editing ? 'Cancel editing' : 'Discard workout'}</button>`;
}

function editWorkout(w) {
  if (draft?.workoutId !== w.id) {
    if (draft && !confirmDiscard()) return;
    setDraft(workoutToDraft(w));
  }
  go('#/log');
}

function WorkoutView({ w }) {
  const d = workoutToDraft(w);
  async function del() {
    if (!confirm(`Delete workout from ${fmtDate(w.date)}? This cannot be undone.`)) return;
    try { await remove('workouts', w.id); } catch { return; }
    if (draft?.workoutId === w.id) clearDraft();
    go('#/history');
  }
  return html`<div class="bar"><a href="#/history">‹ History</a></div>
    <div class="log-head" style=${{ '--plate': plateOf(w.planId, w.dayId) }}>
      <h1>${w.dayName}</h1><p class="muted">${w.planName}, ${fmtDate(w.date)}</p>
    </div>
    <fieldset disabled>
      <legend class="sr">Workout from ${fmtDate(w.date)} (read-only)</legend>
      ${d.entries.map((e, ei) => html`<${ExerciseCard} entry=${e} ei=${ei} prev=${previousSets(data.workouts, e.exerciseId, w)} />`)}
    </fieldset>
    <div class="actions"><button class="primary" onClick=${() => editWorkout(w)}>Edit</button><button class="danger" onClick=${del}>Delete</button></div>`;
}

function History() {
  const list = [...data.workouts].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  return html`<h1>History</h1>
    ${!list.length && html`<p class="empty">No workouts yet. Start one by tapping a plan day on the Train tab.</p>`}
    <ul class="list">${list.map(w => html`<li key=${w.id}>
      <a href=${'#/workout/' + w.id} style=${{ '--plate': plateOf(w.planId, w.dayId) }}>
        <span class="row"><strong>${w.dayName} <span class="muted">${w.planName}</span></strong><span class="muted">${fmtDate(w.date)}</span></span>
        ${w.entries.map(e => html`<span class="line">${exName(e.exerciseId, e.name, data.exercises)}: ${e.sets.map(fmtSet).join(', ')}</span>`)}
      </a></li>`)}
    </ul>`;
}

// ---------- body ----------
function Body() {
  const blank = () => ({ date: today(), ...Object.fromEntries(MEASURES.map(([k]) => [k, ''])) });
  const [f, setF] = useState(blank), [editing, setEditing] = useState(null), [errors, setErrors] = useState({});
  const latest = Object.fromEntries(MEASURES.map(([k]) => [k, bodySeries(data.measurements, k).at(-1)?.value]));
  const set = k => e => { const v = e.target.value; setF(f => ({ ...f, [k]: v })); };
  const reset = () => { setF(blank()); setEditing(null); setErrors({}); };

  async function submit(e) {
    e.preventDefault();
    const { values, errors } = parseMeasurement(f, f.date);
    setErrors(errors);
    const first = Object.keys(errors)[0];
    if (first) return document.getElementById('m-' + first)?.focus();
    try { await save('measurements', { id: editing?.id ?? uuid(), date: f.date, createdAt: editing?.createdAt ?? Date.now(), ...values }); }
    catch { return; }
    reset();
  }
  function load(m) {
    setEditing(m);
    setErrors({});
    setF({ date: m.date, ...Object.fromEntries(MEASURES.map(([k]) => [k, m[k] == null ? '' : String(m[k])])) });
    document.getElementById('m-date').focus();
  }
  async function del() {
    if (!confirm(`Delete the entry from ${fmtDate(editing.date)}?`)) return;
    try { await remove('measurements', editing.id); } catch { return; }
    reset();
  }
  const list = [...data.measurements].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  return html`<h1>Body</h1>
    <form onSubmit=${submit} novalidate>
      <label>Date <input id="m-date" type="date" value=${f.date} max=${today()} onInput=${set('date')}
        aria-invalid=${errors.date ? 'true' : undefined} aria-describedby=${errors.date ? 'e-date' : undefined} /></label>
      ${errors.date && html`<span class="err" id="e-date">${errors.date}</span>`}
      <div class="grid2">${MEASURES.map(([k, label, unit]) => html`<label class=${k === 'mass' ? 'wide' : ''}>${label} (${unit})
        <input id=${'m-' + k} type="text" inputmode="decimal" autocomplete="off" value=${f[k]} onInput=${set(k)}
          placeholder=${latest[k] != null ? fmtNum(latest[k]) : ''}
          aria-invalid=${errors[k] ? 'true' : undefined} aria-describedby=${errors[k] ? 'e-' + k : undefined} />
        ${errors[k] && html`<span class="err" id=${'e-' + k}>${errors[k]}</span>`}
      </label>`)}</div>
      ${errors.form && html`<p class="err" role="alert">${errors.form}</p>`}
      <div class="actions">
        <button class="primary" type="submit">${editing ? 'Save changes' : 'Save measurements'}</button>
        ${editing && html`<button type="button" onClick=${reset}>Cancel</button><button type="button" class="danger" onClick=${del}>Delete</button>`}
      </div>
    </form>
    <section class="section"><h2>Entries</h2>
      ${!list.length && html`<p class="empty">No entries yet. Fill in any fields you measured; blank ones are skipped.</p>`}
      <ul class="list">${list.map(m => html`<li key=${m.id}><button type="button" onClick=${() => load(m)}>
        <strong>${fmtDate(m.date)}</strong>
        <span class="line">${MEASURES.filter(([k]) => m[k] != null).map(([k, l, u]) => `${l} ${fmtNum(m[k])} ${u}`).join(', ')}</span>
      </button></li>`)}</ul>
    </section>`;
}

// ---------- progress ----------
function Chart({ points, unit, label, nouns }) {
  const rows = html`<details><summary>Data</summary><table class="data">
    <thead><tr><th scope="col">Date</th><th scope="col">${unit}</th></tr></thead>
    <tbody>${[...points].reverse().map(p => html`<tr><td>${fmtDate(p.date)}</td><td>${fmtNum(p.value)}</td></tr>`)}</tbody>
  </table></details>`;
  if (points.length < 2) return html`<p class="empty" style="margin-top:20px">
    ${points.length ? `Log at least 2 ${nouns} to see a chart.` : 'Nothing logged yet.'}</p>${points.length > 0 && rows}`;

  const W = 340, H = 200, L = 34, R = 10, T = 10, B = 24;
  const xs = points.map(p => dayNumber(p.date)), vs = points.map(p => p.value);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (lo === hi) { lo -= 1; hi += 1; } else { const pad = (hi - lo) * 0.1; lo -= pad; hi += pad; }
  const sx = x => L + (x - x0) / (x1 - x0) * (W - L - R), sy = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const ticks = [0, 1, 2, 3].map(i => lo + (hi - lo) * i / 3);
  const first = points[0], last = points.at(-1), delta = last.value - first.value;
  const xl = [...new Set([0, points.length >> 1, points.length - 1])];
  const aria = `${label}, ${points.length} ${nouns}, from ${fmtNum(first.value)} ${unit} on ${fmtDate(first.date, false)} to ${fmtNum(last.value)} ${unit} on ${fmtDate(last.date, false)}`;
  return html`<figure class="chart">
    <p class="delta">${delta >= 0 ? '+' : '−'}${fmtNum(Math.abs(delta))} ${unit} <span class="muted">since ${fmtDate(first.date, false)}</span></p>
    <svg viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${aria}>
      ${ticks.map(t => html`<line class="grid" x1=${L} x2=${W - R} y1=${sy(t)} y2=${sy(t)} />
        <text x=${L - 6} y=${sy(t) + 4} text-anchor="end">${fmtNum(t)}</text>`)}
      <polyline class="line" points=${points.map((p, i) => `${sx(xs[i])},${sy(p.value)}`).join(' ')} />
      ${points.map((p, i) => html`<circle cx=${sx(xs[i])} cy=${sy(p.value)} r="4" />`)}
      ${xl.map(i => html`<text x=${sx(xs[i])} y=${H - 6} text-anchor=${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>${fmtDate(points[i].date, false)}</text>`)}
    </svg>
    ${rows}
  </figure>`;
}

function Progress() {
  const saved = (() => { try { return JSON.parse(LS.get('chart')) || {}; } catch { return {}; } })();
  const names = new Map();
  for (const w of data.workouts) for (const e of w.entries) if (e.sets.length) names.set(e.exerciseId, exName(e.exerciseId, e.name, data.exercises));
  const exOptions = [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const options = [...exOptions.map(o => 'ex:' + o.id), ...MEASURES.map(([k]) => 'body:' + k)];
  const [sel, setSel] = useState(saved.sel), [metric, setMetric] = useState(saved.metric === 'reps' ? 'reps' : 'weight');
  const cur = options.includes(sel) ? sel : options[0];
  useEffect(() => { LS.set('chart', JSON.stringify({ sel: cur, metric })); }, [cur, metric]);

  const i = cur.indexOf(':'), kind = cur.slice(0, i), key = cur.slice(i + 1);
  let chart, weightPts = [], effective = metric;
  if (kind === 'ex') {
    weightPts = exerciseSeries(data.workouts, key, 'weight');
    if (!weightPts.length) effective = 'reps';   // bodyweight-only exercise
    chart = effective === 'weight'
      ? { points: weightPts, unit: 'kg', label: `${names.get(key)} top weight` }
      : { points: exerciseSeries(data.workouts, key, 'reps'), unit: 'reps', label: `${names.get(key)} max reps` };
    chart.nouns = 'sessions';
  } else {
    const [, label, unit] = MEASURES.find(([k]) => k === key);
    chart = { points: bodySeries(data.measurements, key), unit, label, nouns: 'entries' };
  }
  return html`<h1>Progress</h1>
    <label>Chart <select value=${cur} onChange=${e => setSel(e.target.value)}>
      ${exOptions.length > 0 && html`<optgroup label="Exercises">${exOptions.map(o => html`<option value=${'ex:' + o.id}>${o.name}</option>`)}</optgroup>`}
      <optgroup label="Body">${MEASURES.map(([k, l]) => html`<option value=${'body:' + k}>${l}</option>`)}</optgroup>
    </select></label>
    ${kind === 'ex' && html`<fieldset class="seg"><legend class="sr">Metric</legend>
      <label><input type="radio" name="metric" checked=${effective === 'weight'} disabled=${!weightPts.length} onChange=${() => setMetric('weight')} /> Top weight</label>
      <label><input type="radio" name="metric" checked=${effective === 'reps'} onChange=${() => setMetric('reps')} /> Max reps</label>
    </fieldset>`}
    <${Chart} ...${chart} />`;
}

// ---------- more: backup, storage, install ----------
const summary = d => {
  const latest = d.workouts.reduce((m, w) => (w.date > m ? w.date : m), '');
  return `${d.plans.length} plan${s(d.plans.length)}, ${d.workouts.length} workout${s(d.workouts.length)}${latest ? ` (latest ${fmtDate(latest, false)})` : ''}, `
    + `${d.measurements.length} measurement${s(d.measurements.length)}, ${d.exercises.length} custom exercise${s(d.exercises.length)}`;
};

function ConfirmImport({ pending, onExport, onReplace, onCancel }) {
  const ref = useRef();
  useEffect(() => { ref.current.showModal(); }, []);
  const exported = new Date(pending.exportedAt);
  return html`<dialog ref=${ref} class="confirm" aria-labelledby="imp-title" onClose=${onCancel}>
    <h2 id="imp-title">Replace your data?</h2>
    <p><strong>This device:</strong> ${summary(data)}</p>
    <p><strong>Backup${isNaN(exported) ? '' : ` from ${fmtDate(today(exported), false)}`}:</strong> ${summary(pending.data)}</p>
    <p>Everything on this device will be replaced by the backup.</p>
    <div class="actions col">
      <button onClick=${onExport}>Export current data first</button>
      <button class="danger-fill" onClick=${onReplace}>Replace my data</button>
      <button onClick=${() => ref.current.close()}>Cancel</button>
    </div>
  </dialog>`;
}

function More() {
  const [persisted, setPersisted] = useState(null), [msg, setMsg] = useState(''), [errors, setErrors] = useState([]), [pending, setPending] = useState(null);
  useEffect(() => { navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(false)) ?? setPersisted(false); }, []);
  const last = Number(LS.get('lastExport')) || 0;
  const file = () => new File([JSON.stringify(buildBackup(data))], `gym-tracker-backup-${today()}.json`, { type: 'application/json' });
  const canShare = (() => { try { return !!navigator.canShare?.({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] }); } catch { return false; } })();
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  const exported = () => { LS.set('lastExport', String(Date.now())); setMsg('Backup created.'); rerender(); };
  function download() {
    const f = file(), url = URL.createObjectURL(f), a = document.createElement('a');
    a.href = url; a.download = f.name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    exported();
  }
  async function share() {
    try { await navigator.share({ files: [file()], title: 'Gym Tracker backup' }); exported(); }
    catch (e) { if (e.name !== 'AbortError') setMsg(`Sharing failed: ${e.message}. Use Download backup instead.`); }
  }
  async function pickFile(e) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setErrors([]); setMsg('');
    let obj;
    try { obj = JSON.parse(await f.text()); } catch { return setErrors(['Not a valid backup file']); }
    const r = validateBackup(obj);
    if (r.errors.length) return setErrors(r.errors);
    setPending({ data: r.data, exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '' });   // the only unvalidated field shown
  }
  async function replace() {
    try { await db.replaceAll(pending.data); }   // one transaction: on failure nothing changes
    catch (e) { setPending(null); return setErrors([`Import failed (${e?.message || e})`]); }
    for (const st of STORES) data[st] = pending.data[st];
    setPending(null);
    setMsg('Backup restored.');
    rerender();
  }

  return html`<h1>More</h1>
    <section class="section"><h2>Backup</h2>
      <p class="muted">Your data is stored only on this device. Last backup: ${last ? fmtDate(today(new Date(last))) : 'never'}.</p>
      <div class="actions">
        <button class="primary" onClick=${download}>Download backup</button>
        ${canShare && html`<button onClick=${share}>Share backup…</button>`}
        <label class="btn file">Import backup<input class="sr" type="file" accept=".json,application/json" onChange=${pickFile} /></label>
      </div>
      ${msg && html`<p role="status">${msg}</p>`}
      ${errors.length > 0 && html`<div class="err" role="alert">
        <p>Import failed. Your data was not changed.</p>
        <ul>${errors.slice(0, 20).map(e => html`<li>${e}</li>`)}</ul>
        ${errors.length > 20 && html`<p>…and ${errors.length - 20} more.</p>`}
      </div>`}
    </section>
    <section class="section"><h2>Storage</h2>
      <p>${persisted === null ? 'Checking storage…' : persisted ? 'Storage: persistent ✓'
        : 'The browser may clear this data when space runs low. Install the app and back up regularly.'}</p>
    </section>
    ${ios && !standalone && html`<section class="section"><h2>Install</h2>
      <p>In Safari tap Share, then Add to Home Screen. Do this before you start logging: Safari and the installed app keep separate data.</p>
    </section>`}
    ${pending && html`<${ConfirmImport} pending=${pending} onExport=${download} onReplace=${replace} onCancel=${() => setPending(null)} />`}`;
}

// ---------- app shell ----------
const TABS = [['', 'Train'], ['history', 'History'], ['body', 'Body'], ['progress', 'Progress'], ['more', 'More']];

function App() {
  const [, setTick] = useState(0);
  rerender = () => setTick(t => t + 1);

  const [route, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const redirect = to => { queueMicrotask(() => location.replace(to)); return null; };
  let screen, nav = true;
  switch (route || '') {
    case '': screen = html`<${Train} />`; break;
    case 'plan': {
      const p = data.plans.find(p => p.id === arg);
      if (arg !== 'new' && !p) return redirect('#/');
      screen = html`<${PlanEditor} key="plan" stored=${p} />`; nav = false; break;
    }
    case 'log': if (!draft) return redirect('#/'); screen = html`<${Logger} />`; nav = false; break;
    case 'workout': {
      const w = data.workouts.find(w => w.id === arg);
      if (!w) return redirect('#/history');
      screen = html`<${WorkoutView} key=${w.id} w=${w} />`; break;
    }
    case 'history': screen = html`<${History} />`; break;
    case 'body': screen = html`<${Body} />`; break;
    case 'progress': screen = html`<${Progress} />`; break;
    case 'more': screen = html`<${More} />`; break;
    default: return redirect('#/');
  }
  const current = route === 'workout' ? 'history' : route || '';
  return html`
    ${banner && html`<div class="banner" role="alert"><span>${banner.msg}</span>
      ${banner.reload && html`<button onClick=${() => location.reload()}>Reload</button>`}</div>`}
    <main>${screen}</main>
    ${nav && html`<nav class="tabs" aria-label="Main">${TABS.map(([r, l]) =>
      html`<a href=${'#/' + r} aria-current=${current === r ? 'page' : undefined}>${l}</a>`)}</nav>`}
    ${picker && html`<${Picker} />`}`;
}

async function boot() {
  const root = document.getElementById('app');
  try {
    await db.open({
      onBlocked: () => showBanner('Close other Gym Tracker tabs to finish updating.'),
      onVersionChange: () => showBanner('Gym Tracker was updated in another tab.', true),
    });
    const [exercises, plans, workouts, measurements] = await Promise.all(STORES.map(st => db.getAll(st)));
    Object.assign(data, { exercises, plans, workouts, measurements });
  } catch (e) {
    render(html`<div class="fatal"><h1>Can't save data here</h1>
      <p>This browser mode doesn't allow storage, so nothing you enter would be kept. Open Gym Tracker in a normal browser window.</p>
      <p class="muted">${String(e?.message || e)}</p></div>`, root);
    return;
  }
  draft = loadDraft();
  // Registered before the first render: a redirect from the first render fires hashchange before any effect would run.
  addEventListener('hashchange', () => { scrollTo(0, 0); rerender(); });
  // The browser drops the wake lock whenever the app is hidden; take it back if a rest is still running.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && restEnd > Date.now()) keepAwake(true); });
  // After a reload (iOS often kills a backgrounded app) the AudioContext is gone; the next tap brings the beep back.
  for (const t of ['touchend', 'click']) addEventListener(t, () => { if (restEnd) unlockAudio(); }, true);
  setInterval(restTick, 250);
  render(html`<${App} />`, root);
  navigator.storage?.persisted?.().then(p => p || navigator.storage.persist()).catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
