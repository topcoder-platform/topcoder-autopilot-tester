import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import ConfigTable from './components/ConfigTable'
import ConfigForm from './components/ConfigForm'
import Runner from './components/Runner'
import type { AppConfig, FlowVariant } from './types'
import { FLOW_DEFINITIONS, ORDERED_FLOW_KEYS } from './flows'

type ViewState = 'home' | 'edit' | 'runFull' | 'runToStep'

const initialViewState = ORDERED_FLOW_KEYS.reduce<Record<FlowVariant, ViewState>>((acc, key) => {
  acc[key] = 'home'
  return acc
}, {} as Record<FlowVariant, ViewState>)

const initialToStepState = ORDERED_FLOW_KEYS.reduce<Record<FlowVariant, string>>((acc, key) => {
  acc[key] = FLOW_DEFINITIONS[key].defaultToStep
  return acc
}, {} as Record<FlowVariant, string>)

function getFlowConfig(config: AppConfig, flow: FlowVariant) {
  switch (flow) {
    case 'full':
      return config.fullChallenge
    case 'design':
      return config.designChallenge
    case 'first2finish':
      return config.first2finish
    case 'topgear':
      return config.topgear
    default:
      return config.fullChallenge
  }
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [views, setViews] = useState<Record<FlowVariant, ViewState>>(initialViewState)
  const [toStepState, setToStepState] = useState<Record<FlowVariant, string>>(initialToStepState)
  const [activeFlow, setActiveFlow] = useState<FlowVariant>('full')

  const loadConfig = async () => {
    const { data } = await axios.get<AppConfig>('/api/config')
    setConfig(data)
  }

  useEffect(() => {
    loadConfig()
  }, [])

  const currentView = views[activeFlow]
  const flowDefinition = FLOW_DEFINITIONS[activeFlow]
  const runSteps = flowDefinition.steps
  const currentToStep = toStepState[activeFlow]

  const flowConfig = useMemo(() => (config ? getFlowConfig(config, activeFlow) : null), [config, activeFlow])
  const showRunner = currentView === 'runFull' || currentView === 'runToStep'

  useEffect(() => {
    const root = document.documentElement
    if (!root) return
    let primary = '#2563eb'
    let primaryStrong = '#1d4ed8'
    if (activeFlow === 'first2finish') {
      primary = '#047857'
      primaryStrong = '#065f46'
    } else if (activeFlow === 'topgear') {
      primary = '#7c3aed'
      primaryStrong = '#5b21b6'
    } else if (activeFlow === 'topgearLate') {
      primary = '#dc2626'
      primaryStrong = '#b91c1c'
    } else if (activeFlow === 'design') {
      primary = '#ea580c'
      primaryStrong = '#c2410c'
    }
    root.style.setProperty('--primary-color', primary)
    root.style.setProperty('--primary-color-strong', primaryStrong)
    return () => {
      root.style.setProperty('--primary-color', '#2563eb')
      root.style.setProperty('--primary-color-strong', '#1d4ed8')
    }
  }, [activeFlow])

  if (!config || !flowConfig) {
    return (
      <div className="container">
        <div className="card">Loading...</div>
      </div>
    )
  }

  const updateView = (flow: FlowVariant, next: ViewState) => {
    setViews(prev => ({ ...prev, [flow]: next }))
  }

  const handleRunFull = () => {
    updateView(activeFlow, 'runFull')
  }

  const handleRunToStep = () => {
    const hasStep = runSteps.some(step => step.id === toStepState[activeFlow])
    const nextStep = hasStep ? toStepState[activeFlow] : flowDefinition.defaultToStep
    setToStepState(prev => ({ ...prev, [activeFlow]: nextStep }))
    updateView(activeFlow, 'runToStep')
  }

  const handleConfigSaved = () => {
    loadConfig()
    updateView(activeFlow, 'home')
  }

  return (
    <>
      <div className="full-bleed" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {ORDERED_FLOW_KEYS.map(flowKey => {
            const definition = FLOW_DEFINITIONS[flowKey]
            const isActive = flowKey === activeFlow
            let palette = {
              activeBackground: '#1d4ed8',
              inactiveBackground: '#1e293b',
              activeBorder: '#1f2937',
              inactiveBorder: '#1f2937',
              activeColor: '#f8fafc',
              inactiveColor: '#cbd5f5'
            }
            if (flowKey === 'first2finish') {
              palette = {
                activeBackground: '#047857',
                inactiveBackground: '#064e3b',
                activeBorder: '#065f46',
                inactiveBorder: '#065f46',
                activeColor: '#f8fafc',
                inactiveColor: '#bbf7d0'
              }
            } else if (flowKey === 'topgear') {
              palette = {
                activeBackground: '#7c3aed',
                inactiveBackground: '#3b0764',
                activeBorder: '#5b21b6',
                inactiveBorder: '#5b21b6',
                activeColor: '#f8fafc',
                inactiveColor: '#d8b4fe'
              }
            } else if (flowKey === 'topgearLate') {
              palette = {
                activeBackground: '#dc2626',
                inactiveBackground: '#7f1d1d',
                activeBorder: '#b91c1c',
                inactiveBorder: '#b91c1c',
                activeColor: '#f8fafc',
                inactiveColor: '#fecaca'
              }
            } else if (flowKey === 'design') {
              palette = {
                activeBackground: '#ea580c',
                inactiveBackground: '#7c2d12',
                activeBorder: '#c2410c',
                inactiveBorder: '#c2410c',
                activeColor: '#f8fafc',
                inactiveColor: '#fed7aa'
              }
            }
            return (
              <button
                type="button"
                key={flowKey}
                onClick={() => setActiveFlow(flowKey)}
                style={{
                  padding: '8px 16px',
                  borderRadius: 999,
                  border: `1px solid ${isActive ? palette.activeBorder : palette.inactiveBorder}`,
                  background: isActive ? palette.activeBackground : palette.inactiveBackground,
                  color: isActive ? palette.activeColor : palette.inactiveColor,
                  fontWeight: isActive ? 600 : 500,
                  cursor: 'pointer'
                }}
              >
                {definition.tabLabel}
              </button>
            )
          })}
        </div>
      </div>

      <div className="full-bleed" style={{ marginBottom: 16 }}>
        <ConfigTable flow={activeFlow} config={flowConfig} />
      </div>

      <div className="full-bleed" style={{ marginBottom: 16 }}>
        <div className="row">
          <div className="col">
            <div className="card">
              <h3>Actions</h3>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={handleRunFull}>Run the full flow</button>
                <button type="button" onClick={handleRunToStep}>Run to a specific step</button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => updateView(activeFlow, 'edit')}
                >
                  Edit configuration
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {currentView === 'edit' && (
        <div className="container" style={{ marginBottom: 16 }}>
          <ConfigForm flow={activeFlow} config={config} onSaved={handleConfigSaved} />
        </div>
      )}

      {currentView === 'runToStep' && (
        <div className="container" style={{ marginBottom: 16 }}>
          <div className="card">
            <label>Step</label>
            <select
              value={currentToStep}
              onChange={event => setToStepState(prev => ({ ...prev, [activeFlow]: event.target.value }))}
              style={{ maxWidth: 400, marginBottom: 12 }}
            >
              {runSteps.map(step => (
                <option key={step.id} value={step.id}>{step.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {showRunner && (
        <div className="full-bleed" style={{ marginBottom: 16 }}>
          <Runner
            flow={activeFlow}
            mode={currentView === 'runFull' ? 'full' : 'toStep'}
            toStep={currentView === 'runToStep' ? currentToStep : undefined}
          />
        </div>
      )}
    </>
  )
}
