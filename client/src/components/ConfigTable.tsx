
import React from 'react'
import type { First2FinishConfig, FlowVariant, FullChallengeConfig, TopgearConfig } from '../types'

type Props = {
  flow: FlowVariant;
  config: FullChallengeConfig | First2FinishConfig;
};

function buildFullEntries(config: FullChallengeConfig) {
  return [
    { label: 'Challenge name prefix', value: config.challengeNamePrefix?.trim() || '-' },
    { label: 'Project ID', value: config.projectId ?? '-' },
    { label: 'Challenge Type ID', value: config.challengeTypeId ?? '-' },
    { label: 'Challenge Track ID', value: config.challengeTrackId ?? '-' },
    { label: 'Timeline Template ID', value: config.timelineTemplateId ?? '-' },
    { label: 'Copilot handle', value: config.copilotHandle?.trim() || '-' },
    {
      label: 'Reviewers',
      value: Array.isArray(config.reviewers) && config.reviewers.length
        ? config.reviewers.join(', ')
        : '-'
    },
    {
      label: 'Submitters',
      value: Array.isArray(config.submitters) && config.submitters.length
        ? config.submitters.join(', ')
        : '-'
    },
    { label: 'Submissions per submitter', value: config.submissionsPerSubmitter ?? '-' },
    { label: 'Scorecard ID', value: config.scorecardId ?? '-' },
    {
      label: 'Prizes',
      value: Array.isArray(config.prizes) && config.prizes.length
        ? config.prizes.join(', ')
        : '-'
    },
    {
      label: 'Submission zip path',
      value: config.submissionZipPath?.trim() || '-'
    }
  ];
}

function buildIterativeEntries(config: First2FinishConfig | TopgearConfig) {
  return [
    { label: 'Challenge name prefix', value: config.challengeNamePrefix?.trim() || '-' },
    { label: 'Project ID', value: config.projectId ?? '-' },
    { label: 'Challenge Type ID', value: config.challengeTypeId ?? '-' },
    { label: 'Challenge Track ID', value: config.challengeTrackId ?? '-' },
    { label: 'Timeline Template ID', value: config.timelineTemplateId ?? '-' },
    { label: 'Copilot handle', value: config.copilotHandle?.trim() || '-' },
    { label: 'Iterative Reviewer', value: config.reviewer?.trim() || '-' },
    {
      label: 'Submitters',
      value: Array.isArray(config.submitters) && config.submitters.length
        ? config.submitters.join(', ')
        : '-'
    },
    { label: 'Scorecard ID', value: config.scorecardId ?? '-' },
    {
      label: 'Prize',
      value: typeof config.prize === 'number'
        ? config.prize
        : '-'
    },
    {
      label: 'Submission zip path',
      value: config.submissionZipPath?.trim() || '-'
    }
  ];
}

export default function ConfigTable({ flow, config }: Props) {
  const entries = flow === 'full'
    ? buildFullEntries(config as FullChallengeConfig)
    : buildIterativeEntries(config as First2FinishConfig | TopgearConfig);

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
