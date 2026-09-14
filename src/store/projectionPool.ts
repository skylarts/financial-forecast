import type { Scenario } from "@/domain";
import { projectScenarioWithRates, type ProjectionOptions, type TaxRatesByYear } from "@/engine/forecastScenario";
import { summarizeProjection, type StressSummary } from "@/engine/stressSummary";
import type { ProjectionReply, ProjectionRequest } from "@/workers/projection.worker";

/**
 * A small pool of projection workers with one queue in front of it. Callers
 * hand in a scenario and options and get the run's summary back; the pool
 * keeps every core but one busy and runs the rest in order.
 *
 * Jobs carry a `generation`: when the plan or the parameters change, the
 * caller bumps its generation and everything still queued from the old one
 * is dropped unrun (a run already inside a worker finishes and is ignored
 * by the caller). Without this an edit mid-analysis queued a second
 * hundred runs behind the first hundred.
 */
export interface PoolResult {
  summary: StressSummary;
  ratesByYear?: TaxRatesByYear;
}

interface Job {
  request: ProjectionRequest;
  generation: number;
  resolve: (r: PoolResult) => void;
  reject: (e: Error) => void;
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

class ProjectionPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job[] = [];
  private inFlight = new Map<number, Job>();
  private nextId = 1;
  /** Jobs from generations below this are dropped before they run. */
  private floor = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL("../workers/projection.worker.ts", import.meta.url));
      worker.onmessage = (event: MessageEvent<ProjectionReply>) => this.onReply(worker, event.data);
      worker.onerror = (event) => {
        // A crashed worker fails whatever it was running; the pool keeps going with the rest.
        for (const [id, job] of this.inFlight) {
          if (job.request.id === id) job.reject(new Error(event.message || "projection worker failed"));
        }
        this.inFlight.clear();
        this.idle.push(worker);
        this.pump();
      };
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  /** Drop every queued job from generations below `generation`. */
  cancelBefore(generation: number): void {
    this.floor = generation;
    const keep: Job[] = [];
    for (const job of this.queue) {
      if (job.generation < generation) job.reject(new CancelledError());
      else keep.push(job);
    }
    this.queue = keep;
  }

  run(scenario: Scenario, options: ProjectionOptions, generation: number, withRates = false): Promise<PoolResult> {
    return new Promise<PoolResult>((resolve, reject) => {
      if (generation < this.floor) {
        reject(new CancelledError());
        return;
      }
      this.queue.push({ request: { id: this.nextId++, scenario, options, withRates }, generation, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const job = this.queue.shift()!;
      const worker = this.idle.pop()!;
      this.inFlight.set(job.request.id, job);
      worker.postMessage(job.request);
    }
  }

  private onReply(worker: Worker, reply: ProjectionReply): void {
    const job = this.inFlight.get(reply.id);
    this.inFlight.delete(reply.id);
    this.idle.push(worker);
    if (job) {
      if ("error" in reply) job.reject(new Error(reply.error));
      else job.resolve({ summary: reply.summary, ratesByYear: reply.ratesByYear });
    }
    this.pump();
  }
}

let pool: ProjectionPool | null | undefined;

/** The shared pool, created on first use in the browser; null where workers do not exist (the server, tests). */
export function getProjectionPool(): ProjectionPool | null {
  if (pool !== undefined) return pool;
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    pool = null;
    return pool;
  }
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  pool = new ProjectionPool(Math.max(1, Math.min(4, cores - 1)));
  return pool;
}

/**
 * One projection through the pool, or inline where there is none. The
 * inline path is what tests and the server hit; it is also what the app
 * would fall back to if a browser refused the worker.
 */
export function runProjection(scenario: Scenario, options: ProjectionOptions, generation: number, withRates = false): Promise<PoolResult> {
  const p = getProjectionPool();
  if (p) return p.run(scenario, options, generation, withRates);
  return new Promise((resolve, reject) => {
    try {
      const { result, ratesByYear } = projectScenarioWithRates(scenario, options);
      resolve({ summary: summarizeProjection(result), ratesByYear: withRates ? ratesByYear : undefined });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
