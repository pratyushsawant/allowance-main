/**
 * Creates ElevenLabs conversation credentials server-side so the API key never reaches the browser.
 * Verified against ElevenLabs docs (2026-11-20):
 *   WebRTC (voice):          GET {base}/v1/convai/conversation/token?agent_id=…          -> { token, conversation_id }
 *   WebSocket (text-only):   GET {base}/v1/convai/conversation/get-signed-url?agent_id=… -> { signed_url }
 *   Header: xi-api-key. The docs do not state how long either credential stays valid.
 */
export const ELEVENLABS_API_BASE_DEFAULT = "https://api.elevenlabs.io";

export type VoiceTransport = "webrtc" | "websocket";

export interface VoiceSession {
  transport: VoiceTransport;
  conversationToken?: string;
  signedUrl?: string;
  conversationId?: string;
}

export class VoiceNotConfiguredError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`Voice is not configured; set ${missing.join(" and ")} in backend/.env`);
    this.name = "VoiceNotConfiguredError";
    this.missing = missing;
  }
}

export class VoiceUpstreamError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`ElevenLabs answered HTTP ${status}`);
    this.name = "VoiceUpstreamError";
    this.status = status;
  }
}

export interface VoiceOptions {
  apiKey?: string;
  agentId?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createVoiceSessions(o: VoiceOptions) {
  const http = o.fetchImpl ?? fetch;
  const base = (o.apiBase || ELEVENLABS_API_BASE_DEFAULT).replace(/\/$/, "");
  const missing = [!o.apiKey && "ELEVENLABS_API_KEY", !o.agentId && "ELEVENLABS_AGENT_ID"].filter(Boolean) as string[];

  return {
    configured: missing.length === 0,
    async create(transport: VoiceTransport): Promise<VoiceSession> {
      if (missing.length) throw new VoiceNotConfiguredError(missing);
      const path = transport === "webrtc" ? "/v1/convai/conversation/token" : "/v1/convai/conversation/get-signed-url";
      const url = `${base}${path}?agent_id=${encodeURIComponent(o.agentId!)}`;
      const res = await http(url, {
        headers: { "xi-api-key": o.apiKey!, accept: "application/json" },
        signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new VoiceUpstreamError(res.status);
      }
      const body = (await res.json()) as { token?: string; conversation_id?: string; signed_url?: string };
      if (transport === "webrtc") {
        if (typeof body.token !== "string") throw new VoiceUpstreamError(502);
        return { transport, conversationToken: body.token, conversationId: body.conversation_id };
      }
      if (typeof body.signed_url !== "string") throw new VoiceUpstreamError(502);
      return { transport, signedUrl: body.signed_url };
    },
  };
}

export type VoiceSessions = ReturnType<typeof createVoiceSessions>;
