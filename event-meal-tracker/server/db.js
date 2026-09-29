import 'dotenv/config';
import pg from 'pg';
import { SEED_MEALS, SEED_USERS } from './seedData.js';

// Event timezone: meal windows are evaluated in this zone on the server AND on
// every client, so devices in different timezones agree on the active meal.
export const EVENT_TIMEZONE = process.env.EVENT_TIMEZONE || 'Asia/Kolkata';

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set. Copy .env.example to .env and paste your Supabase Postgres connection string.'
  );
  process.exit(1);
}

// Supabase requires TLS. Its pooler certs are not in Node's default CA store,
// so we encrypt but don't verify the chain (standard for Supabase + node-postgres).
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: Number(process.env.DATABASE_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000
});
pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

const ROLLOVER_LOCK_KEY = 727001; // arbitrary constant for pg_advisory_xact_lock

// ---------- row <-> object mappers (DB is snake_case, frontend is camelCase) ----------
const toIso = (v) => (v instanceof Date ? v.toISOString() : v);

const rowToParticipant = (r) => {
  const p = { uid: r.uid, name: r.name, team: r.team };
  if (r.dietary != null) p.dietary = r.dietary;
  if (r.notes != null) p.notes = r.notes;
  return p;
};
const rowToMeal = (r) => ({
  id: r.id,
  name: r.name,
  startTime: r.start_time,
  endTime: r.end_time,
  description: r.description ?? undefined
});
const rowToLog = (r) => ({
  id: r.id,
  participantUid: r.participant_uid,
  participantName: r.participant_name,
  team: r.team,
  mealId: r.meal_id,
  mealName: r.meal_name,
  scannedAt: toIso(r.scanned_at),
  scannedByUsn: r.scanned_by_usn
});
const rowToUser = (r) => ({
  id: r.id,
  name: r.name,
  usn: r.usn,
  passwordHash: r.password_hash,
  role: r.role,
  createdAt: toIso(r.created_at)
});
const rowToHistory = (r) => ({
  id: r.id,
  mealId: r.meal_id,
  mealName: r.meal_name,
  archivedAt: toIso(r.archived_at),
  totalServed: r.total_served,
  logs: r.logs
});

// `q` is either the pool or a transaction client — both have .query()
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

// ---------- low-level readers ----------
const qParticipants = async (q = pool) =>
  (await q.query('select * from participants order by uid')).rows.map(rowToParticipant);
const qMeals = async (q = pool) =>
  (await q.query('select * from meals order by sort_order, start_time')).rows.map(rowToMeal);
const qLogs = async (q = pool) =>
  (await q.query('select * from logs order by scanned_at desc, id desc')).rows.map(rowToLog);
const qUsers = async (q = pool) =>
  (await q.query('select * from users order by created_at, id')).rows.map(rowToUser);
const qHistory = async (q = pool) =>
  (await q.query('select * from meal_history order by archived_at, id')).rows.map(rowToHistory);

async function getStateValue(key, q = pool) {
  const { rows } = await q.query('select value from app_state where key = $1', [key]);
  return rows.length ? rows[0].value : null;
}
async function setStateValue(key, value, q = pool) {
  await q.query(
    `insert into app_state (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value ?? null)]
  );
}

// ---------- startup ----------
async function insertSeedMeals(q) {
  for (let i = 0; i < SEED_MEALS.length; i++) {
    const m = SEED_MEALS[i];
    await q.query(
      `insert into meals (id, name, start_time, end_time, description, sort_order)
       values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing`,
      [m.id, m.name, m.startTime, m.endTime, m.description ?? null, i]
    );
  }
}
async function insertSeedUsers(q) {
  for (const u of SEED_USERS) {
    await q.query(
      `insert into users (id, name, usn, password_hash, role, created_at)
       values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
      [u.id, u.name, u.usn, u.passwordHash, u.role, u.createdAt]
    );
  }
}

/**
 * Verifies the connection + schema and seeds default meals/volunteers on a
 * brand-new database. Only seeds a table that is completely empty, so it never
 * touches data you've already entered.
 */
export async function initDb() {
  try {
    await pool.query('select 1 from participants limit 1');
    await pool.query('select 1 from app_state limit 1');
  } catch (err) {
    if (err.code === '42P01') {
      throw new Error('Tables not found. Run supabase/schema.sql in the Supabase SQL Editor first.');
    }
    throw err;
  }

  await withTx(async (q) => {
    const meals = await q.query('select count(*)::int as n from meals');
    if (meals.rows[0].n === 0) await insertSeedMeals(q);
    const users = await q.query('select count(*)::int as n from users');
    if (users.rows[0].n === 0) await insertSeedUsers(q);
  });

  await rolloverIfNeeded();
}

// ---------- shared clock ----------
export function getCurrentClockTime(timeOverride) {
  if (timeOverride) return timeOverride;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: EVENT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const hours = parts.find((p) => p.type === 'hour').value;
  const minutes = parts.find((p) => p.type === 'minute').value;
  return `${hours}:${minutes}`;
}

