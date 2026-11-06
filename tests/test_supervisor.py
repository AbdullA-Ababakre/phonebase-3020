import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "supervisor.py"
SPEC = importlib.util.spec_from_file_location("phonebase_supervisor", MODULE_PATH)
SUPERVISOR = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = SUPERVISOR
SPEC.loader.exec_module(SUPERVISOR)


class SupervisorTests(unittest.TestCase):
    def test_atomic_json_never_leaves_partial_target(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "status.json"
            SUPERVISOR.atomic_json(path, {"ok": True, "value": 7})
            self.assertEqual(path.read_text("utf-8"), '{\n  "ok": true,\n  "value": 7\n}\n')
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_pid_alive_rejects_missing_process(self):
        self.assertFalse(SUPERVISOR.pid_alive(None))
        self.assertTrue(SUPERVISOR.pid_alive(os.getpid()))

    def test_station_status_separates_infrastructure_from_touch(self):
        value = SUPERVISOR.station_state()
        self.assertIn("infrastructureOnline", value)
        self.assertIn("touchReady", value)
        self.assertIn("remoteOnline", value)
        self.assertIn("services", value)

    def test_tunnel_tokens_are_redacted_from_logs(self):
        value = SUPERVISOR.redacted_command([
            "cloudflared",
            "tunnel",
            "run",
            "--token",
            "top-secret-value",
        ])
        self.assertNotIn("top-secret-value", value)
        self.assertIn("[REDACTED]", value)

    @patch.object(SUPERVISOR, "AUTO_HOME", True)
    @patch.object(
        SUPERVISOR,
        "http_json",
        return_value=(True, {
            "connected": True,
            "homed": True,
            "reference_mode": "manual",
        }),
    )
    def test_reference_reconciler_accepts_an_already_ready_driver(self, _request):
        reconciler = SUPERVISOR.ReferenceReconciler()
        service = SUPERVISOR.Service("driver", ["true"])
        service.pid = os.getpid()
        service.healthy = True
        reconciler.tick(service)
        self.assertEqual(reconciler.public()["status"], "ready")


if __name__ == "__main__":
    unittest.main()
