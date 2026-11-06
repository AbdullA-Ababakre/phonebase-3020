"use client";

import {
  ArrowLeft,
  ArrowRight,
  Robot,
  ArrowsOut,
  BookOpenText,
  Camera,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  CheckCircle,
  CirclesFour,
  Code,
  Copy,
  Crosshair,
  DeviceMobile,
  DotsThree,
  HandTap,
  House,
  Key,
  ListBullets,
  MagnifyingGlass,
  Pause,
  PlugsConnected,
  Record,
  ShieldCheck,
  SlidersHorizontal,
  SquaresFour,
  WarningCircle,
  WifiHigh,
  WifiSlash,
  X,
} from "@phosphor-icons/react";
import { ActivityWorkspace } from "./activity-workspace";
import { deviceAvailability } from "./device-availability";
import { FleetDiscoveryPanel } from "./fleet-discovery-panel";
import { PublishingWorkspace } from "./publishing-workspace";
import { RecorderWorkspace } from "./recorder-workspace";
import { AgentLabWorkspace } from "./agent-lab-workspace";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  type FormEvent as ReactFormEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ControlPlaneEndpoint,
  controlPlaneFetch,
  reportTelemetry,
  forgetRemoteEndpoint,
  remoteEndpointFromAccessCode,
  rememberRemoteEndpoint,
  resolveControlPlaneEndpoint,
} from "./control-plane-endpoint";
import { LiveScreen, type LiveFrame } from "./live-screen";
import { initialVideoSource, videoFrameIsUsable, videoPresenceLabel } from "./video-freshness";
import { ScrollIntentBuffer, scrollGesture, wheelPixels, SCROLL_COALESCE_MS } from "./scroll-gesture";
import {
  mapContainedClientPoint,
} from "./pointer-geometry";
import {
  PRESSURE_PRESETS,
  type PressurePreset,
  touchZForPressure,
} from "./touch-pressure";

const LOCAL_POLL_INTERVAL_MS = 700;
const REMOTE_POLL_INTERVAL_MS = 1_500;

type Availability = {
  available: boolean;
  reason?: string;
  supportedKeys?: readonly ("back" | "home" | "enter")[];
};

type DeviceCapabilities = {
  observation: {
    screenshot: Availability;
    liveFrames: Availability;
  };
  actions: {
    status: Availability;
    hold: Availability;
    resume: Availability;
    home: Availability;
    hover_move?: Availability;
    tap: Availability;
    long_press: Availability;
    swipe: Availability;
    input_text?: Availability;
    phone_key?: Availability;
    wait: Availability;
  };
};

type PhoneUseDevice = {
  id: string;
  kind: string;
  status: "running" | "offline";
  connected: boolean;
  connectedAt: number | null;
  lastSeenAt: number | null;
  state: {
    cameraReady?: boolean;
    videoCapture?: { scheduled?: boolean } | null;
    cameraDetail?: string;
    digitalReady?: boolean;
    digitalDetail?: string;
    videoMode?: "wired" | "camera_fallback" | "waiting";
    videoDetail?: string;
      grbl?: {
      connected?: boolean;
      homed?: boolean;
      state?: string;
        calibrationActive?: boolean;
        activeOperation?: {
          type?: string;
          status?: string;
        } | null;
      tapProfile?: {
        touchZ?: number;
        normalTouchZ?: number;
        minimumTouchZ?: number;
        maximumTouchZ?: number;
      };
    };
    touchMapping?: {
      appScreenBounds?: {
        left: number;
        top: number;
        right: number;
        bottom: number;
      };
    } | null;
  } | null;
  screen: {
    width: number;
    height: number;
    rawWidth?: number;
    rawHeight?: number;
    rectified?: boolean;
    imagePoints?: [PointerPoint, PointerPoint, PointerPoint, PointerPoint] | null;
    sequence: number;
    capturedAt: number;
    source: string;
  } | null;
  capabilities: DeviceCapabilities;
  demo?: boolean;
};

type DevicesResponse = {
  ok: boolean;
  protocolVersion: string;
  devices: PhoneUseDevice[];
  rental?: {
    deviceId: string;
    expiresAt: string;
  };
};

type RentalLeaseView = {
  id: string;
  customer: string;
  deviceId: string;
  deviceIds?: string[];
  startsAt: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
  accessCode: string | null;
  accessLink: string | null;
};

type RentalsResponse = {
  ok: boolean;
  configured: boolean;
  configurationError: string;
  consoleUrl: string;
  leases: RentalLeaseView[];
};

type PhoneModel = {
  id: string;
  label: string;
  detail: string;
  screenAspectRatio: number | null;
};

type AutoSetupPreview = {
  ok: true;
  status: "model_required" | "ready" | "baseline_required" | "manual_review";
  deviceId: string;
  reason: string;
  homed: boolean;
  phoneModel: PhoneModel | null;
  frame: { width: number; height: number; sequence: number };
  activeImagePoints: [PointerPoint, PointerPoint, PointerPoint, PointerPoint] | null;
  proposedImagePoints: [PointerPoint, PointerPoint, PointerPoint, PointerPoint] | null;
  referenceCapturedAt: string | null;
  registration: {
    meanDriftPx: number;
    maximumDriftPx: number;
    confidence: number;
    elapsedMs: number;
  } | null;
};

type PointerPoint = { x: number; y: number };
type ClientPointer = { clientX: number; clientY: number };
type PointerSession = {
  pointerId: number;
  startedAt: number;
  start: PointerPoint;
  current: PointerPoint;
};

type ActionPayload =
  | { type: "hover_move"; point: PointerPoint; viewport: { width: number; height: number }; frameSequence: number }
  | { type: "tap"; point: PointerPoint; viewport: { width: number; height: number }; frameSequence: number; touchZ?: number }
  | { type: "long_press"; point: PointerPoint; viewport: { width: number; height: number }; frameSequence: number; durationMs: number; touchZ?: number }
  | { type: "swipe"; start: PointerPoint; end: PointerPoint; viewport: { width: number; height: number }; frameSequence: number; durationMs: number; touchZ?: number }
  | { type: "phone_key"; key: "back" | "home" | "enter"; touchZ?: number }
  | { type: "home"; confirmation: "CLEAR_WORKSPACE_AND_HOME" }
  | { type: "resume" }
  | { type: "hold" };

const unavailable: Availability = { available: false, reason: "Device offline" };
const emptyCapabilities: DeviceCapabilities = {
  observation: { screenshot: unavailable, liveFrames: unavailable },
  actions: {
    status: { available: true },
    hold: { available: true },
    resume: unavailable,
    home: unavailable,
    hover_move: unavailable,
    tap: unavailable,
    long_press: unavailable,
    swipe: unavailable,
    wait: { available: true },
  },
};

function demoDevices(): PhoneUseDevice[] {
  return Array.from({ length: 10 }, (_, index) => ({
    id: `phonebase-demo-${String(index + 1).padStart(2, "0")}`,
    kind: "physical_robot",
    status: index === 7 ? "offline" : "running",
    connected: index !== 7,
    connectedAt: Date.now() - (index + 1) * 93_000,
    lastSeenAt: Date.now(),
    state: {
      cameraReady: index !== 7,
      cameraDetail: "USB Camera2 · 720×1280",
      videoMode: "camera_fallback",
      videoDetail: "Physical camera",
      grbl: {
        connected: index !== 7,
        homed: index !== 7,
        state: index === 7 ? "Offline" : "Idle",
        calibrationActive: index !== 7,
      },
    },
    screen: {
      width: 720,
      height: 1280,
      sequence: 200 + index,
      capturedAt: Date.now(),
      source: "demo",
    },
    capabilities: index === 7
      ? emptyCapabilities
      : {
          observation: { screenshot: { available: true }, liveFrames: { available: true } },
          actions: {
            status: { available: true },
            hold: { available: true },
            resume: { available: false, reason: "Demo controller is already idle" },
            home: { available: false, reason: "Demo device is already homed" },
            hover_move: { available: true },
            tap: { available: true },
            long_press: { available: true },
            swipe: { available: true },
            wait: { available: true },
          },
        },
    demo: true,
  }));
}

function titleFor(device: PhoneUseDevice, index: number) {
  if (device.id.startsWith("phonebase-demo-")) return `PhoneUse ${String(index + 1).padStart(2, "0")}`;
  const hardwareOrdinal = /^black-arm-(\d+)$/.exec(device.id)?.[1];
  if (hardwareOrdinal) return `PhoneUse ${hardwareOrdinal}`;
  return device.id;
}

function shortId(device: PhoneUseDevice) {
  return device.id.replace(/^phonebase-/, "").replace(/^black-arm-/, "ARM-").toUpperCase();
}

function connectionLabel(device: PhoneUseDevice, remote = false) {
  return deviceAvailability(device, remote).label;
}

function actionError(device: PhoneUseDevice, controlEnabled = true, remote = false) {
  if (!controlEnabled && device.capabilities.actions.tap.available) {
    return "View-only mode is active. Click Enable control to send touch actions.";
  }
  return deviceAvailability(device, remote).detail;
}