/** Handles windows crossing midnight (e.g., 22:00 to 02:00) */
export function isTimeInWindow(curr, start, end) {
  if (start <= end) return curr >= start && curr < end;
  return curr >= start || curr < end;
}

export function getActiveMeal(meals, timeOverride) {
  const curr = getCurrentClockTime(timeOverride);
  return meals.find((m) => isTimeInWindow(curr, m.startTime, m.endTime)) || null;
}

export function getNextMeal(meals, timeOverride) {
  const curr = getCurrentClockTime(timeOverride);
  const sorted = [...meals].sort((a, b) => a.startTime.localeCompare(b.startTime));
  return sorted.find((m) => m.startTime > curr) || sorted[0] || null;
}

// ---------- full state ----------
/** Returns the full shared state exactly as the frontend's StorageService expects it. */
export async function getFullState() {
  const [participants, meals, logs, users, timeOverride, mealHistory] = await Promise.all([
    qParticipants(),
    qMeals(),
    qLogs(),
    qUsers(),
    getStateValue('timeOverride'),
    qHistory()
  ]);
  return {
    participants,
    meals,
    logs,
    users,
    timeOverride: timeOverride ?? null,
    mealHistory,
    timezone: EVENT_TIMEZONE,
    serverTime: getCurrentClockTime(timeOverride)
  };
}

export async function resetToDefault() {
  await withTx(async (q) => {
    await q.query('truncate participants, logs, meal_history, meals, users, app_state');
    await insertSeedMeals(q);
    await insertSeedUsers(q);
    const meals = await qMeals(q);
    const active = getActiveMeal(meals, null);
    await setStateValue('lastActiveMealId', active?.id ?? null, q);
  });
  return getFullState();
}

// ---------- participants ----------
export async function getParticipants() {
  return qParticipants();
}

export async function addParticipant(p) {
  const { rowCount } = await pool.query(
    `insert into participants (uid, name, team, dietary, notes) values ($1,$2,$3,$4,$5)
     on conflict (uid) do nothing`,
    [p.uid, p.name, p.team, p.dietary ?? null, p.notes ?? null]
  );
  if (rowCount === 0) {
    return { success: false, message: `UID #${p.uid} is already registered.` };
  }
  return { success: true, participants: await qParticipants() };
}

/**
 * Bulk-add participants, skipping any UID that already exists in the DB
 * (or duplicated within the same batch).
 */
export async function bulkAddParticipants(newParticipants) {
  const seen = new Set();
  const unique = [];
  for (const p of newParticipants) {
    if (seen.has(p.uid)) continue;
    seen.add(p.uid);
    unique.push(p);
  }

  let added = [];
  if (unique.length > 0) {
    const { rows } = await pool.query(
      `insert into participants (uid, name, team, dietary, notes)
       select * from unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[])
       on conflict (uid) do nothing
       returning *`,
      [
        unique.map((p) => p.uid),
        unique.map((p) => p.name),
        unique.map((p) => p.team),
        unique.map((p) => p.dietary ?? null),
        unique.map((p) => p.notes ?? null)
      ]
    );
    added = rows.map(rowToParticipant);
  }

  const total = (await pool.query('select count(*)::int as n from participants')).rows[0].n;
  return { added: added.length, addedParticipants: added, total };
}

// ---------- meals & shared clock ----------
export async function setMeals(meals) {
  await withTx(async (q) => {
    await q.query('delete from meals');
    for (let i = 0; i < meals.length; i++) {
      const m = meals[i];
      await q.query(
        `insert into meals (id, name, start_time, end_time, description, sort_order)
         values ($1,$2,$3,$4,$5,$6)`,
        [m.id, m.name, m.startTime, m.endTime, m.description ?? null, i]
      );
    }
  });
  return qMeals();
}

export async function setTimeOverride(time) {
  const value = time || null;
  await setStateValue('timeOverride', value);
  return value;
}

/**
 * Meal rollover: when the active meal changes (a meal ends or the next one
 * starts), the finished meal's logs are moved into meal_history and removed
 * from the live logs, so the next meal always starts from a clean slate while
 * the old meal's data stays stored. Returns true if anything changed.
 */
export async function rolloverIfNeeded() {
  // Cheap unlocked check first — this runs every few seconds.
  const [meals0, override0, last0] = await Promise.all([
    qMeals(),
    getStateValue('timeOverride'),
    getStateValue('lastActiveMealId')
  ]);
  if ((getActiveMeal(meals0, override0)?.id ?? null) === (last0 ?? null)) return false;

  return withTx(async (q) => {
    // Serialize so two server instances (or a scan + the timer) can't archive twice.
    await q.query('select pg_advisory_xact_lock($1)', [ROLLOVER_LOCK_KEY]);

    const meals = await qMeals(q);
    const override = await getStateValue('timeOverride', q);
    const activeId = getActiveMeal(meals, override)?.id ?? null;
    const lastId = (await getStateValue('lastActiveMealId', q)) ?? null;
    if (activeId === lastId) return false;

    if (lastId) {
      const finished = (await q.query('select * from logs where meal_id = $1 order by scanned_at desc, id desc', [lastId]))
        .rows.map(rowToLog);
      if (finished.length > 0) {
        const meal = meals.find((m) => m.id === lastId);
        await q.query(
          `insert into meal_history (id, meal_id, meal_name, archived_at, total_served, logs)
           values ($1,$2,$3,now(),$4,$5::jsonb)`,
          [
            `hist_${Date.now()}`,
            lastId,
            meal ? meal.name : finished[0].mealName,
            finished.length,
            JSON.stringify(finished)
          ]
        );
        await q.query('delete from logs where meal_id = $1', [lastId]);
      }
    }
    await setStateValue('lastActiveMealId', activeId, q);
    return true;
  });
}

