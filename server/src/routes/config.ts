
import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  normalizeAppConfig,
  readAppConfigFile,
  writeAppConfigFile,
  type AppConfig
} from '../types/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.resolve(__dirname, '../../data/config.json');

const router = Router();

router.get('/', (req, res) => {
  try {
    const config = readAppConfigFile(dataPath);
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read config', details: String(error) });
  }
});

router.post('/', (req, res) => {
  try {
    const incoming = req.body as AppConfig | undefined;
    const normalized = normalizeAppConfig(incoming ?? {});
    writeAppConfigFile(dataPath, normalized);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save config', details: String(error) });
  }
});

export default router;
