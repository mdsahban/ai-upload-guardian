import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { panelLogin } from "../api";
import { setPanelToken } from "../auth";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const out = await panelLogin(email.trim(), password);
      setPanelToken(out.accessToken);
      navigate("/panel", { replace: true });
    } catch (ex: unknown) {
      const msg = ex instanceof Error ? ex.message : String(ex);
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="loginPage">
      <div className="loginCard">
        <Link className="loginBack" to="/">
          ← Back to home
        </Link>
        <h1 className="loginTitle">Admin sign in</h1>
        <p className="loginSub">
          Sign in with your administrator email and password.
        </p>
        <form className="loginForm" onSubmit={onSubmit}>
          <label className="loginLabel">
            Email
            <input
              className="loginInput"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="loginLabel">
            Password
            <input
              className="loginInput"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {err ? <div className="loginErr">{err}</div> : null}
          <button className="loginSubmitBtn" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in to console"}
          </button>
        </form>
      </div>
    </div>
  );
}
