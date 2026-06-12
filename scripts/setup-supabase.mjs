#!/usr/bin/env node
/**
 * One-shot AGENTWORLD Supabase setup. Creates a dedicated project, applies
 * the game schema, fetches the anon key, and writes .env at the repo root.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-supabase.mjs [region]
 *
 * The token is read from the environment only — never hardcode or commit it.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REGION = process.argv[2] ?? "eu-central-1";
const API = "https://api.supabase.com/v1";
if (!TOKEN) {
  console.error("Set SUPABASE_ACCESS_TOKEN (a personal access token, sbp_...)");
  process.exit(1);
}

const SCHEMA_SQL = `
create table if not exists aw_characters (
  name text primary key,
  role text not null check (role in ('human','agent')),
  x double precision not null,
  z double precision not null,
  ap integer not null default 300,
  hp integer not null default 100,
  shards integer not null default 100,
  inventory jsonb not null default '{}'::jsonb,
  kills integer not null default 0,
  deaths integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists aw_ledger (
  id bigint generated always as identity primary key,
  t timestamptz not null default now(),
  kind text not null,
  debit text not null,
  credit text not null,
  item text not null,
  qty integer not null,
  memo text not null default ''
);
create table if not exists aw_orders (
  id text primary key,
  owner_name text not null,
  side text not null check (side in ('buy','sell')),
  item text not null,
  qty integer not null,
  price integer not null,
  created_at timestamptz not null default now()
);
create index if not exists aw_ledger_t_idx on aw_ledger (t desc);
`;

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const orgs = await api("/organizations");
if (!orgs.length) throw new Error("This account has no organizations.");
const org = orgs[0];
console.log(`Organization: ${org.name} (${org.id})`);

const existing = (await api("/projects")).find((p) => p.name === "agentworld");
let project = existing;
if (existing) {
  console.log(`Project "agentworld" already exists (${existing.id}) — reusing.`);
} else {
  const dbPass = randomBytes(24).toString("base64url");
  project = await api("/projects", {
    method: "POST",
    body: JSON.stringify({ name: "agentworld", organization_id: org.id, region: REGION, db_pass: dbPass }),
  });
  console.log(`Created project ${project.id} in ${REGION}. DB password (save it): ${dbPass}`);
}

process.stdout.write("Waiting for project to become healthy");
for (let i = 0; i < 60; i++) {
  const p = await api(`/projects/${project.id}`);
  if (p.status === "ACTIVE_HEALTHY") break;
  process.stdout.write(".");
  await sleep(5000);
  if (i === 59) throw new Error("Timed out waiting for the project to initialize.");
}
console.log(" ready.");

await api(`/projects/${project.id}/database/query`, {
  method: "POST",
  body: JSON.stringify({ query: SCHEMA_SQL }),
});
console.log("Schema applied: aw_characters, aw_ledger, aw_orders.");

const keys = await api(`/projects/${project.id}/api-keys`);
const anon = keys.find((k) => k.name === "anon")?.api_key;
if (!anon) throw new Error("Could not find the anon API key.");

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
writeFileSync(envPath, `SUPABASE_URL=https://${project.id}.supabase.co\nSUPABASE_ANON_KEY=${anon}\n`);
console.log(`Wrote ${envPath}`);
console.log("\nDone. Start the server with: npm run dev:server");
