import { tryLiveAction } from "./live-action-channel";
import { normalizeShortAccessCode } from "../shared/short-access-code.mjs";
import { readPhonebaseAccessCode } from "../shared/connection-code.mjs";
import remoteGatewayAliases from "../config/remote-gateway-aliases.json";

export type ControlPlaneEndpoint = {
  baseUrl: string;
  accessToken: string;
  remote: boolean;
};

export type ControlPlaneEndpointResolution = {
  endpoint: ControlPlaneEndpoint | null;
  error: string;
};

const LOCAL_CONTROL_PLANE_URL = "http://127.0.0.1:3013";
const DEFAULT_REMOTE_CONTROL_PLANE_URL =
  process.env.NEXT_PUBLIC_PHONEBASE_REMOTE_CONTROL_PLANE_URL?.trim() ?? "";
const DEFAULT_REMOTE_ACCESS_TOKEN =
  process.env.NEXT_PUBLIC_PHONEBASE_REMOTE_ACCESS_TOKEN?.trim() ?? "";
const SESSION_KEY = "phonebase.remote.endpoint.v2";
const LEGACY_SESSION_KEY = "phonebase.remote.endpoint.v1";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
type StoredControlPlaneEndpoint = Partial<ControlPlaneEndpoint> & {
  source?: "paired" | "default";
};

export function normalizedRemoteEndpoint(
  baseUrlValue: string,
  accessTokenValue: string,
): ControlPlaneEndpoint | null {
  try {
    const url = new URL(baseUrlValue);
    const localHttp = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !localHttp) return null;
    if (url.username || url.password || url.search || url.hash) return null;

    const accessToken = accessTokenValue.trim();
    if ((accessToken.length < 32 && !normalizeShortAccessCode(accessToken)) || accessToken.length > 256) return null;
    // Only operator-published, exact-origin migrations are allowed. Keep the
    // original lease token, so expiry/revocation and device isolation still apply.
    const alias = (remoteGatewayAliases as Record<string, string>)[url.origin];
    if (alias) {
      const target = new URL(alias);
      if (target.protocol !== "https:" || target.origin !== alias) return null;
    }
    return {
      baseUrl: alias ?? url.origin,
      accessToken,
      remote: !localHttp,
    };
  } catch {
    return null;
  }
}

export function remoteEndpointFromAccessCode(
  accessValue: string,
): ControlPlaneEndpoint | null {
  let value = accessValue.trim();
  try {
    const link = new URL(value);
    const fragment = new URLSearchParams(link.hash.replace(/^#/, ""));
    const encoded = fragment.get("access");
    if (encoded) value = encoded;
    else {
      const legacy = normalizedRemoteEndpoint(
        fragment.get("controlPlane") ?? "",
        fragment.get("token") ?? "",
      );
      if (legacy?.remote) return legacy;
    }
  } catch {
    // A standalone access code is expected to be an invalid URL.
  }
  try {
    const decoded = readPhonebaseAccessCode(value);
    const endpoint = normalizedRemoteEndpoint(decoded.gatewayUrl, decoded.token);
    return endpoint?.remote ? endpoint : null;
  } catch {
    return null;
  }
}

export function rememberRemoteEndpoint(endpoint: ControlPlaneEndpoint) {
  if (typeof window === "undefined" || !endpoint.remote) return;
  window.sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ ...endpoint, source: "paired" }),
  );
  window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
}

export function forgetRemoteEndpoint() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(SESSION_KEY);
  window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
}

