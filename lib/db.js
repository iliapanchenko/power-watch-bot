import { neon } from '@neondatabase/serverless';
import { env } from './env.js';

if (!env.databaseUrl) {
  throw new Error('DATABASE_URL не заданий. Підключи Neon у Vercel → Storage.');
}

export const sql = neon(env.databaseUrl);

export async function initSchema() {
  await sql`
    create table if not exists devices (
      id           serial primary key,
      host         text not null,
      port         integer not null default 443,
      name         text not null,
      status       text not null default 'unknown',
      fail_count   integer not null default 0,
      ok_count     integer not null default 0,
      last_change  timestamptz,
      last_checked timestamptz,
      last_latency integer,
      last_detail  text,
      created_at   timestamptz not null default now(),
      unique (host, port)
    )
  `;
  await sql`
    create table if not exists subscribers (
      chat_id    bigint primary key,
      title      text,
      created_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists events (
      id           serial primary key,
      device_id    integer references devices(id) on delete cascade,
      device_name  text not null,
      status       text not null,
      duration_sec integer,
      created_at   timestamptz not null default now()
    )
  `;
  await sql`create index if not exists events_created_at_idx on events (created_at desc)`;
  await sql`
    create table if not exists run_lock (
      id           integer primary key,
      locked_until timestamptz not null default now(),
      constraint run_lock_single check (id = 1)
    )
  `;
  await sql`insert into run_lock (id) values (1) on conflict (id) do nothing`;
}

/**
 * Один виклик /api/check живе майже хвилину, а cron стукає щохвилини —
 * рано чи пізно два виклики накладуться. Тоді точку перевіряли б удвічі
 * частіше, а про зміну статусу прилетіло б два однакових повідомлення.
 * Замок пропускає лише один прохід за раз.
 *
 * @returns {Promise<boolean>} чи вдалось захопити
 */
export async function acquireRunLock(seconds) {
  const rows = await sql`
    update run_lock
      set locked_until = now() + make_interval(secs => ${seconds}::int)
      where id = 1 and locked_until <= now()
      returning locked_until
  `;
  return rows.length > 0;
}

export async function releaseRunLock() {
  await sql`update run_lock set locked_until = now() where id = 1`;
}

export const devices = {
  all: () => sql`select * from devices order by name`,
  byId: (id) => sql`select * from devices where id = ${id}`,
  find: (needle) => sql`
    select * from devices
    where host = ${needle} or lower(name) = lower(${needle})
    order by id
  `,
  add: (host, port, name) => sql`
    insert into devices (host, port, name)
    values (${host}, ${port}, ${name})
    on conflict (host, port) do update set name = excluded.name
    returning *
  `,
  remove: (id) => sql`delete from devices where id = ${id} returning *`,
  saveProbe: ({ id, status, failCount, okCount, latency, detail, changed }) =>
    changed
      ? sql`
          update devices set
            status = ${status},
            fail_count = ${failCount},
            ok_count = ${okCount},
            last_latency = ${latency},
            last_detail = ${detail},
            last_checked = now(),
            last_change = now()
          where id = ${id}
        `
      : sql`
          update devices set
            fail_count = ${failCount},
            ok_count = ${okCount},
            last_latency = ${latency},
            last_detail = ${detail},
            last_checked = now()
          where id = ${id}
        `,
};

export const subscribers = {
  all: () => sql`select * from subscribers order by created_at`,
  add: (chatId, title) => sql`
    insert into subscribers (chat_id, title)
    values (${chatId}, ${title})
    on conflict (chat_id) do update set title = excluded.title
  `,
  remove: (chatId) => sql`delete from subscribers where chat_id = ${chatId} returning *`,
};

export const events = {
  add: (deviceId, deviceName, status, durationSec) => sql`
    insert into events (device_id, device_name, status, duration_sec)
    values (${deviceId}, ${deviceName}, ${status}, ${durationSec})
  `,
  recent: (limit = 15) => sql`
    select * from events order by created_at desc limit ${limit}
  `,
  recentFor: (deviceId, limit = 15) => sql`
    select * from events where device_id = ${deviceId}
    order by created_at desc limit ${limit}
  `,
};
