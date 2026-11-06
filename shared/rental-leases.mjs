import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeShortAccessCode, SHORT_CODE_ALPHABET } from "./short-access-code.mjs";

const TOKEN_PREFIX = "pb_lease_v2";
const LEGACY_TOKEN_PREFIX = "pb_lease_v1";
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const MAX_CUSTOMER_LENGTH = 200;

function timestamp(value, label) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid.`);
  return new Date(parsed).toISOString();
}

function assignedDevices(input) {
  const raw = input.deviceIds ?? [input.deviceId];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) {
    throw new Error("Assign between 1 and 100 devices per customer access grant.");
  }
  const ids = raw.map(value => String(value ?? "").trim());
  if (ids.some(id => !DEVICE_ID_PATTERN.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("Assigned device IDs must be valid and unique.");
  }
  if (input.deviceId !== undefined && String(input.deviceId).trim() !== ids[0]) {
    throw new Error("The primary device must match the first assigned device.");
  }
  return ids;
}

export function rentalLeaseAllowsDevice(lease, deviceId) {
  return (lease.deviceIds ?? [lease.deviceId]).includes(deviceId);
}

function normalizedLease(value) {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const id = String(input.id ?? "").trim();
  const customer = String(input.customer ?? "").trim();
  const deviceIds = assignedDevices(input);
  const deviceId = deviceIds[0];
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Rental lease ID is invalid.");
  if (!customer || customer.length > MAX_CUSTOMER_LENGTH) {
    throw new Error("Rental customer is invalid.");
  }
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error("Rental device ID is invalid.");
  const startsAt = timestamp(input.startsAt, "Rental start");
  const expiresAt = timestamp(input.expiresAt, "Rental expiry");
  const createdAt = timestamp(input.createdAt, "Rental creation time");
  if (Date.parse(expiresAt) <= Date.parse(startsAt)) {
    throw new Error("Rental expiry must be after its start.");
  }
  const revokedAt = input.revokedAt === null || input.revokedAt === undefined
    ? null
    : timestamp(input.revokedAt, "Rental revocation time");
  return {
    id,
    customer,
    deviceId,
    deviceIds,
    startsAt,
    expiresAt,
    createdAt,
    revokedAt,
    scopes: ["device:read", "device:control"],
  };
}

export function normalizeRentalLeaseRegistry(value) {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  if (input.version !== undefined && input.version !== 1 && input.version !== 2) {
    throw new Error("Rental lease registry version is unsupported.");
  }
  if (input.leases !== undefined && !Array.isArray(input.leases)) {
    throw new Error("Rental lease registry is invalid.");
  }
  const leases = (input.leases ?? []).map(normalizedLease);
  return {
    // Older runtimes reject v2 instead of silently dropping additional devices.
    version: input.version === 2 || leases.some(lease => lease.deviceIds.length > 1) ? 2 : 1,
    leases,
  };
}

export async function readRentalLeaseRegistry(path) {
  try {
    return normalizeRentalLeaseRegistry(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, leases: [] };
    throw error;
  }
}

export async function writeRentalLeaseRegistry(path, registry) {
  const normalized = normalizeRentalLeaseRegistry(registry);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  return normalized;
}

export function monthlyLeaseEnd(start, months = 1) {
  if (!(start instanceof Date) || !Number.isFinite(start.getTime())) {
    throw new Error("Rental start date is invalid.");
  }
  if (!Number.isInteger(months) || months < 1 || months > 12) {
    throw new Error("Rental duration must be between 1 and 12 months.");
  }
  const end = new Date(start);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end;
}

export function rentalLeaseActive(lease, now = new Date()) {
  const at = now.getTime();
  return !lease.revokedAt &&
    Date.parse(lease.startsAt) <= at &&
    at < Date.parse(lease.expiresAt);
}

export function createRentalLease(registry, input, now = new Date()) {
  const current = normalizeRentalLeaseRegistry(registry);
  const deviceIds = assignedDevices(input);
  const deviceId = deviceIds[0];
  const customer = String(input.customer ?? "").trim();
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error("Rental device ID is invalid.");
  if (!customer || customer.length > MAX_CUSTOMER_LENGTH) {
    throw new Error("Customer name or email is required.");
  }
  if (current.leases.some((lease) =>
    deviceIds.some(id => rentalLeaseAllowsDevice(lease, id)) && rentalLeaseActive(lease, now)
  )) {
    throw new Error(`Device ${deviceId} already has an active rental lease.`);
  }
  const lease = normalizedLease({
    id: randomUUID(),
    customer,
    deviceId,
    deviceIds,
    startsAt: now.toISOString(),
    expiresAt: monthlyLeaseEnd(now, input.months ?? 1).toISOString(),
    createdAt: now.toISOString(),
    revokedAt: null,
  });
  return {
    lease,
    registry: normalizeRentalLeaseRegistry({ version: current.version, leases: [...current.leases, lease] }),
  };
}

export function renewRentalLease(registry, leaseId, months = 1, now = new Date()) {
  const current = normalizeRentalLeaseRegistry(registry);
  const existing = current.leases.find((lease) => lease.id === leaseId);
  if (!existing) throw new Error("Rental lease was not found.");
  if (existing.revokedAt) throw new Error("A revoked rental lease cannot be renewed.");
  if (current.leases.some(lease => lease.id !== existing.id && rentalLeaseActive(lease, now) &&
    existing.deviceIds.some(id => rentalLeaseAllowsDevice(lease, id)))) {
    throw new Error("An assigned device already has an active rental lease. Reassign devices before renewal.");
  }
  const base = Date.parse(existing.expiresAt) > now.getTime()
    ? new Date(existing.expiresAt)
    : now;
  const renewed = normalizedLease({
    ...existing,
    expiresAt: monthlyLeaseEnd(base, months).toISOString(),
  });
  return {
    lease: renewed,
    registry: {
      version: current.version,
      leases: current.leases.map((lease) => lease.id === leaseId ? renewed : lease),
    },
  };
}

export function revokeRentalLease(registry, leaseId, now = new Date()) {
  const current = normalizeRentalLeaseRegistry(registry);
  const existing = current.leases.find((lease) => lease.id === leaseId);
  if (!existing) throw new Error("Rental lease was not found.");
  const revoked = normalizedLease({
    ...existing,
    revokedAt: existing.revokedAt ?? now.toISOString(),
  });
  return {
    lease: revoked,
    registry: {
      version: current.version,
      leases: current.leases.map((lease) => lease.id === leaseId ? revoked : lease),
    },
  };
}

function signingSecret(value) {
  const secret = String(value ?? "");
  if (secret.length < 32 || secret.length > 256) {
    throw new Error("Rental signing secret must contain 32 to 256 characters.");
  }
  return secret;
}

function signature(payload, secret) {
  return createHmac("sha256", signingSecret(secret))
    .update(payload)
    .digest("base64url");
}

export function createRentalLeaseToken(leaseValue, secret) {
  const lease = normalizedLease(leaseValue);
  const payload = Buffer.from(JSON.stringify({
    v: 2,
    l: lease.id,
  })).toString("base64url");
  return `${TOKEN_PREFIX}.${payload}.${signature(payload, secret)}`;
}

// 80 bits of pseudorandom, domain-separated HMAC output. No new registry
// secrets are stored; expiry, revocation and device scope use the original lease.
export function createRentalShortCode(leaseValue, secret) {
  const lease = normalizedLease(leaseValue);
  const bytes = createHmac("sha256", signingSecret(secret))
    .update(`phonebase:short-access:v1:${lease.id}`).digest().subarray(0, 10);
  let bits = 0, buffer = 0, encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += SHORT_CODE_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  return "PB-" + encoded.match(/.{4}/g).join("-");
}

export function verifyRentalLeaseToken(tokenValue, secret, registry, now = new Date()) {
  const token = String(tokenValue ?? "");
  const shortCode = normalizeShortAccessCode(token);
  if (shortCode) {
    const supplied = Buffer.from(shortCode);
    const current = normalizeRentalLeaseRegistry(registry);
    let match = null;
    for (const lease of current.leases) {
      const expected = Buffer.from(createRentalShortCode(lease, secret));
      if (timingSafeEqual(supplied, expected)) match = lease;
    }
    if (!match || !rentalLeaseActive(match, now)) throw new Error("Rental access token is invalid or inactive.");
    return match;
  }
  if (token.length < 64 || token.length > 512) {
    throw new Error("Rental access token is invalid.");
  }
  const [prefix, payload, suppliedSignature, extra] = token.split(".");
  if (
    (prefix !== TOKEN_PREFIX && prefix !== LEGACY_TOKEN_PREFIX) ||
    !payload || !suppliedSignature || extra !== undefined
  ) {
    throw new Error("Rental access token is invalid.");
  }
  const expectedSignature = signature(payload, secret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Rental access token is invalid.");
  }
  let tokenPayload;
  try {
    tokenPayload = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Rental access token is invalid.");
  }
  const current = normalizeRentalLeaseRegistry(registry);
  const lease = current.leases.find((candidate) => candidate.id === tokenPayload.l);
  const currentToken = prefix === TOKEN_PREFIX && tokenPayload.v === 2;
  const legacyToken = prefix === LEGACY_TOKEN_PREFIX &&
    tokenPayload.v === 1 && Number.isFinite(tokenPayload.e);
  if (!lease || (!currentToken && !legacyToken)) {
    throw new Error("Rental access token is invalid.");
  }
  if (
    legacyToken &&
    (tokenPayload.e > Date.parse(lease.expiresAt) || now.getTime() >= tokenPayload.e)
  ) {
    throw new Error("Rental access token has expired.");
  }
  if (!rentalLeaseActive(lease, now)) {
    throw new Error(lease.revokedAt
      ? "Rental access has been revoked."
      : "Rental access is not active.");
  }
  return lease;
}
