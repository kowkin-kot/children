import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as webpush from 'web-push';
import {
  firebaseConfig,
  appId,
  FIREBASE_COLLECTION_PATH,
  LEGACY_FIREBASE_COLLECTION_PATH
} from './js/config.js';
import { mergeAccountStates } from './js/state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_FAILURES = 10;

// Session signing key stays strictly in server memory
const SESSION_SECRET = (process.env.ADMIN_SESSION_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');

interface ClaimedAdminRecord {
  salt: string;
  hashHex: string;
  claimedAt: number;
}

interface SessionRecord {
  expiresAt: number;
  issuedAt: number;
}

interface FailureRecord {
  count: number;
  resetAt: number;
}

let claimedAdmin: ClaimedAdminRecord | null = null;
const activeSessions = new Map<string, SessionRecord>();
const loginFailures = new Map<string, FailureRecord>();

function getEnvAdminPassword(): string {
  return (process.env.ADMIN_PASSWORD || '').trim();
}

function getAuthSource(): 'env' | 'claimed' | 'unclaimed' {
  if (getEnvAdminPassword().length > 0) return 'env';
  if (claimedAdmin) return 'claimed';
  return 'unclaimed';
}

function constantTimeCompareSha256(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function verifyAdminPassword(candidate: string): boolean {
  const envPass = getEnvAdminPassword();
  if (envPass.length > 0) {
    return constantTimeCompareSha256(candidate, envPass);
  }
  if (!claimedAdmin) return false;
  const derived = crypto.scryptSync(candidate, claimedAdmin.salt, 64);
  const expected = Buffer.from(claimedAdmin.hashHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [jti, rec] of activeSessions.entries()) {
    if (rec.expiresAt <= now) {
      activeSessions.delete(jti);
    }
  }
}

function issueAdminToken(): { token: string; expiresAt: number } {
  cleanupExpiredSessions();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const jti = crypto.randomBytes(24).toString('hex');
  const payload = Buffer.from(JSON.stringify({ jti, exp: expiresAt }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  activeSessions.set(jti, { issuedAt: now, expiresAt });
  return { token: `${payload}.${sig}`, expiresAt };
}

function verifyBearerToken(authHeader: string | undefined): { jti: string; expiresAt: number } | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0 || dotIdx >= token.length - 1) return null;

  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      jti?: unknown;
      exp?: unknown;
    };
    if (typeof decoded.jti !== 'string' || typeof decoded.exp !== 'number') return null;
    const rec = activeSessions.get(decoded.jti);
    if (!rec || rec.expiresAt <= Date.now()) {
      activeSessions.delete(decoded.jti);
      return null;
    }
    return { jti: decoded.jti, expiresAt: rec.expiresAt };
  } catch {
    return null;
  }
}

function getClientKey(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isRateLimited(clientKey: string): boolean {
  const rec = loginFailures.get(clientKey);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    loginFailures.delete(clientKey);
    return false;
  }
  return rec.count >= RATE_LIMIT_MAX_FAILURES;
}

function recordLoginFailure(clientKey: string): void {
  const now = Date.now();
  const rec = loginFailures.get(clientKey);
  if (!rec || now > rec.resetAt) {
    loginFailures.set(clientKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    rec.count += 1;
  }
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const session = verifyBearerToken(req.headers.authorization);
  if (!session) {
    res.status(401).json({ error: 'Требуется авторизация администратора.' });
    return;
  }
  (req as Request & { adminSession?: { jti: string; expiresAt: number } }).adminSession = session;
  next();
}

// ==================== FIREBASE REST КЛИЕНТ (ПРОЕКТ children-b0573) ====================

let cachedFirebaseToken: { idToken: string; expiresAt: number } | null = null;

async function getServerFirebaseIdToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && cachedFirebaseToken && cachedFirebaseToken.expiresAt - 60000 > now) {
    return cachedFirebaseToken.idToken;
  }

  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    }
  );
  const data = (await resp.json().catch(() => ({}))) as {
    idToken?: string;
    expiresIn?: string;
    error?: { message?: string };
  };

  if (!resp.ok || !data.idToken) {
    throw new Error(data.error?.message || `Firebase Auth HTTP ${resp.status}`);
  }

  const ttlSec = Math.max(300, Number(data.expiresIn) || 3600);
  cachedFirebaseToken = {
    idToken: data.idToken,
    expiresAt: now + ttlSec * 1000,
  };
  return cachedFirebaseToken.idToken;
}

type FirestoreTypedValue = Record<string, unknown>;

function fromFirestoreValue(val: FirestoreTypedValue | undefined): unknown {
  if (!val || typeof val !== 'object') return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) {
    const n = Number(val.integerValue);
    return Number.isSafeInteger(n) ? n : String(val.integerValue);
  }
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('stringValue' in val) return String(val.stringValue);
  if ('timestampValue' in val) return String(val.timestampValue);
  if ('arrayValue' in val) {
    const arrObj = val.arrayValue as { values?: FirestoreTypedValue[] } | undefined;
    const items = Array.isArray(arrObj?.values) ? arrObj.values : [];
    return items.map((item) => fromFirestoreValue(item));
  }
  if ('mapValue' in val) {
    const mapObj = val.mapValue as { fields?: Record<string, FirestoreTypedValue> } | undefined;
    return fromFirestoreFields(mapObj?.fields || {});
  }
  return null;
}

