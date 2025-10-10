
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data');
const filePath = path.join(dataDir, 'last-run.json');

export type ChallengeResource = {
  id: string;
  memberId?: string;
  memberHandle?: string;
  roleId?: string;
};

export type LastRun = {
  challengeId?: string;
  challengeName?: string;
  submissions?: { [submitterHandle: string]: string[] }; // list of submission IDs by handle
  reviews?: { [key: string]: string }; // `${reviewerHandle}:${submitterHandle}:${submissionId}` -> reviewId
  appeals?: string[]; // appeal ids
  appealedCommentIds?: string[];
  reviewerResources?: { [handle: string]: string }; // DEPRECATED: reviewer handle -> resource id (single role). Kept for backward-compat.
  // New: map resource IDs per handle and role to avoid collisions when the same member holds multiple roles
  reviewerResourcesByHandle?: { [handle: string]: { [roleName: string]: string } };
  challengeResources?: ChallengeResource[]; // resources fetched from challenge API
  resourceRoleIds?: { [roleName: string]: string }; // cached resource role IDs by name
};

export function readLastRun(): LastRun {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function writeLastRun(patch: Partial<LastRun>) {
  const curr = readLastRun();
  const next = { ...curr, ...patch };
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  return next;
}

export function resetLastRun() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({}, null, 2));
}
