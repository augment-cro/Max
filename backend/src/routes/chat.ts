import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    buildDocContext,
    buildMessages,
    enrichWithPriorEvents,
    buildWorkflowStore,
    extractAnnotations,
    runLLMStream,
    type ChatMessage,
} from "../lib/chatTools";
import { completeText } from "../lib/llm";
import { recordLlmUsage } from "../lib/llmUsage";
import { getUserApiKeys, getUserModelSettings } from "../lib/userSettings";
import { localeContextForLlm, parseUiLocale } from "../lib/uiLocale";
import { checkProjectAccess } from "../lib/access";
import {
    closeMcpServers,
    loadEnabledMcpServersForUser,
} from "../lib/mcp/servers";
import { loadBuiltinMcpServers } from "../lib/mcp/builtin";

export const chatRouter = Router();

/**
 * Per-chat collaborator check (jsonb email list on chats.shared_with —
 * see migration 109). Mirrors the projects.shared_with pattern: anyone
 * whose JWT-derived email is in the array is allowed to read and post
 * to the chat, but PATCH/DELETE still stay owner-only.
 */
function chatHasCollaborator(
    chat: { shared_with?: unknown } | null | undefined,
    userEmail: string,
): boolean {
    if (!chat || !userEmail) return false;
    const list = (chat as { shared_with?: unknown }).shared_with;
    if (!Array.isArray(list)) return false;
    const target = userEmail.toLowerCase();
    return (list as unknown[]).some(
        (e) => typeof e === "string" && e.toLowerCase() === target,
    );
}

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
chatRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();

    const { data: ownProjects, error: projErr } = await db
        .from("projects")
        .select("id")
        .eq("user_id", userId);
    if (projErr) return void res.status(500).json({ detail: projErr.message });
    const ownProjectIds = ((ownProjects ?? []) as { id: string }[]).map(
        (p) => p.id,
    );

    const filter =
        ownProjectIds.length > 0
            ? `user_id.eq.${userId},project_id.in.(${ownProjectIds.join(",")})`
            : `user_id.eq.${userId}`;

    const { data, error } = await db
        .from("chats")
        .select("*")
        .or(filter)
        .order("created_at", { ascending: false });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json(data ?? []);
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const projectId: string | null = req.body.project_id ?? null;
    const db = createServerSupabase();
    const { data, error } = await db
        .from("chats")
        .insert({ user_id: userId, project_id: projectId ?? undefined })
        .select("id")
        .single();

    if (error) return void res.status(500).json({ detail: error.message });
    res.json({ id: data.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    const { data: chat, error } = await db
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .single();
    if (error || !chat)
        return void res.status(404).json({ detail: "Chat not found" });
    // Owner of the chat, member of the chat's project, OR a per-chat
    // collaborator (chats.shared_with — added after accepting a share
    // invite, see routes/chatShares.ts) can view it.
    let canView = chat.user_id === userId;
    if (!canView && chat.project_id) {
        const access = await checkProjectAccess(
            chat.project_id,
            userId,
            userEmail,
            db,
        );
        canView = access.ok;
    }
    if (!canView && userEmail) {
        canView = chatHasCollaborator(chat, userEmail);
    }
    if (!canView)
        return void res.status(404).json({ detail: "Chat not found" });

    const { data: messages } = await db
        .from("chat_messages")
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });

    const hydrated = await hydrateEditStatuses(messages ?? [], db);
    res.json({ chat, messages: hydrated });
});