function clearPairingFragment() {
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

export function resolveControlPlaneEndpoint(options: { remoteOnly?: boolean } = {}): ControlPlaneEndpointResolution {
  if (typeof window === "undefined") {
    return { endpoint: null, error: "" };
  }

  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const fragmentAccess = fragment.get("access") ?? "";
  const fragmentEndpoint = fragment.get("controlPlane") ?? "";
  const fragmentToken = fragment.get("token") ?? "";
  if (fragmentAccess || fragmentEndpoint || fragmentToken) {
    const endpoint = fragmentAccess
      ? remoteEndpointFromAccessCode(fragmentAccess)
      : normalizedRemoteEndpoint(fragmentEndpoint, fragmentToken);
    clearPairingFragment();
    if (!endpoint) {
      window.sessionStorage.removeItem(SESSION_KEY);
      window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
      return {
        endpoint: null,
        error: "This remote access link is invalid or incomplete.",
      };
    }
    rememberRemoteEndpoint(endpoint);
    return { endpoint, error: "" };
  }

  const defaultRemoteEndpoint = normalizedRemoteEndpoint(
    DEFAULT_REMOTE_CONTROL_PLANE_URL,
    DEFAULT_REMOTE_ACCESS_TOKEN,
  );
  const storedValue = window.sessionStorage.getItem(SESSION_KEY) ??
    window.sessionStorage.getItem(LEGACY_SESSION_KEY);
  if (storedValue) {
    try {
      const stored = JSON.parse(storedValue) as StoredControlPlaneEndpoint;
      const endpoint = normalizedRemoteEndpoint(
        String(stored.baseUrl ?? ""),
        String(stored.accessToken ?? ""),
      );
      if (
        endpoint &&
        (stored.source === "paired" || !defaultRemoteEndpoint)
      ) {
        window.sessionStorage.setItem(
          SESSION_KEY,
          JSON.stringify({ ...endpoint, source: stored.source ?? "paired" }),
        );
        window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
        return { endpoint, error: "" };
      }
    } catch {
      // Fall through to the safe unconfigured state.
    }
    window.sessionStorage.removeItem(SESSION_KEY);
    window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
  }

  if (!options.remoteOnly && LOCAL_HOSTS.has(window.location.hostname)) {
    return {
      endpoint: {
        baseUrl: LOCAL_CONTROL_PLANE_URL,
        accessToken: "",
        remote: false,
      },
      error: "",
    };
  }

  if (defaultRemoteEndpoint) {
    window.sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...defaultRemoteEndpoint, source: "default" }),
    );
    return { endpoint: defaultRemoteEndpoint, error: "" };
  }

  return {
    endpoint: null,
    error: "",
  };
}

export function controlPlaneUrl(endpoint: ControlPlaneEndpoint, path: string) {
  return new URL(path, `${endpoint.baseUrl}/`).toString();
}

export async function controlPlaneFetch(
  endpoint: ControlPlaneEndpoint,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("X-Phonebase-Client", "dashboard");
  if (!headers.has("X-Request-Id")) headers.set("X-Request-Id", crypto.randomUUID());
  if (endpoint.accessToken) {
    headers.set("Authorization", `Bearer ${endpoint.accessToken}`);
  }
  if (endpoint.remote) {
    headers.set("Ngrok-Skip-Browser-Warning", "1");
  }
  const request = async () => {
    const started=performance.now();
    const id=path.match(/^\/api\/v1\/devices\/([^/]+)/)?.[1];
    try {
      // Retain the exact idempotency key on HTTP fallback if the live reply is lost.
      const liveResponse=endpoint.remote && id && init.method==="POST" && path.endsWith("/actions") && typeof init.body==="string"
        ? await tryLiveAction(endpoint,decodeURIComponent(id),init.body,headers.get("X-Request-Id")!) : null;
      const response=liveResponse ?? await fetch(controlPlaneUrl(endpoint, path), { ...init, headers });
      if(id && !path.endsWith("/telemetry")) reportTelemetry(endpoint,decodeURIComponent(id),{
        kind:"client.request", requestId:headers.get("X-Request-Id"),durationMs:performance.now()-started,status:String(response.status)});
      return response;
    } catch(error) {
      if(id)reportTelemetry(endpoint,decodeURIComponent(id),{kind:"client.error",requestId:headers.get("X-Request-Id"),code:"NETWORK_ERROR",durationMs:performance.now()-started});
      throw error;
    }
  };
  if (!endpoint.remote) return request();

  const retryableStatuses = new Set([502, 503, 504, 520, 522, 524]);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await request();
      if (!retryableStatuses.has(response.status) || attempt === 2) {
        return response;
      }
      await response.body?.cancel();
    } catch (error) {
      if (attempt === 2) throw error;
      lastError = error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
  }
  throw lastError;
}

/** Small, content-free diagnostics; failures never block device control. */
export function reportTelemetry(endpoint: ControlPlaneEndpoint, deviceId: string, event: Record<string, unknown>) {
  if (!deviceId || deviceId.startsWith('demo')) return;
  void fetch(controlPlaneUrl(endpoint, `/api/v1/devices/${encodeURIComponent(deviceId)}/telemetry`), {
    method: 'POST', headers: {'Content-Type':'application/json','X-Phonebase-Client':'dashboard',
      ...(endpoint.accessToken?{Authorization:`Bearer ${endpoint.accessToken}`}:{})},
    body: JSON.stringify(event), signal: AbortSignal.timeout(5000),
  }).catch(()=>{});
}
