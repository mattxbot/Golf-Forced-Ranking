/**
 * Validated environment variables.
 *
 * Fails fast with a clear error message if required
 * env vars are missing, instead of cryptic Supabase errors.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Add it to .env.local (see .env.local.example).`
    );
  }
  return value;
}

export const env = {
  supabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
} as const;
