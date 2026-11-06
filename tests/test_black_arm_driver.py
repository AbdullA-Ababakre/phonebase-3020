import json
import re
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bridge.black_arm_driver import (
    BlackArmDriver,
    MachineStatus,
    Position,
    latest_status_report_complete,
    nearest_park_y,
    positions_match,
)


def status(x=0.0, y=0.0, z=0.0, pins=""):
    return MachineStatus(
        ok=True,
        connected=True,
        port="/dev/cu.test",
        state="Idle",
        position=Position(x, y, z),
        normalized_z=z - 1,
        feed=0,
        spindle=0,
        latency_ms=1,
        updated_at="2026-08-08T00:00:00+0000",
        limit_pins=pins,
    )


class FakeReleaseDriver(BlackArmDriver):
    def __init__(self, release_x_at=4.0, release_z_at=1.5):
        super().__init__("/dev/cu.test")
        self.release_x_at = release_x_at
        self.release_z_at = release_z_at
        self.current = status(pins="XZ")
        self.pending = ""
        self.commands = []
        self._last_recovery = {"steps": []}

    def _send_command(self, command, timeout=1.0):
        self.pending = command
        self.commands.append(command)
        return "ok"

    def _wait_idle(self, timeout=4.0):
        x = self.current.position.x
        y = self.current.position.y
        z = self.current.position.z
        z_match = re.fullmatch(r"Z(-?\d+(?:\.\d+)?)", self.pending)
        xy_match = re.fullmatch(
            r"X(-?\d+(?:\.\d+)?)Y(-?\d+(?:\.\d+)?)",
            self.pending,
        )
        if z_match:
            z = float(z_match.group(1))
        elif xy_match:
            x = float(xy_match.group(1))
            y = float(xy_match.group(2))
        else:
            raise AssertionError(f"unexpected command: {self.pending}")
        pins = ""
        if x < self.release_x_at:
            pins += "X"
        if z < self.release_z_at:
            pins += "Z"
        self.current = status(x=x, y=y, z=z, pins=pins)
        return self.current


class ParkSelectionTests(unittest.TestCase):
    def test_selects_the_closest_verified_screen_out_park(self):
        self.assertEqual(nearest_park_y(136.8), 165.0)
        self.assertEqual(nearest_park_y(42.0), 20.5)
        self.assertEqual(nearest_park_y(92.75), 20.5)


class FakeManualReferenceDriver(BlackArmDriver):
    def __init__(self, pins="X", release_z_at=1.5):
        super().__init__("/dev/cu.test")
        self.current = status(x=8.0, y=0.0, z=1.5, pins=pins)
        self.commands = []
        self.release_z_at = release_z_at

    def _connect(self):
        return None

    def _status_locked(self):
        raw = self.current
        result = status(
            x=raw.position.x,
            y=raw.position.y,
            z=raw.position.z,
            pins=raw.limit_pins,
        )
        result.homed = self._homed
        result.controller_position = Position(**vars(raw.position))
        if self._manual_reference:
            result.position = Position(
                raw.position.x - self._coordinate_offset.x,
                raw.position.y - self._coordinate_offset.y,
                raw.position.z,
                raw.position.a,
            )
            result.reference_mode = "manual"
            result.coordinate_offset = Position(**vars(self._coordinate_offset))
        result.recovery = self._last_recovery
        return result

    def _send_command(self, command, timeout=1.0):
        self.commands.append(command)
        z_match = re.fullmatch(r"Z(-?\d+(?:\.\d+)?)", command)
        xy_match = re.fullmatch(
            r"X(-?\d+(?:\.\d+)?)Y(-?\d+(?:\.\d+)?)",
            command,
        )
        if z_match:
            self.current.position.z = float(z_match.group(1))
            if self.current.position.z >= self.release_z_at:
                self.current.limit_pins = self.current.limit_pins.replace("Z", "")
        elif xy_match:
            self.current.position.x = float(xy_match.group(1))
            self.current.position.y = float(xy_match.group(2))
        else:
            raise AssertionError(f"unexpected command: {command}")
        return "ok"

    def _wait_idle(self, timeout=4.0, *, expected_z=None):
        result = self._status_locked()
        if expected_z is not None and abs(result.position.z - expected_z) > 0.08:
            raise AssertionError("Fake controller did not reach the requested Z")
        return result


