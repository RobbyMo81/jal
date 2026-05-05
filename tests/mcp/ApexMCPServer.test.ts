import { ApexMCPServer, ApexMCPServerOptions } from '../../src/apex/mcp/ApexMCPServer';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { JALBrain } from '../../src/apex/brain/JALBrain';
import { AuditLog } from '../../src/apex/policy/AuditLog';
import { InterventionLogger } from '../../src/apex/guardian_angle/InterventionLogger';
import { EpisodicStore } from '../../src/apex/memory/EpisodicStore';
import { SnapshotCollector } from '../../src/apex/heartbeat/EnvironmentSnapshot';
import { ExecSyncShell } from '../../src/apex/heartbeat/HealthChecks';
import { Domain, InterventionRecord } from '../../src/apex/guardian_angle/types';

// Mock the external SDK classes
jest.mock('@modelcontextprotocol/sdk/server/mcp.js');
jest.mock('@modelcontextprotocol/sdk/server/stdio.js');

// Helper to capture registered tools
type RegisteredTool = {
  name: string;
  description: string;
  schema: z.ZodObject<any> | undefined;
  handler: (...args: any[]) => Promise<any>;
};
const registeredTools = new Map<string, RegisteredTool>();

// Mock McpServer to capture tool registrations
(McpServer as jest.Mock).mockImplementation(() => {
  return {
    name: 'mock-mcp-server',
    version: '1.0.0',
    tool: jest.fn((name, description, schemaOrHandler, handlerIfSchema) => {
      const schema = typeof schemaOrHandler === 'function' ? undefined : schemaOrHandler;
      const handler = typeof schemaOrHandler === 'function' ? schemaOrHandler : handlerIfSchema;
      registeredTools.set(name, { name, description, schema, handler });
    }),
    connect: jest.fn(async () => { /* no-op */ }),
    close: jest.fn(async () => { /* no-op */ }),
  };
});

// Mock StdioServerTransport
(StdioServerTransport as jest.Mock).mockImplementation(() => {
  return {
    connect: jest.fn(async () => { /* no-op */ }),
  };
});


// Mock Dependencies
const mockJALBrain = {
  getMemory: jest.fn(() => ({
    active_goal: 'Test Goal',
    provider: 'TestProvider',
    model: 'TestModel',
    session_count: 123,
  })),
} as jest.Mocked<JALBrain>;

const mockAuditLog = {
  query: jest.fn((filters) => {
    const entries = [
      { timestamp: new Date().toISOString(), level: 'info', action: 'test.action', message: 'test message' },
      // Entry for redaction test
      { timestamp: new Date().toISOString(), level: 'warn', action: 'credential.log', details: { token: 'secret123', some_other_field: 'value' } },
      { timestamp: new Date().toISOString(), level: 'error', action: 'critical.error', details: { key: 'secret_key' } },
      { timestamp: new Date(Date.now() - 1000 * 60 * 60).toISOString(), level: 'info', action: 'old.action', message: 'old message' },
    ];
    let filtered = entries.filter(e => {
      if (filters.level && e.level !== filters.level) return false;
      if (filters.action && e.action !== filters.action) return false;
      if (filters.since && new Date(e.timestamp).getTime() <= new Date(filters.since).getTime()) return false;
      return true;
    });
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return filtered.slice(0, filters.limit ?? 100);
  }),
} as jest.Mocked<AuditLog>; // Changed to jest.Mocked<AuditLog>

const mockInterventionLogger = {
  query: jest.fn((opts) => {
    const records: InterventionRecord[] = [
      {
        id: 'int-1',
        timestamp: new Date().toISOString(),
        domain: 'code_generation' as Domain,
        student_model: 'student-model-1',
        guardian_model: 'guardian-model-1',
        student_draft: 'draft1',
        guardian_feedback: 'feedback1',
        pof_index: 1,
        corrected_output: 'corrected1',
        entropy_score: 0.5,
        correction_cycles: 1,
      },
      {
        id: 'int-2',
        timestamp: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
        domain: 'reasoning' as Domain,
        student_model: 'student-model-2',
        guardian_model: 'guardian-model-2',
        student_draft: 'draft2',
        guardian_feedback: 'feedback2',
        pof_index: 2,
        corrected_output: 'corrected2',
        entropy_score: 0.7,
        correction_cycles: 2,
      },
      {
        id: 'int-3',
        timestamp: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
        domain: 'code_generation' as Domain,
        student_model: 'student-model-3',
        guardian_model: 'guardian-model-3',
        student_draft: 'draft3',
        guardian_feedback: 'feedback3',
        pof_index: 3,
        corrected_output: 'corrected3',
        entropy_score: 0.8,
        correction_cycles: 3,
      },
    ];
    let filtered = records.filter(r => {
      if (opts.domain && r.domain !== opts.domain) return false;
      if (opts.since && new Date(r.timestamp).getTime() <= new Date(opts.since).getTime()) return false;
      return true;
    });
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return filtered.slice(0, opts.limit ?? 20);
  }),
} as jest.Mocked<InterventionLogger>;

