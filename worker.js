// Cloudflare Worker for GGNA website.
// - Serves static assets (index.html, images, etc.).
// - /api/events: next N future events from the public Google Calendar.
// - Injects a script into HTML so the News & Announcements tiles show
//   the next 3 upcoming (future-only) calendar events.

const CAL_ID = "gavelloglen@gmail.com";
const ICS_URL =
  "https://calendar.google.com/calendar/ical/" +
  encodeURIComponent(CAL_ID) +
  "/public/basic.ics";

function unfold(ics) {
  return ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function unescapeText(v) {
  return (v || "")
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseIcsDate(raw) {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (m[4] === undefined) return new Date(Date.UTC(y, mo - 1, d));
  const h = +m[4], mi = +m[5], s = +m[6];
  if (m[7]) return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return new Date(y, mo - 1, d, h, mi, s);
}

function parseEvents(ics) {
  const text = unfold(ics);
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  const events = [];
  for (const b of blocks) {
    const body = b.split("END:VEVENT")[0];
    const get = (key) => {
      const re = new RegExp("(?:^|\\n)" + key + "[^:\\n]*:([^\\n]*)");
      const mm = body.match(re);
      return mm ? mm[1].trim() : "";
    };
    const dtRaw = get("DTSTART");
    const start = parseIcsDate(dtRaw);
    if (!start) continue;
    events.push({
      title: unescapeText(get("SUMMARY")) || "Untitled event",
      description: unescapeText(get("DESCRIPTION")),
      location: unescapeText(get("LOCATION")),
      start: start.toISOString(),
      allDay: /^\d{8}$/.test(dtRaw),
    });
  }
  return events;
}

async function getUpcoming(limit) {
  const res = await fetch(ICS_URL, { cf: { cacheTtl: 900, cacheEverything: true } });
  if (!res.ok) throw new Error("calendar fetch failed: " + res.status);
  const ics = await res.text();
  const now = Date.now();
  return parseEvents(ics)
    .filter((e) => new Date(e.start).getTime() >= now)
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, limit);
}

const INJECT = "<script>\n(function(){\n  function fmtDate(iso){\n    try {\n      var d = new Date(iso);\n      return d.toLocaleDateString(\"en-US\", { year:\"numeric\", month:\"long\", day:\"numeric\" }).toUpperCase();\n    } catch(e){ return \"\"; }\n  }\n  function esc(s){\n    return String(s==null?\"\":s).replace(/[&<>\"]/g, function(c){\n      return {\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",\"\\\"\":\"&quot;\"}[c];\n    });\n  }\n  function trim(s, n){\n    s = String(s==null?\"\":s);\n    return s.length > n ? s.slice(0, n-1).trim() + \"\\u2026\" : s;\n  }\n  function render(events){\n    var grid = document.querySelector(\"#news .news-grid\");\n    if (!grid) return;\n    if (!events || !events.length){\n      grid.innerHTML = \"<p style=\\\"opacity:.7\\\">No upcoming events at this time.</p>\";\n      return;\n    }\n    grid.innerHTML = events.map(function(ev){\n      var desc = ev.description || ev.location || \"\";\n      return \"<div class=\\\"news-card\\\">\" +\n        \"<div class=\\\"news-date\\\">\" + esc(fmtDate(ev.start)) + \"</div>\" +\n        \"<h3>\" + esc(ev.title) + \"</h3>\" +\n        \"<p>\" + esc(trim(desc, 160)) + \"</p>\" +\n        \"<a href=\\\"#events\\\" class=\\\"news-read-more\\\">View Calendar \\u2192</a>\" +\n        \"</div>\";\n    }).join(\"\");\n  }\n  function load(){\n    fetch(\"/api/events?limit=3\", { headers: { \"accept\": \"application/json\" } })\n      .then(function(r){ return r.json(); })\n      .then(function(data){ render(data.events || []); })\n      .catch(function(){});\n  }\n  if (document.readyState === \"loading\") document.addEventListener(\"DOMContentLoaded\", load);\n  else load();\n})();\n<\\/script>";

class Injector {
  element(el) {
    el.append(INJECT, { html: true });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/events") {
      try {
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "3", 10) || 3, 20);
        const events = await getUpcoming(limit);
        return new Response(JSON.stringify({ events }), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=900",
            "access-control-allow-origin": "*",
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ events: [], error: String(err) }), {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const ct = assetResponse.headers.get("content-type") || "";
    if (ct.includes("text/html")) {
      return new HTMLRewriter().on("body", new Injector()).transform(assetResponse);
    }
    return assetResponse;
  },
};