class StatusReportParsingTests(unittest.TestCase):
    def parse(self, raw):
        return BlackArmDriver._parse_status(raw, "/dev/cu.test-never-opened", 4)

    def test_latest_complete_report_clears_an_earlier_active_x(self):
        parsed = self.parse(
            "<Idle|MPos:31.500,0.000,1.000,0.000|FS:0,0|Pn:X>\r\n"
            "<Idle|MPos:32.000,0.000,1.000,0.000|FS:0,0>"
        )
        self.assertEqual(parsed.position, Position(32, 0, 1, 0))
        self.assertEqual(parsed.limit_pins, "")
        self.assertEqual(parsed.controller_report, "<Idle|MPos:32.000,0.000,1.000,0.000|FS:0,0>")
        self.assertNotIn("Pn:X", parsed.to_dict()["controller_report"])

    def test_latest_active_x_does_not_use_an_earlier_position_or_state(self):
        parsed = self.parse(
            "<Hold:0|MPos:31.500,0.000,1.000|FS:0,0>\r\n"
            "<Idle|MPos:32.000,0.000,1.000|FS:0,0|Pn:X>"
        )
        self.assertEqual(parsed.state, "Idle")
        self.assertEqual(parsed.position, Position(32, 0, 1, 0))
        self.assertEqual(parsed.limit_pins, "X")
        self.assertEqual(parsed.controller_report, "<Idle|MPos:32.000,0.000,1.000|FS:0,0|Pn:X>")

    def test_command_noise_and_pins_outside_the_selected_report_are_ignored(self):
        parsed = self.parse(
            "ok\r\nerror:20\r\n[MSG:old|Pn:X]\r\n"
            "<Idle|MPos:1.500,2.000,1.000|FS:0,0>\r\nok\r\nerror:9\r\n"
        )
        self.assertEqual(parsed.position, Position(1.5, 2, 1, 0))
        self.assertEqual(parsed.limit_pins, "")
        self.assertEqual(parsed.to_dict()["controller_report"], "<Idle|MPos:1.500,2.000,1.000|FS:0,0>")

    def test_split_report_is_rejected_until_the_same_report_is_complete(self):
        first = "<Idle|MPos:1.500,2."
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            self.parse(first)
        parsed = self.parse(first + "000,1.000|FS:0,0|Pn:X>")
        self.assertEqual(parsed.position, Position(1.5, 2, 1, 0))
        self.assertEqual(parsed.limit_pins, "X")

    def test_status_predicate_waits_for_a_trailing_partial_frame(self):
        first = "<Idle|MPos:1.000,2.000,1.000|Pn:X>\r\n<Idle|MPos:1.500,2."
        complete = first + "000,1.000>\r\nok\r\n"
        self.assertFalse(latest_status_report_complete(first))
        self.assertTrue(latest_status_report_complete(complete))
        self.assertFalse(latest_status_report_complete("ok\r\n>"))

    def test_status_reader_waits_for_the_latest_frame_before_parsing(self):
        first = "<Idle|MPos:1.000,2.000,1.000|Pn:X>\r\n<Idle|MPos:1.500,2."
        complete = first + "000,1.000>"
        driver = BlackArmDriver("/dev/cu.test-never-opened")
        driver._connect = lambda: None
        writes = []
        driver._write = writes.append
        def read(predicate, timeout):
            self.assertFalse(predicate(first))
            self.assertTrue(predicate(complete))
            return complete
        driver._read_until = read
        parsed = driver._status_locked()
        self.assertEqual(writes, [b"?"])
        self.assertEqual(parsed.position, Position(1.5, 2, 1, 0))
        self.assertEqual(parsed.limit_pins, "")
        self.assertEqual(parsed.controller_report, "<Idle|MPos:1.500,2.000,1.000>")

    def test_trailing_partial_report_never_reuses_an_older_clear_report(self):
        clear = "<Idle|MPos:1.000,2.000,1.000|FS:0,0>\r\n"
        for partial in ("<Idle|MPos:1.5", "<Idle|MPos:1.500,2.000,1.000|Pn:"):
            with self.subTest(partial=partial):
                with self.assertRaisesRegex(RuntimeError, "incomplete"):
                    self.parse(clear + partial)

    def test_malformed_newest_report_never_falls_back_or_borrows_position(self):
        old = "<Idle|MPos:1.000,2.000,1.000|FS:0,0>\r\n"
        for malformed in (
            "<Idle|Pn:X>", "<Idle|MPos:broken|Pn:X>",
            "<Idle|MPos:1.000,2.000,1.000garbage|Pn:X>",
            "<Idle|MPos:1.000,2.000,1.000|MPos:4.000,5.000,1.000>",
            "<Idle|MPos:1.000,2.000,1.000|Pn:X|Pn:>",
            "<Idle|MPos:1.000,2.000,1.000|Pn:123>",
        ):
            with self.subTest(malformed=malformed):
                with self.assertRaises(RuntimeError):
                    self.parse(old + malformed)

    def test_a_new_complete_report_can_follow_an_old_incomplete_fragment(self):
        parsed = self.parse("<Idle|MPos:old-incomplete\r\n<Idle|MPos:3.000,4.000,1.000|Pn:Y>")
        self.assertEqual(parsed.position, Position(3, 4, 1, 0))
        self.assertEqual(parsed.limit_pins, "Y")

    def test_missing_diagnostic_report_is_omitted_from_status_json(self):
        self.assertNotIn("controller_report", status().to_dict())

    def test_oversized_selected_report_is_rejected_instead_of_truncating_it(self):
        with self.assertRaisesRegex(RuntimeError, "size limit"):
            self.parse("<Idle|MPos:1.000,2.000,1.000|Extra:" + "a" * 2048 + ">")