const mockEpisodicStore = {
  list: jest.fn((tag: string) => {
    if (tag === 'apex_goal_loop') {
      const items = [];
      for (let i = 0; i < 15; i++) {
        items.push({ id: `item${i}`, tag: 'apex_goal_loop', content: `Goal Loop Item ${i}`, timestamp: new Date(Date.now() - i * 1000).toISOString() });
      }
      return items;
    }
    return [];
  }),
} as jest.Mocked<EpisodicStore>;

const mockExecSyncShell = {
  exec: jest.fn((command: string, timeout: number) => {
    if (command.startsWith('ps aux')) {
      return { stdout: `USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
user       123  0.0  0.1  12345  6789 ?        Ss   May01   0:01 node /app/index.js
user       456  0.2  0.5  54321 98765 pts/0    R+   May01   0:05 bash`, stderr: '', exit_code: 0 };
    }
    if (command.startsWith('docker ps')) {
      return { stdout: `abcdef	container_name_1	Up 10 hours
123456	container_name_2	Exited (0) 2 minutes ago`, stderr: '', exit_code: 0 };
    }
    if (command.startsWith('df -k')) {
      return { stdout: `Filesystem     1K-blocks    Used Available Use% Mounted on
/dev/root       10000000 1000000 9000000  10% /
tmpfs            1000000     0   1000000   0% /dev/shm`, stderr: '', exit_code: 0 };
    }
    if (command.includes('/proc/meminfo')) {
      return { stdout: `MemAvailable:    1000000 kB
`, stderr: '', exit_code: 0 };
    }
    if (command.startsWith('ss -tn') || command.startsWith('netstat -tn')) {
      return { stdout: `State      Recv-Q Send-Q Local Address:Port               Peer Address:Port
ESTAB      0      0      127.0.0.1:45678            127.0.0.1:8080
LISTEN     0      0      0.0.0.0:22                 0.0.0.0:*`, stderr: '', exit_code: 0 };
    }
    return { stdout: '', stderr: `Unknown command: ${command}`, exit_code: 1 };
  }),
} as jest.Mocked<ExecSyncShell>;

const mockSnapshotCollector = new SnapshotCollector(mockExecSyncShell);
jest.spyOn(mockSnapshotCollector, 'collect').mockReturnValue({
  captured_at: new Date().toISOString(),
  processes: [{ pid: 123, name: 'node', cpu_percent: 0.0, mem_percent: 0.1 }], // Removed status
  containers: [{ id: 'abcdef', name: 'container_name_1', status: 'Up 10 hours' }],
  disk_mounts: [{ mount: '/', total_bytes: 10240000000, used_bytes: 1024000000, avail_bytes: 9216000000, use_percent: 10 }],
  available_memory_mb: 1000,
  network_connections: [{ proto: 'tcp', local_addr: '127.0.0.1:45678', foreign_addr: '127.0.0.1:8080', state: 'ESTAB' }],
});

const mockGetGuardianSleepStats = jest.fn(() => ({
  reasoning: { accuracy: 0.9, window: 3600, in_sleep_mode: false },
  code_generation: { accuracy: 0.7, window: 1800, in_sleep_mode: true },
}));

