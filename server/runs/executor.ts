/**
 * Ejecuta una corrida real y la va guardando paso a paso, para que la
 * interfaz pueda mostrarla mientras ocurre. Solo una corrida a la vez.
 */
import { rmSync } from 'node:fs';

import { runScenario } from '../scenario/run-scenario.ts';
import type { RunRecord } from '../scenario/types.ts';
import type { RunStore } from './store.ts';

export class RunExecutor {
  readonly #store: RunStore;
  readonly #keepWorkspaces: boolean;
  #current: { id: string; done: Promise<RunRecord> } | null = null;

  constructor(store: RunStore, options: { keepWorkspaces?: boolean } = {}) {
    this.#store = store;
    this.#keepWorkspaces = options.keepWorkspaces ?? false;
  }

  get runningId(): string | null {
    return this.#current?.id ?? null;
  }

  /** Arranca una corrida; `undefined` si ya hay otra en curso. */
  start(): { id: string; done: Promise<RunRecord> } | undefined {
    if (this.#current !== null) return undefined;
    const id = this.#store.newId();
    const record = this.#store.create(id);
    this.#store.save(record);
    const done = this.#execute(record).finally(() => {
      this.#current = null;
    });
    this.#current = { id, done };
    return this.#current;
  }

  async #execute(record: RunRecord): Promise<RunRecord> {
    const workDir = this.#store.workDir(record.id);
    try {
      const result = await runScenario(workDir, record.id, {
        step: (step) => {
          record.steps.push(step);
          this.#store.save(record);
        },
        lane: (lane, outcome) => {
          record.lanes = { ...record.lanes, [lane]: outcome };
          this.#store.save(record);
        },
      });
      record.checks = result.checks;
      record.artifacts = result.artifacts;
      record.isolation = result.isolation;
      record.status = 'done';
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
    }
    record.finishedAt = new Date().toISOString();
    this.#store.save(record);
    if (!this.#keepWorkspaces) {
      // El JSON ya guarda todo lo que se muestra; la carpeta de trabajo sobra.
      rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
    }
    this.#store.prune();
    return record;
  }
}
