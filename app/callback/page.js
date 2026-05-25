"use client";

import { useEffect, useMemo, useState } from "react";

function callbackPayload() {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  return {
    code: params.get("code") || "",
    state: params.get("state") || "",
    error: params.get("error") || "",
    errorDescription: params.get("error_description") || "",
    timestamp: Date.now()
  };
}

export default function OAuthCallbackPage() {
  const payload = useMemo(callbackPayload, []);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ type: "oauth_callback", data: payload }, window.location.origin);
      }
    } catch {
      // Popup messaging is best-effort; localStorage/BroadcastChannel below provide fallback paths.
    }
    try {
      window.localStorage.setItem("oauth_callback", JSON.stringify(payload));
    } catch {
      // Ignore unavailable storage.
    }
    try {
      const channel = new BroadcastChannel("oauth_callback");
      channel.postMessage(payload);
      channel.close();
    } catch {
      // BroadcastChannel may be unavailable in some browsers.
    }
    setSent(true);
  }, [payload]);

  const hasError = Boolean(payload.error);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        background: "#f6f7fb",
        color: "#111827"
      }}
    >
      <section
        style={{
          width: "min(520px, 100%)",
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          background: "#ffffff",
          padding: 28,
          boxShadow: "0 20px 45px rgba(15, 23, 42, 0.08)"
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>{hasError ? "授权失败" : "授权回调已收到"}</h1>
        <p style={{ color: "#4b5563", lineHeight: 1.7 }}>
          {hasError
            ? payload.errorDescription || payload.error
            : sent
              ? "授权结果已经发送给 AgentRoute Studio。你可以关闭这个窗口，回到控制台继续。"
              : "正在把授权结果发送给控制台..."}
        </p>
      </section>
    </main>
  );
}