describe('ApexMCPServer', () => {
  let server: ApexMCPServer;
  let opts: ApexMCPServerOptions;

  beforeEach(() => {
    // Clear mocks before each test
    jest.clearAllMocks();
    registeredTools.clear();

    opts = {
      jalBrain: mockJALBrain,
      auditLog: mockAuditLog,
      interventionLogger: mockInterventionLogger,
      episodicStore: mockEpisodicStore,
      snapshotCollector: mockSnapshotCollector,
      getGuardianSleepStats: mockGetGuardianSleepStats,
    };

    server = new ApexMCPServer(opts);
  });

  it('should instantiate and register all six tools', () => {
    expect(registeredTools.size).toBe(6);
    expect(registeredTools.has('get_agent_status')).toBe(true);
    expect(registeredTools.has('query_audit_log')).toBe(true);
    expect(registeredTools.has('get_guardian_interventions')).toBe(true);
    expect(registeredTools.has('get_environment_snapshot')).toBe(true);
    expect(registeredTools.has('get_task_history')).toBe(true);
    expect(registeredTools.has('get_sleep_stats')).toBe(true);

    // Verify descriptions are present
    expect(registeredTools.get('get_agent_status')?.description).toBeDefined();
    expect(registeredTools.get('query_audit_log')?.description).toBeDefined();
    expect(registeredTools.get('get_guardian_interventions')?.description).toBeDefined();
    expect(registeredTools.get('get_environment_snapshot')?.description).toBeDefined();
    expect(registeredTools.get('get_task_history')?.description).toBeDefined();
    expect(registeredTools.get('get_sleep_stats')?.description).toBeDefined();
  });

  describe('Tool: get_agent_status', () => {
    it('should return agent status from JALBrain', async () => {
      const tool = registeredTools.get('get_agent_status');
      expect(tool).toBeDefined();
      expect(tool?.schema).toBeUndefined(); // No schema for get_agent_status

      const result = await tool?.handler();
      const expectedMemory = mockJALBrain.getMemory();

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expectedMemory, null, 2) }],
      });
      expect(mockJALBrain.getMemory).toHaveBeenCalledTimes(1);
    });
  });

  describe('Tool: query_audit_log', () => {
    it('should query audit log with default parameters', async () => {
      const tool = registeredTools.get('query_audit_log');
      expect(tool).toBeDefined();
      expect(tool?.schema).toBeInstanceOf(z.ZodObject);

      await tool?.handler({});
      expect(mockAuditLog.query).toHaveBeenCalledWith({ limit: undefined, level: undefined, action: undefined, since: undefined });
    });

    it('should query audit log with specified filters and return redacted content', async () => {
      const tool = registeredTools.get('query_audit_log');
      const filters = { level: 'info', action: 'test.action', since: new Date().toISOString(), limit: 1 };
      const result = await tool?.handler(filters);

      expect(mockAuditLog.query).toHaveBeenCalledWith(filters);
      expect(result.content[0].type).toBe('text');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveLength(1);
      expect(parsedResult[0].level).toBe('info');
      expect(parsedResult[0].action).toBe('test.action');
    });

    it('should redact credential-pattern values in audit log results', async () => {
      const tool = registeredTools.get('query_audit_log');
      const result = await tool?.handler({ level: 'warn' });
      const parsedResult = JSON.parse(result.content[0].text);

      const redactedEntry = parsedResult.find((entry: any) => entry.action === 'credential.log');
      expect(redactedEntry.details.token).toBe('[redacted]');
      expect(redactedEntry.details.some_other_field).toBe('value');
    });

    it('should redact nested credential-pattern values', async () => {
      const tool = registeredTools.get('query_audit_log');
      const result = await tool?.handler({ level: 'error' });
      const parsedResult = JSON.parse(result.content[0].text);
      
      const redactedEntry = parsedResult.find((entry: any) => entry.action === 'critical.error');
      expect(redactedEntry.details.key).toBe('[redacted]');
    });

    it('should enforce limit for audit log', async () => {
      const tool = registeredTools.get('query_audit_log');
      const result = await tool?.handler({ limit: 2 });
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveLength(2);
    });

    it('should return empty array if no logs match', async () => {
      // Temporarily mock query to return an empty array
      mockAuditLog.query.mockReturnValueOnce([]);
      const tool = registeredTools.get('query_audit_log');
      const result = await tool?.handler({ level: 'nonexistent' });
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveLength(0);
    });
  });

  describe('Tool: get_guardian_interventions', () => {
    it('should query intervention log with default parameters', async () => {
      const tool = registeredTools.get('get_guardian_interventions');
      expect(tool).toBeDefined();
      expect(tool?.schema).toBeInstanceOf(z.ZodObject);

      await tool?.handler({});
      expect(mockInterventionLogger.query).toHaveBeenCalledWith({ limit: 20, domain: undefined, since: undefined });
    });

    it('should query intervention log with specified filters', async () => {
      const tool = registeredTools.get('get_guardian_interventions');
      const filters = { domain: 'code_generation' as Domain, since: new Date().toISOString(), limit: 1 };
      const result = await tool?.handler(filters);

      expect(mockInterventionLogger.query).toHaveBeenCalledWith(filters);
      expect(result.content[0].type).toBe('text');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveLength(1);
      expect(parsedResult[0].domain).toBe('code_generation');
    });

    it('should enforce limit for intervention log', async () => {
      const tool = registeredTools.get('get_guardian_interventions');
      const result = await tool?.handler({ limit: 1 });
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveLength(1);
    });
  });

  describe('Tool: get_environment_snapshot', () => {
    it('should return environment snapshot', async () => {
      const tool = registeredTools.get('get_environment_snapshot');
      expect(tool).toBeDefined();
      expect(tool?.schema).toBeUndefined();

      const result = await tool?.handler();
      expect(mockSnapshotCollector.collect).toHaveBeenCalledTimes(1);
      expect(result.content[0].type).toBe('text');
      const parsedResult = JSON.parse(result.content[0].text);

      expect(parsedResult.processes[0]).not.toHaveProperty('status'); // Status should be stripped
      expect(parsedResult.processes[0].name).toBe('node');
      expect(parsedResult.containers).toHaveLength(1);
      expect(parsedResult.disk_mounts).toHaveLength(1);
      expect(parsedResult.available_memory_mb).toBe(1000);
      expect(parsedResult.network_connections).toHaveLength(1);
    });
  });

  describe('Tool: get_task_history', () => {
    it('should return task history with default limit', async () => {
      const tool = registeredTools.get('get_task_history');
      expect(tool).toBeDefined();
      expect(tool?.schema).toBeInstanceOf(z.ZodObject);

      const result = await tool?.handler({});
      expect(mockEpisodicStore.list).toHaveBeenCalledWith('apex_goal_loop');
      expect(result.content[0].type).toBe('text');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveLength(10); // Default limit is 10
      expect(parsedResult[0].id).toBe('item14'); // Newest first
    });

    it('should return task history with specified limit', async () => {
      const tool = registeredTools.get('get_task_history');
      const result = await tool?.handler({ limit: 5 });
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveLength(5);
      expect(parsedResult[0].id).toBe('item14'); // Newest first
    });
  });

  describe('Tool: get_sleep_stats', () => {
    it('should return guardian sleep statistics', async () => {
      const tool = registeredTools.get('get_sleep_stats');
      expect(tool).toBeDefined();
      expect(tool?.schema).toBeUndefined();

      const result = await tool?.handler();
      expect(mockGetGuardianSleepStats).toHaveBeenCalledTimes(1);
      expect(result.content[0].type).toBe('text');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toEqual(mockGetGuardianSleepStats());
    });

    it('should return empty object if getGuardianSleepStats is not provided', async () => {
      const serverWithoutSleepStats = new ApexMCPServer({ ...opts, getGuardianSleepStats: undefined });
      const tool = registeredTools.get('get_sleep_stats'); // Assuming tools are re-registered if server is re-instantiated
      
      // Need to re-capture tools for this new server instance
      const newRegisteredTools = new Map<string, RegisteredTool>();
      (McpServer as jest.Mock).mockImplementationOnce(() => {
        return {
          name: 'mock-mcp-server',
          version: '1.0.0',
          tool: jest.fn((name, description, schemaOrHandler, handlerIfSchema) => {
            const schema = typeof schemaOrHandler === 'function' ? undefined : schemaOrHandler;
            const handler = typeof schemaOrHandler === 'function' ? schemaOrHandler : handlerIfSchema;
            newRegisteredTools.set(name, { name, description, schema, handler });
          }),
          connect: jest.fn(async () => { /* no-op */ }),
          close: jest.fn(async () => { /* no-op */ }),
        };
      });

      // Re-instantiate to re-register tools with the new opts
      const freshServer = new ApexMCPServer({ ...opts, getGuardianSleepStats: undefined });
      const newTool = newRegisteredTools.get('get_sleep_stats');

      const result = await newTool?.handler();
      expect(result.content[0].type).toBe('text');
      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toEqual({});
    });
  });

  describe('Server Lifecycle', () => {
    it('should start and stop cleanly', async () => {
      const mcpServerMockInstance = (McpServer as jest.Mock).mock.results[0].value;
      const stdioServerTransportMockInstance = (StdioServerTransport as jest.Mock).mock.results[0].value;

      await expect(server.start()).resolves.not.toThrow();
      expect(stdioServerTransportMockInstance.connect).toHaveBeenCalledTimes(1);
      expect(mcpServerMockInstance.connect).toHaveBeenCalledWith(expect.any(StdioServerTransport));

      await expect(server.stop()).resolves.not.toThrow();
      expect(mcpServerMockInstance.close).toHaveBeenCalledTimes(1);
    });
  });
});
