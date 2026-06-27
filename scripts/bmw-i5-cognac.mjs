import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const reportsDir = path.join(rootDir, "reports");
const latestJsonPath = path.join(dataDir, "latest.json");
const latestReportPath = path.join(reportsDir, "latest.md");
const searchCachePath = path.join(dataDir, "search-cache.json");
const seedSearchCachePath = path.join(rootDir, "seed-data", "data", "search-cache.json");
const refreshLogPath = path.join(dataDir, "refresh.log");

const MODEL_RANGES = ["i4_G26E", "i5_G60E", "i5_G61E", "iX1_U11E"];
const FILTERS_PARAM = encodeURIComponent(encodeURIComponent(JSON.stringify({ MARKETING_MODEL_RANGE: MODEL_RANGES })));

const INVENTORIES = [
  {
    key: "new",
    label: "New car",
    finderPath: "vehiclefinder",
    sorting: "PRODUCTION_DATE_DESC",
    sourceUrl: `https://www.bmw.be/nl-be/sl/vehiclefinder/results?filters=${FILTERS_PARAM}&sorting=PRODUCTION_DATE_DESC`,
  },
  {
    key: "used",
    label: "Occasion",
    finderPath: "vehiclefinder_uc",
    sorting: "PRICE_ASC",
    sourceUrl: `https://www.bmw.be/nl-be/sl/vehiclefinder_uc/results?filters=${FILTERS_PARAM}&sorting=PRICE_ASC`,
  },
];

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : null,
  process.env.DISABLE_SYSTEM_CHROME !== "1"
    ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
    : null,
  process.env.DISABLE_SYSTEM_CHROME !== "1"
    ? { executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" }
    : null,
  process.env.USE_SYSTEM_CHROME
    ? { channel: "chrome", executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
    : null,
  process.env.USE_SYSTEM_CHROME
    ? { channel: "msedge", executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" }
    : null,
].filter(Boolean);

export function isoDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Brussels",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function appendRefreshLog(line) {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.appendFile(refreshLogPath, `${line}\n`, "utf8");
  } catch {
    // Best-effort logging only.
  }
}

function logEvent(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  void appendRefreshLog(line);
}

function logError(message, error) {
  const line = `[${new Date().toISOString()}] ${message}: ${toShortError(error)}`;
  console.warn(line);
  void appendRefreshLog(line);
  const details = toErrorDetails(error, 20_000);
  if (details) void appendRefreshLog(details);
}

async function findBrowserLaunchOptions() {
  if (process.env.CHROME_PATH && (await exists(process.env.CHROME_PATH))) {
    return { executablePath: process.env.CHROME_PATH };
  }

  if (process.env.USE_SYSTEM_CHROME === "1") {
    for (const candidate of BROWSER_CANDIDATES) {
      if (candidate?.channel && candidate.executablePath && (await exists(candidate.executablePath))) {
        return { channel: candidate.channel };
      }
      if (candidate?.executablePath && (await exists(candidate.executablePath))) {
        return { executablePath: candidate.executablePath };
      }
    }
  }

  return {};
}