// Stored message annotations/events capture the `status` at the time the
// assistant produced the edit (always "pending"). If the user later accepts
// or rejects, `document_edits.status` is updated but the stored message
// annotation is not. On chat load we merge the current DB status in so
// EditCards render with the real state.
async function hydrateEditStatuses(
    messages: Record<string, unknown>[],
    db: ReturnType<typeof createServerSupabase>,
): Promise<Record<string, unknown>[]> {
    const editIds = new Set<string>();
    const versionIds = new Set<string>();
    const collectFromAnnList = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const a of list as Record<string, unknown>[]) {
            if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
            if (typeof a?.version_id === "string")
                versionIds.add(a.version_id);
        }
    };
    for (const m of messages) {
        collectFromAnnList(m.annotations);
        const content = m.content;
        if (Array.isArray(content)) {
            for (const ev of content as Record<string, unknown>[]) {
                if (ev?.type === "doc_edited") {
                    collectFromAnnList(ev.annotations);
                    if (typeof ev.version_id === "string")
                        versionIds.add(ev.version_id);
                }
            }
        }
    }
    if (editIds.size === 0 && versionIds.size === 0) return messages;

    // Edit status patch.
    const statusById = new Map<string, "pending" | "accepted" | "rejected">();
    if (editIds.size > 0) {
        const { data: rows } = await db
            .from("document_edits")
            .select("id, status")
            .in("id", Array.from(editIds));
        for (const r of (rows ?? []) as { id: string; status: string }[]) {
            if (
                r.status === "pending" ||
                r.status === "accepted" ||
                r.status === "rejected"
            ) {
                statusById.set(r.id, r.status);
            }
        }
    }

    // Version-number patch — old stored events don't carry `version_number`
    // because they predate the schema change. Look it up from
    // document_versions so the UI can render "V3" chips + download filenames.
    const versionNumberById = new Map<string, number | null>();
    if (versionIds.size > 0) {
        const { data: vrows } = await db
            .from("document_versions")
            .select("id, version_number")
            .in("id", Array.from(versionIds));
        for (const r of (vrows ?? []) as {
            id: string;
            version_number: number | null;
        }[]) {
            versionNumberById.set(r.id, r.version_number ?? null);
        }
    }

    const patchAnnList = (list: unknown): unknown => {
        if (!Array.isArray(list)) return list;
        return (list as Record<string, unknown>[]).map((a) => {
            let next = a;
            if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
                next = { ...next, status: statusById.get(a.edit_id) };
            }
            if (
                typeof a?.version_id === "string" &&
                versionNumberById.has(a.version_id)
            ) {
                next = {
                    ...next,
                    version_number: versionNumberById.get(a.version_id) ?? null,
                };
            }
            return next;
        });
    };
    return messages.map((m) => {
        const next: Record<string, unknown> = { ...m };
        next.annotations = patchAnnList(m.annotations);
        if (Array.isArray(m.content)) {
            next.content = (m.content as Record<string, unknown>[]).map(
                (ev) => {
                    if (ev?.type !== "doc_edited") return ev;
                    let patched: Record<string, unknown> = {
                        ...ev,
                        annotations: patchAnnList(ev.annotations),
                    };
                    if (
                        typeof ev.version_id === "string" &&
                        versionNumberById.has(ev.version_id)
                    ) {
                        patched = {
                            ...patched,
                            version_number:
                                versionNumberById.get(ev.version_id) ?? null,
                        };
                    }
                    return patched;
                },
            );
        }
        return next;
    });
}

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const title = (req.body.title ?? "").trim();
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const db = createServerSupabase();
    const { data, error } = await db
        .from("chats")
        .update({ title })
        .eq("id", chatId)
        .eq("user_id", userId)
        .select("id, title")
        .single();

    if (error || !data)
        return void res.status(404).json({ detail: "Chat not found" });
    res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const { error } = await db
        .from("chats")
        .delete()
        .eq("id", chatId)
        .eq("user_id", userId);

    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

