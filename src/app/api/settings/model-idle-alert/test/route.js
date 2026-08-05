import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import {
  buildDingTalkText,
  createModelIdleAlertState,
  normalizeModelIdleAlertSettings,
  sendDingTalkAlert,
} from "@/shared/services/modelIdleAlert";

export async function POST() {
  try {
    const settings = await getSettings();
    const config = normalizeModelIdleAlertSettings(settings.modelIdleAlert);
    if (!config.dingtalkWebhook) {
      return NextResponse.json({ ok: false, error: "DingTalk webhook is required" }, { status: 400 });
    }

    const nowMs = Date.now();
    const state = createModelIdleAlertState({
      lastCallAt: nowMs - config.idleMinutes * 60 * 1000,
    });
    const text = buildDingTalkText({ settings: config, state, nowMs });
    await sendDingTalkAlert(config, `[TEST] ${text}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message || "DingTalk test failed" }, { status: 500 });
  }
}
