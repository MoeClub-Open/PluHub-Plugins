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
          viewBox="0 0 100 184"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d="M0 92H30Q40 92 40 82V38Q40 28 50 28H100M40 92H100M40 92V146Q40 156 50 156H100" />
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
            <span>{name}</span>
            <span>POST /v1/chat/completions</span>
          </div>
          <pre>
            <code>
              <span>{"{\n"}</span>
              {'  "model": '}
              <em>"model-id"</em>
              {",\n"}
              {'  "messages": [{ "role": '}
              <em>"user"</em>
              {', "content": '}
              <em>"Hello"</em>
              {" }],\n"}
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
