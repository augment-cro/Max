/**
 * Max API client — all requests to the Node.js backend.
 * Attaches the OAuth JWT token for user authentication.
 */

import {
    getStoredTokens,
    getValidAccessToken,
    refreshAccessToken,
    clearTokens,
} from "@/lib/oauth";
import type {
    AssistantEvent,
    MikeChat,
    MikeChatDetailOut,
    MikeCitationAnnotation,
    MikeDocument,
    MikeFolder,
    MikeMessage,
    MikeProject,
    MikeWorkflow,
    TabularReview,
    TabularReviewDetailOut,
} from "@/app/components/shared/types";

// Server-side shape before mapping
interface ServerMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    files?: { filename: string; document_id?: string }[] | null;
    workflow?: { id: string; title: string } | null;
    annotations?: MikeCitationAnnotation[] | null;
    is_flagged?: boolean | null;
    created_at: string;
}
interface ServerChatDetailOut {
    chat: MikeChat;
    messages: ServerMessage[];
}

// `??` only coalesces on null/undefined — a blank env var (which happened
// once when the Dockerfile exported `ENV NEXT_PUBLIC_API_BASE_URL=` even
// without a build-arg) would slip through and make API_BASE = "", which
// silently routed every backend call to the frontend origin and surfaced
// as 404 page-not-found HTML for /chat, /user/profile, /auth/pair/start.
// Treat whitespace-only values as unset too.
const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";

function getAuthHeader(): Record<string, string> {
    const tokens = getStoredTokens();
    if (!tokens?.access_token) return {};
    return { Authorization: `Bearer ${tokens.access_token}` };
}

/** Sent to the API so LLM prompts match the active Next.js UI locale (en | hr). */
function getUiLocaleHeader(): Record<string, string> {
    if (typeof document === "undefined") return {};
    const m = document.cookie.match(/(?:^|; )NEXT_LOCALE=([^;]*)/);
    const raw = m?.[1] ? decodeURIComponent(m[1]) : "";
    const code = raw.trim();
    if (code === "hr" || code === "en") return { "X-UI-Locale": code };
    return {};
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const authHeaders = getAuthHeader();
    const localeHeaders = getUiLocaleHeader();
    const { headers: initHeaders, ...restInit } = init ?? {};

    let response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        ...restInit,
        headers: {
            Accept: "application/json",
            ...localeHeaders,
            ...authHeaders,
            ...(initHeaders as Record<string, string> | undefined),
        },
    });

    // Auto-refresh on 401 TOKEN_EXPIRED, retry once
    if (response.status === 401) {
        try {
            const body = await response.clone().json();
            if (body?.code === "TOKEN_EXPIRED" || !authHeaders.Authorization) {
                const refreshed = await refreshAccessToken();
                if (refreshed) {
                    response = await fetch(`${API_BASE}${path}`, {
                        cache: "no-store",
                        ...restInit,
                        headers: {
                            Accept: "application/json",
                            ...localeHeaders,
                            Authorization: `Bearer ${refreshed.access_token}`,
                            ...(initHeaders as Record<string, string> | undefined),
                        },
                    });
                } else {
                    // Refresh failed — force re-login
                    clearTokens();
                    if (typeof window !== "undefined") {
                        window.location.href = "/login";
                    }
                    throw new Error("Session expired. Please sign in again.");
                }
            }
        } catch (parseErr) {
            // If we can't parse the 401 body, just throw
        }
    }

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `API error: ${response.status}`);
    }

    if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
    ) {
        return undefined as T;
    }

    return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Word add-in pairing
// ---------------------------------------------------------------------------

export interface PairingCode {
    code: string;
    expires_at: string;
    ttl_seconds: number;
}

export async function startPairingCode(): Promise<PairingCode> {
    return apiRequest<PairingCode>("/auth/pair/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<MikeProject[]> {
    return apiRequest<MikeProject[]>("/projects");
}

export async function createProject(
    name: string,
    cm_number?: string,
    shared_with?: string[],
): Promise<MikeProject> {
    return apiRequest<MikeProject>("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cm_number, shared_with }),
    });
}

export async function deleteAccount(): Promise<void> {
    return apiRequest<void>("/user/account", { method: "DELETE" });
}

export async function getProject(projectId: string): Promise<MikeProject> {
    return apiRequest<MikeProject>(`/projects/${projectId}`);
}

