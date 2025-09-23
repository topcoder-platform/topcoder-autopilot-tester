
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data');
const filePath = path.join(dataDir, 'last-run.json');

export type LastRun = {
  challengeId?: string;
  challengeName?: string;
  submissions?: { [submitterHandle: string]: string[] }; // list of submission IDs by handle
  reviews?: { [key: string]: string }; // `${reviewerHandle}:${submitterHandle}:${submissionId}` -> reviewId
  appeals?: string[]; // appeal ids
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
