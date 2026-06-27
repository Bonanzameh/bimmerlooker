let payload = null;
let activeFilter = "all";
let refreshTimer = null;
let refreshStartedAt = null;
let latestFingerprint = "";
let distanceHydrationToken = 0;
let distanceFilterError = "";

const AUTO_RELOAD_INTERVAL_MS = 60_000;
const distanceCoordinateCache = new Map();
const distancePairCache = new Map();

const els = {
  matchCount: document.querySelector("#matchCount"),
  scannedCount: document.querySelector("#scannedCount"),
  newCount: document.querySelector("#newCount"),
  changedCount: document.querySelector("#changedCount"),
  resultGrid: document.querySelector("#resultGrid"),
  statusLine: document.querySelector("#statusLine"),
  refreshButton: document.querySelector("#refreshButton"),
  reportText: document.querySelector("#reportText"),
  newSourceLink: document.querySelector("#newSourceLink"),
  usedSourceLink: document.querySelector("#usedSourceLink"),
  sortSelect: document.querySelector("#sortSelect"),
  searchInput: document.querySelector("#searchInput"),
  modelSelect: document.querySelector("#modelSelect"),
  inventorySelect: document.querySelector("#inventorySelect"),
  bodySelect: document.querySelector("#bodySelect"),
  exteriorSelect: document.querySelector("#exteriorSelect"),
  interiorSelect: document.querySelector("#interiorSelect"),
  featureSelect: document.querySelector("#featureSelect"),
  interiorGroupSelect: document.querySelector("#interiorGroupSelect"),
  postalCodeInput: document.querySelector("#postalCodeInput"),
  distanceSelect: document.querySelector("#distanceSelect"),
  distanceInput: document.querySelector("#distanceInput"),
  targetOnlyInput: document.querySelector("#targetOnlyInput"),
  towInput: document.querySelector("#towInput"),
  drivingInput: document.querySelector("#drivingInput"),
  parkingInput: document.querySelector("#parkingInput"),
  watchlistButton: document.querySelector("#watchlistButton"),
  allInventoryButton: document.querySelector("#allInventoryButton"),
  segments: [...document.querySelectorAll(".segment")],
};

const SELECT_DEFAULTS = {
  model: "All models",
  body: "All bodies",
  exterior: "All exterior colours",
  interior: "All interiors",
  feature: "All features",
};

const BELGIUM_POSTAL_CODE_FALLBACKS = new Map([
  ["3140", { lat: 51.0051977, lon: 4.6543021, label: "3140, Keerbergen, Belgium" }],
]);

function money(value) {
  if (!value) return "Price unknown";
  return `EUR ${Number(value).toLocaleString("nl-BE")}`;
}

function priceMain(item) {
  return item.formattedPrice || money(item.priceEur);
}

function priceSubtext(item) {
  const parts = [];
  if (item.priceLabel) parts.push(item.priceLabel);
  if (item.listPriceEur && item.priceEur && item.listPriceEur !== item.priceEur) {
    parts.push(`List price ${money(item.listPriceEur)}`);
  }
  return parts.join(" · ");
}

function km(value) {
  if (value == null) return "Km unknown";
  return `${Number(value).toLocaleString("nl-BE")} km`;
}

function distanceKm(value) {
  if (value == null) return "Distance unknown";
  return `${value.toFixed(1).replace(/\.0$/, "")} km`;
}

