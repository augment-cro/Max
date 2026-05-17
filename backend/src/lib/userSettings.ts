import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_MAIN_MODEL,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    type UserApiKeys,
} from "./llm";
import { decryptApiKey } from "./crypto";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
    /**
     * UI locale the user selected (mirrors the value the frontend uses
     * via next-intl). We honor this in title generation and any other
     * lightweight LLM call where the result lands directly in the UI,
     * so a Croatian-speaking user gets Croatian chat titles even when
     * their first message was in English.
     */
    preferred_language: string;
};

/**
 * Pick a sensible main-chat model when the client didn't send one.
 *
 * The Word add-in deliberately ships without a model picker — the user
 * configures preferred providers in the Max web app once, and the
 * add-in should "just work". Order of preference:
 *
 *   1. Claude   — Sonnet 4.6 (primary; prod always has a server key wired
 *                via Secret Manager, see cloudbuild.yaml).
 *   2. LocalLLM — if the operator wired up an in-house endpoint and the
 *                user has no Claude entitlement.
 *   3. Gemini   — 3.1 Pro
 *   4. Mistral  — Large
 *   5. OpenAI   — gpt-5.5 (last because OpenAI cost / latency is highest)
 *
 * If none of the above are available, we fall back to `DEFAULT_MAIN_MODEL`
 * and let the downstream client surface its own credentials error, which
 * is at least obvious in logs.
 */
export function resolveDefaultMainModel(apiKeys?: UserApiKeys): string {
    if (apiKeys?.claude?.trim()) return "claude-sonnet-4-6";
    if (process.env.VLLM_BASE_URL?.trim()) return "localllm-main";
    if (apiKeys?.gemini?.trim()) return "gemini-3.1-pro-preview";
    if (apiKeys?.mistral?.trim()) return "mistral-large-latest";
    if (apiKeys?.openai?.trim()) return "gpt-5.5";
    return DEFAULT_MAIN_MODEL;
}

/**
 * Pick a frontier-tier model for the AI Column Suggester (the floating
 * AI prompt above tabular reviews).
 *
 * Why this exists separately from `tabular_model`:
 *   - `tabular_model` is used for per-cell extraction — a narrow,
 *     well-bounded task that even small / self-hosted models handle
 *     fine. We let users save costs by routing it to `localllm-main`.
 *   - The column SUGGESTER, however, is an agentic flow that has to:
 *       1. parse a free-form user instruction,
 *       2. optionally web-search,
 *       3. emit a tool call with strict JSON shape,
 *       4. obey strong language directives (HR / EN),
 *       5. follow few-shot examples to the letter.
 *     Smaller / OSS models routinely fail step 4 (drop language) and
 *     step 5 (ignore examples), which is exactly the "why is the LLM
 *     answering in English?" bug we kept hitting.
 *
 * So here we *deliberately* skip `localllm-main` and any cheap-tier
 * variants, and pick the strongest available frontier model from
 * whatever provider keys are wired up.
 */
export function resolveColumnSuggesterModel(apiKeys?: UserApiKeys): string {
    if (apiKeys?.claude?.trim()) return "claude-sonnet-4-6";
    if (apiKeys?.gemini?.trim()) return "gemini-3.1-pro-preview";
    if (apiKeys?.mistral?.trim()) return "mistral-large-latest";
    if (apiKeys?.openai?.trim()) return "gpt-5.5";
    // Last resort — only fall back to localllm if literally nothing
    // else is configured; otherwise honor DEFAULT_MAIN_MODEL.
    if (process.env.VLLM_BASE_URL?.trim()) return "localllm-main";
    return DEFAULT_MAIN_MODEL;
}