// POST /chat/messages/:messageId/flag
// Toggle the "not appropriate answer" flag on an assistant message.
//
// Body: { flagged: boolean, reason?: string }
//
// Anyone with access to the parent chat (owner, project member, or
// per-chat collaborator) may flag a message — flags reflect *the
// requesting user's* opinion of the assistant reply, not just the
// chat owner's, so consumers in a shared chat can all surface concerns.
// The denormalised `is_flagged` boolean reflects the most recent
// action; the full toggle history lives in chat_message_flags.
chatRouter.post(
    "/messages/:messageId/flag",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { messageId } = req.params;
        const flagged = !!req.body?.flagged;
        const reasonRaw = req.body?.reason;
        const reason =
            typeof reasonRaw === "string" && reasonRaw.trim().length > 0
                ? reasonRaw.trim().slice(0, 500)
                : "not_appropriate";

        const db = createServerSupabase();
        const { data: msg, error: msgErr } = await db
            .from("chat_messages")
            .select("id, chat_id, role")
            .eq("id", messageId)
            .single();
        if (msgErr || !msg)
            return void res.status(404).json({ detail: "Message not found" });
        if (msg.role !== "assistant")
            return void res
                .status(400)
                .json({ detail: "Only assistant messages can be flagged" });

        const { data: chat } = await db
            .from("chats")
            .select("id, user_id, project_id, shared_with")
            .eq("id", msg.chat_id)
            .single();
        if (!chat)
            return void res.status(404).json({ detail: "Chat not found" });

        let canFlag = chat.user_id === userId;
        if (!canFlag && chat.project_id) {
            const access = await checkProjectAccess(
                chat.project_id,
                userId,
                userEmail,
                db,
            );
            canFlag = access.ok;
        }
        if (!canFlag && userEmail) {
            canFlag = chatHasCollaborator(chat, userEmail);
        }
        if (!canFlag)
            return void res.status(404).json({ detail: "Message not found" });

        const nowIso = new Date().toISOString();
        const { error: updErr } = await db
            .from("chat_messages")
            .update({
                is_flagged: flagged,
                flagged_at: flagged ? nowIso : null,
                flagged_by: flagged ? userId : null,
            })
            .eq("id", messageId);
        if (updErr)
            return void res.status(500).json({ detail: updErr.message });

        await db.from("chat_message_flags").insert({
            chat_message_id: messageId,
            chat_id: msg.chat_id,
            user_id: userId,
            action: flagged ? "flag" : "unflag",
            reason: flagged ? reason : null,
        });

        res.json({
            id: messageId,
            is_flagged: flagged,
            flagged_at: flagged ? nowIso : null,
        });
    },
);

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const message: string = (req.body.message ?? "").trim();
    if (!message)
        return void res.status(400).json({ detail: "message is required" });

    const db = createServerSupabase();
    const { data: chat, error } = await db
        .from("chats")
        .select("id, user_id, project_id, shared_with")
        .eq("id", chatId)
        .single();

    if (error || !chat)
        return void res.status(404).json({ detail: "Chat not found" });
    let canTitle = chat.user_id === userId;
    if (!canTitle && chat.project_id) {
        const access = await checkProjectAccess(
            chat.project_id,
            userId,
            userEmail,
            db,
        );
        canTitle = access.ok;
    }
    if (!canTitle && userEmail) {
        canTitle = chatHasCollaborator(chat, userEmail);
    }
    if (!canTitle)
        return void res.status(404).json({ detail: "Chat not found" });

    try {
        const { title_model, api_keys, preferred_language } =
            await getUserModelSettings(userId, db);
        const langName =
            preferred_language === "hr" ? "Croatian" : "English";
        const titleText = await completeText({
            model: title_model,
            user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title MUST be written in ${langName} (the user's UI language), regardless of the language of the user's message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. Return only the title, no quotes or punctuation.\n\nMessage: ${message.slice(0, 500)}`,
            maxTokens: 64,
            apiKeys: api_keys,
        });
        const title = titleText.trim() || message.slice(0, 60);

        await db
            .from("chats")
            .update({ title })
            .eq("id", chatId)
            .eq("user_id", userId);

        res.json({ title });
    } catch (err) {
        console.error("[generate-title]", err);
        res.status(500).json({ detail: "Failed to generate title" });
    }
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const {
        messages,
        chat_id,
        project_id,
        model,
        effort,
        client,
        editMode,
    } = req.body as {
        messages: ChatMessage[];
        chat_id?: string;
        project_id?: string;
        model?: string;
        // User-selected reasoning intensity for this turn. Validated
        // below against the canonical "low" | "medium" | "high" set so
        // a malformed client can't crash the provider with an invalid
        // value.
        effort?: string;
        // `client` lets the LLM tailor its tool-use strategy: the Word
        // add-in needs `find` strings that survive Office.js' search
        // primitive (≤200 chars, single paragraph). Defaults to "web"
        // when missing so existing callers (Max frontend, public API)
        // keep their behavior.
        client?: "web" | "word";
        // How the user wants edits applied in the Word client. Plumbed
        // into the system prompt so the model phrases reasons
        // accordingly, and echoed in the `doc_edited` event so the
        // client picks the right Apply UI.
        editMode?: "track" | "comments";
    };
    const reasoningEffort: "low" | "medium" | "high" | undefined =
        effort === "low" || effort === "medium" || effort === "high"
            ? effort
            : undefined;

    console.log("[chat/stream] incoming request", {
        userId,
        chat_id,
        project_id,
        model,
        // Effort is logged so we can verify in Cloud Run logs that the
        // picker is actually wired through to the provider — see
        // backend/src/lib/llm/{claude,openai,gemini}.ts where it lands
        // in `output_config.effort` / `reasoning_effort` /
        // `thinkingConfig.thinkingLevel`. Raw `effort` shows what the
        // client sent; `reasoningEffort` shows what we accepted after
        // validation.
        effort,
        reasoningEffort,
        client: client ?? "web",
        editMode: editMode ?? "track",
        messageCount: messages?.length,
    });

    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;

    if (chatId) {
        // Chat owner, a member of the chat's project, OR a per-chat
        // collaborator (chats.shared_with) can post into the thread.
        const { data: existing } = await db
            .from("chats")
            .select("id, title, user_id, project_id, shared_with")
            .eq("id", chatId)
            .single();
        let canUse = !!existing && existing.user_id === userId;
        if (!canUse && existing?.project_id) {
            const access = await checkProjectAccess(
                existing.project_id,
                userId,
                userEmail,
                db,
            );
            canUse = access.ok;
        }
        if (!canUse && existing && userEmail) {
            canUse = chatHasCollaborator(existing, userEmail);
        }
        if (!canUse || !existing) chatId = null;
        else chatTitle = existing.title;
    }

    if (!chatId) {
        // If creating a chat tied to a project, the user must have access
        // to the project (own or shared).
        if (project_id) {
            const access = await checkProjectAccess(
                project_id,
                userId,
                userEmail,
                db,
            );
            if (!access.ok)
                return void res
                    .status(404)
                    .json({ detail: "Project not found" });
        }
        const { data: newChat, error } = await db
            .from("chats")
            .insert({ user_id: userId, project_id: project_id ?? null })
            .select("id, title")
            .single();
        if (error || !newChat) {
            console.error("[chat/stream] failed to create chat", error);
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        }
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    console.log("[chat/stream] resolved chatId", chatId);

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
        await db.from("chat_messages").insert({
            chat_id: chatId,
            role: "user",
            // `chat_messages.content` is jsonb (migration 107) — user turns
            // are plain strings, but jsonb wants a JSON literal, so wrap
            // the string as a JSON-string literal. Assistant inserts pass
            // an array which the dbShim already JSON.stringify's.
            content: JSON.stringify(lastUser.content ?? ""),
            files: lastUser.files ?? null,
            workflow: lastUser.workflow ?? null,
        });
    }

    const { docIndex, docStore } = await buildDocContext(
        messages,
        userId,
        db,
        chatId,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
    }));
    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
    );
    const apiMessages = buildMessages(
        enrichedMessages,
        docAvailability,
        localeContextForLlm(parseUiLocale(req)),
        docIndex,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    console.log("[chat/stream] starting LLM stream", {
        apiMessageCount: apiMessages.length,
        docCount: Object.keys(docIndex).length,
        workflowCount: Object.keys(workflowStore).length,
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    // Opt this response (and any future request to the same origin) out of
    // HTTP/3. Cloud Run advertises QUIC via Alt-Svc; Chrome then keeps a
    // long-lived UDP/443 flow open for the SSE stream, which middleboxes
    // (corp VPN, hotel Wi-Fi, NAT rebind on Wi-Fi↔LTE handover) like to drop
    // mid-answer with net::ERR_QUIC_PROTOCOL_ERROR after 60-180s. Clearing
    // Alt-Svc forces Chrome back to HTTP/2 over TCP, where the same path
    // survives because TCP keeps a stateful connection middleboxes respect.
    res.setHeader("Alt-Svc", "clear");
    res.flushHeaders();

    // Keep the underlying socket open for the duration of the stream.
    // Long extended-thinking + multi-MCP runs can exceed Node's default
    // 2-minute request socket timeout, which would surface as the browser
    // dropping the connection mid-answer ("load failed"). 0 disables the
    // per-request timer; the Cloud Run service-level --timeout=3600 still
    // bounds the overall lifetime.
    if (typeof req.setTimeout === "function") req.setTimeout(0);
    if (typeof res.setTimeout === "function") res.setTimeout(0);

    const write = (line: string) => res.write(line);

    // SSE keep-alive heartbeat. Comment lines (": …") are ignored by the
    // EventSource/SSE parser but force a flush through Cloud Run's HTTP/2
    // proxy and any intermediary caches, preventing them from closing the
    // stream as "idle" while the LLM is in a long thinking block or
    // between tool-call rounds. 15s is comfortably below the typical 30-60s
    // idle thresholds without producing meaningful network overhead.
    const heartbeat = setInterval(() => {
        try {
            res.write(`: keepalive ${Date.now()}\n\n`);
        } catch {
            /* socket already closed — interval gets cleared in finally */
        }
    }, 15_000);
    // Clean up if the client navigates away before we finish.
    req.on("close", () => clearInterval(heartbeat));

    const apiKeys = await getUserApiKeys(userId, db);
    // Per-user connectors come first so they win any slug collision in
    // findMcpServerForTool; built-in (system-side) MCPs follow.
    const [userMcpServers, builtinMcpServers] = await Promise.all([
        loadEnabledMcpServersForUser(userId, db),
        loadBuiltinMcpServers(userId, db),
    ]);
    const mcpServers = [...userMcpServers, ...builtinMcpServers];

    // Wall-clock timer for cost telemetry — see recordLlmUsage call below.
    const turnStartedAt = Date.now();
    let usageRecorded = false;

    try {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

        const { fullText, events, usage, selectedModel } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            db,
            write,
            workflowStore,
            model,
            reasoningEffort,
            apiKeys,
            projectId: project_id ?? null,
            mcpServers,
            client: client ?? "web",
            editMode: editMode ?? "track",
        });

        console.log("[chat/stream] LLM stream finished", {
            fullTextLen: fullText?.length ?? 0,
            eventCount: events?.length ?? 0,
        });

        const annotations = extractAnnotations(fullText, docIndex, events);
        const { data: insertedAssistant } = await db
            .from("chat_messages")
            .insert({
                chat_id: chatId,
                role: "assistant",
                content: events.length ? events : null,
                annotations: annotations.length ? annotations : null,
            })
            .select("id")
            .single();
        if (insertedAssistant?.id) {
            // Surfaces the new row's id to the client so the UI can wire
            // up per-message affordances (flag "Not appropriate answer",
            // export to PDF, print) without a full chat refetch.
            try {
                write(
                    `data: ${JSON.stringify({ type: "message_id", messageId: insertedAssistant.id })}\n\n`,
                );
            } catch {
                /* ignore */
            }
        }

        // Cost telemetry: persist token counts + USD for this assistant
        // turn. Best-effort — recordLlmUsage swallows its own errors.
        if (usage) {
            usageRecorded = true;
            await recordLlmUsage({
                userId,
                provider: "claude",
                model: selectedModel,
                chatId,
                projectId: project_id ?? null,
                chatMessageId: insertedAssistant?.id ?? null,
                usage,
                durationMs: Date.now() - turnStartedAt,
                status: "ok",
            });
        }

        if (!chatTitle && lastUser?.content) {
            await db
                .from("chats")
                .update({ title: lastUser.content.slice(0, 120) })
                .eq("id", chatId);
        }
    } catch (err) {
        console.error("[chat/stream] error:", err);
        // Even on failure we want a usage row when the upstream call had
        // already produced any tokens (e.g. crash mid-tool-loop). The
        // stream result is unavailable here; we log a zero-token row
        // tagged with the error so the row count itself signals failure
        // rate even before we have a UI.
        if (!usageRecorded) {
            try {
                await recordLlmUsage({
                    userId,
                    provider: "claude",
                    model: model ?? "unknown",
                    chatId,
                    projectId: project_id ?? null,
                    usage: {
                        inputTokens: 0,
                        outputTokens: 0,
                        cacheCreationInputTokens: 0,
                        cacheReadInputTokens: 0,
                        iterations: 0,
                    },
                    durationMs: Date.now() - turnStartedAt,
                    status: "error",
                    errorMessage:
                        err instanceof Error ? err.message : String(err),
                });
            } catch {
                /* recordLlmUsage already logs its own failures */
            }
        }
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: "Stream error" })}\n\n`,
            );
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        clearInterval(heartbeat);
        await closeMcpServers(mcpServers);
        res.end();
    }
});
