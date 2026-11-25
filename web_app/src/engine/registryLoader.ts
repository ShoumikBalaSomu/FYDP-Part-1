import { assertMaxJsonDepth } from "./esrcAdapter";
import type { ModelEntry, ModelRegistry } from "./types";

const LOCAL_MODELS_STORAGE_KEY = "somsense_local_aez_models_v1";
const IDB_NAME = "somsense_local_db";
const IDB_STORE = "calibrated_models";
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const LOCAL_MODEL_ID_RE = /^local_[a-z0-9_]+$/;

type RawJsonNode =
  | { kind: "obj"; entries: Array<[string, RawJsonNode]> }
  | { kind: "arr"; items: RawJsonNode[] }
  | { kind: "str"; val: string }
  | { kind: "lit"; raw: string };

/**
 * Lossless JSON AST parser preserving exact numeric tokens (e.g. "0.0", "1.0", "30.0")
 * so canonical serialization matches Python json.dumps(sort_keys=True, separators=(",", ":")).
 */
function parseRawJsonAst(src: string): RawJsonNode {
  assertMaxJsonDepth(src, 32);
  let i = 0;

  const skipWs = (): void => {
    while (i < src.length) {
      const ch = src[i];
      if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
        i++;
      } else {
        break;
      }
    }
  };

  const parseString = (): string => {
    const start = i;
    i++; // opening quote
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        break;
      }
      i++;
    }
    return JSON.parse(src.slice(start, i)) as string;
  };

  const parseValue = (): RawJsonNode => {
    skipWs();
    const ch = src[i];
    if (ch === "{") {
      i++;
      const entries: Array<[string, RawJsonNode]> = [];
      skipWs();
      if (src[i] === "}") {
        i++;
        return { kind: "obj", entries };
      }
      while (i < src.length) {
        skipWs();
        if (src[i] !== '"') {
          throw new Error(`Invalid JSON object key at offset ${i}`);
        }
        const key = parseString();
        if (FORBIDDEN_KEYS.has(key)) {
          throw new Error(`Rejected forbidden key in registry JSON: ${key}`);
        }
        skipWs();
        if (src[i] !== ":") {
          throw new Error(`Expected ':' at offset ${i}`);
        }
        i++;
        const val = parseValue();
        entries.push([key, val]);
        skipWs();
        if (src[i] === "}") {
          i++;
          break;
        }
        if (src[i] !== ",") {
          throw new Error(`Expected ',' or '}' at offset ${i}`);
        }
        i++;
      }
      return { kind: "obj", entries };
    }

    if (ch === "[") {
      i++;
      const items: RawJsonNode[] = [];
      skipWs();
      if (src[i] === "]") {
        i++;
        return { kind: "arr", items };
      }
      while (i < src.length) {
        items.push(parseValue());
        skipWs();
        if (src[i] === "]") {
          i++;
          break;
        }
        if (src[i] !== ",") {
          throw new Error(`Expected ',' or ']' at offset ${i}`);
        }
        i++;
      }
      return { kind: "arr", items };
    }

    if (ch === '"') {
      return { kind: "str", val: parseString() };
    }
    if (src.startsWith("true", i)) {
      i += 4;
      return { kind: "lit", raw: "true" };
    }
    if (src.startsWith("false", i)) {
      i += 5;
      return { kind: "lit", raw: "false" };
    }
    if (src.startsWith("null", i)) {
      i += 4;
      return { kind: "lit", raw: "null" };
    }

    const start = i;
    while (i < src.length) {
      const c = src[i];
      if (c !== undefined && /[-0-9eE.+]/.test(c)) {
        i++;
      } else {
        break;
      }
    }
    if (i === start) {
      throw new Error(`Unexpected token in JSON at offset ${i}`);
    }
    const rawNum = src.slice(start, i);
    if (!Number.isFinite(Number(rawNum))) {
      throw new Error(`Non-finite numeric literal in registry JSON: ${rawNum}`);
    }
    return { kind: "lit", raw: rawNum };
  };

  return parseValue();
}

