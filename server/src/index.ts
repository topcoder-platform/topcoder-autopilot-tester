
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import configRouter from './routes/config.js';
import runRouter from './routes/run.js';
import refdataRouter from './routes/refdata.js';
import challengesRouter from './routes/challenges.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/api/config', configRouter);
app.use('/api/run', runRouter);
app.use('/api/refdata', refdataRouter);
app.use('/api/challenges', challengesRouter);

const PORT = process.env.PORT || 5055;
app.listen(PORT, () => {
  console.log(`Autopilot tester server listening on http://localhost:${PORT}`);
});
