import importlib.util
from pathlib import Path
import sys
import unittest


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "scripts" / "install_supervisor_macos.py"
)
SPEC = importlib.util.spec_from_file_location("phonebase_install_supervisor", MODULE_PATH)
INSTALLER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = INSTALLER
SPEC.loader.exec_module(INSTALLER)


class InstallSupervisorTests(unittest.TestCase):
    def test_captures_a_complete_live_manual_reference(self):
        value = INSTALLER.reference_checkpoint({
            "connected": True,
            "port": "/dev/cu.usbserial-21110",
            "state": "Idle",
            "homed": True,
            "reference_mode": "manual",
            "controller_position": {"x": 5.637, "y": -12.962, "z": 1, "a": 0},
            "coordinate_offset": {"x": -12.366, "y": -33.462, "z": 0, "a": 0},
        })
        self.assertEqual(value["version"], 1)
        self.assertEqual(value["serialPort"], "/dev/cu.usbserial-21110")
        self.assertEqual(value["controllerPosition"]["z"], 1)

    def test_does_not_snapshot_a_sensor_homed_device(self):
        self.assertIsNone(INSTALLER.reference_checkpoint({
            "connected": True,
            "state": "Idle",
            "homed": True,
            "reference_mode": "sensor-home",
        }))

    def test_rejects_an_incomplete_live_manual_reference(self):
        with self.assertRaisesRegex(ValueError, "position/offset"):
            INSTALLER.reference_checkpoint({
                "connected": True,
                "port": "/dev/cu.usbserial-21110",
                "state": "Idle",
                "homed": True,
                "reference_mode": "manual",
            })


if __name__ == "__main__":
    unittest.main()
