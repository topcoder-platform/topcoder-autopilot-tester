
import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth.middleware.js';
import { axiosWithAuth } from '../services/topcoder.js';

const router = Router();

router.use(authenticateJWT);

router.get('/challenge-types', async (req, res) => {
  try {
    const token = req.user?.token;
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const ax = axiosWithAuth(token);
    const { data } = await ax.get('https://api.topcoder-dev.com/v6/challenge-types');
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to fetch challenge types', details: e?.message || String(e) });
  }
});

router.get('/challenge-tracks', async (req, res) => {
  try {
    const token = req.user?.token;
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const ax = axiosWithAuth(token);
    const { data } = await ax.get('https://api.topcoder-dev.com/v6/challenge-tracks');
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to fetch challenge tracks', details: e?.message || String(e) });
  }
});

router.get('/scorecards', async (req, res) => {
  try {
    const { challengeTypeId, challengeTrackId, challengeType, challengeTrack } = req.query;
    const typeParam = (challengeType || challengeTypeId) as string | undefined;
    const trackParamRaw = (challengeTrack || challengeTrackId) as string | undefined;
    if (!typeParam || !trackParamRaw) {
      return res.status(400).json({
        error: 'challengeType and challengeTrack are required when fetching scorecards'
      });
    }

    const token = req.user?.token;
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const trackParam = trackParamRaw.toUpperCase();

    const ax = axiosWithAuth(token);
    const { data } = await ax.get(`https://api.topcoder-dev.com/v6/scorecards`, {
      params: {
        challengeType: typeParam,
        challengeTrack: trackParam,
        perPage: 100
      }
    });
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to fetch scorecards', details: e?.message || String(e) });
  }
});

export default router;
