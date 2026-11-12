import test from "node:test";
import assert from "node:assert/strict";
import { sdkConnectionErrorMessage } from "../src/sdk-feedback";

test("serial busy, Windows access denial and missing ports give distinct actionable guidance", () => {
  assert.match(sdkConnectionErrorMessage(new Error("PORT_BUSY: resource busy"), "COM29"), /串口 COM29已被占用.*关闭/);
  const denied = sdkConnectionErrorMessage(new Error("PERMISSION_DENIED: Opening COM29: Access denied"), "COM29");
  assert.match(denied, /COM29.*可能被其他程序占用，或没有访问权限/);
  assert.match(sdkConnectionErrorMessage(new Error("PORT_NOT_FOUND: port not found"), "COM5"), /找不到串口 COM5.*刷新串口列表/);
  const license = "LICENSE_REJECTED: access denied by license service";
  assert.equal(sdkConnectionErrorMessage(new Error(license), "COM5"), license);
});

test("timeouts and transport loss do not incorrectly report that the device is disconnected", () => {
  assert.match(sdkConnectionErrorMessage(new DOMException("timed out", "TimeoutError"), "COM5"), /超时.*尚未确认是否连接成功/);
  assert.match(sdkConnectionErrorMessage(new TypeError("Failed to fetch")), /连接结果尚未确认/);
  assert.equal(sdkConnectionErrorMessage(new Error("串口已由其他卡片占用")), "串口已由其他卡片占用");
});
