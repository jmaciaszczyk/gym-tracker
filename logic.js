// Pure functions: no DOM, no IndexedDB. Everything here is covered by logic.test.js.
import { SEED, MUSCLES } from './exercises.js';

export const STORES = ['exercises', 'plans', 'workouts', 'measurements'];
export const FORMAT = 1;
export const LIMITS = { name: 60, sets: [1, 10], weight: [0, 1000], reps: [1, 999], mass: [20, 400], cm: [10, 250] };
export const MEASURES = [['mass', 'Body mass', 'kg'], ['chest', 'Chest', 'cm'], ['waist', 'Waist', 'cm'], ['hips', 'Hips', 'cm'],
  ['bicepsL', 'Biceps L', 'cm'], ['bicepsR', 'Biceps R', 'cm'], ['thighL', 'Thigh L', 'cm'], ['thighR', 'Thigh R', 'cm'],
  ['calf', 'Calf', 'cm'], ['neck', 'Neck', 'cm'], ['forearm', 'Forearm', 'cm']];

const SEED_BY_ID = new Map(SEED.map(e => [e.id, e]));
const uuid = () => crypto.randomUUID();

// '' → null (blank), anything that is not a plain non-negative decimal → NaN. Accepts ',' and a trailing separator ('82,').
export function num(s, { int = false } = {}) {
  s = String(s ?? '').trim();
  if (!s) return null;
  if (!/^(\d+([.,]\d*)?|[.,]\d+)$/.test(s)) return NaN;
  const n = Number(s.replace(',', '.'));
  return int && !Number.isInteger(n) ? NaN : n;
}
export const inRange = (n, [lo, hi], int = false) => Number.isFinite(n) && n >= lo && n <= hi && (!int || Number.isInteger(n));
export const cleanName = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name).trimEnd();
export const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/ł/g, 'l').replace(/\s+/g, ' ').trim();

const pad = n => String(n).padStart(2, '0');
export const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
export const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const dayNumber = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };

export const fmtNum = n => String(Math.round(n * 100) / 100);
export const fmtSet = s => `${s.weight == null ? 'BW' : fmtNum(s.weight)} × ${s.reps}`;

export const exName = (id, snapshot, custom = []) =>
  SEED_BY_ID.get(id)?.name || custom.find(c => c.id === id)?.name || snapshot || 'Unknown exercise';

export function newCustomExercise(name, muscle, custom, { id = 'c-' + uuid(), createdAt = Date.now() } = {}) {
  const n = cleanName(name);
  if (!n) return { error: 'Enter a name' };
  if ([...SEED, ...custom].some(e => norm(e.name) === norm(n))) return { error: `"${n}" already exists` };
  return { exercise: { id, name: n, muscle: MUSCLES.includes(muscle) ? muscle : 'Other', createdAt } };
}

const clamp = (n, [lo, hi]) => Math.min(hi, Math.max(lo, n));

// Rest timer between sets, in seconds.
export const REST = { default: 150, step: 15, range: [15, 600] };
export const clampRest = n => Number.isFinite(n) && n > 0   // 0/NaN = nothing stored (Number(null) is 0)
  ? clamp(Math.max(1, Math.round(n / REST.step)) * REST.step, REST.range) : REST.default;
export const fmtClock = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
export const normalizePlan = p => ({
  id: p.id, name: cleanName(p.name) || 'Untitled plan', createdAt: p.createdAt,
  days: p.days.map((d, i) => ({
    id: d.id, name: cleanName(d.name) || `Day ${i + 1}`,
    exercises: d.exercises.map(e => ({ exerciseId: e.exerciseId, sets: clamp(Math.round(e.sets) || 1, LIMITS.sets) })),
  })),
});

// Latest finished workout strictly before (date, createdAt) that has sets for this exercise, ignoring the one being edited.
// ponytail: if an exercise appears twice in one workout, only the first entry counts.
export function previousSets(workouts, exerciseId, { id, date, createdAt }) {
  let best = null;
  for (const w of workouts) {
    if (w.id === id || w.date > date || (w.date === date && w.createdAt >= createdAt)) continue;
    const e = w.entries.find(e => e.exerciseId === exerciseId && e.sets.length);
    if (e && (!best || w.date > best.date || (w.date === best.date && w.createdAt > best.createdAt)))
      best = { date: w.date, createdAt: w.createdAt, sets: e.sets };
  }
  return best;
}

export const draftFromDay = (plan, day, custom, date, createdAt) => ({
  workoutId: null, planId: plan.id, dayId: day.id, planName: plan.name, dayName: day.name, date, createdAt,
  entries: day.exercises.map(e => ({
    exerciseId: e.exerciseId, name: exName(e.exerciseId, '', custom),
    sets: Array.from({ length: e.sets }, () => ({ w: '', r: '' })),
  })),
});