function fromFirestoreFields(fields: Record<string, FirestoreTypedValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields || {})) {
    out[k] = fromFirestoreValue(v);
  }
  return out;
}

function toFirestoreValue(val: unknown): FirestoreTypedValue {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return { nullValue: null };
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.map((item) => toFirestoreValue(item)),
      },
    };
  }
  if (typeof val === 'object') {
    return {
      mapValue: {
        fields: toFirestoreFields(val as Record<string, unknown>),
      },
    };
  }
  return { stringValue: String(val) };
}

function toFirestoreFields(obj: Record<string, unknown>): Record<string, FirestoreTypedValue> {
  const fields: Record<string, FirestoreTypedValue> = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue;
    fields[k] = toFirestoreValue(v);
  }
  return fields;
}

function detectPassHashKind(passHash: unknown): 'sha256' | 'fnv' | 'custom' | 'none' {
  if (typeof passHash !== 'string' || !passHash) return 'none';
  if (passHash.startsWith('fnv_')) return 'fnv';
  if (/^[a-f0-9]{64}$/i.test(passHash)) return 'sha256';
  return 'custom';
}

function sanitizeJsonValue(val: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(val));
  } catch {
    return {};
  }
}

async function fetchFirestoreWithAuth(url: string, init: RequestInit = {}): Promise<globalThis.Response> {
  let token = await getServerFirebaseIdToken(false);
  let resp = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (resp.status === 401) {
    token = await getServerFirebaseIdToken(true);
    resp = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
  }
  return resp;
}

async function listFirestoreCollectionRaw(
  pathSegments: string[],
  collectionName: string,
  includeHashes = false
): Promise<Array<Record<string, unknown>>> {
  const collectionPath = pathSegments.map((seg) => encodeURIComponent(seg)).join('/');
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseConfig.projectId)}/databases/(default)/documents/${collectionPath}`;
  const results: Array<Record<string, unknown>> = [];
  let pageToken = '';

  do {
    const url = `${baseUrl}?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const resp = await fetchFirestoreWithAuth(url);
    const body = (await resp.json().catch(() => ({}))) as {
      documents?: Array<{
        name: string;
        createTime?: string;
        updateTime?: string;
        fields?: Record<string, FirestoreTypedValue>;
      }>;
      nextPageToken?: string;
      error?: { message?: string };
    };

    if (!resp.ok) {
      throw new Error(body.error?.message || `Firestore HTTP ${resp.status}`);
    }

    for (const doc of body.documents || []) {
      const docId = doc.name.split('/').pop() || '';
      const parsed = fromFirestoreFields(doc.fields || {});
      const rawPassHash = parsed.passHash || parsed.passwordHash;
      const passHashKind = detectPassHashKind(rawPassHash);
      const hasPassword = Boolean(rawPassHash);

      if (!includeHashes) {
        delete parsed.passHash;
        delete parsed.passwordHash;
      }

      const serverCreateTime = doc.createTime ? Date.parse(doc.createTime) : null;
      const serverUpdateTime = doc.updateTime ? Date.parse(doc.updateTime) : null;

      results.push({
        ...parsed,
        login: typeof parsed.login === 'string' && parsed.login ? parsed.login : docId,
        docId,
        collection: collectionName,
        hasPassword,
        passHashKind,
        serverCreateTime: Number.isFinite(serverCreateTime) ? serverCreateTime : null,
        serverUpdateTime: Number.isFinite(serverUpdateTime) ? serverUpdateTime : null,
      });
    }

    pageToken = body.nextPageToken || '';
  } while (pageToken);

  return results;
}

async function listFirestoreCollection(
  pathSegments: string[],
  collectionName: string
): Promise<Array<Record<string, unknown>>> {
  return listFirestoreCollectionRaw(pathSegments, collectionName, false);
}

async function listAllFirestoreAccounts(): Promise<Array<Record<string, unknown>>> {
  const [primaryDocs, legacyDocs] = await Promise.all([
    listFirestoreCollection(FIREBASE_COLLECTION_PATH, 'malysh_accounts'),
    listFirestoreCollection(LEGACY_FIREBASE_COLLECTION_PATH, 'accounts').catch(() => [])
  ]);
  return [...primaryDocs, ...legacyDocs];
}

async function firestoreDocExists(pathSegments: string[], login: string): Promise<boolean> {
  const docPath = [...pathSegments, login].map((seg) => encodeURIComponent(seg)).join('/');
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseConfig.projectId)}/databases/(default)/documents/${docPath}`;
  const resp = await fetchFirestoreWithAuth(url);
  return resp.ok;
}

async function patchFirestoreAccountInCollection(
  pathSegments: string[],
  login: string,
  fieldsObj: Record<string, unknown>
): Promise<void> {
  const docPath = [...pathSegments, login].map((seg) => encodeURIComponent(seg)).join('/');
  const keys = Object.keys(fieldsObj).filter((k) => fieldsObj[k] !== undefined);
  const maskQuery = keys.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseConfig.projectId)}/databases/(default)/documents/${docPath}?${maskQuery}`;

  const resp = await fetchFirestoreWithAuth(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: toFirestoreFields(fieldsObj),
    }),
  });

  if (!resp.ok) {
    const errBody = (await resp.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(errBody.error?.message || `Firestore PATCH HTTP ${resp.status}`);
  }
}

