import { writeFileSync } from "node:fs";

const { SUPABASE_URL, SUPABASE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY)
  throw new Error("SUPABASE_URL / SUPABASE_KEY 없음");

writeFileSync(
  "public/config.js",
  `export const SUPABASE_URL = ${JSON.stringify(SUPABASE_URL)}\n` +
    `export const SUPABASE_KEY = ${JSON.stringify(SUPABASE_KEY)}\n`,
);
