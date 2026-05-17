"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
    ArrowUp,
    GlobeIcon,
    GripVertical,
    HelpCircle,
    Loader2,
    Sparkles,
    XIcon,
} from "lucide-react";
import type { ColumnConfig, ColumnFormat } from "@/app/components/shared/types";
import {
    refineWorkflowWithAi,
    streamSuggestTabularColumnsWithAi,
    updateTabularReview,
    updateWorkflow,
    type AiColumnSuggesterEvent,
} from "@/app/lib/mikeApi";

const VALID_FORMATS: ColumnFormat[] = [
    "text",
    "bulleted_list",
    "number",
    "percentage",
    "monetary_amount",
    "currency",
    "yes_no",
    "date",
    "tag",
];

function normalizeFormat(raw: string | undefined): ColumnFormat {
    const v = (raw ?? "text").toLowerCase().trim();
    return VALID_FORMATS.includes(v as ColumnFormat)
        ? (v as ColumnFormat)
        : "text";
}

type WorkflowProps = {
    variant: "workflow";
    workflowId: string;
    onApplied: (next: {
        title: string;
        prompt_md: string;
        columns: ColumnConfig[];
    }) => void;
};

type TabularProps = {
    variant: "tabular";
    reviewId: string;
    columns: ColumnConfig[];
    onApplied: (next: ColumnConfig[]) => void;
};

type Props = WorkflowProps | TabularProps;

const TEXTAREA_MAX_PX = 140;

type StatusPhase = "thinking" | "searching" | "applying";

type WebSearchHit = {
    query: string;
    provider: string;
    count: number;
};

