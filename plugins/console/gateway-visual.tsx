import { Icon } from "../../lib/ui/components.js";
import { t } from "../../lib/ui/i18n.js";
import "./gateway-visual.css";

export function GatewayVisual({
  name,
  example = true,
}: {
  name: string;
  example?: boolean;
}) {
  return (
    <div className="gateway-visual" aria-label={t("API 接入示意")}>
      <div className="gateway-diagram">
        <div className="gateway-client">
          <Icon name="key" size={20} />
          <span>API Key</span>
        </div>
        <svg
          viewBox="0 0 100 180"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d="M0 90H30Q40 90 40 80V36Q40 26 50 26H100M40 90H100M40 90V144Q40 154 50 154H100" />
        </svg>
        <div className="gateway-operations">
          <div>
            <Icon name="chat" size={18} />
            <span>
              {t("对话")}
              <small>/chat/completions</small>
            </span>
          </div>
          <div>
            <Icon name="models" size={18} />
            <span>
              {t("图片")}
              <small>/images/generations</small>
            </span>
          </div>
          <div>
            <Icon name="activity" size={18} />
            <span>
              {t("视频")}
              <small>/videos</small>
            </span>
          </div>
        </div>
      </div>
      {example && (
        <div className="gateway-code">
          <div>
            <span className="gateway-code-dot" />
            <span>{name}</span>
            <span>POST /v1/chat/completions</span>
          </div>
          <pre>
            <code>
              <span>{"{\n"}</span>
              {'  "model": '}
              <em>"model-id"</em>
              {",\n"}
              {'  "messages": [{\n    "role": '}
              <em>"user"</em>
              {',\n    "content": '}
              <em>"Hello"</em>
              {"\n  }],\n"}
              {'  "stream": '}
              <b>true</b>
              {"\n}"}
            </code>
          </pre>
        </div>
      )}
    </div>
  );
}
