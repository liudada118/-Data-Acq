import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { defaultPressureMaximum, isPressureMaximum, resolvePressureRange } from "../src/pressure-range";
import { PRESSURE_DISPLAY_KEY, PRESSURE_RANGE_KEY, readPressureDisplay, readPressureRange, savePressureRange } from "../src/pressure-display";

const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
Object.assign(globalThis, { window: dom.window });

test("fixed defaults follow known 8/12-bit full scales and invalid settings never create zero/NaN denominators", () => {
  assert.equal(defaultPressureMaximum(255, "uint8"), 255);
  assert.equal(defaultPressureMaximum(4095, "uint16"), 4095);
  assert.equal(defaultPressureMaximum(undefined, "uint8"), 255);
  for (const value of [NaN, Infinity, -Infinity, 0, -1, Number.MAX_SAFE_INTEGER + 1, "255", null]) {
    assert.equal(isPressureMaximum(value), false);
    assert.equal(resolvePressureRange({ mode: "fixed", maximum: value as number }, [0, NaN], 4095).maximum, 4095);
  }
  assert.equal(resolvePressureRange({ mode: "auto" }, [NaN, -1, 0]).maximum, 1);
  assert.deepEqual(resolvePressureRange({ mode: "fixed", maximum: 100 }, [-1, 0, 100, 101, NaN]), { maximum: 100, above: 1, below: 1 });
});

test("range persistence is per stream, retains old display preferences and rejects corrupted entries", () => {
  window.localStorage.clear();
  window.localStorage.setItem(PRESSURE_DISPLAY_KEY, JSON.stringify({ old: "numbers" }));
  assert.equal(readPressureDisplay("old"), "numbers");
  assert.deepEqual(readPressureRange("old"), { mode: "auto" });
  savePressureRange("old", { mode: "fixed", maximum: 4095 });
  savePressureRange("other", { mode: "auto", maximum: 255 });
  assert.deepEqual(readPressureRange("old"), { mode: "fixed", maximum: 4095 });
  assert.deepEqual(readPressureRange("other"), { mode: "auto", maximum: 255 });
  assert.equal(readPressureDisplay("old"), "numbers");
  savePressureRange("old", { mode: "fixed", maximum: NaN });
  assert.deepEqual(readPressureRange("old"), { mode: "fixed", maximum: 4095 }, "an invalid update cannot overwrite the saved bound");
  window.localStorage.setItem(PRESSURE_RANGE_KEY, JSON.stringify({ zero: { mode: "fixed", maximum: 0 }, bad: { mode: "mystery", maximum: 100 }, good: { mode: "fixed", maximum: 123.5 } }));
  assert.deepEqual(readPressureRange("zero"), { mode: "auto" });
  assert.deepEqual(readPressureRange("bad"), { mode: "auto" });
  assert.deepEqual(readPressureRange("good"), { mode: "fixed", maximum: 123.5 });
  assert.deepEqual(readPressureRange("__proto__"), { mode: "auto" });
  window.localStorage.setItem(PRESSURE_RANGE_KEY, "broken");
  assert.deepEqual(readPressureRange("good"), { mode: "auto" });
  for (let i = 0; i < 80; i++) savePressureRange(`stream-${i}`, { mode: "fixed", maximum: i + 1 });
  assert.equal(Object.keys(JSON.parse(window.localStorage.getItem(PRESSURE_RANGE_KEY)!)).length, 64);
  assert.deepEqual(readPressureRange("stream-0"), { mode: "auto" });
  assert.deepEqual(readPressureRange("stream-79"), { mode: "fixed", maximum: 80 });
  window.localStorage.clear();
});
