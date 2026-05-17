/**
 * Streaming column suggester for the floating AI prompt above tabular
 * reviews. Wraps `streamChatWithTools` with a tightly-scoped tool set:
 *
 *   - `web_search`        — same Tavily/Exa/Parallel/You wrapper the
 *                           assistant chat uses; lets the model ground
 *                           regulatory / domain queries before drafting
 *                           columns (e.g. "add a GDPR Art. 28 check").
 *   - `apply_columns`     — terminal tool. Model calls this with the
 *                           final columns_config; we emit a `result`
 *                           SSE event and end the turn.
 *   - `ask_clarification` — terminal tool. Model calls this when the
 *                           instruction is too vague to act on (e.g. a
 *                           single keyword like "GDPR"); we surface the
 *                           question to the user and end the turn.
 *
 * The endpoint streams Server-Sent Events so the UI can show
 * "Razmatram trenutne stupce…" → "Pretražujem web…" → "Generiram…"
 * as the model progresses, instead of a 1-3s opaque spinner.
 */

import {
    formatSearchResultsForLLM,
    isAnyProviderConfigured,
    webSearch,
    type SearchProvider,
} from "./search";
import {
    streamChatWithTools,
    type LlmMessage,
    type NormalizedToolCall,
    type NormalizedToolResult,
    type OpenAIToolSchema,
    type UserApiKeys,
} from "./llm";
import { localeContextForLlm, type UiLocale } from "./uiLocale";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ColumnDraft = {
    name: string;
    prompt: string;
    format: string;
    tags?: string[];
};

export type ColumnSuggesterEvent =
    | { type: "status"; phase: "thinking" | "searching" | "applying"; message?: string }
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
    | { type: "result"; columns: ColumnDraft[]; explanation?: string | null }
    | { type: "error"; message: string }
    | { type: "done" };

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const WEB_SEARCH_TOOL: OpenAIToolSchema = {
    type: "function",
    function: {
        name: "web_search",
        description:
            "Search the live web for facts, regulatory updates, court decisions, or any information that might have changed since your training cutoff. Use this BEFORE drafting columns when the user references a specific regulation (e.g. 'GDPR Art. 28', 'DORA', 'AI Act'), a recent case, a market practice that may have shifted, or any topic where currency matters. Skip it for purely structural instructions ('delete all columns', 'add a column for Term').\n\nNOTE: The query argument is sent to a search engine, NOT to the user — write it in the language most likely to retrieve authoritative sources (often English for international regulation, Croatian for HR-specific law). The user-facing column names you produce afterwards STILL must be in the user's UI language.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description:
                        "Natural-language search query. Be specific — include regulation numbers (2016/679), acronyms (GDPR), article references, and jurisdiction modifiers when applicable. Write in the language most likely to retrieve good results.",
                },
                provider: {
                    type: "string",
                    enum: ["tavily", "exa", "parallel", "you", "auto"],
                    description:
                        "Which provider to use. 'auto' (default) lets the backend pick. Tavily is best for general/legal-ish queries.",
                },
                num_results: {
                    type: "integer",
                    minimum: 1,
                    maximum: 10,
                    description: "How many results to return (1-10). Default 5.",
                },
                recency_days: {
                    type: "integer",
                    minimum: 1,
                    maximum: 3650,
                    description:
                        "Restrict to results published in the last N days. Use small values (7, 30) for breaking-news; omit for evergreen regulatory text.",
                },
            },
            required: ["query"],
        },
    },
};

