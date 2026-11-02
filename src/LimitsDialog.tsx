import { useEffect, useState } from "react";
import { useT } from "./prefs";
import { RE_REVIEW_RANGE, WAKE_RANGE, saveLimits, useLimits, useLimitsLoaded } from "./limits";
import type { Group } from "./useGroups";

// 규약이 있지만 {reReviews}가 없는 그룹(사용자가 고친 규약): 재리뷰 횟수가 들어가지 않는다
export const fixedRuleGroups = (groups: Group[]) => groups.filter((g) => g.rules && !g.rules.includes("{reReviews}")).map((g) => g.name || g.id);

// 앱 메뉴 "협업 제한…" (src-tauri/src/menu.rs, src-tauri/src/limits.rs, docs/spec.md "협업 제한"): 세션끼리 사용자 없이 주고받을 메시지
// 수와 재리뷰 최대 횟수. 저장하면 대화 제한은 바로 (바뀌었으면 모든 작업그룹을 다시 세고 보류된 알림을 보냄), 재리뷰 횟수는 새로 띄운
// 세션부터. 규약에 {reReviews}가 없는 작업그룹(사용자가 고친 규약)에는 재리뷰 횟수가 들어가지 않는다고 알린다.
export function LimitsDialog({ groups, onClose }: { groups: Group[] | null; onClose: () => void }) {
  const t = useT();
  const limits = useLimits();
  // 저장한 값을 읽기 전에 열리면 (앱을 켠 직후) 읽을 때까지 고치거나 저장하지 못한다. 읽으면 그 값으로 채운다
  // (리뷰 R1: 기본값을 보이고 저장해서 저장한 대화 제한을 덮었다)
  const loaded = useLimitsLoaded();
  const [wake, setWake] = useState(loaded ? String(limits.wakeLimit) : "");
  const [reviews, setReviews] = useState(loaded ? String(limits.reReviews) : "");
  const [filled, setFilled] = useState(loaded);
  useEffect(() => {
    if (!loaded || filled) return;
    setWake(String(limits.wakeLimit));
    setReviews(String(limits.reReviews));
    setFilled(true);
  }, [loaded, filled, limits]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parse = (v: string, [lo, hi]: readonly [number, number]) => (/^\d+$/.test(v.trim()) && +v >= lo && +v <= hi ? +v : null);
  const wakeLimit = parse(wake, WAKE_RANGE);
  const reReviews = parse(reviews, RE_REVIEW_RANGE);
  const fixed = fixedRuleGroups(groups ?? []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!filled || wakeLimit === null || reReviews === null || busy) return;
    setBusy(true);
    try {
      await saveLimits({ wakeLimit, reReviews });
      onClose();
    } catch (err) {
      setError(t("limits.saveFailed", { detail: String(err) }));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="modal" data-dialog="limits"
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape" && !busy) onClose();
        }}
      >
        <div className="modal-title">{t("limits.title")}</div>
        {!filled && (
          <div className="modal-hint" data-loading>
            {t("limits.loading")}
          </div>
        )}
        <label>
          {t("limits.wake")}
          <input data-field="wake" inputMode="numeric" value={wake} disabled={!filled} onChange={(e) => setWake(e.target.value)} autoFocus />
        </label>
        <div className="modal-hint">{t("limits.wakeHint", { lo: WAKE_RANGE[0], hi: WAKE_RANGE[1] })}</div>
        {filled && wakeLimit === null && <div className="modal-error" data-invalid="wake">{t("limits.range", { lo: WAKE_RANGE[0], hi: WAKE_RANGE[1] })}</div>}
        <label>
          {t("limits.reReviews")}
          <input data-field="reReviews" inputMode="numeric" value={reviews} disabled={!filled} onChange={(e) => setReviews(e.target.value)} />
        </label>
        <div className="modal-hint">{t("limits.reReviewsHint", { lo: RE_REVIEW_RANGE[0], hi: RE_REVIEW_RANGE[1] })}</div>
        {filled && reReviews === null && <div className="modal-error" data-invalid="reReviews">{t("limits.range", { lo: RE_REVIEW_RANGE[0], hi: RE_REVIEW_RANGE[1] })}</div>}
        {fixed.length > 0 && (
          <div className="modal-hint" data-fixed-rules={fixed.join(",")}>
            {t("limits.fixedRules", { groups: fixed.join(", ") })}
          </div>
        )}
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" data-action="limits-save" disabled={busy || !filled || wakeLimit === null || reReviews === null}>
            {t("limits.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
