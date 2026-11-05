import type { Env as Bindings } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}
export {};
