import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ANSWER_RETURN_LIMIT,
  BUFFER_LIMIT,
  CONNECT_STAGES,
  confirmCode,
  connectionUrl,
  digestHex,
  failureNote,
  FILE_CHUNK,
  gateAnswer,
  pageUrlForPhone,
  parseConnectionText,
  qrByteLength,
  QR_BYTE_LIMIT,
  sdpDeferRemoteChecks,
  sdpHasCandidate,
  signalPayload,
  stageLabel,
  timeoutStage,
  type ConnectStage,
  type SignalMessage,
} from "@/lib/portfolio/qr-link";

type Role = "pc" | "phone";
type Phase = "idle" | "preparing" | "show-local" | "wait-remote" | "connecting" | "open" | "failed";
type StageStatus = "wait" | "now" | "ok" | "ng";
type Incoming = { name: string; size: number; hash: string; parts: Uint8Array[]; got: number };

function emptyStages(): Record<ConnectStage, StageStatus> {
  return { qr: "wait", parse: "wait", prepare: "wait", ice: "wait", channel: "wait", file: "wait" };
}

function statusWord(status: StageStatus): string {
  if (status === "ok") return "成功";
  if (status === "ng") return "失敗";
  if (status === "now") return "進行中";
  return "待ち";
}

function phaseLabel(phase: Phase): string {
  if (phase === "preparing") return "接続情報を作っています";
  if (phase === "show-local") return "相手の操作待ち";
  if (phase === "wait-remote") return "QRの読み取り待ち";
  if (phase === "connecting") return "直接接続を試しています";
  if (phase === "open") return "接続できました";
  if (phase === "failed") return "接続できませんでした";
  return "未接続";
}

async function waitForCandidates(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      window.clearTimeout(timer);
      pc.removeEventListener("icecandidate", onCandidate);
      pc.removeEventListener("icegatheringstatechange", onGathering);
      resolve();
    };
    const onCandidate = (event: Event) => {
      if (!(event as RTCPeerConnectionIceEvent).candidate || pc.iceGatheringState === "complete") finish();
    };
    const onGathering = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = window.setTimeout(() => {
      pc.removeEventListener("icecandidate", onCandidate);
      pc.removeEventListener("icegatheringstatechange", onGathering);
      reject(new Error("接続候補を集めきれませんでした。中継なしでは、このブラウザで直接接続を準備できないことがあります。"));
    }, 8000);
    pc.addEventListener("icecandidate", onCandidate);
    pc.addEventListener("icegatheringstatechange", onGathering);
  });
}