// Title generation is a lightweight task — routed to the default title model
// (Claude Sonnet) which prod always has wired via Secret Manager, then falls
// back through cheaper per-provider models.
function resolveTitleModel(apiKeys: UserApiKeys): string {
    // Claude first — prod always has ANTHROPIC_API_KEY
    if (apiKeys.claude?.trim()) return DEFAULT_TITLE_MODEL;
    // LocalLLM for self-hosters
    if (process.env.VLLM_BASE_URL?.trim()) return "localllm-lite";
    // Other providers — cheapest tier each
    if (apiKeys.gemini?.trim()) return "gemini-3.1-flash-lite-preview";
    if (apiKeys.openai?.trim()) return "gpt-5.4-nano";
    if (apiKeys.mistral?.trim()) return "mistral-small-latest";
    // Fall back to server-level env keys
    if (
        process.env.ANTHROPIC_API_KEY?.trim() ||
        process.env.CLAUDE_API_KEY?.trim()
    )
        return DEFAULT_TITLE_MODEL;
    if (process.env.GEMINI_API_KEY?.trim()) return "gemini-3.1-flash-lite-preview";
    if (process.env.OPENAI_API_KEY?.trim()) return "gpt-5.4-nano";
    if (process.env.MISTRAL_API_KEY?.trim()) return "mistral-small-latest";
    return DEFAULT_TITLE_MODEL;
}

/** Try to decrypt; if the value isn't encrypted just return as-is. */
function safeDecrypt(val: string | null | undefined): string | null {
    if (!val?.trim()) return null;
    try {
        return decryptApiKey(val);
    } catch {
        // Might be a plaintext key from before encryption was added
        return val;
    }
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data, error } = await client
        .from("user_profiles")
        .select("tabular_model, preferred_language, claude_api_key, gemini_api_key, openai_api_key, mistral_api_key")
        .eq("user_id", userId)
        .single();

    if (error) {
        // Most likely cause: a column referenced in SELECT doesn't exist yet
        // (schema out of sync with code). Log and continue with null data so
        // the caller gets safe defaults instead of crashing.
        console.error("[userSettings] user_profiles query failed:", error.message);
    }

    const api_keys: UserApiKeys = {
        claude: safeDecrypt(data?.claude_api_key) ?? serverClaudeKey(),
        gemini: safeDecrypt(data?.gemini_api_key) ?? process.env.GEMINI_API_KEY ?? null,
        openai: safeDecrypt(data?.openai_api_key) ?? process.env.OPENAI_API_KEY ?? process.env.VLLM_API_KEY ?? null,
        mistral: safeDecrypt(data?.mistral_api_key) ?? process.env.MISTRAL_API_KEY ?? null,
    };

    const SUPPORTED = new Set(["en", "hr"]);
    const lang =
        typeof data?.preferred_language === "string" &&
        SUPPORTED.has(data.preferred_language)
            ? data.preferred_language
            : "hr";

    return {
        title_model: resolveTitleModel(api_keys),
        tabular_model: resolveModel(data?.tabular_model, "localllm-main"),
        api_keys,
        preferred_language: lang,
    };
}

/**
 * Server-level Anthropic key fallback. Prefer `ANTHROPIC_API_KEY` (the
 * canonical name Anthropic's own SDK + `.env.example` use); accept the
 * legacy `CLAUDE_API_KEY` for backwards compatibility with older
 * deployments. Returning a non-empty server key here means the user
 * doesn't need to paste their own key in Settings — Max just works.
 */
function serverClaudeKey(): string | null {
    const fromAnthropic = process.env.ANTHROPIC_API_KEY?.trim();
    if (fromAnthropic) return fromAnthropic;
    const legacy = process.env.CLAUDE_API_KEY?.trim();
    if (legacy) return legacy;
    return null;
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    const { data, error } = await client
        .from("user_profiles")
        .select("claude_api_key, gemini_api_key, openai_api_key, mistral_api_key")
        .eq("user_id", userId)
        .single();
    if (error) {
        console.error("[userSettings] getUserApiKeys query failed:", error.message);
    }
    return {
        claude: safeDecrypt(data?.claude_api_key) ?? serverClaudeKey(),
        gemini: safeDecrypt(data?.gemini_api_key) ?? process.env.GEMINI_API_KEY ?? null,
        openai: safeDecrypt(data?.openai_api_key) ?? process.env.OPENAI_API_KEY ?? process.env.VLLM_API_KEY ?? null,
        mistral: safeDecrypt(data?.mistral_api_key) ?? process.env.MISTRAL_API_KEY ?? null,
    };
}
