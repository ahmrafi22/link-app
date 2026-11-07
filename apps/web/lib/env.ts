// Central env access. All secrets come from the Vercel dashboard in
// production and from .env.local during local dev — never committed.

export const APP_SECRET = process.env.APP_SECRET ?? "";

// Supabase: newer projects use SUPABASE_SECRET_KEY (sb_secret_…);
// older ones still call it SUPABASE_SERVICE_ROLE_KEY. Accept both.
export const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
export const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "";

export const appSecretConfigured = () => Boolean(APP_SECRET);
export const supabaseConfigured = () => Boolean(SUPABASE_URL && SUPABASE_KEY);
