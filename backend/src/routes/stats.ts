import { Router } from "express";
import type { Request, Response } from "express";
import { query } from "../lib/db";

export const statsRouter = Router();

const TOTAL_TOKEN_GIFT = 200_000_000;

/**
 * GET /stats/tokens
 * Public endpoint — no auth required.
 * Returns total input+output tokens ever consumed and the gift cap.
 */
statsRouter.get("/tokens", async (_req: Request, res: Response) => {
    try {
        const result = await query<{
            input_total: string;
            output_total: string;
        }>(
            `SELECT
                COALESCE(SUM(input_tokens), 0)  AS input_total,
                COALESCE(SUM(output_tokens), 0) AS output_total
            FROM public.llm_usage`,
            [],
        );

        const row = result.rows[0];
        const input = Number(row?.input_total ?? 0);
        const output = Number(row?.output_total ?? 0);
        const used = input + output;

        res.setHeader("Cache-Control", "public, max-age=60");
        res.json({
            used,
            cap: TOTAL_TOKEN_GIFT,
            input,
            output,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[stats/tokens] failed:", msg);
        res.status(500).json({ detail: "Failed to load token stats" });
    }
});