async function deleteFirestoreAccountInCollection(
  pathSegments: string[],
  docId: string
): Promise<void> {
  const docPath = [...pathSegments, docId].map((seg) => encodeURIComponent(seg)).join('/');
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseConfig.projectId)}/databases/(default)/documents/${docPath}`;
  const resp = await fetchFirestoreWithAuth(url, { method: 'DELETE' });
  if (!resp.ok) {
    const errBody = (await resp.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(errBody.error?.message || `Firestore DELETE HTTP ${resp.status}`);
  }
}

async function patchFirestoreAccount(login: string, fieldsObj: Record<string, unknown>): Promise<void> {
  await patchFirestoreAccountInCollection(FIREBASE_COLLECTION_PATH, login, fieldsObj);
}

// ==================== WEB PUSH (VAPID) ДЛЯ ФОНОВЫХ УВЕДОМЛЕНИЙ ====================

interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

interface PushSubscriptionPayload {
  endpoint: string;
  expirationTime: number | null;
  keys: PushSubscriptionKeys;
}

interface ScheduledPushItem {
  key: 'feeding' | 'sleep' | 'diaper' | 'doctor' | 'custom';
  tag: string;
  triggerAt: number;
  title: string;
  body: string;
  tab: string;
  requireInteraction: boolean;
  sentAt: number | null;
}

interface PushSubscriptionRecord {
  id: string;
  login: string;
  subscription: PushSubscriptionPayload;
  schedule: ScheduledPushItem[];
  sentTags: Record<string, number>;
  createdAt: number;
  updatedAt: number;
  lastPushAt: number | null;
}

const MAX_PUSH_SUBSCRIPTIONS = 5000;
const PUSH_DISPATCH_INTERVAL_MS = 15000;
const PUSH_TAG_COOLDOWN_MS = 30 * 60 * 1000;
const PUSH_TEST_WINDOW_MS = 60 * 1000;
const PUSH_TEST_MAX_PER_WINDOW = 6;
const ALLOWED_SCHEDULE_KEYS = new Set(['feeding', 'sleep', 'diaper', 'doctor', 'custom']);
const ALLOWED_TABS = new Set(['journal', 'development', 'health', 'growth', 'symptoms', 'diary']);

const pushSubscriptions = new Map<string, PushSubscriptionRecord>();
const pushTestRateLimits = new Map<string, { count: number; resetAt: number }>();
const pushSubscribeRateLimits = new Map<string, { count: number; resetAt: number }>();

function initWebPushConfig(): { publicKey: string; subject: string; configuredFromEnv: boolean } {
  const envPub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const envPriv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const rawSubject = (process.env.VAPID_SUBJECT || '').trim();
  const subject = (rawSubject.startsWith('mailto:') || rawSubject.startsWith('https://'))
    ? rawSubject
    : 'mailto:support@malysh-plus.local';

  if (envPub && envPriv) {
    try {
      webpush.setVapidDetails(subject, envPub, envPriv);
      return { publicKey: envPub, subject, configuredFromEnv: true };
    } catch (err) {
      console.warn('Invalid VAPID env keys, falling back to ephemeral VAPID keys:', err instanceof Error ? err.message : err);
    }
  }

  const generated = webpush.generateVAPIDKeys();
  webpush.setVapidDetails(subject, generated.publicKey, generated.privateKey);
  return { publicKey: generated.publicKey, subject, configuredFromEnv: false };
}

const webPushConfig = initWebPushConfig();

function hashPushEndpoint(endpoint: string): string {
  return crypto.createHash('sha256').update(endpoint, 'utf8').digest('hex');
}

function isDisallowedPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || !host.includes('.')) return true;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return true;
  }
  // Block IPv4 literals (loopback, private, link-local, etc.) and IPv6 literals
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(':')) return true;
  return false;
}

function validatePushEndpointUrl(rawEndpoint: unknown): string | null {
  if (typeof rawEndpoint !== 'string') return null;
  const trimmed = rawEndpoint.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (isDisallowedPushHost(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function validatePushSubscription(rawSub: unknown): PushSubscriptionPayload | null {
  if (!rawSub || typeof rawSub !== 'object') return null;
  const sub = rawSub as Record<string, unknown>;
  const endpoint = validatePushEndpointUrl(sub.endpoint);
  if (!endpoint) return null;

  const keysObj = sub.keys && typeof sub.keys === 'object' ? (sub.keys as Record<string, unknown>) : null;
  if (!keysObj) return null;

  const p256dh = typeof keysObj.p256dh === 'string' ? keysObj.p256dh.trim() : '';
  const auth = typeof keysObj.auth === 'string' ? keysObj.auth.trim() : '';
  if (!/^[A-Za-z0-9_-]{40,200}=*$/.test(p256dh)) return null;
  if (!/^[A-Za-z0-9_-]{16,80}=*$/.test(auth)) return null;

  const exp = typeof sub.expirationTime === 'number' && Number.isFinite(sub.expirationTime)
    ? sub.expirationTime
    : null;

  return {
    endpoint,
    expirationTime: exp,
    keys: { p256dh, auth },
  };
}

function sanitizePushLogin(rawLogin: unknown): string {
  if (typeof rawLogin !== 'string') return '';
  return rawLogin.trim().toLowerCase().slice(0, 64);
}

function sanitizeScheduledPushItems(rawItems: unknown, sentTags: Record<string, number>): ScheduledPushItem[] {
  if (!Array.isArray(rawItems)) return [];
  const now = Date.now();
  const maxTriggerAt = now + 14 * 24 * 60 * 60 * 1000;
  const out: ScheduledPushItem[] = [];
  const seenTags = new Set<string>();

  for (const raw of rawItems.slice(0, 32)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const keyRaw = typeof item.key === 'string' ? item.key.trim() : 'custom';
    const key = (ALLOWED_SCHEDULE_KEYS.has(keyRaw) ? keyRaw : 'custom') as ScheduledPushItem['key'];

    const triggerAt = Number(item.triggerAt);
    if (!Number.isFinite(triggerAt) || triggerAt < now - 60_000 || triggerAt > maxTriggerAt) {
      continue;
    }

    const rawTag = typeof item.tag === 'string' ? item.tag.trim() : '';
    const tag = (rawTag || `malysh-${key}-${Math.round(triggerAt)}`).slice(0, 120);
    if (seenTags.has(tag)) continue;
    seenTags.add(tag);

    const rawTitle = typeof item.title === 'string' ? item.title.trim() : '';
    const title = (rawTitle || 'Малыш+').slice(0, 140);
    const body = (typeof item.body === 'string' ? item.body.trim() : '').slice(0, 300);
    const rawTab = typeof item.tab === 'string' ? item.tab.trim() : 'journal';
    const tab = ALLOWED_TABS.has(rawTab) ? rawTab : 'journal';

    const prevSentAt = sentTags[tag];
    const alreadySentRecently = typeof prevSentAt === 'number' && (now - prevSentAt) < PUSH_TAG_COOLDOWN_MS;

    out.push({
      key,
      tag,
      triggerAt,
      title,
      body,
      tab,
      requireInteraction: Boolean(item.requireInteraction) || key === 'sleep' || key === 'feeding',
      sentAt: alreadySentRecently ? prevSentAt : null,
    });
  }

  return out;
}

function prunePushSubscriptionsIfNeeded(): void {
  if (pushSubscriptions.size <= MAX_PUSH_SUBSCRIPTIONS) return;
  const sorted = Array.from(pushSubscriptions.values()).sort((a, b) => a.updatedAt - b.updatedAt);
  const toRemove = sorted.length - MAX_PUSH_SUBSCRIPTIONS;
  for (let i = 0; i < toRemove; i++) {
    pushSubscriptions.delete(sorted[i].id);
  }
}

function isPushTestRateLimited(rateKey: string): boolean {
  const now = Date.now();
  const rec = pushTestRateLimits.get(rateKey);
  if (!rec || now > rec.resetAt) {
    pushTestRateLimits.set(rateKey, { count: 1, resetAt: now + PUSH_TEST_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > PUSH_TEST_MAX_PER_WINDOW;
}

function isPushSubscribeRateLimited(clientKey: string): boolean {
  const now = Date.now();
  const rec = pushSubscribeRateLimits.get(clientKey);
  if (!rec || now > rec.resetAt) {
    pushSubscribeRateLimits.set(clientKey, { count: 1, resetAt: now + PUSH_TEST_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > 30;
}

async function deliverWebPushNotification(
  rec: PushSubscriptionRecord,
  payload: {
    title: string;
    body: string;
    tag: string;
    key: string;
    tab: string;
    requireInteraction?: boolean;
  }
): Promise<{ ok: boolean; expired?: boolean; error?: string }> {
  const bodyJson = JSON.stringify({
    title: payload.title,
    body: payload.body,
    tag: payload.tag,
    key: payload.key,
    tab: payload.tab || 'journal',
    requireInteraction: Boolean(payload.requireInteraction),
    url: './',
  });

  try {
    await webpush.sendNotification(rec.subscription, bodyJson, {
      TTL: 3600,
      urgency: 'high',
    });
    rec.lastPushAt = Date.now();
    return { ok: true };
  } catch (err: unknown) {
    const statusCode =
      err && typeof err === 'object' && 'statusCode' in err
        ? Number((err as { statusCode?: unknown }).statusCode)
        : 0;
    if (statusCode === 404 || statusCode === 410) {
      pushSubscriptions.delete(rec.id);
      return { ok: false, expired: true, error: `Subscription expired (${statusCode})` };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Push delivery failed',
    };
  }
}

let pushDispatchRunning = false;

async function runScheduledPushDispatch(): Promise<void> {
  if (pushDispatchRunning || pushSubscriptions.size === 0) return;
  pushDispatchRunning = true;
  try {
    const now = Date.now();
    for (const rec of Array.from(pushSubscriptions.values())) {
      // Prune old sentTags (> 6h)
      for (const [tag, ts] of Object.entries(rec.sentTags)) {
        if (now - ts > 6 * 60 * 60 * 1000) {
          delete rec.sentTags[tag];
        }
      }

      if (!Array.isArray(rec.schedule) || rec.schedule.length === 0) continue;

      for (const item of rec.schedule) {
        if (item.sentAt !== null) continue;
        if (item.triggerAt > now) continue;

        const prevSentAt = rec.sentTags[item.tag];
        if (typeof prevSentAt === 'number' && (now - prevSentAt) < PUSH_TAG_COOLDOWN_MS) {
          item.sentAt = prevSentAt;
          continue;
        }

        item.sentAt = now;
        rec.sentTags[item.tag] = now;

        const res = await deliverWebPushNotification(rec, {
          title: item.title,
          body: item.body,
          tag: item.tag,
          key: item.key,
          tab: item.tab,
          requireInteraction: item.requireInteraction,
        });

        if (res.expired) break;
      }
    }
  } finally {
    pushDispatchRunning = false;
  }
}

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Prevent caching of sensitive admin auth endpoints
  app.use('/api/admin', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // Check whether admin password is configured via env, claimed on first run, or unclaimed
  app.get('/api/admin/status', (_req, res) => {
    const source = getAuthSource();
    res.json({
      configured: source !== 'unclaimed',
      source,
    });
  });

  // One-time first-run admin password setup when ADMIN_PASSWORD env var is not configured
  app.post('/api/admin/claim', (req, res) => {
    if (getEnvAdminPassword().length > 0) {
      res.status(409).json({ error: 'Пароль администратора уже задан в переменных окружения.' });
      return;
    }
    if (claimedAdmin) {
      res.status(409).json({ error: 'Пароль администратора уже настроен.' });
      return;
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password.length < 6 || password.length > 128) {
      res.status(400).json({ error: 'Пароль администратора должен содержать от 6 до 128 символов.' });
      return;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hashHex = crypto.scryptSync(password, salt, 64).toString('hex');
    claimedAdmin = { salt, hashHex, claimedAt: Date.now() };

    const { token, expiresAt } = issueAdminToken();
    res.json({ ok: true, token, expiresAt, source: 'claimed' });
  });

  // Admin login
  app.post('/api/admin/login', (req, res) => {
    const clientKey = getClientKey(req);
    if (isRateLimited(clientKey)) {
      res.status(429).json({ error: 'Слишком много неудачных попыток входа. Попробуйте позже.' });
      return;
    }

    const source = getAuthSource();
    if (source === 'unclaimed') {
      res.status(409).json({ error: 'Сначала создайте пароль администратора.' });
      return;
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password || password.length > 128) {
      recordLoginFailure(clientKey);
      res.status(401).json({ error: 'Неверный пароль администратора.' });
      return;
    }

    if (!verifyAdminPassword(password)) {
      recordLoginFailure(clientKey);
      res.status(401).json({ error: 'Неверный пароль администратора.' });
      return;
    }

    loginFailures.delete(clientKey);
    const { token, expiresAt } = issueAdminToken();
    res.json({ ok: true, token, expiresAt, source });
  });

  // Verify current admin session
  app.get('/api/admin/session', requireAdminAuth, (req, res) => {
    const session = (req as Request & { adminSession?: { jti: string; expiresAt: number } }).adminSession!;
    res.json({
      authenticated: true,
      expiresAt: session.expiresAt,
      source: getAuthSource(),
    });
  });

  // Revoke current admin session
  app.post('/api/admin/logout', (req, res) => {
    const session = verifyBearerToken(req.headers.authorization);
    if (session) {
      activeSessions.delete(session.jti);
    }
    res.json({ ok: true });
  });

  // Change claimed admin password (when not overridden by ADMIN_PASSWORD env secret)
  app.post('/api/admin/change-password', requireAdminAuth, (req, res) => {
    const clientKey = getClientKey(req);
    if (isRateLimited(clientKey)) {
      res.status(429).json({ error: 'Слишком много неудачных попыток. Попробуйте позже.' });
      return;
    }

    if (getEnvAdminPassword().length > 0) {
      res.status(409).json({
        error: 'Пароль администратора задан через секрет ADMIN_PASSWORD — измените его в настройках секретов проекта.'
      });
      return;
    }

    if (!claimedAdmin) {
      res.status(409).json({ error: 'Пароль администратора ещё не настроен.' });
      return;
    }

    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

    if (!currentPassword || currentPassword.length > 128 || !verifyAdminPassword(currentPassword)) {
      recordLoginFailure(clientKey);
      res.status(401).json({ error: 'Неверный текущий пароль администратора.' });
      return;
    }

    if (newPassword.length < 6 || newPassword.length > 128) {
      res.status(400).json({ error: 'Новый пароль администратора должен содержать от 6 до 128 символов.' });
      return;
    }

    if (newPassword === currentPassword) {
      res.status(400).json({ error: 'Новый пароль должен отличаться от текущего.' });
      return;
    }

    loginFailures.delete(clientKey);
    const salt = crypto.randomBytes(16).toString('hex');
    const hashHex = crypto.scryptSync(newPassword, salt, 64).toString('hex');
    claimedAdmin = { salt, hashHex, claimedAt: Date.now() };

    // Revoke all previous sessions and issue a fresh token for the current admin
    activeSessions.clear();
    const { token, expiresAt } = issueAdminToken();
    res.json({ ok: true, token, expiresAt, source: 'claimed' });
  });

  // Server-authorized password hash generation for user password reset
  app.post('/api/admin/hash-user-password', requireAdminAuth, (req, res) => {
    const login = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

    if (!login || login.length > 100 || /[/\\]/.test(login) || login === '.' || login === '..') {
      res.status(400).json({ error: 'Некорректный логин пользователя.' });
      return;
    }
    if (newPassword.length < 4 || newPassword.length > 128) {
      res.status(400).json({ error: 'Новый пароль должен содержать от 4 до 128 символов.' });
      return;
    }

    // Matches client hashPassword() SHA-256 format so user login works seamlessly
    const passHash = crypto.createHash('sha256').update(newPassword, 'utf8').digest('hex');
    res.json({
      ok: true,
      login,
      passHash,
      changedAt: Date.now(),
    });
  });

  // Fetch all accounts directly from Firestore (children-b0573) with serverCreateTime metadata
  app.get('/api/admin/cloud/users', requireAdminAuth, async (_req, res) => {
    try {
      const users = await listAllFirestoreAccounts();
      res.json({
        ok: true,
        projectId: firebaseConfig.projectId,
        appId,
        users,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось загрузить данные из Firestore.';
      res.status(502).json({ error: message });
    }
  });

  // Update user password directly in Firestore (children-b0573) without touching user state
  app.post('/api/admin/cloud/user-password', requireAdminAuth, async (req, res) => {
    const login = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    const syncToCloud = req.body?.syncToCloud !== false;

    if (!login || login.length > 100 || /[/\\]/.test(login) || login === '.' || login === '..') {
      res.status(400).json({ error: 'Некорректный логин пользователя.' });
      return;
    }
    if (newPassword.length < 4 || newPassword.length > 128) {
      res.status(400).json({ error: 'Новый пароль должен содержать от 4 до 128 символов.' });
      return;
    }

    const passHash = crypto.createHash('sha256').update(newPassword, 'utf8').digest('hex');
    const changedAt = Date.now();
    let cloudUpdated = false;
    const updatedCollections: string[] = [];

    if (syncToCloud) {
      try {
        const [existsPrimary, existsLegacy] = await Promise.all([
          firestoreDocExists(FIREBASE_COLLECTION_PATH, login),
          firestoreDocExists(LEGACY_FIREBASE_COLLECTION_PATH, login)
        ]);

        if (existsPrimary || (!existsLegacy && req.body?.fallbackState)) {
          const patchPrimary: Record<string, unknown> = {
            login,
            passHash,
            passwordChangedAt: changedAt,
            updatedAt: changedAt,
          };
          if (!existsPrimary && req.body?.fallbackState && typeof req.body.fallbackState === 'object') {
            patchPrimary.state = sanitizeJsonValue(req.body.fallbackState);
            patchPrimary.createdAt = typeof req.body.fallbackCreatedAt === 'number' ? req.body.fallbackCreatedAt : changedAt;
          }
          await patchFirestoreAccountInCollection(FIREBASE_COLLECTION_PATH, login, patchPrimary);
          updatedCollections.push('malysh_accounts');
          cloudUpdated = true;
        }

        if (existsLegacy) {
          const patchLegacy: Record<string, unknown> = {
            login,
            passHash,
            passwordHash: passHash,
            passwordChangedAt: changedAt,
            updatedAt: changedAt,
          };
          await patchFirestoreAccountInCollection(LEGACY_FIREBASE_COLLECTION_PATH, login, patchLegacy);
          updatedCollections.push('accounts');
          cloudUpdated = true;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Ошибка записи в Firestore.';
        res.status(502).json({ error: message });
        return;
      }
    }

    res.json({
      ok: true,
      login,
      passHash,
      changedAt,
      cloudUpdated,
      updatedCollections,
    });
  });

  // Sync a local-only account to Firestore (children-b0573)
  app.post('/api/admin/cloud/sync-user', requireAdminAuth, async (req, res) => {
    const login = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
    const state = req.body?.state;
    const passHash = typeof req.body?.passHash === 'string' ? req.body.passHash : '';
    const createdAt = typeof req.body?.createdAt === 'number' ? req.body.createdAt : Date.now();
    const updatedAt = typeof req.body?.updatedAt === 'number' ? req.body.updatedAt : Date.now();

    if (!login || login.length > 100 || /[/\\]/.test(login) || login === '.' || login === '..') {
      res.status(400).json({ error: 'Некорректный логин пользователя.' });
      return;
    }
    if (!state || typeof state !== 'object') {
      res.status(400).json({ error: 'Отсутствуют данные профиля для синхронизации.' });
      return;
    }

    try {
      const payload: Record<string, unknown> = {
        login,
        state: sanitizeJsonValue(state),
        createdAt,
        updatedAt,
      };
      if (passHash) payload.passHash = passHash;
      await patchFirestoreAccount(login, payload);
      res.json({ ok: true, login });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка синхронизации с Firestore.';
      res.status(502).json({ error: message });
    }
  });

  // Merge duplicates & migrate legacy accounts -> malysh_accounts without losing data
  app.post('/api/admin/cloud/merge-duplicates', requireAdminAuth, async (req, res) => {
    const mode = req.body?.mode === 'all_legacy' ? 'all_legacy' : 'duplicates';
    const singleLogin = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
    const deleteLegacyAfterMerge = Boolean(req.body?.deleteLegacyAfterMerge);

    if (singleLogin && (singleLogin.length > 100 || /[/\\]/.test(singleLogin) || singleLogin === '.' || singleLogin === '..')) {
      res.status(400).json({ error: 'Некорректный логин пользователя.' });
      return;
    }

    try {
      const [primaryList, legacyList] = await Promise.all([
        listFirestoreCollectionRaw(FIREBASE_COLLECTION_PATH, 'malysh_accounts', true),
        listFirestoreCollectionRaw(LEGACY_FIREBASE_COLLECTION_PATH, 'accounts', true).catch(() => [])
      ]);

      const primaryByLogin = new Map<string, Record<string, unknown>>();
      for (const d of primaryList) {
        const key = String(d.login || d.docId || '').trim();
        if (key) primaryByLogin.set(key, d);
      }

      const legacyByLogin = new Map<string, Record<string, unknown>>();
      for (const d of legacyList) {
        const key = String(d.login || d.docId || '').trim();
        if (key) legacyByLogin.set(key, d);
      }

      let targetLogins: string[] = [];
      if (singleLogin) {
        if (!legacyByLogin.has(singleLogin)) {
          res.status(404).json({ error: `Аккаунт @${singleLogin} отсутствует в коллекции accounts.` });
          return;
        }
        targetLogins = [singleLogin];
      } else if (mode === 'all_legacy') {
        targetLogins = Array.from(legacyByLogin.keys());
      } else {
        targetLogins = Array.from(legacyByLogin.keys()).filter((k) => primaryByLogin.has(k));
      }

      const mergedLogins: string[] = [];
      let deletedLegacyCount = 0;
      const errors: Array<{ login: string; error: string }> = [];

      for (const targetLogin of targetLogins) {
        try {
          const legacyDoc = legacyByLogin.get(targetLogin);
          const primaryDoc = primaryByLogin.get(targetLogin);
          if (!legacyDoc) continue;

          const orderedStates: Record<string, unknown>[] = [];
          if (legacyDoc.state && typeof legacyDoc.state === 'object') {
            orderedStates.push(legacyDoc.state as Record<string, unknown>);
          }
          if (primaryDoc?.state && typeof primaryDoc.state === 'object') {
            orderedStates.push(primaryDoc.state as Record<string, unknown>);
          }

          const { state: unifiedState } = mergeAccountStates(orderedStates);

          const primaryHash = typeof primaryDoc?.passHash === 'string' && primaryDoc.passHash
            ? primaryDoc.passHash
            : (typeof primaryDoc?.passwordHash === 'string' ? primaryDoc.passwordHash : '');
          const legacyHash = typeof legacyDoc.passHash === 'string' && legacyDoc.passHash
            ? legacyDoc.passHash
            : (typeof legacyDoc.passwordHash === 'string' ? legacyDoc.passwordHash : '');

          const pChanged = typeof primaryDoc?.passwordChangedAt === 'number' ? primaryDoc.passwordChangedAt : 0;
          const lChanged = typeof legacyDoc.passwordChangedAt === 'number' ? legacyDoc.passwordChangedAt : 0;
          const resolvedHash = (lChanged > pChanged && legacyHash)
            ? legacyHash
            : (primaryHash || legacyHash || '');

          const createdCandidates = [
            primaryDoc?.createdAt,
            primaryDoc?.serverCreateTime,
            legacyDoc.createdAt,
            legacyDoc.serverCreateTime,
            (legacyDoc.state as Record<string, unknown> | undefined)?.accountCreatedAt,
            (primaryDoc?.state as Record<string, unknown> | undefined)?.accountCreatedAt
          ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 946684800000);

          const resolvedCreatedAt = createdCandidates.length > 0 ? Math.min(...createdCandidates) : Date.now();
          const nowMs = Date.now();

          const payload: Record<string, unknown> = {
            login: targetLogin,
            state: sanitizeJsonValue(unifiedState),
            createdAt: resolvedCreatedAt,
            updatedAt: nowMs,
          };
          if (resolvedHash) payload.passHash = resolvedHash;
          const maxPwChanged = Math.max(pChanged, lChanged);
          if (maxPwChanged > 0) payload.passwordChangedAt = maxPwChanged;

          const targetDocId = typeof primaryDoc?.docId === 'string' && primaryDoc.docId ? primaryDoc.docId : targetLogin;
          await patchFirestoreAccountInCollection(FIREBASE_COLLECTION_PATH, targetDocId, payload);
          mergedLogins.push(targetLogin);

          if (deleteLegacyAfterMerge) {
            const legacyDocId = typeof legacyDoc.docId === 'string' && legacyDoc.docId ? legacyDoc.docId : targetLogin;
            await deleteFirestoreAccountInCollection(LEGACY_FIREBASE_COLLECTION_PATH, legacyDocId);
            deletedLegacyCount++;
          }
        } catch (err) {
          errors.push({
            login: targetLogin,
            error: err instanceof Error ? err.message : 'Ошибка объединения'
          });
        }
      }

      res.json({
        ok: true,
        mergedCount: mergedLogins.length,
        deletedLegacyCount,
        mergedLogins,
        errors,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка объединения аккаунтов в Firestore.';
      res.status(502).json({ error: message });
    }
  });

  // ==================== WEB PUSH API ROUTES ====================

  app.use('/api/push', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/api/push/public-key', (_req, res) => {
    res.json({
      supported: true,
      publicKey: webPushConfig.publicKey,
      persistentKeys: webPushConfig.configuredFromEnv,
    });
  });

  app.post('/api/push/subscribe', (req, res) => {
    if (isPushSubscribeRateLimited(getClientKey(req))) {
      res.status(429).json({ error: 'Слишком много запросов подписки. Попробуйте через минуту.' });
      return;
    }

    const sub = validatePushSubscription(req.body?.subscription);
    if (!sub) {
      res.status(400).json({ error: 'Некорректные данные Web Push подписки.' });
      return;
    }

    const subId = hashPushEndpoint(sub.endpoint);
    const login = sanitizePushLogin(req.body?.login);
    const now = Date.now();
    const existing = pushSubscriptions.get(subId);
    const sentTags = existing?.sentTags || {};
    const hasSchedule = Array.isArray(req.body?.schedule);
    const schedule = hasSchedule
      ? sanitizeScheduledPushItems(req.body.schedule, sentTags)
      : (existing?.schedule || []);

    const record: PushSubscriptionRecord = {
      id: subId,
      login: login || existing?.login || '',
      subscription: sub,
      schedule,
      sentTags,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastPushAt: existing?.lastPushAt || null,
    };

    pushSubscriptions.set(subId, record);
    prunePushSubscriptionsIfNeeded();

    res.json({
      ok: true,
      scheduledCount: schedule.filter((s) => s.sentAt === null).length,
    });
  });

  app.post('/api/push/sync-schedule', (req, res) => {
    const endpoint = validatePushEndpointUrl(req.body?.endpoint);
    if (!endpoint) {
      res.status(400).json({ error: 'Некорректный endpoint подписки.' });
      return;
    }

    const subId = hashPushEndpoint(endpoint);
    const existing = pushSubscriptions.get(subId);
    if (!existing) {
      res.status(404).json({ error: 'Подписка не найдена на сервере — требуется перерегистрация.', needsResubscribe: true });
      return;
    }

    const login = sanitizePushLogin(req.body?.login);
    if (login) existing.login = login;
    existing.schedule = sanitizeScheduledPushItems(req.body?.schedule, existing.sentTags);
    existing.updatedAt = Date.now();

    res.json({
      ok: true,
      scheduledCount: existing.schedule.filter((s) => s.sentAt === null).length,
    });
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    const endpoint = validatePushEndpointUrl(req.body?.endpoint);
    if (!endpoint) {
      res.status(400).json({ error: 'Некорректный endpoint подписки.' });
      return;
    }
    const subId = hashPushEndpoint(endpoint);
    pushSubscriptions.delete(subId);
    res.json({ ok: true });
  });

  app.post('/api/push/test', async (req, res) => {
    const endpoint = validatePushEndpointUrl(req.body?.endpoint);
    if (!endpoint) {
      res.status(400).json({ error: 'Сначала включите системные Push-уведомления на этом устройстве.' });
      return;
    }

    const subId = hashPushEndpoint(endpoint);
    const rec = pushSubscriptions.get(subId);
    if (!rec) {
      res.status(404).json({ error: 'Подписка не активна — нажмите «Включить» ещё раз.', needsResubscribe: true });
      return;
    }

    const rateKey = `${getClientKey(req)}:${subId.slice(0, 12)}`;
    if (isPushTestRateLimited(rateKey)) {
      res.status(429).json({ error: 'Слишком много тестовых отправок. Подождите минуту.' });
      return;
    }

    const rawDelay = Number(req.body?.delaySec);
    const delaySec = Number.isFinite(rawDelay) ? Math.max(0, Math.min(10, Math.round(rawDelay))) : 0;

    const payload = {
      title: 'Малыш+: фоновый Push работает!',
      body: delaySec > 0
        ? 'Отлично — уведомление пришло с сервера даже в свёрнутом режиме.'
        : 'Тестовое серверное Push-уведомление доставлено.',
      tag: `malysh-test-${Date.now()}`,
      key: 'custom',
      tab: 'journal',
      requireInteraction: false,
    };

    if (delaySec > 0) {
      setTimeout(() => {
        const current = pushSubscriptions.get(subId);
        if (current) {
          deliverWebPushNotification(current, payload).catch(() => {});
        }
      }, delaySec * 1000);
      res.json({ ok: true, queued: true, delaySec });
      return;
    }

    const result = await deliverWebPushNotification(rec, payload);
    if (!result.ok) {
      res.status(result.expired ? 410 : 502).json({
        error: result.error || 'Не удалось доставить Push-уведомление.',
        needsResubscribe: Boolean(result.expired),
      });
      return;
    }

    res.json({ ok: true, delivered: true });
  });

  // Return JSON 404 for unknown /api routes instead of falling through to HTML middleware
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Return JSON for malformed request bodies or unexpected API errors
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) {
      const status =
        err && typeof err === 'object' && 'status' in err && typeof (err as { status?: unknown }).status === 'number'
          ? (err as { status: number }).status
          : 500;
      const safeStatus = status >= 400 && status < 600 ? status : 500;
      res.status(safeStatus).json({
        error: safeStatus === 400 ? 'Некорректный формат JSON-запроса.' : 'Внутренняя ошибка сервера.',
      });
      return;
    }
    next(err);
  });

  // Friendly /admin and /admin/ aliases
  app.get(['/admin', '/admin/'], (_req, res) => {
    res.redirect(302, '/admin.html');
  });

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(__dirname, 'dist');

  if (!isProd || !fs.existsSync(distDir)) {
    // HMR is disabled in this environment; serve a clean no-WebSocket stub for /@vite/client
    // so Vite's injected client script never triggers "WebSocket closed without opened." errors.
    app.get('/@vite/client', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(`
const sheetsMap = new Map();
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    style.remove();
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    invalidate() {},
    on() {},
    off() {},
    send() {}
  };
}
export function injectQuery(url, queryToInject) {
  if (url[0] !== '.' && url[0] !== '/') return url;
  const pathname = url.replace(/[?#].*$/, '');
  const { search, hash } = new URL(url, 'http://vite.dev');
  return pathname + '?' + queryToInject + (search ? '&' + search.slice(1) : '') + (hash || '');
}
export class ErrorOverlay extends HTMLElement {}
`);
    });

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'mpa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('/', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
    app.get('/admin.html', (_req, res) => {
      res.sendFile(path.join(distDir, 'admin.html'));
    });
  }

  const pushInterval = setInterval(() => {
    runScheduledPushDispatch().catch(() => {});
  }, PUSH_DISPATCH_INTERVAL_MS);
  if (typeof pushInterval.unref === 'function') {
    pushInterval.unref();
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Malysh+ server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
