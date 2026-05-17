"use client";

import { useEffect, useState } from "react";

const CAP = 200_000_000;
const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";

function fmt(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")} M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)} K`;
    return n.toLocaleString("hr");
}

export function TokenBanner() {
    const [used, setUsed] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        async function load() {
            try {
                const res = await fetch(`${API_BASE}/stats/tokens`, { cache: "no-store" });
                if (!res.ok) return;
                const data = await res.json() as { used: number };
                if (!cancelled) setUsed(data.used);
            } catch {
                // silently ignore — banner hides itself on error
            }
        }
        void load();
        // Refresh every 5 minutes while the tab is open
        const id = setInterval(() => void load(), 5 * 60 * 1000);
        return () => { cancelled = true; clearInterval(id); };
    }, []);

    if (used === null) return null;

    const pct = Math.min((used / CAP) * 100, 100);
    const remaining = Math.max(CAP - used, 0);

    return (
        <div className="bg-[#F7F3E9] text-neutral-900 border-b border-neutral-200">
            <div className="max-w-5xl mx-auto px-6 py-4 md:py-5">
                {/* Headline */}
                <p className="text-center font-serif text-base md:text-lg text-neutral-900 mb-4">
                    Poklanjamo prvih{" "}
                    <span className="font-semibold">200.000.000 tokena</span>{" "}
                    besplatno za testiranje.
                    {remaining > 0 && (
                        <span className="ml-2 text-neutral-500 text-sm font-mono">
                            Ostalo: {fmt(remaining)}
                        </span>
                    )}
                </p>

                {/* Progress track */}
                <div className="relative">
                    {/* Labels */}
                    <div className="flex justify-between items-end mb-1.5">
                        <span className="font-mono text-[11px] text-neutral-400">0</span>
                        <span className="font-mono text-xs text-neutral-900 font-semibold">
                            {fmt(used)} iskorišteno
                        </span>
                        <span className="font-mono text-[11px] text-neutral-400">200 M</span>
                    </div>

                    {/* Track */}
                    <div className="h-2 bg-neutral-200 rounded-full overflow-hidden">
                        <div
                            className="h-full rounded-full bg-neutral-900 transition-all duration-700"
                            style={{ width: `${pct}%` }}
                        />
                    </div>

                    {/* Percentage */}
                    <p className="mt-1.5 text-center font-mono text-[11px] text-neutral-400">
                        {pct.toFixed(2)}% iskorišteno
                    </p>
                </div>
            </div>
        </div>
    );
}