export async function updateProject(
    projectId: string,
    payload: {
        name?: string;
        cm_number?: string;
        shared_with?: string[];
    },
): Promise<MikeProject> {
    return apiRequest<MikeProject>(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteProject(projectId: string): Promise<void> {
    await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

export interface ProjectPeople {
    owner: {
        user_id: string;
        email: string | null;
        display_name: string | null;
    };
    members: { email: string; display_name: string | null }[];
}

export async function getProjectPeople(
    projectId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/projects/${projectId}/people`);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createProjectFolder(
    projectId: string,
    name: string,
    parentFolderId?: string | null,
): Promise<MikeFolder> {
    return apiRequest<MikeFolder>(`/projects/${projectId}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            parent_folder_id: parentFolderId ?? null,
        }),
    });
}

export async function renameProjectFolder(
    projectId: string,
    folderId: string,
    name: string,
): Promise<MikeFolder> {
    return apiRequest<MikeFolder>(
        `/projects/${projectId}/folders/${folderId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        },
    );
}

export async function deleteProjectFolder(
    projectId: string,
    folderId: string,
): Promise<void> {
    await apiRequest(`/projects/${projectId}/folders/${folderId}`, {
        method: "DELETE",
    });
}

export async function moveSubfolderToFolder(
    projectId: string,
    folderId: string,
    parentFolderId: string | null,
): Promise<MikeFolder> {
    return apiRequest<MikeFolder>(
        `/projects/${projectId}/folders/${folderId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parent_folder_id: parentFolderId }),
        },
    );
}

export async function moveDocumentToFolder(
    projectId: string,
    documentId: string,
    folderId: string | null,
): Promise<MikeDocument> {
    return apiRequest<MikeDocument>(
        `/projects/${projectId}/documents/${documentId}/folder`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder_id: folderId }),
        },
    );
}

export async function addDocumentToProject(
    projectId: string,
    documentId: string,
): Promise<MikeDocument> {
    return apiRequest<MikeDocument>(
        `/projects/${projectId}/documents/${documentId}`,
        { method: "POST" },
    );
}

export interface MikeDocumentVersion {
    id: string;
    version_number: number | null;
    source: string;
    created_at: string;
    display_name: string | null;
}

export async function listDocumentVersions(
    documentId: string,
): Promise<{
    current_version_id: string | null;
    versions: MikeDocumentVersion[];
}> {
    return apiRequest(`/single-documents/${documentId}/versions`);
}

