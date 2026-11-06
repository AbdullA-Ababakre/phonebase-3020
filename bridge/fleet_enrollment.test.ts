import assert from "node:assert/strict";
import test from "node:test";

import {
  nextFleetDeviceId,
  normalizeUsbLocation,
  pairUsbHardware,
  usbTopologyAffinity,
} from "./fleet_enrollment.ts";

test("normalizes macOS USB locations", () => {
  assert.equal(normalizeUsbLocation("0x02114430"), "02114430");
  assert.equal(normalizeUsbLocation("2114430"), "02114430");
});

test("pairs multiple identical devices by the globally best hub topology", () => {
  const pairs = pairUsbHardware(
    [
      { serial: "/dev/cu.usbserial-211240", location: "02112400" },
      { serial: "/dev/cu.usbserial-2114440", location: "02114440" },
    ],
    [
      { identity: "camera-near-arm-a", location: "02114430" },
      { identity: "camera-near-arm-b", location: "02114200" },
    ],
  );
  assert.deepEqual(
    pairs.map((pair) => [pair.controller.serial, pair.camera.identity]),
    [
      ["/dev/cu.usbserial-211240", "camera-near-arm-b"],
      ["/dev/cu.usbserial-2114440", "camera-near-arm-a"],
    ],
  );
  assert.ok(usbTopologyAffinity("02114440", "02114430") > usbTopologyAffinity("02114440", "02114200"));
});

test("refuses incomplete controller/camera sets", () => {
  assert.deepEqual(
    pairUsbHardware(
      [{ serial: "/dev/cu.usbserial-one", location: "02110000" }],
      [],
    ),
    [],
  );
});

test("allocates the next stable station device id", () => {
  assert.equal(nextFleetDeviceId(["sf-black-arm-01", "sf-black-arm-03"], "sf-black-arm"), "sf-black-arm-02");
});