function DeviceTile({
  device,
  index,
  endpoint,
  controlEnabled,
  selected,
  onSelect,
  onActivateVideo,
  onInspect,
  onAction,
  onFullscreen,
  onPosition,
  mode = "grid",
  onClose,
  onControlToggle,
}: {
  device: PhoneUseDevice;
  index: number;
  endpoint: ControlPlaneEndpoint | null;
  controlEnabled: boolean;
  selected: boolean;
  onSelect: () => void;
  onActivateVideo?: () => void;
  onInspect?: () => void;
  onAction: (device: PhoneUseDevice, action: ActionPayload) => Promise<boolean>;
  onFullscreen: (device: PhoneUseDevice) => void;
  onPosition: (device: PhoneUseDevice) => void;
  mode?: "grid" | "focus";
  onClose?: () => void;
  onControlToggle?: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const mouseTargetRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<PointerSession | null>(null);
  const touchFeedbackTimerRef = useRef<number | null>(null);
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [streamQuality, setStreamQuality] = useState<"responsive" | "focus">("responsive");
  const [viewSource, setViewSource] = useState<"camera" | "mirror">(() => initialVideoSource(device.state?.digitalReady));
  useEffect(() => {
    if (viewSource !== "mirror" || device.state?.digitalReady !== false) return;
    // Never strand the customer on an unavailable USB source. Remounting the
    // stream obtains fresh camera coordinates before any further touch.
    setFrame(null);
    setStreamConnected(false);
    setViewSource("camera");
  }, [viewSource, device.state?.digitalReady]);
  const [streamConnected, setStreamConnected] = useState(false);
  const [streamDetail, setStreamDetail] = useState("");
  const lastFrameReceivedAtRef = useRef<number | null>(null);
  const displayIsFresh = useCallback(() => device.demo || videoFrameIsUsable(
    document.visibilityState !== "hidden", lastFrameReceivedAtRef.current, performance.now(),
  ), [device.demo]);
  const [pressed, setPressed] = useState(false);
  const [touchFeedback, setTouchFeedback] = useState<{ id: number; point: PointerPoint } | null>(null);
  const [pressurePreset, setPressurePreset] = useState<PressurePreset>("natural");
  const pressureStorageKey = `phonebase-touch-pressure:${endpoint?.baseUrl ?? "local"}:${device.id}`;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(pressureStorageKey);
      setPressurePreset(saved === "light" || saved === "firm" ? saved : "natural");
    } catch { setPressurePreset("natural"); }
  }, [pressureStorageKey]);
  const selectPressurePreset = (preset: PressurePreset) => {
    setPressurePreset(preset);
    try { localStorage.setItem(pressureStorageKey, preset); } catch { /* Storage may be unavailable. */ }
  };
  const focusMode = mode === "focus";
  useEffect(()=>{
    if(endpoint && !device.demo)reportTelemetry(endpoint,device.id,{kind:"ui.view",view:viewSource,status:streamQuality});
  },[device.id,device.demo,endpoint,viewSource,streamQuality]);

  const selectedFrameReady = Boolean(frame && (viewSource === "camera" ? frame.role === "verification" : frame.source === "iphone-wired-usb-video")) && streamConnected && (viewSource !== "mirror" || device.state?.digitalReady === true);
  const canTouch = (device.demo || selectedFrameReady) && controlEnabled && device.connected && device.capabilities.actions.tap.available;
  // Cursor previews stay visual. Moving the arm on hover races the next tap
  // and can reject it as DEVICE_BUSY before the phone is touched.
  const localPointerPreview = endpoint?.remote !== true;
  const frameWidth = frame?.width ?? device.screen?.rawWidth ?? device.screen?.width ?? 720;
  const frameHeight = frame?.height ?? device.screen?.rawHeight ?? device.screen?.height ?? 1280;
  const width = frame?.width ?? device.screen?.width ?? 720;
  const height = frame?.height ?? device.screen?.height ?? 1280;
  const sequence = frame?.sequence ?? device.screen?.sequence ?? 0;
  const tapProfile = device.state?.grbl?.tapProfile;
  const maximumTouchZ = Number(tapProfile?.maximumTouchZ ?? tapProfile?.touchZ);
  const minimumTouchZ = Number(
    tapProfile?.minimumTouchZ ??
    (Number.isFinite(maximumTouchZ) ? maximumTouchZ - 0.5 : Number.NaN),
  );
  const selectedTouchZ = touchZForPressure(pressurePreset, {
    minimum: minimumTouchZ,
    maximum: maximumTouchZ,
    normal: tapProfile?.normalTouchZ,
  });
  const touchDepth = selectedTouchZ === null ? {} : { touchZ: selectedTouchZ };
  const wheelBuffer = useRef(new ScrollIntentBuffer());
  const wheelBusy = useRef(false);
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {});
  const wheelDispatch = useRef<() => void>(() => {});
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  wheelDispatch.current = () => {
    wheelTimer.current = null;
    const intent = wheelBuffer.current.take(performance.now());
    if (!intent || wheelBusy.current || pointerRef.current || !canTouch || !displayIsFresh() || !device.capabilities.actions.swipe.available) return;
    const gesture = scrollGesture(intent, { width: frameWidth, height: frameHeight, sequence,
      camera: viewSource === "camera", imagePoints: device.screen?.imagePoints },
      { width: device.screen?.width ?? width, height: device.screen?.height ?? height }, device.state?.touchMapping?.appScreenBounds);
    if (!gesture) return;
    wheelBusy.current = true;
    void onAction(device, { ...gesture, ...touchDepth }).finally(() => {
      wheelBusy.current = false;
      wheelBuffer.current.clear();
    });
  };
  wheelHandler.current = event => {
    if (event.ctrlKey || event.metaKey) return; // Preserve browser pinch/zoom.
    const media = stageRef.current?.querySelector(":scope > canvas, :scope > img");
    if (!media) return;
    const bounds = media.getBoundingClientRect();
    const anchor = mapContainedClientPoint({ x: event.clientX, y: event.clientY }, bounds, { width: frameWidth, height: frameHeight });
    if (!anchor) return;
    event.preventDefault();
    const now = performance.now();
    // No backlog during motion, but continuing input must work immediately
    // after completion. Requiring a quiet gap deadlocked continuous trackpads.
    if (wheelBusy.current) return;
    if (!canTouch || !displayIsFresh() || !device.capabilities.actions.swipe.available) return;
    wheelBuffer.current.add(wheelPixels(event.deltaX, event.deltaY, event.deltaMode, bounds.height), anchor, bounds, now);
    if (wheelTimer.current === null) wheelTimer.current = setTimeout(() => wheelDispatch.current(), SCROLL_COALESCE_MS);
  };
  useEffect(() => {
    const stage = stageRef.current;
    const listener = (event: WheelEvent) => wheelHandler.current(event);
    stage?.addEventListener("wheel", listener, { passive: false });
    return () => {
      stage?.removeEventListener("wheel", listener);
      if (wheelTimer.current !== null) clearTimeout(wheelTimer.current);
      wheelBuffer.current.clear();
    };
  }, [device.id]);

  const cameraPointFromEvent = useCallback((event: ClientPointer) => {
    const media = stageRef.current?.querySelector(":scope > canvas, :scope > img");
    if (!media) return null;
    return mapContainedClientPoint(
      { x: event.clientX, y: event.clientY },
      media.getBoundingClientRect(),
      { width: frameWidth, height: frameHeight },
    );
  }, [frameHeight, frameWidth]);

  const pointFromEvent = useCallback((event: ClientPointer) => {
    const cameraPoint = cameraPointFromEvent(event);
    if (!cameraPoint) return null;
    // Raw camera coordinates are transformed exactly once by the server.
    return cameraPoint;
  }, [cameraPointFromEvent]);

  const hideMouseTarget = useCallback(() => {
    const target = mouseTargetRef.current;
    if (!target) return;
    target.style.opacity = "0";
    target.style.visibility = "hidden";
  }, []);

  const moveMouseTarget = useCallback((event: ClientPointer) => {
    const cameraPoint = cameraPointFromEvent(event);
    const bounds = stageRef.current?.getBoundingClientRect();
    const target = mouseTargetRef.current;
    if (!cameraPoint || !bounds || bounds.width <= 0 || bounds.height <= 0 || !target) {
      hideMouseTarget();
      return pointFromEvent(event);
    }
    const point = pointFromEvent(event);
    target.style.left = `${Math.max(0, Math.min(bounds.width, event.clientX - bounds.left))}px`;
    target.style.top = `${Math.max(0, Math.min(bounds.height, event.clientY - bounds.top))}px`;
    target.style.opacity = "1";
    target.style.visibility = "visible";
    const label = target.firstElementChild;
    if (label) {
      label.textContent = point
        ? `${Math.round(Math.max(0, Math.min(100, (point.x / width) * 100)))}%, ${Math.round(Math.max(0, Math.min(100, (point.y / height) * 100)))}%`
        : "Outside screen";
    }
    return point;
  }, [cameraPointFromEvent, height, hideMouseTarget, pointFromEvent, width]);

  const trackMouse = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || !localPointerPreview) return pointFromEvent(event);
    return moveMouseTarget(event);
  };

  useEffect(() => () => {
    if (touchFeedbackTimerRef.current !== null) window.clearTimeout(touchFeedbackTimerRef.current);
  }, []);

  const showTouchFeedback = (point: PointerPoint) => {
    if (touchFeedbackTimerRef.current !== null) window.clearTimeout(touchFeedbackTimerRef.current);
    setTouchFeedback({ id: performance.now(), point });
    touchFeedbackTimerRef.current = window.setTimeout(() => {
      setTouchFeedback(null);
      touchFeedbackTimerRef.current = null;
    }, 700);
  };

  useEffect(() => {
    if (!focusMode || !onClose) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusMode, onClose]);

  useEffect(() => {
    if (!localPointerPreview) {
      hideMouseTarget();
      return;
    }
    const handleMouseMove = (event: MouseEvent) => {
      moveMouseTarget(event);
    };
    const handleWindowBlur = () => hideMouseTarget();
    window.addEventListener("mousemove", handleMouseMove, { capture: true, passive: true });
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [hideMouseTarget, localPointerPreview, moveMouseTarget]);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    onSelect();
    if (device.state?.videoCapture?.scheduled === false) { onActivateVideo?.(); return; }
    const point = trackMouse(event);
    if (!canTouch || !sequence || !displayIsFresh()) return;
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      start: point,
      current: point,
    };
    setPressed(true);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = trackMouse(event);
    if (pointerRef.current?.pointerId !== event.pointerId) return;
    if (point) pointerRef.current.current = point;
  };

  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointerPoint = trackMouse(event);
    const session = pointerRef.current;
    pointerRef.current = null;
    setPressed(false);
    if (!session || session.pointerId !== event.pointerId || !canTouch || !sequence || !displayIsFresh()) return;
    const current = pointerPoint ?? session.current;
    const durationMs = Math.round(performance.now() - session.startedAt);
    const distance = Math.hypot(current.x - session.start.x, current.y - session.start.y);
    const viewport = { width, height };
    showTouchFeedback(current);
    if (distance > Math.min(width, height) * 0.045 && device.capabilities.actions.swipe.available) {
      void onAction(device, {
        type: "swipe",
        start: session.start,
        end: current,
        viewport,
        frameSequence: sequence,
        durationMs: Math.max(180, Math.min(durationMs, 1_200)),
        ...touchDepth,
      });
      return;
    }
    if (durationMs >= 520 && device.capabilities.actions.long_press.available) {
      void onAction(device, {
        type: "long_press",
        point: current,
        viewport,
        frameSequence: sequence,
        durationMs: Math.min(durationMs, 2_500),
        ...touchDepth,
      });
      return;
    }
    void onAction(device, { type: "tap", point: current, viewport, frameSequence: sequence, ...touchDepth });
  };

  const pointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerRef.current = null;
    setPressed(false);
    if (event.pointerType === "mouse") hideMouseTarget();
  };

  const goBack = () => {
    onSelect();
    if (!canTouch || !displayIsFresh() ||
      !device.capabilities.actions.phone_key?.available ||
      !device.capabilities.actions.phone_key.supportedKeys?.includes("back")) return;
    void onAction(device, { type: "phone_key", key: "back", ...touchDepth });
  };

  const goHome = () => {
    onSelect();
    if (
      !canTouch ||
      !displayIsFresh() ||
      !device.capabilities.actions.phone_key?.available ||
      !device.capabilities.actions.phone_key.supportedKeys?.includes("home")
    ) return;
    void onAction(device, { type: "phone_key", key: "home", ...touchDepth });
  };

  const holdDevice = () => {
    onSelect();
    if (!device.connected || !device.capabilities.actions.hold.available) return;
    void onAction(device, { type: "hold" });
  };

  const status = connectionLabel(device, endpoint?.remote);
  const displayTitle = titleFor(device, index);
  const focusRatio = frameWidth / frameHeight;
  const focusWidth = `min(430px, calc(100vw - 32px), calc(${(focusRatio * 100).toFixed(4)}dvh - ${(focusRatio * 210).toFixed(2)}px))`;
  return (
    <article className={`wall-device ${selected ? "selected" : ""} ${focusMode ? "focus-device" : ""}`} aria-label={`${displayTitle} ${focusMode ? "focus mode" : "device"}`}>
      {focusMode ? (
        <div className="wall-device-toolbar focus-device-toolbar">
          <div className="focus-device-identity">
            <span className={`device-presence ${device.connected && selectedFrameReady ? "online" : ""}`}><i />{videoPresenceLabel(device.connected, selectedFrameReady, streamDetail)}</span>
            <strong>{displayTitle}</strong>
            <small>{canTouch ? "Click, press, or drag directly on the phone" : actionError(device, controlEnabled, endpoint?.remote)}</small>
          </div>
          <div className="focus-toolbar-actions">
            <button
              type="button"
              className={`focus-control-toggle ${controlEnabled ? "enabled" : ""}`}
              onClick={onControlToggle}
              disabled={!onControlToggle || !device.connected}
              aria-label={controlEnabled ? `Disable control for ${displayTitle}` : `Enable control for ${displayTitle}`}
            >
              <HandTap size={16} weight={controlEnabled ? "fill" : "regular"} />
              {controlEnabled ? "Control on" : "Enable control"}
            </button>
            <button
              type="button"
              className="focus-hold-button"
              onClick={holdDevice}
              disabled={!device.connected || !device.capabilities.actions.hold.available}
              aria-label={`Hold ${displayTitle}`}
              title="Stop this device and disable physical movement"
            >
              <Pause size={15} weight="fill" /> Hold
            </button>
            <button type="button" className="focus-close-button" onClick={onClose} aria-label="Exit focus mode" title="Exit focus mode (Esc)"><X size={18} /></button>
          </div>
        </div>
      ) : (
        <div className="wall-device-toolbar">
          <div className="tile-heading"><strong>{displayTitle}</strong><span className={`device-presence ${device.connected ? "online" : ""}`}><i />{status}</span></div>
          <div className="device-toolbar-actions">
            {!endpoint?.remote && <button type="button" aria-label={`Position ${displayTitle}`} title="Set up device position" onClick={() => onPosition(device)}><Crosshair size={15} /></button>}
            <button
              type="button"
              className="fullscreen-trigger"
              aria-label={`Open ${displayTitle} full screen`}
              title="Open full screen control"
              onClick={() => onFullscreen(device)}
            >
              <ArrowsOut size={14} />
              <span>Full screen</span>
            </button>
            <button type="button" aria-label={`Details for ${displayTitle}`} title="Device details" onClick={onInspect ?? onSelect}>
              <DotsThree size={17} weight="bold" />
            </button>
          </div>
        </div>
      )}

      <div className="device-view-switch" role="group" aria-label="Phone view">
        <button type="button" aria-pressed={viewSource === "camera"} onClick={() => { setViewSource("camera"); setFrame(null); setStreamConnected(false); }}>Camera</button>
        <button type="button" aria-pressed={viewSource === "mirror"} onClick={() => { setViewSource("mirror"); setFrame(null); setStreamConnected(false); }}>HD mirror{device.state?.digitalReady ? "" : " · Offline"}</button>
      </div>
      {endpoint?.remote && <div className="stream-quality-control"><label>Video quality <select aria-label="Video quality" value={streamQuality} onChange={event=>setStreamQuality(event.target.value as "responsive"|"focus")}><option value="responsive">Responsive · lower bandwidth</option><option value="focus">Sharp · more detail</option></select></label></div>}
      {viewSource === "mirror" && !device.state?.digitalReady && <p className="mirror-unavailable">{endpoint?.remote ? "HD mirror is unavailable. Your operator manages the phone connection. You can try Camera view while they check the station." : "Connect and unlock the assigned iPhone, then trust the station computer. You can try Camera view while restoring HD mirror."}</p>}
      <div
        ref={stageRef}
        className={`wall-screen ${canTouch ? "interactive" : ""} ${pressed ? "pressed" : ""}`}
        style={{
          aspectRatio: `${frameWidth} / ${frameHeight}`,
          ...(focusMode ? { width: focusWidth } : {}),
        }}
        onPointerDown={pointerDown}
        onPointerEnter={(event) => { trackMouse(event); }}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse" && pointerRef.current?.pointerId !== event.pointerId) hideMouseTarget();
        }}
        onPointerCancel={pointerCancel}
        aria-label={canTouch
          ? `${focusMode ? "Focus mode " : ""}physical phone control surface for ${displayTitle}`
          : actionError(device, controlEnabled, endpoint?.remote)}
      >
        {device.demo ? (
          // The static demo is already cropped to the physical phone viewport.
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/demo-phonefarm-screen.png" alt="Demo physical phone screen" draggable={false} />
        ) : endpoint && device.connected ? (
          <LiveScreen
            controlPlaneUrl={endpoint.baseUrl}
            accessToken={endpoint.accessToken}
            deviceId={device.id}
            key={viewSource}
            source={viewSource}
            raw={viewSource === "camera"}
            quality={endpoint.remote ? streamQuality : focusMode ? "focus" : "preview"}
            onFrame={(next) => {
              lastFrameReceivedAtRef.current = performance.now();
              setFrame(next);
            }}
            onConnection={(connected, detail) => {
              if (!connected) lastFrameReceivedAtRef.current = null;
              setStreamConnected(connected);
              setStreamDetail(detail ?? "");
            }}
          />
        ) : (
          <div className="screen-empty">
            <DeviceMobile size={34} weight="thin" />
            <strong>{device.connected ? "Waiting for camera" : "Device offline"}</strong>
            <span>{device.state?.cameraDetail ?? "Connect camera and controller USB"}</span>
          </div>
        )}
        {!device.demo && device.connected && !streamConnected ? (
          <div className="screen-stream-state"><span />{streamDetail || "Connecting video"}</div>
        ) : null}
        {!endpoint?.remote && device.state?.videoCapture?.scheduled === false && onActivateVideo ? (
          <button type="button" className="video-start-button" aria-label={`Start live video for ${displayTitle}`}
            onPointerDown={event => event.stopPropagation()}
            onClick={event => { event.stopPropagation(); onActivateVideo(); }}><Camera size={16} /> Start live video</button>
        ) : null}
        {localPointerPreview ? (
          <div
            ref={mouseTargetRef}
            className={`wall-mouse-target ${canTouch ? "ready" : "locked"} ${pressed ? "pressed" : ""}`}
            aria-hidden="true"
          >
            <span />
          </div>
        ) : null}
        {touchFeedback ? (
          <div
            key={touchFeedback.id}
            className="wall-touch-feedback"
            style={{
              left: `${Math.max(0, Math.min(100, (touchFeedback.point.x / width) * 100))}%`,
              top: `${Math.max(0, Math.min(100, (touchFeedback.point.y / height) * 100))}%`,
            }}
            aria-hidden="true"
          />
        ) : null}
        {!controlEnabled && device.connected ? endpoint?.remote && onControlToggle ? (
          <button
            type="button"
            className="inspect-badge enable-control-badge"
            onClick={(event) => {
              event.stopPropagation();
              onControlToggle();
            }}
          >
            <HandTap size={13} weight="fill" /> Enable control to tap phone
          </button>
        ) : (
          <div className="inspect-badge">View only</div>
        ) : null}
        {controlEnabled && !device.capabilities.actions.tap.available ? (
          <div className="locked-badge"><ShieldCheck size={13} /> {connectionLabel(device, endpoint?.remote)}</div>
        ) : null}
      </div>

      <div className="wall-touch-controls">
        <button
          type="button"
          className="ios-back-button"
          onClick={goBack}
          disabled={!canTouch || !device.capabilities.actions.phone_key?.available || !device.capabilities.actions.phone_key.supportedKeys?.includes("back")}
          aria-label={`${focusMode ? "Focus mode " : ""}Back for ${displayTitle}`}
          title="Return using the visible Back control on this phone"
        >
          <ArrowLeft size={14} /> Back
        </button>
        <button
          type="button"
          className="ios-system-button"
          onClick={goHome}
          disabled={
            !canTouch ||
            !device.capabilities.actions.phone_key?.available ||
            !device.capabilities.actions.phone_key.supportedKeys?.includes("home")
          }
          aria-label={`${focusMode ? "Focus mode " : ""}Home for ${displayTitle}`}
          title={device.capabilities.actions.phone_key?.supportedKeys?.includes("home")
            ? "Return this phone to its Home screen"
            : "Phone Home is unavailable; your operator manages device preparation"}
        >
          <House size={14} /> Home
        </button>
        <div className="pressure-selector" aria-label={`Touch pressure for ${displayTitle}`}>
          {PRESSURE_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className={pressurePreset === preset.id ? "active" : ""}
              onClick={() => selectPressurePreset(preset.id)}
              title={selectedTouchZ === null ? preset.label : `${preset.label} touch pressure`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {focusMode ? (
        <div className="focus-device-status">
          <span>iPhone · {shortId(device)}</span>
          <span className={canTouch ? "control-live" : ""}>{canTouch ? "Physical control is live" : controlEnabled ? status : "View-only · click Enable control to tap the phone"}</span>
        </div>
      ) : (
        <button type="button" className="wall-device-meta" onClick={() => { onSelect(); if (device.state?.videoCapture?.scheduled === false) onActivateVideo?.(); }}>
          <span className={`device-radio ${selected ? "selected" : ""}`}>{selected ? <CheckCircle size={18} weight="fill" /> : null}</span>
          <span className="device-meta-copy">
            <strong>{displayTitle}</strong>
            <small>iPhone · {shortId(device)}</small>
          </span>
          <span className={`device-state-pill ${status.toLowerCase().replace(" ", "-")}`}>{status}</span>
        </button>
      )}
    </article>
  );
}