function serializeCanonicalAst(node: RawJsonNode, excludeRootKey: string | null): string {
  if (node.kind === "lit") return node.raw;
  if (node.kind === "str") return JSON.stringify(node.val);
  if (node.kind === "arr") {
    return `[${node.items.map((item) => serializeCanonicalAst(item, null)).join(",")}]`;
  }
  const filtered = node.entries
    .filter(([k]) => k !== excludeRootKey)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${filtered
    .map(([k, v]) => `${JSON.stringify(k)}:${serializeCanonicalAst(v, null)}`)
    .join(",")}}`;
}

export async function sha256HexUtf8(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto subtle SHA-256 is unavailable in this environment.");
  }
  const bytes = new TextEncoder().encode(text);
  const digestBuffer = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digestBuffer);
  return Array.from(view)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function canonicalJsonFromValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonFromValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys
      .filter((k) => rec[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJsonFromValue(rec[k])}`)
      .join(",")}}`;
  }
  return "null";
}

function assertValidRegistryStructure(doc: unknown): asserts doc is ModelRegistry {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("Registry payload is not a JSON object.");
  }
  const obj = doc as Record<string, unknown>;
  if (obj.platform !== "SOMSense-ESRC") {
    throw new Error(`Invalid registry platform: ${String(obj.platform)}`);
  }
  const auth = obj.authority_protocol as Record<string, unknown> | undefined;
  if (!auth || auth.forbid_direct_sensor_om !== true || auth.forbid_passive_c_subtraction !== true) {
    throw new Error("Registry failed authority_protocol guardrail checks.");
  }
  const models = obj.models as Record<string, unknown> | undefined;
  if (!models || typeof models !== "object" || Object.keys(models).length === 0) {
    throw new Error("Registry contains zero models.");
  }
  for (const [modelId, rawEntry] of Object.entries(models)) {
    const entry = rawEntry as Partial<ModelEntry>;
    if (
      !entry.model_id ||
      !entry.preprocessing?.raw_features?.length ||
      !entry.predictor ||
      !entry.uncertainty ||
      !entry.ood
    ) {
      throw new Error(`Model '${modelId}' failed structural registry schema validation.`);
    }
    const rawFeatSet = new Set(entry.preprocessing.raw_features);
    if (rawFeatSet.has("TN_pct") || rawFeatSet.has("total_nitrogen_pct")) {
      throw new Error(`Circular TN_pct leak detected inside model '${modelId}'.`);
    }
  }
}

export interface VerifiedRegistryLoadResult {
  registry: ModelRegistry;
  rootSha256: string;
  verifiedModels: number;
}

/**
 * Verify canonical_payload_sha256 and every model artifact_sha256 using WebCrypto SHA-256.
 */
export async function parseAndVerifyRegistryText(rawText: string): Promise<VerifiedRegistryLoadResult> {
  const ast = parseRawJsonAst(rawText);
  if (ast.kind !== "obj") {
    throw new Error("Registry root must be a JSON object.");
  }

  const parsed = JSON.parse(rawText) as unknown;
  assertValidRegistryStructure(parsed);

  const canonicalRoot = serializeCanonicalAst(ast, "integrity");
  const computedRootHash = await sha256HexUtf8(canonicalRoot);
  if (computedRootHash !== parsed.integrity.canonical_payload_sha256) {
    throw new Error(
      `Registry SHA-256 mismatch: expected ${parsed.integrity.canonical_payload_sha256}, computed ${computedRootHash}.`
    );
  }

  const modelsNode = ast.entries.find(([k]) => k === "models")?.[1];
  if (!modelsNode || modelsNode.kind !== "obj") {
    throw new Error("Registry AST missing models object.");
  }

  let verifiedModels = 0;
  for (const [modelId, modelAst] of modelsNode.entries) {
    const entry = parsed.models[modelId];
    if (!entry) {
      throw new Error(`Missing model '${modelId}' during integrity verification.`);
    }
    const canonicalEntry = serializeCanonicalAst(modelAst, "artifact_sha256");
    const entryHash = await sha256HexUtf8(canonicalEntry);
    if (entryHash !== entry.artifact_sha256) {
      throw new Error(
        `Model '${modelId}' artifact SHA-256 mismatch: expected ${entry.artifact_sha256}, computed ${entryHash}.`
      );
    }
    verifiedModels++;
  }

  return {
    registry: parsed,
    rootSha256: computedRootHash,
    verifiedModels,
  };
}

export async function fetchAndVerifyRegistry(url = "./models/registry.json"): Promise<VerifiedRegistryLoadResult> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Failed to fetch model registry (${response.status} ${response.statusText}).`);
  }
  const rawText = await response.text();
  return parseAndVerifyRegistryText(rawText);
}

function isValidLocalModelEntry(key: string, candidate: unknown): candidate is ModelEntry {
  if (!LOCAL_MODEL_ID_RE.test(key)) return false;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const entry = candidate as Partial<ModelEntry>;
  if (entry.model_id !== key) return false;
  if (
    typeof entry.artifact_sha256 !== "string" ||
    !SHA256_HEX_RE.test(entry.artifact_sha256) ||
    entry.artifact_sha256 === "0".repeat(64)
  ) {
    return false;
  }
  if (!entry.preprocessing?.raw_features?.length || !entry.predictor || !entry.uncertainty || !entry.ood) {
    return false;
  }
  const rawFeatSet = new Set(entry.preprocessing.raw_features);
  if (rawFeatSet.has("TN_pct") || rawFeatSet.has("total_nitrogen_pct")) {
    return false;
  }
  return true;
}

export function loadLocalCalibratedModels(): Record<string, ModelEntry> {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_MODELS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw, (key, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) return undefined;
      return value;
    });
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const safeOut: Record<string, ModelEntry> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      if (isValidLocalModelEntry(k, v)) {
        safeOut[k] = v;
      }
    }
    return safeOut;
  } catch {
    return {};
  }
}

export function saveLocalCalibratedModel(entry: ModelEntry): void {
  const existing = loadLocalCalibratedModels();
  const updated: Record<string, ModelEntry> = {
    ...existing,
    [entry.model_id]: entry,
  };
  try {
    globalThis.localStorage?.setItem(LOCAL_MODELS_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage quota errors gracefully
  }

  // Mirror asynchronously into IndexedDB when supported
  if (typeof globalThis.indexedDB !== "undefined") {
    try {
      const req = globalThis.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "model_id" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(entry);
        tx.oncomplete = () => db.close();
      };
    } catch {
      // IndexedDB unavailable in restricted mode
    }
  }
}

export function clearAllLocalStorageAndCaches(): void {
  try {
    globalThis.localStorage?.clear();
  } catch {
    // Ignore storage access errors
  }
  if (typeof globalThis.indexedDB !== "undefined") {
    try {
      globalThis.indexedDB.deleteDatabase(IDB_NAME);
    } catch {
      // Ignore IndexedDB deletion errors
    }
  }
}
