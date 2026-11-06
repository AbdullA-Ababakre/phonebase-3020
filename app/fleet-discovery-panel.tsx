"use client";

import { useEffect, useState } from "react";
import type { FleetDiscoveryView } from "../shared/fleet-discovery-view";
import { controlPlaneFetch, type ControlPlaneEndpoint } from "./control-plane-endpoint";
import styles from "./fleet-discovery-panel.module.css";

export function FleetDiscoveryPanel({ endpoint }: { endpoint: ControlPlaneEndpoint }) {
  const [discovery, setDiscovery] = useState<FleetDiscoveryView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (endpoint.remote) return;
    let cancelled = false, refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const response = await controlPlaneFetch(endpoint, "/api/v1/admin/fleet-discovery", {
          cache: "no-store", signal: AbortSignal.timeout(4_500),
        });
        if (!response.ok) throw new Error("Hardware discovery is temporarily unavailable.");
        const body = await response.json() as { discovery: FleetDiscoveryView };
        if (!cancelled) { setDiscovery(body.discovery); setError(""); }
      } catch (error) {
        if (!cancelled) {
          setDiscovery(null);
          setError(error instanceof Error ? error.message : "Hardware discovery is temporarily unavailable.");
        }
      } finally { refreshing = false; }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [endpoint]);

  if (endpoint.remote) return null;
  const unclaimed = (discovery?.unclaimed.controllers.length ?? 0) + (discovery?.unclaimed.cameras.length ?? 0);
  const unresolved = discovery?.configured.filter(device => !device.controllerPresent || !device.cameraResolved) ?? [];
  const waitingForVideo = discovery?.configured.filter(device => device.nodeConnected && !device.liveVideo) ?? [];
  return <details className={styles.panel}>
    <summary>
      <strong>Hardware discovery</strong>
      <span>{discovery?.available
        ? `${discovery.configured.length} configured · ${unresolved.length} unresolved · ${waitingForVideo.length} waiting for video${unclaimed ? ` · ${unclaimed} unpaired components` : ""}`
        : "Checking camera and controller connections"}</span>
    </summary>
    <div className={styles.body}>
      {(error || discovery?.detail) && <p role="status" className={styles.notice}>{error || discovery?.detail}</p>}
      {discovery?.available && <>
        {!discovery.automaticEnrollment && <p className={styles.notice}>Automatic enrollment is paused for identity review. Existing stations keep working; new hardware appears below without receiving a new station ID.</p>}
        <p>Every configured station is listed here, including disconnected stations. A detected camera can still be waiting for live video.</p>
        <p className={styles.timestamp}>{discovery.stale ? "Last observation" : "Hardware checked"} {discovery.observedAt ? new Date(discovery.observedAt).toLocaleTimeString() : "—"}{discovery.discoveryPending ? " · Retrying incomplete discovery" : ""}</p>
        <div className={styles.tableScroll}><table>
          <thead><tr><th>Station</th><th>Controller</th><th>Camera identity</th><th>Live video</th><th>Connection detail</th></tr></thead>
          <tbody>{discovery.configured.map(device => <tr key={device.id}>
            <th scope="row">{device.id}</th>
            <td>{device.controllerPresent ? "Detected" : "Missing"}</td>
            <td>{device.cameraResolved ? "Resolved" : "Missing / unresolved"}</td>
            <td>{device.liveVideo ? "Live" : device.nodeConnected ? "Waiting for frames" : "Offline"}</td>
            <td>{device.reason || (device.nodeConnected ? device.liveVideo ? "Connected" : "Camera detected; no fresh video" : "Waiting for station connection")}</td>
          </tr>)}</tbody>
        </table></div>
        {unclaimed > 0 && <div className={styles.unpaired}>
          <strong>Unpaired hardware</strong>
          <p>Discovery retries automatically. Verify the physical stand label before changing an existing station binding.</p>
          {discovery.unclaimed.controllers.map(serial => <p key={serial}>Controller: <code>{serial}</code></p>)}
          {discovery.unclaimed.cameras.map(camera => <p key={camera.identity}>Camera: {camera.name} <code>{camera.identity}</code></p>)}
        </div>}
      </>}
    </div>
  </details>;
}
