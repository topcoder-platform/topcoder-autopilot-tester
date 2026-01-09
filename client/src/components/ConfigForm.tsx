import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import type {
  AppConfig,
  First2FinishConfig,
  FlowVariant,
  FullChallengeConfig,
  TopgearConfig,
  DesignConfig
} from '../types'
import { CONFIG_STORAGE_KEY } from '../defaultConfig'

function getFlowConfig(config: AppConfig, flow: FlowVariant): FullChallengeConfig | First2FinishConfig | DesignConfig {
  switch (flow) {
    case 'full':
      return config.fullChallenge;
    case 'design':
      return config.designChallenge;
    case 'designSingle':
      return config.designSingleChallenge;
    case 'designFailScreening':
      return config.designFailScreeningChallenge;
    case 'designFailReview':
      return config.designFailReviewChallenge;
    case 'first2finish':
      return config.first2finish;
    case 'topgear':
      return config.topgear;
    case 'topgearLate':
      return config.topgear;
    default:
      return config.fullChallenge;
  }
}

type Props = {
  flow: FlowVariant;
  config: AppConfig;
  onSaved: () => void;
};

type ListInputs = {
  reviewers: string;
  reviewer: string;
  screener?: string;
  approver?: string;
  checkpointScreener?: string;
  checkpointReviewer?: string;
  submitters: string;
  prizes: string;
  prize: string;
};