export function QrLinkDialog({
  open,
  onOpenChange,
  bootText = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bootText?: string | null;
}) {
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const roleRef = useRef<Role | null>(null);
  const timerRef = useRef<number | null>(null);
  const seenRef = useRef(new Set<string>());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const incomingRef = useRef<Incoming | null>(null);
  const downloadRef = useRef<string | null>(null);
  const answerRef = useRef<HTMLTextAreaElement | null>(null);
  const linkRef = useRef<HTMLTextAreaElement | null>(null);
  const bootSeen = useRef("");
  const [role, setRole] = useState<Role | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [stages, setStages] = useState<Record<ConnectStage, StageStatus>>(emptyStages);
  const [ice, setIce] = useState("new");
  const [gathering, setGathering] = useState("new");
  const [channelState, setChannelState] = useState("なし");
  const [note, setNote] = useState("");
  const [linkText, setLinkText] = useState("");
  const [linkNote, setLinkNote] = useState("");
  const [qrUrl, setQrUrl] = useState("");
  const [qrError, setQrError] = useState("");
  const [scanNote, setScanNote] = useState("");
  const [paste, setPaste] = useState("");
  const [confirmInput, setConfirmInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [answerText, setAnswerText] = useState("");
  const [answerCode, setAnswerCode] = useState("");
  const [sent, setSent] = useState("");
  const [sendProgress, setSendProgress] = useState<{ sent: number; size: number } | null>(null);
  const [received, setReceived] = useState<{ name: string; size: number; text: string; match: boolean; url: string } | null>(null);
  const [receiveProgress, setReceiveProgress] = useState<{ name: string; got: number; size: number } | null>(null);
  const [failStage, setFailStage] = useState("なし");
  const secure = typeof window !== "undefined" && window.isSecureContext;

  const patchStage = (stage: ConnectStage, status: StageStatus) => {
    setStages((current) => (current[stage] === status ? current : { ...current, [stage]: status }));
  };

  const release = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const channel = channelRef.current;
    channelRef.current = null;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onmessage = null;
      channel.onerror = null;
      channel.close();
    }
    const peer = peerRef.current;
    peerRef.current = null;
    if (peer) {
      peer.onicecandidate = null;
      peer.ondatachannel = null;
      peer.oniceconnectionstatechange = null;
      peer.close();
    }
    if (downloadRef.current) URL.revokeObjectURL(downloadRef.current);
    downloadRef.current = null;
    incomingRef.current = null;
    setScanning(false);
  };

  const reset = () => {
    release();
    roleRef.current = null;
    seenRef.current.clear();
    setRole(null);
    setPhase("idle");
    setStages(emptyStages());
    setIce("new");
    setGathering("new");
    setChannelState("なし");
    setNote("");
    setLinkText("");
    setLinkNote("");
    setQrUrl("");
    setQrError("");
    setScanNote("");
    setPaste("");
    setConfirmInput("");
    setAnswerText("");
    setAnswerCode("");
    setSent("");
    setSendProgress(null);
    setReceived(null);
    setReceiveProgress(null);
    setFailStage("なし");
  };

  const markFailed = (stage: ConnectStage, detail: string) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setFailStage(stageLabel(stage));
    setStages((current) => ({ ...current, [stage]: "ng" }));
    setPhase("failed");
    setNote(failureNote(stage, detail));
  };

  const armTimeout = (pc: RTCPeerConnection) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const channel = channelRef.current;
      if (channel?.readyState === "open") return;
      const iceState = pc.iceConnectionState;
      const stage = timeoutStage(iceState);
      if (stage === "channel") {
        markFailed("channel", "ICEはつながりましたが、データチャネルが開きませんでした。最初からやり直せます。");
        return;
      }
      markFailed("ice", `状態は ${iceState} です。同じネットワークでも、中継なしでは直接つながらないことがあります。最初からやり直せます。`);
    }, 20000);
  };

  const bindChannel = (channel: RTCDataChannel) => {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 64 * 1024;
    const mark = () => setChannelState(channel.readyState);
    channel.onopen = () => {
      mark();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      setPhase("open");
      setStages((current) => ({
        ...current,
        ice: "ok",
        channel: "ok",
        file: current.file === "ok" ? "ok" : "now",
      }));
      setNote(
        roleRef.current === "pc"
          ? "データチャネルが開きました。テストファイルを送れます。"
          : "データチャネルが開きました。PCからのテストファイルを待っています。",
      );
    };
    channel.onclose = () => {
      mark();
      const incoming = incomingRef.current;
      if (incoming && incoming.got < incoming.size) {
        incomingRef.current = null;
        markFailed("channel", "受信が完了する前に切断しました。PCからもう一度送信してください。");
        return;
      }
      setNote((current) => current || "データチャネルが閉じました。");
    };
    channel.onerror = () => {
      if (channel.readyState === "open") return;
      markFailed("channel", "データチャネルでエラーが起きました。最初からやり直せます。");
    };
    channel.onmessage = (event) => {
      void receive(event.data);
    };
    mark();
  };

  const bindPeer = (pc: RTCPeerConnection) => {
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      setIce(state);
      setGathering(pc.iceGatheringState);
      if (state === "checking") {
        patchStage("ice", "now");
        armTimeout(pc);
      }
      if (state === "connected" || state === "completed") {
        setStages((current) => ({
          ...current,
          ice: "ok",
          channel: current.channel === "ok" || current.channel === "ng" ? current.channel : "now",
        }));
      }
      if (state === "failed") {
        markFailed("ice", "端末同士の直接通信が成立しませんでした。最初からやり直せます。");
      }
    };
  };

  const receive = async (data: unknown) => {
    if (typeof data === "string") {
      let message: { t?: string; name?: unknown; size?: unknown; hash?: unknown };
      try {
        message = JSON.parse(data) as { t?: string };
      } catch {
        patchStage("file", "ng");
        setFailStage(stageLabel("file"));
        setNote(`${stageLabel("file")}の段階で失敗しました。受信データの形式が正しくありません。`);
        incomingRef.current = null;
        return;
      }
      if (message.t === "begin" && typeof message.name === "string" && typeof message.hash === "string" && typeof message.size === "number") {
        if (!/^[\w.-]{1,80}$/.test(message.name) || !Number.isSafeInteger(message.size) || message.size < 0 || message.size > 256 * 1024) {
          setNote("テスト用ではないデータは受け取りませんでした。");
          incomingRef.current = null;
          return;
        }
        incomingRef.current = { name: message.name, size: message.size, hash: message.hash, parts: [], got: 0 };
        setReceiveProgress({ name: message.name, got: 0, size: message.size });
        setReceived(null);
        patchStage("file", "now");
        return;
      }
      if (message.t === "end") {
        const incoming = incomingRef.current;
        incomingRef.current = null;
        if (!incoming || incoming.got !== incoming.size) {
          patchStage("file", "ng");
          setFailStage(stageLabel("file"));
          setNote(`${stageLabel("file")}の段階で失敗しました。受信が完了する前に切れました。もう一度送信してください。`);
          return;
        }
        const bytes = new Uint8Array(incoming.got);
        let offset = 0;
        for (const part of incoming.parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        const actual = await digestHex(bytes);
        const match = actual === incoming.hash;
        if (downloadRef.current) URL.revokeObjectURL(downloadRef.current);
        const url = URL.createObjectURL(new Blob([bytes], { type: "text/plain" }));
        downloadRef.current = url;
        setReceived({ name: incoming.name, size: incoming.size, text: new TextDecoder().decode(bytes), match, url });
        if (match) {
          patchStage("file", "ok");
          setNote("受信した内容は送信データと一致しました。");
        } else {
          patchStage("file", "ng");
          setFailStage(stageLabel("file"));
          setNote(`${stageLabel("file")}の段階で失敗しました。受信しましたが、内容が一致しません。`);
        }
      }
      return;
    }
    const incoming = incomingRef.current;
    if (!incoming) {
      setNote(`${stageLabel("file")}の段階で、開始情報のないデータを受信したため破棄しました。`);
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (!bytes) {
      incomingRef.current = null;
      patchStage("file", "ng");
      setFailStage(stageLabel("file"));
      setNote(`${stageLabel("file")}の段階で失敗しました。受信データの形式が正しくありません。`);
      return;
    }
    if (incoming.got + bytes.byteLength > incoming.size) {
      incomingRef.current = null;
      patchStage("file", "ng");
      setFailStage(stageLabel("file"));
      setNote(`${stageLabel("file")}の段階で失敗しました。受信データが宣言より大きいため中断しました。`);
      return;
    }
    incoming.parts.push(bytes);
    incoming.got += bytes.byteLength;
    setReceiveProgress({ name: incoming.name, got: incoming.got, size: incoming.size });
  };

  const ensurePhone = () => {
    release();
    roleRef.current = "phone";
    seenRef.current.clear();
    setRole("phone");
    setAnswerText("");
    setAnswerCode("");
    setFailStage("なし");
    setSent("");
    setReceived(null);
    setSendProgress(null);
    setReceiveProgress(null);
    setPhase("wait-remote");
    const pc = new RTCPeerConnection({ iceServers: [] });
    peerRef.current = pc;
    bindPeer(pc);
    pc.ondatachannel = (event) => {
      channelRef.current = event.channel;
      bindChannel(event.channel);
    };
    return pc;
  };

  const acceptSignal = async (signal: SignalMessage, pc: RTCPeerConnection, cancelled?: () => boolean) => {
    const stop = () => cancelled?.() ?? false;
    const currentRole = roleRef.current;
    if (stop() || peerRef.current !== pc || !currentRole) return;
    try {
      if (currentRole === "phone") {
        if (signal.k !== "offer") return;
        patchStage("prepare", "now");
        const deferred = sdpDeferRemoteChecks(signal.sdp);
        try {
          await pc.setRemoteDescription({ type: "offer", sdp: deferred });
        } catch {
          await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        }
        if (stop() || peerRef.current !== pc) return;
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForCandidates(pc);
        if (stop() || peerRef.current !== pc) return;
        const sdp = pc.localDescription?.sdp ?? "";
        const packed = signalPayload({ v: 1, k: "answer", sdp });
        const code = await confirmCode(sdp);
        if (stop() || peerRef.current !== pc) return;
        setAnswerText(packed);
        setAnswerCode(code);
        patchStage("prepare", "ok");
        setPhase("show-local");
        setGathering(pc.iceGatheringState);
        setNote(
          sdpHasCandidate(sdp)
            ? `${ANSWER_RETURN_LIMIT} PCが応答を取り込むまで、こちらから接続は始めません。PC側が失敗しても、その結果はこちらへ自動では届きません。`
            : "応答は作りました。ただし接続候補がありません。中継なしではつながらない可能性が高いです。",
        );
        return;
      }
      if (signal.k !== "answer") return;
      await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      if (stop() || peerRef.current !== pc) return;
      patchStage("ice", "now");
      setPhase("connecting");
      setGathering(pc.iceGatheringState);
      setNote("応答を確認しました。直接接続を待っています。番号だけでは接続していません。");
      armTimeout(pc);
    } catch (error) {
      if (stop() || peerRef.current !== pc) return;
      const stage: ConnectStage = currentRole === "phone" ? "prepare" : "parse";
      markFailed(stage, error instanceof Error ? error.message : "接続情報を適用できませんでした。画像データは変更していません。");
    }
  };

  const acceptOfferText = async (raw: string, cancelled?: () => boolean) => {
    const stop = () => cancelled?.() ?? false;
    if (stop()) return;
    setRole("phone");
    roleRef.current = "phone";
    setStages({ ...emptyStages(), qr: "ok", parse: "now" });
    let signal: SignalMessage;
    try {
      signal = parseConnectionText(raw);
    } catch (error) {
      if (stop()) return;
      markFailed("parse", error instanceof Error ? error.message : "接続情報を解析できませんでした。");
      return;
    }
    if (signal.k !== "offer") {
      if (stop()) return;
      markFailed("parse", "スマホ側で読むのはPCの接続情報です。応答はここでは使いません。");
      return;
    }
    if (stop()) return;
    setScanning(false);
    const pc = ensurePhone();
    setStages({ ...emptyStages(), qr: "ok", parse: "ok", prepare: "now" });
    if (stop() || peerRef.current !== pc) return;
    await acceptSignal(signal, pc, cancelled);
  };

  const startPc = async () => {
    release();
    roleRef.current = "pc";
    seenRef.current.clear();
    setRole("pc");
    setStages({ ...emptyStages(), prepare: "now" });
    setPhase("preparing");
    setLinkText("");
    setLinkNote("");
    setQrUrl("");
    setQrError("");
    setAnswerText("");
    setAnswerCode("");
    setPaste("");
    setConfirmInput("");
    setScanNote("");
    setReceived(null);
    setSent("");
    setSendProgress(null);
    setReceiveProgress(null);
    setFailStage("なし");
    setNote("接続候補を集めています。外部の中継は使いません。");
    let pc: RTCPeerConnection | null = null;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      peerRef.current = pc;
      bindPeer(pc);
      const channel = pc.createDataChannel("komacho-test");
      channelRef.current = channel;
      bindChannel(channel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForCandidates(pc);
      if (peerRef.current !== pc) return;
      const sdp = pc.localDescription?.sdp ?? "";
      const page = pageUrlForPhone(window.location.href, sdp);
      const link = connectionUrl(page.url, { v: 1, k: "offer", sdp });
      setLinkText(link);
      setLinkNote(page.note);
      setGathering(pc.iceGatheringState);
      const tooBig = qrByteLength(link) > QR_BYTE_LIMIT;
      patchStage("prepare", sdpHasCandidate(sdp) ? "ok" : "ng");
      if (!sdpHasCandidate(sdp)) {
        setFailStage(stageLabel("prepare"));
        setNote(`${failureNote("prepare", "接続候補がありません。")} ${page.note}`.trim());
      }
      if (tooBig) {
        setQrError("接続情報を1枚のQRに収められません。短く切ってはいません。下の住所を1回だけコピーして、スマホのブラウザに貼り付けてください。");
        patchStage("qr", "ng");
        setPhase("show-local");
        setNote("QRコードの読み取りの段階で、1枚に収まらなかったためQRは出していません。短く切ってはいません。下の住所を1回だけコピーして、スマホのブラウザに貼り付けてください。");
        return;
      }
      patchStage("qr", "now");
      setPhase("show-local");
      if (sdpHasCandidate(sdp)) {
        setNote(`このQRをスマホで1回読み取ってください。標準カメラはアプリの接続画面を開きます。検索へは移動しません。${page.note ? ` ${page.note}` : ""} ${ANSWER_RETURN_LIMIT}`);
      }
    } catch (error) {
      if (peerRef.current !== pc) return;
      const message = error instanceof Error ? error.message : "接続の準備に失敗しました。";
      markFailed("prepare", message);
      release();
    }
  };

  const startPhone = () => {
    ensurePhone();
    setStages({ ...emptyStages(), qr: "now" });
    setLinkText("");
    setQrError("");
    setPaste("");
    setScanNote("");
    setNote("PCのQRを1回読み取ってください。スマホの標準カメラで開くか、下のカメラで読みます。読み取ったあとに検索へは移動しません。");
  };

  const submitAnswer = async () => {
    const pc = peerRef.current;
    if (roleRef.current !== "pc" || !pc) {
      setNote("先にPCとしてQRを表示してください。番号だけでは接続できません。");
      return;
    }
    const result = await gateAnswer(paste, confirmInput);
    if (peerRef.current !== pc) return;
    if (!result.ok) {
      if (result.reason === "bad" || result.reason === "not-answer") {
        markFailed("parse", result.detail);
        return;
      }
      setNote(result.detail);
      patchStage("parse", result.reason === "mismatch" ? "ng" : "wait");
      if (result.reason === "mismatch") setFailStage(stageLabel("parse"));
      return;
    }
    setStages((current) => ({ ...current, qr: "ok", parse: "ok" }));
    setFailStage("なし");
    setPaste("");
    await acceptSignal(result.signal, pc);
  };

  const submitOfferPaste = () => {
    const raw = paste.trim();
    if (!raw) return;
    setPaste("");
    void acceptOfferText(raw);
  };

  const waitForSendRoom = async (channel: RTCDataChannel) => {
    if (channel.readyState !== "open") throw new Error("送信中に切断しました。");
    if (channel.bufferedAmount <= BUFFER_LIMIT) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        window.clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onLow = () => finish();
      const onClose = () => finish(new Error("送信中に切断しました。"));
      const timer = window.setTimeout(() => {
        if (channel.readyState === "open" && channel.bufferedAmount <= BUFFER_LIMIT) finish();
        else finish(new Error("送信バッファが空かず、タイムアウトしました。接続し直して再試行できます。"));
      }, 10000);
      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onClose);
    });
  };

  const sendTest = async () => {
    const channel = channelRef.current;
    if (roleRef.current !== "pc") {
      setNote("テスト送信はPC側だけです。スマホ側は受信します。");
      return;
    }
    if (!channel || channel.readyState !== "open") {
      setNote("まだ接続できていません。");
      return;
    }
    const text = `komacho-qr-test\nnonce:${crypto.randomUUID()}\nfrom:pc\n`;
    const bytes = new TextEncoder().encode(text);
    const hash = await digestHex(bytes);
    setSent(text);
    setSendProgress({ sent: 0, size: bytes.length });
    patchStage("file", "now");
    try {
      channel.send(JSON.stringify({ t: "begin", name: "komacho-qr-test.txt", size: bytes.length, hash }));
      for (let offset = 0; offset < bytes.length; offset += FILE_CHUNK) {
        if (channel.readyState !== "open") throw new Error("送信中に切断しました。");
        await waitForSendRoom(channel);
        channel.send(bytes.subarray(offset, Math.min(bytes.length, offset + FILE_CHUNK)));
        setSendProgress({ sent: Math.min(bytes.length, offset + FILE_CHUNK), size: bytes.length });
      }
      channel.send(JSON.stringify({ t: "end" }));
      patchStage("file", "ok");
      setNote("テストファイルを送りました。スマホ側の受信結果と見比べてください。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "送信に失敗しました。接続し直して再試行できます。";
      patchStage("file", "ng");
      setFailStage(stageLabel("file"));
      setNote(failureNote("file", detail));
    }
  };

  const copyText = async (value: string, box: HTMLTextAreaElement | null, success: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNote(success);
    } catch {
      box?.focus();
      box?.select();
      setNote("自動コピーは使えません。表示中の文字列を選択して、1回だけコピーしてください。");
    }
  };

  useEffect(() => {
    if (!open) reset();
    return () => release();
    // The dialog owns the peer connection. Reset only when it closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) {
      bootSeen.current = "";
      return;
    }
    if (!bootText || bootSeen.current === bootText) return;
    bootSeen.current = bootText;
    let cancelled = false;
    void acceptOfferText(bootText, () => cancelled);
    return () => {
      cancelled = true;
      bootSeen.current = "";
    };
    // The hash is consumed once per open. acceptOfferText checks cancellation itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bootText]);

  useEffect(() => {
    if (role !== "pc" || !linkText || qrByteLength(linkText) > QR_BYTE_LIMIT) {
      setQrUrl("");
      return;
    }
    let cancelled = false;
    void import("qrcode").then((mod) =>
      mod.default.toDataURL(linkText, { errorCorrectionLevel: "L", margin: 2, width: 360 }).then(
        (url) => {
          if (!cancelled) setQrUrl(url);
        },
        () => {
          if (!cancelled) {
            setQrUrl("");
            setQrError("接続情報を1枚のQRに収められません。短く切ってはいません。下の住所を1回だけコピーして、スマホのブラウザに貼り付けてください。");
            patchStage("qr", "ng");
          }
        },
      ),
    );
    return () => {
      cancelled = true;
    };
  }, [role, linkText]);

  useEffect(() => {
    if (!scanning) return;
    const video = videoRef.current;
    if (!video) return;
    let stop = false;
    let stream: MediaStream | null = null;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const watch = (raw: string) => {
      if (seenRef.current.has(raw)) return;
      seenRef.current.add(raw);
      void acceptOfferText(raw);
    };
    void (async () => {
      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        const { default: jsQR } = await import("jsqr");
        if (stop) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();
        let last = 0;
        const tick = (now: number) => {
          if (stop) return;
          if (context && now - last > 120 && video.readyState >= 2) {
            last = now;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            context.drawImage(video, 0, 0);
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(image.data, image.width, image.height);
            if (code?.data) watch(code.data);
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      } catch {
        if (!stop) {
          setScanning(false);
          setScanNote("カメラを使えません。標準カメラでQRを開くか、下の欄に住所を1回貼り付けてください。検索へは移動しません。");
          if (!secure) setScanNote("このページではカメラを使えないことがあります。PCに出ている住所を1回貼り付けてください。");
        }
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    };
    // Scanning owns the camera session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  const progress = sendProgress && sendProgress.size > 0 ? Math.round((sendProgress.sent / sendProgress.size) * 100) : 0;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="storage-sheet qr-test-sheet">
          <div className="border-b border-line px-4 py-3">
            <Dialog.Title className="font-medium">QR接続テスト</Dialog.Title>
            <Dialog.Description className="text-sm text-ink-muted">
              PCからスマホへ、小さなテストファイルだけを送ります。画像や保存データには触れません。
            </Dialog.Description>
          </div>
          <div className="space-y-4 px-4 py-4 text-sm">
            <p className="text-ink-muted">
              外部の中継サーバー、STUN、TURNは使いません。QRに入るのは、この接続画面を開く住所と接続情報だけです。画像・アカウント・保存データは入れません。直接つなぐため、端末のローカルアドレスが接続情報に入ることがあります。別のネットワークでは、中継なしでは届かないことが普通です。
            </p>
            <p>{ANSWER_RETURN_LIMIT}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="quiet" onClick={() => void startPc()}>
                PCとしてQRを表示
              </Button>
              <Button variant="quiet" onClick={startPhone}>
                スマホとして待つ
              </Button>
              <Button variant="quiet" onClick={reset}>
                最初からやり直す
              </Button>
            </div>
            <section className="space-y-2">
              <h2 className="font-medium">接続段階</h2>
              <ol className="qr-stages">
                {CONNECT_STAGES.map((stage) => (
                  <li key={stage} data-qr-stage={stage} data-status={stages[stage]}>
                    <span>{stageLabel(stage)}</span>
                    <span>{statusWord(stages[stage])}</span>
                  </li>
                ))}
              </ol>
              <p>役割: {role === "pc" ? "PC" : role === "phone" ? "スマホ" : "未選択"}</p>
              <p>状態: {phaseLabel(phase)}</p>
              <p>ICE: {ice}</p>
              <p>候補の収集: {gathering}</p>
              <p>データチャネル: {channelState}</p>
              <p>失敗した段階: {failStage}</p>
              {note ? <p>{note}</p> : null}
            </section>
            {role === "pc" && linkText ? (
              <section className="space-y-2">
                <h2 className="font-medium">PCの接続用QR（1枚）</h2>
                <p className="text-ink-muted">PCにカメラは要りません。スマホでこのQRを1回読むと、アプリの接続画面が開きます。</p>
                {qrUrl ? <img className="qr-test-image" src={qrUrl} alt="接続用QR" /> : null}
                {qrError ? <p>{qrError}</p> : null}
                {linkNote ? <p>{linkNote}</p> : null}
                <textarea ref={linkRef} className="w-full rounded-md border border-line bg-paper px-2 py-1" readOnly rows={3} value={linkText} data-qr-link="" />
                <Button variant="quiet" onClick={() => void copyText(linkText, linkRef.current, "接続用の住所をコピーしました。スマホのブラウザに1回だけ貼り付けてください。")}>
                  QRを読めないときだけ住所をコピー
                </Button>
              </section>
            ) : null}
            {role === "pc" && linkText ? (
              <section className="space-y-2">
                <h2 className="font-medium">スマホからの応答（1回だけ貼り付け）</h2>
                <p className="text-ink-muted">自動では届きません。応答の文字列と、確認用の4桁の両方が必要です。4桁だけ入力しても接続しません。</p>
                <textarea
                  className="w-full rounded-md border border-line bg-paper px-2 py-1"
                  rows={3}
                  value={paste}
                  placeholder="スマホに出た応答を、ここに1回貼り付けます"
                  data-qr-paste=""
                  onChange={(event) => setPaste(event.target.value)}
                />
                <label className="block space-y-1">
                  <span>確認用の4桁（これだけでは接続しません）</span>
                  <input
                    className="w-24 rounded-md border border-line bg-paper px-2 py-2 text-center text-lg tracking-widest"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={4}
                    value={confirmInput}
                    data-qr-confirm=""
                    onChange={(event) => setConfirmInput(event.target.value.replace(/\D/g, "").slice(0, 4))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submitAnswer();
                    }}
                  />
                </label>
                <Button variant="quiet" onClick={() => void submitAnswer()}>
                  応答を確認して接続
                </Button>
              </section>
            ) : null}
            {role === "phone" && !answerText ? (
              <section className="space-y-2">
                <h2 className="font-medium">アプリ内でQRを読む</h2>
                <p className="text-ink-muted">標準カメラで開いた場合は、この操作は要りません。ここでの読み取りは住所を開かず、この画面で解析します。検索へは移動しません。</p>
                {scanning ? <video ref={videoRef} className="qr-test-camera" muted playsInline /> : <video ref={videoRef} className="hidden" muted playsInline />}
                <Button variant="quiet" onClick={() => setScanning((value) => !value)}>
                  {scanning ? "カメラを止める" : "カメラで1回読み取る"}
                </Button>
                <textarea
                  className="w-full rounded-md border border-line bg-paper px-2 py-1"
                  rows={3}
                  value={paste}
                  placeholder="標準カメラが使えないときは、PCの住所を1回貼り付けます"
                  onChange={(event) => setPaste(event.target.value)}
                />
                <Button variant="quiet" onClick={submitOfferPaste}>
                  貼り付けた住所を解析
                </Button>
                {scanNote ? <p>{scanNote}</p> : null}
              </section>
            ) : null}
            {role === "phone" && answerText ? (
              <section className="space-y-2">
                <h2 className="font-medium">PCへ返す応答（1回だけコピー）</h2>
                <p>確認用の4桁</p>
                <p className="qr-confirm-code" data-qr-code="">
                  {answerCode}
                </p>
                <p className="text-ink-muted">この番号だけでは接続できません。下の応答をPCに1回貼り付け、PCで同じ4桁を入力します。</p>
                <textarea ref={answerRef} className="w-full rounded-md border border-line bg-paper px-2 py-1" readOnly rows={3} value={answerText} data-qr-answer="" />
                <Button variant="quiet" onClick={() => void copyText(answerText, answerRef.current, "応答をコピーしました。PCに1回だけ貼り付け、同じ4桁を入力してください。")}>
                  応答を1回コピー
                </Button>
              </section>
            ) : null}
            <section className="space-y-2">
              <h2 className="font-medium">テストファイル送信（PCからスマホ）</h2>
              <p className="text-ink-muted">スマホ側はこのボタンを使えません。受信結果で内容を確認します。</p>
              <Button variant="quiet" disabled={role !== "pc" || phase !== "open"} onClick={() => void sendTest()}>
                テストファイルを送る
              </Button>
              {sendProgress ? (
                <>
                  <p>
                    komacho-qr-test.txt / {sendProgress.sent}/{sendProgress.size} バイト
                  </p>
                  <div className="storage-bar" role="meter" aria-label="送信進捗" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                    <span style={{ width: `${progress}%` }} />
                  </div>
                </>
              ) : null}
              {sent ? <pre className="overflow-auto rounded-md border border-line bg-paper p-2">{sent}</pre> : null}
            </section>
            <section className="space-y-2">
              <h2 className="font-medium">受信結果</h2>
              {receiveProgress ? (
                <>
                  <p>
                    {receiveProgress.name} / 受信 {receiveProgress.got}/{receiveProgress.size} バイト
                  </p>
                  <div
                    className="storage-bar"
                    role="meter"
                    aria-label="受信進捗"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={receiveProgress.size > 0 ? Math.round((receiveProgress.got / receiveProgress.size) * 100) : 0}
                  >
                    <span style={{ width: `${receiveProgress.size > 0 ? Math.round((receiveProgress.got / receiveProgress.size) * 100) : 0}%` }} />
                  </div>
                </>
              ) : (
                <p className="text-ink-muted">まだ受信していません。</p>
              )}
              {received ? (
                <>
                  <p>
                    {received.name} / {received.size} バイト / {received.match ? "一致" : "不一致"}
                  </p>
                  <pre className="overflow-auto rounded-md border border-line bg-paper p-2">{received.text}</pre>
                  <a className="underline" href={received.url} download={received.name}>
                    受信ファイルをダウンロード
                  </a>
                </>
              ) : null}
            </section>
          </div>
          <div className="flex justify-end border-t border-line px-4 py-3">
            <Dialog.Close asChild>
              <Button variant="quiet">閉じる</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