function PlacementModal({
  device,
  index,
  endpoint,
  onClose,
}: {
  device: PhoneUseDevice;
  index: number;
  endpoint: ControlPlaneEndpoint;
  onClose: () => void;
}) {
  const router = useRouter();
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [streamDetail, setStreamDetail] = useState("Connecting camera");
  const [checks, setChecks] = useState([false, false, false]);
  const ready = streamConnected && checks.every(Boolean);
  const guideState = ready ? "ready" : checks[0] ? "close" : "adjust";
  const checklist = [
    { title: "Whole screen visible", detail: "The complete display and all four corners are in view." },
    { title: "Four corners inside guide", detail: "Keep the screen edges inside the target outline." },
    { title: "Reduce glare", detail: "Adjust the angle or lighting until icons and both edges stay visible." },
  ];

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="placement-layer" role="dialog" aria-modal="true" aria-labelledby="placement-title" data-testid="placement-dialog">
      <section className="placement-dialog">
        <header className="placement-header">
          <div>
            <strong id="placement-title">Position device</strong>
            <span>Align the phone under the camera before calibration.</span>
          </div>
          <div className={`placement-camera-state ${streamConnected ? "connected" : ""}`}>
            <span />
            {streamConnected ? "Camera connected" : streamDetail}
          </div>
          <button type="button" className="placement-close" onClick={onClose} aria-label="Close position device"><X size={18} /></button>
        </header>

        <div className="placement-body">
          <div className="placement-viewer">
            <div
              className="placement-feed"
              style={{ aspectRatio: `${frame?.width ?? 720} / ${frame?.height ?? 1280}` }}
            >
              <LiveScreen
                controlPlaneUrl={endpoint.baseUrl}
                accessToken={endpoint.accessToken}
                deviceId={device.id}
                raw
                onFrame={setFrame}
                onConnection={(connected, detail) => {
                  setStreamConnected(connected);
                  setStreamDetail(detail || (connected ? "Camera connected" : "Connecting camera"));
                }}
              />
              <div className={`placement-guide ${guideState}`} aria-hidden="true">
                <span className="guide-corner top-left" />
                <span className="guide-corner top-right" />
                <span className="guide-corner bottom-right" />
                <span className="guide-corner bottom-left" />
                <span className="guide-top"><CaretUp size={16} weight="fill" /> TOP</span>
              </div>
            </div>
            <div className="placement-nudge left"><CaretLeft size={24} weight="bold" /><span>Move left</span></div>
            <div className="placement-nudge right"><CaretRight size={24} weight="bold" /><span>Move right</span></div>
            <div className="placement-nudge down"><CaretDown size={24} weight="bold" /><span>Move down</span></div>
          </div>

          <aside className="placement-checklist">
            <div className="placement-checklist-title">
              <strong>Follow the steps to get a clear view</strong>
              <span>{titleFor(device, index)} · {frame ? `${frame.width}×${frame.height}` : "Waiting for frame"}</span>
            </div>
            <div className="placement-checks">
              {checklist.map((item, itemIndex) => (
                <button
                  type="button"
                  key={item.title}
                  className={checks[itemIndex] ? "checked" : ""}
                  aria-pressed={checks[itemIndex]}
                  onClick={() => setChecks((current) => current.map((value, indexValue) => indexValue === itemIndex ? !value : value))}
                >
                  <span className="placement-check-number">
                    {checks[itemIndex] ? <CheckCircle size={24} weight="fill" /> : itemIndex + 1}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                    <em>{checks[itemIndex] ? "Confirmed" : "Tap to confirm"}</em>
                  </span>
                </button>
              ))}
            </div>

            <div className="placement-tip">
              <Camera size={19} />
              <p><strong>Phone does not fit?</strong><span>Loosen the screw behind the camera, move it up or down, then tighten it again.</span></p>
            </div>

            <div className="placement-actions">
              <button type="button" className="placement-secondary" onClick={onClose}>Close</button>
              <button
                type="button"
                className="placement-primary"
                disabled={!ready}
                onClick={() => router.push(`/calibrate?deviceId=${encodeURIComponent(device.id)}`)}
              >
                <Crosshair size={17} /> Continue to calibration
              </button>
              {!ready ? <small>Confirm all three checks to continue.</small> : <small className="ready-copy">Ready for four-corner calibration.</small>}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

function autoSetupBaseUrl() {
  return "http://127.0.0.1:3031";
}

async function autoSetupRequest<T>(
  deviceId: string,
  operation: "model" | "preview" | "reference" | "run",
  init: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
) {
  const response = await fetch(
    `${autoSetupBaseUrl()}/v1/devices/${encodeURIComponent(deviceId)}/${operation}`,
    {
      method: init.method ?? "POST",
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
      body: init.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    },
  );
  reportTelemetry({baseUrl:"http://127.0.0.1:3013",accessToken:"",remote:false},deviceId,
    {kind:"ui.setup",view:operation,status:String(response.status)});
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Automatic setup failed (${response.status})`);
  }
  return payload;
}

function AutoSetupModal({
  device,
  index,
  endpoint,
  onClose,
  onComplete,
}: {
  device: PhoneUseDevice;
  index: number;
  endpoint: ControlPlaneEndpoint;
  onClose: () => void;
  onComplete: (message: string) => void;
}) {
  const [preview, setPreview] = useState<AutoSetupPreview | null>(null);
  const [models, setModels] = useState<PhoneModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [frameUrl, setFrameUrl] = useState("");
  const [cornersConfirmed, setCornersConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    setCornersConfirmed(false);
    try {
      const value = await autoSetupRequest<AutoSetupPreview>(device.id, "preview");
      setPreview(value);
      if (value.phoneModel) setModelId(value.phoneModel.id);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Camera recognition failed");
    } finally {
      setBusy(false);
    }
  }, [device.id]);

  useEffect(() => {
    let cancelled = false;
    void autoSetupRequest<{ model: PhoneModel | null; models: PhoneModel[] }>(
      device.id,
      "model",
      { method: "GET" },
    ).then((value) => {
      if (cancelled) return;
      setModels(value.models);
      setModelId(value.model?.id ?? "");
      return refresh();
    }).catch((value: unknown) => {
      if (!cancelled) {
        setError(value instanceof Error ? value.message : "PhoneUse Vision is unavailable");
      }
    });
    return () => { cancelled = true; };
  }, [device.id, refresh]);

  useEffect(() => {
    if (!preview) return;
    let cancelled = false;
    let objectUrl = "";
    void controlPlaneFetch(
      endpoint,
      `/api/v1/devices/${encodeURIComponent(device.id)}/screenshot?sequence=${preview.frame.sequence}`,
      { cache: "no-store" },
    ).then(async (response) => {
      if (!response.ok) throw new Error(`Camera frame unavailable (${response.status})`);
      objectUrl = URL.createObjectURL(await response.blob());
      if (!cancelled) setFrameUrl(objectUrl);
    }).catch((value: unknown) => {
      if (!cancelled) setError(value instanceof Error ? value.message : "Camera frame unavailable");
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [device.id, endpoint, preview]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  const selectModel = async () => {
    if (!modelId) return;
    setBusy(true);
    setError("");
    try {
      await autoSetupRequest(device.id, "model", { body: { modelId } });
      await refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Unable to save phone model");
      setBusy(false);
    }
  };

  const saveReference = async () => {
    if (!preview || !cornersConfirmed) return;
    setBusy(true);
    setError("");
    try {
      const adoptVisionProposal = preview.proposedImagePoints !== null;
      await autoSetupRequest(device.id, "reference", {
        body: {
          frameSequence: preview.frame.sequence,
          adoptVisionProposal,
          confirmation: adoptVisionProposal
            ? "VISION_PROPOSAL_MATCHES_PHYSICAL_SCREEN"
            : "CURRENT_PLACEMENT_MATCHES_ACTIVE_CALIBRATION",
        },
      });
      onComplete("Phone model and trusted screen outline saved");
      await refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Unable to save visual reference");
      setBusy(false);
    }
  };

  const homeForSetup = async () => {
    const confirmed = window.confirm(
      "The arm will run its Home cycle. Keep hands, cables, and loose objects clear, then click OK.",
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    try {
      const response = await controlPlaneFetch(
        endpoint,
        `/api/v1/devices/${encodeURIComponent(device.id)}/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: `automatic-setup-home-${device.id}-${Date.now()}`,
            action: { type: "home", confirmation: "CLEAR_WORKSPACE_AND_HOME" },
          }),
        },
      );
      const payload = await response.json() as {
        error?: string;
        result?: { receipt?: { id?: string } };
      };
      if (!response.ok) throw new Error(payload.error ?? `Home failed (${response.status})`);
      const receiptId = payload.result?.receipt?.id;
      if (!receiptId) throw new Error("Home did not return a hardware receipt");
      const deadline = Date.now() + 70_000;
      while (Date.now() < deadline) {
        const receiptResponse = await controlPlaneFetch(
          endpoint,
          `/api/v1/devices/${encodeURIComponent(device.id)}/actions/${encodeURIComponent(receiptId)}`,
          { cache: "no-store" },
        );
        const receiptPayload = await receiptResponse.json() as {
          error?: string;
          receipt?: { status?: string; error?: string | null };
        };
        if (!receiptResponse.ok) {
          throw new Error(receiptPayload.error ?? `Receipt failed (${receiptResponse.status})`);
        }
        if (receiptPayload.receipt?.status === "completed") {
          onComplete("Home completed; checking the phone again");
          await refresh();
          return;
        }
        if (receiptPayload.receipt?.status === "failed") {
          throw new Error(receiptPayload.receipt.error ?? "Machine homing failed");
        }
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
      throw new Error("Machine homing timed out");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Unable to Home the machine");
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!preview || preview.status !== "ready") return;
    if (!preview.homed) {
      const confirmed = window.confirm(
        "The arm must Home before restoring control. Keep hands, cables, and loose objects clear, then click OK.",
      );
      if (!confirmed) return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await autoSetupRequest<{ moved: boolean }>(device.id, "run", {
        body: { confirmation: "CLEAR_WORKSPACE_AND_AUTO_SETUP" },
      });
      onComplete(result.moved
        ? "Home completed and the screen map was restored"
        : "The screen map was restored automatically");
      onClose();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Automatic restore failed");
      setBusy(false);
    }
  };

  const points = preview?.proposedImagePoints ?? preview?.activeImagePoints ?? null;
  const needsManualBaseline = preview?.status === "baseline_required" && points === null;
  const polygon = points?.map((point) => `${point.x},${point.y}`).join(" ") ?? "";
  const statusLabel = preview?.status === "ready"
    ? "Screen recognized"
    : preview?.status === "baseline_required"
      ? needsManualBaseline ? "Manual calibration required" : "Confirm once"
      : preview?.status === "manual_review"
        ? "Review needed"
        : preview?.status === "model_required"
          ? "Choose model"
          : "Analyzing";

  return (
    <div className="placement-layer" role="dialog" aria-modal="true" aria-labelledby="auto-setup-title" data-testid="auto-setup-dialog">
      <section className="placement-dialog auto-setup-dialog">
        <header className="placement-header">
          <div>
            <strong id="auto-setup-title">Automatic phone setup</strong>
            <span>{titleFor(device, index)} · choose once, then PhoneUse remembers</span>
          </div>
          <div className={`auto-setup-state ${preview?.status ?? "loading"}`}><span />{busy ? "Analyzing camera" : statusLabel}</div>
          <button type="button" className="placement-close" disabled={busy} onClick={onClose} aria-label="Close automatic setup"><X size={18} /></button>
        </header>

        <div className="auto-setup-body">
          <div className="auto-setup-viewer">
            {preview && frameUrl ? (
              <div className={`auto-setup-frame ${preview.status}`} style={{ aspectRatio: `${preview.frame.width} / ${preview.frame.height}` }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={frameUrl} alt="Physical camera frame used for screen recognition" />
                {points ? (
                  <svg viewBox={`0 0 ${preview.frame.width} ${preview.frame.height}`} aria-label={preview.proposedImagePoints ? "Proposed phone screen corners" : "Previous calibration corners"}>
                    <polygon points={polygon} />
                    {points.map((point, pointIndex) => (
                      <g key={`${point.x}-${point.y}`}><circle cx={point.x} cy={point.y} r="8" /><text x={point.x + 14} y={point.y + 8}>{pointIndex + 1}</text></g>
                    ))}
                  </svg>
                ) : null}
                {points ? <span className="auto-setup-overlay-label">{preview.proposedImagePoints ? "Detected screen" : "Previous calibration · verify before use"}</span> : null}
              </div>
            ) : <div className="auto-setup-loading">Reading the physical camera…</div>}
          </div>

          <aside className="auto-setup-summary">
            <div>
              <strong>{statusLabel}</strong>
              <p>{error || preview?.reason || "Connecting to PhoneUse Vision."}</p>
            </div>

            <div className="phone-model-field">
              <label htmlFor="phone-model">Phone model</label>
              <select id="phone-model" value={modelId} disabled={busy} onChange={(event) => setModelId(event.target.value)}>
                <option value="">Select once…</option>
                {models.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
              </select>
              <small>{models.find((model) => model.id === modelId)?.detail ?? "This helps Vision identify the correct screen shape."}</small>
              {modelId !== preview?.phoneModel?.id ? <button type="button" disabled={busy || !modelId} onClick={() => void selectModel()}>Save model &amp; detect screen</button> : null}
            </div>

            <dl>
              <div><dt>Camera frame</dt><dd>{preview ? `${preview.frame.width}×${preview.frame.height}` : "—"}</dd></div>
              <div><dt>Home state</dt><dd>{preview?.homed ? "Complete" : "Required"}</dd></div>
              <div><dt>Confidence</dt><dd>{preview?.registration ? `${Math.round(preview.registration.confidence * 100)}%` : "—"}</dd></div>
              <div><dt>Mean drift</dt><dd>{preview?.registration ? `${preview.registration.meanDriftPx.toFixed(1)} px` : "—"}</dd></div>
            </dl>

            <div className="auto-setup-note"><ShieldCheck size={19} /><p><strong>Safe by default</strong><span>Low confidence, changed resolution, or out-of-range coordinates stop before movement.</span></p></div>

            <div className="auto-setup-actions">
              <button type="button" className="placement-secondary" disabled={busy || !preview?.phoneModel} onClick={() => void refresh()}>Retry recognition</button>
              {preview && !preview.homed ? <button type="button" className="placement-primary" disabled={busy} onClick={() => void homeForSetup()}>Home machine first</button> : null}
              {preview?.status === "baseline_required" && !needsManualBaseline ? (
                <>
                  <label className="corner-confirm"><input type="checkbox" checked={cornersConfirmed} onChange={(event) => setCornersConfirmed(event.target.checked)} />All four green corners match the physical screen</label>
                  <button type="button" className="placement-primary" disabled={busy || !preview.homed || !cornersConfirmed} onClick={() => void saveReference()}>Confirm once &amp; save</button>
                </>
              ) : null}
              {preview?.status === "ready" ? <button type="button" className="placement-primary" disabled={busy} onClick={() => void restore()}>Restore screen map</button> : null}
              {preview?.status === "manual_review" || preview?.status === "baseline_required" ? <Link className="auto-setup-manual" href={`/calibrate?deviceId=${encodeURIComponent(device.id)}`}>Use manual calibration</Link> : null}
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

type WorkspaceView = "devices" | "connections" | "rentals" | "developer" | "activity" | "publishing" | "recorder" | "agent";

function CloudPairing({
  initialError,
  onConnected,
}: {
  initialError: string;
  onConnected: (endpoint: ControlPlaneEndpoint) => void;
}) {
  const [accessCode, setAccessCode] = useState("");
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);

  const connect = async (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = remoteEndpointFromAccessCode(accessCode);
    if (!candidate) {
      setError("This invitation looks incomplete. Paste the full private link or access code from your operator.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await controlPlaneFetch(candidate, "/api/v1/devices", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? "This invitation has expired or is no longer valid. Ask your operator for a new invitation."
        : "Your station is temporarily unavailable. Try again, or ask your operator to check the connection.");
      const payload = await response.json() as { devices?: unknown[] };
      if (!Array.isArray(payload.devices)) throw new Error("The station could not return your devices. Try again shortly.");
      rememberRemoteEndpoint(candidate);
      onConnected(candidate);
    } catch (value) {
      setError(value instanceof TypeError ? "We couldn’t reach your station. Check your internet connection and try again. If this continues, contact your operator." : value instanceof Error ? value.message : "Could not connect to this station");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="cloud-pairing-shell">
      <header className="pairing-header">
        <Link href="/" className="cloud-pairing-brand"><DeviceMobile size={24} weight="duotone" /><strong>phoneuse</strong><span>console</span></Link>
        <nav aria-label="Console resources"><Link href="/docs/quickstart">Quickstart</Link><Link href="/docs">Documentation <ArrowRight size={15} /></Link></nav>
      </header>
      <div className="pairing-layout">
        <section className="pairing-intro">
          <span className="platform-eyebrow">REAL PHONE WORKSPACE</span>
          <h1>Give your agent<br />a real phone.</h1>
          <p>One private invitation opens the same assigned device in your browser, REST API, and MCP client.</p>
          <div className="pairing-signals" aria-label="Workspace benefits"><span><WifiHigh size={16} />Live screen</span><span><ShieldCheck size={16} />Private access</span><span><CheckCircle size={16} />Action receipts</span></div>
          <ol className="pairing-steps">
            <li><span>01</span><div><strong>Paste the private invitation</strong><p>Use the link or short access code from your PhoneUse operator.</p></div></li>
            <li><span>02</span><div><strong>Open your assigned device</strong><p>Watch the real screen and see whether physical control is ready.</p></div></li>
            <li><span>03</span><div><strong>Operate or connect an agent</strong><p>Use the browser directly, or take the same access into API and MCP.</p></div></li>
          </ol>
          <div className="pairing-preview" aria-label="Example connected PhoneUse workspace">
            <div className="pairing-preview-top"><span><i /> DEVICE SF-01</span><small>LIVE</small></div>
            <div className="pairing-preview-body"><div className="pairing-mini-phone"><span /><b /><i /></div><div className="pairing-preview-events"><span>Observe <b>fresh frame</b></span><span>Act <b>physical tap</b></span><span>Verify <b>receipt complete</b></span></div></div>
          </div>
        </section>
        <section className="cloud-pairing-card" aria-labelledby="pairing-title">
          <div className="pairing-card-top"><span className="pairing-key"><Key size={22} weight="duotone" /></span><span>SECURE ACCESS PORTAL</span></div>
          <h2 id="pairing-title">Open your PhoneUse workspace</h2>
          <p className="pairing-description">Paste the complete invitation. We will verify the station and show only devices assigned to you.</p>
          <form className="cloud-pairing-form" onSubmit={(event) => void connect(event)}>
            <label htmlFor="workspace-invitation"><span>Private invitation</span><small>Link or short access code</small></label>
            <div className="pairing-input-wrap"><input id="workspace-invitation" type={showCode ? "text" : "password"} required maxLength={2048} value={accessCode} onChange={(event) => { setAccessCode(event.target.value); setError(""); }} placeholder="Paste your invitation here" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(error)} aria-describedby={error ? "pairing-error" : "pairing-privacy"} /><button type="button" onClick={() => setShowCode(!showCode)} aria-label={showCode ? "Hide invitation" : "Show invitation"}>{showCode ? "Hide" : "Show"}</button></div>
            {error ? <div id="pairing-error" role="alert" className="cloud-pairing-error"><WarningCircle size={18} weight="fill" /><span>{error}</span></div> : null}
            <button type="submit" disabled={busy || !accessCode.trim()}>{busy ? "Verifying your invitation…" : "Continue to device"}<ArrowRight size={17} /></button>
          </form>
          <p id="pairing-privacy" className="pairing-privacy"><ShieldCheck size={17} weight="fill" />Your invitation stays in this browser and is never shown back on screen.</p>
          <div className="pairing-card-foot"><span>Usually takes less than 10 seconds</span><Link href="/docs/security">How access works <ArrowRight size={14} /></Link></div>
          <details className="pairing-help"><summary>Need an invitation?</summary><p>Ask the person managing your PhoneUse trial for a private customer link or short access code.</p><Link href="/docs/quickstart">Read the customer quickstart <ArrowRight size={15} /></Link></details>
        </section>
      </div>
      <footer className="pairing-footer"><span>PhoneUse · Real phones for AI agents</span><div><span>San Francisco station</span><i /> <span>Systems operational</span></div></footer>
    </main>
  );
}

const ACTION_CAPABILITIES: Array<{
  key: keyof DeviceCapabilities["actions"];
  label: string;
  detail: string;
}> = [
  { key: "status", label: "Status", detail: "Read controller and motion state" },
  { key: "hold", label: "Hold", detail: "Immediately pause physical motion" },
  { key: "resume", label: "Resume", detail: "Release a safe controller hold" },
  { key: "home", label: "Home", detail: "Run an explicitly confirmed homing cycle" },
  { key: "hover_move", label: "Hover move", detail: "Move above a screen point without touching" },
  { key: "tap", label: "Tap", detail: "Touch a point from an exact camera frame" },
  { key: "long_press", label: "Long press", detail: "Press a point with calibrated duration and depth" },
  { key: "swipe", label: "Swipe", detail: "Move between two calibrated screen points" },
  { key: "input_text", label: "Input text", detail: "Send a complete value through the verified iOS keyboard" },
  { key: "phone_key", label: "Phone key", detail: "Send Back, Enter, or phone Home" },
  { key: "wait", label: "Wait", detail: "Pause a deterministic workflow step" },
];

function CopyCodeButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button type="button" className="copy-code-button" onClick={() => void copy()}>
      {copied ? <CheckCircle size={14} weight="fill" /> : <Code size={14} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CodeSample({ title, value }: { title: string; value: string }) {
  return (
    <section className="developer-code-card">
      <div><strong>{title}</strong><CopyCodeButton value={value} /></div>
      <pre>{value}</pre>
    </section>
  );
}

function ConnectionsWorkspace({
  devices,
  endpoint,
  endpointError,
  onOpenDevice,
  onAutoSetup,
  onDisconnect,
}: {
  devices: PhoneUseDevice[];
  endpoint: ControlPlaneEndpoint | null;
  endpointError: string;
  onOpenDevice: (deviceId: string) => void;
  onAutoSetup: (device: PhoneUseDevice) => void;
  onDisconnect: () => void;
}) {
  const installCommand = "curl -fsSL --proto '=https' --tlsv1.2 https://phoneuse.com/install.sh | bash";
  return (
    <div className="platform-view connections-view">
      <section className="platform-hero">
        <div>
          <span className="platform-eyebrow"><PlugsConnected size={15} /> {endpoint?.remote ? "Private cloud session" : "Local-first runtime"}</span>
          <h1>{endpoint?.remote ? "Connection & device readiness" : "Station setup"}</h1>
          <p>{endpoint?.remote ? "Check your connection and the readiness of your assigned devices. Your operator manages hardware setup." : "Connect your camera and controller, verify the phone, then assign access to your customers."}</p>
        </div>
        <div className={`runtime-card ${endpointError ? "offline" : ""}`}>
          <span className="system-dot" />
          <div><strong>{endpointError ? `${endpoint?.remote ? "Remote gateway" : "Local service"} offline` : `${endpoint?.remote ? "Remote gateway" : "Local service"} healthy`}</strong><small>{endpoint?.baseUrl ?? "http://127.0.0.1:3013"}</small></div>
          {endpoint?.remote ? <button type="button" className="disconnect-station" onClick={onDisconnect}>Disconnect</button> : null}
        </div>
      </section>

      {!endpoint?.remote && <section className="setup-grid">
        {[
          ["01", "Run guided setup", "Check the Mac, install dependencies, and start the local platform with one documented flow.", installCommand],
          ["02", "Bind USB hardware", "Assign a stable device ID to one controller topology and one camera identity.", "config/device-fleet.json"],
          ["03", "Recognize the phone", "Choose its model once, verify the detected screen, and let PhoneUse remember it.", "Automatic setup"],
          ["04", "Verify your integration", "Run health checks, inspect OpenAPI, and send idempotent test actions.", "phonebase doctor"],
        ].map(([number, title, detail, command]) => (
          <article className="setup-step" key={number}>
            <span>{number}</span>
            <div><strong>{title}</strong><p>{detail}</p><code>{command}</code></div>
          </article>
        ))}
      </section>}

      <section className="connection-section">
        <div className="platform-section-heading">
          <div><strong>Connected hardware</strong><span>Every safety dependency is visible before control is enabled.</span></div>
          <span>{devices.length} device{devices.length === 1 ? "" : "s"}</span>
        </div>
        {devices.length ? (
          <div className="connection-table">
            <div className="connection-row connection-head">
              <span>Device</span><span>Camera</span><span>Controller</span><span>{endpoint?.remote ? "Preparation" : "Homing"}</span><span>Touch gate</span><span />
            </div>
            {devices.map((device, index) => (
              <div className="connection-row" key={device.id}>
                <div className="connection-device"><DeviceMobile size={19} /><span><strong>{titleFor(device, index)}</strong><small>{device.id}</small></span></div>
                <span className={device.state?.cameraReady ? "good" : "bad"}>{device.state?.cameraReady ? "Live" : "Missing"}</span>
                <span className={device.state?.grbl?.connected ? "good" : "bad"}>{device.state?.grbl?.connected ? "Connected" : "Offline"}</span>
                <span className={device.state?.grbl?.homed ? "good" : "warn"}>{device.state?.grbl?.homed ? "Complete" : endpoint?.remote ? "Operator required" : "Required"}</span>
                <span className={device.capabilities.actions.tap.available ? "good" : "warn"}>{connectionLabel(device, endpoint?.remote)}</span>
                <div className="connection-actions">
                  <button type="button" onClick={() => onOpenDevice(device.id)}>Open</button>
                  {!endpoint?.remote ? <button type="button" disabled={!device.connected} onClick={() => onAutoSetup(device)}>Auto setup</button> : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="platform-empty"><PlugsConnected size={34} weight="thin" /><strong>{endpoint?.remote ? "No assigned device is available" : "No hardware registered"}</strong><p>{endpoint?.remote ? "Ask your operator to confirm your assignment and check the station hardware." : "Connect a supported controller and UVC camera, then follow the station setup guide."}</p><Link href={endpoint?.remote ? "/docs/errors" : "/docs/station-setup"}>View troubleshooting guide →</Link></div>
        )}
      </section>

      {!endpoint?.remote && <section className="local-surfaces">
        <article><SquaresFour size={20} /><strong>Dashboard</strong><span>Human operation and live video</span><code>127.0.0.1:3020</code></article>
        <article><Code size={20} /><strong>Control API</strong><span>REST, receipts, and WebSocket frames</span><code>127.0.0.1:3013</code></article>
        <article><CirclesFour size={20} /><strong>MCP server</strong><span>Typed tools for compatible developer platforms</span><code>phonebase mcp</code></article>
      </section>}
    </div>
  );
}

function RentalsWorkspace({
  devices,
  endpoint,
}: {
  devices: PhoneUseDevice[];
  endpoint: ControlPlaneEndpoint;
}) {
  const [leases, setLeases] = useState<RentalLeaseView[]>([]);
  const [configured, setConfigured] = useState(false);
  const [configurationError, setConfigurationError] = useState("");
  const [consoleUrl, setConsoleUrl] = useState("https://phoneuse.com/console");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customer, setCustomer] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [copiedLeaseId, setCopiedLeaseId] = useState("");

  const loadRentals = useCallback(async () => {
    try {
      const response = await controlPlaneFetch(endpoint, "/api/v1/admin/rentals", { cache: "no-store" });
      const payload = await response.json() as RentalsResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || `Rental service returned ${response.status}`);
      setLeases(payload.leases);
      setConfigured(payload.configured);
      setConfigurationError(payload.configurationError);
      setConsoleUrl(payload.consoleUrl);
      setError("");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not load rentals");
    }
  }, [endpoint]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadRentals(), 0);
    const timer = window.setInterval(() => void loadRentals(), 5_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [loadRentals]);

  const activeDeviceIds = useMemo(() => new Set(
    leases.filter((lease) => lease.status === "active").flatMap((lease) => lease.deviceIds ?? [lease.deviceId]),
  ), [leases]);
  const availableDevices = useMemo(
    () => devices.filter((device) => device.connected && !activeDeviceIds.has(device.id)),
    [activeDeviceIds, devices],
  );
  const selectedDeviceIds = selectedIds.filter(id => availableDevices.some(device => device.id === id));

  const createRental = async (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedDeviceIds.length || !customer.trim()) return;
    setBusyAction("create");
    setError("");
    try {
      const response = await controlPlaneFetch(endpoint, "/api/v1/admin/rentals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceIds: selectedDeviceIds, customer: customer.trim() }),
      });
      const payload = await response.json() as { error?: string; lease?: RentalLeaseView };
      if (!response.ok || !payload.lease) throw new Error(payload.error || `Rental creation failed (${response.status})`);
      setCustomer("");
      setSelectedIds([]);
      await loadRentals();
      const customerAccess = payload.lease.accessCode ?? payload.lease.accessLink;
      if (customerAccess) {
        try {
          await navigator.clipboard.writeText(customerAccess);
          setCopiedLeaseId(payload.lease.id);
        } catch {
          setError("Access created. Clipboard unavailable; copy the access code from the row below.");
        }
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not create this rental");
    } finally {
      setBusyAction("");
    }
  };

  const changeRental = async (lease: RentalLeaseView, operation: "renew" | "revoke") => {
    if (operation === "revoke" && !window.confirm(`Revoke access for ${lease.customer}?`)) return;
    setBusyAction(`${operation}:${lease.id}`);
    setError("");
    try {
      const response = await controlPlaneFetch(
        endpoint,
        `/api/v1/admin/rentals/${encodeURIComponent(lease.id)}/${operation}`,
        { method: "POST" },
      );
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || `Rental ${operation} failed (${response.status})`);
      await loadRentals();
    } catch (value) {
      setError(value instanceof Error ? value.message : `Could not ${operation} this rental`);
    } finally {
      setBusyAction("");
    }
  };

  const copyCustomerLink = async (lease: RentalLeaseView, invitation = false) => {
    const customerAccess = invitation ? lease.accessLink : lease.accessCode ?? lease.accessLink;
    if (!customerAccess) return;
    try {
      await navigator.clipboard.writeText(customerAccess);
      setCopiedLeaseId(invitation ? `${lease.id}:link` : lease.id);
      window.setTimeout(() => setCopiedLeaseId(""), 1_800);
    } catch {
      setError("Could not copy. Expand Private access code to select and copy the code manually.");
    }
  };

  const activeCount = leases.filter((lease) => lease.status === "active").length;
  const formatDate = (value: string) => new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));

  return (
    <div className="platform-view rentals-view">
      <section className="platform-hero rentals-hero">
        <div>
          <span className="platform-eyebrow"><Key size={15} /> ACCESS MANAGEMENT</span>
          <h1>Customer access</h1>
          <p>Create one private customer link. It stays the same through renewals and station restarts, until you revoke the rental.</p>
        </div>
        <div className={`runtime-card ${configured ? "" : "offline"}`}>
          <span className="system-dot" />
          <div><strong>{configured ? "Remote access ready" : "One-time setup required"}</strong><small>{configured ? new URL(consoleUrl).host : "Station gateway is not configured"}</small></div>
        </div>
      </section>

      <section className="rental-summary" aria-label="Rental summary">
        <article><strong>{devices.filter((device) => device.connected).length}</strong><span>Connected devices</span></article>
        <article><strong>{activeCount}</strong><span>Active rentals</span></article>
        <article><strong>{availableDevices.length}</strong><span>Available now</span></article>
      </section>

      {!configured ? (
        <div className="rental-config-warning"><WarningCircle size={20} weight="fill" /><div><strong>Remote access needs one-time station setup.</strong><span>{configurationError || "Finish the HTTPS gateway configuration before creating customer access."} Daily rental management will stay in this page.</span></div></div>
      ) : null}
      {error ? <div className="rental-error"><WarningCircle size={18} weight="fill" />{error}</div> : null}

      <section className="rental-create-card">
        <div className="platform-section-heading"><div><strong>Assign devices to a customer</strong><span>The customer receives one fixed link and sees only the selected devices.</span></div><span>No terminal needed</span></div>
        <form className="rental-form" onSubmit={(event) => void createRental(event)}>
          <fieldset className="rental-device-picker"><legend>Assigned devices ({selectedDeviceIds.length})</legend>{availableDevices.length ? availableDevices.map(device => <label key={device.id}><input type="checkbox" checked={selectedDeviceIds.includes(device.id)} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, device.id] : ids.filter(id => id !== device.id))} /><span>{device.id}</span></label>) : <p>No connected, unassigned devices available.</p>}</fieldset>
          <label><span>Company or customer</span><input required maxLength={200} value={customer} onChange={(event) => setCustomer(event.target.value)} placeholder="Acme Robotics · developer team" /></label>
          <button type="submit" disabled={!configured || !selectedDeviceIds.length || !customer.trim() || busyAction === "create"}>{busyAction === "create" ? "Creating…" : "Create & copy access code"}</button>
        </form>
      </section>

      <section className="rental-list-section">
        <div className="platform-section-heading"><div><strong>Customers and access</strong><span>Codes stop working immediately after revocation or expiry.</span></div><span>{leases.length} total</span></div>
        {leases.length ? <div className="rental-list">
          {leases.map((lease) => (
            <article className="rental-row" key={lease.id}>
              <div className="rental-customer"><span className="rental-avatar">{lease.customer.slice(0, 1).toUpperCase()}</span><div><strong>{lease.customer}</strong><small>{(lease.deviceIds ?? [lease.deviceId]).join(" · ")}</small></div></div>
              <div className="rental-period"><span>Expires</span><strong>{formatDate(lease.expiresAt)}</strong></div>
              <span className={`rental-status ${lease.status}`}>{lease.status}</span>
              <div className="rental-code">{lease.accessLink ? <><details><summary>Private access code</summary><code>{lease.accessCode}</code></details><button type="button" onClick={() => void copyCustomerLink(lease)}><Copy size={14} />{copiedLeaseId === lease.id ? "Copied" : "Copy access code"}</button><button type="button" onClick={() => void copyCustomerLink(lease, true)}><Copy size={14} />{copiedLeaseId === `${lease.id}:link` ? "Copied" : "Copy invitation link"}</button></> : <span>Access disabled</span>}</div>
              <div className="rental-actions">
                {lease.status !== "revoked" ? <button type="button" disabled={Boolean(busyAction)} onClick={() => void changeRental(lease, "renew")}>{busyAction === `renew:${lease.id}` ? "Renewing…" : "Renew 1 month"}</button> : null}
                {lease.status !== "revoked" ? <button type="button" className="danger" disabled={Boolean(busyAction)} onClick={() => void changeRental(lease, "revoke")}>{busyAction === `revoke:${lease.id}` ? "Revoking…" : "Revoke"}</button> : null}
              </div>
            </article>
          ))}
        </div> : <div className="platform-empty"><Key size={34} weight="thin" /><strong>No rentals yet</strong><p>Select available devices above to create the first one-month customer access code.</p></div>}
      </section>
    </div>
  );
}

