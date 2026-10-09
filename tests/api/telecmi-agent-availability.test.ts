import { describe, expect, it } from 'vitest';
import {
  availableTelecmiAgents,
  telecmiAgentManagementList,
} from '../../supabase/functions/_shared/telecmi-agent-availability';

const agents = [
  { agentId: '101_33338826', name: 'Linked', extension: 101, phone: '919876543210' },
  { agentId: '102_33338826', name: 'Same mobile', extension: 102, phone: '9876543211' },
  { agentId: '103_33338826', name: 'Available', extension: 103, phone: '9876543212' },
  { agentId: '104_33338826', name: 'No mobile', extension: 104, phone: null },
  { agentId: '105_99999999', name: 'Wrong app', extension: 105, phone: '9876543213' },
];

describe('TeleCMI agent availability', () => {
  it('shows all agents for management with usage and assignment eligibility, without provider passwords', () => {
    const providerAgents = [...agents, { ...agents[2], password: 'private-softphone' }];
    const result = telecmiAgentManagementList(
      providerAgents,
      [{ user_id: '101_33338826', phone: '919876543210' }],
      33338826,
    );
    expect(result.map((agent) => [agent.agent_id, agent.in_use, agent.assignable])).toEqual([
      ['101_33338826', true, false],
      ['102_33338826', false, true],
      ['103_33338826', false, true],
      ['104_33338826', false, false],
    ]);
    expect(JSON.stringify(result)).not.toContain('private-softphone');
  });
  it('excludes an agent reserved by ID or normalized mobile', () => {
    const result = availableTelecmiAgents(
      agents,
      [
        { user_id: '101_33338826', phone: '919000000000' },
        { user_id: '200_33338826', phone: '+91 98765 43211' },
      ],
      33338826,
    );
    expect(result).toEqual([
      { agent_id: '103_33338826', name: 'Available', extension: 103, phone: '919876543212' },
    ]);
  });

  it('only returns dialable agents from the requested app once', () => {
    const result = availableTelecmiAgents([...agents, agents[2]], [], 33338826);
    expect(result.map((agent) => agent.agent_id)).toEqual([
      '101_33338826',
      '102_33338826',
      '103_33338826',
    ]);
  });
});
