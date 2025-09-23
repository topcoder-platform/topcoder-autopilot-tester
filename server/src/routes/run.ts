
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RunnerLogger } from '../utils/logger.js';
import { runFlow, type FlowConfig, type StepName } from '../services/flowRunner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.resolve(__dirname, '../../data/config.json');

const router = Router();

type ActiveRun = {
  controller: AbortController;
};

let activeRun: ActiveRun | null = null;

router.get('/stream', async (req, res) => {
  const mode = (req.query.mode || 'full') as 'full' | 'toStep';
  const toStep = req.query.toStep as StepName | undefined;

  // Cancel any previously running flow before starting a new one.
  if (activeRun) {
    activeRun.controller.abort();
  }

  const controller = new AbortController();
  const currentRun: ActiveRun = { controller };
  activeRun = currentRun;

  const cleanup = () => {
    if (activeRun === currentRun) {
      activeRun = null;
    }
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  function send(evt: any) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  const log = new RunnerLogger();
  const onLog = (e: any) => send(e);
  const onStep = (e: any) => send(e);
  log.on('log', onLog);
  log.on('step', onStep);

  let cfg: FlowConfig;
  try {
    cfg = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  } catch (e) {
    send({ level: 'error', message: 'Failed to read config' });
    res.end();
    return;
  }

  const onClose = () => {
    controller.abort();
  };
  req.on('close', onClose);

  try {
    send({ level: 'info', message: 'Run started' });
    await runFlow(cfg, mode, toStep, log, controller.signal);
    send({ level: 'info', message: 'Run finished', progress: 100 });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg === '__STOP_EARLY__') {
      send({ level: 'info', message: 'Stopped at requested step', progress: 100 });
      res.end();
      cleanup();
      return;
    }
    if (msg === '__CANCELLED__') {
      send({ level: 'info', message: 'Run cancelled' });
    } else {
      send({ level: 'error', message: 'Run failed', data: e?.message || String(e) });
    }
  } finally {
    log.off('log', onLog);
    log.off('step', onStep);
    cleanup();
    req.off('close', onClose);
    res.end();
  }
});

export default router;