function DeveloperWorkspace({
  devices,
  selectedDevice,
  endpoint,
  onSelectDevice,
}: {
  devices: PhoneUseDevice[];
  selectedDevice: PhoneUseDevice | null;
  endpoint: ControlPlaneEndpoint | null;
  onSelectDevice: (deviceId: string) => void;
}) {
  const [includeKey, setIncludeKey] = useState(false);
  const privateToken = includeKey ? endpoint?.accessToken ?? "YOUR_API_KEY" : "YOUR_API_KEY";
  const baseUrl = endpoint?.baseUrl ?? "http://127.0.0.1:3013";
  const deviceId = selectedDevice?.id ?? "black-arm-01";
  const authHeader = endpoint?.remote
    ? ` \\\n  -H 'Authorization: Bearer ${privateToken}'`
    : "";
  const listExample = `curl --fail-with-body ${baseUrl}/api/v1/devices${authHeader}`;
  const statusExample = `curl --fail-with-body -X POST ${baseUrl}/api/v1/devices/${deviceId}/actions \\
  -H 'Content-Type: application/json'${authHeader} \\
  -d '{"idempotencyKey":"my-status-check-1","action":{"type":"status"}}'`;
  const mcpConfig = endpoint?.remote
    ? `mkdir -p "$HOME/.phonebase/mcp"
cd "$HOME/.phonebase/mcp"
curl --fail --proto '=https' --tlsv1.2 -O https://console.phonefarm.ai/downloads/phonebase-mcp.mjs
curl --fail --proto '=https' --tlsv1.2 -O https://console.phonefarm.ai/downloads/phonebase-mcp.mjs.sha256
shasum -a 256 -c phonebase-mcp.mjs.sha256
node phonebase-mcp.mjs --configure`
    : JSON.stringify({ mcpServers: { phonebase: {
        command: "phonebase", args: ["mcp"], env: { PHONEBASE_API_URL: baseUrl },
      } } }, null, 2);
  const firstAgentPrompt = `Use phonebase_observe on ${deviceId}. Read the returned image and live safety state. Before every physical action, use the exact frameSequence and frame size, provide a stable idempotencyKey, and wait for the final receipt.`;

  return (
    <div className="platform-view developer-view">
      <section className="developer-hero">
        <div>
          <span className="platform-eyebrow"><Code size={15} /> Developer platform</span>
          <h1>Build with API & MCP</h1>
          <p>Use your existing workspace connection to start an application or connect an AI agent.</p>
        </div>
        <div className="developer-hero-actions">
          <div><span>{endpoint?.remote ? "Station API gateway" : "Local API base"}</span><code>{baseUrl}</code></div>
          <Link href="/docs" target="_blank"><BookOpenText size={15} /> Developer docs</Link>
          <Link href="/agent-guide.txt" target="_blank"><CirclesFour size={15} /> Agent handoff</Link>
          <Link href={endpoint?.remote ? "/openapi-remote.json" : "/openapi.json"} target="_blank"><Code size={15} /> OpenAPI 3.1</Link>
        </div>
      </section>

      <div className="integration-start"><Link href="/docs/quickstart?path=api"><Code size={24} /><strong>Build with the REST API</strong><span>List devices, read a frame, then submit actions.</span><b>Follow the quickstart →</b></Link><a href="#agent-quick-connect"><Robot size={24} /><strong>Connect an AI agent</strong><span>The agent receives camera images and safety state through MCP—no separate live-view window is required.</span><b>Quick connect →</b></a></div>
      <section className="agent-connect-card" id="agent-quick-connect">
        <div className="agent-connect-heading">
          <span><Robot size={20} weight="fill" /> Agent quick connect</span>
          <strong>{endpoint?.remote ? "Your private station connection is ready" : "Local station connection"}</strong>
          <p>Download the verified bridge, run its private setup once, then import the generated configuration into your agent host. The new <code>phonebase_observe</code> tool returns the current device state, camera image, and exact coordinates in one call.</p>
        </div>
        <div className="agent-connect-actions">
          <a href="/downloads/phonebase-mcp.mjs" download><Robot size={16} /> Download MCP bridge</a>
          <Link href="/docs/mcp" target="_blank"><BookOpenText size={16} /> Setup guide</Link>
          <Link href="/downloads/phonebase-mcp.mjs.sha256" target="_blank"><ShieldCheck size={16} /> SHA-256</Link>
        </div>
      </section>
      {endpoint?.remote && <label className="integration-reveal"><input type="checkbox" checked={includeKey} onChange={event => setIncludeKey(event.target.checked)} /> Include my private API key in the examples below</label>}
      <CodeSample title="Start here · list your assigned devices" value={listExample} />
      <details className="workspace-advanced"><summary>Device capabilities and API endpoints</summary>
      <section className="capability-section">
        <div className="platform-section-heading">
          <div><strong>Capability matrix</strong><span>The live device response is the source of truth. Unavailable actions always include a reason.</span></div>
          {devices.length ? (
            <select value={selectedDevice?.id ?? ""} onChange={(event) => onSelectDevice(event.target.value)} aria-label="Capability device">
              {devices.map((device) => <option value={device.id} key={device.id}>{device.id}</option>)}
            </select>
          ) : <span>No device connected</span>}
        </div>
        <div className="capability-grid">
          <article className="capability-card">
            <div><Camera size={18} /><strong>Observation</strong></div>
            <ul>
              <li><span>Screenshot</span><b className={selectedDevice?.capabilities.observation.screenshot.available ? "available" : "unavailable"}>{selectedDevice?.capabilities.observation.screenshot.available ? "Available" : "Unavailable"}</b></li>
              <li><span>Live frames</span><b className={selectedDevice?.capabilities.observation.liveFrames.available ? "available" : "unavailable"}>{selectedDevice?.capabilities.observation.liveFrames.available ? "Available" : "Unavailable"}</b></li>
            </ul>
          </article>
          {ACTION_CAPABILITIES.filter(({ key }) => !endpoint?.remote || key !== "home").map(({ key, label, detail }) => {
            const availability = selectedDevice?.capabilities.actions[key];
            return (
              <article className="capability-card" key={key}>
                <div><HandTap size={18} /><strong>{label}</strong><b className={availability?.available ? "available" : "unavailable"}>{availability?.available ? "Available" : key === "home" && selectedDevice?.state?.grbl?.homed ? "Complete" : "Unavailable"}</b></div>
                <p>{detail}</p>
                {!availability?.available && availability?.reason ? <small>{availability.reason}</small> : null}
              </article>
            );
          })}
        </div>
      </section>

      <section className="api-contract-section">
        <div className="platform-section-heading"><div><strong>Infrastructure API</strong><span>Small primitives compose into reliable enterprise workflows.</span></div><span>Protocol 2026-07-29</span></div>
        <div className="endpoint-list">
          {[
            ["GET", "/api/v1/devices", "Fleet and capability state"],
            ["GET", "/api/v1/devices/:deviceId", "One device and its safety gates"],
            ["GET", "/api/v1/devices/:deviceId/screenshot", "Latest or exact camera frame"],
            ["WS", "/api/live/socket?deviceId=…", "Low-latency image stream"],
            ["POST", "/api/v1/devices/:deviceId/actions", "Submit an idempotent primitive"],
            ["GET", "/api/v1/devices/:deviceId/actions/:receiptId", "Wait for physical completion"],
          ].map(([method, path, detail]) => <div key={`${method}-${path}`}><b className={method.toLowerCase()}>{method}</b><code>{path}</code><span>{detail}</span></div>)}
        </div>
      </section>

      </details>
      <section className="developer-samples">
        <div><p className="integration-example-note">Verify the action API with a status check that does not move the arm. For physical actions, follow the fresh screenshot and receipt workflow in the documentation.</p><CodeSample title="Read controller status" value={statusExample} /></div>
        <div><p className="integration-example-note">Setup asks for your invitation and writes a verified private configuration with the actual paths and gateway. Import it into your MCP host.</p><CodeSample title="Connect through MCP" value={mcpConfig} /></div>
        <div><p className="integration-example-note">After your host discovers PhoneUse, give the agent this first instruction. It observes through the camera tool, so a human does not need to keep the live console open.</p><CodeSample title="First agent prompt" value={firstAgentPrompt} /></div>
      </section>

      <section className="developer-safety-note">
        <ShieldCheck size={22} weight="fill" />
        <div><strong>Safety remains below every integration.</strong><span>API and MCP clients cannot bypass frame freshness, device identity, homing, calibration, reachability, touch-depth limits, or the local hardware Hold.</span></div>
      </section>
    </div>
  );
}

