/**
 * Forma de una corrida guardada. Todo lo que muestra la interfaz sale de aquí,
 * y todo lo que hay aquí sale de procesos reales (Concord, git, node --test).
 */
import type { ToolCallRecord } from '../concord/session.ts';

export type LaneId = 'control' | 'concord';
export type ActorId = 'caja' | 'reparto' | 'revision' | 'relevo';
export type Phase = 'sin-coordinar' | 'reclamar' | 'hablar' | 'turnos' | 'caida' | 'cierre';

export interface TestCase {
  readonly name: string;
  readonly ok: boolean;
  /** Primeras líneas del error, si falló. */
  readonly reason: string | null;
}

export interface TestResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly passed: number;
  readonly failed: number;
  readonly cases: readonly TestCase[];
  readonly durationMs: number;
}

export interface GuardResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
}

export interface Step {
  readonly n: number;
  readonly lane: LaneId;
  readonly phase: Phase;
  readonly actor: ActorId;
  readonly kind: 'concord' | 'guard' | 'edit' | 'tests' | 'session' | 'read';
  /** Frase corta para la línea de tiempo. */
  readonly title: string;
  /** Detalle legible (una o dos frases). */
  readonly detail: string;
  readonly ok: boolean;
  readonly at: string;
  readonly call?: ToolCallRecord;
  readonly guard?: GuardResult;
  readonly tests?: TestResult;
  readonly diff?: string;
}

export interface LaneOutcome {
  readonly tests: TestResult | null;
  /** Diff final de `src/totales.js` contra la versión inicial. */
  readonly diff: string;
  /** Arreglos que algún actor escribió y que no sobrevivieron. */
  readonly lostFixes: readonly string[];
}

export interface Check {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface Artifacts {
  readonly handoffMd: string | null;
  readonly reviewPacketMd: string | null;
  readonly workStateSummary: string | null;
  readonly eventsCount: number;
}

export interface Isolation {
  /** Líneas RELEVO_NETWORK_BLOCKED que emitieron los procesos de Concord. */
  readonly networkAttempts: readonly string[];
  /** Archivos que quedaron dentro del HOME falso (debería ser casi nada). */
  readonly homeFiles: readonly string[];
  readonly concordProcesses: number;
}

export type RunStatus = 'running' | 'done' | 'failed';

export interface RunRecord {
  readonly schema: 1;
  readonly id: string;
  readonly source: 'live' | 'capture';
  status: RunStatus;
  readonly startedAt: string;
  finishedAt: string | null;
  readonly environment: {
    readonly concordVersion: string;
    readonly node: string;
    readonly platform: string;
  };
  readonly steps: Step[];
  lanes: Partial<Record<LaneId, LaneOutcome>>;
  checks: Check[];
  artifacts: Artifacts | null;
  isolation: Isolation | null;
  error: string | null;
}