function setSearchParam(url, key, value) {
  const parsed = new URL(url);
  parsed.searchParams.set(key, String(value));
  return parsed.toString();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stripAnsi(value) {
  return String(value || "").replace(
    // eslint-disable-next-line no-control-regex
    /\u001B\[[0-?]*[ -/]*[@-~]/g,
    "",
  );
}

function errorChain(error) {
  const chain = [];
  let current = error;
  const seen = new Set();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function formatErrorChain(error) {
  const chain = errorChain(error);
  const parts = [];
  for (const item of chain) {
    const message = stripAnsi(item?.message || String(item));
    const code = typeof item?.code === "string" ? item.code : "";
    const name = typeof item?.name === "string" ? item.name : "";
    const header = [name, code].filter(Boolean).join(" ");
    parts.push(header ? `${header}: ${message}` : message);
  }
  return parts.filter(Boolean).join(" -> ");
}

function toShortError(error) {
  const stripped = formatErrorChain(error) || stripAnsi(error?.message || String(error));
  const firstLine = stripped.split("\n")[0] || "unknown error";
  return firstLine.length > 240 ? `${firstLine.slice(0, 237)}...` : firstLine;
}

function toErrorDetails(error, max = 4000) {
  const details = formatErrorChain(error) || stripAnsi(error?.message || String(error));
  const stack = stripAnsi(error?.stack || "");
  const stripped = [details, stack].filter(Boolean).join("\n\n");
  if (stripped.length <= max) return stripped;
  return `${stripped.slice(0, max - 3)}...`;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function loadSearchCache() {
  try {
    const cachePath = (await exists(searchCachePath))
      ? searchCachePath
      : (await exists(seedSearchCachePath))
        ? seedSearchCachePath
        : "";
    if (!cachePath) return { inventories: {} };
    const cache = await readJson(cachePath);
    if (!cache || typeof cache !== "object") return { inventories: {} };
    if (!cache.inventories || typeof cache.inventories !== "object") return { inventories: {} };
    return cache;
  } catch {
    return { inventories: {} };
  }
}

async function saveSearchCache(cache) {
  await fs.mkdir(dataDir, { recursive: true });
  await writeJson(searchCachePath, cache);
}

async function getCachedSearchRequest(inventory) {
  const cache = await loadSearchCache();
  const entry = cache.inventories?.[inventory.key];
  if (!entry?.url || !entry?.postData) return null;
  return { url: entry.url, postData: entry.postData, headers: entry.headers || {}, capturedAt: entry.capturedAt || "" };
}

async function setCachedSearchRequest(inventory, searchRequest) {
  const cache = await loadSearchCache();
  cache.inventories ||= {};
  cache.inventories[inventory.key] = {
    url: searchRequest.url,
    postData: searchRequest.postData,
    headers: searchRequest.headers || {},
    capturedAt: new Date().toISOString(),
  };
  await saveSearchCache(cache);
}

function getLocalizedName(value) {
  if (!value) return "";
  const result =
    typeof value === "string"
      ? value
      : value.nl_BE || value.default_BE || value.en_BE || value.fr_BE || Object.values(value)[0] || "";
  return String(result || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\s+/g, " ")
    .trim();
}

function formatClusterName(value) {
  return String(value || "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function getEquipments(vehicle) {
  return vehicle.vehicleSpecification?.modelAndOption?.equipments || {};
}

function getEquipmentEntries(vehicle) {
  const equipments = getEquipments(vehicle);
  return Object.entries(equipments).map(([code, equipment]) => ({
    code: code || "",
    type: equipment?.type || "",
    name: getLocalizedName(equipment?.marketingText?.name || equipment?.name),
  }));
}

function getFeatureNames(vehicle) {
  const entries = getEquipmentEntries(vehicle);
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (!entry?.name) continue;
    if (entry.type === "UPHOLSTERY" || entry.type === "COLOR") continue;
    const key = normalizeText(entry.name);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry.name);
  }
  result.sort((a, b) => a.localeCompare(b, "nl-BE"));
  return result;
}

function getEquipmentText(vehicle) {
  return normalizeText(JSON.stringify(getEquipments(vehicle)));
}

function hasEquipment(vehicle, codes, textNeedles = []) {
  const equipments = getEquipments(vehicle);
  if (codes.some((code) => equipments[code])) return true;

  const equipmentText = getEquipmentText(vehicle);
  return textNeedles.some((needle) => equipmentText.includes(needle));
}

function getPrice(vehicle) {
  const price =
    vehicle.vehicleSpecification?.prices?.currentPrice ||
    vehicle.prices?.currentPrice ||
    vehicle.price ||
    vehicle.pricing?.price ||
    {};

  if (typeof price === "number") return price;
  return (
    price.grossSalesPrice ||
    price.modelSalesPriceGross ||
    price.vehicleGrossPrice ||
    price.grossListPrice ||
    price.grossValue ||
    price.amount ||
    null
  );
}

function getModelTitle(vehicle, bodyStyle) {
  const modelAndOption = vehicle.vehicleSpecification?.modelAndOption || {};
  const model = modelAndOption.model || {};
  const modelName =
    model.modelName ||
    getLocalizedName(model.modelDescription) ||
    model.derivative ||
    getLocalizedName(modelAndOption.modelDescription);

  if (!modelName) {
    const family = getModelFamily(inferModelRange(vehicle));
    return family === "BMW" ? `BMW ${bodyStyle}` : `BMW ${family} ${bodyStyle}`;
  }
  return modelName.toLowerCase().startsWith("bmw ") ? modelName : `BMW ${modelName}`;
}

function getPricingTimestamps(vehicle) {
  const updatedAt = vehicle.internal?.updatedAt || vehicle.internal?.updated || "";
  const enrichedAt = vehicle.internal?.enrichedAt || vehicle.internal?.enriched || updatedAt || "";
  return { updatedAt, enrichedAt };
}

function getMileageKm(vehicle, inventory) {
  const mileage = vehicle.vehicleLifeCycle?.mileage || vehicle.mileage;
  if (typeof mileage === "number") return mileage;
  if (mileage?.km != null) return mileage.km;
  return inventory.key === "new" ? 0 : null;
}

function getUpholstery(vehicle) {
  const modelAndOption = vehicle.vehicleSpecification?.modelAndOption || {};
  const upholstery = Object.entries(getEquipments(vehicle)).find(
    ([, equipment]) => equipment?.type === "UPHOLSTERY",
  );
  const [code, equipment] = upholstery || [];

  return {
    cluster: modelAndOption.upholsteryColor?.upholsteryColorCluster || "",
    type: modelAndOption.upholsteryType || "",
    code: code || "",
    name: getLocalizedName(equipment?.marketingText?.name || equipment?.name),
  };
}

function getExteriorColor(vehicle) {
  const modelAndOption = vehicle.vehicleSpecification?.modelAndOption || {};
  const paint = Object.values(getEquipments(vehicle)).find((equipment) => equipment?.type === "COLOR");
  return (
    getLocalizedName(paint?.marketingText?.name || paint?.name) ||
    getLocalizedName(modelAndOption.exteriorColor?.marketingText?.name || modelAndOption.exteriorColor?.name) ||
    formatClusterName(modelAndOption.color?.clusterFine) ||
    formatClusterName(modelAndOption.color?.clusterRough) ||
    ""
  );
}

function getImage(vehicle) {
  const usedImages = vehicle.media?.usedCarImages || {};
  const cosyImages = vehicle.media?.cosyImages || {};
  return (
    usedImages["EXTERIOR_FRONT-0"] ||
    usedImages["EXTERIOR_FRONT-10"] ||
    Object.values(usedImages)[0] ||
    cosyImages["exteriorImage-null"] ||
    Object.values(cosyImages)[0] ||
    ""
  );
}

function getDealerName(vehicle) {
  return (
    vehicle.ordering?.retailData?.locationOutletName ||
    vehicle.ordering?.distributionData?.locationOutletNickname ||
    vehicle.dealer?.name ||
    vehicle.businessPartner?.name ||
    vehicle.location?.dealerName ||
    vehicle.retailer?.name ||
    ""
  );
}

function getDealerCity(vehicle) {
  const address = vehicle.ordering?.retailData?.locationOutletAddress || {};
  return (
    address.city ||
    [address.postalCode, address.country].filter(Boolean).join(" ") ||
    vehicle.dealer?.address?.city ||
    vehicle.businessPartner?.address?.city ||
    vehicle.location?.city ||
    ""
  );
}

function hasTowHitch(vehicle) {
  return hasEquipment(vehicle, ["S03AC"], [
    "trailer hitch",
    "trailer coupling",
    "trekhaak",
    "attelage",
    "anhängerkupplung",
    "aanhangwagenkoppeling",
  ]);
}

function hasDrivingAssistantPro(vehicle) {
  return hasEquipment(vehicle, ["S05AU"], [
    "driving assistant pack professional",
    "driving assistant professional",
    "driving assistant pro",
    "drive assist pro",
    "rijassistent professional",
    "driving assistant professionnel",
  ]);
}

function hasParking360(vehicle) {
  return hasEquipment(vehicle, ["S05DN", "S05DW"], [
    "parking assistant pack plus",
    "parking assistant plus",
    "parking assistant professional",
    "parking assistant pro",
    "surround view",
    "360",
    "parkeerassistent plus",
    "parkeerassistent professional",
    "assistant de stationnement plus",
    "assistant de stationnement professional",
  ]);
}

function inferModelRange(vehicle) {
  const modelAndOption = vehicle.vehicleSpecification?.modelAndOption || {};
  const candidates = [
    modelAndOption.modelDescription,
    modelAndOption.marketingModelRange,
    modelAndOption.modelRange,
    modelAndOption.model?.marketingModelRange,
    modelAndOption.model?.marketingModelRange?.value,
    vehicle.model?.marketingModelRange,
  ];
  const text = `${candidates.map((value) => JSON.stringify(value || "")).join(" ")} ${JSON.stringify(modelAndOption)}`;

  if (text.includes("i4_G26E")) return "i4_G26E";
  if (text.includes("i5_G61E")) return "i5_G61E";
  if (text.includes("i5_G60E")) return "i5_G60E";
  if (text.includes("iX1_U11E")) return "iX1_U11E";
  return "";
}

function getModelFamily(modelRange) {
  if (modelRange.startsWith("i4_")) return "i4";
  if (modelRange.startsWith("i5_")) return "i5";
  if (modelRange.startsWith("iX1_")) return "iX1";
  return "BMW";
}

function getBodyStyle(modelRange) {
  if (modelRange === "i4_G26E") return "Gran Coupe";
  if (modelRange === "i5_G61E") return "Touring";
  if (modelRange === "i5_G60E") return "Sedan";
  if (modelRange === "iX1_U11E") return "SUV";
  return "Unknown";
}

function makeDetailUrl(vehicle, inventory) {
  return `https://www.bmw.be/nl-be/sl/${inventory.finderPath}/details/${vehicle.vssId}`;
}

function makePricingUrl(vehicle, inventory, hash) {
  if (!vehicle.vssId || !hash) return "";

  const url = new URL(`https://stolo-data-service.prod.stolo.eu-central-1.aws.bmw.cloud/vehicle/nl-be/${inventory.finderPath}/${vehicle.vssId}/pricing`);
  const { updatedAt, enrichedAt } = getPricingTimestamps(vehicle);
  url.searchParams.set("context", "details-page");
  if (updatedAt) url.searchParams.set("updatedAt", updatedAt);
  if (enrichedAt) url.searchParams.set("enrichedAt", enrichedAt);
  url.searchParams.set("b2b", "false");
  url.searchParams.set("brand", "BMW");
  url.searchParams.set("hash", hash);
  return url.toString();
}

function isMerinoNonBlack(hit) {
  const upholstery = getUpholstery(hit.vehicle || {});
  const name = normalizeText(upholstery.name);
  const cluster = normalizeText(upholstery.cluster);

  if (!name.includes("merino")) return false;
  if (cluster === "black") return false;
  return !["black", "schwarz", "zwart", "noir"].some((needle) => name.includes(needle));
}

function isMAlcantaraInterior(hit) {
  const upholstery = getUpholstery(hit.vehicle || {});
  const name = normalizeText(upholstery.name);
  return (
    name.includes("binnenbekleding kunstleder veganza / m alcantara combinatie schwarz") ||
    (name.includes("alcantara") && name.includes("veganza") && name.includes("schwarz"))
  );
}

function getInteriorCategory(hit) {
  if (isMerinoNonBlack(hit)) return "Merino non-black";
  if (isMAlcantaraInterior(hit)) return "M Alcantara";
  return "";
}

function isWantedMatch(hit) {
  const vehicle = hit.vehicle || {};
  return Boolean(getInteriorCategory(hit)) && hasDrivingAssistantPro(vehicle) && hasParking360(vehicle);
}

function rankMatch(item) {
  const isIdeal =
    item.modelFamily === "i5" &&
    item.bodyStyle === "Touring" &&
    item.hasTowHitch &&
    item.upholstery.name.toLowerCase().includes("kupferbraun");

  return [
    isIdeal ? 0 : 1,
    item.modelFamily === "i5" ? 0 : 1,
    item.bodyStyle === "Touring" ? 0 : 1,
    item.hasTowHitch ? 0 : 1,
    item.upholstery.name.toLowerCase().includes("kupferbraun") ? 0 : 1,
    item.interiorCategory === "Merino non-black" ? 0 : 1,
    item.inventoryType === "used" ? 0 : 1,
    item.priceEur || Number.MAX_SAFE_INTEGER,
  ];
}

function compareRank(a, b) {
  const left = rankMatch(a);
  const right = rankMatch(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function normalizeVehicle(hit, inventory) {
  const vehicle = hit.vehicle;
  const modelRange = inferModelRange(vehicle);
  const modelFamily = getModelFamily(modelRange);
  const bodyStyle = getBodyStyle(modelRange);
  const upholstery = getUpholstery(vehicle);
  const features = getFeatureNames(vehicle);
  const equipmentEntries = getEquipmentEntries(vehicle);
  const towHitch = hasTowHitch(vehicle);
  const drivingAssistantPro = hasDrivingAssistantPro(vehicle);
  const parking360 = hasParking360(vehicle);
  const listPriceEur = getPrice(vehicle);
  const interiorCategory = getInteriorCategory(hit);
  const targetMatch = isWantedMatch(hit);

  return {
    id: `${inventory.key}:${vehicle.documentId || vehicle.vssId}`,
    documentId: vehicle.documentId || "",
    vssId: vehicle.vssId || "",
    title: getModelTitle(vehicle, bodyStyle),
    model: modelRange,
    modelFamily,
    bodyStyle,
    inventoryType: inventory.key,
    inventoryLabel: inventory.label,
    hasTowHitch: towHitch,
    hasDrivingAssistantPro: drivingAssistantPro,
    hasParking360: parking360,
    interiorCategory,
    isTargetMatch: targetMatch,
    isIdeal: modelFamily === "i5" && bodyStyle === "Touring" && towHitch && upholstery.name.toLowerCase().includes("kupferbraun"),
    priceEur: listPriceEur,
    listPriceEur,
    priceLabel: "BMW search price",
    formattedPrice: "",
    mileageKm: getMileageKm(vehicle, inventory),
    registrationDate: vehicle.vehicleLifeCycle?.registrationDate || vehicle.registrationDate || "",
    updatedAt:
      vehicle.internal?.updatedAt ||
      vehicle.internal?.enrichedAt ||
      vehicle.vehicleSpecification?.prices?.currentPrice?.priceUpdatedAt ||
      "",
    exteriorColor:
      getExteriorColor(vehicle),
    upholstery,
    features,
    equipmentCodes: equipmentEntries.map((entry) => entry.code).filter(Boolean),
    dealer: getDealerName(vehicle),
    city: getDealerCity(vehicle),
    detailUrl: makeDetailUrl(vehicle, inventory),
    sourceUrl: inventory.sourceUrl,
    imageUrl: getImage(vehicle),
  };
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get("retry-after") || 0);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1_000;
  if (response?.status === 429) return 15_000 * attempt;
  return 2_000 * attempt;
}

function replayHeaders(headers = {}) {
  const allowed = [
    "accept",
    "accept-language",
    "content-type",
    "referer",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "user-agent",
    "x-api-key",
  ];
  const result = {};
  for (const key of allowed) {
    if (headers[key]) result[key] = headers[key];
  }
  return result;
}

async function fetchJson(url, postData, attempts = 8, requestHeaders = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: "https://www.bmw.be",
          referer: "https://www.bmw.be/",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          ...replayHeaders(requestHeaders),
        },
        body: postData,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      if (!response.ok) {
        await sleep(retryDelayMs(response, attempt));
        throw new Error(`BMW API ${response.status}: ${text.slice(0, 500)}`);
      }
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      await sleep(2_000 * attempt);
    }
  }
  const finalError = new Error(`BMW fetch failed: ${toShortError(lastError)}`, { cause: lastError });
  throw finalError;
}

async function fetchDealerPricing(vehicle, inventory, hash, requestHeaders = {}) {
  const pricingUrl = makePricingUrl(vehicle, inventory, hash);
  if (!pricingUrl) return null;

  const body = JSON.stringify({
    installmentFilters: {
      sfOfferCalculationSearchBody: {
        productCategoryType: {
          value: ["LEASE", "LOAN"],
        },
      },
      isMonthlyInstallmentSelected: null,
    },
    selectedAccessories: [{ quantity: 1, accessoryId: "SE000001" }],
  });

  try {
    const pricing = await fetchJson(pricingUrl, body, 2, requestHeaders);
    const price = pricing?.price || {};
    if (!price.value) return null;
    return {
      priceEur: price.value,
      formattedPrice: price.formattedPrice || "",
      priceLabel: price.label || "Dealer price",
      isOfferPriceAvailable: Boolean(price.isOfferPriceAvailable),
    };
  } catch {
    return null;
  }
}

async function enrichMatchesWithDealerPricing(matches, hitByVssId, inventory, hash, requestHeaders = {}) {
  for (const match of matches) {
    const vehicle = hitByVssId.get(match.vssId)?.vehicle;
    if (!vehicle) continue;

    const pricing = await fetchDealerPricing(vehicle, inventory, hash, requestHeaders);
    if (pricing) Object.assign(match, pricing);
    await sleep(400);
  }
}

async function captureSearchRequest(page, inventory) {
  let searchRequest;
  page.on("request", (request) => {
    if (!searchRequest && request.url().includes("/vehiclesearch/search/")) {
      searchRequest = {
        url: request.url(),
        postData: request.postData(),
        headers: request.headers(),
      };
    }
  });

  await page.goto(inventory.sourceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const started = Date.now();
  while (!searchRequest && Date.now() - started < 45_000) {
    await page.waitForTimeout(500);
  }

  if (!searchRequest?.url || !searchRequest?.postData) {
    throw new Error(`Could not capture BMW ${inventory.label} search request.`);
  }

  return searchRequest;
}

async function scrapeInventory(browser, inventory) {
  let searchRequest;
  if (process.env.SCRAPE_MODE === "cache" || !browser) {
    const cached = await getCachedSearchRequest(inventory);
    if (!cached) {
      const modeHint = !browser ? "No browser available" : "SCRAPE_MODE=cache is set";
      throw new Error(`${modeHint} and no cached search request exists for ${inventory.label}.`);
    }
    logEvent(`Using cached search request for ${inventory.label}${cached.capturedAt ? ` (captured ${cached.capturedAt})` : ""}.`);
    searchRequest = { url: cached.url, postData: cached.postData, headers: cached.headers || {} };
  } else {
    const page = await browser.newPage({
      locale: "nl-BE",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });

    try {
      searchRequest = await captureSearchRequest(page, inventory);
      await setCachedSearchRequest(inventory, searchRequest);
      logEvent(`Captured search request for ${inventory.label} (and saved to cache).`);
    } catch (error) {
      const cached = await getCachedSearchRequest(inventory);
      if (!cached) throw error;
      logError(`Failed to capture ${inventory.label} search request; falling back to cached request`, error);
      searchRequest = { url: cached.url, postData: cached.postData, headers: cached.headers || {} };
    } finally {
      await page.close();
    }
  }

  const searchUrl = new URL(searchRequest.url);
  searchUrl.searchParams.set("maxResults", "12");

  const firstPage = await fetchJson(searchUrl.toString(), searchRequest.postData, 8, searchRequest.headers);
  const hash = searchUrl.searchParams.get("hash") || "";
  const totalCount = firstPage.metadata?.totalCount || firstPage.hits?.length || 0;
  const pageSize = Number(searchUrl.searchParams.get("maxResults") || 12);
  const hits = [...(firstPage.hits || [])];

  for (let startIndex = pageSize; startIndex < totalCount; startIndex += pageSize) {
    await sleep(3_000);
    const pageUrl = setSearchParam(searchUrl.toString(), "startIndex", startIndex);
    const pageData = await fetchJson(pageUrl, searchRequest.postData, 8, searchRequest.headers);
    hits.push(...(pageData.hits || []));
  }

  const vehicles = hits.map((hit) => normalizeVehicle(hit, inventory));
  const matches = vehicles.filter((item) => item.isTargetMatch);
  const hitByVssId = new Map(hits.map((hit) => [hit.vehicle?.vssId, hit]).filter(([vssId]) => vssId));
  logEvent(`Fetched ${hits.length}/${totalCount} ${inventory.label} vehicles; enriching ${matches.length} matches.`);
  await enrichMatchesWithDealerPricing(matches, hitByVssId, inventory, hash, searchRequest.headers);
  return { inventory, totalCount, hitsCount: hits.length, vehicles, matches };
}

export async function scrape() {
  let browser = null;
  if (process.env.SCRAPE_MODE !== "cache") {
    const launchOptions = await findBrowserLaunchOptions();
    try {
      logEvent(
        `Launching browser (headless=true, SCRAPE_MODE=${process.env.SCRAPE_MODE || "live"}, USE_SYSTEM_CHROME=${process.env.USE_SYSTEM_CHROME ? "1" : "0"}).`,
      );
      browser = await chromium.launch({ headless: true, ...launchOptions });
      logEvent(`Browser launched${Object.keys(launchOptions).length ? ` (${JSON.stringify(launchOptions)})` : " (Playwright-managed Chromium)"}.`);
    } catch (error) {
      logError("Browser launch failed", error);
      browser = null;
    }
  }

  try {
    const results = [];
    for (const inventory of INVENTORIES) {
      logEvent(`Fetching inventory: ${inventory.label}.`);
      results.push(await scrapeInventory(browser, inventory));
    }

    const vehicles = results.flatMap((result) => result.vehicles).sort(compareRank);
    const matches = vehicles.filter((item) => item.isTargetMatch).sort(compareRank);
    const inventoryCounts = Object.fromEntries(
      results.map((result) => [
        result.inventory.key,
        {
          label: result.inventory.label,
          scanned: result.totalCount,
          fetched: result.hitsCount,
          vehicles: result.vehicles.length,
          matches: result.matches.length,
        },
      ]),
    );

    return {
      generatedAt: new Date().toISOString(),
      sourceUrls: Object.fromEntries(INVENTORIES.map((inventory) => [inventory.key, inventory.sourceUrl])),
      filters: {
        model: MODEL_RANGES,
      },
      totalScanned: results.reduce((sum, result) => sum + result.totalCount, 0),
      vehicleCount: vehicles.length,
      inventoryCounts,
      matchCount: matches.length,
      vehicles,
      matches,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function indexById(items) {
  return new Map(items.map((item) => [item.id, item]));
}

export function compare(previous, current) {
  const prevById = indexById(previous?.matches || []);
  const currentById = indexById(current.matches || []);

  const added = current.matches.filter((item) => !prevById.has(item.id));
  const removed = (previous?.matches || []).filter((item) => !currentById.has(item.id));
  const changed = [];

  for (const item of current.matches) {
    const old = prevById.get(item.id);
    if (!old) continue;

    const changes = [];
    for (const field of [
      "priceEur",
      "listPriceEur",
      "mileageKm",
      "registrationDate",
      "dealer",
      "city",
      "hasTowHitch",
      "hasDrivingAssistantPro",
      "hasParking360",
      "interiorCategory",
      "exteriorColor",
      "inventoryType",
      "bodyStyle",
      "title",
      "modelFamily",
    ]) {
      if ((old[field] ?? "") !== (item[field] ?? "")) {
        changes.push({ field, before: old[field] ?? "", after: item[field] ?? "" });
      }
    }
    if (changes.length) changed.push({ item, changes });
  }

  return { added, removed, changed };
}

export function money(value) {
  if (!value) return "price unknown";
  return `EUR ${Number(value).toLocaleString("nl-BE")}`;
}

function priceText(item) {
  if (!item.priceEur) return "price unknown";
  const price = item.formattedPrice || money(item.priceEur);
  const label = item.priceLabel ? `${item.priceLabel}: ` : "";
  if (item.listPriceEur && item.listPriceEur !== item.priceEur) {
    return `${label}${price} (list ${money(item.listPriceEur)})`;
  }
  return `${label}${price}`;
}

export function km(value) {
  if (value == null) return "km unknown";
  return `${Number(value).toLocaleString("nl-BE")} km`;
}

function listingLine(item) {
  const place = [item.dealer, item.city].filter(Boolean).join(", ");
  const upholstery = [item.upholstery?.name, item.upholstery?.type].filter(Boolean).join(" | ");
  return `- ${item.inventoryLabel} | ${item.title || `BMW ${item.modelFamily || ""} ${item.bodyStyle || ""}`.trim()} | ${priceText(item)} | ${km(item.mileageKm)} | ${place || "dealer unknown"} | ${upholstery || "Interior"} | [open listing](${item.detailUrl})`;
}

function countBy(list, selector) {
  const counts = {};
  for (const item of list || []) {
    const key = selector(item);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function getCount(counts, key) {
  return counts?.[key] || 0;
}

export function renderReport(current, previous, diff) {
  const previousRun = previous?.generatedAt || "none";
  const newCounts = current.inventoryCounts?.new;
  const usedCounts = current.inventoryCounts?.used;
  const refresh = current.refresh || null;
  const scannedByModel = countBy(current.vehicles, (vehicle) => vehicle.model);
  const matchByModel = countBy(current.matches, (match) => match.model);
  const scannedByFamily = countBy(current.vehicles, (vehicle) => vehicle.modelFamily);
  const matchByFamily = countBy(current.matches, (match) => match.modelFamily);
  const scannedI5ByBody = countBy(
    (current.vehicles || []).filter((vehicle) => vehicle.modelFamily === "i5"),
    (vehicle) => vehicle.bodyStyle,
  );
  const matchI5ByBody = countBy(
    (current.matches || []).filter((match) => match.modelFamily === "i5"),
    (match) => match.bodyStyle,
  );
  const lines = [
    "# BMW i4/i5/iX1 Filter Browser",
    "",
    `Generated: ${current.generatedAt}`,
    `Previous baseline: ${previousRun}`,
    ...(refresh
      ? [
          `Refresh attempted: ${refresh.attemptedAt || "unknown"}`,
          `Refresh status: ${refresh.ok ? "OK" : `FAILED (${refresh.errorShort || refresh.error || "unknown error"})`}`,
        ]
      : []),
    `BMW i4/i5/iX1 vehicles scanned: ${current.totalScanned}`,
    `New cars scanned: ${newCounts?.scanned ?? 0}; matches: ${newCounts?.matches ?? 0}`,
    `Occasions scanned: ${usedCounts?.scanned ?? 0}; matches: ${usedCounts?.matches ?? 0}`,
    `Filtered matches: ${current.matchCount}`,
    "",
    "## Model-family counts (scanned / matches)",
    "",
    `- i4: ${getCount(scannedByFamily, "i4")} / ${getCount(matchByFamily, "i4")}`,
    `- i5 Sedan: ${getCount(scannedI5ByBody, "Sedan")} / ${getCount(matchI5ByBody, "Sedan")}`,
    `- i5 Touring: ${getCount(scannedI5ByBody, "Touring")} / ${getCount(matchI5ByBody, "Touring")}`,
    `- iX1: ${getCount(scannedByFamily, "iX1")} / ${getCount(matchByFamily, "iX1")}`,
    "",
    "## Model range counts (scanned / matches)",
    "",
    ...MODEL_RANGES.map(
      (model) => `- ${model}: ${getCount(scannedByModel, model)} / ${getCount(matchByModel, model)}`,
    ),
    "",
    "## Daily changes",
    "",
    `New: ${diff.added.length}`,
    `Changed: ${diff.changed.length}`,
    `Removed: ${diff.removed.length}`,
    "",
  ];

  if (diff.added.length) {
    lines.push("### New matches", "", ...diff.added.map(listingLine), "");
  }

  if (diff.changed.length) {
    lines.push("### Changed matches", "");
    for (const { item, changes } of diff.changed) {
      lines.push(listingLine(item));
      for (const change of changes) {
        lines.push(`  - ${change.field}: ${change.before || "blank"} -> ${change.after || "blank"}`);
      }
    }
    lines.push("");
  }

  if (diff.removed.length) {
    lines.push("### Removed matches", "", ...diff.removed.map(listingLine), "");
  }

  lines.push("## Current matches", "", ...current.matches.map(listingLine), "");
  lines.push("Source searches:");
  for (const [inventory, sourceUrl] of Object.entries(current.sourceUrls || {})) {
    lines.push(`- ${inventory}: ${sourceUrl}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function runScrapeAndWrite() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });

  const previous = (await exists(latestJsonPath))
    ? JSON.parse(await fs.readFile(latestJsonPath, "utf8"))
    : null;

  const attemptedAt = new Date().toISOString();
  let current;
  let scrapeError = null;
  try {
    current = await scrape();
    current.refresh = { attemptedAt, ok: true, errorShort: "", errorDetails: "" };
  } catch (error) {
    scrapeError = error;
    if (!previous) throw error;
    current = {
      ...previous,
      refresh: {
        attemptedAt,
        ok: false,
        errorShort: toShortError(error),
        errorDetails: toErrorDetails(error),
      },
    };
  }
  const diff = compare(previous, current);
  current.previousGeneratedAt = previous?.generatedAt || null;
  current.changes = {
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
  };
  const report = renderReport(current, previous, diff);
  const today = isoDate();

  await writeJson(path.join(dataDir, `history-${today}.json`), current);
  await writeJson(latestJsonPath, current);
  await fs.writeFile(latestReportPath, report);

  console.log(report);
  if (scrapeError) {
    console.warn(
      `Scrape failed (${scrapeError?.message || String(scrapeError)}); wrote stale snapshot with refresh status.`,
    );
  }
  return { current, previous, diff, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runScrapeAndWrite().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
