import { Router, type Request, type Response } from "express";

import { requireAuth } from "../middleware/auth";
import { mintEulexPartnerToken } from "../lib/mcp/partnerJwt";
import { realtimeInstructions } from "../lib/realtimePrompt";

/**
 * Live glasovni razgovor (mobilna aplikacija) — mint ephemeral ključa za
 * OpenAI Realtime API (GA: POST /v1/realtime/client_secrets). Pravi
 * OPENAI_API_KEY nikad ne napušta server; klijent dobiva kratkotrajni
 * `value` i njime otvara WebRTC vezu na /v1/realtime/calls.
 *
 * Model je namjerno u env varijabli (REALTIME_MODEL) — prelazak na novi
 * model (npr. budući gpt-live-*) je promjena konfiguracije, bez novog
 * buildanja aplikacije.
 *
 * Sesiji se prilaže EULEX MCP server (isti partner JWT kao chat builtin
 * konektor), pa realtime model može pretraživati EUR-Lex uživo; klijent
 * iz MCP eventa na data channelu gradi transkript s izvorima.
 */
export const realtimeRouter = Router();

const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const EULEX_MCP_URL = "https://mcp.eulex.ai/mcp";

realtimeRouter.post("/session", requireAuth, async (req: Request, res: Response) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        res.status(503).json({ detail: "Realtime is not configured (OPENAI_API_KEY missing)" });
        return;
    }

    const userId = res.locals.userId as string;
    const language = req.body?.language === "en" ? "en" : "hr";
    const model = process.env.REALTIME_MODEL || "gpt-realtime-2.1";

    // EULEX MCP kao realtime tool — fail-soft: bez tokena sesija ide bez alata.
    const tools: unknown[] = [];
    try {
        const token = mintEulexPartnerToken(userId);
        if (token) {
            tools.push({
                type: "mcp",
                server_label: "eulex",
                server_url: EULEX_MCP_URL,
                authorization: token,
                require_approval: "never",
            });
        }
    } catch {
        /* bez MCP alata — razgovor i dalje radi */
    }

    const session = {
        type: "realtime",
        model,
        instructions: realtimeInstructions(language),
        // Preporuka za produkcijske voice agente (Realtime 2.x): nizak
        // reasoning effort — manje skrivenih tokena prije prvog izgovora.
        reasoning: {
            effort: process.env.REALTIME_REASONING_EFFORT || "medium",
        },
        audio: {
            input: {
                transcription: {
                    model: process.env.REALTIME_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
                },
            },
            output: { voice: process.env.REALTIME_VOICE || "marin" },
        },
        ...(tools.length > 0 ? { tools } : {}),
    };

    try {
        const upstream = await fetch(OPENAI_CLIENT_SECRETS_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ session }),
        });
        if (!upstream.ok) {
            const detail = await upstream.text();
            console.error("[realtime/session] client_secrets failed:", upstream.status, detail);
            res.status(502).json({ detail: "Realtime session mint failed" });
            return;
        }
        const data = (await upstream.json()) as { value?: string; expires_at?: number };
        res.json({ value: data.value, expires_at: data.expires_at ?? null, model });
    } catch (err) {
        console.error("[realtime/session] error:", err);
        res.status(502).json({ detail: "Realtime session mint failed" });
    }
});