export const workoutToDraft = w => ({
  workoutId: w.id, planId: w.planId, dayId: w.dayId, planName: w.planName, dayName: w.dayName, date: w.date, createdAt: w.createdAt,
  entries: w.entries.map(e => ({
    exerciseId: e.exerciseId, name: e.name,
    sets: e.sets.map(s => ({ w: s.weight == null ? '' : String(s.weight), r: String(s.reps) })),
  })),
});

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string' && v.length > 0;
export const isDraft = d => isObj(d) && isStr(d.planId) && isStr(d.dayId) && typeof d.date === 'string' &&
  Number.isFinite(d.createdAt) && Array.isArray(d.entries) && d.entries.every(e => isObj(e) && isStr(e.exerciseId) &&
    Array.isArray(e.sets) && e.sets.every(s => isObj(s) && typeof s.w === 'string' && typeof s.r === 'string'));

// Field-level errors block saving; warnings need a confirm.
export function draftToWorkout(draft, custom = []) {
  const errors = [], warnings = [], entries = [];
  let skipped = 0;
  if (!isValidDate(draft.date)) errors.push({ field: 'date', msg: 'Enter a valid date' });
  draft.entries.forEach((e, entry) => {
    const sets = [];
    e.sets.forEach((s, set) => {
      const w = num(s.w), r = num(s.r, { int: true });
      if (w === null && r === null) return;
      const badW = w !== null && !inRange(w, LIMITS.weight), badR = r !== null && !inRange(r, LIMITS.reps, true);
      if (badW) errors.push({ entry, set, field: 'w' });
      if (badR) errors.push({ entry, set, field: 'r' });
      if (badW || badR) return;
      if (r === null) { skipped++; return; }
      sets.push({ weight: w, reps: r });
    });
    if (sets.length) entries.push({ exerciseId: e.exerciseId, name: exName(e.exerciseId, e.name, custom), sets });
  });
  if (skipped) warnings.push(`${skipped} set${skipped > 1 ? 's have' : ' has'} weight but no reps and will be skipped.`);
  if (!errors.length && !entries.length) errors.push({ msg: 'Nothing logged yet' });
  if (errors.length) return { workout: null, errors, warnings };
  const { workoutId, planId, dayId, planName, dayName, date, createdAt } = draft;
  return { workout: { id: workoutId ?? uuid(), date, createdAt, planId, dayId, planName, dayName, entries }, errors, warnings };
}

export function parseMeasurement(fields, date) {
  const values = {}, errors = {};
  if (!isValidDate(date)) errors.date = 'Enter a valid date';   // first, so the date field gets focus first
  for (const [k, , unit] of MEASURES) {
    const n = num(fields[k]);
    if (n === null) continue;
    const lim = k === 'mass' ? LIMITS.mass : LIMITS.cm;
    if (inRange(n, lim)) values[k] = n; else errors[k] = `Enter ${lim[0]}–${lim[1]} ${unit}`;
  }
  if (!Object.keys(values).length && !Object.keys(errors).length) errors.form = 'Enter at least one value';
  return { values, errors };
}

const byDateAsc = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

// One point per date: the best set across all of that day's workouts. metric: 'weight' | 'reps'.
export function exerciseSeries(workouts, exerciseId, metric) {
  const best = new Map();
  for (const w of workouts) for (const e of w.entries) if (e.exerciseId === exerciseId) for (const s of e.sets) {
    const v = metric === 'weight' ? (s.weight > 0 ? s.weight : null) : s.reps;
    if (v != null) best.set(w.date, Math.max(best.get(w.date) ?? -Infinity, v));
  }
  return [...best].sort(byDateAsc).map(([date, value]) => ({ date, value }));
}

// One point per date; with several entries on a date, the latest createdAt wins.
export function bodySeries(measurements, field) {
  const latest = new Map();
  for (const m of measurements) if (m[field] != null && !(latest.get(m.date)?.createdAt > m.createdAt)) latest.set(m.date, m);
  return [...latest].sort(byDateAsc).map(([date, m]) => ({ date, value: m[field] }));
}

export const buildBackup = (data, exportedAt = new Date().toISOString()) =>
  ({ app: 'gym-tracker', format: FORMAT, exportedAt, ...Object.fromEntries(STORES.map(s => [s, data[s]])) });

