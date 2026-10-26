import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { t as tr } from "../../lib/ui/i18n.js";
function mathMarkdown(text: string) {
  return text
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(/\\\[([\s\S]*?)\\\]/g, (_, value) => "$$" + value + "$$")
            .replace(/\\\(([\s\S]*?)\\\)/g, (_, value) => "$" + value + "$"),
    )
    .join("");
}

function Diagram({
  source,
  streaming,
}: {
  source: string;
  streaming: boolean;
}) {
  const target = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState(false);
  const [code, setCode] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    if (streaming || code) return;
    let current = true;
    setError(false);
    setLoading(true);
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: "neutral",
          flowchart: { htmlLabels: false },
          fontFamily: "inherit",
        });
        const { svg } = await mermaid.render(
          "diagram-" + crypto.randomUUID(),
          source,
        );
        if (current && target.current) {
          target.current.innerHTML = svg;
          setLoading(false);
        }
      })
      .catch(() => {
        if (current) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [source, streaming, code]);
  return (
    <figure className="chat-diagram">
      <div className="chat-code-toolbar">
        <span>Mermaid</span>
        <button type="button" className="ghost" onClick={() => setCode(!code)}>
          {tr(code ? "查看图表" : "查看代码")}
        </button>
      </div>
      {streaming || code || error ? (
        <pre>
          <code>{source}</code>
        </pre>
      ) : (
        <div ref={target} />
      )}
      {error && <figcaption>{tr("图表语法无效，已显示原始代码。")}</figcaption>}
      {!streaming && !code && !error && loading && (
        <figcaption role="status">{tr("正在渲染图表…")}</figcaption>
      )}
    </figure>
  );
}
function CodeBlock({ language, source }: { language: string; source: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="chat-code">
      <div className="chat-code-toolbar">
        <span>{language || tr("代码")}</span>
        <button
          type="button"
          className="ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(source);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
        >
          {tr(copied ? "已复制" : "复制代码")}
        </button>
      </div>
      <pre>
        <code>{source}</code>
      </pre>
    </div>
  );
}
export const RichText = React.memo(function RichText({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className="chat-markdown">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: "ignore", trust: false }]]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: (props) => (
            <img {...props} loading="lazy" referrerPolicy="no-referrer" />
          ),
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, node: _node, ...props }) => {
            const language =
              /language-([^\s]+)/.exec(className ?? "")?.[1] ?? "";
            const source = String(children).replace(/\n$/, "");
            if (language === "mermaid")
              return <Diagram source={source} streaming={streaming} />;
            return language || String(children).endsWith("\n") ? (
              <CodeBlock language={language} source={source} />
            ) : (
              <code {...props} className={className}>
                {children}
              </code>
            );
          },
        }}
      >
        {mathMarkdown(text)}
      </Markdown>
    </div>
  );
});