export async function uploadDocumentVersion(
    documentId: string,
    file: File,
    displayName?: string,
): Promise<MikeDocumentVersion> {
    const authHeaders = getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    if (displayName) form.append("display_name", displayName);
    const response = await fetch(
        `${API_BASE}/single-documents/${documentId}/versions`,
        {
            method: "POST",
            headers: { ...authHeaders },
            body: form,
        },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<MikeDocumentVersion>;
}

export async function renameDocumentVersion(
    documentId: string,
    versionId: string,
    displayName: string | null,
): Promise<MikeDocumentVersion> {
    return apiRequest<MikeDocumentVersion>(
        `/single-documents/${documentId}/versions/${versionId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ display_name: displayName }),
        },
    );
}

export async function uploadProjectDocument(
    projectId: string,
    file: File,
): Promise<MikeDocument> {
    const authHeaders = getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(
        `${API_BASE}/projects/${projectId}/documents`,
        {
            method: "POST",
            headers: { ...authHeaders },
            body: form,
        },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<MikeDocument>;
}

export async function uploadStandaloneDocument(
    file: File,
): Promise<MikeDocument> {
    const authHeaders = getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`${API_BASE}/single-documents`, {
        method: "POST",
        headers: { ...authHeaders },
        body: form,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<MikeDocument>;
}

export async function listStandaloneDocuments(): Promise<MikeDocument[]> {
    return apiRequest<MikeDocument[]>("/single-documents");
}

export async function deleteDocument(documentId: string): Promise<void> {
    await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

export async function getDocumentUrl(
    documentId: string,
    versionId?: string | null,
): Promise<{ url: string; filename: string; version_id: string | null }> {
    const qs = versionId
        ? `?version_id=${encodeURIComponent(versionId)}`
        : "";
    return apiRequest(`/single-documents/${documentId}/url${qs}`);
}

/** Must stay in sync with `MAX_ZIP_DOCUMENTS` in backend `documents.ts`. */
export const MAX_ZIP_DOWNLOAD_DOCUMENTS = 50;

export class ZipDocumentLimitError extends Error {
    readonly max: number;

    constructor(max: number) {
        super("ZIP_DOCUMENT_LIMIT");
        this.name = "ZipDocumentLimitError";
        this.max = max;
    }
}

export async function downloadDocumentsZip(
    documentIds: string[],
): Promise<Blob> {
    const authHeaders = getAuthHeader();
    const response = await fetch(`${API_BASE}/single-documents/download-zip`, {
        method: "POST",
        cache: "no-store",
        headers: {
            "Content-Type": "application/json",
            ...authHeaders,
        },
        body: JSON.stringify({ document_ids: documentIds }),
    });
    if (!response.ok) {
        const text = await response.text();
        let body: unknown;
        try {
            body = JSON.parse(text) as unknown;
        } catch {
            body = null;
        }
        if (
            body !== null &&
            typeof body === "object" &&
            (body as { code?: unknown }).code === "ZIP_DOCUMENT_LIMIT"
        ) {
            const rawMax = (body as { max_documents?: unknown }).max_documents;
            if (typeof rawMax === "number" && Number.isFinite(rawMax))
                throw new ZipDocumentLimitError(rawMax);
        }
        throw new Error(
            (body !== null &&
            typeof body === "object" &&
            typeof (body as { detail?: unknown }).detail === "string"
                ? String((body as { detail: string }).detail).trim()
                : text.trim()) ||
                `API error: ${response.status}`,
        );
    }
    return response.blob();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
    project_id?: string;
}): Promise<{ id: string }> {
    return apiRequest<{ id: string }>("/chat/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
    });
}

export async function listChats(): Promise<MikeChat[]> {
    return apiRequest<MikeChat[]>("/chat");
}

export async function listProjectChats(projectId: string): Promise<MikeChat[]> {
    return apiRequest<MikeChat[]>(`/projects/${projectId}/chats`);
}

export async function getChat(chatId: string): Promise<MikeChatDetailOut> {
    const raw = await apiRequest<ServerChatDetailOut>(`/chat/${chatId}`);
    const messages: MikeMessage[] = raw.messages.map((m) => {
        if (m.role === "user") {
            return {
                id: m.id,
                role: "user",
                content: typeof m.content === "string" ? m.content : "",
                files: m.files ?? undefined,
                workflow: m.workflow ?? undefined,
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        return {
            id: m.id,
            role: "assistant",
            content:
                events
                    ?.filter((e) => e.type === "content")
                    .map((e) => (e as { type: "content"; text: string }).text)
                    .join("") ?? "",
            annotations: m.annotations ?? undefined,
            events,
            flagged: !!m.is_flagged,
        };
    });
    return { chat: raw.chat, messages };
}

/**
 * Toggle the "not appropriate answer" flag on an assistant message.
 * Returns the new flag state so the caller can sync local UI without a
 * full chat refetch.
 */
export async function setMessageFlag(
    messageId: string,
    flagged: boolean,
    reason?: string,
): Promise<{ id: string; is_flagged: boolean; flagged_at: string | null }> {
    return apiRequest<{
        id: string;
        is_flagged: boolean;
        flagged_at: string | null;
    }>(`/chat/messages/${messageId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagged, reason }),
    });
}

