
import React, { useEffect, useState } from 'react'
import axios from 'axios'

export default function ConfigForm({ onSaved }: { onSaved: ()=>void }) {
  const [config, setConfig] = useState<any>(null);
  const [types, setTypes] = useState<any[]>([]);
  const [tracks, setTracks] = useState<any[]>([]);
  const [scorecards, setScorecards] = useState<any[]>([]);
  const [listInputs, setListInputs] = useState({ reviewers: '', submitters: '', prizes: '' });

  const load = async () => {
    const [c,t,tr] = await Promise.all([
      axios.get('/api/config'),
      axios.get('/api/refdata/challenge-types'),
      axios.get('/api/refdata/challenge-tracks')
    ]);
    setConfig(c.data);
    setTypes(t.data);
    setTracks(tr.data);
    setListInputs({
      reviewers: Array.isArray(c.data?.reviewers) ? c.data.reviewers.join(', ') : '',
      submitters: Array.isArray(c.data?.submitters) ? c.data.submitters.join(', ') : '',
      prizes: Array.isArray(c.data?.prizes) ? c.data.prizes.join(', ') : ''
    });
  };
  useEffect(()=>{ load(); },[]);

  useEffect(()=>{
    const loadScores = async () => {
      if (!config?.challengeTypeId || !config?.challengeTrackId) { setScorecards([]); return; }

      const typeName = types.find(t => t.id === config.challengeTypeId)?.name || config.challengeTypeId;
      const trackName = tracks.find(t => t.id === config.challengeTrackId)?.name || config.challengeTrackId;

      if (!typeName || !trackName) { setScorecards([]); return; }

      try {
        const { data } = await axios.get('/api/refdata/scorecards', {
          params: {
            challengeType: typeName,
            challengeTrack: trackName.toUpperCase()
          }
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
      } catch (err) {
        console.error('Failed to load scorecards', err);
        setScorecards([]);
      }
    };
    loadScores();
  }, [config?.challengeTypeId, config?.challengeTrackId, types, tracks]);

  if (!config) return <div className="card">Loading...</div>;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    await axios.post('/api/config', config);
    onSaved();
  };

  const update = (key: string, val: any) => setConfig((c:any)=>({ ...c, [key]: val }));
  const updateHandleList = (key: 'reviewers' | 'submitters', val: string) => {
    setListInputs(prev => ({ ...prev, [key]: val }));
    update(key, val.split(',').map(x=>x.trim()).filter(Boolean));
  };

  const updatePrizes = (val: string) => {
    setListInputs(prev => ({ ...prev, prizes: val }));
    const entries = val
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
      .map(x => Number(x));
    update('prizes', entries.filter(n => !Number.isNaN(n)));
  };

  return (
    <form className="card" onSubmit={save}>
      <h3>Edit Configuration</h3>
      <div className="row">
        <div className="col">
          <label>Challenge name prefix</label>
          <input value={config.challengeNamePrefix} onChange={e=>update('challengeNamePrefix', e.target.value)} />
        </div>
        <div className="col">
          <label>Project ID</label>
          <input type="number" value={config.projectId} onChange={e=>update('projectId', Number(e.target.value))} />
        </div>
      </div>

      <div className="row">
        <div className="col">
          <label>Challenge type</label>
          <select value={config.challengeTypeId} onChange={e=>update('challengeTypeId', e.target.value)}>
            <option value="">-- Select --</option>
            {types.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="col">
          <label>Challenge track</label>
          <select value={config.challengeTrackId} onChange={e=>update('challengeTrackId', e.target.value)}>
            <option value="">-- Select --</option>
            {tracks.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      </div>

      <div className="row">
        <div className="col">
          <label>Scorecard</label>
          <select value={config.scorecardId} onChange={e=>update('scorecardId', e.target.value)}>
            <option value="">-- Select --</option>
            {scorecards.map((s:any)=><option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="col">
          <label>Submissions per submitter</label>
          <input type="number" min={1} value={config.submissionsPerSubmitter} onChange={e=>update('submissionsPerSubmitter', Number(e.target.value))} />
        </div>
      </div>

      <div className="row">
        <div className="col">
          <label>Copilot handle</label>
          <input value={config.copilotHandle} onChange={e=>update('copilotHandle', e.target.value)} />
        </div>
        <div className="col">
          <label>Reviewers (comma-separated handles)</label>
          <input value={listInputs.reviewers} onChange={e=>updateHandleList('reviewers', e.target.value)} />
        </div>
      </div>

      <div className="row">
        <div className="col">
          <label>Submitters (comma-separated handles)</label>
          <input value={listInputs.submitters} onChange={e=>updateHandleList('submitters', e.target.value)} />
        </div>
        <div className="col">
          <label>Prizes (1st, 2nd, 3rd)</label>
          <input value={listInputs.prizes} onChange={e=>updatePrizes(e.target.value)} />
        </div>
      </div>

      <div style={{marginTop:12, display:'flex', gap:8}}>
        <button type="submit">Save</button>
        <span className="pill">Remember to create <code>server/secrets/m2m.json</code> from the sample</span>
      </div>
    </form>
  )
}
