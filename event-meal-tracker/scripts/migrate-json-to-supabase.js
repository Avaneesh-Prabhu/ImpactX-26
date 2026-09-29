// One-time helper: copies an existing server/data/db.json into Supabase.
// Usage:  node scripts/migrate-json-to-supabase.js [path/to/db.json]
// Requires DATABASE_URL in .env and supabase/schema.sql already applied.
// It REPLACES whatever is currently in the Supabase tables.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../server/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(__dirname, '..', 'server', 'data', 'db.json');
const db = JSON.parse(fs.readFileSync(file, 'utf-8'));

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('truncate participants, logs, meal_history, meals, users, app_state');

  for (const p of db.participants || []) {
    await client.query('insert into participants (uid,name,team,dietary,notes) values ($1,$2,$3,$4,$5)',
      [p.uid, p.name, p.team, p.dietary ?? null, p.notes ?? null]);
  }
  for (const [i, m] of (db.meals || []).entries()) {
    await client.query('insert into meals (id,name,start_time,end_time,description,sort_order) values ($1,$2,$3,$4,$5,$6)',
      [m.id, m.name, m.startTime, m.endTime, m.description ?? null, i]);
  }
  for (const u of db.users || []) {
    await client.query('insert into users (id,name,usn,password_hash,role,created_at) values ($1,$2,$3,$4,$5,$6)',
      [u.id, u.name, u.usn, u.passwordHash, u.role, u.createdAt]);
  }
  const insLog = (l) => client.query(
    `insert into logs (id,participant_uid,participant_name,team,meal_id,meal_name,scanned_at,scanned_by_usn)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
    [l.id, l.participantUid, l.participantName, l.team, l.mealId, l.mealName, l.scannedAt, l.scannedByUsn]);
  for (const l of db.logs || []) await insLog(l);
  for (const h of db.mealHistory || []) {
    await client.query(
      'insert into meal_history (id,meal_id,meal_name,archived_at,total_served,logs) values ($1,$2,$3,$4,$5,$6::jsonb)',
      [h.id, h.mealId, h.mealName, h.archivedAt, h.totalServed, JSON.stringify(h.logs || [])]);
  }
  await client.query(`insert into app_state (key,value) values ('timeOverride',$1::jsonb),('lastActiveMealId',$2::jsonb)`,
    [JSON.stringify(db.timeOverride ?? null), JSON.stringify(db.lastActiveMealId ?? null)]);

  await client.query('COMMIT');
  console.log(`Imported ${db.participants?.length || 0} participants, ${db.meals?.length || 0} meals, ` +
    `${db.users?.length || 0} users, ${db.logs?.length || 0} logs, ${db.mealHistory?.length || 0} history entries.`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Migration failed, nothing was changed:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
