import { Router } from 'express';
import { getToken, TC } from '../services/topcoder.js';

const router = Router();

router.get('/:challengeId/reviews', async (req, res) => {
  const challengeId = typeof req.params.challengeId === 'string' ? req.params.challengeId.trim() : '';
  if (!challengeId) {
    res.status(400).json({ error: 'challengeId is required' });
    return;
  }

  try {
    const token = await getToken();
    const data = await TC.listReviews(token, challengeId);
    res.json(data);
  } catch (error: any) {
    console.error('Failed to fetch reviews', {
      challengeId,
      error: error?.message || String(error)
    });
    res.status(500).json({
      error: 'Failed to fetch reviews',
      details: error?.message || String(error)
    });
  }
});

export default router;
