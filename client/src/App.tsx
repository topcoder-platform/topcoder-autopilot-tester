
import React, { useEffect, useState } from 'react'
import axios from 'axios'
import ConfigTable from './components/ConfigTable'
import ConfigForm from './components/ConfigForm'
import Runner from './components/Runner'

export default function App() {
  const [config, setConfig] = useState<any>(null);
  const [view, setView] = useState<'home'|'edit'|'runFull'|'runToStep'>('home');
  const [toStep, setToStep] = useState<string>('activate');

  const loadConfig = async () => {
    const { data } = await axios.get('/api/config');
    setConfig(data);
  };
  useEffect(()=>{ loadConfig() }, []);

  if (!config) return <div className="container"><div className="card">Loading...</div></div>;

  const showRunner = view === 'runFull' || view === 'runToStep';
  const runSteps = ['token','createChallenge','updateDraft','activate','awaitRegSubOpen','assignResources','createSubmissions','awaitReviewOpen','createReviews','awaitAppealsOpen','createAppeals','awaitAppealsResponseOpen','appealResponses','awaitAllClosed','awaitCompletion'];

  return (
    <>
      <div className="full-bleed" style={{ marginBottom: 16 }}>
        <ConfigTable config={config} />
      </div>

      <div className="full-bleed" style={{ marginBottom: 16 }}>
        <div className="row">
          <div className="col">
            <div className="card">
              <h3>Actions</h3>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => setView('runFull')}>Run the full flow</button>
                <button onClick={() => setView('runToStep')}>Run to a specific step</button>
                <button className="secondary" onClick={() => setView('edit')}>Edit configuration</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {view === 'edit' && (
        <div className="container" style={{ marginBottom: 16 }}>
          <ConfigForm onSaved={() => { loadConfig(); setView('home'); }} />
        </div>
      )}

      {view === 'runToStep' && (
        <div className="container" style={{ marginBottom: 16 }}>
          <div className="card">
            <label>Step</label>
            <select
              value={toStep}
              onChange={e => setToStep(e.target.value)}
              style={{ maxWidth: 400, marginBottom: 12 }}
            >
              {runSteps.map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {showRunner && (
        <div className="full-bleed" style={{ marginBottom: 16 }}>
          <Runner mode={view === 'runFull' ? 'full' : 'toStep'} toStep={view === 'runToStep' ? toStep : undefined} />
        </div>
      )}
    </>
  )
}
