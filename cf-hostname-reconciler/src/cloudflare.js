// Thin Cloudflare API client: zone discovery + custom hostname CRUD.
import { log } from "./logging.js";

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE = 1.5;

export class CloudflareError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CloudflareClient {
  constructor(token, baseUrl, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
    this._token = token;
    this._base = baseUrl;
    this._fetch = fetchImpl;
    this._timeout = timeoutMs;
  }

  async _request(method, path, { params, body } = {}) {
    const url = new URL(this._base + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));

    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this._timeout);
      let resp;
      try {
        resp = await this._fetch(url, {
          method,
          signal: ctrl.signal,
          headers: {
            Authorization: `Bearer ${this._token}`,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        lastError = err;
        if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_BASE ** attempt * 1000);
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (resp.status === 429 || resp.status >= 500) {
        // Honour Retry-After when present, else exponential backoff.
        const retryAfter = Number(resp.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : BACKOFF_BASE ** attempt;
        lastError = new CloudflareError(`${resp.status} on ${method} ${path}`);
        log.warning("cloudflare throttled/errored, retrying", {
          status: resp.status,
          attempt,
          delay,
          path,
        });
        if (attempt < MAX_ATTEMPTS) await sleep(delay * 1000);
        continue;
      }

      let payload;
      try {
        payload = await resp.json();
      } catch {
        throw new CloudflareError(`non-JSON response from ${method} ${path}`);
      }
      if (!payload.success) {
        throw new CloudflareError(`${method} ${path} failed: ${JSON.stringify(payload.errors)}`);
      }
      return payload;
    }
    throw new CloudflareError(`${method} ${path} failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
  }

  async *_paginate(path, params = {}) {
    let page = 1;
    for (;;) {
      const body = await this._request("GET", path, { params: { ...params, page, per_page: 50 } });
      const results = body.result ?? [];
      yield* results;
      const totalPages = body.result_info?.total_pages ?? 1;
      if (page >= totalPages || results.length === 0) return;
      page += 1;
    }
  }

  async listZones(names = []) {
    if (names.length) {
      const zones = [];
      for (const name of names) {
        const found = [];
        for await (const z of this._paginate("/zones", { name })) found.push(z);
        if (!found.length) throw new CloudflareError(`zone ${JSON.stringify(name)} not found or not visible to this token`);
        for (const z of found) zones.push({ id: z.id, name: z.name.toLowerCase() });
      }
      return zones;
    }
    const zones = [];
    for await (const z of this._paginate("/zones")) zones.push({ id: z.id, name: z.name.toLowerCase() });
    return zones;
  }

  async listCustomHostnames(zone) {
    const out = [];
    for await (const item of this._paginate(`/zones/${zone.id}/custom_hostnames`)) {
      out.push({
        id: item.id,
        hostname: item.hostname.toLowerCase().replace(/\.$/, ""),
        zoneId: zone.id,
        zoneName: zone.name,
        status: item.status ?? "",
      });
    }
    return out;
  }

  async createCustomHostname(zone, hostname) {
    const body = await this._request("POST", `/zones/${zone.id}/custom_hostnames`, {
      body: { hostname, ssl: { method: "http", type: "dv" } },
    });
    const r = body.result;
    return { id: r.id, hostname: r.hostname.toLowerCase(), zoneId: zone.id, zoneName: zone.name, status: r.status ?? "" };
  }

  async deleteCustomHostname(entry) {
    await this._request("DELETE", `/zones/${entry.zoneId}/custom_hostnames/${entry.id}`);
  }
}
