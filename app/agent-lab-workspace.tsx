"use client";

import {
  CheckCircle,
  Crosshair,
  Key,
  Play,
  Robot,
  ShieldCheck,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import {
  controlPlaneFetch,
  type ControlPlaneEndpoint,
} from "./control-plane-endpoint";

type Device = { id: string; connected: boolean };
type Config = {
  configured: boolean;
  source: "environment" | "local-file" | null;
  model: string;
  plannerModel: string;
  mode: "agent";
};
type AgentAction = {
  type: string;
  appName?: string;
  target?: string;
  text?: string;
  key?: string;
  durationMs?: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
};
type AgentTask = {
  id: string;
  deviceId: string;
  goal: string;
  status: "running" | "succeeded" | "blocked" | "failed" | "stopped";
  createdAt: number;
  updatedAt: number;
  model: string;
  maxSteps: number;
  budgetUsd: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  summary: string;
  error: string;
  steps: Array<{
    index: number;
    at: number;
    summary: string;
    action: AgentAction;
    outcome: string;
    latencyMs: number;
    cost: number;
    locator?: {
      model: string;
      provider: string;
      target: string;
      visibleProbability: number;
      confidence: number;
      plannerAgreement: boolean;
      qualifiedBy: "jev" | "planner+jev" | null;
      latencyMs: number;
      cost: number;
    };
  }>;
};
type LocateResult = {
  mode: "shadow";
  target: string;
  frameSequence: number;
  image: { dataUrl: string; width: number; height: number };
  result: {
    model: string;
    provider: string;
    visibleProbability: number;
    confidence: number;
    box: { top: number; bottom: number; left: number; right: number };
    usage: { inputTokens: number; outputTokens: number; cost: number };
  };
  policy: { safeToAct: boolean; executed: false; reason: string };
  latencyMs: number;
};

function actionLabel(action: AgentAction) {
  if (action.type === "input_text") return `Input complete text (${action.text?.length ?? 0} characters)`;
  if (action.type === "open_app") return `Open ${action.appName}`;
  if (action.type === "tap_text") return `Tap “${action.target}”`;
  if (action.type === "tap") return `Tap ${action.target || "visual target"}`;
  if (action.type === "long_press") return `Long press ${action.target || "visual target"} (${action.durationMs ?? 0} ms)`;
  if (action.type === "swipe") return `Swipe ${action.target || "screen"}`;
  if (action.type === "phone_key") return `Phone key: ${action.key}`;
  if (action.type === "wait") return `Wait ${action.durationMs} ms`;
  return "Verify completion";
}

function taskStage(task: AgentTask) {
  if (task.status === "succeeded") return "Complete";
  if (task.status === "blocked" || task.status === "failed" || task.status === "stopped") return "Needs attention";
  const latest = task.steps.at(-1);
  if (!latest) return "Observing";
  if (latest.action.type === "input_text") return "Composing";
  if (/send|deliver|verify/iu.test(`${latest.summary} ${latest.action.target ?? ""}`)) return "Verifying";
  if (["open_app", "tap", "tap_text", "long_press", "swipe", "phone_key"].includes(latest.action.type)) return "Navigating";
  return "Reasoning";
}

function elapsedLabel(task: AgentTask) {
  const seconds = Math.max(0, Math.round((task.updatedAt - task.createdAt) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function AgentLabWorkspace({ endpoint, devices }: {
  endpoint: ControlPlaneEndpoint;
  devices: Device[];
}) {
  const [config, setConfig] = useState<Config | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [goal, setGoal] = useState("Tell Alex I will be ten minutes late");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [target, setTarget] = useState("Weather app icon");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [located, setLocated] = useState<LocateResult | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const response = await controlPlaneFetch(endpoint, "/api/v1/admin/agent-lab/config", { cache: "no-store" });
      const payload = await response.json() as Config & { error?: string };
      if (!response.ok) throw new Error(payload.error || `Agent Lab unavailable (${response.status})`);
      setConfig(payload);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Agent Lab unavailable");
    }
  }, [endpoint]);

  const loadTasks = useCallback(async () => {
    try {
      const response = await controlPlaneFetch(endpoint, "/api/v1/admin/agent-lab/tasks", { cache: "no-store" });
      const payload = await response.json() as { tasks?: AgentTask[]; error?: string };
      if (!response.ok) throw new Error(payload.error || `Could not load tasks (${response.status})`);
      setTasks(payload.tasks ?? []);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not load Agent tasks");
    }
  }, [endpoint]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConfig();
      void loadTasks();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadConfig, loadTasks]);

  useEffect(() => {
    if (!tasks.some((task) => task.status === "running")) return;
    const timer = window.setInterval(() => void loadTasks(), 900);
    return () => window.clearInterval(timer);
  }, [loadTasks, tasks]);

  const selectedDeviceId = deviceId || devices.find((device) => device.connected)?.id || "";

  const saveKey = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("key");
    setError("");
    try {
      const response = await controlPlaneFetch(endpoint, "/api/v1/admin/agent-lab/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const payload = await response.json() as Config & { error?: string };
      if (!response.ok) throw new Error(payload.error || `Could not save key (${response.status})`);
      setConfig(payload);
      setApiKey("");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not save OpenRouter key");
    } finally {
      setBusy("");
    }
  };

  const startTask = async () => {
    if (!selectedDeviceId || !goal.trim()) return;
    const confirmed = window.confirm(
      "Confirm the robot workspace is clear, the phone is safely positioned, and this task explicitly authorizes any message, post, or other external effect it requests.",
    );
    if (!confirmed) return;
    setBusy("task");
    setError("");
    try {
      const response = await controlPlaneFetch(endpoint, "/api/v1/admin/agent-lab/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: selectedDeviceId, goal: goal.trim(), confirmed: true }),
      });
      const payload = await response.json() as { task?: AgentTask; error?: string };
      if (!response.ok) throw new Error(payload.error || `Could not start task (${response.status})`);
      if (payload.task) setTasks((current) => [payload.task!, ...current.filter((task) => task.id !== payload.task!.id)]);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not start Agent task");
    } finally {
      setBusy("");
    }
  };

  const stopTask = async (taskId: string) => {
    setError("");
    try {
      const response = await controlPlaneFetch(endpoint, `/api/v1/admin/agent-lab/tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST" });
      const payload = await response.json() as { task?: AgentTask; error?: string };
      if (!response.ok) throw new Error(payload.error || `Could not stop task (${response.status})`);
      if (payload.task) setTasks((current) => current.map((task) => task.id === taskId ? payload.task! : task));
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not stop Agent task");
    }
  };

  const locate = async () => {
    if (!selectedDeviceId || !target.trim()) return;
    setBusy("locate");
    setError("");
    setLocated(null);
    try {
      const response = await controlPlaneFetch(endpoint, "/api/v1/admin/agent-lab/locate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: selectedDeviceId, target: target.trim() }),
      });
      const payload = await response.json() as LocateResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || `Jev request failed (${response.status})`);
      setLocated(payload);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Jev request failed");
    } finally {
      setBusy("");
    }
  };

  const latestTask = tasks[0] ?? null;
  const box = located?.result.box;
  return (
    <div className="platform-view agent-lab-view">
      <section className="platform-hero agent-lab-hero">
        <div>
          <span className="platform-eyebrow"><Robot size={16} weight="fill" /> EMBODIED AI OPERATOR</span>
          <h1>AI Operator</h1>
          <p>Describe the outcome. PhoneUse observes the real phone, reasons about its robotic body, acts safely, and verifies the result.</p>
        </div>
        <div className="agent-shadow-badge"><ShieldCheck size={17} weight="fill" />Guarded execution</div>
      </section>

      {error ? <div className="recorder-error"><WarningCircle size={18} weight="fill" />{error}</div> : null}

      <section className="recorder-card agent-task-card">
        <div className="recorder-section-heading"><div><h2>Give the phone a task</h2><p>Example: Tell Alex I will be ten minutes late</p></div><span>{config?.plannerModel || "Vision planner"}</span></div>
        <div className="agent-task-form">
          <label>Device<select value={selectedDeviceId} onChange={(event) => setDeviceId(event.target.value)}>{devices.filter((device) => device.connected).map((device) => <option key={device.id} value={device.id}>{device.id}</option>)}</select></label>
          <label>Complete task<textarea value={goal} maxLength={500} rows={3} onChange={(event) => setGoal(event.target.value)} placeholder="Tell the Agent what result you want" /></label>
          <button type="button" disabled={!config?.configured || !selectedDeviceId || !goal.trim() || Boolean(busy) || tasks.some((task) => task.status === "running" && task.deviceId === selectedDeviceId)} onClick={() => void startTask()}><Play size={18} weight="fill" />{busy === "task" ? "Starting…" : "Run task"}</button>
        </div>
        {!config?.configured ? <p className="agent-inline-note">Add a newly generated OpenRouter key below before running the first paid request.</p> : <p className="agent-safety-note"><ShieldCheck size={15} />Before every run, the station asks you to confirm the physical workspace and the task’s external effects.</p>}
      </section>

      <section className="recorder-card agent-task-status">
        <div className="recorder-section-heading"><div><h2>Task execution</h2><p>Each row is one model decision followed by a confirmed hardware receipt.</p></div>{latestTask ? <span className={`agent-status ${latestTask.status}`}>{latestTask.status}</span> : <span>No task yet</span>}</div>
        {latestTask ? <>
          <div className="agent-task-summary">
            <div><strong>{latestTask.goal}</strong><p>{latestTask.error || latestTask.summary}</p></div>
            <dl className="agent-metadata">
              <div><dt>Steps</dt><dd>{latestTask.steps.length} / {latestTask.maxSteps}</dd></div>
              <div><dt>Phase</dt><dd>{taskStage(latestTask)}</dd></div>
              <div><dt>Elapsed</dt><dd>{elapsedLabel(latestTask)}</dd></div>
              <div><dt>Cost</dt><dd>${latestTask.costUsd.toFixed(5)} / ${latestTask.budgetUsd.toFixed(2)}</dd></div>
            </dl>
            {latestTask.status === "running" ? <button className="agent-stop" type="button" onClick={() => void stopTask(latestTask.id)}><Stop size={16} weight="fill" />Stop after current action</button> : null}
          </div>
          <ol className="agent-task-steps">
            {latestTask.steps.map((step) => <li key={`${latestTask.id}-${step.index}`}>
              <b>{step.index}</b>
              <div><strong>{actionLabel(step.action)}</strong><span>{step.summary}</span><span>{step.outcome}</span>{step.locator ? <em>Jev: visible {Math.round(step.locator.visibleProbability * 100)}% · confidence {Math.round(step.locator.confidence * 100)}% · {step.locator.qualifiedBy ? `qualified by ${step.locator.qualifiedBy}` : `planner agreement ${step.locator.plannerAgreement ? "yes" : "no"}`} · {step.locator.latencyMs.toLocaleString()} ms</em> : null}</div>
              <small>{step.latencyMs.toLocaleString()} ms</small>
            </li>)}
            {latestTask.status === "running" ? <li className="running"><b>…</b><div><strong>Observing the latest frame</strong><span>{latestTask.summary}</span></div></li> : null}
          </ol>
        </> : <div className="agent-empty"><Robot size={34} /><strong>Ready for an end-to-end task</strong><p>The planner understands the goal and its robotic body, Jev qualifies visual targets, and every physical action is verified.</p></div>}
      </section>

      <div className="agent-lab-grid">
        <section className="recorder-card agent-config-card">
          <div className="recorder-section-heading"><div><h2>OpenRouter</h2><p>The key stays on this Mac and is never returned to the browser.</p></div>{config?.configured ? <span><CheckCircle size={15} weight="fill" />Connected</span> : <span>Not configured</span>}</div>
          <dl className="agent-metadata">
            <div><dt>Planner</dt><dd>{config?.plannerModel || "openai/gpt-6.1-sol"}</dd></div>
            <div><dt>Locator</dt><dd>{config?.model || "typesafe/jev-1.14"}</dd></div>
            <div><dt>Credential</dt><dd>{config?.configured ? config.source === "environment" ? "Environment" : "Local secret file" : "Missing"}</dd></div>
          </dl>
          <form className="agent-key-form" onSubmit={(event) => void saveKey(event)}>
            <input type="text" name="username" autoComplete="username" value="openrouter" readOnly hidden />
            <label>New OpenRouter key<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-or-v1-…" /></label>
            <button type="submit" disabled={busy === "key" || !apiKey.trim()}><Key size={16} />{busy === "key" ? "Verifying…" : "Verify & save locally"}</button>
          </form>
          <small>Use a newly generated key. Revoke any credential that has appeared in chat, screenshots, or logs.</small>
        </section>

        <section className="recorder-card agent-run-card">
          <div className="recorder-section-heading"><div><h2>Jev locator diagnostic</h2><p>Test one visual target without forwarding any coordinates to the arm.</p></div><span><Crosshair size={15} />Shadow only</span></div>
          <div className="agent-run-form">
            <label>Device<select value={selectedDeviceId} onChange={(event) => setDeviceId(event.target.value)}>{devices.filter((device) => device.connected).map((device) => <option key={device.id} value={device.id}>{device.id}</option>)}</select></label>
            <label>Visible target<input value={target} maxLength={120} onChange={(event) => setTarget(event.target.value)} placeholder="Weather app icon" /></label>
            <button type="button" disabled={!config?.configured || !selectedDeviceId || !target.trim() || Boolean(busy)} onClick={() => void locate()}><Crosshair size={17} />{busy === "locate" ? "Locating…" : "Run shadow test"}</button>
          </div>
        </section>
      </div>

      <section className="recorder-card agent-result-card">
        <div className="recorder-section-heading"><div><h2>Locator result</h2><p>The green box is Jev’s prediction. This diagnostic never clicks.</p></div>{located ? <span>Frame {located.frameSequence}</span> : <span>No run yet</span>}</div>
        {located ? <div className="agent-result-grid">
          <div className="agent-frame" style={{ aspectRatio: `${located.image.width} / ${located.image.height}` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={located.image.dataUrl} alt="Rectified phone screenshot used by Jev" />
            {box ? <span className="agent-box" style={{ left: `${box.left * 100}%`, top: `${box.top * 100}%`, width: `${(box.right - box.left) * 100}%`, height: `${(box.bottom - box.top) * 100}%` }}><b>{located.target}</b></span> : null}
          </div>
          <div className="agent-result-metrics">
            <div className={located.policy.safeToAct ? "pass" : "blocked"}><strong>{located.policy.safeToAct ? "Qualified" : "Blocked"}</strong><span>{located.policy.reason}</span></div>
            <dl className="agent-metadata">
              <div><dt>Visible</dt><dd>{Math.round(located.result.visibleProbability * 100)}%</dd></div>
              <div><dt>Box confidence</dt><dd>{Math.round(located.result.confidence * 100)}%</dd></div>
              <div><dt>Latency</dt><dd>{located.latencyMs} ms</dd></div>
              <div><dt>Input tokens</dt><dd>{located.result.usage.inputTokens.toLocaleString()}</dd></div>
              <div><dt>Cost</dt><dd>${located.result.usage.cost.toFixed(8)}</dd></div>
              <div><dt>Provider</dt><dd>{located.result.provider}</dd></div>
            </dl>
          </div>
        </div> : <div className="agent-empty"><Crosshair size={34} /><strong>No locator diagnostic yet</strong><p>This optional tool helps compare Jev’s speed and accuracy separately from the complete Agent.</p></div>}
      </section>
    </div>
  );
}
