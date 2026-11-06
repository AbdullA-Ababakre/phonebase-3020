"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle,
  CircleNotch,
  Crosshair,
  DeviceMobileCamera,
  FloppyDisk,
  MapPin,
  Play,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LiveScreen, type LiveFrame, type ScreenPoint } from "../live-screen";
import { calibrationReadinessIssue } from "../../shared/calibration-readiness";
import { calibrationFrameIssue, calibrationJogIssue, calibrationMotionIssue, repeatedMachinePointIssue, type CalibrationController } from "../../shared/calibration-workflow";

const CONTROL_PLANE_URL = "http://127.0.0.1:3013";
const CORNERS = ["Top left", "Top right", "Bottom right", "Bottom left"];

type MachinePoint = { x: number; y: number };
type Draft = {
  frame: { width: number; height: number; sequence: number };
  screen: { width: number; height: number };
  imagePoints: Array<ScreenPoint | null>;
  machinePoints: Array<MachinePoint | null>;
};
type CalibrationResponse = {
  ok: boolean;
  error?: string;
  calibration?: { draft: Draft | null; active: { id: string } | null; jog?: { id: string; status: string; error?: string } };
};
type Device = {
  id: string;
  connected: boolean;
  state?: {
    appVersion?: string;
    grbl?: CalibrationController;
  };
};

export default function CalibratePage() {
  // The router can render the destination before window.location is committed.
  // Key the entire workflow so no frame, draft or confirmation crosses devices.
  const searchParams = useSearchParams();
  const deviceId = searchParams.get("deviceId")?.trim() ?? "";
  return <DeviceCalibration key={deviceId} deviceId={deviceId} />;
}

