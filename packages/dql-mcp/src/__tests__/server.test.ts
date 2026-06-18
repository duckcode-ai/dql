import { describe, expect, it } from 'vitest';
import { DQL_MCP_INSTRUCTIONS } from '../server.js';

describe('DQL MCP server instructions', () => {
  it('describe exact certified routing and dynamic metadata SQL for custom grains', () => {
    expect(DQL_MCP_INSTRUCTIONS).toContain('exact saved block');
    expect(DQL_MCP_INSTRUCTIONS).toContain('direct KPI');
    expect(DQL_MCP_INSTRUCTIONS).toContain('named customer/user/account');
    expect(DQL_MCP_INSTRUCTIONS).toContain('custom filters, rankings');
    expect(DQL_MCP_INSTRUCTIONS).toContain('query_via_metadata');
    expect(DQL_MCP_INSTRUCTIONS).toContain('uncertified: true');
    expect(DQL_MCP_INSTRUCTIONS).toContain('ask_dql');
    expect(DQL_MCP_INSTRUCTIONS).toContain('build_dql_app');
  });
});
