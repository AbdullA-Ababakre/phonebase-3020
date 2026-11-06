"use client";

import {
  CheckCircle,
  Circle,
  FloppyDisk,
  Play,
  Record,
  Stop,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import {
  controlPlaneFetch,
  type ControlPlaneEndpoint,
} from "./control-plane-endpoint";

type Step = {
  id: string;
  label: string;
  action: { type: string };
  recordedAt: number;
};
type Session = {
  id: string;
  deviceId: string;
  name: string;
  startedAt: number;
  steps: Step[];
};
type Workflow = {
  id: string;
  deviceId: string;
  name: string;
  createdAt: number;
  steps: Step[];
};
type Run = {
  id: string;
  workflowId: string;
  status: "running" | "succeeded" | "failed";
  stepIndex: number;
  stepLabel: string;
  startedAt: number;
  endedAt: number | null;
  error: string;
};
type Snapshot = {
  sessions: Session[];
  workflows: Workflow[];
  runs: Run[];
};
type Device = { id: string; connected: boolean };

const empty: Snapshot = { sessions: [], workflows: [], runs: [] };

export function RecorderWorkspace({
  endpoint,
  devices,
  onOpenDevices,
}: {
  endpoint: ControlPlaneEndpoint;
  devices: Device[];
  onOpenDevices: (deviceId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [deviceId, setDeviceId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await controlPlaneFetch(endpoint, "/api/v1/admin/recorder", {
        cache: "no-store",
      });
      const payload = await response.json() as Snapshot & { error?: string };
      if (!response.ok) throw new Error(payload.error || `Recorder unavailable (${response.status})`);
      setSnapshot(payload);
      setError("");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Recorder unavailable");
    }
  }, [endpoint]);

  const selectedDeviceId = deviceId || devices.find((device) => device.connected)?.id || "";

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 1_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  const mutate = async (key: string, path: string, body: Record<string, unknown> = {}) => {
    setBusy(key);
    setError("");
    try {
      const response = await controlPlaneFetch(endpoint, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || `Recorder request failed (${response.status})`);
      await load();
      return true;
    } catch (value) {
      setError(value instanceof Error ? value.message : "Recorder request failed");
      return false;
    } finally {
      setBusy("");
    }
  };

  const start = async () => {
    if (!selectedDeviceId) return;
    if (await mutate("start", "/api/v1/admin/recorder/sessions", { deviceId: selectedDeviceId, name })) {
      setName("");
      onOpenDevices(selectedDeviceId);
    }
  };

  const run = async (workflow: Workflow) => {
    if (!window.confirm(
      `Run “${workflow.name}” now? Confirm the phone is in the expected starting state and the arm workspace is clear.`,
    )) return;
    await mutate(
      `run:${workflow.id}`,
      `/api/v1/admin/recorder/workflows/${encodeURIComponent(workflow.id)}/run`,
      { confirmed: true },
    );
  };

  return (
    <div className="platform-view recorder-view">
      <section className="platform-hero recorder-hero">
        <div>
          <span className="platform-eyebrow"><Record size={15} weight="fill" /> LOCAL AUTOMATION</span>
          <h1>Recorder</h1>
          <p>Record browser-controlled phone actions once, then replay the same normalized steps without an AI model.</p>
        </div>
        <div className={`recorder-live-badge ${snapshot.sessions.length ? "active" : ""}`}>
          <Circle size={12} weight="fill" />
          {snapshot.sessions.length ? `${snapshot.sessions.length} recording` : "Recorder idle"}
        </div>
      </section>

      {error ? <div className="recorder-error"><WarningCircle size={18} weight="fill" />{error}</div> : null}

      <section className="recorder-card recorder-start">
        <div>
          <h2>New recording</h2>
          <p>Start here, return to Devices, enable control, and operate the phone normally. Hover previews and safety controls are never recorded.</p>
        </div>
        <div className="recorder-start-form">
          <label>Device<select value={selectedDeviceId} onChange={(event) => setDeviceId(event.target.value)}>
            {devices.filter((device) => device.connected).map((device) => <option key={device.id} value={device.id}>{device.id}</option>)}
          </select></label>
          <label>Workflow name<input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Open Weather and inspect forecast" /></label>
          <button type="button" disabled={!selectedDeviceId || Boolean(busy)} onClick={() => void start()}><Record size={17} weight="fill" />Start recording</button>
        </div>
        <small>Typed phone text is stored in the local recorder file because replay needs it. Do not record passwords or private messages.</small>
      </section>

      {snapshot.sessions.map((session) => (
        <section className="recorder-card recorder-session" key={session.id}>
          <div className="recorder-session-heading"><div><span className="recorder-pulse" /><strong>{session.name}</strong><small>{session.deviceId} · {session.steps.length} recorded steps</small></div><span>Recording now</span></div>
          <ol className="recorder-steps">{session.steps.map((step, index) => <li key={step.id}><b>{index + 1}</b><span>{step.label}</span><small>{step.action.type}</small></li>)}</ol>
          {!session.steps.length ? <p className="recorder-empty">No actions yet. Open Devices and interact with the phone.</p> : null}
          <div className="recorder-actions">
            <button type="button" onClick={() => onOpenDevices(session.deviceId)}>Open Devices</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void mutate(`discard:${session.id}`, `/api/v1/admin/recorder/sessions/${encodeURIComponent(session.id)}/discard`)}><Trash size={15} />Discard</button>
            <button className="primary" type="button" disabled={!session.steps.length || Boolean(busy)} onClick={() => void mutate(`stop:${session.id}`, `/api/v1/admin/recorder/sessions/${encodeURIComponent(session.id)}/stop`, { name: session.name })}><Stop size={15} weight="fill" />Stop &amp; save</button>
          </div>
        </section>
      ))}

      <section className="recorder-card">
        <div className="recorder-section-heading"><div><h2>Saved workflows</h2><p>Coordinates are stored relative to the calibrated screen and rebound to a fresh frame during replay.</p></div><span>{snapshot.workflows.length} saved</span></div>
        {snapshot.workflows.length ? <div className="recorder-workflows">{snapshot.workflows.map((workflow) => {
          const latest = snapshot.runs.find((runItem) => runItem.workflowId === workflow.id);
          return <article key={workflow.id}>
            <div className="recorder-workflow-top"><div><strong>{workflow.name}</strong><span>{workflow.deviceId} · {workflow.steps.length} steps</span></div>{latest ? <span className={`recorder-run-status ${latest.status}`}>{latest.status === "succeeded" ? <CheckCircle size={14} weight="fill" /> : latest.status === "running" ? <Circle size={12} weight="fill" /> : <WarningCircle size={14} weight="fill" />}{latest.status}</span> : null}</div>
            <details><summary>Recorded steps</summary><ol className="recorder-steps">{workflow.steps.map((step, index) => <li key={step.id}><b>{index + 1}</b><span>{step.label}</span><small>{step.action.type}</small></li>)}</ol></details>
            {latest?.error ? <p className="recorder-run-error">{latest.error}</p> : null}
            <div className="recorder-actions"><button type="button" disabled={Boolean(busy)} onClick={() => void mutate(`delete:${workflow.id}`, `/api/v1/admin/recorder/workflows/${encodeURIComponent(workflow.id)}/delete`)}><Trash size={15} />Delete</button><button className="primary" type="button" disabled={Boolean(busy) || latest?.status === "running"} onClick={() => void run(workflow)}><Play size={15} weight="fill" />{busy === `run:${workflow.id}` ? "Running…" : "Run workflow"}</button></div>
          </article>;
        })}</div> : <div className="recorder-empty-state"><FloppyDisk size={30} /><strong>No saved workflows</strong><p>Your first completed recording will appear here.</p></div>}
      </section>
    </div>
  );
}
