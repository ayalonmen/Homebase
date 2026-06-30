// api.js — the thin REST wrapper around PocketBase.
//
// No SDK. Just fetch. Responsibilities, and nothing more:
//   • prefix everything with API_BASE
//   • throw a typed ApiError on any 4xx/5xx
//   • map 204 No Content → null
//   • build query strings safely (encodeURIComponent every param value)
//
// Access rules are open in dev, so no Authorization header is sent.

import { API_BASE } from './config.js';

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

// Build a `?a=1&b=2` string with every key AND value percent-encoded.
function queryString(params = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// Core request. Resolves to parsed JSON, or null for 204.
async function request(path, { method = 'GET', body, headers } = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    // Connection refused / CORS / offline — PocketBase probably isn't running.
    throw new ApiError(
      `Cannot reach the API at ${API_BASE}. Is PocketBase running?`,
      0,
      { cause: String(networkErr) },
    );
  }

  if (res.status === 204) return null;

  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!res.ok) {
    const message = data?.message || `Request failed (${res.status}) for ${method} ${path}`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

// --- record operations -------------------------------------------------------
const recordsPath = (collection) => `/collections/${encodeURIComponent(collection)}/records`;

// List records. `filter` is a PocketBase filter expression; it (and sort, etc.)
// are encoded by queryString. Returns the raw page object { items, ... }.
export function listRecords(collection, { filter, sort, page, perPage = 500, fields } = {}) {
  return request(recordsPath(collection) + queryString({ filter, sort, page, perPage, fields }));
}

// Convenience: list and hand back just the items array.
export async function listAll(collection, opts = {}) {
  const res = await listRecords(collection, opts);
  return res?.items ?? [];
}

export function createRecord(collection, data) {
  return request(recordsPath(collection), { method: 'POST', body: data });
}

export function updateRecord(collection, id, data) {
  return request(`${recordsPath(collection)}/${encodeURIComponent(id)}`, { method: 'PATCH', body: data });
}

// DELETE → 204 → null.
export function deleteRecord(collection, id) {
  return request(`${recordsPath(collection)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function healthCheck() {
  try { await request('/health'); return true; } catch { return false; }
}
