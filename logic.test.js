process.env.TZ = 'Europe/Warsaw';   // makes the toISOString() midnight bug reproducible on any machine

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { SEED, MUSCLES } from './exercises.js';
import {
  num, today, isValidDate, previousSets, draftToWorkout, workoutToDraft, draftFromDay, isDraft, normalizePlan,
  newCustomExercise, parseMeasurement, exerciseSeries, bodySeries, buildBackup, validateBackup, norm, exName, fmtSet,
} from './logic.js';

test('num', () => {
  assert.equal(num('80,5'), 80.5);
  assert.equal(num('80.5'), 80.5);
  assert.equal(num('82,'), 82);
  assert.equal(num(' 7 '), 7);
  assert.equal(num(''), null);
  assert.equal(num('  '), null);
  for (const s of ['8o', '-5', '1e3', '1,2,3', 'abc']) assert.ok(Number.isNaN(num(s)), s);
  assert.ok(Number.isNaN(num('8.5', { int: true })));
  assert.equal(num('8', { int: true }), 8);
  assert.equal(fmtSet({ weight: 11.25, reps: 10 }), '11.25 × 10');   // previous weight must show what was lifted
  assert.equal(fmtSet({ weight: null, reps: 12 }), 'BW × 12');
});

test('dates', () => {
  assert.equal(today(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-2-3'), false);
  assert.equal(isValidDate('2026-02-28'), true);
  assert.equal(isValidDate(undefined), false);
});

const W = (id, date, createdAt, sets, exerciseId = 'barbell-bench-press', planId = 'p1') =>
  ({ id, date, createdAt, planId, dayId: 'd1', planName: 'PPL', dayName: 'Push',
     entries: [{ exerciseId, name: 'Barbell Bench Press', sets }] });

test('previousSets', () => {
  const s1 = [{ weight: 80, reps: 8 }], s2 = [{ weight: 82.5, reps: 6 }];
  const ws = [W('a', '2026-10-01', 1, s1, undefined, 'other-plan'), W('b', '2026-10-05', 2, s2), W('c', '2026-10-09', 3, [{ weight: 90, reps: 1 }])];
  assert.deepEqual(previousSets(ws, 'barbell-bench-press', { id: null, date: '2026-10-08', createdAt: 9 }).sets, s2);
  // a different plan counts
  assert.deepEqual(previousSets(ws.slice(0, 1), 'barbell-bench-press', { id: null, date: '2026-10-08', createdAt: 9 }).sets, s1);
  // editing b: previous is the session before it
  assert.deepEqual(previousSets(ws, 'barbell-bench-press', { id: 'b', date: '2026-10-05', createdAt: 2 }).sets, s1);
  // same date ordered by createdAt
  const same = [W('x', '2026-10-05', 10, s1), W('y', '2026-10-05', 20, s2)];
  assert.deepEqual(previousSets(same, 'barbell-bench-press', { id: null, date: '2026-10-05', createdAt: 30 }).sets, s2);
  assert.deepEqual(previousSets(same, 'barbell-bench-press', { id: null, date: '2026-10-05', createdAt: 15 }).sets, s1);
  // entries without sets are skipped, nothing → null
  assert.equal(previousSets([W('e', '2026-10-01', 1, [])], 'barbell-bench-press', { id: null, date: '2026-10-08', createdAt: 9 }), null);
  assert.equal(previousSets(ws, 'squat', { id: null, date: '2026-10-08', createdAt: 9 }), null);
});

const draft = (sets, extra = {}) => ({
  workoutId: null, planId: 'p1', dayId: 'd1', planName: 'PPL', dayName: 'Push', date: '2026-10-16', createdAt: 5,
  entries: [{ exerciseId: 'barbell-bench-press', name: 'Barbell Bench Press', sets }], ...extra,
});

test('draftToWorkout', () => {
  let r = draftToWorkout(draft([{ w: '80,5', r: '8' }, { w: '', r: '' }, { w: '', r: '12' }]));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.workout.entries[0].sets, [{ weight: 80.5, reps: 8 }, { weight: null, reps: 12 }]);
  assert.equal(r.workout.createdAt, 5);

  r = draftToWorkout(draft([{ w: '80', r: '8' }, { w: '80', r: '8o' }]));
  assert.equal(r.workout, null);
  assert.deepEqual(r.errors, [{ entry: 0, set: 1, field: 'r' }]);
  assert.deepEqual(draftToWorkout(draft([{ w: '1200', r: '5' }])).errors, [{ entry: 0, set: 0, field: 'w' }]);
  assert.deepEqual(draftToWorkout(draft([{ w: '80', r: '0' }])).errors, [{ entry: 0, set: 0, field: 'r' }]);

  r = draftToWorkout(draft([{ w: '80', r: '8' }, { w: '80', r: '' }]));
  assert.equal(r.warnings.length, 1);
  assert.equal(r.workout.entries[0].sets.length, 1);

  assert.deepEqual(draftToWorkout(draft([{ w: '', r: '' }])).errors, [{ msg: 'Nothing logged yet' }]);
  assert.equal(draftToWorkout(draft([{ w: '80', r: '8' }], { date: '2026-02-30' })).errors[0].field, 'date');

  // empty entries are dropped
  const d = draft([{ w: '80', r: '8' }]);
  d.entries.push({ exerciseId: 'deadlift', name: 'Deadlift', sets: [{ w: '', r: '' }] });
  assert.equal(draftToWorkout(d).workout.entries.length, 1);

  // editing keeps id and createdAt; round trip is lossless
  const w = { id: 'w1', date: '2026-10-01', createdAt: 42, planId: 'p1', dayId: 'd1', planName: 'PPL', dayName: 'Push',
    entries: [{ exerciseId: 'barbell-bench-press', name: 'Barbell Bench Press', sets: [{ weight: 77.5, reps: 7 }, { weight: null, reps: 10 }] }] };
  assert.deepEqual(draftToWorkout(workoutToDraft(w), []).workout, w);
  assert.ok(isDraft(workoutToDraft(w)));
  assert.equal(isDraft({ entries: 'x' }), false);
  assert.equal(isDraft(null), false);
});

test('normalizePlan', () => {
  const p = normalizePlan({ id: 'p', name: '  ', createdAt: 1, days: [
    { id: 'a', name: 'Push', exercises: [{ exerciseId: 'deadlift', sets: 0 }] },
    { id: 'b', name: '', exercises: [{ exerciseId: 'deadlift', sets: 15 }] },
  ] });
  assert.equal(p.name, 'Untitled plan');
  assert.equal(p.days[1].name, 'Day 2');
  assert.equal(p.days[0].exercises[0].sets, 1);
  assert.equal(p.days[1].exercises[0].sets, 10);
  assert.equal(normalizePlan({ id: 'p', name: 'x'.repeat(70), createdAt: 1, days: [] }).name.length, 60);
});

test('newCustomExercise', () => {
  assert.ok(newCustomExercise('  ', 'Chest', []).error);
  assert.ok(newCustomExercise('barbell  BENCH press', 'Chest', []).error);   // duplicate of a seed by norm
  const { exercise } = newCustomExercise('  Landmine   Press ', 'Shoulders', []);
  assert.equal(exercise.name, 'Landmine Press');
  assert.ok(exercise.id.startsWith('c-'));
  assert.ok(newCustomExercise('landmine press', 'Other', [exercise]).error);
  assert.equal(newCustomExercise('y'.repeat(70), 'Nope', []).exercise.name.length, 60);
  assert.equal(newCustomExercise('Wyciskanie łańcuchy', 'Nope', []).exercise.muscle, 'Other');
  assert.equal(norm('Wyciskanie Łańcuchy'), 'wyciskanie lancuchy');
  assert.equal(exName('c-x', 'Old name', [{ id: 'c-x', name: 'New name' }]), 'New name');
  assert.equal(exName('gone', 'Old name', []), 'Old name');
});

test('parseMeasurement', () => {
  let r = parseMeasurement({ mass: '82,4', waist: '', chest: '102' }, '2026-10-16');
  assert.deepEqual(r, { values: { mass: 82.4, chest: 102 }, errors: {} });
  assert.ok(parseMeasurement({ mass: '5' }, '2026-10-16').errors.mass);
  assert.ok(parseMeasurement({}, '2026-10-16').errors.form);
  assert.ok(parseMeasurement({ mass: '80' }, 'nope').errors.date);
  assert.equal(Object.keys(parseMeasurement({ mass: '5' }, 'nope').errors)[0], 'date');   // focus order follows the form
});

test('series', () => {
  const ws = [
    W('a', '2026-10-01', 1, [{ weight: 80, reps: 8 }, { weight: 85, reps: 5 }]),
    W('b', '2026-10-01', 2, [{ weight: 87.5, reps: 3 }]),
    W('c', '2026-10-05', 3, [{ weight: null, reps: 15 }]),
  ];
  assert.deepEqual(exerciseSeries(ws, 'barbell-bench-press', 'weight'), [{ date: '2026-10-01', value: 87.5 }]);
  assert.deepEqual(exerciseSeries(ws, 'barbell-bench-press', 'reps'), [{ date: '2026-10-01', value: 8 }, { date: '2026-10-05', value: 15 }]);
  const ms = [
    { id: '1', date: '2026-10-02', createdAt: 2, mass: 82 },
    { id: '2', date: '2026-10-01', createdAt: 1, mass: 83, waist: 85 },
    { id: '3', date: '2026-10-02', createdAt: 3, mass: 81.5 },
  ];
  assert.deepEqual(bodySeries(ms, 'mass'), [{ date: '2026-10-01', value: 83 }, { date: '2026-10-02', value: 81.5 }]);
  assert.deepEqual(bodySeries(ms, 'waist'), [{ date: '2026-10-01', value: 85 }]);
  assert.deepEqual(bodySeries(ms, 'chest'), []);
});

test('validateBackup', () => {
  // Built only from writer outputs: the app must never produce a backup it refuses.
  const { exercise } = newCustomExercise('Landmine Press', 'Shoulders', []);
  const plan = normalizePlan({ id: 'p1', name: '', createdAt: 1, days: [
    { id: 'd1', name: '', exercises: [{ exerciseId: 'barbell-bench-press', sets: 3 }, { exerciseId: exercise.id, sets: 2 }] },
    { id: 'd2', name: 'Empty day', exercises: [] },
  ] });
  const d = draftFromDay(plan, plan.days[0], [exercise], '2026-10-16', 7);
  d.entries[0].sets[0] = { w: '80', r: '8' };
  d.entries[1].sets[0] = { w: '', r: '12' };
  const { workout } = draftToWorkout(d, [exercise]);
  const m = { id: 'm1', date: '2026-10-16', createdAt: 8, ...parseMeasurement({ mass: '82,4', waist: '84' }, '2026-10-16').values };
  const data = { exercises: [exercise], plans: [plan], workouts: [workout], measurements: [m] };
  const backup = JSON.parse(JSON.stringify(buildBackup(data)));
  const ok = validateBackup(backup);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.data, data);

  // unknown keys are dropped
  const extra = structuredClone(backup);
  extra.workouts[0].hacked = true;
  assert.equal('hacked' in validateBackup(extra).data.workouts[0], false);

  // a custom name equal to a seed name is accepted
  const seedName = structuredClone(backup);
  seedName.exercises[0].name = 'Deadlift';
  assert.deepEqual(validateBackup(seedName).errors, []);

  const bad = [
    b => { b.app = 'other'; },
    b => { b.format = 2; },
    b => { b.workouts = null; },
    b => { b.workouts[0].date = '2026-02-30'; },
    b => { b.workouts.push(structuredClone(b.workouts[0])); },
    b => { b.plans[0].days[1].id = 'd1'; },
    b => { b.plans[0].days[0].exercises[0].sets = 0; },
    b => { b.workouts[0].entries[0].sets[0].reps = 1.5; },
    b => { b.workouts[0].entries[0].sets[0].reps = 'abc'; },
    b => { b.plans[0].days[0].exercises[0].exerciseId = 'nope'; },
    b => { b.exercises[0].id = 'deadlift'; },
    b => { b.measurements[0] = { id: 'm1', date: '2026-10-16', createdAt: 1 }; },
    b => { b.plans[0].name = 7; },
  ];
  for (const mutate of bad) {
    const b = structuredClone(backup);
    mutate(b);
    const r = validateBackup(b);
    assert.ok(r.errors.length && r.data === null, mutate.toString());
  }
  const b = structuredClone(backup);
  b.workouts[0].entries[0].sets[0].reps = 'abc';
  assert.match(validateBackup(b).errors[0], /^workouts\[0\]\.entries\[0\]\.sets\[0\]\.reps:/);
});

test('seeds', () => {
  assert.equal(SEED.length, 86);
  assert.equal(new Set(SEED.map(e => e.id)).size, 86);
  assert.equal(new Set(SEED.map(e => norm(e.name))).size, 86);
  for (const e of SEED) {
    assert.match(e.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(!e.id.startsWith('c-'), e.id);
    assert.ok(MUSCLES.includes(e.muscle), e.muscle);
  }
});

test('every precached file exists', () => {
  const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  const files = JSON.parse(sw.match(/const FILES = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  for (const f of files) if (f !== './') assert.ok(existsSync(new URL(f, import.meta.url)), f);
});