// ---------- users & authentication ----------
export async function getUsers() {
  return qUsers();
}

export async function addVolunteer(name, usn, password, role = 'Volunteer') {
  const cleanUsn = usn.trim().toUpperCase();
  const newUser = {
    id: `user_${Date.now()}`,
    name: name.trim(),
    usn: cleanUsn,
    passwordHash: password,
    role: (role || '').trim() || 'Volunteer',
    createdAt: new Date().toISOString()
  };
  const { rowCount } = await pool.query(
    `insert into users (id, name, usn, password_hash, role, created_at)
     values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
    [newUser.id, newUser.name, newUser.usn, newUser.passwordHash, newUser.role, newUser.createdAt]
  );
  if (rowCount === 0) {
    return { success: false, message: `A volunteer with USN ${cleanUsn} is already registered.` };
  }
  return { success: true, user: newUser, users: await qUsers() };
}

// ---------- meal logs & scanning ----------
export async function getLogs() {
  return qLogs();
}

export async function processScan(rawInput, volunteerUsn) {
  await rolloverIfNeeded();
  const nowIso = new Date().toISOString();

  // 1. Extract numeric UID (handles pure number, string number, or formatted
  // QR text like "UID:1004" or "https://.../1004")
  let uid;
  if (typeof rawInput === 'number') {
    uid = rawInput;
  } else {
    const cleaned = String(rawInput).trim();
    const match = cleaned.match(/\b\d{3,6}\b/);
    if (match) {
      uid = parseInt(match[0], 10);
    } else {
      const parsed = parseInt(cleaned, 10);
      if (isNaN(parsed)) {
        return { status: 'INVALID_PARTICIPANT', message: `Unrecognized QR format: "${rawInput}"`, timestamp: nowIso };
      }
      uid = parsed;
    }
  }

  // 2. Lookup participant
  const pRes = await pool.query('select * from participants where uid = $1', [uid]);
  if (pRes.rows.length === 0) {
    return { status: 'INVALID_PARTICIPANT', message: `Participant #${uid} not found in guest registry.`, timestamp: nowIso };
  }
  const participant = rowToParticipant(pRes.rows[0]);

  // 3. Check active meal
  const [meals, timeOverride] = await Promise.all([qMeals(), getStateValue('timeOverride')]);
  const activeMeal = getActiveMeal(meals, timeOverride);
  if (!activeMeal) {
    const nextMeal = getNextMeal(meals, timeOverride);
    return {
      status: 'NO_ACTIVE_MEAL',
      message: `No meal active right now (Current time: ${getCurrentClockTime(timeOverride)}). Next: ${nextMeal ? nextMeal.name + ' at ' + nextMeal.startTime : 'None scheduled'}`,
      participant,
      timestamp: nowIso
    };
  }

  // 4 + 5. Atomic "insert if not already scanned". The unique constraint on
  // (participant_uid, meal_id) means two volunteers scanning the same guest at
  // the same instant can never both succeed.
  const newLog = {
    id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    participantUid: participant.uid,
    participantName: participant.name,
    team: participant.team,
    mealId: activeMeal.id,
    mealName: activeMeal.name,
    scannedAt: nowIso,
    scannedByUsn: volunteerUsn || 'VOLUNTEER'
  };
  const ins = await pool.query(
    `insert into logs (id, participant_uid, participant_name, team, meal_id, meal_name, scanned_at, scanned_by_usn)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (participant_uid, meal_id) do nothing`,
    [newLog.id, newLog.participantUid, newLog.participantName, newLog.team, newLog.mealId, newLog.mealName, newLog.scannedAt, newLog.scannedByUsn]
  );

  if (ins.rowCount === 0) {
    const ex = await pool.query('select * from logs where participant_uid = $1 and meal_id = $2', [uid, activeMeal.id]);
    return {
      status: 'ALREADY_SCANNED',
      message: `${participant.name} already fed for ${activeMeal.name}`,
      participant,
      meal: activeMeal,
      existingLog: ex.rows[0] ? rowToLog(ex.rows[0]) : undefined,
      timestamp: nowIso
    };
  }

  return {
    status: 'SUCCESS',
    message: `${participant.name} marked for ${activeMeal.name}`,
    participant,
    meal: activeMeal,
    timestamp: nowIso,
    logId: newLog.id
  };
}

export async function undoScan(logId) {
  const { rowCount } = await pool.query('delete from logs where id = $1', [logId]);
  return rowCount > 0;
}
