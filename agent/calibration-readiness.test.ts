import assert from "node:assert/strict";
import test from "node:test";
import { calibrationReadinessIssue } from "../shared/calibration-readiness";

const camera = [
  { x: 100, y: 40 },
  { x: 620, y: 40 },
  { x: 620, y: 1240 },
  { x: 100, y: 1240 },
];

test("rejects four calibration captures taken at the same machine point", () => {
  assert.match(calibrationReadinessIssue({
    imagePoints: camera,
    machinePoints: Array.from({ length: 4 }, () => ({ x: 1, y: 1 })),
  }) ?? "", /overlap/i);
});

test("accepts four separated camera and machine corners", () => {
  assert.equal(calibrationReadinessIssue({
    imagePoints: camera,
    machinePoints: [
      { x: 79, y: 158 },
      { x: 8, y: 158 },
      { x: 8, y: 6 },
      { x: 79, y: 6 },
    ],
  }), null);
});

test("rejects a flat profile with a duplicated top machine corner", () => {
  const issue = calibrationReadinessIssue({
    imagePoints: [
      { x: 190, y: 109 },
      { x: 532, y: 110 },
      { x: 519, y: 1163 },
      { x: 191, y: 1145 },
    ],
    machinePoints: [
      { x: 72, y: 12.5 },
      { x: 72, y: 12.5 },
      { x: 10, y: 12.5 },
      { x: 70, y: 14.5 },
    ],
  });

  assert.match(issue ?? "", /overlap|separate|valid/i);
});

test("rejects station 10's swapped bottom camera corners even with valid machine points", () => {
  assert.match(calibrationReadinessIssue({
    imagePoints: [
      { x: 161.09, y: 97.08 }, { x: 525.08, y: 100.35 },
      { x: 149.28, y: 1211.67 }, { x: 536.37, y: 1211.67 },
    ],
    machinePoints: [{ x: 79, y: 158 }, { x: 8, y: 158 }, { x: 8, y: 6 }, { x: 79, y: 6 }],
  }) ?? "", /camera corners cross or are out of order/);
});

test("rejects crossed machine corners and accepts mirrored axis orientation", () => {
  const points = [{ x: 79, y: 158 }, { x: 8, y: 158 }, { x: 8, y: 6 }, { x: 79, y: 6 }];
  assert.match(calibrationReadinessIssue({
    imagePoints: camera,
    machinePoints: [points[0], points[1], points[3], points[2]],
  }) ?? "", /machine corners cross or are out of order/);
  assert.equal(calibrationReadinessIssue({ imagePoints: camera, machinePoints: [...points].reverse() }), null);
});
