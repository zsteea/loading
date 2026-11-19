/*  420TTT player card helper  (Cloudflare Worker)

    The loading screen is a plain web page. It cannot ask Steam for a
    profile picture, and it cannot see the game server's playtime. This
    small helper sits in between:

      GET  /?steamid=7656119...     the loading screen asks who this is
                                    -> { name, avatar, seconds }
      POST /update                  the game server reports playtime
                                    (must carry the password)

    Needs, in the Worker's settings:
      KV namespace binding   CARDS       where playtime is kept
      Secret                 SECRET      password shared with the game server
      Secret (optional)      STEAM_KEY   a Steam Web API key. Without it the
                                         helper reads the public profile page,
                                         which works but Steam may slow it down.

    Setup steps are in README.txt.
*/

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Card-Secret"
};

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS, extra || {})
  });
}

const isSteamID = (id) => /^7656119\d{10}$/.test(id || "");

/* ---- Steam: name and picture ------------------------------------------ */

async function fromSteamKey(id, key) {
  const res = await fetch("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=" + key + "&steamids=" + id);
  if (!res.ok) return null;
  const data = await res.json();
  const p = data && data.response && data.response.players && data.response.players[0];
  return p ? { name: p.personaname || "", avatar: p.avatarfull || p.avatarmedium || "" } : null;
}

function between(text, tag) {
  const m = new RegExp("<" + tag + ">(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</" + tag + ">").exec(text);
  return m ? m[1].trim() : "";
}

async function fromProfilePage(id) {
  const res = await fetch("https://steamcommunity.com/profiles/" + id + "/?xml=1", {
    headers: { "User-Agent": "420TTT-player-card" }
  });
  if (!res.ok) return null;
  const xml = await res.text();
  const avatar = between(xml, "avatarFull") || between(xml, "avatarMedium");
  if (!avatar) return null;
  return { name: between(xml, "steamID"), avatar: avatar };
}

async function profile(id, env) {
  try {
    if (env.STEAM_KEY) {
      const viaKey = await fromSteamKey(id, env.STEAM_KEY);
      if (viaKey) return viaKey;
    }
    return (await fromProfilePage(id)) || { name: "", avatar: "" };
  } catch (e) {
    return { name: "", avatar: "" };
  }
}

/* ---- playtime ------------------------------------------------------------ */

/* Everyone's playtime lives in one record, so each report from the game
   server is a single write however many players it covers. */
async function readTimes(env) {
  return (await env.CARDS.get("playtime", "json")) || {};
}

async function handleLookup(request, url, env, ctx) {
  const id = url.searchParams.get("steamid");
  if (!isSteamID(id)) return json({ error: "bad steamid" }, 400);

  /* Steam is only asked once every six hours per player. */
  const cache = caches.default;
  const cacheKey = new Request("https://card.cache/profile/" + id);
  let who;
  const hit = await cache.match(cacheKey);
  if (hit) {
    who = await hit.json();
  } else {
    who = await profile(id, env);
    if (who.avatar) {
      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(who), {
        headers: { "Content-Type": "application/json", "Cache-Control": "max-age=21600" }
      })));
    }
  }

  const times = await readTimes(env);
  const entry = times[id];
  const out = { name: who.name, avatar: who.avatar };
  /* a number means the server knows this player; leaving it out means "no idea" */
  if (entry) { out.seconds = entry.s; if (!out.name) out.name = entry.n || ""; }
  else if (times.__ready) out.seconds = 0;

  return json(out, 200, { "Cache-Control": "max-age=60" });
}

async function handleUpdate(request, env) {
  if (!env.SECRET || request.headers.get("X-Card-Secret") !== env.SECRET) {
    return json({ error: "wrong password" }, 403);
  }

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const players = body && body.players;
  if (!players || typeof players !== "object") return json({ error: "no players" }, 400);

  const times = await readTimes(env);
  let count = 0;
  for (const id of Object.keys(players)) {
    const p = players[id] || {};
    const s = Math.floor(Number(p.s));
    if (!isSteamID(id) || !(s >= 0) || count >= 200) continue;
    times[id] = { s: s, n: String(p.n || "").slice(0, 40) };
    count++;
  }
  times.__ready = true;   /* from now on, an unknown player really is new */
  await env.CARDS.put("playtime", JSON.stringify(times));

  return json({ saved: count });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!env.CARDS) return json({ error: "KV binding CARDS is missing" }, 500);

    if (request.method === "POST" && url.pathname === "/update") return handleUpdate(request, env);
    if (request.method === "GET") return handleLookup(request, url, env, ctx);
    return json({ error: "not found" }, 404);
  }
};