const APPLY_COLUMNS_TOOL: OpenAIToolSchema = {
    type: "function",
    function: {
        name: "apply_columns",
        description:
            "TERMINAL TOOL. Call this with the COMPLETE resulting columns_config — including any existing columns that should remain, minus any that should be removed, plus any new ones. Calling this ends your turn; do not emit any prose after.\n\nLANGUAGE: Every string argument (column name, prompt, tags, explanation) MUST match the user's UI language as declared at the top of the system prompt. If the user's UI is Croatian, write in Croatian — even if THIS schema description and field names are in English.",
        parameters: {
            type: "object",
            properties: {
                columns: {
                    type: "array",
                    description:
                        "The full list of columns the review should have AFTER the user's instruction is applied. Pass an empty array to remove all columns.",
                    items: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string",
                                description:
                                    "Short column header (≤ 40 chars). Title case; no trailing punctuation. WRITE IN THE USER'S UI LANGUAGE: when uiLocale=hr → Croatian (e.g. 'Trajanje najma', 'Iznos najamnine', 'Klauzula o reviziji najamnine'); when uiLocale=en → English (e.g. 'Lease Term', 'Rent Amount').",
                            },
                            prompt: {
                                type: "string",
                                description:
                                    "Extraction instruction sent to the per-cell LLM for each document. Focus on WHAT to extract — never on how to format the response. WRITE IN THE USER'S UI LANGUAGE: when uiLocale=hr → Croatian sentence (e.g. 'Pronađi početni i krajnji datum najma te ukupno trajanje izraženo u mjesecima.'); when uiLocale=en → English sentence.",
                            },
                            format: {
                                type: "string",
                                enum: [
                                    "text",
                                    "bulleted_list",
                                    "number",
                                    "percentage",
                                    "monetary_amount",
                                    "currency",
                                    "yes_no",
                                    "date",
                                    "tag",
                                ],
                                description:
                                    "Response shape for the cell. Use 'tag' only when there is a fixed enumerated set; otherwise prefer 'text' for prose, 'yes_no' for compliance checks, 'date' for dates. (This enum value is an internal key, NOT a user-visible string — leave it in English.)",
                            },
                            tags: {
                                type: "array",
                                items: { type: "string" },
                                description:
                                    "Required when format = 'tag'. Non-empty enumerated set the cell must pick from. WRITE TAGS IN THE USER'S UI LANGUAGE: when uiLocale=hr → Croatian (e.g. ['Da', 'Ne', 'Djelomično']); when uiLocale=en → English (e.g. ['Yes', 'No', 'Partial']).",
                            },
                        },
                        required: ["name", "prompt", "format"],
                    },
                },
                explanation: {
                    type: "string",
                    description:
                        "Optional one-sentence summary of what changed (added/removed/replaced). Shown in the UI for the user — so write it in the user's UI language. When uiLocale=hr: Croatian (e.g. 'Dodan stupac za trajanje najma.'). When uiLocale=en: English. Keep it short.",
                },
            },
            required: ["columns"],
        },
    },
};