export default function ConfigForm({ flow, config, onSaved }: Props) {
  const [types, setTypes] = useState<any[]>([]);
  const [tracks, setTracks] = useState<any[]>([]);
  const [scorecards, setScorecards] = useState<any[]>([]);
  const [isRefDataLoading, setIsRefDataLoading] = useState(false);
  const [refDataError, setRefDataError] = useState<string | null>(null);
  const [isScorecardsLoading, setIsScorecardsLoading] = useState(false);
  const [scorecardsError, setScorecardsError] = useState<string | null>(null);
  const [formConfig, setFormConfig] = useState<FullChallengeConfig | First2FinishConfig | DesignConfig>(() => getFlowConfig(config, flow));
  const [listInputs, setListInputs] = useState<ListInputs>({ reviewers: '', reviewer: '', screener: '', approver: '', checkpointScreener: '', checkpointReviewer: '', submitters: '', prizes: '', prize: '' });
  const isFull = flow === 'full';
  const isFullLike = flow === 'full' || flow === 'designSingle';
  const isDesign = flow === 'design' || flow === 'designFailScreening' || flow === 'designFailReview';
  const iterativeLabel = flow === 'topgear' ? 'Topgear Task' : (flow === 'topgearLate' ? 'Topgear Task (Late)' : 'First2Finish');
  const refDataStatus = isRefDataLoading ? 'Loading challenge types and tracks...' : refDataError;
  const scorecardsStatus = isScorecardsLoading ? 'Loading scorecards...' : scorecardsError;
  const isScorecardsDisabled = isScorecardsLoading || Boolean(scorecardsError);

  const activeConfig = useMemo(() => getFlowConfig(config, flow), [config, flow]);

  useEffect(() => {
    const loadReferenceData = async () => {
      try {
        setIsRefDataLoading(true);
        setRefDataError(null);
        const [typesResponse, tracksResponse] = await Promise.all([
          axios.get('/api/refdata/challenge-types'),
          axios.get('/api/refdata/challenge-tracks')
        ]);
        setTypes(Array.isArray(typesResponse.data) ? typesResponse.data : []);
        setTracks(Array.isArray(tracksResponse.data) ? tracksResponse.data : []);
      } catch (error) {
        console.error('Failed to load reference data', error);
        setRefDataError('Failed to load challenge types and tracks.');
        setTypes([]);
        setTracks([]);
      } finally {
        setIsRefDataLoading(false);
      }
    };
    loadReferenceData();
  }, []);

  useEffect(() => {
    setFormConfig(activeConfig);
    setListInputs({
      reviewers: isFullLike && Array.isArray((activeConfig as FullChallengeConfig).reviewers)
        ? (activeConfig as FullChallengeConfig).reviewers.join(', ')
        : '',
      reviewer: isDesign ? (activeConfig as DesignConfig).reviewer ?? '' : (!isFullLike ? (activeConfig as First2FinishConfig).reviewer ?? '' : ''),
      screener: isFullLike
        ? ((activeConfig as FullChallengeConfig).screener ?? '')
        : isDesign
          ? ((activeConfig as DesignConfig).screener ?? (activeConfig as DesignConfig).screeningReviewer ?? (activeConfig as DesignConfig).reviewer ?? '')
          : '',
      approver: isDesign ? ((activeConfig as DesignConfig).approver ?? (activeConfig as DesignConfig).reviewer ?? '') : '',
      checkpointScreener: isDesign ? ((activeConfig as DesignConfig).checkpointScreener ?? (activeConfig as DesignConfig).screener ?? (activeConfig as DesignConfig).screeningReviewer ?? (activeConfig as DesignConfig).reviewer ?? '') : '',
      checkpointReviewer: isDesign ? ((activeConfig as DesignConfig).checkpointReviewer ?? (activeConfig as DesignConfig).reviewer ?? '') : '',
      submitters: Array.isArray(activeConfig.submitters) ? activeConfig.submitters.join(', ') : '',
      prizes: (isFullLike || isDesign) && Array.isArray((activeConfig as any).prizes)
        ? ((activeConfig as any).prizes as number[]).join(', ')
        : '',
      prize: (!isFullLike && !isDesign) && typeof (activeConfig as First2FinishConfig).prize === 'number'
        ? String((activeConfig as First2FinishConfig).prize)
        : ''
    });
  }, [activeConfig, isFullLike, isDesign]);

  useEffect(() => {
    const loadScores = async () => {
      setScorecardsError(null);
      if (!formConfig.challengeTypeId || !formConfig.challengeTrackId) {
        setScorecards([]);
        setIsScorecardsLoading(false);
        return;
      }
      const typeEntry = types.find(t => t.id === formConfig.challengeTypeId);
      const trackEntry = tracks.find(t => t.id === formConfig.challengeTrackId);
      const typeName = typeEntry?.name || formConfig.challengeTypeId;
      const trackCode = trackEntry?.track; // Use the API 'track' value, not the display name
      if (!typeName || !trackCode) {
        setScorecards([]);
        setIsScorecardsLoading(false);
        return;
      }
      try {
        setIsScorecardsLoading(true);
        const { data } = await axios.get('/api/refdata/scorecards', {
          params: { challengeType: typeName, challengeTrack: trackCode }
        });
        const list = Array.isArray(data)
          ? data
          : Array.isArray((data as any)?.scoreCards)
            ? (data as any).scoreCards
            : Array.isArray((data as any)?.result)
              ? (data as any).result
              : Array.isArray((data as any)?.result?.content)
                ? (data as any).result.content
                : [];
        setScorecards(list);
      } catch (error) {
        console.error('Failed to load scorecards', error);
        setScorecardsError('Failed to load scorecards.');
        setScorecards([]);
      } finally {
        setIsScorecardsLoading(false);
      }
    };
    loadScores();
  }, [formConfig.challengeTypeId, formConfig.challengeTrackId, types, tracks]);

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const payload: AppConfig = {
      ...config,
      fullChallenge: flow === 'full' ? formConfig as FullChallengeConfig : config.fullChallenge,
      designChallenge: flow === 'design' ? formConfig as DesignConfig : config.designChallenge,
      designSingleChallenge: flow === 'designSingle' ? formConfig as FullChallengeConfig : config.designSingleChallenge,
      designFailScreeningChallenge: flow === 'designFailScreening' ? formConfig as DesignConfig : config.designFailScreeningChallenge,
      designFailReviewChallenge: flow === 'designFailReview' ? formConfig as DesignConfig : config.designFailReviewChallenge,
      first2finish: flow === 'first2finish' ? formConfig as First2FinishConfig : config.first2finish,
      topgear: (flow === 'topgear' || flow === 'topgearLate') ? formConfig as TopgearConfig : config.topgear
    };
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(payload));
    onSaved();
  };

  const update = (key: any, value: any) => {
    setFormConfig(prev => ({ ...prev, [key]: value }));
  };

  const updateHandleList = (key: 'reviewers' | 'submitters', value: string) => {
    setListInputs(prev => ({ ...prev, [key]: value }));
    const list = value
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);
    update(key, list);
  };

  const updateReviewer = (value: string) => {
    setListInputs(prev => ({ ...prev, reviewer: value }));
    update('reviewer', value.trim());
  };

  const updateFullScreener = (value: string) => {
    setListInputs(prev => ({ ...prev, screener: value }));
    update('screener', value.trim());
  };

  const updateDesignScreener = (value: string) => {
    setListInputs(prev => ({ ...prev, screener: value }));
    const trimmed = value.trim();
    update('screener', trimmed);
    update('screeningReviewer', trimmed);
  };

  const updateApprover = (value: string) => {
    setListInputs(prev => ({ ...prev, approver: value }));
    update('approver', value.trim());
  };

  const updateCheckpointScreener = (value: string) => {
    setListInputs(prev => ({ ...prev, checkpointScreener: value }));
    update('checkpointScreener', value.trim());
  };

  const updateCheckpointReviewer = (value: string) => {
    setListInputs(prev => ({ ...prev, checkpointReviewer: value }));
    update('checkpointReviewer', value.trim());
  };

  const updateCheckpointPrizeAmount = (value: string) => {
    const amount = Number.parseFloat(value);
    if (Number.isNaN(amount)) {
      update('checkpointPrizeAmount', 0);
      return;
    }
    update('checkpointPrizeAmount', Math.max(0, amount));
  };

  const updateCheckpointPrizeCount = (value: string) => {
    const count = Number.parseInt(value, 10);
    if (Number.isNaN(count)) {
      update('checkpointPrizeCount', 0);
      return;
    }
    update('checkpointPrizeCount', Math.max(0, count));
  };

  const updatePrizes = (value: string) => {
    setListInputs(prev => ({ ...prev, prizes: value }));
    const entries = value
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(entry => Number(entry))
      .filter(entry => !Number.isNaN(entry));
    update('prizes', entries as [number, number, number]);
  };

  const updatePrize = (value: string) => {
    setListInputs(prev => ({ ...prev, prize: value }));
    if (!value.trim()) {
      update('prize', 0);
      return;
    }
    const amount = Number.parseFloat(value);
    if (!Number.isNaN(amount)) {
      update('prize', amount);
    }
  };

  return (
    <form className="card" onSubmit={save}>
      <h3>Edit {flow === 'full' ? 'Full Challenge' : flow === 'design' ? 'Design Challenge' : iterativeLabel} Configuration</h3>

      <div className="row">
        <div className="col">
          <label>Challenge name prefix</label>
          <input value={formConfig.challengeNamePrefix} onChange={e => update('challengeNamePrefix', e.target.value)} />
        </div>
        <div className="col">
          <label>Project ID</label>
          <input
            type="number"
            value={formConfig.projectId}
            onChange={e => update('projectId', Number(e.target.value))}
          />
        </div>
      </div>

      <div className="row">
        <div className="col">
          <label>Challenge type</label>
          <select value={formConfig.challengeTypeId} onChange={e => update('challengeTypeId', e.target.value)} disabled={isRefDataLoading}>
            <option value="">-- Select --</option>
            {types.map((item: any) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </div>
        <div className="col">
          <label>Challenge track</label>
          <select value={formConfig.challengeTrackId} onChange={e => update('challengeTrackId', e.target.value)} disabled={isRefDataLoading}>
            <option value="">-- Select --</option>
            {tracks.map((item: any) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </div>
      </div>
      {refDataStatus ? (
        <small style={{ display: 'block', marginTop: 4, color: isRefDataLoading ? '#94a3b8' : '#fca5a5' }}>
          {refDataStatus}
        </small>
      ) : null}

      <div className="row">
        <div className="col">
          <label>Timeline template ID</label>
          <input
            value={formConfig.timelineTemplateId}
            onChange={e => update('timelineTemplateId', e.target.value)}
            readOnly={!(isFull || isDesign)}
            disabled={!(isFull || isDesign)}
            style={!(isFull || isDesign) ? { opacity: 0.8, cursor: 'not-allowed' } : undefined}
          />
          {(!isFull && !isDesign) ? (
            <small style={{ display: 'block', marginTop: 4, color: '#94a3b8' }}>
              {iterativeLabel} uses a fixed timeline template.
            </small>
          ) : null}
        </div>
        {!isDesign ? (
          <div className="col">
            <label>Scorecard</label>
            <select value={formConfig.scorecardId} onChange={e => update('scorecardId', e.target.value)} disabled={isScorecardsDisabled}>
              <option value="">-- Select --</option>
              {scorecards.map((item: any) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      {scorecardsStatus ? (
        <small style={{ display: 'block', marginTop: 4, color: isScorecardsLoading ? '#94a3b8' : '#fca5a5' }}>
          {scorecardsStatus}
        </small>
      ) : null}

      {isDesign ? (
        <div className="row">
          <div className="col">
            <label>Review Scorecard</label>
            <select
              value={(formConfig as DesignConfig).reviewScorecardId || formConfig.scorecardId}
              onChange={e => update('reviewScorecardId', e.target.value)}
              disabled={isScorecardsDisabled}
            >
              <option value="">-- Select --</option>
              {scorecards.map((item: any) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
          <div className="col">
            <label>Screening Scorecard</label>
            <select
              value={(formConfig as DesignConfig).screeningScorecardId || formConfig.scorecardId}
              onChange={e => update('screeningScorecardId', e.target.value)}
              disabled={isScorecardsDisabled}
            >
              <option value="">-- Select --</option>
              {scorecards.map((item: any) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
          <div className="col">
            <label>Approval Scorecard</label>
            <select
              value={(formConfig as DesignConfig).approvalScorecardId || formConfig.scorecardId}
              onChange={e => update('approvalScorecardId', e.target.value)}
              disabled={isScorecardsDisabled}
            >
              <option value="">-- Select --</option>
              {scorecards.map((item: any) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {isDesign ? (
        <div className="row">
          <div className="col">
            <label>Checkpoint Screening Scorecard</label>
            <select
              value={(formConfig as DesignConfig).checkpointScreeningScorecardId || (formConfig as DesignConfig).checkpointScorecardId}
              onChange={e => update('checkpointScreeningScorecardId', e.target.value)}
              disabled={isScorecardsDisabled}
            >
              <option value="">-- Select --</option>
              {scorecards.map((item: any) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
          <div className="col">
            <label>Checkpoint Review Scorecard</label>
            <select
              value={(formConfig as DesignConfig).checkpointReviewScorecardId || (formConfig as DesignConfig).checkpointScorecardId}
              onChange={e => update('checkpointReviewScorecardId', e.target.value)}
              disabled={isScorecardsDisabled}
            >
              <option value="">-- Select --</option>
              {scorecards.map((item: any) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {isFullLike ? (
        <>
          <div className="row">
            <div className="col">
              <label>Submissions per submitter</label>
              <input
                type="number"
                min={1}
                value={(formConfig as FullChallengeConfig).submissionsPerSubmitter}
                onChange={e => update('submissionsPerSubmitter', Number(e.target.value))}
              />
            </div>
            <div className="col">
              <label>Reviewers (comma-separated handles)</label>
              <input
                value={listInputs.reviewers}
                onChange={e => updateHandleList('reviewers', e.target.value)}
              />
            </div>
          </div>
          <div className="row">
            <div className="col">
              <label>Screener handle</label>
              <input
                value={listInputs.screener || ''}
                onChange={e => updateFullScreener(e.target.value)}
              />
            </div>
            <div className="col">
              <label>Copilot handle</label>
              <input value={formConfig.copilotHandle} onChange={e => update('copilotHandle', e.target.value)} />
            </div>
          </div>
          <div className="row">
            <div className="col">
              <label>Submitters (comma-separated handles)</label>
              <input
                value={listInputs.submitters}
                onChange={e => updateHandleList('submitters', e.target.value)}
              />
            </div>
          </div>
        </>
      ) : isDesign ? (
        <div className="row">
          <div className="col">
            <label>Submissions per submitter</label>
            <input
              type="number"
              min={1}
              value={(formConfig as DesignConfig).submissionsPerSubmitter}
              onChange={e => update('submissionsPerSubmitter', Number(e.target.value))}
            />
          </div>
          <div className="col">
            <label>Reviewer handle</label>
            <input value={listInputs.reviewer} onChange={e => updateReviewer(e.target.value)} />
          </div>
        </div>
      ) : (
        <div className="row">
          <div className="col">
            <label>Iterative Reviewer handle</label>
            <input value={listInputs.reviewer} onChange={e => updateReviewer(e.target.value)} />
          </div>
          <div className="col">
            <label>Copilot handle</label>
            <input value={formConfig.copilotHandle} onChange={e => update('copilotHandle', e.target.value)} />
          </div>
        </div>
      )}

      {isDesign ? (
        <div className="row">
          <div className="col">
            <label>Screener handle</label>
            <input value={listInputs.screener || ''} onChange={e => updateDesignScreener(e.target.value)} />
          </div>
          <div className="col">
            <label>Approver handle</label>
            <input value={listInputs.approver || ''} onChange={e => updateApprover(e.target.value)} />
          </div>
        </div>
      ) : null}

      {isDesign ? (
        <div className="row">
          <div className="col">
            <label>Checkpoint Screener handle</label>
            <input value={listInputs.checkpointScreener || ''} onChange={e => updateCheckpointScreener(e.target.value)} />
          </div>
          <div className="col">
            <label>Checkpoint Reviewer handle</label>
            <input value={listInputs.checkpointReviewer || ''} onChange={e => updateCheckpointReviewer(e.target.value)} />
          </div>
        </div>
      ) : null}

      {isFull ? null : (
        <div className="row">
          <div className="col">
            <label>Submitters (comma-separated handles)</label>
            <input
              value={listInputs.submitters}
              onChange={e => updateHandleList('submitters', e.target.value)}
            />
          </div>
          {(!isDesign) ? (
            <div className="col">
              <label>Prize (winner)</label>
              <input value={listInputs.prize} onChange={e => updatePrize(e.target.value)} />
            </div>
          ) : null}
        </div>
      )}

      {(isFull || isDesign) ? (
        <div className="row">
          <div className="col">
            <label>Prizes (1st, 2nd, 3rd)</label>
            <input value={listInputs.prizes} onChange={e => updatePrizes(e.target.value)} />
          </div>
        </div>
      ) : null}

      {isDesign ? (
        <div className="row">
          <div className="col">
            <label>Checkpoint prize amount</label>
            <input
              type="number"
              min={0}
              value={(formConfig as DesignConfig).checkpointPrizeAmount ?? 0}
              onChange={e => updateCheckpointPrizeAmount(e.target.value)}
            />
          </div>
          <div className="col">
            <label>Checkpoint prize count</label>
            <input
              type="number"
              min={0}
              step={1}
              value={(formConfig as DesignConfig).checkpointPrizeCount ?? 0}
              onChange={e => updateCheckpointPrizeCount(e.target.value)}
            />
          </div>
        </div>
      ) : null}

      <div className="row">
        <div className="col">
          <label>Submission zip path</label>
          <input
            value={formConfig.submissionZipPath}
            onChange={e => update('submissionZipPath', e.target.value)}
            placeholder="./path/to/submission.zip"
          />
        </div>
      </div>

      {(!isFull && !isDesign) ? (
        <div className="row">
          <div className="col">
            <label>Additional Notes</label>
            <div className="pill" style={{ display: 'inline-block' }}>
              {iterativeLabel} runs with one reviewer and iterative submissions.
            </div>
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button type="submit">Save</button>
        <span className="pill">Remember to create <code>server/secrets/m2m.json</code> from the sample</span>
      </div>
    </form>
  )
}