// Validates a parsed backup and rebuilds every record from known keys. Nothing may be written unless errors is empty.
export function validateBackup(obj) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  if (!isObj(obj) || obj.app !== 'gym-tracker') return { errors: ['Not a Gym Tracker backup file'], data: null };
  if (!Number.isInteger(obj.format) || obj.format < 1) return { errors: ['format: must be a positive integer'], data: null };
  if (obj.format > FORMAT) return { errors: ['Backup is from a newer app version. Open the app online to update, then import again.'], data: null };
  for (const s of STORES) if (!Array.isArray(obj[s])) err(s, 'must be an array');
  if (errors.length) return { errors, data: null };

  const id = (v, p, seen) => {
    if (!isStr(v)) err(p, 'must be a non-empty string');
    else if (seen.has(v)) err(p, 'duplicate id');
    else seen.add(v);
    return v;
  };
  const name = (v, p) => {
    const n = cleanName(typeof v === 'string' ? v : '');
    if (!n || v.trim().length > LIMITS.name) err(p, `must be text of 1–${LIMITS.name} characters`);   // !n short-circuits non-strings
    return n;
  };
  const str = (v, p) => { if (!isStr(v)) err(p, 'must be a non-empty string'); return v; };
  const finite = (v, p) => { if (!Number.isFinite(v)) err(p, 'must be a number'); return v; };
  const date = (v, p) => { if (!isValidDate(v)) err(p, 'must be a valid YYYY-MM-DD date'); return v; };
  const range = (v, lim, p, int = false) => {
    if (!inRange(v, lim, int)) err(p, `must be ${int ? 'an integer' : 'a number'} ${lim[0]}–${lim[1]}`);
    return v;
  };
  const list = (v, p, fn) => {
    if (!Array.isArray(v)) { err(p, 'must be an array'); return []; }
    return v.map((x, i) => isObj(x) ? fn(x, `${p}[${i}]`) : (err(`${p}[${i}]`, 'must be an object'), null));
  };

  const exIds = new Set();
  const exercises = list(obj.exercises, 'exercises', (e, p) => {
    id(e.id, `${p}.id`, exIds);
    if (isStr(e.id) && (!e.id.startsWith('c-') || SEED_BY_ID.has(e.id))) err(`${p}.id`, 'must start with "c-"');
    if (!MUSCLES.includes(e.muscle)) err(`${p}.muscle`, 'unknown muscle group');
    // A custom name may equal a seed name: seeds can be renamed later and old backups must stay restorable.
    return { id: e.id, name: name(e.name, `${p}.name`), muscle: e.muscle, createdAt: finite(e.createdAt, `${p}.createdAt`) };
  });

  const known = new Set([...SEED_BY_ID.keys(), ...exIds]), planIds = new Set();
  const plans = list(obj.plans, 'plans', (pl, p) => {
    const dayIds = new Set();
    return {
      id: id(pl.id, `${p}.id`, planIds), name: name(pl.name, `${p}.name`), createdAt: finite(pl.createdAt, `${p}.createdAt`),
      days: list(pl.days, `${p}.days`, (d, q) => ({
        id: id(d.id, `${q}.id`, dayIds), name: name(d.name, `${q}.name`),
        exercises: list(d.exercises, `${q}.exercises`, (x, r) => {
          if (!known.has(x.exerciseId)) err(`${r}.exerciseId`, 'unknown exercise');
          return { exerciseId: x.exerciseId, sets: range(x.sets, LIMITS.sets, `${r}.sets`, true) };
        }),
      })),
    };
  });

  const workoutIds = new Set();
  const workouts = list(obj.workouts, 'workouts', (w, p) => ({
    id: id(w.id, `${p}.id`, workoutIds), date: date(w.date, `${p}.date`), createdAt: finite(w.createdAt, `${p}.createdAt`),
    planId: str(w.planId, `${p}.planId`), dayId: str(w.dayId, `${p}.dayId`),
    planName: name(w.planName, `${p}.planName`), dayName: name(w.dayName, `${p}.dayName`),
    // exerciseId need not resolve: the name snapshot covers deleted or unknown exercises.
    entries: list(w.entries, `${p}.entries`, (e, q) => ({
      exerciseId: str(e.exerciseId, `${q}.exerciseId`), name: name(e.name, `${q}.name`),
      sets: list(e.sets, `${q}.sets`, (s, r) => ({
        weight: s.weight === null ? null : range(s.weight, LIMITS.weight, `${r}.weight`),
        reps: range(s.reps, LIMITS.reps, `${r}.reps`, true),
      })),
    })),
  }));

  const mIds = new Set();
  const measurements = list(obj.measurements, 'measurements', (m, p) => {
    const rec = { id: id(m.id, `${p}.id`, mIds), date: date(m.date, `${p}.date`), createdAt: finite(m.createdAt, `${p}.createdAt`) };
    for (const [k] of MEASURES) if (m[k] != null) rec[k] = range(m[k], k === 'mass' ? LIMITS.mass : LIMITS.cm, `${p}.${k}`);
    if (Object.keys(rec).length === 3) err(p, 'must have at least one measurement');
    return rec;
  });

  return errors.length ? { errors, data: null } : { errors, data: { exercises, plans, workouts, measurements } };
}
