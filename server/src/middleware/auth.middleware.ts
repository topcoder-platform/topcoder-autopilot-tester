import core from 'tc-core-library-js';
import type { RequestHandler } from 'express';

const TOKEN_COOKIE_KEYS = ['tcjwt', 'tctV3'];

/** Parse member cookies from an optional header; malformed encoding stays inert data. */
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

/** Read a strict bearer header or supported member cookie; return null when absent/invalid. */
const extractToken = (req: Parameters<RequestHandler>[0]): string | null => {
  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === 'string') {
    return /^Bearer ([^\s]+)$/i.exec(authHeader)?.[1] || null;
  }

  const cookies = parseCookies(req.headers.cookie);
  for (const key of TOKEN_COOKIE_KEYS) {
    if (cookies[key]) {
      return cookies[key];
    }
  }

  return null;
};

let validator: ReturnType<typeof core.auth.createValidator> | undefined;

/**
 * Verify the member bearer/cookie token before reference-data requests.
 * Express request/response/next are inputs; populates req.user and invokes next.
 * Returns 401 for invalid signatures/claims or 403 for verified service identities;
 * errors remain sanitized and no unsigned decoded claims grant access.
 */
export const authenticateJWT: RequestHandler = async (req, res, next) => {
  let principal;
  try {
    if (!validator) validator = core.auth.createValidator();
    principal = await validator.verify(extractToken(req) || '');
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (principal.kind !== 'user') {
    res.status(403).json({ error: 'Member authentication required' });
    return;
  }
  if (!principal.handle || !principal.userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  req.user = { handle: principal.handle, userId: principal.userId, roles: principal.roles, token: extractToken(req)! };
  next();
};

export const requireAuth = authenticateJWT;
