import type { RequestHandler } from 'express';

const TOKEN_COOKIE_KEYS = ['tcjwt', 'tctV3'];

const parseCookies = (cookieHeader: string | undefined): Record<string, string> => {
  if (!cookieHeader) {
    return {};
  }
  return cookieHeader.split(';').reduce<Record<string, string>>((acc, part) => {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) {
      return acc;
    }
    const value = rest.join('=');
    try {
      acc[rawKey] = decodeURIComponent(value);
    } catch {
      acc[rawKey] = value;
    }
    return acc;
  }, {});
};

const extractToken = (req: Parameters<RequestHandler>[0]): string | null => {
  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === 'string') {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      return trimmed.slice(7).trim();
    }
    return trimmed;
  }

  const cookies = parseCookies(req.headers.cookie);
  for (const key of TOKEN_COOKIE_KEYS) {
    if (cookies[key]) {
      return cookies[key];
    }
  }

  return null;
};

const decodeBase64Url = (value: string): string | null => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    return Buffer.from(padded, 'base64').toString('utf-8');
  } catch {
    return null;
  }
};

const decodeTokenPayload = (token: string): Record<string, unknown> | null => {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  const decoded = decodeBase64Url(parts[1]);
  if (!decoded) {
    return null;
  }
  try {
    const payload = JSON.parse(decoded);
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
};

const findClaimValue = (payload: Record<string, unknown>, matcher: string): unknown => {
  const needle = matcher.toLowerCase();
  for (const [key, value] of Object.entries(payload)) {
    if (key.toLowerCase().includes(needle)) {
      return value;
    }
  }
  return undefined;
};

const extractHandle = (payload: Record<string, unknown>): string | undefined => {
  const direct = payload.handle;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const fromClaim = findClaimValue(payload, 'handle');
  if (typeof fromClaim === 'string' && fromClaim.trim()) {
    return fromClaim.trim();
  }
  const alt = payload.username ?? payload.name ?? payload.sub;
  if (typeof alt === 'string' && alt.trim()) {
    return alt.trim();
  }
  return undefined;
};

const extractUserId = (payload: Record<string, unknown>): number | undefined => {
  const direct = payload.userId ?? payload.user_id ?? findClaimValue(payload, 'userid');
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }
  if (typeof direct === 'string' && direct.trim()) {
    const parsed = Number(direct);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const extractRoles = (payload: Record<string, unknown>): string[] | undefined => {
  const direct = payload.roles ?? findClaimValue(payload, 'roles');
  if (Array.isArray(direct)) {
    return direct.filter(item => typeof item === 'string');
  }
  if (typeof direct === 'string' && direct.trim()) {
    return [direct.trim()];
  }
  return undefined;
};

const extractExp = (payload: Record<string, unknown>): number | undefined => {
  const direct = payload.exp;
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }
  if (typeof direct === 'string' && direct.trim()) {
    const parsed = Number(direct);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

export const authenticateJWT: RequestHandler = (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const payload = decodeTokenPayload(token);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const exp = extractExp(payload);
  if (typeof exp === 'number' && Date.now() >= exp * 1000) {
    res.status(401).json({ error: 'Token expired' });
    return;
  }

  const handle = extractHandle(payload);
  if (!handle) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const userId = extractUserId(payload);
  const roles = extractRoles(payload);

  req.user = {
    handle,
    userId: userId ?? 0,
    roles,
    token
  };

  next();
};

export const requireAuth = authenticateJWT;