export function FloatingAiPrompt(props: Props) {
    const t = useTranslations("floatingAi");
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const taRef = useRef<HTMLTextAreaElement>(null);

    /* ---- agentic state (tabular variant only) ---- */
    const [statusPhase, setStatusPhase] = useState<StatusPhase | null>(null);
    const [statusDetail, setStatusDetail] = useState<string | null>(null);
    const [webHits, setWebHits] = useState<WebSearchHit[]>([]);
    const [clarify, setClarify] = useState<{
        question: string;
        original: string;
    } | null>(null);

    const abortRef = useRef<AbortController | null>(null);

    const resetAgenticState = useCallback(() => {
        setStatusPhase(null);
        setStatusDetail(null);
        setWebHits([]);
    }, []);

    /* ---- drag state ---- */
    const containerRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
    const dragging = useRef(false);
    const dragOffset = useRef({ x: 0, y: 0 });

    const handlePointerDown = useCallback(
        (e: React.PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const el = containerRef.current;
            if (!el) return;

            dragging.current = true;

            const rect = el.getBoundingClientRect();
            // If first drag and still centred via CSS transform, initialise pos
            const currentX = pos?.x ?? rect.left;
            const currentY = pos?.y ?? rect.top;
            dragOffset.current = {
                x: e.clientX - currentX,
                y: e.clientY - currentY,
            };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
        },
        [pos],
    );

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragging.current) return;
        const el = containerRef.current;
        if (!el) return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const nx = Math.min(
            Math.max(0, e.clientX - dragOffset.current.x),
            window.innerWidth - w,
        );
        const ny = Math.min(
            Math.max(0, e.clientY - dragOffset.current.y),
            window.innerHeight - h,
        );
        setPos({ x: nx, y: ny });
    }, []);

    const handlePointerUp = useCallback(() => {
        dragging.current = false;
    }, []);

    useEffect(() => {
        const el = taRef.current;
        if (!el) return;
        el.style.height = "0px";
        el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_PX)}px`;
    }, [text]);

    useEffect(
        () => () => {
            abortRef.current?.abort();
        },
        [],
    );

    async function runTabular(rawInstruction: string, originalText: string) {
        if (props.variant !== "tabular") return;

        // Build effective instruction. When the user is answering a
        // clarification, prepend the original prompt so the model has
        // both turns of context in a single agentic call (the endpoint
        // is stateless across requests by design).
        const effectiveInstruction = clarify
            ? `${clarify.original}\n\n[user clarification]: ${rawInstruction}`
            : rawInstruction;

        const controller = new AbortController();
        abortRef.current = controller;

        let resultColumns: typeof props.columns | null = null;
        let resultExplanation: string | null = null;
        let clarifyQuestion: string | null = null;
        let streamError: string | null = null;

        try {
            await streamSuggestTabularColumnsWithAi({
                reviewId: props.reviewId,
                instruction: effectiveInstruction,
                columns_config: props.columns,
                signal: controller.signal,
                onEvent: (ev: AiColumnSuggesterEvent) => {
                    switch (ev.type) {
                        case "status":
                            setStatusPhase(ev.phase);
                            // Only surface a `message` if it looks like
                            // human-readable text (contains a space or
                            // non-ASCII char). Internal keys like
                            // "analyzing_columns" should never reach the UI.
                            setStatusDetail(
                                ev.message &&
                                    /[\s\u00A0-\uFFFF]/.test(ev.message)
                                    ? ev.message
                                    : null,
                            );
                            break;
                        case "web_search_started":
                            setStatusPhase("searching");
                            setStatusDetail(ev.query);
                            break;
                        case "web_search_result":
                            setWebHits((prev) => [
                                ...prev,
                                {
                                    query: ev.query,
                                    provider: ev.provider,
                                    count: ev.results.length,
                                },
                            ]);
                            break;
                        case "clarify":
                            clarifyQuestion = ev.question;
                            break;
                        case "result": {
                            const start = 0;
                            const next: ColumnConfig[] = ev.columns.map(
                                (c, i) => ({
                                    index: start + i,
                                    name: c.name,
                                    prompt: c.prompt,
                                    format: normalizeFormat(c.format),
                                    tags: c.tags,
                                }),
                            );
                            resultColumns = next;
                            resultExplanation = ev.explanation ?? null;
                            break;
                        }
                        case "error":
                            streamError = ev.message;
                            break;
                        case "done":
                            // no-op — handled below after the stream closes
                            break;
                    }
                },
            });
        } catch (e) {
            if ((e as Error).name === "AbortError") return;
            console.error("[FloatingAiPrompt] stream failed", e);
            streamError = (e as Error).message;
        } finally {
            abortRef.current = null;
        }

        // Stream is closed — apply the terminal event.
        if (streamError) {
            setErr(streamError || t("error"));
            return;
        }

        if (clarifyQuestion) {
            setClarify({ question: clarifyQuestion, original: originalText });
            // Keep what the user typed visible so they can iterate on
            // it, but pre-empt a fresh focus to the textarea.
            setText("");
            requestAnimationFrame(() => taRef.current?.focus());
            return;
        }

        if (resultColumns) {
            try {
                await updateTabularReview(props.reviewId, {
                    columns_config: resultColumns,
                });
                props.onApplied(resultColumns);
                setText("");
                setClarify(null);
                if (resultExplanation) {
                    // Surface the model's one-liner briefly via statusDetail
                    // (kept after the stream so the user sees what changed).
                    setStatusDetail(resultExplanation);
                } else {
                    setStatusDetail(null);
                }
                setStatusPhase(null);
            } catch (e) {
                console.error("[FloatingAiPrompt] updateTabularReview failed", e);
                setErr(t("error"));
            }
            return;
        }

        // No terminal event — model misbehaved.
        setErr(t("error"));
    }

    async function handleSubmit() {
        const instruction = text.trim();
        if (!instruction || busy) return;
        setBusy(true);
        setErr(null);
        resetAgenticState();
        try {
            if (props.variant === "workflow") {
                const out = await refineWorkflowWithAi(
                    props.workflowId,
                    instruction,
                );
                const rawCols = (out.columns_config ?? []) as Record<
                    string,
                    unknown
                >[];
                const columns: ColumnConfig[] = rawCols.map((c, i) => ({
                    index: i,
                    name: String(c.name ?? ""),
                    prompt: String(c.prompt ?? ""),
                    format: normalizeFormat(String(c.format ?? "text")),
                    tags: Array.isArray(c.tags)
                        ? c.tags.filter((x) => typeof x === "string")
                        : undefined,
                }));
                await updateWorkflow(props.workflowId, {
                    title: out.title,
                    prompt_md: out.prompt_md,
                    columns_config: columns,
                });
                props.onApplied({
                    title: out.title,
                    prompt_md: out.prompt_md,
                    columns,
                });
                setText("");
            } else {
                await runTabular(instruction, instruction);
            }
        } catch (e) {
            console.error("[FloatingAiPrompt] submit failed", e);
            setErr(t("error"));
        } finally {
            setBusy(false);
        }
    }

    function handleCancel() {
        abortRef.current?.abort();
        abortRef.current = null;
        setBusy(false);
        resetAgenticState();
    }

    function handleDismissClarify() {
        setClarify(null);
    }

    const isWorkflow = props.variant === "workflow";
    const placeholder = clarify
        ? t("clarifyAnswerPlaceholder")
        : isWorkflow
          ? t("workflowPlaceholder")
          : t("tabularPlaceholder");
    const sendLabel = isWorkflow ? t("workflowSubmit") : t("tabularSubmit");

    /* When `pos` is set we switch from CSS-centred to absolute left/top */
    const positionStyle: React.CSSProperties = pos
        ? {
              left: pos.x,
              top: pos.y,
              transform: "none",
              pointerEvents: "none" as const,
          }
        : {
              bottom: 24,
              left: "50%",
              transform: "translateX(-50%)",
              pointerEvents: "none" as const,
          };

    const statusLabel = statusPhase
        ? statusPhase === "thinking"
            ? t("statusThinking")
            : statusPhase === "searching"
              ? t("statusSearching")
              : t("statusApplying")
        : null;

    return (
        <div
            ref={containerRef}
            className="fixed z-[90] w-[min(820px,calc(100vw-3rem))]"
            style={positionStyle}
        >
            {/* Clarification banner */}
            {clarify && (
                <div
                    className="mb-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 shadow-[0_4px_18px_rgba(0,0,0,0.05)]"
                    style={{ pointerEvents: "auto" }}
                >
                    <div className="flex items-start gap-2">
                        <HelpCircle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
                        <div className="flex-1">
                            <div className="text-[11px] uppercase tracking-wide text-amber-700 font-medium">
                                {t("clarifyHeader")}
                            </div>
                            <div className="text-sm text-amber-900 mt-0.5">
                                {clarify.question}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={handleDismissClarify}
                            className="text-amber-600 hover:text-amber-800 transition-colors"
                            title={t("dismiss")}
                            aria-label={t("dismiss")}
                        >
                            <XIcon className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            )}

            {/* Live status while the agent is running */}
            {busy && statusLabel && (
                <div
                    className="mb-2 rounded-full border border-gray-200 bg-white/90 backdrop-blur px-3 py-1.5 shadow-[0_2px_10px_rgba(0,0,0,0.04)] flex items-center gap-2 max-w-fit mx-auto"
                    style={{ pointerEvents: "auto" }}
                >
                    {statusPhase === "searching" ? (
                        <GlobeIcon className="h-3.5 w-3.5 text-gray-500" />
                    ) : (
                        <Loader2 className="h-3.5 w-3.5 text-gray-500 animate-spin" />
                    )}
                    <span className="text-xs text-gray-700">{statusLabel}</span>
                    {statusDetail && (
                        <span className="text-xs text-gray-400 truncate max-w-[320px]">
                            — {statusDetail}
                        </span>
                    )}
                </div>
            )}

            {/* Web search hit summary (after stream — small chip strip) */}
            {!busy && webHits.length > 0 && (
                <div
                    className="mb-2 flex flex-wrap gap-1.5 max-w-[640px] mx-auto justify-center"
                    style={{ pointerEvents: "auto" }}
                >
                    {webHits.map((h, i) => (
                        <span
                            key={i}
                            className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-600 px-2 py-0.5 text-[11px]"
                            title={`${h.provider} · ${h.count} ${t("results")}`}
                        >
                            <GlobeIcon className="h-3 w-3" />
                            {h.query.length > 48
                                ? h.query.slice(0, 48) + "…"
                                : h.query}
                        </span>
                    ))}
                </div>
            )}

            <div
                className="rounded-full border border-gray-200 bg-white shadow-[0_4px_24px_rgba(0,0,0,0.07)] flex items-center gap-3 pl-2 pr-1.5 py-1.5 focus-within:border-gray-900 focus-within:shadow-[0_4px_28px_rgba(0,0,0,0.10)] transition-colors"
                style={{ pointerEvents: "auto" }}
            >
                {/* Drag handle */}
                <div
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    className="flex items-center gap-1 cursor-grab active:cursor-grabbing select-none pl-1 pr-1 py-1 rounded-full hover:bg-gray-100 transition-colors touch-none"
                    title={t("dragHandle")}
                >
                    <GripVertical className="h-3.5 w-3.5 text-gray-400" />
                    <Sparkles className="h-4 w-4 text-gray-700 shrink-0" />
                </div>

                <textarea
                    ref={taRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void handleSubmit();
                        }
                    }}
                    placeholder={placeholder}
                    rows={1}
                    disabled={busy}
                    aria-label={sendLabel}
                    className="flex-1 resize-none bg-transparent border-none outline-none text-sm text-gray-800 placeholder:text-gray-400 placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap py-2 leading-5 max-h-[160px] overflow-y-auto"
                />
                <button
                    type="button"
                    disabled={!busy && !text.trim()}
                    onClick={() =>
                        busy ? handleCancel() : void handleSubmit()
                    }
                    title={busy ? t("cancel") : sendLabel}
                    aria-label={busy ? t("cancel") : sendLabel}
                    className="flex items-center justify-center h-9 w-9 rounded-full bg-gray-900 text-white hover:bg-gray-800 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                    {busy ? (
                        <XIcon className="h-4 w-4" />
                    ) : (
                        <ArrowUp className="h-4 w-4" />
                    )}
                </button>
            </div>
            {err && (
                <p
                    className="mt-2 text-xs text-red-600 text-center"
                    style={{ pointerEvents: "auto" }}
                >
                    {err}
                </p>
            )}
        </div>
    );
}
