import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { PhonebaseSemanticAction } from "./action-contract";

type NormalizedPoint = { x: number; y: number };

export type RecordedAction =
  | { type: "tap"; point: NormalizedPoint; durationMs?: number; touchZ?: number }
  | { type: "long_press"; point: NormalizedPoint; durationMs: number; touchZ?: number }
  | { type: "swipe"; start: NormalizedPoint; end: NormalizedPoint; durationMs: number; touchZ?: number }
  | { type: "input_text"; text: string; touchZ?: number }
  | { type: "phone_key"; key: "back" | "home" | "enter" }
  | { type: "wait"; durationMs: number };

export type RecorderStep = {
  id: string;
  label: string;
  action: RecordedAction;
  receiptId: string;
  recordedAt: number;
};

export type RecorderSession = {
  id: string;
  deviceId: string;
  name: string;
  startedAt: number;
  steps: RecorderStep[];
};

export type RecorderWorkflow = {
  id: string;
  deviceId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  steps: RecorderStep[];
};

export type RecorderRun = {
  id: string;
  workflowId: string;
  deviceId: string;
  status: "running" | "succeeded" | "failed";
  stepIndex: number;
  stepLabel: string;
  startedAt: number;
  endedAt: number | null;
  error: string;
};

type RecorderSnapshot = {
  version: 1;
  sessions: RecorderSession[];
  workflows: RecorderWorkflow[];
  runs: RecorderRun[];
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizedPoint(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): NormalizedPoint {
  return {
    x: Math.max(0, Math.min(1, point.x / viewport.width)),
    y: Math.max(0, Math.min(1, point.y / viewport.height)),
  };
}

export function recordedAction(
  action: PhonebaseSemanticAction,
): RecordedAction | null {
  if (action.type === "tap" || action.type === "long_press") {
    return {
      type: action.type,
      point: normalizedPoint(action.point, action.viewport),
      ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }),
      ...(action.touchZ === undefined ? {} : { touchZ: action.touchZ }),
    } as RecordedAction;
  }
  if (action.type === "swipe") {
    return {
      type: action.type,
      start: normalizedPoint(action.start, action.viewport),
      end: normalizedPoint(action.end, action.viewport),
      durationMs: action.durationMs,
      ...(action.touchZ === undefined ? {} : { touchZ: action.touchZ }),
    };
  }
  if (action.type === "input_text") {
    return {
      type: action.type,
      text: action.text,
      ...(action.touchZ === undefined ? {} : { touchZ: action.touchZ }),
    };
  }
  if (action.type === "phone_key") return { type: action.type, key: action.key };
  if (action.type === "wait") return { type: action.type, durationMs: action.durationMs };
  return null;
}

function stepLabel(action: RecordedAction) {
  if (action.type === "input_text") return `Input text (${action.text.length} characters)`;
  if (action.type === "phone_key") return `Phone key · ${action.key}`;
  if (action.type === "wait") return `Wait · ${action.durationMs} ms`;
  if (action.type === "swipe") return "Swipe";
  return action.type === "long_press" ? "Long press" : "Tap";
}

export class RecorderStore {
  private state: RecorderSnapshot = {
    version: 1,
    sessions: [],
    workflows: [],
    runs: [],
  };
  private writeQueue = Promise.resolve();

  constructor(private readonly path: string) {}

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<RecorderSnapshot>;
      this.state = {
        version: 1,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        workflows: Array.isArray(parsed.workflows) ? parsed.workflows : [],
        runs: Array.isArray(parsed.runs) ? parsed.runs.map((run) => run.status === "running"
          ? { ...run, status: "failed", endedAt: Date.now(), error: "Station restarted during replay." }
          : run) : [],
      };
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  snapshot() {
    return clone(this.state);
  }

  async start(deviceId: string, name: string) {
    if (this.state.sessions.some((session) => session.deviceId === deviceId)) {
      throw new Error(`A recording is already active for ${deviceId}.`);
    }
    const session: RecorderSession = {
      id: randomUUID(),
      deviceId,
      name: name.trim() || `Workflow ${new Date().toLocaleString()}`,
      startedAt: Date.now(),
      steps: [],
    };
    this.state.sessions.unshift(session);
    await this.persist();
    return clone(session);
  }

  async record(deviceId: string, action: PhonebaseSemanticAction, receiptId = "") {
    const session = this.state.sessions.find((candidate) => candidate.deviceId === deviceId);
    const normalized = recordedAction(action);
    if (!session || !normalized) return null;
    const step: RecorderStep = {
      id: randomUUID(),
      label: stepLabel(normalized),
      action: normalized,
      receiptId,
      recordedAt: Date.now(),
    };
    session.steps.push(step);
    await this.persist();
    return clone(step);
  }

  async stop(sessionId: string, name = "") {
    const index = this.state.sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) throw new Error("Recording session not found.");
    const session = this.state.sessions[index];
    if (!session.steps.length) throw new Error("Record at least one phone action before saving.");
    this.state.sessions.splice(index, 1);
    const now = Date.now();
    const workflow: RecorderWorkflow = {
      id: randomUUID(),
      deviceId: session.deviceId,
      name: name.trim() || session.name,
      createdAt: now,
      updatedAt: now,
      steps: session.steps,
    };
    this.state.workflows.unshift(workflow);
    await this.persist();
    return clone(workflow);
  }

  async discard(sessionId: string) {
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((session) => session.id !== sessionId);
    if (before === this.state.sessions.length) throw new Error("Recording session not found.");
    await this.persist();
  }

  workflow(workflowId: string) {
    return clone(this.state.workflows.find((workflow) => workflow.id === workflowId) ?? null);
  }

  async deleteWorkflow(workflowId: string) {
    const before = this.state.workflows.length;
    this.state.workflows = this.state.workflows.filter((workflow) => workflow.id !== workflowId);
    if (before === this.state.workflows.length) throw new Error("Recorded workflow not found.");
    await this.persist();
  }

  async beginRun(workflow: RecorderWorkflow) {
    const run: RecorderRun = {
      id: randomUUID(),
      workflowId: workflow.id,
      deviceId: workflow.deviceId,
      status: "running",
      stepIndex: -1,
      stepLabel: "Starting",
      startedAt: Date.now(),
      endedAt: null,
      error: "",
    };
    this.state.runs.unshift(run);
    this.state.runs = this.state.runs.slice(0, 100);
    await this.persist();
    return clone(run);
  }

  async updateRun(runId: string, update: Partial<RecorderRun>) {
    const run = this.state.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error("Recorder run not found.");
    Object.assign(run, update);
    await this.persist();
    return clone(run);
  }

  async flush() {
    await this.writeQueue;
  }

  private persist() {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writeQueue;
  }
}
