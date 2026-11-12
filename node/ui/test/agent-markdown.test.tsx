import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { AgentMarkdown } from "../src/AgentMarkdown";

function render(content: string) {
  return new JSDOM(renderToStaticMarkup(<AgentMarkdown content={content} />)).window.document;
}

test("Agent replies render headings, GFM tables, emphasis, lists and code as readable markup", () => {
  const document = render([
    "## 已读取的 SDK 内容", "", "- **通信协议**：`Docs/camera.docx`", "- 需要填写相机地址", "",
    "| 文件 | 用途 |", "| --- | --- |", "| `RTSP.pdf` | 实时取流说明 |", "",
    "> 请连接实机验证。", "", "```js", "const url = 'rtsp://camera/live';", "if (width < 1920) emit(frame);", "```",
  ].join("\n"));
  assert.equal(document.querySelector("h2")?.textContent, "已读取的 SDK 内容");
  assert.equal(document.querySelectorAll("li").length, 2);
  assert.equal(document.querySelector("strong")?.textContent, "通信协议");
  assert.equal(document.querySelector("li code")?.textContent, "Docs/camera.docx");
  assert.deepEqual([...document.querySelectorAll("th")].map(cell => cell.textContent), ["文件", "用途"]);
  assert.equal(document.querySelector("td code")?.textContent, "RTSP.pdf");
  assert.ok(document.querySelector('[aria-label="Agent 表格"][tabindex="0"]'));
  assert.equal(document.querySelector("blockquote")?.textContent?.trim(), "请连接实机验证。");
  assert.equal(document.querySelector("pre code")?.textContent, "const url = 'rtsp://camera/live';\nif (width < 1920) emit(frame);\n");
});

test("untrusted assistant HTML, image URLs and privileged links cannot create active content", () => {
  const document = render([
    '<script>globalThis.stolen = true</script>', "", '<iframe src="file:///C:/secret"></iframe>', "",
    '<img src="https://tracking.invalid/pixel" onerror="alert(1)">', "",
    '[执行](javascript:alert%281%29) [文件](file:///C:/secret) [站内](/api/plugins/reload)', "",
    '[回环](http://127.0.0.1:8788/) [协议相对](//tracking.invalid) [凭据](https://user:password@example.com/)', "",
    '![相机图片](https://tracking.invalid/pixel) ![本地图片](file:///C:/secret)',
  ].join("\n"));
  assert.equal(document.querySelectorAll("script, iframe, img, a, object, embed, form").length, 0);
  assert.match(document.body.textContent ?? "", /文件/);
  assert.match(document.body.textContent ?? "", /\[图片：相机图片\]/);
  assert.match(document.body.textContent ?? "", /\[图片：本地图片\]/);
});

test("HTTPS documentation links open outside the current privileged page", () => {
  const document = render("[官方文档](https://example.com/sdk?q=rtsp) 和 https://example.com/help");
  const links = [...document.querySelectorAll("a")];
  assert.equal(links.length, 2);
  assert.equal(links[0].href, "https://example.com/sdk?q=rtsp");
  for (const link of links) {
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
  }
});