function DeviceCalibration({ deviceId }: { deviceId: string }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedCorner, setSelectedCorner] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "success" | "error"; text: string }>({ kind: "info", text: "Select a corner, record its camera point, then move the hovering stylus to that same corner and capture XY." });
  const [videoConnected, setVideoConnected] = useState(false);
  const [videoDetail, setVideoDetail] = useState("Waiting for a fresh physical camera frame.");
  const [now, setNow] = useState(() => Date.now());
  const [confirmed, setConfirmed] = useState(false);
  const [jogStep, setJogStep] = useState<0.5 | 2 | 10>(2);
  const stageRef = useRef<HTMLDivElement>(null);
  const requestActive = useRef(false);

  const device = devices.find((item) => item.id === deviceId);
  const grbl = device?.state?.grbl;

  const refresh = useCallback(async () => {
    setNow(Date.now());
    try {
      const response = await fetch(`${CONTROL_PLANE_URL}/api/v1/devices`, { cache: "no-store" });
      if (!response.ok) throw new Error("Device status is unavailable.");
      const payload = await response.json() as { devices?: Device[] };
      const next = payload.devices ?? [];
      setDevices(next);
      if (!deviceId) setNotice({ kind: "error", text: "Select a device from the Dashboard to calibrate." });
      else if (!next.some((item) => item.id === deviceId)) setNotice({ kind: "error", text: `Device ${deviceId} is unavailable. Return to the Dashboard to select a device.` });
    } catch {
      setDevices([]);
      setNotice({ kind: "error", text: "PhoneUse control plane is offline." });
    }
  }, [deviceId]);

  const loadCalibration = useCallback(async (targetId: string) => {
    if (!targetId) return;
    try {
      const response = await fetch(
        `${CONTROL_PLANE_URL}/api/v1/devices/${encodeURIComponent(targetId)}/calibration`,
        { cache: "no-store" },
      );
      const payload = await response.json() as CalibrationResponse;
      if (!response.ok) throw new Error(payload.error ?? "Unable to load calibration");
      setDraft(payload.calibration?.draft ?? null);
      setActiveId(payload.calibration?.active?.id ?? null);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Unable to load calibration" });
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = setTimeout(() => void loadCalibration(deviceId), 0);
    return () => clearTimeout(timer);
  }, [deviceId, loadCalibration]);

  const activateVideo = useCallback(async () => {
    if (!deviceId) return;
    try {
      const response = await fetch(`${CONTROL_PLANE_URL}/api/v1/admin/video-focus`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to start live video");
      setVideoDetail("Starting this device's live camera. Waiting for a fresh frame.");
    } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : "Unable to start live video" }); }
  }, [deviceId]);
  useEffect(() => {
    if (!device?.connected) return;
    const timer = setTimeout(() => void activateVideo(), 0);
    return () => clearTimeout(timer);
  }, [device?.connected, activateVideo]);

  const calibrationRequest = async (body: Record<string, unknown>) => {
    if (!device?.connected || requestActive.current) return;
    requestActive.current = true;
    setBusy(true);
    try {
      const response = await fetch(
        `${CONTROL_PLANE_URL}/api/v1/devices/${encodeURIComponent(deviceId)}/calibration`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json() as CalibrationResponse;
      if (!response.ok) throw new Error(payload.error ?? "Calibration request failed");
      if (body.operation === "jog" && payload.calibration?.jog?.status !== "completed") {
        throw new Error(payload.calibration?.jog?.error ?? "The calibration move has no confirmed completion. Observe the controller before trying another move.");
      }
      setDraft(payload.calibration?.draft ?? null);
      setActiveId(payload.calibration?.active?.id ?? null);
      const text = body.operation === "jog" ? "Controller reports the move complete. Confirm the physical stylus moved to the intended corner before capturing XY."
        : body.operation === "begin" ? "New draft started. Select Top left, record its camera point, then capture the matching machine position."
        : body.operation === "capture_image_point" ? `Camera point ${Number(body.index) + 1} recorded. Move the hovering stylus to this same corner, then capture XY.`
        : body.operation === "capture_machine_point" ? `Machine point ${Number(body.index) + 1} recorded. Select the next corner when this pair is correct.`
        : "Calibration profile activated.";
      setNotice({ kind: "success", text });
      await refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Calibration request failed" });
    } finally {
      requestActive.current = false;
      setBusy(false);
    }
  };

  const begin = () => {
    const issue = calibrationFrameIssue(frame, deviceId, videoConnected, now) ?? calibrationMotionIssue(grbl);
    if (issue) { setNotice({ kind: "error", text: issue }); return; }
    setSelectedCorner(0);
    setConfirmed(false);
    void calibrationRequest({
      operation: "begin",
      screenWidth: 720,
      screenHeight: 1560,
    });
  };

  const captureImagePoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draft || !frame || !stageRef.current) return;
    const issue = calibrationFrameIssue(frame, deviceId, videoConnected, now, draft.frame) ?? calibrationMotionIssue(grbl);
    if (issue) { setNotice({ kind: "error", text: issue }); return; }
    const rect = stageRef.current.getBoundingClientRect();
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
    const renderedWidth = frame.width * scale;
    const renderedHeight = frame.height * scale;
    const x = (event.clientX - rect.left - (rect.width - renderedWidth) / 2) / scale;
    const y = (event.clientY - rect.top - (rect.height - renderedHeight) / 2) / scale;
    if (x < 0 || x > frame.width || y < 0 || y > frame.height) return;
    setConfirmed(false);
    void calibrationRequest({
      operation: "capture_image_point",
      index: selectedCorner,
      x,
      y,
    });
  };

  const captureMachinePoint = () => {
    const issue = calibrationFrameIssue(frame, deviceId, videoConnected, now, draft?.frame)
      ?? calibrationMotionIssue(grbl)
      ?? (draft && grbl ? repeatedMachinePointIssue(draft.machinePoints, selectedCorner, grbl.x!, grbl.y!) : "Start a draft first.");
    if (issue) { setNotice({ kind: "error", text: issue }); return; }
    setConfirmed(false);
    void calibrationRequest({
      operation: "capture_machine_point",
      index: selectedCorner,
    });
  };

  const jog = (axis: "X" | "Y", distance: number) => {
    const issue = calibrationFrameIssue(frame, deviceId, videoConnected, now, draft?.frame) ?? calibrationJogIssue(grbl, axis, distance);
    if (issue) { setNotice({ kind: "error", text: issue }); return; }
    setConfirmed(false);
    void calibrationRequest({
      operation: "jog",
      axis,
      distance,
    });
  };

  const resumeMotion = async () => {
    if (!device?.connected || requestActive.current) return;
    requestActive.current = true;
    setBusy(true);
    try {
      const response = await fetch(
        `${CONTROL_PLANE_URL}/api/v1/devices/${encodeURIComponent(deviceId)}/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: `calibration-resume-${deviceId}-${Date.now()}`,
            action: { type: "resume" },
          }),
        },
      );
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to resume the controller");
      setNotice({ kind: "info", text: "Resume requested. Wait for the controller to report Idle before calibration." });
      await refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Unable to resume the controller" });
    } finally {
      requestActive.current = false;
      setBusy(false);
    }
  };

  const imagePointCount = draft?.imagePoints.filter(Boolean).length ?? 0;
  const machinePointCount = draft?.machinePoints.filter(Boolean).length ?? 0;
  const readinessIssue = draft ? calibrationReadinessIssue(draft) : null;
  const complete = Boolean(draft && !readinessIssue);
  const moving = Boolean(grbl?.activeOperation);
  const motionIssue = calibrationMotionIssue(grbl);
  const frameIssue = calibrationFrameIssue(frame, deviceId, videoConnected, now, draft?.frame);
  const blockedIssue = frameIssue ?? motionIssue;
  const jogOptions = [
    { label: "up", axis: "Y", distance: jogStep, Icon: ArrowUp },
    { label: "left", axis: "X", distance: jogStep, Icon: ArrowLeft },
    { label: "right", axis: "X", distance: -jogStep, Icon: ArrowRight },
    { label: "down", axis: "Y", distance: -jogStep, Icon: ArrowDown },
  ] as const;
  const boundaryIssues = [...new Set(jogOptions.map(option => calibrationJogIssue(grbl, option.axis, option.distance)).filter((issue): issue is string => Boolean(issue)))];
  const readinessMessage = readinessIssue ?? (
    confirmed
      ? "All four camera and machine points are valid. The profile can be activated."
      : "All four point pairs are valid. Check the physical verification box to activate."
  );

  return (
    <main className="calibration-shell">
      <header className="calibration-header">
        <Link href="/"><ArrowLeft size={18} /> Back to control</Link>
        <div>
          <span className="brand-icon"><Crosshair size={21} weight="bold" /></span>
          <div><strong>Screen calibration</strong><span>Camera pixels → physical millimetres</span></div>
        </div>
        <button type="button" onClick={() => void activateVideo()} disabled={!device?.connected}>Start live video</button>
        <span className={`status-pill ${activeId ? "ready" : "preview"}`}>
          {activeId ? "PROFILE ACTIVE" : "NOT CALIBRATED"}
        </span>
      </header>

      <div className="calibration-grid">
        <section className="calibration-camera-card">
          <div className="section-heading">
            <span>Raw camera frame</span>
            <small>{frame ? `${frame.width}×${frame.height} · ${frame.sequence}` : "waiting"}</small>
          </div>
          <p className="calibration-hint" data-calibration-device={deviceId}>
            Device: <strong>{deviceId || "No device selected"}</strong>
          </p>
          <div
            className={`calibration-stage ${draft ? "picking" : ""}`}
            ref={stageRef}
            onPointerDown={captureImagePoint}
            style={frame ? { aspectRatio: `${frame.width} / ${frame.height}` } : undefined}
          >
            {device ? (
              <LiveScreen
                controlPlaneUrl={CONTROL_PLANE_URL}
                deviceId={deviceId}
                raw
                source="camera"
                onFrame={(nextFrame) => {
                  if (nextFrame.deviceId === deviceId) { setFrame(nextFrame); setNow(Date.now()); }
                  else {
                    setFrame(null);
                    setVideoConnected(false);
                    setNotice({ kind: "error", text: "Camera device identity does not match. Calibration is blocked." });
                  }
                }}
                onConnection={(connected, detail) => {
                  setVideoConnected(connected);
                  setVideoDetail(connected ? "Physical camera connected." : detail || "Waiting for fresh video.");
                  if (!connected) setFrame(null);
                }}
              />
            ) : (
              <div className="screen-empty"><DeviceMobileCamera size={34} /><strong>No camera node</strong></div>
            )}
            {draft?.imagePoints.map((point, index) => point ? (
              <span
                key={index}
                className={`calibration-marker ${selectedCorner === index ? "active" : ""}`}
                style={{
                  left: `${(point.x / draft.frame.width) * 100}%`,
                  top: `${(point.y / draft.frame.height) * 100}%`,
                }}
              >{index + 1}</span>
            ) : null)}
          </div>
          <p className="calibration-hint">
            {videoDetail} {frameIssue || "Live raw camera ready."}
          </p>
          <p className="calibration-hint">
            Select a corner tab before clicking its camera point. Then move the hovering stylus to that same corner and capture XY. Repeat clockwise: Top left → Top right → Bottom right → Bottom left. Keep the phone and camera fixed.
          </p>
        </section>

        <aside className="calibration-steps-card">
          <div className="section-heading">
            <span>Four-point workflow</span>
            {draft ? <small>camera {imagePointCount}/4 · machine {machinePointCount}/4</small> : null}
          </div>

          {!draft ? (
            <button className="primary-calibration-button" type="button" onClick={begin} disabled={!device?.connected || Boolean(blockedIssue) || busy}>
              {busy ? <CircleNotch className="spin" size={18} /> : <Crosshair size={18} />}
              Start calibration
            </button>
          ) : (
            <>
              <button type="button" onClick={begin} disabled={busy || Boolean(calibrationFrameIssue(frame, deviceId, videoConnected, now)) || Boolean(motionIssue)}>Restart draft and clear all points</button>
              <p className="calibration-hint">Selected corner: <strong>{CORNERS[selectedCorner]}</strong>. Each corner needs both a camera point and a machine point.</p>
              <div className="corner-tabs">
                {CORNERS.map((label, index) => (
                  <button
                    key={label}
                    type="button"
                    className={selectedCorner === index ? "active" : ""}
                    onClick={() => { setSelectedCorner(index); setConfirmed(false); }}
                    disabled={busy}
                  >
                    <span>{index + 1}</span>
                    <div>
                      <strong>{label}</strong>
                      <small>
                        {draft.imagePoints[index] ? "camera ✓" : "camera —"} · {draft.machinePoints[index] ? "machine ✓" : "machine —"}
                      </small>
                    </div>
                  </button>
                ))}
              </div>

              <div className="capture-position-card">
                <div><MapPin size={19} /><strong>Record machine point {selectedCorner + 1}</strong></div>
                <p>
                  Each arrow moves the selected {jogStep} mm step. Keep the stylus at hover Z=0; these controls do not press the screen.
                </p>
                <p>XY below comes from the controller. Camera clicks only record image points; they do not move the arm.</p>
                <div className="mini-coordinates">
                  <span>X <b>{Number(grbl?.x ?? 0).toFixed(2)}</b></span>
                  <span>Y <b>{Number(grbl?.y ?? 0).toFixed(2)}</b></span>
                  <span>Z <b>{Number(grbl?.z ?? 0).toFixed(2)}</b></span>
                </div>
                {String(grbl?.state ?? "").startsWith("Hold") ? (
                  <div className="calibration-hold-notice">
                    <span>Motion is paused in {grbl?.state}. Check the workspace before resuming: a controller may continue an interrupted move.</span>
                    <button type="button" onClick={() => void resumeMotion()} disabled={busy || moving}>
                      <Play size={15} weight="fill" /> Resume calibration motion
                    </button>
                  </div>
                ) : null}
                {draft.machinePoints[selectedCorner] ? (
                  <small className="captured-machine-point">
                    Recorded for corner {selectedCorner + 1}: X {draft.machinePoints[selectedCorner]!.x.toFixed(2)} · Y {draft.machinePoints[selectedCorner]!.y.toFixed(2)}
                  </small>
                ) : null}
                <div className="calibration-step-size" aria-label="Calibration movement step">
                  <span>Move step</span>
                  {([0.5, 2, 10] as const).map((step) => (
                    <button key={step} type="button" className={jogStep === step ? "active" : ""} onClick={() => setJogStep(step)}>
                      {step} mm
                    </button>
                  ))}
                </div>
                <div className="calibration-jog" aria-label="Calibration jog controls">
                  {jogOptions.map(({ label, axis, distance, Icon }, index) => {
                    const issue = frameIssue ?? calibrationJogIssue(grbl, axis, distance);
                    return <span key={label} style={{ display: "contents" }}>{index === 2 ? <span>{jogStep} mm</span> : null}<button type="button" aria-label={`Move stylus ${label}`} title={issue ?? `Move ${label} ${jogStep} mm`} onClick={() => jog(axis, distance)} disabled={busy || Boolean(issue)}><Icon size={16} /></button></span>;
                  })}
                </div>
                {boundaryIssues.map(issue => <small key={issue}>{issue}</small>)}
                <button type="button" onClick={captureMachinePoint} disabled={busy || Boolean(blockedIssue)}>
                  <MapPin size={17} /> Capture current XY
                </button>
                {motionIssue ? <small>{motionIssue}</small> : null}
              </div>

              <div className={`calibration-readiness ${readinessIssue ? "blocked" : "ready"}`}>
                {readinessIssue ? <WarningCircle size={18} /> : <CheckCircle size={18} />}
                <p><strong>{readinessIssue ? "Calibration is not ready" : "Four point pairs are valid"}</strong><span>{readinessMessage}</span></p>
              </div>

              <label className={`verification-check ${!complete ? "disabled" : ""}`}>
                <input type="checkbox" checked={confirmed} disabled={!complete} onChange={(event) => setConfirmed(event.target.checked)} />
                <ShieldCheck size={19} />
                <span>I verified the phone is fixed and all four camera/machine points match.</span>
              </label>

              <button
                className="primary-calibration-button"
                type="button"
                disabled={!complete || !confirmed || busy || Boolean(blockedIssue)}
                onClick={() => void calibrationRequest({
                  operation: "activate",
                  index: 0,
                  confirmation: "PHONE_FIXED_AND_POINTS_VERIFIED",
                })}
              >
                {busy ? <CircleNotch className="spin" size={18} /> : <FloppyDisk size={18} />}
                Verify and activate profile
              </button>
            </>
          )}

          {blockedIssue ? <p className="calibration-hint" role="status">{blockedIssue}</p> : null}
          <div role={notice.kind === "error" ? "alert" : "status"} className={`calibration-message ${notice.kind === "error" ? "error" : ""}`}>
            {notice.kind === "error" ? <WarningCircle size={17} /> : notice.kind === "success" ? <CheckCircle size={17} /> : <ShieldCheck size={17} />}
            <span>{notice.text}</span>
          </div>
        </aside>
      </div>
    </main>
  );
}