export function DashboardContent({ cloudConsole = false }: { cloudConsole?: boolean }) {
  const [activeView, setActiveView] = useState<WorkspaceView>("devices");
  const [endpoint, setEndpoint] = useState<ControlPlaneEndpoint | null>(null);
  const [endpointError, setEndpointError] = useState("");
  const [endpointResolved, setEndpointResolved] = useState(cloudConsole);
  const [devices, setDevices] = useState<PhoneUseDevice[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [controlEnabled, setControlEnabled] = useState(false);
  const [toast, setToast] = useState("");
  const [fullscreenDevice, setFullscreenDevice] = useState<PhoneUseDevice | null>(null);
  const [placementDevice, setPlacementDevice] = useState<PhoneUseDevice | null>(null);
  const [autoSetupDevice, setAutoSetupDevice] = useState<PhoneUseDevice | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rentalExpiresAt, setRentalExpiresAt] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const resolved = resolveControlPlaneEndpoint({ remoteOnly: cloudConsole });
      setEndpoint(resolved.endpoint);
      setEndpointError(resolved.error);
      setEndpointResolved(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cloudConsole]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const demo = new URLSearchParams(window.location.search).get("demo") === "1";
      if (demo) {
        const next = demoDevices();
        if (!cancelled) {
          setDevices(next);
          setSelectedId((current) => current || next[0].id);
        }
        return;
      }
      if (!endpoint) {
        if (!cancelled) setDevices([]);
        return;
      }
      try {
        const response = await controlPlaneFetch(endpoint, "/api/v1/devices", { cache: "no-store" });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({})) as { error?: string };
          if (!cancelled && (response.status === 401 || response.status === 403)) {
            setDevices([]);
            setSelectedId("");
            setControlEnabled(false);
            setRentalExpiresAt("");
          }
          throw new Error(detail.error || `Control plane returned ${response.status}`);
        }
        const payload = await response.json() as DevicesResponse;
        if (!cancelled) {
          setDevices(payload.devices);
          setRentalExpiresAt(payload.rental?.expiresAt ?? "");
          setEndpointError("");
          setSelectedId((current) => payload.devices.some((device) => device.id === current)
            ? current
            : payload.devices[0]?.id ?? "");
        }
      } catch (error) {
        if (!cancelled) setEndpointError(error instanceof Error ? error.message : "Control plane unavailable");
      }
    };
    void refresh();
    const timer = window.setInterval(
      refresh,
      endpoint?.remote ? REMOTE_POLL_INTERVAL_MS : LOCAL_POLL_INTERVAL_MS,
    );
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [endpoint]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3_200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filteredDevices = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return devices;
    return devices.filter((device, index) => `${device.id} ${titleFor(device, index)}`.toLowerCase().includes(needle));
  }, [devices, query]);

  const onlineCount = devices.filter((device) => device.connected).length;
  const readyCount = devices.filter((device) => device.capabilities.actions.tap.available).length;
  const liveCount = devices.filter((device) => device.connected && device.capabilities.observation.liveFrames.available).length;
  const selectedDevice = devices.find((device) => device.id === selectedId) ?? null;
  const focusedDevice = fullscreenDevice
    ? devices.find((device) => device.id === fullscreenDevice.id) ?? fullscreenDevice
    : null;
  const controlActive = controlEnabled;
  useEffect(()=>{
    const id=selectedDevice?.id ?? devices.find(d=>!d.demo)?.id;
    if(endpoint && id)reportTelemetry(endpoint,id,{kind:"ui.navigation",view:activeView});
  },[activeView,endpoint,selectedDevice?.id]);
  useEffect(()=>{
    const id=selectedDevice?.id ?? devices.find(d=>!d.demo)?.id;
    if(endpoint && id)reportTelemetry(endpoint,id,{kind:"ui.control",status:controlEnabled?"enabled":"disabled"});
  },[controlEnabled,endpoint,selectedDevice?.id]);

  useEffect(()=>{
    const id=selectedDevice?.id ?? devices.find(d=>!d.demo)?.id;
    if(!endpoint || !id)return;
    const click=(event:MouseEvent)=>{
      const control=(event.target as Element)?.closest?.("button,a,select,input[type=checkbox]");
      if(!control)return;
      // Never read input values, hrefs (which can contain credentials), or phone pixels.
      const label=(control.getAttribute("aria-label") || control.textContent || control.tagName)
        .replace(/pb_connect_v1\.[^\s]+|pb_[a-zA-Z0-9_-]{8,}|[a-zA-Z0-9_-]{32,}/g,"[redacted]").trim().slice(0,100);
      reportTelemetry(endpoint,id,{kind:"ui.interaction",view:activeView,control:label});
    };
    const clientError=()=>reportTelemetry(endpoint,id,{kind:"client.error",view:activeView,code:"UNHANDLED_BROWSER_ERROR"});
    document.addEventListener("click",click,true);
    window.addEventListener("error",clientError);window.addEventListener("unhandledrejection",clientError);
    return()=>{document.removeEventListener("click",click,true);window.removeEventListener("error",clientError);window.removeEventListener("unhandledrejection",clientError)};
  },[endpoint,selectedDevice?.id,activeView]);

  const activateVideo = useCallback(async (device: PhoneUseDevice) => {
    if (!endpoint || endpoint.remote || device.demo) return;
    try {
      const response = await controlPlaneFetch(endpoint, "/api/v1/admin/video-focus", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceId: device.id }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to start live video");
      setSelectedId(device.id);
      if (device.state?.videoCapture?.scheduled === false) setToast(`Starting live video for ${device.id}`);
    } catch (error) { setToast(error instanceof Error ? error.message : "Unable to start live video"); }
  }, [endpoint]);
  const openDeviceSetup = useCallback((device: PhoneUseDevice) => {
    void activateVideo(device);
    setAutoSetupDevice(device);
  }, [activateVideo]);

  const openFullscreen = useCallback((device: PhoneUseDevice) => {
    void activateVideo(device);
    setFullscreenDevice(device);
    if (!document.fullscreenElement && typeof document.documentElement.requestFullscreen === "function") {
      void document.documentElement.requestFullscreen().catch(() => {
        // Keep the in-page focus mode available when browser fullscreen is blocked.
      });
    }
  }, [activateVideo]);

  const closeFullscreen = useCallback(() => {
    setFullscreenDevice(null);
    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      void document.exitFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!focusedDevice) return;
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) setFullscreenDevice(null);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [focusedDevice]);

  useEffect(() => {
    if (endpoint?.remote || placementDevice || autoSetupDevice) return;
    const target = devices.find((device) =>
      !device.demo &&
      device.connected &&
      !device.capabilities.actions.tap.available &&
      // Busy, a transient stream interruption, and a held controller are not
      // reasons to interrupt an operator with the calibration workflow.
      (device.state?.grbl?.homed === false ||
        /calibrat|screen map|reference/i.test(device.capabilities.actions.tap.reason ?? ""))
    );
    if (!target) return;
    const key = `phonebase-placement-shown:${target.id}`;
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, "1");
    const timer = window.setTimeout(() => {
      setAutoSetupDevice(target);
      setSelectedId(target.id);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoSetupDevice, devices, endpoint?.remote, placementDevice]);

  const sendAction = useCallback(async (device: PhoneUseDevice, action: ActionPayload) => {
    if (device.demo) {
      setToast(`${action.type.replace("_", " ")} sent to ${device.id}`);
      return true;
    }
    if (!endpoint) {
      setToast("The PhoneUse station is not connected");
      return false;
    }
    try {
      const response = await controlPlaneFetch(endpoint, `/api/v1/devices/${encodeURIComponent(device.id)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `dashboard-${device.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          action,
        }),
      });
      const payload = await response.json() as {
        error?: string;
        receipt?: { id?: string; status?: string; error?: string };
        result?: { receipt?: { id?: string; status?: string; error?: string } };
      };
      if (!response.ok) throw new Error(payload.error || `Action failed (${response.status})`);
      const actionLabel = action.type.replace("_", " ");
      const deviceLabel = titleFor(device, devices.indexOf(device));
      const receipt = payload.result?.receipt ?? payload.receipt;
      if (receipt?.status === "completed") {
        setToast(`${actionLabel} completed on ${deviceLabel}`);
      } else if (receipt?.id) {
        setToast(`${actionLabel} accepted · arm moving on ${deviceLabel}`);
        const receiptId = receipt.id;
        void (async () => {
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            try {
              const receiptResponse = await controlPlaneFetch(
                endpoint,
                `/api/v1/devices/${encodeURIComponent(device.id)}/actions/${encodeURIComponent(receiptId)}`,
                { cache: "no-store" },
              );
              const receiptPayload = await receiptResponse.json() as {
                error?: string;
                receipt?: { status?: string; error?: string };
              };
              if (!receiptResponse.ok) {
                throw new Error(receiptPayload.error || `Receipt failed (${receiptResponse.status})`);
              }
              if (receiptPayload.receipt?.status === "completed") {
                setToast(`${actionLabel} completed on ${deviceLabel}`);
                return;
              }
              if (receiptPayload.receipt?.status === "failed") {
                setToast(receiptPayload.receipt.error || `${actionLabel} failed on ${deviceLabel}`);
                return;
              }
            } catch (error) {
              setToast(error instanceof Error ? error.message : `${actionLabel} receipt unavailable`);
              return;
            }
          }
          setToast(`${actionLabel} is still running · check device status before retrying`);
        })();
      } else {
        setToast(`${actionLabel} accepted by ${deviceLabel}`);
      }
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Action failed");
      return false;
    }
  }, [devices, endpoint]);

  const holdAll = async () => {
    const online = devices.filter((device) => device.connected);
    if (!online.length) return;
    setBusy(true);
    const results = await Promise.all(online.map((device) => sendAction(device, { type: "hold" })));
    setControlEnabled(false);
    setBusy(false);
    const accepted = results.filter(Boolean).length;
    setToast(accepted === online.length ? `Hold requested for ${accepted} device${accepted === 1 ? "" : "s"}. Check device status to confirm motion has stopped.` : `Hold accepted by ${accepted} of ${online.length} devices. Check the remaining devices and use the station’s physical Hold if needed.`);
  };

  const toggleControl = async () => {
    if (controlActive) {
      setControlEnabled(false);
      return;
    }
    if (readyCount > 0) {
      setControlEnabled(true);
      return;
    }

    if (devices.some(device => device.state?.grbl?.activeOperation?.status === "running")) {
      setToast("Wait for the current operation to finish.");
      return;
    }
    const resumable = devices.find((device) =>
      device.connected && device.capabilities.actions.resume.available
    );
    if (resumable) {
      setBusy(true);
      try {
        const accepted = await sendAction(resumable, { type: "resume" });
        if (accepted) {
          setControlEnabled(true);
          setSelectedId(resumable.id);
          setToast(`Controller resumed for ${titleFor(resumable, devices.indexOf(resumable))}; control will enable when Idle is confirmed`);
        }
      } finally {
        setBusy(false);
      }
      return;
    }

    const target = selectedDevice?.connected
      ? selectedDevice
      : devices.find((device) => device.connected) ?? null;
    if (!target) {
      setToast("Connect a PhoneUse camera and controller first");
      return;
    }

    setControlEnabled(false);
    setSelectedId(target.id);
    setDetailsOpen(true);
    setToast(`Control paused: ${actionError(target, true, endpoint?.remote)}`);
    if (!endpoint?.remote) setAutoSetupDevice(target);
  };

  const homeMachine = async (device: PhoneUseDevice) => {
    const confirmed = window.confirm(
      `Home ${titleFor(device, devices.indexOf(device))}?\n\n` +
      "The arm will move through its homing cycle. Keep hands, cables, and loose objects clear, then click OK.",
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await sendAction(device, {
        type: "home",
        confirmation: "CLEAR_WORKSPACE_AND_HOME",
      });
    } finally {
      setBusy(false);
    }
  };

  const disconnectStation = () => {
    forgetRemoteEndpoint();
    setEndpoint(null);
    setEndpointError("");
    setDevices([]);
    setRentalExpiresAt("");
    setSelectedId("");
    setControlEnabled(false);
    setDetailsOpen(false);
  };

  if (endpointResolved && !endpoint) {
    return (
      <CloudPairing
        key={endpointError}
        initialError={endpointError}
        onConnected={(nextEndpoint) => {
          setEndpoint(nextEndpoint);
          setEndpointError("");
        }}
      />
    );
  }

  return (
    <main className="device-wall-shell">
      <a className="workspace-skip" href="#workspace-content">Skip to workspace</a>
      <aside className="wall-rail" aria-label="Primary navigation">
        <Link href="/" className="wall-mark"><CirclesFour size={25} weight="fill" /><strong>phoneuse</strong><small>REAL DEVICE CLOUD</small></Link>
        <div className="rail-context"><span className="system-dot" /><div><strong>{endpoint?.remote ? "Customer workspace" : "Station workspace"}</strong><small>{endpoint?.remote ? "Assigned devices" : "Local operator"}</small></div></div>
        <span className="rail-label">WORKSPACE</span>
        <nav>
          {([
            ["devices", "Devices", SquaresFour],
            ...(!endpoint?.remote ? [["agent", "AI Operator", Robot]] : []),
            ...(!endpoint?.remote ? [["recorder", "Recorder", Record]] : []),
            ...(!endpoint?.remote ? [["publishing", "Publishing", Camera]] : []),
            ["connections", endpoint?.remote ? "Connection" : "Station setup", PlugsConnected],
            ...(!endpoint?.remote ? [["rentals", "Customer access", Key], ["activity", "Activity & incidents", ListBullets]] : []),
            ["developer", "API & MCP", Code],
          ] as const).map(([view, label, Icon]) => <button key={view as string} type="button" className={activeView === view ? "active" : ""} aria-current={activeView === view ? "page" : undefined} onClick={() => { setActiveView(view as WorkspaceView); setDetailsOpen(false); }}><Icon size={20} /><span>{label as string}</span></button>)}
        </nav>
        <div className="rail-bottom"><Link href="/docs"><BookOpenText size={19} /><span>Documentation</span></Link><Link href="/docs/errors"><WarningCircle size={19} /><span>Help & troubleshooting</span></Link>{endpoint?.remote && <button type="button" onClick={disconnectStation}><ArrowLeft size={18} /><span>Disconnect</span></button>}<small>PhoneUse Cloud Beta</small></div>
      </aside>

      <section className="wall-workspace" id="workspace-content" tabIndex={-1}>
        {activeView === "devices" ? <>
        <div className="workspace-heading"><div><span className="platform-eyebrow">{endpoint?.remote ? "YOUR WORKSPACE" : "FLEET OVERVIEW"}</span><h1>Devices</h1><p>{endpoint?.remote ? "Your assigned devices, ready for your next workflow." : "Monitor your devices and manage physical interaction."}</p></div><Link href="/docs/console"><BookOpenText size={17} /> How to use the console</Link></div>
        {devices.some(device => device.demo) && <div className="workspace-notice" role="status">Demo workspace · Sample screens and simulated actions. No physical device is controlled.</div>}
        <header className="wall-header">
          <div className="wall-title">
            <strong>{devices.length} device{devices.length === 1 ? "" : "s"}</strong>
            <span>{onlineCount} online · {readyCount} ready</span>
          </div>
          <label className="wall-search">
            <MagnifyingGlass size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search devices" aria-label="Search devices" />
            {query && <button type="button" aria-label="Clear device search" onClick={() => setQuery("")}><X size={15} /></button>}
          </label>
          <div className="wall-header-actions" hidden={devices.length === 0}>
            <button type="button" className="filter-button" onClick={() => setDetailsOpen((value) => !value)}><SlidersHorizontal size={16} /> Details</button>
            <button type="button" className="hold-button" disabled={busy || onlineCount === 0} onClick={() => void holdAll()}><Pause size={16} weight="fill" /> Hold all</button>
            <button
              type="button"
              className={`control-toggle ${controlActive ? "enabled" : ""}`}
              disabled={busy || onlineCount === 0}
              onClick={() => { if (endpoint?.remote && readyCount === 0) { setActiveView("connections"); return; } void toggleControl(); }}
            >
              <HandTap size={17} weight={controlActive ? "fill" : "regular"} />
              {controlActive ? "Disable control" : readyCount === 0 ? devices.some(device => device.state?.grbl?.activeOperation?.status === "running") ? "Operation in progress" : endpoint?.remote ? "Check device status" : "Complete setup" : "Enable control"}
            </button>
          </div>
        </header>

        <div className="wall-statusbar">
          <div><span className={`system-dot ${endpointError ? "error" : ""}`} />{endpointError ? `${endpoint?.remote ? "Remote gateway" : "Local service"} unavailable` : `${endpoint?.remote ? "Remote gateway" : "Local system"} healthy`}</div>
          <div className="statusbar-center">
            <span><WifiHigh size={14} /> {liveCount} live video</span>
            <span><ShieldCheck size={14} /> {readyCount} ready for touch</span>
            {controlActive ? <span className="control-warning"><WarningCircle size={14} weight="fill" /> Physical control is live</span> : <span>View-only mode</span>}
          </div>
          <span>{rentalExpiresAt
            ? `Rental until ${new Date(rentalExpiresAt).toLocaleDateString()}`
            : endpoint?.remote ? "Private connection" : "Local connection"}</span>
        </div>

        {endpoint && !endpoint.remote && !devices.some(device => device.demo) && <FleetDiscoveryPanel endpoint={endpoint} />}

        {devices.length === 0 ? (
          <div className="wall-empty-state">
            <span className="empty-state-icon">{endpointError ? <WifiSlash size={32} /> : <PlugsConnected size={32} />}</span>
            <strong>{endpointError ? "We can’t reach your station" : endpoint?.remote ? "Your workspace is connected" : "Let’s connect your first device"}</strong>
            <p>{endpoint?.remote ? endpointError ? "Your connection may have expired, or the station may be offline. Check your connection details or use a new invitation." : "No assigned devices are available yet. Ask your operator to check your device assignment and bring the station online. Devices will appear here automatically." : endpointError ? "Check that the local PhoneUse service is running, then review the station connection." : "Connect the camera and controller, then follow station setup to make your device ready for control."}</p>
            <div className="empty-state-actions"><button type="button" onClick={() => setActiveView("connections")}>{endpoint?.remote ? "Connection details" : "Open station setup"}<ArrowRight size={17} /></button><Link href={endpoint?.remote ? "/docs/errors" : "/docs/station-setup"}>{endpoint?.remote ? "Troubleshoot access" : "Read setup guide"}</Link></div>
            {endpoint?.remote && endpointError && <button className="empty-text-button" type="button" onClick={disconnectStation}>Use another invitation</button>}
            <small>{endpointError ? "The workspace will reconnect automatically when available." : "This page updates automatically. No refresh needed."}</small>
          </div>
        ) : filteredDevices.length === 0 ? <div className="wall-empty-state"><MagnifyingGlass size={32} /><strong>No matching devices</strong><p>Try a different name or device ID.</p><button className="empty-text-button" type="button" onClick={() => setQuery("")}>Clear search</button></div> : focusedDevice ? null : (
          <div className="device-grid compact">
            {filteredDevices.map((device) => (
              <DeviceTile
                key={device.id}
                device={device}
                index={devices.indexOf(device)}
                endpoint={endpoint}
                controlEnabled={controlActive && !focusedDevice}
                selected={selectedId === device.id}
                onSelect={() => setSelectedId(device.id)}
                onActivateVideo={() => void activateVideo(device)}
                onInspect={() => { setSelectedId(device.id); setDetailsOpen(true); }}
                onAction={sendAction}
                onFullscreen={openFullscreen}
                onPosition={openDeviceSetup}
                onControlToggle={() => void toggleControl()}
              />
            ))}
          </div>
        )}</> : null}

        {activeView === "connections" ? (
          <ConnectionsWorkspace
            devices={devices}
            endpoint={endpoint}
            endpointError={endpointError}
            onOpenDevice={(deviceId) => {
              const device = devices.find(item => item.id === deviceId);
              if (device) void activateVideo(device);
              setSelectedId(deviceId);
              setActiveView("devices");
              setDetailsOpen(true);
            }}
            onAutoSetup={openDeviceSetup}
            onDisconnect={disconnectStation}
          />
        ) : null}

        {activeView === "rentals" && endpoint && !endpoint.remote ? (
          <RentalsWorkspace devices={devices} endpoint={endpoint} />
        ) : null}

        {activeView === "activity" && endpoint && !endpoint.remote ? <ActivityWorkspace endpoint={endpoint} /> : null}
        {activeView === "agent" && endpoint && !endpoint.remote ? <AgentLabWorkspace endpoint={endpoint} devices={devices} /> : null}
        {activeView === "publishing" && endpoint && !endpoint.remote ? <PublishingWorkspace endpoint={endpoint} devices={devices} /> : null}
        {activeView === "recorder" && endpoint && !endpoint.remote ? <RecorderWorkspace endpoint={endpoint} devices={devices} onOpenDevices={(deviceId) => { setSelectedId(deviceId); setActiveView("devices"); }} /> : null}

        {activeView === "developer" ? (
          <DeveloperWorkspace
            devices={devices}
            selectedDevice={selectedDevice}
            endpoint={endpoint}
            onSelectDevice={setSelectedId}
          />
        ) : null}
      </section>

      {detailsOpen ? (
        <aside className="device-inspector">
          <div className="inspector-header"><strong>Device details</strong><button type="button" onClick={() => setDetailsOpen(false)} aria-label="Close details"><X size={17} /></button></div>
          {selectedDevice ? (
            <>
              <div className="inspector-device"><DeviceMobile size={24} /><div><strong>{titleFor(selectedDevice, devices.indexOf(selectedDevice))}</strong><span>{selectedDevice.id}</span></div></div>
              <dl>
                <div><dt>Connection</dt><dd className={selectedDevice.connected ? "good" : "bad"}>{selectedDevice.connected ? "Online" : "Offline"}</dd></div>
                <div><dt>Video</dt><dd>{selectedDevice.state?.videoMode === "wired" ? "Wired" : "Physical camera"}</dd></div>
                <div><dt>Controller</dt><dd>{selectedDevice.state?.grbl?.connected ? "Connected" : "Disconnected"}</dd></div>
                <div><dt>Motion state</dt><dd>{selectedDevice.state?.grbl?.state ?? "Unknown"}</dd></div>
                <div><dt>{endpoint?.remote ? "Preparation" : "Homing"}</dt><dd>{selectedDevice.state?.grbl?.homed ? "Complete" : endpoint?.remote ? "Operator required" : "Required"}</dd></div>
                <div><dt>Control</dt><dd>{connectionLabel(selectedDevice, endpoint?.remote)}</dd></div>
              </dl>
              {!selectedDevice.capabilities.actions.tap.available ? <div className="inspector-notice"><ShieldCheck size={18} /><p><strong>{connectionLabel(selectedDevice, endpoint?.remote)}</strong><span>{actionError(selectedDevice, true, endpoint?.remote)}</span></p></div> : null}
              {!endpoint?.remote && selectedDevice.capabilities.actions.home.available ? (
                <button type="button" className="inspector-position-button inspector-home-button" disabled={busy} onClick={() => void homeMachine(selectedDevice)}>
                  <Crosshair size={17} /> {busy ? "Starting homing…" : "Home machine"}
                </button>
              ) : null}
              {selectedDevice.capabilities.actions.resume.available ? (
                <button type="button" className="inspector-position-button" disabled={busy} onClick={() => void sendAction(selectedDevice, { type: "resume" })}>
                  <HandTap size={17} /> Resume from Hold
                </button>
              ) : null}
              {!endpoint?.remote ? <>
                <button type="button" className="inspector-position-button" disabled={busy || !selectedDevice.connected} onClick={() => setAutoSetupDevice(selectedDevice)}>
                  <CirclesFour size={17} /> Automatic phone setup
                </button>
                <button type="button" className="inspector-position-button" disabled={busy || !selectedDevice.state?.grbl?.homed} onClick={() => setPlacementDevice(selectedDevice)}>
                  <Crosshair size={17} /> Manual calibration
                </button>
              </> : null}
              <div className="api-example"><div><Code size={15} /> Infrastructure API</div><pre>{`POST /api/v1/devices/${selectedDevice.id}/actions\n{ "action": { "type": "tap", ... } }`}</pre></div>
            </>
          ) : <p className="inspector-placeholder">Select a device to inspect its connection and safety state.</p>}
        </aside>
      ) : null}

      {focusedDevice ? (
        <div className="fullscreen-layer" role="dialog" aria-modal="true" aria-label={`${focusedDevice.id} focus mode`}>
          <DeviceTile
            device={focusedDevice}
            index={devices.indexOf(focusedDevice)}
            endpoint={endpoint}
            controlEnabled={controlActive}
            selected={selectedId === focusedDevice.id}
            onSelect={() => setSelectedId(focusedDevice.id)}
            onActivateVideo={() => void activateVideo(focusedDevice)}
            onAction={sendAction}
            onFullscreen={() => {}}
            onPosition={openDeviceSetup}
            mode="focus"
            onClose={closeFullscreen}
            onControlToggle={() => void toggleControl()}
          />
        </div>
      ) : null}

      {placementDevice && endpoint && !endpoint.remote ? (
        <PlacementModal
          device={placementDevice}
          index={devices.indexOf(placementDevice)}
          endpoint={endpoint}
          onClose={() => setPlacementDevice(null)}
        />
      ) : null}

      {autoSetupDevice && endpoint && !endpoint.remote ? (
        <AutoSetupModal
          device={autoSetupDevice}
          index={devices.indexOf(autoSetupDevice)}
          endpoint={endpoint}
          onClose={() => setAutoSetupDevice(null)}
          onComplete={setToast}
        />
      ) : null}

      {toast ? <div className="wall-toast" role="status" aria-live="polite">{toast}</div> : null}
    </main>
  );
}
