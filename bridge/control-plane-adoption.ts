/** lsof is invoked with numeric endpoints, filtered to the expected PID/port. */
export function assertLoopbackControlPlaneListener(records: string, port: number) {
  const endpoints = records.split("\n").filter(line => line.startsWith("n")).map(line => line.slice(1));
  const allowed = new Set([`127.0.0.1:${port}`, `[::1]:${port}`]);
  if (!endpoints.length || endpoints.some(endpoint => !allowed.has(endpoint))) {
    throw new Error(`Existing control plane on ${port} is not exclusively bound to loopback; refusing adoption.`);
  }
}