export async function renameChat(chatId: string, title: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function deleteChat(chatId: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Chat sharing (email-bound invites — backend/routes/chatShares.ts)
// ---------------------------------------------------------------------------

export interface ChatShare {
    id: string;
    shared_with_email: string;
    created_at: string;
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
}

export interface ShareChatResponse {
    sent: string[];
    failures: { email: string; reason: string }[];
    shares: ChatShare[];
}

export async function shareChat(
    chatId: string,
    payload: { emails: string[] },
): Promise<ShareChatResponse> {
    return apiRequest<ShareChatResponse>(`/chat/${chatId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listChatShares(chatId: string): Promise<ChatShare[]> {
    return apiRequest<ChatShare[]>(`/chat/${chatId}/shares`);
}

export async function deleteChatShare(
    chatId: string,
    shareId: string,
): Promise<void> {
    await apiRequest(`/chat/${chatId}/shares/${shareId}`, { method: "DELETE" });
}

export interface SharedChatDetail {
    mode: "snapshot" | "live";
    chat: MikeChat;
    /**
     * Server returns raw chat_messages rows — the share page renders
     * them through the same mapping as `getChat()` for visual parity.
     */
    messages: ServerMessage[];
    shared_at: string;
    expires_at: string;
    accepted_at: string | null;
    owner: {
        display_name: string | null;
        email: string | null;
    };
    redirect_to: string;
}

export interface SharedChatView {
    mode: "snapshot" | "live";
    chat: MikeChat;
    messages: MikeMessage[];
    shared_at: string;
    expires_at: string;
    accepted_at: string | null;
    owner: { display_name: string | null; email: string | null };
    redirect_to: string;
}

/** Mirrors `getChat()`'s ServerMessage → MikeMessage normalization. */
function mapServerMessages(serverMessages: ServerMessage[]): MikeMessage[] {
    return serverMessages.map((m) => {
        if (m.role === "user") {
            return {
                role: "user",
                content: typeof m.content === "string" ? m.content : "",
                files: m.files ?? undefined,
                workflow: m.workflow ?? undefined,
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        return {
            role: "assistant",
            content:
                events
                    ?.filter((e) => e.type === "content")
                    .map((e) => (e as { type: "content"; text: string }).text)
                    .join("") ?? "",
            annotations: m.annotations ?? undefined,
            events,
        };
    });
}

export async function getSharedChat(token: string): Promise<SharedChatView> {
    const raw = await apiRequest<SharedChatDetail>(
        `/share/${encodeURIComponent(token)}`,
    );
    return {
        ...raw,
        messages: mapServerMessages(raw.messages),
    };
}

export async function acceptSharedChat(
    token: string,
): Promise<{ chat_id: string; project_id: string | null; redirect_to: string }> {
    return apiRequest(`/share/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    });
}

export async function generateChatTitle(
    chatId: string,
    message: string,
): Promise<{ title: string }> {
    return apiRequest<{ title: string }>(`/chat/${chatId}/generate-title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
    });
}

export async function streamChat(payload: {
    messages: {
        role: string;
        content: string;
        files?: { filename: string; document_id?: string }[];
        workflow?: { id: string; title: string };
    }[];
    chat_id?: string;
    project_id?: string;
    model?: string;
    /** "low" | "medium" | "high" — reasoning intensity for this turn. */
    effort?: string;
    signal?: AbortSignal;
}): Promise<Response> {
    const { signal, ...body } = payload;
    const authHeaders = getAuthHeader();
    return fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...getUiLocaleHeader(),
            ...authHeaders,
        },
        body: JSON.stringify(body),
        signal,
    });
}

type StreamChatMessage = {
    role: string;
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
};

export async function streamProjectChat(payload: {
    projectId: string;
    messages: StreamChatMessage[];
    chat_id?: string;
    model?: string;
    /** "low" | "medium" | "high" — reasoning intensity for this turn. */
    effort?: string;
    displayed_doc?: { filename: string; document_id: string };
    attached_documents?: { filename: string; document_id: string }[];
    signal?: AbortSignal;
}): Promise<Response> {
    const { projectId, signal, ...body } = payload;
    const authHeaders = getAuthHeader();
    return fetch(`${API_BASE}/projects/${projectId}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...getUiLocaleHeader(),
            ...authHeaders,
        },
        body: JSON.stringify(body),
        signal,
    });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
    projectId?: string,
): Promise<TabularReview[]> {
    const qs = projectId
        ? `?project_id=${encodeURIComponent(projectId)}`
        : "";
    return apiRequest<TabularReview[]>(`/tabular-review${qs}`);
}

