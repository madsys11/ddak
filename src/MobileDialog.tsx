import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import qrcode from "qrcode-generator";
import { useT, usePrefs } from "./prefs";

// src-tauri/src/mobile.rs Status
type Status = {
  config: { enabled: boolean; port: number; screen: string; name: string; id: string };
  running: boolean;
  port: number | null;
  error: string | null;
  tailscale: { installed: boolean; running: boolean; host: string | null; login: string | null; cert: boolean; serve: "off" | "ours" | "other"; funnel: boolean };
  // push: 폰 알림 (on, off, gone: 푸시 서비스가 구독을 없앰)
  devices: { id: string; name: string; created: number; used: number; push: "on" | "off" | "gone" }[];
};
// mobile_pair_code
type Pairing = { code: string; api: string; link: string; expires: number };

// QR을 SVG로 (색은 테마 토큰 --qr-fg·--qr-bg)
function Qr({ text }: { text: string }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 2;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  const size = n + margin * 2;
  return (
    <svg className="mobile-qr" viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" role="img" aria-label="QR">
      <rect width={size} height={size} fill="var(--qr-bg)" />
      <path d={d} fill="var(--qr-fg)" />
    </svg>
  );
}

// 모바일 연결 (앱 메뉴 "모바일 연결…", docs/mobile-plan.md): 켜기, Tailscale 상태와 `tailscale serve` 연결,
// 폰 페어링(QR·코드), 연결된 기기 목록. 상태는 열 때와 바꿀 때마다 Rust에서 다시 읽는다 (tailscale CLI).
export function MobileDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { locale } = usePrefs();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // 고치는 중인 폰에 보일 이름 (null: 저장된 이름)
  const [name, setName] = useState<string | null>(null);

  const run = async (cmd: string, args?: Record<string, unknown>) => {
    setBusy(true);
    try {
      setStatus(await invoke<Status>(cmd, args));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    run("mobile_status");
  }, []);
  // 코드가 남은 시간
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  const pair = async () => {
    try {
      setPairing(await invoke<Pairing>("mobile_pair_code"));
      setNow(Date.now());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  // 칸을 벗어나거나 Enter면 저장한다. Rust가 다듬은 이름(비우면 이 맥 이름)으로 칸을 되돌린다.
  // 저장하는 동안(Tailscale 상태까지 다시 읽는다) 칸을 잠근다: 그 사이 고친 것을 응답이 지우지 않게 (리뷰 R1)
  const saveName = async () => {
    if (name !== null && name !== status?.config.name) await run("mobile_set_name", { name });
    setName(null);
  };

  const ts = status?.tailscale;
  const enabled = !!status?.config.enabled;
  // 폰이 붙을 수 있는 상태: 서버가 떠 있고 Tailscale이 돌며 HTTPS 인증서와 serve가 이 포트로
  const ready = !!status?.running && !!ts?.running && !!ts.host && ts.cert && ts.serve === "ours" && !ts.funnel;
  const left = pairing ? Math.max(0, Math.ceil((pairing.expires - now) / 1000)) : 0;
  const date = (ms: number) => new Date(ms).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal mobile-dialog"
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="modal-title">{t("mobile.title")}</div>
        <div className="modal-hint">{t("mobile.hint")}</div>
        {status && (
          <label className="mobile-enable">
            <input type="checkbox" checked={enabled} disabled={busy} data-action="mobile-enable" onChange={(e) => run("mobile_set_enabled", { enabled: e.target.checked })} autoFocus />
            <span>{t("mobile.enable", { name: status.config.name })}</span>
          </label>
        )}
        {status && (
          <label>
            {t("mobile.name")}
            <input
              value={name ?? status.config.name}
              maxLength={64}
              data-action="mobile-name"
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) e.currentTarget.blur();
              }}
            />
          </label>
        )}
        {enabled && status && ts && (
          <div className="mobile-checks" data-mobile-ready={ready}>
            {status.error === "funnel" || ts.funnel ? (
              <div className="modal-error">{t("mobile.funnel")}</div>
            ) : status.error ? (
              <div className="modal-error">{t("mobile.startFailed", { error: status.error })}</div>
            ) : null}
            {!ts.installed ? (
              <div className="modal-error">{t("mobile.tsMissing")}</div>
            ) : !ts.running || !ts.host ? (
              <div className="modal-error">{t("mobile.tsStopped")}</div>
            ) : (
              <>
                <div className="mobile-row">
                  <span className={ts.cert ? "mobile-ok" : "mobile-bad"}>{ts.cert ? "✓" : "!"}</span>
                  <span>{ts.cert ? t("mobile.certOk", { host: ts.host }) : t("mobile.certMissing")}</span>
                </div>
                <div className="mobile-row">
                  <span className={ts.serve === "ours" ? "mobile-ok" : "mobile-bad"}>{ts.serve === "ours" ? "✓" : "!"}</span>
                  <span>{ts.serve === "ours" ? t("mobile.serveOn", { host: ts.host }) : ts.serve === "other" ? t("mobile.serveOther") : t("mobile.serveOff")}</span>
                  {ts.serve !== "ours" && (
                    <button className="secondary" data-action="mobile-serve" disabled={busy || !status.running} onClick={() => run("mobile_serve")}>
                      {t("mobile.serveButton")}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {enabled && ready && (
          <div className="mobile-pair">
            {pairing && left > 0 ? (
              <div className="mobile-pairing">
                <Qr text={pairing.link} />
                <div className="mobile-pairing-text">
                  <div className="modal-hint">{t("mobile.pairHint")}</div>
                  <div className="mobile-code" data-pair-code={pairing.code}>
                    {pairing.code}
                  </div>
                  <div className="modal-hint">{t("mobile.address", { api: pairing.api })}</div>
                  <div className="modal-hint">{t("mobile.expires", { min: Math.floor(left / 60), sec: String(left % 60).padStart(2, "0") })}</div>
                  <button className="secondary" onClick={pair}>
                    {t("mobile.newCode")}
                  </button>
                </div>
              </div>
            ) : (
              <button data-action="mobile-pair" onClick={pair}>
                {t("mobile.pair")}
              </button>
            )}
          </div>
        )}
        {status && status.devices.length > 0 && (
          <div className="mobile-devices">
            <div className="modal-sub">{t("mobile.devices")}</div>
            {status.devices.map((d) => (
              <div key={d.id} className="mobile-row" data-device={d.id}>
                <span className="mobile-device-name">{d.name}</span>
                <span className="modal-hint">
                  {t("mobile.used", { time: date(d.used) })} · {t(d.push === "on" ? "mobile.pushOn" : d.push === "gone" ? "mobile.pushGone" : "mobile.pushOff")}
                </span>
                <button className="secondary" disabled={busy} onClick={() => run("mobile_forget", { id: d.id })}>
                  {t("mobile.forget")}
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </div>
  );
}
