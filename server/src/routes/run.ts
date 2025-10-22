
import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { RunnerLogger } from '../utils/logger.js';
import { runFlow, runDesignSingleFlow, type StepName as FullStepName, type DesignSingleStepName } from '../services/flowRunner.js';
import { runFirst2FinishFlow, type StepName as First2FinishStepName } from '../services/first2finishRunner.js';
import { runDesignFlow, type StepName as DesignStepName } from '../services/designRunner.js';
import { readAppConfigFile } from '../types/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.resolve(__dirname, '../../data/config.json');

const router = Router();

type ActiveRun = {
  controller: AbortController;
};

let activeRun: ActiveRun | null = null;

router.get('/stream', async (req, res) => {
  const modeParam = typeof req.query.mode === 'string' ? req.query.mode : 'full';
  const mode = modeParam === 'toStep' ? 'toStep' : 'full';
  const toStepRaw = typeof req.query.toStep === 'string' ? req.query.toStep : undefined;
  const flowParam = typeof req.query.flow === 'string' ? req.query.flow.toLowerCase() : 'full';
  const flowVariant = flowParam === 'first2finish'
    ? 'first2finish'
    : flowParam === 'topgear'
      ? 'topgear'
      : flowParam === 'topgearlate'
        ? 'topgearLate'
        : flowParam === 'designsingle'
          ? 'designSingle'
          : flowParam === 'designfailscreening'
            ? 'designFailScreening'
            : flowParam === 'designfailreview'
              ? 'designFailReview'
              : flowParam === 'design'
                ? 'design'
                : 'full';

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

  const appConfig = readAppConfigFile(dataPath);

  const onClose = () => {
    controller.abort();
  };
  req.on('close', onClose);

  try {
    send({ level: 'info', message: 'Run started', data: { flow: flowVariant } });
    if (flowVariant === 'first2finish' || flowVariant === 'topgear' || flowVariant === 'topgearLate') {
      await runFirst2FinishFlow(
        flowVariant === 'first2finish' ? appConfig.first2finish : appConfig.topgear,
        mode,
        toStepRaw as First2FinishStepName | undefined,
        log,
        controller.signal,
        flowVariant === 'topgear'
          ? { submissionPhaseName: 'Topgear Submission' }
          : flowVariant === 'topgearLate'
            ? { submissionPhaseName: 'Topgear Submission', lateSubmission: true }
            : undefined
      );
    } else if (flowVariant === 'design') {
      await runDesignFlow(
        appConfig.designChallenge,
        mode,
        toStepRaw as DesignStepName | undefined,
        log,
        controller.signal
      );
    } else if (flowVariant === 'designSingle') {
      await runDesignSingleFlow(
        appConfig.designSingleChallenge,
        mode,
        toStepRaw as DesignSingleStepName | undefined,
        log,
        controller.signal
      );
    } else if (flowVariant === 'designFailScreening') {
      await (runDesignFlow as any)(
        appConfig.designFailScreeningChallenge,
        mode,
        toStepRaw as DesignStepName | undefined,
        log,
        controller.signal,
        'screening'
      );
    } else if (flowVariant === 'designFailReview') {
      await (runDesignFlow as any)(
        appConfig.designFailReviewChallenge,
        mode,
        toStepRaw as DesignStepName | undefined,
        log,
        controller.signal,
        'review'
      );
    } else {
      await runFlow(
        appConfig.fullChallenge,
        mode,
        toStepRaw as FullStepName | undefined,
        log,
        controller.signal
      );
    }
    send({ level: 'info', message: 'Run finished', progress: 100, data: { flow: flowVariant } });
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