function timeAgo(iso) {
  if (!iso) return "Unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function elapsedText(startedAt) {
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (!minutes) return `${seconds}s`;
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

function shortError(message) {
  if (!message) return "";
  if (message.includes("BMW API 429")) return "BMW is rate limiting requests (429).";
  if (message.includes("Failed to fetch")) return "BMW refused one of the inventory requests.";
  return message.split("\n")[0];
}

function getChanges() {
  const changes = payload?.data?.changes || {};
  return {
    added: changes.added || [],
    changed: changes.changed || [],
    removed: changes.removed || [],
  };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePostalCode(value) {
  return String(value || "").replace(/\D/g, "").trim();
}

function garagePostalCode(item) {
  return normalizePostalCode(item.postalCode || item.city || item.location?.postalCode || item.ordering?.retailData?.locationOutletAddress?.postalCode);
}

function haversineKm(a, b) {
  if (!a || !b) return null;
  const radius = 6371;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const value =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

async function fetchPostalCoordinates(postalCode) {
  const normalized = normalizePostalCode(postalCode);
  if (!normalized) return null;
  if (distanceCoordinateCache.has(normalized)) return distanceCoordinateCache.get(normalized);
  if (BELGIUM_POSTAL_CODE_FALLBACKS.has(normalized)) {
    const fallback = { postalCode: normalized, ...BELGIUM_POSTAL_CODE_FALLBACKS.get(normalized) };
    distanceCoordinateCache.set(normalized, fallback);
    return fallback;
  }

  const response = await fetch(`/api/geocode-postal?postalCode=${encodeURIComponent(normalized)}`);
  if (!response.ok) return null;
  const data = await response.json();
  const coords = {
    postalCode: normalized,
    lat: Number(data.lat),
    lon: Number(data.lon),
    label: data.label || normalized,
  };
  if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lon)) return null;
  distanceCoordinateCache.set(normalized, coords);
  return coords;
}

async function ensureDistanceHydration(items, state) {
  if (!state.distanceEnabled) return { ready: true, error: "" };

  const originPostalCode = normalizePostalCode(state.postalCode);
  if (!originPostalCode) {
    return { ready: false, error: "Enter a Belgian postal code to filter by distance." };
  }

  const nextToken = ++distanceHydrationToken;
  const garagePostalCodes = new Set(
    items.map((item) => garagePostalCode(item)).filter(Boolean),
  );
  garagePostalCodes.add(originPostalCode);

  const coordinates = new Map();
  const lookups = [...garagePostalCodes].map(async (postalCode) => {
    const coords = await fetchPostalCoordinates(postalCode);
    if (coords) coordinates.set(postalCode, coords);
  });
  await Promise.all(lookups);

  if (nextToken !== distanceHydrationToken) {
    return { ready: false, error: "" };
  }

  const origin = coordinates.get(originPostalCode);
  if (!origin) {
    return { ready: false, error: `Could not resolve postal code ${originPostalCode}.` };
  }

  for (const item of items) {
    const garageCode = garagePostalCode(item);
    const pairKey = `${originPostalCode}|${garageCode}`;
    if (distancePairCache.has(pairKey)) {
      item.distanceToOriginKm = distancePairCache.get(pairKey);
      continue;
    }
    const garage = coordinates.get(garageCode) || null;
    const distance = haversineKm(origin, garage);
    distancePairCache.set(pairKey, distance);
    item.distanceToOriginKm = distance;
  }

  return { ready: true, error: "" };
}

function ids(items) {
  return new Set(items.map((item) => item.id || item.item?.id).filter(Boolean));
}

function changedById(items) {
  return new Map(items.map((entry) => [entry.item.id, entry]));
}

function getAllItems() {
  const data = payload?.data || {};
  return data.vehicles || data.matches || [];
}

function getHydrationItems() {
  const data = payload?.data || {};
  const changes = getChanges();
  const items = [
    ...(data.vehicles || data.matches || []),
    ...(changes.added || []),
    ...((changes.changed || []).map((entry) => entry.item).filter(Boolean)),
    ...(changes.removed || []),
  ];
  const seen = new Set();
  return items.filter((item) => {
    const id = item?.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function getFilterState() {
  return {
    query: normalizeText(els.searchInput.value),
    postalCode: normalizePostalCode(els.postalCodeInput.value),
    distanceEnabled: els.distanceInput.checked,
    distanceKm: Number(els.distanceSelect.value || 20),
    model: els.modelSelect.value,
    inventory: els.inventorySelect.value,
    body: els.bodySelect.value,
    exterior: els.exteriorSelect.value,
    interior: els.interiorSelect.value,
    feature: els.featureSelect.value,
    interiorGroup: els.interiorGroupSelect.value,
    targetOnly: els.targetOnlyInput.checked,
    tow: els.towInput.checked,
    driving: els.drivingInput.checked,
    parking: els.parkingInput.checked,
  };
}

function sorted(items) {
  const result = [...items];
  const mode = els.sortSelect.value;
  result.sort((a, b) => {
    if (mode === "best") return bestRank(a) - bestRank(b) || (a.priceEur || 0) - (b.priceEur || 0);
    if (mode === "distanceAsc") return (a.distanceToOriginKm ?? Number.POSITIVE_INFINITY) - (b.distanceToOriginKm ?? Number.POSITIVE_INFINITY);
    if (mode === "priceDesc") return (b.priceEur || 0) - (a.priceEur || 0);
    if (mode === "mileageAsc") return (a.mileageKm || Number.MAX_SAFE_INTEGER) - (b.mileageKm || Number.MAX_SAFE_INTEGER);
    if (mode === "updatedDesc") return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    return (a.priceEur || Number.MAX_SAFE_INTEGER) - (b.priceEur || Number.MAX_SAFE_INTEGER);
  });
  return result;
}

function bestRank(item) {
  let rank = 0;
  if (!item.isIdeal) rank += 100;
  if (item.bodyStyle !== "Touring") rank += 20;
  if (item.modelFamily !== "i5") rank += 15;
  if (!item.hasTowHitch) rank += 10;
  if (!String(item.upholstery?.name || "").toLowerCase().includes("kupferbraun")) rank += 5;
  if (item.interiorCategory !== "Merino non-black") rank += 2;
  if (item.inventoryType !== "used") rank += 1;
  return rank;
}

function getVisibleItems() {
  const data = payload?.data || {};
  const changes = getChanges();
  if (activeFilter === "new") return filterItems(changes.added || []);
  if (activeFilter === "changed") return filterItems((changes.changed || []).map((entry) => entry.item).filter(Boolean));
  if (activeFilter === "removed") return filterItems(changes.removed || []);
  return filterItems(data.vehicles || data.matches || []);
}

function itemMatchesFilters(item, state, omitted = new Set()) {
  if (!omitted.has("targetOnly") && state.targetOnly && !item.isTargetMatch) return false;
  if (!omitted.has("tow") && state.tow && !item.hasTowHitch) return false;
  if (!omitted.has("driving") && state.driving && !item.hasDrivingAssistantPro) return false;
  if (!omitted.has("parking") && state.parking && !item.hasParking360) return false;
  if (!omitted.has("distance") && state.distanceEnabled && !distanceFilterError) {
    if (item.distanceToOriginKm == null || item.distanceToOriginKm > state.distanceKm) return false;
  }
  if (!omitted.has("model") && state.model !== "all" && normalizeText(item.modelFamily) !== state.model) return false;
  if (!omitted.has("inventory") && state.inventory !== "all" && item.inventoryType !== state.inventory) return false;
  if (!omitted.has("body") && state.body !== "all" && normalizeText(item.bodyStyle) !== state.body) return false;
  if (!omitted.has("exterior") && state.exterior !== "all" && normalizeText(item.exteriorColor) !== state.exterior) return false;
  if (!omitted.has("interior") && state.interior !== "all" && normalizeText(item.upholstery?.name) !== state.interior) return false;
  if (!omitted.has("feature") && state.feature !== "all") {
    const features = item.features || [];
    if (!features.some((feature) => normalizeText(feature) === state.feature)) return false;
  }

  if (!omitted.has("interiorGroup")) {
    if (state.interiorGroup === "interesting" && !["Merino non-black", "M Alcantara"].includes(item.interiorCategory)) return false;
    if (state.interiorGroup === "merino" && item.interiorCategory !== "Merino non-black") return false;
    if (state.interiorGroup === "alcantara" && item.interiorCategory !== "M Alcantara") return false;
    if (state.interiorGroup === "other" && item.interiorCategory) return false;
  }

  if (!omitted.has("query") && state.query) {
    const haystack = normalizeText([
      item.title,
      item.modelFamily,
      item.model,
      item.inventoryLabel,
      item.bodyStyle,
      item.exteriorColor,
      item.upholstery?.name,
      item.upholstery?.cluster,
      item.interiorCategory,
      ...(item.features || []),
      item.dealer,
      item.city,
    ].filter(Boolean).join(" "));
    if (!haystack.includes(state.query)) return false;
  }

  return true;
}

function filterItems(items, omitted = new Set()) {
  const state = getFilterState();
  return items.filter((item) => itemMatchesFilters(item, state, omitted));
}

function uniqueOptions(items, getter) {
  const options = new Map();
  for (const item of items) {
    const label = String(getter(item) || "").replace(/\s+/g, " ").trim();
    if (!label) continue;
    const value = normalizeText(label);
    if (!options.has(value)) options.set(value, label);
  }
  return [...options.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "nl-BE"));
}

function setSelectOptions(select, options, firstLabel) {
  const current = select.value;
  select.innerHTML = `<option value="all">${firstLabel}</option>`;
  for (const { value, label } of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = options.some((option) => option.value === current) ? current : "all";
}

function populateFilterOptions() {
  const items = getAllItems();
  setSelectOptions(
    els.modelSelect,
    uniqueOptions(items, (item) => item.modelFamily),
    SELECT_DEFAULTS.model,
  );
  setSelectOptions(
    els.bodySelect,
    uniqueOptions(items, (item) => item.bodyStyle),
    SELECT_DEFAULTS.body,
  );
  setSelectOptions(
    els.exteriorSelect,
    uniqueOptions(items, (item) => item.exteriorColor),
    SELECT_DEFAULTS.exterior,
  );
  setSelectOptions(
    els.interiorSelect,
    uniqueOptions(items, (item) => item.upholstery?.name),
    SELECT_DEFAULTS.interior,
  );

  const featureSet = new Map();
  for (const item of items) {
    for (const feature of item.features || []) {
      const label = String(feature || "").replace(/\s+/g, " ").trim();
      if (!label) continue;
      const value = normalizeText(label);
      if (!value) continue;
      if (!featureSet.has(value)) featureSet.set(value, label);
    }
  }
  const featureOptions = [...featureSet.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "nl-BE"));
  setSelectOptions(els.featureSelect, featureOptions, SELECT_DEFAULTS.feature);
}

function renderSummary() {
  const data = payload?.data || {};
  const changes = getChanges();
  els.matchCount.textContent = sorted(getVisibleItems()).length;
  els.scannedCount.textContent = data.totalScanned ?? data.totalTowHitchResults ?? "-";
  els.newCount.textContent = changes.added.length;
  els.changedCount.textContent = changes.changed.length;
  els.newSourceLink.href = data.sourceUrls?.new || "#";
  els.usedSourceLink.href = data.sourceUrls?.used || "#";
}

function renderCards() {
  const changes = getChanges();
  const addedIds = ids(changes.added);
  const removedIds = ids(changes.removed);
  const changedMap = changedById(changes.changed);
  const items = sorted(getVisibleItems());

  els.resultGrid.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent =
      activeFilter === "all"
        ? "No cars match the current local filters."
        : `No ${activeFilter} listings in the latest run.`;
    els.resultGrid.append(empty);
    return;
  }

  for (const item of items) {
    const card = document.createElement("article");
    const isNew = addedIds.has(item.id);
    const isRemoved = removedIds.has(item.id);
    const changed = changedMap.get(item.id);
    card.className = `listing-card${isNew ? " is-new" : ""}${changed ? " is-changed" : ""}${isRemoved ? " is-removed" : ""}`;

    const image = document.createElement("img");
    image.className = "car-image";
    image.src = item.imageUrl || "";
    image.alt = item.title || "BMW i4/i5/iX1";
    image.loading = "lazy";
    image.onerror = () => {
      image.removeAttribute("src");
      image.alt = "Image unavailable";
    };

    const body = document.createElement("div");
    body.className = "card-body";

    const badgeText = isRemoved
      ? "Removed"
      : isNew
        ? "New"
        : changed
          ? "Changed"
          : item.isIdeal
            ? "Ideal"
            : item.inventoryLabel || "BMW";
    const towText = item.hasTowHitch ? "Yes" : "No";
    const drivingAssistantText = item.hasDrivingAssistantPro ? "Yes" : "No";
    const parking360Text = item.hasParking360 ? "Yes" : "No";
    const changesHtml = changed
      ? `<ul class="change-list">${changed.changes
          .map((change) => `<li>${escapeHtml(change.field)}: ${escapeHtml(String(change.before || "blank"))} -> ${escapeHtml(String(change.after || "blank"))}</li>`)
          .join("")}</ul>`
      : "";

    body.innerHTML = `
      <div class="card-topline">
        <h2 class="card-title">${escapeHtml(item.title || "BMW i4/i5/iX1")}</h2>
        <span class="badge">${escapeHtml(badgeText)}</span>
      </div>
      <p class="price">${escapeHtml(priceMain(item))}</p>
      ${priceSubtext(item) ? `<p class="price-note">${escapeHtml(priceSubtext(item))}</p>` : ""}
      <dl class="facts">
        <div><dt>Type</dt><dd>${escapeHtml(item.inventoryLabel || item.inventoryType || "Unknown")}</dd></div>
        <div><dt>Model</dt><dd>${escapeHtml(item.modelFamily || "Unknown")}</dd></div>
        <div><dt>Body</dt><dd>${escapeHtml(item.bodyStyle || "Unknown")}</dd></div>
        <div><dt>Mileage</dt><dd>${km(item.mileageKm)}</dd></div>
        <div><dt>Garage distance</dt><dd>${escapeHtml(distanceKm(item.distanceToOriginKm))}</dd></div>
        <div><dt>Tow hitch</dt><dd>${towText}</dd></div>
        <div><dt>Driving Pack Pro</dt><dd>${drivingAssistantText}</dd></div>
        <div><dt>Parking Pack Plus</dt><dd>${parking360Text}</dd></div>
        <div><dt>Dealer</dt><dd>${escapeHtml([item.dealer, item.city].filter(Boolean).join(", ") || "Unknown")}</dd></div>
        <div><dt>Interior type</dt><dd>${escapeHtml(item.interiorCategory || "Unknown")}</dd></div>
        <div><dt>Interior</dt><dd>${escapeHtml(item.upholstery?.name || item.upholstery?.cluster || "Merino")}</dd></div>
        <div><dt>Exterior</dt><dd>${escapeHtml(item.exteriorColor || "Unknown")}</dd></div>
        <div><dt>Updated</dt><dd>${escapeHtml(timeAgo(item.updatedAt))}</dd></div>
      </dl>
      ${changesHtml}
      <a class="card-link" href="${escapeAttr(item.detailUrl)}" target="_blank" rel="noreferrer">Open BMW listing</a>
    `;

    card.append(image, body);
    els.resultGrid.append(card);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value || "#");
}

function render() {
  renderSummary();
  renderCards();
  els.reportText.textContent = payload?.report || "";
  const generatedAt = payload?.data?.generatedAt ? timeAgo(payload.data.generatedAt) : "unknown";
  const status = payload?.refreshStatus || {};
  if (payload?.refreshError) {
    const failedAt = status.finishedAt ? timeAgo(status.finishedAt) : "just now";
    els.statusLine.textContent = `Refresh failed at ${failedAt}: ${shortError(payload.refreshError)} Showing last successful run: ${generatedAt}`;
    return;
  }
  if (distanceFilterError) {
    els.statusLine.textContent = `${distanceFilterError} Last successful run: ${generatedAt}`;
    return;
  }
  els.statusLine.textContent = `Last successful run: ${generatedAt}`;
}

async function renderWithFilterOptions() {
  populateFilterOptions();
  const state = getFilterState();
  const items = getHydrationItems();
  const hydration = await ensureDistanceHydration(items, state);
  distanceFilterError = hydration.error || "";
  render();
}

function getPayloadFingerprint(nextPayload) {
  const data = nextPayload?.data || {};
  const changes = data.changes || {};
  return [
    data.generatedAt || "",
    data.refresh?.attemptedAt || "",
    data.refresh?.ok ?? "",
    changes.added?.length ?? 0,
    changes.changed?.length ?? 0,
    changes.removed?.length ?? 0,
  ].join("|");
}

function stopRefreshTimer() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = null;
  refreshStartedAt = null;
}

function startRefreshTimer(startedAt = new Date().toISOString()) {
  refreshStartedAt = startedAt;
  const tick = () => {
    els.statusLine.textContent = `Checking BMW inventory now... ${elapsedText(refreshStartedAt)} elapsed`;
  };
  tick();
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(tick, 1000);
}

async function pollRefreshStatus() {
  try {
    const response = await fetch("/api/status");
    if (!response.ok) return;
    const status = await response.json();
    if (status.refreshing) {
      if (!refreshTimer) startRefreshTimer(status.startedAt);
    } else if (refreshTimer) {
      stopRefreshTimer();
      els.refreshButton.disabled = false;
      els.refreshButton.textContent = "Refresh now";
      await loadLatest();
    }
  } catch {
    // The POST refresh call will surface the useful error.
  }
}

async function loadLatest({ silent = false, onlyIfChanged = false } = {}) {
  if (!silent) els.statusLine.textContent = "Loading results...";
  const response = await fetch("/api/latest");
  if (!response.ok) throw new Error(await response.text());
  const nextPayload = await response.json();
  const nextFingerprint = getPayloadFingerprint(nextPayload);
  if (onlyIfChanged && nextFingerprint === latestFingerprint) return false;
  payload = nextPayload;
  latestFingerprint = nextFingerprint;
  await renderWithFilterOptions();
  return true;
}

async function refreshNow() {
  els.refreshButton.disabled = true;
  els.refreshButton.textContent = "Refreshing...";
  startRefreshTimer();
  let statusPoller = null;
  try {
    statusPoller = window.setInterval(pollRefreshStatus, 3000);
    const response = await fetch("/api/refresh", { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    payload = await response.json();
    stopRefreshTimer();
    await renderWithFilterOptions();
  } catch (error) {
    stopRefreshTimer();
    els.statusLine.textContent = shortError(error.message || String(error));
  } finally {
    if (statusPoller) window.clearInterval(statusPoller);
    els.refreshButton.disabled = false;
    els.refreshButton.textContent = "Refresh now";
  }
}

els.refreshButton.addEventListener("click", refreshNow);
els.sortSelect.addEventListener("change", () => {
  void renderWithFilterOptions();
});

for (const input of [
  els.searchInput,
  els.postalCodeInput,
  els.distanceSelect,
  els.distanceInput,
  els.modelSelect,
  els.inventorySelect,
  els.bodySelect,
  els.exteriorSelect,
  els.interiorSelect,
  els.featureSelect,
  els.interiorGroupSelect,
  els.targetOnlyInput,
  els.towInput,
  els.drivingInput,
  els.parkingInput,
]) {
  input.addEventListener("input", () => {
    void renderWithFilterOptions();
  });
  input.addEventListener("change", () => {
    void renderWithFilterOptions();
  });
}

els.watchlistButton.addEventListener("click", () => {
  els.searchInput.value = "";
  els.postalCodeInput.value = "3140";
  els.distanceSelect.value = "20";
  els.distanceInput.checked = true;
  els.modelSelect.value = "all";
  els.inventorySelect.value = "all";
  els.bodySelect.value = "all";
  els.exteriorSelect.value = "all";
  els.interiorSelect.value = "all";
  els.featureSelect.value = "all";
  els.interiorGroupSelect.value = "interesting";
  els.targetOnlyInput.checked = true;
  els.towInput.checked = false;
  els.drivingInput.checked = true;
  els.parkingInput.checked = true;
  activeFilter = "all";
  for (const item of els.segments) item.classList.toggle("is-active", item.dataset.filter === "all");
  void renderWithFilterOptions();
});

els.allInventoryButton.addEventListener("click", () => {
  els.searchInput.value = "";
  els.modelSelect.value = "all";
  els.inventorySelect.value = "all";
  els.bodySelect.value = "all";
  els.exteriorSelect.value = "all";
  els.interiorSelect.value = "all";
  els.featureSelect.value = "all";
  els.interiorGroupSelect.value = "all";
  els.distanceInput.checked = false;
  els.targetOnlyInput.checked = false;
  els.towInput.checked = false;
  els.drivingInput.checked = false;
  els.parkingInput.checked = false;
  activeFilter = "all";
  for (const item of els.segments) item.classList.toggle("is-active", item.dataset.filter === "all");
  void renderWithFilterOptions();
});

for (const segment of els.segments) {
  segment.addEventListener("click", () => {
    activeFilter = segment.dataset.filter;
    for (const item of els.segments) item.classList.toggle("is-active", item === segment);
    renderCards();
  });
}

loadLatest().catch((error) => {
  els.statusLine.textContent = error.message || String(error);
});

window.setInterval(() => {
  if (refreshTimer) return;
  loadLatest({ silent: true, onlyIfChanged: true }).catch(() => {
    // Keep the current dashboard visible if a background poll misses once.
  });
}, AUTO_RELOAD_INTERVAL_MS);
