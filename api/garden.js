/**
 * Ascii Bloom: garden API (Vercel serverless function + Turso database)
 *
 * GET  /api/garden?id=<viewId>    -> read-only garden
 * GET  /api/garden?key=<editKey>  -> garden + plants (caller may edit)
 * POST /api/garden {action: create | plant | remove | date, ...}
 *
 * Access model: no accounts. Every garden has two random secrets.
 *   id  = public view link  (read only)
 *   key = shared edit link  (anyone holding it can plant and remove)
 *
 * Environment variables (set in Vercel):
 *   TURSO_DATABASE_URL   e.g. libsql://ascii-bloom-yourname.turso.io
 *   TURSO_AUTH_TOKEN     token with read and write access
 */
import { createClient } from '@libsql/client/web';
import { randomBytes } from 'node:crypto';

const TYPES = ['lily', 'rose', 'tulip', 'daisy', 'cherry', 'sunflower'];
const PALS = ['blush', 'peach', 'lilac', 'snow'];
const MAX_PLANTS = 80;
const MAX_GARDENS_PER_HOUR = 30; // crude global brake against spam

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let client;
let ready;

function db() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new HttpError(503, 'The garden database is not connected yet. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Vercel, then redeploy.');
  }
  return (client ??= createClient({ url, authToken }));
}

function ensureSchema() {
  return (ready ??= db()
    .batch(
      [
        `create table if not exists gardens (
          id text primary key,
          edit_key text unique not null,
          name text not null default '',
          start_date text,
          created_at integer not null default (unixepoch())
        )`,
        `create table if not exists plants (
          id integer primary key autoincrement,
          garden_id text not null,
          type text not null,
          pal text not null,
          x real not null,
          seed integer not null,
          msg text not null default '',
          author text not null default '',
          created_at integer not null default (unixepoch())
        )`,
        'create index if not exists plants_garden_idx on plants (garden_id, id)',
      ],
      'write',
    )
    .catch((err) => {
      ready = undefined; // allow a retry on the next request
      throw err;
    }));
}

const token = (bytes) => randomBytes(bytes).toString('base64url');
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d ?? ''));

function cleanPlant(p = {}) {
  if (!TYPES.includes(p.type) || !PALS.includes(p.pal)) return null;
  return {
    type: p.type,
    pal: p.pal,
    x: Math.min(0.96, Math.max(0.04, Number(p.x) || 0.5)),
    seed: Math.abs(parseInt(p.seed, 10) || 1) % 2147483647,
    msg: text(p.msg, 80),
    author: text(p.author, 24),
  };
}

async function gardenBy({ id, key }) {
  const rs = key
    ? await db().execute({ sql: 'select id, name, start_date from gardens where edit_key = ?', args: [String(key).slice(0, 64)] })
    : await db().execute({ sql: 'select id, name, start_date from gardens where id = ?', args: [String(id ?? '').slice(0, 32)] });
  if (!rs.rows.length) throw new HttpError(404, 'Garden not found');
  return rs.rows[0];
}

async function snapshot(row) {
  const rs = await db().execute({
    sql: 'select id, type, pal, x, seed, msg, author, created_at from plants where garden_id = ? order by id',
    args: [row.id],
  });
  return {
    garden: { id: String(row.id), name: String(row.name), startDate: row.start_date ? String(row.start_date) : '' },
    plants: rs.rows.map((r) => ({
      id: String(r.id),
      type: String(r.type),
      pal: String(r.pal),
      x: Number(r.x),
      seed: Number(r.seed),
      msg: String(r.msg),
      author: String(r.author),
      ts: Number(r.created_at),
    })),
  };
}

const actions = {
  // Creates a garden. Optionally imports flowers + date from the visitor's local garden.
  async create({ name, plants, startDate }) {
    const since = Math.floor(Date.now() / 1000) - 3600;
    const recent = await db().execute({ sql: 'select count(*) as n from gardens where created_at > ?', args: [since] });
    if (Number(recent.rows[0].n) >= MAX_GARDENS_PER_HOUR) {
      throw new HttpError(429, 'Lots of gardens are being planted right now. Try again soon.');
    }
    const id = token(9);
    const key = token(18);
    const statements = [
      {
        sql: 'insert into gardens (id, edit_key, name, start_date) values (?, ?, ?, ?)',
        args: [id, key, text(name, 40), isDate(startDate) ? startDate : null],
      },
    ];
    for (const p of (Array.isArray(plants) ? plants : []).slice(0, MAX_PLANTS)) {
      const v = cleanPlant(p);
      if (v) {
        statements.push({
          sql: 'insert into plants (garden_id, type, pal, x, seed, msg, author) values (?, ?, ?, ?, ?, ?, ?)',
          args: [id, v.type, v.pal, v.x, v.seed, v.msg, v.author],
        });
      }
    }
    await db().batch(statements, 'write');
    return { id, key };
  },

  async plant({ key, plant }) {
    const row = await gardenBy({ key });
    const count = await db().execute({ sql: 'select count(*) as n from plants where garden_id = ?', args: [row.id] });
    if (Number(count.rows[0].n) >= MAX_PLANTS) throw new HttpError(409, 'The garden is full. Remove a flower first.');
    const v = cleanPlant(plant);
    if (!v) throw new HttpError(400, 'Unknown flower');
    await db().execute({
      sql: 'insert into plants (garden_id, type, pal, x, seed, msg, author) values (?, ?, ?, ?, ?, ?, ?)',
      args: [row.id, v.type, v.pal, v.x, v.seed, v.msg, v.author],
    });
    return { ok: true };
  },

  async remove({ key, plantId }) {
    const row = await gardenBy({ key });
    await db().execute({ sql: 'delete from plants where id = ? and garden_id = ?', args: [Number(plantId) || 0, row.id] });
    return { ok: true };
  },

  async date({ key, date }) {
    const row = await gardenBy({ key });
    if (!isDate(date)) throw new HttpError(400, 'Invalid date');
    await db().execute({ sql: 'update gardens set start_date = ? where id = ?', args: [date, row.id] });
    return { ok: true };
  },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    if (req.method === 'GET') {
      const { id, key } = req.query;
      if (!id && !key) throw new HttpError(400, 'Missing id or key');
      return res.status(200).json(await snapshot(await gardenBy({ id, key })));
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const run = actions[body.action];
      if (!run) throw new HttpError(400, 'Unknown action');
      return res.status(200).json(await run(body));
    }
    res.setHeader('Allow', 'GET, POST');
    throw new HttpError(405, 'Method not allowed');
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({
      error: status === 500 ? 'The garden database could not be reached. Check the Turso URL and token in Vercel.' : err.message,
    });
  }
}
