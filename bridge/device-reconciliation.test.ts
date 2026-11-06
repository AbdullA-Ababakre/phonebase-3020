import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceReconciliation } from './device-reconciliation';

const previous = { serial: '/dev/robot05', driverPort: 3021, camera: '1', cameraIdentity: 'old-usb-path' };
test('camera-only unplug and explicit rebind preserve the existing motor driver', () => {
  assert.equal(deviceReconciliation(previous, undefined, true), 'retain');
  assert.equal(deviceReconciliation(previous, { ...previous, camera: '3', cameraIdentity: 'new-usb-path' }, true), 'replace-node');
});
test('unchanged identity survives camera index reorder without restarting its node', () => {
  assert.equal(deviceReconciliation(previous, { ...previous, camera: '7' }, true), 'retain');
});
test('a missing or different controller must never inherit an existing homing reference', () => {
  assert.equal(deviceReconciliation(previous, undefined, false), 'stop');
  assert.equal(deviceReconciliation(previous, { ...previous, serial: '/dev/other' }, true), 'stop');
  assert.equal(deviceReconciliation(previous, { ...previous, driverPort: 3030 }, true), 'stop');
});