class ControllerSettingsTests(unittest.TestCase):
    def driver(self, reply="", error=None, connected=True):
        driver = BlackArmDriver("/dev/cu.test-never-opened")
        driver._fd = 123 if connected else None
        driver.commands = []
        def no_connect():
            raise AssertionError("Settings must not open or reconnect a serial port")
        def send(command, timeout=1.0):
            driver.commands.append(command)
            if error is not None:
                raise error
            return reply
        driver._connect = no_connect
        driver._send_command = send
        return driver

    def test_settings_sends_only_the_readonly_query_over_the_existing_connection(self):
        raw = "$5=0\r\n$23=7\r\n$100=200.000 (x steps/mm)\r\nok"
        driver = self.driver(raw)
        result = driver.settings()
        self.assertEqual(driver.commands, ["$$"])
        self.assertEqual(result, {"settings": {"5": 0, "23": 7, "100": 200.0}, "raw": raw})
        self.assertFalse(driver.homed)

    def test_settings_does_not_open_a_missing_connection(self):
        driver = self.driver(connected=False)
        with self.assertRaisesRegex(RuntimeError, "existing serial connection"):
            driver.settings()
        self.assertEqual(driver.commands, [])

    def test_unsupported_query_is_reported_without_fallback(self):
        driver = self.driver(error=RuntimeError("The controller rejected '$$': error:3"))
        with self.assertRaisesRegex(RuntimeError, "rejected"):
            driver.settings()
        self.assertEqual(driver.commands, ["$$"])

    def test_unacknowledged_empty_malformed_duplicate_and_oversized_settings_fail_closed(self):
        for reply in (
            "$5=0", "ok", "$5=broken\nok", "$5=0\n$5=1\nok",
            "$5=" + "9" * 400 + "\nok", "$5=0\n" + "a" * 4096 + "\nok",
        ):
            with self.subTest(reply=reply[:60]):
                driver = self.driver(reply)
                with self.assertRaises(RuntimeError):
                    driver.settings()
                self.assertEqual(driver.commands, ["$$"])


