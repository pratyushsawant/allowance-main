// All app state lives here. Components just read it and call the actions.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { ApprovalRequest, Budget, ChatMessage, Connection, InputVia, Movement, Payment, Rules } from "./types";
import { speech, voice } from "./voice";

export function useAllowance() {
  const [rules, setRules] = useState<Rules | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [movements, setMovements] = useState<Movement[] | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connection, setConnection] = useState<Connection>("logged_out");
  // The placeholder for the answer we're waiting on, if any.
  const pendingId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getRules().then(setRules).catch(() => {});
    // After a refresh, put the current conversation back (the backend keeps it).
    api
      .restoreChat()
      .then((restored) => restored.length && setMessages((m) => (m.length ? m : restored)))
      .catch(() => {});
    return api.subscribe((e) => {
      switch (e.type) {
        case "payment":
          // Same id = status update; new id = new row, newest first.
          setPayments((prev) => {
            const exists = prev.some((p) => p.id === e.payment.id);
            const next = exists ? prev.map((p) => (p.id === e.payment.id ? e.payment : p)) : [e.payment, ...prev];
            return exists ? next : next.sort((a, b) => b.timestamp - a.timestamp);
          });
          // A purchase is running while we wait for the assistant: show that it's fetching data.
          if (pendingId.current && e.payment.status === "pending") {
            const id = pendingId.current;
            setMessages((m) => m.map((x) => (x.id === id && x.status === "thinking" ? { ...x, status: "fetching" } : x)));
          }
          break;
        case "approval_request":
          setApproval(e.request);
          break;
        case "approval_resolved":
          setApproval((a) => (a?.id === e.id ? null : a));
          break;
        case "agent_pending": {
          const id = e.id;
          setMessages((m) => (m.some((x) => x.id === id) ? m : [...m, { id, from: "agent", text: "", status: "thinking", at: Date.now() }]));
          break;
        }
        case "agent_message": {
          const msg: ChatMessage = { id: e.id ?? crypto.randomUUID(), from: "agent", text: e.text, status: e.status ?? "done", spoken: e.spoken, at: Date.now() };
          // With an id, it answers a placeholder (a spoken turn); replace it rather than add a second bubble.
          setMessages((m) => (e.id && m.some((x) => x.id === e.id) ? m.map((x) => (x.id === e.id ? msg : x)) : [...m, msg]));
          break;
        }
        case "notice":
          setMessages((m) => [...m, { id: crypto.randomUUID(), from: "system", text: e.text, status: e.tone === "warn" ? "error" : "done", at: Date.now() }]);
          break;
        case "user_message":
          setMessages((m) => [...m, { id: crypto.randomUUID(), from: "user", text: e.text, via: e.via, at: Date.now() }]);
          break;
        case "rules":
          setRules(e.rules);
          break;
        case "budget":
          setBudget(e.budget);
          break;
        case "movements":
          setMovements(e.movements);
          break;
        case "connection":
          setConnection(e.connection);
          break;
      }
    });
  }, []);

  // The backend's figure when connected (paid + held today, in its own time zone). The mock has none,
  // so count confirmed payments since local midnight.
  const spentToday = useMemo(() => {
    if (budget) return budget.spentToday;
    const midnight = new Date().setHours(0, 0, 0, 0);
    return payments
      .filter((p) => p.status === "confirmed" && p.timestamp >= midnight)
      .reduce((sum, p) => sum + p.amount, 0);
  }, [payments, budget]);

  const connect = useCallback(() => api.connect(), []);

  // One message to the assistant. The input mode belongs to this turn: a typed message gets a text
  // answer only (and silences speech left over from an earlier spoken turn); a message the browser
  // heard (via "spoken") also gets its answer read aloud, unless spoken replies are muted or the person
  // has moved on by then. ElevenLabs spoken turns don't come through here (see VoiceBridge).
  const say = useCallback(async (text: string, via: InputVia = "typed") => {
    const readAloud = via === "spoken" ? speech.beginSpokenTurn() : null;
    if (via === "typed") {
      speech.interrupt();
      voice.controls()?.supersede();
    }
    const id = crypto.randomUUID();
    pendingId.current = id;
    setBusy(true);
    setMessages((m) => [...m, { id: crypto.randomUUID(), from: "user", text, via, at: Date.now() }, { id, from: "agent", text: "", status: "thinking", at: Date.now() }]);
    const reply = await api.sendMessage(text);
    setMessages((m) => m.map((x) => (x.id === id ? { ...x, text: reply.text, status: reply.status, at: Date.now() } : x)));
    if (readAloud !== null && reply.status !== "canceled") speech.speakReply(reply.text, readAloud);
    if (pendingId.current === id) {
      pendingId.current = null;
      setBusy(false);
    }
  }, []);

  return {
    rules,
    budget,
    payments,
    movements,
    approval,
    messages,
    spentToday,
    connection,
    /** Waiting for the assistant's answer. */
    busy,
    saveRules: async (r: Rules) => setRules(await api.saveRules(r)),
    decide: (approve: boolean) => approval && api.decideApproval(approval.id, approve),
    setFrozen: (frozen: boolean) => api.setFrozen(frozen),
    connect,
    /** Stop waiting for the current answer (a payment already submitted still stands). */
    stop: () => api.cancel(),
    /** New conversation: the assistant forgets the chat; payments, approvals and budget stay. */
    clearChat: () => {
      api.newChat();
      setMessages([]);
    },
    say,
  };
}
