
import React from 'react'
import type { First2FinishConfig, FlowVariant, FullChallengeConfig } from '../types'

type Props = {
  flow: FlowVariant;
  config: FullChallengeConfig | First2FinishConfig;
};

export default function ConfigTable({ flow, config }: Props) {
  const entries = flow === 'full'
    ? [
        { label: 'Challenge name prefix', value: (config as FullChallengeConfig).challengeNamePrefix?.trim() || '-' },
        { label: 'Project ID', value: (config as FullChallengeConfig).projectId ?? '-' },
        { label: 'Challenge Type ID', value: (config as FullChallengeConfig).challengeTypeId ?? '-' },
        { label: 'Challenge Track ID', value: (config as FullChallengeConfig).challengeTrackId ?? '-' },
        { label: 'Timeline Template ID', value: (config as FullChallengeConfig).timelineTemplateId ?? '-' },
        { label: 'Copilot handle', value: (config as FullChallengeConfig).copilotHandle?.trim() || '-' },
        {
          label: 'Reviewers',
          value: Array.isArray((config as FullChallengeConfig).reviewers) && (config as FullChallengeConfig).reviewers.length
            ? (config as FullChallengeConfig).reviewers.join(', ')
            : '-'
        },
        {
          label: 'Submitters',
          value: Array.isArray((config as FullChallengeConfig).submitters) && (config as FullChallengeConfig).submitters.length
            ? (config as FullChallengeConfig).submitters.join(', ')
            : '-'
        },
        { label: 'Submissions per submitter', value: (config as FullChallengeConfig).submissionsPerSubmitter ?? '-' },
        { label: 'Scorecard ID', value: (config as FullChallengeConfig).scorecardId ?? '-' },
        {
          label: 'Prizes',
          value: Array.isArray((config as FullChallengeConfig).prizes) && (config as FullChallengeConfig).prizes.length
            ? (config as FullChallengeConfig).prizes.join(', ')
            : '-'
        }
      ]
    : [
        { label: 'Challenge name prefix', value: (config as First2FinishConfig).challengeNamePrefix?.trim() || '-' },
        { label: 'Project ID', value: (config as First2FinishConfig).projectId ?? '-' },
        { label: 'Challenge Type ID', value: (config as First2FinishConfig).challengeTypeId ?? '-' },
        { label: 'Challenge Track ID', value: (config as First2FinishConfig).challengeTrackId ?? '-' },
        { label: 'Timeline Template ID', value: (config as First2FinishConfig).timelineTemplateId ?? '-' },
        { label: 'Copilot handle', value: (config as First2FinishConfig).copilotHandle?.trim() || '-' },
        { label: 'Reviewer', value: (config as First2FinishConfig).reviewer?.trim() || '-' },
        {
          label: 'Submitters',
          value: Array.isArray((config as First2FinishConfig).submitters) && (config as First2FinishConfig).submitters.length
            ? (config as First2FinishConfig).submitters.join(', ')
            : '-'
        },
        { label: 'Scorecard ID', value: (config as First2FinishConfig).scorecardId ?? '-' },
        {
          label: 'Prize',
          value: typeof (config as First2FinishConfig).prize === 'number'
            ? (config as First2FinishConfig).prize
            : '-'
        }
      ];

  return (
    <div className="card">
      <h3>Current Configuration</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 12,
          marginBottom: 12
        }}
      >
        {entries.map(entry => (
          <div
            key={entry.label}
            style={{
              border: '1px solid #1e293b',
              borderRadius: 10,
              background: '#0b1220',
              padding: '8px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              minHeight: 60
            }}
          >
            <span style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4 }}>{entry.label}</span>
            <span style={{ fontSize: 14, color: '#e2e8f0', wordBreak: 'break-word' }}>{entry.value}</span>
          </div>
        ))}
      </div>
      <small className="pill">Note: M2M token generation secrets are read from <code>server/secrets/m2m.json</code></small>
    </div>
  )
}
