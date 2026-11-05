export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ENV: string; // development | test | production
  SETUP_KEY?: string; // secret: needed once, in production, to open /setup and create the first admin
}

export interface User { id: string; email: string; name: string; role: "admin" | "staff" }
export type AppEnv = { Bindings: Env; Variables: { user: User } };