export async function createTabularReview(payload: {
    title?: string;
    document_ids: string[];
    columns_config: { index: number; name: string; prompt: string }[];
    workflow_id?: string;
    project_id?: string;
}): Promise<TabularReview> {
    return apiRequest<TabularReview>("/tabular-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReview(
    reviewId: string,
): Promise<TabularReviewDetailOut> {
    return apiRequest<TabularReviewDetailOut>(`/tabular-review/${reviewId}`);
}

export async function updateTabularReview(
    reviewId: string,
    payload: {
        title?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        document_ids?: string[];
        project_id?: string | null;
        shared_with?: string[];
    },
): Promise<TabularReview> {
    return apiRequest<TabularReview>(`/tabular-review/${reviewId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReviewPeople(
    reviewId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
}

export async function generateTabularColumnPrompt(
    title: string,
    options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "preset" | "llm" | "fallback" }> {
    return apiRequest<{
        prompt: string;
        source: "preset" | "llm" | "fallback";
    }>("/tabular-review/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title,
            format: options?.format,
            documentName: options?.documentName,
            tags: options?.tags,
        }),
    });
}

export type AiColumnDraft = {
    name: string;
    prompt: string;
    format: string;
    tags?: string[];
};

export type AiColumnSuggesterEvent =
    | {
          type: "status";
          phase: "thinking" | "searching" | "applying";
          message?: string;
      }
    | {
          type: "web_search_started";
          query: string;
          provider: string;
      }
    | {
          type: "web_search_result";
          provider: string;
          query: string;
          results: Array<{
              title: string;
              url: string;
              snippet: string;
              published_date?: string | null;
          }>;
          error?: string | null;
      }
    | { type: "clarify"; question: string }
    | {
          type: "result";
          columns: AiColumnDraft[];
          explanation?: string | null;
      }
    | { type: "error"; message: string }
    | { type: "done" };

/**
 * SSE-streaming variant of the column suggester. The backend emits a
 * sequence of `status` / `web_search_*` events and ends with EXACTLY
 * one of `result` (apply the new columns) or `clarify` (surface a
 * follow-up question to the user), followed by `done`.
 *
 * Caller passes an `onEvent` callback for live UI updates and an
 * optional `signal` to cancel an in-flight request.
 */
export async function streamSuggestTabularColumnsWithAi(args: {
    reviewId: string;
    instruction: string;
    columns_config: unknown[];
    onEvent: (event: AiColumnSuggesterEvent) => void;
    signal?: AbortSignal;
}): Promise<void> {
    const { reviewId, instruction, columns_config, onEvent, signal } = args;
    const authHeaders = getAuthHeader();
    const res = await fetch(`${API_BASE}/tabular-review/ai-suggest-columns`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...getUiLocaleHeader(),
            ...authHeaders,
        },
        body: JSON.stringify({
            review_id: reviewId,
            instruction,
            columns_config,
        }),
        signal,
    });
    if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        throw new Error(
            `ai-suggest-columns failed (${res.status}): ${txt.slice(0, 300)}`,
        );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line. Split on \n\n,
        // keep the last (possibly incomplete) chunk in `buf` for the
        // next iteration.
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
            const rawEvent = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const dataLine = rawEvent
                .split("\n")
                .find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const payload = dataLine.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
                const event = JSON.parse(payload) as AiColumnSuggesterEvent;
                onEvent(event);
            } catch (err) {
                console.warn(
                    "[streamSuggestTabularColumnsWithAi] invalid JSON",
                    err,
                    payload.slice(0, 200),
                );
            }
        }
    }
}

export async function uploadReviewDocument(
    reviewId: string,
    file: File,
    options?: {
        projectId?: string;
        documentIds?: string[];
        columnsConfig?: { index: number; name: string; prompt: string }[];
    },
): Promise<MikeDocument> {
    const uploaded = options?.projectId
        ? await uploadProjectDocument(options.projectId, file)
        : await uploadStandaloneDocument(file);

    await updateTabularReview(reviewId, {
        columns_config: options?.columnsConfig,
        document_ids: [...(options?.documentIds ?? []), uploaded.id],
    });

    return uploaded;
}

export async function deleteTabularReview(reviewId: string): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}`, { method: "DELETE" });
}

export async function streamTabularGeneration(
    reviewId: string,
): Promise<Response> {
    const authHeaders = getAuthHeader();
    return fetch(`${API_BASE}/tabular-review/${reviewId}/generate`, {
        method: "POST",
        headers: { ...getUiLocaleHeader(), ...authHeaders },
    });
}

export async function streamTabularChat(
    reviewId: string,
    messages: { role: string; content: string }[],
    chat_id?: string | null,
    signal?: AbortSignal,
    context?: { reviewTitle?: string | null; projectName?: string | null },
): Promise<Response> {
    const authHeaders = getAuthHeader();
    return fetch(`${API_BASE}/tabular-review/${reviewId}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...getUiLocaleHeader(),
            ...authHeaders,
        },
        body: JSON.stringify({
            messages,
            chat_id: chat_id ?? undefined,
            review_title: context?.reviewTitle ?? undefined,
            project_name: context?.projectName ?? undefined,
        }),
        signal: signal ?? undefined,
    });
}

export interface TRCitationAnnotation {
    type: "tabular_citation";
    ref: number;
    col_index: number;
    row_index: number;
    col_name: string;
    doc_name: string;
    quote: string;
}

interface RawTRMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    annotations?: TRCitationAnnotation[] | null;
    created_at: string;
}

export interface TRDisplayMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
}

export interface TRChat {
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
}

export function mapTRMessages(raw: RawTRMessage[]): TRDisplayMessage[] {
    return raw.map((m) => {
        if (m.role === "user") {
            return {
                role: "user" as const,
                content: typeof m.content === "string" ? m.content : "",
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        const content =
            events
                ?.filter((e) => e.type === "content")
                .map((e) => (e as { type: "content"; text: string }).text)
                .join("") ?? "";
        return {
            role: "assistant" as const,
            content,
            events,
            annotations: m.annotations ?? undefined,
        };
    });
}

export async function getTabularChats(reviewId: string): Promise<TRChat[]> {
    return apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
}

export async function getTabularChatMessages(
    reviewId: string,
    chatId: string,
): Promise<RawTRMessage[]> {
    return apiRequest<RawTRMessage[]>(
        `/tabular-review/${reviewId}/chats/${chatId}/messages`,
    );
}

export async function deleteTabularChat(
    reviewId: string,
    chatId: string,
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "DELETE",
    });
}

export async function regenerateTabularCell(
    reviewId: string,
    documentId: string,
    columnIndex: number,
): Promise<{
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
}> {
    return apiRequest(`/tabular-review/${reviewId}/regenerate-cell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            document_id: documentId,
            column_index: columnIndex,
        }),
    });
}

