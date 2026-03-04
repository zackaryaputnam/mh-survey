/**
 * MH Survey Server — Railway Edition
 * 
 * Sync backend for the Manhole Survey Field Collection app.
 * Uses PostgreSQL (provided free by Railway).
 *
 * Environment variables (auto-set by Railway when you add a Postgres plugin):
 *   DATABASE_URL  - PostgreSQL connection string
 *   PORT          - Server port (Railway sets this automatically)
 */

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const compression = require('compression');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ================ DATABASE ================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS manholes (
        id          TEXT NOT NULL,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        data        JSONB NOT NULL,
        updated     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id, project_id)
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mh_project ON manholes(project_id);`);
    console.log('Database tables ready');
  } finally {
    client.release();
  }
}

// ================ MIDDLEWARE ================

app.use(cors());
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ================ API ROUTES ================

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const projCount = (await pool.query('SELECT COUNT(*) AS c FROM projects')).rows[0].c;
    const mhCount = (await pool.query('SELECT COUNT(*) AS c FROM manholes')).rows[0].c;
    res.json({ status: 'ok', projects: Number(projCount), manholes: Number(mhCount) });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// List projects
app.get('/api/projects', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.name, p.created, p.updated,
             COUNT(m.id) AS manhole_count,
             SUM(CASE WHEN m.data->>'survey' IS NOT NULL AND m.data->>'survey' != 'null' THEN 1 ELSE 0 END) AS surveyed_count
      FROM projects p
      LEFT JOIN manholes m ON m.project_id = p.id
      GROUP BY p.id
      ORDER BY p.updated DESC
    `);
    res.json(result.rows.map(r => ({
      ...r,
      manhole_count: Number(r.manhole_count),
      surveyed_count: Number(r.surveyed_count)
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create project
app.post('/api/projects', async (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  try {
    await pool.query(
      `INSERT INTO projects (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = $2, updated = NOW()`,
      [id, name]
    );
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rename project
app.put('/api/projects/:id', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    await pool.query('UPDATE projects SET name = $1, updated = NOW() WHERE id = $2', [name, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete project
app.delete('/api/projects/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get manholes for a project
app.get('/api/projects/:projectId/manholes', async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM manholes WHERE project_id = $1', [req.params.projectId]);
    res.json(result.rows.map(r => r.data));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Full sync — the main endpoint for field iPads
app.post('/api/sync-all', async (req, res) => {
  const clientProjects = req.body.projects || {};
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Upsert each project and its manholes
    for (const [projId, proj] of Object.entries(clientProjects)) {
      await client.query(
        `INSERT INTO projects (id, name, created) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = $2, updated = NOW()`,
        [projId, proj.name, proj.created || new Date().toISOString()]
      );

      for (const mh of (proj.manholes || [])) {
        const updated = mh.survey?.timestamp || proj.created || new Date().toISOString();
        await client.query(
          `INSERT INTO manholes (id, project_id, data, updated) VALUES ($1, $2, $3, $4)
           ON CONFLICT (id, project_id) DO UPDATE SET
             data = CASE WHEN $4::timestamptz > manholes.updated THEN $3::jsonb ELSE manholes.data END,
             updated = CASE WHEN $4::timestamptz > manholes.updated THEN $4::timestamptz ELSE manholes.updated END`,
          [mh.id, projId, JSON.stringify(mh), updated]
        );
      }
    }

    await client.query('COMMIT');

    // Return full merged state
    const allProjects = (await client.query('SELECT id, name, created FROM projects')).rows;
    const result = {};
    for (const proj of allProjects) {
      const mhRows = (await client.query('SELECT data FROM manholes WHERE project_id = $1', [proj.id])).rows;
      result[proj.id] = {
        name: proj.name,
        created: proj.created,
        manholes: mhRows.map(r => r.data)
      };
    }

    res.json({ ok: true, projects: result });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Sync error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Fallback: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================ START ================

async function start() {
  if (process.env.DATABASE_URL) {
    await initDB();
  } else {
    console.warn('⚠️  No DATABASE_URL set — running without database (API calls will fail)');
    console.warn('   Add a Postgres plugin in Railway or set DATABASE_URL manually.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════╗
║   MH Survey Server running              ║
║   Port: ${PORT}                             ║
║   API:  /api/health                      ║
╚══════════════════════════════════════════╝
    `);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
