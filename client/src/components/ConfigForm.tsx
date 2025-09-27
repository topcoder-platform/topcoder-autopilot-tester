import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import type {
  AppConfig,
  First2FinishConfig,
  FlowVariant,
  FullChallengeConfig
} from '../types'

function getFlowConfig(config: AppConfig, flow: FlowVariant): FullChallengeConfig | First2FinishConfig {
  return flow === 'full' ? config.fullChallenge : config.first2finish;
}

type Props = {
  flow: FlowVariant;
  config: AppConfig;
  onSaved: () => void;
};

type ListInputs = {
  reviewers: string;
  reviewer: string;
  submitters: string;
  prizes: string;
  prize: string;
};

export default function ConfigForm({ flow, config, onSaved }: Props) {
  const [types, setTypes] = useState<any[]>([]);
  const [tracks, setTracks] = useState<any[]>([]);
  const [scorecards, setScorecards] = useState<any[]>([]);
  const [formConfig, setFormConfig] = useState<FullChallengeConfig | First2FinishConfig>(() => getFlowConfig(config, flow));
  const [listInputs, setListInputs] = useState<ListInputs>({ reviewers: '', reviewer: '', submitters: '', prizes: '', prize: '' });
  const isFull = flow === 'full';

  const activeConfig = useMemo(() => getFlowConfig(config, flow), [config, flow]);

  useEffect(() => {
    const loadReferenceData = async () => {
      try {
        const [typesResponse, tracksResponse] = await Promise.all([
          axios.get('/api/refdata/challenge-types'),
          axios.get('/api/refdata/challenge-tracks')
        ]);
        setTypes(Array.isArray(typesResponse.data) ? typesResponse.data : []);
        setTracks(Array.isArray(tracksResponse.data) ? tracksResponse.data : []);
      } catch (error) {
        console.error('Failed to load reference data', error);
        setTypes([]);
        setTracks([]);
      }
    };
    loadReferenceData();
  }, []);

  useEffect(() => {
    setFormConfig(activeConfig);
    setListInputs({
      reviewers: isFull && Array.isArray((activeConfig as FullChallengeConfig).reviewers)
        ? (activeConfig as FullChallengeConfig).reviewers.join(', ')
        : '',
      reviewer: !isFull ? (activeConfig as First2FinishConfig).reviewer ?? '' : '',
      submitters: Array.isArray(activeConfig.submitters) ? activeConfig.submitters.join(', ') : '',
      prizes: isFull && Array.isArray((activeConfig as FullChallengeConfig).prizes)
        ? (activeConfig as FullChallengeConfig).prizes.join(', ')
        : '',
      prize: !isFull && typeof (activeConfig as First2FinishConfig).prize === 'number'
        ? String((activeConfig as First2FinishConfig).prize)
        : ''
    });
  }, [activeConfig, isFull]);

  useEffect(() => {
    const loadScores = async () => {
      if (!formConfig.challengeTypeId || !formConfig.challengeTrackId) {
        setScorecards([]);
        return;
      }
      const typeEntry = types.find(t => t.id === formConfig.challengeTypeId);
      const trackEntry = tracks.find(t => t.id === formConfig.challengeTrackId);
      const typeName = typeEntry?.name || formConfig.challengeTypeId;
      const trackName = trackEntry?.name || formConfig.challengeTrackId;
      if (!typeName || !trackName) {
        setScorecards([]);
        return;
      }
      try {
        const { data } = await axios.get('/api/refdata/scorecards', {
          params: { challengeType: typeName, challengeTrack: String(trackName).toUpperCase() }
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
        setScorecards([]);
      }
    };
    loadScores();
  }, [formConfig.challengeTypeId, formConfig.challengeTrackId, types, tracks]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const payload: AppConfig = {
      ...config,
      fullChallenge: flow === 'full' ? formConfig as FullChallengeConfig : config.fullChallenge,
      first2finish: flow === 'first2finish' ? formConfig as First2FinishConfig : config.first2finish
    };
    await axios.post('/api/config', payload);
    onSaved();
  };

  const update = (key: keyof FullChallengeConfig | keyof First2FinishConfig, value: any) => {
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
      <h3>Edit {flow === 'full' ? 'Full Challenge' : 'First2Finish'} Configuration</h3>

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
          <select value={formConfig.challengeTypeId} onChange={e => update('challengeTypeId', e.target.value)}>
            <option value="">-- Select --</option>
            {types.map((item: any) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </div>
        <div className="col">
          <label>Challenge track</label>
          <select value={formConfig.challengeTrackId} onChange={e => update('challengeTrackId', e.target.value)}>
            <option value="">-- Select --</option>
            {tracks.map((item: any) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="row">
        <div className="col">
          <label>Timeline template ID</label>
          <input
            value={formConfig.timelineTemplateId}
            onChange={e => update('timelineTemplateId', e.target.value)}
            readOnly={!isFull}
            disabled={!isFull}
            style={!isFull ? { opacity: 0.8, cursor: 'not-allowed' } : undefined}
          />
          {!isFull ? (
            <small style={{ display: 'block', marginTop: 4, color: '#94a3b8' }}>
              First2Finish uses a fixed timeline template.
            </small>
          ) : null}
        </div>
        <div className="col">
          <label>Scorecard</label>
          <select value={formConfig.scorecardId} onChange={e => update('scorecardId', e.target.value)}>
            <option value="">-- Select --</option>
            {scorecards.map((item: any) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </div>
      </div>

      {isFull ? (
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
      ) : (
        <div className="row">
          <div className="col">
            <label>Reviewer handle</label>
            <input value={listInputs.reviewer} onChange={e => updateReviewer(e.target.value)} />
          </div>
          <div className="col">
            <label>Copilot handle</label>
            <input value={formConfig.copilotHandle} onChange={e => update('copilotHandle', e.target.value)} />
          </div>
        </div>
      )}

      {isFull ? (
        <div className="row">
          <div className="col">
            <label>Copilot handle</label>
            <input value={formConfig.copilotHandle} onChange={e => update('copilotHandle', e.target.value)} />
          </div>
          <div className="col">
            <label>Submitters (comma-separated handles)</label>
            <input
              value={listInputs.submitters}
              onChange={e => updateHandleList('submitters', e.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="row">
          <div className="col">
            <label>Submitters (comma-separated handles)</label>
            <input
              value={listInputs.submitters}
              onChange={e => updateHandleList('submitters', e.target.value)}
            />
          </div>
          <div className="col">
            <label>Prize (winner)</label>
            <input value={listInputs.prize} onChange={e => updatePrize(e.target.value)} />
          </div>
        </div>
      )}

      {isFull ? (
        <div className="row">
          <div className="col">
            <label>Prizes (1st, 2nd, 3rd)</label>
            <input value={listInputs.prizes} onChange={e => updatePrizes(e.target.value)} />
          </div>
        </div>
      ) : null}

      {!isFull ? (
        <div className="row">
          <div className="col">
            <label>Additional Notes</label>
            <div className="pill" style={{ display: 'inline-block' }}>
              First2Finish runs with one reviewer and iterative submissions.
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
