
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.resolve(__dirname, '../../data/config.json');

const router = Router();

router.get('/', (req, res) => {
  try {
    const raw = fs.readFileSync(dataPath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: 'Failed to read config', details: String(e) });
  }
});

router.post('/', (req, res) => {
  try {
    fs.writeFileSync(dataPath, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save config', details: String(e) });
  }
});

export default router;
