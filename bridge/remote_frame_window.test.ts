import assert from "node:assert/strict";
import test from "node:test";
import { RemoteFrameWindow } from "./remote_frame_window";

test("legacy clients wait for each acknowledgement", () => {
  const window = new RemoteFrameWindow(null);
  assert.equal(window.available, false);
  window.start();
  window.sent(12);
  assert.equal(window.available, false);
  window.acknowledge(12);
  assert.equal(window.available, true);
});

test("a pipeline remains bounded despite duplicate ready and invalid acknowledgements", () => {
  const window = new RemoteFrameWindow("999");
  assert.equal(window.size, 3);
  window.start();
  for (const sequence of [10, 20, 30]) {
    assert.equal(window.available, true);
    window.sent(sequence);
  }
  assert.equal(window.available, false);
  window.start();
  window.acknowledge(999);
  window.acknowledge(0);
  assert.equal(window.available, false);
  window.acknowledge(20);
  window.sent(40);
  window.sent(50);
  assert.equal(window.available, false);
  window.acknowledge(20);
  assert.equal(window.available, false);
  window.acknowledge(50);
  assert.equal(window.available, true);
});

test("invalid window sizes retain legacy backpressure", () => {
  for (const value of [null, "", "0", "-1", "1.5", "NaN", "Infinity"]) {
    assert.equal(new RemoteFrameWindow(value).size, 1);
  }
});
