import { Hono } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { eq, notInArray } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { games, settings } from "../../db/schema.ts";

export const config = { path: "/api/*" };

const app = new Hono();
const MAIN = "main";
const MAX_BODY = 8 * 1024 * 1024;

const noStore = { "Cache-Control": "no-store" };

function passcodeOk(given: string | undefined): "ok" | "bad" | "unset" {
  const expected = process.env.EDIT_PASSCODE;
  if (!expected) return "unset";
  if (!given) return "bad";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) ? "ok" : "bad";
}

async function readState() {
  const [s] = await db.select().from(settings).where(eq(settings.id, MAIN));
  const rows = await db.select().from(games);
  return {
    cfg: s?.cfg ?? null,
    version: s?.version ?? 0,
    updatedAt: s?.updatedAt ?? null,
    games: rows.map((r) => r.data),
  };
}

// Anyone can read the shared stats.
app.get("/api/state", async (c) => {
  return c.json(await readState(), 200, noStore);
});

// Lets the page check a passcode before turning on editing.
app.post("/api/check", async (c) => {
  const r = passcodeOk(c.req.header("x-edit-key"));
  if (r === "unset") return c.json({ ok: false, error: "Editing is not set up yet: the site owner needs to add an EDIT_PASSCODE environment variable in Netlify." }, 503, noStore);
  return c.json({ ok: r === "ok" }, r === "ok" ? 200 : 401, noStore);
});

// Editors replace the shared settings + games list.
app.put("/api/state", async (c) => {
  const r = passcodeOk(c.req.header("x-edit-key"));
  if (r === "unset") return c.json({ error: "Editing is not set up yet: the site owner needs to add an EDIT_PASSCODE environment variable in Netlify." }, 503, noStore);
  if (r === "bad") return c.json({ error: "Wrong passcode" }, 401, noStore);

  const raw = await c.req.text();
  if (raw.length > MAX_BODY) return c.json({ error: "Too much data" }, 413, noStore);
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400, noStore);
  }
  const { cfg, baseVersion, force } = body ?? {};
  const list = body?.games;
  if (!cfg || typeof cfg !== "object" || !Array.isArray(list) || !list.length) {
    return c.json({ error: "Expected settings and at least one game" }, 400, noStore);
  }
  if (!list.every((g: any) => g && typeof g.id === "string" && g.id && Array.isArray(g.poss))) {
    return c.json({ error: "Invalid game data" }, 400, noStore);
  }

  const result = await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(settings).where(eq(settings.id, MAIN)).for("update");
    const curVersion = cur?.version ?? 0;
    if (!force && typeof baseVersion === "number" && baseVersion !== curVersion) {
      return { conflict: true as const, version: curVersion };
    }
    const ids = list.map((g: any) => g.id as string);
    await tx.delete(games).where(notInArray(games.id, ids));
    for (const g of list) {
      await tx
        .insert(games)
        .values({ id: g.id, data: g, updatedAt: new Date() })
        .onConflictDoUpdate({ target: games.id, set: { data: g, updatedAt: new Date() } });
    }
    const version = curVersion + 1;
    await tx
      .insert(settings)
      .values({ id: MAIN, cfg, version, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.id, set: { cfg, version, updatedAt: new Date() } });
    return { conflict: false as const, version };
  });

  if (result.conflict) {
    return c.json({ error: "conflict", latest: await readState() }, 409, noStore);
  }
  return c.json({ ok: true, version: result.version }, 200, noStore);
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404, noStore));

export default app;
