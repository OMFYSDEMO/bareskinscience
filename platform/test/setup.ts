import { env } from "cloudflare:test";
import { ensureSchema } from "../src/migrate";

// The same self-migration the deployed app runs on its first request.
await ensureSchema(env.DB);