export async function clearTabularCells(
    reviewId: string,
    documentIds: string[],
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/clear-cells`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_ids: documentIds }),
    });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = MikeWorkflow["type"];

export async function listWorkflows(
    type: WorkflowType,
): Promise<MikeWorkflow[]> {
    return apiRequest<MikeWorkflow[]>(`/workflows?type=${type}`);
}

export async function getWorkflow(workflowId: string): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>(`/workflows/${workflowId}`);
}

export async function createWorkflow(payload: {
    title: string;
    type: "assistant" | "tabular";
    prompt_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    practice?: string | null;
}): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>("/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateWorkflow(
    workflowId: string,
    payload: {
        title?: string;
        prompt_md?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        practice?: string | null;
    },
): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>(`/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function refineWorkflowWithAi(
    workflowId: string,
    instruction: string,
): Promise<{
    title: string;
    type: string;
    prompt_md: string;
    columns_config: unknown[];
}> {
    return apiRequest(`/workflows/ai-refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: workflowId, instruction }),
    });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

export async function listHiddenWorkflows(): Promise<string[]> {
    return apiRequest<string[]>("/workflows/hidden");
}

export async function hideWorkflow(workflowId: string): Promise<void> {
    await apiRequest("/workflows/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: workflowId }),
    });
}

export async function unhideWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/hidden/${workflowId}`, { method: "DELETE" });
}

export async function shareWorkflow(
    workflowId: string,
    payload: { emails: string[]; allow_edit: boolean },
): Promise<void> {
    await apiRequest<void>(`/workflows/${workflowId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listWorkflowShares(
    workflowId: string,
): Promise<
    {
        id: string;
        shared_with_email: string;
        allow_edit: boolean;
        created_at: string;
    }[]
> {
    return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function deleteWorkflowShare(
    workflowId: string,
    shareId: string,
): Promise<void> {
    await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
        method: "DELETE",
    });
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export interface McpServer {
    id: string;
    slug: string;
    name: string;
    url: string;
    header_keys: string[];
    enabled: boolean;
    last_error: string | null;
    auth_type: "headers" | "oauth";
    oauth_authorized: boolean;
    created_at: string;
    updated_at: string;
}

export interface McpServerTestResult {
    ok: boolean;
    tool_count?: number;
    tools?: { name: string; description: string }[];
    error?: string;
}

export async function listMcpServers(): Promise<McpServer[]> {
    return apiRequest<McpServer[]>("/user/mcp-servers");
}

export interface BuiltinMcpServer {
    slug: string;
    name: string;
    enabled: boolean;
}

export async function listBuiltinMcpServers(): Promise<BuiltinMcpServer[]> {
    return apiRequest<BuiltinMcpServer[]>("/builtin-mcp-servers");
}

/**
 * Toggle a built-in (server-side) MCP connector for the current user.
 * Built-ins default to enabled; this writes only the deviation. The
 * change applies to the next chat request.
 */
export async function updateBuiltinMcpServer(
    slug: string,
    payload: { enabled: boolean },
): Promise<{ slug: string; enabled: boolean }> {
    return apiRequest<{ slug: string; enabled: boolean }>(
        `/builtin-mcp-servers/${encodeURIComponent(slug)}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

export async function createMcpServer(payload: {
    name: string;
    url: string;
    slug?: string;
    headers?: Record<string, string>;
    enabled?: boolean;
    auth_type?: "headers" | "oauth";
}): Promise<McpServer> {
    return apiRequest<McpServer>("/user/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function startMcpOauth(
    id: string,
): Promise<{ authorize_url: string | null; already_authorized?: boolean }> {
    return apiRequest(`/user/mcp-servers/${id}/oauth/start`, {
        method: "POST",
    });
}

export async function updateMcpServer(
    id: string,
    payload: {
        name?: string;
        url?: string;
        headers?: Record<string, string>;
        enabled?: boolean;
    },
): Promise<McpServer> {
    return apiRequest<McpServer>(`/user/mcp-servers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteMcpServer(id: string): Promise<void> {
    await apiRequest(`/user/mcp-servers/${id}`, { method: "DELETE" });
}

/**
 * Wipes all OAuth state (DCR registration, tokens, code verifier) for a
 * connector. Use when the auth server has forgotten the client (e.g. after
 * a server-side registry reset) and the cached client_id is stuck — calling
 * this and then `startMcpOauth` forces a fresh discovery + DCR + sign-in.
 */
export async function resetMcpOauth(id: string): Promise<void> {
    await apiRequest(`/user/mcp-servers/${id}/reauth`, { method: "POST" });
}

export async function testMcpServer(id: string): Promise<McpServerTestResult> {
    return apiRequest<McpServerTestResult>(`/user/mcp-servers/${id}/test`, {
        method: "POST",
    });
}

// ─────────────────────────────────────────────────────────────────────
// File-source connectors (Google Drive / OneDrive / Box).
// Backend: backend/src/routes/integrations.ts
// ─────────────────────────────────────────────────────────────────────

export type IntegrationProviderId = "google_drive" | "onedrive" | "box";

export interface IntegrationProviderStatus {
    id: IntegrationProviderId;
    display_name: string;
    /** Operator wired the env-var credentials for this provider. */
    configured: boolean;
    /** This user has authorized the connector. */
    connected: boolean;
    account_email: string | null;
    account_name: string | null;
    expires_at: string | null;
}

export interface IntegrationFile {
    id: string;
    name: string;
    mime_type: string;
    size_bytes: number | null;
    modified_at: string | null;
    revision: string | null;
    web_url: string | null;
    parent: string | null;
}

export interface IntegrationFileListing {
    files: IntegrationFile[];
    next_page_token: string | null;
}

export async function listIntegrations(): Promise<{
    providers: IntegrationProviderStatus[];
}> {
    return apiRequest<{ providers: IntegrationProviderStatus[] }>(
        "/integrations",
    );
}

export async function startIntegrationOAuth(
    provider: IntegrationProviderId,
): Promise<{ authorize_url: string }> {
    return apiRequest<{ authorize_url: string }>(
        `/integrations/${provider}/oauth/start`,
        { method: "POST" },
    );
}

export async function disconnectIntegration(
    provider: IntegrationProviderId,
): Promise<void> {
    await apiRequest(`/integrations/${provider}`, { method: "DELETE" });
}

export async function listIntegrationFiles(
    provider: IntegrationProviderId,
    opts: { q?: string; page_token?: string; page_size?: number } = {},
): Promise<IntegrationFileListing> {
    const params = new URLSearchParams();
    if (opts.q) params.set("q", opts.q);
    if (opts.page_token) params.set("page_token", opts.page_token);
    if (opts.page_size) params.set("page_size", String(opts.page_size));
    const qs = params.toString();
    return apiRequest<IntegrationFileListing>(
        `/integrations/${provider}/files${qs ? `?${qs}` : ""}`,
    );
}

export async function importIntegrationFile(
    provider: IntegrationProviderId,
    file_id: string,
    project_id: string | null,
): Promise<MikeDocument> {
    return apiRequest<MikeDocument>(`/integrations/${provider}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id, project_id }),
    });
}