class BlackArmDriverTests(unittest.TestCase):
    @patch("bridge.black_arm_driver.INTERACTIVE_HOVER_MS", 1_200)
    @patch("bridge.black_arm_driver.time.sleep", lambda _seconds: None)
    def test_interactive_tap_waits_at_safe_hover_until_explicit_park(self):
        driver = FakeManualReferenceDriver(pins="")
        driver._homed = True
        driver.current = status(x=18.0, y=20.5, z=1.0)

        touched = driver.tap(40.0, 80.0)

        self.assertEqual(touched.position, Position(40.0, 80.0, 1.0, 0.0))
        self.assertEqual(driver.commands, [
            "X40.000Y80.000",
            "Z10.000",
            "Z1.000",
        ])

        parked = driver.park()
        self.assertEqual(driver.commands[-1], "X18.000Y20.500")
        self.assertEqual(parked.position, Position(18.0, 20.5, 1.0, 0.0))

    @patch("bridge.black_arm_driver.INTERACTIVE_HOVER_MS", 0)
    @patch("bridge.black_arm_driver.time.sleep", lambda _seconds: None)
    def test_standard_tap_still_parks_before_returning(self):
        driver = FakeManualReferenceDriver(pins="")
        driver._homed = True
        driver.current = status(x=18.0, y=165.0, z=1.0)

        result = driver.tap(40.0, 130.0)

        self.assertEqual(driver.commands[-1], "X18.000Y165.000")
        self.assertEqual(result.position, Position(18.0, 165.0, 1.0, 0.0))

    def test_reference_restore_requires_the_full_controller_position(self):
        expected = Position(5.637, -12.962, 1.0, 0.0)
        self.assertTrue(positions_match(Position(5.64, -12.96, 1.0), expected))
        self.assertFalse(positions_match(Position(5.64, -12.7, 1.0), expected))

    @patch("bridge.black_arm_driver.RESTORE_MANUAL_REFERENCE", True)
    @patch("bridge.black_arm_driver.MAX_MANUAL_REFERENCE_OFFSET_MM", 100)
    def test_driver_restart_restores_only_an_exact_persisted_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "reference.json"
            checkpoint.write_text(json.dumps({
                "version": 1,
                "serialPort": "/dev/cu.test",
                "controllerPosition": {
                    "x": 5.637,
                    "y": -12.962,
                    "z": 1.0,
                    "a": 0.0,
                },
                "coordinateOffset": {
                    "x": -12.366,
                    "y": -33.462,
                    "z": 0.0,
                    "a": 0.0,
                },
            }), "utf-8")
            with patch(
                "bridge.black_arm_driver.MANUAL_REFERENCE_STATE_PATH",
                checkpoint,
            ):
                driver = BlackArmDriver("/dev/cu.test")
                driver._fd = 1
                driver._write = lambda _value: None
                driver._read_until = lambda _predicate, _timeout: (
                    "<Idle|MPos:5.637,-12.962,1.000,0.000|FS:0,0|Pn:X>"
                )
                driver._restore_manual_reference_locked()
                self.assertTrue(driver.homed)
                self.assertTrue(driver._manual_reference)
                self.assertEqual(
                    driver._coordinate_offset,
                    Position(-12.366, -33.462, 0, 0),
                )

    def test_status_parser_exposes_active_limit_inputs(self):
        parsed = BlackArmDriver._parse_status(
            "<Alarm|MPos:1.000,2.000,3.000,0.000|FS:0,0|Pn:XZ|WCO:0,0,0,0>",
            "/dev/cu.test",
            4,
        )
        self.assertEqual(parsed.state, "Alarm")
        self.assertEqual(parsed.limit_pins, "XZ")
        self.assertEqual(parsed.position, Position(1, 2, 3, 0))

    def test_release_moves_z_then_x_and_stops_when_inputs_clear(self):
        driver = FakeReleaseDriver(release_x_at=4.0, release_z_at=1.5)
        result = driver._release_active_limits_locked(driver.current)
        self.assertEqual(result.limit_pins, "")
        self.assertEqual(result.position, Position(4, 0, 1.5, 0))
        self.assertEqual(driver.commands[:3], ["Z0.500", "Z1.000", "Z1.500"])
        self.assertEqual(driver.commands[-1], "X4.000Y0.000")

    def test_stuck_x_is_bounded_and_fails_without_homing(self):
        driver = FakeReleaseDriver(release_x_at=99.0, release_z_at=1.5)
        with self.assertRaisesRegex(RuntimeError, "8 mm"):
            driver._release_active_limits_locked(driver.current)
        x_commands = [value for value in driver.commands if value.startswith("X")]
        self.assertEqual(len(x_commands), 16)
        self.assertEqual(x_commands[-1], "X8.000Y0.000")
        self.assertEqual(driver.current.limit_pins, "X")

    @patch("bridge.black_arm_driver.MAINTENANCE_ENABLED", True)
    @patch("bridge.black_arm_driver.time.sleep", lambda _seconds: None)
    def test_maintenance_tap_never_moves_xy_and_restores_exact_z(self):
        driver = FakeManualReferenceDriver()
        driver.maintenance_move_probe()
        driver.commands.clear()
        result = driver.maintenance_tap_current()
        self.assertEqual(driver.commands, [
            "Z10.000",
            "X41.000Y80.000",
            "Z1.500",
            "X40.000Y80.000",
        ])
        self.assertEqual(result.controller_position, Position(40, 80, 1.5, 0))
        self.assertFalse(result.homed)

    @patch("bridge.black_arm_driver.MAINTENANCE_ENABLED", True)
    @patch("bridge.black_arm_driver.time.sleep", lambda _seconds: None)
    def test_manual_reference_translates_coordinates_and_normalizes_hover(self):
        driver = FakeManualReferenceDriver()
        driver.maintenance_move_probe()
        driver.maintenance_tap_current()
        referenced = driver.set_manual_reference(39.0, 82.0, True)
        self.assertTrue(referenced.homed)
        self.assertEqual(referenced.reference_mode, "manual")
        self.assertEqual(referenced.position, Position(39, 82, 1, 0))
        self.assertEqual(referenced.coordinate_offset, Position(1, -2, 0, 0))
        driver._move_xy_locked(50.0, 100.0)
        self.assertEqual(driver.commands[-1], "X51.000Y98.000")

    @patch("bridge.black_arm_driver.MAINTENANCE_ENABLED", True)
    def test_fixed_probe_move_accepts_no_coordinates_and_enters_screen(self):
        driver = FakeManualReferenceDriver()
        result = driver.maintenance_move_probe()
        self.assertEqual(driver.commands, ["X40.000Y80.000"])
        self.assertEqual(result.controller_position, Position(40, 80, 1.5, 0))

    @patch("bridge.black_arm_driver.MAINTENANCE_ENABLED", True)
    @patch("bridge.black_arm_driver.time.sleep", lambda _seconds: None)
    def test_fixed_probe_sequence_is_bounded_and_requires_one_tap_each(self):
        driver = FakeManualReferenceDriver()
        expected = [(40, 80), (25, 40), (55, 120)]
        for target_x, target_y in expected:
            result = driver.maintenance_move_probe()
            self.assertEqual(
                result.controller_position,
                Position(target_x, target_y, 1.5, 0),
            )
            driver.maintenance_tap_current()
        with self.assertRaisesRegex(RuntimeError, "used all fixed maintenance-probe positions"):
            driver.maintenance_move_probe()

    @patch("bridge.black_arm_driver.MAINTENANCE_ENABLED", True)
    def test_fixed_probe_move_rejects_an_unexpected_start_position(self):
        driver = FakeManualReferenceDriver()
        driver.current.position.y = 6
        with self.assertRaisesRegex(RuntimeError, "fixed screen sequence"):
            driver.maintenance_move_probe()

    @patch("bridge.black_arm_driver.MAINTENANCE_ENABLED", True)
    @patch("bridge.black_arm_driver.time.sleep", lambda _seconds: None)
    def test_failed_second_point_can_revoke_manual_reference(self):
        driver = FakeManualReferenceDriver()
        driver.maintenance_move_probe()
        driver.maintenance_tap_current()
        driver.set_manual_reference(40.0, 80.0, True)
        revoked = driver.revoke_manual_reference()
        self.assertFalse(revoked.homed)
        self.assertEqual(revoked.reference_mode, "unreferenced")

    @patch("bridge.black_arm_driver.MAINTENANCE_ENABLED", True)
    def test_failed_validation_park_can_make_one_bounded_positive_retry(self):
        driver = FakeManualReferenceDriver(pins="XZ")
        driver.current = status(x=16.075, y=12.2, z=1.0, pins="XZ")
        prepared = driver.prepare_visual_retry()
        self.assertEqual(driver.commands, ["Z1.500", "X40.000Y80.000"])
        self.assertEqual(
            prepared.controller_position,
            Position(40, 80, 1.5, 0),
        )
        self.assertEqual(prepared.limit_pins, "X")
        with self.assertRaisesRegex(RuntimeError, "visual retry.*already been used"):
            driver.prepare_visual_retry()

    @patch("bridge.black_arm_driver.MAINTENANCE_ENABLED", True)
    def test_visual_retry_steps_z_to_two_for_a_late_releasing_switch(self):
        driver = FakeManualReferenceDriver(pins="XZ", release_z_at=2.0)
        driver.current = status(x=16.075, y=12.2, z=1.0, pins="XZ")
        prepared = driver.prepare_visual_retry()
        self.assertEqual(
            driver.commands,
            ["Z1.500", "Z2.000", "X40.000Y80.000"],
        )
        self.assertEqual(
            prepared.controller_position,
            Position(40, 80, 2.0, 0),
        )
        self.assertEqual(prepared.limit_pins, "X")

    @patch("bridge.black_arm_driver.MAINTENANCE_ENABLED", True)
    def test_xy_fault_can_use_the_same_bounded_visual_reference(self):
        driver = FakeManualReferenceDriver(pins="XY")
        moved = driver.maintenance_move_probe()
        self.assertEqual(moved.controller_position, Position(40, 80, 1.5, 0))
        driver.maintenance_tap_current()
        referenced = driver.set_manual_reference(40.0, 80.0, True)
        self.assertTrue(referenced.homed)

    @patch("bridge.black_arm_driver.MAINTENANCE_ENABLED", True)
    @patch("bridge.black_arm_driver.time.sleep", lambda _seconds: None)
    def test_manual_reference_rejects_a_large_fixture_offset(self):
        driver = FakeManualReferenceDriver()
        driver.maintenance_move_probe()
        driver.maintenance_tap_current()
        with self.assertRaisesRegex(RuntimeError, "offset.*too large"):
            driver.set_manual_reference(20.0, 50.0, True)

    @patch("bridge.black_arm_driver.MAINTENANCE_ENABLED", True)
    def test_manual_recovery_rejects_any_other_fault(self):
        driver = FakeManualReferenceDriver(pins="XZ")
        with self.assertRaisesRegex(RuntimeError, r"X or X\+Y input fault"):
            driver.maintenance_move_probe()


if __name__ == "__main__":
    unittest.main()