const ASK_CLARIFICATION_TOOL: OpenAIToolSchema = {
    type: "function",
    function: {
        name: "ask_clarification",
        description:
            "TERMINAL TOOL. Call this ONLY when the user's instruction is too ambiguous to act on confidently — typically a single keyword ('trajanje', 'GDPR'), a vague verb without target ('promijeni'), or contradicting requirements. Ask exactly ONE concise follow-up question that, once answered, lets you call apply_columns. Do not call this for normal instructions where a reasonable default exists.\n\nLANGUAGE: The question is shown verbatim to the user, so it MUST be in the user's UI language. uiLocale=hr → Croatian question; uiLocale=en → English question.",
        parameters: {
            type: "object",
            properties: {
                question: {
                    type: "string",
                    description:
                        "The single question to surface to the user. Should be answerable in one short sentence. WRITE IN THE USER'S UI LANGUAGE. When uiLocale=hr, example: 'Na koji aspekt GDPR-a se misli — Čl. 28 (izvršitelj obrade), Čl. 32 (sigurnost), ili nešto drugo?'. When uiLocale=en, example: 'Which aspect of GDPR — Art. 28 (processor obligations), Art. 32 (security), or something else?'",
                },
            },
            required: ["question"],
        },
    },
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(args: {
    uiLocale: UiLocale;
    webSearchAvailable: boolean;
    reviewTitle?: string | null;
    projectName?: string | null;
}): string {
    // Top-of-prompt language block. Modeled after the pattern Anthropic
    // recommends for forcing output language: an explicit, exaggerated
    // directive at position 0 so it dominates over downstream English
    // tool-description text. Repeated again at the end of the prompt
    // and injected into every user message — defense in depth.
    const languageBlock =
        args.uiLocale === "hr"
            ? `OUTPUT LANGUAGE — STRICTLY HRVATSKI (CROATIAN).

Every string you put into a tool call argument WILL BE DISPLAYED VERBATIM IN THE USER'S CROATIAN-LANGUAGE UI. Therefore:
- The "question" field of ask_clarification MUST be written in Croatian.
- The "explanation" field of apply_columns MUST be written in Croatian.
- The "name", "prompt" and "tags" fields of every column in apply_columns MUST be written in Croatian, using Croatian legal terminology (not English, not Serbian, not Bosnian).

This rule applies EVEN THOUGH this system prompt and the tool schemas are written in English. The English here is for you (the model); your OUTPUT is for a Croatian end user.

Do not switch to English under any circumstance. Do not "translate" the user's Croatian instruction into English before answering. If you find yourself drafting an English sentence, stop and rewrite it in Croatian.

FORBIDDEN English words and phrases (NEVER use these as column names or in prompts when uiLocale=hr; always use the Croatian alternative):
  - "Lease Term"            → "Trajanje najma"
  - "Rent Amount"           → "Iznos najamnine"
  - "Rent Review Clause"    → "Klauzula o reviziji najamnine"
  - "Security Deposit"      → "Polog (jamčevina)"
  - "Termination"           → "Raskid"
  - "Notice Period"         → "Otkazni rok"
  - "Governing Law"         → "Mjerodavno pravo"
  - "Jurisdiction"          → "Nadležnost"
  - "Liability"             → "Odgovornost"
  - "Indemnity / Indemnification" → "Naknada štete / obeštećenje"
  - "Confidentiality"       → "Povjerljivost"
  - "Force Majeure"         → "Viša sila"
  - "Effective Date"        → "Datum stupanja na snagu"
  - "Parties"               → "Ugovorne strane"
  - "Counterparty"          → "Druga ugovorna strana"
  - "Payment Terms"         → "Uvjeti plaćanja"
  - "Late Payment"          → "Zakašnjelo plaćanje"
  - "Breach"                → "Povreda ugovora"
  - "Remedies"              → "Pravni lijekovi"
  - "Warranty"              → "Jamstvo"
  - "Representations"       → "Izjave (jamstva)"
  - "Assignment"            → "Ustup ugovora"
  - "Subletting"            → "Podnajam"
  - "Maintenance"           → "Održavanje"

If the source document is in English, you MAY quote document terms verbatim INSIDE the prompt as a parenthetical hint (e.g. "Trajanje najma (lease term)"), but the COLUMN NAME itself must always be in Croatian.

Concrete reference example for the Croatian UI (follow this pattern):

User instruction (in Croatian): "dodaj stupac za trajanje najma"
Correct apply_columns call:
{
  "columns": [
    /* …all existing columns re-emitted unchanged… */,
    {
      "name": "Trajanje najma",
      "prompt": "Pronađi početni i krajnji datum najma te ukupno trajanje izraženo u mjesecima ili godinama. Citiraj točan period kako je naveden u ugovoru.",
      "format": "text"
    }
  ],
  "explanation": "Dodan stupac za trajanje najma."
}

WRONG (do NOT do this when uiLocale=hr):
{ "name": "Lease Term", "prompt": "What is the duration of the lease?…", "format": "text" }
{ "name": "Rent Amount", "prompt": "Extract the monthly rent amount.", "format": "monetary_amount" }`
            : `OUTPUT LANGUAGE — STRICTLY INTERNATIONAL ENGLISH.

Every string you put into a tool call argument WILL BE DISPLAYED VERBATIM IN THE USER'S ENGLISH-LANGUAGE UI. Therefore:
- The "question" field of ask_clarification MUST be in English.
- The "explanation", "name", "prompt" and "tags" fields of apply_columns MUST be in clear international English.

If the user typed in another language, still answer in English.`;

    const contextLines: string[] = [];
    if (args.projectName)
        contextLines.push(`Project: ${args.projectName}`);
    if (args.reviewTitle)
        contextLines.push(`Tabular review: ${args.reviewTitle}`);
    const contextBlock = contextLines.length
        ? `\n\nReview context:\n${contextLines.join("\n")}`
        : "";

    const webSearchBlock = args.webSearchAvailable
        ? `

You have a web_search tool. Use it BEFORE calling apply_columns when the instruction references:
- a specific regulation/article (GDPR Art. 28, DORA, AI Act, EU Late Payment Directive…)
- recent case law or regulatory amendments
- a market or industry practice that may have shifted

Skip web_search for purely structural changes ("delete all columns", "add a column for Term", "rename Remedies to Sanctions") — those don't need grounding.

Make queries specific: include regulation numbers ("2016/679"), acronyms ("GDPR"), article references, and the user's UI language hint where useful.`
        : "";

    return `${languageBlock}

---

You manage extraction columns for a legal tabular review in Max. The user gives a natural-language instruction; you translate it into concrete column edits.${contextBlock}

You MUST end every turn by calling exactly ONE of:
  - apply_columns(columns, explanation?)   — when you can confidently produce the new columns_config
  - ask_clarification(question)            — when the instruction is too ambiguous (e.g. one-word input)

Never emit prose alongside or instead of these tool calls. Never make up new tools.

Behavior rules for apply_columns:
- Return the COMPLETE resulting columns_config. Existing columns that should remain MUST be re-emitted (with their existing name/prompt/format unchanged).
- Examples:
  - "obriši sve stupce" / "delete all columns" → call apply_columns with columns: []
  - "obriši stupac X" / "remove column X" → all existing columns except X
  - "dodaj stupac Y" / "add column Y" → existing columns + new column Y
  - "zamijeni stupce za NDA analizu" → entirely new set suitable for NDA review
- format must be one of: text, bulleted_list, number, percentage, monetary_amount, currency, yes_no, date, tag.
- For format "tag", supply a non-empty tags array.
- Column prompts focus on WHAT to extract — never embed format instructions inside the prompt.

Behavior rules for ask_clarification:
- Use ONLY when the instruction is genuinely ambiguous. Single keywords without a verb ("GDPR", "trajanje") and contradictory instructions are the canonical cases.
- Never ask for confirmation of an obvious instruction. "obriši sve stupce" is not ambiguous — apply it.
- Ask EXACTLY one concise question.${webSearchBlock}

${localeContextForLlm(args.uiLocale)}

REMEMBER: ${args.uiLocale === "hr" ? "All your tool-call argument strings must be in Croatian. Not English." : "All your tool-call argument strings must be in English."}`;
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Language guard — detects when the model has returned English column names
// or prompts even though uiLocale=hr (a frequent failure mode for smaller
// models). When detected we send one corrective follow-up message and let
// the model re-call apply_columns with Croatian wording.
// ---------------------------------------------------------------------------

const HR_DIACRITIC_RE = /[čćšžđČĆŠŽĐ]/;

const ENGLISH_LEGAL_WORDS_RE =
    /\b(lease|term|terms|amount|date|clause|clauses|agreement|contract|rent|rental|payment|payments|party|parties|liability|warranty|notice|review|breach|termination|jurisdiction|governing|law|name|description|value|number|total|duration|start|end|deposit|security|fee|fees|rate|deadline|landlord|tenant|seller|buyer|provider|customer|effective|signature|signed|witness|consideration|obligations|representations|indemnity|confidentiality|force majeure|assignment|subletting|maintenance|premises|property|conditions|covenants|remedies|definitions|recitals|schedule|annex|exhibit|appendix|whereas|hereby|herein|thereof)\b/i;

function looksEnglish(text: string): boolean {
    if (!text || text.length < 4) return false;
    if (HR_DIACRITIC_RE.test(text)) return false;
    return ENGLISH_LEGAL_WORDS_RE.test(text);
}

function suggestionLooksEnglish(cols: ColumnDraft[]): boolean {
    if (cols.length === 0) return false;
    let englishHits = 0;
    for (const c of cols) {
        if (looksEnglish(c.name) || looksEnglish(c.prompt)) englishHits += 1;
    }
    // Trip the guard if at least one column is clearly English. We err on
    // the side of retrying — a one-extra-turn cost is acceptable to avoid
    // shipping English UI strings to a Croatian user.
    return englishHits >= 1;
}

function normalizeColumns(raw: unknown): ColumnDraft[] {
    if (!Array.isArray(raw)) return [];
    const out: ColumnDraft[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const c = item as Record<string, unknown>;
        const name = typeof c.name === "string" ? c.name.trim() : "";
        const prompt = typeof c.prompt === "string" ? c.prompt.trim() : "";
        const format = typeof c.format === "string" ? c.format.trim() : "text";
        if (!name || !prompt) continue;
        const tags = Array.isArray(c.tags)
            ? (c.tags as unknown[]).filter(
                  (t): t is string => typeof t === "string" && t.trim() !== "",
              )
            : undefined;
        out.push({ name, prompt, format, tags });
    }
    return out;
}

export async function streamColumnSuggestion(args: {
    instruction: string;
    currentColumns: unknown[];
    uiLocale: UiLocale;
    model: string;
    apiKeys?: UserApiKeys;
    write: (event: ColumnSuggesterEvent) => void;
    reviewTitle?: string | null;
    projectName?: string | null;
}): Promise<void> {
    const {
        instruction,
        currentColumns,
        uiLocale,
        model,
        apiKeys,
        write,
        reviewTitle,
        projectName,
    } = args;

    const webSearchAvailable = isAnyProviderConfigured();
    const tools: OpenAIToolSchema[] = [
        APPLY_COLUMNS_TOOL,
        ASK_CLARIFICATION_TOOL,
    ];
    if (webSearchAvailable) tools.unshift(WEB_SEARCH_TOOL);

    const systemPrompt = buildSystemPrompt({
        uiLocale,
        webSearchAvailable,
        reviewTitle,
        projectName,
    });

    const userLanguageReminder =
        uiLocale === "hr"
            ? `[INSTRUCTION TO MODEL: The end user's UI language is Croatian. ALL strings inside your apply_columns and ask_clarification arguments — including "question", "explanation", "name", "prompt" and "tags" — MUST be written in Croatian. Do not switch to English even if you find it more natural.]`
            : `[INSTRUCTION TO MODEL: The end user's UI language is English. ALL strings inside your tool-call arguments must be in English.]`;

    const userMessage =
        `${userLanguageReminder}\n\n` +
        `CURRENT columns_config:\n${JSON.stringify(currentColumns, null, 2)}\n\n` +
        `USER INSTRUCTION:\n${instruction.trim()}`;

    const messages: LlmMessage[] = [{ role: "user", content: userMessage }];

    write({ type: "status", phase: "thinking" });

    let terminal:
        | { kind: "apply"; columns: ColumnDraft[]; explanation?: string }
        | { kind: "clarify"; question: string }
        | null = null;
    let appliedStatusEmitted = false;

    const runTools = async (
        calls: NormalizedToolCall[],
    ): Promise<NormalizedToolResult[]> => {
        const results: NormalizedToolResult[] = [];
        for (const call of calls) {
            if (call.name === "web_search") {
                const query =
                    typeof call.input.query === "string" ? call.input.query : "";
                const provider =
                    typeof call.input.provider === "string" &&
                    ["tavily", "exa", "parallel", "you"].includes(
                        call.input.provider,
                    )
                        ? (call.input.provider as SearchProvider)
                        : undefined;
                const numResults =
                    typeof call.input.num_results === "number"
                        ? call.input.num_results
                        : undefined;
                const recencyDays =
                    typeof call.input.recency_days === "number"
                        ? call.input.recency_days
                        : undefined;

                write({
                    type: "status",
                    phase: "searching",
                    message: query,
                });
                write({
                    type: "web_search_started",
                    query,
                    provider: provider ?? "auto",
                });

                const resp = await webSearch({
                    query,
                    provider,
                    num_results: numResults,
                    recency_days: recencyDays,
                });

                write({
                    type: "web_search_result",
                    provider: resp.provider,
                    query: resp.query,
                    results: resp.results.map((r) => ({
                        title: r.title,
                        url: r.url,
                        snippet: r.content,
                        published_date: r.published_date ?? null,
                    })),
                    error: resp.error ?? null,
                });

                results.push({
                    tool_use_id: call.id,
                    content: formatSearchResultsForLLM(resp),
                });
            } else if (call.name === "apply_columns") {
                const columns = normalizeColumns(call.input.columns);
                const explanation =
                    typeof call.input.explanation === "string"
                        ? call.input.explanation
                        : undefined;
                terminal = { kind: "apply", columns, explanation };
                if (!appliedStatusEmitted) {
                    write({
                        type: "status",
                        phase: "applying",
                    });
                    appliedStatusEmitted = true;
                }
                results.push({
                    tool_use_id: call.id,
                    content:
                        "OK — columns recorded. END YOUR TURN NOW. Do not call any other tools or emit any prose.",
                });
            } else if (call.name === "ask_clarification") {
                const question =
                    typeof call.input.question === "string"
                        ? call.input.question.trim()
                        : "";
                terminal = { kind: "clarify", question };
                results.push({
                    tool_use_id: call.id,
                    content:
                        "OK — clarification recorded. END YOUR TURN NOW. Do not call any other tools or emit any prose.",
                });
            } else {
                // Unknown tool — return an error so the model self-corrects
                // on the next iteration rather than crashing the request.
                results.push({
                    tool_use_id: call.id,
                    content: `Unknown tool '${call.name}'. Use only apply_columns, ask_clarification${webSearchAvailable ? ", or web_search" : ""}.`,
                });
            }
        }
        return results;
    };

    try {
        await streamChatWithTools({
            model,
            systemPrompt,
            messages,
            tools,
            maxIterations: 4,
            apiKeys,
            runTools,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[columnSuggester] streamChatWithTools failed", err);
        write({ type: "error", message });
        write({ type: "done" });
        return;
    }

    if (!terminal) {
        write({
            type: "error",
            message:
                "The model finished without calling apply_columns or ask_clarification. Please try a more specific instruction.",
        });
        write({ type: "done" });
        return;
    }

    // -----------------------------------------------------------------
    // Language guard. Some models persistently emit English column
    // names/prompts even with strong system-prompt directives. If the
    // first call produced an apply_columns turn whose strings look
    // English while the UI is Croatian, force one corrective turn.
    // -----------------------------------------------------------------
    {
        const t0 = terminal as
            | { kind: "apply"; columns: ColumnDraft[]; explanation?: string }
            | { kind: "clarify"; question: string };
        if (
            uiLocale === "hr" &&
            t0.kind === "apply" &&
            suggestionLooksEnglish(t0.columns)
        ) {
            const englishDraft = t0.columns;
            terminal = null;
            appliedStatusEmitted = false;

            write({ type: "status", phase: "thinking" });

            const retryMessage =
                `[LANGUAGE CORRECTION REQUIRED]\n\n` +
                `Tvoj prethodni apply_columns poziv vratio je sljedeće stupce na ENGLESKOM, što je krivo — sučelje je na hrvatskom:\n` +
                `${JSON.stringify(englishDraft, null, 2)}\n\n` +
                `ZADATAK: Ponovo pozovi apply_columns s ISTIM stupcima, ali svi tekstovi (name, prompt, explanation, tags) MORAJU biti na hrvatskom jeziku, koristeći hrvatsku pravnu terminologiju. Ne mijenjaj broj stupaca, redoslijed ni značenje — samo prevedi sadržaj na hrvatski.\n\n` +
                `Primjer pravilnog prijevoda:\n` +
                `  "Lease Term"           → "Trajanje najma"\n` +
                `  "Rent Amount"          → "Iznos najamnine"\n` +
                `  "Rent Review Clause"   → "Klauzula o reviziji najamnine"\n` +
                `  "Security Deposit"     → "Polog (jamčevina)"\n\n` +
                `Pozovi apply_columns SADA s prevedenim sadržajem. Ne pozivaj druge alate.`;

            try {
                await streamChatWithTools({
                    model,
                    systemPrompt,
                    messages: [{ role: "user", content: retryMessage }],
                    tools,
                    maxIterations: 2,
                    apiKeys,
                    runTools,
                });
            } catch (err) {
                console.error(
                    "[columnSuggester] language-guard retry failed",
                    err,
                );
                // Fall back to the (English) draft so the user still
                // gets a usable result rather than a hard error.
                terminal = {
                    kind: "apply",
                    columns: englishDraft,
                    explanation: t0.explanation,
                };
            }

            if (!terminal) {
                // Retry produced nothing actionable — fall back.
                terminal = {
                    kind: "apply",
                    columns: englishDraft,
                    explanation: t0.explanation,
                };
            }
        }
    }

    const t = terminal as
        | { kind: "apply"; columns: ColumnDraft[]; explanation?: string }
        | { kind: "clarify"; question: string };
    if (t.kind === "apply") {
        write({
            type: "result",
            columns: t.columns,
            explanation: t.explanation ?? null,
        });
    } else {
        if (!t.question) {
            write({
                type: "error",
                message: "Model asked for clarification but did not provide a question.",
            });
        } else {
            write({ type: "clarify", question: t.question });
        }
    }
    write({ type: "done" });
}
