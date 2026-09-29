import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import {
  getFullState,
  resetToDefault,
  addParticipant,
  bulkAddParticipants,
  setMeals,
  setTimeOverride,
  getUsers,
  addVolunteer,
  processScan,
  undoScan,
  rolloverIfNeeded,
  initDb
} from './db.js';
import { parseParticipantsWorkbook } from './participantImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const DIST_DIR = path.join(__dirname, '..', 'dist');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Accept the uploaded file in memory — files are small (a guest list),
// so there's no need to write the raw upload to disk first.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Broadcasts the full shared state to every connected client (dashboard,
// scanner stations, registry, etc.) so everyone stays in sync. The state is
// small (an event's worth of participants/logs), so sending the whole thing
// on every change is simpler and more robust than diffing.
async function broadcastState(reason) {
  try {
    io.emit('data-updated', { reason, state: await getFullState() });
  } catch (err) {
    console.error('Broadcast failed:', err);
  }
}

// Express 4 doesn't catch rejected promises from async handlers on its own.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

io.on('connection', async (socket) => {
  console.log(`[socket] client connected: ${socket.id}`);
  // Send the newly-connected client the current state right away, in case
  // it missed the initial REST fetch or reconnected after a drop.
  try {
    socket.emit('data-updated', { reason: 'initial-sync', state: await getFullState() });
  } catch (err) {
    console.error('Initial sync failed:', err);
  }

  socket.on('disconnect', () => {
    console.log(`[socket] client disconnected: ${socket.id}`);
  });
});

// Check every few seconds whether a meal window has ended/started; if so,
// archive the finished meal and push the fresh state to every device.
let rolloverRunning = false;
setInterval(async () => {
  if (rolloverRunning) return;
  rolloverRunning = true;
  try {
    if (await rolloverIfNeeded()) await broadcastState('meal-rollover');
  } catch (err) {
    console.error('Rollover check failed:', err);
  } finally {
    rolloverRunning = false;
  }
}, 5000);

app.get('/api/health', wrap(async (_req, res) => {
  res.json({ ok: true });
}));

// Full bootstrap snapshot for a freshly-loaded client.
app.get('/api/state', wrap(async (_req, res) => {
  res.json(await getFullState());
}));

app.get('/api/participants', wrap(async (_req, res) => {
  res.json({ participants: (await getFullState()).participants });
}));

app.post('/api/participants', wrap(async (req, res) => {
  const { uid, name, team, dietary, notes } = req.body || {};
  if (!uid || !name || !team) {
    return res.status(400).json({ success: false, message: 'uid, name and team are required.' });
  }

  const result = await addParticipant({ uid: Number(uid), name, team, dietary, notes });
  if (result.success) {
    await broadcastState('participant-added');
  }
  res.json(result);
}));

// Used by the client-side Excel import flow (src/services/excelImport.ts
// parses the workbook in-browser, then hands the resulting rows here so
// every connected dashboard picks them up).
app.post('/api/participants/bulk', wrap(async (req, res) => {
  const participants = req.body?.participants;
  if (!Array.isArray(participants)) {
    return res.status(400).json({ success: false, added: 0, message: 'participants array is required.' });
  }

  const { added, total } = await bulkAddParticipants(participants);
  if (added > 0) {
    await broadcastState('participants-imported');
  }
  res.json({ success: true, added, totalParticipants: total });
}));

app.post('/api/import-participants', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      added: 0,
      skipped: 0,
      errors: ['No file uploaded. Attach the spreadsheet under the "file" field.']
    });
  }

  try {
    const { toAdd, errors, skipped } = await parseParticipantsWorkbook(req.file.buffer);
    const { added, total } = await bulkAddParticipants(toAdd);

    if (added > 0) {
      await broadcastState('participants-imported');
    }

    res.json({ success: true, added, skipped, errors, totalParticipants: total });
  } catch (err) {
    console.error('Import failed:', err);
    res.status(500).json({
      success: false,
      added: 0,
      skipped: 0,
      errors: [`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`]
    });
  }
}));

app.post('/api/meals', wrap(async (req, res) => {
  const meals = req.body?.meals;
  if (!Array.isArray(meals)) {
    return res.status(400).json({ success: false, message: 'meals array is required.' });
  }
  await setMeals(meals);
  await rolloverIfNeeded();
  await broadcastState('meals-updated');
  res.json({ success: true, meals });
}));

app.post('/api/time-override', wrap(async (req, res) => {
  const time = req.body?.time ?? null;
  const stored = await setTimeOverride(time);
  await rolloverIfNeeded();
  await broadcastState('time-override-updated');
  res.json({ success: true, timeOverride: stored });
}));

app.get('/api/users', wrap(async (_req, res) => {
  res.json({ users: await getUsers() });
}));

app.post('/api/users', wrap(async (req, res) => {
  const { name, usn, password, role } = req.body || {};
  if (!name || !usn || !password) {
    return res.status(400).json({ success: false, message: 'name, usn and password are required.' });
  }
  const result = await addVolunteer(name, usn, password, role);
  if (result.success) {
    await broadcastState('volunteer-added');
  }
  res.json(result);
}));

app.post('/api/scan', wrap(async (req, res) => {
  const { rawInput, volunteerUsn } = req.body || {};
  if (rawInput === undefined || rawInput === null || rawInput === '') {
    return res.status(400).json({ status: 'INVALID_PARTICIPANT', message: 'No UID provided.', timestamp: new Date().toISOString() });
  }
  const result = await processScan(rawInput, volunteerUsn);
  if (result.status === 'SUCCESS') {
    await broadcastState('scan-logged');
  }
  res.json(result);
}));

app.post('/api/scan/undo', wrap(async (req, res) => {
  const { logId } = req.body || {};
  const success = await undoScan(logId);
  if (success) {
    await broadcastState('scan-undone');
  }
  res.json({ success });
}));

app.post('/api/reset', wrap(async (_req, res) => {
  const state = await resetToDefault();
  await broadcastState('reset-to-default');
  res.json({ success: true, state });
}));

// Central error handler for anything thrown inside an async route.
app.use('/api', (err, _req, res, _next) => {
  console.error('API error:', err);
  res.status(500).json({ success: false, message: 'Server error. Please try again.' });
});

// Serve the built frontend (npm run build -> dist/) when it exists, so a
// single deployed service can host both the API and the site — no separate
// static host, no CORS to configure between two origins.
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
  console.log('Serving built frontend from', DIST_DIR);
} else {
  console.log('No dist/ build found — run `npm run build` to serve the frontend from this server too.');
}

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Event Meal Tracker server listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start:', err.message || err);
    process.exit(1);
  });
