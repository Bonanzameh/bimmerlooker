import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScrapeAndWrite } from "./scripts/bmw-i5-cognac.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const latestJsonPath = path.join(__dirname, "data", "latest.json");
const latestReportPath = path.join(__dirname, "reports", "latest.md");
const postalCodeCache = new Map();

let refreshPromise = null;
let refreshStatus = {
  refreshing: false,
  startedAt: null,
  finishedAt: null,
  ok: null,
  error: "",
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
}

function normalizePostalCode(value) {
  return String(value || "").replace(/\D/g, "").trim();
}

async function fetchPostalCodeCoordinates(postalCode) {
  const normalized = normalizePostalCode(postalCode);
  if (!normalized) {
    throw new Error("Postal code is required.");
  }

  if (postalCodeCache.has(normalized)) {
    return postalCodeCache.get(normalized);
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("postalcode", normalized);
  url.searchParams.set("country", "Belgium");
  url.searchParams.set("countrycodes", "be");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: {
      "user-agent": "bmw-i5-cognac-watch/1.0 (local dev)",
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Postal-code lookup failed for ${normalized}: ${response.status} ${response.statusText}`);
  }

  const results = await response.json();
  const match = Array.isArray(results) ? results[0] : null;
  if (!match?.lat || !match?.lon) {
    throw new Error(`No coordinates found for postal code ${normalized}.`);
  }

  const coords = {
    postalCode: normalized,
    lat: Number(match.lat),
    lon: Number(match.lon),
    label: match.display_name || match.name || normalized,
  };
  postalCodeCache.set(normalized, coords);
  return coords;
}

async function readLatest() {
  const [dataRaw, report] = await Promise.all([
    fs.readFile(latestJsonPath, "utf8"),
    fs.readFile(latestReportPath, "utf8").catch(() => ""),
  ]);
  return { data: JSON.parse(dataRaw), report };
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const safePath = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    send(res, 403, "Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, body, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
  } catch {
    send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
  }
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/latest") {
      sendJson(res, 200, await readLatest());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/refresh") {
      if (!refreshPromise) {
        refreshStatus = {
          refreshing: true,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          ok: null,
          error: "",
        };
        refreshPromise = runScrapeAndWrite()
          .then((result) => {
            refreshStatus = {
              ...refreshStatus,
              refreshing: false,
              finishedAt: new Date().toISOString(),
              ok: true,
              error: "",
            };
            return result;
          })
          .catch((error) => {
            refreshStatus = {
              ...refreshStatus,
              refreshing: false,
              finishedAt: new Date().toISOString(),
              ok: false,
              error: error.message || String(error),
            };
            throw error;
          })
          .finally(() => {
            refreshPromise = null;
          });
      }

      try {
        const result = await refreshPromise;
        sendJson(res, 200, { data: result.current, report: result.report, refreshStatus });
      } catch (error) {
        const stale = await readLatest();
        sendJson(res, 200, {
          ...stale,
          refreshError: error.message || String(error),
          refreshStatus,
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, {
        ...refreshStatus,
        refreshing: Boolean(refreshPromise),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/geocode-postal") {
      try {
        const postalCode = url.searchParams.get("postalCode") || url.searchParams.get("postcode") || "";
        const coords = await fetchPostalCodeCoordinates(postalCode);
        sendJson(res, 200, coords);
      } catch (error) {
        sendJson(res, 404, { error: error.message || String(error) });
      }
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    send(res, 405, "Method not allowed", { "content-type": "text/plain; charset=utf-8" });
  } catch (error) {
    sendJson(res, 500, { error: error.message || String(error) });
  }
}

const host = process.env.HOST || "0.0.0.0";
const preferredPort = Number(process.env.PORT || 4173);

function listen(port, attemptsLeft = 10) {
  const server = http.createServer(handleRequest);

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0 && !process.env.PORT) {
      server.close();
      listen(port + 1, attemptsLeft - 1);
      return;
    }

    console.error(error);
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    console.log(`BMW i4/i5/iX1 watch web app: http://${host}:${port}`);
  });
}

listen(preferredPort);
