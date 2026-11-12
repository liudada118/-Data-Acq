import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo } from "react";

// Agent output is untrusted. Only explicit HTTPS links may leave the conversation;
// Electron opens these in the system browser through its existing window handler.
function externalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

const components: Components = {
  a: ({ href, children }) => {
    const url = href && externalUrl(href);
    return url ? <a href={url} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
  },
  // Documents can contain remote tracking images or local file URLs. Render their
  // labels without fetching them or passing them to the desktop file handlers.
  img: ({ alt }) => <span className="sdk-markdown-image">{alt ? `[图片：${alt}]` : "[图片]"}</span>,
  table: ({ children }) => <div className="sdk-markdown-table" role="region" aria-label="Agent 表格" tabIndex={0}><table>{children}</table></div>,
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
};

export const AgentMarkdown = memo(function AgentMarkdown({ content }: { content: string }) {
  return <div className="sdk-markdown"><Markdown remarkPlugins={[remarkGfm]} components={components}
    skipHtml urlTransform={externalUrl}>{content}</Markdown></div>;
});
