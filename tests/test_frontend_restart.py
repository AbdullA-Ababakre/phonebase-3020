import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest


class FrontendRestartTest(unittest.TestCase):
    def test_frontend_restart_preserves_fleet_and_station_shutdown_cleans_up(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copy2(Path(__file__).resolve().parents[1] / "start-local.sh", root / "start-local.sh")
            binary = root / "npm"
            binary.write_text("""#!/usr/bin/env python3
import os, pathlib, sys, time
root = pathlib.Path(os.environ['PHONEBASE_RESTART_TEST_ROOT'])
service = sys.argv[2]
(root / (service + '.pid')).write_text(str(os.getpid()))
if service == 'start:3020':
    marker = root / 'frontend-attempts'
    count = int(marker.read_text()) + 1 if marker.exists() else 1
    marker.write_text(str(count))
    if count == 1: sys.exit(1)
time.sleep(60)
""")
            binary.chmod(0o755)
            env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                   "PHONEBASE_RESTART_TEST_ROOT": str(root)}
            station = subprocess.Popen(["/bin/zsh", str(root / "start-local.sh")], env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    marker = root / "frontend-attempts"
                    if marker.exists() and marker.read_text() == "2":
                        break
                    time.sleep(0.05)
                else:
                    self.fail("frontend was not restarted")
                self.assertIsNone(station.poll())
                children = [int((root / (name + ".pid")).read_text())
                            for name in ["fleet", "vision", "start:3020"]]
                for pid in children:
                    os.kill(pid, 0)
                station.terminate()
                station.wait(timeout=5)
                deadline = time.monotonic() + 3
                remaining = list(children)
                while remaining and time.monotonic() < deadline:
                    for pid in remaining[:]:
                        try:
                            os.kill(pid, 0)
                        except ProcessLookupError:
                            remaining.remove(pid)
                    time.sleep(0.05)
                self.assertEqual(remaining, [], "station shutdown left mock child processes")
            finally:
                if station.poll() is None:
                    station.kill()
                    station.wait()


if __name__ == "__main__":
    unittest.main()
