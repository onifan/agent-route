"use client";

import { useState } from "react";
import PropTypes from "@/shared/prop-types";
import { Modal, Button, Input, OAuthModal } from "@/shared/components";

function getRedirectUri() {
  if (typeof window === "undefined") return "http://localhost/callback";
  const port = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
  return `http://localhost:${port}/callback`;
}

export default function AntigravityAuthModal({ isOpen, providerInfo, onSuccess, onClose }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState("");
  const [showOAuth, setShowOAuth] = useState(false);
  const [oauthMeta, setOauthMeta] = useState(null);
  const [useLocalConfig, setUseLocalConfig] = useState(false);

  const reset = () => {
    setClientId("");
    setClientSecret("");
    setError("");
    setShowOAuth(false);
    setOauthMeta(null);
    setUseLocalConfig(false);
  };

  const handleClose = () => {
    reset();
    onClose?.();
  };

  const handleOAuthStart = () => {
    const trimmedClientId = clientId.trim();
    const trimmedClientSecret = clientSecret.trim();
    if (!trimmedClientId) {
      setError("请填写 Google OAuth Client ID。");
      return;
    }
    if (!trimmedClientSecret) {
      setError("请填写 Google OAuth Client Secret。");
      return;
    }
    setError("");
    setOauthMeta({
      clientId: trimmedClientId,
      clientSecret: trimmedClientSecret
    });
    setUseLocalConfig(false);
    setShowOAuth(true);
  };

  const handleLocalConfigStart = () => {
    setError("");
    setOauthMeta(null);
    setUseLocalConfig(true);
    setShowOAuth(true);
  };

  if (!isOpen) return null;

  if (showOAuth && (oauthMeta || useLocalConfig)) {
    return (
      <OAuthModal
        isOpen
        provider="antigravity"
        providerInfo={providerInfo}
        oauthMeta={oauthMeta || undefined}
        onSuccess={() => {
          onSuccess?.();
          handleClose();
        }}
        onClose={() => {
          setShowOAuth(false);
          setOauthMeta(null);
          setUseLocalConfig(false);
        }}
      />
    );
  }

  return (
    <Modal isOpen={isOpen} title="连接 Antigravity" onClose={handleClose} size="lg">
      <div className="flex flex-col gap-4">
        <div className="rounded-[12px] border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-text-main">
          <p className="font-semibold">Antigravity 不能复用 Gemini CLI 的公共 OAuth Client。</p>
          <p className="mt-2 text-text-muted">
            Google 会拒绝不匹配的 Client ID 和 Antigravity scope。请使用你自己的 Google Cloud OAuth Client，并授权
            Antigravity 所需 scope。
          </p>
        </div>

        <p className="text-xs leading-5 text-text-muted">
          Redirect URI 请配置为{" "}
          <code className="rounded bg-surface-2 px-1 py-0.5 text-text-main">{getRedirectUri()}</code>。Client Secret
          只用于本次授权换 token，不会展示在连接状态中，也不会提交到 git。
        </p>

        <div className="rounded-[12px] border border-border-subtle bg-surface-2 p-4">
          <p className="text-sm font-semibold text-text-main">本机配置</p>
          <p className="mt-1 text-xs leading-5 text-text-muted">
            如果 `.env.local` 已经配置 AGENT_ROUTE_OAUTH_ANTIGRAVITY_CLIENT_ID 和
            AGENT_ROUTE_OAUTH_ANTIGRAVITY_CLIENT_SECRET，可以直接使用本机配置授权。
          </p>
          <Button className="mt-3" variant="secondary" onClick={handleLocalConfigStart} fullWidth>
            使用本机配置授权
          </Button>
        </div>

        <Input
          label="Google OAuth Client ID"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          placeholder="xxxx.apps.googleusercontent.com"
          required
        />
        <Input
          label="Google OAuth Client Secret"
          type="password"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
          placeholder="GOCSPX-..."
          required
        />

        <div className="rounded-[12px] border border-border-subtle bg-surface-2 p-3 text-xs leading-5 text-text-muted">
          <p className="font-medium text-text-main">需要的 Google OAuth scope</p>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>https://www.googleapis.com/auth/cloud-platform</li>
            <li>https://www.googleapis.com/auth/userinfo.email</li>
            <li>https://www.googleapis.com/auth/userinfo.profile</li>
            <li>https://www.googleapis.com/auth/cclog</li>
            <li>https://www.googleapis.com/auth/experimentsandconfigs</li>
          </ul>
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={handleOAuthStart} fullWidth disabled={!clientId.trim() || !clientSecret.trim()}>
            使用 Google 授权
          </Button>
          <Button onClick={handleClose} variant="ghost" fullWidth>
            取消
          </Button>
        </div>
      </div>
    </Modal>
  );
}

AntigravityAuthModal.propTypes = {
  isOpen: PropTypes.bool,
  providerInfo: PropTypes.object,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func
};
