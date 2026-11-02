/**
 * Una sesión MCP real contra `concord-mcp` (stdio), una por actor. Cada
 * llamada queda registrada tal cual: herramienta, argumentos, texto devuelto,
 * datos estructurados, error y duración. Eso es lo que muestra la interfaz.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  CONCORD_MCP_ENTRY,
  concordEnv,
  concordNodeArgs,
  type SandboxPaths,
} from './sandbox.ts';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ToolCallRecord {
  readonly agentId: string;
  readonly tool: string;
  readonly args: Record<string, JsonValue>;
  readonly ok: boolean;
  readonly text: string;
  readonly structured: JsonValue | null;
  readonly durationMs: number;
  readonly at: string;
}

export type CallObserver = (record: ToolCallRecord) => void;

function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  return parseJson(text);
}

function parseJson(text: string): JsonValue {
  const parsed: unknown = JSON.parse(text);
  return narrowJson(parsed);
}

function narrowJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item: unknown) => narrowJson(item));
  if (typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) out[key] = narrowJson(item);
    return out;
  }
  return null;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'type' in item &&
      item.type === 'text' &&
      'text' in item &&
      typeof item.text === 'string'
    ) {
      parts.push(item.text);
    }
  }
  return parts.join('\n');
}

export class ConcordSession {
  readonly agentId: string;
  readonly #client: Client;
  readonly #transport: StdioClientTransport;
  readonly #observer: CallObserver;
  readonly #stderr: string[] = [];
  #closed = false;

  private constructor(
    agentId: string,
    client: Client,
    transport: StdioClientTransport,
    observer: CallObserver,
  ) {
    this.agentId = agentId;
    this.#client = client;
    this.#transport = transport;
    this.#observer = observer;
  }

  /** Arranca un proceso `concord-mcp` propio para este actor y se conecta. */
  static async open(
    agentId: string,
    paths: SandboxPaths,
    runDir: string,
    observer: CallObserver,
  ): Promise<ConcordSession> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: concordNodeArgs(CONCORD_MCP_ENTRY, runDir),
      env: concordEnv(paths, agentId),
      cwd: paths.workspace,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'relevo-lab', version: '0.1.0' });
    const session = new ConcordSession(agentId, client, transport, observer);
    transport.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/u)) {
        if (line.trim() !== '') session.#stderr.push(line);
      }
    });
    await client.connect(transport);
    return session;
  }

  /** Líneas que el servidor escribió en stderr (avisos, bloqueos de red). */
  get stderrLines(): readonly string[] {
    return this.#stderr;
  }

  /** Nombres de las herramientas que anuncia el servidor. */
  async listTools(): Promise<string[]> {
    const result = await this.#client.listTools();
    return result.tools.map((tool) => tool.name);
  }

  /**
   * Llama una herramienta y devuelve el registro. Los errores de Concord
   * (`isError`) no lanzan: son resultados que la demo necesita mostrar.
   */
  async call(tool: string, args: Record<string, JsonValue>): Promise<ToolCallRecord> {
    const started = performance.now();
    const at = new Date().toISOString();
    let record: ToolCallRecord;
    try {
      const result = await this.#client.callTool({ name: tool, arguments: args });
      record = {
        agentId: this.agentId,
        tool,
        args,
        ok: result.isError !== true,
        text: textOf(result.content),
        structured: toJson(result.structuredContent),
        durationMs: Math.round(performance.now() - started),
        at,
      };
    } catch (error) {
      record = {
        agentId: this.agentId,
        tool,
        args,
        ok: false,
        text: error instanceof Error ? error.message : String(error),
        structured: null,
        durationMs: Math.round(performance.now() - started),
        at,
      };
    }
    this.#observer(record);
    return record;
  }

  /** Cierra la sesión (y su proceso). Idempotente. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#client.close();
  }

  /** Simula una sesión que se cae: mata el proceso sin despedirse. */
  crash(): void {
    const pid = this.#transport.pid;
    if (pid !== null) process.kill(pid);
    this.#closed = true;
  }
}
