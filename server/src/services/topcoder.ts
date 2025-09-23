
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type M2MSecrets = {
  tokenUrl: string;
  audience: string;
  clientId: string;
  clientSecret: string;
};
let cachedToken: { token: string; exp: number } | null = null;

export async function getToken(): Promise<string> {
  const secretPath = path.resolve(__dirname, '../../secrets/m2m.json');
  if (!fs.existsSync(secretPath)) {
    throw new Error(`Missing secrets/m2m.json. Copy secrets/m2m.sample.json and fill your clientId/clientSecret.`);
  }
  const secrets: M2MSecrets = JSON.parse(fs.readFileSync(secretPath, 'utf-8'));
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const { data } = await axios.post(secrets.tokenUrl, {
    fresh_token: true,
    client_id: secrets.clientId,
    client_secret: secrets.clientSecret,
    audience: secrets.audience,
    grant_type: 'client_credentials'
  }, { headers: { 'content-type': 'application/json' } });

  const token = data.access_token;
  const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf-8'));
  cachedToken = { token, exp: decoded.exp || (now + 3600) };
  return token;
}

export function axiosWithAuth(token: string) {
  const ax = axios.create({
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });

  ax.interceptors.request.use((config) => {
    const method = config.method?.toUpperCase() || 'GET';
    const url = config.url || 'unknown-url';
    (config as any).__requestStart = Date.now();
    console.log(`[Topcoder API] → ${method} ${url}`, {
      params: config.params,
      data: config.data
    });
    return config;
  }, (error) => {
    const cfg = error?.config;
    const method = cfg?.method?.toUpperCase() || 'GET';
    const url = cfg?.url || 'unknown-url';
    console.error(`[Topcoder API] ✖ request ${method} ${url}: ${error?.message}`);
    return Promise.reject(error);
  });

  ax.interceptors.response.use((response) => {
    const { config, status, statusText, data } = response;
    const method = config.method?.toUpperCase() || 'GET';
    const url = config.url || 'unknown-url';
    const startedAt = (config as any).__requestStart;
    const durationMs = typeof startedAt === 'number' ? Date.now() - startedAt : undefined;
    console.log(`[Topcoder API] ← ${method} ${url} ${status} ${statusText || ''}${durationMs !== undefined ? ` (${durationMs}ms)` : ''}`, {
      data
    });
    return response;
  }, (error) => {
    const cfg = error?.config || {};
    const method = cfg.method?.toUpperCase() || 'GET';
    const url = cfg.url || 'unknown-url';
    const status = error?.response?.status;
    const statusText = error?.response?.statusText;
    const startedAt = (cfg as any).__requestStart;
    const durationMs = typeof startedAt === 'number' ? Date.now() - startedAt : undefined;
    console.error(`[Topcoder API] ← ${method} ${url} ${status ?? 'error'} ${statusText || ''}${durationMs !== undefined ? ` (${durationMs}ms)` : ''}`, {
      data: error?.response?.data,
      message: error?.message
    });
    return Promise.reject(error);
  });
  return ax;
}

// Helpers that map to the v6 APIs used in the flow.
export const TC = {
  async createChallenge(token: string, payload: any) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.post('https://api.topcoder-dev.com/v6/challenges', payload);
    return data;
  },
  async updateChallenge(token: string, id: string, payload: any) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.put(`https://api.topcoder-dev.com/v6/challenges/${id}`, payload);
    return data;
  },
  async activateChallenge(token: string, id: string) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.patch(`https://api.topcoder-dev.com/v6/challenges/${id}`, { status: 'ACTIVE' });
    return data;
  },
  async getChallenge(token: string, id: string) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.get(`https://api.topcoder-dev.com/v6/challenges/${id}`);
    return data;
  },
  async getMemberByHandle(token: string, handle: string) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.get(`https://api.topcoder-dev.com/v6/members/${encodeURIComponent(handle)}`);
    return data;
  },
  async listResourceRoles(token: string) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.get('https://api.topcoder-dev.com/v6/resource-roles');
    return data;
  },
  async addResource(token: string, payload: any) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.post('https://api.topcoder-dev.com/v6/resources', payload);
    return data;
  },
  async createSubmission(token: string, payload: any) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.post('https://api.topcoder-dev.com/v6/submissions', payload);
    return data;
  },
  async getScorecard(token: string, id: string) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.get(`https://api.topcoder-dev.com/v6/scorecards/${id}`);
    return data;
  },
  async createReview(token: string, payload: any) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.post(`https://api.topcoder-dev.com/v6/reviews`, payload);
    return data;
  },
  async listReviews(token: string, challengeId: string) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.get(`https://api.topcoder-dev.com/v6/reviews`, { params: { challengeId } });
    return data;
  },
  async createAppeal(token: string, payload: any) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.post(`https://api.topcoder-dev.com/v6/appeals`, payload);
    return data;
  },
  async respondToAppeal(token: string, appealId: string, payload: any) {
    const ax = axiosWithAuth(token);
    const { data } = await ax.post(`https://api.topcoder-dev.com/v6/appeals/${appealId}/response`, payload);
    return data;
  },
  // NOTE: The exact endpoint to update review item scores may vary.
  // If your environment exposes a dedicated endpoint, adjust here.
  async updateReviewItem(token: string, payload: any) {
    const ax = axiosWithAuth(token);
    // Placeholder endpoint; adjust to your review service API if different:
    const { data } = await ax.post(`https://api.topcoder-dev.com/v6/review-items`, payload);
    return data;
  }
};
